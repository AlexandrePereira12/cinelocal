// Worker de DIAGNÓSTICO (descartável, separado do proxy): refaz a cadeia que o navegador percorre ao assistir um filme
// saindo da rede da Cloudflare e mostra, em cada passo, status e domínios referenciados. Serve para descobrir um host
// novo do player (acrescentar em ALLOWED_HOSTS do worker.js) e para provar se a Cloudflare alcança o provedor.
//
// Cadeia: 1) /embed/<tmdb> -> 2) ajax/get_stream_link (devolve o link do 2º player) -> 3) página do 2º player.
// Uso: https://<nome>.<conta>.workers.dev/?tmdb=550   (opcional: &referer=https://SEU-SITE-PUBLICADO/)

const PROVIDER = 'https://embedplayapi.top';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0 Safari/537.36';

const hostsIn = (text) => [...new Set([...text.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1].toLowerCase()))].sort();

async function step(name, url, headers) {
  const started = Date.now();
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, redirect: 'manual', signal: AbortSignal.timeout(25000) });
    const text = await res.text();
    return { step: { name, url, status: res.status, ms: Date.now() - started, bytes: text.length, location: res.headers.get('location'), hosts: hostsIn(text) }, text };
  } catch (err) {
    return { step: { name, url, erro: String(err), ms: Date.now() - started }, text: '' };
  }
}

export default {
  async fetch(request) {
    const params = new URL(request.url).searchParams;
    const tmdb = /^\d{1,9}$/.test(params.get('tmdb') ?? '') ? params.get('tmdb') : '550';
    const referer = params.get('referer') ?? `${PROVIDER}/`;
    const steps = [];

    const embed = await step('1 embed', `${PROVIDER}/embed/${tmdb}`, { Referer: referer });
    steps.push(embed.step);

    const movie = embed.text.match(/data-movie-id="([^"]+)"/)?.[1];
    const server = embed.text.match(/data-id="([^"]+)"[^>]*>[^<]*<span class="float-right status-dot/)?.[1];
    if (!movie || !server) {
      steps.push({ name: '2 get_stream_link', erro: `não achei movie/server no embed (movie=${movie}, server=${server})` });
      return Response.json({ saiuDoPonto: request.cf?.colo ?? null, tmdb, steps }, { headers: { 'Cache-Control': 'no-store' } });
    }

    const q = new URLSearchParams({ id: server, movie, is_init: 'false', captcha: '', ref: '' });
    const link = await step('2 get_stream_link', `${PROVIDER}/ajax/get_stream_link?${q}`, { Referer: `${PROVIDER}/embed/${tmdb}`, 'X-Requested-With': 'XMLHttpRequest' });
    steps.push({ ...link.step, resposta: link.text.slice(0, 160) });

    let target = null;
    try {
      const u = new URL(JSON.parse(link.text)?.data?.link);
      if (u.protocol === 'https:') target = u.href;
    } catch {
      /* sem link válido: o passo 3 não roda */
    }
    if (!target) steps.push({ name: '3 player final', erro: 'o provedor não devolveu um link https válido' });
    else steps.push((await step('3 player final', target, { Referer: `${PROVIDER}/` })).step);

    return Response.json({ saiuDoPonto: request.cf?.colo ?? null, tmdb, referer, steps }, { headers: { 'Cache-Control': 'no-store' } });
  },
};
