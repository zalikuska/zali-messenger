// Доходит ли уведомление о сообщении до пользователя.
//
// Каждый клиент — настоящий ZaliInterface (тот же load_interface.mjs, что у
// voice_doctor/perf_doctor). Подменены только границы браузера: DOM-отрисовка,
// звук, персист и нативный мост, который здесь просто записывает каждый
// SHOW_NOTIFICATION. Видимость окна, фокус и кадры анимации управляются
// тестом — ровно те три вещи, от которых зависело, придёт ли уведомление.
import fs from 'node:fs';
import { loadZaliInterface } from '../voice_doctor/lib/load_interface.mjs';

let failures = 0;
let checks = 0;
const pass = (n, d = '') => { checks += 1; console.log(`  [PASS] ${n}${d ? ` — ${d}` : ''}`); };
const fail = (n, d = '') => { checks += 1; failures += 1; console.log(`  [FAIL] ${n}${d ? ` — ${d}` : ''}`); };
const check = (n, ok, failDetail = '', passDetail = '') => (ok ? pass(n, passDetail) : fail(n, failDetail));
const settle = (ms = 400) => new Promise(resolve => setTimeout(resolve, ms));

function makeClient({ native = true, current = 'alice' } = {}) {
    const { ZaliInterface, sandbox } = loadZaliInterface();
    const env = { hidden: false, focused: true };
    const doc = sandbox.document;
    Object.defineProperty(doc, 'hidden', { get: () => env.hidden, configurable: true });
    Object.defineProperty(doc, 'visibilityState', { get: () => (env.hidden ? 'hidden' : 'visible'), configurable: true });
    doc.hasFocus = () => env.focused;
    sandbox.performance = globalThis.performance;
    // Свёрнутому окну, окну в трее и фоновой вкладке браузер не выдаёт кадров вовсе.
    sandbox.requestAnimationFrame = (fn) => (env.hidden ? 0 : setTimeout(() => fn(Date.now()), 0));

    const shown = [];
    const browserShown = [];
    const api = Object.create(ZaliInterface.prototype);
    api.S = {
        session: { username: 'me', token: 't' },
        chats: {}, serverChats: {}, unread: {}, channelUnread: {}, mutedChats: {},
        contacts: ['alice', 'bob', 'carol'], navMode: 'dm', current,
        activeServer: null, activeChannel: null,
    };
    api.historyLoadSeq = 0;
    api._historyPrimedPeers = new Set();
    api._historyPrimedChannels = new Set();
    // Состояние, которое конструктор заводит, а Object.create() пропускает.
    for (const field of ['messageAnimSeen', 'storageWarningSeen', 'tenorPending']) api[field] = new Set();
    for (const field of ['mediaSizeCache', 'conversationSyncAt', 'conversationRefreshTimers', 'serverHistoryLoadSeq', 'sendWatchdogTimers', 'avatarCache']) api[field] = new Map();
    api.sound = {};
    api.voice = { status: 'idle', peerConnections: new Map() };
    if (native) {
        api.nativeBridge = () => ({
            available: true,
            supports: {},
            postMessage: (payload) => {
                if (payload?.type === 'SHOW_NOTIFICATION') shown.push(payload);
                return true;
            },
        });
    } else {
        api.nativeBridge = () => null;
        sandbox.Notification = function Notification(title) { browserShown.push(title); };
        sandbox.Notification.permission = 'granted';
    }
    const noop = () => {};
    Object.assign(api, {
        trace: noop, addLogEntry: noop, playMessageChime: noop,
        renderContacts: noop, renderServerInterface: noop, scheduleRenderMessages: noop,
        syncHubSegmentBadges: noop, saveStoredMessageCache: noop, scheduleSaveStoredMessageCache: noop,
        saveStoredServerChats: noop, scheduleFlushPendingOutbox: noop, scheduleConversationRefresh: noop,
        loadPendingOutbox: () => [], loadStoredCurrentContact: () => current,
    });
    return { api, env, shown, browserShown, sandbox };
}

const at = (i) => new Date(Date.UTC(2026, 8, 1, 0, 0, i)).toISOString();

// История одного собеседника в том виде, в каком её отдаёт нативный шелл:
// вся переписка по возрастанию времени, новое — в самом конце.
function history(peer, oldCount, newIds = []) {
    const rows = [];
    for (let i = 0; i < oldCount; i += 1) {
        rows.push({ id: `${peer}-old-${i}`, sender: i % 2 ? 'me' : peer, receiver: i % 2 ? peer : 'me', text: `old ${i}`, timestamp: at(i) });
    }
    newIds.forEach((id, k) => rows.push({ id, sender: peer, receiver: 'me', text: `new ${id}`, timestamp: at(oldCount + k) }));
    return rows;
}

function seedKnownHistory(api, peer, oldCount) {
    api.S.chats[peer] = history(peer, oldCount).map(m => ({ ...m, attachments: [], reactions: [], myReactions: [], status: 'sent' }));
    api._historyPrimedPeers.add(peer);
}

const fromPeers = (shown) => shown.map(n => n.sender).sort().join(',') || 'ничего';

async function attendedGate() {
    console.log('\n──────── открытый чат, окно не перед пользователем\n');
    const { api, env, shown } = makeClient();
    const incoming = (id) => api.receiveMessage({ id, sender: 'alice', receiver: 'me', text: `hi ${id}` });

    incoming('m1');
    check('окно в фокусе, чат открыт — уведомления нет', shown.length === 0,
        `${shown.length} уведомлений о сообщении, которое пользователь видит`, 'пользователь его и так видит');

    env.focused = false;
    incoming('m2');
    check('окно за другим приложением — уведомление есть', shown.length === 1,
        'открытый чат глушил уведомление, хотя на окно никто не смотрит', '1 уведомление');
    check('и счётчик непрочитанного растёт', api.S.unread.alice === 1, `unread=${api.S.unread.alice || 0}`, 'unread=1');

    env.hidden = true;
    incoming('m3');
    check('окно свёрнуто / в трее — уведомление есть', shown.length === 2,
        `${shown.length} уведомлений`, '2 уведомления');

    env.hidden = false;
    env.focused = true;
    if (typeof api.clearAttendedConversationUnread === 'function') api.clearAttendedConversationUnread();
    check('вернулся к окну — счётчик открытого чата снят', !api.S.unread.alice,
        `unread=${api.S.unread.alice}`, 'unread=0');

    const bridge = fs.readFileSync(new URL('../../web/src/interface/native_bridge.js', import.meta.url), 'utf8');
    check('снятие счётчика привязано к возврату окна (visibilitychange/focus)',
        /onVisibilityChange[\s\S]*?clearAttendedConversationUnread\(\)/.test(bridge),
        'onVisibilityChange не зовёт clearAttendedConversationUnread — счётчик повиснет до переключения чата');

    const channel = makeClient();
    Object.assign(channel.api.S, { navMode: 'servers', activeServer: 's1', activeChannel: 'c1' });
    channel.env.focused = false;
    channel.api.receiveMessage({ id: 'c-1', sender: 'alice', receiver: '', text: 'в канал', serverId: 's1', channelId: 'c1' });
    check('открытый канал, окно не в фокусе — уведомление есть', channel.shown.length === 1,
        `${channel.shown.length} уведомлений`, '1 уведомление');

    const browser = makeClient({ native: false });
    browser.env.focused = false;
    browser.api.receiveMessage({ id: 'b-1', sender: 'alice', receiver: 'me', text: 'из браузера' });
    check('браузер: видимая, но не активная вкладка — уведомление есть', browser.browserShown.length === 1,
        'showBrowserNotification ждала только скрытую вкладку', '1 уведомление');
}

async function catchUpBurst() {
    console.log('\n──────── догрузка после обрыва: история нескольких переписок подряд\n');
    const { api, shown } = makeClient({ current: 'carol' });
    seedKnownHistory(api, 'alice', 300);
    seedKnownHistory(api, 'bob', 300);
    // Нативный шелл присылает историю по одной переписке на вызов, пачкой.
    api.loadHistory(history('alice', 300, ['alice-new']));
    api.loadHistory(history('bob', 300, ['bob-new']));
    await settle();
    check('новое в каждой переписке пачки даёт уведомление', shown.length === 2,
        `уведомления только от: ${fromPeers(shown)} — разбор первой переписки отменил вызов для второй`,
        fromPeers(shown));
    check('и счётчики обеих переписок', api.S.unread.alice === 1 && api.S.unread.bob === 1,
        `alice=${api.S.unread.alice || 0} bob=${api.S.unread.bob || 0}`, 'alice=1 bob=1');

    const again = makeClient({ current: 'carol' });
    seedKnownHistory(again.api, 'alice', 300);
    again.api.loadHistory(history('alice', 300, ['alice-new']));
    again.api.loadHistory(history('alice', 300, ['alice-new']));
    await settle();
    check('повторная загрузка той же переписки не дублирует уведомление', again.shown.length === 1,
        `${again.shown.length} уведомлений об одном сообщении`, '1 уведомление');
}

async function hiddenWindow() {
    console.log('\n──────── догрузка в свёрнутом окне (кадров нет)\n');
    const { api, env, shown } = makeClient({ current: 'carol' });
    env.hidden = true;
    seedKnownHistory(api, 'alice', 600);
    api.loadHistory(history('alice', 600, ['alice-new']));
    await settle();
    check('уведомление приходит, пока окно свёрнуто, а не при его открытии', shown.length === 1,
        'разбор истории ждёт кадра, которого в скрытом окне не будет', '1 уведомление без единого кадра');
}

// Сервер решает, слать ли Web Push на устройство, по тому, что сообщила вкладка
// (server/src/push.rs::push_suppressed_for). Проверяется только сторона вкладки.
async function presenceReport() {
    console.log('\n──────── вкладка сообщает серверу, смотрят ли в неё\n');
    const { api, env, sandbox } = makeClient({ native: false });
    const sent = [];
    sandbox.WebSocket.OPEN = 1;
    api.voice.socket = { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) };
    api.currentDeviceId = () => 'dev-laptop';

    api.reportClientPresence({ force: true });
    check('при открытии сокета — смотрит, с id устройства',
        sent.at(-1)?.type === 'client_presence' && sent.at(-1).attended === true && sent.at(-1).deviceId === 'dev-laptop',
        `отправлено ${JSON.stringify(sent.at(-1))}`, JSON.stringify(sent.at(-1)));

    api.reportClientPresence();
    check('без изменений повторно не шлёт', sent.length === 1, `${sent.length} событий`, '1 событие');

    env.focused = false;
    api.reportClientPresence();
    check('ушёл в другое приложение — сервер узнаёт', sent.at(-1)?.attended === false,
        `последнее attended=${sent.at(-1)?.attended}`, 'attended=false');

    env.focused = true;
    api.reportClientPresence();
    api.reportClientPresence({ force: true, attended: false });
    check('закрытие вкладки сообщает «не смотрю» даже в фокусе', sent.at(-1)?.attended === false,
        `последнее attended=${sent.at(-1)?.attended}`, 'attended=false');
}

await attendedGate();
await catchUpBurst();
await hiddenWindow();
await presenceReport();

console.log(`\n  итог: ${checks} проверок, ${failures} нарушено`);
process.exit(failures ? 1 : 0);
