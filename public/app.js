'use strict';

const HERO_ROTATE_MS = 8000;
const HERO_SIZE = 5;
const META_LIMIT = 400;
const TOKEN_KEY = 'cine.token';

const LIST_TITLES = {
  'trending-movies': 'Filmes em alta',
  'trending-shows': 'Séries em alta',
  'top-movies': 'Mais avaliados',
  'recent-movies': 'Lançamentos',
  'library-movies': 'Filmes',
  'library-shows': 'Séries',
};

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

// --- componentes ---

function spinner(text = 'Carregando…') {
  return el('div', { class: 'state' }, el('div', { class: 'spinner' }), text);
}

function errorState(message, retry) {
  return el(
    'div',
    { class: 'state' },
    el('p', {}, `Não foi possível carregar: ${message}`),
    retry && el('button', { class: 'btn', type: 'button', onclick: retry }, 'Tentar de novo'),
  );
}

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
    item.quality && item.type !== 'tv' && el('span', { class: 'badge left' }, item.quality),
    item.rating != null && el('span', { class: 'badge right' }, `★ ${item.rating.toFixed(1)}`),
  );
  return el(
    'a',
    { class: 'card', href: watchHref(item), title: item.title },
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
  const poster = el('img', { class: 'hero-poster', alt: '' });
  const dots = el('div', { class: 'hero-dots' });
  const root = el(
    'section',
    { class: 'hero' },
    bg,
    el('div', { class: 'hero-shade' }),
    el('div', { class: 'hero-body' }, el('div', { class: 'hero-text' }, tag, title, info, overview, play), poster),
    dots,
  );

  let current = 0;
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
    info.textContent = [item.year, item.quality, item.rating != null && `★ ${item.rating.toFixed(1)}`, item.runtime && `${item.runtime} min`].filter(Boolean).join(' · ');
    overview.textContent = item.overview ?? '';
    play.href = watchHref(item);
    buttons.forEach((b, i) => b.classList.toggle('on', i === index));
    if (manual) startRotation();
  }

  function startRotation() {
    clearInterval(heroTimer);
    if (items.length > 1) heroTimer = setInterval(() => show((current + 1) % items.length), HERO_ROTATE_MS);
  }

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
function passwordField(label, id, attrs) {
  const toggle = el('button', { class: 'toggle-pass', type: 'button', 'aria-label': 'Mostrar senha', title: 'Mostrar senha' }, icon('eye'));
  const root = field(
    label,
    id,
    { type: 'password', maxlength: '128', autocapitalize: 'off', spellcheck: 'false', ...attrs },
    { iconName: 'lock', trailing: toggle },
  );
  const input = root.querySelector('input');
  const caps = el('p', { class: 'field-hint', hidden: true }, 'Caps Lock ligado');
  root.append(caps);

  toggle.addEventListener('click', () => {
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
  const passRoot = passwordField('Senha', 'password', { autocomplete: 'new-password', 'aria-describedby': 'password-msg password-rules' });
  const checklist = passwordChecklist('password-rules');
  const repeatRoot = passwordField('Repita a senha', 'password2', { autocomplete: 'new-password' });

  const nameInput = nameRoot.querySelector('input');
  const passInput = passRoot.querySelector('input');
  const repeatInput = repeatRoot.querySelector('input');
  let repeatTouched = false;

  function checkName(strict = false) {
    const valid = nameInput.value.replace(/\s+/g, ' ').trim().length >= 2;
    setFieldState(nameRoot, !valid && strict ? 'invalid' : null, !valid && strict ? 'Informe o seu nome (2 a 60 caracteres).' : '');
    return valid;
  }

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

  nameInput.addEventListener('input', () => checkName());
  passInput.addEventListener('input', () => {
    checkPassword();
    if (repeatInput.value) checkRepeat();
  });
  repeatInput.addEventListener('input', () => checkRepeat());
  repeatInput.addEventListener('blur', () => {
    repeatTouched = true;
    if (repeatInput.value) checkRepeat();
  });

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
          [passInput, checkPassword(true)],
          [repeatInput, checkRepeat(true)],
        ];
        const firstInvalid = checks.find(([, valid]) => !valid);
        if (firstInvalid) {
          error.textContent = 'Corrija os campos destacados.';
          firstInvalid[0].focus();
          return;
        }
        setBusy(submit, true, 'Enviando…');
        try {
          const data = await api('auth/register', {
            method: 'POST',
            body: { name: nameInput.value, email: form.elements.email.value.trim(), password: passInput.value },
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
    passRoot,
    checklist.root,
    repeatRoot,
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
  app.replaceChildren(spinner());
  const names = ['trending-movies', 'trending-shows', 'top-movies', 'recent-movies'];
  const favorites = session.genres ?? [];
  const settled = await Promise.allSettled([
    api('me/library'),
    favorites.length ? api('me/recommendations') : Promise.resolve({ rows: [] }),
    ...names.map((name) => api(`list/${name}`)),
  ]);
  if (token !== navToken) return;
  const [libraryResult, recommendationsResult, ...results] = settled;

  const page = el('div');
  const featured = results[0].status === 'fulfilled' ? results[0].value.items.filter((i) => i.poster && i.backdrop).slice(0, HERO_SIZE) : [];
  if (featured.length) page.append(hero(featured));

  const library = libraryResult.status === 'fulfilled' ? libraryResult.value : { continue: [], watched: [] };
  remember([...library.continue, ...library.watched]);

  // 1. continuar assistindo
  if (library.continue.length) page.append(row('Continuar assistindo', library.continue, '#/biblioteca'));

  // 2. gosto 1, gosto 2 e a mistura dos dois (filmes e séries, sem "Ver tudo")
  if (favorites.length) {
    page.append(
      el('p', { class: 'genre-bar' }, 'Seus gêneros: ', el('strong', {}, favorites.map((genre) => genre.name).join(' · ')), ' — ', el('a', { href: '#/generos' }, 'alterar')),
    );
    if (recommendationsResult.status === 'fulfilled') {
      for (const { title, items } of recommendationsResult.value.rows) {
        remember(items);
        page.append(row(title, items));
      }
    }
  }

  // 3. as fileiras de sempre
  let loaded = 0;
  results.forEach((result, i) => {
    if (result.status !== 'fulfilled' || !result.value.items.length) return;
    remember(result.value.items);
    page.append(row(LIST_TITLES[names[i]], result.value.items, `#/lista/${names[i]}`));
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

function renderPagedGrid(title, loadPage, token) {
  const grid = el('div', { class: 'grid' });
  const more = el('div', { class: 'more' });
  const page = el('div', { class: 'page' }, el('h1', {}, title), grid, more);
  app.replaceChildren(page);

  let next = 1;
  let loading = false;

  async function loadMore() {
    if (loading) return;
    loading = true;
    more.replaceChildren(spinner());
    try {
      const data = await loadPage(next);
      if (token !== navToken) return;
      remember(data.items);
      grid.append(...data.items.map(card));
      next++;
      const hasMore = data.totalPages != null && next <= data.totalPages;
      if (!grid.children.length) more.replaceChildren(el('div', { class: 'state' }, 'Nada encontrado.'));
      else more.replaceChildren(hasMore ? el('button', { class: 'btn', type: 'button', onclick: loadMore }, 'Carregar mais') : '');
    } catch (err) {
      if (token === navToken) more.replaceChildren(errorState(err.message, loadMore));
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

function renderSearch(term, token) {
  renderPagedGrid(`Resultados para “${term}”`, async () => ({ ...(await api(`search?q=${encodeURIComponent(term)}`)), totalPages: 1 }), token);
}

async function renderLibrary(token) {
  app.replaceChildren(spinner());
  try {
    const { continue: resume, watched } = await api('me/library');
    if (token !== navToken) return;
    remember([...resume, ...watched]);

    const section = (title, items, empty) =>
      el('section', {}, el('h2', { class: 'section-title' }, title), items.length ? el('div', { class: 'grid' }, items.map(card)) : el('p', { class: 'empty' }, empty));

    app.replaceChildren(
      el(
        'div',
        { class: 'page' },
        el('h1', {}, 'Minha lista'),
        section('Continuar assistindo', resume, 'Nada em andamento. Abra um filme ou série para ele aparecer aqui.'),
        section('Assistir novamente', watched, 'Marque um título como assistido, no player, para guardá-lo aqui.'),
      ),
    );
  } catch (err) {
    if (token === navToken) app.replaceChildren(errorState(err.message, () => route()));
  }
}

// --- transmitir para a TV ---
// O player é um iframe de outro site: a página não enxerga o <video> nem a URL do vídeo, então não há como usar
// o Google Cast SDK nem a Remote Playback API. A transmissão é feita pelo espelhamento do navegador/aparelho
// (Chromecast pelo Chrome/Edge, AirPlay, Smart View, HDMI), e aqui só se guia a pessoa até lá.

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
    title: 'Outras formas (cabo HDMI, Miracast e navegador da TV)',
    steps: [
      'Cabo HDMI: ligue o computador ou o celular (com adaptador) à TV e escolha a entrada HDMI. É a opção mais estável.',
      'Windows: tecle Windows + K para transmitir a tela para uma TV com Miracast.',
      'Smart TV com navegador: abra o navegador da TV, digite o endereço abaixo, entre na sua conta e abra o filme.',
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

function openCastDialog() {
  const address = location.href;
  const copyLabel = 'Copiar link';
  const link = el('input', { class: 'cast-link', type: 'text', readonly: true, value: address, 'aria-label': 'Endereço deste filme' });
  const copy = el('button', { class: 'btn small', type: 'button' }, copyLabel);
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(address);
      copy.textContent = 'Copiado!';
    } catch {
      link.select();
      copy.textContent = 'Copie com Ctrl+C';
    }
    setTimeout(() => {
      copy.textContent = copyLabel;
    }, 2500);
  });

  const preferred = castGuideFor();
  showDialog(
    'Transmitir para a TV',
    el('p', { class: 'modal-intro' }, 'O filme toca num player de outro site dentro do Cine Local, então a transmissão é feita pelo espelhamento do seu navegador ou aparelho, e não por um botão dentro do player. Funciona na mesma rede Wi-Fi da TV.'),
    ...CAST_GUIDES.map((guide) => guideDetails(guide, guide.id === preferred)),
    el('p', { class: 'modal-tip' }, 'Tela preta ou sem som? Alguns players bloqueiam o espelhamento da aba. No Chrome, em “Fontes”, escolha “Transmitir tela” em vez de “Transmitir guia”.'),
    el('div', { class: 'cast-link-row' }, link, copy),
  );
}

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
  };
  let frameRequest = 0;

  const heading = el('h1', {}, state.title);
  const subtitle = el('p', { class: 'sub' });
  const player = el('div', { class: 'player' });
  const message = el('p', { class: 'form-error', role: 'alert' });

  const openLink = el('a', { class: 'btn primary', target: '_blank', rel: 'noopener noreferrer' }, '▶ Assistir em nova aba');
  const castBtn = el('button', { class: 'btn', type: 'button', onclick: openCastDialog }, icon('tv'), 'Transmitir para a TV');
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
    message,
    el(
      'p',
      { class: 'note' },
      'Se um anúncio abrir em outra aba, feche e volte. Bloqueadores de anúncio impedem o player de tocar.',
    ),
  );
  app.replaceChildren(page);

  // Garante que o item atual (ex.: vindo de link direto) apareça na lista mesmo se a sondagem não o achou.
  function withCurrent(list, current) {
    return current == null || list.includes(current) ? list : [...list, current].sort((a, b) => a - b);
  }

  function fillSelect(select, values, selected, label) {
    select.replaceChildren(...values.map((v) => el('option', { value: v, selected: v === selected }, `${label} ${v}`)));
  }

  function refreshControls() {
    doneBtn.textContent = state.done ? '✓ Assistido (desmarcar)' : 'Marcar como assistido';
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
    openLink.href = data.url;
    player.replaceChildren(
      el('iframe', {
        src: data.url,
        // Sem `sandbox` de propósito: o player do provedor detecta e se recusa a tocar ("remova o Sandbox").
        allowfullscreen: true,
        allow: 'autoplay; fullscreen; encrypted-media; picture-in-picture',
        title: data.title,
      }),
    );
    if (isTv) history.replaceState(null, '', `#/assistir/tv/${id}/${data.season}/${data.episode}`);
    refreshControls();
  }

  async function toggleDone() {
    message.textContent = '';
    try {
      const item = await api('me/done', { method: 'POST', body: { type, id, done: !state.done } });
      state.done = item.done;
      refreshControls();
    } catch (err) {
      message.textContent = err.message;
    }
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
  clearInterval(heroTimer);
  document.title = 'Cine Local';
  window.scrollTo(0, 0);

  const hash = location.hash || '#/';
  let match;

  if ((match = hash.match(/^#\/decisao(?:\/([A-Za-z0-9._-]+))?$/))) {
    setActiveNav(null);
    return renderDecision(match[1], token);
  }
  if (hash === '#/creditos') {
    setActiveNav(null);
    return renderCredits();
  }
  if (hash === '#/login' || hash === '#/cadastro') {
    setActiveNav(null);
    if (session.token) return location.replace('#/');
    return hash === '#/login' ? renderLogin() : renderRegister();
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
    const term = decodeURIComponent(match[1]);
    setActiveNav(null);
    if (document.activeElement !== searchInput) searchInput.value = term;
    return renderSearch(term, token);
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

function goSearch() {
  const term = searchInput.value.trim();
  if (term.length >= 2) location.hash = `#/busca/${encodeURIComponent(term)}`;
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

window.addEventListener('hashchange', route);

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
