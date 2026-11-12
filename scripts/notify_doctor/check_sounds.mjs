// Звуки приложения: сами буферы (web/src/modules/sound_synth.js) и то, как боевой
// ZaliInterface выбирает и проигрывает их (web/src/interface/sounds.js).
//
// Слушать тест не умеет, зато проверяет всё, что ломается молча:
//  - рендер каждого звука на 48 и 44,1 кГц: без NaN, без клиппинга, не тишина;
//  - рингтон зациклен без шва — стык конца с началом не резче соседних сэмплов;
//  - звуки выведены на один уровень громкости (иначе один шепчет, другой орёт);
//  - выбор: по умолчанию новые звуки, «Классика» остаётся вариантом, мусор в
//    настройках и сбой рендера не оставляют приложение без звука.
import fs from 'node:fs';
import { loadZaliInterface } from '../voice_doctor/lib/load_interface.mjs';

let failures = 0;
let checks = 0;
const pass = (n, d = '') => { checks += 1; console.log(`  [PASS] ${n}${d ? ` — ${d}` : ''}`); };
const fail = (n, d = '') => { checks += 1; failures += 1; console.log(`  [FAIL] ${n}${d ? ` — ${d}` : ''}`); };
const check = (n, ok, failDetail = '', passDetail = '') => (ok ? pass(n, passDetail) : fail(n, failDetail));

// Модуль исполняется в основном реалме (не в vm): в песочнице каждый Math.* идёт
// через перехватчик глобального объекта, и рендер занимает секунды вместо миллисекунд.
const source = fs.readFileSync(new URL('../../web/src/modules/sound_synth.js', import.meta.url), 'utf8');
(0, eval)(source);
const synth = globalThis.ZaliSoundSynth;

// ── 1. Буферы ────────────────────────────────────────────────────────────────

function measure(r) {
    const n = r.left.length;
    let peak = 0, bad = 0, power = 0;
    const steps = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const l = r.left[i], rr = r.right[i];
        if (!Number.isFinite(l) || !Number.isFinite(rr)) bad += 1;
        peak = Math.max(peak, Math.abs(l), Math.abs(rr));
        power += (l * l + rr * rr) / 2;
        if (i) steps[i] = Math.max(Math.abs(l - r.left[i - 1]), Math.abs(rr - r.right[i - 1]));
    }
    const seam = Math.max(Math.abs(r.left[0] - r.left[n - 1]), Math.abs(r.right[0] - r.right[n - 1]));
    // Самый резкий «обычный» шаг в четверти секунды по обе стороны от стыка.
    const near = Math.min(n - 1, Math.round(r.sampleRate / 4));
    let neighbour = 0;
    for (let i = 1; i <= near; i++) neighbour = Math.max(neighbour, steps[i], steps[n - i]);
    // Громкость самого громкого окна в 100 мс: средний уровень тут не годится —
    // у рингтона-звонка две трети цикла занимает пауза.
    const win = Math.round(r.sampleRate / 10);
    let loudest = 0;
    for (let from = 0; from + win <= n; from += win >> 1) {
        let sum = 0;
        for (let i = from; i < from + win; i++) sum += (r.left[i] * r.left[i] + r.right[i] * r.right[i]) / 2;
        loudest = Math.max(loudest, sum / win);
    }
    return {
        n, peak, bad, seam, neighbour,
        rmsDb: 10 * Math.log10(power / n + 1e-20),
        loudDb: 10 * Math.log10(loudest + 1e-20),
    };
}

const levels = [];
for (const kind of ['message', 'ring', 'voice']) {
    const sounds = synth.list(kind);
    const expected = 4;
    check(`${kind}: в наборе несколько звуков`, sounds.length >= expected, `всего ${sounds.length}`, sounds.map(s => s.id).join(', '));
    check(`${kind}: у каждого звука есть название и подпись`,
        sounds.every(s => s.id && s.name && s.hint && s.id !== 'classic'));
    for (const sound of sounds) {
        for (const sr of [48000, 44100]) {
            const r = synth.render(kind, sound.id, sr);
            const m = measure(r);
            const label = `${kind}/${sound.id} @${sr}`;
            const problems = [];
            if (m.bad) problems.push(`${m.bad} нечисловых сэмплов`);
            if (m.peak > 0.9) problems.push(`пик ${m.peak.toFixed(3)} > 0.9`);
            if (m.peak < (kind === 'voice' ? 0.15 : 0.25)) problems.push(`пик ${m.peak.toFixed(3)} — слишком тихо`);
            if (r.sampleRate !== sr) problems.push(`частота ${r.sampleRate}`);
            if (kind !== 'ring') {
                if (r.loop) problems.push('звук помечен как цикл');
                const limit = kind === 'voice' ? 1.6 : 3.5;
                if (r.duration > limit) problems.push(`длится ${r.duration.toFixed(2)} с`);
                if (Math.abs(r.left[m.n - 1]) > 0.002) problems.push('обрывается не в тишину');
            } else {
                if (!r.loop) problems.push('рингтон не помечен как цикл');
                if (r.duration < 2 || r.duration > 9) problems.push(`цикл ${r.duration.toFixed(2)} с`);
                if (m.seam > Math.max(0.02, m.neighbour * 1.5)) {
                    problems.push(`шов цикла ${m.seam.toFixed(4)} резче соседних шагов (${m.neighbour.toFixed(4)})`);
                }
            }
            check(label, problems.length === 0, problems.join('; '),
                `${r.duration.toFixed(2)} с, пик ${m.peak.toFixed(2)}, ${m.rmsDb.toFixed(1)} дБ`);
            if (sr === 48000) levels.push({ kind, id: sound.id, loudDb: m.loudDb });
        }
    }
    check(`${kind}: неизвестный звук — null, а не исключение`, synth.render(kind, 'нет-такого', 48000) === null);
}

// Вход и конец: без щелчка и обрыва, но и без затянутого начала. Для разовых звуков
// (сообщение, голосовой канал): первый сэмпл — тишина, звук слышен в первые 20 мс,
// первая миллисекунда после начала не выше 30% пика (иначе это щелчок), последний
// сэмпл — снова тишина. У рингтонов начало и конец — шов цикла, его проверяет шов,
// а вход при запуске сглаживает playSoundBuffer.
for (const kind of ['message', 'voice']) {
    for (const { id } of synth.list(kind)) {
        const r = synth.render(kind, id, 48000);
        const n = r.left.length;
        const at = (i) => Math.max(Math.abs(r.left[i]), Math.abs(r.right[i]));
        let peak = 0;
        for (let i = 0; i < n; i++) peak = Math.max(peak, at(i));
        let onset = 0;
        while (onset < n && at(onset) < peak * 0.003) onset += 1;
        let firstMs = 0;
        for (let i = onset; i < Math.min(n, onset + 48); i++) firstMs = Math.max(firstMs, at(i));
        const problems = [];
        if (at(0) > 1e-4) problems.push(`первый сэмпл ${at(0).toFixed(4)}`);
        if (onset / 48 > 20) problems.push(`слышен только через ${(onset / 48).toFixed(0)} мс`);
        if (firstMs > peak * 0.3) problems.push(`первая миллисекунда ${(firstMs / peak * 100).toFixed(0)}% пика — щелчок`);
        if (at(n - 1) > 1e-3) problems.push(`обрывается на ${at(n - 1).toFixed(4)}`);
        check(`${kind}/${id}: мягкое, но быстрое начало и конец без обрыва`, problems.length === 0, problems.join('; '),
            `слышен через ${(onset / 48).toFixed(1)} мс, первая мс — ${(firstMs / peak * 100).toFixed(0)}% пика`);
    }
}

// Все звуки выведены на один уровень: сравнивается самое громкое окно каждого.
{
    const loud = levels.filter(l => l.kind !== 'voice').map(l => l.loudDb);
    const spread = Math.max(...loud) - Math.min(...loud);
    check('звуки и рингтоны выведены на один уровень', spread <= 6, `разброс ${spread.toFixed(1)} дБ`, `разброс ${spread.toFixed(1)} дБ`);
    // Звуки канала звучат поверх разговора — заметно тише сигнала сообщения, но не шёпотом.
    const avg = (list) => list.reduce((a, b) => a + b, 0) / list.length;
    const message = avg(levels.filter(l => l.kind === 'message').map(l => l.loudDb));
    for (const l of levels.filter(l => l.kind === 'voice')) {
        const below = message - l.loudDb;
        check(`voice/${l.id} тише звука сообщения на 2–9 дБ`, below >= 2 && below <= 9, `на ${below.toFixed(1)} дБ`, `на ${below.toFixed(1)} дБ`);
    }
}

// Рингтон по умолчанию — остинато: одна короткая ячейка, повторённая без развития
// (мелодии-«композиции» пользователь отвергал). Первый и второй такты цикла обязаны
// почти совпадать — иначе это снова мелодия.
{
    const r = synth.render('ring', 'gruv', 48000);
    const bar = Math.round(r.left.length / 4);
    let dot = 0, a2 = 0, b2 = 0;
    for (let i = 0; i < bar; i++) {
        const a = r.left[i], b = r.left[i + bar];
        dot += a * b; a2 += a * a; b2 += b * b;
    }
    const similarity = dot / Math.sqrt(a2 * b2 + 1e-20);
    check('рингтон по умолчанию — повторяющаяся ячейка, а не мелодия', similarity >= 0.8,
        `сходство тактов ${similarity.toFixed(2)}`, `сходство тактов 1 и 2: ${similarity.toFixed(2)}`);
}

// Детерминизм: один и тот же звук — одни и те же сэмплы (кеш и синхронизация между
// устройствами на это опираются; случайность в рендере означала бы «плавающий» звук).
{
    const a = synth.render('message', 'struna', 48000);
    const b = synth.render('message', 'struna', 48000);
    let same = a.left.length === b.left.length;
    for (let i = 0; same && i < a.left.length; i++) same = a.left[i] === b.left[i] && a.right[i] === b.right[i];
    check('рендер детерминирован', same);
}

// ── 2. Выбор и проигрывание в ZaliInterface ──────────────────────────────────

function fakeParam() {
    return {
        value: 1,
        setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {},
        setTargetAtTime() {}, cancelScheduledValues() {},
    };
}

function makeClient({ withSynth = true, prefs = {}, synthModule = synth, contextState = 'running' } = {}) {
    const { ZaliInterface, sandbox } = loadZaliInterface();
    const log = { sources: [], oscillators: 0, stopped: 0 };
    class FakeAudioContext {
        constructor() { this.sampleRate = 48000; this.currentTime = 0; this.state = contextState; this.destination = {}; }
        resume() { return Promise.resolve(); }
        createGain() { return { gain: fakeParam(), connect() {}, disconnect() {} }; }
        createDynamicsCompressor() {
            return { threshold: fakeParam(), knee: fakeParam(), ratio: fakeParam(), attack: fakeParam(), release: fakeParam(), connect() {} };
        }
        createWaveShaper() { return { curve: null, connect() {} }; }
        createBiquadFilter() { return { type: '', Q: fakeParam(), frequency: fakeParam(), connect() {} }; }
        createOscillator() {
            log.oscillators += 1;
            return { type: '', frequency: fakeParam(), connect() {}, start() {}, stop() {} };
        }
        createBuffer(channels, length, sampleRate) {
            const data = Array.from({ length: channels }, () => new Float32Array(length));
            return { length, sampleRate, duration: length / sampleRate, numberOfChannels: channels, getChannelData: (c) => data[c] };
        }
        createBufferSource() {
            const src = { buffer: null, loop: false, started: false, connect() {}, disconnect() {}, start() { src.started = true; }, stop(when) { log.stopped += 1; log.stopWhen = when; } };
            log.sources.push(src);
            return src;
        }
    }
    sandbox.window.AudioContext = FakeAudioContext;
    if (withSynth) sandbox.window.ZaliSoundSynth = synthModule;
    const api = Object.create(ZaliInterface.prototype);
    api.sound = { ctx: null, bus: null, ringing: false, ringTimer: null };
    api.audioPrefs = { notificationVolumePercent: 100, messageSound: '', ringtone: '', ...prefs };
    api.saveAudioPrefs = () => {};
    api.trace = () => {};
    api.myName = () => 'me';
    api.voice = { roomId: '', roomType: '', participants: [] };
    return { api, log };
}

{
    const { api } = makeClient();
    check('по умолчанию — новый звук сообщения', api.selectedSound('message') === 'gruv', api.selectedSound('message'));
    check('по умолчанию — новый рингтон', api.selectedSound('ring') === 'gruv', api.selectedSound('ring'));
    for (const kind of ['message', 'ring']) {
        const ids = api.soundCatalog(kind).map(s => s.id);
        check(`${kind}: «Классика» осталась вариантом`, ids.includes('classic') && ids.length === synth.list(kind).length + 1, ids.join(', '));
    }
}

{
    const { api } = makeClient({ prefs: { messageSound: 'удалённый-звук', ringtone: 42 } });
    check('мусор в настройках → звук по умолчанию',
        api.selectedSound('message') === 'gruv' && api.selectedSound('ring') === 'gruv');
}

{
    const { api } = makeClient({ withSynth: false, prefs: { messageSound: 'kaplya', ringtone: 'puls' } });
    check('без модуля синтеза остаётся «Классика»',
        api.selectedSound('message') === 'classic' && api.selectedSound('ring') === 'classic');
}

{
    const { api, log } = makeClient();
    api.playMessageChime();
    const src = log.sources[0];
    check('звук сообщения играет готовый буфер', !!src && src.started && !src.loop && src.buffer?.length > 1000 && log.oscillators === 0,
        `источников ${log.sources.length}, осцилляторов ${log.oscillators}`);
    let peak = 0;
    if (src?.buffer) for (const x of src.buffer.getChannelData(0)) peak = Math.max(peak, Math.abs(x));
    check('в буфер попали сэмплы рендера', peak > 0.25, `пик ${peak}`);
    api.playMessageChime();
    check('повторный звук берёт буфер из кеша', log.sources[1]?.buffer === src?.buffer);
}

{
    const { api, log } = makeClient({ prefs: { messageSound: 'classic', ringtone: 'classic' } });
    api.playMessageChime();
    check('«Классика»: сигнал сообщения — прежний живой синтез', log.sources.length === 0 && log.oscillators > 0);
    const before = log.oscillators;
    api.startRingtone();
    check('«Классика»: рингтон — фраза и таймер повтора',
        api.sound.ringing === true && !!api.sound.ringTimer && log.oscillators > before && log.sources.length === 0);
    api.stopRingtone();
    check('«Классика»: остановка снимает таймер', api.sound.ringing === false && api.sound.ringTimer === null);
}

{
    const { api, log } = makeClient({ prefs: { ringtone: 'savanna' } });
    api.startRingtone();
    const src = log.sources[0];
    check('рингтон — один зацикленный источник, без таймера',
        api.sound.ringing === true && !!src && src.loop === true && src.started && !api.sound.ringTimer && log.sources.length === 1);
    api.startRingtone();
    check('повторный startRingtone не запускает второй', log.sources.length === 1);
    api.stopRingtone();
    check('stopRingtone останавливает цикл', api.sound.ringing === false && api.sound.ringLoop === null && log.stopped === 1);
}

{
    // Контекст не разблокирован жестом (фоновая вкладка, запуск в трей): всё, что в него
    // поставлено, прозвучит разом при первом клике.
    const { api, log } = makeClient({ contextState: 'suspended' });
    for (let i = 0; i < 10; i++) api.playMessageChime();
    check('до разблокировки звука копится один сигнал сообщения, а не пачка', log.sources.length === 1, `поставлено ${log.sources.length}`);
    api.sound.ctx.state = 'running';
    api.playMessageChime();
    api.playMessageChime();
    check('после разблокировки каждый сигнал звучит', log.sources.length === 3, `поставлено ${log.sources.length}`);
}

{
    const { api, log } = makeClient({ contextState: 'suspended' });
    api.startRingtone();
    api.stopRingtone();
    check('сброшенный до разблокировки звонок снимается сразу, без «хвоста» при первом клике',
        log.stopped === 1 && log.stopWhen === undefined && api.sound.ringLoop === null, `stop(${log.stopWhen})`);
}

{
    // Сбой рендера (например, не хватило памяти под буфер) не оставляет без звука.
    const broken = { list: synth.list, has: synth.has, render() { throw new Error('boom'); } };
    const { api, log } = makeClient({ synthModule: broken });
    let threw = false;
    try {
        api.playMessageChime();
        api.startRingtone();
    } catch (error) {
        threw = true;
    }
    check('сбой рендера → звучит «Классика», а не тишина',
        !threw && log.sources.length === 0 && log.oscillators > 0 && api.sound.ringing === true && !!api.sound.ringTimer);
    api.stopRingtone();
}

// ── 3. Голосовой канал ───────────────────────────────────────────────────────

{
    const { api, log } = makeClient();
    const join = (participants, roomId = 'ch-1', roomType = 'channel') => {
        const before = log.sources.length;
        api.sound.voiceEventAt = {};
        api.noteVoiceRoomMembers({ roomId, roomType, participants });
        api.voice.roomId = roomId;
        api.voice.roomType = roomType;
        api.voice.participants = participants;
        return log.sources.length - before;
    };
    check('свой заход в канал с людьми — один звук, а не по одному на каждого', join(['alice', 'bob', 'me']) === 1);
    check('повтор того же состава (раз в 8 с, переподключение) — тишина', join(['alice', 'bob', 'me']) === 0);
    const last = () => log.sources[log.sources.length - 1]?.buffer;
    const leaveBuffer = () => api.soundBuffer('voice', 'leave', api.sound.ctx);
    const joinBuffer = () => api.soundBuffer('voice', 'join', api.sound.ctx);
    check('кто-то вышел — звук выхода', join(['alice', 'me']) === 1 && last() === leaveBuffer());
    check('кто-то зашёл — звук захода', join(['alice', 'me', 'carol']) === 1 && last() === joinBuffer());
    check('один ушёл, другой пришёл за одно обновление — один звук, заход',
        join(['alice', 'me', 'erin']) === 1 && last() === joinBuffer());
    check('переход в другой канал — без звука выхода за людей прошлой комнаты',
        join(['me'], 'ch-9') === 1 && last() === joinBuffer());
    api.voice = { roomId: 'ch-9', roomType: 'channel', participants: ['me', 'alice'] };
    check('чужая комната канала, где меня нет, — тишина', join(['x', 'y'], 'ch-2') === 0);
    check('личный звонок — без звука захода', join(['me', 'alice'], 'dm-1', 'dm') === 0);
    // Свой заход: звук по клику, первый состав от сервера не звучит второй раз,
    // следующий чужой заход — звучит.
    api.voice = { roomId: '', roomType: '', participants: [] };
    api.sound.voiceEventAt = {};
    let clicked = log.sources.length;
    api.noteVoiceRoomJoining('ch-5');
    check('свой заход — звук сразу по клику', log.sources.length - clicked === 1 && last() === joinBuffer());
    check('первый состав после своего захода — без второго звука', join(['me', 'alice', 'bob'], 'ch-5') === 0);
    check('после этого чужой заход звучит как обычно', join(['me', 'alice', 'bob', 'zed'], 'ch-5') === 1);

    // Свой выход из канала.
    api.voice = { roomId: 'ch-1', roomType: 'channel', participants: ['me', 'alice'] };
    api.sound.voiceEventAt = {};
    let before = log.sources.length;
    api.noteVoiceRoomLeft();
    check('свой выход из канала — звук выхода', log.sources.length - before === 1 && last() === leaveBuffer());
    api.voice = { roomId: 'dm-1', roomType: 'dm', participants: ['me', 'alice'] };
    api.sound.voiceEventAt = {};
    before = log.sources.length;
    api.noteVoiceRoomLeft();
    check('конец личного звонка — без звука выхода', log.sources.length === before);
    api.voice = { roomId: 'ch-1', roomType: 'channel', participants: ['me'] };
    api.audioPrefs.voiceSounds = false;
    check('выключено в настройках — тишина', join(['me', 'dave']) === 0);
    api.audioPrefs.voiceSounds = true;

    api.sound.voiceEventAt = {};
    before = log.sources.length;
    api.playVoiceEventSound('stream');
    api.playVoiceEventSound('stream');
    check('звук демонстрации играет готовый буфер и не повторяется пачкой',
        log.sources.length - before === 1 && log.sources[log.sources.length - 1].buffer?.length > 1000);
}

{
    // Звук ещё не разблокирован жестом: событий «сейчас» не копим.
    const { api, log } = makeClient({ contextState: 'suspended' });
    api.playVoiceEventSound('join');
    api.noteVoiceRoomMembers({ roomId: 'ch-1', roomType: 'channel', participants: ['me', 'alice'] });
    check('до разблокировки звуки канала не ставятся в очередь', log.sources.length === 0, `поставлено ${log.sources.length}`);
}

{
    // Харнессы голоса (voice_doctor) поднимают клиент без this.sound — звук не должен ронять звонок.
    const { api } = makeClient();
    delete api.sound;
    let threw = false;
    try {
        api.playVoiceEventSound('stream');
        api.noteVoiceRoomMembers({ roomId: 'ch-1', roomType: 'channel', participants: ['me', 'alice'] });
    } catch (error) {
        threw = true;
    }
    check('без звукового состояния звуки канала молчат, а не бросают', !threw);
}

console.log('');
console.log(failures === 0 ? `sounds: ${checks} checks passed` : `sounds: ${failures} of ${checks} checks FAILED`);
process.exit(failures === 0 ? 0 : 1);
