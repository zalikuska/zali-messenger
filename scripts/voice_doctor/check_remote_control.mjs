// Удалённое управление (web/src/interface/remote_control.js) на настоящем коде клиента.
//
// Модель: управление не просят — его отдаёт сам показывающий («Отдать управление» на
// своей демонстрации) на время этой демонстрации. alice показывает экран (нативная
// демонстрация всего экрана, оболочка с nativeRemoteControl), bob и eve смотрят. Сервер —
// прямой обмен voice_signal с проставленным `from`, оболочка alice — заглушка MEDIA_REQUEST,
// которая отвечает на rc_grant так, как ответил бы пользователь в нативном диалоге.
// Проверяется то, на чём держится безопасность: без подтверждения оболочки управления
// нет, ввод принимается только от того, кому отдали, клавиши не ходят через сервер, и
// всё снимается с концом демонстрации, звонка или выключением компонента.
import { loadZaliInterface } from './lib/load_interface.mjs';

let failures = 0;
let count = 0;
function record(name, ok, detail = '') {
    count += 1;
    if (!ok) failures += 1;
    process.stdout.write(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}\n`);
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 6; i += 1) await tick(); };

const { ZaliInterface, sandbox } = loadZaliInterface({ NativeMessageTypes: { MEDIA_REQUEST: 'MEDIA_REQUEST' } });

// Настоящее хранилище: компонент выключен, пока ключа нет.
{
    const probe = Object.create(ZaliInterface.prototype);
    sandbox.localStorage.removeItem(ZaliInterface.RC_COMPONENT_KEY);
    const off = !probe.remoteControlComponentEnabled();
    sandbox.localStorage.setItem(ZaliInterface.RC_COMPONENT_KEY, '1');
    const on = probe.remoteControlComponentEnabled();
    sandbox.localStorage.removeItem(ZaliInterface.RC_COMPONENT_KEY);
    console.log('\n== компонент в хранилище ==');
    record('без ключа выключен, с ключом включён', off && on);
}

const clients = new Map();
function makeClient(name, { host = false } = {}) {
    const api = Object.create(ZaliInterface.prototype);
    api.me = name;
    api.logs = [];
    api.native = [];          // MEDIA_REQUEST, ушедшие в оболочку
    api.grantAnswer = 'allow';
    // Хранилище у клиентов харнесса общее — флаг компонента у каждого свой.
    api.componentOn = false;
    api.remoteControlComponentEnabled = () => api.componentOn;
    const others = ['alice', 'bob', 'eve'].filter((n) => n !== name);
    api.voice = {
        roomId: 'voice:server:s1:c1', roomType: 'server', serverId: 's1', channelId: 'c1',
        screenSharing: host, screenNativeStream: host ? 7 : 0, screenIsDisplay: host,
        peerConnections: new Map(others.map((n) => [n, { pc: {} }])),
        // Зритель видит экран alice: без этого onRemoteControlGranted отвечает 'no-screen'
        // (проверка аудита 2026-11-18) и право не принимается.
        remoteScreens: new Map(host ? [] : [['alice', {}]]),
    };
    api.addLogEntry = (e) => api.logs.push(e.msg);
    api.voiceTrace = () => {};
    api.playVoiceEventSound = () => {};
    api.nativeSupports = (cap) => host && cap === 'nativeRemoteControl';
    api.postNativeMessage = (msg) => { api.native.push(msg); return true; };
    api.nativeMediaRequest = async (op, fields) => {
        api.native.push({ op, ...fields, requested: true });
        if (op !== 'rc_grant') return {};
        if (api.grantAnswer === 'allow') return { event: 'rc_granted', stream: fields.stream };
        throw Object.assign(new Error('отмена'), { code: api.grantAnswer });
    };
    // «Сервер»: voice_signal уходит адресату с from = отправитель.
    api.sendVoiceEvent = (payload) => {
        const target = clients.get(payload.to);
        if (target) queueMicrotask(() => target.handleRemoteControlSignal(name, payload.signal));
        return true;
    };
    clients.set(name, api);
    return api;
}

const alice = makeClient('alice', { host: true });
const bob = makeClient('bob');
const eve = makeClient('eve');
const inputs = () => alice.native.filter((m) => m.op === 'rc_input');
const grants = () => alice.native.filter((m) => m.op === 'rc_grant');
const revokes = () => alice.native.filter((m) => m.op === 'rc_revoke');

console.log('\n== компонент выключен ==');
{
    record('без компонента отдать управление нельзя', !alice.remoteControlHostAvailable());
    await alice.grantRemoteControl('bob');
    await settle();
    record('и нативный диалог не открывается', grants().length === 0 && !alice.rcState().host);
    alice.componentOn = true;
}

console.log('\n== отдать можно только при нативном показе всего экрана ==');
{
    record('alice (нативный показ экрана, компонент включён) может отдать', alice.remoteControlHostAvailable());
    alice.voice.screenIsDisplay = false;
    record('показ окна, а не экрана — нет', !alice.remoteControlHostAvailable());
    alice.voice.screenIsDisplay = true;
    record('кандидаты — участники звонка', alice.remoteControlCandidates().join(',') === 'bob,eve');
}

console.log('\n== управление не просят ==');
{
    alice.handleRemoteControlSignal('bob', { type: 'rc-request' });
    await settle();
    record('rc-request ничего не открывает', grants().length === 0 && !alice.rcState().host);
    alice.handleRemoteControlSignal('bob', { type: 'rc-input', e: { t: 'down', x: 0.5, y: 0.5, b: 0 } });
    record('ввод без выдачи игнорируется', inputs().length === 0);
}

console.log('\n== отмена в нативном диалоге ==');
{
    alice.grantAnswer = 'denied';
    await alice.grantRemoteControl('bob');
    await settle();
    record('оболочку спросили (rc_grant со своим потоком и именем)', grants().some((m) => m.stream === 7 && m.options.peer === 'bob'));
    record('управление не отдано', !alice.rcState().host && !bob.rcState().view);
    alice.grantAnswer = 'allow';
}

console.log('\n== у получателя выключен компонент ==');
{
    await alice.grantRemoteControl('bob');
    await settle();
    record('право сразу вернулось', !alice.rcState().host && !bob.rcState().view);
    record('показывающий знает почему', alice.logs.some((l) => l.includes('выключен компонент')));
    record('и оболочка разрешение сняла', revokes().length >= 1);
    bob.componentOn = true;
    eve.componentOn = true;
}

console.log('\n== отдать bob ==');
{
    await alice.grantRemoteControl('bob');
    await settle();
    record('у показывающего управляет bob', alice.rcState().host?.peer === 'bob');
    record('bob получил право без своего запроса', !!bob.rcState().view && bob.logs.some((l) => l.includes('отдал вам управление')));
    alice.handleRemoteControlSignal('bob', { type: 'rc-input', e: { t: 'down', x: 0.25, y: 0.75, b: 0 } });
    const last = inputs().at(-1);
    record('ввод bob уходит в оболочку с потоком экрана', last && last.stream === 7 && last.options.t === 'down' && last.options.x === 0.25);
    const n = inputs().length;
    alice.handleRemoteControlSignal('eve', { type: 'rc-input', e: { t: 'move', x: 0.1, y: 0.1 } });
    record('ввод eve (ей не отдавали) отброшен', inputs().length === n);
    alice.onVoiceDataChannel('eve', { label: 'zali-rc', close() {} });
    alice.rcState().channels.get('eve').onmessage({ data: JSON.stringify({ t: 'key', code: 'KeyA', d: 1 }) });
    record('и через канал данных — тоже', inputs().length === n);
    alice.handleRemoteControlSignal('bob', { type: 'rc-input', e: { t: 'key', code: 'Key A";rm', d: 1 } });
    alice.handleRemoteControlSignal('bob', { type: 'rc-input', e: { t: 'exec', cmd: 'x' } });
    alice.handleRemoteControlSignal('bob', { type: 'rc-input', e: { t: 'move', x: 'NaN', y: 1 } });
    record('мусорные события отброшены', inputs().length === n);
    alice.handleRemoteControlSignal('bob', { type: 'rc-input', e: { t: 'move', x: 9, y: -3 } });
    const clamped = inputs().at(-1)?.options;
    record('координаты прижаты к кадру', clamped && clamped.x === 1 && clamped.y === 0);
    const k = inputs().length;
    alice.handleRemoteControlSignal('bob', { type: 'rc-input', e: { t: 'key', code: 'KeyP', d: 1 } });
    record('клавиши через сервер не принимаются даже от bob', inputs().length === k);
    alice.onVoiceDataChannel('bob', { label: 'zali-rc', close() {} });
    alice.rcState().channels.get('bob').onmessage({ data: JSON.stringify({ t: 'key', code: 'KeyP', d: 1 }) });
    record('а по каналу данных — проходят', inputs().at(-1)?.options?.code === 'KeyP');
    const relayed = [];
    const realSend = bob.sendVoiceEvent;
    bob.sendVoiceEvent = (payload) => { relayed.push(payload.signal); return true; };
    bob.sendRemoteControlInput({ t: 'key', code: 'KeyP', d: 1 });
    bob.sendRemoteControlInput({ t: 'down', x: 0.5, y: 0.5, b: 0 });
    bob.sendVoiceEvent = realSend;
    record('зритель без канала данных не шлёт клавиши через сервер',
        relayed.length === 1 && relayed[0].e.t === 'down' && bob.logs.some((l) => l.includes('Клавиатура заработает')));
}

console.log('\n== отдать другому — у прежнего забирается ==');
{
    await alice.grantRemoteControl('eve');
    await settle();
    record('теперь управляет eve', alice.rcState().host?.peer === 'eve' && !!eve.rcState().view);
    record('у bob право забрано', !bob.rcState().view && bob.logs.some((l) => l.includes('забрал управление')));
    const n = inputs().length;
    alice.handleRemoteControlSignal('bob', { type: 'rc-input', e: { t: 'move', x: 0.3, y: 0.3 } });
    record('ввод bob больше не проходит', inputs().length === n);
}

console.log('\n== зритель возвращает управление сам ==');
{
    eve.stopRemoteControlView();
    await settle();
    record('у показывающего снято', !alice.rcState().host);
    record('показывающему сказано, что вернули', alice.logs.some((l) => l.includes('вернул управление')));
}

console.log('\n== «Забрать управление» / «Остановить» ==');
{
    await alice.grantRemoteControl('bob');
    await settle();
    const before = revokes().length;
    alice.revokeRemoteControlHost('stopped');
    await settle();
    record('разрешение снято в оболочке', revokes().length === before + 1);
    record('bob отключён', !bob.rcState().view);
    const n = inputs().length;
    alice.handleRemoteControlSignal('bob', { type: 'rc-input', e: { t: 'move', x: 0.1, y: 0.1 } });
    record('после этого ввод не проходит', inputs().length === n);
}

console.log('\n== конец демонстрации снимает управление ==');
{
    await alice.grantRemoteControl('bob');
    await settle();
    record('снова отдано', alice.rcState().host?.peer === 'bob');
    // stopScreenShare первым делом зовёт revokeRemoteControlHost('screen-stop').
    alice.revokeRemoteControlHost('screen-stop');
    alice.voice.screenSharing = false;
    await settle();
    record('у показывающего пусто, у зрителя пусто', !alice.rcState().host && !bob.rcState().view);
    record('без демонстрации отдать нельзя', !alice.remoteControlHostAvailable());
    alice.voice.screenSharing = true;
}

console.log('\n== оболочка сама сняла разрешение (поток кончился) ==');
{
    await alice.grantRemoteControl('bob');
    await settle();
    record('отдано перед концом потока', alice.rcState().host?.peer === 'bob');
    alice.onNativeRemoteControlRevoked({ event: 'rc_revoked', stream: 7, reason: 'stream-ended' });
    await settle();
    record('страница показывающего это отражает, зритель отключён', !alice.rcState().host && !bob.rcState().view);
}

console.log('\n== конец звонка ==');
{
    await alice.grantRemoteControl('bob');
    await settle();
    const before = revokes().length;
    alice.resetRemoteControl('call-end');
    record('выход из звонка снимает разрешение в оболочке', !alice.rcState().host && revokes().length === before + 1);
    bob.resetRemoteControl('call-end');
}

console.log('\n== выключение компонента посреди сеанса ==');
{
    await alice.grantRemoteControl('bob');
    await settle();
    const before = revokes().length;
    alice.setRemoteControlComponentEnabled(false);
    alice.componentOn = false;
    await settle();
    record('у показывающего снято и в оболочке', !alice.rcState().host && revokes().length === before + 1);
    record('зритель отключён', !bob.rcState().view);
    alice.rcState().host = { peer: 'bob', stream: 7, since: Date.now() };
    const n = inputs().length;
    alice.handleRemoteControlSignal('bob', { type: 'rc-input', e: { t: 'move', x: 0.2, y: 0.2 } });
    record('с выключенным компонентом ввод не проходит даже при оставшемся состоянии', inputs().length === n);
    alice.rcState().host = null;
}

console.log(`\n${failures ? 'FAIL' : 'OK'} (${count} checks)\n`);
process.exit(failures ? 1 : 0);
