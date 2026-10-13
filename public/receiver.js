'use strict';

/*
 * Receptor do Chromecast (Google Cast Web Receiver personalizado): roda NA TV, aberto pelo Chromecast.
 * Registre a URL https://SEU-SITE/receiver.html no console do Google Cast para obter o App ID (CAST_APP_ID).
 * O site (app.js) manda {type:'play', url, title, season, episode} ou {type:'stop'} neste namespace.
 *
 * Decisões:
 * - O receptor responde cada comando com {type:'ack', ok, reason}: a TV não tem como ser depurada, e assim o
 *   celular mostra se o envio foi recusado.
 * - `disableIdleTimeout`: sem mídia do Cast tocando, o Chromecast fecharia o receptor por inatividade e a TV
 *   voltaria para a tela inicial no meio do filme.
 * - O endereço do player é validado em TvPlayer.show (tv-player.js), não aqui.
 */
(function () {
  var NAMESPACE = 'urn:x-cast:com.cinelocal.tv'; // igual ao de app.js
  var context = cast.framework.CastReceiverContext.getInstance();

  context.addCustomMessageListener(NAMESPACE, function (event) {
    var message = event.data || {};
    var ok = true;
    var reason;

    if (message.type === 'play') {
      ok = window.TvPlayer.show(message);
      if (!ok) reason = 'endereço inválido';
    } else if (message.type === 'stop') {
      window.TvPlayer.clear();
    } else {
      ok = false;
      reason = 'comando desconhecido';
    }
    var ack = { type: 'ack', ok: ok };
    if (reason) ack.reason = reason;
    context.sendCustomMessage(NAMESPACE, event.senderId, ack);
  });

  var namespaces = {};
  namespaces[NAMESPACE] = cast.framework.system.MessageType.JSON;
  context.start({ customNamespaces: namespaces, disableIdleTimeout: true });
})();
