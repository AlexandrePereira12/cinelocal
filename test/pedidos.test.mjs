import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeApp } from './helpers.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const ask = (app, token, body) => app.call('POST', '/api/me/requests', { token, body });
const list = async (app, token) => (await app.call('GET', '/api/me/requests', { token })).body.items;
const uidOf = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub;
const quiet = (t) => t.mock.method(console, 'error', () => {});

test('pedidos: as três rotas exigem login', async () => {
  const app = makeApp();
  assert.equal((await app.call('GET', '/api/me/requests')).status, 401);
  assert.equal((await app.call('POST', '/api/me/requests', { body: { title: 'Duna' } })).status, 401);
  assert.equal((await app.call('POST', '/api/me/requests/cancel', { body: { id: '0123456789abcdef' } })).status, 401);
  assert.equal((await app.call('GET', '/api/me/requests', { token: 'a.b.c' })).status, 401);
});

test('pedido: grava, responde 201, avisa o admin e aparece na lista como pendente', async () => {
  const app = makeApp();
  const { token, email } = await app.registerAndApprove();

  const res = await ask(app, token, { title: '  Duna   Parte Três ', type: 'movie', year: 2027, note: ' versão   legendada ' });
  assert.equal(res.status, 201);
  assert.match(res.body.item.id, /^[0-9a-f]{16}$/);
  assert.deepEqual({ ...res.body.item, id: undefined, createdAt: undefined }, { id: undefined, title: 'Duna Parte Três', type: 'movie', year: 2027, note: 'versão legendada', createdAt: undefined });
  assert.equal(res.body.item.createdAt, '2026-10-11T12:00:00.000Z');
  assert.equal(res.body.duplicate, undefined);

  assert.deepEqual(app.requestMails, [{ name: 'Ana Souza', email, title: 'Duna Parte Três', type: 'movie', year: 2027, note: 'versão legendada' }]);
  assert.deepEqual(await list(app, token), [{ ...res.body.item, inCatalog: null }]);
});

test('pedido: tipo padrão é "any", ano e observação são opcionais (vazio vira null)', async () => {
  const app = makeApp();
  const { token } = await app.registerAndApprove();
  const bare = await ask(app, token, { title: 'Só o Título' });
  assert.equal(bare.status, 201);
  assert.deepEqual([bare.body.item.type, bare.body.item.year, bare.body.item.note], ['any', null, null]);
  const blank = await ask(app, token, { title: 'Outro Título', type: 'tv', year: null, note: '   ' });
  assert.deepEqual([blank.status, blank.body.item.type, blank.body.item.year, blank.body.item.note], [201, 'tv', null, null]);
  const control = await ask(app, token, { title: 'Com\u0000 controle\r\ninvisível', note: 'a\tb‮c' });
  assert.equal(control.body.item.title, 'Com controle invisível', 'caractere de controle vira espaço');
  assert.equal(control.body.item.note, 'a b c');
});

test('pedido: validação (400) de título, tipo, ano e observação', async () => {
  const app = makeApp();
  const { token } = await app.registerAndApprove();
  const bad = [
    {}, { title: '' }, { title: 'a' }, { title: ' a ' }, { title: 'y'.repeat(101) }, { title: 123 }, { title: ['Duna'] }, { title: null },
    { title: '!!' }, { title: '?-.' },
    { title: 'Duna', type: 'anime' }, { title: 'Duna', type: 5 },
    { title: 'Duna', year: 1799 }, { title: 'Duna', year: 2101 }, { title: 'Duna', year: '2020' }, { title: 'Duna', year: 2020.5 }, { title: 'Duna', year: true },
    { title: 'Duna', note: 'n'.repeat(201) }, { title: 'Duna', note: 42 }, { title: 'Duna', note: { a: 1 } },
  ];
  for (const body of bad) {
    const res = await ask(app, token, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.code, 'bad_request');
  }
  assert.deepEqual(await list(app, token), [], 'nada foi gravado');
  assert.deepEqual(app.requestMails, []);

  for (const body of [{ title: 'ab' }, { title: 'y'.repeat(100) }, { title: 'Duna', year: 1800 }, { title: 'Duna 2', year: 2100 }, { title: 'Duna 3', note: 'n'.repeat(200) }]) {
    assert.equal((await ask(app, token, body)).status, 201, JSON.stringify(body).slice(0, 60));
  }
  assert.equal((await app.call('POST', '/api/me/requests', { token, raw: '{quebrado', body: undefined })).status, 400);
  assert.equal((await app.call('POST', '/api/me/requests', { token, raw: '[]' })).status, 400);
  assert.equal((await app.call('POST', '/api/me/requests', { token, raw: '{}', contentType: 'text/plain' })).status, 415);
});

test('pedido: título que já está no catálogo responde 409 com o título e não grava nem envia e-mail', async () => {
  const app = makeApp();
  const { token } = await app.registerAndApprove();

  const res = await ask(app, token, { title: 'DO catalogo!' });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'already_in_catalog');
  assert.equal(res.body.item.id, '777');
  assert.equal(res.body.item.type, 'movie');
  assert.equal(res.body.item.title, 'Do Catálogo');
  assert.ok(res.body.error);
  assert.deepEqual(await list(app, token), []);
  assert.deepEqual(app.requestMails, []);

  const show = await ask(app, token, { title: 'série do catálogo', type: 'tv', year: 2022 });
  assert.deepEqual([show.status, show.body.item.id], [409, '300']);

  // Tipo ou ano diferentes não casam: viram pedido de verdade.
  assert.equal((await ask(app, token, { title: 'Do Catálogo', type: 'tv' })).status, 201);
  assert.equal((await ask(app, token, { title: 'Do Catálogo', year: 1999 })).status, 201);
});

test('pedido: o mesmo pedido de novo é idempotente (200 duplicate, sem novo registro, e-mail nem limite)', async () => {
  const app = makeApp();
  const { token } = await app.registerAndApprove();
  const first = await ask(app, token, { title: 'Duna: Parte Três', type: 'movie' });
  assert.equal(first.status, 201);

  app.clock.ms += 60 * 1000;
  const again = await ask(app, token, { title: '  DUNA parte três!! ', type: 'movie', note: 'texto novo', year: 2030 });
  assert.equal(again.status, 200);
  assert.equal(again.body.duplicate, true);
  assert.deepEqual(again.body.item, first.body.item, 'devolve o que já existe, sem alterar');
  assert.equal(app.requestMails.length, 1);
  assert.equal((await list(app, token)).length, 1);

  // Outro tipo é outro pedido (a chave é tipo + título).
  const other = await ask(app, token, { title: 'Duna: Parte Três', type: 'any' });
  assert.deepEqual([other.status, other.body.duplicate], [201, undefined]);
  assert.notEqual(other.body.item.id, first.body.item.id);
  assert.equal((await list(app, token)).length, 2);

  // Repetir não gasta o limite diário: 3 pedidos novos (já são 2 + ...), depois muitas repetições seguem 200.
  for (let i = 0; i < 3; i++) await ask(app, token, { title: `Filme ${i} Extra` });
  for (let i = 0; i < 10; i++) assert.equal((await ask(app, token, { title: 'Duna: Parte Três', type: 'movie' })).status, 200);
});

test('pedido: duas abas pedindo o mesmo título ao mesmo tempo viram um só pedido e um só e-mail', async () => {
  const app = makeApp();
  const { token } = await app.registerAndApprove();
  const results = await Promise.all([ask(app, token, { title: 'Corrida Dupla' }), ask(app, token, { title: 'corrida dupla' })]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 201]);
  assert.equal(results.find((r) => r.status === 200).body.duplicate, true);
  assert.equal((await list(app, token)).length, 1);
  assert.equal(app.requestMails.length, 1);
});

test('pedido: pedidos simultâneos de títulos diferentes não se perdem (escrita condicional por etag)', async () => {
  const app = makeApp();
  const { token } = await app.registerAndApprove();
  const results = await Promise.all(['Alfa Um', 'Beta Dois', 'Gama Três'].map((title) => ask(app, token, { title })));
  assert.deepEqual(results.map((r) => r.status), [201, 201, 201]);
  assert.deepEqual((await list(app, token)).map((i) => i.title).sort(), ['Alfa Um', 'Beta Dois', 'Gama Três']);
});

test('pedido: limite de 5 pedidos novos por dia por usuário (429) e liberado no dia seguinte', async () => {
  const app = makeApp();
  const a = await app.registerAndApprove('a@exemplo.com');
  const b = await app.registerAndApprove('b@exemplo.com');
  for (let i = 1; i <= 5; i++) assert.equal((await ask(app, a.token, { title: `Pedido número ${i}` })).status, 201);

  const blocked = await ask(app, a.token, { title: 'Pedido número 6' });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.code, 'rate_limited');
  assert.equal((await list(app, a.token)).length, 5, 'o bloqueado não foi gravado');
  assert.equal((await ask(app, b.token, { title: 'Pedido do outro' })).status, 201, 'o limite é por usuário');

  app.clock.ms += DAY_MS + 1000;
  assert.equal((await ask(app, a.token, { title: 'Pedido número 6' })).status, 201);
});

test('pedido: falha no e-mail NÃO desfaz o pedido (só vai para o log)', async (t) => {
  const log = quiet(t);
  const app = makeApp({ requestMailFails: true });
  const { token } = await app.registerAndApprove();
  const res = await ask(app, token, { title: 'Pedido Sem Aviso' });
  assert.equal(res.status, 201);
  assert.deepEqual((await list(app, token)).map((i) => i.title), ['Pedido Sem Aviso']);
  assert.ok(log.mock.calls.some((call) => call.arguments.join(' ').includes('mail_error')), 'a falha é registrada no log');
  assert.ok(!JSON.stringify(res.body).includes('mail_failed'), 'e não vaza para a resposta');
});

test('pedido: teto diário de e-mails ao admin (20): passou do teto grava sem enviar', async (t) => {
  quiet(t);
  const app = makeApp();
  const { token } = await app.registerAndApprove();
  const day = '2026-10-11';
  await app.stores.limits.create(`request-mails:${day}`, { count: 19, resetAt: app.clock.ms + DAY_MS });

  assert.equal((await ask(app, token, { title: 'Ainda Cabe' })).status, 201);
  assert.equal(app.requestMails.length, 1, 'o 20º e-mail do dia sai');
  app.clock.ms += 1000;
  const over = await ask(app, token, { title: 'Passou do Teto' });
  assert.equal(over.status, 201, 'o pedido é gravado mesmo assim');
  assert.equal(app.requestMails.length, 1, 'mas o 21º e-mail não sai');
  assert.deepEqual((await list(app, token)).map((i) => i.title), ['Passou do Teto', 'Ainda Cabe']);

  app.clock.ms += DAY_MS;
  await ask(app, token, { title: 'Dia Seguinte' });
  assert.equal(app.requestMails.length, 2, 'o contador é por dia');
});

test('pedido: no máximo 30 por usuário, descartando os mais antigos', async () => {
  const app = makeApp();
  const { token } = await app.registerAndApprove();
  const items = {};
  for (let i = 0; i < 30; i++) {
    const created = new Date(Date.parse('2026-09-01T00:00:00Z') + i * 1000).toISOString();
    items[`any:antigo ${i}`] = { id: i.toString(16).padStart(16, '0'), title: `Antigo ${i}`, type: 'any', year: null, note: null, createdAt: created };
  }
  await app.stores.requests.create(uidOf(token), { items });

  assert.equal((await ask(app, token, { title: 'Pedido Novo' })).status, 201);
  const mine = await list(app, token);
  assert.equal(mine.length, 30);
  assert.equal(mine[0].title, 'Pedido Novo', 'o mais novo primeiro');
  assert.ok(!mine.some((i) => i.title === 'Antigo 0'), 'o mais antigo saiu');
  assert.ok(mine.some((i) => i.title === 'Antigo 1'));
});

test('lista: mais novos primeiro, isolada por usuário e inCatalog calculado na hora', async () => {
  const app = makeApp();
  const a = await app.registerAndApprove('a@exemplo.com');
  const b = await app.registerAndApprove('b@exemplo.com');
  await ask(app, a.token, { title: 'Primeiro Pedido' });
  app.clock.ms += 1000;
  await ask(app, a.token, { title: 'Segundo Pedido', type: 'tv', year: 2020, note: 'urgente' });
  assert.deepEqual((await list(app, a.token)).map((i) => i.title), ['Segundo Pedido', 'Primeiro Pedido']);
  assert.deepEqual(Object.keys((await list(app, a.token))[0]).sort(), ['createdAt', 'id', 'inCatalog', 'note', 'title', 'type', 'year']);
  assert.deepEqual(await list(app, b.token), [], 'b não vê os pedidos de a');

  // O título entra no catálogo depois do pedido: o pedido "se atende sozinho", sem job nem regravação.
  const key = 'any:serie do catalogo';
  const record = (await app.stores.requests.get(uidOf(b.token)))?.value ?? { items: {} };
  record.items[key] = { id: 'aaaaaaaaaaaaaaaa', title: 'Série do Catálogo', type: 'any', year: null, note: null, createdAt: '2026-10-11T00:00:00.000Z' };
  await app.stores.requests.create(uidOf(b.token), record);
  const [granted] = await list(app, b.token);
  assert.equal(granted.inCatalog.id, '300');
  assert.equal(granted.inCatalog.type, 'tv');
  assert.equal(granted.inCatalog.title, 'Série do Catálogo');
});

test('cancelar: remove só o pedido do usuário; id desconhecido é 404 e id malformado é 400', async () => {
  const app = makeApp();
  const a = await app.registerAndApprove('a@exemplo.com');
  const b = await app.registerAndApprove('b@exemplo.com');
  const mine = (await ask(app, a.token, { title: 'Para Cancelar' })).body.item;
  const keep = (await ask(app, a.token, { title: 'Para Manter' })).body.item;
  await ask(app, b.token, { title: 'Para Cancelar' });
  const cancel = (token, id) => app.call('POST', '/api/me/requests/cancel', { token, body: { id } });

  assert.equal((await cancel(b.token, keep.id)).status, 404, 'não cancela pedido de outra pessoa');
  assert.equal((await list(app, a.token)).length, 2);

  const done = await cancel(a.token, mine.id);
  assert.deepEqual([done.status, done.body], [200, { ok: true }]);
  assert.deepEqual((await list(app, a.token)).map((i) => i.id), [keep.id]);
  assert.equal((await list(app, b.token)).length, 1, 'o pedido de b com o mesmo título continua');

  const again = await cancel(a.token, mine.id);
  assert.deepEqual([again.status, again.body.code], [404, 'not_found']);
  assert.equal((await cancel(a.token, 'ffffffffffffffff')).status, 404);
  for (const bad of ['', 'xyz', '0123456789abcdeg', '0123456789ABCDEF', 'y'.repeat(40), 5, null, undefined]) {
    assert.equal((await cancel(a.token, bad)).status, 400, String(bad));
  }
  assert.equal((await app.call('POST', '/api/me/requests/cancel', { token: a.token, body: {} })).status, 400);

  // Depois de cancelar, dá para pedir de novo (é um pedido novo, com novo e-mail).
  const mails = app.requestMails.length;
  const reopened = await ask(app, a.token, { title: 'Para Cancelar' });
  assert.deepEqual([reopened.status, reopened.body.duplicate], [201, undefined]);
  assert.equal(app.requestMails.length, mails + 1);
});

test('cancelar sem nenhum pedido gravado é 404 (e não cria registro)', async () => {
  const app = makeApp();
  const { token } = await app.registerAndApprove();
  const res = await app.call('POST', '/api/me/requests/cancel', { token, body: { id: '0123456789abcdef' } });
  assert.equal(res.status, 404);
  assert.equal(await app.stores.requests.get(uidOf(token)), null);
});

test('métodos errados nas rotas de pedido respondem 405', async () => {
  const app = makeApp();
  const { token } = await app.registerAndApprove();
  assert.equal((await app.call('DELETE', '/api/me/requests', { token })).status, 405);
  assert.equal((await app.call('GET', '/api/me/requests/cancel', { token })).status, 405);
});
