// Игровой статус («Играет в …») на стороне веба: web/src/interface/game_activity.js.
//
// Настоящий ZaliInterface (тот же load_interface.mjs, что у voice_doctor и
// notify_doctor). Подменены только границы: нативный мост (записывает каждый
// исходящий кадр), DOM и localStorage. Что проверяется — контракт с оболочкой и
// сервером и приватность: без явного согласия наружу не уходит ничего.
import { loadZaliInterface } from '../voice_doctor/lib/load_interface.mjs';

let failures = 0;
const pass = (n, d = '') => console.log(`  [PASS] ${n}${d ? ` — ${d}` : ''}`);
const fail = (n, d = '') => { failures += 1; console.log(`  [FAIL] ${n}${d ? ` — ${d}` : ''}`); };
const check = (n, ok, failDetail = '', passDetail = '') => (ok ? pass(n, passDetail) : fail(n, failDetail));

function makeClient({ supports = { voice: true, gameActivity: true }, username = 'me' } = {}) {
    const { ZaliInterface, sandbox } = loadZaliInterface();
    const store = new Map();
    sandbox.localStorage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => { store.set(k, String(v)); },
        removeItem: (k) => { store.delete(k); },
    };
    sandbox.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
    const posted = [];
    const api = Object.create(ZaliInterface.prototype);
    api.S = {
        session: { username, token: 't' },
        contacts: ['alice', 'bob'], navMode: 'dm', current: null,
        chats: {}, unread: {}, wsOn: true, serverModal: {},
    };
    api.voice = { status: 'idle', socket: null };
    api.nativeBridge = () => ({
        available: true,
        supports,
        postMessage: (payload) => { posted.push(payload); return true; },
    });
    const noop = () => {};
    Object.assign(api, {
        trace: noop, addLogEntry: noop, renderContacts: noop,
        updateChatHeaderCryptoKey: noop, renderProfileOverlay: noop,
        renderServerModalMembers: noop, ensureProfileState: () => ({ open: false }),
    });
    const frames = () => posted
        .filter(p => p.type === 'VOICE_EVENT' && p.payload?.type === 'client_activity')
        .map(p => p.payload);
    const detectorConfigs = () => posted.filter(p => p.type === 'GAME_DETECTOR_CONFIG');
    return { api, posted, frames, detectorConfigs, store };
}

const detect = (api, name, id = '') =>
    api.handleGameActivityRealtime({ type: 'native_game_activity', activity: name ? { name, id, source: 'process' } : undefined });

// ── приватность ────────────────────────────────────────────────────────────
console.log('\n──────── по умолчанию ничего не уходит');
{
    const { api, frames, detectorConfigs } = makeClient();
    check('статус выключен по умолчанию', api.gameActivityPrefs().enabled === false);
    detect(api, 'Dota 2');
    api.onGameActivityConnected();
    check('найденная игра без согласия не отправляется', frames().length === 0, `кадров: ${frames().length}`);
    check('и оболочка не просит опрашивать процессы', detectorConfigs().length === 0 || detectorConfigs().every(c => c.enabled === false));
    check('effectiveGameActivity пуст', api.effectiveGameActivity() === null);
}

console.log('\n──────── включено — уходит название и источник');
{
    const { api, frames, detectorConfigs } = makeClient();
    api.saveGameActivityPrefs({ enabled: true });
    const on = detectorConfigs().find(c => c.enabled === true);
    check('оболочке уходит GAME_DETECTOR_CONFIG с каталогом', !!on && on.games.length > 50, JSON.stringify(detectorConfigs().map(c => [c.enabled, c.games.length])));
    check('каталог в плоском виде {process, name}', on?.games.every(g => g.process && g.name) === true);
    check('процессы в нижнем регистре, без .exe', on?.games.every(g => g.process === g.process.toLowerCase() && !g.process.endsWith('.exe')) === true);
    const flat = on?.games || [];
    check('Deadlock распознаётся по deadlock.exe (и по старому project8)',
        ['deadlock', 'project8'].every(p => flat.some(g => g.process === p && g.name === 'Deadlock')));
    const osuStable = flat.find(g => g.name === 'osu!' && g.process === 'osu!');
    const osuLazerExe = flat.find(g => g.name === 'osu!lazer' && g.process === 'osu!');
    check('osu! stable и osu!lazer делят процесс и различаются путём установки',
        !!osuStable?.path && !!osuLazerExe?.path && osuStable.path !== osuLazerExe.path,
        JSON.stringify([osuStable, osuLazerExe]));
    check('lazer на macOS находится по bundle id без ограничения по пути',
        flat.some(g => g.process === 'sh.ppy.osu.lazer' && g.name === 'osu!lazer' && !('path' in g)));
    check('записи без ограничения не несут поля path',
        flat.filter(g => g.name === 'Dota 2').every(g => !('path' in g)));
    detect(api, 'Dota 2', 'proc:dota2');
    const sent = frames();
    check('кадр client_activity ушёл через VOICE_EVENT', sent.length === 1, `кадров: ${sent.length}`);
    check('в кадре kind/name/source/since', sent[0]?.activity?.kind === 'game'
        && sent[0].activity.name === 'Dota 2' && sent[0].activity.source === 'process' && sent[0].activity.since > 0,
        JSON.stringify(sent[0]));
    detect(api, 'Dota 2', 'proc:dota2');
    check('повтор той же игры не шлёт второй кадр', frames().length === 1, `кадров: ${frames().length}`);
    detect(api, null);
    const last = frames().at(-1);
    check('игра закрыта — уходит activity: null', last?.activity === null, JSON.stringify(last));
}

console.log('\n──────── «это не игра» и ручной статус');
{
    const { api, frames } = makeClient();
    api.saveGameActivityPrefs({ enabled: true, ignored: ['Chrome Remote'] });
    detect(api, 'Chrome Remote');
    check('игра из списка исключений не отправляется', frames().length === 0);
    api.saveGameActivityPrefs({ manual: 'Свой пасьянс' });
    const manual = frames().at(-1)?.activity;
    check('ручная игра отправляется как manual', manual?.name === 'Свой пасьянс' && manual.source === 'manual', JSON.stringify(manual));
    detect(api, 'Dota 2');
    check('ручной статус сильнее автоопределения', api.effectiveGameActivity().name === 'Свой пасьянс');
    api.saveGameActivityPrefs({ enabled: false });
    check('выключатель гасит и ручной статус', api.effectiveGameActivity() === null && frames().at(-1)?.activity === null);
}

console.log('\n──────── без поддержки оболочки');
{
    const { api, detectorConfigs } = makeClient({ supports: { voice: true } });
    api.saveGameActivityPrefs({ enabled: true });
    check('GAME_DETECTOR_CONFIG не шлётся, если оболочка не умеет', detectorConfigs().length === 0);
    check('но ручной статус работает', (api.saveGameActivityPrefs({ manual: 'Chess' }), api.effectiveGameActivity()?.name === 'Chess'));
}

// ── чужие статусы ──────────────────────────────────────────────────────────
console.log('\n──────── чужие статусы');
{
    const { api } = makeClient();
    api.handleGameActivityRealtime({ type: 'activity_snapshot', activities: {
        alice: { name: 'Factorio', since: 1 },
        me: { name: 'Своё', since: 1 },
        evil: { name: '   ' },
    } });
    check('снимок наполняет карту', api.gameActivityFor('alice')?.name === 'Factorio');
    check('пустое название отбрасывается', api.gameActivityFor('evil') === null);
    check('свой статус из снимка игнорируется', api.gameActivityFor('me') === null);
    api.handleGameActivityRealtime({ type: 'user_activity', username: 'bob', activity: { name: 'Hades' } });
    check('user_activity добавляет', api.gameActivityFor('bob')?.name === 'Hades');
    api.handleGameActivityRealtime({ type: 'user_activity', username: 'bob', activity: null });
    check('activity: null убирает', api.gameActivityFor('bob') === null);
    api.handleGameActivityRealtime({ type: 'activity_snapshot', activities: {} });
    check('новый снимок заменяет прежний целиком', api.gameActivityFor('alice') === null);
}

console.log('\n──────── чужое название — недоверенный ввод');
{
    const { api } = makeClient();
    api.handleGameActivityRealtime({ type: 'user_activity', username: 'alice', activity: { name: '<img src=x onerror=alert(1)>'.repeat(10) } });
    const html = api.gameActivityLineHTML('alice');
    check('разметка экранируется', !html.includes('<img') && html.includes('&lt;img'), html.slice(0, 120));
    check('длина названия ограничена', api.gameActivityFor('alice').name.length <= 64);
}

console.log('\n──────── смена аккаунта');
{
    const { api, frames } = makeClient();
    api.saveGameActivityPrefs({ enabled: true });
    detect(api, 'Dota 2');
    api.handleGameActivityRealtime({ type: 'user_activity', username: 'alice', activity: { name: 'Factorio' } });
    const before = frames().length;
    api.S.session = { username: 'other', token: 't2' };
    api.publishGameActivity();
    check('карта чужих статусов сброшена', api.gameActivityFor('alice') === null);
    check('новому аккаунту уходит статус заново', frames().length === before + 1, `было ${before}, стало ${frames().length}`);
    api.S.session = { username: '', token: null };
    api.publishGameActivity();
    check('на выходе (нет токена) ничего не шлётся', frames().length === before + 1);
}

console.log('');
console.log(failures === 0 ? '  итог: все проверки пройдены' : `  итог: нарушено ${failures}`);
process.exit(failures === 0 ? 0 : 1);
