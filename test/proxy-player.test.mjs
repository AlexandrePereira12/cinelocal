import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../cloudflare/proxy-player/worker.js';

const SITE = 'https://meu-site.netlify.app';
const PROXY = 'https://proxy.exemplo.workers.dev';
const env = { SITE_ORIGIN: SITE };

function call(path, { referer = `${SITE}/`, method = 'GET', upstream } = {}) {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return upstream ?? new Response('ok', { headers: { 'Content-Type': 'text/plain' } });
  };
  const headers = referer ? { Referer: referer } : {};
  return worker
    .fetch(new Request(`${PROXY}${path}`, { method, headers }), env)
    .then((res) => ({ res, calls }))
    .finally(() => {
      globalThis.fetch = realFetch;
    });
}

test('recusa Referer de terceiros e requisição sem Referer, sem chamar o provedor', async () => {
  for (const referer of ['https://outro-site.com/', null]) {
    const { res, calls } = await call('/embedplayapi.top/embed/550', { referer });
    assert.equal(res.status, 403);
    assert.equal(calls.length, 0);
  }
});

test('só atende hosts da lista: nada de proxy aberto nem de endereço interno', async () => {
  for (const path of ['/example.com/', '/169.254.169.254/latest', '/localhost/', '/embedplayapi.top.evil.com/x']) {
    const { res, calls } = await call(path);
    assert.equal(res.status, 404, path);
    assert.equal(calls.length, 0);
  }
});

test('recusa métodos que mudam estado', async () => {
  const { res } = await call('/embedplayapi.top/embed/550', { method: 'POST' });
  assert.equal(res.status, 405);
});

test('no embed raiz o Referer enviado ao provedor é o do nosso site; nos demais, o do provedor', async () => {
  const raiz = await call('/embedplayapi.top/embed/550');
  assert.equal(raiz.calls[0].url, 'https://embedplayapi.top/embed/550');
  assert.equal(raiz.calls[0].init.headers.Referer, `${SITE}/`);
  const segundo = await call('/embedplay.vip/filme/tt0137523', { referer: `${PROXY}/embedplayapi.top/embed/550` });
  assert.equal(segundo.calls[0].init.headers.Referer, 'https://embedplayapi.top/');
});

test('reescreve URLs absolutas de hosts permitidos e caminhos iniciados em /, e deixa hosts desconhecidos como estão', async () => {
  const html = '<script src="/themes/a.js"></script><link href="https://embedplayapi.top/x.css"><iframe src="//embedplay.vip/f"></iframe><a href="https://cdn.jsdelivr.net/npm/x">';
  const { res } = await call('/embedplayapi.top/embed/550', { upstream: new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }) });
  const out = await res.text();
  assert.match(out, new RegExp(`src="${PROXY}/embedplayapi.top/themes/a.js"`));
  assert.match(out, new RegExp(`href="${PROXY}/embedplayapi.top/x.css"`));
  assert.match(out, new RegExp(`src="${PROXY}/embedplay.vip/f"`));
  assert.match(out, /href="https:\/\/cdn\.jsdelivr\.net\/npm\/x"/);
});

test('remove CSP/X-Frame-Options/cookies do provedor e só deixa o nosso site embutir', async () => {
  const upstream = new Response('x', { headers: { 'Content-Type': 'text/plain', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'", 'Set-Cookie': 'a=b' } });
  const { res } = await call('/embedplayapi.top/embed/550', { upstream });
  assert.equal(res.headers.get('x-frame-options'), null);
  assert.equal(res.headers.get('set-cookie'), null);
  assert.equal(res.headers.get('content-security-policy'), `frame-ancestors ${SITE} ${PROXY}`);
});

test('redireciona host permitido pelo proxy', async () => {
  const ok = await call('/embedplay.vip/', { upstream: new Response(null, { status: 301, headers: { Location: 'https://embedplay.one/filme/1' } }) });
  assert.equal(ok.res.status, 301);
  assert.equal(ok.res.headers.get('location'), `${PROXY}/embedplay.one/filme/1`);
  const ruim = await call('/embedplay.vip/', { upstream: new Response(null, { status: 302, headers: { Location: 'https://evil.com/' } }) });
  assert.equal(ruim.res.headers.get('location'), 'https://evil.com/');
});

test('conteúdo que não é texto (vídeo) passa sem ser lido nem alterado', async () => {
  const bytes = new Uint8Array([0, 1, 2, 255]);
  const { res } = await call('/vidsrc.sh/v.ts', { upstream: new Response(bytes, { headers: { 'Content-Type': 'video/mp2t' } }) });
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), bytes);
});

test('reescreve também URL com barras escapadas de JSON e com porta 443, sem mexer em host parecido', async () => {
  const json = '{"link":"https:\\/\\/embedplay.vip\\/filme\\/1","b":"https://embedplay.vip:443/x","c":"https://embedplay.vip.evil.com/y"}';
  const { res } = await call('/embedplayapi.top/ajax/get_stream_link', { upstream: new Response(json, { headers: { 'Content-Type': 'application/json' } }) });
  const out = await res.text();
  assert.ok(out.includes(`"${PROXY.replaceAll('/', '\\/')}\\/embedplay.vip\\/filme\\/1"`), out);
  assert.ok(out.includes(`"${PROXY}/embedplay.vip/x"`), out);
  assert.ok(out.includes('https://embedplay.vip.evil.com/y'), out);
});

test('CSP deixa o próprio proxy embutir (pai do 2º iframe) e playlist HLS e CSS têm caminhos / reescritos', async () => {
  const { res } = await call('/vidsrc.sh/p.m3u8', { upstream: new Response('#EXTM3U\n/seg1.ts\nhttps://crn77.com/seg2.ts\n', { headers: { 'Content-Type': 'application/octet-stream' } }) });
  assert.equal(res.headers.get('content-security-policy'), `frame-ancestors ${SITE} ${PROXY}`);
  assert.equal(await res.text(), `#EXTM3U\n${PROXY}/vidsrc.sh/seg1.ts\n${PROXY}/crn77.com/seg2.ts\n`);
  const css = await call('/embedplayapi.top/a.css', { upstream: new Response('a{background:url(/img/x.png)}', { headers: { 'Content-Type': 'text/css' } }) });
  assert.equal(await css.res.text(), `a{background:url(${PROXY}/embedplayapi.top/img/x.png)}`);
});

test('status sem corpo (204) e resposta parcial (206) de texto não quebram', async () => {
  const vazio = await call('/embedplayapi.top/ajax/played', { upstream: new Response(null, { status: 204, headers: { 'Content-Type': 'application/json' } }) });
  assert.equal(vazio.res.status, 204);
  const parcial = await call('/embedplayapi.top/a.js', { upstream: new Response('x', { status: 206, headers: { 'Content-Type': 'text/javascript', 'Content-Range': 'bytes 0-0/9' } }) });
  assert.equal(parcial.res.status, 200);
  assert.equal(parcial.res.headers.get('content-range'), null);
});

test('redirecionamento para CDN fora da lista segue direto, sem passar pelo proxy', async () => {
  const { res } = await call('/vidsrc.sh/v', { upstream: new Response(null, { status: 302, headers: { Location: 'https://cdn.exemplo.com/v.mp4' } }) });
  assert.equal(res.headers.get('location'), 'https://cdn.exemplo.com/v.mp4');
});
