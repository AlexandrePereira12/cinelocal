import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeApp } from './helpers.mjs';

const MINUTE_MS = 60 * 1000;

const play = (app, token, body) => app.call('POST', '/api/play', { token, body });
const done = (app, token, body) => app.call('POST', '/api/me/done', { token, body });
const library = async (app, token) => (await app.call('GET', '/api/me/library', { token })).body;

test('detalhe do título: dados do catálogo, parecidos, "quero ver" e progresso da pessoa', async () => {
  const app = makeApp();
  const { token } = await app.registerAndApprove();

  const res = await app.call('GET', '/api/title/movie/777', { token });
  assert.equal(res.status, 200);
  assert.equal(res.body.title, 'Do Catálogo');
  assert.deepEqual(res.body.genres, ['Ação']);
  assert.equal(res.body.similar[0].title, 'Parecido');
  assert.equal(res.body.inWatchlist, false);
  assert.equal(res.body.progress, null);

  await play(app, token, { type: 'movie', id: '777' });
  assert.deepEqual((await app.call('GET', '/api/title/movie/777', { token })).body.progress, { season: null, episode: null, done: false });

  const missing = await app.call('GET', '/api/title/movie/424242', { token });
  assert.equal(missing.status, 410, '410 e não 404: o netlify dev reenvia 404 para outro caminho');
  assert.equal(missing.body.code, 'not_found');
  assert.equal((await app.call('GET', '/api/title/anime/1', { token })).status, 404, 'tipo inválido nem casa com a rota');
  assert.equal((await app.call('GET', '/api/title/movie/777')).status, 401);
});

test('o player recebe sinopse e nota do catálogo (info), sem poluir o histórico', async () => {
  const app = makeApp();
  const { token } = await app.registerAndApprove();

  const known = await play(app, token, { type: 'movie', id: '777' });
  assert.equal(known.body.info.overview, 'Sinopse do catálogo');
  assert.deepEqual(known.body.info.genres, ['Ação']);

  const unknown = await play(app, token, { type: 'movie', id: '10', title: 'Fora do catálogo' });
  assert.equal(unknown.body.info, null);

  const lib = await library(app, token);
  assert.ok(lib.continue.every((item) => !('info' in item) && !('overview' in item)), 'o histórico não carrega texto longo');
});

test('quero ver: adiciona, remove, mantém a data da 1ª vez e sai da lista ao abrir o player', async () => {
  const app = makeApp();
  const { token } = await app.registerAndApprove();
  const toggle = (body) => app.call('POST', '/api/me/watchlist', { token, body });

  const added = await toggle({ type: 'movie', id: '777', add: true });
  assert.deepEqual(added.body, { inWatchlist: true });
  const first = (await library(app, token)).watchlist;
  assert.deepEqual(Object.keys(first[0]).sort(), ['addedAt', 'id', 'poster', 'title', 'type', 'year']);
  assert.equal(first[0].title, 'Do Catálogo', 'o metadado vem do catálogo do servidor');
  assert.equal((await app.call('GET', '/api/title/movie/777', { token })).body.inWatchlist, true);

  app.clock.ms += 5 * MINUTE_MS;
  await toggle({ type: 'movie', id: '777', add: true });
  assert.equal((await library(app, token)).watchlist[0].addedAt, first[0].addedAt, 'adicionar de novo não muda a data');

  await toggle({ type: 'tv', id: '300', add: true });
  assert.deepEqual((await library(app, token)).watchlist.map((item) => item.id), ['300', '777'], 'a mais recente primeiro');

  await play(app, token, { type: 'movie', id: '777' });
  assert.deepEqual((await library(app, token)).watchlist.map((item) => item.id), ['300'], 'começou a ver: sai de "quero ver"');
  assert.deepEqual((await library(app, token)).continue.map((item) => item.id), ['777']);

  assert.deepEqual((await toggle({ type: 'tv', id: '300', add: false })).body, { inWatchlist: false });
  assert.equal((await toggle({ type: 'tv', id: '300', add: false })).status, 200, 'remover o que não está é inofensivo');
  assert.deepEqual((await library(app, token)).watchlist, []);
});

test('quero ver: valida entrada, recusa título fora do catálogo e é isolado por usuário', async () => {
  const app = makeApp();
  const a = await app.registerAndApprove('a@exemplo.com');
  const b = await app.registerAndApprove('b@exemplo.com');
  const toggle = (token, body) => app.call('POST', '/api/me/watchlist', { token, body });

  for (const bad of [{ type: 'anime', id: '777', add: true }, { type: 'movie', id: 'x', add: true }, { type: 'movie', id: '777' }, { type: 'movie', id: '777', add: 'sim' }, {}]) {
    assert.equal((await toggle(a.token, bad)).status, 400, JSON.stringify(bad));
  }
  const gone = await toggle(a.token, { type: 'movie', id: '424242', add: true });
  assert.equal(gone.status, 410);
  assert.equal(gone.body.code, 'not_found');

  await toggle(a.token, { type: 'movie', id: '777', add: true });
  assert.deepEqual((await library(app, b.token)).watchlist, []);
});

test('quero ver tem teto e descarta os mais antigos', async () => {
  const app = makeApp();
  const { token } = await app.registerAndApprove();
  app.catalog.lookup = (type, id) => ({ title: `Título ${id}`, year: '2024', poster: null });
  for (let i = 1; i <= 201; i++) {
    app.clock.ms += 1000;
    await app.call('POST', '/api/me/watchlist', { token, body: { type: 'movie', id: String(i), add: true } });
  }
  const { watchlist } = await library(app, token);
  assert.equal(watchlist.length, 200);
  assert.ok(!watchlist.some((item) => item.id === '1'), 'o mais antigo saiu');
  assert.equal(watchlist[0].id, '201');
});

test('biblioteca antiga, sem o campo de "quero ver", continua funcionando', async () => {
  const app = makeApp();
  const { token } = await app.registerAndApprove();
  const sub = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub;
  await app.stores.library.create(sub, { items: { 'movie:10': { type: 'movie', id: '10', title: 'Antigo', year: '2000', poster: null, season: null, episode: null, done: false, lastViewedAt: '2026-01-01T00:00:00.000Z' } } });

  assert.deepEqual((await library(app, token)).watchlist, []);
  assert.equal((await app.call('POST', '/api/me/watchlist', { token, body: { type: 'movie', id: '777', add: true } })).status, 200);
  const lib = await library(app, token);
  assert.deepEqual(lib.continue.map((item) => item.id), ['10'], 'o histórico antigo continua lá');
  assert.deepEqual(lib.watchlist.map((item) => item.id), ['777']);
});

test('série: marcar o episódio como assistido avança para o próximo e, no último, conclui a série', async () => {
  const app = makeApp();
  const { token } = await app.registerAndApprove();
  const watch = (season, episode) => play(app, token, { type: 'tv', id: '300', season, episode });

  await watch(1, 1);
  const first = await done(app, token, { type: 'tv', id: '300', done: true, season: 1, episode: 1 });
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.next, { season: 1, episode: 2 });
  assert.equal(first.body.done, false, 'a série segue em andamento');
  let lib = await library(app, token);
  assert.deepEqual(lib.continue.map((item) => [item.id, item.season, item.episode]), [['300', 1, 2]], '"continuar assistindo" já mostra o próximo');
  assert.deepEqual(lib.watched, []);
  assert.equal((await play(app, token, { type: 'tv', id: '300' })).body.url, 'https://embedplayapi.top/embed/300/1/2', 'e o player retoma dele');

  const second = await done(app, token, { type: 'tv', id: '300', done: true, season: 1, episode: 2 });
  assert.deepEqual(second.body.next, { season: 2, episode: 1 }, 'vira para a próxima temporada');

  const last = await done(app, token, { type: 'tv', id: '300', done: true, season: 2, episode: 1 });
  assert.equal(last.body.next, undefined);
  assert.equal(last.body.done, true, 'era o último episódio: a série inteira está assistida');
  lib = await library(app, token);
  assert.deepEqual(lib.watched.map((item) => item.id), ['300']);
  assert.deepEqual(lib.continue, []);

  const undone = await done(app, token, { type: 'tv', id: '300', done: false });
  assert.equal(undone.body.done, false, 'desmarcar (sem episódio) mexe no título todo, como sempre');
  assert.deepEqual((await library(app, token)).continue.map((item) => item.id), ['300']);
});

test('marcar como assistido: série fora do catálogo vale pelo título todo e o pedido é validado', async () => {
  const app = makeApp();
  const { token } = await app.registerAndApprove();
  await play(app, token, { type: 'tv', id: '20', title: 'Série Vinte' });
  const whole = await done(app, token, { type: 'tv', id: '20', done: true, season: 1, episode: 1 });
  assert.equal(whole.body.done, true, 'sem contagem de episódios no catálogo, não há "próximo"');
  assert.equal(whole.body.next, undefined);

  for (const bad of [{ season: 1 }, { episode: 2 }, { season: 'a', episode: 1 }, { season: 1, episode: 0 }, { season: 100, episode: 1 }]) {
    assert.equal((await done(app, token, { type: 'tv', id: '20', done: true, ...bad })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await done(app, token, { type: 'tv', id: '999', done: true, season: 1, episode: 1 })).status, 404, 'título que não está na lista');
});

test('filme: marcar como assistido continua sem avançar nada e guarda a data para a fileira "Porque você assistiu"', async () => {
  const app = makeApp();
  const { token } = await app.registerAndApprove();
  await play(app, token, { type: 'movie', id: '10', title: 'Dez' });
  const res = await done(app, token, { type: 'movie', id: '10', done: true });
  assert.equal(res.body.done, true);
  assert.equal(res.body.next, undefined);
  const record = (await app.stores.library.get(JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub)).value.items['movie:10'];
  assert.ok(record.doneAt);
  await done(app, token, { type: 'movie', id: '10', done: false });
  const after = (await app.stores.library.get(JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub)).value.items['movie:10'];
  assert.equal(after.doneAt, undefined);
});

test('recomendações: fileira "Porque você assistiu X" e, sem assistidos, "Parecidos com X" pelo último aberto', async () => {
  const app = makeApp();
  const { token } = await app.registerAndApprove();
  await app.call('POST', '/api/me/preferences', { token, body: { genres: [28, 18] } });

  const empty = await app.call('GET', '/api/me/recommendations', { token });
  assert.deepEqual(empty.body.rows.map((row) => row.id), ['gosto-1', 'gosto-2'], 'sem histórico não há fileira "porque"');

  await play(app, token, { type: 'movie', id: '10', title: 'Filme Dez' });
  const opened = await app.call('GET', '/api/me/recommendations', { token });
  assert.deepEqual(opened.body.rows[0], { id: 'because', title: 'Parecidos com Filme Dez', items: [{ id: '5', type: 'movie', title: 'Parecido com o 10' }] });

  await done(app, token, { type: 'movie', id: '10', done: true });
  const watched = await app.call('GET', '/api/me/recommendations', { token });
  assert.equal(watched.body.rows[0].title, 'Porque você assistiu Filme Dez');
  assert.deepEqual(watched.body.rows.map((row) => row.id), ['because', 'gosto-1', 'gosto-2']);

  const similarCall = app.catalog.calls.filter((call) => call[0] === 'similar').at(-1);
  assert.deepEqual(similarCall, ['similar', 'movie', '10', ['movie:10']], 'o próprio título e o que já foi aberto não voltam como parecidos');
});

test('recomendações: o último assistido (e não o último aberto) escolhe o título da fileira', async () => {
  const app = makeApp();
  const { token } = await app.registerAndApprove();
  await play(app, token, { type: 'movie', id: '10', title: 'Dez' });
  await done(app, token, { type: 'movie', id: '10', done: true });
  app.clock.ms += MINUTE_MS;
  await play(app, token, { type: 'movie', id: '11', title: 'Onze' });
  const rows = (await app.call('GET', '/api/me/recommendations', { token })).body.rows;
  assert.equal(rows[0].title, 'Porque você assistiu Dez');
});

test('explorar: repassa os filtros validados ao catálogo e recusa valor inválido', async () => {
  const app = makeApp();
  const { token } = await app.registerAndApprove();
  const get = (query) => app.call('GET', `/api/browse${query}`, { token });

  assert.equal((await get('?type=movie&genre=28&from=2000&to=2010&rating=7.5&page=2')).status, 200);
  assert.deepEqual(app.catalog.calls.at(-1), ['browse', { type: 'movie', genre: 28, from: 2000, to: 2010, minRating: 7.5, page: 2 }]);
  assert.equal((await get('')).status, 200);
  assert.deepEqual(app.catalog.calls.at(-1), ['browse', { type: 'all', genre: null, from: null, to: null, minRating: null, page: 1 }]);

  for (const bad of ['?type=anime', '?genre=abc', '?genre=0', '?from=1e3', '?from=2010&to=2000', '?to=3000', '?rating=11', '?rating=abc', '?page=0', '?page=x', '?from=']) {
    assert.equal((await get(bad)).status, 400, bad);
  }

  const options = await app.call('GET', '/api/browse/options', { token });
  assert.equal(options.status, 200);
  assert.deepEqual(Object.keys(options.body).sort(), ['all', 'movie', 'tv']);
});

test('busca: aceita filtro de tipo e de ano e recusa valor inválido', async () => {
  const app = makeApp();
  const { token } = await app.registerAndApprove();
  const get = (query) => app.call('GET', `/api/search?q=matrix${query}`, { token });

  assert.equal((await get('')).status, 200);
  assert.deepEqual(app.catalog.calls.at(-1), ['search', 'matrix'], 'sem filtro, igual a antes');
  assert.equal((await get('&type=tv&from=1999&to=2003')).status, 200);
  assert.deepEqual(app.catalog.calls.at(-1), ['search', 'matrix', { type: 'tv', from: 1999, to: 2003 }]);
  assert.equal((await get('&type=all')).status, 200);
  assert.deepEqual(app.catalog.calls.at(-1), ['search', 'matrix'], '"todos" é o mesmo que sem filtro');
  for (const bad of ['&type=anime', '&from=abc', '&from=2010&to=2000']) assert.equal((await get(bad)).status, 400, bad);
});
