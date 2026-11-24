/* =========================================================
   Mi Agenda · Sincronización con GitHub (sync.js)
   Guarda los datos de todas las apps (localStorage e IndexedDB,
   con fotos y archivos) en un almacén PRIVADO de tu GitHub,
   para tenerlos iguales en el iPad y en el iPhone.
   Va lo primero en el <head> de cada página.
   ========================================================= */
(function () {
  'use strict';
  if (window.__MA_SYNC__) return;
  window.__MA_SYNC__ = true;

  const PFX = 'masync:';
  const API = 'https://api.github.com';
  const MAX_BLOB = 25 * 1024 * 1024; // archivos de más de 25 MB no se sincronizan
  const BIG_STR = 150 * 1024;          // textos más largos (dibujos, fotos en texto) van en archivos aparte
  const MAX_UNIT = 30 * 1024 * 1024;
  const LS = window.localStorage;
  const SP = Storage.prototype;
  const S_get = SP.getItem, S_set = SP.setItem, S_rem = SP.removeItem, S_clear = SP.clear, S_key = SP.key;
  const lsGet = k => S_get.call(LS, k);
  const lsSet = (k, v) => S_set.call(LS, k, v);
  const lsRem = k => S_rem.call(LS, k);
  const lsKeys = () => { const a = []; for (let i = 0; i < LS.length; i++) a.push(S_key.call(LS, i)); return a; };

  const exclLS = k => k == null || k.startsWith(PFX) || /^firebase/i.test(k);
  const exclDB = n => !n || /^(firebase|firestore|workbox|__)/i.test(n);

  function jget(k, d) { try { const v = lsGet(PFX + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function jset(k, v) { try { lsSet(PFX + k, JSON.stringify(v)); } catch (e) { } }

  let cfg = jget('cfg', null);         // {owner, repo, token, branch, setup}
  let base = jget('base', {});         // ruta -> {sha, h}  (versión de la nube y huella del contenido)
  let dirty = jget('dirty', {});       // ruta -> hora del último cambio local
  const dirtyAtStart = Object.assign({}, dirty);
  let knownDBs = jget('dbs', []);
  let frozen = false;                  // mientras se aplican datos de la nube
  let hold = true;                     // hasta la primera sincronización de esta página
  const held = new Set();
  let busy = null;
  let fullCheckDone = false;
  const status = { state: 'idle', msg: '', last: jget('last', 0), err: jget('err', '') };

  const device = jget('dev', null) || (() => {
    const ua = navigator.userAgent;
    const n = /iPhone/.test(ua) ? 'iPhone' : (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) ? 'iPad' : /Mac/.test(ua) ? 'Mac' : 'Aparato';
    const d = n + '-' + Math.random().toString(36).slice(2, 6);
    jset('dev', d); return d;
  })();

  /* ---------- utilidades ---------- */
  const te = new TextEncoder(), td = new TextDecoder();
  function b64u(str) { const u = te.encode(str); let s = ''; for (const b of u) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function unb64u(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; const b = atob(s); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return td.decode(u); }
  function bytesToB64(u) { let s = ''; const CH = 0x8000; for (let i = 0; i < u.length; i += CH) s += String.fromCharCode.apply(null, u.subarray(i, i + CH)); return btoa(s); }
  function b64ToBytes(b) { const s = atob(b); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }
  async function sha256hex(data) { const h = await crypto.subtle.digest('SHA-256', data); return [...new Uint8Array(h)].map(x => x.toString(16).padStart(2, '0')).join(''); }
  const lsPath = k => 'ls/' + b64u(k) + '.json';
  const idbPath = n => 'idb/' + b64u(n) + '.json';
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /* ---------- Apple Pencil: que iPadOS no corte los trazos ---------- */
  // Si el sistema "se queda" con el toque del lápiz (desplazar, Escritura a mano, lupa…)
  // el trazo se corta a mitad. Cancelamos solo los toques del lápiz que caen sobre
  // una zona de dibujo (canvas); el dedo sigue funcionando igual.
  let penBusyUntil = 0, penOnCanvas = false;
  const PEN_IDLE = 5000;
  const NO_DRAW = 'input,textarea,select,button,a,label,[contenteditable="true"],[contenteditable=""]';
  function isDrawZone(t) {
    if (!t || t.nodeType !== 1 || t.closest(NO_DRAW)) return false;
    return t.tagName === 'CANVAS';
  }
  const hasStylus = list => { for (let i = 0; i < list.length; i++) if (list[i].touchType === 'stylus') return true; return false; };
  document.addEventListener('touchstart', e => {
    if (!hasStylus(e.changedTouches)) return;
    penBusyUntil = Date.now() + PEN_IDLE;
    penOnCanvas = isDrawZone(e.target);
    if (penOnCanvas && e.cancelable) e.preventDefault();
  }, { capture: true, passive: false });
  document.addEventListener('touchmove', e => {
    if (!hasStylus(e.touches)) return;
    penBusyUntil = Date.now() + PEN_IDLE;
    if (penOnCanvas && e.cancelable) e.preventDefault();
  }, { capture: true, passive: false });
  ['touchend', 'touchcancel'].forEach(n => document.addEventListener(n, e => {
    if (!hasStylus(e.changedTouches)) return;
    penBusyUntil = Date.now() + PEN_IDLE;
    if (!hasStylus(e.touches)) penOnCanvas = false;
  }, { capture: true, passive: true }));
  document.addEventListener('selectstart', e => { if (penOnCanvas) e.preventDefault(); }, { capture: true });
  ['pointerdown', 'pointermove'].forEach(n => document.addEventListener(n, e => {
    if (e.pointerType === 'pen') penBusyUntil = Date.now() + PEN_IDLE;
  }, { capture: true, passive: true }));

  /* ---------- vigilar los cambios de las apps ---------- */
  function mark(path) {
    if (hold) { held.add(path); return; }
    dirty[path] = Date.now(); jset('dirty', dirty); schedulePush();
  }
  SP.setItem = function (k, v) {
    if (this === LS) {
      k = String(k);
      if (frozen && !exclLS(k)) return;
      const old = lsGet(k);
      S_set.call(this, k, v);
      if (!exclLS(k) && old !== String(v)) mark(lsPath(k));
      return;
    }
    return S_set.call(this, k, v);
  };
  SP.removeItem = function (k) {
    if (this === LS) {
      k = String(k);
      if (frozen && !exclLS(k)) return;
      const had = lsGet(k) !== null;
      S_rem.call(this, k);
      if (had && !exclLS(k)) mark(lsPath(k));
      return;
    }
    return S_rem.call(this, k);
  };
  SP.clear = function () {
    if (this === LS) {
      if (frozen) return;
      const ks = lsKeys().filter(k => !exclLS(k));
      ks.forEach(k => S_rem.call(LS, k));
      ks.forEach(k => mark(lsPath(k)));
      return;
    }
    return S_clear.call(this);
  };

  if (window.indexedDB && window.IDBObjectStore) {
    const guard = function (src) {
      const tx = src.transaction;
      if (tx && tx.__ma) return;
      if (frozen) throw new DOMException('Sincronizando, espera un momento', 'AbortError');
      const n = tx && tx.db && tx.db.name;
      if (!exclDB(n)) mark(idbPath(n));
    };
    const OS = IDBObjectStore.prototype;
    ['put', 'add', 'delete', 'clear'].forEach(m => {
      const o = OS[m];
      if (o) OS[m] = function () { guard(this); return o.apply(this, arguments); };
    });
    const CU = IDBCursor.prototype;
    ['update', 'delete'].forEach(m => {
      const o = CU[m];
      if (o) CU[m] = function () { const s = this.source; guard(s && s.objectStore ? s.objectStore : s); return o.apply(this, arguments); };
    });
    const F = IDBFactory.prototype, fOpen = F.open, fDel = F.deleteDatabase;
    F.open = function (name) {
      if (!exclDB(name) && !knownDBs.includes(name)) { knownDBs.push(name); jset('dbs', knownDBs); }
      return fOpen.apply(this, arguments);
    };
    F.deleteDatabase = function (name) {
      if (!exclDB(name)) mark(idbPath(name));
      return fDel.apply(this, arguments);
    };
    window.__maIdbOpen = (n, v) => v ? fOpen.call(indexedDB, n, v) : fOpen.call(indexedDB, n);
  }

  /* ---------- convertir valores a JSON y de vuelta ---------- */
  function encode(v, blobs) {
    if (v === undefined) return { __u: 1 };
    if (typeof v === 'string') { if (v.length > BIG_STR) { const ref = { __str: null, s: v.length }; blobs.push({ str: v, ref }); return ref; } return v; }
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'number') return isFinite(v) ? v : { __n: String(v) };
    if (typeof v === 'bigint') return { __bi: String(v) };
    if (typeof v !== 'object') return null;
    if (v instanceof Date) return { __d: isNaN(v) ? null : v.toISOString() };
    if (typeof Blob !== 'undefined' && v instanceof Blob) {
      const ref = { __blob: null, t: v.type || '', s: v.size };
      if (typeof File !== 'undefined' && v instanceof File) { ref.n = v.name; ref.lm = v.lastModified; }
      blobs.push({ blob: v, ref }); return ref;
    }
    if (v instanceof ArrayBuffer) return { __ab: bytesToB64(new Uint8Array(v)) };
    if (ArrayBuffer.isView(v)) return { __ta: v.constructor.name, b: bytesToB64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
    if (v instanceof Map) return { __map: [...v].map(([k, x]) => [encode(k, blobs), encode(x, blobs)]) };
    if (v instanceof Set) return { __set: [...v].map(x => encode(x, blobs)) };
    if (v instanceof RegExp) return { __re: [v.source, v.flags] };
    if (Array.isArray(v)) { const a = new Array(v.length); for (let i = 0; i < v.length; i++) a[i] = encode(v[i], blobs); return a; }
    const o = {}; let special = false;
    for (const k of Object.keys(v)) { if (k.startsWith('__')) special = true; o[k] = encode(v[k], blobs); }
    return special ? { __o: o } : o;
  }
  function decode(v, blobMap) {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(x => decode(x, blobMap));
    if ('__u' in v) return undefined;
    if ('__n' in v) return Number(v.__n);
    if ('__bi' in v) return BigInt(v.__bi);
    if ('__d' in v) return new Date(v.__d === null ? NaN : v.__d);
    if ('__str' in v) { const d = blobMap.get(v.__str); if (!d) throw new Error('falta un trozo'); return td.decode(d); }
    if ('__blob' in v) {
      const data = blobMap.get(v.__blob);
      if (!data) throw new Error('falta un archivo');
      if (v.n != null && typeof File !== 'undefined') return new File([data], v.n, { type: v.t, lastModified: v.lm });
      return new Blob([data], { type: v.t });
    }
    if ('__ab' in v) return b64ToBytes(v.__ab).buffer;
    if ('__ta' in v) { const u = b64ToBytes(v.b); const C = window[v.__ta] || Uint8Array; return C === DataView ? new DataView(u.buffer) : new C(u.buffer); }
    if ('__map' in v) return new Map(v.__map.map(([k, x]) => [decode(k, blobMap), decode(x, blobMap)]));
    if ('__set' in v) return new Set(v.__set.map(x => decode(x, blobMap)));
    if ('__re' in v) return new RegExp(v.__re[0], v.__re[1]);
    if ('__o' in v) { const o = {}; for (const k of Object.keys(v.__o)) o[k] = decode(v.__o[k], blobMap); return o; }
    const o = {}; for (const k of Object.keys(v)) o[k] = decode(v[k], blobMap); return o;
  }
  function blobHashes(v, out) {
    if (v && typeof v === 'object') {
      if (Array.isArray(v)) v.forEach(x => blobHashes(x, out));
      else if ('__blob' in v) { if (v.__blob) out.add(v.__blob); }
      else if ('__str' in v) { if (v.__str) out.add(v.__str); }
      else for (const k of Object.keys(v)) blobHashes(v[k], out);
    }
    return out;
  }

  /* ---------- IndexedDB: leer y escribir bases completas ---------- */
  function req(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
  function openExisting(name) {
    return new Promise(res => {
      let r; try { r = window.__maIdbOpen(name); } catch (e) { res(null); return; }
      let created = false;
      r.onupgradeneeded = () => { created = true; try { r.transaction.abort(); } catch (e) { } };
      r.onsuccess = () => { if (created) { r.result.close(); res(null); } else res(r.result); };
      r.onerror = e => { e.preventDefault && e.preventDefault(); res(null); };
      r.onblocked = () => { };
    });
  }
  async function listDBs() {
    let names = [];
    try { if (indexedDB.databases) names = (await indexedDB.databases()).map(d => d.name); } catch (e) { }
    return [...new Set(names.concat(knownDBs))].filter(n => !exclDB(n));
  }
  async function dumpDB(name) {
    const db = await openExisting(name);
    if (!db) return null;
    try {
      const names = [...db.objectStoreNames];
      const stores = [];
      if (names.length) {
        const tx = db.transaction(names, 'readonly'); tx.__ma = true;
        for (const sn of names) {
          const st = tx.objectStore(sn);
          const info = {
            name: sn, keyPath: st.keyPath, autoIncrement: st.autoIncrement,
            indexes: [...st.indexNames].map(i => { const x = st.index(i); return { name: x.name, keyPath: x.keyPath, unique: x.unique, multiEntry: x.multiEntry }; })
          };
          info._k = req(st.getAllKeys()); info._v = req(st.getAll());
          stores.push(info);
        }
        for (const s of stores) { const k = await s._k, v = await s._v; delete s._k; delete s._v; s.rows = k.map((kk, i) => [kk, v[i]]); }
      }
      return { kind: 'idb', name, version: db.version, stores };
    } finally { db.close(); }
  }
  async function restoreDB(data, blobMap) {
    let db = await openExisting(data.name);
    if (!db) {
      db = await new Promise((res, rej) => {
        const r = window.__maIdbOpen(data.name, Math.max(1, data.version || 1));
        r.onupgradeneeded = () => {
          const d = r.result; r.transaction.__ma = true;
          for (const s of data.stores) {
            if (d.objectStoreNames.contains(s.name)) continue;
            const o = {}; if (s.keyPath !== null && s.keyPath !== undefined) o.keyPath = s.keyPath; if (s.autoIncrement) o.autoIncrement = true;
            const st = d.createObjectStore(s.name, o);
            for (const ix of s.indexes || []) try { st.createIndex(ix.name, ix.keyPath, { unique: !!ix.unique, multiEntry: !!ix.multiEntry }); } catch (e) { }
          }
        };
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
        r.onblocked = () => rej(new Error('bloqueada'));
      });
    }
    let complete = true;
    try {
      const names = data.stores.map(s => s.name).filter(n => db.objectStoreNames.contains(n));
      if (names.length !== data.stores.length) complete = false;
      if (!names.length) return complete;
      const tx = db.transaction(names, 'readwrite'); tx.__ma = true;
      const done = new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error || new Error('abort')); });
      for (const s of data.stores) {
        if (!db.objectStoreNames.contains(s.name)) continue;
        const st = tx.objectStore(s.name);
        st.clear();
        const inline = st.keyPath !== null;
        for (const [k, v] of s.rows) { const val = decode(v, blobMap); inline ? st.put(val) : st.put(val, decode(k, blobMap)); }
      }
      await done;
    } finally { db.close(); }
    return complete;
  }

  /* ---------- unidades (cada clave de localStorage y cada base de datos) ---------- */
  async function localUnit(path) {
    let content = null; const blobs = [];
    if (path.startsWith('ls/')) {
      const key = unb64u(path.slice(3, -5)); const v = lsGet(key);
      if (v === null) return null;
      content = { kind: 'ls', key, value: encode(v, blobs) };
    } else if (path.startsWith('idb/')) {
      const name = unb64u(path.slice(4, -5));
      const d = await dumpDB(name);
      if (!d) return null;
      content = { kind: 'idb', name, version: d.version, stores: d.stores.map(s => ({ name: s.name, keyPath: s.keyPath, autoIncrement: s.autoIncrement, indexes: s.indexes, rows: s.rows.map(([k, v]) => [encode(k, blobs), encode(v, blobs)]) })) };
    } else return null;
    for (const b of blobs) {
      const buf = 'str' in b ? te.encode(b.str).buffer : await b.blob.arrayBuffer();
      const h = await sha256hex(buf); b.buf = buf; b.hash = h;
      if ('str' in b) { b.ref.__str = h; delete b.str; } else b.ref.__blob = h;
    }
    const body = JSON.stringify(content);
    const h = await sha256hex(te.encode(body));
    return { content, body, h, blobs };
  }

  /* ---------- GitHub ---------- */
  async function gh(method, path, body, accept) {
    const payload = body ? JSON.stringify(body) : undefined;
    let lastErr;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const r = await fetch(API + path, {
          method, cache: 'no-store',
          headers: Object.assign({ 'Authorization': 'Bearer ' + cfg.token, 'Accept': accept || 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, body ? { 'Content-Type': 'application/json' } : {}),
          body: payload
        });
        if ((r.status === 403 || r.status === 429) && attempt < 3 && (r.headers.get('retry-after') || r.headers.get('x-ratelimit-remaining') === '0')) {
          const wait = Math.min(90, parseInt(r.headers.get('retry-after') || '30', 10) || 30);
          progress(`☁️ GitHub pide una pausa… (${wait} s)`); await sleep(wait * 1000); continue;
        }
        if (r.status >= 500 && attempt < 3) { await sleep(2000 * (attempt + 1)); continue; }
        return r;
      } catch (e) {
        lastErr = e;
        if (attempt < 3) { await sleep([1500, 4000, 9000][attempt]); continue; }
      }
    }
    const e = new Error('Se cortó la conexión con GitHub. Comprueba el wifi y que el aparato no se bloquee mientras sincroniza.');
    e.net = true; e.cause = lastErr; throw e;
  }
  const repoPath = () => `/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}`;
  async function getTree() {
    const r = await gh('GET', `${repoPath()}/git/trees/${encodeURIComponent(cfg.branch || 'main')}?recursive=1`);
    if (r.status === 409 || r.status === 404) {
      if (r.status === 404) { const rr = await gh('GET', repoPath()); if (!rr.ok) throw httpErr(rr); }
      return {};
    }
    if (!r.ok) throw httpErr(r);
    const j = await r.json(); const t = {};
    for (const e of j.tree || []) if (e.type === 'blob') t[e.path] = e.sha;
    return t;
  }
  function httpErr(r) {
    const e = new Error(r.status === 401 ? 'La clave no es válida o ha caducado' : r.status === 403 ? 'La clave no tiene permiso (revisa «Contents: Read and write»)' : r.status === 404 ? 'No encuentro el almacén (revisa usuario y nombre)' : 'GitHub respondió ' + r.status);
    e.status = r.status; return e;
  }
  async function getBlob(sha) {
    const r = await gh('GET', `${repoPath()}/git/blobs/${sha}`, null, 'application/vnd.github.raw+json');
    if (!r.ok) throw httpErr(r);
    return await r.arrayBuffer();
  }
  async function putFile(path, bytes, sha, msg) {
    const body = { message: msg, content: bytesToB64(bytes), branch: cfg.branch || 'main' };
    if (sha) body.sha = sha;
    const r = await gh('PUT', `${repoPath()}/contents/${path}`, body);
    if (!r.ok) throw httpErr(r);
    const j = await r.json(); return j.content.sha;
  }
  async function delFile(path, sha) {
    const r = await gh('DELETE', `${repoPath()}/contents/${path}`, { message: 'Borrar ' + path, sha, branch: cfg.branch || 'main' });
    if (!r.ok && r.status !== 404) throw httpErr(r);
  }

  const NAMES = { 'miagenda': 'Agendas', 'bujo-mi-agenda': 'Bullet Journal', 'bujo-state': 'Bullet Journal (ajustes)', 'cuaderno-caligrafia': 'Caligrafía', 'mi-estanteria': 'Estantería', 'miAnatomia': 'Anatomía', 'miCardiologia': 'Cardiología', 'misCuentasFotos': 'Cuentas (fotos)', 'mandalas': 'Mandalas', 'silabarios-v1': 'Silabarios', 'mis-enlaces': 'Enlaces' };
  function unitLabel(path) {
    let n = path; try { n = unb64u(path.replace(/^(ls|idb)\//, '').replace(/\.json$/, '')); } catch (e) { }
    return NAMES[n] || n;
  }
  function progress(msg) {
    const el = document.getElementById('ms-prog');
    if (el) el.textContent = msg || '';
    if (!document.body) return;
    if (msg && (!cfg || !cfg.setup || document.getElementById('ms-prog') || frozen)) pill(msg);
    if (!msg && !frozen) { const p = document.getElementById('masync-pill'); if (p) p.classList.remove('on'); }
  }

  /* ---------- sincronizar ---------- */
  // 1.º solo la ficha (pequeña); los archivos se descargan después, al aplicar
  async function pullMeta(path, sha) {
    const buf = await getBlob(sha);
    const file = JSON.parse(td.decode(buf));
    const c = file.data;
    const hashes = [...blobHashes(c, new Set())];
    return { file, content: c, hashes, blobMap: null, h: await sha256hex(te.encode(JSON.stringify(c))) };
  }
  // 2.º los archivos que falten: 4 a la vez, con aviso de cuánto queda
  async function fetchBlobs(path, remote, tree, cache) {
    if (remote.blobMap) return remote;
    const label = unitLabel(path), blobMap = new Map(), todo = [];
    for (const h of remote.hashes) {
      if (cache.has(h)) blobMap.set(h, cache.get(h));
      else { if (!tree['blobs/' + h]) throw new Error('faltan archivos en la nube (se subirán desde el otro aparato)'); todo.push(h); }
    }
    let done = 0, next = 0;
    const total = todo.length;
    if (total) progress(`☁️ Trayendo «${label}»: 0 de ${total} archivos…`);
    const worker = async () => {
      while (next < todo.length) {
        const h = todo[next++];
        const b = await getBlob(tree['blobs/' + h]);
        cache.set(h, b); blobMap.set(h, b); done++;
        progress(`☁️ Trayendo «${label}»: ${done} de ${total} archivos…`);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    remote.blobMap = blobMap;
    return remote;
  }
  async function pullUnit(path, sha, tree, cache) { return fetchBlobs(path, await pullMeta(path, sha), tree, cache); }
  // guarda en la caché los archivos que ya tiene este aparato, para no volver a descargarlos
  function seedCache(cache, local) { if (local && local.blobs) for (const b of local.blobs) if (b.buf && !cache.has(b.hash)) cache.set(b.hash, b.buf); }
  async function applyUnit(path, remote) {
    const c = remote.content;
    if (c.kind === 'ls') { S_set.call(LS, c.key, typeof c.value === 'string' ? c.value : decode(c.value, remote.blobMap)); return true; }
    if (c.kind === 'idb') return await restoreDB(c, remote.blobMap);
    return true;
  }
  async function pushUnit(path, local, sha, tree) {
    const label = unitLabel(path);
    let i = 0;
    for (const b of local.blobs) {
      i++;
      const p = 'blobs/' + b.hash;
      if (tree[p] || b.done) continue;
      if (b.buf.byteLength > MAX_BLOB) { const mb = Math.round(b.buf.byteLength / 1048576); status.warn = `Hay archivos de más de 25 MB (${mb} MB en «${label}») que no se sincronizan`; continue; }
      progress(`☁️ ${label}: subiendo archivo ${i} de ${local.blobs.length}…`);
      tree[p] = await putFile(p, new Uint8Array(b.buf), null, 'Archivo ' + b.hash.slice(0, 8));
      b.done = true; b.buf = null;
    }
    const file = { app: 'mi-agenda', v: 1, device, updated: Date.now(), data: local.content };
    const bytes = te.encode(JSON.stringify(file));
    if (bytes.byteLength > MAX_UNIT) throw new Error(`«${label}» es demasiado grande (${Math.round(bytes.byteLength / 1048576)} MB)`);
    progress(`☁️ Guardando «${label}»…`);
    return await putFile(path, bytes, sha, `${label} · ${device}`);
  }

  async function syncNow(opts) {
    opts = opts || {};
    if (!cfg || !cfg.setup || !cfg.token) { endHold(false); return { skipped: true }; }
    if (busy) { if (opts.wait) { try { await busy; } catch (e) { } } else return busy; }
    const run = (async () => {
      setStatus('sync', 'Sincronizando…');
      let applied = 0, pushed = 0;
      try {
        const tree = await getTree();
        const remotePaths = Object.keys(tree).filter(p => /^(ls|idb)\//.test(p));
        const cand = new Set(remotePaths);
        lsKeys().filter(k => !exclLS(k)).forEach(k => cand.add(lsPath(k)));
        Object.keys(dirty).forEach(p => cand.add(p));
        Object.keys(base).forEach(p => cand.add(p));
        held.forEach(p => cand.add(p));
        const dbs = await listDBs();
        const fullIdb = !fullCheckDone || opts.mode;
        dbs.forEach(n => { const p = idbPath(n); if (fullIdb || dirty[p] || held.has(p) || !base[p]) cand.add(p); });

        const cache = new Map();
        const toApply = [];
        const failed = [];
        const sizes = jget('sz', {});
        const order = [...cand].sort((a, b) => (sizes[a] || 0) - (sizes[b] || 0));
        for (const path of order) {
         try {
          const b = base[path], rsha = tree[path] || null;
          const isIdb = path.startsWith('idb/');
          const remoteChanged = rsha ? (!b || b.sha !== rsha) : !!(b && b.sha);
          const needLocal = !isIdb || fullIdb || remoteChanged || dirty[path] || held.has(path) || !b;
          if (!needLocal) continue;
          if (sizes[path] > 20) progress(`☁️ Revisando «${unitLabel(path)}»…`);
          const local = await localUnit(path);
          const lh = local ? local.h : null;
          if (local) { sizes[path] = local.blobs.length; jset('sz', sizes); }
          const localChanged = b ? lh !== b.h : lh !== null;

          if (opts.mode === 'down') {
            if (rsha) { seedCache(cache, local); toApply.push({ path, rsha }); }
            else if (local) { base[path] = { sha: await pushUnit(path, local, null, tree), h: lh }; pushed++; delete dirty[path]; }
            continue;
          }
          if (opts.mode === 'up') {
            if (local) { if (!b || lh !== b.h || b.sha !== rsha) { base[path] = { sha: await pushUnit(path, local, rsha, tree), h: lh }; pushed++; } delete dirty[path]; }
            else if (rsha) toApply.push({ path, rsha });
            continue;
          }

          if (!remoteChanged && !localChanged) { if (dirty[path]) delete dirty[path]; continue; }
          if (remoteChanged && !localChanged) {
            if (!rsha) { if (!local) delete base[path]; else if (path.startsWith('ls/')) { S_rem.call(LS, local.content.key); delete base[path]; } continue; }
            if (opts.apply) { seedCache(cache, local); toApply.push({ path, rsha }); }
            continue;
          }
          if (localChanged && !remoteChanged) {
            if (local) { base[path] = { sha: await pushUnit(path, local, rsha, tree), h: lh }; pushed++; }
            else if (rsha) { await delFile(path, rsha); delete base[path]; pushed++; }
            else delete base[path];
            delete dirty[path];
            continue;
          }
          // cambió en los dos aparatos: gana el cambio más reciente
          if (!rsha) { if (local) { base[path] = { sha: await pushUnit(path, local, null, tree), h: lh }; pushed++; } delete dirty[path]; continue; }
          const remote = await pullMeta(path, rsha);
          if (remote.h === lh) { base[path] = { sha: rsha, h: lh }; delete dirty[path]; continue; }
          const localTime = hold ? (dirtyAtStart[path] || 0) : (dirty[path] || dirtyAtStart[path] || 0);
          if (local && localTime > (remote.file.updated || 0)) {
            base[path] = { sha: await pushUnit(path, local, rsha, tree), h: lh }; pushed++; delete dirty[path];
          } else {
            seedCache(cache, local); toApply.push({ path, rsha, remote });
          }
         } catch (e) {
          if (e.status === 401 || e.status === 403 || e.status === 404) throw e;
          failed.push(unitLabel(path) + ': ' + (e.message || e));
         } finally { jset('base', base); jset('dirty', dirty); }
        }

        if (toApply.length) {
          if (sessionReloads() >= 3) throw new Error('Demasiadas recargas seguidas; vuelve a intentarlo en un minuto');
          frozen = true; showBusy(true);
          for (const t of toApply) {
            try { if (!t.remote) t.remote = await pullMeta(t.path, t.rsha); }
            catch (e) { if (e.status === 401 || e.status === 403 || e.status === 404) throw e; t.err = e; }
          }
          toApply.sort((a, b) => ((a.remote && a.remote.hashes.length) || 0) - ((b.remote && b.remote.hashes.length) || 0));
          for (const t of toApply) {
            try {
              if (t.err) throw t.err;
              progress(`☁️ Trayendo «${unitLabel(t.path)}»…`);
              const remote = await fetchBlobs(t.path, t.remote, tree, cache);
              progress(`☁️ Guardando «${unitLabel(t.path)}» en este aparato…`);
              const ok = await applyUnit(t.path, remote);
              remote.blobMap = null; t.remote = null;
              if (ok) base[t.path] = { sha: t.rsha, h: remote.h };
              delete dirty[t.path]; applied++;
            } catch (e) {
              if (e.status === 401 || e.status === 403 || e.status === 404) throw e;
              failed.push(unitLabel(t.path) + ': ' + (e.message || e));
            }
            jset('base', base); jset('dirty', dirty);
          }
          if (!applied) { frozen = false; showBusy(false); }
        }
        jset('base', base); jset('dirty', dirty);
        fullCheckDone = true;
        progress(null);
        if (failed.length) {
          status.err = 'No se pudo sincronizar todo. Se volverá a intentar solo:\n• ' + failed.slice(0, 6).join('\n• ') + (failed.length > 6 ? `\n• y ${failed.length - 6} más` : '');
          jset('err', status.err); setStatus('error', status.err);
        } else {
          status.last = Date.now(); jset('last', status.last);
          status.err = ''; jset('err', '');
          setStatus('ok', applied ? 'Actualizado desde tu otro aparato' : pushed ? 'Cambios guardados en la nube' : 'Todo al día');
        }
        if (applied) { countReload(); sessionStorage.setItem(PFX + 'toast', '☁️ Actualizado con los cambios de tu otro aparato'); location.reload(); await sleep(5000); }
        endHold(true);
        if (failed.length) schedulePush(60000);
        return { applied, pushed, failed: failed.length };
      } catch (e) {
        frozen = false; showBusy(false); progress(null);
        status.err = e.message || String(e); jset('err', status.err);
        setStatus('error', status.err);
        endHold(false);
        throw e;
      } finally { busy = null; }
    })();
    busy = run;
    run.catch(() => { });
    return run;
  }
  function endHold(ok) {
    if (!hold) return;
    hold = false;
    if (held.size) { const now = Date.now(); held.forEach(p => { dirty[p] = now; }); held.clear(); jset('dirty', dirty); schedulePush(); }
  }
  function sessionReloads() { try { const r = JSON.parse(sessionStorage.getItem(PFX + 'rl') || '[]').filter(t => Date.now() - t < 60000); return r.length; } catch (e) { return 0; } }
  function countReload() { try { const r = JSON.parse(sessionStorage.getItem(PFX + 'rl') || '[]').filter(t => Date.now() - t < 60000); r.push(Date.now()); sessionStorage.setItem(PFX + 'rl', JSON.stringify(r)); } catch (e) { } }

  let pushT = null;
  function schedulePush(ms) {
    if (!cfg || !cfg.setup) return;
    clearTimeout(pushT);
    pushT = setTimeout(() => {
      // mientras escribes con el lápiz no se sincroniza: se espera a que pares unos segundos
      const wait = penBusyUntil - Date.now();
      if (wait > 0) { schedulePush(wait + 500); return; }
      if (navigator.onLine !== false) syncNow({ apply: false }).catch(() => { });
    }, ms == null ? 4000 : ms);
  }

  /* ---------- aviso y panel ---------- */
  const listeners = new Set();
  function setStatus(state, msg) { status.state = state; status.msg = msg; listeners.forEach(f => { try { f(status); } catch (e) { } }); updateBtn(); }
  function css() {
    if (document.getElementById('masync-css')) return;
    const st = document.createElement('style'); st.id = 'masync-css';
    st.textContent = `
#masync-pill{position:fixed;left:50%;top:max(10px,env(safe-area-inset-top));transform:translateX(-50%);z-index:2147483000;background:rgba(35,38,58,.92);color:#fff;font:600 13px/1.2 -apple-system,system-ui,sans-serif;padding:8px 14px;border-radius:99px;box-shadow:0 8px 24px -8px rgba(0,0,0,.4);pointer-events:none;transition:opacity .25s;opacity:0}
#masync-pill.on{opacity:1}
#masync-btn{position:fixed;left:max(12px,env(safe-area-inset-left));bottom:max(12px,env(safe-area-inset-bottom));z-index:2147482000;width:46px;height:46px;border-radius:50%;border:1px solid rgba(0,0,0,.08);background:#fff;box-shadow:0 6px 18px -6px rgba(0,0,0,.35);font-size:21px;cursor:pointer;display:grid;place-items:center;padding:0}
#masync-btn i{position:absolute;right:5px;top:5px;width:10px;height:10px;border-radius:50%;background:#bbb;border:2px solid #fff}
#masync-btn i.ok{background:#3a9a6a}#masync-btn i.sync{background:#e0a526}#masync-btn i.error{background:#d0453b}
#masync-dlg{position:fixed;inset:0;z-index:2147483100;background:rgba(35,38,58,.38);display:grid;place-items:center;padding:16px;font:15px/1.45 -apple-system,system-ui,sans-serif;color:#23263a}
#masync-dlg .box{background:#fffdf9;border-radius:20px;padding:20px;width:min(440px,100%);max-height:90vh;overflow:auto;box-shadow:0 30px 60px -20px rgba(0,0,0,.45)}
#masync-dlg h3{margin:0 0 6px;font-size:19px}
#masync-dlg p{margin:6px 0}
#masync-dlg .note{font-size:13px;color:#6d6a75}
#masync-dlg label{display:block;font-size:13px;font-weight:700;margin:12px 0 4px}
#masync-dlg input{width:100%;box-sizing:border-box;border:1.5px solid #ddd6c8;border-radius:11px;padding:10px 11px;font:inherit;background:#fff;color:inherit;-webkit-user-select:text;user-select:text}
#masync-dlg .row{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px;justify-content:flex-end}
#masync-dlg button{border:1.5px solid #ddd6c8;background:#fff;border-radius:11px;padding:10px 14px;font:700 14px -apple-system,system-ui,sans-serif;color:#23263a;cursor:pointer}
#masync-dlg button.pri{background:#23263a;color:#fff;border-color:#23263a}
#masync-dlg button.dan{color:#b3392f}
#masync-dlg button.block{display:block;width:100%;margin-top:8px;text-align:left}
#masync-dlg button small{display:block;font-weight:500;font-size:12.5px;opacity:.75;margin-top:2px}
#masync-dlg .stat{background:#f3eee5;border-radius:12px;padding:10px 12px;font-size:14px;margin-top:8px}
#masync-dlg .err{background:#fbe9e7;color:#8d2a22;border-radius:12px;padding:10px 12px;font-size:13.5px;margin-top:8px}`;
    (document.head || document.documentElement).appendChild(st);
  }
  let pillT;
  function pill(msg, ms) {
    css(); let p = document.getElementById('masync-pill');
    if (!p) { p = document.createElement('div'); p.id = 'masync-pill'; document.body.appendChild(p); }
    p.textContent = msg; p.classList.add('on'); clearTimeout(pillT);
    if (ms) pillT = setTimeout(() => p.classList.remove('on'), ms);
  }
  function showBusy(on) { if (!document.body) return; if (on) pill('☁️ Trayendo los cambios de tu otro aparato…'); else { const p = document.getElementById('masync-pill'); if (p) p.classList.remove('on'); } }

  function wantsButton() {
    const s = document.currentScript || document.querySelector('script[src*="sync.js"]');
    return s && s.dataset && s.dataset.boton === 'si';
  }
  const SHOW_BTN = wantsButton();
  function updateBtn() {
    const b = document.getElementById('masync-btn'); if (!b) return;
    const dot = b.querySelector('i');
    dot.className = !cfg || !cfg.setup ? '' : status.state === 'error' ? 'error' : status.state === 'sync' ? 'sync' : 'ok';
    b.title = !cfg || !cfg.setup ? 'Sincronizar con el iPhone / iPad' : status.msg || 'Sincronización';
  }
  function addBtn() {
    if (!SHOW_BTN || document.getElementById('masync-btn')) return;
    css();
    const b = document.createElement('button'); b.id = 'masync-btn'; b.type = 'button';
    b.innerHTML = '☁️<i></i>'; b.onclick = openPanel;
    document.body.appendChild(b); updateBtn();
  }
  const fmt = t => !t ? 'nunca' : new Date(t).toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const escH = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function dlg(html) {
    css(); closeDlg();
    const d = document.createElement('div'); d.id = 'masync-dlg';
    d.innerHTML = `<div class="box">${html}</div>`;
    d.addEventListener('click', e => { if (e.target === d) closeDlg(); });
    document.body.appendChild(d); return d;
  }
  function closeDlg() { const d = document.getElementById('masync-dlg'); if (d) d.remove(); }

  function openPanel() {
    if (!cfg || !cfg.setup) return openSetup();
    const pend = Object.keys(dirty).length;
    const d = dlg(`
      <h3>☁️ Sincronización</h3>
      <p class="note">Tus datos de Mi Agenda se guardan en tu almacén privado <b>${escH(cfg.owner)}/${escH(cfg.repo)}</b> de GitHub. Se sincronizan al abrir cada app y unos segundos después de cada cambio.</p>
      <div class="stat">Este aparato: <b>${escH(device)}</b><br>Última sincronización: <b id="ms-last">${fmt(status.last)}</b><br>Cambios pendientes de subir: <b>${pend}</b></div>
      ${status.err ? `<div class="err">⚠️ ${escH(status.err).replace(/\n/g, '<br>')}</div>` : ''}
      ${status.warn ? `<div class="err">${escH(status.warn)}</div>` : ''}
      <p class="note" id="ms-prog"></p>
      <div class="row">
        <button class="dan" id="ms-off">Desconectar este aparato</button>
        <button id="ms-close">Cerrar</button>
        <button class="pri" id="ms-now">Sincronizar ahora</button>
      </div>`);
    d.querySelector('#ms-close').onclick = closeDlg;
    d.querySelector('#ms-now').onclick = async e => {
      e.target.disabled = true; e.target.textContent = 'Sincronizando…';
      try { const r = await syncNow({ apply: true, wait: true }); if (r && r.failed) openPanel(); else { closeDlg(); pill('☁️ ' + status.msg, 2500); } }
      catch (err) { openPanel(); }
    };
    d.querySelector('#ms-off').onclick = () => {
      if (!confirm('¿Desconectar este aparato? Tus datos se quedan aquí y en la nube, pero este aparato dejará de sincronizarse hasta que vuelvas a poner la clave.')) return;
      cfg = null; lsRem(PFX + 'cfg'); base = {}; jset('base', base); closeDlg(); updateBtn(); pill('Este aparato ya no se sincroniza', 2500);
    };
  }

  function openSetup() {
    const c = cfg || { owner: 'diosaninja', repo: 'mi-agenda-datos' };
    const d = dlg(`
      <h3>☁️ Sincronizar este aparato</h3>
      <p class="note">Escribe tu usuario de GitHub, el nombre de tu almacén <b>privado</b> y pega la clave (empieza por <b>github_pat_</b>). Solo hace falta una vez en cada aparato.</p>
      <label for="ms-owner">Usuario de GitHub</label><input id="ms-owner" value="${escH(c.owner)}" autocapitalize="off" autocorrect="off" spellcheck="false">
      <label for="ms-repo">Almacén privado</label><input id="ms-repo" value="${escH(c.repo)}" autocapitalize="off" autocorrect="off" spellcheck="false">
      <label for="ms-tok">Clave de acceso</label><input id="ms-tok" type="password" placeholder="github_pat_…" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">
      <div id="ms-msg"></div>
      <div class="row"><button id="ms-close">Cancelar</button><button class="pri" id="ms-check">Comprobar</button></div>`);
    d.querySelector('#ms-close').onclick = closeDlg;
    d.querySelector('#ms-check').onclick = async e => {
      const owner = d.querySelector('#ms-owner').value.trim(), repo = d.querySelector('#ms-repo').value.trim(), token = d.querySelector('#ms-tok').value.trim();
      const msg = d.querySelector('#ms-msg');
      if (!owner || !repo || !token) { msg.innerHTML = '<div class="err">Rellena los tres campos.</div>'; return; }
      e.target.disabled = true; e.target.textContent = 'Comprobando…';
      const tmp = { owner, repo, token, branch: 'main', setup: false };
      const prev = cfg; cfg = tmp;
      try {
        const r = await gh('GET', repoPath());
        if (!r.ok) throw httpErr(r);
        const info = await r.json();
        if (!info.private) { cfg = prev; msg.innerHTML = '<div class="err">⚠️ Ese almacén es <b>público</b>: cualquiera podría ver tus datos. En GitHub entra en el almacén → Settings → abajo, «Change visibility» → Private. Luego vuelve a pulsar Comprobar.</div>'; e.target.disabled = false; e.target.textContent = 'Comprobar'; return; }
        if (info.permissions && info.permissions.push === false) throw Object.assign(new Error('La clave no tiene permiso de escritura (revisa «Contents: Read and write»)'), { status: 403 });
        tmp.branch = info.default_branch || 'main';
        const tree = await getTree();
        const hasData = Object.keys(tree).some(p => /^(ls|idb)\//.test(p));
        cfg = prev;
        chooseDirection(tmp, hasData);
      } catch (err) {
        cfg = prev;
        msg.innerHTML = `<div class="err">⚠️ ${escH(err.message || err)}</div>`;
        e.target.disabled = false; e.target.textContent = 'Comprobar';
      }
    };
  }

  function chooseDirection(tmp, hasData) {
    const d = dlg(hasData ? `
      <h3>Todo correcto ✓</h3>
      <p>En la nube ya hay datos de Mi Agenda. ¿Qué quieres hacer en este aparato?</p>
      <button class="block pri" id="ms-down">⬇️ Traer los datos de la nube<small>Lo normal en el segundo aparato (por ejemplo, el iPhone). Lo que hay en la nube reemplaza a lo de aquí.</small></button>
      <button class="block" id="ms-up">⬆️ Subir los datos de este aparato<small>Lo de este aparato reemplaza a lo que hay en la nube.</small></button>
      <div class="row"><button id="ms-close">Cancelar</button></div>` : `
      <h3>Todo correcto ✓</h3>
      <p>Tu almacén está vacío. Vamos a subir los datos de <b>este aparato</b> para que el otro pueda descargarlos.</p>
      <p class="note">Hazlo primero en el aparato donde tienes tus datos (el iPad). Si hay muchas fotos o libros, puede tardar unos minutos: no cierres la app.</p>
      <div class="row"><button id="ms-close">Cancelar</button><button class="pri" id="ms-up">⬆️ Subir mis datos</button></div>`);
    d.querySelector('#ms-close').onclick = closeDlg;
    const go = async mode => {
      if (mode === 'up' && hasData && !confirm('Lo que hay en la nube se reemplazará por lo de este aparato. ¿Seguro?')) return;
      if (mode === 'down' && !confirm('Lo de este aparato se reemplazará por lo que hay en la nube. ¿Seguro?')) return;
      cfg = Object.assign({}, tmp, { setup: true }); jset('cfg', cfg);
      base = {}; jset('base', base);
      dlg(`<h3>☁️ ${mode === 'up' ? 'Subiendo tus datos…' : 'Trayendo tus datos…'}</h3><p class="note">No cierres la app ni bloquees la pantalla hasta que termine.</p><p class="note" id="ms-prog" style="font-weight:700;color:#23263a"></p>`);
      try {
        const r = await syncNow({ mode, apply: true, wait: true });
        closeDlg(); updateBtn();
        if (r && r.failed) openPanel(); else pill(`☁️ Listo: ${r && r.pushed ? r.pushed + ' apartados subidos' : 'todo al día'}`, 3500);
      } catch (err) {
        dlg(`<h3>No se pudo terminar</h3><div class="err">⚠️ ${escH(err.message || err)}</div><p class="note">Lo que ya se subió está a salvo. Vuelve a intentarlo con «Sincronizar ahora».</p><div class="row"><button class="pri" id="ms-ok">Entendido</button></div>`)
          .querySelector('#ms-ok').onclick = closeDlg;
      }
    };
    const up = d.querySelector('#ms-up'), down = d.querySelector('#ms-down');
    if (up) up.onclick = () => go('up');
    if (down) down.onclick = () => go('down');
  }

  /* ---------- arranque ---------- */
  function onReady(f) { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', f); else f(); }
  onReady(() => {
    addBtn();
    const t = sessionStorage.getItem(PFX + 'toast');
    if (t) { sessionStorage.removeItem(PFX + 'toast'); pill(t, 3000); }
  });
  if (cfg && cfg.setup) {
    const first = () => syncNow({ apply: true }).catch(() => { });
    if (navigator.onLine === false) endHold(false); else first();
    setTimeout(() => endHold(false), 15000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') syncNow({ apply: true }).catch(() => { });
      else if (Object.keys(dirty).length) syncNow({ apply: false }).catch(() => { });
    });
    window.addEventListener('online', () => syncNow({ apply: true }).catch(() => { }));
  } else endHold(false);

  window.MiAgendaSync = { syncNow, openPanel, status, onChange: f => listeners.add(f), _dbg: () => ({ base, dirty, cfg: cfg && Object.assign({}, cfg, { token: '***' }) }) };
})();
