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

test('service worker só usa a rede para API e telas: cacheia apenas a página offline e o CSS', async () => {
  const sw = await text('public/sw.js');
  assert.match(sw, /addEventListener\('fetch'/, 'sem fetch handler o navegador não oferece a instalação');
  assert.ok(!sw.includes('/api'), 'o service worker não pode tocar na API');
  assert.match(sw, /cache\.addAll\(\[OFFLINE_URL, STYLE_URL\]\)/);
  assert.ok(!/cache\.put\(/.test(sw), 'nenhuma resposta da rede é gravada no cache');
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
