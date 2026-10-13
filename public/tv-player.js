'use strict';

/*
 * Parte comum das duas telas que rodam na TV: tv.html (pareamento por código) e receiver.html (Chromecast).
 * Abre e fecha o player do provedor em tela cheia. Sem recursos novos de JavaScript (?., ??): TVs têm navegador velho.
 *
 * Decisão: o endereço é conferido aqui, na ponta que abre o iframe, mesmo já tendo passado pelo servidor ou pelo
 * celular. Só abre https://embedplayapi.top/embed/..., nunca outra origem.
 */
window.TvPlayer = (function () {
  var EMBED_ORIGIN = 'https://embedplayapi.top';
  var NOW_VISIBLE_MS = 6000;

  var wait = document.getElementById('wait');
  var stage = document.getElementById('stage');
  var player = document.getElementById('player');
  var now = document.getElementById('now');
  var nowTimer = null;

  function safeUrl(value) {
    try {
      var url = new URL(value);
      return url.origin === EMBED_ORIGIN && url.pathname.indexOf('/embed/') === 0 ? url.href : null;
    } catch (e) {
      return null;
    }
  }

  // Devolve false (e não muda nada na tela) se o endereço não for do provedor.
  function show(play) {
    var url = safeUrl(play && play.url);
    if (!url) return false;
    var frame = document.createElement('iframe');
    frame.src = url;
    frame.allow = 'autoplay; fullscreen; encrypted-media; picture-in-picture';
    frame.setAttribute('allowfullscreen', '');
    frame.title = play.title || 'Filme';
    player.textContent = '';
    player.appendChild(frame);
    wait.hidden = true;
    stage.hidden = false;

    var label = play.title ? play.title : '';
    if (play.season) label += (label ? ' · ' : '') + 'Temporada ' + play.season + ' · Episódio ' + play.episode;
    clearTimeout(nowTimer);
    now.hidden = !label;
    now.textContent = label;
    if (label) {
      now.style.animation = 'none';
      void now.offsetWidth; // reinicia a animação de sumir
      now.style.animation = '';
      nowTimer = setTimeout(function () {
        now.hidden = true;
      }, NOW_VISIBLE_MS);
    }
    return true;
  }

  function clear() {
    clearTimeout(nowTimer);
    player.textContent = '';
    now.hidden = true;
    stage.hidden = true;
    wait.hidden = false;
  }

  return { show: show, clear: clear };
})();
