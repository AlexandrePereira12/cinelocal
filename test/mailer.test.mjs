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
