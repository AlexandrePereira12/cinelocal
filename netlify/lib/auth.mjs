/*
 * Senhas (scrypt) e tokens assinados (HS256), só com node:crypto.
 *
 * Decisões:
 * - O header do token é fixo e comparado byte a byte: não existe negociação de `alg`
 *   (bloqueia `alg: none` e troca de algoritmo).
 * - `typ` separa token de acesso de token de decisão (link do e-mail do admin): um não serve no lugar do outro.
 * - Tamanho da assinatura é conferido antes do `timingSafeEqual`, que lança erro com tamanhos diferentes;
 *   sem isso, token adulterado viraria 500 em vez de 401.
 * - Se o usuário não existe, o login ainda gasta um scrypt (hash dummy) para não revelar a existência pelo tempo.
 */

import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const MIN_SECRET_LENGTH = 32;
const HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');

function scryptAsync(password, salt, { N, r, p, keylen }) {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, { N, r, p }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT);
  const { N, r, p } = SCRYPT;
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password, stored) {
  const parts = typeof stored === 'string' ? stored.split('$') : [];
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64url');
  const params = { N: Number(N), r: Number(r), p: Number(p), keylen: expected.length };
  if (!params.N || !params.r || !params.p || !params.keylen) return false;
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64url'), params);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

let dummyHash;

// Gasta o mesmo custo de uma verificação real quando o usuário não existe.
export async function burnPasswordCheck(password) {
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
  await verifyPassword(password, await dummyHash);
}

export function readSecret(env) {
  const secret = env.AUTH_SECRET;
  return typeof secret === 'string' && secret.length >= MIN_SECRET_LENGTH ? secret : null;
}

function sign(data, secret) {
  return createHmac('sha256', secret).update(data).digest();
}

export function signToken(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = sign(`${HEADER}.${body}`, secret).toString('base64url');
  return `${HEADER}.${body}.${signature}`;
}

export function verifyToken(token, secret, expectedTyp, nowSeconds) {
  if (typeof token !== 'string' || token.length > 2048) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== HEADER) return null;

  const expected = sign(`${parts[0]}.${parts[1]}`, secret);
  const given = Buffer.from(parts[2], 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || payload.typ !== expectedTyp) return null;
  if (!Number.isInteger(payload.exp) || payload.exp <= nowSeconds) return null;
  return payload;
}

export function sha256Hex(text) {
  return createHash('sha256').update(text).digest('hex');
}
