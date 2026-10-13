import { HttpError } from './errors.mjs';

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]', 'g');

// Regra pedida para o cadastro: mínimo curto, mas com maiúscula, minúscula, número e um destes símbolos: @ _ .
// Só vale ao criar conta; o login não aplica a regra para não trancar quem já tem senha antiga.
// A tela de cadastro (public/app.js, PASSWORD_RULES) espelha estas regras para avisar antes do envio.
export const PASSWORD_MIN = 4;
export const PASSWORD_MAX = 128;

export function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && EMAIL_RE.test(email) ? email : null;
}

export function cleanName(value) {
  if (typeof value !== 'string') return null;
  const name = value.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  return name.length >= 2 && name.length <= 60 ? name : null;
}

export function cleanTitle(value) {
  if (typeof value !== 'string') return null;
  const title = value.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  return title.length >= 1 && title.length <= 150 ? title : null;
}

export function validPassword(value) {
  return (
    typeof value === 'string' &&
    value.length >= PASSWORD_MIN &&
    value.length <= PASSWORD_MAX &&
    /\p{Lu}/u.test(value) &&
    /\p{Ll}/u.test(value) &&
    /[0-9]/.test(value) &&
    /[@_.]/.test(value)
  );
}

// Domínio de um e-mail já normalizado (a parte depois do último @).
export function emailDomain(email) {
  return email.slice(email.lastIndexOf('@') + 1);
}

export function validType(value) {
  return value === 'movie' || value === 'tv' ? value : null;
}

export function validId(value) {
  return typeof value === 'string' && /^\d{1,9}$/.test(value) ? value : null;
}

export function validYear(value) {
  return typeof value === 'string' && /^\d{4}$/.test(value) ? value : null;
}

export function validPoster(value) {
  return typeof value === 'string' && /^\/[\w-]{1,60}\.(?:jpg|png|webp)$/.test(value) ? value : null;
}

export function intInRange(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max ? value : null;
}

export function badRequest(message = 'Requisição inválida') {
  return new HttpError(400, message, 'bad_request');
}
