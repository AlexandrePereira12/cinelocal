/*
 * Gera o catálogo ("foto") que a função do Netlify serve: netlify/data/catalogo.mjs.
 * Roda no PC do dono, não no Netlify:  npm run atualizar-catalogo
 *
 * Por que existe: o embedplayapi.top recusa o IP de datacenter da função, então a função não pode
 * consultá-lo em runtime. Aqui (IP residencial) baixamos a lista de ids que ele tem (/api/all-ids) e
 * buscamos os metadados de cada id na API oficial do TMDB. O Netlify só empacota o resultado.
 * A chave do TMDB fica só no `.env` local (TMDB_TOKEN = "API Read Access Token" de themoviedb.org/settings/api).
 *
 * Decisões:
 * - Um snapshot ruim nunca sobrescreve o bom. Antes de gravar há gates: contagem do all-ids bate com o que
 *   ele próprio declara, falha de rede/404 do TMDB sob teto, e o total não pode cair muito frente ao anterior.
 *   Em qualquer abort o arquivo atual fica intacto e o script sai com código 1. Escrita atômica (tmp + rename).
 * - O tipo (filme/série) vem da lista de origem do all-ids, nunca de heurística.
 * - Conteúdo adulto (`adult: true`) é descartado.
 * - Séries: só temporadas ≥ 1 com episódios; temporadas não exibidas ainda e episódios além de
 *   `last_episode_to_air` ficam de fora (o TMDB conta episódios futuros).
 * - Formato: um item por linha (diff do git legível), campos nulos omitidos, sinopse cortada em 240 caracteres.
 *   Chaves curtas: i id · t título · ot título original · y ano · d data · p pôster · b backdrop · r nota ·
 *   n votos · v popularidade · o sinopse · rt duração (filme) · g ids de gênero (filme e série, cada um no seu
 *   conjunto de ids) · s temporadas [[número, episódios], ...] (série).
 *   Topo do arquivo: `genres` (filme) e `tvGenres` (série) = { idDoGênero: "nome em pt-BR" }.
 * - Atualização automática: .github/workflows/atualizar-catalogo.yml roda este mesmo script toda semana no GitHub
 *   e, se o catálogo mudou, faz o commit (o Netlify publica sozinho). Se o embedplayapi recusar o IP do GitHub, o
 *   passo 1/3 falha com código ≠ 0 e o catálogo atual fica como está.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const EMBEDPLAY = 'https://embedplayapi.top';
const TMDB = 'https://api.themoviedb.org/3';
const OUTPUT_FILE = fileURLToPath(new URL('../netlify/data/catalogo.mjs', import.meta.url));

const IDS_TIMEOUT_MS = 180_000;
const TMDB_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 4;
const OVERVIEW_MAX = 240;

export const GATES = {
  maxFailedRatio: 0.02,
  maxNotFoundRatio: 0.1,
  minVsPreviousRatio: 0.9,
};

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- rede com retry ---

async function requestJson(url, { fetchImpl, headers = {}, timeoutMs, sleep = defaultSleep, allow404 = false }) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 404 && allow404) return { notFound: true };
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers?.get?.('retry-after'));
        lastError = new Error(`HTTP ${res.status}`);
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : attempt * 1500);
        continue;
      }
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { fatal: true });
      return { data: await res.json() };
    } catch (err) {
      if (err.fatal) throw err;
      lastError = err;
      await sleep(attempt * 1500);
    }
  }
  throw lastError ?? new Error('falha desconhecida');
}

// --- lista de ids do embedplay ---

export async function loadAvailableIds({ fetchImpl = fetch, sleep } = {}) {
  const load = async (type, key) => {
    const { data } = await requestJson(`${EMBEDPLAY}/api/all-ids?type=${type}`, {
      fetchImpl,
      sleep,
      timeoutMs: IDS_TIMEOUT_MS,
      headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0 Safari/537.36' },
    });
    const list = data?.results?.[key];
    if (data?.status !== 'success' || !Array.isArray(list)) throw new Error(`all-ids (${type}): resposta inesperada`);
    if (data.counts?.[key] !== list.length) {
      throw new Error(`all-ids (${type}): declarou ${data.counts?.[key]} itens mas veio ${list.length} (resposta truncada?)`);
    }
    const ids = [...new Set(list.map((x) => String(x?.tmdb_id ?? '')).filter((id) => /^\d{1,9}$/.test(id)))];
    if (ids.length < list.length * 0.99) throw new Error(`all-ids (${type}): muitos itens sem tmdb_id válido`);
    return ids;
  };

  const movies = await load('movie', 'movies');
  const series = await load('series', 'series');
  const seriesSet = new Set(series);
  return { movies, series, overlap: movies.filter((id) => seriesSet.has(id)).length };
}

// --- mapeamento TMDB -> formato compacto ---

const yearOf = (date) => (/^\d{4}/.test(date ?? '') ? date.slice(0, 4) : undefined);
const round1 = (n) => (typeof n === 'number' ? Math.round(n * 10) / 10 : undefined);
const asPath = (p) => (typeof p === 'string' && /^\/[\w-]{1,60}\.(?:jpg|png|webp)$/.test(p) ? p : undefined);

function truncate(text, max) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return undefined;
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

function common(d, title, original, date) {
  return {
    i: Number(d.id),
    t: String(title ?? '').trim(),
    ot: original && original !== title ? String(original).trim() : undefined,
    y: yearOf(date),
    d: /^\d{4}-\d{2}-\d{2}$/.test(date ?? '') ? date : undefined,
    p: asPath(d.poster_path),
    b: asPath(d.backdrop_path),
    r: d.vote_count > 0 ? round1(d.vote_average) : undefined,
    n: d.vote_count > 0 ? d.vote_count : undefined,
    v: round1(d.popularity),
    o: truncate(d.overview, OVERVIEW_MAX),
  };
}

function genreIds(d) {
  const ids = (Array.isArray(d.genres) ? d.genres : []).map((g) => g?.id).filter((id) => Number.isInteger(id) && id > 0);
  return ids.length ? ids : undefined;
}

export function compactMovie(d) {
  if (!d || d.adult === true || !d.title) return null;
  return { ...common(d, d.title, d.original_title, d.release_date), rt: d.runtime > 0 ? d.runtime : undefined, g: genreIds(d) };
}

export function compactSeries(d, today) {
  if (!d || d.adult === true || !d.name) return null;
  const last = d.last_episode_to_air;
  const seasons = [];
  for (const s of d.seasons ?? []) {
    const number = s.season_number;
    const count = s.episode_count;
    if (!(number >= 1) || !(count > 0)) continue;
    if (last) {
      if (number > last.season_number) continue;
      seasons.push([number, number === last.season_number ? Math.min(count, last.episode_number) : count]);
    } else if (s.air_date && s.air_date <= today) {
      seasons.push([number, count]);
    }
  }
  return { ...common(d, d.name, d.original_name, d.first_air_date), g: genreIds(d), s: seasons };
}

// --- coleta no TMDB ---

function createPacer(minIntervalMs, sleep) {
  let next = 0;
  return async () => {
    const now = Date.now();
    const start = Math.max(now, next);
    next = start + minIntervalMs;
    if (start > now) await sleep(start - now);
  };
}

export async function collect({ ids, token, fetchImpl = fetch, today, concurrency = 10, minIntervalMs = 30, sleep = defaultSleep, onProgress }) {
  const pace = createPacer(minIntervalMs, sleep);
  const jobs = [...ids.movies.map((id) => ['movie', id]), ...ids.series.map((id) => ['tv', id])];
  const result = { movies: [], series: [], genres: {}, tvGenres: {}, stats: { total: jobs.length, ok: 0, notFound: 0, failed: 0, discarded: 0 } };
  let cursor = 0;
  let done = 0;

  async function worker() {
    while (cursor < jobs.length) {
      const [kind, id] = jobs[cursor++];
      try {
        await pace();
        const reply = await requestJson(`${TMDB}/${kind}/${id}?language=pt-BR`, {
          fetchImpl,
          sleep,
          timeoutMs: TMDB_TIMEOUT_MS,
          allow404: true,
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        });
        if (reply.notFound) {
          result.stats.notFound++;
        } else {
          const entry = kind === 'movie' ? compactMovie(reply.data) : compactSeries(reply.data, today);
          if (!entry) result.stats.discarded++;
          else {
            (kind === 'movie' ? result.movies : result.series).push(entry);
            result.stats.ok++;
            // Nomes dos gêneros (já em pt-BR) vêm das próprias respostas. Filme e série usam ids de gênero diferentes no TMDB.
            const names = kind === 'movie' ? result.genres : result.tvGenres;
            for (const g of reply.data.genres ?? []) {
              if (Number.isInteger(g?.id) && typeof g.name === 'string' && g.name.trim()) names[g.id] = g.name.trim();
            }
          }
        }
      } catch (err) {
        if (err.message === 'HTTP 401') {
          throw new Error('TMDB recusou o token (401). O TMDB_TOKEN tem que ser o "API Read Access Token" (o LONGO, começa com eyJ), não a "API Key" curta.');
        }
        result.stats.failed++;
      }
      onProgress?.(++done, jobs.length);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  result.movies.sort((a, b) => a.i - b.i);
  result.series.sort((a, b) => a.i - b.i);
  return result;
}

// --- gates e gravação ---

export const MIN_GENRES = 10; // o TMDB tem cerca de 19 gêneros de filme

export function checkGates({ stats, kept, previousTotal, genreCount = MIN_GENRES }) {
  const problems = [];
  if (kept === 0) problems.push('nenhum título coletado');
  if (kept > 0 && genreCount < MIN_GENRES) problems.push(`o TMDB devolveu só ${genreCount} gêneros (esperado ao menos ${MIN_GENRES}); a seleção de gêneros ficaria quebrada`);
  if (stats.total > 0 && stats.failed / stats.total > GATES.maxFailedRatio) {
    problems.push(`falhas de rede/TMDB demais: ${stats.failed} de ${stats.total} (teto ${GATES.maxFailedRatio * 100}%)`);
  }
  if (stats.total > 0 && stats.notFound / stats.total > GATES.maxNotFoundRatio) {
    problems.push(`ids inexistentes no TMDB demais: ${stats.notFound} de ${stats.total} (teto ${GATES.maxNotFoundRatio * 100}%)`);
  }
  if (previousTotal > 0 && kept < previousTotal * GATES.minVsPreviousRatio) {
    problems.push(`o total caiu de ${previousTotal} para ${kept} (mínimo aceito: ${Math.ceil(previousTotal * GATES.minVsPreviousRatio)})`);
  }
  return problems;
}

export function serialize({ generatedAt, genres = {}, tvGenres = {}, movies, series }) {
  const lines = (items) => items.map((item) => `    ${JSON.stringify(item)}`).join(',\n');
  return [
    '// Gerado por scripts/atualizar-catalogo.mjs (npm run atualizar-catalogo). Não edite à mão.',
    'export default {',
    `  generatedAt: ${JSON.stringify(generatedAt)},`,
    `  genres: ${JSON.stringify(genres)},`,
    `  tvGenres: ${JSON.stringify(tvGenres)},`,
    '  movies: [',
    lines(movies),
    '  ],',
    '  series: [',
    lines(series),
    '  ],',
    '};',
    '',
  ].join('\n');
}

export function writeAtomic(file, content) {
  mkdirSync(fileURLToPath(new URL('.', pathToFileURL(file))), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

async function previousTotal(file) {
  if (!existsSync(file)) return 0;
  try {
    const mod = await import(`${pathToFileURL(file).href}?t=${randomUUID()}`); // sufixo único: o cache de módulos do Node não pode servir versão antiga
    return (mod.default?.movies?.length ?? 0) + (mod.default?.series?.length ?? 0);
  } catch {
    return 0;
  }
}

export async function refreshCatalog({ token, fetchImpl = fetch, file = OUTPUT_FILE, today = new Date().toISOString().slice(0, 10), sleep, log = console.log, concurrency, minIntervalMs }) {
  log('1/3 baixando a lista de ids do embedplay…');
  const ids = await loadAvailableIds({ fetchImpl, sleep });
  log(`    ${ids.movies.length} filmes e ${ids.series.length} séries disponíveis (${ids.overlap} ids aparecem nas duas listas)`);

  log('2/3 consultando o TMDB (leva alguns minutos)…');
  const started = Date.now();
  const collected = await collect({
    ids,
    token,
    fetchImpl,
    today,
    sleep,
    concurrency,
    minIntervalMs,
    onProgress: (done, total) => {
      if (done % 1000 === 0 || done === total) log(`    ${done}/${total}`);
    },
  });
  const { stats } = collected;
  const kept = collected.movies.length + collected.series.length;

  const genreCount = Object.keys(collected.genres).length;
  const problems = checkGates({ stats, kept, previousTotal: await previousTotal(file), genreCount });
  if (problems.length) {
    const error = new Error(`snapshot rejeitado, o catálogo atual foi mantido:\n  - ${problems.join('\n  - ')}`);
    error.stats = stats;
    throw error;
  }

  log('3/3 gravando…');
  writeAtomic(file, serialize({ generatedAt: new Date().toISOString(), genres: collected.genres, tvGenres: collected.tvGenres, movies: collected.movies, series: collected.series }));
  const summary = {
    filmes: collected.movies.length,
    series: collected.series.length,
    generos: genreCount,
    inexistentesNoTmdb: stats.notFound,
    falhas: stats.failed,
    descartados: stats.discarded,
    idsNasDuasListas: ids.overlap,
    segundos: Math.round((Date.now() - started) / 1000),
    kb: Math.round(statSync(file).size / 1024),
  };
  log(`pronto: ${JSON.stringify(summary)}`);
  return summary;
}

async function main() {
  try {
    process.loadEnvFile('.env');
  } catch {
    /* sem .env: usa só o ambiente do processo */
  }
  const token = process.env.TMDB_TOKEN;
  if (!token) {
    console.error(
      'Falta o TMDB_TOKEN. Crie conta em themoviedb.org, abra Settings > API e copie o "API Read Access Token"\n' +
        '(o token LONGO, que começa com eyJ; não a "API Key" curta). Adicione esta linha ao arquivo .env da raiz\n' +
        'do projeto (o git ignora esse arquivo, e as outras linhas dele continuam):  TMDB_TOKEN=...',
    );
    process.exit(1);
  }
  try {
    await refreshCatalog({ token });
  } catch (err) {
    console.error(`ERRO: ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
