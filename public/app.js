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

const session = { token: null, name: null };

try {
  session.token = localStorage.getItem(TOKEN_KEY);
} catch {
  /* sem storage: a sessão dura só até recarregar a página */
}

function clearSession(message) {
  session.token = null;
  session.name = null;
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

function updateChrome() {
  document.body.classList.toggle('anon', !session.token);
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

let blockPopups = readStore('cine.blockPopups').on !== false;

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
    el('div', { class: 'row-head' }, el('h2', {}, title), el('a', { href }, 'Ver tudo')),
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

function field(label, id, attrs) {
  return el('div', { class: 'field' }, el('label', { for: id }, label), el('input', { id, name: id, required: true, ...attrs }));
}

// --- páginas públicas: login, cadastro e decisão do admin ---

function renderLogin() {
  const message = el('p', { class: 'form-info', role: 'status' }, flash);
  flash = null;
  const error = el('p', { class: 'form-error', role: 'alert' });
  const submit = el('button', { class: 'btn primary', type: 'submit' }, 'Entrar');

  const form = el(
    'form',
    {
      class: 'auth-card',
      onsubmit: async (event) => {
        event.preventDefault();
        error.textContent = '';
        submit.disabled = true;
        try {
          const data = await api('auth/login', {
            method: 'POST',
            body: { email: form.elements.email.value, password: form.elements.password.value },
          });
          session.token = data.token;
          session.name = data.user.name;
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
          submit.disabled = false;
        }
      },
    },
    el('h1', {}, 'Entrar'),
    message,
    field('E-mail', 'email', { type: 'email', autocomplete: 'username', maxlength: '254' }),
    field('Senha', 'password', { type: 'password', autocomplete: 'current-password', maxlength: '128' }),
    error,
    submit,
    el('p', { class: 'auth-alt' }, 'Ainda não tem conta? ', el('a', { href: '#/cadastro' }, 'Solicitar cadastro')),
  );
  app.replaceChildren(el('div', { class: 'auth-wrap' }, form));
  form.elements.email.focus();
}

function renderRegister() {
  const error = el('p', { class: 'form-error', role: 'alert' });
  const submit = el('button', { class: 'btn primary', type: 'submit' }, 'Solicitar cadastro');
  const wrap = el('div', { class: 'auth-wrap' });

  const form = el(
    'form',
    {
      class: 'auth-card',
      onsubmit: async (event) => {
        event.preventDefault();
        error.textContent = '';
        const { name, email, password, password2 } = form.elements;
        if (password.value !== password2.value) {
          error.textContent = 'As senhas não conferem.';
          return;
        }
        submit.disabled = true;
        try {
          const data = await api('auth/register', {
            method: 'POST',
            body: { name: name.value, email: email.value, password: password.value },
          });
          wrap.replaceChildren(
            el(
              'div',
              { class: 'auth-card' },
              el('h1', {}, 'Solicitação enviada'),
              el('p', { class: 'form-info', role: 'status' }, data.message),
              el('a', { class: 'btn', href: '#/login' }, 'Ir para o login'),
            ),
          );
        } catch (err) {
          error.textContent = err.message;
          submit.disabled = false;
        }
      },
    },
    el('h1', {}, 'Solicitar cadastro'),
    el('p', { class: 'auth-hint' }, 'O acesso é liberado depois que o administrador aprovar o seu cadastro.'),
    field('Nome', 'name', { type: 'text', autocomplete: 'name', maxlength: '60' }),
    field('E-mail', 'email', { type: 'email', autocomplete: 'username', maxlength: '254' }),
    field('Senha (mínimo de 10 caracteres)', 'password', { type: 'password', autocomplete: 'new-password', minlength: '10', maxlength: '128' }),
    field('Repita a senha', 'password2', { type: 'password', autocomplete: 'new-password', maxlength: '128' }),
    error,
    submit,
    el('p', { class: 'auth-alt' }, 'Já tem conta? ', el('a', { href: '#/login' }, 'Entrar')),
  );
  wrap.append(form);
  app.replaceChildren(wrap);
  form.elements.name.focus();
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
  const [libraryResult, ...results] = await Promise.allSettled([api('me/library'), ...names.map((name) => api(`list/${name}`))]);
  if (token !== navToken) return;

  const page = el('div');
  const featured = results[0].status === 'fulfilled' ? results[0].value.items.filter((i) => i.poster && i.backdrop).slice(0, HERO_SIZE) : [];
  if (featured.length) page.append(hero(featured));

  if (libraryResult.status === 'fulfilled') {
    const { continue: resume, watched } = libraryResult.value;
    remember([...resume, ...watched]);
    if (resume.length) page.append(row('Continuar assistindo', resume, '#/biblioteca'));
    if (watched.length) page.append(row('Assistir novamente', watched, '#/biblioteca'));
  }

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
  if (!LIST_TITLES[name]) {
    app.replaceChildren(errorState('lista inexistente'));
    return;
  }
  renderPagedGrid(LIST_TITLES[name], (page) => api(`list/${name}?page=${page}`), token);
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
  const reloadBtn = el('button', { class: 'btn', type: 'button', onclick: () => loadFrame() }, 'Recarregar player');
  const doneBtn = el('button', { class: 'btn', type: 'button', onclick: () => toggleDone() }, 'Marcar como assistido');
  const popupToggle = el('input', {
    type: 'checkbox',
    id: 'block-popups',
    checked: blockPopups,
    onchange: () => {
      blockPopups = popupToggle.checked;
      writeStore('cine.blockPopups', { on: blockPopups });
      loadFrame();
    },
  });
  const popupLabel = el('label', { class: 'toggle', for: 'block-popups' }, popupToggle, 'Bloquear pop-ups');

  const page = el(
    'div',
    { class: 'watch' },
    el(
      'div',
      { class: 'watch-head' },
      el('div', {}, heading, subtitle),
      el('div', { class: 'controls' }, popupLabel, doneBtn, openLink, reloadBtn),
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
        { class: 'controls' },
        el('label', { for: 'season' }, 'Temporada'),
        seasonSelect,
        el('label', { for: 'episode' }, 'Episódio'),
        episodeSelect,
        el('span', { class: 'spacer' }),
        prevBtn,
        nextBtn,
      ),
    );
  }
  page.append(
    message,
    el(
      'p',
      { class: 'note' },
      'Se o player embutido mostrar “Acesso não autorizado” (acontece em localhost ou por IP), acesse pelo endereço do site publicado ou use “Assistir em nova aba”.',
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
        // Sem allow-popups/allow-top-navigation: o player não abre abas nem redireciona a página.
        sandbox: blockPopups ? 'allow-scripts allow-same-origin allow-forms' : null,
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
  if (hash === '#/login' || hash === '#/cadastro') {
    setActiveNav(null);
    if (session.token) return location.replace('#/');
    return hash === '#/login' ? renderLogin() : renderRegister();
  }
  if (!session.token) return location.replace('#/login');

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

async function boot() {
  updateChrome();
  if (session.token) {
    try {
      session.name = (await api('auth/me')).name;
    } catch {
      /* 401 já limpou a sessão; falha de rede deixa as telas mostrarem o erro */
    }
    updateChrome();
  }
  route();
}

boot();
