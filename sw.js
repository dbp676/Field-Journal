/* Field Journal service worker
   - app shell: cache-first, refreshed in the background
   - regs data: network-first so updates land, cache as fallback
   - map tiles: cache-first, persisted forever so downloaded country works offline
*/
const VERSION   = 'fj-v1';
const SHELL     = `${VERSION}-shell`;
const TILES     = `${VERSION}-tiles`;
const DATA      = `${VERSION}-data`;

const SHELL_URLS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './assets/icon-192.png',
  './assets/icon-512.png'
];

const TILE_HOSTS = [
  'tile.opentopomap.org',
  'server.arcgisonline.com',
  'basemap.nationalmap.gov',
  'tile.openstreetmap.org'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(SHELL)
      .then(c => c.addAll(SHELL_URLS).catch(() => c.add('./index.html')))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => !k.startsWith(VERSION)).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

const isTile = url => TILE_HOSTS.some(h => url.hostname.endsWith(h));

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // never intercept the AI API — it must always go to the network
  if (url.hostname === 'api.anthropic.com') return;

  // map tiles: cache-first and keep forever
  if (isTile(url)) {
    e.respondWith(
      caches.open(TILES).then(async cache => {
        const hit = await cache.match(req);
        if (hit) return hit;
        try {
          const res = await fetch(req, { mode: 'cors' });
          if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
          return res;
        } catch (err) {
          return hit || new Response('', { status: 504 });
        }
      })
    );
    return;
  }

  // regulation data: prefer the network so edits propagate, fall back to cache
  if (url.pathname.endsWith('regs-data.json')) {
    e.respondWith(
      fetch(req)
        .then(res => {
          if (res.ok) caches.open(DATA).then(c => c.put(req, res.clone()));
          return res;
        })
        .catch(() => caches.match(req).then(r => r || new Response('{}', {
          headers: { 'content-type': 'application/json' }
        })))
    );
    return;
  }

  // same-origin app shell: cache-first, revalidate quietly in the background
  if (url.origin === location.origin) {
    e.respondWith(
      caches.match(req).then(hit => {
        const net = fetch(req).then(res => {
          if (res && res.ok) caches.open(SHELL).then(c => c.put(req, res.clone()));
          return res;
        }).catch(() => hit);
        return hit || net;
      })
    );
  }
});

/* Messages from the page: bulk tile prefetch + cache accounting */
self.addEventListener('message', async e => {
  const msg = e.data || {};
  const reply = r => e.source && e.source.postMessage(r);

  if (msg.type === 'CACHE_TILES') {
    const cache = await caches.open(TILES);
    const urls = msg.urls || [];
    let done = 0, failed = 0;
    const QUEUE = 6; // be polite to free tile servers
    let i = 0;
    await Promise.all(Array.from({ length: QUEUE }, async () => {
      while (i < urls.length) {
        const u = urls[i++];
        try {
          if (await cache.match(u)) { done++; }
          else {
            const res = await fetch(u, { mode: 'cors' });
            if (res && (res.ok || res.type === 'opaque')) { await cache.put(u, res.clone()); done++; }
            else failed++;
          }
        } catch (err) { failed++; }
        if ((done + failed) % 15 === 0) reply({ type: 'TILE_PROGRESS', done, failed, total: urls.length });
      }
    }));
    reply({ type: 'TILE_DONE', done, failed, total: urls.length });
    return;
  }

  if (msg.type === 'TILE_STATS') {
    const cache = await caches.open(TILES);
    const keys = await cache.keys();
    reply({ type: 'TILE_STATS', count: keys.length });
    return;
  }

  if (msg.type === 'CLEAR_TILES') {
    await caches.delete(TILES);
    reply({ type: 'TILES_CLEARED' });
  }
});
