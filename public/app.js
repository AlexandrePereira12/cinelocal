'use strict';

const HERO_ROTATE_MS = 8000;
const HERO_SIZE = 5;
const META_LIMIT = 400;
const SEARCH_CAP = 40; // igual a SEARCH_LIMIT do servidor (catalog.mjs): a busca para aqui, então avisamos
const TOKEN_KEY = 'cine.token';

const LIST_TITLES = {
  'new-this-week': 'Novidades da semana',
  'trending-movies': 'Filmes em alta',
  'trending-shows': 'Séries em alta',
  'top-movies': 'Mais avaliados',
  'recent-movies': 'Lançamentos',
  classics: 'Clássicos',
  'short-movies': 'Filmes até 90 min',
  'short-shows': 'Séries curtas',
  'library-movies': 'Filmes',
  'library-shows': 'Séries',
};

// Fileiras "de sempre" da home, na ordem em que aparecem. Fileira vazia (ex.: sem novidades) simplesmente não aparece.
const HOME_LISTS = ['new-this-week', 'trending-movies', 'trending-shows', 'top-movies', 'recent-movies', 'classics', 'short-movies', 'short-shows'];

// Faixas de ano dos filtros (busca e explorar): valor "de-até" e texto do seletor.
const YEAR_RANGES = [
  ['', 'Qualquer ano'],
  ['2020-2100', '2020 em diante'],
  ['2010-2019', '2010 a 2019'],
  ['2000-2009', '2000 a 2009'],
  ['1990-1999', '1990 a 1999'],
  ['1980-1989', '1980 a 1989'],
  ['1900-1979', 'Antes de 1980'],
];
const TYPE_OPTIONS = [
  ['all', 'Filmes e séries'],
  ['movie', 'Só filmes'],
  ['tv', 'Só séries'],
];
const RATING_OPTIONS = [
  ['', 'Qualquer nota'],
  ['6', 'Nota 6 ou mais'],
  ['7', 'Nota 7 ou mais'],
  ['8', 'Nota 8 ou mais'],
];

const app = document.getElementById('app');
const searchInput = document.getElementById('search');
const searchForm = document.getElementById('search-form');
const userName = document.getElementById('user-name');

document.getElementById('year').textContent = new Date().getFullYear();

let navToken = 0;
let heroTimer = null;
let flash = null;

// --- util ---

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.flat().filter((c) => c != null && c !== false));
  return node;
}

function posterUrl(file, size) {
  return file ? `https://image.tmdb.org/t/p/${size}${file}` : null;
}

function readStore(key) {
  try {
    return JSON.parse(localStorage.getItem(key)) || {};
  } catch {
    return {};
  }
}

function writeStore(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage indisponível: o app segue funcionando sem persistência */
  }
}

// --- sessão e API ---

const session = { token: null, name: null, genres: null, needsGenres: false };

try {
  session.token = localStorage.getItem(TOKEN_KEY);
} catch {
  /* sem storage: a sessão dura só até recarregar a página */
}

function clearSession(message) {
  session.token = null;
  session.name = null;
  session.genres = null;
  session.needsGenres = false;
  flash = message ?? null;
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem('cine.meta');
  } catch {
    /* ignora */
  }
  for (const key of Object.keys(meta)) delete meta[key];
  updateChrome();
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (session.token) headers.Authorization = `Bearer ${session.token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res;
  try {
    res = await fetch(`/api/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw Object.assign(new Error('sem conexão com o servidor'), { status: 0 });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && session.token) {
      clearSession('Sua sessão expirou. Entre de novo.');
      location.hash = '#/login';
    }
    throw Object.assign(new Error(data.error || `Erro ${res.status}`), { status: res.status, code: data.code });
  }
  return data;
}

// Perfil devolvido pelo servidor no login e em /auth/me: nome, gêneros favoritos e se ainda falta escolhê-los.
function applyProfile(profile) {
  session.name = profile.name;
  session.genres = profile.genres ?? null;
  session.needsGenres = Boolean(profile.needsGenres);
}

function updateChrome() {
  document.body.classList.toggle('anon', !session.token);
  document.body.classList.toggle('onboarding', Boolean(session.token && session.needsGenres));
  userName.textContent = session.name ?? '';
}

// Guarda título/pôster dos itens vistos para a página do player abrir por link direto.
const meta = readStore('cine.meta');

function remember(items) {
  for (const item of items) meta[`${item.type}:${item.id}`] = item;
  const keys = Object.keys(meta);
  for (const key of keys.slice(0, Math.max(0, keys.length - META_LIMIT))) delete meta[key];
  writeStore('cine.meta', meta);
}

function watchHref(item) {
  return `#/assistir/${item.type}/${item.id}`;
}

function detailHref(item) {
  return `#/titulo/${item.type}/${item.id}`;
}

// --- componentes ---

function spinner(text = 'Carregando…') {
  return el('div', { class: 'state' }, el('div', { class: 'spinner' }), text);
}

// Esqueletos: o formato da tela aparece na hora e o conteúdo entra no lugar (em vez de um círculo girando numa tela vazia).
const skeletonCard = () => el('div', { class: 'skeleton sk-card' });

function skeletonRow() {
  return el('div', { class: 'row' }, el('div', { class: 'skeleton sk-title' }), el('div', { class: 'row-scroll' }, Array.from({ length: 10 }, skeletonCard)));
}

function skeletonHome() {
  return el('div', { class: 'sk-page', 'aria-busy': 'true' }, el('span', { class: 'sr-only' }, 'Carregando…'), el('div', { class: 'skeleton sk-hero' }), skeletonRow(), skeletonRow());
}

function skeletonDetail() {
  return el(
    'div',
    { class: 'page sk-page', 'aria-busy': 'true' },
    el('span', { class: 'sr-only' }, 'Carregando…'),
    el('div', { class: 'detail-body' }, el('div', { class: 'skeleton sk-poster' }), el('div', { class: 'sk-text' }, el('div', { class: 'skeleton sk-title' }), el('div', { class: 'skeleton sk-line' }), el('div', { class: 'skeleton sk-line' }), el('div', { class: 'skeleton sk-line short' }))),
  );
}

function errorState(message, retry) {
  return el(
    'div',
    { class: 'state' },
    el('p', {}, `Não foi possível carregar: ${message}`),
    retry && el('button', { class: 'btn', type: 'button', onclick: retry }, 'Tentar de novo'),
  );
}

// Quem já tem histórico (item da biblioteca) abre direto no player, para retomar; o resto abre a tela de detalhe.
function card(item) {
  const src = posterUrl(item.poster, 'w342');
  const progressLabel = item.type === 'tv' && item.season != null ? `T${item.season} · E${item.episode}` : null;
  const poster = el(
    'div',
    { class: 'card-poster' },
    src
      ? el('img', { src, alt: '', loading: 'lazy', decoding: 'async' })
      : el('div', { class: 'card-fallback' }, item.title),
    item.type === 'tv' && el('span', { class: 'badge left type' }, progressLabel ?? 'Série'),
    item.rating != null && el('span', { class: 'badge right' }, `★ ${item.rating.toFixed(1)}`),
  );
  return el(
    'a',
    { class: 'card', href: item.lastViewedAt ? watchHref(item) : detailHref(item), title: item.title },
    poster,
    el('div', { class: 'card-title' }, item.title),
    item.year && el('div', { class: 'card-year' }, item.year),
  );
}

function row(title, items, href) {
  return el(
    'section',
    { class: 'row' },
    el('div', { class: 'row-head' }, el('h2', {}, title), href && el('a', { href }, 'Ver tudo')),
    el('div', { class: 'row-scroll' }, items.map(card)),
  );
}

function hero(items) {
  const bg = el('div', { class: 'hero-bg' });
  const tag = el('span', { class: 'hero-tag' }, 'Em alta');
  const title = el('h1');
  const info = el('p', { class: 'hero-meta' });
  const overview = el('p', { class: 'hero-overview' });
  const play = el('a', { class: 'btn primary' }, '▶ Assistir');
  const details = el('a', { class: 'btn' }, 'Detalhes');
  const poster = el('img', { class: 'hero-poster', alt: '' });
  const dots = el('div', { class: 'hero-dots' });
  const root = el(
    'section',
    { class: 'hero' },
    bg,
    el('div', { class: 'hero-shade' }),
    el('div', { class: 'hero-body' }, el('div', { class: 'hero-text' }, tag, title, info, overview, el('div', { class: 'hero-actions' }, play, details)), poster),
    dots,
  );

  let current = 0;
  let paused = false; // mouse em cima ou foco dentro: o destaque não troca debaixo de quem está lendo ou prestes a clicar
  const buttons = items.map((_, i) =>
    el('button', { type: 'button', 'aria-label': `Destaque ${i + 1}`, onclick: () => show(i, true) }),
  );
  dots.append(...buttons);

  function show(index, manual) {
    current = index;
    const item = items[index];
    // Com backdrop (imagem larga do TMDB) o fundo fica nítido; sem ele, usa o pôster ampliado com blur.
    bg.classList.toggle('sharp', Boolean(item.backdrop));
    bg.style.backgroundImage = `url("${item.backdrop ? posterUrl(item.backdrop, 'w1280') : posterUrl(item.poster, 'w780')}")`;
    poster.src = posterUrl(item.poster, 'w500');
    title.textContent = item.title;
    info.textContent = [item.year, item.rating != null && `★ ${item.rating.toFixed(1)}`, item.runtime && `${item.runtime} min`].filter(Boolean).join(' · ');
    overview.textContent = item.overview ?? '';
    play.href = watchHref(item);
    details.href = detailHref(item);
    buttons.forEach((b, i) => b.classList.toggle('on', i === index));
    if (manual) startRotation();
  }

  // Quem pede menos movimento no sistema (prefers-reduced-motion) não recebe troca automática: só pelos botões.
  function startRotation() {
    clearInterval(heroTimer);
    if (items.length > 1 && !paused && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      heroTimer = setInterval(() => show((current + 1) % items.length), HERO_ROTATE_MS);
    }
  }

  function pause() {
    paused = true;
    clearInterval(heroTimer);
  }

  function resume() {
    paused = false;
    startRotation();
  }

  root.addEventListener('mouseenter', pause);
  root.addEventListener('mouseleave', resume);
  root.addEventListener('focusin', pause);
  root.addEventListener('focusout', (event) => {
    if (!root.contains(event.relatedTarget)) resume();
  });

  show(0);
  startRotation();
  return root;
}

// --- formulários de login e cadastro ---

// Espelham netlify/lib/validate.mjs (validPassword e EMAIL_RE): quem decide é o servidor, aqui é só o aviso antes do envio.
const PASSWORD_RULES = [
  { label: 'Pelo menos 4 caracteres', test: (value) => value.length >= 4 },
  { label: 'Uma letra maiúscula', test: (value) => /\p{Lu}/u.test(value) },
  { label: 'Uma letra minúscula', test: (value) => /\p{Ll}/u.test(value) },
  { label: 'Um número', test: (value) => /[0-9]/.test(value) },
  { label: 'Um símbolo: @ _ ou .', test: (value) => /[@_.]/.test(value) },
];
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

function looksLikeEmail(value) {
  const email = value.trim().toLowerCase();
  return email.length <= 254 && EMAIL_RE.test(email);
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  mail: ['M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z', 'M22 6l-10 7L2 6'],
  lock: ['M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z', 'M7 11V7a5 5 0 0 1 10 0v4'],
  user: ['M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2', 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z'],
  eye: ['M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
  eyeOff: [
    'M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24',
    'M1 1l22 22',
  ],
  check: ['M20 6L9 17l-5-5'],
  play: ['M6 4l14 8-14 8z'],
  star: ['M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z'],
  bookmark: ['M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z'],
  tv: ['M4 7h16a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z', 'M17 2l-5 5-5-5'],
  x: ['M18 6L6 18', 'M6 6l12 12'],
};

// SVG inline montado por DOM (a CSP do site não aceita atributo style nem imagem de outra origem).
function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const d of ICONS[name]) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

function field(label, id, attrs, { iconName, trailing } = {}) {
  return el(
    'div',
    { class: 'field' },
    el('label', { for: id }, label),
    el(
      'div',
      { class: 'input-wrap' },
      el('span', { class: 'input-icon' }, icon(iconName)),
      el('input', { id, name: id, required: true, 'aria-describedby': `${id}-msg`, ...attrs }),
      trailing,
    ),
    el('p', { class: 'field-msg', id: `${id}-msg` }),
  );
}

// state: 'invalid' | 'valid' | null (neutro). O texto vai na linha logo abaixo do campo.
function setFieldState(root, state, text = '') {
  root.classList.toggle('invalid', state === 'invalid');
  root.classList.toggle('valid', state === 'valid');
  root.querySelector('.field-msg').textContent = text;
  root.querySelector('input').setAttribute('aria-invalid', String(state === 'invalid'));
}

function emailField(attrs) {
  return field(
    'E-mail',
    'email',
    { type: 'email', autocomplete: 'username', maxlength: '254', placeholder: 'voce@exemplo.com', inputmode: 'email', autocapitalize: 'off', spellcheck: 'false', ...attrs },
    { iconName: 'mail' },
  );
}

// Valida o formato enquanto digita: erro só depois de sair do campo (ou no envio), "ok" assim que o formato fecha.
function bindEmailValidation(root, { okText = '' } = {}) {
  const input = root.querySelector('input');
  let touched = false;
  function validate(strict = false) {
    const value = input.value.trim();
    const valid = looksLikeEmail(value);
    if (valid) setFieldState(root, 'valid', okText);
    else if (!value) setFieldState(root, strict ? 'invalid' : null, strict ? 'Informe o seu e-mail.' : '');
    else if (strict || touched) setFieldState(root, 'invalid', 'Digite um e-mail válido, como nome@exemplo.com.');
    else setFieldState(root, null);
    return valid;
  }
  input.addEventListener('input', () => validate());
  input.addEventListener('blur', () => {
    touched = true;
    validate();
  });
  return validate;
}

// Campo de senha com botão para mostrar/ocultar o que está sendo digitado e aviso de Caps Lock.
// `reveal: false` tira o botão de mostrar: a "senha atual" da troca de senha nunca deve aparecer na tela (ombro de quem passa, captura de tela).
function passwordField(label, id, attrs, { reveal = true } = {}) {
  const toggle = reveal ? el('button', { class: 'toggle-pass', type: 'button', 'aria-label': 'Mostrar senha', title: 'Mostrar senha' }, icon('eye')) : null;
  const root = field(
    label,
    id,
    { type: 'password', maxlength: '128', autocapitalize: 'off', spellcheck: 'false', ...attrs },
    { iconName: 'lock', trailing: toggle },
  );
  const input = root.querySelector('input');
  const caps = el('p', { class: 'field-hint', hidden: true }, 'Caps Lock ligado');
  root.append(caps);

  toggle?.addEventListener('click', () => {
    const show = input.type === 'password';
    const text = show ? 'Ocultar senha' : 'Mostrar senha';
    input.type = show ? 'text' : 'password';
    toggle.setAttribute('aria-label', text);
    toggle.title = text;
    toggle.replaceChildren(icon(show ? 'eyeOff' : 'eye'));
    input.focus();
  });
  const watchCaps = (event) => {
    caps.hidden = !event.getModifierState?.('CapsLock');
  };
  input.addEventListener('keydown', watchCaps);
  input.addEventListener('keyup', watchCaps);
  input.addEventListener('blur', () => {
    caps.hidden = true;
  });
  return root;
}

// Lista de requisitos que vai marcando enquanto digita, mais a barra de força (um segmento por requisito atendido).
function passwordChecklist(id) {
  const items = PASSWORD_RULES.map((rule) => el('li', {}, el('span', { class: 'rule-mark', 'aria-hidden': 'true' }), rule.label, el('span', { class: 'sr-only' }, ' (pendente)')));
  const meter = el('div', { class: 'meter', 'aria-hidden': 'true', 'data-score': '0' }, ...PASSWORD_RULES.map(() => el('span')));
  return {
    root: el('div', { class: 'rules-box' }, meter, el('ul', { class: 'rules', id }, ...items)),
    // Devolve true quando todos os requisitos foram atendidos.
    update(value) {
      let score = 0;
      PASSWORD_RULES.forEach((rule, index) => {
        const ok = rule.test(value);
        if (ok) score++;
        items[index].classList.toggle('ok', ok);
        items[index].lastChild.textContent = ok ? ' (atendido)' : ' (pendente)';
      });
      meter.dataset.score = String(score);
      return score === PASSWORD_RULES.length;
    },
  };
}

// Senha nova + repetição, com a lista de requisitos e a barra de força: cadastro, redefinição e troca de senha usam o mesmo bloco.
function newPasswordGroup({ label = 'Senha', passId = 'password', repeatId = 'password2', rulesId = 'password-rules' } = {}) {
  const passRoot = passwordField(label, passId, { autocomplete: 'new-password', 'aria-describedby': `${passId}-msg ${rulesId}` });
  const checklist = passwordChecklist(rulesId);
  const repeatRoot = passwordField('Repita a senha', repeatId, { autocomplete: 'new-password' });
  const passInput = passRoot.querySelector('input');
  const repeatInput = repeatRoot.querySelector('input');
  let repeatTouched = false;

  function checkPassword(strict = false) {
    const valid = checklist.update(passInput.value);
    if (strict && !valid) setFieldState(passRoot, 'invalid', 'A senha ainda não atende a todos os requisitos.');
    else setFieldState(passRoot, valid ? 'valid' : null);
    return valid;
  }

  function checkRepeat(strict = false) {
    const same = repeatInput.value === passInput.value;
    const valid = same && repeatInput.value !== '';
    if (valid) setFieldState(repeatRoot, 'valid', 'As senhas conferem.');
    else if (!repeatInput.value) setFieldState(repeatRoot, strict ? 'invalid' : null, strict ? 'Repita a senha.' : '');
    else if (strict || repeatTouched || repeatInput.value.length >= passInput.value.length) setFieldState(repeatRoot, 'invalid', 'As senhas não conferem.');
    else setFieldState(repeatRoot, null);
    return valid;
  }

  passInput.addEventListener('input', () => {
    checkPassword();
    if (repeatInput.value) checkRepeat();
  });
  repeatInput.addEventListener('input', () => checkRepeat());
  repeatInput.addEventListener('blur', () => {
    repeatTouched = true;
    if (repeatInput.value) checkRepeat();
  });

  return {
    nodes: [passRoot, checklist.root, repeatRoot],
    input: passInput,
    value: () => passInput.value,
    // Marca o que estiver errado e devolve o primeiro campo inválido (ou null se está tudo certo).
    firstInvalid() {
      const passOk = checkPassword(true);
      const repeatOk = checkRepeat(true);
      if (!passOk) return passInput;
      return repeatOk ? null : repeatInput;
    },
    reset() {
      passInput.value = '';
      repeatInput.value = '';
      repeatTouched = false;
      checkPassword();
      checkRepeat();
    },
  };
}

function setBusy(button, busy, label) {
  button.disabled = busy;
  button.setAttribute('aria-busy', String(busy));
  button.textContent = label;
}

const PERKS = [
  ['play', 'Filmes e séries num só lugar'],
  ['star', 'Recomendações pelos seus gêneros favoritos'],
  ['bookmark', 'Sua lista e o que você já assistiu'],
];

function cardHead(title, hint) {
  return [el('span', { class: 'auth-mark' }, icon('play')), el('h1', {}, title), hint && el('p', { class: 'auth-hint' }, hint)];
}

// Palco do login e do cadastro: fundo de "parede de pôsteres" decorativo, texto de apoio à esquerda e o cartão à direita.
function authStage({ title, lede }, slot) {
  const backdrop = el('div', { class: 'auth-backdrop', 'aria-hidden': 'true' }, ...Array.from({ length: 32 }, () => el('span')));
  const aside = el(
    'aside',
    { class: 'auth-aside' },
    el('h2', {}, ...title),
    el('p', { class: 'auth-lede' }, lede),
    el('ul', { class: 'auth-perks' }, ...PERKS.map(([name, text]) => el('li', {}, el('span', { class: 'perk-icon' }, icon(name)), text))),
  );
  return el('div', { class: 'auth-stage' }, backdrop, el('div', { class: 'auth-shell' }, aside, slot));
}

// --- páginas públicas: login, cadastro e decisão do admin ---

function renderLogin() {
  const message = el('p', { class: 'form-info', role: 'status' }, flash);
  flash = null;
  const error = el('p', { class: 'form-error', role: 'alert' });
  const submit = el('button', { class: 'btn primary block', type: 'submit' }, 'Entrar');
  const emailRoot = emailField();
  const checkEmail = bindEmailValidation(emailRoot);
  const passRoot = passwordField('Senha', 'password', { autocomplete: 'current-password' });

  const form = el(
    'form',
    {
      class: 'auth-card',
      novalidate: true,
      onsubmit: async (event) => {
        event.preventDefault();
        error.textContent = '';
        const { email, password } = form.elements;
        const emailOk = checkEmail(true);
        const passOk = Boolean(password.value);
        setFieldState(passRoot, passOk ? null : 'invalid', passOk ? '' : 'Informe a sua senha.');
        if (!emailOk || !passOk) {
          (emailOk ? password : email).focus();
          return;
        }
        setBusy(submit, true, 'Entrando…');
        try {
          const data = await api('auth/login', {
            method: 'POST',
            body: { email: email.value, password: password.value },
          });
          session.token = data.token;
          applyProfile(data.user);
          try {
            localStorage.setItem(TOKEN_KEY, data.token);
          } catch {
            /* sem storage: sessão só nesta aba */
          }
          updateChrome();
          location.hash = '#/';
        } catch (err) {
          error.textContent = err.message;
        } finally {
          setBusy(submit, false, 'Entrar');
        }
      },
    },
    ...cardHead('Entrar', 'Use o e-mail e a senha do seu cadastro.'),
    message,
    emailRoot,
    passRoot,
    el('a', { class: 'forgot-link', href: '#/esqueci' }, 'Esqueci minha senha'),
    error,
    submit,
    el('p', { class: 'auth-alt' }, 'Ainda não tem conta? ', el('a', { href: '#/cadastro' }, 'Solicitar cadastro')),
  );
  passRoot.querySelector('input').addEventListener('input', () => setFieldState(passRoot, null));
  app.replaceChildren(
    authStage({ title: ['Bem-vindo de ', el('em', {}, 'volta'), '.'], lede: 'Entre para continuar de onde parou e ver o que separamos para você.' }, el('div', { class: 'auth-slot' }, form)),
  );
  form.elements.email.focus();
}

function renderRegister() {
  const error = el('p', { class: 'form-error', role: 'alert' });
  const submit = el('button', { class: 'btn primary block', type: 'submit' }, 'Solicitar cadastro');
  const slot = el('div', { class: 'auth-slot' });

  const nameRoot = field('Nome', 'name', { type: 'text', autocomplete: 'name', maxlength: '60', placeholder: 'Como devemos te chamar?' }, { iconName: 'user' });
  const emailRoot = emailField();
  const checkEmail = bindEmailValidation(emailRoot, { okText: 'Formato válido' });
  const passwords = newPasswordGroup();

  const nameInput = nameRoot.querySelector('input');

  function checkName(strict = false) {
    const valid = nameInput.value.replace(/\s+/g, ' ').trim().length >= 2;
    setFieldState(nameRoot, !valid && strict ? 'invalid' : null, !valid && strict ? 'Informe o seu nome (2 a 60 caracteres).' : '');
    return valid;
  }

  nameInput.addEventListener('input', () => checkName());

  const form = el(
    'form',
    {
      class: 'auth-card',
      novalidate: true,
      onsubmit: async (event) => {
        event.preventDefault();
        error.textContent = '';
        const checks = [
          [nameInput, checkName(true)],
          [form.elements.email, checkEmail(true)],
        ];
        const passwordProblem = passwords.firstInvalid();
        const firstInvalid = checks.find(([, valid]) => !valid)?.[0] ?? passwordProblem;
        if (firstInvalid) {
          error.textContent = 'Corrija os campos destacados.';
          firstInvalid.focus();
          return;
        }
        setBusy(submit, true, 'Enviando…');
        try {
          const data = await api('auth/register', {
            method: 'POST',
            body: { name: nameInput.value, email: form.elements.email.value.trim(), password: passwords.value() },
          });
          slot.replaceChildren(
            el(
              'div',
              { class: 'auth-card' },
              el('span', { class: 'success-mark' }, icon('check')),
              el('h1', {}, 'Solicitação enviada'),
              el('p', { class: 'form-info', role: 'status' }, data.message),
              el('a', { class: 'btn primary block', href: '#/login' }, 'Ir para o login'),
            ),
          );
        } catch (err) {
          if (err.code === 'invalid_email_domain') {
            setFieldState(emailRoot, 'invalid', err.message);
            form.elements.email.focus();
          } else {
            error.textContent = err.message;
          }
          setBusy(submit, false, 'Solicitar cadastro');
        }
      },
    },
    ...cardHead('Solicitar cadastro', 'O acesso é liberado depois que o administrador aprovar o seu cadastro.'),
    nameRoot,
    emailRoot,
    ...passwords.nodes,
    error,
    submit,
    el('p', { class: 'auth-alt' }, 'Já tem conta? ', el('a', { href: '#/login' }, 'Entrar')),
  );
  slot.append(form);
  app.replaceChildren(
    authStage({ title: ['Peça o seu ', el('em', {}, 'acesso'), '.'], lede: 'Crie a sua conta em poucos passos. Assim que for aprovada, o catálogo completo é seu.' }, slot),
  );
  nameInput.focus();
}

// Pede o link de redefinição. A resposta é sempre a mesma, exista a conta ou não (o servidor não revela quem tem conta).
function renderForgot() {
  const error = el('p', { class: 'form-error', role: 'alert' });
  const submit = el('button', { class: 'btn primary block', type: 'submit' }, 'Enviar o link');
  const slot = el('div', { class: 'auth-slot' });
  const emailRoot = emailField();
  const checkEmail = bindEmailValidation(emailRoot);

  const form = el(
    'form',
    {
      class: 'auth-card',
      novalidate: true,
      onsubmit: async (event) => {
        event.preventDefault();
        error.textContent = '';
        if (!checkEmail(true)) {
          form.elements.email.focus();
          return;
        }
        setBusy(submit, true, 'Enviando…');
        try {
          const data = await api('auth/forgot', { method: 'POST', body: { email: form.elements.email.value.trim() } });
          slot.replaceChildren(
            el(
              'div',
              { class: 'auth-card' },
              el('span', { class: 'success-mark' }, icon('check')),
              el('h1', {}, 'Confira o seu e-mail'),
              el('p', { class: 'form-info', role: 'status' }, data.message),
              el('p', { class: 'auth-hint' }, 'Não chegou? Veja a caixa de spam. Dá para pedir de novo, com um intervalo.'),
              el('a', { class: 'btn primary block', href: '#/login' }, 'Voltar ao login'),
            ),
          );
        } catch (err) {
          error.textContent = err.message;
          setBusy(submit, false, 'Enviar o link');
        }
      },
    },
    ...cardHead('Esqueci minha senha', 'Informe o e-mail do cadastro. Se existir uma conta aprovada, enviamos um link para escolher uma nova senha.'),
    emailRoot,
    error,
    submit,
    el('p', { class: 'auth-alt' }, 'Lembrou? ', el('a', { href: '#/login' }, 'Entrar')),
  );
  slot.append(form);
  app.replaceChildren(authStage({ title: ['Vamos recuperar o seu ', el('em', {}, 'acesso'), '.'], lede: 'O link chega por e-mail, vale por 1 hora e só pode ser usado uma vez.' }, slot));
  form.elements.email.focus();
}

// Página aberta pelo link do e-mail (#/redefinir/<token>). O token sai da barra de endereço assim que é lido, como na decisão do admin.
function renderReset(token) {
  if (token) history.replaceState(null, '', '#/redefinir');
  if (!token) {
    app.replaceChildren(
      el('div', { class: 'auth-wrap' }, el('div', { class: 'auth-card' }, el('h1', {}, 'Link inválido'), el('p', { class: 'form-error' }, 'Abra o link de redefinição direto do e-mail. Se ele já foi usado ou venceu, peça outro.'), el('a', { class: 'btn primary', href: '#/esqueci' }, 'Pedir novo link'))),
    );
    return;
  }

  const error = el('p', { class: 'form-error', role: 'alert' });
  const submit = el('button', { class: 'btn primary block', type: 'submit' }, 'Salvar a nova senha');
  const passwords = newPasswordGroup({ label: 'Nova senha' });

  const form = el(
    'form',
    {
      class: 'auth-card',
      novalidate: true,
      onsubmit: async (event) => {
        event.preventDefault();
        error.textContent = '';
        const problem = passwords.firstInvalid();
        if (problem) {
          error.textContent = 'Corrija os campos destacados.';
          problem.focus();
          return;
        }
        setBusy(submit, true, 'Salvando…');
        try {
          const data = await api('auth/reset', { method: 'POST', body: { token, password: passwords.value() } });
          clearSession(data.message); // se havia uma sessão neste navegador, ela já caiu no servidor
          location.hash = '#/login';
        } catch (err) {
          error.textContent = err.code === 'invalid_token' ? 'Este link já foi usado ou venceu. Peça um novo.' : err.message;
          setBusy(submit, false, 'Salvar a nova senha');
          if (err.code === 'invalid_token') error.append(' ', el('a', { href: '#/esqueci' }, 'Pedir novo link'));
        }
      },
    },
    ...cardHead('Nova senha', 'Escolha uma senha que você ainda não usa em outro lugar.'),
    ...passwords.nodes,
    error,
    submit,
  );
  app.replaceChildren(authStage({ title: ['Escolha uma ', el('em', {}, 'nova senha'), '.'], lede: 'Depois de salvar, as sessões abertas nos outros aparelhos são encerradas.' }, el('div', { class: 'auth-slot' }, form)));
  passwords.input.focus();
}

// Atribuição exigida pelos termos de uso do TMDB: fica numa página de créditos, fora das telas principais.
function renderCredits() {
  app.replaceChildren(
    el(
      'div',
      { class: 'auth-wrap' },
      el(
        'div',
        { class: 'auth-card' },
        el('h1', {}, 'Créditos'),
        el('p', { class: 'auth-hint' }, 'Dados de filmes e séries, pôsteres e imagens: TMDB. Este produto usa a API do TMDB, mas não é endossado nem certificado pelo TMDB.'),
        el('a', { class: 'btn', href: session.token ? '#/' : '#/login' }, 'Voltar'),
      ),
    ),
  );
}

// --- janela modal: base do painel de instalação do app e do painel de transmissão para a TV ---

function guideDetails(guide, open = false) {
  return el('details', { class: 'guide', open }, el('summary', {}, guide.title), el('ol', {}, ...guide.steps.map((step) => el('li', {}, step))), guide.note && el('p', { class: 'guide-note' }, guide.note));
}

function showDialog(title, ...content) {
  const dialog = el(
    'dialog',
    { class: 'modal', 'aria-labelledby': 'modal-title' },
    el(
      'div',
      { class: 'modal-body' },
      el(
        'div',
        { class: 'modal-head' },
        el('h2', { id: 'modal-title' }, title),
        el('button', { class: 'modal-close', type: 'button', 'aria-label': 'Fechar', onclick: () => dialog.close() }, icon('x')),
      ),
      ...content,
    ),
  );
  dialog.addEventListener('close', () => dialog.remove());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close(); // clique no fundo escurecido
  });
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}

// --- instalação como app (PWA): o ícone no fim do cabeçalho já conduz a instalação ---
// Se o navegador ofereceu o prompt nativo (`beforeinstallprompt`), o clique instala na hora; sem ele (iPhone/Safari,
// Firefox, ou o Chrome ainda não liberou) abre um painel só com os passos do aparelho da pessoa.

const installApp = document.getElementById('install-app');
let installPrompt = null;

function isInstalled() {
  return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

function detectPlatform() {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
  return /Android/.test(ua) ? 'android' : 'desktop';
}

installApp.hidden = isInstalled();

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPrompt = event;
});

window.addEventListener('appinstalled', () => {
  installPrompt = null;
  installApp.hidden = true;
});

const INSTALL_GUIDES = [
  {
    id: 'android',
    title: 'Android (Chrome)',
    steps: [
      'Abra o Cine Local no Chrome.',
      'Toque nos três pontinhos (⋮), no canto superior direito.',
      'Toque em “Instalar app” (em alguns aparelhos aparece como “Adicionar à tela inicial”).',
      'Confirme em “Instalar”. O ícone aparece na sua tela inicial.',
    ],
  },
  {
    id: 'ios',
    title: 'iPhone e iPad (Safari)',
    steps: [
      'Abra o Cine Local no Safari.',
      'Toque no botão Compartilhar (o quadrado com uma seta para cima).',
      'Role a lista e toque em “Adicionar à Tela de Início”.',
      'Toque em “Adicionar”. O ícone aparece na tela inicial.',
    ],
  },
  {
    id: 'desktop',
    title: 'Computador (Chrome ou Edge)',
    steps: [
      'Abra o Cine Local no Chrome ou no Edge.',
      'Clique no ícone de instalar, na ponta direita da barra de endereço (um monitor com uma seta para baixo).',
      'Clique em “Instalar”. O app abre numa janela própria e ganha atalho no menu de aplicativos.',
    ],
    note: 'O Firefox no computador não instala sites como app.',
  },
];

function openInstallDialog() {
  const mine = INSTALL_GUIDES.find((guide) => guide.id === detectPlatform());
  showDialog(
    'Instalar o Cine Local',
    el('p', { class: 'modal-intro' }, 'Sem loja de aplicativos: o app ganha ícone na tela inicial e abre em tela cheia. Siga os passos:'),
    el('h3', { class: 'modal-subtitle' }, mine.title),
    el('ol', { class: 'modal-steps' }, ...mine.steps.map((step) => el('li', {}, step))),
    mine.note && el('p', { class: 'modal-note' }, mine.note),
    el('h3', { class: 'modal-subtitle' }, 'Outro aparelho?'),
    ...INSTALL_GUIDES.filter((guide) => guide !== mine).map((guide) => guideDetails(guide)),
  );
}

installApp.addEventListener('click', async () => {
  if (!installPrompt) return openInstallDialog();
  const prompt = installPrompt;
  installPrompt = null; // o evento só pode ser usado uma vez
  try {
    await prompt.prompt();
  } catch {
    openInstallDialog();
  }
});

// Escolha dos 2 gêneros de filme favoritos: obrigatória para quem ainda não escolheu (novo ou antigo), editável depois.
async function renderGenres(token) {
  app.replaceChildren(spinner());
  let data;
  try {
    data = await api('me/preferences');
  } catch (err) {
    if (token === navToken) app.replaceChildren(errorState(err.message, () => route()));
    return;
  }
  if (token !== navToken) return;
  applyProfile({ name: session.name, genres: data.genres, needsGenres: data.needsGenres });
  updateChrome();

  if (!data.options.length) {
    app.replaceChildren(el('div', { class: 'auth-wrap' }, el('div', { class: 'auth-card' }, el('h1', {}, 'Gêneros indisponíveis'), el('p', { class: 'auth-hint' }, 'O catálogo atual ainda não tem gêneros. Volte mais tarde.'), el('a', { class: 'btn', href: '#/' }, 'Voltar'))));
    return;
  }

  let selected = (data.genres ?? []).map((genre) => genre.id);
  const count = el('p', { class: 'chip-count', 'aria-live': 'polite' });
  const error = el('p', { class: 'form-error', role: 'alert' });
  const save = el('button', { class: 'btn primary', type: 'button', onclick: () => submit() }, 'Salvar e continuar');
  const chips = data.options.map((option) =>
    el('button', { class: 'chip', type: 'button', 'aria-pressed': 'false', onclick: () => toggle(option.id) }, option.name),
  );

  function refresh() {
    chips.forEach((chip, i) => chip.setAttribute('aria-pressed', String(selected.includes(data.options[i].id))));
    count.textContent = `${selected.length} de 2 escolhidos`;
    save.disabled = selected.length !== 2;
  }

  // O terceiro toque tira o primeiro escolhido: sempre sobram no máximo 2.
  function toggle(id) {
    error.textContent = '';
    selected = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id].slice(-2);
    refresh();
  }

  async function submit() {
    save.disabled = true;
    error.textContent = '';
    try {
      const saved = await api('me/preferences', { method: 'POST', body: { genres: selected } });
      applyProfile({ name: session.name, genres: saved.genres, needsGenres: saved.needsGenres });
      updateChrome();
      location.hash = '#/';
    } catch (err) {
      error.textContent = err.message;
      refresh();
    }
  }

  app.replaceChildren(
    el(
      'div',
      { class: 'page genres-page' },
      el('h1', {}, 'Quais são seus gêneros favoritos?'),
      el('p', { class: 'auth-hint' }, 'Escolha 2 gêneros de filme. Usamos isso para montar as suas recomendações, e você pode mudar depois.'),
      el('div', { class: 'chips', role: 'group', 'aria-label': 'Gêneros de filme' }, chips),
      count,
      error,
      el('div', { class: 'genres-actions' }, save, !session.needsGenres && el('a', { class: 'btn', href: '#/' }, 'Cancelar')),
    ),
  );
  refresh();
}

async function renderDecision(token, navId) {
  app.replaceChildren(spinner());
  if (token) history.replaceState(null, '', '#/decisao'); // tira o token da barra de endereço
  const wrap = el('div', { class: 'auth-wrap' });
  const show = (...children) => {
    if (navId !== navToken) return;
    wrap.replaceChildren(el('div', { class: 'auth-card' }, ...children));
    app.replaceChildren(wrap);
  };

  if (!token) {
    show(el('h1', {}, 'Link inválido'), el('p', { class: 'form-error' }, 'Abra o link de aprovação direto do e-mail.'));
    return;
  }

  try {
    const info = await api('auth/decision/preview', { method: 'POST', body: { token } });
    if (info.status !== 'pending') {
      show(el('h1', {}, 'Pedido já decidido'), el('p', { class: 'form-info' }, `${info.name} já está com status “${info.status}”.`));
      return;
    }
    const approve = info.action === 'approve';
    const result = el('p', { role: 'status' });
    const confirm = el(
      'button',
      {
        class: approve ? 'btn primary' : 'btn danger',
        type: 'button',
        onclick: async () => {
          confirm.disabled = true;
          try {
            const done = await api('auth/decision', { method: 'POST', body: { token } });
            confirm.remove();
            result.className = 'form-info';
            result.textContent = done.status === 'approved' ? 'Cadastro aprovado.' : 'Cadastro recusado.';
          } catch (err) {
            confirm.disabled = false;
            result.className = 'form-error';
            result.textContent = err.message;
          }
        },
      },
      approve ? 'Aprovar cadastro' : 'Recusar cadastro',
    );
    show(
      el('h1', {}, approve ? 'Aprovar cadastro?' : 'Recusar cadastro?'),
      el('p', { class: 'decision-who' }, el('strong', {}, info.name), el('br'), info.email),
      confirm,
      result,
    );
  } catch (err) {
    show(el('h1', {}, 'Não foi possível abrir'), el('p', { class: 'form-error' }, err.message));
  }
}

// --- páginas autenticadas ---

async function renderHome(token) {
  app.replaceChildren(skeletonHome());
  const favorites = session.genres ?? [];
  const settled = await Promise.allSettled([api('me/library'), api('me/recommendations'), ...HOME_LISTS.map((name) => api(`list/${name}`))]);
  if (token !== navToken) return;
  const [libraryResult, recommendationsResult, ...results] = settled;
  const listResult = (name) => results[HOME_LISTS.indexOf(name)];

  const page = el('div');
  const trending = listResult('trending-movies');
  const featured = trending.status === 'fulfilled' ? trending.value.items.filter((i) => i.poster && i.backdrop).slice(0, HERO_SIZE) : [];
  if (featured.length) page.append(hero(featured));

  const library = libraryResult.status === 'fulfilled' ? libraryResult.value : { continue: [], watched: [], watchlist: [] };
  remember([...library.continue, ...library.watched, ...(library.watchlist ?? [])]);

  // 1. continuar assistindo e o que a pessoa guardou para ver
  if (library.continue.length) page.append(row('Continuar assistindo', library.continue, '#/biblioteca'));
  if (library.watchlist?.length) page.append(row('Quero ver', library.watchlist, '#/biblioteca'));

  // 2. "Porque você assistiu X" e, com gêneros escolhidos, gosto 1, gosto 2 e a mistura dos dois (filmes e séries, sem "Ver tudo")
  if (favorites.length) {
    page.append(
      el('p', { class: 'genre-bar' }, 'Seus gêneros: ', el('strong', {}, favorites.map((genre) => genre.name).join(' · ')), ' — ', el('a', { href: '#/generos' }, 'alterar')),
    );
  }
  if (recommendationsResult.status === 'fulfilled') {
    for (const { title, items } of recommendationsResult.value.rows) {
      remember(items);
      page.append(row(title, items));
    }
  }

  // 3. as fileiras de sempre
  let loaded = 0;
  HOME_LISTS.forEach((name, i) => {
    const result = results[i];
    if (result.status !== 'fulfilled' || !result.value.items.length) return;
    remember(result.value.items);
    page.append(row(LIST_TITLES[name], result.value.items, `#/lista/${name}`));
    loaded++;
  });

  if (!loaded) {
    const firstError = results.find((r) => r.status === 'rejected');
    app.replaceChildren(errorState(firstError?.reason?.message ?? 'catálogo vazio', () => route()));
    return;
  }

  // 4. por último, assistir novamente
  if (library.watched.length) page.append(row('Assistir novamente', library.watched, '#/biblioteca'));
  app.replaceChildren(page);
}

// `header` entra entre o título e a grade (filtros); `onData` recebe cada resposta (ex.: total de resultados).
function renderPagedGrid(title, loadPage, token, { header = null, onData = null } = {}) {
  const grid = el('div', { class: 'grid', 'aria-busy': 'true' }, Array.from({ length: 18 }, skeletonCard));
  const more = el('div', { class: 'more' });
  const page = el('div', { class: 'page' }, el('h1', {}, title), header, grid, more);
  app.replaceChildren(page);

  let next = 1;
  let loading = false;

  function clearSkeleton() {
    grid.replaceChildren();
    grid.removeAttribute('aria-busy');
  }

  async function loadMore() {
    if (loading) return;
    loading = true;
    if (next > 1) more.replaceChildren(spinner());
    try {
      const data = await loadPage(next);
      if (token !== navToken) return;
      if (next === 1) clearSkeleton(); // tira os esqueletos
      remember(data.items);
      grid.append(...data.items.map(card));
      onData?.(data);
      next++;
      const hasMore = data.totalPages != null && next <= data.totalPages;
      if (!grid.children.length) more.replaceChildren(el('div', { class: 'state' }, 'Nada encontrado.'));
      else more.replaceChildren(hasMore ? el('button', { class: 'btn', type: 'button', onclick: loadMore }, 'Carregar mais') : '');
    } catch (err) {
      if (token === navToken) {
        if (next === 1) clearSkeleton();
        more.replaceChildren(errorState(err.message, loadMore));
      }
    } finally {
      loading = false;
    }
  }

  loadMore();
}

function renderList(name, token) {
  const title = LIST_TITLES[name];
  if (!title) {
    app.replaceChildren(errorState('lista inexistente'));
    return;
  }
  renderPagedGrid(title, (page) => api(`list/${name}?page=${page}`), token);
}

// --- filtros (busca e explorar): o estado mora na própria URL, então voltar, recarregar e compartilhar funcionam ---

// Só aceita o que está na lista de opções (a URL é digitável: valor estranho vira o padrão em vez de virar pergunta ao servidor).
function pickOption(value, options, fallback) {
  return options.some(([optionValue]) => optionValue === value) ? value : fallback;
}

function hashWithQuery(base, params) {
  const query = new URLSearchParams(Object.entries(params).filter(([, value]) => value));
  const text = query.toString();
  return text ? `${base}?${text}` : base;
}

function filterSelect(label, id, options, value, onChange) {
  const select = el(
    'select',
    { id, onchange: () => onChange(select.value) },
    options.map(([optionValue, text]) => el('option', { value: optionValue, selected: optionValue === value }, text)),
  );
  return el('div', { class: 'pick' }, el('label', { for: id }, label), select);
}

// "2010-2019" -> parâmetros de ano da API.
function addYearRange(query, range) {
  if (!range) return;
  const [from, to] = range.split('-');
  query.set('from', from);
  query.set('to', to);
}

function renderSearch(term, params, token) {
  const type = pickOption(params.get('tipo'), TYPE_OPTIONS, 'all');
  const range = pickOption(params.get('ano'), YEAR_RANGES, '');
  const go = (next) => {
    location.hash = hashWithQuery(`#/busca/${encodeURIComponent(term)}`, { tipo: next.type === 'all' ? '' : next.type, ano: next.range });
  };
  const note = el('p', { class: 'filters-note', 'aria-live': 'polite' });
  const header = el(
    'div',
    { class: 'filters' },
    filterSelect('Tipo', 'filter-type', TYPE_OPTIONS, type, (value) => go({ type: value, range })),
    filterSelect('Ano', 'filter-year', YEAR_RANGES, range, (value) => go({ type, range: value })),
    note,
  );
  renderPagedGrid(
    `Resultados para “${term}”`,
    async () => {
      const query = new URLSearchParams({ q: term });
      if (type !== 'all') query.set('type', type);
      addYearRange(query, range);
      return { ...(await api(`search?${query}`)), totalPages: 1 };
    },
    token,
    { header, onData: (data) => (note.textContent = data.items.length >= SEARCH_CAP ? `Mostrando os ${SEARCH_CAP} primeiros. Use os filtros para refinar.` : '') },
  );
}

// Explorar: tipo, gênero, ano e nota. Os gêneros de "séries" são os próprios das séries; "filmes e séries" usa os de filme.
let browseOptions = null;

async function renderExplore(params, token) {
  app.replaceChildren(el('div', { class: 'page' }, el('h1', {}, 'Explorar'), el('div', { class: 'grid', 'aria-busy': 'true' }, Array.from({ length: 18 }, skeletonCard))));
  try {
    browseOptions ??= await api('browse/options');
  } catch (err) {
    if (token === navToken) app.replaceChildren(errorState(err.message, () => route()));
    return;
  }
  if (token !== navToken) return;

  const type = pickOption(params.get('tipo'), TYPE_OPTIONS, 'all');
  const genreOptions = [['', 'Todos os gêneros'], ...browseOptions[type].map((genre) => [String(genre.id), genre.name])];
  const genre = pickOption(params.get('genero'), genreOptions, '');
  const range = pickOption(params.get('ano'), YEAR_RANGES, '');
  const rating = pickOption(params.get('nota'), RATING_OPTIONS, '');
  const go = (next) => {
    location.hash = hashWithQuery('#/explorar', { tipo: next.type === 'all' ? '' : next.type, genero: next.genre, ano: next.range, nota: next.rating });
  };
  const current = { type, genre, range, rating };

  const total = el('p', { class: 'filters-note', 'aria-live': 'polite' });
  const header = el(
    'div',
    { class: 'filters' },
    filterSelect('Tipo', 'filter-type', TYPE_OPTIONS, type, (value) => go({ ...current, type: value, genre: value === 'tv' || type === 'tv' ? '' : genre })), // os ids de gênero de série são outros
    filterSelect('Gênero', 'filter-genre', genreOptions, genre, (value) => go({ ...current, genre: value })),
    filterSelect('Ano', 'filter-year', YEAR_RANGES, range, (value) => go({ ...current, range: value })),
    filterSelect('Nota', 'filter-rating', RATING_OPTIONS, rating, (value) => go({ ...current, rating: value })),
    total,
  );
  renderPagedGrid(
    'Explorar',
    (page) => {
      const query = new URLSearchParams({ type, page: String(page) });
      if (genre) query.set('genre', genre);
      if (rating) query.set('rating', rating);
      addYearRange(query, range);
      return api(`browse?${query}`);
    },
    token,
    { header, onData: (data) => (total.textContent = data.total === 1 ? '1 título' : `${data.total} títulos`) },
  );
}

// --- detalhe do título: o que o card não cabe (sinopse, gêneros, parecidos) e "Quero ver" ---

async function renderTitle(type, id, token) {
  app.replaceChildren(skeletonDetail());
  let data;
  try {
    data = await api(`title/${type}/${id}`);
  } catch (err) {
    if (token !== navToken) return;
    if (err.status === 410) {
      app.replaceChildren(el('div', { class: 'auth-wrap' }, el('div', { class: 'auth-card' }, el('h1', {}, 'Título indisponível'), el('p', { class: 'auth-hint' }, 'Este título não está mais no catálogo.'), el('a', { class: 'btn', href: '#/' }, 'Voltar ao início'))));
    } else {
      app.replaceChildren(errorState(err.message, () => route()));
    }
    return;
  }
  if (token !== navToken) return;
  document.title = `${data.title} — Cine Local`;
  remember([{ type: data.type, id: data.id, title: data.title, year: data.year, poster: data.poster }]); // só o básico: `data` carrega sinopse e parecidos

  const bg = el('div', { class: 'detail-bg' });
  const backdrop = posterUrl(data.backdrop ?? data.poster, data.backdrop ? 'w1280' : 'w780');
  if (backdrop) bg.style.backgroundImage = `url("${backdrop}")`; // CSSOM, não atributo `style`: a CSP do site bloqueia o atributo
  bg.classList.toggle('sharp', Boolean(data.backdrop));

  const seasons = data.seasons ? `${data.seasons} ${data.seasons === 1 ? 'temporada' : 'temporadas'}` + (data.episodes ? ` · ${data.episodes} episódios` : '') : null;
  const meta = [data.year, data.runtime && `${data.runtime} min`, seasons, data.rating != null && `★ ${data.rating.toFixed(1)}${data.votes ? ` (${data.votes} votos)` : ''}`].filter(Boolean).join(' · ');

  const progress = data.progress;
  const playLabel = !progress ? '▶ Assistir' : progress.done ? '▶ Assistir de novo' : type === 'tv' ? `▶ Continuar T${progress.season} · E${progress.episode}` : '▶ Continuar';
  const message = el('p', { class: 'form-error', role: 'alert' });

  let inList = data.inWatchlist;
  const listButton = el('button', { class: 'btn', type: 'button', onclick: () => toggleList() });
  function paintList() {
    listButton.replaceChildren(icon('bookmark'), inList ? 'Na lista “Quero ver”' : 'Quero ver');
    listButton.setAttribute('aria-pressed', String(inList));
  }
  async function toggleList() {
    message.textContent = '';
    listButton.disabled = true;
    try {
      inList = (await api('me/watchlist', { method: 'POST', body: { type, id, add: !inList } })).inWatchlist;
      paintList();
    } catch (err) {
      message.textContent = err.message;
    } finally {
      listButton.disabled = false;
    }
  }
  paintList();

  const posterSrc = posterUrl(data.poster, 'w500');
  app.replaceChildren(
    el(
      'div',
      {},
      el(
        'section',
        { class: 'detail' },
        bg,
        el('div', { class: 'detail-shade' }),
        el(
          'div',
          { class: 'detail-body' },
          posterSrc ? el('img', { class: 'detail-poster', src: posterSrc, alt: '' }) : el('div', { class: 'detail-poster card-fallback' }, data.title),
          el(
            'div',
            { class: 'detail-text' },
            el('h1', {}, data.title),
            data.originalTitle && el('p', { class: 'sub' }, data.originalTitle),
            meta && el('p', { class: 'detail-meta' }, meta),
            data.genres.length > 0 && el('ul', { class: 'tags' }, data.genres.map((name) => el('li', {}, name))),
            data.overview ? el('p', { class: 'detail-overview' }, data.overview) : el('p', { class: 'detail-overview empty' }, 'Sem sinopse no catálogo.'),
            progress?.done && el('p', { class: 'detail-seen' }, '✓ Você já assistiu'),
            el('div', { class: 'detail-actions' }, el('a', { class: 'btn primary', href: watchHref({ type, id }) }, playLabel), listButton),
            message,
          ),
        ),
      ),
      data.similar.length > 0 && row('Títulos parecidos', data.similar),
    ),
  );
}

async function renderLibrary(token) {
  app.replaceChildren(spinner());
  try {
    const { continue: resume, watched, watchlist } = await api('me/library');
    if (token !== navToken) return;
    remember([...resume, ...watched, ...watchlist]);

    const section = (title, items, empty) =>
      el('section', {}, el('h2', { class: 'section-title' }, title), items.length ? el('div', { class: 'grid' }, items.map(card)) : el('p', { class: 'empty' }, empty));

    app.replaceChildren(
      el(
        'div',
        { class: 'page' },
        el('h1', {}, 'Minha lista'),
        section('Continuar assistindo', resume, 'Nada em andamento. Abra um filme ou série para ele aparecer aqui.'),
        section('Quero ver', watchlist, 'Abra um filme ou série e toque em “Quero ver” para guardá-lo aqui.'),
        section('Assistir novamente', watched, 'Marque um título como assistido, no player, para guardá-lo aqui.'),
      ),
    );
  } catch (err) {
    if (token === navToken) app.replaceChildren(errorState(err.message, () => route()));
  }
}

// --- perfil: nome, gêneros, senha e sessões ---

// Pergunta de confirmação numa janela (em vez do confirm() do navegador, que não combina com o resto). Resolve true/false.
function confirmDialog(title, text, actionLabel, cancelLabel = 'Cancelar') {
  return new Promise((resolve) => {
    let answer = false;
    const dialog = showDialog(
      title,
      el('p', { class: 'modal-intro' }, text),
      el(
        'div',
        { class: 'cast-row' },
        el('button', { class: 'btn danger', type: 'button', onclick: () => ((answer = true), dialog.close()) }, actionLabel),
        el('button', { class: 'btn', type: 'button', onclick: () => dialog.close() }, cancelLabel),
      ),
    );
    dialog.addEventListener('close', () => resolve(answer));
  });
}

async function renderAccount(token) {
  app.replaceChildren(spinner());
  let account;
  try {
    account = await api('me/account');
  } catch (err) {
    if (token === navToken) app.replaceChildren(errorState(err.message, () => route()));
    return;
  }
  if (token !== navToken) return;

  // 1. nome
  const nameRoot = field('Nome', 'name', { type: 'text', autocomplete: 'name', maxlength: '60', value: account.name }, { iconName: 'user' });
  const nameInput = nameRoot.querySelector('input');
  const nameInfo = el('p', { class: 'form-info', role: 'status' });
  const nameError = el('p', { class: 'form-error', role: 'alert' });
  const nameSave = el('button', { class: 'btn primary', type: 'submit' }, 'Salvar nome');
  const nameForm = el(
    'form',
    {
      class: 'panel',
      novalidate: true,
      onsubmit: async (event) => {
        event.preventDefault();
        nameInfo.textContent = '';
        nameError.textContent = '';
        if (nameInput.value.replace(/\s+/g, ' ').trim().length < 2) {
          setFieldState(nameRoot, 'invalid', 'Informe o seu nome (2 a 60 caracteres).');
          nameInput.focus();
          return;
        }
        setFieldState(nameRoot, null);
        setBusy(nameSave, true, 'Salvando…');
        try {
          const saved = await api('me/account', { method: 'POST', body: { name: nameInput.value } });
          applyProfile({ name: saved.name, genres: saved.genres, needsGenres: saved.needsGenres });
          updateChrome();
          nameInput.value = saved.name;
          nameInfo.textContent = 'Nome atualizado.';
        } catch (err) {
          nameError.textContent = err.message;
        } finally {
          setBusy(nameSave, false, 'Salvar nome');
        }
      },
    },
    el('h2', {}, 'Seus dados'),
    el('p', { class: 'auth-hint' }, 'E-mail: ', el('strong', {}, account.email)),
    nameRoot,
    nameInfo,
    nameError,
    el('div', { class: 'genres-actions' }, nameSave),
  );

  // 2. gêneros favoritos
  const favorites = session.genres ?? [];
  const genresPanel = el(
    'section',
    { class: 'panel' },
    el('h2', {}, 'Gêneros favoritos'),
    el('p', { class: 'auth-hint' }, favorites.length ? favorites.map((genre) => genre.name).join(' · ') : 'Você ainda não escolheu.'),
    el('div', { class: 'genres-actions' }, el('a', { class: 'btn', href: '#/generos' }, 'Alterar gêneros')),
  );

  // 3. senha
  const currentRoot = passwordField('Senha atual', 'current-password', { autocomplete: 'current-password' }, { reveal: false });
  const passwords = newPasswordGroup({ label: 'Nova senha', passId: 'new-password', repeatId: 'new-password2', rulesId: 'new-password-rules' });
  const passInfo = el('p', { class: 'form-info', role: 'status' });
  const passError = el('p', { class: 'form-error', role: 'alert' });
  const passSave = el('button', { class: 'btn primary', type: 'submit' }, 'Trocar senha');
  const passForm = el(
    'form',
    {
      class: 'panel',
      novalidate: true,
      onsubmit: async (event) => {
        event.preventDefault();
        passInfo.textContent = '';
        passError.textContent = '';
        const currentInput = currentRoot.querySelector('input');
        const hasCurrent = Boolean(currentInput.value);
        setFieldState(currentRoot, hasCurrent ? null : 'invalid', hasCurrent ? '' : 'Informe a sua senha atual.');
        const problem = passwords.firstInvalid();
        if (!hasCurrent || problem) {
          passError.textContent = 'Corrija os campos destacados.';
          (hasCurrent ? problem : currentInput).focus();
          return;
        }
        setBusy(passSave, true, 'Trocando…');
        try {
          const data = await api('me/password', { method: 'POST', body: { current: currentInput.value, next: passwords.value() } });
          session.token = data.token; // o servidor encerrou as outras sessões; esta continua com o token novo
          try {
            localStorage.setItem(TOKEN_KEY, data.token);
          } catch {
            /* sem storage: vale só nesta aba */
          }
          currentInput.value = '';
          passwords.reset();
          passInfo.textContent = 'Senha alterada. Os outros aparelhos foram desconectados.';
        } catch (err) {
          if (err.code === 'wrong_password') {
            setFieldState(currentRoot, 'invalid', err.message);
            currentInput.focus();
          } else {
            passError.textContent = err.message;
          }
        } finally {
          setBusy(passSave, false, 'Trocar senha');
        }
      },
    },
    el('h2', {}, 'Trocar senha'),
    currentRoot,
    ...passwords.nodes,
    passInfo,
    passError,
    el('div', { class: 'genres-actions' }, passSave),
  );
  currentRoot.querySelector('input').addEventListener('input', () => setFieldState(currentRoot, null));

  // 4. sessões
  const logoutError = el('p', { class: 'form-error', role: 'alert' });
  const logoutAll = el(
    'section',
    { class: 'panel' },
    el('h2', {}, 'Segurança'),
    el('p', { class: 'auth-hint' }, 'Perdeu um aparelho ou esqueceu a sessão aberta em algum lugar? Encerre todas, inclusive esta.'),
    logoutError,
    el(
      'div',
      { class: 'genres-actions' },
      el(
        'button',
        {
          class: 'btn danger',
          type: 'button',
          onclick: async () => {
            logoutError.textContent = '';
            if (!(await confirmDialog('Sair de todos os dispositivos?', 'Todas as sessões abertas, neste e em outros aparelhos, serão encerradas e você precisará entrar de novo.', 'Sair de todos'))) return;
            try {
              await api('me/logout-all', { method: 'POST', body: {} });
              clearSession('Você saiu de todos os dispositivos. Entre de novo.');
              location.hash = '#/login';
            } catch (err) {
              logoutError.textContent = err.message;
            }
          },
        },
        'Sair de todos os dispositivos',
      ),
    ),
  );

  app.replaceChildren(el('div', { class: 'page account-page' }, el('h1', {}, 'Meu perfil'), nameForm, genresPanel, passForm, logoutAll));
}

// --- transmitir para a TV ---
// Três caminhos, do mais direto ao mais manual:
//  1. Chromecast (Google Cast): o site manda o endereço do player para uma página nossa (receiver.html) que roda no
//     Chromecast e abre o player na TV. Só aparece com CAST_APP_ID configurado e num navegador com Cast (Chrome).
//  2. Código da TV: a TV abre /tv e mostra um código; aqui a pessoa digita e o servidor entrega à TV (tv.mjs).
//  3. Espelhamento: passo a passo para espelhar a tela (Chromecast pelo Chrome, AirPlay, Miracast, HDMI).
// O player é um iframe de outro site: não há acesso ao <video> nem ao endereço do vídeo. Por isso os caminhos 1 e 2
// mandam a TV abrir o MESMO player (não o vídeo) e nenhum deles controla o player depois de aberto.

const CAST_NAMESPACE = 'urn:x-cast:com.cinelocal.tv'; // igual ao de receiver.js
const CAST_SDK_URL = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';
const TV_CODE_KEY = 'cine.tvcode';

const CAST_GUIDES = [
  {
    id: 'chrome',
    title: 'Chromecast ou TV com Chromecast (Chrome ou Edge no computador)',
    steps: [
      'Abra este filme no Chrome ou no Edge, com o computador na mesma rede Wi-Fi da TV.',
      'Chrome: menu (⋮) → “Salvar e compartilhar” → “Transmitir…”. Edge: menu (…) → “Mais ferramentas” → “Transmitir mídia para o dispositivo”.',
      'Escolha a sua TV na lista. Em “Fontes”, selecione “Transmitir guia” para o som ir junto.',
      'Dê play e coloque o player em tela cheia. Para parar, clique no ícone de transmissão na barra do navegador e em “Parar”.',
    ],
  },
  {
    id: 'android',
    title: 'Celular Android (Transmitir, Smart View ou Espelhar tela)',
    steps: [
      'Deixe o celular na mesma rede Wi-Fi da TV.',
      'Deslize a barra de atalhos e toque em “Transmitir”, “Smart View” ou “Espelhar tela” (o nome muda conforme a marca).',
      'Escolha a sua TV.',
      'Abra este filme no navegador, dê play e gire o celular para tela cheia.',
    ],
  },
  {
    id: 'airplay',
    title: 'iPhone, iPad e Mac (AirPlay)',
    steps: [
      'Deixe o aparelho na mesma rede Wi-Fi da Apple TV ou da TV com AirPlay.',
      'iPhone e iPad: abra a Central de Controle e toque em “Espelhar Tela”. Mac: Central de Controle → “Espelhamento de Tela”.',
      'Escolha a sua TV (e digite o código que aparecer nela, se pedir).',
      'Abra este filme, dê play e use a tela cheia.',
    ],
  },
  {
    id: 'other',
    title: 'Outras formas (cabo HDMI e Miracast)',
    steps: [
      'Cabo HDMI: ligue o computador ou o celular (com adaptador) à TV e escolha a entrada HDMI. É a opção mais estável.',
      'Windows: tecle Windows + K para transmitir a tela para uma TV com Miracast.',
    ],
  },
];

function castGuideFor() {
  const ua = navigator.userAgent;
  const platform = detectPlatform();
  if (platform === 'ios') return 'airplay';
  if (/Macintosh/.test(ua) && /Safari/.test(ua) && !/Chrome|Chromium|Edg|OPR/.test(ua)) return 'airplay';
  return platform === 'android' ? 'android' : 'chrome';
}

// ---- código da TV ----

function readTvCode() {
  try {
    return localStorage.getItem(TV_CODE_KEY) || '';
  } catch {
    return '';
  }
}

function saveTvCode(code) {
  try {
    localStorage.setItem(TV_CODE_KEY, code);
  } catch {
    /* sem storage: a pessoa digita de novo na próxima vez */
  }
}

const normalizeTvCode = (value) => value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
const formatTvCode = (code) => (code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code);

function sendToTv(code, target) {
  return api('tv/send', { method: 'POST', body: { code, type: target.type, id: target.id, season: target.season ?? undefined, episode: target.episode ?? undefined } });
}

function codeOption(cast) {
  const input = el('input', { class: 'cast-code', type: 'text', maxlength: '7', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', placeholder: 'ABC 123', 'aria-label': 'Código mostrado na TV', value: formatTvCode(readTvCode()) });
  const info = el('p', { class: 'cast-info', role: 'status' });
  const send = el('button', { class: 'btn primary small', type: 'button' }, 'Enviar para a TV');
  const stop = el('button', { class: 'btn small', type: 'button', hidden: !cast.tvCode }, 'Parar na TV');

  const say = (text, bad = false) => {
    info.textContent = text;
    info.classList.toggle('bad', bad);
  };

  send.addEventListener('click', async () => {
    const code = normalizeTvCode(input.value);
    if (code.length !== 6) return say('Digite os 6 caracteres que aparecem na TV.', true);
    send.disabled = true;
    try {
      await sendToTv(code, cast.target());
      saveTvCode(code);
      cast.tvCode = code;
      input.value = formatTvCode(code);
      stop.hidden = false;
      say('Enviado! O player abre na TV em até 5 segundos. Se trocar de episódio aqui, a TV acompanha.');
    } catch (err) {
      say(err.message, true);
    } finally {
      send.disabled = false;
    }
  });

  stop.addEventListener('click', async () => {
    try {
      await api('tv/stop', { method: 'POST', body: { code: cast.tvCode } });
      cast.tvCode = null;
      stop.hidden = true;
      say('Transmissão encerrada. A TV volta para a tela do código.');
    } catch (err) {
      say(err.message, true);
    }
  });

  return el(
    'section',
    { class: 'cast-option' },
    el('h3', {}, 'TV com navegador (código)'),
    el('p', {}, `Na TV, abra o navegador e entre em ${location.host}/tv. Digite aqui o código que aparecer.`),
    el('div', { class: 'cast-row' }, input, send, stop),
    info,
  );
}

// ---- Chromecast (Google Cast) ----

let castSdkLoad = null;
let castAppIdLoad = null;
let castReady = false;
let castNotify = null; // quem está ouvindo as respostas do receptor (o painel aberto)
const listened = new WeakSet(); // sessões do Cast que já têm o ouvinte (um por sessão, não um por abertura do painel)

function loadCastSdk() {
  castSdkLoad ??= new Promise((resolve) => {
    window.__onGCastApiAvailable = (available) => resolve(Boolean(available) && Boolean(window.cast?.framework));
    const script = el('script', { src: CAST_SDK_URL, async: true });
    script.addEventListener('error', () => resolve(false));
    document.head.append(script);
    setTimeout(() => resolve(false), 10000);
  });
  return castSdkLoad;
}

// null quando a opção não está disponível aqui (sem App ID configurado ou navegador sem Cast).
async function castContext() {
  castAppIdLoad ??= api('cast/config').then((config) => config.appId, () => null);
  const appId = await castAppIdLoad;
  if (!appId || !(await loadCastSdk())) return null;
  const context = cast.framework.CastContext.getInstance();
  if (!castReady) {
    context.setOptions({ receiverApplicationId: appId, autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED });
    castReady = true;
  }
  return context;
}

async function sendToChromecast(context, target) {
  const session = context.getCurrentSession();
  if (!session) throw new Error('Nenhum Chromecast conectado.');
  await session.sendMessage(CAST_NAMESPACE, { type: 'play', url: target.url, title: target.title, season: target.season, episode: target.episode });
}

function chromecastOption(cast) {
  const info = el('p', { class: 'cast-info', role: 'status' });
  const actions = el('div', { class: 'cast-row' });
  const root = el('section', { class: 'cast-option', hidden: true }, el('h3', {}, 'Chromecast'), el('p', {}, 'Para um Chromecast ou TV com Chromecast na mesma rede Wi-Fi. A TV abre o mesmo player do filme.'), actions, info);
  const say = (text, bad = false) => {
    info.textContent = text;
    info.classList.toggle('bad', bad);
  };

  castContext().then((context) => {
    if (!context) return;
    root.hidden = false;

    const listen =(session) => session.addMessageListener(CAST_NAMESPACE, (_namespace, raw) => castNotify?.(typeof raw === 'string' ? JSON.parse(raw) : raw));
    const paint = () => {
      const session = context.getCurrentSession();
      if (!session) {
        actions.replaceChildren(el('button', { class: 'btn primary small', type: 'button', onclick: connect }, 'Escolher Chromecast'));
        return;
      }
      if (!listened.has(session)) {
        listened.add(session);
        listen(session);
      }
      say(`Conectado a ${session.getCastDevice().friendlyName}.`);
      actions.replaceChildren(
        el('button', { class: 'btn primary small', type: 'button', onclick: resend }, 'Enviar este título'),
        el('button', { class: 'btn small', type: 'button', onclick: disconnect }, 'Parar'),
      );
    };

    async function resend() {
      try {
        await sendToChromecast(context, cast.target());
        cast.chromecast = true;
        say(`Enviado para ${context.getCurrentSession().getCastDevice().friendlyName}. Se o player não abrir na TV, ele pode estar pedindo um clique que o controle não faz.`);
      } catch (err) {
        say(err.message, true);
      }
    }

    async function connect() {
      const error = await context.requestSession();
      if (typeof error === 'string') {
        if (error !== 'cancel') say(`Não foi possível conectar ao Chromecast (${error}).`, true);
        return;
      }
      paint();
      await resend();
    }

    function disconnect() {
      context.endCurrentSession(true);
      cast.chromecast = false;
      say('Transmissão encerrada.');
      paint();
    }

    castNotify = (message) => {
      if (message?.type === 'ack' && message.ok === false) say(`A TV recusou o envio (${message.reason}).`, true);
      else if (message?.type === 'ack') say('A TV abriu o player.');
    };
    paint();
  });
  return root;
}

// Se a pessoa trocar de episódio com a transmissão ativa, a TV acompanha (só dentro da mesma tela do filme).
function followCast(cast) {
  if (cast.tvCode) sendToTv(cast.tvCode, cast.target()).catch(() => (cast.tvCode = null));
  if (cast.chromecast) {
    castContext()
      .then((context) => context && sendToChromecast(context, cast.target()))
      .catch(() => (cast.chromecast = false));
  }
}

function openCastDialog(cast) {
  const preferred = castGuideFor();
  const dialog = showDialog(
    'Transmitir para a TV',
    el('p', { class: 'modal-intro' }, 'O filme toca num player de outro site, então a TV abre o mesmo player. Daqui você troca de episódio e para a transmissão; pausar e avançar dependem do player que abrir na TV.'),
    chromecastOption(cast),
    codeOption(cast),
    el(
      'details',
      { class: 'guide' },
      el('summary', {}, 'Espelhar a tela (sem Chromecast e sem código)'),
      el('div', { class: 'guide-nested' }, ...CAST_GUIDES.map((guide) => guideDetails(guide, guide.id === preferred)), el('p', { class: 'modal-tip' }, 'Tela preta ou sem som? Alguns players bloqueiam o espelhamento da aba. No Chrome, em “Fontes”, escolha “Transmitir tela” em vez de “Transmitir guia”.')),
    ),
  );
  dialog.addEventListener('close', () => {
    castNotify = null;
  });
}

// --- trava do "voltar" na tela do filme ---
// No celular o gesto de voltar (borda da tela) é fácil de acionar sem querer e tira a pessoa do filme; ao reabrir, o
// player recomeça e os anúncios vêm de novo. Ao abrir a tela empilha-se uma entrada igual à atual (a "guarda"): o
// primeiro voltar só a desempilha e o site pergunta se a pessoa quer sair. Com a pergunta aberta a guarda é recolocada
// a cada voltar, então um segundo voltar sem querer também não sai. As duas entradas levam o mesmo id no history.state
// (`cineWatch` na tela, `cineGuard` na guarda) para reconhecer só o voltar que desempilhou a guarda desta tela.
// O Chrome pula entradas criadas sem interação prévia com a página: nesse caso o voltar sai como sempre saiu.

let watchGuard = null; // { id, hash } enquanto a tela do filme está aberta
let leavePrompt = false;

function armWatchGuard() {
  const state = history.state;
  if (state?.cineGuard) {
    watchGuard = { id: state.cineGuard, hash: location.hash }; // recarregou ou voltou até a guarda: já está armada
    return;
  }
  const id = state?.cineWatch ?? Math.random().toString(36).slice(2);
  history.replaceState({ ...state, cineWatch: id }, '');
  history.pushState({ cineGuard: id }, '');
  watchGuard = { id, hash: location.hash };
}

function onWatchGuardPop(event) {
  if (!watchGuard || event.state?.cineWatch !== watchGuard.id) return;
  // A entrada de baixo pode guardar o endereço de um episódio anterior; as duas passam a ter o endereço atual da tela.
  history.replaceState({ cineWatch: watchGuard.id }, '', watchGuard.hash);
  history.pushState({ cineGuard: watchGuard.id }, '', watchGuard.hash);
  if (leavePrompt) return;
  leavePrompt = true;
  confirmDialog('Sair do player?', 'Se sair, o player recarrega e os anúncios podem aparecer de novo.', 'Sair', 'Continuar assistindo').then((leave) => {
    leavePrompt = false;
    if (!leave || !watchGuard) return;
    // Pilha: [..., anterior, tela, guarda]. Sem entrada anterior (link aberto direto) não há para onde voltar: vai ao início.
    if (history.length > 2) history.go(-2);
    else location.replace('#/');
  });
}

window.addEventListener('popstate', onWatchGuardPop);

async function renderWatch(type, id, seasonArg, episodeArg, token) {
  const isTv = type === 'tv';
  const known = meta[`${type}:${id}`];
  const state = {
    title: known?.title ?? `Título ${id}`,
    season: seasonArg ? Number(seasonArg) : null,
    episode: episodeArg ? Number(episodeArg) : null,
    seasons: [],
    episodes: [],
    done: false,
    url: null,
  };
  let frameRequest = 0;
  // Estado da transmissão desta tela: com ela ativa, trocar de episódio manda o novo para a TV (followCast).
  const cast = { tvCode: null, chromecast: false, target: () => ({ type, id, season: state.season, episode: state.episode, title: state.title, url: state.url }) };

  const heading = el('h1', {}, state.title);
  const subtitle = el('p', { class: 'sub' });
  const player = el('div', { class: 'player' });
  const message = el('p', { class: 'form-error', role: 'alert' });
  const info = el('div', { class: 'watch-info' });

  const openLink = el('a', { class: 'btn primary', target: '_blank', rel: 'noopener noreferrer' }, '▶ Assistir em nova aba');
  const castBtn = el('button', { class: 'btn', type: 'button', onclick: () => openCastDialog(cast) }, icon('tv'), 'Transmitir para a TV');
  const reloadBtn = el('button', { class: 'btn', type: 'button', onclick: () => loadFrame() }, 'Recarregar player');
  const doneBtn = el('button', { class: 'btn', type: 'button', onclick: () => toggleDone() }, 'Marcar como assistido');
  const page = el(
    'div',
    { class: 'watch' },
    el(
      'div',
      { class: 'watch-head' },
      el('div', {}, heading, subtitle),
      el('div', { class: 'controls' }, openLink, castBtn, doneBtn, reloadBtn),
    ),
    player,
  );

  const seasonSelect = el('select', { id: 'season', onchange: () => onSeasonChange() });
  const episodeSelect = el('select', { id: 'episode', onchange: () => goTo(state.season, Number(episodeSelect.value)) });
  const prevBtn = el('button', { class: 'btn', type: 'button', onclick: () => step(-1) }, '◀ Anterior');
  const nextBtn = el('button', { class: 'btn', type: 'button', onclick: () => step(1) }, 'Próximo ▶');

  if (isTv) {
    page.append(
      el(
        'div',
        { class: 'controls series' },
        el('div', { class: 'pick' }, el('label', { for: 'season' }, 'Temporada'), seasonSelect),
        el('div', { class: 'pick' }, el('label', { for: 'episode' }, 'Episódio'), episodeSelect),
        el('span', { class: 'spacer' }),
        el('div', { class: 'step' }, prevBtn, nextBtn),
      ),
    );
  }
  page.append(
    info,
    message,
    el(
      'p',
      { class: 'note' },
      'Se um anúncio abrir em outra aba, feche e volte. Bloqueadores de anúncio impedem o player de tocar.',
    ),
  );
  app.replaceChildren(page);
  armWatchGuard();

  // Nota, duração, gêneros e sinopse do catálogo, abaixo do player (vêm na resposta do /play).
  function renderInfo(extra) {
    if (!extra) {
      info.replaceChildren();
      return;
    }
    const facts = [
      extra.rating != null && `★ ${extra.rating.toFixed(1)}`,
      extra.runtime && `${extra.runtime} min`,
      extra.seasons && `${extra.seasons} ${extra.seasons === 1 ? 'temporada' : 'temporadas'}`,
      ...(extra.genres ?? []),
    ].filter(Boolean);
    info.replaceChildren(
      facts.length > 0 && el('p', { class: 'watch-meta' }, facts.join(' · ')),
      extra.overview && el('p', { class: 'watch-overview' }, extra.overview),
      el('a', { class: 'watch-detail-link', href: detailHref({ type, id }) }, 'Ver detalhes e títulos parecidos'),
    );
  }

  // Garante que o item atual (ex.: vindo de link direto) apareça na lista mesmo se a sondagem não o achou.
  function withCurrent(list, current) {
    return current == null || list.includes(current) ? list : [...list, current].sort((a, b) => a - b);
  }

  function fillSelect(select, values, selected, label) {
    select.replaceChildren(...values.map((v) => el('option', { value: v, selected: v === selected }, `${label} ${v}`)));
  }

  function refreshControls() {
    // Em série, "assistido" vale para o episódio (e já abre o próximo); só o último episódio conclui a série toda.
    if (isTv) doneBtn.textContent = state.done ? '✓ Série concluída (desmarcar)' : 'Marcar episódio como assistido';
    else doneBtn.textContent = state.done ? '✓ Assistido (desmarcar)' : 'Marcar como assistido';
    if (!isTv) return;
    const seasons = withCurrent(state.seasons, state.season);
    const episodes = withCurrent(state.episodes, state.episode);
    fillSelect(seasonSelect, seasons, state.season, 'Temporada');
    fillSelect(episodeSelect, episodes, state.episode, 'Episódio');
    const seasonIdx = seasons.indexOf(state.season);
    const epIdx = episodes.indexOf(state.episode);
    prevBtn.disabled = seasonIdx <= 0 && epIdx <= 0;
    nextBtn.disabled = seasonIdx >= seasons.length - 1 && epIdx >= episodes.length - 1;
  }

  // O servidor registra o título no histórico e devolve o link do player (e, em série, de onde retomar).
  async function loadFrame(season = state.season, episode = state.episode) {
    const request = ++frameRequest;
    message.textContent = '';
    player.replaceChildren(spinner());
    let data;
    try {
      data = await api('play', {
        method: 'POST',
        body: { type, id, season: season ?? undefined, episode: episode ?? undefined, title: known?.title, year: known?.year ?? undefined, poster: known?.poster ?? undefined },
      });
    } catch (err) {
      if (token === navToken && request === frameRequest) player.replaceChildren(errorState(err.message, () => loadFrame(season, episode)));
      return;
    }
    if (token !== navToken || request !== frameRequest) return;

    state.title = data.title;
    state.season = data.season;
    state.episode = data.episode;
    state.done = data.done;
    heading.textContent = data.title;
    subtitle.textContent = [data.year, isTv && `Temporada ${data.season} · Episódio ${data.episode}`].filter(Boolean).join(' · ');
    document.title = `${data.title} — Cine Local`;
    renderInfo(data.info);
    openLink.href = data.url;
    state.url = data.url;
    player.replaceChildren(
      el('iframe', {
        src: data.url,
        // Sem `sandbox` de propósito: o player do provedor detecta e se recusa a tocar ("remova o Sandbox").
        allowfullscreen: true,
        allow: 'autoplay; fullscreen; encrypted-media; picture-in-picture',
        title: data.title,
      }),
    );
    if (isTv) {
      const hash = `#/assistir/tv/${id}/${data.season}/${data.episode}`;
      history.replaceState(history.state, '', hash); // mantém a guarda do voltar
      if (watchGuard) watchGuard.hash = hash;
    }
    refreshControls();
    followCast(cast);
  }

  async function toggleDone() {
    message.textContent = '';
    // Série ainda não concluída: marca o episódio atual e o servidor devolve o próximo (`next`), que já abrimos.
    const episodeMode = isTv && !state.done && state.season != null;
    try {
      const item = await api('me/done', {
        method: 'POST',
        body: episodeMode ? { type, id, done: true, season: state.season, episode: state.episode } : { type, id, done: !state.done },
      });
      state.done = item.done;
      if (item.next) {
        await moveTo(item.next.season, item.next.episode);
        return;
      }
      refreshControls();
    } catch (err) {
      message.textContent = err.message;
    }
  }

  // Vai para um episódio que pode ser de outra temporada (a lista de episódios da nova temporada precisa vir antes).
  async function moveTo(season, episode) {
    if (season !== state.season) {
      state.season = season;
      state.episodes = [];
      await loadEpisodes(season);
      if (token !== navToken) return;
    }
    goTo(season, episode);
  }

  async function loadEpisodes(season) {
    try {
      const data = await api(`episodes/${id}/${season}`);
      if (token !== navToken || season !== state.season) return;
      state.episodes = data.episodes;
    } catch {
      state.episodes = [];
    }
    refreshControls();
  }

  function goTo(season, episode) {
    state.season = season;
    state.episode = episode;
    refreshControls();
    loadFrame(season, episode);
  }

  async function onSeasonChange() {
    state.season = Number(seasonSelect.value);
    state.episodes = [];
    await loadEpisodes(state.season);
    if (token !== navToken) return;
    goTo(state.season, state.episodes[0] ?? 1);
  }

  async function step(direction) {
    const epIdx = state.episodes.indexOf(state.episode);
    const target = state.episodes[epIdx + direction];
    if (target != null) return goTo(state.season, target);

    const seasonIdx = state.seasons.indexOf(state.season);
    const season = state.seasons[seasonIdx + direction];
    if (season == null) return;
    state.season = season;
    state.episodes = [];
    await loadEpisodes(season);
    if (token !== navToken) return;
    goTo(season, direction > 0 ? (state.episodes[0] ?? 1) : (state.episodes.at(-1) ?? 1));
  }

  refreshControls();
  await loadFrame();

  if (isTv && token === navToken && state.season != null) {
    try {
      const data = await api(`seasons/${id}`);
      if (token !== navToken) return;
      state.seasons = data.seasons;
    } catch {
      state.seasons = [];
    }
    refreshControls();
    await loadEpisodes(state.season);
  }
}

// --- roteador ---

function setActiveNav(key) {
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === key));
}

function route() {
  const token = ++navToken;
  watchGuard = null;
  clearInterval(heroTimer);
  document.title = 'Cine Local';
  window.scrollTo(0, 0);

  // Filtros vão depois do `?` (busca e explorar); o resto do roteamento olha só o caminho.
  const [hash, queryText = ''] = (location.hash || '#/').split('?');
  const params = new URLSearchParams(queryText);
  let match;

  if ((match = hash.match(/^#\/decisao(?:\/([A-Za-z0-9._-]+))?$/))) {
    setActiveNav(null);
    return renderDecision(match[1], token);
  }
  if ((match = hash.match(/^#\/redefinir(?:\/([A-Za-z0-9._-]+))?$/))) {
    setActiveNav(null);
    return renderReset(match[1]);
  }
  if (hash === '#/creditos') {
    setActiveNav(null);
    return renderCredits();
  }
  if (hash === '#/login' || hash === '#/cadastro' || hash === '#/esqueci') {
    setActiveNav(null);
    if (session.token) return location.replace('#/');
    if (hash === '#/login') return renderLogin();
    return hash === '#/cadastro' ? renderRegister() : renderForgot();
  }
  if (!session.token) return location.replace('#/login');
  if (session.needsGenres && hash !== '#/generos') return location.replace('#/generos');
  if (hash === '#/generos') {
    setActiveNav(null);
    return renderGenres(token);
  }

  if ((match = hash.match(/^#\/lista\/([a-z-]+)$/))) {
    setActiveNav(match[1]);
    searchInput.value = '';
    return renderList(match[1], token);
  }
  if ((match = hash.match(/^#\/busca\/(.+)$/))) {
    let term;
    try {
      term = decodeURIComponent(match[1]);
    } catch {
      return location.replace('#/'); // endereço digitado à mão e malformado
    }
    setActiveNav(null);
    if (document.activeElement !== searchInput) searchInput.value = term;
    return renderSearch(term, params, token);
  }
  if (hash === '#/explorar') {
    setActiveNav('explore');
    searchInput.value = '';
    return renderExplore(params, token);
  }
  if ((match = hash.match(/^#\/titulo\/(movie|tv)\/(\d{1,9})$/))) {
    setActiveNav(null);
    searchInput.value = '';
    return renderTitle(match[1], match[2], token);
  }
  if (hash === '#/perfil') {
    setActiveNav(null);
    searchInput.value = '';
    return renderAccount(token);
  }
  if (hash === '#/biblioteca') {
    setActiveNav('library');
    searchInput.value = '';
    return renderLibrary(token);
  }
  if ((match = hash.match(/^#\/assistir\/(movie|tv)\/(\d{1,9})(?:\/(\d+)\/(\d+))?$/))) {
    setActiveNav(null);
    searchInput.value = '';
    return renderWatch(match[1], match[2], match[3], match[4], token);
  }

  setActiveNav('home');
  searchInput.value = '';
  return renderHome(token);
}

let searchTimer = null;

// Na tela de busca, uma nova palavra mantém os filtros que já estavam escolhidos.
function goSearch() {
  const term = searchInput.value.trim();
  if (term.length < 2) return;
  const filters = location.hash.startsWith('#/busca/') ? location.hash.split('?')[1] : '';
  location.hash = `#/busca/${encodeURIComponent(term)}${filters ? `?${filters}` : ''}`;
}

searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(goSearch, 450);
});

searchForm.addEventListener('submit', (event) => {
  event.preventDefault();
  clearTimeout(searchTimer);
  goSearch();
});

document.getElementById('logout').addEventListener('click', () => {
  clearSession();
  location.hash = '#/login';
});

window.addEventListener('hashchange', () => {
  if (watchGuard && location.hash === watchGuard.hash) return; // desempilhar/recolocar a guarda não troca de tela
  route();
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* sem service worker o site funciona igual; só não é oferecido como app */
    });
  });
}

async function boot() {
  updateChrome();
  if (session.token) {
    try {
      applyProfile(await api('auth/me'));
    } catch {
      /* 401 já limpou a sessão; falha de rede deixa as telas mostrarem o erro */
    }
    updateChrome();
  }
  route();
}

boot();
