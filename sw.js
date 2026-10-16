/* VFR Nav — service worker : fonctionnement hors ligne */
const APP_CACHE = 'vfrnav-app-v5';
const TILE_CACHE = 'vfrnav-tiles';
const LIB = [
  'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js',
  'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css'
];
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'nav.js', 'manifest.json', 'icon-180.png', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(APP_CACHE).then(c => c.addAll(SHELL).then(() => c.addAll(LIB).catch(() => {}))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('vfrnav-app-') && k !== APP_CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const tileKey = u => u.replace(/:\/\/[abc]\.tile\.opentopomap\.org/, '://tile.opentopomap.org').replace(/:\/\/[abcd]\.basemaps\.cartocdn\.com/, '://basemaps.cartocdn.com');
const isGlyph = u => /\/font\/[^/]+\/\d+-\d+\.pbf/.test(u);
const isTile = u => isGlyph(u) || /\/\d+\/\d+\/\d+\.(png|jpe?g|webp)(\?|$)/.test(u) || /[?&]TILEMATRIX=/i.test(u);

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = req.url;
  if (/\.geojson(\?|$)/.test(url)) return; // données aéro : toujours depuis le réseau

  // Tuiles de carte : cache d'abord, puis réseau (et mise en cache)
  if (isTile(url)) {
    const key = tileKey(url);
    e.respondWith(caches.open(TILE_CACHE).then(async c => {
      const hit = await c.match(key);
      if (hit) return hit;
      try {
        const r = await fetch(req);
        if (r.ok) c.put(key, r.clone());
        return r;
      } catch (err) {
        return new Response('', { status: 504 });
      }
    }));
    return;
  }

  // Bibliothèque carte (CDN) : cache d'abord
  if (LIB.includes(url)) {
    e.respondWith(caches.match(url).then(hit => hit || fetch(req).then(r => { const cl = r.clone(); caches.open(APP_CACHE).then(c => c.put(url, cl)); return r; })));
    return;
  }

  // Fichiers de l'app : cache immédiat + mise à jour en arrière-plan
  if (new URL(url).origin === self.location.origin) {
    e.respondWith(caches.open(APP_CACHE).then(async c => {
      const hit = await c.match(req, { ignoreSearch: true }) || (req.mode === 'navigate' ? await c.match('index.html') : null);
      const net = fetch(req).then(r => { if (r.ok) c.put(req, r.clone()); return r; }).catch(() => null);
      return hit || (await net) || new Response('Hors ligne', { status: 503 });
    }));
  }
  // Le reste (données OurAirports…) passe directement au réseau.
});
