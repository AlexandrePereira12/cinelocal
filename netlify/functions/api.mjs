/*
 * Entrada da Netlify Function: liga o handler às dependências reais (Blobs, Resend, catálogo empacotado).
 * Variáveis de ambiente (UI do Netlify, escopo Functions, marcadas como secret): ver .env.example.
 * Código compartilhado fica em netlify/lib/ — qualquer arquivo no topo de netlify/functions/ vira uma função.
 * O catálogo (netlify/data/catalogo.mjs) é importado como módulo para o esbuild empacotá-lo com a função.
 */

import catalogData from '../data/catalogo.mjs';
import { createCatalog } from '../lib/catalog.mjs';
import { createDomainChecker } from '../lib/email-domain.mjs';
import { createHandler } from '../lib/handler.mjs';
import { createMailer } from '../lib/mailer.mjs';
import { blobsStores } from '../lib/store.mjs';

let handler;

export default async (req, context) => {
  handler ??= createHandler({
    stores: blobsStores(),
    catalog: createCatalog({ data: catalogData }),
    mailer: createMailer(process.env),
    acceptsMail: createDomainChecker(),
    env: process.env,
  });
  return handler(req, context);
};

export const config = { path: '/api/*' };
