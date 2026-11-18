// Minimal app-shell cache for the standalone browser/PWA client. Only caches this
// directory's own static files (HTML/CSS/JS/wasm) so the app shell loads offline;
// everything under /api and /ws always goes straight to the network — this is a
// live messenger, not a static site, and stale cached API responses would be wrong.
const CACHE_NAME = 'zali-shell-v3';
// Настройки, которые страница сообщает SW (адрес API для «Отклонить» в уведомлении о
// звонке). Отдельный кеш, переживающий смену версии каркаса.
const CONFIG_CACHE = 'zali-sw-config';
const CONFIG_KEY = './__zali-sw-config';
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
            .then((names) => Promise.all(names.filter((name) => name !== CACHE_NAME && name !== CONFIG_CACHE).map((name) => caches.delete(name))))
            .then(() => self.clients.claim())
    );
});

// Одно сообщение — одно уведомление. О сообщении могут сообщить двое: пуш с сервера и
// живая, но не активная вкладка (showBrowserNotification). Сервер шлёт пуш и такой вкладке
// — он не может знать, исполняется ли у неё JS (фоновую вкладку браузер замораживает).
// Обе стороны ставят один tag (переписка) и messageId в data: если уведомление об этом
// сообщении уже висит, пуш переподнимает его молча. Совсем не показывать нельзя — подписка
// оформлена с userVisibleOnly, и браузер сам покажет «сайт обновлён в фоне».
async function showMessageNotification(title, options) {
    const tag = options.tag || '';
    const messageId = options.data && options.data.messageId;
    // force — «Всё равно оповестить» (server/src/focus.rs): тихое уведомление об этом
    // сообщении уже стоит, и именно его надо повторить со звуком.
    const forced = !!(options.data && options.data.force);
    if (tag && messageId && !forced) {
        const existing = await self.registration.getNotifications({ tag });
        if (existing.some((notification) => notification.data && notification.data.messageId === messageId)) {
            return self.registration.showNotification(title, { ...options, renotify: false, silent: true });
        }
    }
    return self.registration.showNotification(title, options);
}

self.addEventListener('message', (event) => {
    const data = event.data || {};
    if (data.type !== 'zali:sw-config' || typeof data.apiBaseUrl !== 'string') return;
    event.waitUntil(
        caches.open(CONFIG_CACHE).then((cache) => cache.put(
            CONFIG_KEY,
            new Response(JSON.stringify({ apiBaseUrl: data.apiBaseUrl }), { headers: { 'Content-Type': 'application/json' } })
        ))
    );
});

async function storedApiBaseUrl() {
    try {
        const cache = await caches.open(CONFIG_CACHE);
        const response = await cache.match(CONFIG_KEY);
        const config = response ? await response.json() : null;
        return config && typeof config.apiBaseUrl === 'string' ? config.apiBaseUrl.replace(/\/+$/, '') : '';
    } catch (e) {
        return '';
    }
}

// Звонок (server/src/push.rs, send_incoming_call_push / send_call_end_push). Кнопки в
// уведомлении браузер красит сам — цвет им не задать.
function showCallNotification(data) {
    const payload = data.data || {};
    const tag = data.tag || `zali:call:${payload.roomId || ''}`;
    if (payload.kind === 'call') {
        return self.registration.showNotification(data.title || 'Входящий звонок', {
            body: data.body || payload.from || '',
            icon: './icon-192.png',
            badge: './icon-192.png',
            tag,
            renotify: true,
            requireInteraction: true,
            vibrate: [400, 200, 400, 200, 400],
            actions: [
                { action: 'accept', title: 'Принять' },
                { action: 'decline', title: 'Отклонить' },
            ],
            data: payload,
        });
    }
    // Конец звонка заменяет его уведомление тем же tag: подписка userVisibleOnly, совсем
    // ничего не показать нельзя.
    return self.registration.showNotification(data.title || 'Звонок завершён', {
        body: data.body || payload.from || '',
        icon: './icon-192.png',
        badge: './icon-192.png',
        tag,
        silent: !!data.silent,
        data: payload,
    });
}

self.addEventListener('push', (event) => {
    let data = {};
    try {
        data = event.data ? event.data.json() : {};
    } catch (e) {}
    const kind = data.data && data.data.kind;
    if (kind === 'call' || kind === 'call_end') {
        event.waitUntil(showCallNotification(data));
        return;
    }
    const title = data.title || 'ZaliMessenger';
    const options = {
        body: data.body || '',
        icon: './icon-192.png',
        badge: './icon-192.png',
        data: data.data || {},
    };
    if (data.tag) {
        // Одна запись на переписку в центре уведомлений, но каждое новое сообщение звучит.
        options.tag = data.tag;
        options.renotify = true;
    }
    if (data.silent) {
        // Режим «в игре» получателя: показать, но без звука. Браузер отвергает
        // silent вместе с renotify (TypeError), поэтому повтор сигнала выключается.
        options.silent = true;
        options.renotify = false;
    }
    event.waitUntil(showMessageNotification(title, options));
});

// Клик ведёт в переписку уведомления, а не просто на главную: открытой вкладке уходит
// postMessage (web/src/interface/web_push.js, installWebPushClickRouting), новая
// открывается с ?open=… в адресе.
// «Отклонить» без открытой вкладки: секретом звонка из пуша, без сессии
// (server/src/voice.rs, decline_call_with_token). Не вышло — открытой вкладке.
async function declineCall(data) {
    const apiBaseUrl = await storedApiBaseUrl();
    if (apiBaseUrl && data.declineToken) {
        try {
            const response = await fetch(`${apiBaseUrl}/api/voice/call/decline`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ roomId: data.roomId || '', token: data.declineToken }),
            });
            if (response.ok || response.status === 410) return;
        } catch (e) {}
    }
    const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clientList) {
        client.postMessage({ type: 'zali:call-action', action: 'decline', roomId: data.roomId || '', from: data.from || '' });
    }
}

async function openForCall(data, action) {
    const message = { type: 'zali:call-action', action, roomId: data.roomId || '', from: data.from || '' };
    const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clientList) {
        if ('focus' in client) {
            client.postMessage(message);
            return client.focus();
        }
    }
    if (!self.clients.openWindow) return undefined;
    const url = new URL(self.registration.scope);
    // «Принять» через адрес — только с одноразовым nonce, который знает лишь этот
    // service worker (Cache API того же origin). Без него страница считает `?call=`
    // простым «открыть»: иначе ссылка `?call={"action":"accept"}` от звонящего
    // поднимала трубку и включала микрофон без нажатия (аудит 2026-11-18).
    let nonce = '';
    if (action === 'accept') {
        try {
            nonce = Array.from(self.crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
            const cache = await caches.open(CALL_NONCE_CACHE);
            await cache.put(`/__zali_call_nonce/${nonce}`, new Response(String(Date.now())));
        } catch (e) {
            nonce = '';
        }
    }
    url.searchParams.set('call', JSON.stringify({ action: nonce ? action : 'open', roomId: message.roomId, from: message.from, nonce }));
    return self.clients.openWindow(url.toString());
}

const CALL_NONCE_CACHE = 'zali-call-nonce';

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const data = event.notification.data || {};
    if (data.kind === 'call') {
        if (event.action === 'decline') event.waitUntil(declineCall(data));
        // Само уведомление (не кнопка) — открыть приложение, звонок там со своими кнопками.
        else event.waitUntil(openForCall(data, event.action === 'accept' ? 'accept' : 'open'));
        return;
    }
    const target = {
        sender: data.sender || '',
        serverId: data.serverId || '',
        channelId: data.channelId || '',
    };
    const hasTarget = !!(target.sender || (target.serverId && target.channelId));
    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
            for (const client of clientList) {
                if ('focus' in client) {
                    if (hasTarget) client.postMessage({ type: 'zali:open-conversation', ...target });
                    return client.focus();
                }
            }
            if (!self.clients.openWindow) return undefined;
            const url = new URL(self.registration.scope);
            if (hasTarget) url.searchParams.set('open', JSON.stringify(target));
            return self.clients.openWindow(url.toString());
        })
    );
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin) return;
    if (url.pathname.startsWith('/api') || url.pathname.startsWith('/ws') || url.pathname.startsWith('/uploads')) return;
    if (event.request.method !== 'GET') return;

    // Network-first, cache only as an offline fallback. This used to be
    // `return cached || network`: the cached copy was served immediately and the
    // network copy only refreshed the cache, so every browser/PWA user ran the
    // PREVIOUS deploy's app.js until they reloaded a second time — client fixes
    // (voice among them) silently didn't reach the web client the day they shipped,
    // while the native shells, which embed the bundle at build time, did get them.
    // The shell is a handful of files off the same origin; paying one conditional
    // request for it is cheaper than debugging a version skew nobody can see.
    event.respondWith(
        fetch(event.request)
            .then((response) => {
                // Кешируем только сам каркас: URL с query (`/?open={"sender":…}` из
                // уведомлений и т. п.) копили в CacheStorage имена собеседников и
                // росли без предела; офлайн их отдаст каркас по пути без query.
                if (response.ok && !url.search && response.type === 'basic') {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
                }
                return response;
            })
            .catch(() => caches.match(event.request, { ignoreSearch: true }).then((cached) => cached || Promise.reject(new Error('offline'))))
    );
});
