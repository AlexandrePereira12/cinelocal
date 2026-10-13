/*
 * Pareamento com a TV: a TV abre /tv.html e mostra um código; no celular a pessoa digita o código e envia o filme.
 * A TV descobre o que tocar perguntando ao servidor (não há conexão aberta: a função serverless não segura uma).
 *
 * Decisões:
 * - A TV não tem login, então o que a protege é um segredo que só ela conhece (devolvido no `pair`). O código
 *   curto (6 caracteres sem I, L, O, 0, 1) serve só para o celular achar a TV; quem tem o código não lê o que a
 *   TV recebe. Só o hash do segredo é guardado e a comparação é em tempo constante.
 * - Código inexistente, expirado ou segredo errado respondem exatamente igual (410 `tv_gone`): não dá para
 *   descobrir quais códigos existem.
 * - `poll` só LÊ (nenhuma escrita, nenhum limite por requisição): é a rota mais chamada e cada escrita no Blob
 *   custaria o dobro. Quem controla o custo é a própria TV (intervalo, pausa e teto de tempo no tv.js).
 * - O código vale 6 horas, contadas da criação, e depois sai do ar (a TV pede outro).
 * - Só quem está logado e aprovado envia. Quem erra o código demais é bloqueado por um tempo: sem isso daria para
 *   varrer os ~887 milhões de códigos possíveis com uma conta qualquer.
 * - O envio guarda o link do player já montado pelo servidor; a TV valida o endereço de novo antes de abri-lo.
 * - `seq` sobe a cada comando (escrita condicional por etag): a TV só reage quando o número muda.
 */

import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { sha256Hex } from './auth.mjs';
import { HttpError } from './errors.mjs';
import { increment, isBlocked } from './limits.mjs';

const HOUR_MS = 60 * 60 * 1000;
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_RE = /^[A-HJ-KM-NP-Z2-9]{6}$/;
const SECRET_RE = /^[A-Za-z0-9_-]{20,64}$/;
const CODE_TTL_MS = 6 * HOUR_MS;
const PAIR_PER_IP = { limit: 20, windowMs: HOUR_MS };
const SEND_FAILS_PER_USER = { limit: 10, windowMs: 15 * 60 * 1000 };
const WRITE_ATTEMPTS = 3;

// 410 e não 404: o `netlify dev` reenvia 404 de função para outros caminhos e o handler responderia "Rota inexistente".
const gone = () => new HttpError(410, 'Código inválido ou expirado', 'tv_gone');
const tooMany = () => new HttpError(429, 'Muitas tentativas. Tente novamente em alguns minutos.', 'rate_limited');

export const normalizeCode = (value) => (typeof value === 'string' ? value.trim().toUpperCase() : '');

export function createTv({ stores, now }) {
  const keyOf = (code) => `code:${code}`;
  const isLive = (record) => record.expiresAt > now();

  function secretMatches(record, secret) {
    const given = Buffer.from(sha256Hex(secret), 'hex');
    const stored = Buffer.from(record.secretHash, 'hex');
    return given.length === stored.length && timingSafeEqual(given, stored);
  }

  async function pair(ip) {
    const count = await increment(stores.limits, `tvpair:${sha256Hex(ip)}`, PAIR_PER_IP.windowMs, now());
    if (count > PAIR_PER_IP.limit) throw tooMany();

    const secret = randomBytes(24).toString('base64url');
    const record = { secretHash: sha256Hex(secret), createdAt: new Date(now()).toISOString(), expiresAt: now() + CODE_TTL_MS, seq: 0, play: null };
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
      if (await stores.tv.create(keyOf(code), record)) return { code, secret, expiresInSec: CODE_TTL_MS / 1000 };
    }
    throw new HttpError(503, 'Não foi possível gerar um código agora. Tente de novo.', 'tv_busy');
  }

  async function poll({ code, secret }) {
    if (!CODE_RE.test(code) || !SECRET_RE.test(secret)) throw gone();
    const entry = await stores.tv.get(keyOf(code));
    if (!entry || !secretMatches(entry.value, secret)) throw gone();
    if (!isLive(entry.value)) {
      await stores.tv.del(keyOf(code)); // só quem tem o segredo faz a limpeza
      throw gone();
    }
    const { seq, play } = entry.value;
    return { status: play ? 'playing' : 'waiting', seq, play };
  }

  async function change(uid, code, apply) {
    const failKey = `tvsend:${uid}`;
    if (await isBlocked(stores.limits, failKey, SEND_FAILS_PER_USER.limit, now())) throw tooMany();
    const fail = async () => {
      await increment(stores.limits, failKey, SEND_FAILS_PER_USER.windowMs, now());
      throw gone();
    };
    if (!CODE_RE.test(code)) return fail();

    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
      const entry = await stores.tv.get(keyOf(code));
      if (!entry || !isLive(entry.value)) return fail();
      const next = { ...entry.value, ...apply(entry.value), seq: entry.value.seq + 1 };
      if (await stores.tv.put(keyOf(code), next, entry.etag)) return { seq: next.seq };
    }
    throw new HttpError(409, 'A TV estava ocupada. Tente de novo.', 'tv_conflict');
  }

  return {
    pair,
    poll,
    send: (uid, { code, play }) => change(uid, code, () => ({ play })),
    stop: (uid, { code }) => change(uid, code, () => ({ play: null })),
  };
}
