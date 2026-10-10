// Режим «в игре» на стороне веба: web/src/interface/game_focus.js и его места в
// notifications.js / game_activity.js.
//
// Настоящий ZaliInterface; подменены нативный мост (записывает SHOW_NOTIFICATION и
// VOICE_EVENT), localStorage, apiFetch и звук. Проверяется контракт с сервером
// (server/src/focus.rs) и то, что получатель в игре не будет потревожен лишний раз.
import { loadZaliInterface } from '../voice_doctor/lib/load_interface.mjs';

let failures = 0;
const pass = (n, d = '') => console.log(`  [PASS] ${n}${d ? ` — ${d}` : ''}`);
const fail = (n, d = '') => { failures += 1; console.log(`  [FAIL] ${n}${d ? ` — ${d}` : ''}`); };
const check = (n, ok, failDetail = '', passDetail = '') => (ok ? pass(n, passDetail) : fail(n, failDetail));

function makeClient({ username = 'me', current = null, supports = { voice: true, gameActivity: true }, bridge = true } = {}) {
    const { ZaliInterface, sandbox } = loadZaliInterface();
    const store = new Map();
    sandbox.localStorage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => { store.set(k, String(v)); },
        removeItem: (k) => { store.delete(k); },
    };
    sandbox.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
    // Тест управляет DOM для заметки над полем ввода.
    const boxes = new Map();
    const element = (id) => {
        if (!boxes.has(id)) boxes.set(id, { id, hidden: true, innerHTML: '', childElementCount: 0, dataset: {}, addEventListener() {} });
        return boxes.get(id);
    };
    sandbox.document.getElementById = (id) => element(id);

    const posted = [];
    const api = Object.create(ZaliInterface.prototype);
    api.S = {
        session: { username, token: 't' },
        contacts: ['alice', 'bob'], navMode: 'dm', current,
        chats: {}, unread: {}, channelUnread: {}, mutedChats: {}, wsOn: true, serverModal: {},
    };
    api.voice = { status: 'idle', socket: null };
    api.sound = {};
    const chimes = [];
    const browserShown = [];
    api.nativeBridge = () => (bridge ? {
        available: true,
        supports,
        postMessage: (payload) => { posted.push(payload); return true; },
    } : null);
    const requests = [];
    const noop = () => {};
    Object.assign(api, {
        trace: noop, addLogEntry: noop, renderContacts: noop, syncHubSegmentBadges: noop,
        updateChatHeaderCryptoKey: noop, renderProfileOverlay: noop,
        renderServerModalMembers: noop, ensureProfileState: () => ({ open: false }),
        playMessageChime: () => { chimes.push(Date.now()); },
        showBrowserNotification: (n) => { browserShown.push(n); },
        coinCardSummary: () => '',
        apiFetch: async (path, options = {}) => {
            requests.push({ path, ...options });
            const body = options.body ? JSON.parse(options.body) : null;
            if (path === '/api/game-focus') {
                if (api._failSave && options.method === 'PUT') return { ok: false, status: 400, json: async () => ({}) };
                return { ok: true, status: 200, json: async () => body || api._serverFocus || {} };
            }
            return { ok: true, status: 200, json: async () => ({ ok: true }) };
        },
    });
    const shown = () => posted.filter(p => p.type === 'SHOW_NOTIFICATION' && !p.quiet);
    const quiet = () => posted.filter(p => p.type === 'SHOW_NOTIFICATION' && p.quiet);
    const badges = () => posted.filter(p => p.type === 'SET_UNREAD_BADGE').map(p => p.count);
    const frames = () => posted
        .filter(p => p.type === 'VOICE_EVENT' && p.payload?.type === 'client_activity')
        .map(p => p.payload);
    return { api, posted, shown, quiet, badges, frames, chimes, browserShown, requests, element, sandbox };
}

const incoming = (api, over = {}) => api.notifyBackgroundMessage({
    sender: 'alice', text: 'ты где?', peer: 'alice', messageId: 'm1', ...over,
});
const realtime = (api, payload) => api.dispatchRealtimeEvent(payload);

console.log('\n──────── без политики — уведомление обычное');
{
    const { api, shown, chimes } = makeClient();
    incoming(api);
    check('сигнал и уведомление как раньше', chimes.length === 1 && shown().length === 1);
    check('silent не выставлен', shown()[0]?.silent === false);
    check('счётчик непрочитанного вырос', api.S.unread.alice === 1);
}

console.log('\n──────── silent — уведомление есть, звука нет');
{
    const { api, shown, chimes, browserShown } = makeClient();
    realtime(api, { type: 'notify_policy', messageId: 'm1', mode: 'silent', from: 'alice' });
    incoming(api);
    check('нативное уведомление показано', shown().length === 1);
    check('с флагом silent', shown()[0].silent === true);
    check('сигнал приложения не играет', chimes.length === 0);
    check('браузерное тоже silent', browserShown[0]?.silent === true);
    check('счётчик непрочитанного вырос', api.S.unread.alice === 1);
    incoming(api, { messageId: 'm2' });
    check('политика одноразовая: следующее сообщение — обычное', shown()[1]?.silent === false && chimes.length === 1);
}

console.log('\n──────── defer — тоста нет до конца игры');
{
    const { api, shown, chimes } = makeClient();
    realtime(api, { type: 'notify_policy', messageId: 'm1', mode: 'defer', from: 'alice' });
    realtime(api, { type: 'notify_policy', messageId: 'm2', mode: 'defer', from: 'alice' });
    incoming(api, { messageId: 'm1', text: 'раз' });
    incoming(api, { messageId: 'm2', text: 'два' });
    check('ни тоста, ни сигнала', shown().length === 0 && chimes.length === 0);
    check('счётчик при этом растёт — сообщения не потеряны', api.S.unread.alice === 2);
    realtime(api, { type: 'focus_flush' });
    check('конец сессии — одно сводное уведомление на отправителя', shown().length === 1, `уведомлений: ${shown().length}`);
    check('в сводке число сообщений', /2 сообщения/.test(shown()[0]?.text || ''), shown()[0]?.text);
    check('сводка со звуком', shown()[0]?.silent === false && chimes.length === 1);
    realtime(api, { type: 'focus_flush' });
    check('повторный flush ничего не показывает', shown().length === 1);
}

console.log('\n──────── defer — кружок на значке сразу, без тоста и звука');
{
    const { api, shown, chimes, badges } = makeClient({ supports: { voice: true, gameActivity: true, taskbarBadge: true } });
    realtime(api, { type: 'notify_policy', messageId: 'm1', mode: 'defer', from: 'alice' });
    incoming(api);
    check('тоста и сигнала нет', shown().length === 0 && chimes.length === 0);
    check('кружок на значке уже показывает 1', badges().at(-1) === 1, JSON.stringify(badges()));
    realtime(api, { type: 'notify_policy', messageId: 'm2', mode: 'defer', from: 'bob' });
    incoming(api, { sender: 'bob', peer: 'bob', messageId: 'm2' });
    check('растёт с каждым сообщением', badges().at(-1) === 2);
    // Человек открыл переписку с alice и прочитал — отложенное о ней больше не нужно.
    api.S.unread.alice = 0;
    api.syncTaskbarBadge();
    realtime(api, { type: 'focus_flush' });
    check('прочитанное в сводку не попадает', shown().length === 1 && shown()[0].sender === 'bob', JSON.stringify(shown().map(s => s.sender)));
    check('кружок уменьшился', badges().at(-1) === 1);
}

console.log('\n──────── значок установленного PWA (Badging API)');
{
    const calls = [];
    const { api, sandbox } = makeClient({ bridge: false });
    sandbox.navigator = { setAppBadge: (n) => { calls.push(n); return Promise.resolve(); }, clearAppBadge: () => { calls.push(0); return Promise.resolve(); } };
    globalThis.navigator ??= sandbox.navigator;
    realtime(api, { type: 'notify_policy', messageId: 'm1', mode: 'defer', from: 'alice' });
    incoming(api);
    check('setAppBadge получает число непрочитанных', calls.at(-1) === 1, JSON.stringify(calls));
    api.S.unread.alice = 0;
    api.syncTaskbarBadge();
    check('прочитано — значок очищается', calls.at(-1) === 0, JSON.stringify(calls));
}

console.log('\n──────── Android: тихое уведомление ради кружка');
{
    const { api, shown, quiet, chimes } = makeClient({ supports: { voice: false, quietBadge: true } });
    realtime(api, { type: 'notify_policy', messageId: 'm1', mode: 'defer', from: 'alice' });
    realtime(api, { type: 'notify_policy', messageId: 'm2', mode: 'defer', from: 'alice' });
    incoming(api, { messageId: 'm1' });
    incoming(api, { messageId: 'm2' });
    check('обычного уведомления нет', shown().length === 0 && chimes.length === 0);
    check('одно тихое на отправителя со счётчиком', quiet().length === 2 && quiet().at(-1).count === 2 && quiet().at(-1).sender === 'alice', JSON.stringify(quiet()));
    realtime(api, { type: 'focus_flush' });
    check('по окончании игры тихое снимается', quiet().at(-1)?.clear === true);
}

console.log('\n──────── «Всё равно оповестить» у получателя');
{
    const { api, shown, chimes } = makeClient();
    realtime(api, { type: 'notify_policy', messageId: 'm1', mode: 'defer', from: 'alice' });
    incoming(api, { text: 'срочно' });
    check('сначала тишина', shown().length === 0);
    realtime(api, { type: 'notify_now', messageId: 'm1', from: 'alice' });
    check('notify_now показывает именно это сообщение со звуком', shown().length === 1 && shown()[0].text === 'срочно' && chimes.length === 1);
    check('с force — заменяет тихое уведомление', shown()[0].force === true);
    realtime(api, { type: 'focus_flush' });
    check('снятое с отсрочки в сводку не попадает', shown().length === 1);
}

console.log('\n──────── silent → «Всё равно оповестить» повторяет громко');
{
    const { api, shown, chimes } = makeClient();
    realtime(api, { type: 'notify_policy', messageId: 'm1', mode: 'silent', from: 'alice' });
    incoming(api, { text: 'ку' });
    realtime(api, { type: 'notify_now', messageId: 'm1', from: 'alice' });
    check('второе уведомление со звуком', shown().length === 2 && shown()[1].silent === false && shown()[1].force === true && chimes.length === 1);
    check('с тем же текстом', shown()[1].text === 'ку');
}

console.log('\n──────── сообщения каналов режим не трогает');
{
    const { api, shown } = makeClient();
    realtime(api, { type: 'notify_policy', messageId: 'c1', mode: 'defer', from: 'alice' });
    api.notifyBackgroundMessage({ sender: 'alice', text: 'в канале', serverId: 's1', channelId: 'c1', messageId: 'c1' });
    check('канал — обычное уведомление', shown().length === 1);
}

console.log('\n──────── заметка отправителя');
{
    const { api, element, requests } = makeClient({ current: 'bob' });
    realtime(api, { type: 'delivery_note', messageId: 'm9', to: 'bob', mode: 'defer' });
    const box = element('composerFocusNote');
    check('заметка видна в чате с этим собеседником', box.hidden === false && /по окончании игровой сессии/.test(box.innerHTML), box.innerHTML);
    check('есть кнопка «Всё равно оповестить»', /Всё равно оповестить/.test(box.innerHTML) && /data-focus-notify-anyway="m9"/.test(box.innerHTML));
    check('названия игры в заметке нет', !/Dota|Играет в/.test(box.innerHTML));
    api.S.current = 'alice';
    api.renderComposerFocusNote();
    check('в другом чате заметки нет', box.hidden === true);
    api.S.current = 'bob';
    realtime(api, { type: 'delivery_note', messageId: 'm10', to: 'bob', mode: 'silent' });
    check('тихий режим говорит «отправлено тихо»', /Отправлено тихо/.test(box.innerHTML) && /без звука/.test(box.innerHTML));
    await api.notifyAnyway('m10');
    const call = requests.find(r => r.path === '/api/message/m10/notify-now');
    check('кнопка шлёт POST notify-now по id сообщения', call?.method === 'POST', JSON.stringify(requests.map(r => r.path)));
    check('после нажатия заметка исчезает', box.hidden === true);
    realtime(api, { type: 'delivery_note', messageId: 'm11', to: 'bob', mode: 'defer' });
    realtime(api, { type: 'delivery_note_done', to: 'bob', messageIds: ['m11'] });
    check('когда сообщение дошло, заметка снимается', box.hidden === true);
}

console.log('\n──────── настройки и определение игры');
{
    const { api, frames, shown } = makeClient();
    api._detectedGame = null;
    api.handleGameActivityRealtime({ type: 'native_game_activity', activity: { name: 'Dota 2', id: 'proc:dota2', source: 'process' } });
    check('без режима и без показа статус не уходит', frames().length === 0);
    await api.saveGameFocusSettings({ mode: 'defer', audience: 'friends' });
    check('режим включён', api.gameFocusEnabled() === true);
    const sent = frames().at(-1);
    check('игра ушла на сервер для режима', sent?.activity?.name === 'Dota 2', JSON.stringify(sent));
    check('но с share:false — показывать её другим никто не просил', sent?.activity?.share === false);
    check('у себя значок игры не рисуется', api.gameActivityFor('me') === null);
    await api.saveGameFocusSettings({ audience: 'nobody' });
    check('аудитория «никому» = режим выключен', api.gameFocusEnabled() === false);
    check('и статус отзывается', frames().at(-1)?.activity === null, JSON.stringify(frames().at(-1)));
}
{
    const { api } = makeClient();
    await api.saveGameFocusSettings({ mode: 'silent', people: ['bob'], audience: 'only' });
    api._failSave = true;
    await api.saveGameFocusSettings({ mode: 'defer' });
    check('не сохранилось на сервере — вернули прежнее', api.gameFocusSettings().mode === 'silent' && !!api._gameFocusError);
    api._failSave = false;
    api._serverFocus = { mode: 'defer', audience: 'except', games: ['Hades'], people: ['eve'] };
    await api.loadGameFocusSettings();
    check('настройки с сервера подтягиваются', api.gameFocusSettings().audience === 'except' && api.gameFocusSettings().people[0] === 'eve');
}

console.log('');
console.log(failures === 0 ? '  итог: все проверки пройдены' : `  итог: нарушено ${failures}`);
process.exit(failures === 0 ? 0 : 1);
