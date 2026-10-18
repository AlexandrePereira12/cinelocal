import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeApp } from './helpers.mjs';

const PASSWORD = 'Senha_bem_longa_1';
const setLimit = (app, token, body) => app.call('POST', '/api/me/rating-limit', { token, body });
const me = async (app, token) => (await app.call('GET', '/api/auth/me', { token })).body;
const play = (app, token, body) => app.call('POST', '/api/play', { token, body });
const library = async (app, token) => (await app.call('GET', '/api/me/library', { token })).body;
const viewCalls = (app) => app.catalog.calls.filter(([name]) => name === 'forRating');

// O fake classifica o filme 777 como 12 anos e a série 300 como 16 anos (ver FAKE_CERTIFICATIONS em helpers.mjs).
async function withLimit(max) {
  const app = makeApp();
  const user = await app.registerAndApprove();
  const res = await setLimit(app, user.token, { max });
  assert.equal(res.status, 200);
  return { app, ...user };
}

test('modo família: o perfil traz maxRating (null sem modo) e as preferências trazem as opções', async () => {
  const app = makeApp();
  const { token } = await app.registerAndApprove();
  assert.equal((await me(app, token)).maxRating, null);
  const prefs = (await app.call('GET', '/api/me/preferences', { token })).body;
  assert.deepEqual(prefs.ratingOptions, [0, 10, 12, 14, 16]);
  assert.equal(prefs.maxRating, null);
  const login = await app.call('POST', '/api/auth/login', { body: { email: 'ana@exemplo.com', password: PASSWORD } });
  assert.equal(login.body.user.maxRating, null);
});

test('modo família: exige login e valida o limite (só null ou uma das opções)', async () => {
  const app = makeApp();
  const { token } = await app.registerAndApprove();
  assert.equal((await setLimit(app, undefined, { max: 12 })).status, 401);
  for (const bad of [{}, { max: undefined }, { max: 18 }, { max: 15 }, { max: -1 }, { max: '12' }, { max: 12.5 }, { max: true }, { max: [12] }, { password: PASSWORD }]) {
    const res = await setLimit(app, token, bad);
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.equal(res.body.code, 'bad_request');
  }
  assert.equal((await me(app, token)).maxRating, null, 'nada mudou');
});

test('modo família: ligar e apertar o limite não pedem senha; devolve o perfil e as opções', async () => {
  const app = makeApp();
  const { token } = await app.registerAndApprove();

  const on = await setLimit(app, token, { max: 14 });
  assert.equal(on.status, 200);
  assert.equal(on.body.maxRating, 14);
  assert.deepEqual(on.body.ratingOptions, [0, 10, 12, 14, 16]);
  assert.equal(on.body.name, 'Ana Souza');
  assert.ok(!('email' in on.body) && !('passHash' in on.body));
  assert.equal((await me(app, token)).maxRating, 14, 'persistiu');

  assert.equal((await setLimit(app, token, { max: 14 })).status, 200, 'o mesmo valor não afrouxa');
  assert.equal((await setLimit(app, token, { max: 12 })).body.maxRating, 12);
  assert.equal((await setLimit(app, token, { max: 0 })).body.maxRating, 0, '0 (livre) é um limite válido, não "desligado"');
  assert.equal((await me(app, token)).maxRating, 0);
});

test('modo família: afrouxar (subir o limite ou desligar) exige a senha da conta', async () => {
  const { app, token } = await withLimit(10);

  const missing = await setLimit(app, token, { max: 12 });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.code, 'password_required');
  for (const password of ['', 5, null, ['x'], 'y'.repeat(129)]) {
    assert.equal((await setLimit(app, token, { max: null, password })).status, 400, String(password));
  }
  assert.equal((await me(app, token)).maxRating, 10, 'sem senha nada afrouxa');

  const wrong = await setLimit(app, token, { max: 12, password: 'Errada_1' });
  assert.equal(wrong.status, 400, '401 derrubaria a sessão no front');
  assert.equal(wrong.body.code, 'wrong_password');
  assert.equal((await me(app, token)).maxRating, 10);

  const raised = await setLimit(app, token, { max: 12, password: PASSWORD });
  assert.equal(raised.status, 200);
  assert.equal(raised.body.maxRating, 12);

  const off = await setLimit(app, token, { max: null, password: PASSWORD });
  assert.equal(off.body.maxRating, null);
  assert.equal((await me(app, token)).maxRating, null);

  // Sem limite, qualquer valor é "ligar": não pede senha.
  assert.equal((await setLimit(app, token, { max: 16 })).status, 200);
  // Apertar com senha enviada à toa também funciona e não consome nada.
  assert.equal((await setLimit(app, token, { max: 10, password: 'qualquer' })).body.maxRating, 10);
});

test('modo família: de 0 (livre) qualquer aumento também pede senha', async () => {
  const { app, token } = await withLimit(0);
  assert.equal((await setLimit(app, token, { max: 10 })).body.code, 'password_required');
  assert.equal((await setLimit(app, token, { max: 10, password: PASSWORD })).status, 200);
});

test('modo família: senha errada usa o mesmo limitador da troca de senha (conta antes, zera no sucesso)', async () => {
  const { app, token } = await withLimit(10);

  for (let i = 0; i < 5; i++) assert.equal((await setLimit(app, token, { max: 12, password: `Errada_${i}` })).body.code, 'wrong_password');
  const blocked = await setLimit(app, token, { max: 12, password: PASSWORD });
  assert.equal(blocked.status, 429, 'depois de 5 erradas nem a senha certa passa');
  assert.equal(blocked.body.code, 'rate_limited');
  assert.equal((await me(app, token)).maxRating, 10);
  const change = await app.call('POST', '/api/me/password', { token, body: { current: PASSWORD, next: 'Outra_senha_2' } });
  assert.equal(change.status, 429, 'o contador é compartilhado com a troca de senha');

  app.clock.ms += 15 * 60 * 1000 + 1000;
  assert.equal((await setLimit(app, token, { max: 12, password: PASSWORD })).status, 200, 'a janela passou');
});

test('modo família: acertar a senha zera as tentativas; pedido sem senha não conta', async () => {
  const { app, token } = await withLimit(10);
  for (let i = 0; i < 4; i++) assert.equal((await setLimit(app, token, { max: 12, password: 'Errada_1' })).status, 400);
  assert.equal((await setLimit(app, token, { max: 12, password: PASSWORD })).status, 200);
  await setLimit(app, token, { max: 10 });
  for (let i = 0; i < 20; i++) assert.equal((await setLimit(app, token, { max: 12 })).body.code, 'password_required', 'sem senha não conta tentativa');
  for (let i = 0; i < 5; i++) assert.equal((await setLimit(app, token, { max: 12, password: 'Errada_1' })).status, 400, 'zerado: mais 5 tentativas');
  assert.equal((await setLimit(app, token, { max: 12, password: 'Errada_1' })).status, 429);
});

test('modo família: tentativas paralelas de senha respeitam o teto (conta antes de verificar)', async () => {
  const { app, token } = await withLimit(10);
  const results = await Promise.all(Array.from({ length: 20 }, () => setLimit(app, token, { max: null, password: 'Errada_1' })));
  const checked = results.filter((res) => res.body.code === 'wrong_password').length;
  assert.ok(checked >= 1 && checked <= 5, `a senha foi conferida ${checked} vezes em 20 pedidos paralelos (teto: 5)`);
  assert.ok(results.every((res) => [400, 429].includes(res.status)));
  assert.equal((await me(app, token)).maxRating, 10);
});

test('modo família: valor gravado fora das opções vale como "sem limite"', async () => {
  const app = makeApp();
  const { token } = await app.registerAndApprove();
  const uid = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub;
  for (const junk of [99, '12', -1, 18]) {
    const entry = await app.stores.users.get(uid);
    await app.stores.users.put(uid, { ...entry.value, maxRating: junk }, entry.etag);
    assert.equal((await me(app, token)).maxRating, null, String(junk));
    assert.equal((await play(app, token, { type: 'movie', id: '10', title: 'Fora do catálogo' })).status, 200);
  }
});

test('modo família: play, tv/send, título, temporadas, episódios, marcar e quero ver exigem título visível', async () => {
  const { app, token } = await withLimit(12);
  const gone = (res) => {
    assert.equal(res.status, 410);
    assert.equal(res.body.code, 'not_found');
  };

  // Série 300 (16 anos) e título fora do catálogo ficam bloqueados; filme 777 (12 anos) passa.
  gone(await play(app, token, { type: 'tv', id: '300' }));
  gone(await play(app, token, { type: 'movie', id: '10', title: 'Fora do catálogo' }));
  gone(await app.call('POST', '/api/tv/send', { token, body: { code: 'ABC234', type: 'tv', id: '300', season: 1, episode: 1 } }));
  gone(await app.call('POST', '/api/tv/send', { token, body: { code: 'ABC234', type: 'movie', id: '10' } }));
  gone(await app.call('GET', '/api/title/tv/300', { token }));
  gone(await app.call('GET', '/api/title/movie/10', { token }));
  gone(await app.call('GET', '/api/seasons/300', { token }));
  gone(await app.call('GET', '/api/episodes/300/1', { token }));
  gone(await app.call('POST', '/api/me/done', { token, body: { type: 'tv', id: '300', done: true, season: 1, episode: 1 } }));
  gone(await app.call('POST', '/api/me/done', { token, body: { type: 'movie', id: '10', done: true } }));
  gone(await app.call('POST', '/api/me/watchlist', { token, body: { type: 'tv', id: '300', add: true } }));
  assert.deepEqual(await library(app, token), { continue: [], watched: [], watchlist: [] }, 'nada foi gravado');

  const ok = await play(app, token, { type: 'movie', id: '777' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.info.certification, 12, 'o player recebe a classificação');
  assert.equal((await app.call('GET', '/api/title/movie/777', { token })).status, 200);
  assert.equal((await app.call('POST', '/api/me/done', { token, body: { type: 'movie', id: '777', done: true } })).status, 200);
  assert.equal((await app.call('POST', '/api/me/watchlist', { token, body: { type: 'movie', id: '777', add: true } })).status, 200);
  assert.equal((await app.call('POST', '/api/me/watchlist', { token, body: { type: 'tv', id: '300', add: false } })).status, 200, 'remover continua valendo');
});

test('modo família: tv/send de título visível segue o fluxo normal (o bloqueio vem só da classificação)', async () => {
  const { app, token } = await withLimit(16);
  const tv = (await app.call('POST', '/api/tv/pair')).body;
  const res = await app.call('POST', '/api/tv/send', { token, body: { code: tv.code, type: 'tv', id: '300', season: 1, episode: 2 } });
  assert.equal(res.status, 200, 'a série de 16 anos passa com limite 16');
  assert.equal(res.body.title, 'Série do Catálogo');
  assert.equal((await play(app, token, { type: 'tv', id: '300' })).status, 200);
});

test('modo família: sem o modo nada muda (inclusive o fallback de título fora do catálogo no play)', async () => {
  const app = makeApp();
  const { token } = await app.registerAndApprove();
  assert.equal((await play(app, token, { type: 'tv', id: '300' })).status, 200);
  const outside = await play(app, token, { type: 'movie', id: '10', title: 'Fora do catálogo' });
  assert.equal(outside.status, 200);
  assert.equal(outside.body.info, null);
  assert.equal((await app.call('GET', '/api/seasons/300', { token })).status, 200);
  assert.deepEqual(viewCalls(app), [], 'o catálogo completo é usado: nenhuma visão filtrada foi criada');
});

test('modo família: biblioteca filtra o que não está na visão (e volta ao desligar com a senha)', async () => {
  const app = makeApp();
  const { token } = await app.registerAndApprove();
  await play(app, token, { type: 'tv', id: '300' });
  await play(app, token, { type: 'movie', id: '777' });
  await play(app, token, { type: 'movie', id: '10', title: 'Fora do catálogo' });
  app.clock.ms += 1000;
  await app.call('POST', '/api/me/watchlist', { token, body: { type: 'movie', id: '777', add: true } });
  assert.equal((await library(app, token)).continue.length, 3);

  await setLimit(app, token, { max: 12 });
  const limited = await library(app, token);
  assert.deepEqual(limited.continue.map((i) => i.id), ['777'], 'a série de 16 anos e o título fora do catálogo somem');
  assert.deepEqual(limited.watched, []);

  await setLimit(app, token, { max: null, password: PASSWORD });
  assert.equal((await library(app, token)).continue.length, 3, 'nada foi apagado: só ficou escondido');
});

test('modo família: a watchlist também é filtrada', async () => {
  const app = makeApp();
  const { token } = await app.registerAndApprove();
  await app.call('POST', '/api/me/watchlist', { token, body: { type: 'tv', id: '300', add: true } });
  await app.call('POST', '/api/me/watchlist', { token, body: { type: 'movie', id: '777', add: true } });
  assert.equal((await library(app, token)).watchlist.length, 2);
  await setLimit(app, token, { max: 12 });
  assert.deepEqual((await library(app, token)).watchlist.map((i) => i.id), ['777']);
});

test('modo família: recomendações não usam como âncora nem como exclusão título invisível, e passam pela visão', async () => {
  const app = makeApp();
  const { token } = await app.registerAndApprove();
  await play(app, token, { type: 'movie', id: '777' });
  app.clock.ms += 1000;
  await play(app, token, { type: 'tv', id: '300' }); // o mais recente, mas com 16 anos
  await app.call('POST', '/api/me/preferences', { token, body: { genres: [18, 28] } });

  await setLimit(app, token, { max: 12 });
  app.catalog.calls.length = 0;
  const res = await app.call('GET', '/api/me/recommendations', { token });
  assert.equal(res.status, 200);
  const similar = app.catalog.calls.filter(([name]) => name === 'similar');
  assert.equal(similar.length, 1);
  assert.deepEqual(similar[0].slice(1, 3), ['movie', '777'], 'a âncora é o último título VISÍVEL, não a série de 16 anos');
  assert.ok(viewCalls(app).length > 0);
  assert.deepEqual(res.body.rows.map((row) => row.id), ['gosto-1', 'gosto-2'], 'as fileiras de gênero vêm da visão (o fake não tem parecidos do 777)');

  // Só com título invisível na biblioteca não há âncora: a fileira "Porque você assistiu" some.
  const solo = makeApp();
  const only = await solo.registerAndApprove();
  await play(solo, only.token, { type: 'tv', id: '300' });
  await setLimit(solo, only.token, { max: 12 });
  solo.catalog.calls.length = 0;
  const empty = await solo.call('GET', '/api/me/recommendations', { token: only.token });
  assert.deepEqual(empty.body.rows, []);
  assert.equal(solo.catalog.calls.filter(([name]) => name === 'similar').length, 0);
});

test('modo família: TODA rota que lê o catálogo usa a visão filtrada', async () => {
  const { app, token } = await withLimit(12);
  const routes = [
    ['GET', '/api/list/trending-movies'],
    ['GET', '/api/search?q=filme'],
    ['GET', '/api/browse'],
    ['GET', '/api/browse/options'],
    ['GET', '/api/directors'],
    ['GET', '/api/director/9001'],
    ['GET', '/api/title/movie/777'],
    ['GET', '/api/seasons/300'],
    ['GET', '/api/episodes/300/1'],
    ['GET', '/api/me/library'],
    ['GET', '/api/me/recommendations'],
    ['GET', '/api/me/surprise'],
    ['POST', '/api/play', { type: 'movie', id: '777' }],
    ['POST', '/api/me/done', { type: 'movie', id: '777', done: true }],
    ['POST', '/api/me/watchlist', { type: 'movie', id: '777', add: true }],
    ['POST', '/api/me/requests', { title: 'Pedido Qualquer' }],
    ['GET', '/api/me/requests'],
    ['POST', '/api/tv/send', { code: 'ABC234', type: 'movie', id: '777' }],
  ];
  for (const [method, path, body] of routes) {
    app.catalog.calls.length = 0;
    await app.call(method, path, { token, body });
    assert.ok(viewCalls(app).some(([, max]) => max === 12), `${method} ${path} não passou pela visão do modo família`);
  }
});

test('modo família: sorteio e pedido de título trabalham com a visão', async () => {
  const { app, token } = await withLimit(12);
  assert.equal((await app.call('GET', '/api/me/surprise', { token })).body.item.id, '777');
  await play(app, token, { type: 'movie', id: '777' });
  assert.equal((await app.call('GET', '/api/me/surprise', { token })).body.item, null, 'a série de 16 anos não pode ser sorteada');

  const hidden = await app.call('POST', '/api/me/requests', { token, body: { title: 'Série do Catálogo' } });
  assert.equal(hidden.status, 201, 'para quem está no modo família, a série oculta não conta como "já no catálogo"');
  const known = await app.call('POST', '/api/me/requests', { token, body: { title: 'Do Catálogo' } });
  assert.equal(known.status, 409);
});

test('modo família: o limite vale por conta e a visão muda junto com o limite', async () => {
  const app = makeApp();
  const kid = await app.registerAndApprove('crianca@exemplo.com');
  const adult = await app.registerAndApprove('adulto@exemplo.com');
  await setLimit(app, kid.token, { max: 12 });

  assert.equal((await app.call('GET', '/api/title/tv/300', { token: kid.token })).status, 410);
  assert.equal((await app.call('GET', '/api/title/tv/300', { token: adult.token })).status, 200);
  assert.equal((await me(app, adult.token)).maxRating, null);

  await setLimit(app, kid.token, { max: 16, password: 'errada' }).then((res) => assert.equal(res.status, 400));
  await setLimit(app, kid.token, { max: 16, password: PASSWORD });
  assert.equal((await app.call('GET', '/api/title/tv/300', { token: kid.token })).status, 200, 'com 16 a série de 16 anos aparece');
  await setLimit(app, kid.token, { max: 10 });
  assert.equal((await app.call('GET', '/api/title/movie/777', { token: kid.token })).status, 410, 'com 10 o filme de 12 anos some');
});

test('modo família: o limite sobrevive a login novo e sair de todos os aparelhos não o desliga', async () => {
  const { app, token } = await withLimit(10);
  await app.call('POST', '/api/me/logout-all', { token });
  const login = await app.call('POST', '/api/auth/login', { body: { email: 'ana@exemplo.com', password: PASSWORD } });
  assert.equal(login.body.user.maxRating, 10);
  assert.equal((await app.call('GET', '/api/title/movie/777', { token: login.body.token })).status, 410);
});
