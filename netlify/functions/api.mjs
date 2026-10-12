/*
 * Entrada da Netlify Function: liga o handler às dependências reais (Blobs, Resend, upstream).
 * Variáveis de ambiente (UI do Netlify, escopo Functions, marcadas como secret): ver .env.example.
 * Código compartilhado fica em netlify/lib/ — qualquer arquivo no topo de netlify/functions/ vira uma função.
 */

import { createCatalog } from '../lib/catalog.mjs';
import { createHandler } from '../lib/handler.mjs';
import { createMailer } from '../lib/mailer.mjs';
import { blobsStores } from '../lib/store.mjs';

let handler;

export default async (req, context) => {
  handler ??= createHandler({
    stores: blobsStores(),
    catalog: createCatalog(),
    mailer: createMailer(process.env),
    env: process.env,
  });
  return handler(req, context);
};

export const config = { path: '/api/*' };
