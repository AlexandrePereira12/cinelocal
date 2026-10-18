import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

// Testes estáticos do front (app.js é script de navegador, sem exports): travam as peças que, se alguém mexer,
// quebram em silêncio. O comportamento em si só se prova num navegador.
const text = (file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8');
const app = await text('public/app.js');
const css = await text('public/style.css');

test('rotas novas (sorteio e pedidos) estão no roteador e o sorteio no menu', async () => {
  assert.match(app, /hash === '#\/sorteio'[\s\S]{0,120}renderSurprise\(params, token\)/);
  assert.match(app, /hash === '#\/pedidos'[\s\S]{0,120}renderRequests\(params, token\)/);
  assert.match(await text('public/index.html'), /<a href="#\/sorteio" data-route="surprise">/);
  assert.match(app, /href: '#\/sorteio'/, 'a home leva ao sorteio');
});

test('a API consumida pelo front segue o contrato (rotas e campos)', () => {
  for (const route of ['me/surprise?', "'me/requests'", "'me/requests/cancel'", "'me/rating-limit'", "'me/library'"]) {
    assert.ok(app.includes(route), `falta chamar ${route}`);
  }
  assert.match(app, /already_in_catalog/, '409 do pedido não é erro vermelho');
  assert.match(app, /wrong_password/);
  assert.match(app, /item\.fresh/, 'selo de novo episódio');
  assert.match(app, /SURPRISE_SKIP_MAX = 40/);
});

test('próximo episódio: sem avanço por timer, com tecla N que ignora campos de formulário', () => {
  const watch = app.slice(app.indexOf('async function renderWatch('), app.indexOf('// --- sorteio'));
  assert.ok(!/setTimeout|setInterval/.test(watch), 'não existe auto-avanço por tempo: o embed não avisa quando o episódio acaba');
  assert.match(watch, /Terminou\?/);
  assert.match(watch, /Terminei a série/);
  const hotkey = app.slice(app.indexOf("document.addEventListener('keydown'"), app.indexOf('async function renderWatch('));
  assert.match(hotkey, /event\.key !== 'n' && event\.key !== 'N'/);
  assert.match(hotkey, /input, select, textarea/);
  assert.match(hotkey, /event\.repeat/);
  assert.match(app, /watchGuard = null;\s+watchHotkey = null;/, 'sair da tela solta o atalho');
});

test('applyProfile não zera o limite do modo família quando o perfil vem sem a chave', () => {
  assert.match(app, /if \('maxRating' in profile\) session\.maxRating = profile\.maxRating \?\? null;/);
});

test('afrouxar o modo família exige senha e ela só é enviada nesse caso', () => {
  const family = app.slice(app.indexOf('function familySection('), app.indexOf('async function renderAccount('));
  assert.match(family, /const loosens = \(\) => current !== null && \(chosen\(\) === null \|\| chosen\(\) > current\)/);
  assert.match(family, /needsPassword \? \{ max, password: passInput\.value \} : \{ max \}/);
});

test('CSP: o front não usa atributo style nem script inline nas telas novas', async () => {
  assert.ok(!/\bstyle: /.test(app.replace(/\/\/.*$/gm, '')), 'atributo style via el() seria bloqueado pela CSP');
  assert.ok(!/<style\b|\sstyle=|<script>/i.test(await text('public/index.html')));
});

test('elementos com atributo hidden que ganham display no CSS têm regra [hidden]', () => {
  for (const selector of ['.next-card', '.field', '.request-found']) {
    assert.ok(css.includes(`${selector}[hidden] { display: none; }`), `${selector}[hidden]`);
  }
});

test('o service worker continua sem tocar nas rotas novas (são rotas de hash e chamadas da API)', async () => {
  const sw = await text('public/sw.js');
  assert.ok(!/sorteio|pedidos|\/api/.test(sw));
});
