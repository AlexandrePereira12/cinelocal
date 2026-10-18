import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { annotateNew, checkGates, collect, compactMovie, compactSeries, directorsOf, loadAvailableIds, movieCertification, refreshCatalog, serialize, seriesCertification } from '../scripts/atualizar-catalogo.mjs';

const noSleep = async () => {};
const TODAY = '2026-10-11';

const json = (body, status = 200, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  json: async () => body,
});

// 12 gêneros de filme; cada filme falso devolve metade deles (ímpar: 1ª metade, par: 2ª), então 2 filmes já cobrem os 12.
const GENRES = Array.from({ length: 12 }, (_, i) => ({ id: 100 + i, name: `Gênero ${i + 1}` }));

// Gêneros de série usam ids próprios no TMDB (10759 = Ação e Aventura).
const TV_GENRES = [{ id: 10759, name: 'Ação e Aventura' }, { id: 18, name: 'Drama' }];

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
      ? json({ id: Number(id), title: `Filme ${id}`, release_date: '2020-01-02', poster_path: `/p${id}.jpg`, vote_count: 10, vote_average: 7.25, popularity: 12.34, overview: 'Sinopse', genres: Number(id) % 2 ? GENRES.slice(0, 6) : GENRES.slice(6), credits: { crew: [{ id: 5000 + Number(id), name: `Diretor ${id}`, job: 'Director', profile_path: `/d${id}.jpg` }] }, release_dates: { results: [{ iso_3166_1: 'BR', release_dates: [{ certification: '12' }] }] } })
      : json({ id: Number(id), name: `Série ${id}`, first_air_date: '2019-03-04', vote_count: 5, vote_average: 8, popularity: 3, genres: TV_GENRES, seasons: [{ season_number: 1, episode_count: 4, air_date: '2019-03-04' }], last_episode_to_air: { season_number: 1, episode_number: 4 }, content_ratings: { results: [{ iso_3166_1: 'BR', rating: '14' }] } });
  };
  return { fetchImpl, calls };
}

test('compactMovie mapeia os campos do TMDB, omite o que falta e descarta adulto', () => {
  const entry = compactMovie({
    id: 11, title: 'Título', original_title: 'Original', release_date: '2020-05-06', runtime: 95,
    poster_path: '/p.jpg', backdrop_path: '/b.jpg', vote_average: 7.26, vote_count: 321, popularity: 55.55, overview: '  Texto   com   espaços  ',
    genres: [{ id: 28, name: 'Ação' }, { id: 18, name: 'Drama' }, { id: 'x', name: 'inválido' }, null],
    credits: { crew: [{ id: 77, name: 'Dir', job: 'Director' }] },
    release_dates: { results: [{ iso_3166_1: 'BR', release_dates: [{ certification: '12' }] }] },
  });
  assert.deepEqual(entry, { i: 11, t: 'Título', ot: 'Original', y: '2020', d: '2020-05-06', p: '/p.jpg', b: '/b.jpg', r: 7.3, n: 321, v: 55.6, o: 'Texto com espaços', rt: 95, g: [28, 18], dr: [77], c: 12 });

  const sparse = compactMovie({ id: 12, title: 'X', original_title: 'X', release_date: '', poster_path: '../x.jpg', vote_count: 0, vote_average: 0, runtime: 0, overview: '' });
  assert.deepEqual(JSON.parse(JSON.stringify(sparse)), { i: 12, t: 'X' }, 'sem título original igual, data, pôster inválido, nota sem votos, duração 0 ou sinopse vazia');

  assert.equal(compactMovie({ id: 13, title: 'Y', adult: true }), null);
  assert.equal(compactMovie({ id: 16, title: 'Sem equipe' }).dr, undefined, 'sem diretor, o campo `dr` é omitido');
  assert.equal(compactMovie({ id: 14, title: '' }), null);
  assert.equal(compactMovie({ id: 15, title: 'Z', overview: 'a'.repeat(500) }).o.length, 240);
});

test('compactSeries filtra temporadas: especiais, vazias, futuras e episódios ainda não exibidos', () => {
  const withLast = compactSeries(
    {
      id: 1, name: 'S', first_air_date: '2020-01-01', genres: [{ id: 10759, name: 'Ação e Aventura' }, { id: 'x' }],
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
  assert.deepEqual(withLast.g, [10759], 'gêneros de série, descartando id inválido');

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

test('directorsOf: só quem tem job Director, sem repetir, com teto e ignorando dado inválido', () => {
  const crew = [
    { id: 1, name: ' Ana Dir ', job: 'Director', profile_path: '/ana.jpg' },
    { id: 2, name: 'Roteirista', job: 'Writer', profile_path: '/w.jpg' },
    { id: 1, name: 'Ana Dir', job: 'Director' },
    { id: 3, name: 'Sem foto', job: 'Director', profile_path: null },
    { id: 4, name: '   ', job: 'Director' },
    { id: 'x', name: 'Id ruim', job: 'Director' },
    { id: 5, name: 'Foto ruim', job: 'Director', profile_path: '../x.jpg' },
    { id: 6, name: 'Quarto', job: 'Director' },
  ];
  assert.deepEqual([...directorsOf({ credits: { crew } })], [
    [1, { n: 'Ana Dir', p: '/ana.jpg' }],
    [3, { n: 'Sem foto', p: undefined }],
    [5, { n: 'Foto ruim', p: undefined }],
  ], 'até 3, a repetição de Ana não conta e foto fora do padrão é descartada');
  assert.equal(directorsOf({}).size, 0);
  assert.equal(directorsOf({ credits: { crew: 'x' } }).size, 0);
  assert.deepEqual(compactMovie({ id: 9, title: 'T', credits: { crew: crew.slice(0, 1) } }).dr, [1]);
});

test('coleta: guarda os diretores dos filmes que ficaram, em ordem de id, e descarta os dos filmes descartados', async () => {
  const world = fakeWorld({
    movies: [1, 2, 3],
    series: [],
    tmdb: {
      'movie:3': () => json({ id: 3, title: 'Adulto', adult: true, credits: { crew: [{ id: 999, name: 'Fora', job: 'Director' }] } }),
    },
  });
  const ids = await loadAvailableIds({ fetchImpl: world.fetchImpl, sleep: noSleep });
  const result = await collect({ ids, token: 'T', fetchImpl: world.fetchImpl, today: TODAY, minIntervalMs: 0, sleep: noSleep });
  assert.deepEqual(result.directors, { 5001: { n: 'Diretor 1', p: '/d1.jpg' }, 5002: { n: 'Diretor 2', p: '/d2.jpg' } });
  assert.deepEqual(result.movies.map((m) => m.dr), [[5001], [5002]]);
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
  assert.equal(Object.keys(result.genres).length, 6, 'nomes de gênero vêm só dos filmes que trouxeram gêneros');
  assert.equal(result.genres[100], 'Gênero 1');
  assert.deepEqual(result.tvGenres, { 10759: 'Ação e Aventura', 18: 'Drama' }, 'gêneros de série ficam num mapa próprio');
});

test('coleta: usa Bearer, língua pt-BR e aborta com mensagem clara se o token for recusado', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => (seen.push({ url, auth: init.headers.Authorization }), json({}, 401));
  await assert.rejects(
    collect({ ids: { movies: ['1'], series: [] }, token: 'segredo', fetchImpl, today: TODAY, minIntervalMs: 0, sleep: noSleep }),
    /TMDB recusou o token/,
  );
  assert.equal(seen[0].auth, 'Bearer segredo');
  assert.ok(seen[0].url.endsWith('/3/movie/1?language=pt-BR&append_to_response=credits,release_dates'), 'filme pede créditos e classificação na mesma chamada');
});

test('gates rejeitam snapshot ruim', () => {
  const ok = { total: 1000, ok: 990, notFound: 8, failed: 2, discarded: 0 };
  assert.deepEqual(checkGates({ stats: ok, kept: 990, previousTotal: 1000 }), []);
  assert.match(checkGates({ stats: { ...ok, failed: 30 }, kept: 970, previousTotal: 0 })[0], /falhas de rede/);
  assert.match(checkGates({ stats: { ...ok, notFound: 150 }, kept: 850, previousTotal: 0 })[0], /inexistentes no TMDB/);
  assert.match(checkGates({ stats: ok, kept: 800, previousTotal: 1000 })[0], /o total caiu de 1000 para 800/);
  assert.match(checkGates({ stats: { total: 0, ok: 0, notFound: 0, failed: 0, discarded: 0 }, kept: 0, previousTotal: 0 })[0], /nenhum título/);
  assert.match(checkGates({ stats: ok, kept: 990, previousTotal: 0, genreCount: 3 })[0], /só 3 gêneros/);
  assert.deepEqual(checkGates({ stats: ok, kept: 990, previousTotal: 0, genreCount: 19 }), []);
  assert.match(checkGates({ stats: ok, kept: 990, previousTotal: 0, movies: 900, directed: 100 })[0], /só 100 de 900 filmes trouxeram diretor/);
  assert.deepEqual(checkGates({ stats: ok, kept: 990, previousTotal: 0, movies: 900, directed: 850 }), []);
  assert.match(checkGates({ stats: ok, kept: 990, previousTotal: 0, rated: 100 })[0], /só 100 de 990 títulos trouxeram classificação/);
  assert.deepEqual(checkGates({ stats: ok, kept: 990, previousTotal: 0, rated: 700 }), []);
});

test('classificação indicativa: vale a do Brasil (a mais alta se houver várias), cai para a dos EUA convertida e some sem nenhuma', () => {
  const dates = (country, ...certs) => ({ iso_3166_1: country, release_dates: certs.map((certification) => ({ certification })) });
  assert.equal(movieCertification({ release_dates: { results: [dates('BR', 'L')] } }), 0);
  assert.equal(movieCertification({ release_dates: { results: [dates('BR', '', '12', '16')] } }), 16, 'estreia e relançamento: a mais alta');
  assert.equal(movieCertification({ release_dates: { results: [dates('US', 'PG-13'), dates('BR', '10')] } }), 10, 'Brasil vence os EUA');
  assert.equal(movieCertification({ release_dates: { results: [dates('US', 'PG-13')] } }), 14, 'sem Brasil: PG-13 vira 14 (faixa mais restrita)');
  assert.equal(movieCertification({ release_dates: { results: [dates('US', 'R')] } }), 16);
  assert.equal(movieCertification({ release_dates: { results: [dates('BR', 'abc'), dates('FR', '12')] } }), undefined, 'lixo e outros países são ignorados');
  assert.equal(movieCertification({}), undefined);
  assert.equal(movieCertification({ release_dates: { results: 'x' } }), undefined);

  const rating = (country, value) => ({ iso_3166_1: country, rating: value });
  assert.equal(seriesCertification({ content_ratings: { results: [rating('BR', '14')] } }), 14);
  assert.equal(seriesCertification({ content_ratings: { results: [rating('US', 'TV-Y7')] } }), 0);
  assert.equal(seriesCertification({ content_ratings: { results: [rating('US', 'TV-MA')] } }), 18);
  assert.equal(seriesCertification({ content_ratings: { results: [rating('US', 'NR')] } }), undefined);
  assert.equal(compactSeries({ id: 1, name: 'S', content_ratings: { results: [rating('BR', '12')] } }, TODAY).c, 12);
  assert.equal(JSON.stringify(compactMovie({ id: 2, title: 'Sem classificação' })).includes('"c"'), false, 'sem classificação, `c` não vai para o arquivo');
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
  assert.deepEqual(mod.default.series[0].g, [10759, 18]);
  assert.deepEqual(mod.default.tvGenres, { 10759: 'Ação e Aventura', 18: 'Drama' });
  assert.equal(Object.keys(mod.default.genres).length, 12);
  assert.equal(Object.keys(mod.default.directors).length, 10);
  assert.deepEqual(mod.default.directors[5001], { n: 'Diretor 1', p: '/d1.jpg' });
  assert.deepEqual(mod.default.movies[0].dr, [5001]);
  assert.equal(mod.default.movies[0].c, 12);
  assert.equal(mod.default.series[0].c, 14);
  assert.equal(summary.classificados, 12);
  assert.deepEqual(mod.default.movies[0].g, GENRES.slice(0, 6).map((g) => g.id), 'filme 1 (ímpar) traz os ids do 1º grupo');
  assert.ok(written.split('\n').filter((line) => line.startsWith('    {')).length === 12, 'um item por linha');
  assert.ok(!written.includes('TMDB_TOKEN') && !written.includes('Bearer'), 'nenhum segredo no arquivo');

  // todos os ids falham no TMDB: gate de falhas barra e o arquivo fica intacto
  const broken = fakeWorld({ movies: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], series: [20, 21], tmdb: { default: () => json({}, 400) } });
  await assert.rejects(refreshCatalog({ ...common, fetchImpl: broken.fetchImpl }), /snapshot rejeitado.*falhas de rede/s);
  assert.equal(readFileSync(file, 'utf8'), written, 'arquivo anterior intacto');

  // TMDB sem créditos (mudança de formato): gate barra, senão a seção de diretores ficaria vazia em produção
  const noCredits = async (url, init) => {
    const res = await good.fetchImpl(url, init);
    if (!/\/3\/movie\//.test(url)) return res;
    const body = await res.json();
    delete body.credits;
    return json(body);
  };
  await assert.rejects(refreshCatalog({ ...common, fetchImpl: noCredits }), /só 0 de 10 filmes trouxeram diretor/);
  assert.equal(readFileSync(file, 'utf8'), written, 'arquivo anterior intacto também sem créditos');

  // TMDB sem gêneros (mudança de formato, por exemplo): gate barra, senão a seleção de gêneros quebraria em produção
  const noGenres = async (url, init) => {
    const res = await good.fetchImpl(url, init);
    if (!/\/3\/movie\//.test(url)) return res;
    const body = await res.json();
    delete body.genres;
    return json(body);
  };
  await assert.rejects(refreshCatalog({ ...common, fetchImpl: noGenres }), /só 0 gêneros/);
  assert.equal(readFileSync(file, 'utf8'), written, 'arquivo anterior intacto também sem gêneros');

  // TMDB sem classificação (mudança de formato): gate barra, senão o modo família esconderia o catálogo inteiro
  const noRatings = async (url, init) => {
    const res = await good.fetchImpl(url, init);
    const body = await res.json();
    delete body.release_dates;
    delete body.content_ratings;
    return json(body);
  };
  await assert.rejects(refreshCatalog({ ...common, fetchImpl: noRatings }), /títulos trouxeram classificação/);
  assert.equal(readFileSync(file, 'utf8'), written, 'arquivo anterior intacto também sem classificação');

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
  writeFileSync(file, serialize({ generatedAt: '2026-01-01T00:00:00Z', genres: { 28: 'Ação', 18: 'Drama' }, tvGenres: { 10759: 'Ação e Aventura' }, directors: { 7: { n: 'Zé "Aspas"', p: '/z.jpg' }, 8: { n: 'Sem Foto' } }, movies: [tricky], series: [] }));
  const mod = await import(pathToFileURL(file).href);
  assert.equal(mod.default.movies[0].t, tricky.t);
  assert.deepEqual(mod.default.genres, { 18: 'Drama', 28: 'Ação' });
  assert.deepEqual(mod.default.tvGenres, { 10759: 'Ação e Aventura' });
  assert.deepEqual(mod.default.directors, { 7: { n: 'Zé "Aspas"', p: '/z.jpg' }, 8: { n: 'Sem Foto' } });
});

test('annotateNew: só id novo ganha `a`, quem já estava mantém o seu e `a` velho some', () => {
  const previous = {
    total: 4,
    seen: new Map([
      ['movie:1', undefined], // estava na foto anterior, sem data
      ['movie:2', '2026-10-10'], // novidade de 8 dias atrás: mantém
      ['tv:9', '2026-08-01'], // mais de 30 dias: a data é descartada
      ['movie:5', undefined],
    ]),
  };
  const collected = { movies: [{ i: 1 }, { i: 2 }, { i: 3 }, { i: 9 }], series: [{ i: 9 }, { i: 7 }] };
  const added = annotateNew(collected, previous, '2026-10-18');
  assert.equal(added, 3, 'novos: filme 3, filme 9 e série 7');
  assert.deepEqual(collected.movies, [{ i: 1 }, { i: 2, a: '2026-10-10' }, { i: 3, a: '2026-10-18' }, { i: 9, a: '2026-10-18' }], 'o filme 9 é novo mesmo existindo uma série 9: o tipo faz parte da chave');
  assert.deepEqual(collected.series, [{ i: 9 }, { i: 7, a: '2026-10-18' }]);
});

test('annotateNew: primeira foto (anterior vazia ou ausente) não marca nada como novidade', () => {
  const collected = { movies: [{ i: 1 }], series: [{ i: 2 }] };
  assert.equal(annotateNew(collected, { total: 0, seen: new Map() }, '2026-10-18'), 0);
  assert.deepEqual(collected, { movies: [{ i: 1 }], series: [{ i: 2 }] });
});

test('refreshCatalog: a 1ª coleta não marca novidade; as seguintes marcam só o que chegou e esquecem o que ficou velho', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'catalogo-'));
  const file = join(dir, 'catalogo.mjs');
  const run = async (movies, series, today, version) => {
    const world = fakeWorld({ movies, series });
    const summary = await refreshCatalog({ token: 'T', file, today, sleep: noSleep, minIntervalMs: 0, log: () => {}, fetchImpl: world.fetchImpl });
    const mod = await import(`${pathToFileURL(file).href}?n=${version}`);
    const dates = (list) => Object.fromEntries(list.map((entry) => [entry.i, entry.a]));
    return { summary, movies: dates(mod.default.movies), series: dates(mod.default.series) };
  };
  const base = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  const first = await run(base, [20, 21], '2026-10-04', 'a');
  assert.equal(first.summary.novos, 0);
  assert.ok([...Object.values(first.movies), ...Object.values(first.series)].every((a) => a === undefined), 'nenhum `a` na primeira foto');

  const second = await run([...base, 11, 12], [20, 21, 22], '2026-10-11', 'b');
  assert.equal(second.summary.novos, 3);
  assert.deepEqual([second.movies[1], second.movies[11], second.movies[12], second.series[20], second.series[22]], [undefined, '2026-10-11', '2026-10-11', undefined, '2026-10-11']);

  const third = await run([...base, 11, 12, 13], [20, 21, 22], '2026-10-18', 'c');
  assert.equal(third.summary.novos, 1);
  assert.deepEqual([third.movies[11], third.movies[13], third.series[22]], ['2026-10-11', '2026-10-18', '2026-10-11'], 'quem já era novidade mantém a data');

  const later = await run([...base, 11, 12, 13], [20, 21, 22], '2026-12-01', 'd');
  assert.equal(later.summary.novos, 0);
  assert.ok(Object.values(later.movies).every((a) => a === undefined), 'passou de 30 dias: a data sai do arquivo');
});
