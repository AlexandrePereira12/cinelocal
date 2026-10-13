/*
 * Lado da TV do "Transmitir para a TV" por código (servidor: netlify/lib/tv.mjs).
 * Gera um código, mostra na tela e pergunta ao servidor o que tocar; quando o celular envia, abre o player.
 *
 * Decisões:
 * - ES5 puro, com XMLHttpRequest e callbacks (sem fetch, Promise, async/await, const/let, setas, template string):
 *   TV antiga não roda nada disso, e um recurso novo derruba a página inteira em silêncio. O teste
 *   test/tv-pages.test.mjs trava isso. Se o script não rodar, a tela fica no texto "Carregando…" do HTML.
 * - Cada pergunta ao servidor é uma função serverless cobrada, então o ritmo tem teto: 5 s nos primeiros 10 min
 *   esperando, 15 s até 30 min e depois PARA (volta com qualquer tecla ou clique); tocando, 10 s. Aba escondida não
 *   pergunta. O código expira sozinho em 6 h no servidor.
 * - Se o servidor responder "código inválido" várias vezes seguidas, a TV para de trocar de código e espera 1 min
 *   (sem isso um problema no servidor faria o código mudar sem parar e gastaria o limite de códigos por IP).
 * - O endereço do player é conferido em tv-player.js: só abre o player do provedor, nunca outra origem.
 * - O código e o segredo ficam no localStorage para a TV recarregar sem trocar de código.
 */

(function () {
  'use strict';

  var STORE_KEY = 'cine.tv';
  var FAST_MS = 5000;
  var FAST_UNTIL_MS = 10 * 60 * 1000;
  var SLOW_MS = 15000;
  var IDLE_AFTER_MS = 30 * 60 * 1000;
  var PLAYING_MS = 10000;
  var RETRY_MS = 15000;
  var GONE_LIMIT = 3;
  var GONE_WINDOW_MS = 60 * 1000;
  var GONE_WAIT_MS = 60 * 1000;

  var codeEl = document.getElementById('code');
  var statusEl = document.getElementById('status');
  document.getElementById('address').textContent = 'Esta TV: ' + location.host + '/tv';

  var session = readSession();
  var lastSeq = null;
  var playing = false;
  var paused = false;
  var lastActivity = new Date().getTime();
  var timer = null;
  var goneTimes = [];

  function nowMs() {
    return new Date().getTime();
  }

  function readSession() {
    try {
      var saved = JSON.parse(localStorage.getItem(STORE_KEY));
      if (saved && saved.code && saved.secret && saved.expiresAt > nowMs()) return saved;
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

  // done(erro, status, dados): erro só para falha de rede/tempo esgotado; resposta do servidor vem em status.
  function post(path, body, done) {
    var finished = false;
    function finish(err, status, data) {
      if (finished) return;
      finished = true;
      done(err, status, data);
    }
    var xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/' + path, true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.timeout = 20000;
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      if (xhr.status === 0) return finish(new Error('rede'));
      var data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch (e) {
        /* corpo vazio ou inválido */
      }
      finish(null, xhr.status, data);
    };
    xhr.ontimeout = function () {
      finish(new Error('tempo'));
    };
    xhr.send(body ? JSON.stringify(body) : null);
  }

  function pairNew(done) {
    post('tv/pair', null, function (err, status, data) {
      if (err) return done(err);
      if (status !== 200) return done(new Error('pair_' + status));
      session = { code: data.code, secret: data.secret, expiresAt: nowMs() + data.expiresInSec * 1000 };
      saveSession(session);
      lastSeq = null;
      showCode(session.code);
      done(null);
    });
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

  // O servidor disse que o código não vale mais várias vezes seguidas: algo está errado, não insistir trocando de código.
  function tooManyGone() {
    var cutoff = nowMs() - GONE_WINDOW_MS;
    var recent = [];
    for (var i = 0; i < goneTimes.length; i++) if (goneTimes[i] > cutoff) recent.push(goneTimes[i]);
    recent.push(nowMs());
    goneTimes = recent;
    return recent.length >= GONE_LIMIT;
  }

  function pollOnce(done) {
    post('tv/poll', { code: session.code, secret: session.secret }, function (err, status, data) {
      if (err) return done(err);
      if (status === 410) {
        // código expirado ou apagado: troca por outro (a menos que isso esteja se repetindo)
        session = null;
        saveSession(null);
        stopPlaying();
        if (tooManyGone()) return done(new Error('gone_loop'));
        return pairNew(done);
      }
      if (status !== 200) return done(new Error('poll_' + status));
      goneTimes = [];
      if (data.seq === lastSeq) return done(null);
      lastSeq = data.seq;
      lastActivity = nowMs();
      if (data.status === 'playing' && data.play) startPlaying(data.play);
      else stopPlaying();
      done(null);
    });
  }

  function poll(done) {
    if (session) return pollOnce(done);
    pairNew(function (err) {
      if (err) return done(err);
      setStatus('Aguardando você enviar um filme…');
      pollOnce(done);
    });
  }

  function nextDelay() {
    if (playing) return PLAYING_MS;
    return nowMs() - lastActivity < FAST_UNTIL_MS ? FAST_MS : SLOW_MS;
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

  function tick() {
    if (document.hidden) return schedule();
    if (!playing && nowMs() - lastActivity > IDLE_AFTER_MS) return pause();
    poll(function (err) {
      if (!err) return schedule();
      var reason = err.message;
      if (reason === 'pair_429') {
        setStatus('Códigos demais gerados por aqui. Tentando de novo em 1 minuto…', true);
        schedule(60000);
      } else if (reason === 'gone_loop') {
        setStatus('O servidor não está aceitando o código. Tentando de novo em 1 minuto…', true);
        schedule(GONE_WAIT_MS);
      } else {
        // o motivo aparece na tela porque TV não tem console: ajuda a descobrir o que está falhando
        setStatus('Sem conexão com o Cine Local (' + reason + '). Tentando de novo…', true);
        schedule(RETRY_MS);
      }
    });
  }

  // Tecla do controle ou clique: mantém o ritmo rápido e acorda a TV depois da pausa.
  function activity() {
    lastActivity = nowMs();
    if (paused) {
      paused = false;
      setStatus('Aguardando você enviar um filme…');
      tick();
    }
  }
  document.addEventListener('keydown', activity, false);
  document.addEventListener('click', activity, false);
  document.addEventListener(
    'visibilitychange',
    function () {
      if (!document.hidden && !paused) {
        clearTimeout(timer);
        tick();
      }
    },
    false
  );

  setStatus('Gerando o código…');
  if (session) showCode(session.code);
  tick();
})();
