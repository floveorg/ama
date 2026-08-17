/* Ama liberada — helpers puros (compartidos por la página y los tests).
   Se carga como <script src="ama.js"> (expone window.Ama) y como módulo Node. */
(function (global) {
  'use strict';

  var LICENSE = 'CC BY-SA 4.0';
  var LICENSE_URL = 'https://creativecommons.org/licenses/by-sa/4.0/deed.es';

  function isVideoClip(c) {
    if (!c) return false;
    if (c.video === true || c.kind === 'video' || c.type === 'video') return true;
    return /\.(mp4|webm|mov|m4v|ogv)$/i.test(String(c.src || ''));
  }

  function buildAmaTracks(amors) {
    if (!Array.isArray(amors)) return [];
    return amors
      .filter(function (c) { return c && c.src; })
      .map(function (c) {
        return {
          t: c.t || ('Amor de ' + (c.name || 'alguien')),
          src: c.src,
          tags: c.tags || 'amor libre',
          by: (c.name || 'Anónimo') + ' · ' + LICENSE,
          tg: c.tg || '',
          key: c.key || '',
          orig: LICENSE_URL,
          origLabel: 'licencia',
          isVideo: isVideoClip(c),
          clip: c
        };
      });
  }

  function latestFeed(amors, n) {
    if (!Array.isArray(amors)) return [];
    return amors.slice(0, n || 6).map(function (c) {
      return {
        name: (c && c.name) || 'Anónimo',
        tags: (c && c.tags) || 'amor libre',
        when: (c && c.when) || 'ahora'
      };
    });
  }

  function clipsOf(ama) {
    if (Array.isArray(ama)) return ama;
    return (ama && Array.isArray(ama.clips)) ? ama.clips : [];
  }

  function risaOf(ama) {
    return (ama && !Array.isArray(ama) && ama.risa && Array.isArray(ama.risa))
      ? ama.risa : [];
  }

  function flagsOf(ama) {
    return (ama && !Array.isArray(ama) && ama.flag && typeof ama.flag === 'object')
      ? ama.flag : {};
  }

  var api = {
    buildAmaTracks: buildAmaTracks,
    latestFeed: latestFeed,
    clipsOf: clipsOf,
    risaOf: risaOf,
    flagsOf: flagsOf,
    AMA_URL: 'https://ama.liberada.net/ama.json',
    RISA_URL: 'https://risa.liberada.net/risa.json',
    TELEGRAM_BOT: 'https://t.me/AmaLiberadaBot',
    LICENSE: LICENSE,
    LICENSE_URL: LICENSE_URL
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.Ama = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
