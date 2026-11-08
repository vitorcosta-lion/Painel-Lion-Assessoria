// Service worker do painel: abre rápido e mostra o último dado carregado se a internet cair.
const VERSION = 'lion-v1';
const SHELL = ['/', '/assets/icon-color.png', '/assets/logo-white.png', '/assets/Poppins-Regular.ttf', '/assets/Poppins-Medium.ttf', '/assets/Poppins-Bold.ttf'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

// Rede primeiro, cache como reserva (dados e página sempre atualizados quando online).
async function networkFirst(req) {
  const cache = await caches.open(VERSION);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    const hit = await cache.match(req);
    if (hit) return hit;
    if (req.mode === 'navigate') return (await cache.match('/')) || Response.error();
    return new Response(JSON.stringify({ error: 'offline' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  }
}

// Cache primeiro para arquivos estáticos (fontes, ícones), atualizando em segundo plano.
async function staleWhileRevalidate(req) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(req);
  const net = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => hit);
  return hit || net;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return; // POST /api/sync passa direto
  if (url.pathname === '/sw.js') return;
  if (url.pathname.startsWith('/api/') || req.mode === 'navigate') {
    e.respondWith(networkFirst(req));
  } else {
    e.respondWith(staleWhileRevalidate(req));
  }
});
