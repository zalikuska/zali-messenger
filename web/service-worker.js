// Minimal app-shell cache for the standalone browser/PWA client. Only caches this
// directory's own static files (HTML/CSS/JS/wasm) so the app shell loads offline;
// everything under /api and /ws always goes straight to the network — this is a
// live messenger, not a static site, and stale cached API responses would be wrong.
const CACHE_NAME = 'zali-shell-v2';
const SHELL_FILES = [
    './',
    './index.html',
    './style.css',
    './app.js',
    './manifest.json',
    './icon.svg',
    './icon-192.png',
    './icon-512.png',
    './apple-touch-icon.png',
    './wasm-pkg/zali_core.js',
    './wasm-pkg/zali_core_bg.wasm',
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(SHELL_FILES))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((names) => Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('push', (event) => {
    let data = {};
    try {
        data = event.data ? event.data.json() : {};
    } catch (e) {}
    const title = data.title || 'ZaliMessenger';
    const options = {
        body: data.body || '',
        icon: './icon-192.png',
        badge: './icon-192.png',
        data: data.data || {},
    };
    event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const targetUrl = self.registration.scope;
    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
            for (const client of clientList) {
                if ('focus' in client) return client.focus();
            }
            if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
            return undefined;
        })
    );
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin) return;
    if (url.pathname.startsWith('/api') || url.pathname.startsWith('/ws') || url.pathname.startsWith('/uploads')) return;
    if (event.request.method !== 'GET') return;

    event.respondWith(
        caches.match(event.request).then((cached) => {
            const network = fetch(event.request)
                .then((response) => {
                    if (response.ok) {
                        const clone = response.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
                    }
                    return response;
                })
                .catch(() => cached);
            return cached || network;
        })
    );
});
