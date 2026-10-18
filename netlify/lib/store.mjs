/*
 * Adaptador fino sobre o Netlify Blobs. O handler só conhece esta interface
 * (get/create/put/del), o que permite testar com uma store em memória.
 *
 * Decisões:
 * - Consistência forte: com a padrão (eventual, até 60 s) quem acabou de ser aprovado não entraria
 *   e o rate limit vazaria.
 * - `create` usa onlyIfNew e `put` aceita etag (onlyIfMatch): escritas condicionais evitam
 *   cadastro duplicado e perda de atualização concorrente.
 */

import { getStore } from '@netlify/blobs';

function wrap(store) {
  return {
    async get(key) {
      const found = await store.getWithMetadata(key, { type: 'json' });
      return found ? { value: found.data, etag: found.etag } : null;
    },
    async create(key, value) {
      return (await store.setJSON(key, value, { onlyIfNew: true })).modified;
    },
    async put(key, value, etag) {
      return (await store.setJSON(key, value, etag ? { onlyIfMatch: etag } : {})).modified;
    },
    async del(key) {
      await store.delete(key);
    },
  };
}

export function blobsStores() {
  const open = (name) => wrap(getStore({ name, consistency: 'strong' }));
  return { users: open('users'), library: open('library'), limits: open('limits'), tv: open('tv'), requests: open('requests') };
}
