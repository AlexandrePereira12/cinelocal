import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sha256Hex, signToken } from '../netlify/lib/auth.mjs';
import { AUTH_SECRET, SITE_URL, makeApp } from './helpers.mjs';

const GOOD = 'Senha_bem_longa_1';
const NEXT = 'Outra_senha_2';
const HOUR_MS = 60 * 60 * 1000;

const login = (app, email, password, ip) => app.call('POST', '/api/auth/login', { body: { email, password }, ip });
const resetToken = (app) => app.resets.at(-1).resetUrl.split('/#/redefinir/')[1];
const userIdOf = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub;

test('decisão do admin avisa a pessoa por e-mail; falha no envio não desfaz a decisão', async () => {
  const app = makeApp();
  await app.call('POST', '/api/auth/register', { body: { name: 'Ana Souza', email: 'ana@exemplo.com', password: GOOD } });
  await app.call('POST', '/api/auth/register', { body: { name: 'Beto Lima', email: 'beto@exemplo.com', password: GOOD } });
  const [ana, beto] = app.mails;

  const approved = await app.call('POST', '/api/auth/decision', { body: { token: ana.approveUrl.split('/#/decisao/')[1] } });
  assert.equal(approved.status, 200);
  assert.deepEqual(app.notices, [{ name: 'Ana Souza', email: 'ana@exemplo.com', approved: true, loginUrl: `${SITE_URL}/#/login` }]);

  const rejected = await app.call('POST', '/api/auth/decision', { body: { token: beto.rejectUrl.split('/#/decisao/')[1] } });
  assert.equal(rejected.status, 200);
  assert.equal(app.notices.at(-1).approved, false);
  assert.equal(app.notices.at(-1).email, 'beto@exemplo.com');

  const flaky = makeApp({ userMailFails: true });
  await flaky.call('POST', '/api/auth/register', { body: { name: 'Caio Dias', email: 'caio@exemplo.com', password: GOOD } });
  const decided = await flaky.call('POST', '/api/auth/decision', { body: { token: flaky.mails[0].approveUrl.split('/#/decisao/')[1] } });
  assert.equal(decided.status, 200, 'o e-mail falhou, a decisão vale');
  assert.equal((await login(flaky, 'caio@exemplo.com', GOOD)).status, 200, 'e a pessoa consegue entrar');
});

test('esqueci a senha: resposta igual com ou sem conta, e só conta aprovada recebe o link', async () => {
  const app = makeApp();
  await app.registerAndApprove('ana@exemplo.com');
  await app.call('POST', '/api/auth/register', { body: { name: 'Pendente', email: 'pendente@exemplo.com', password: GOOD } });

  const known = await app.call('POST', '/api/auth/forgot', { body: { email: 'ANA@exemplo.com' } });
  const unknown = await app.call('POST', '/api/auth/forgot', { body: { email: 'ninguem@exemplo.com' } });
  const pending = await app.call('POST', '/api/auth/forgot', { body: { email: 'pendente@exemplo.com' } });
  assert.equal(known.status, 202);
  assert.deepEqual(unknown, known, 'conta inexistente responde igual');
  assert.deepEqual(pending, known, 'conta pendente responde igual');

  assert.equal(app.resets.length, 1, 'só a conta aprovada recebe o e-mail');
  assert.equal(app.resets[0].email, 'ana@exemplo.com');
  assert.equal(app.resets[0].name, 'Ana Souza');
  assert.match(app.resets[0].resetUrl, new RegExp(`^${SITE_URL}/#/redefinir/[A-Za-z0-9._-]+$`));

  assert.equal((await app.call('POST', '/api/auth/forgot', { body: { email: 'não é e-mail' } })).status, 400);
  assert.equal((await app.call('POST', '/api/auth/forgot', { body: {} })).status, 400);
});

test('esqueci a senha: falha no e-mail e teto diário não mudam a resposta (nem revelam a conta)', async () => {
  const flaky = makeApp({ userMailFails: true });
  await flaky.registerAndApprove('ana@exemplo.com');
  const known = await flaky.call('POST', '/api/auth/forgot', { body: { email: 'ana@exemplo.com' } });
  const unknown = await flaky.call('POST', '/api/auth/forgot', { body: { email: 'ninguem@exemplo.com' } });
  assert.equal(known.status, 202);
  assert.deepEqual(known, unknown);

  const app = makeApp();
  const emails = Array.from({ length: 31 }, (_, k) => `pessoa${k}@exemplo.com`);
  // Contas já aprovadas gravadas direto na store: o cadastro tem limite próprio (5 por IP/hora, 30 avisos ao admin/dia).
  for (const email of emails) {
    const id = `u_${sha256Hex(email).slice(0, 40)}`;
    await app.stores.users.create(id, { id, name: 'Fulano', email, passHash: 'scrypt$qualquer', status: 'approved', createdAt: new Date(app.clock.ms).toISOString() });
  }
  for (const [index, email] of emails.entries()) {
    const res = await app.call('POST', '/api/auth/forgot', { body: { email }, ip: `198.51.100.${index + 1}` });
    assert.equal(res.status, 202);
  }
  assert.equal(app.resets.length, 30, 'o 31º pedido do dia não envia (teto diário), mas responde igual');
});

test('esqueci a senha: limita por e-mail e por IP', async () => {
  const app = makeApp();
  await app.registerAndApprove('ana@exemplo.com');
  for (let i = 0; i < 3; i++) assert.equal((await app.call('POST', '/api/auth/forgot', { body: { email: 'ana@exemplo.com' }, ip: `198.51.100.${i + 1}` })).status, 202);
  const fourth = await app.call('POST', '/api/auth/forgot', { body: { email: 'ana@exemplo.com' }, ip: '198.51.100.99' });
  assert.equal(fourth.status, 429, 'o 4º pedido da hora para o mesmo e-mail, de outro IP, também é barrado');
  assert.equal(app.resets.length, 3);

  const other = makeApp();
  for (let i = 0; i < 5; i++) assert.equal((await other.call('POST', '/api/auth/forgot', { body: { email: `x${i}@exemplo.com` }, ip: '203.0.113.50' })).status, 202);
  assert.equal((await other.call('POST', '/api/auth/forgot', { body: { email: 'x9@exemplo.com' }, ip: '203.0.113.50' })).status, 429);
  other.clock.ms += HOUR_MS + 1;
  assert.equal((await other.call('POST', '/api/auth/forgot', { body: { email: 'x9@exemplo.com' }, ip: '203.0.113.50' })).status, 202, 'a janela de 1 hora renova');
});

test('redefinir: muda a senha, derruba as sessões antigas e o link só funciona uma vez', async () => {
  const app = makeApp();
  const { token: oldSession } = await app.registerAndApprove('ana@exemplo.com');
  await app.call('POST', '/api/auth/forgot', { body: { email: 'ana@exemplo.com' } });
  const link = resetToken(app);

  assert.equal((await app.call('POST', '/api/auth/reset', { body: { token: link, password: 'fraca' } })).status, 400, 'senha fora da regra');
  const done = await app.call('POST', '/api/auth/reset', { body: { token: link, password: NEXT } });
  assert.equal(done.status, 200);

  assert.equal((await login(app, 'ana@exemplo.com', GOOD)).status, 401, 'a senha antiga não vale mais');
  const fresh = await login(app, 'ana@exemplo.com', NEXT);
  assert.equal(fresh.status, 200);
  assert.equal((await app.call('GET', '/api/me/library', { token: oldSession })).status, 401, 'a sessão aberta antes da redefinição caiu');
  assert.equal((await app.call('GET', '/api/me/library', { token: fresh.body.token })).status, 200);

  const again = await app.call('POST', '/api/auth/reset', { body: { token: link, password: 'Terceira_3' } });
  assert.equal(again.status, 400, 'o mesmo link não serve de novo');
  assert.equal(again.body.code, 'invalid_token');
  assert.equal((await login(app, 'ana@exemplo.com', NEXT)).status, 200, 'a senha continua a da primeira redefinição');
});

test('redefinir: link vencido, adulterado ou de outro tipo é recusado com o mesmo erro', async () => {
  const app = makeApp();
  const { token } = await app.registerAndApprove('ana@exemplo.com');
  await app.call('POST', '/api/auth/forgot', { body: { email: 'ana@exemplo.com' } });
  const link = resetToken(app);
  const sub = userIdOf(token);
  const iat = Math.floor(app.clock.ms / 1000);
  const bad = {
    lixo: 'abc',
    vazio: '',
    adulterado: `${link.slice(0, -3)}AAA`,
    'token de acesso': token,
    'reset sem impressão': signToken({ typ: 'reset', sub, iat, exp: iat + 3600 }, AUTH_SECRET),
    'reset com impressão errada': signToken({ typ: 'reset', sub, pv: '0'.repeat(16), iat, exp: iat + 3600 }, AUTH_SECRET),
    'usuário inexistente': signToken({ typ: 'reset', sub: `u_${'0'.repeat(40)}`, pv: '0'.repeat(16), iat, exp: iat + 3600 }, AUTH_SECRET),
  };
  for (const [label, candidate] of Object.entries(bad)) {
    const res = await app.call('POST', '/api/auth/reset', { body: { token: candidate, password: NEXT } });
    assert.equal(res.status, 400, label);
    assert.equal(res.body.code, 'invalid_token', label);
  }

  app.clock.ms += HOUR_MS + 1000;
  const expired = await app.call('POST', '/api/auth/reset', { body: { token: link, password: NEXT } });
  assert.equal(expired.status, 400, 'passou de 1 hora');
  assert.equal(expired.body.code, 'invalid_token');
  assert.equal((await login(app, 'ana@exemplo.com', GOOD)).status, 200, 'nada mudou');
});

test('redefinir destrava o login de quem errou a senha vezes demais', async () => {
  const app = makeApp();
  await app.registerAndApprove('ana@exemplo.com');
  for (let i = 0; i < 5; i++) await login(app, 'ana@exemplo.com', 'errada');
  assert.equal((await login(app, 'ana@exemplo.com', GOOD)).status, 429, 'travada');

  await app.call('POST', '/api/auth/forgot', { body: { email: 'ana@exemplo.com' } });
  assert.equal((await app.call('POST', '/api/auth/reset', { body: { token: resetToken(app), password: NEXT } })).status, 200);
  assert.equal((await login(app, 'ana@exemplo.com', NEXT)).status, 200);
});

test('trocar a senha: exige a atual (erro 400, nunca 401), devolve token novo e derruba as outras sessões', async () => {
  const app = makeApp();
  const { token: current } = await app.registerAndApprove('ana@exemplo.com');
  const other = (await login(app, 'ana@exemplo.com', GOOD)).body.token;
  const change = (body, token = current) => app.call('POST', '/api/me/password', { token, body });

  const wrong = await change({ current: 'Errada_1', next: NEXT });
  assert.equal(wrong.status, 400, '401 derrubaria a sessão no front');
  assert.equal(wrong.body.code, 'wrong_password');
  assert.equal((await app.call('GET', '/api/me/library', { token: current })).status, 200, 'a sessão continua valendo');

  assert.equal((await change({ current: GOOD, next: 'fraca' })).status, 400);
  assert.equal((await change({ current: GOOD, next: GOOD })).status, 400, 'a nova tem que ser diferente');
  assert.equal((await change({ next: NEXT })).status, 400);
  assert.equal((await change({ current: 123, next: NEXT })).status, 400);

  const ok = await change({ current: GOOD, next: NEXT });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.token);
  assert.equal((await app.call('GET', '/api/me/library', { token: ok.body.token })).status, 200, 'o aparelho que trocou continua entrando');
  assert.equal((await app.call('GET', '/api/me/library', { token: current })).status, 401, 'o token antigo caiu');
  assert.equal((await app.call('GET', '/api/me/library', { token: other })).status, 401, 'e a sessão de outro aparelho também');
  assert.equal((await login(app, 'ana@exemplo.com', GOOD)).status, 401);
  assert.equal((await login(app, 'ana@exemplo.com', NEXT)).status, 200);
});

test('trocar a senha: erros na senha atual são limitados por usuário', async () => {
  const app = makeApp();
  const { token } = await app.registerAndApprove('ana@exemplo.com');
  for (let i = 0; i < 5; i++) assert.equal((await app.call('POST', '/api/me/password', { token, body: { current: 'Errada_1', next: NEXT } })).status, 400);
  const blocked = await app.call('POST', '/api/me/password', { token, body: { current: GOOD, next: NEXT } });
  assert.equal(blocked.status, 429, 'nem a senha certa passa enquanto estiver travado');
  app.clock.ms += 16 * 60 * 1000;
  assert.equal((await app.call('POST', '/api/me/password', { token, body: { current: GOOD, next: NEXT } })).status, 200);
});

test('sair de todos os dispositivos invalida todos os tokens, inclusive o de quem pediu', async () => {
  const app = makeApp();
  const { token: first } = await app.registerAndApprove('ana@exemplo.com');
  const second = (await login(app, 'ana@exemplo.com', GOOD)).body.token;
  assert.equal((await app.call('POST', '/api/me/logout-all', { token: first })).status, 200);
  for (const token of [first, second]) assert.equal((await app.call('GET', '/api/auth/me', { token })).status, 401);
  const again = await login(app, 'ana@exemplo.com', GOOD);
  assert.equal(again.status, 200, 'entrar de novo funciona');
  assert.equal((await app.call('GET', '/api/auth/me', { token: again.body.token })).status, 200);
  assert.equal((await app.call('POST', '/api/me/logout-all', {})).status, 401, 'exige login');
});

test('sessão antiga, sem o número de versão, continua valendo até alguém encerrar as sessões', async () => {
  const app = makeApp();
  const { token } = await app.registerAndApprove('ana@exemplo.com');
  const id = userIdOf(token);
  const legacy = signToken({ typ: 'access', sub: id, iat: Math.floor(app.clock.ms / 1000), exp: Math.floor(app.clock.ms / 1000) + 600 }, AUTH_SECRET);
  assert.equal((await app.call('GET', '/api/auth/me', { token: legacy })).status, 200);
  await app.call('POST', '/api/me/logout-all', { token });
  assert.equal((await app.call('GET', '/api/auth/me', { token: legacy })).status, 401);
});

test('conta: mostra nome e e-mail da própria pessoa e troca o nome', async () => {
  const app = makeApp();
  const { token } = await app.registerAndApprove('ana@exemplo.com');
  assert.deepEqual((await app.call('GET', '/api/me/account', { token })).body, { name: 'Ana Souza', email: 'ana@exemplo.com' });

  const renamed = await app.call('POST', '/api/me/account', { token, body: { name: '  Ana   Maria ' } });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.name, 'Ana Maria');
  assert.equal((await app.call('GET', '/api/auth/me', { token })).body.name, 'Ana Maria');
  assert.equal((await app.call('POST', '/api/me/account', { token, body: { name: 'A' } })).status, 400);
  assert.equal((await app.call('POST', '/api/me/account', { token, body: {} })).status, 400);
  assert.equal((await app.call('GET', '/api/me/account', {})).status, 401);
});

test('o campo "senha atual" da troca de senha não tem botão de mostrar (as senhas novas continuam tendo)', async () => {
  const { readFile } = await import('node:fs/promises');
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /passwordField\('Senha atual', 'current-password', \{[^}]*\}, \{ reveal: false \}\)/);
  assert.match(app, /function passwordField\(label, id, attrs, \{ reveal = true \} = \{\}\)/, 'por padrão o botão existe (login, cadastro, nova senha)');
});

test('limites de tentativa resistem a requisições paralelas: a tentativa é contada antes de verificar a senha', async () => {
  const app = makeApp();
  const { token } = await app.registerAndApprove('ana@exemplo.com');

  const changes = await Promise.all(Array.from({ length: 20 }, () => app.call('POST', '/api/me/password', { token, body: { current: 'Errada_1', next: NEXT } })));
  const checked = changes.filter((res) => res.body.code === 'wrong_password').length;
  assert.ok(checked >= 1 && checked <= 5, `a senha atual foi conferida ${checked} vezes em 20 pedidos paralelos (teto: 5)`);
  assert.ok(changes.every((res) => [400, 429].includes(res.status)));

  // IPs diferentes: só o limite por e-mail pode segurar a adivinhação distribuída
  const logins = await Promise.all(Array.from({ length: 20 }, (_, i) => login(app, 'ana@exemplo.com', `Errada_${i}`, `198.51.100.${i + 1}`)));
  const tried = logins.filter((res) => res.body.code === 'invalid_credentials').length;
  assert.ok(tried >= 1 && tried <= 5, `a senha foi conferida ${tried} vezes em 20 logins paralelos (teto: 5)`);
  assert.ok(logins.every((res) => [401, 429].includes(res.status)));
});

test('login certo zera a contagem de tentativas do e-mail (não sobra bloqueio por ter errado antes)', async () => {
  const app = makeApp();
  await app.registerAndApprove('ana@exemplo.com');
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 4; i++) assert.equal((await login(app, 'ana@exemplo.com', 'errada')).status, 401);
    assert.equal((await login(app, 'ana@exemplo.com', GOOD)).status, 200, `rodada ${round}: o acerto passa e zera`);
  }
});
