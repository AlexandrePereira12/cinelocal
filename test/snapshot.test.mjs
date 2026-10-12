import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { checkGates, collect, compactMovie, compactSeries, loadAvailableIds, refreshCatalog, serialize } from '../scripts/atualizar-catalogo.mjs';

const noSleep = async () => {};
const TODAY = '2026-10-11';

const json = (body, status = 200, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  json: async () => body,
});

function fakeWorld({ movies = [101, 102], series = [201], tmdb = {}, declared } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('/api/all-ids?type=movie')) {
      return json({ status: 'success', counts: { movies: declared?.movies ?? movies.length, series: 0 }, results: { movies: movies.map((id) => ({ tmdb_id: String(id), imdb_id: null })), series: [] } });
    }
    if (url.includes('/api/all-ids?type=series')) {
      return json({ status: 'success', counts: { movies: 0, series: series.length }, results: { movies: [], series: series.map((id) => ({ tmdb_id: String(id), imdb_id: null })) } });
    }
    const [, kind, id] = url.match(/\/3\/(movie|tv)\/(\d+)/);
    const handler = tmdb[`${kind}:${id}`] ?? tmdb.default;
    if (handler) return handler(calls);
    return kind === 'movie'
      ? json({ id: Number(id), title: `Filme ${id}`, release_date: '2020-01-02', poster_path: `/p${id}.jpg`, vote_count: 10, vote_average: 7.25, popularity: 12.34, overview: 'Sinopse' })
      : json({ id: Number(id), name: `Série ${id}`, first_air_date: '2019-03-04', vote_count: 5, vote_average: 8, popularity: 3, seasons: [{ season_number: 1, episode_count: 4, air_date: '2019-03-04' }], last_episode_to_air: { season_number: 1, episode_number: 4 } });
  };
  return { fetchImpl, calls };
}

test('compactMovie mapeia os campos do TMDB, omite o que falta e descarta adulto', () => {
  const entry = compactMovie({
    id: 11, title: 'Título', original_title: 'Original', release_date: '2020-05-06', runtime: 95,
    poster_path: '/p.jpg', backdrop_path: '/b.jpg', vote_average: 7.26, vote_count: 321, popularity: 55.55, overview: '  Texto   com   espaços  ',
  });
  assert.deepEqual(entry, { i: 11, t: 'Título', ot: 'Original', y: '2020', d: '2020-05-06', p: '/p.jpg', b: '/b.jpg', r: 7.3, n: 321, v: 55.6, o: 'Texto com espaços', rt: 95 });

  const sparse = compactMovie({ id: 12, title: 'X', original_title: 'X', release_date: '', poster_path: '../x.jpg', vote_count: 0, vote_average: 0, runtime: 0, overview: '' });
  assert.deepEqual(JSON.parse(JSON.stringify(sparse)), { i: 12, t: 'X' }, 'sem título original igual, data, pôster inválido, nota sem votos, duração 0 ou sinopse vazia');

  assert.equal(compactMovie({ id: 13, title: 'Y', adult: true }), null);
  assert.equal(compactMovie({ id: 14, title: '' }), null);
  assert.equal(compactMovie({ id: 15, title: 'Z', overview: 'a'.repeat(500) }).o.length, 240);
});

test('compactSeries filtra temporadas: especiais, vazias, futuras e episódios ainda não exibidos', () => {
  const withLast = compactSeries(
    {
      id: 1, name: 'S', first_air_date: '2020-01-01',
      seasons: [
        { season_number: 0, episode_count: 5, air_date: '2019-01-01' },
        { season_number: 1, episode_count: 10, air_date: '2020-01-01' },
        { season_number: 2, episode_count: 0, air_date: '2021-01-01' },
        { season_number: 3, episode_count: 12, air_date: '2022-01-01' },
        { season_number: 4, episode_count: 8, air_date: '2027-01-01' },
      ],
      last_episode_to_air: { season_number: 3, episode_number: 7 },
    },
    TODAY,
  );
  assert.deepEqual(withLast.s, [[1, 10], [3, 7]]);

  const noLast = compactSeries(
    { id: 2, name: 'T', seasons: [{ season_number: 1, episode_count: 3, air_date: '2024-01-01' }, { season_number: 2, episode_count: 3, air_date: '2027-01-01' }, { season_number: 3, episode_count: 3, air_date: null }] },
    TODAY,
  );
  assert.deepEqual(noLast.s, [[1, 3]]);
  assert.equal(compactSeries({ id: 3, name: 'A', adult: true }, TODAY), null);
});

test('all-ids: valida resposta, detecta truncamento, filtra ids inválidos e conta ids nas duas listas', async () => {
  const ok = await loadAvailableIds({ fetchImpl: fakeWorld({ movies: [1, 2, 3], series: [3, 4] }).fetchImpl, sleep: noSleep });
  assert.deepEqual(ok, { movies: ['1', '2', '3'], series: ['3', '4'], overlap: 1 });

  const truncated = fakeWorld({ movies: [1, 2, 3], declared: { movies: 9796 } });
  await assert.rejects(loadAvailableIds({ fetchImpl: truncated.fetchImpl, sleep: noSleep }), /declarou 9796 itens mas veio 3/);

  const wrong = async () => json({ status: 'error' });
  await assert.rejects(loadAvailableIds({ fetchImpl: wrong, sleep: noSleep }), /resposta inesperada/);
});

test('all-ids: tenta de novo em erro 5xx e em timeout antes de desistir', async () => {
  const world = fakeWorld();
  let failures = 2;
  const flaky = async (url, init) => {
    if (url.includes('all-ids?type=movie') && failures-- > 0) {
      if (failures === 1) throw new Error('timeout');
      return json({}, 503);
    }
    return world.fetchImpl(url, init);
  };
  const ids = await loadAvailableIds({ fetchImpl: flaky, sleep: noSleep });
  assert.deepEqual(ids.movies, ['101', '102']);

  const dead = async () => json({}, 500);
  await assert.rejects(loadAvailableIds({ fetchImpl: dead, sleep: noSleep }), /HTTP 500/);
});

test('coleta: 404 do TMDB é contado à parte, 429 respeita Retry-After e adulto é descartado', async () => {
  const sleeps = [];
  let limited = 0;
  const world = fakeWorld({
    movies: [1, 2, 3, 4],
    series: [9],
    tmdb: {
      'movie:2': () => json({}, 404),
      'movie:3': () => (limited++ === 0 ? json({}, 429, { 'retry-after': '3' }) : json({ id: 3, title: 'Depois do limite', vote_count: 1, vote_average: 5 })),
      'movie:4': () => json({ id: 4, title: 'Adulto', adult: true }),
    },
  });
  const ids = await loadAvailableIds({ fetchImpl: world.fetchImpl, sleep: noSleep });
  const result = await collect({ ids, token: 'T', fetchImpl: world.fetchImpl, today: TODAY, minIntervalMs: 0, sleep: async (ms) => void sleeps.push(ms) });

  assert.deepEqual(result.stats, { total: 5, ok: 3, notFound: 1, failed: 0, discarded: 1 });
  assert.deepEqual(result.movies.map((m) => m.i), [1, 3]);
  assert.deepEqual(result.series.map((s) => s.i), [9]);
  assert.ok(sleeps.includes(3000), 'esperou o Retry-After de 3 s');
});

test('coleta: usa Bearer, língua pt-BR e aborta com mensagem clara se o token for recusado', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => (seen.push({ url, auth: init.headers.Authorization }), json({}, 401));
  await assert.rejects(
    collect({ ids: { movies: ['1'], series: [] }, token: 'segredo', fetchImpl, today: TODAY, minIntervalMs: 0, sleep: noSleep }),
    /TMDB recusou o token/,
  );
  assert.equal(seen[0].auth, 'Bearer segredo');
  assert.ok(seen[0].url.endsWith('/3/movie/1?language=pt-BR'));
});

test('gates rejeitam snapshot ruim', () => {
  const ok = { total: 1000, ok: 990, notFound: 8, failed: 2, discarded: 0 };
  assert.deepEqual(checkGates({ stats: ok, kept: 990, previousTotal: 1000 }), []);
  assert.match(checkGates({ stats: { ...ok, failed: 30 }, kept: 970, previousTotal: 0 })[0], /falhas de rede/);
  assert.match(checkGates({ stats: { ...ok, notFound: 150 }, kept: 850, previousTotal: 0 })[0], /inexistentes no TMDB/);
  assert.match(checkGates({ stats: ok, kept: 800, previousTotal: 1000 })[0], /o total caiu de 1000 para 800/);
  assert.match(checkGates({ stats: { total: 0, ok: 0, notFound: 0, failed: 0, discarded: 0 }, kept: 0, previousTotal: 0 })[0], /nenhum título/);
});

test('refreshCatalog grava um módulo importável e nunca sobrescreve o bom com um ruim', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'catalogo-'));
  const file = join(dir, 'catalogo.mjs');
  const logs = [];
  const common = { token: 'T', file, today: TODAY, sleep: noSleep, minIntervalMs: 0, log: (line) => logs.push(line) };

  const good = fakeWorld({ movies: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], series: [20, 21] });
  const summary = await refreshCatalog({ ...common, fetchImpl: good.fetchImpl });
  assert.equal(summary.filmes, 10);
  assert.equal(summary.series, 2);

  const written = readFileSync(file, 'utf8');
  const mod = await import(`${pathToFileURL(file).href}?v=1`);
  assert.equal(mod.default.movies.length, 10);
  assert.deepEqual(mod.default.series[0].s, [[1, 4]]);
  assert.ok(written.split('\n').filter((line) => line.startsWith('    {')).length === 12, 'um item por linha');
  assert.ok(!written.includes('TMDB_TOKEN') && !written.includes('Bearer'), 'nenhum segredo no arquivo');

  // todos os ids falham no TMDB: gate de falhas barra e o arquivo fica intacto
  const broken = fakeWorld({ movies: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], series: [20, 21], tmdb: { default: () => json({}, 400) } });
  await assert.rejects(refreshCatalog({ ...common, fetchImpl: broken.fetchImpl }), /snapshot rejeitado.*falhas de rede/s);
  assert.equal(readFileSync(file, 'utf8'), written, 'arquivo anterior intacto');

  // all-ids encolheu muito frente ao anterior: gate de queda barra
  const shrunk = fakeWorld({ movies: [1, 2], series: [20] });
  await assert.rejects(refreshCatalog({ ...common, fetchImpl: shrunk.fetchImpl }), /o total caiu de 12 para 3/);
  assert.equal(readFileSync(file, 'utf8'), written);

  // placeholder vazio como "anterior": qualquer snapshot válido passa
  writeFileSync(file, 'export default { generatedAt: null, movies: [], series: [] };\n');
  await refreshCatalog({ ...common, fetchImpl: shrunk.fetchImpl });
  assert.equal((await import(`${pathToFileURL(file).href}?v=2`)).default.movies.length, 2);
});

test('serialize gera JS válido mesmo com aspas e caracteres especiais no título', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'catalogo-'));
  const file = join(dir, 'c.mjs');
  const tricky = { i: 1, t: 'Título "com aspas" e \\ barra   separador', y: '2020' };
  writeFileSync(file, serialize({ generatedAt: '2026-01-01T00:00:00Z', movies: [tricky], series: [] }));
  const mod = await import(pathToFileURL(file).href);
  assert.equal(mod.default.movies[0].t, tricky.t);
});
