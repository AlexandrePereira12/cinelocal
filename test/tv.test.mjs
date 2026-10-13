import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeApp } from './helpers.mjs';

const HOUR = 60 * 60 * 1000;
const pair = async (app, ip) => (await app.call('POST', '/api/tv/pair', { ip })).body;
const poll = (app, { code, secret }) => app.call('POST', '/api/tv/poll', { body: { code, secret } });
const send = (app, token, body) => app.call('POST', '/api/tv/send', { token, body });
const snapshot = (store) => JSON.stringify([...store.data]);

test('pair gera código de 6 caracteres legíveis e um segredo; cada TV recebe o seu', async () => {
  const app = makeApp();
  const first = await pair(app);
  const second = await pair(app);
  assert.match(first.code, /^[A-HJ-KM-NP-Z2-9]{6}$/, 'sem I, L, O, 0 e 1 para não confundir na TV');
  assert.ok(first.secret.length >= 20);
  assert.equal(first.expiresInSec, 6 * 3600);
  assert.notEqual(first.code, second.code);
  assert.notEqual(first.secret, second.secret);
  const stored = JSON.stringify([...app.stores.tv.data]);
  assert.ok(!stored.includes(first.secret), 'o segredo nunca é guardado em claro');
});

test('poll: espera, e código desconhecido, expirado ou segredo errado respondem igual', async () => {
  const app = makeApp();
  const tv = await pair(app);
  assert.deepEqual((await poll(app, tv)).body, { status: 'waiting', seq: 0, play: null });

  const wrongSecret = await poll(app, { code: tv.code, secret: 'x'.repeat(32) });
  const unknownCode = await poll(app, { code: 'ZZZZZZ', secret: tv.secret });
  const badFormat = await poll(app, { code: 'abc', secret: 'curto' });
  assert.equal(wrongSecret.status, 410);
  assert.deepEqual(wrongSecret, unknownCode, 'não revela quais códigos existem');
  assert.deepEqual(wrongSecret, badFormat);
  assert.equal(wrongSecret.body.code, 'tv_gone');
});

test('poll só lê: não grava no Blob nem consome limite (é a rota mais chamada)', async () => {
  const app = makeApp();
  const tv = await pair(app);
  const before = [snapshot(app.stores.tv), snapshot(app.stores.limits)];
  for (let i = 0; i < 25; i++) await poll(app, tv);
  assert.deepEqual([snapshot(app.stores.tv), snapshot(app.stores.limits)], before);
});

test('enviar exige login e só aceita tipo, id, temporada e episódio (nunca uma URL)', async () => {
  const app = makeApp();
  const tv = await pair(app);
  assert.equal((await send(app, undefined, { code: tv.code, type: 'movie', id: '777' })).status, 401);
  const { token } = await app.registerAndApprove();

  for (const bad of [{ type: 'filme', id: '777' }, { type: 'movie', id: 'abc' }, { type: 'tv', id: '1', season: 100 }, { type: 'tv', id: '1', episode: 0 }, {}]) {
    assert.equal((await send(app, token, { code: tv.code, ...bad })).status, 400, JSON.stringify(bad));
  }

  const res = await send(app, token, { code: tv.code, type: 'movie', id: '777', url: 'https://malicioso.example/x' });
  assert.deepEqual(res.body, { ok: true, title: 'Do Catálogo' });
  const playing = (await poll(app, tv)).body;
  assert.equal(playing.status, 'playing');
  assert.equal(playing.play.url, 'https://embedplayapi.top/embed/777', 'o link é montado pelo servidor');
  assert.ok(!JSON.stringify(playing).includes('malicioso'));
});

test('série: o link inclui temporada e episódio; sem eles começa no 1x1', async () => {
  const app = makeApp();
  const tv = await pair(app);
  const { token } = await app.registerAndApprove();

  await send(app, token, { code: tv.code, type: 'tv', id: '1396', season: 2, episode: 5 });
  assert.deepEqual((await poll(app, tv)).body.play, { url: 'https://embedplayapi.top/embed/1396/2/5', title: null, season: 2, episode: 5 });
  await send(app, token, { code: tv.code, type: 'tv', id: '1396' });
  assert.equal((await poll(app, tv)).body.play.url, 'https://embedplayapi.top/embed/1396/1/1');
});

test('cada comando sobe o seq; parar volta para "waiting"; aceita o código digitado em minúsculas', async () => {
  const app = makeApp();
  const tv = await pair(app);
  const { token } = await app.registerAndApprove();

  await send(app, token, { code: ` ${tv.code.toLowerCase()} `, type: 'movie', id: '777' });
  assert.equal((await poll(app, tv)).body.seq, 1);
  assert.equal((await app.call('POST', '/api/tv/stop', { token, body: { code: tv.code } })).status, 200);
  assert.deepEqual((await poll(app, tv)).body, { status: 'waiting', seq: 2, play: null });
});

test('dois envios ao mesmo tempo não se perdem (escrita condicional por etag)', async () => {
  const app = makeApp();
  const tv = await pair(app);
  const { token } = await app.registerAndApprove();
  const results = await Promise.all([send(app, token, { code: tv.code, type: 'movie', id: '777' }), send(app, token, { code: tv.code, type: 'tv', id: '1396', season: 1, episode: 2 })]);
  assert.deepEqual(results.map((r) => r.status), [200, 200]);
  assert.equal((await poll(app, tv)).body.seq, 2);
});

test('enviar não mexe no histórico do usuário', async () => {
  const app = makeApp();
  const tv = await pair(app);
  const { token } = await app.registerAndApprove();
  await send(app, token, { code: tv.code, type: 'movie', id: '777' });
  assert.equal((await app.call('GET', '/api/me/library', { token })).body.continue.length, 0);
});

test('o código vale 6 horas e depois some', async () => {
  const app = makeApp();
  const tv = await pair(app);
  const { token } = await app.registerAndApprove();

  app.clock.ms += 6 * HOUR - 1000;
  assert.equal((await poll(app, tv)).status, 200);
  app.clock.ms += 2000;
  assert.equal((await poll(app, tv)).body.code, 'tv_gone');
  assert.equal(app.stores.tv.data.size, 0, 'a TV que expirou limpa o próprio registro');
  assert.equal((await send(app, token, { code: tv.code, type: 'movie', id: '777' })).status, 410);
});

test('errar o código demais bloqueia o envio por um tempo, até com o código certo', async () => {
  const app = makeApp();
  const tv = await pair(app);
  const { token } = await app.registerAndApprove();
  const bad = () => send(app, token, { code: 'ZZZZZZ', type: 'movie', id: '777' });

  for (let i = 0; i < 10; i++) assert.equal((await bad()).status, 410);
  assert.equal((await bad()).status, 429);
  assert.equal((await send(app, token, { code: tv.code, type: 'movie', id: '777' })).status, 429, 'bloqueado mesmo com o código certo');

  app.clock.ms += 16 * 60 * 1000;
  assert.equal((await send(app, token, { code: tv.code, type: 'movie', id: '777' })).status, 200);
});

test('limite de códigos novos por IP', async () => {
  const app = makeApp();
  for (let i = 0; i < 20; i++) assert.equal((await app.call('POST', '/api/tv/pair', { ip: '198.51.100.40' })).status, 200);
  assert.equal((await app.call('POST', '/api/tv/pair', { ip: '198.51.100.40' })).status, 429);
  assert.equal((await app.call('POST', '/api/tv/pair', { ip: '198.51.100.41' })).status, 200, 'outro IP não é afetado');
});

test('configuração do Chromecast: exige login e só devolve um App ID válido', async () => {
  const none = makeApp();
  assert.equal((await none.call('GET', '/api/cast/config')).status, 401);
  const { token } = await none.registerAndApprove();
  assert.deepEqual((await none.call('GET', '/api/cast/config', { token })).body, { appId: null });

  const set = makeApp({ env: { CAST_APP_ID: 'abcd1234' } });
  const { token: t2 } = await set.registerAndApprove();
  assert.deepEqual((await set.call('GET', '/api/cast/config', { token: t2 })).body, { appId: 'ABCD1234' });

  const junk = makeApp({ env: { CAST_APP_ID: 'não é um id' } });
  const { token: t3 } = await junk.registerAndApprove();
  assert.deepEqual((await junk.call('GET', '/api/cast/config', { token: t3 })).body, { appId: null });
});
