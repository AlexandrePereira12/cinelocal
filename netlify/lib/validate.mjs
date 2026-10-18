import { HttpError } from './errors.mjs';

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]', 'g');
// Caracteres invisíveis de direção/largura zero (ex.: U+202E inverte o texto). Só nos pedidos de título: o texto vai
// parar na caixa do admin, onde um título "invertido" poderia disfarçar o que foi pedido.
const INVISIBLE_CHARS = new RegExp('[\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u2069\\ufeff]', 'g');
const cleanFreeText = (value) => value.replace(CONTROL_CHARS, ' ').replace(INVISIBLE_CHARS, ' ').replace(/\s+/g, ' ').trim();

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

// Pedido de título: texto livre que vai parar na caixa do admin, então o limite é pequeno e controle vira espaço.
export function cleanRequestTitle(value) {
  if (typeof value !== 'string') return null;
  const title = cleanFreeText(value);
  return title.length >= 2 && title.length <= 100 ? title : null;
}

// Observação do pedido (opcional). Ausente ou vazia vira null; texto inválido (não é string ou passa de 200) devolve false,
// para o chamador distinguir "não mandou" de "mandou errado".
export function cleanNote(value) {
  if (value == null) return null;
  if (typeof value !== 'string') return false;
  const note = cleanFreeText(value);
  if (note.length > 200) return false;
  return note || null;
}

export const REQUEST_TYPES = ['any', 'movie', 'tv'];

// Tipo do pedido: ausente = 'any'; valor fora da lista = null (inválido).
export function requestType(value) {
  if (value == null) return 'any';
  return REQUEST_TYPES.includes(value) ? value : null;
}

// Classificações indicativas aceitas no limite do modo família (0 = livre). 18 não é opção: "até 18" é o mesmo que desligar.
export const RATING_OPTIONS = [0, 10, 12, 14, 16];

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

// Parâmetros de query chegam como texto: só aceita inteiro decimal puro (nada de "1e3", "0x10" ou " 7").
export function intParam(value, min, max) {
  return typeof value === 'string' && /^\d{1,6}$/.test(value) ? intInRange(Number(value), min, max) : null;
}

// Nota mínima do explorar: de 1 a 10, com no máximo uma casa decimal.
export function ratingParam(value) {
  if (typeof value !== 'string' || !/^\d{1,2}(\.\d)?$/.test(value)) return null;
  const rating = Number(value);
  return rating >= 1 && rating <= 10 ? rating : null;
}

export function badRequest(message = 'Requisição inválida') {
  return new HttpError(400, message, 'bad_request');
}
