'use strict';

/*
 * Lado da TV do "Transmitir para a TV" por código (servidor: netlify/lib/tv.mjs).
 * Gera um código, mostra na tela e pergunta ao servidor o que tocar; quando o celular envia, abre o player.
 * Escrito sem recursos novos de JavaScript (?., ??) porque navegadores de TV costumam ser antigos.
 *
 * Decisões:
 * - Cada pergunta ao servidor é uma função serverless cobrada, então o ritmo tem teto: 5 s nos primeiros 10 min
 *   esperando, 15 s até 30 min e depois PARA (volta com qualquer tecla ou clique); tocando, 10 s. Aba escondida não
 *   pergunta. O código expira sozinho em 6 h no servidor.
 * - O endereço do player é conferido em tv-player.js: só abre o player do provedor, nunca outra origem.
 * - O código e o segredo ficam no localStorage para a TV recarregar sem trocar de código.
 */

(function () {
  var STORE_KEY = 'cine.tv';
  var FAST_MS = 5000;
  var FAST_UNTIL_MS = 10 * 60 * 1000;
  var SLOW_MS = 15000;
  var IDLE_AFTER_MS = 30 * 60 * 1000;
  var PLAYING_MS = 10000;
  var RETRY_MS = 15000;

  var codeEl = document.getElementById('code');
  var statusEl = document.getElementById('status');
  document.getElementById('address').textContent = 'Esta TV: ' + location.host + '/tv';

  var session = readSession();
  var lastSeq = null;
  var playing = false;
  var paused = false;
  var lastActivity = Date.now();
  var timer = null;

  function readSession() {
    try {
      var saved = JSON.parse(localStorage.getItem(STORE_KEY));
      if (saved && saved.code && saved.secret && saved.expiresAt > Date.now()) return saved;
    } catch (e) {
      /* sem storage: gera código novo a cada abertura */
    }
    return null;
  }

  function saveSession(value) {
    try {
      if (value) localStorage.setItem(STORE_KEY, JSON.stringify(value));
      else localStorage.removeItem(STORE_KEY);
    } catch (e) {
      /* ignora */
    }
  }

  function setStatus(text, warn) {
    statusEl.textContent = text;
    statusEl.className = 'tv-status' + (warn ? ' warn' : '');
  }

  function showCode(code) {
    codeEl.textContent = code.slice(0, 3) + ' ' + code.slice(3);
  }

  async function post(path, body) {
    var res = await fetch('/api/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    var data = {};
    try {
      data = await res.json();
    } catch (e) {
      /* corpo vazio ou inválido */
    }
    return { status: res.status, data: data };
  }

  async function pairNew() {
    var res = await post('tv/pair');
    if (res.status !== 200) throw new Error('pair_' + res.status);
    session = { code: res.data.code, secret: res.data.secret, expiresAt: Date.now() + res.data.expiresInSec * 1000 };
    saveSession(session);
    lastSeq = null;
    showCode(session.code);
  }

  function stopPlaying() {
    playing = false;
    window.TvPlayer.clear();
    setStatus('Aguardando você enviar um filme…');
  }

  function startPlaying(play) {
    // endereço que não é do provedor é ignorado (a tela de espera continua)
    playing = window.TvPlayer.show(play);
  }

  async function poll() {
    if (!session) {
      await pairNew();
      setStatus('Aguardando você enviar um filme…');
    }
    var res = await post('tv/poll', { code: session.code, secret: session.secret });
    if (res.status === 410) {
      // código expirado ou apagado: troca por outro
      session = null;
      saveSession(null);
      stopPlaying();
      await pairNew();
      return;
    }
    if (res.status !== 200) throw new Error('poll_' + res.status);
    if (res.data.seq === lastSeq) return;
    lastSeq = res.data.seq;
    lastActivity = Date.now();
    if (res.data.status === 'playing' && res.data.play) startPlaying(res.data.play);
    else stopPlaying();
  }

  function nextDelay() {
    if (playing) return PLAYING_MS;
    return Date.now() - lastActivity < FAST_UNTIL_MS ? FAST_MS : SLOW_MS;
  }

  function schedule(delay) {
    clearTimeout(timer);
    if (!paused) timer = setTimeout(tick, delay === undefined ? nextDelay() : delay);
  }

  function pause() {
    paused = true;
    clearTimeout(timer);
    stopPlaying();
    setStatus('Sem atividade há um tempo. Pressione OK (ou clique) para continuar aguardando.', true);
  }

  async function tick() {
    if (document.hidden) return schedule();
    if (!playing && Date.now() - lastActivity > IDLE_AFTER_MS) return pause();
    try {
      await poll();
      schedule();
    } catch (e) {
      if (e.message === 'pair_429') {
        setStatus('Códigos demais gerados por aqui. Tentando de novo em 1 minuto…', true);
        schedule(60000);
      } else {
        setStatus('Sem conexão com o Cine Local. Tentando de novo…', true);
        schedule(RETRY_MS);
      }
    }
  }

  // Tecla do controle ou clique: mantém o ritmo rápido e acorda a TV depois da pausa.
  function activity() {
    lastActivity = Date.now();
    if (paused) {
      paused = false;
      setStatus('Aguardando você enviar um filme…');
      tick();
    }
  }
  document.addEventListener('keydown', activity);
  document.addEventListener('click', activity);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && !paused) {
      clearTimeout(timer);
      tick();
    }
  });

  if (session) showCode(session.code);
  tick();
})();
