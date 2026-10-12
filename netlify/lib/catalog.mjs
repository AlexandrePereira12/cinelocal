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
 */

import { HttpError } from './errors.mjs';

export const EMBED_BASE = 'https://embedplayapi.top/embed';

const PAGE_SIZE = 30;
const TRENDING_CAP = 60;
const TOP_MIN_VOTES = 500;
const SEARCH_LIMIT = 40;

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
