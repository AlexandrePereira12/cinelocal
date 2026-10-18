import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashPassword, sha256Hex, signToken } from '../netlify/lib/auth.mjs';
import { ADMIN_EMAIL, AUTH_SECRET, DOMAIN_WITHOUT_MAIL, SITE_URL, makeApp } from './helpers.mjs';

const PROTECTED = [
  ['GET', '/api/auth/me'],
  ['GET', '/api/list/trending-movies'],
  ['GET', '/api/search?q=matrix'],
  ['GET', '/api/seasons/1396'],
  ['GET', '/api/episodes/1396/1'],
  ['POST', '/api/play', { type: 'movie', id: '1' }],
  ['POST', '/api/me/done', { type: 'movie', id: '1', done: true }],
  ['GET', '/api/me/library'],
  ['GET', '/api/me/preferences'],
  ['POST', '/api/me/preferences', { genres: [28, 18] }],
  ['GET', '/api/me/recommendations'],
  ['GET', '/api/title/movie/777'],
  ['GET', '/api/browse?type=movie'],
  ['GET', '/api/browse/options'],
  ['GET', '/api/directors'],
  ['GET', '/api/director/9001'],
  ['GET', '/api/me/account'],
  ['POST', '/api/me/account', { name: 'Ana Souza' }],
  ['POST', '/api/me/watchlist', { type: 'movie', id: '777', add: true }],
];

const seconds = (app) => Math.floor(app.clock.ms / 1000);
const accessToken = (app, sub, overrides = {}) =>
  signToken({ typ: 'access', sub, iat: seconds(app), exp: seconds(app) + 600, ...overrides }, AUTH_SECRET);

test('toda rota protegida exige token válido', async () => {
  const app = makeApp();
  const { token } = await app.registerAndApprove();
  const sub = (await app.call('GET', '/api/me/library', { token })).status === 200 && Buffer.from(token.split('.')[1], 'base64url').toString();
  const userId = JSON.parse(sub).sub;

  const forged = signToken({ typ: 'access', sub: userId, iat: 1, exp: seconds(app) + 600 }, 'outro-segredo-qualquer-com-mais-de-32-chars');
  const [h, p] = token.split('.');
  const noneHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const bad = {
    'sem token': undefined,
    lixo: 'abc',
    'assinatura de outro segredo': forged,
    'assinatura adulterada': `${h}.${p}.${'A'.repeat(43)}`,
    'assinatura curta': `${h}.${p}.AA`,
    'alg none': `${noneHeader}.${p}.`,
    expirado: accessToken(app, userId, { exp: seconds(app) - 1 }),
    'token de decisão': signToken({ typ: 'decision', sub: userId, act: 'approve', iat: 1, exp: seconds(app) + 600 }, AUTH_SECRET),
    'usuário inexistente': accessToken(app, `u_${'0'.repeat(40)}`),
    'sub malformado': accessToken(app, '../users'),
  };

  for (const [method, path, body] of PROTECTED) {
    for (const [label, bearer] of Object.entries(bad)) {
      const res = await app.call(method, path, { token: bearer, body });
      assert.equal(res.status, 401, `${method} ${path} com ${label}`);
    }
    const ok = await app.call(method, path, { token, body });
    assert.equal(ok.status, 200, `${method} ${path} com token válido`);
  }
});

test('rota inexistente e método errado', async () => {
  const app = makeApp();
  assert.equal((await app.call('GET', '/api/nada')).status, 404);
  assert.equal((await app.call('GET', '/api/auth/login')).status, 405);
  assert.equal((await app.call('GET', '/api/play')).status, 405);
  assert.equal((await app.call('DELETE', '/api/me/library')).status, 405);
  assert.equal((await app.call('DELETE', '/api/me/nada')).status, 404);
  assert.equal((await app.call('DELETE', '/api/me/preferences')).status, 405);
  assert.equal((await app.call('PUT', '/api/me/preferences')).status, 405);
});

test('cadastro valida dados e avisa o admin sem expor o e-mail dele', async () => {
  const app = makeApp();
  const ok = { name: '  Ana   Souza ', email: 'ANA@Exemplo.com ', password: 'Senha_bem_longa_1' };

  for (const bad of [{ ...ok, name: 'A' }, { ...ok, email: 'sem-arroba' }, { ...ok, password: 'curta' }, { ...ok, password: 123 }, {}]) {
    assert.equal((await app.call('POST', '/api/auth/register', { body: bad })).status, 400);
  }
  assert.equal(app.mails.length, 0);

  const res = await app.call('POST', '/api/auth/register', { body: ok });
  assert.equal(res.status, 202);
  assert.equal(app.mails.length, 1);
  assert.equal(app.mails[0].name, 'Ana Souza');
  assert.equal(app.mails[0].email, 'ana@exemplo.com');
  assert.ok(app.mails[0].approveUrl.startsWith(`${SITE_URL}/#/decisao/`), 'link usa SITE_URL, não o Host da requisição');
  assert.ok(!JSON.stringify(app.mails).includes(ADMIN_EMAIL));
});

test('cadastro exige senha de 4+ caracteres com maiúscula, minúscula, número e símbolo (@ _ .)', async () => {
  const app = makeApp();
  const body = { name: 'Ana', email: 'ana@exemplo.com' };
  const register = (password) => app.call('POST', '/api/auth/register', { body: { ...body, password } });

  const rejected = {
    'curta demais (3)': 'Ab1',
    'sem maiúscula': 'abc1@',
    'sem minúscula': 'ABC1@',
    'sem número': 'Abc@x',
    'sem símbolo': 'Abc12',
    'símbolo fora da lista': 'Abc1!',
    'acima do limite': `Aa1_${'x'.repeat(125)}`,
  };
  for (const [motivo, password] of Object.entries(rejected)) {
    const res = await register(password);
    assert.equal(res.status, 400, motivo);
    assert.match(res.body.error, /maiúscula, minúscula, número e um símbolo/, motivo);
  }
  assert.equal(app.mails.length, 0);

  for (const [i, password] of ['Ab1@', 'aB2_', 'Zz9.', 'Á1b_', `Aa1_${'x'.repeat(124)}`].entries()) {
    const res = await app.call('POST', '/api/auth/register', { body: { ...body, email: `ok${i}@exemplo.com`, password } });
    assert.equal(res.status, 202, password);
  }
});

test('cadastro recusa e-mail cujo domínio não recebe mensagens', async () => {
  const app = makeApp();
  const body = { name: 'Ana', email: `ana@${DOMAIN_WITHOUT_MAIL}`, password: 'Senha_bem_longa_1' };

  const res = await app.call('POST', '/api/auth/register', { body });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'invalid_email_domain');
  assert.equal(app.mails.length, 0);
  assert.equal(app.stores.users.data.size, 0);
  assert.deepEqual(app.domainChecks, [DOMAIN_WITHOUT_MAIL]);

  assert.equal((await app.call('POST', '/api/auth/register', { body: { ...body, email: 'ana@exemplo.com' } })).status, 202);
});

test('o DNS só é consultado depois da validação básica e do limite por IP', async () => {
  const app = makeApp();
  await app.call('POST', '/api/auth/register', { body: { name: 'Ana', email: 'sem-arroba', password: 'Senha_bem_longa_1' } });
  await app.call('POST', '/api/auth/register', { body: { name: 'Ana', email: 'ana@exemplo.com', password: 'fraca' } });
  assert.deepEqual(app.domainChecks, [], 'dado inválido não custa consulta de DNS');

  for (let i = 0; i < 5; i++) await app.call('POST', '/api/auth/register', { body: { name: 'Ana', email: `r${i}@exemplo.com`, password: 'Senha_bem_longa_1' }, ip: '198.51.100.20' });
  assert.equal(app.domainChecks.length, 5);
  assert.equal((await app.call('POST', '/api/auth/register', { body: { name: 'Ana', email: 'r9@exemplo.com', password: 'Senha_bem_longa_1' }, ip: '198.51.100.20' })).status, 429);
  assert.equal(app.domainChecks.length, 5, 'bloqueado por IP não consulta DNS');
});

test('login não aplica a regra de senha do cadastro (contas antigas continuam entrando)', async () => {
  const app = makeApp();
  const legacy = 'senha-antiga-sem-simbolo-1';
  const { email } = await app.registerAndApprove('velho@exemplo.com');
  const entry = await app.stores.users.get(`u_${sha256Hex(email).slice(0, 40)}`);
  await app.stores.users.put(entry.value.id, { ...entry.value, passHash: await hashPassword(legacy) }, entry.etag);

  const res = await app.call('POST', '/api/auth/login', { body: { email, password: legacy } });
  assert.equal(res.status, 200);
});

test('cadastro repetido responde igual e não reenvia e-mail', async () => {
  const app = makeApp();
  const body = { name: 'Ana', email: 'ana@exemplo.com', password: 'Senha_bem_longa_1' };
  const first = await app.call('POST', '/api/auth/register', { body });
  const again = await app.call('POST', '/api/auth/register', { body: { ...body, name: 'Outra Pessoa', password: 'Outra_senha_longa_2' } });
  assert.deepEqual(again, first);
  assert.equal(app.mails.length, 1);
});

test('se o aviso ao admin falhar, o cadastro é desfeito e dá erro', async () => {
  const app = makeApp({ mailFails: true });
  const body = { name: 'Ana', email: 'ana@exemplo.com', password: 'Senha_bem_longa_1' };
  const res = await app.call('POST', '/api/auth/register', { body });
  assert.equal(res.status, 503);
  assert.equal(app.stores.users.data.size, 0);
});

test('login: erro genérico, pendente só após senha correta, aprovação libera', async () => {
  const app = makeApp();
  const body = { name: 'Ana', email: 'ana@exemplo.com', password: 'Senha_bem_longa_1' };
  await app.call('POST', '/api/auth/register', { body });

  const unknown = await app.call('POST', '/api/auth/login', { body: { email: 'ninguem@exemplo.com', password: 'qualquer-senha-1' } });
  const wrong = await app.call('POST', '/api/auth/login', { body: { email: body.email, password: 'senha-errada-123' } });
  assert.equal(unknown.status, 401);
  assert.deepEqual(unknown, wrong, 'usuário inexistente e senha errada são indistinguíveis');

  const pending = await app.call('POST', '/api/auth/login', { body: { email: body.email, password: body.password } });
  assert.equal(pending.status, 401);
  assert.equal(pending.body.code, 'pending');

  const token = app.mails[0].approveUrl.split('/#/decisao/')[1];
  assert.equal((await app.call('POST', '/api/auth/decision', { body: { token } })).status, 200);
  const ok = await app.call('POST', '/api/auth/login', { body: { email: body.email, password: body.password } });
  assert.equal(ok.status, 200);
  assert.deepEqual(Object.keys(ok.body).sort(), ['token', 'user']);
  assert.deepEqual(ok.body.user, { name: 'Ana', genres: null, needsGenres: true, maxRating: null });
});

test('decisão: prévia sem mudar estado, uso único, recusa bloqueia', async () => {
  const app = makeApp();
  const body = { name: 'Bia', email: 'bia@exemplo.com', password: 'Senha_bem_longa_1' };
  await app.call('POST', '/api/auth/register', { body });
  const reject = app.mails[0].rejectUrl.split('/#/decisao/')[1];
  const approve = app.mails[0].approveUrl.split('/#/decisao/')[1];

  const preview = await app.call('POST', '/api/auth/decision/preview', { body: { token: reject } });
  assert.deepEqual(preview.body, { name: 'Bia', email: 'bia@exemplo.com', action: 'reject', status: 'pending' });
  assert.equal((await app.call('POST', '/api/auth/decision/preview', { body: { token: reject } })).body.status, 'pending');

  assert.equal((await app.call('POST', '/api/auth/decision', { body: { token: reject } })).body.status, 'rejected');
  assert.equal((await app.call('POST', '/api/auth/decision', { body: { token: approve } })).status, 409);

  const login = await app.call('POST', '/api/auth/login', { body: { email: body.email, password: body.password } });
  assert.equal(login.status, 401);
  assert.equal(login.body.code, 'rejected');
});

test('decisão: token inválido, expirado, de outro tipo ou GET', async () => {
  const app = makeApp();
  const { token } = await app.registerAndApprove();
  const bad = [undefined, 'x', token, 'a.b.c'];
  for (const t of bad) assert.equal((await app.call('POST', '/api/auth/decision', { body: { token: t } })).status, 400);

  const body = { name: 'Caio', email: 'caio@exemplo.com', password: 'Senha_bem_longa_1' };
  await app.call('POST', '/api/auth/register', { body });
  const link = app.mails.at(-1).approveUrl.split('/#/decisao/')[1];
  app.clock.ms += 8 * 24 * 3600 * 1000;
  assert.equal((await app.call('POST', '/api/auth/decision', { body: { token: link } })).status, 400);
  assert.equal((await app.call('GET', '/api/auth/decision')).status, 405);
});

test('revogação vale na hora: token antigo de usuário recusado perde acesso', async () => {
  const app = makeApp();
  const { token } = await app.registerAndApprove();
  assert.equal((await app.call('GET', '/api/me/library', { token })).status, 200);
  for (const [key, entry] of app.stores.users.data) app.stores.users.data.set(key, { ...entry, value: { ...entry.value, status: 'rejected' } });
  assert.equal((await app.call('GET', '/api/me/library', { token })).status, 401);
});

test('token expira', async () => {
  const app = makeApp();
  const { token } = await app.registerAndApprove();
  app.clock.ms += 8 * 24 * 3600 * 1000;
  assert.equal((await app.call('GET', '/api/auth/me', { token })).status, 401);
});

test('limite de tentativas de login por e-mail e por IP', async () => {
  const app = makeApp();
  const { email, password } = await app.registerAndApprove();
  const attempt = (ip) => app.call('POST', '/api/auth/login', { body: { email, password: 'senha-errada-123' }, ip });

  for (let i = 0; i < 5; i++) assert.equal((await attempt('198.51.100.1')).status, 401);
  assert.equal((await attempt('198.51.100.2')).status, 429, 'bloqueio por e-mail vale de qualquer IP');
  assert.equal((await app.call('POST', '/api/auth/login', { body: { email, password }, ip: '198.51.100.3' })).status, 429, 'nem a senha certa passa enquanto bloqueado');

  app.clock.ms += 16 * 60 * 1000;
  assert.equal((await app.call('POST', '/api/auth/login', { body: { email, password }, ip: '198.51.100.3' })).status, 200);
});

test('limite de cadastros por IP e teto diário de avisos', async () => {
  const app = makeApp();
  const reg = (i, ip) => app.call('POST', '/api/auth/register', { body: { name: 'Pessoa', email: `p${i}@exemplo.com`, password: 'Senha_bem_longa_1' }, ip });
  for (let i = 0; i < 5; i++) assert.equal((await reg(i, '198.51.100.9')).status, 202);
  assert.equal((await reg(99, '198.51.100.9')).status, 429);

  const capped = makeApp();
  let last;
  for (let i = 0; i < 31; i++) last = await capped.call('POST', '/api/auth/register', { body: { name: 'Pessoa', email: `q${i}@exemplo.com`, password: 'Senha_bem_longa_1' }, ip: `198.51.100.${i}` });
  assert.equal(last.status, 503);
  assert.equal(capped.mails.length, 30);
});

test('corpo: content-type, tamanho e JSON', async () => {
  const app = makeApp();
  const url = '/api/auth/login';
  assert.equal((await app.call('POST', url, { raw: '{}', contentType: 'text/plain' })).status, 415);
  assert.equal((await app.call('POST', url, { raw: 'não é json' })).status, 400);
  assert.equal((await app.call('POST', url, { raw: '[]' })).status, 400);
  assert.equal((await app.call('POST', url, { raw: JSON.stringify({ email: 'a@b.co', password: 'x'.repeat(5000) }) })).status, 413);
});

test('sem AUTH_SECRET ou SITE_URL o serviço falha fechado', async () => {
  const body = { name: 'Ana', email: 'ana@exemplo.com', password: 'Senha_bem_longa_1' };
  assert.equal((await makeApp({ env: { AUTH_SECRET: 'curto' } }).call('POST', '/api/auth/login', { body })).status, 500);
  assert.equal((await makeApp({ env: { SITE_URL: 'http://site-publico.invalid' } }).call('POST', '/api/auth/register', { body })).status, 500);
  assert.equal((await makeApp({ env: { SITE_URL: undefined } }).call('POST', '/api/auth/register', { body })).status, 500);
});

test('catálogo só responde autenticado e valida parâmetros', async () => {
  const app = makeApp();
  const { token } = await app.registerAndApprove();
  assert.equal((await app.call('GET', '/api/list/trending-movies?page=0', { token })).status, 400);
  assert.equal((await app.call('GET', '/api/list/trending-movies?page=abc', { token })).status, 400);
  assert.equal((await app.call('GET', '/api/search?q=a', { token })).status, 400);
  assert.equal((await app.call('GET', '/api/seasons/abc', { token })).status, 404);
  assert.equal((await app.call('GET', '/api/episodes/1396/100', { token })).status, 404);
  assert.equal((await app.call('GET', '/api/list/trending-movies?page=3', { token })).status, 200);
  assert.deepEqual(app.catalog.calls.at(-1), ['list', 'trending-movies', 3]);
});

test('histórico: filme entra em continuar, série retoma de onde parou, marcar como assistido', async () => {
  const app = makeApp();
  const { token } = await app.registerAndApprove();
  const play = (body) => app.call('POST', '/api/play', { token, body });

  const movie = await play({ type: 'movie', id: '10', title: 'Filme Dez', year: '2021', poster: '/abc.jpg' });
  assert.equal(movie.body.url, 'https://embedplayapi.top/embed/10');

  const first = await play({ type: 'tv', id: '20', title: 'Série Vinte' });
  assert.equal(first.body.url, 'https://embedplayapi.top/embed/20/1/1');
  const moved = await play({ type: 'tv', id: '20', season: 2, episode: 5 });
  assert.equal(moved.body.url, 'https://embedplayapi.top/embed/20/2/5');
  assert.equal(moved.body.title, 'Série Vinte', 'metadado preservado');
  const resumed = await play({ type: 'tv', id: '20' });
  assert.equal(resumed.body.url, 'https://embedplayapi.top/embed/20/2/5', 'retoma de onde parou');

  let lib = await app.call('GET', '/api/me/library', { token });
  assert.deepEqual(lib.body.continue.map((i) => i.id).sort(), ['10', '20']);
  assert.deepEqual(lib.body.watched, []);

  const done = await app.call('POST', '/api/me/done', { token, body: { type: 'movie', id: '10', done: true } });
  assert.equal(done.body.done, true);
  lib = await app.call('GET', '/api/me/library', { token });
  assert.deepEqual(lib.body.continue.map((i) => i.id), ['20']);
  assert.deepEqual(lib.body.watched.map((i) => i.id), ['10']);
  assert.deepEqual(Object.keys(lib.body.watched[0]).sort(), ['done', 'episode', 'id', 'lastViewedAt', 'poster', 'season', 'title', 'type', 'year']);

  assert.equal((await app.call('POST', '/api/me/done', { token, body: { type: 'movie', id: '99', done: true } })).status, 404);
});

test('histórico valida entrada e é isolado por usuário', async () => {
  const app = makeApp();
  const a = await app.registerAndApprove('a@exemplo.com');
  const b = await app.registerAndApprove('b@exemplo.com');
  const play = (token, body) => app.call('POST', '/api/play', { token, body });

  for (const bad of [
    { type: 'anime', id: '1' },
    { type: 'movie', id: 'abc' },
    { type: 'movie', id: '1', poster: 'https://evil.example/x.jpg' },
    { type: 'movie', id: '1', title: 'x'.repeat(200) },
    { type: 'tv', id: '1', season: 500, episode: 1 },
    { type: 'tv', id: '1', season: 1, episode: 0 },
    { type: 'movie', id: '1', year: '20x1' },
  ]) {
    assert.equal((await play(a.token, bad)).status, 400, JSON.stringify(bad));
  }

  await play(a.token, { type: 'movie', id: '1', title: 'Só da Ana' });
  const libB = await app.call('GET', '/api/me/library', { token: b.token });
  assert.deepEqual(libB.body, { continue: [], watched: [], watchlist: [] });
});

test('histórico tem teto e descarta os mais antigos', async () => {
  const app = makeApp();
  const { token } = await app.registerAndApprove();
  for (let i = 1; i <= 305; i++) {
    app.clock.ms += 1000;
    await app.call('POST', '/api/play', { token, body: { type: 'movie', id: String(i), title: `Filme ${i}` } });
  }
  const [{ value }] = [...app.stores.library.data.values()];
  assert.equal(Object.keys(value.items).length, 300);
  assert.ok(!value.items['movie:1'] && value.items['movie:305']);
});

test('pendente cujo aviso venceu recebe novo e-mail ao repetir o cadastro', async () => {
  const app = makeApp();
  const body = { name: 'Dani', email: 'dani@exemplo.com', password: 'Senha_bem_longa_1' };
  const DAY = 24 * 3600 * 1000;

  await app.call('POST', '/api/auth/register', { body });
  app.clock.ms += 3 * DAY;
  await app.call('POST', '/api/auth/register', { body });
  assert.equal(app.mails.length, 1, 'dentro do prazo não reenvia');

  app.clock.ms += 5 * DAY; // 8 dias desde o aviso: o link antigo expirou
  const old = app.mails[0].approveUrl.split('/#/decisao/')[1];
  assert.equal((await app.call('POST', '/api/auth/decision', { body: { token: old } })).status, 400);

  const again = await app.call('POST', '/api/auth/register', { body: { ...body, name: 'Outro Nome', password: 'Outra_senha_longa_2' } });
  assert.equal(again.status, 202);
  assert.equal(app.mails.length, 2);
  assert.equal(app.mails[1].name, 'Dani', 'repetir o cadastro não altera os dados guardados');

  const fresh = app.mails[1].approveUrl.split('/#/decisao/')[1];
  assert.equal((await app.call('POST', '/api/auth/decision', { body: { token: fresh } })).status, 200);
  const login = await app.call('POST', '/api/auth/login', { body: { email: body.email, password: body.password } });
  assert.equal(login.status, 200, 'vale a senha do cadastro original');
});

test('reenvio que falha não apaga o cadastro pendente', async () => {
  const app = makeApp();
  const body = { name: 'Edu', email: 'edu@exemplo.com', password: 'Senha_bem_longa_1' };
  await app.call('POST', '/api/auth/register', { body });

  app.clock.ms += 8 * 24 * 3600 * 1000;
  const failing = makeApp({ mailFails: true });
  failing.stores.users.data = app.stores.users.data; // mesmo armazenamento, mailer quebrado
  failing.clock.ms = app.clock.ms;
  assert.equal((await failing.call('POST', '/api/auth/register', { body })).status, 503);
  assert.equal(app.stores.users.data.size, 1);

  assert.equal((await app.call('POST', '/api/auth/register', { body })).status, 202);
  assert.equal(app.mails.length, 2, 'nova tentativa com o e-mail funcionando reenvia');
});

test('play usa o metadado do catálogo do servidor e ignora o que o navegador manda', async () => {
  const app = makeApp();
  const { token } = await app.registerAndApprove();
  const res = await app.call('POST', '/api/play', { token, body: { type: 'movie', id: '777', title: 'Título Falso', year: '1999', poster: '/falso.jpg' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.title, 'Do Catálogo');
  assert.equal(res.body.year, '2024');
  assert.equal(res.body.poster, '/catalogo.jpg');

  const deepLink = await app.call('POST', '/api/play', { token, body: { type: 'movie', id: '777' } });
  assert.equal(deepLink.body.title, 'Do Catálogo', 'link direto também ganha o título certo');
});

test('gêneros favoritos: usuário novo precisa escolher 2, salva, e o perfil reflete', async () => {
  const app = makeApp();
  const { token } = await app.registerAndApprove();

  const before = await app.call('GET', '/api/auth/me', { token });
  assert.deepEqual(before.body, { name: 'Ana Souza', genres: null, needsGenres: true, maxRating: null });

  const prefs = await app.call('GET', '/api/me/preferences', { token });
  assert.deepEqual(prefs.body.options, [{ id: 28, name: 'Ação' }, { id: 35, name: 'Comédia' }, { id: 18, name: 'Drama' }]);
  assert.equal(prefs.body.needsGenres, true);

  const saved = await app.call('POST', '/api/me/preferences', { token, body: { genres: [18, 28] } });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.genres, [{ id: 18, name: 'Drama' }, { id: 28, name: 'Ação' }]);
  assert.equal(saved.body.needsGenres, false);

  const after = await app.call('GET', '/api/auth/me', { token });
  assert.deepEqual(after.body, { name: 'Ana Souza', genres: [{ id: 18, name: 'Drama' }, { id: 28, name: 'Ação' }], needsGenres: false, maxRating: null });
  const login = await app.call('POST', '/api/auth/login', { body: { email: 'ana@exemplo.com', password: 'Senha_bem_longa_1' } });
  assert.equal(login.body.user.needsGenres, false, 'o login também já traz os gêneros');

  const changed = await app.call('POST', '/api/me/preferences', { token, body: { genres: [35, 28] } });
  assert.deepEqual(changed.body.genres.map((g) => g.id), [35, 28], 'dá para trocar depois');
});

test('gêneros favoritos: valida exatamente 2 ids distintos e da lista', async () => {
  const app = makeApp();
  const { token } = await app.registerAndApprove();
  for (const genres of [[], [28], [28, 18, 35], [28, 28], [28, 999], ['28', '18'], [28, null], [1.5, 28], 'Ação', null, undefined]) {
    const res = await app.call('POST', '/api/me/preferences', { token, body: { genres } });
    assert.equal(res.status, 400, JSON.stringify(genres));
  }
  assert.equal((await app.call('POST', '/api/me/preferences', { token, body: {} })).status, 400);
  assert.equal((await app.call('GET', '/api/auth/me', { token })).body.genres, null, 'nada foi salvo');
});

test('gêneros favoritos: usuário antigo (registro sem o campo) também precisa escolher no próximo acesso', async () => {
  const app = makeApp();
  const { token } = await app.registerAndApprove();
  for (const [key, entry] of app.stores.users.data) {
    const { genres, ...old } = entry.value;
    app.stores.users.data.set(key, { ...entry, value: old });
  }
  assert.equal((await app.call('GET', '/api/auth/me', { token })).body.needsGenres, true);
});

test('gêneros favoritos: id salvo que saiu do catálogo volta a pedir a escolha', async () => {
  const app = makeApp();
  const { token } = await app.registerAndApprove();
  await app.call('POST', '/api/me/preferences', { token, body: { genres: [28, 18] } });
  for (const [key, entry] of app.stores.users.data) app.stores.users.data.set(key, { ...entry, value: { ...entry.value, genres: [28, 777] } });
  const me = await app.call('GET', '/api/auth/me', { token });
  assert.deepEqual(me.body, { name: 'Ana Souza', genres: null, needsGenres: true, maxRating: null });
});

test('gêneros favoritos: catálogo sem gêneros não obriga ninguém e recusa salvar', async () => {
  const app = makeApp({ genres: false });
  const { token } = await app.registerAndApprove();
  assert.deepEqual((await app.call('GET', '/api/auth/me', { token })).body, { name: 'Ana Souza', genres: null, needsGenres: false, maxRating: null });
  assert.equal((await app.call('GET', '/api/me/preferences', { token })).body.options.length, 0);
  const res = await app.call('POST', '/api/me/preferences', { token, body: { genres: [28, 18] } });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'genres_unavailable');
});

test('gêneros favoritos: são por usuário e nunca aparecem no registro de outro', async () => {
  const app = makeApp();
  const a = await app.registerAndApprove('a@exemplo.com');
  const b = await app.registerAndApprove('b@exemplo.com', 'Senha_bem_longa_1', 'Bia');
  await app.call('POST', '/api/me/preferences', { token: a.token, body: { genres: [28, 18] } });
  assert.equal((await app.call('GET', '/api/auth/me', { token: b.token })).body.genres, null);
});

test('recomendações: sem gêneros escolhidos não há fileiras; com gêneros vêm na ordem escolhida', async () => {
  const app = makeApp();
  const { token } = await app.registerAndApprove();
  assert.deepEqual((await app.call('GET', '/api/me/recommendations', { token })).body, { rows: [] });

  await app.call('POST', '/api/me/preferences', { token, body: { genres: [28, 18] } });
  const res = await app.call('GET', '/api/me/recommendations', { token });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.rows.map((row) => [row.id, row.title]), [['gosto-1', 'Mais de Ação'], ['gosto-2', 'Mais de Drama']], 'a lista "mix" vazia some');
  assert.deepEqual(app.catalog.calls.at(-1), ['recommend', [28, 18], []]);

  await app.call('POST', '/api/me/preferences', { token, body: { genres: [18, 28] } });
  const swapped = await app.call('GET', '/api/me/recommendations', { token });
  assert.deepEqual(swapped.body.rows.map((row) => row.title), ['Mais de Drama', 'Mais de Ação'], 'o 1º gênero escolhido vira a 1ª fileira');
});

test('recomendações: o histórico do usuário (filme e série) é passado para esconder o que já foi aberto', async () => {
  const app = makeApp();
  const { token } = await app.registerAndApprove();
  await app.call('POST', '/api/me/preferences', { token, body: { genres: [28, 18] } });
  await app.call('POST', '/api/play', { token, body: { type: 'movie', id: '10', title: 'Filme' } });
  await app.call('POST', '/api/play', { token, body: { type: 'tv', id: '20', title: 'Série' } });
  await app.call('GET', '/api/me/recommendations', { token });
  assert.deepEqual(app.catalog.calls.at(-1), ['recommend', [28, 18], ['movie:10', 'tv:20']]);
});

test('recomendações: cada usuário vê só o que o próprio histórico exclui', async () => {
  const app = makeApp();
  const a = await app.registerAndApprove('a@exemplo.com');
  const b = await app.registerAndApprove('b@exemplo.com', 'Senha_bem_longa_1', 'Bia');
  for (const user of [a, b]) await app.call('POST', '/api/me/preferences', { token: user.token, body: { genres: [28, 18] } });
  await app.call('POST', '/api/play', { token: a.token, body: { type: 'movie', id: '10', title: 'Só da Ana' } });
  await app.call('GET', '/api/me/recommendations', { token: b.token });
  assert.deepEqual(app.catalog.calls.at(-1), ['recommend', [28, 18], []], 'o histórico da Ana não vaza para a Bia');
});
