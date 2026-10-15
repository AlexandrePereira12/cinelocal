'use strict';

/*
 * Service worker: existe para o navegador oferecer a instalação do app, para mostrar a página "sem conexão" quando uma
 * navegação falha por falta de rede e para guardar os pôsteres do TMDB.
 *
 * Decisões:
 * - Fora os pôsteres, só guarda offline.html e style.css, usados apenas como último recurso. A API e as telas nunca vêm
 *   do cache: o catálogo e a sessão são do usuário, e dado velho (ou de outra conta) seria pior que um aviso.
 * - Tudo que não for navegação, o style.css nem pôster segue direto para a rede, sem passar por aqui.
 * - Pôsteres (image.tmdb.org/t/p/...): cache primeiro, rede só quando ainda não há cópia. Não é stale-while-revalidate
 *   de propósito: o caminho de cada imagem do TMDB é um arquivo que não muda (se o pôster troca, o caminho troca) e o
 *   CDN já manda cache de 1 ano, então revalidar só gastaria rede e reescreveria o cache à toa. Imagens não têm dado do
 *   usuário, por isso podem ficar guardadas.
 * - O TMDB não manda cabeçalho CORS, então a resposta do <img> é "opaca" (status 0): dá para guardar, mas ela esconde o
 *   status. Duas consequências, medidas no Chrome:
 *   1) cada resposta opaca conta ~7,6 MB na cota de armazenamento do site (padding), embora ocupe uns 40 KB em disco:
 *      150 pôsteres contaram 1,17 GB de uma cota de 9 GiB. Por isso o teto é POSTER_MAX (as mais antigas saem primeiro);
 *   2) um 404/429/5xx também fica opaco e seria guardado como se fosse a imagem, e o cache primeiro serviria o erro
 *      para sempre. Por isso o cache de pôsteres inteiro é descartado a cada POSTER_TTL_MS (as imagens voltam do cache
 *      HTTP do navegador, que o CDN do TMDB deixa valer 1 ano, então refazer é barato). A data da última limpeza fica
 *      no cache offline, fora do cache de pôsteres, para o teto não apagá-la.
 *   Qualquer falha ao gravar (cota cheia, modo privado) é ignorada: o pôster aparece igual, só não fica guardado.
 * - Trocar o nome de um cache (CACHE, POSTERS) descarta a cópia antiga no próximo `activate`.
 */

const CACHE = 'cine-offline-v1';
const POSTERS = 'cine-posters-v1';
const POSTER_PREFIX = 'https://image.tmdb.org/t/p/';
const POSTER_MAX = 60;
const POSTER_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const STAMP_URL = '/__posters-desde'; // chave interna (nunca é requisitada), no cache offline
const STAMP_RECHECK_MS = 60 * 60 * 1000;
let stampCheckedAt = 0;
const OFFLINE_URL = '/offline.html';
const STYLE_URL = '/style.css';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll([OFFLINE_URL, STYLE_URL]))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key !== CACHE && key !== POSTERS) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

function fallbackFor(request) {
  if (request.mode === 'navigate') return OFFLINE_URL;
  const url = new URL(request.url);
  return url.origin === self.location.origin && url.pathname === STYLE_URL ? STYLE_URL : null;
}

const isPoster = (request) => request.method === 'GET' && request.destination === 'image' && request.url.startsWith(POSTER_PREFIX);

// Grava o pôster e mantém só os POSTER_MAX mais recentes (`keys()` vem na ordem em que foram gravados).
async function storePoster(cache, request, response) {
  try {
    await cache.put(request, response);
    const keys = await cache.keys();
    for (const key of keys.slice(0, Math.max(0, keys.length - POSTER_MAX))) await cache.delete(key);
  } catch {
    /* cota cheia ou armazenamento indisponível: o pôster já foi entregue, só não fica guardado */
  }
}

// Abre o cache de pôsteres, esvaziando-o antes se a última limpeza passou de POSTER_TTL_MS (ou nunca houve).
async function posterCache() {
  if (Date.now() - stampCheckedAt > STAMP_RECHECK_MS) {
    const meta = await caches.open(CACHE);
    const stamp = await meta.match(STAMP_URL);
    const age = stamp ? Date.now() - Number(await stamp.text()) : Infinity;
    if (!(age < POSTER_TTL_MS)) {
      await caches.delete(POSTERS);
      await meta.put(STAMP_URL, new Response(String(Date.now())));
    }
    stampCheckedAt = Date.now();
  }
  return caches.open(POSTERS);
}

async function poster(event) {
  const cache = await posterCache();
  const cached = await cache.match(event.request);
  if (cached) return cached;
  const response = await fetch(event.request);
  if (response.ok || response.type === 'opaque') event.waitUntil(storePoster(cache, event.request, response.clone()));
  return response;
}

self.addEventListener('fetch', (event) => {
  if (isPoster(event.request)) {
    event.respondWith(poster(event));
    return;
  }
  const fallback = fallbackFor(event.request);
  if (!fallback) return;
  event.respondWith(fetch(event.request).catch(async () => (await caches.match(fallback)) ?? Response.error()));
});
