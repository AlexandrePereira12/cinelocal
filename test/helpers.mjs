import assert from 'node:assert/strict';
import { normalizeTitle } from '../netlify/lib/catalog.mjs';
import { createHandler } from '../netlify/lib/handler.mjs';

export const ADMIN_EMAIL = 'admin-secreto@exemplo.invalid';
export const AUTH_SECRET = 'x'.repeat(48);
export const SITE_URL = 'https://cine.exemplo.invalid';
export const DOMAIN_WITHOUT_MAIL = 'sem-email.exemplo.com';

export function memoryStore() {
  const data = new Map();
  let version = 0;
  return {
    data,
    async get(key) {
      const found = data.get(key);
      return found ? { value: structuredClone(found.value), etag: found.etag } : null;
    },
    async create(key, value) {
      if (data.has(key)) return false;
      data.set(key, { value: structuredClone(value), etag: String(++version) });
      return true;
    },
    async put(key, value, etag) {
      const found = data.get(key);
      if (etag && (!found || found.etag !== etag)) return false;
      data.set(key, { value: structuredClone(value), etag: String(++version) });
      return true;
    },
    async del(key) {
      data.delete(key);
    },
  };
}

// Classificação indicativa dos títulos "do catálogo" do fake: o filme 777 é 12 anos e a série 300 é 16 anos.
// Título que não está aqui não é conhecido pelo fake (lookup = null), com ou sem modo família.
export const FAKE_CERTIFICATIONS = { 'movie:777': 12, 'tv:300': 16 };

export function fakeCatalog({ withGenres = true } = {}) {
  const calls = [];
  // Temporadas da série 300 (número, episódios): mutável, para o teste simular episódio novo no catálogo.
  const state = { shows: { 300: [[1, 2], [2, 1]] } };
  const build = (maxRating) => {
    const visible = (type, id) => {
      const cert = FAKE_CERTIFICATIONS[`${type}:${id}`];
      return cert !== undefined && (maxRating == null || cert <= maxRating);
    };
    const certified = (type, id, item) => (visible(type, id) ? { ...item, certification: FAKE_CERTIFICATIONS[`${type}:${id}`] } : null);
    const self = {
      calls,
      state,
      async list(name, page) {
        calls.push(['list', name, page]);
        return { page, totalPages: 1, items: [{ id: '1', type: 'movie', title: 'Filme', year: '2020', poster: '/a.jpg', quality: 'HD', rating: null, runtime: 90 }] };
      },
      async search(term, options) {
        // Sem filtro, a chamada é registrada como antes; com filtro, as opções vão junto.
        const filtered = options && (options.type || options.from !== null || options.to !== null);
        calls.push(filtered ? ['search', term, options] : ['search', term]);
        return { items: [] };
      },
      async seasons(id) {
        calls.push(['seasons', id]);
        return { seasons: [1, 2] };
      },
      async episodes(id, season) {
        calls.push(['episodes', id, season]);
        return { season, episodes: [1, 2, 3] };
      },
      genres() {
        return withGenres ? [{ id: 28, name: 'Ação' }, { id: 35, name: 'Comédia' }, { id: 18, name: 'Drama' }] : [];
      },
      recommend(ids, exclude) {
        calls.push(['recommend', ids, [...exclude].sort()]);
        return {
          first: [{ id: '1', type: 'movie', title: 'Só do 1º' }],
          second: [{ id: '2', type: 'tv', title: 'Só do 2º' }],
          both: [],
        };
      },
      // Títulos "do catálogo": o filme 777 e a série 300 (S1 com 2 episódios, S2 com 1).
      lookup(type, id) {
        if (!visible(type, id)) return null;
        if (type === 'movie' && id === '777') return { title: 'Do Catálogo', year: '2024', poster: '/catalogo.jpg' };
        if (type === 'tv' && id === '300') return { title: 'Série do Catálogo', year: '2022', poster: '/serie.jpg' };
        return null;
      },
      info(type, id) {
        if (type === 'movie' && id === '777') return visible(type, id) ? { overview: 'Sinopse do catálogo', rating: 7.5, votes: 100, runtime: 100, originalTitle: null, genres: ['Ação'], certification: 12, seasons: null, episodes: null } : null;
        return null;
      },
      detail(type, id) {
        const known = this.lookup(type, id);
        return known ? { id, type, ...known, overview: 'Sinopse', genres: ['Ação'], similar: [{ id: '5', type, title: 'Parecido' }] } : null;
      },
      similar(type, id, options = {}) {
        calls.push(['similar', type, id, [...(options.exclude ?? [])].sort()]);
        return id === '10' ? [{ id: '5', type, title: 'Parecido com o 10' }] : [];
      },
      async browse(options) {
        calls.push(['browse', options]);
        return { page: options.page, totalPages: 1, total: 0, items: [] };
      },
      browseGenres() {
        const list = [{ id: 28, name: 'Ação' }];
        return { all: list, movie: list, tv: [{ id: 10759, name: 'Action & Adventure' }] };
      },
      async directors(options) {
        calls.push(['directors', options]);
        return { page: options.page, totalPages: 1, total: 0, items: [] };
      },
      async director(id, page) {
        calls.push(['director', id, page]);
        return id === '9001' ? { director: { id, name: 'Diretora Teste', photo: null, count: 1 }, page, totalPages: 1, items: [] } : null;
      },
      // Mesma regra do catálogo real, sobre as temporadas de `state.shows`.
      nextEpisode(id, season, episode) {
        const seasons = state.shows[id];
        const current = seasons?.find(([number]) => number === season);
        if (!current) return null;
        if (episode < current[1]) return { season, episode: episode + 1 };
        const later = seasons.map(([number]) => number).filter((number) => number > season);
        return later.length ? { season: Math.min(...later), episode: 1 } : null;
      },
      episodeCount(id) {
        const seasons = state.shows[id];
        return seasons ? seasons.reduce((sum, [, count]) => sum + count, 0) : null;
      },
      // Sorteio: escolhe entre os títulos do fake que não estão em exclude/skip, usando o `random` recebido (índice = floor(random * n)).
      pick(options = {}) {
        const { exclude = new Set(), skip = new Set(), random = Math.random } = options;
        calls.push(['pick', { ...options, exclude: [...exclude].sort(), skip: [...skip].sort(), random: typeof random }]);
        const pool = [
          { type: 'movie', id: '777', title: 'Do Catálogo', year: '2024', poster: '/catalogo.jpg', genres: ['Ação'] },
          { type: 'tv', id: '300', title: 'Série do Catálogo', year: '2022', poster: '/serie.jpg', genres: ['Drama'] },
        ].filter((item) => visible(item.type, item.id) && !exclude.has(`${item.type}:${item.id}`) && !skip.has(`${item.type}:${item.id}`));
        return pool.length ? pool[Math.floor(random() * pool.length)] : null;
      },
      // Pedido de título: conhece só os dois títulos do fake (pelo título normalizado).
      hasTitle(title, { type = 'any', year = null } = {}) {
        const known = { 'do catalogo': ['movie', '777', 'Do Catálogo', '2024'], 'serie do catalogo': ['tv', '300', 'Série do Catálogo', '2022'] }[normalizeTitle(title)];
        if (!known) return null;
        const [kind, id, name, y] = known;
        if ((type && type !== 'any' && type !== kind) || (year != null && String(year) !== y) || !visible(kind, id)) return null;
        return certified(kind, id, { id, type: kind, title: name, year: y, poster: null });
      },
      forRating(max) {
        if (max == null) return self;
        calls.push(['forRating', max]);
        return build(max);
      },
    };
    return self;
  };
  return build(null);
}

export function makeApp({ env: envOverrides = {}, mailFails = false, userMailFails = false, requestMailFails = false, genres = true, random = () => 0 } = {}) {
  const stores = { users: memoryStore(), library: memoryStore(), limits: memoryStore(), tv: memoryStore(), requests: memoryStore() };
  const catalog = fakeCatalog({ withGenres: genres });
  const mails = [];
  const notices = [];
  const resets = [];
  const requestMails = [];
  const mailer = {
    async sendTitleRequest(mail) {
      if (requestMailFails) throw new Error('mail_failed:500');
      requestMails.push(mail);
    },
    async sendApprovalRequest(mail) {
      if (mailFails) throw new Error('mail_failed:500');
      mails.push(mail);
    },
    async sendDecisionNotice(mail) {
      if (userMailFails) throw new Error('mail_failed:500');
      notices.push(mail);
    },
    async sendPasswordReset(mail) {
      if (userMailFails) throw new Error('mail_failed:500');
      resets.push(mail);
    },
  };
  const clock = { ms: Date.parse('2026-10-11T12:00:00Z') };
  const env = { AUTH_SECRET, SITE_URL, ADMIN_EMAIL, ...envOverrides };
  const domainChecks = [];
  const acceptsMail = async (domain) => {
    domainChecks.push(domain);
    return domain !== DOMAIN_WITHOUT_MAIL;
  };
  const handle = createHandler({ stores, catalog, mailer, acceptsMail, env, now: () => clock.ms, random });

  async function call(method, path, { body, token, ip = '203.0.113.7', headers = {}, raw, contentType = 'application/json' } = {}) {
    const init = { method, headers: { ...headers } };
    if (token) init.headers.authorization = `Bearer ${token}`;
    if (body !== undefined || raw !== undefined) {
      init.headers['content-type'] = contentType;
      init.body = raw ?? JSON.stringify(body);
    }
    const res = await handle(new Request(`https://evil.example${path}`, init), { ip });
    const text = await res.text();

    // Nenhuma resposta pode vazar segredo, hash de senha ou o e-mail do admin.
    for (const forbidden of [ADMIN_EMAIL, AUTH_SECRET, 'passHash', 'scrypt$']) {
      assert.ok(!text.includes(forbidden), `resposta de ${method} ${path} vazou "${forbidden}"`);
    }
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  async function registerAndApprove(email = 'ana@exemplo.com', password = 'Senha_bem_longa_1', name = 'Ana Souza') {
    const reg = await call('POST', '/api/auth/register', { body: { name, email, password } });
    assert.equal(reg.status, 202);
    const mail = mails.at(-1);
    const token = mail.approveUrl.split('/#/decisao/')[1];
    const decided = await call('POST', '/api/auth/decision', { body: { token } });
    assert.equal(decided.status, 200);
    const login = await call('POST', '/api/auth/login', { body: { email, password } });
    assert.equal(login.status, 200);
    return { token: login.body.token, email, password };
  }

  return { call, stores, catalog, mails, notices, resets, requestMails, domainChecks, clock, env, registerAndApprove };
}
