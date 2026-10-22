// Proxy reverso do player (RESERVA, não ativo): serve o player do provedor a partir da Cloudflare quando a rede do usuário
// não alcança os domínios dele. Ler README.md antes de ativar. Não é proxy aberto: só atende hosts da lista abaixo.
//
// Endereço: https://<worker>/<host>/<caminho>?<query>   ex.: /embedplayapi.top/embed/550

// Domínios do player. O provedor troca o 2º domínio sozinho (já foi embedplay.one, hoje embedplay.vip): quando o
// player falhar por um host novo, acrescente-o aqui (lista fechada de propósito; nunca aceitar host arbitrário).
const ALLOWED_HOSTS = new Set([
  'embedplayapi.top',
  'embedplay.vip',
  'www.embedplay.vip',
  'embedplay.one',
  'www.embedplay.one',
  'vidsrc.sh',
  'crn77.com',
  'tmdb.img.cinemaplay.top',
]);

const UA = 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0 Safari/537.36';
const TEXT_TYPE = /^(?:text\/|application\/(?:javascript|x-javascript|json|xml|vnd\.apple\.mpegurl|x-mpegurl|mpegurl)|audio\/mpegurl|[a-z]+\/[a-z.+-]*(?:json|xml))/i;
const TEXT_PATH = /\.(?:m3u8|js|json|css|vtt)$/i; // playlist HLS costuma vir como octet-stream
const NO_BODY = new Set([101, 204, 205, 304]);
const HEADERS_TIMEOUT_MS = 25000;
const HOP_HEADERS = ['content-length', 'content-encoding', 'transfer-encoding', 'connection', 'set-cookie', 'content-security-policy', 'content-security-policy-report-only', 'x-frame-options', 'report-to', 'nel'];

const fail = (status, message) => new Response(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });

// Reescreve para o proxy toda URL absoluta (ou sem protocolo) de host permitido, inclusive com barras escapadas de JSON
// (https:\/\/host) e com a porta padrão, e os caminhos iniciados em "/" em HTML (src/href/action/poster, com ou sem
// aspas), CSS (url(/x)) e playlists HLS (linha iniciada em /), que sem isso apontariam para a raiz do Worker.
// Limite: um caminho "/x" montado dentro de JavaScript em runtime não é visto aqui (o player atual usa BASE_URL absoluto).
function rewrite(text, proxy, host, kind) {
  const escapedProxy = proxy.replaceAll('/', '\\/');
  let out = text.replace(/(?:https?:)?(\\?\/\\?\/)([a-z0-9.-]+)(?::443)?(?![a-z0-9.-])/gi, (match, slashes, h) => {
    if (!ALLOWED_HOSTS.has(h.toLowerCase())) return match;
    return slashes.includes('\\') ? `${escapedProxy}\\/${h.toLowerCase()}` : `${proxy}/${h.toLowerCase()}`;
  });
  const prefix = `${proxy}/${host}/`;
  if (kind === 'html') out = out.replace(/\b(src|href|action|poster)=(["']?)\/(?!\/)/gi, `$1=$2${prefix}`);
  if (kind === 'html' || kind === 'css') out = out.replace(/url\((["']?)\/(?!\/)/gi, `url($1${prefix}`);
  if (kind === 'm3u8') out = out.replace(/^\/(?!\/)/gm, prefix);
  return out;
}

export default {
  async fetch(request, env) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return fail(405, 'método não permitido');

    const site = env.SITE_ORIGIN; // ex.: https://meu-site.netlify.app (sem barra no final)
    if (!site) return fail(500, 'SITE_ORIGIN não configurado');

    const self = new URL(request.url);
    const proxy = self.origin;

    // Porteiro contra uso por terceiros: a página-mãe tem de ser o site ou o próprio proxy (sub-recursos do player).
    // Referer é falsificável fora do navegador; isto só barra o uso casual, e o limite real é a lista de hosts.
    let refererOrigin = '';
    try {
      refererOrigin = new URL(request.headers.get('Referer') ?? '').origin;
    } catch {
      /* sem Referer */
    }
    if (refererOrigin !== site && refererOrigin !== proxy) return fail(403, 'origem não autorizada');

    const match = self.pathname.match(/^\/([a-z0-9.-]+)(\/.*)?$/i);
    const host = match?.[1].toLowerCase();
    if (!host || !ALLOWED_HOSTS.has(host)) return fail(404, 'host não permitido');
    const upstreamUrl = `https://${host}${match[2] ?? '/'}${self.search}`;

    // O provedor valida o Referer: no embed raiz vai o domínio do nosso site; nos demais, o do próprio provedor.
    const referer = host === 'embedplayapi.top' && refererOrigin === site ? `${site}/` : 'https://embedplayapi.top/';
    const headers = { 'User-Agent': UA, Referer: referer, Accept: request.headers.get('Accept') ?? '*/*', 'Accept-Language': request.headers.get('Accept-Language') ?? 'pt-BR,pt;q=0.9' };
    for (const name of ['Range', 'X-Requested-With']) if (request.headers.has(name)) headers[name] = request.headers.get(name);

    // Timeout só até chegarem os cabeçalhos: um abort depois cortaria no meio um vídeo longo repassado em stream.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEADERS_TIMEOUT_MS);
    let upstream;
    try {
      upstream = await fetch(upstreamUrl, { method: request.method, headers, redirect: 'manual', signal: controller.signal });
    } catch (err) {
      return fail(502, `provedor inacessível: ${err}`);
    } finally {
      clearTimeout(timer);
    }

    const out = new Headers(upstream.headers);
    for (const name of HOP_HEADERS) out.delete(name);
    // Só o site (e o próprio proxy, pai do 2º iframe do player) pode embutir; o do provedor (X-Frame-Options/CSP) foi removido acima porque apontava para o domínio dele.
    out.set('Content-Security-Policy', `frame-ancestors ${site} ${proxy}`);
    out.set('Referrer-Policy', 'origin');
    out.set('Cache-Control', 'no-store');

    const location = out.get('Location');
    if (location) {
      let next;
      try {
        next = new URL(location, upstreamUrl);
      } catch {
        return fail(502, 'redirecionamento inválido');
      }
      if (next.protocol !== 'https:') return fail(502, 'redirecionamento inválido');
      // Host fora da lista (ex.: CDN de mídia): o navegador segue direto, sem passar pelo proxy.
      out.set('Location', ALLOWED_HOSTS.has(next.hostname) ? `${proxy}/${next.hostname}${next.pathname}${next.search}` : next.href);
    }

    const type = upstream.headers.get('Content-Type') ?? '';
    const isText = TEXT_TYPE.test(type) || TEXT_PATH.test(match[2]?.split('?')[0] ?? '');
    if (request.method === 'HEAD' || NO_BODY.has(upstream.status) || upstream.body === null || !isText) {
      // Passagem direta: mantém o tamanho quando não há compressão no meio, para o player conseguir calcular duração e seek.
      if (upstream.headers.has('Content-Length') && !upstream.headers.has('Content-Encoding')) out.set('Content-Length', upstream.headers.get('Content-Length'));
      return new Response(NO_BODY.has(upstream.status) ? null : upstream.body, { status: upstream.status, headers: out });
    }

    const path = match[2] ?? '';
    const kind = /html/i.test(type) ? 'html' : /css/i.test(type) || /\.css$/i.test(path) ? 'css' : /mpegurl|\.m3u8$/i.test(type + path.split('?')[0]) ? 'm3u8' : 'text';
    const body = rewrite(await upstream.text(), proxy, host, kind);
    // O corpo foi relido como UTF-8 e mudou de tamanho: declara o charset real e desfaz a resposta parcial (206).
    out.set('Content-Type', `${type.split(';')[0] || 'text/plain'}; charset=utf-8`);
    out.delete('Content-Range');
    out.delete('Accept-Ranges');
    return new Response(body, { status: upstream.status === 206 ? 200 : upstream.status, headers: out });
  },
};
