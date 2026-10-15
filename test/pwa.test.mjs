import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const ROOT = new URL('../', import.meta.url);
const read = (file) => readFile(new URL(file, ROOT));
const text = async (file) => (await read(file)).toString('utf8');

const manifest = JSON.parse(await text('public/manifest.webmanifest'));

function pngSize(buffer) {
  assert.equal(buffer.subarray(1, 4).toString(), 'PNG', 'não é PNG');
  return `${buffer.readUInt32BE(16)}x${buffer.readUInt32BE(20)}`;
}

test('manifest tem o necessário para o navegador oferecer a instalação', () => {
  assert.equal(manifest.name, 'Cine Local');
  assert.ok(manifest.short_name);
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.background_color && manifest.theme_color);

  const png = manifest.icons.filter((icon) => icon.type === 'image/png');
  assert.ok(png.some((icon) => icon.sizes === '192x192' && icon.purpose === 'any'));
  assert.ok(png.some((icon) => icon.sizes === '512x512' && icon.purpose === 'any'));
  assert.ok(png.some((icon) => icon.sizes === '512x512' && icon.purpose === 'maskable'));
});

test('cada ícone do manifest existe e tem o tamanho declarado', async () => {
  for (const icon of manifest.icons) {
    const file = await read(`public/${icon.src}`);
    if (icon.type === 'image/png') assert.equal(pngSize(file), icon.sizes, icon.src);
    else assert.match(file.toString('utf8'), /<svg\b/, icon.src);
  }
});

test('o ícone da Apple existe com 180x180', async () => {
  assert.equal(pngSize(await read('public/icons/apple-touch-icon.png')), '180x180');
});

test('index.html liga o manifest, o ícone da Apple e põe o botão de download no fim do cabeçalho', async () => {
  const html = await text('public/index.html');
  assert.match(html, /<link rel="manifest" href="manifest\.webmanifest">/);
  assert.match(html, /<link rel="apple-touch-icon" href="icons\/apple-touch-icon\.png">/);
  assert.match(html, /<meta name="theme-color" content="#0b0b10">/);
  assert.match(html, /<button class="install-app" id="install-app" type="button" aria-label="Baixar o app"/);
  const user = html.match(/<div class="user" id="user">([\s\S]*?)<\/div>/)[1];
  assert.ok(user.lastIndexOf('id="install-app"') > user.lastIndexOf('id="logout"'), 'o ícone deve vir depois do botão Sair, no fim do cabeçalho');
});

test('a CSP libera manifest e service worker só da própria origem', async () => {
  const toml = await text('netlify.toml');
  const csp = toml.match(/Content-Security-Policy = "([^"]+)"/)[1];
  assert.match(csp, /manifest-src 'self'(;|$)/);
  assert.match(csp, /worker-src 'self'(;|$)/);
});

test('service worker só usa a rede para API e telas: cacheia a página offline, o CSS e os pôsteres do TMDB', async () => {
  const sw = await text('public/sw.js');
  assert.match(sw, /addEventListener\('fetch'/, 'sem fetch handler o navegador não oferece a instalação');
  assert.ok(!sw.includes('/api'), 'o service worker não pode tocar na API');
  assert.match(sw, /cache\.addAll\(\[OFFLINE_URL, STYLE_URL\]\)/);
  assert.equal((sw.match(/cache\.put\(/g) ?? []).length, 1, 'a única gravação vinda da rede é a do pôster');
  assert.match(sw, /POSTER_PREFIX = 'https:\/\/image\.tmdb\.org\/t\/p\/'/);
  assert.match(sw, /request\.destination === 'image'/, 'só imagem entra no cache de pôsteres');
});

test('a CSP libera o TMDB no connect-src: o fetch do service worker obedece a ele e, sem isso, todo pôster quebra em silêncio', async () => {
  const csp = (await text('netlify.toml')).match(/Content-Security-Policy = "([^"]+)"/)[1];
  assert.match(csp, /connect-src[^;]*https:\/\/image\.tmdb\.org/);
  assert.match(csp, /img-src[^;]*https:\/\/image\.tmdb\.org/);
});

class FakeResponse {
  constructor(body) {
    this.body = body;
  }

  async text() {
    return this.body;
  }

  static error() {
    return { error: true };
  }
}

// Roda o sw.js de verdade num contexto isolado, com caches e rede falsos, e dispara os eventos como o navegador faria.
async function loadWorker({ quotaFull = false } = {}) {
  const { runInNewContext } = await import('node:vm');
  const handlers = {};
  const stores = new Map();
  const network = [];
  let netStatus = { ok: true, type: 'opaque' };
  const makeCache = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const map = stores.get(name);
    return {
      map,
      async addAll() {},
      async match(request) {
        return map.get(request.url ?? request);
      },
      async put(request, response) {
        if (quotaFull && name === 'cine-posters-v1') throw new Error('QuotaExceededError');
        map.set(request.url ?? request, response);
      },
      async keys() {
        return [...map.keys()].map((url) => ({ url }));
      },
      async delete(key) {
        return map.delete(key.url);
      },
    };
  };
  const context = {
    self: { addEventListener: (type, fn) => (handlers[type] = fn), location: { origin: 'https://cine.exemplo.invalid' }, skipWaiting: async () => {}, clients: { claim: async () => {} } },
    caches: {
      open: async (name) => makeCache(name),
      keys: async () => [...stores.keys()],
      delete: async (name) => stores.delete(name),
      match: async (url) => [...stores.values()].map((map) => map.get(url)).find(Boolean),
    },
    fetch: async (request) => {
      network.push(request.url);
      return { ...netStatus, url: request.url, clone() { return { ...this }; } };
    },
    URL,
    Response: FakeResponse,
  };
  runInNewContext(await text('public/sw.js'), context);
  const fire = async (request) => {
    const event = { request, waits: [], responded: undefined, respondWith(promise) { this.responded = promise; }, waitUntil(promise) { this.waits.push(promise); } };
    handlers.fetch(event);
    const response = event.responded ? await event.responded : undefined;
    await Promise.all(event.waits);
    return { intercepted: Boolean(event.responded), response };
  };
  return { handlers, stores, network, fire, setNet: (next) => (netStatus = next) };
}

const poster = (path) => ({ url: `https://image.tmdb.org/t/p/w342/${path}.jpg`, method: 'GET', destination: 'image', mode: 'no-cors' });

test('service worker: pôster vai à rede uma vez, fica guardado e depois vem do cache', async () => {
  const sw = await loadWorker();
  const first = await sw.fire(poster('a'));
  assert.equal(first.intercepted, true);
  assert.deepEqual(sw.network, ['https://image.tmdb.org/t/p/w342/a.jpg']);
  assert.ok(sw.stores.get('cine-posters-v1').has('https://image.tmdb.org/t/p/w342/a.jpg'), 'resposta opaca (status 0) também é guardada');

  const second = await sw.fire(poster('a'));
  assert.equal(second.intercepted, true);
  assert.equal(sw.network.length, 1, 'a segunda vez não vai à rede (cache primeiro, sem revalidar)');
});

test('service worker: resposta com erro não é guardada, e o teto descarta os pôsteres mais antigos', async () => {
  const sw = await loadWorker();
  sw.setNet({ ok: false, type: 'basic', status: 404 });
  await sw.fire(poster('quebrado'));
  assert.equal(sw.stores.get('cine-posters-v1').size, 0, 'um 404 legível não vira cópia para sempre');

  sw.setNet({ ok: true, type: 'opaque' });
  for (let i = 0; i < 160; i++) await sw.fire(poster(`p${i}`));
  const kept = [...sw.stores.get('cine-posters-v1').keys()];
  assert.equal(kept.length, 60, 'o teto é baixo de propósito: cada resposta opaca conta ~7,6 MB na cota do site');
  assert.ok(!kept.some((url) => url.endsWith('/p0.jpg')) && kept.some((url) => url.endsWith('/p159.jpg')), 'saem os mais antigos');
});

test('service worker: o cache de pôsteres é esvaziado depois de 7 dias (um erro opaco não fica preso para sempre)', async () => {
  const DAY = 24 * 60 * 60 * 1000;
  const stamp = (daysAgo) => new Map([['/__posters-desde', new FakeResponse(String(Date.now() - daysAgo * DAY))]]);

  // limpeza recente: o que já estava guardado continua valendo
  const recent = await loadWorker();
  recent.stores.set('cine-offline-v1', stamp(2));
  recent.stores.set('cine-posters-v1', new Map([['https://image.tmdb.org/t/p/w342/velho.jpg', { cached: true }]]));
  assert.deepEqual((await recent.fire(poster('velho'))).response, { cached: true });
  assert.equal(recent.network.length, 0, 'veio do cache, sem rede');

  // passou de 7 dias: esvazia, busca de novo e renova a data
  const old = await loadWorker();
  old.stores.set('cine-offline-v1', stamp(8));
  old.stores.set('cine-posters-v1', new Map([['https://image.tmdb.org/t/p/w342/velho.jpg', { cached: 'erro opaco guardado' }]]));
  const { response } = await old.fire(poster('velho'));
  assert.equal(response.type, 'opaque', 'foi à rede de novo');
  assert.deepEqual(old.network, ['https://image.tmdb.org/t/p/w342/velho.jpg']);
  const renewed = Number(await old.stores.get('cine-offline-v1').get('/__posters-desde').text());
  assert.ok(Date.now() - renewed < 5000, 'a data da limpeza foi renovada');

  // nunca houve limpeza (primeira vez): grava a data sem perder nada que a rede devolva
  const first = await loadWorker();
  await first.fire(poster('a'));
  assert.ok(first.stores.get('cine-offline-v1').has('/__posters-desde'));
  assert.ok(first.stores.get('cine-posters-v1').has('https://image.tmdb.org/t/p/w342/a.jpg'));
});

test('service worker: cota cheia não impede o pôster de aparecer', async () => {
  const sw = await loadWorker({ quotaFull: true });
  const { response } = await sw.fire(poster('a'));
  assert.equal(response.type, 'opaque', 'o pôster foi entregue mesmo sem conseguir guardar');
});

test('service worker: só intercepta pôster do TMDB, navegação e o CSS; API e outras imagens seguem direto para a rede', async () => {
  const sw = await loadWorker();
  const origin = 'https://cine.exemplo.invalid';
  const ignored = [
    { url: `${origin}/api/list/trending-movies`, method: 'GET', destination: '', mode: 'cors' },
    { url: `${origin}/api/me/library`, method: 'GET', destination: '', mode: 'cors' },
    { url: `${origin}/app.js`, method: 'GET', destination: 'script', mode: 'no-cors' },
    { url: 'https://outro.exemplo.invalid/t/p/w342/a.jpg', method: 'GET', destination: 'image', mode: 'no-cors' },
    { url: 'https://image.tmdb.org/t/p/w342/a.jpg', method: 'POST', destination: 'image', mode: 'no-cors' },
    { url: 'https://image.tmdb.org/t/p/w342/a.jpg', method: 'GET', destination: '', mode: 'cors' },
  ];
  for (const request of ignored) assert.equal((await sw.fire(request)).intercepted, false, `${request.method} ${request.url}`);
  assert.equal((await sw.fire({ url: `${origin}/`, method: 'GET', destination: 'document', mode: 'navigate' })).intercepted, true, 'navegação tem a página offline de reserva');
  assert.equal((await sw.fire({ url: `${origin}/style.css`, method: 'GET', destination: 'style', mode: 'no-cors' })).intercepted, true);
  assert.deepEqual([...sw.stores.get('cine-posters-v1')?.keys() ?? []], [], 'nada além de pôster entra no cache de pôsteres');
});

test('service worker: ao ativar, apaga caches antigos mas mantém o offline e o de pôsteres', async () => {
  const sw = await loadWorker();
  for (const name of ['cine-offline-v1', 'cine-posters-v1', 'cine-offline-v0', 'outro']) await sw.stores.set(name, new Map());
  let done;
  sw.handlers.activate({ waitUntil: (promise) => (done = promise) });
  await done;
  assert.deepEqual([...sw.stores.keys()].sort(), ['cine-offline-v1', 'cine-posters-v1']);
});

test('offline.html não depende de script nem estilo inline (a CSP bloquearia)', async () => {
  const html = await text('public/offline.html');
  assert.ok(!/<script\b/i.test(html));
  assert.ok(!/<style\b/i.test(html));
  assert.ok(!/\sstyle=/i.test(html));
  assert.match(html, /href="\/style\.css"/);
});

test('app.js registra o service worker e instala direto pelo prompt nativo ou abre o passo a passo', async () => {
  const app = await text('public/app.js');
  assert.match(app, /serviceWorker\.register\('\/sw\.js'\)/);
  assert.match(app, /addEventListener\('beforeinstallprompt'/);
  assert.match(app, /function openInstallDialog\(\)/);
  assert.ok(!app.includes("'#/app'"), 'a página #/app foi substituída pelo painel');
});
