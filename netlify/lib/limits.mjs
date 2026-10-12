/*
 * Rate limit por janela fixa guardado nas stores (função serverless não tem memória compartilhada).
 * Escrita condicional com até 3 tentativas; se houver disputa persistente falha fechado (bloqueia).
 */

const MAX_ATTEMPTS = 3;

export async function isBlocked(store, key, limit, nowMs) {
  const entry = await store.get(key);
  return Boolean(entry && entry.value.resetAt > nowMs && entry.value.count >= limit);
}

export async function increment(store, key, windowMs, nowMs) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const entry = await store.get(key);
    const fresh = !entry || entry.value.resetAt <= nowMs;
    const next = fresh ? { count: 1, resetAt: nowMs + windowMs } : { count: entry.value.count + 1, resetAt: entry.value.resetAt };
    const saved = entry ? await store.put(key, next, entry.etag) : await store.create(key, next);
    if (saved) return next.count;
  }
  return Number.MAX_SAFE_INTEGER;
}

export async function clear(store, key) {
  await store.del(key);
}
