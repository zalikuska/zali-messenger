// «Общий браузер» (web/src/interface/shared_browser.js) на настоящем коде клиента.
//
// alice запускает браузер в звонке сообщества (оболочка с nativeSharedBrowser), bob и eve
// управляют им. Сервер — прямой обмен voice_signal с проставленным `from`; каналы данных —
// пары заглушек RTCDataChannel; оболочка alice — заглушка MEDIA_REQUEST, startScreenShare —
// заглушка, которая «открывает» браузер. Проверяется то, на чём держится безопасность:
// фильтр ввода (вставка/копирование чужого буфера, file:/javascript:), клавиши и вставка
// не идут через сервер, «управляю только я», профиль сообщества берётся и сохраняется
// только через свой сервер, и всё гасится с концом трансляции или звонка.
import { loadZaliInterface } from './lib/load_interface.mjs';

let failures = 0;
let count = 0;
function record(name, ok, detail = '') {
    count += 1;
    if (!ok) failures += 1;
    process.stdout.write(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}\n`);
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 8; i += 1) await tick(); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { ZaliInterface } = loadZaliInterface({ NativeMessageTypes: { MEDIA_REQUEST: 'MEDIA_REQUEST' } });

const clients = new Map();
const serverProfile = { cookies: [{ name: 'sid', value: 'shared', domain: '.example.com', path: '/', expires: -1 }], puts: [] };

/** Пара каналов: то, что отправлено в один, приходит в onmessage другого. */
function channelPair(label) {
    const a = { label, readyState: 'open', bufferedAmount: 0, sent: [], peer: null, onmessage: null, onclose: null, onopen: null };
    const b = { label, readyState: 'open', bufferedAmount: 0, sent: [], peer: null, onmessage: null, onclose: null, onopen: null };
    for (const [x, y] of [[a, b], [b, a]]) {
        x.peer = y;
        x.send = (data) => { x.sent.push(data); queueMicrotask(() => y.onmessage?.({ data })); };
        x.close = () => { x.readyState = 'closed'; x.onclose?.(); };
    }
    return [a, b];
}

function makeClient(name, { host = false } = {}) {
    const api = Object.create(ZaliInterface.prototype);
    api.logs = [];
    api.native = [];
    api.S = { servers: [{ id: 's1', name: 'Guild' }] };
    const others = ['alice', 'bob', 'eve'].filter((n) => n !== name);
    const pcs = new Map();
    for (const peer of others) {
        pcs.set(peer, {
            pc: {
                // Канал, созданный участником к запустившему, приходит тому в ondatachannel.
                createDataChannel: (label) => {
                    const [mine, theirs] = channelPair(label);
                    queueMicrotask(() => clients.get(peer)?.onVoiceDataChannel(name, theirs));
                    api.createdChannels = (api.createdChannels || 0) + 1;
                    return mine;
                },
            },
        });
    }
    api.voice = {
        roomId: 'voice:server:s1:c1', roomType: 'server', serverId: 's1', channelId: 'c1',
        screenSharing: false, screenNativeStream: 0, screenActivity: '',
        peerConnections: pcs,
    };
    api.myName = () => name;
    api.addLogEntry = (e) => api.logs.push(e.msg);
    api.voiceTrace = () => {};
    api.renderVoicePanel = () => {};
    api.syncSharedBrowserUi = () => {};
    api.openVoiceFocus = () => {};
    api.renegotiateVoicePeer = async () => {};
    api.nativeCaptureAvailable = (kind) => host && kind === 'browser';
    api.postNativeMessage = (msg) => { api.native.push(msg); return true; };
    api.nativeMediaRequest = async (op, fields) => {
        api.native.push({ op, ...fields, requested: true });
        if (op === 'browser_cookies') return { event: 'browser_cookies', stream: fields.stream, cookies: api.browserCookies || [] };
        return {};
    };
    api.apiFetch = async (path, init = {}) => {
        api.fetches = [...(api.fetches || []), { path, method: init.method || 'GET' }];
        if ((init.method || 'GET') === 'PUT') {
            serverProfile.puts.push({ path, body: JSON.parse(init.body) });
            return { ok: true, status: 200, json: async () => ({ revision: serverProfile.puts.length }) };
        }
        return { ok: true, status: 200, json: async () => ({ cookies: serverProfile.cookies, revision: 1 }) };
    };
    api.startScreenShare = async (choice) => {
        api.lastShare = choice;
        if (!choice?.browser) return;
        api.voice.screenSharing = true;
        api.voice.screenActivity = 'browser';
        api.voice.screenNativeStream = 9;
        // Как в настоящем startScreenShare: участникам уходит дорожка — и состояние браузера.
        for (const peer of api.voice.peerConnections.keys()) api.onSharedBrowserPeerAttached?.(peer);
    };
    api.stopScreenShare = () => {
        if (!api.voice.screenSharing) return;
        api.onSharedBrowserShareStopping('screen-stop');
        api.voice.screenSharing = false;
        api.voice.screenActivity = '';
        api.voice.screenNativeStream = 0;
    };
    // «Сервер»: voice_signal уходит адресату с from = отправитель.
    api.signals = [];
    api.sendVoiceEvent = (payload) => {
        api.signals.push({ to: payload.to, ...payload.signal });
        const target = clients.get(payload.to);
        if (target) queueMicrotask(() => target.handleSharedBrowserSignal(name, payload.signal));
        return true;
    };
    // Каналы 'zali-rc' здесь не участвуют — onVoiceDataChannel настоящий (из remote_control.js).
    clients.set(name, api);
    return api;
}

const alice = makeClient('alice', { host: true });
const bob = makeClient('bob');
const eve = makeClient('eve');
const browserInputs = () => alice.native.filter((m) => m.op === 'browser_input');
const browserNavs = () => alice.native.filter((m) => m.op === 'browser_nav');

console.log('\n== фильтр ввода ==');
{
    const s = (e) => alice.sanitizeSharedBrowserInput(e);
    record('Cmd/Ctrl+V (вставка буфера запустившего) отброшен', !s({ t: 'key', code: 'KeyV', key: 'v', d: 1, m: 8 }) && !s({ t: 'key', code: 'KeyV', key: 'v', d: 1, m: 2 }));
    record('Cmd/Ctrl+C и X отброшены', !s({ t: 'key', code: 'KeyC', key: 'c', d: 1, m: 8 }) && !s({ t: 'key', code: 'KeyX', key: 'x', d: 1, m: 2 }));
    record('Shift+Insert отброшен', !s({ t: 'key', code: 'Insert', key: 'Insert', d: 1, m: 1 }));
    record('Cmd+A и обычные буквы проходят', !!s({ t: 'key', code: 'KeyA', key: 'a', d: 1, m: 8 }) && s({ t: 'key', code: 'KeyS', key: 'ы', d: 1, m: 0 })?.key === 'ы');
    record('управляющие символы в key отброшены', !s({ t: 'key', code: 'KeyA', key: '\u0007', d: 1, m: 0 }));
    record('доли кадра зажаты в [0..1]', s({ t: 'down', x: 3, y: -1, b: 0 })?.x === 1 && s({ t: 'down', x: 3, y: -1, b: 0 })?.y === 0);
    record('неизвестный тип и кнопка 5 отброшены', !s({ t: 'exec', code: 'x' }) && !s({ t: 'down', x: 0.1, y: 0.1, b: 5 }));
    record('вставка текста ≤ 2000 символов', s({ t: 'text', s: 'x'.repeat(5000) })?.s.length === 2000);
    record('file: и javascript: не становятся адресом', alice.normalizeSharedBrowserUrl('file:///etc/passwd').startsWith('https://duckduckgo.com/?q=')
        && alice.normalizeSharedBrowserUrl('javascript:alert(1)').startsWith('https://duckduckgo.com/?q='));
    record('голое имя сайта → https', alice.normalizeSharedBrowserUrl('youtube.com/watch?v=1') === 'https://youtube.com/watch?v=1');
    record('запрос со словами → поиск', alice.normalizeSharedBrowserUrl('котики видео') === `https://duckduckgo.com/?q=${encodeURIComponent('котики видео')}`);
    record('nav go с file: отброшен целиком', s({ t: 'nav', a: 'go', url: 'file:///C:/' })?.url?.startsWith('https://duckduckgo.com/') === true);
    record('nav с неизвестным действием отброшен', !s({ t: 'nav', a: 'eval' }));
}

console.log('\n== запуск: только где оболочка умеет ==');
{
    record('у bob (нет nativeSharedBrowser) запуска нет', !bob.sharedBrowserLaunchAvailable() && bob.sharedBrowserButtonHtml() === '');
    record('у alice — есть', alice.sharedBrowserLaunchAvailable());
    alice.voice.screenSharing = true;
    const refused = await alice.launchSharedBrowser({ url: 'https://example.com/', profile: 'own' });
    record('при идущем показе экрана браузер не запускается', refused === false && alice.logs.some((l) => l.includes('остановите показ экрана')));
    alice.voice.screenSharing = false;
}

console.log('\n== запуск с профилем сообщества ==');
{
    const ok = await alice.launchSharedBrowser({ url: 'https://example.com/', profile: 'community' });
    await settle();
    record('браузер запущен', ok === true && !!alice.sbState().host);
    record('профиль взят с сервера сообщества', alice.fetches?.some((f) => f.path === '/api/servers/s1/browser-profile' && f.method === 'GET'));
    record('куки сообщества ушли в оболочку', alice.lastShare?.browser?.cookies?.[0]?.value === 'shared' && alice.lastShare.browser.profile === 'community');
    record('участникам ушло sb-state', ['bob', 'eve'].every((p) => alice.signals.some((s) => s.to === p && s.type === 'sb-state')));
    record('у bob и eve появился браузер alice', bob.sbState().remote.has('alice') && eve.sbState().remote.has('alice'));
    record('и они сразу открыли канал к alice', bob.createdChannels === 1 && eve.createdChannels === 1 && alice.sbState().channels.size === 2);
    record('bob видит уведомление', bob.logs.some((l) => l.includes('запустил общий браузер')));
}

console.log('\n== частота экрана и отправка в звонок ==');
{
    record('частоту выбирает оболочка (fps: 0 — по экрану запустившего)', alice.lastShare?.browser?.fps === 0);
    const sender = { params: { encodings: [{}] }, getParameters() { return JSON.parse(JSON.stringify(this.params)); }, async setParameters(p) { this.params = p; } };
    alice.voice.screenFps = 120;
    await alice.applyVoiceVideoBitrateLimit(sender, 'screen');
    record('отправка держит частоту экрана (maxFramerate 120)', sender.params.encodings[0].maxFramerate === 120);
    record('при нехватке канала падает разрешение, а не плавность', sender.params.degradationPreference === 'maintain-framerate');
    const browserBudget = sender.params.encodings[0].maxBitrate;
    alice.voice.screenActivity = '';
    record('бюджет больше, чем у демонстрации экрана', browserBudget > alice.voiceVideoBudget('screen'));
    const plain = { params: { encodings: [{}] }, getParameters() { return JSON.parse(JSON.stringify(this.params)); }, async setParameters(p) { this.params = p; } };
    await alice.applyVoiceVideoBitrateLimit(plain, 'screen');
    // Обычная демонстрация держит разрешение (а размер кадра ограничен
    // VOICE_SCREEN_MAX_SIDE) и без потолка частоты.
    record('обычная демонстрация экрана — как раньше', plain.params.degradationPreference === 'maintain-resolution' && !plain.params.encodings[0].maxFramerate);
    // Через TURN-ретранслятор всё медиа пира — одна сессия с потолком coturn
    // (VOICE_RELAY_MAX_BPS = max-bps конфигурации). Видео вместе обязано в него
    // уложиться, а при штатном потолке — получать полные прямые лимиты (не «на бумаге»).
    {
        const saved = { cam: alice.voice.cameraOn, scr: alice.voice.screenSharing };
        const ceiling = ZaliInterface.VOICE_RELAY_MAX_BPS;
        alice.voice.cameraOn = true;
        alice.voice.screenSharing = true;
        const relayed = { relayed: true };
        const both = alice.voiceVideoBudget('screen', relayed) + alice.voiceVideoBudget('camera', relayed);
        record('через ретранслятор экран + камера укладываются в потолок сессии', both <= ceiling * 0.9);
        record('при штатном потолке через ретранслятор — полные лимиты',
            alice.voiceVideoBudget('screen', relayed) === alice.voiceVideoBudget('screen', { relayed: false })
            && alice.voiceVideoBudget('camera', relayed) === alice.voiceVideoBudget('camera', { relayed: false }));
        alice.voice.cameraOn = saved.cam;
        alice.voice.screenSharing = saved.scr;
    }
    alice.voice.screenActivity = 'browser';
}

console.log('\n== ввод участников ==');
{
    bob.sendSharedBrowserInput('alice', { t: 'down', x: 0.3, y: 0.4, b: 0, n: 1 });
    await settle();
    const last = browserInputs().at(-1);
    record('клик bob по каналу → browser_input с потоком браузера', last?.stream === 9 && last.options.t === 'down' && last.options.x === 0.3);
    record('курсор bob у alice обновился', alice.sbState().host.cursors.get('bob')?.x === 0.3);
    bob.sendSharedBrowserInput('alice', { t: 'key', code: 'KeyV', key: 'v', d: 1, m: 8 });
    await settle();
    record('Cmd+V от bob до оболочки не дошёл', !browserInputs().some((m) => m.options.code === 'KeyV'));
    bob.sendSharedBrowserInput('alice', { t: 'text', s: 'привет' });
    await settle();
    record('вставка своего текста bob → {t:text}', browserInputs().at(-1)?.options.s === 'привет');
    bob.sendSharedBrowserInput('alice', { t: 'nav', a: 'go', url: 'https://youtube.com/' });
    await settle();
    record('навигация bob → browser_nav', browserNavs().at(-1)?.options.action === 'go' && browserNavs().at(-1).options.url === 'https://youtube.com/');
}

console.log('\n== без канала: через сервер только мышь ==');
{
    const n = browserInputs().length;
    alice.handleSharedBrowserSignal('eve', { type: 'sb-input', e: { t: 'key', code: 'KeyA', key: 'a', d: 1, m: 0 } });
    alice.handleSharedBrowserSignal('eve', { type: 'sb-input', e: { t: 'text', s: 'secret' } });
    record('клавиши и текст через сервер отброшены', browserInputs().length === n);
    alice.handleSharedBrowserSignal('eve', { type: 'sb-input', e: { t: 'down', x: 0.5, y: 0.5, b: 0 } });
    record('клик через сервер принят', browserInputs().length === n + 1);
    // Участник без открытого канала сам не шлёт клавиши через сервер.
    const entry = eve.sbState().remote.get('alice');
    entry.channel.readyState = 'connecting';
    const before = eve.signals.length;
    eve.sendSharedBrowserInput('alice', { t: 'key', code: 'KeyA', key: 'a', d: 1, m: 0 });
    record('eve без канала клавиши не отправила', eve.signals.length === before && eve.logs.some((l) => l.includes('Клавиатура заработает')));
    eve.sendSharedBrowserInput('alice', { t: 'up', x: 0.5, y: 0.5, b: 0 });
    record('а клик ушёл сигналом sb-input', eve.signals.at(-1)?.type === 'sb-input');
    entry.channel.readyState = 'open';
}

console.log('\n== «Управляю только я» ==');
{
    alice.setSharedBrowserAllowOthers(false);
    await settle();
    record('участникам ушло allowOthers=false', bob.sbState().remote.get('alice')?.allowOthers === false);
    const n = browserInputs().length;
    alice.applySharedBrowserInput('bob', { t: 'down', x: 0.9, y: 0.9, b: 0 }, 'channel');
    record('ввод bob отброшен', browserInputs().length === n);
    record('но курсор bob виден', alice.sbState().host.cursors.get('bob')?.x === 0.9);
    alice.sendSharedBrowserInput('', { t: 'down', x: 0.1, y: 0.1, b: 0 });
    record('свой ввод alice проходит', browserInputs().length === n + 1);
    alice.setSharedBrowserAllowOthers(true);
}

console.log('\n== курсоры ==');
{
    alice.applySharedBrowserInput('eve', { t: 'move', x: 0.2, y: 0.2 }, 'channel');
    alice.sendSharedBrowserInput('', { t: 'move', x: 0.6, y: 0.6 });
    alice.broadcastSharedBrowserCursors();
    await settle();
    const bobCursors = bob.sbState().remote.get('alice')?.cursors;
    record('bob получил курсоры eve и alice', bobCursors?.has('eve') && bobCursors?.has('alice'));
    record('своего курсора bob не получает', !bobCursors?.has('bob'));
    record('цвет курсора — строка цвета', /^hsl\(/.test(alice.sharedBrowserCursorColor('eve')));
    alice.applySharedBrowserInput('eve', { t: 'leave' }, 'channel');
    record('leave убирает курсор', !alice.sbState().host.cursors.has('eve'));
}

console.log('\n== состояние и сохранение профиля ==');
{
    alice.onNativeSharedBrowserState({ stream: 9, url: 'https://example.com/a', title: 'A', canBack: true, canForward: false, loading: false });
    await sleep(200);
    await settle();
    record('адрес дошёл до участников', bob.sbState().remote.get('alice')?.url === 'https://example.com/a' && bob.sbState().remote.get('alice')?.canBack === true);
    alice.onNativeSharedBrowserState({ stream: 3, url: 'https://evil.example/' });
    record('состояние чужого потока игнорируется', alice.sbState().host.url === 'https://example.com/a');
    alice.browserCookies = serverProfile.cookies;
    await alice.saveSharedBrowserProfile('autosave');
    record('куки не менялись — на сервер не пишем', serverProfile.puts.length === 0);
    alice.browserCookies = [{ name: 'sid', value: 'logged-in', domain: '.example.com', path: '/', expires: 1900000000 }];
    await alice.saveSharedBrowserProfile('loaded');
    record('изменились — PUT в профиль сообщества', serverProfile.puts.length === 1 && serverProfile.puts[0].path === '/api/servers/s1/browser-profile'
        && serverProfile.puts[0].body.cookies[0].value === 'logged-in');
}

console.log('\n== закрытие ==');
{
    alice.browserCookies = [{ name: 'sid', value: 'final', domain: '.example.com', path: '/', expires: 1900000000 }];
    await alice.closeSharedBrowser();
    await settle();
    record('перед закрытием профиль сохранён', serverProfile.puts.at(-1)?.body.cookies[0].value === 'final');
    record('трансляция остановлена, браузера нет', !alice.voice.screenSharing && !alice.sbState().host);
    record('участникам ушло sb-end', alice.signals.some((x) => x.type === 'sb-end') && !bob.sbState().remote.has('alice') && !eve.sbState().remote.has('alice'));
    record('каналы закрыты', alice.sbState().channels.size === 0);
    const n = browserInputs().length;
    alice.applySharedBrowserInput('bob', { t: 'down', x: 0.5, y: 0.5, b: 0 }, 'channel');
    record('ввод после закрытия игнорируется', browserInputs().length === n);
}

console.log('\n== закрытие посреди автосохранения ==');
{
    await alice.launchSharedBrowser({ url: 'https://example.com/', profile: 'community' });
    await settle();
    record('ревизия профиля запомнена при запуске', alice.sbState().host?.revision === 1);
    const realRequest = alice.nativeMediaRequest;
    let release;
    alice.browserCookies = [{ name: 'sid', value: 'during-autosave', domain: '.example.com', path: '/', expires: 1900000000 }];
    alice.nativeMediaRequest = async (op, fields) => {
        if (op === 'browser_cookies' && !release) await new Promise((r) => { release = r; });
        return realRequest(op, fields);
    };
    const autosave = alice.saveSharedBrowserProfile('autosave');
    await settle();
    const closing = alice.closeSharedBrowser();
    await settle();
    record('браузер не закрыт, пока идёт автосохранение', !!alice.sbState().host);
    alice.browserCookies = [{ name: 'sid', value: 'at-close', domain: '.example.com', path: '/', expires: 1900000000 }];
    release();
    await autosave;
    await closing;
    await settle();
    record('после автосохранения закрытие сохранило свежие куки', serverProfile.puts.at(-1)?.body.cookies[0].value === 'at-close');
    record('PUT несёт ревизию, от которой начали', typeof serverProfile.puts.at(-1)?.body.baseRevision === 'number');
    record('и только потом браузер закрыт', !alice.sbState().host && !alice.voice.screenSharing);
    alice.nativeMediaRequest = realRequest;
}

console.log('\n== звонок кончился, пока грузился профиль ==');
{
    const realFetch = alice.apiFetch;
    let respond;
    alice.apiFetch = (path, init) => new Promise((r) => { respond = () => r(realFetch(path, init)); });
    alice.lastShare = null;
    const launching = alice.launchSharedBrowser({ url: 'https://example.com/', profile: 'community' });
    await settle();
    const savedRoom = alice.voice.roomId;
    alice.voice.roomId = null;
    respond();
    const result = await launching;
    record('браузер не открыт вне звонка', result === false && !alice.lastShare && !alice.sbState().host);
    alice.voice.roomId = savedRoom;
    alice.apiFetch = realFetch;
}

console.log('\n== свой профиль и конец звонка ==');
{
    alice.fetches = [];
    await alice.launchSharedBrowser({ url: 'https://example.com/', profile: 'own' });
    await settle();
    record('свой профиль — без обращения к серверу', alice.fetches.length === 0 && alice.lastShare.browser.profile === 'own' && alice.lastShare.browser.cookies.length === 0);
    const putsBefore = serverProfile.puts.length;
    const saved = await alice.saveSharedBrowserProfile('autosave');
    record('свой профиль на сервер не сохраняется', saved === false && serverProfile.puts.length === putsBefore);
    alice.resetSharedBrowser('call-end');
    bob.resetSharedBrowser('call-end');
    // resetVoiceState гасит и саму трансляцию.
    Object.assign(alice.voice, { screenSharing: false, screenActivity: '', screenNativeStream: 0 });
    record('конец звонка гасит всё', !alice.sbState().host && alice.sbState().channels.size === 0 && bob.sbState().remote.size === 0);
}

console.log('\n== закрытое соединение с участником ==');
{
    await alice.launchSharedBrowser({ url: 'https://example.com/', profile: 'own' });
    await settle();
    alice.applySharedBrowserInput('bob', { t: 'move', x: 0.4, y: 0.4 }, 'channel');
    alice.onSharedBrowserPeerClosed('bob');
    record('курсор и канал bob убраны', !alice.sbState().host.cursors.has('bob') && !alice.sbState().channels.has('bob'));
    bob.onSharedBrowserPeerClosed('alice');
    record('у bob канал к alice сброшен (пересоздастся)', bob.sbState().remote.get('alice')?.channel === null);
    alice.resetSharedBrowser('call-end');
}

console.log(`\n${count - failures}/${count} checks passed`);
if (failures) {
    console.log(`FAIL: ${failures} check(s) failed`);
    process.exit(1);
}
console.log('OK');
