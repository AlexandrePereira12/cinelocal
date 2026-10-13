import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const text = (file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8');
const csp = async () => (await text('netlify.toml')).match(/Content-Security-Policy = "([^"]+)"/)[1];
const directive = (policy, name) => policy.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) ?? '';

test('o namespace do Cast é o mesmo no celular (app.js) e na TV (receiver.js)', async () => {
  const [app, receiver] = await Promise.all([text('public/app.js'), text('public/receiver.js')]);
  const ns = (source) => source.match(/urn:x-cast:[\w.-]+/)[0];
  assert.equal(ns(app), ns(receiver));
});

test('o receptor desliga o timeout de inatividade e só abre o player pelo TvPlayer', async () => {
  const receiver = await text('public/receiver.js');
  assert.match(receiver, /disableIdleTimeout:\s*true/);
  assert.match(receiver, /window\.TvPlayer\.show\(/);
  assert.ok(!/createElement\('iframe'\)/.test(receiver), 'o iframe é criado só em tv-player.js, que valida o endereço');
});

test('tv-player.js só aceita o player do provedor (origem e caminho)', async () => {
  const player = await text('public/tv-player.js');
  assert.match(player, /EMBED_ORIGIN = 'https:\/\/embedplayapi\.top'/);
  assert.match(player, /url\.origin === EMBED_ORIGIN/);
  assert.match(player, /indexOf\('\/embed\/'\) === 0/);
});

test('as páginas da TV não têm script nem estilo inline (a CSP bloquearia) e carregam tv-player antes dos outros', async () => {
  for (const file of ['public/tv.html', 'public/receiver.html']) {
    const html = await text(file);
    assert.ok(!/<script(?![^>]*\ssrc=)/i.test(html), `${file}: script inline`);
    assert.ok(!/<style\b/i.test(html) && !/\sstyle=/i.test(html), `${file}: estilo inline`);
    assert.ok(html.indexOf('tv-player.js') > -1 && html.indexOf('tv-player.js') < html.indexOf(file.includes('receiver') ? 'receiver.js' : 'tv.js"'), `${file}: tv-player.js deve vir antes`);
  }
  assert.match(await text('public/receiver.html'), /src="https:\/\/www\.gstatic\.com\/cast\/sdk\/libs\/caf_receiver\/v3\/cast_receiver_framework\.js"/);
});

test('a CSP libera só o que o Cast pediu (gstatic, Shaka e o canal local do Chromecast), sem extensões', async () => {
  const policy = await csp();
  const script = directive(policy, 'script-src');
  assert.match(script, /https:\/\/www\.gstatic\.com/);
  assert.match(script, /https:\/\/ajax\.googleapis\.com/);
  assert.ok(!script.includes('chrome-extension'), 'o SDK real não pediu extensão do Chrome');
  assert.ok(!script.includes("'unsafe-inline'") && !script.includes("'unsafe-eval'"));
  assert.equal(directive(policy, 'connect-src'), "connect-src 'self' ws://localhost:8008");
  assert.ok(!script.includes('*') && !directive(policy, 'connect-src').includes('*'), 'sem curinga');
});

test('.env.example documenta CAST_APP_ID e a URL exata do receptor a registrar no Google', async () => {
  const env = await text('.env.example');
  assert.match(env, /^CAST_APP_ID=$/m);
  assert.match(env, /https:\/\/SEU-SITE\/receiver\.html/);
});

test('o ícone do cabeçalho do painel da TV e o painel não carregam nada do Google sem App ID', async () => {
  const app = await text('public/app.js');
  // o SDK só é pedido dentro de castContext(), depois de o servidor devolver um App ID
  const body = app.slice(app.indexOf('async function castContext()'));
  assert.ok(body.indexOf('if (!appId') < body.indexOf('loadCastSdk()'), 'sem App ID não pode carregar o SDK');
  assert.ok(!/<script[^>]*gstatic/.test(await text('public/index.html')), 'index.html não pode carregar o SDK direto');
});
