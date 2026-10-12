/*
 * Catálogo do embedplayapi.top.
 *
 * Decisões:
 * - A API oficial (`/api/all-ids`) só devolve IDs. Título, ano, pôster e qualidade vêm do HTML das páginas
 *   de catálogo (cards `.movie-card`), convertido para JSON aqui; o front nunca recebe HTML do upstream.
 * - Rotas fixas mapeadas para paths fixos do upstream: nada de proxy de URL arbitrária.
 * - Pôsteres vêm de image.tmdb.org (o mirror do upstream dá 403 fora do site). Sem chave do TMDB não há backdrop.
 * - Séries: a API só responde "existe/não existe" por episódio (`/api/status`), então temporadas e episódios
 *   são descobertos por sondagem em lotes (limitados por invocação) e cacheados em memória da instância.
 * - O upstream fica atrás do Cloudflare e pode recusar IP de datacenter: respostas 403/429/503, ou uma página
 *   de lista sem nenhum card, viram `upstream_blocked` (502 claro) em vez de catálogo vazio silencioso.
 */

import { HttpError } from './errors.mjs';

export const EMBED_BASE = 'https://embedplayapi.top/embed';

const UPSTREAM = 'https://embedplayapi.top';
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const CATALOG_TTL_MS = 10 * 60 * 1000;
const STATUS_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10000;
const MAX_CONCURRENT = 8;
const MAX_CACHE_ENTRIES = 2000;
const SEASON_BATCHES = 3;
const SEASON_BATCH_SIZE = 10;
const EPISODE_BATCHES = 4;
const EPISODE_BATCH_SIZE = 25;

const LISTS = {
  'trending-movies': { path: '/trending/movies', type: 'movie' },
  'trending-shows': { path: '/trending/shows', type: 'tv' },
  'top-movies': { path: '/imdb-top/movies', type: 'movie' },
  'recent-movies': { path: '/recent-releases/movies', type: 'movie' },
  'library-movies': { path: '/library/movies', type: 'movie' },
  'library-shows': { path: '/library/shows', type: 'tv' },
};

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const hex = entity[1].toLowerCase() === 'x';
      const code = parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function textOf(html) {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

export function parseCards(html, fixedType) {
  const items = [];
  const seen = new Set();

  for (const card of html.split('card movie-card').slice(1)) {
    const link = card.match(/\/embed\/([A-Za-z0-9]+)(?:\/(\d+)\/(\d+))?/);
    const titleBlock = card.match(/class="title mt-0">([\s\S]*?)<\/p>/);
    if (!link || !titleBlock || seen.has(link[1])) continue;
    seen.add(link[1]);

    const title = textOf(titleBlock[1]);
    const titleYear = title.match(/^(.*\S)\s+-\s+(\d{4})$/);
    const poster = card.match(/url\(https?:\/\/[^)\s]*\/tmdb\/w\d+(\/[\w-]+\.(?:jpg|png|webp))\)/);
    // O badge do topo é a qualidade (HD/CAM) ou, no Top IMDb, a nota.
    const badge = textOf(card.match(/class="top">([\s\S]*?)<\/div>/)?.[1] ?? '');
    const isRating = /^\d+(\.\d+)?$/.test(badge);
    const runtime = textOf(card.match(/class="bottom">([\s\S]*?)<\/div>/)?.[1] ?? '').match(/(\d+)\s*Min/i);

    // Busca mistura filmes e séries: link com /T/E é série; sem runtime também (cards de série não trazem).
    const type = fixedType ?? (link[2] || !runtime ? 'tv' : 'movie');

    items.push({
      id: link[1],
      type,
      title: titleYear ? titleYear[1] : title,
      year: titleYear ? titleYear[2] : null,
      poster: poster ? poster[1] : null,
      quality: badge && !isRating ? badge : null,
      rating: isRating ? Number(badge) : null,
      runtime: runtime ? Number(runtime[1]) : null,
    });
  }
  return items;
}

function parseTotalPages(html) {
  const pages = [...html.matchAll(/[?&]page=(\d+)/g)].map((m) => Number(m[1]));
  return pages.length ? Math.max(...pages) : 1;
}

export function createCatalog({ fetchImpl = fetch, now = Date.now } = {}) {
  let active = 0;
  const waiting = [];
  const cache = new Map();

  function limited(task) {
    return new Promise((resolve, reject) => {
      const run = () => {
        active++;
        task()
          .then(resolve, reject)
          .finally(() => {
            active--;
            waiting.shift()?.();
          });
      };
      if (active < MAX_CONCURRENT) run();
      else waiting.push(run);
    });
  }

  async function fetchOnce(pathAndQuery, ajax) {
    let res;
    try {
      res = await fetchImpl(UPSTREAM + pathAndQuery, {
        headers: {
          'User-Agent': USER_AGENT,
          'Accept-Language': 'pt-BR,pt;q=0.9',
          ...(ajax ? { 'X-Requested-With': 'XMLHttpRequest' } : {}),
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch {
      throw new HttpError(502, 'Catálogo indisponível a partir do servidor', 'upstream_unreachable');
    }
    if ([403, 429, 503].includes(res.status)) {
      throw new HttpError(502, 'Catálogo indisponível a partir do servidor', 'upstream_blocked');
    }
    if (!res.ok) throw new HttpError(502, 'Catálogo indisponível a partir do servidor', 'upstream_error');
    return res;
  }

  // O upstream oscila: uma nova tentativa cobre timeout/5xx pontual (bloqueio 403/429/503 não é repetido).
  function fetchUpstream(pathAndQuery, { ajax = false } = {}) {
    return limited(async () => {
      try {
        return await fetchOnce(pathAndQuery, ajax);
      } catch (err) {
        if (err.code === 'upstream_blocked') throw err;
        return fetchOnce(pathAndQuery, ajax);
      }
    });
  }

  async function cached(key, ttl, loader) {
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttl) return hit.value;
    if (cache.size >= MAX_CACHE_ENTRIES) cache.clear();
    const entry = { at: now(), value: loader() };
    cache.set(key, entry);
    try {
      return await entry.value;
    } catch (err) {
      if (cache.get(key) === entry) cache.delete(key);
      throw err;
    }
  }

  function episodeExists(id, season, episode) {
    return cached(`status:${id}:${season}:${episode}`, STATUS_TTL_MS, async () => {
      const res = await fetchUpstream(`/api/status?tmdb=${id}&sea=${season}&epi=${episode}&type=tv`);
      return (await res.json()).status === 'success';
    });
  }

  async function probe(from, count, check) {
    const numbers = Array.from({ length: count }, (_, i) => from + i);
    const results = await Promise.all(numbers.map(check));
    return numbers.map((n, i) => ({ n, ok: results[i] }));
  }

  // Sonda em lotes; segue para o próximo lote só se o último número do lote atual existe.
  async function discover(batches, size, check) {
    const found = [];
    for (let b = 0; b < batches; b++) {
      const batch = await probe(b * size + 1, size, check);
      found.push(...batch.filter((r) => r.ok).map((r) => r.n));
      if (!batch.at(-1).ok) break;
    }
    return found;
  }

  return {
    async list(name, page) {
      const list = LISTS[name];
      if (!list) throw new HttpError(404, 'Lista desconhecida', 'not_found');
      return cached(`list:${name}:${page}`, CATALOG_TTL_MS, async () => {
        const html = await (await fetchUpstream(`${list.path}${page > 1 ? `?page=${page}` : ''}`)).text();
        const items = parseCards(html, list.type);
        if (page === 1 && !items.length) {
          throw new HttpError(502, 'Catálogo indisponível a partir do servidor', 'upstream_blocked');
        }
        return { page, totalPages: parseTotalPages(html), items };
      });
    },

    async search(term) {
      return cached(`search:${term.toLowerCase()}`, CATALOG_TTL_MS, async () => {
        const res = await fetchUpstream(`/search?term=${encodeURIComponent(term)}`, { ajax: true });
        return { items: parseCards(await res.text(), null) };
      });
    },

    async seasons(id) {
      return cached(`seasons:${id}`, STATUS_TTL_MS, async () => ({
        seasons: await discover(SEASON_BATCHES, SEASON_BATCH_SIZE, (s) => episodeExists(id, s, 1)),
      }));
    },

    async episodes(id, season) {
      return cached(`episodes:${id}:${season}`, STATUS_TTL_MS, async () => ({
        season,
        episodes: await discover(EPISODE_BATCHES, EPISODE_BATCH_SIZE, (e) => episodeExists(id, season, e)),
      }));
    },
  };
}
