/*
 * Todas as rotas `/api/*`. As dependências (stores, catálogo, mailer, env, relógio) são injetadas para
 * permitir testes sem Netlify.
 *
 * Decisões de segurança:
 * - Só `register`, `login`, `forgot`, `reset` e a decisão do admin são públicas. Todo o resto exige `Authorization: Bearer`
 *   e relê o usuário a cada chamada, exigindo status `approved`: recusar/revogar vale na hora.
 * - Sem enumeração de contas: login com erro devolve sempre a mesma mensagem (com custo de scrypt igual);
 *   "aguardando aprovação"/"recusado" só aparece depois de senha correta; cadastro de e-mail já existente
 *   responde igual ao sucesso e não dispara novo e-mail; "esqueci a senha" responde sempre igual, exista a conta ou não.
 * - O cadastro só fica pendente se o aviso ao admin for enviado; se o envio falhar o registro é desfeito e
 *   a pessoa recebe erro (nada fica pendente em silêncio).
 * - Limites: cadastro por IP, falhas de login por e-mail e por IP, decisão por IP e teto diário de avisos ao admin
 *   (evita transformar o cadastro público em spam na caixa do admin).
 * - Cadastro: senha de 4+ caracteres com maiúscula, minúscula, número e um de @ _ . (regra definida pelo dono do
 *   projeto, mais branda que a anterior de 10 caracteres). O login não aplica a regra, para contas antigas entrarem;
 *   redefinir e trocar a senha aplicam (é senha nova). O domínio do e-mail precisa receber mensagens (email-domain.mjs);
 *   a consulta vem depois do limite por IP e só reprova com "sem registro" explícito do DNS. A caixa em si não é
 *   provada: a aprovação do admin cobre isso.
 * - Transmissão para a TV (tv.mjs): pareamento por código; `/api/tv/pair` e `/api/tv/poll` são públicos (a TV não tem
 *   login) e protegidos por segredo próprio; enviar e parar exigem login. O App ID do Chromecast vem de CAST_APP_ID.
 * - O link do e-mail usa SITE_URL (nunca o header Host, que permitiria injetar link de phishing) e abre uma
 *   página de confirmação; a decisão é um POST com token assinado (uso único: só vale com status `pending`).
 * - POST só com application/json e corpo pequeno; sem CORS (mesma origem); respostas `no-store`.
 * - Gêneros favoritos (exatamente 2, só de filme) ficam no registro do usuário. `needsGenres` vem do servidor e
 *   só é verdadeiro se o catálogo tem gêneros: usuário antigo e novo veem a escolha na próxima entrada.
 * - Recomendações da home saem dos 2 gêneros escolhidos (filme e série) e nunca incluem título que já está no
 *   histórico do usuário; a lógica fica no catálogo (`recommend`), aqui só se monta a resposta. O que a pessoa marcou
 *   como assistido pondera a ordem (ver catalog.mjs) e escolhe o título da fileira "Porque você assistiu X" (sem
 *   nenhum assistido, vale o último aberto e a fileira vira "Parecidos com X").
 * - Histórico guarda temporada/episódio (a posição em minutos não existe: o player é um iframe de outra origem).
 *   O embed em si é público no provedor: o bloqueio é do app, não do provedor.
 *
 * Decisões da conta (sessão, senha e e-mails):
 * - Sair de todos os dispositivos = `ver` no registro do usuário. O token de acesso leva o `ver` de quando foi emitido e
 *   `authenticate` exige igualdade; subir o `ver` invalida todos os tokens de uma vez, sem lista de tokens. Registro ou
 *   token sem `ver` valem 0, então as sessões que já existiam continuam valendo até alguém subir o número.
 *   Trocar ou redefinir a senha também sobe o `ver` (quem tinha a senha antiga perde a sessão); a troca devolve um token
 *   novo para o aparelho que trocou continuar entrando.
 * - O link de redefinição é um token assinado (`typ: reset`, 1 hora) com uma "impressão" do hash da senha atual (`pv`).
 *   Usar o link muda a senha, o que muda a impressão e inutiliza o próprio link: uso único sem guardar nada. Só vale
 *   para conta aprovada. Nunca vai para log (só no e-mail; no `netlify dev` com dry run, no console).
 * - Senha atual errada na troca responde 400, não 401: no front, 401 com token derruba a sessão (api() em app.js).
 *   As tentativas de troca contam num limite por usuário, para quem roubar um token não ficar tentando adivinhar a senha.
 *   Limites de tentativa (troca de senha e login por e-mail) contam ANTES de verificar e zeram no sucesso; contar só
 *   depois do erro deixa requisições paralelas furarem o limite (todas passam pela checagem antes da primeira contar).
 * - Aceito: 5 senhas erradas para um e-mail travam o login dele por 15 minutos, de qualquer IP, mesmo com a senha certa
 *   (alguém que conheça o e-mail da vítima consegue atrapalhar). "Esqueci a senha" destrava, e o limite por e-mail é
 *   o que impede adivinhar senha de uma conta; trocá-lo por limite só por IP deixaria a adivinhação distribuída livre.
 * - "Esqueci a senha": limite por IP e por e-mail (ninguém bombardeia a caixa de outra pessoa) e teto diário de
 *   e-mails a usuários (cota do Resend). Passou do teto ou o envio falhou: a resposta continua igual (só vai para o
 *   log), senão a diferença revelaria que a conta existe. Resta uma diferença de tempo (só conta existente espera o
 *   envio), aceita porque os limites tornam a varredura inviável.
 * - O aviso de aprovação/recusa é "melhor esforço": se o e-mail falhar, a decisão do admin já valeu e não é desfeita.
 *
 * Decisões da biblioteca:
 * - "Quero ver" (watchlist) mora no mesmo registro da biblioteca (`watchlist`), não numa store nova: reaproveita a
 *   escrita condicional por etag e não exige criar store nem mexer no deploy. Teto próprio. O metadado do título vem
 *   sempre do catálogo do servidor. Abrir o título no player tira ele de "Quero ver" (já virou "Continuar assistindo").
 * - Marcar episódio como assistido numa série avança a posição salva para o próximo episódio (o catálogo sabe a
 *   contagem de cada temporada); no último episódio da última temporada, a série inteira vira "assistida". Sem
 *   temporada/episódio no pedido (ou em filme) o comportamento é o de sempre: marca/desmarca o título todo.
 * - Sinopse e nota vão só no `info` da resposta de /play, nunca em `publicItem`: o histórico/lista não carrega texto longo.
 * - Diretores (`/api/directors` e `/api/director/<id>`): a ordenação e as regras ficam no catálogo; aqui só se validam
 *   os parâmetros. Busca com 1 caractere é erro (como na busca de títulos), vazia é "sem filtro". Diretor desconhecido
 *   responde 410 como título fora do catálogo.
 * - Rotas novas respondem 410 (não 404) para "título fora do catálogo": o `netlify dev` reenvia 404 para outro caminho.
 */

import { burnPasswordCheck, hashPassword, readSecret, sha256Hex, signToken, verifyPassword, verifyToken } from './auth.mjs';
import { embedUrl } from './catalog.mjs';
import { HttpError } from './errors.mjs';
import { clear, increment, isBlocked } from './limits.mjs';
import { createTv, normalizeCode } from './tv.mjs';
import * as v from './validate.mjs';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const ACCESS_TTL_S = 7 * 24 * 60 * 60;
const DECISION_TTL_S = 7 * 24 * 60 * 60;
const RESET_TTL_S = 60 * 60;
const MAX_BODY_BYTES = 4096;
const LIBRARY_CAP = 300;
const WATCHLIST_CAP = 200;
const CONTINUE_LIMIT = 30;
const WATCHED_LIMIT = 60;

const REGISTER_PER_IP = { limit: 5, windowMs: HOUR_MS };
const LOGIN_FAILS_PER_EMAIL = { limit: 5, windowMs: 15 * 60 * 1000 };
const LOGIN_FAILS_PER_IP = { limit: 20, windowMs: 15 * 60 * 1000 };
const PASSWORD_FAILS_PER_USER = { limit: 5, windowMs: 15 * 60 * 1000 };
const DECISION_PER_IP = { limit: 30, windowMs: HOUR_MS };
const FORGOT_PER_IP = { limit: 5, windowMs: HOUR_MS };
const FORGOT_PER_EMAIL = { limit: 3, windowMs: HOUR_MS };
const RESET_PER_IP = { limit: 20, windowMs: HOUR_MS };
const DAILY_ADMIN_NOTICES = 30;
const DAILY_USER_MAILS = 30;

const USER_ID_RE = /^u_[0-9a-f]{40}$/;
const ACCEPTED_MESSAGE = 'Solicitação recebida. Você poderá entrar assim que o cadastro for aprovado.';
const FORGOT_MESSAGE = 'Se existir uma conta aprovada com esse e-mail, enviamos um link para escolher uma nova senha. O link vale por 1 hora.';
const PASSWORD_MESSAGE = `A senha precisa ter de ${v.PASSWORD_MIN} a ${v.PASSWORD_MAX} caracteres, com letra maiúscula, minúscula, número e um símbolo (@, _ ou .)`;

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
const conflict = () => new HttpError(409, 'Conflito ao salvar. Tente de novo.', 'conflict');
const invalidLink = () => new HttpError(400, 'Link inválido ou expirado', 'invalid_token');
const titleGone = () => new HttpError(410, 'Título não encontrado no catálogo', 'not_found');

// Impressão do hash da senha atual: o link de redefinição só vale enquanto a senha for a mesma de quando ele foi gerado.
const passwordStamp = (user) => sha256Hex(user.passHash).slice(0, 16);

// Mantém só os `cap` registros mais recentes de um mapa (pelo campo de data indicado).
function keepNewest(map, cap, field) {
  const keys = Object.keys(map);
  if (keys.length <= cap) return;
  keys.sort((a, b) => map[a][field].localeCompare(map[b][field]));
  for (const old of keys.slice(0, keys.length - cap)) delete map[old];
}

// Filtros comuns de busca e explorar (tipo e faixa de anos). Valor inválido é erro, nunca é ignorado em silêncio.
function readFilters(url) {
  const params = url.searchParams;
  const type = params.get('type') ?? 'all';
  if (!['all', 'movie', 'tv'].includes(type)) throw v.badRequest();
  const year = (name) => {
    if (!params.has(name)) return null;
    const value = v.intParam(params.get(name), 1800, 2100);
    if (value === null) throw v.badRequest();
    return value;
  };
  const from = year('from');
  const to = year('to');
  if (from !== null && to !== null && from > to) throw v.badRequest();
  return { type, from, to };
}

export function createHandler({ stores, catalog, mailer, acceptsMail, env, now = Date.now }) {
  const nowSeconds = () => Math.floor(now() / 1000);
  const nowIso = () => new Date(now()).toISOString();
  const userId = (email) => `u_${sha256Hex(email).slice(0, 40)}`;
  const tv = createTv({ stores, now });

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

  function accessToken(user) {
    const iat = nowSeconds();
    return signToken({ typ: 'access', sub: user.id, ver: user.ver ?? 0, iat, exp: iat + ACCESS_TTL_S }, secret());
  }

  async function authenticate(req) {
    const key = secret();
    const match = (req.headers.get('authorization') ?? '').match(/^Bearer ([A-Za-z0-9._-]+)$/);
    const payload = match && verifyToken(match[1], key, 'access', nowSeconds());
    if (!payload || typeof payload.sub !== 'string' || !USER_ID_RE.test(payload.sub)) throw unauthorized();
    const entry = await stores.users.get(payload.sub);
    if (!entry || entry.value.status !== 'approved') throw unauthorized();
    if ((payload.ver ?? 0) !== (entry.value.ver ?? 0)) throw unauthorized(); // sessão encerrada (sair de todos / senha trocada)
    return { id: payload.sub, user: entry.value };
  }

  // Grava uma mudança no registro do usuário com escrita condicional (etag), tentando de novo se houver disputa.
  // `mutate` recebe o registro atual e devolve o novo; pode lançar HttpError para recusar a mudança.
  async function updateUser(uid, mutate) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const entry = await stores.users.get(uid);
      if (!entry || entry.value.status !== 'approved') throw unauthorized();
      const next = await mutate(entry.value);
      if (await stores.users.put(uid, next, entry.etag)) return next;
    }
    throw conflict();
  }

  // Gêneros favoritos do usuário já resolvidos para {id, name}. Se o catálogo mudou e não restam 2 válidos, vale como "não escolheu".
  function pickedGenres(user) {
    const options = new Map(catalog.genres().map((genre) => [genre.id, genre]));
    const picked = (Array.isArray(user.genres) ? user.genres : []).map((id) => options.get(id)).filter(Boolean);
    return picked.length === 2 ? picked : null;
  }

  // Única forma de montar o que sai do registro do usuário: nunca devolve hash de senha, e-mail nem status.
  // `needsGenres` só é verdadeiro se o catálogo tem opções de gênero (catálogo antigo não obriga ninguém a escolher).
  function profile(user) {
    const genres = pickedGenres(user);
    return { name: user.name, genres, needsGenres: genres === null && catalog.genres().length > 0 };
  }

  async function guard(prefix, subject, { limit, windowMs }) {
    if ((await increment(stores.limits, `${prefix}:${sha256Hex(subject)}`, windowMs, now())) > limit) throw tooMany();
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

  // Aviso do resultado à pessoa que pediu o cadastro. Melhor esforço: a decisão já foi gravada e não é desfeita por falha de e-mail.
  async function notifyDecision(user, approved) {
    try {
      await mailer.sendDecisionNotice({ name: user.name, email: user.email, approved, loginUrl: `${siteOrigin()}/#/login` });
    } catch (err) {
      console.error('mail_error', err?.message);
    }
  }

  // --- públicas ---

  async function register(req, ip) {
    const key = secret();
    const origin = siteOrigin();
    const body = await readJson(req);
    const name = v.cleanName(body.name);
    const email = v.normalizeEmail(body.email);
    if (!name) throw v.badRequest('Informe um nome de 2 a 60 caracteres');
    if (!email) throw v.badRequest('Informe um e-mail válido');
    if (!v.validPassword(body.password)) throw v.badRequest(PASSWORD_MESSAGE);
    await guard('reg', ip, REGISTER_PER_IP);
    // Depois do limite por IP: cada consulta de DNS é custo nosso. Não depende de o e-mail já ter conta (sem enumeração).
    if (!(await acceptsMail(v.emailDomain(email)))) {
      throw new HttpError(400, 'Esse e-mail não parece real: o domínio não recebe mensagens. Confira se digitou certo.', 'invalid_email_domain');
    }

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
    secret(); // sem AUTH_SECRET o serviço está mal configurado: erro 500 já na entrada, não um 401 enganoso
    const body = await readJson(req);
    if (typeof body.password !== 'string' || body.password.length > v.PASSWORD_MAX) throw v.badRequest();
    const email = v.normalizeEmail(body.email);

    // Por e-mail, a tentativa é contada ANTES de verificar (e zerada no sucesso): checar o bloqueio e só contar depois do
    // erro deixaria requisições paralelas passarem todas pela checagem antes da primeira contar, e adivinhar a senha de
    // uma conta não teria limite real. Por IP continua contando só as falhas (vários logins certos atrás do mesmo NAT).
    const ipKey = `login-ip:${sha256Hex(ip)}`;
    const emailKey = email && `login-email:${sha256Hex(email)}`;
    if (
      (await isBlocked(stores.limits, ipKey, LOGIN_FAILS_PER_IP.limit, now())) ||
      (emailKey && (await increment(stores.limits, emailKey, LOGIN_FAILS_PER_EMAIL.windowMs, now())) > LOGIN_FAILS_PER_EMAIL.limit)
    ) {
      throw tooMany();
    }

    const entry = email ? await stores.users.get(userId(email)) : null;
    const valid = entry ? await verifyPassword(body.password, entry.value.passHash) : (await burnPasswordCheck(body.password), false);
    if (!valid) {
      await increment(stores.limits, ipKey, LOGIN_FAILS_PER_IP.windowMs, now());
      throw new HttpError(401, 'E-mail ou senha inválidos', 'invalid_credentials');
    }
    if (emailKey) await clear(stores.limits, emailKey);

    // 401 (e não 403) de propósito: o `netlify dev` reenvia respostas 403/404 de function para caminhos
    // alternativos (…/index.html) e o handler passaria a ver outra rota. O `code` distingue o motivo.
    const user = entry.value;
    if (user.status === 'pending') throw new HttpError(401, 'Seu cadastro está aguardando aprovação.', 'pending');
    if (user.status !== 'approved') throw new HttpError(401, 'Seu cadastro não foi aprovado.', 'rejected');

    return json(200, { token: accessToken(user), user: profile(user) });
  }

  function decisionPayload(body) {
    const payload = verifyToken(body.token, secret(), 'decision', nowSeconds());
    if (!payload || !['approve', 'reject'].includes(payload.act) || !USER_ID_RE.test(payload.sub)) throw invalidLink();
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
    await notifyDecision(entry.value, status === 'approved');
    return json(200, { status });
  }

  // Pede o link de redefinição. Resposta sempre igual (ver "Decisões da conta" no topo).
  async function forgot(req, ip) {
    const key = secret();
    const origin = siteOrigin();
    const body = await readJson(req);
    const email = v.normalizeEmail(body.email);
    if (!email) throw v.badRequest('Informe um e-mail válido');
    await guard('forgot-ip', ip, FORGOT_PER_IP);
    await guard('forgot-email', email, FORGOT_PER_EMAIL);

    const entry = await stores.users.get(userId(email));
    if (entry?.value.status === 'approved') {
      const day = nowIso().slice(0, 10);
      if ((await increment(stores.limits, `user-mails:${day}`, DAY_MS, now())) > DAILY_USER_MAILS) {
        console.error('mail_error', 'daily_cap');
      } else {
        const user = entry.value;
        const iat = nowSeconds();
        const token = signToken({ typ: 'reset', sub: user.id, pv: passwordStamp(user), iat, exp: iat + RESET_TTL_S }, key);
        try {
          await mailer.sendPasswordReset({ name: user.name, email: user.email, resetUrl: `${origin}/#/redefinir/${token}` });
        } catch (err) {
          console.error('mail_error', err?.message);
        }
      }
    }
    return json(202, { message: FORGOT_MESSAGE });
  }

  // Usa o link de redefinição: grava a senha nova, encerra as sessões antigas e inutiliza o próprio link.
  async function reset(req, ip) {
    const key = secret();
    await guard('reset', ip, RESET_PER_IP);
    const body = await readJson(req);
    const payload = verifyToken(body.token, key, 'reset', nowSeconds());
    if (!payload || typeof payload.pv !== 'string' || !USER_ID_RE.test(payload.sub)) throw invalidLink();
    if (!v.validPassword(body.password)) throw v.badRequest(PASSWORD_MESSAGE);

    const passHash = await hashPassword(body.password);
    const user = await updateUser(payload.sub, (current) => {
      if (payload.pv !== passwordStamp(current)) throw invalidLink();
      return { ...current, passHash, ver: (current.ver ?? 0) + 1 };
    }).catch((err) => {
      throw err.status === 401 ? invalidLink() : err; // conta sumiu ou deixou de estar aprovada: mesmo erro do link vencido
    });
    await clear(stores.limits, `login-email:${sha256Hex(user.email)}`); // quem esqueceu a senha e travou o login destrava
    return json(200, { message: 'Senha alterada. Entre com a nova senha.' });
  }

  // --- biblioteca do usuário ---

  async function updateLibrary(id, mutate) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const entry = await stores.library.get(id);
      const library = entry?.value ?? { items: {} };
      library.watchlist ??= {};
      const result = mutate(library);

      keepNewest(library.items, LIBRARY_CAP, 'lastViewedAt');
      keepNewest(library.watchlist, WATCHLIST_CAP, 'addedAt');

      const saved = entry ? await stores.library.put(id, library, entry.etag) : await stores.library.create(id, library);
      if (saved) return result;
    }
    throw conflict();
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

  function publicWatchlistItem(item) {
    return { type: item.type, id: item.id, title: item.title, year: item.year, poster: item.poster, addedAt: item.addedAt };
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
      if (prev?.doneAt) next.doneAt = prev.doneAt;
      library.items[itemKey] = next;
      delete library.watchlist[itemKey]; // começou a ver: sai de "Quero ver" e passa a "Continuar assistindo"
      return next;
    });

    return json(200, { url: embedUrl(type, mediaId, item.season, item.episode), ...publicItem(item), info: known ? catalog.info(type, mediaId) : null });
  }

  async function markDone(req, { id: uid }) {
    const body = await readJson(req);
    const type = v.validType(body.type);
    const mediaId = v.validId(body.id);
    if (!type || !mediaId || typeof body.done !== 'boolean') throw v.badRequest();

    const season = body.season == null ? null : v.intInRange(body.season, 0, 99);
    const episode = body.episode == null ? null : v.intInRange(body.episode, 1, 999);
    if ((body.season != null && season === null) || (body.episode != null && episode === null) || (season === null) !== (episode === null)) throw v.badRequest();

    let next = null;
    const item = await updateLibrary(uid, (library) => {
      const current = library.items[`${type}:${mediaId}`];
      if (!current) throw new HttpError(404, 'Título não está na sua lista', 'not_found');
      next = type === 'tv' && body.done && season !== null ? catalog.nextEpisode(mediaId, season, episode) : null;
      if (next) {
        // Episódio visto e ainda tem o seguinte: a série continua em andamento, agora no próximo episódio.
        current.season = next.season;
        current.episode = next.episode;
        current.done = false;
        delete current.doneAt;
      } else {
        current.done = body.done;
        if (body.done) current.doneAt = nowIso();
        else delete current.doneAt;
      }
      return current;
    });
    return json(200, { ...publicItem(item), ...(next && { next }) });
  }

  async function library({ id: uid }) {
    const entry = await stores.library.get(uid);
    const items = Object.values(entry?.value.items ?? {}).sort((a, b) => b.lastViewedAt.localeCompare(a.lastViewedAt));
    const watchlist = Object.values(entry?.value.watchlist ?? {}).sort((a, b) => b.addedAt.localeCompare(a.addedAt));
    return json(200, {
      continue: items.filter((i) => !i.done).slice(0, CONTINUE_LIMIT).map(publicItem),
      watched: items.filter((i) => i.done).slice(0, WATCHED_LIMIT).map(publicItem),
      watchlist: watchlist.map(publicWatchlistItem),
    });
  }

  async function setWatchlist(req, { id: uid }) {
    const body = await readJson(req);
    const type = v.validType(body.type);
    const mediaId = v.validId(body.id);
    if (!type || !mediaId || typeof body.add !== 'boolean') throw v.badRequest();
    const key = `${type}:${mediaId}`;

    if (body.add) {
      const known = catalog.lookup(type, mediaId);
      if (!known) throw titleGone();
      await updateLibrary(uid, (library) => {
        library.watchlist[key] ??= { type, id: mediaId, title: known.title, year: known.year, poster: known.poster, addedAt: nowIso() };
      });
    } else {
      await updateLibrary(uid, (library) => {
        delete library.watchlist[key];
      });
    }
    return json(200, { inWatchlist: body.add });
  }

  // --- detalhe do título ---

  async function title(type, mediaId, { id: uid }) {
    const detail = catalog.detail(type, mediaId);
    if (!detail) throw titleGone();
    const library = (await stores.library.get(uid))?.value;
    const key = `${type}:${mediaId}`;
    const seen = library?.items[key];
    return json(200, {
      ...detail,
      inWatchlist: Boolean(library?.watchlist?.[key]),
      progress: seen ? { season: seen.season, episode: seen.episode, done: seen.done } : null,
    });
  }

  // --- explorar ---

  async function browse(url) {
    const { type, from, to } = readFilters(url);
    const params = url.searchParams;
    const genre = params.has('genre') ? v.intParam(params.get('genre'), 1, 99999) : null;
    const minRating = params.has('rating') ? v.ratingParam(params.get('rating')) : null;
    const page = params.has('page') ? Number(params.get('page')) : 1;
    if ((params.has('genre') && genre === null) || (params.has('rating') && minRating === null) || !v.intInRange(page, 1, 2000)) throw v.badRequest();
    return json(200, await catalog.browse({ type, genre, from, to, minRating, page }));
  }

  // --- diretores ---

  function pageParam(url) {
    const page = url.searchParams.has('page') ? Number(url.searchParams.get('page')) : 1;
    if (!v.intInRange(page, 1, 2000)) throw v.badRequest();
    return page;
  }

  async function directors(url) {
    const term = (url.searchParams.get('q') ?? '').trim().slice(0, 100);
    if (url.searchParams.has('q') && term && term.length < 2) throw v.badRequest('Busca precisa de pelo menos 2 caracteres');
    return json(200, await catalog.directors({ term, page: pageParam(url) }));
  }

  async function director(id, url) {
    const result = await catalog.director(id, pageParam(url));
    if (!result) throw new HttpError(410, 'Diretor não encontrado no catálogo', 'not_found');
    return json(200, result);
  }

  // --- gêneros favoritos ---

  function preferences(user) {
    return json(200, { ...profile(user), options: catalog.genres() });
  }

  async function savePreferences(req, { id: uid }) {
    const body = await readJson(req);
    const options = catalog.genres();
    if (!options.length) throw new HttpError(409, 'Os gêneros não estão disponíveis neste catálogo', 'genres_unavailable');

    const ids = body.genres;
    const valid =
      Array.isArray(ids) &&
      ids.length === 2 &&
      new Set(ids).size === 2 &&
      ids.every((id) => Number.isInteger(id) && options.some((option) => option.id === id));
    if (!valid) throw v.badRequest('Escolha exatamente 2 gêneros diferentes da lista');

    return preferences(await updateUser(uid, (user) => ({ ...user, genres: ids })));
  }

  // Fileiras da home: "Porque você assistiu X" e as três dos gêneros escolhidos (gosto 1, gosto 2 e a mistura dos dois),
  // com filme e série e sem o que o usuário já abriu.
  async function recommendations({ id: uid, user }) {
    const genres = pickedGenres(user);
    const entry = await stores.library.get(uid);
    const items = Object.values(entry?.value.items ?? {});
    const exclude = new Set(Object.keys(entry?.value.items ?? {}));
    const when = (item) => item.doneAt ?? item.lastViewedAt;
    const watched = items.filter((item) => item.done).sort((a, b) => when(b).localeCompare(when(a)));
    const rows = [];

    const anchor = watched[0] ?? items.sort((a, b) => b.lastViewedAt.localeCompare(a.lastViewedAt))[0];
    if (anchor) {
      rows.push({
        id: 'because',
        title: watched[0] ? `Porque você assistiu ${anchor.title}` : `Parecidos com ${anchor.title}`,
        items: catalog.similar(anchor.type, anchor.id, { exclude }),
      });
    }
    if (genres) {
      const { first, second, both } = catalog.recommend(
        genres.map((genre) => genre.id),
        exclude,
        undefined,
        { watched },
      );
      rows.push(
        { id: 'gosto-1', title: `Mais de ${genres[0].name}`, items: first },
        { id: 'gosto-2', title: `Mais de ${genres[1].name}`, items: second },
        { id: 'mix', title: `${genres[0].name} + ${genres[1].name}`, items: both },
      );
    }
    return json(200, { rows: rows.filter((row) => row.items?.length) });
  }

  // --- conta ---

  async function account({ user }) {
    return json(200, { name: user.name, email: user.email });
  }

  async function renameAccount(req, { id: uid }) {
    const body = await readJson(req);
    const name = v.cleanName(body.name);
    if (!name) throw v.badRequest('Informe um nome de 2 a 60 caracteres');
    return json(200, profile(await updateUser(uid, (user) => ({ ...user, name }))));
  }

  async function changePassword(req, { id: uid }) {
    const body = await readJson(req);
    if (typeof body.current !== 'string' || !body.current || body.current.length > v.PASSWORD_MAX) throw v.badRequest();
    if (!v.validPassword(body.next)) throw v.badRequest(PASSWORD_MESSAGE);

    // Conta a tentativa ANTES de verificar (e zera no sucesso): checar o bloqueio e só contar depois do erro deixaria
    // requisições paralelas passarem todas pela checagem antes da primeira contar, e o limite viraria "quantas couberem".
    const failKey = `pwfail:${uid}`;
    if ((await increment(stores.limits, failKey, PASSWORD_FAILS_PER_USER.windowMs, now())) > PASSWORD_FAILS_PER_USER.limit) throw tooMany();
    const passHash = await hashPassword(body.next);
    const user = await updateUser(uid, async (current) => {
      if (!(await verifyPassword(body.current, current.passHash))) {
        throw new HttpError(400, 'Senha atual incorreta', 'wrong_password'); // 400 e não 401: 401 derrubaria a sessão no front
      }
      if (body.current === body.next) throw v.badRequest('A nova senha precisa ser diferente da atual');
      return { ...current, passHash, ver: (current.ver ?? 0) + 1 };
    });
    await clear(stores.limits, failKey);
    return json(200, { token: accessToken(user) });
  }

  async function logoutAll(_req, { id: uid }) {
    await updateUser(uid, (user) => ({ ...user, ver: (user.ver ?? 0) + 1 }));
    return json(200, { ok: true });
  }

  // --- transmitir para a TV (ver tv.mjs) ---

  const tvPair = async (_req, ip) => json(200, await tv.pair(ip));

  async function tvPoll(req) {
    const body = await readJson(req);
    return json(200, await tv.poll({ code: normalizeCode(body.code), secret: typeof body.secret === 'string' ? body.secret : '' }));
  }

  // Só type/id/season/episode entram: o link do player é sempre montado aqui, e o histórico não é tocado
  // (o celular já registrou o título ao abrir o filme).
  async function tvSend(req, { id: uid }) {
    const body = await readJson(req);
    const type = v.validType(body.type);
    const mediaId = v.validId(body.id);
    const season = body.season == null ? 1 : v.intInRange(body.season, 0, 99);
    const episode = body.episode == null ? 1 : v.intInRange(body.episode, 1, 999);
    if (!type || !mediaId || season === null || episode === null) throw v.badRequest();

    const title = catalog.lookup(type, mediaId)?.title ?? null;
    const play = { url: embedUrl(type, mediaId, season, episode), title, season: type === 'tv' ? season : null, episode: type === 'tv' ? episode : null };
    await tv.send(uid, { code: normalizeCode(body.code), play });
    return json(200, { ok: true, title });
  }

  async function tvStop(req, { id: uid }) {
    const body = await readJson(req);
    await tv.stop(uid, { code: normalizeCode(body.code) });
    return json(200, { ok: true });
  }

  // O App ID do receptor do Chromecast (8 caracteres hexadecimais, público) vem do ambiente; sem ele a opção some.
  const castAppId = () => (/^[0-9A-F]{8}$/i.test(env.CAST_APP_ID ?? '') ? env.CAST_APP_ID.toUpperCase() : null);

  // --- roteamento ---

  const PROTECTED = [
    ['GET', /^\/api\/auth\/me$/, async (_req, _url, _m, session) => json(200, profile(session.user))],
    ['GET', /^\/api\/me\/preferences$/, async (_req, _url, _m, session) => preferences(session.user)],
    ['POST', /^\/api\/me\/preferences$/, (req, _url, _m, session) => savePreferences(req, session)],
    ['GET', /^\/api\/me\/recommendations$/, (_req, _url, _m, session) => recommendations(session)],
    ['GET', /^\/api\/me\/account$/, (_req, _url, _m, session) => account(session)],
    ['POST', /^\/api\/me\/account$/, (req, _url, _m, session) => renameAccount(req, session)],
    ['POST', /^\/api\/me\/password$/, (req, _url, _m, session) => changePassword(req, session)],
    ['POST', /^\/api\/me\/logout-all$/, (req, _url, _m, session) => logoutAll(req, session)],
    ['POST', /^\/api\/me\/watchlist$/, (req, _url, _m, session) => setWatchlist(req, session)],
    [
      'GET',
      /^\/api\/list\/([a-z0-9-]{1,30})$/,
      async (_req, url, m) => {
        const page = url.searchParams.has('page') ? Number(url.searchParams.get('page')) : 1;
        if (!v.intInRange(page, 1, 2000)) throw v.badRequest();
        return json(200, await catalog.list(m[1], page));
      },
    ],
    ['GET', /^\/api\/directors$/, (_req, url) => directors(url)],
    ['GET', /^\/api\/director\/(\d{1,9})$/, (_req, url, m) => director(m[1], url)],
    ['GET', /^\/api\/browse$/, (_req, url) => browse(url)],
    ['GET', /^\/api\/browse\/options$/, async () => json(200, catalog.browseGenres())],
    ['GET', /^\/api\/title\/(movie|tv)\/(\d{1,9})$/, (_req, _url, m, session) => title(m[1], m[2], session)],
    [
      'GET',
      /^\/api\/search$/,
      async (_req, url) => {
        const term = (url.searchParams.get('q') ?? '').trim().slice(0, 100);
        if (term.length < 2) throw v.badRequest('Busca precisa de pelo menos 2 caracteres');
        const { type, from, to } = readFilters(url);
        return json(200, await catalog.search(term, { type: type === 'all' ? null : type, from, to }));
      },
    ],
    ['GET', /^\/api\/seasons\/(\d{1,9})$/, async (_req, _url, m) => json(200, await catalog.seasons(m[1]))],
    [
      'GET',
      /^\/api\/episodes\/(\d{1,9})\/(\d{1,2})$/,
      async (_req, _url, m) => json(200, await catalog.episodes(m[1], Number(m[2]))),
    ],
    ['POST', /^\/api\/play$/, (req, _url, _m, session) => play(req, session)],
    ['POST', /^\/api\/tv\/send$/, (req, _url, _m, session) => tvSend(req, session)],
    ['POST', /^\/api\/tv\/stop$/, (req, _url, _m, session) => tvStop(req, session)],
    ['GET', /^\/api\/cast\/config$/, async () => json(200, { appId: castAppId() })],
    ['POST', /^\/api\/me\/done$/, (req, _url, _m, session) => markDone(req, session)],
    ['GET', /^\/api\/me\/library$/, (_req, _url, _m, session) => library(session)],
  ];

  const PUBLIC = [
    ['POST', '/api/auth/register', register],
    ['POST', '/api/auth/login', login],
    ['POST', '/api/auth/forgot', forgot],
    ['POST', '/api/auth/reset', reset],
    ['POST', '/api/tv/pair', tvPair],
    ['POST', '/api/tv/poll', tvPoll],
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

      // O mesmo caminho pode ter mais de um método (GET e POST em /me/preferences): só vira 405 se nenhum casar.
      let knownPath = false;
      for (const [method, pattern, run] of PROTECTED) {
        const match = path.match(pattern);
        if (!match) continue;
        knownPath = true;
        if (method !== req.method) continue;
        const session = await authenticate(req);
        return await run(req, url, match, session);
      }

      if (knownPath || PUBLIC.some(([, route]) => route === path)) throw new HttpError(405, 'Método não permitido', 'method_not_allowed');
      throw new HttpError(404, 'Rota inexistente', 'not_found');
    } catch (err) {
      if (err instanceof HttpError) return json(err.status, { error: err.message, code: err.code });
      console.error('api_error', err?.name, err?.message);
      return json(500, { error: 'Erro interno', code: 'internal' });
    }
  };
}
