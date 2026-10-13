import assert from 'node:assert/strict';
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

export function fakeCatalog({ withGenres = true } = {}) {
  const calls = [];
  return {
    calls,
    async list(name, page) {
      calls.push(['list', name, page]);
      return { page, totalPages: 1, items: [{ id: '1', type: 'movie', title: 'Filme', year: '2020', poster: '/a.jpg', quality: 'HD', rating: null, runtime: 90 }] };
    },
    async search(term) {
      calls.push(['search', term]);
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
    lookup(type, id) {
      return type === 'movie' && id === '777' ? { title: 'Do Catálogo', year: '2024', poster: '/catalogo.jpg' } : null;
    },
  };
}

export function makeApp({ env: envOverrides = {}, mailFails = false, genres = true } = {}) {
  const stores = { users: memoryStore(), library: memoryStore(), limits: memoryStore() };
  const catalog = fakeCatalog({ withGenres: genres });
  const mails = [];
  const mailer = {
    async sendApprovalRequest(mail) {
      if (mailFails) throw new Error('mail_failed:500');
      mails.push(mail);
    },
  };
  const clock = { ms: Date.parse('2026-10-11T12:00:00Z') };
  const env = { AUTH_SECRET, SITE_URL, ADMIN_EMAIL, ...envOverrides };
  const domainChecks = [];
  const acceptsMail = async (domain) => {
    domainChecks.push(domain);
    return domain !== DOMAIN_WITHOUT_MAIL;
  };
  const handle = createHandler({ stores, catalog, mailer, acceptsMail, env, now: () => clock.ms });

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

  return { call, stores, catalog, mails, domainChecks, clock, env, registerAndApprove };
}
