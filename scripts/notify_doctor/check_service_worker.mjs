// web/service-worker.js: пуш и локальное уведомление вкладки об одном сообщении — одно
// уведомление, а клик ведёт в переписку.
//
// Исполняется настоящий файл service worker'а. Подменены только ServiceWorkerGlobalScope
// (registration, clients) — центр уведомлений моделируется так, как его ведёт браузер:
// уведомление с тем же tag заменяет предыдущее.
import fs from 'node:fs';
import vm from 'node:vm';

let failures = 0;
let checks = 0;
const pass = (n, d = '') => { checks += 1; console.log(`  [PASS] ${n}${d ? ` — ${d}` : ''}`); };
const fail = (n, d = '') => { checks += 1; failures += 1; console.log(`  [FAIL] ${n}${d ? ` — ${d}` : ''}`); };
const check = (n, ok, failDetail = '', passDetail = '') => (ok ? pass(n, passDetail) : fail(n, failDetail));

const source = fs.readFileSync(new URL('../../web/service-worker.js', import.meta.url), 'utf8');

// appRoot — значение APP_ROOT: './' как есть или '/web/' для копии в корне домена,
// которую делает scripts/build_site_dist.py (скрипт в /service-worker.js, клиент в /web/).
function loadWorker({ appRoot = './', scriptUrl = 'https://msg.example/service-worker.js' } = {}) {
    const listeners = {};
    const shown = [];
    const center = [];
    const clients = [];
    const opened = [];
    const registration = {
        scope: 'https://msg.example/',
        getNotifications: async ({ tag } = {}) => center.filter(entry => !tag || entry.tag === tag),
        showNotification: async (title, options = {}) => {
            shown.push({ title, ...options });
            const entry = { title, tag: options.tag, data: options.data };
            const index = options.tag ? center.findIndex(item => item.tag === options.tag) : -1;
            if (index >= 0) center[index] = entry; else center.push(entry);
        },
    };
    const self = {
        registration,
        location: new URL(scriptUrl),
        addEventListener: (type, fn) => { listeners[type] = fn; },
        skipWaiting: async () => {},
        clients: {
            matchAll: async () => clients.map(client => ({ url: 'https://msg.example/', ...client })),
            openWindow: async (url) => { opened.push(url); },
            claim: async () => {},
        },
    };
    const sandbox = { self, caches: {}, fetch: async () => ({}), URL, console, Promise };
    vm.createContext(sandbox);
    const patched = source.replace("const APP_ROOT = './'; // @app-root", `const APP_ROOT = ${JSON.stringify(appRoot)}; // @app-root`);
    if (appRoot !== './' && patched === source) throw new Error('маркер @app-root пропал из web/service-worker.js');
    vm.runInContext(patched, sandbox, { filename: 'web/service-worker.js' });

    const fire = async (type, event) => {
        let pending = null;
        event.waitUntil = (promise) => { pending = promise; };
        listeners[type](event);
        await pending;
    };
    const push = (payload) => fire('push', { data: { json: () => payload } });
    const click = (data) => {
        const event = { notification: { data, close() {} } };
        return fire('notificationclick', event);
    };
    return { push, click, shown, center, clients, opened };
}

const dmPush = (messageId) => ({
    title: 'alice',
    body: 'Новое сообщение',
    tag: 'zali:dm:alice',
    data: { sender: 'alice', serverId: null, channelId: null, messageId },
});

async function dedupe() {
    console.log('\n──────── одно сообщение — одно уведомление\n');
    const worker = loadWorker();

    await worker.push(dmPush('m1'));
    const first = worker.shown.at(-1);
    check('новое сообщение звучит', first && first.renotify === true && !first.silent,
        `renotify=${first?.renotify} silent=${first?.silent}`, 'renotify, не silent');

    await worker.push(dmPush('m1'));
    const repeat = worker.shown.at(-1);
    check('повторный пуш о том же сообщении не звенит второй раз', repeat.silent === true && repeat.renotify === false,
        `renotify=${repeat.renotify} silent=${repeat.silent}`, 'переподнято молча');
    check('и не плодит записей в центре уведомлений', worker.center.length === 1, `${worker.center.length} записей`, '1 запись');

    const tabFirst = loadWorker();
    // Живая вкладка успела показать своё уведомление (showBrowserNotification) раньше пуша.
    tabFirst.center.push({ title: 'alice', tag: 'zali:dm:alice', data: { messageId: 'm7' } });
    await tabFirst.push(dmPush('m7'));
    check('пуш после локального уведомления вкладки молчит', tabFirst.shown.at(-1).silent === true,
        'двойной звонок о сообщении, которое вкладка уже показала', 'silent');

    await tabFirst.push(dmPush('m8'));
    check('следующее сообщение той же переписки снова звучит', tabFirst.shown.at(-1).renotify === true && !tabFirst.shown.at(-1).silent,
        'второе сообщение переписки пришло беззвучно', 'renotify');
}

async function clickRouting() {
    console.log('\n──────── клик по уведомлению\n');
    const withTab = loadWorker();
    const messages = [];
    let focused = 0;
    withTab.clients.push({ focus: async () => { focused += 1; }, postMessage: (message) => messages.push(message) });
    await withTab.click({ sender: '', serverId: 's1', channelId: 'c1', messageId: 'm1' });
    const message = messages[0];
    check('открытая вкладка получает переписку уведомления', message?.type === 'zali:open-conversation'
        && message.serverId === 's1' && message.channelId === 'c1',
        `получено ${JSON.stringify(message)}`, 's1/c1');
    check('и выходит на передний план', focused === 1, `focus() вызван ${focused} раз`, 'focus()');

    const noTab = loadWorker();
    await noTab.click({ sender: 'alice', serverId: null, channelId: null, messageId: 'm1' });
    const url = noTab.opened[0] ? new URL(noTab.opened[0]) : null;
    const target = url ? JSON.parse(url.searchParams.get('open') || '{}') : {};
    check('без вкладки открывается новая — сразу в переписку', target.sender === 'alice',
        `открыто ${noTab.opened[0] || 'ничего'}`, noTab.opened[0]);
}

// Клиент в /web/, скрипт в корне домена: сайт на корне не должен ни получать фокус
// по клику на уведомление, ни открываться вместо приложения.
async function rootScript() {
    console.log('\n──────── скрипт в корне домена, клиент в /web/\n');
    const opts = { appRoot: '/web/' };
    const site = loadWorker(opts);
    const siteMessages = [];
    let siteFocused = 0;
    site.clients.push({ url: 'https://msg.example/', focus: async () => { siteFocused += 1; }, postMessage: (m) => siteMessages.push(m) });
    await site.click({ sender: 'alice', serverId: null, channelId: null, messageId: 'm1' });
    check('открытая страница сайта не получает ни фокус, ни переписку',
        siteFocused === 0 && siteMessages.length === 0, `focus=${siteFocused}, сообщений ${siteMessages.length}`, 'сайт не тронут');
    const opened = site.opened[0] ? new URL(site.opened[0]) : null;
    check('вместо неё открывается приложение в /web/, сразу в переписку',
        opened?.pathname === '/web/' && JSON.parse(opened.searchParams.get('open') || '{}').sender === 'alice',
        `открыто ${site.opened[0] || 'ничего'}`, site.opened[0]);

    const app = loadWorker(opts);
    const appMessages = [];
    let appFocused = 0;
    app.clients.push({ url: 'https://msg.example/web/', focus: async () => { appFocused += 1; }, postMessage: (m) => appMessages.push(m) });
    await app.click({ sender: '', serverId: 's1', channelId: 'c1', messageId: 'm2' });
    check('открытое окно приложения в /web/ получает переписку и фокус',
        appFocused === 1 && appMessages[0]?.type === 'zali:open-conversation' && app.opened.length === 0,
        `focus=${appFocused}, открыто ${app.opened.length}`, 'фокус без нового окна');
}

await dedupe();
await clickRouting();
await rootScript();

console.log(`\n  итог: ${checks} проверок, ${failures} нарушено`);
process.exit(failures ? 1 : 0);
