/*
 * Parte comum das duas telas que rodam na TV: tv.html (pareamento por código) e receiver.html (Chromecast).
 * Abre e fecha o player do provedor em tela cheia.
 *
 * Decisões:
 * - ES5 puro (var, function, sem URL/fetch/Promise): navegador de TV costuma ser antigo, e um único recurso novo
 *   vira erro de sintaxe e a página inteira nem roda. O teste test/tv-pages.test.mjs trava isso.
 * - O endereço é conferido aqui, na ponta que abre o iframe, mesmo já tendo passado pelo servidor ou pelo celular.
 *   Só abre https://embedplayapi.top/embed/<id> (ou <id>/<temporada>/<episódio>), nunca outra origem. Uma expressão
 *   regular sobre a URL inteira (em vez de `new URL`) recusa também usuário@, porta e subdomínio enganoso.
 */
window.TvPlayer = (function () {
  'use strict';

  var EMBED_URL = /^https:\/\/embedplayapi\.top\/embed\/\d{1,9}(\/\d{1,2}\/\d{1,3})?$/;
  var NOW_VISIBLE_MS = 6000;

  var wait = document.getElementById('wait');
  var stage = document.getElementById('stage');
  var player = document.getElementById('player');
  var now = document.getElementById('now');
  var nowTimer = null;

  // O atributo `hidden` + a regra [hidden] do tv.css funciona até em navegador que não tem a propriedade .hidden.
  function setHidden(node, hidden) {
    if (hidden) node.setAttribute('hidden', '');
    else node.removeAttribute('hidden');
  }

  // Devolve false (e não muda nada na tela) se o endereço não for do provedor.
  function show(play) {
    var url = play && typeof play.url === 'string' && EMBED_URL.test(play.url) ? play.url : null;
    if (!url) return false;

    var frame = document.createElement('iframe');
    frame.setAttribute('src', url);
    frame.setAttribute('allow', 'autoplay; fullscreen; encrypted-media; picture-in-picture');
    frame.setAttribute('allowfullscreen', '');
    frame.setAttribute('title', play.title || 'Filme');
    player.innerHTML = '';
    player.appendChild(frame);
    setHidden(wait, true);
    setHidden(stage, false);

    var label = play.title ? String(play.title) : '';
    if (play.season) label += (label ? ' · ' : '') + 'Temporada ' + play.season + ' · Episódio ' + play.episode;
    clearTimeout(nowTimer);
    now.textContent = label;
    setHidden(now, !label);
    if (label) {
      nowTimer = setTimeout(function () {
        setHidden(now, true);
      }, NOW_VISIBLE_MS);
    }
    return true;
  }

  function clear() {
    clearTimeout(nowTimer);
    player.innerHTML = '';
    setHidden(now, true);
    setHidden(stage, true);
    setHidden(wait, false);
  }

  return { show: show, clear: clear };
})();
