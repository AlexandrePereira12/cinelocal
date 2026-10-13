/*
 * Confere se o domínio do e-mail existe e recebe mensagens (MX, ou A/AAAA como o SMTP aceita na falta de MX).
 * Não prova que a caixa existe: isso só um link de confirmação provaria.
 *
 * Decisões:
 * - Só "o DNS respondeu que não há registro" (ENOTFOUND/ENODATA) reprova o domínio. Falha do próprio DNS
 *   (timeout, SERVFAIL, rede) aprova: não vale barrar quem digitou certo por um problema nosso, e o admin
 *   ainda aprova cada cadastro à mão.
 * - MX nulo (RFC 7505, `0 .`, que o Node devolve como exchange vazio) declara que o domínio não recebe e-mail.
 */

import { Resolver } from 'node:dns/promises';

const NO_RECORDS = new Set(['ENOTFOUND', 'ENODATA']);

export function createDomainChecker({ resolver = new Resolver({ timeout: 3000, tries: 2 }) } = {}) {
  async function records(kind, domain) {
    try {
      return await resolver[kind](domain);
    } catch (err) {
      if (NO_RECORDS.has(err?.code)) return [];
      throw err;
    }
  }

  return async function acceptsMail(domain) {
    try {
      const mx = await records('resolveMx', domain);
      if (mx.length > 0) return mx.some((entry) => entry.exchange !== '' && entry.exchange !== '.');
      if ((await records('resolve4', domain)).length > 0) return true;
      return (await records('resolve6', domain)).length > 0;
    } catch (err) {
      console.error('dns_error', err?.code);
      return true;
    }
  };
}
