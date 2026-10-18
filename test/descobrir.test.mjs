import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeApp } from './helpers.mjs';

const surprise = (app, token, query = '') => app.call('GET', `/api/me/surprise${query}`, { token });
const pickCalls = (app) => app.catalog.calls.filter(([name]) => name === 'pick').map(([, options]) => options);

test('sorteio: exige login', async () => {
  const app = makeApp();
  assert.equal((await surprise(app, undefined)).status, 401);
  assert.equal((await surprise(app, 'token.invalido.x')).status, 401);
});

test('sorteio: devolve um título do catálogo, com os parâmetros certos repassados', async () => {
  const app = makeApp();
  const { token } = await app.registerAndApprove();

  const res = await surprise(app, token);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { item: { type: 'movie', id: '777', title: 'Do Catálogo', year: '2024', poster: '/catalogo.jpg', genres: ['Ação'] }, inWatchlist: false });
  assert.deepEqual(pickCalls(app), [{ genreIds: null, exclude: [], skip: [], maxMinutes: null, type: 'all', random: 'function' }], 'sem filtros e sem gêneros escolhidos');

  await surprise(app, token, '?type=tv&max=90&skip=movie:1,tv:2');
  assert.deepEqual(pickCalls(app).at(-1), { genreIds: null, exclude: [], skip: ['movie:1', 'tv:2'], maxMinutes: 90, type: 'tv', random: 'function' });
});

test('sorteio: usa os gêneros favoritos do usuário quando ele escolheu', async () => {
  const app = makeApp();
  const { token } = await app.registerAndApprove();
  await app.call('POST', '/api/me/preferences', { token, body: { genres: [18, 28] } });
  await surprise(app, token);
  assert.deepEqual(pickCalls(app).at(-1).genreIds, [18, 28], 'na ordem em que foram escolhidos');
});

test('sorteio: o `random` injetado no handler é o que decide o título (determinista)', async () => {
  const low = makeApp({ random: () => 0 });
  const high = makeApp({ random: () => 0.99 });
  const a = await low.registerAndApprove();
  const b = await high.registerAndApprove();
  assert.equal((await surprise(low, a.token)).body.item.id, '777');
  assert.equal((await surprise(high, b.token)).body.item.id, '300');
});

test('sorteio: não repete o que já está na biblioteca; "quero ver" continua candidato e avisa', async () => {
  const app = makeApp();
  const { token } = await app.registerAndApprove();

  await app.call('POST', '/api/me/watchlist', { token, body: { type: 'movie', id: '777', add: true } });
  const wished = await surprise(app, token);
  assert.equal(wished.body.item.id, '777', '"Quero ver" não é excluído');
  assert.equal(wished.body.inWatchlist, true);
  assert.deepEqual(pickCalls(app).at(-1).exclude, []);

  await app.call('POST', '/api/play', { token, body: { type: 'movie', id: '777' } });
  const next = await surprise(app, token);
  assert.equal(next.body.item.id, '300', 'o filme já aberto sai do sorteio');
  assert.deepEqual(pickCalls(app).at(-1).exclude, ['movie:777']);
  assert.equal(next.body.inWatchlist, false);

  await app.call('POST', '/api/play', { token, body: { type: 'tv', id: '300' } });
  const empty = await surprise(app, token);
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body, { item: null, inWatchlist: false }, 'sem sugestão: item null, não erro');
});

test('sorteio: o skip esconde o que já foi sugerido; a biblioteca de outra pessoa não conta', async () => {
  const app = makeApp();
  const a = await app.registerAndApprove('a@exemplo.com');
  const b = await app.registerAndApprove('b@exemplo.com');
  await app.call('POST', '/api/play', { token: a.token, body: { type: 'movie', id: '777' } });

  assert.equal((await surprise(app, b.token, '?skip=movie:777')).body.item.id, '300');
  assert.equal((await surprise(app, b.token)).body.item.id, '777', 'b nunca abriu o 777');
  assert.equal((await surprise(app, b.token, '?skip=movie:777,tv:300')).body.item, null);
});

test('sorteio: valida os parâmetros (inválido é 400, nunca ignorado)', async () => {
  const app = makeApp();
  const { token } = await app.registerAndApprove();
  const bad = [
    '?type=anime', '?type=', '?max=29', '?max=601', '?max=abc', '?max=', '?max=1e2', '?max=-60', '?max=90.5', '?max=%2060',
    '?skip=movie', '?skip=movie:', '?skip=anime:1', '?skip=movie:1,', '?skip=,movie:1', '?skip=movie:1234567890', '?skip=movie:1;tv:2', '?skip=MOVIE:1', '?skip=movie:-1',
  ];
  for (const query of bad) assert.equal((await surprise(app, token, query)).status, 400, query);

  for (const query of ['?type=all', '?type=movie', '?type=tv', '?max=30', '?max=600', '?skip=', '?skip=movie:123456789']) {
    assert.equal((await surprise(app, token, query)).status, 200, query);
  }
  const before = pickCalls(app).length;
  await surprise(app, token, '?max=29');
  assert.equal(pickCalls(app).length, before, 'pedido inválido nem chega ao catálogo');
});

test('sorteio: skip aceita até 40 entradas', async () => {
  const app = makeApp();
  const { token } = await app.registerAndApprove();
  const skip = (count) => Array.from({ length: count }, (_, k) => `movie:${k + 1}`).join(',');
  assert.equal((await surprise(app, token, `?skip=${skip(40)}`)).status, 200);
  const tooMany = await surprise(app, token, `?skip=${skip(41)}`);
  assert.equal(tooMany.status, 400);
  assert.equal(tooMany.body.code, 'bad_request');
});

test('sorteio: só GET', async () => {
  const app = makeApp();
  const { token } = await app.registerAndApprove();
  const res = await app.call('POST', '/api/me/surprise', { token, body: {} });
  assert.equal(res.status, 405);
});
