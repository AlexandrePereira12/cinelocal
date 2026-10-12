/*
 * Todas as rotas `/api/*`. As dependências (stores, catálogo, mailer, env, relógio) são injetadas para
 * permitir testes sem Netlify.
 *
 * Decisões de segurança:
 * - Só `register`, `login` e a decisão do admin são públicas. Todo o resto exige `Authorization: Bearer`
 *   e relê o usuário a cada chamada, exigindo status `approved`: recusar/revogar vale na hora.
 * - Sem enumeração de contas: login com erro devolve sempre a mesma mensagem (com custo de scrypt igual);
 *   "aguardando aprovação"/"recusado" só aparece depois de senha correta; cadastro de e-mail já existente
 *   responde igual ao sucesso e não dispara novo e-mail.
 * - O cadastro só fica pendente se o aviso ao admin for enviado; se o envio falhar o registro é desfeito e
 *   a pessoa recebe erro (nada fica pendente em silêncio).
 * - Limites: cadastro por IP, falhas de login por e-mail e por IP, decisão por IP e teto diário de avisos ao admin
 *   (evita transformar o cadastro público em spam na caixa do admin).
 * - O link do e-mail usa SITE_URL (nunca o header Host, que permitiria injetar link de phishing) e abre uma
 *   página de confirmação; a decisão é um POST com token assinado (uso único: só vale com status `pending`).
 * - POST só com application/json e corpo pequeno; sem CORS (mesma origem); respostas `no-store`.
 * - Histórico guarda temporada/episódio (a posição em minutos não existe: o player é um iframe de outra origem).
 *   O embed em si é público no provedor: o bloqueio é do app, não do provedor.
 */

import { burnPasswordCheck, hashPassword, readSecret, sha256Hex, signToken, verifyPassword, verifyToken } from './auth.mjs';
import { EMBED_BASE } from './catalog.mjs';
import { HttpError } from './errors.mjs';
import { clear, increment, isBlocked } from './limits.mjs';
import * as v from './validate.mjs';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const ACCESS_TTL_S = 7 * 24 * 60 * 60;
const DECISION_TTL_S = 7 * 24 * 60 * 60;
const MAX_BODY_BYTES = 4096;
const LIBRARY_CAP = 300;
const CONTINUE_LIMIT = 30;
const WATCHED_LIMIT = 60;

const REGISTER_PER_IP = { limit: 5, windowMs: HOUR_MS };
const LOGIN_FAILS_PER_EMAIL = { limit: 5, windowMs: 15 * 60 * 1000 };
const LOGIN_FAILS_PER_IP = { limit: 20, windowMs: 15 * 60 * 1000 };
const DECISION_PER_IP = { limit: 30, windowMs: HOUR_MS };
const DAILY_ADMIN_NOTICES = 30;

const USER_ID_RE = /^u_[0-9a-f]{40}$/;
const ACCEPTED_MESSAGE = 'Solicitação recebida. Você poderá entrar assim que o cadastro for aprovado.';

const HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: HEADERS });
}

const unauthorized = () => new HttpError(401, 'Sessão inválida ou expirada', 'unauthorized');
const tooMany = () => new HttpError(429, 'Muitas tentativas. Tente novamente em alguns minutos.', 'rate_limited');

export function createHandler({ stores, catalog, mailer, env, now = Date.now }) {
  const nowSeconds = () => Math.floor(now() / 1000);
  const nowIso = () => new Date(now()).toISOString();
  const userId = (email) => `u_${sha256Hex(email).slice(0, 40)}`;

  function secret() {
    const value = readSecret(env);
    if (!value) throw new HttpError(500, 'Serviço indisponível', 'misconfigured');
    return value;
  }

  function siteOrigin() {
    let url;
    try {
      url = new URL(env.SITE_URL);
    } catch {
      throw new HttpError(500, 'Serviço indisponível', 'misconfigured');
    }
    const local = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
    if (url.protocol !== 'https:' && !local) throw new HttpError(500, 'Serviço indisponível', 'misconfigured');
    return url.origin;
  }

  async function readJson(req) {
    if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
      throw new HttpError(415, 'Content-Type deve ser application/json', 'unsupported_media_type');
    }
    if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) {
      throw new HttpError(413, 'Corpo grande demais', 'too_large');
    }
    const text = await req.text();
    if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw new HttpError(413, 'Corpo grande demais', 'too_large');
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw v.badRequest();
    }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) throw v.badRequest();
    return data;
  }

  async function authenticate(req) {
    const key = secret();
    const match = (req.headers.get('authorization') ?? '').match(/^Bearer ([A-Za-z0-9._-]+)$/);
    const payload = match && verifyToken(match[1], key, 'access', nowSeconds());
    if (!payload || typeof payload.sub !== 'string' || !USER_ID_RE.test(payload.sub)) throw unauthorized();
    const entry = await stores.users.get(payload.sub);
    if (!entry || entry.value.status !== 'approved') throw unauthorized();
    return { id: payload.sub, user: entry.value };
  }

  async function guard(prefix, ip, { limit, windowMs }) {
    if ((await increment(stores.limits, `${prefix}:${sha256Hex(ip)}`, windowMs, now())) > limit) throw tooMany();
  }

  async function claimDailyNotice() {
    const day = nowIso().slice(0, 10);
    if ((await increment(stores.limits, `notices:${day}`, DAY_MS, now())) > DAILY_ADMIN_NOTICES) {
      throw new HttpError(503, 'Muitas solicitações hoje. Tente novamente amanhã.', 'daily_cap');
    }
  }

  async function sendNotice(user, key, origin) {
    const iat = nowSeconds();
    const link = (act) => `${origin}/#/decisao/${signToken({ typ: 'decision', sub: user.id, act, iat, exp: iat + DECISION_TTL_S }, key)}`;
    try {
      await mailer.sendApprovalRequest({ name: user.name, email: user.email, approveUrl: link('approve'), rejectUrl: link('reject') });
    } catch (err) {
      console.error('mail_error', err?.message);
      throw new HttpError(503, 'Não foi possível enviar sua solicitação agora. Tente novamente mais tarde.', 'mail_failed');
    }
  }

  // --- públicas ---

  async function register(req, ip) {
    const key = secret();
    const origin = siteOrigin();
    const body = await readJson(req);
    const name = v.cleanName(body.name);
    const email = v.normalizeEmail(body.email);
    if (!name || !email || !v.validPassword(body.password)) {
      throw v.badRequest(`Informe nome, e-mail válido e senha de ${v.PASSWORD_MIN} a ${v.PASSWORD_MAX} caracteres`);
    }
    await guard('reg', ip, REGISTER_PER_IP);

    const passHash = await hashPassword(body.password); // sempre, para o tempo não revelar e-mail já cadastrado
    const id = userId(email);
    const existing = await stores.users.get(id);

    if (existing) {
      // Pendente com aviso vencido (link de 7 dias expirou ou o e-mail se perdeu): reenvia ao admin com tokens novos.
      // Usa os dados já guardados (quem repete o cadastro não altera nome/senha). Falha de envio não apaga o usuário.
      const user = existing.value;
      const lastNotice = Date.parse(user.notifiedAt ?? user.createdAt);
      if (user.status === 'pending' && now() - lastNotice > DECISION_TTL_S * 1000) {
        await claimDailyNotice();
        await sendNotice(user, key, origin);
        await stores.users.put(id, { ...user, notifiedAt: nowIso() }, existing.etag);
      }
      return json(202, { message: ACCEPTED_MESSAGE });
    }

    await claimDailyNotice();
    const user = { id, name, email, passHash, status: 'pending', createdAt: nowIso(), notifiedAt: nowIso() };
    if (!(await stores.users.create(id, user))) return json(202, { message: ACCEPTED_MESSAGE });
    try {
      await sendNotice(user, key, origin);
    } catch (err) {
      await stores.users.del(id);
      throw err;
    }
    return json(202, { message: ACCEPTED_MESSAGE });
  }

  async function login(req, ip) {
    const key = secret();
    const body = await readJson(req);
    if (typeof body.password !== 'string' || body.password.length > v.PASSWORD_MAX) throw v.badRequest();
    const email = v.normalizeEmail(body.email);

    const ipKey = `login-ip:${sha256Hex(ip)}`;
    const emailKey = email && `login-email:${sha256Hex(email)}`;
    if (
      (await isBlocked(stores.limits, ipKey, LOGIN_FAILS_PER_IP.limit, now())) ||
      (emailKey && (await isBlocked(stores.limits, emailKey, LOGIN_FAILS_PER_EMAIL.limit, now())))
    ) {
      throw tooMany();
    }

    const entry = email ? await stores.users.get(userId(email)) : null;
    const valid = entry ? await verifyPassword(body.password, entry.value.passHash) : (await burnPasswordCheck(body.password), false);
    if (!valid) {
      await increment(stores.limits, ipKey, LOGIN_FAILS_PER_IP.windowMs, now());
      if (emailKey) await increment(stores.limits, emailKey, LOGIN_FAILS_PER_EMAIL.windowMs, now());
      throw new HttpError(401, 'E-mail ou senha inválidos', 'invalid_credentials');
    }
    if (emailKey) await clear(stores.limits, emailKey);

    // 401 (e não 403) de propósito: o `netlify dev` reenvia respostas 403/404 de function para caminhos
    // alternativos (…/index.html) e o handler passaria a ver outra rota. O `code` distingue o motivo.
    const user = entry.value;
    if (user.status === 'pending') throw new HttpError(401, 'Seu cadastro está aguardando aprovação.', 'pending');
    if (user.status !== 'approved') throw new HttpError(401, 'Seu cadastro não foi aprovado.', 'rejected');

    const iat = nowSeconds();
    const token = signToken({ typ: 'access', sub: user.id, iat, exp: iat + ACCESS_TTL_S }, key);
    return json(200, { token, user: { name: user.name } });
  }

  function decisionPayload(body) {
    const payload = verifyToken(body.token, secret(), 'decision', nowSeconds());
    if (!payload || !['approve', 'reject'].includes(payload.act) || !USER_ID_RE.test(payload.sub)) {
      throw new HttpError(400, 'Link inválido ou expirado', 'invalid_token');
    }
    return payload;
  }

  async function decisionPreview(req, ip) {
    await guard('decision', ip, DECISION_PER_IP);
    const payload = decisionPayload(await readJson(req));
    const entry = await stores.users.get(payload.sub);
    if (!entry) throw new HttpError(404, 'Cadastro não encontrado', 'not_found');
    return json(200, { name: entry.value.name, email: entry.value.email, action: payload.act, status: entry.value.status });
  }

  async function decisionApply(req, ip) {
    await guard('decision', ip, DECISION_PER_IP);
    const payload = decisionPayload(await readJson(req));
    const entry = await stores.users.get(payload.sub);
    if (!entry) throw new HttpError(404, 'Cadastro não encontrado', 'not_found');
    if (entry.value.status !== 'pending') throw new HttpError(409, 'Este pedido já foi decidido.', 'already_decided');

    const status = payload.act === 'approve' ? 'approved' : 'rejected';
    const saved = await stores.users.put(payload.sub, { ...entry.value, status, decidedAt: nowIso() }, entry.etag);
    if (!saved) throw new HttpError(409, 'Este pedido já foi decidido.', 'already_decided');
    return json(200, { status });
  }

  // --- biblioteca do usuário ---

  async function updateLibrary(id, mutate) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const entry = await stores.library.get(id);
      const library = entry?.value ?? { items: {} };
      const result = mutate(library);

      const keys = Object.keys(library.items);
      if (keys.length > LIBRARY_CAP) {
        keys.sort((a, b) => library.items[a].lastViewedAt.localeCompare(library.items[b].lastViewedAt));
        for (const old of keys.slice(0, keys.length - LIBRARY_CAP)) delete library.items[old];
      }

      const saved = entry ? await stores.library.put(id, library, entry.etag) : await stores.library.create(id, library);
      if (saved) return result;
    }
    throw new HttpError(409, 'Conflito ao salvar. Tente de novo.', 'conflict');
  }

  function publicItem(item) {
    return {
      type: item.type,
      id: item.id,
      title: item.title,
      year: item.year,
      poster: item.poster,
      season: item.season,
      episode: item.episode,
      done: item.done,
      lastViewedAt: item.lastViewedAt,
    };
  }

  async function play(req, { id: uid }) {
    const body = await readJson(req);
    const type = v.validType(body.type);
    const mediaId = v.validId(body.id);
    if (!type || !mediaId) throw v.badRequest();

    const season = body.season == null ? null : v.intInRange(body.season, 0, 99);
    const episode = body.episode == null ? null : v.intInRange(body.episode, 1, 999);
    if ((body.season != null && season === null) || (body.episode != null && episode === null)) throw v.badRequest();

    const title = body.title == null ? null : v.cleanTitle(body.title);
    const year = body.year == null ? null : v.validYear(body.year);
    const poster = body.poster == null ? null : v.validPoster(body.poster);
    if ((body.title != null && !title) || (body.year != null && !year) || (body.poster != null && !poster)) throw v.badRequest();

    // O catálogo do servidor é a fonte do metadado; o que o navegador manda só vale para título que saiu do catálogo.
    const known = catalog.lookup(type, mediaId);
    const item = await updateLibrary(uid, (library) => {
      const itemKey = `${type}:${mediaId}`;
      const prev = library.items[itemKey];
      const next = {
        type,
        id: mediaId,
        title: known?.title ?? title ?? prev?.title ?? `Título ${mediaId}`,
        year: known?.year ?? year ?? prev?.year ?? null,
        poster: known?.poster ?? poster ?? prev?.poster ?? null,
        season: type === 'tv' ? (season ?? prev?.season ?? 1) : null,
        episode: type === 'tv' ? (episode ?? (season != null ? 1 : (prev?.episode ?? 1))) : null,
        done: prev?.done ?? false,
        lastViewedAt: nowIso(),
      };
      library.items[itemKey] = next;
      return next;
    });

    const url = type === 'tv' ? `${EMBED_BASE}/${mediaId}/${item.season}/${item.episode}` : `${EMBED_BASE}/${mediaId}`;
    return json(200, { url, ...publicItem(item) });
  }

  async function markDone(req, { id: uid }) {
    const body = await readJson(req);
    const type = v.validType(body.type);
    const mediaId = v.validId(body.id);
    if (!type || !mediaId || typeof body.done !== 'boolean') throw v.badRequest();

    const item = await updateLibrary(uid, (library) => {
      const current = library.items[`${type}:${mediaId}`];
      if (!current) throw new HttpError(404, 'Título não está na sua lista', 'not_found');
      current.done = body.done;
      return current;
    });
    return json(200, publicItem(item));
  }

  async function library({ id: uid }) {
    const entry = await stores.library.get(uid);
    const items = Object.values(entry?.value.items ?? {}).sort((a, b) => b.lastViewedAt.localeCompare(a.lastViewedAt));
    return json(200, {
      continue: items.filter((i) => !i.done).slice(0, CONTINUE_LIMIT).map(publicItem),
      watched: items.filter((i) => i.done).slice(0, WATCHED_LIMIT).map(publicItem),
    });
  }

  // --- roteamento ---

  const PROTECTED = [
    ['GET', /^\/api\/auth\/me$/, async (_req, _url, _m, session) => json(200, { name: session.user.name })],
    [
      'GET',
      /^\/api\/list\/([a-z-]{1,30})$/,
      async (_req, url, m) => {
        const page = url.searchParams.has('page') ? Number(url.searchParams.get('page')) : 1;
        if (!v.intInRange(page, 1, 2000)) throw v.badRequest();
        return json(200, await catalog.list(m[1], page));
      },
    ],
    [
      'GET',
      /^\/api\/search$/,
      async (_req, url) => {
        const term = (url.searchParams.get('q') ?? '').trim().slice(0, 100);
        if (term.length < 2) throw v.badRequest('Busca precisa de pelo menos 2 caracteres');
        return json(200, await catalog.search(term));
      },
    ],
    ['GET', /^\/api\/seasons\/(\d{1,9})$/, async (_req, _url, m) => json(200, await catalog.seasons(m[1]))],
    [
      'GET',
      /^\/api\/episodes\/(\d{1,9})\/(\d{1,2})$/,
      async (_req, _url, m) => json(200, await catalog.episodes(m[1], Number(m[2]))),
    ],
    ['POST', /^\/api\/play$/, (req, _url, _m, session) => play(req, session)],
    ['POST', /^\/api\/me\/done$/, (req, _url, _m, session) => markDone(req, session)],
    ['GET', /^\/api\/me\/library$/, (_req, _url, _m, session) => library(session)],
  ];

  const PUBLIC = [
    ['POST', '/api/auth/register', register],
    ['POST', '/api/auth/login', login],
    ['POST', '/api/auth/decision/preview', decisionPreview],
    ['POST', '/api/auth/decision', decisionApply],
  ];

  return async function handle(req, context) {
    try {
      const url = new URL(req.url);
      const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
      const ip = String(context?.ip ?? 'unknown');

      const open = PUBLIC.find(([method, route]) => method === req.method && route === path);
      if (open) return await open[2](req, ip);

      for (const [method, pattern, run] of PROTECTED) {
        const match = path.match(pattern);
        if (!match) continue;
        if (method !== req.method) throw new HttpError(405, 'Método não permitido', 'method_not_allowed');
        const session = await authenticate(req);
        return await run(req, url, match, session);
      }

      if (PUBLIC.some(([, route]) => route === path)) throw new HttpError(405, 'Método não permitido', 'method_not_allowed');
      throw new HttpError(404, 'Rota inexistente', 'not_found');
    } catch (err) {
      if (err instanceof HttpError) return json(err.status, { error: err.message, code: err.code });
      console.error('api_error', err?.name, err?.message);
      return json(500, { error: 'Erro interno', code: 'internal' });
    }
  };
}
