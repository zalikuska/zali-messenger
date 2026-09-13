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

function loadWorker() {
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
        addEventListener: (type, fn) => { listeners[type] = fn; },
        skipWaiting: async () => {},
        clients: {
            matchAll: async () => clients,
            openWindow: async (url) => { opened.push(url); },
            claim: async () => {},
        },
    };
    const sandbox = { self, caches: {}, fetch: async () => ({}), URL, console, Promise };
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox, { filename: 'web/service-worker.js' });

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

await dedupe();
await clickRouting();

console.log(`\n  итог: ${checks} проверок, ${failures} нарушено`);
process.exit(failures ? 1 : 0);
