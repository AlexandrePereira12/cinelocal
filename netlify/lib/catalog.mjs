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
 *   palavra do título (ou do título original). Começo do título vem primeiro, depois a popularidade.
 * - Séries: temporadas e episódios vêm da contagem do TMDB (sem sondar o provedor).
 * - Gêneros: o usuário escolhe 2 gêneros de FILME (`genres()`); catálogo sem gêneros devolve `genres()` vazio e o
 *   recurso fica desligado (ninguém é obrigado a escolher).
 * - Recomendação (`recommend`) mistura filme e série: série tem ids de gênero próprios no TMDB, então cada gênero de
 *   filme é ligado aos equivalentes de série por uma tabela fixa (TV_EQUIVALENTS). Gênero sem equivalente (Terror,
 *   Romance, Thriller...) recomenda só filme. Três listas sem repetição entre si: só do gênero 1, só do gênero 2 e
 *   os que têm os dois; o que o usuário já abriu (histórico) nunca é recomendado.
 */

import { HttpError } from './errors.mjs';

export const EMBED_BASE = 'https://embedplayapi.top/embed';

const PAGE_SIZE = 30;
const TRENDING_CAP = 60;
const TOP_MIN_VOTES = 500;
const SEARCH_LIMIT = 40;
const RECOMMEND_LIMIT = 30;
const MIX_MIN = 10; // com menos que isso de títulos nos dois gêneros, a lista "mistura" é completada com os próximos de cada gênero

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

export function createCatalog({ data, now = Date.now }) {
  const movies = data?.movies ?? [];
  const series = data?.series ?? [];
  const seriesById = new Map(series.map((entry) => [String(entry.i), entry]));
  const moviesById = new Map(movies.map((entry) => [String(entry.i), entry]));

  const byPopularity = (list) => [...list].sort(byDesc('v'));
  const byVotes = (list) => [...list].sort(byDesc('n'));
  const moviesByPopularity = byPopularity(movies);
  const seriesByPopularity = byPopularity(series);

  // Gêneros de filme que de fato têm título no catálogo (ids e nomes em pt-BR vêm do TMDB, via snapshot).
  const usedGenreIds = new Set(movies.flatMap((entry) => entry.g ?? []));
  const genreOptions = Object.entries(data?.genres ?? {})
    .map(([id, name]) => ({ id: Number(id), name: String(name) }))
    .filter((genre) => Number.isInteger(genre.id) && usedGenreIds.has(genre.id))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));

  const lists = {
    'trending-movies': { type: 'movie', cap: TRENDING_CAP, items: () => byPopularity(movies) },
    'trending-shows': { type: 'tv', cap: TRENDING_CAP, items: () => byPopularity(series) },
    'top-movies': {
      type: 'movie',
      cap: TRENDING_CAP,
      items: () => movies.filter((e) => e.r != null && e.n >= TOP_MIN_VOTES).sort((a, b) => b.r - a.r || b.n - a.n),
    },
    'recent-movies': {
      type: 'movie',
      cap: TRENDING_CAP,
      items: () => {
        const today = new Date(now()).toISOString().slice(0, 10);
        return movies.filter((e) => e.d && e.d <= today).sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : (b.v ?? 0) - (a.v ?? 0)));
      },
    },
    'library-movies': { type: 'movie', items: () => byVotes(movies) },
    'library-shows': { type: 'tv', items: () => byVotes(series) },
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

  return {
    // Opções para a escolha de gêneros favoritos (vazio = catálogo sem gêneros: o recurso fica desligado).
    genres() {
      return genreOptions.map((genre) => ({ ...genre }));
    },

    // Recomendações pelos 2 gêneros favoritos, misturando filme e série. `exclude` = chaves "tipo:id" que o usuário já abriu.
    // Devolve { first, second, both }: só do 1º gênero, só do 2º e os que têm os dois. Sem repetição entre as três.
    recommend([a, b], exclude = new Set(), limit = RECOMMEND_LIMIT) {
      const fits = (type, entry, genreId) => {
        if (type === 'movie') return Boolean(entry.g?.includes(genreId));
        const equivalents = TV_EQUIVALENTS[genreId];
        return Boolean(equivalents && entry.g?.some((id) => equivalents.includes(id)));
      };
      const pool = (type, list) =>
        list
          .filter((entry) => !exclude.has(`${type}:${entry.i}`))
          .map((entry) => ({ type, entry, a: fits(type, entry, a), b: fits(type, entry, b) }))
          .filter((row) => row.a || row.b);
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

    async list(name, page) {
      const list = lists[name];
      if (!list) throw new HttpError(404, 'Lista desconhecida', 'not_found');
      requireData();
      if (!cache.has(name)) {
        const all = list.items();
        cache.set(name, list.cap ? all.slice(0, list.cap) : all);
      }
      const all = cache.get(name);
      const start = (page - 1) * PAGE_SIZE;
      return {
        page,
        totalPages: Math.max(1, Math.ceil(all.length / PAGE_SIZE)),
        items: all.slice(start, start + PAGE_SIZE).map((entry) => toItem(list.type, entry)),
      };
    },

    async search(term) {
      requireData();
      const words = normalize(term).split(' ').filter(Boolean);
      if (!words.length) return { items: [] };
      const matches = [];
      for (const row of searchIndex) {
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

    // Metadado oficial de um título (o servidor não depende do que o navegador manda).
    lookup(type, id) {
      const entry = (type === 'tv' ? seriesById : moviesById).get(id);
      return entry ? toItem(type, entry) : null;
    },
  };
}
