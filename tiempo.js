/* =========================================================
   Mi Agenda · Tiempo de estudio automático (tiempo.js)
   Cuenta solo los minutos que usas cada app y los suma a su área
   (japones, caligrafia, lectura, medicina u otro) para las
   Estadísticas y el Aprendizaje del Dashboard.

   Uso, en el <head> de cada app (después de sync.js si lo tiene):
     <script src="tiempo.js" data-area="japones" data-app="kanji"></script>

   · Solo cuenta mientras usas la app: si no tocas nada en 2 minutos,
     deja de contar (un vídeo o audio en marcha sí cuenta).
   · Cada aparato guarda lo suyo en «tiempo-<aparato>» (localStorage,
     se sincroniza con sync.js), así el iPad y el iPhone nunca se pisan.
   ========================================================= */
(function () {
  'use strict';
  if (window.__MA_TIEMPO__) return;
  window.__MA_TIEMPO__ = true;

  const me = document.currentScript || document.querySelector('script[src*="tiempo.js"]');
  const AREAS = ['japones', 'caligrafia', 'lectura', 'medicina', 'otro'];
  const area = me && AREAS.includes(me.dataset.area) ? me.dataset.area : 'otro';
  const app = (me && me.dataset.app) || (location.pathname.split('/').pop() || 'index').replace(/\.html?$/, '') || 'index';

  const TICK = 15;               // segundos
  const IDLE = 120000;           // 2 min sin tocar nada → deja de contar
  const FLUSH_EVERY = 8;         // guardar cada 8 ticks (2 min)
  const KEEP_DAYS = 460;

  let dev = null, pend = {}, ticks = 0, lastAct = Date.now();
  const pad = n => String(n).padStart(2, '0');
  const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  /* Identificador de este aparato: en una base que sync.js no copia (empieza por «__») */
  function loadDev() {
    return new Promise(res => {
      try {
        const r = indexedDB.open('__tiempo', 1);
        r.onupgradeneeded = () => { try { r.result.createObjectStore('meta'); } catch (e) { } };
        r.onsuccess = () => {
          const db = r.result;
          try {
            const tx = db.transaction('meta', 'readwrite'), st = tx.objectStore('meta');
            const q = st.get('dev');
            q.onsuccess = () => {
              let v = q.result;
              if (!v) { v = Date.now().toString(36) + Math.random().toString(36).slice(2, 7); st.put(v, 'dev'); }
              tx.oncomplete = () => { db.close(); res(v); };
            };
            tx.onerror = () => { db.close(); res(null); };
          } catch (e) { db.close(); res(null); }
        };
        r.onerror = () => res(null);
      } catch (e) { res(null); }
    });
  }

  function flush() {
    if (!dev || !Object.keys(pend).length) return;
    const key = 'tiempo-' + dev;
    let o; try { o = JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch (e) { o = {}; }
    o.v = 1; o.d = o.d || {};
    for (const [d, v] of Object.entries(pend)) {
      const t = o.d[d] || (o.d[d] = {});
      for (const [k, s] of Object.entries(v)) {
        if (k === 'apps') { t.apps = t.apps || {}; for (const [a, x] of Object.entries(s)) t.apps[a] = (t.apps[a] || 0) + x; }
        else t[k] = (t[k] || 0) + s;
      }
    }
    const lim = new Date(); lim.setDate(lim.getDate() - KEEP_DAYS);
    const limK = dayKey(lim);
    for (const d of Object.keys(o.d)) if (d < limK) delete o.d[d];
    try { localStorage.setItem(key, JSON.stringify(o)); pend = {}; } catch (e) { }
  }

  function mediaPlaying() {
    try { return [...document.querySelectorAll('video, audio')].some(m => !m.paused && !m.ended); } catch (e) { return false; }
  }

  const act = () => { lastAct = Date.now(); };
  ['pointerdown', 'keydown', 'wheel', 'touchstart', 'input'].forEach(ev => document.addEventListener(ev, act, { passive: true, capture: true }));
  document.addEventListener('scroll', act, { passive: true, capture: true });
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); else act(); });
  window.addEventListener('pagehide', flush);

  setInterval(() => {
    if (document.hidden) return;
    if (Date.now() - lastAct > IDLE && !mediaPlaying()) return;
    const d = dayKey(), p = pend[d] || (pend[d] = {});
    p[area] = (p[area] || 0) + TICK;
    p.apps = p.apps || {}; p.apps[app] = (p.apps[app] || 0) + TICK;
    if (++ticks % FLUSH_EVERY === 0) flush();
  }, TICK * 1000);

  loadDev().then(v => { dev = v || 'aparato'; });

  /* Para consultar desde la consola o desde otra app */
  window.MiAgendaTiempo = {
    area, app,
    hoy() {
      flush();
      const d = dayKey(), out = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i) || '';
        if (!k.startsWith('tiempo-')) continue;
        try { const v = (JSON.parse(localStorage.getItem(k) || '{}').d || {})[d] || {}; for (const a of AREAS) if (v[a]) out[a] = (out[a] || 0) + v[a]; } catch (e) { }
      }
      return out;
    }
  };
})();
