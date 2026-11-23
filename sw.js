'use strict';
const cacheName='libreta-ninja-shell-v11';
const assets=['./','./index.html','./style.css','./app.js','./art.js','./extras.js','./io.js','./manifest.webmanifest','./icon.png'];
self.addEventListener('install',event=>event.waitUntil(caches.open(cacheName).then(cache=>cache.addAll(assets))));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('libreta-ninja-shell-')&&key!==cacheName).map(key=>caches.delete(key))))));
self.addEventListener('fetch',event=>{
  const request=event.request;
  if(request.method!=='GET'||!assets.some(path=>new URL(path,self.registration.scope).href===request.url))return;
  event.respondWith(fetch(request).catch(async()=>await caches.match(request)||Response.error()));
});
