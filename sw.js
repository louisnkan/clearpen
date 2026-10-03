// Clearpen service worker — minimal on purpose.
// It never touches /api/ calls or Supabase/Paystack requests (only same-origin page loads).
const CACHE = 'clearpen-shell-v1';
const OFFLINE_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Clearpen</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0e1f17;color:#f0ead8;font-family:system-ui,sans-serif;text-align:center;padding:24px}button{margin-top:16px;padding:12px 22px;border:0;border-radius:8px;background:#c9a84c;color:#0e1f17;font-weight:600;font-size:16px}</style></head><body><div><h2>You're offline</h2><p>Clearpen needs internet to refine your writing.</p><button onclick="location.reload()">Try again</button></div></body></html>`;

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  // Only handle same-origin page navigations. Everything else goes straight to the network.
  if (req.method !== 'GET' || url.origin !== self.location.origin || req.mode !== 'navigate') return;
  event.respondWith(
    fetch(req).catch(() => new Response(OFFLINE_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }))
  );
});
