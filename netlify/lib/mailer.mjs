/*
 * Aviso de novo cadastro ao admin, via API HTTP do Resend (sem dependência).
 *
 * Decisões:
 * - O e-mail do admin vem só de variável de ambiente (ADMIN_EMAIL) e nunca aparece em resposta, log ou código.
 * - Os links do e-mail abrem uma página de confirmação (a decisão é um POST); GET que muda estado
 *   seria disparado por scanners de e-mail.
 * - Nome e e-mail do solicitante são texto livre: escapados no HTML e sem quebra de linha no assunto.
 * - Modo "dry run" imprime os links no console, mas só com MAIL_DRY_RUN=1 *e* NETLIFY_DEV=true (netlify dev);
 *   em produção o link é credencial e nunca vai para log.
 */

const RESEND_URL = 'https://api.resend.com/emails';
const SEND_TIMEOUT_MS = 8000;

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const LINE_BREAKS = new RegExp('[\\r\\n\\u2028\\u2029]+', 'g');

function oneLine(text) {
  return String(text).replace(LINE_BREAKS, ' ').slice(0, 80);
}

export function createMailer(env, fetchImpl = fetch) {
  return {
    async sendApprovalRequest({ name, email, approveUrl, rejectUrl }) {
      if (env.MAIL_DRY_RUN === '1' && env.NETLIFY_DEV === 'true') {
        console.log(`[dry-run] cadastro pendente: ${name} <${email}>\n  aprovar: ${approveUrl}\n  recusar: ${rejectUrl}`);
        return;
      }

      const { RESEND_API_KEY: apiKey, MAIL_FROM: from, ADMIN_EMAIL: to } = env;
      if (!apiKey || !from || !to) throw new Error('mail_not_configured');

      const html = `
        <p>Nova solicitação de cadastro no Cine Local:</p>
        <p><strong>${escapeHtml(name)}</strong><br>${escapeHtml(email)}</p>
        <p><a href="${escapeHtml(approveUrl)}">Revisar e aprovar</a> &nbsp;|&nbsp; <a href="${escapeHtml(rejectUrl)}">Revisar e recusar</a></p>
        <p>Os links abrem uma página de confirmação e valem por 7 dias.</p>`;
      const text = `Nova solicitação de cadastro: ${name} <${email}>\nAprovar: ${approveUrl}\nRecusar: ${rejectUrl}\nOs links valem por 7 dias.`;

      const res = await fetchImpl(RESEND_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject: `Cadastro pendente: ${oneLine(name)}`, html, text }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`mail_failed:${res.status}`);
    },
  };
}
