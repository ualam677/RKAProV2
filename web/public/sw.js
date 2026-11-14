// RKAPro's service worker: the app works offline once it has been opened online.
// - The start page: from the network whenever there is one (an old saved copy would ask for code files a newer deploy
//   has replaced, and show a blank page); the saved copy only offline.
// - The app's code files: kept once downloaded (each version has its own file names).
// - The card database, strings and ban list (BabelCDB, Distribution, LFLists on GitHub): the same.
// - Card scripts (CardScripts): kept once downloaded; a card's script only changes with an engine update.
// Card pictures are not kept: their servers don't allow pages to keep them cheaply, and offline they show as names.
const VERSION = "rka-2";
const APP = `${VERSION}-app`;
const DATA = `${VERSION}-data`;

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(APP).then((cache) => cache.addAll(["./", "./index.html", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png"])));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (!key.startsWith(VERSION)) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

// the cached copy at once if there is one, and a fresh copy into the cache for next time
async function fresh(cacheName, request) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request, { ignoreSearch: request.mode === "navigate" });
  const update = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => cached);
  return cached ?? update;
}
// the network, and the saved copy only when there is no network
async function online(cacheName, request) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    return (await cache.match(request)) ?? Response.error();
  }
}
// the cached copy; the network only the first time
async function kept(cacheName, request) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  // a script that doesn't exist (404) is remembered too: the engine asks for missing ones
  if (response.ok || response.status === 404) cache.put(request, response.clone());
  return response;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin === self.location.origin) {
    // the app's pages: the start page whatever the address after it (#replay= links included)
    if (request.mode === "navigate") event.respondWith(online(APP, new Request("./")));
    else if (url.pathname.includes("/assets/")) event.respondWith(kept(APP, request));
    else event.respondWith(online(APP, request));
    return;
  }
  if (url.hostname === "raw.githubusercontent.com" || url.hostname === "api.github.com") {
    event.respondWith(url.pathname.includes("/CardScripts/") ? kept(DATA, request) : fresh(DATA, request));
  }
});
