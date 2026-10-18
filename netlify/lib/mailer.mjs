/*
 * E-mails do site, via API HTTP do Resend (sem dependência): aviso de novo cadastro ao admin e, para a própria pessoa,
 * o resultado da decisão (aprovado/recusado) e o link de redefinição de senha.
 *
 * Decisões:
 * - O e-mail do admin vem só de variável de ambiente (ADMIN_EMAIL) e nunca aparece em resposta, log ou código.
 * - Os links do e-mail de aprovação abrem uma página de confirmação (a decisão é um POST); GET que muda estado
 *   seria disparado por scanners de e-mail.
 * - Nome e e-mail do solicitante são texto livre: escapados no HTML e sem quebra de linha no assunto.
 * - O pedido de título (texto livre de qualquer usuário aprovado) segue a mesma regra: nome, e-mail, título e observação
 *   escapados no HTML e assunto sem quebra de linha. É aviso de melhor esforço: quem chama não desfaz o pedido se falhar.
 * - Modo "dry run" imprime os links no console, mas só com MAIL_DRY_RUN=1 *e* NETLIFY_DEV=true (netlify dev);
 *   em produção o link é credencial e nunca vai para log. Vale também para o link de redefinição de senha.
 * - Os e-mails para a pessoa (aviso de decisão e redefinição) só chegam se o remetente puder escrever para qualquer
 *   endereço: com o remetente de teste do Resend (onboarding@resend.dev) a entrega é só para o e-mail da conta Resend.
 *   Em produção isso exige domínio verificado no Resend (ver .env.example). Quem chama decide o que fazer com a falha
 *   (decisão: segue sem o aviso; redefinição: a pessoa pode pedir de novo).
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

const REQUEST_KIND = { any: 'filme ou série', movie: 'filme', tv: 'série' };

export function createMailer(env, fetchImpl = fetch) {
  const dryRun = env.MAIL_DRY_RUN === '1' && env.NETLIFY_DEV === 'true';

  async function deliver({ to, subject, html, text }) {
    const { RESEND_API_KEY: apiKey, MAIL_FROM: from } = env;
    if (!apiKey || !from || !to) throw new Error('mail_not_configured');
    const res = await fetchImpl(RESEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, html, text }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`mail_failed:${res.status}`);
  }

  return {
    async sendApprovalRequest({ name, email, approveUrl, rejectUrl }) {
      if (dryRun) {
        console.log(`[dry-run] cadastro pendente: ${name} <${email}>\n  aprovar: ${approveUrl}\n  recusar: ${rejectUrl}`);
        return;
      }

      const html = `
        <p>Nova solicitação de cadastro no Cine Local:</p>
        <p><strong>${escapeHtml(name)}</strong><br>${escapeHtml(email)}</p>
        <p><a href="${escapeHtml(approveUrl)}">Revisar e aprovar</a> &nbsp;|&nbsp; <a href="${escapeHtml(rejectUrl)}">Revisar e recusar</a></p>
        <p>Os links abrem uma página de confirmação e valem por 7 dias.</p>`;
      const text = `Nova solicitação de cadastro: ${name} <${email}>\nAprovar: ${approveUrl}\nRecusar: ${rejectUrl}\nOs links valem por 7 dias.`;
      await deliver({ to: env.ADMIN_EMAIL, subject: `Cadastro pendente: ${oneLine(name)}`, html, text });
    },

    // Pedido de um título que o catálogo não tem (ver "Decisões dos pedidos" em handler.mjs). Vai para o admin.
    async sendTitleRequest({ name, email, title, type, year, note }) {
      const kind = REQUEST_KIND[type] ?? REQUEST_KIND.any;
      const details = [`${kind}`, year ? `ano ${year}` : null].filter(Boolean).join(', ');
      if (dryRun) {
        console.log(`[dry-run] pedido de título de ${name} <${email}>: ${title} (${details})${note ? ` - ${note}` : ''}`);
        return;
      }

      const html = `
        <p>Novo pedido de título no Cine Local:</p>
        <p><strong>${escapeHtml(title)}</strong> (${escapeHtml(details)})</p>
        ${note ? `<p>Observação: ${escapeHtml(note)}</p>` : ''}
        <p>Pedido por ${escapeHtml(name)} (${escapeHtml(email)}).</p>`;
      const text = `Novo pedido de título: ${title} (${details})\n${note ? `Observação: ${note}\n` : ''}Pedido por ${name} <${email}>`;
      await deliver({ to: env.ADMIN_EMAIL, subject: `Pedido de título: ${oneLine(title)}`, html, text });
    },

    // Resultado da decisão do admin, para quem pediu o cadastro.
    async sendDecisionNotice({ name, email, approved, loginUrl }) {
      if (dryRun) {
        console.log(`[dry-run] aviso de ${approved ? 'aprovação' : 'recusa'} para ${name} <${email}>`);
        return;
      }

      const html = approved
        ? `<p>Olá, ${escapeHtml(name)}!</p>
           <p>Seu cadastro no Cine Local foi <strong>aprovado</strong>. Já dá para entrar:</p>
           <p><a href="${escapeHtml(loginUrl)}">Entrar no Cine Local</a></p>`
        : `<p>Olá, ${escapeHtml(name)}.</p>
           <p>Seu pedido de cadastro no Cine Local não foi aprovado desta vez.</p>`;
      const text = approved
        ? `Olá, ${name}! Seu cadastro no Cine Local foi aprovado. Entre em: ${loginUrl}`
        : `Olá, ${name}. Seu pedido de cadastro no Cine Local não foi aprovado desta vez.`;
      await deliver({ to: email, subject: approved ? 'Seu cadastro foi aprovado' : 'Sobre o seu pedido de cadastro', html, text });
    },

    // Link de redefinição de senha (vale por pouco tempo e só uma vez: ver handler.mjs).
    async sendPasswordReset({ name, email, resetUrl }) {
      if (dryRun) {
        console.log(`[dry-run] redefinir senha de ${name} <${email}>\n  link: ${resetUrl}`);
        return;
      }

      const html = `
        <p>Olá, ${escapeHtml(name)}!</p>
        <p>Recebemos um pedido para redefinir a senha da sua conta no Cine Local.</p>
        <p><a href="${escapeHtml(resetUrl)}">Escolher uma nova senha</a></p>
        <p>O link vale por 1 hora e só pode ser usado uma vez. Se não foi você, ignore este e-mail: a sua senha continua a mesma.</p>`;
      const text = `Olá, ${name}! Para escolher uma nova senha no Cine Local, abra: ${resetUrl}\nO link vale por 1 hora e só pode ser usado uma vez. Se não foi você, ignore este e-mail.`;
      await deliver({ to: email, subject: 'Redefinir a senha do Cine Local', html, text });
    },
  };
}
