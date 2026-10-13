'use strict';

/*
 * Service worker mínimo: existe para o navegador oferecer a instalação do app e para mostrar a página
 * "sem conexão" quando uma navegação falha por falta de rede.
 *
 * Decisões:
 * - Só guarda offline.html e style.css, usados apenas como último recurso. A API e as telas nunca vêm do
 *   cache: o catálogo e a sessão são do usuário, e dado velho (ou de outra conta) seria pior que um aviso.
 * - Tudo que não for navegação nem o style.css segue direto para a rede, sem passar por aqui.
 * - Trocar o nome do cache (CACHE) descarta a cópia antiga no próximo `activate`.
 */

const CACHE = 'cine-offline-v1';
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
        if (key !== CACHE) await caches.delete(key);
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

self.addEventListener('fetch', (event) => {
  const fallback = fallbackFor(event.request);
  if (!fallback) return;
  event.respondWith(fetch(event.request).catch(async () => (await caches.match(fallback)) ?? Response.error()));
});
