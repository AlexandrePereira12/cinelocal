/*
 * Catálogo servido a partir da "foto" gerada por scripts/atualizar-catalogo.mjs (netlify/data/catalogo.mjs).
 *
 * Decisões:
 * - Nenhuma chamada externa em runtime. O embedplayapi.top bloqueia o IP de datacenter da função, então a lista
 *   do que ele tem e os metadados (TMDB) são coletados no PC do dono e empacotados com a função. O catálogo só
 *   muda quando o script roda de novo e o site é publicado.
 * - "Em alta" = popularidade do TMDB na data da foto; "Mais avaliados" = nota com mínimo de votos;
 *   "Lançamentos" = data de estreia já passada; biblioteca = mais votados (os mais conhecidos primeiro).
 * - Catálogo vazio responde 503 `catalog_empty` (não 403/404: o `netlify dev` reenvia esses dois para outro caminho).
 * - A busca é local, sem acento e sem diferenciar maiúsculas; cada palavra digitada precisa ser o começo de uma
 *   palavra do título (ou do título original). Começo do título vem primeiro, depois a popularidade. Os filtros
 *   (tipo e ano) entram ANTES do corte de SEARCH_LIMIT: filtrar depois esconderia resultados que cabiam.
 * - Séries: temporadas e episódios vêm da contagem do TMDB (sem sondar o provedor).
 * - Gêneros: o usuário escolhe 2 gêneros de FILME (`genres()`); catálogo sem gêneros devolve `genres()` vazio e o
 *   recurso fica desligado (ninguém é obrigado a escolher).
 * - Filme e série têm ids de gênero próprios no TMDB, então cada gênero de filme é ligado aos equivalentes de série
 *   por uma tabela fixa (TV_EQUIVALENTS), usada por `fits`. Recomendar e explorar ("Todos") usam o MESMO `fits`:
 *   se divergissem, o que aparece em "Mais de Ação" e em "Explorar > Ação" seria diferente. Gênero sem equivalente
 *   (Terror, Romance, Thriller...) só casa com filme. Explorar só séries usa os gêneros de série direto (`tvGenres`).
 * - Recomendação (`recommend`): três listas sem repetição entre si (só do gênero 1, só do 2 e os que têm os dois);
 *   o que o usuário já abriu nunca é recomendado. Quando há poucos títulos com os dois gêneros (menos de MIX_MIN), a
 *   lista "os dois" é completada com os títulos de um só gênero que ficaram DEPOIS do limite das outras duas listas
 *   (por isso ainda não repete nada); ela só fica menor se nem assim houver títulos. Com histórico de assistidos, cada candidato é ordenado por
 *   popularidade × (1 + afinidade), onde afinidade soma, por gênero do candidato, a fração dos assistidos que tem
 *   aquele gênero. Sem assistidos a afinidade é 0 e a ordem é a de sempre (só popularidade). É heurística simples
 *   e explicável de propósito: aprendizado de máquina seria exagero para um catálogo de uma pessoa.
 * - Parecidos (`similar`): mesmo tipo, ordenados por quantos gêneros dividem com o título e depois por
 *   popularidade; exige SIMILAR_MIN_VOTES para o topo não ser título obscuro com um gênero igual.
 * - Listas por critério (clássicos, até 90 min, séries curtas) têm teto de 60 como as "em alta", para a home não virar
 *   um catálogo inteiro. "Novidades da semana" usa o campo `a` (data em que o título entrou no catálogo, gravado pelo
 *   script só para id novo) contado a partir de `generatedAt`, e não do relógio: a janela fica determinista e a
 *   fileira não esvazia só porque o site ficou dias sem receber uma foto nova. Foto sem nenhum `a` = fileira vazia.
 * - `nextEpisode` decide o "próximo episódio" no servidor com a mesma contagem do TMDB, para o front não precisar
 *   mandar a lista de episódios.
 */

import { HttpError } from './errors.mjs';

export const EMBED_BASE = 'https://embedplayapi.top/embed';

// Link do player do provedor. Só o servidor monta: o navegador (ou a TV) nunca manda uma URL pronta.
export function embedUrl(type, mediaId, season, episode) {
  return type === 'tv' ? `${EMBED_BASE}/${mediaId}/${season}/${episode}` : `${EMBED_BASE}/${mediaId}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 30;
const TRENDING_CAP = 60;
const TOP_MIN_VOTES = 500;
const SEARCH_LIMIT = 40;
const RECOMMEND_LIMIT = 30;
const MIX_MIN = 10; // com menos que isso de títulos nos dois gêneros, a lista "mistura" é completada com os próximos de cada gênero
const SIMILAR_LIMIT = 20;
const SIMILAR_MIN_VOTES = 100;
const RATING_FILTER_MIN_VOTES = 50; // nota alta com 3 votos não é nota: o filtro "nota mínima" ignora título com poucos votos
const NEW_WINDOW_DAYS = 7;
const SHORT_SHOW_MAX_EPISODES = 12;
const SHORT_SHOW_MIN_VOTES = 300;
const SHORT_MOVIE_MIN_MINUTES = 60; // abaixo disso é curta-metragem, não "filme curto"
const SHORT_MOVIE_MAX_MINUTES = 90;
const SHORT_MOVIE_MIN_VOTES = 500;
const CLASSIC_BEFORE_YEAR = 1990;
const CLASSIC_MIN_VOTES = 1000;
const CLASSIC_MIN_RATING = 7;

// Gênero de filme -> gêneros de série equivalentes (ids do TMDB TV). Os que não aparecem aqui não têm equivalente em série.
const TV_EQUIVALENTS = {
  28: [10759], // Ação -> Action & Adventure
  12: [10759], // Aventura -> Action & Adventure
  14: [10765], // Fantasia -> Sci-Fi & Fantasy
  878: [10765], // Ficção científica -> Sci-Fi & Fantasy
  10752: [10768], // Guerra -> War & Politics
  16: [16], // Animação
  35: [35], // Comédia
  80: [80], // Crime
  99: [99], // Documentário
  18: [18], // Drama
  10751: [10751], // Família
  9648: [9648], // Mistério
  37: [37], // Faroeste
};

// O caminho inverso (gênero de série -> gêneros de filme), para medir a afinidade de quem assistiu séries.
const MOVIE_FOR_TV = {};
for (const [movieId, tvIds] of Object.entries(TV_EQUIVALENTS)) {
  for (const tvId of tvIds) (MOVIE_FOR_TV[tvId] ??= []).push(Number(movieId));
}

// `genreId` é sempre um id de gênero de FILME. Filme casa direto; série casa pelos equivalentes.
function fits(type, entry, genreId) {
  if (type === 'movie') return Boolean(entry.g?.includes(genreId));
  const equivalents = TV_EQUIVALENTS[genreId];
  return Boolean(equivalents && entry.g?.some((id) => equivalents.includes(id)));
}

// Alterna os itens de duas listas (a0, b0, a1, b1...); quando uma acaba, segue com o resto da outra.
function zip(a, b) {
  const out = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (i < a.length) out.push(a[i]);
    if (i < b.length) out.push(b[i]);
  }
  return out;
}

// Filmes e séries (cada lista já por popularidade) em alternância, começando por quem tem o item mais popular: sempre mistura os dois tipos.
function interleave(movies, shows) {
  return (movies[0]?.entry.v ?? -1) >= (shows[0]?.entry.v ?? -1) ? zip(movies, shows) : zip(shows, movies);
}

const normalize = (text) =>
  String(text ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

const byDesc = (key) => (a, b) => (b[key] ?? 0) - (a[key] ?? 0);
const yearOf = (entry) => (entry.y ? Number(entry.y) : NaN);
const totalEpisodes = (entry) => (entry.s ?? []).reduce((sum, [, count]) => sum + count, 0);

function toItem(type, entry) {
  return {
    id: String(entry.i),
    type,
    title: entry.t,
    year: entry.y ?? null,
    poster: entry.p ?? null,
    backdrop: entry.b ?? null,
    overview: entry.o ?? null,
    rating: entry.r ?? null,
    runtime: entry.rt ?? null,
  };
}

const asRows = (type, entries) => entries.map((entry) => ({ type, entry }));

// Filtros de ano e de nota, iguais na busca e no explorar. Sem ano no título = fora quando há filtro de ano.
function passesFilters(entry, { from = null, to = null, minRating = null }) {
  if (from !== null || to !== null) {
    const year = yearOf(entry);
    if (!Number.isFinite(year) || (from !== null && year < from) || (to !== null && year > to)) return false;
  }
  if (minRating !== null && !(entry.r != null && entry.r >= minRating && (entry.n ?? 0) >= RATING_FILTER_MIN_VOTES)) return false;
  return true;
}

export function createCatalog({ data, now = Date.now }) {
  const movies = data?.movies ?? [];
  const series = data?.series ?? [];
  const seriesById = new Map(series.map((entry) => [String(entry.i), entry]));
  const moviesById = new Map(movies.map((entry) => [String(entry.i), entry]));
  const entryOf = (type, id) => (type === 'tv' ? seriesById : moviesById).get(id);

  const byPopularity = (list) => [...list].sort(byDesc('v'));
  const byVotes = (list) => [...list].sort(byDesc('n'));
  const moviesByPopularity = byPopularity(movies);
  const seriesByPopularity = byPopularity(series);

  // Gêneros que de fato têm título no catálogo (ids e nomes em pt-BR vêm do TMDB, via snapshot).
  const optionsFor = (names, entries) => {
    const used = new Set(entries.flatMap((entry) => entry.g ?? []));
    return Object.entries(names ?? {})
      .map(([id, name]) => ({ id: Number(id), name: String(name) }))
      .filter((genre) => Number.isInteger(genre.id) && used.has(genre.id))
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  };
  const genreOptions = optionsFor(data?.genres, movies);
  const tvGenreOptions = optionsFor(data?.tvGenres, series);
  const genreNames = { movie: data?.genres ?? {}, tv: data?.tvGenres ?? {} };

  // "Novidades": título cujo `a` cai nos NEW_WINDOW_DAYS dias que terminam na data da foto.
  const snapshotTime = Date.parse(data?.generatedAt);
  const newSince = new Date((Number.isFinite(snapshotTime) ? snapshotTime : now()) - (NEW_WINDOW_DAYS - 1) * DAY_MS).toISOString().slice(0, 10);

  const lists = {
    'trending-movies': { cap: TRENDING_CAP, rows: () => asRows('movie', byPopularity(movies)) },
    'trending-shows': { cap: TRENDING_CAP, rows: () => asRows('tv', byPopularity(series)) },
    'top-movies': {
      cap: TRENDING_CAP,
      rows: () => asRows('movie', movies.filter((e) => e.r != null && e.n >= TOP_MIN_VOTES).sort((a, b) => b.r - a.r || b.n - a.n)),
    },
    'recent-movies': {
      cap: TRENDING_CAP,
      rows: () => {
        const today = new Date(now()).toISOString().slice(0, 10);
        return asRows('movie', movies.filter((e) => e.d && e.d <= today).sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : (b.v ?? 0) - (a.v ?? 0))));
      },
    },
    'new-this-week': {
      cap: TRENDING_CAP,
      rows: () =>
        [...asRows('movie', movies), ...asRows('tv', series)]
          .filter(({ entry }) => entry.a && entry.a >= newSince)
          .sort((a, b) => (a.entry.a < b.entry.a ? 1 : a.entry.a > b.entry.a ? -1 : (b.entry.v ?? 0) - (a.entry.v ?? 0))),
    },
    classics: {
      cap: TRENDING_CAP,
      rows: () => asRows('movie', movies.filter((e) => yearOf(e) < CLASSIC_BEFORE_YEAR && (e.n ?? 0) >= CLASSIC_MIN_VOTES && (e.r ?? 0) >= CLASSIC_MIN_RATING).sort(byDesc('n'))),
    },
    'short-movies': {
      cap: TRENDING_CAP,
      rows: () => asRows('movie', byPopularity(movies.filter((e) => e.rt >= SHORT_MOVIE_MIN_MINUTES && e.rt <= SHORT_MOVIE_MAX_MINUTES && (e.n ?? 0) >= SHORT_MOVIE_MIN_VOTES))),
    },
    'short-shows': {
      cap: TRENDING_CAP,
      rows: () => asRows('tv', byPopularity(series.filter((e) => totalEpisodes(e) > 0 && totalEpisodes(e) <= SHORT_SHOW_MAX_EPISODES && (e.n ?? 0) >= SHORT_SHOW_MIN_VOTES))),
    },
    'library-movies': { rows: () => asRows('movie', byVotes(movies)) },
    'library-shows': { rows: () => asRows('tv', byVotes(series)) },
  };
  const cache = new Map();

  const searchIndex = [
    ...movies.map((entry) => ({ type: 'movie', entry })),
    ...series.map((entry) => ({ type: 'tv', entry })),
  ].map((row) => {
    const title = normalize(row.entry.t);
    return { ...row, title, titleWords: title.split(' '), words: normalize(`${row.entry.t} ${row.entry.ot ?? ''}`).split(' ') };
  });

  function requireData() {
    if (!movies.length && !series.length) {
      throw new HttpError(503, 'O catálogo ainda não foi gerado. Rode o script de atualização e publique de novo.', 'catalog_empty');
    }
  }

  // Quanto o gosto de quem já assistiu "puxa" cada gênero de filme: fração dos assistidos que tem o gênero (0 a 1).
  function tasteOf(watched) {
    const counts = new Map();
    let total = 0;
    for (const { type, id } of watched) {
      const entry = entryOf(type, id);
      if (!entry?.g?.length) continue;
      total++;
      const movieGenres = new Set(type === 'movie' ? entry.g : entry.g.flatMap((tvId) => MOVIE_FOR_TV[tvId] ?? []));
      for (const genreId of movieGenres) counts.set(genreId, (counts.get(genreId) ?? 0) + 1);
    }
    return { counts, total };
  }

  function affinity(type, entry, taste) {
    if (!taste.total) return 0;
    const movieGenres = new Set(type === 'movie' ? (entry.g ?? []) : (entry.g ?? []).flatMap((tvId) => MOVIE_FOR_TV[tvId] ?? []));
    let sum = 0;
    for (const genreId of movieGenres) sum += (taste.counts.get(genreId) ?? 0) / taste.total;
    return sum;
  }

  function info(type, id) {
    const entry = entryOf(type, id);
    if (!entry) return null;
    const names = genreNames[type];
    return {
      overview: entry.o ?? null,
      rating: entry.r ?? null,
      votes: entry.n ?? null,
      runtime: entry.rt ?? null,
      originalTitle: entry.ot ?? null,
      genres: (entry.g ?? []).map((genreId) => names[genreId]).filter(Boolean),
      seasons: type === 'tv' ? (entry.s ?? []).length : null,
      episodes: type === 'tv' ? totalEpisodes(entry) : null,
    };
  }

  // Mesmo tipo, mais gêneros em comum primeiro; a lista de origem já vem por popularidade e o sort é estável.
  function similar(type, id, { limit = SIMILAR_LIMIT, exclude = new Set() } = {}) {
    const entry = entryOf(type, id);
    if (!entry?.g?.length) return [];
    const mine = new Set(entry.g);
    const scored = [];
    for (const other of type === 'tv' ? seriesByPopularity : moviesByPopularity) {
      if (other.i === entry.i || (other.n ?? 0) < SIMILAR_MIN_VOTES || exclude.has(`${type}:${other.i}`)) continue;
      const shared = (other.g ?? []).reduce((count, genreId) => count + (mine.has(genreId) ? 1 : 0), 0);
      if (shared) scored.push({ other, shared });
    }
    scored.sort((a, b) => b.shared - a.shared);
    return scored.slice(0, limit).map(({ other }) => toItem(type, other));
  }

  return {
    // Opções para a escolha de gêneros favoritos (vazio = catálogo sem gêneros: o recurso fica desligado).
    genres() {
      return genreOptions.map((genre) => ({ ...genre }));
    },

    // Opções do explorar por tipo. "Todos" usa os gêneros de filme (ver `fits`); "séries" usa os próprios da série.
    browseGenres() {
      const copy = (list) => list.map((genre) => ({ ...genre }));
      return { all: copy(genreOptions), movie: copy(genreOptions), tv: copy(tvGenreOptions) };
    },

    // Recomendações pelos 2 gêneros favoritos, misturando filme e série. `exclude` = chaves "tipo:id" que o usuário já abriu;
    // `watched` = [{type, id}] dos que ele marcou como assistidos (só pesa na ordem, nunca inclui nem tira título).
    // Devolve { first, second, both }: só do 1º gênero, só do 2º e os que têm os dois. Sem repetição entre as três.
    recommend([a, b], exclude = new Set(), limit = RECOMMEND_LIMIT, { watched = [] } = {}) {
      const taste = tasteOf(watched);
      const pool = (type, list) => {
        const rows = list
          .filter((entry) => !exclude.has(`${type}:${entry.i}`))
          .map((entry) => ({ type, entry, a: fits(type, entry, a), b: fits(type, entry, b), score: (entry.v ?? 0) * (1 + affinity(type, entry, taste)) }))
          .filter((row) => row.a || row.b);
        return taste.total ? rows.sort((x, y) => y.score - x.score) : rows;
      };
      const movieRows = pool('movie', moviesByPopularity);
      const showRows = pool('tv', seriesByPopularity);
      const pick = (test) => interleave(movieRows.filter(test), showRows.filter(test));

      const firstAll = pick((row) => row.a && !row.b);
      const secondAll = pick((row) => row.b && !row.a);
      let both = pick((row) => row.a && row.b).slice(0, limit);
      if (both.length < MIX_MIN) {
        // Poucos títulos com os dois gêneros: completa com os que vêm depois dos já mostrados nas outras duas listas.
        const seen = new Set(both.map((row) => `${row.type}:${row.entry.i}`));
        const extra = zip(firstAll.slice(limit), secondAll.slice(limit)).filter((row) => !seen.has(`${row.type}:${row.entry.i}`));
        both = [...both, ...extra].slice(0, limit);
      }
      const items = (rows) => rows.slice(0, limit).map((row) => toItem(row.type, row.entry));
      return { first: items(firstAll), second: items(secondAll), both: items(both) };
    },

    similar,

    // Tudo que a tela de detalhe mostra (o que o player mostra é só `info`). Título que saiu do catálogo = null.
    detail(type, id) {
      const entry = entryOf(type, id);
      if (!entry) return null;
      return { ...toItem(type, entry), ...info(type, id), similar: similar(type, id) };
    },

    info,

    async list(name, page) {
      const list = lists[name];
      if (!list) throw new HttpError(404, 'Lista desconhecida', 'not_found');
      requireData();
      if (!cache.has(name)) {
        const all = list.rows();
        cache.set(name, list.cap ? all.slice(0, list.cap) : all);
      }
      const all = cache.get(name);
      const start = (page - 1) * PAGE_SIZE;
      return {
        page,
        totalPages: Math.max(1, Math.ceil(all.length / PAGE_SIZE)),
        items: all.slice(start, start + PAGE_SIZE).map(({ type, entry }) => toItem(type, entry)),
      };
    },

    // Explorar: tipo ('all' | 'movie' | 'tv'), gênero, ano (de/até) e nota mínima, sempre por popularidade.
    async browse({ type = 'all', genre = null, from = null, to = null, minRating = null, page = 1 } = {}) {
      requireData();
      const rows = [];
      const add = (rowType, entries) => {
        for (const entry of entries) {
          if (genre !== null && !(type === 'tv' ? entry.g?.includes(genre) : fits(rowType, entry, genre))) continue;
          if (passesFilters(entry, { from, to, minRating })) rows.push({ type: rowType, entry });
        }
      };
      if (type !== 'tv') add('movie', moviesByPopularity);
      if (type !== 'movie') add('tv', seriesByPopularity);
      if (type === 'all') rows.sort((a, b) => (b.entry.v ?? 0) - (a.entry.v ?? 0));

      const start = (page - 1) * PAGE_SIZE;
      return {
        page,
        totalPages: Math.max(1, Math.ceil(rows.length / PAGE_SIZE)),
        total: rows.length,
        items: rows.slice(start, start + PAGE_SIZE).map(({ type: rowType, entry }) => toItem(rowType, entry)),
      };
    },

    async search(term, { type = null, from = null, to = null } = {}) {
      requireData();
      const words = normalize(term).split(' ').filter(Boolean);
      if (!words.length) return { items: [] };
      const matches = [];
      for (const row of searchIndex) {
        if (type && row.type !== type) continue;
        if (!passesFilters(row.entry, { from, to })) continue;
        if (!words.every((word) => row.words.some((w) => w.startsWith(word)))) continue;
        const rank = row.title.startsWith(words[0]) ? 0 : row.titleWords.some((w) => w.startsWith(words[0])) ? 1 : 2;
        matches.push({ rank, popularity: row.entry.v ?? 0, row });
      }
      matches.sort((a, b) => a.rank - b.rank || b.popularity - a.popularity);
      return { items: matches.slice(0, SEARCH_LIMIT).map(({ row }) => toItem(row.type, row.entry)) };
    },

    async seasons(id) {
      return { seasons: (seriesById.get(id)?.s ?? []).map(([number]) => number) };
    },

    async episodes(id, season) {
      const found = (seriesById.get(id)?.s ?? []).find(([number]) => number === season);
      return { season, episodes: found ? Array.from({ length: found[1] }, (_, i) => i + 1) : [] };
    },

    // Episódio seguinte ao informado: o próximo da temporada ou o 1º da próxima. null = era o último (ou a série não está
    // no catálogo, caso em que o chamador trata como "série concluída").
    nextEpisode(id, season, episode) {
      const seasons = seriesById.get(id)?.s ?? [];
      const current = seasons.find(([number]) => number === season);
      if (!current) return null;
      if (episode < current[1]) return { season, episode: episode + 1 };
      const later = seasons.map(([number]) => number).filter((number) => number > season);
      return later.length ? { season: Math.min(...later), episode: 1 } : null;
    },

    // Metadado oficial de um título (o servidor não depende do que o navegador manda).
    lookup(type, id) {
      const entry = entryOf(type, id);
      return entry ? toItem(type, entry) : null;
    },
  };
}
