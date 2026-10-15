import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMailer } from '../netlify/lib/mailer.mjs';

const env = { RESEND_API_KEY: 're_chave', MAIL_FROM: 'Cine <no-reply@exemplo.invalid>', ADMIN_EMAIL: 'admin@exemplo.invalid' };
const mail = { name: 'Ana <script>alert(1)</script>\nBcc: x@y.z', email: 'ana@exemplo.com', approveUrl: 'https://s.invalid/#/decisao/a', rejectUrl: 'https://s.invalid/#/decisao/r' };

function capture(status = 200) {
  const sent = [];
  const fetchImpl = async (url, init) => (sent.push({ url, init, body: JSON.parse(init.body) }), { ok: status < 400, status });
  return { sent, fetchImpl };
}

test('envia ao admin com HTML escapado e assunto em uma linha', async () => {
  const { sent, fetchImpl } = capture();
  await createMailer(env, fetchImpl).sendApprovalRequest(mail);

  const [{ url, init, body }] = sent;
  assert.equal(url, 'https://api.resend.com/emails');
  assert.equal(init.headers.Authorization, 'Bearer re_chave');
  assert.deepEqual(body.to, ['admin@exemplo.invalid']);
  assert.ok(!/[\r\n]/.test(body.subject), 'assunto sem quebra de linha');
  assert.ok(!body.html.includes('<script>'), 'nome escapado no HTML');
  assert.ok(body.html.includes('&lt;script&gt;'));
  assert.ok(body.html.includes(mail.approveUrl) && body.html.includes(mail.rejectUrl));
});

test('falha de envio e configuração ausente viram erro (o cadastro é desfeito pelo handler)', async () => {
  await assert.rejects(createMailer(env, capture(403).fetchImpl).sendApprovalRequest(mail), /mail_failed:403/);
  await assert.rejects(createMailer({ ...env, RESEND_API_KEY: '' }, capture().fetchImpl).sendApprovalRequest(mail), /mail_not_configured/);
  await assert.rejects(createMailer({}, capture().fetchImpl).sendApprovalRequest(mail), /mail_not_configured/);
});

test('aviso de decisão vai para a própria pessoa, com o nome escapado e o link de entrada só na aprovação', async () => {
  const { sent, fetchImpl } = capture();
  const mailer = createMailer(env, fetchImpl);
  await mailer.sendDecisionNotice({ name: 'Ana <b>x</b>', email: 'ana@exemplo.com', approved: true, loginUrl: 'https://s.invalid/#/login' });
  await mailer.sendDecisionNotice({ name: 'Beto', email: 'beto@exemplo.com', approved: false, loginUrl: 'https://s.invalid/#/login' });

  const [yes, no] = sent.map((item) => item.body);
  assert.deepEqual(yes.to, ['ana@exemplo.com']);
  assert.ok(!yes.to.includes('admin@exemplo.invalid'), 'o aviso não vai para o admin');
  assert.ok(yes.html.includes('https://s.invalid/#/login') && yes.html.includes('aprovado'));
  assert.ok(!yes.html.includes('<b>x</b>') && yes.html.includes('&lt;b&gt;'), 'nome escapado');
  assert.deepEqual(no.to, ['beto@exemplo.com']);
  assert.ok(!no.html.includes('https://s.invalid') && no.html.includes('não foi aprovado'), 'recusa não tem link');
  for (const body of [yes, no]) assert.ok(!/[\r\n]/.test(body.subject));
});

test('e-mail de redefinição leva o link, vale 1 hora e escapa o nome', async () => {
  const { sent, fetchImpl } = capture();
  await createMailer(env, fetchImpl).sendPasswordReset({ name: 'Ana\nBcc: x@y.z <i>', email: 'ana@exemplo.com', resetUrl: 'https://s.invalid/#/redefinir/abc.def.ghi' });
  const [{ body }] = sent;
  assert.deepEqual(body.to, ['ana@exemplo.com']);
  assert.ok(body.html.includes('https://s.invalid/#/redefinir/abc.def.ghi') && body.text.includes('https://s.invalid/#/redefinir/abc.def.ghi'));
  assert.ok(body.html.includes('1 hora') && !body.html.includes('<i>'));
  assert.ok(!/[\r\n]/.test(body.subject));
});

test('e-mails à pessoa: falha de envio e configuração ausente viram erro; sem destinatário também', async () => {
  const note = { name: 'Ana', email: 'ana@exemplo.com', approved: true, loginUrl: 'https://s.invalid/#/login' };
  const reset = { name: 'Ana', email: 'ana@exemplo.com', resetUrl: 'https://s.invalid/#/redefinir/x' };
  await assert.rejects(createMailer(env, capture(500).fetchImpl).sendDecisionNotice(note), /mail_failed:500/);
  await assert.rejects(createMailer(env, capture(429).fetchImpl).sendPasswordReset(reset), /mail_failed:429/);
  await assert.rejects(createMailer({ ...env, MAIL_FROM: '' }, capture().fetchImpl).sendPasswordReset(reset), /mail_not_configured/);
  await assert.rejects(createMailer(env, capture().fetchImpl).sendPasswordReset({ ...reset, email: '' }), /mail_not_configured/);
  // o ADMIN_EMAIL não é necessário para escrever à pessoa
  const { sent, fetchImpl } = capture();
  await createMailer({ RESEND_API_KEY: 're_chave', MAIL_FROM: env.MAIL_FROM }, fetchImpl).sendPasswordReset(reset);
  assert.equal(sent.length, 1);
});

test('dry run também cobre os e-mails à pessoa e só vale no netlify dev', async () => {
  const logs = [];
  const original = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    const dev = capture();
    const mailer = createMailer({ MAIL_DRY_RUN: '1', NETLIFY_DEV: 'true' }, dev.fetchImpl);
    await mailer.sendPasswordReset({ name: 'Ana', email: 'ana@exemplo.com', resetUrl: 'https://s.invalid/#/redefinir/segredo' });
    await mailer.sendDecisionNotice({ name: 'Ana', email: 'ana@exemplo.com', approved: true, loginUrl: 'https://s.invalid/#/login' });
    assert.equal(dev.sent.length, 0);
    assert.ok(logs.join('\n').includes('https://s.invalid/#/redefinir/segredo'), 'no netlify dev o link sai no console');

    logs.length = 0;
    const prod = capture();
    await createMailer({ ...env, MAIL_DRY_RUN: '1' }, prod.fetchImpl).sendPasswordReset({ name: 'Ana', email: 'ana@exemplo.com', resetUrl: 'https://s.invalid/#/redefinir/segredo' });
    assert.equal(prod.sent.length, 1);
    assert.deepEqual(logs, [], 'link de redefinição não vai para o log em produção');
  } finally {
    console.log = original;
  }
});

test('dry run só vale no netlify dev e nunca em produção', async () => {
  const logs = [];
  const original = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    const dev = capture();
    await createMailer({ MAIL_DRY_RUN: '1', NETLIFY_DEV: 'true' }, dev.fetchImpl).sendApprovalRequest(mail);
    assert.equal(dev.sent.length, 0);
    assert.ok(logs.join('\n').includes(mail.approveUrl));

    logs.length = 0;
    const prod = capture();
    await createMailer({ ...env, MAIL_DRY_RUN: '1' }, prod.fetchImpl).sendApprovalRequest(mail);
    assert.equal(prod.sent.length, 1, 'MAIL_DRY_RUN sozinho não desliga o envio real');
    assert.deepEqual(logs, [], 'link de aprovação não vai para o log em produção');

    await assert.rejects(createMailer({ MAIL_DRY_RUN: '1' }, capture().fetchImpl).sendApprovalRequest(mail), /mail_not_configured/);
  } finally {
    console.log = original;
  }
});
