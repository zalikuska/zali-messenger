// --- window.ZaliSoundSynth: звуки и рингтоны приложения, отрендеренные офлайн. ---
//
// Прежние звуки («Классика», interface/notifications.js) собираются на лету из
// осцилляторов Web Audio: что успел построить граф в реальном времени, то и звучит.
// Здесь наоборот — каждый звук считается ОДИН раз, целиком и не в реальном времени,
// в пару Float32Array (стерео), а играет уже готовый буфер. Это снимает все
// ограничения «живого» графа: FM-электропиано, модальные маримба/колокольчики,
// струна Карплуса—Стронга, ударные из шума и мастеринг по громкости.
//
// Файлов-ассетов нет намеренно: рендер детерминирован, на устройстве получаются те же
// сэмплы, что лежали бы в WAV, но в бандл каждого шелла не едут мегабайты аудио.
//
// Рингтоны зациклены без шва. Цикл длиной L рендерится в буфер L + хвост, после чего
// хвост (реверберация и затухание нот за границей цикла) складывается обратно в
// начало. Вся цепочка до этого шага линейна, поэтому результат в точности равен
// бесконечному периодическому повтору — AudioBufferSourceNode.loop крутит его без
// щелчка и без таймеров (setInterval в свёрнутом окне душится, а звонок звонит
// как раз свёрнутому).
//
// Модуль не трогает DOM и Web Audio — только считает. Проверка:
// scripts/notify_doctor/check_sounds.mjs (NaN, пики, шов цикла, громкость).
(function (root) {
    'use strict';

    const TAU = Math.PI * 2;
    const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

    // ── Таблица синуса ────────────────────────────────────────────────────────
    // FM считает sin от модулированной фазы на каждый сэмпл; Math.sin там — основная
    // цена рендера. Линейная интерполяция по 4096 точкам даёт ошибку ~3e-7.
    // Фаза везде в оборотах (1.0 = период). +2 точки запаса: phase - floor(phase)
    // из-за округления может дать ровно 1.0.
    const SIN_SIZE = 4096;
    const SIN = new Float32Array(SIN_SIZE + 2);
    for (let i = 0; i < SIN.length; i++) SIN[i] = Math.sin(TAU * i / SIN_SIZE);
    function sinT(phase) {
        const x = (phase - Math.floor(phase)) * SIN_SIZE;
        const i = x | 0;
        return SIN[i] + (SIN[i + 1] - SIN[i]) * (x - i);
    }

    // ── Волновые таблицы (ограниченный спектр: гармоник не больше, чем влезает до Найквиста) ──
    const WT_SIZE = 2048;
    const wtCache = new Map();
    function wavetable(kind, harmonics, ampOf) {
        const key = `${kind}:${harmonics}`;
        let table = wtCache.get(key);
        if (table) return table;
        table = new Float32Array(WT_SIZE + 2);
        for (let h = 1; h <= harmonics; h++) {
            const amp = ampOf(h);
            for (let i = 0; i < WT_SIZE; i++) table[i] += amp * Math.sin(TAU * h * i / WT_SIZE);
        }
        table[WT_SIZE] = table[0];
        table[WT_SIZE + 1] = table[1];
        wtCache.set(key, table);
        return table;
    }
    function wtRead(table, phase) {
        const x = (phase - Math.floor(phase)) * WT_SIZE;
        const i = x | 0;
        return table[i] + (table[i + 1] - table[i]) * (x - i);
    }

    // Вход ноты: полкосинуса за n сэмплов. Линейный подъём за 1–2 мс щёлкал (резкий
    // излом огибающей слышен как тик), а дольше 5–6 мс — уже «наплыв». 3–5 мс — середина:
    // звук начинается сразу, но мягко. Так же устроены и концы (см. finalize, riser).
    function rise(j, n) {
        return j >= n ? 1 : 0.5 - 0.5 * Math.cos(Math.PI * j / n);
    }

    // Детерминированный шум: одна и та же нота — одни и те же сэмплы на любом устройстве.
    function prng(seed) {
        let a = seed >>> 0;
        return () => {
            a = (a + 0x6D2B79F5) >>> 0;
            let t = a;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
        };
    }

    const NOTE_BASE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
    function hz(name) {
        const m = /^([A-G])([#b]?)(-?\d)$/.exec(name);
        if (!m) throw new Error(`bad note ${name}`);
        const midi = 12 * (Number(m[3]) + 1) + NOTE_BASE[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
        return 440 * Math.pow(2, (midi - 69) / 12);
    }

    // ── Микс ──────────────────────────────────────────────────────────────────
    // L/R — сухой сигнал, S — посыл в реверберацию (моно), E — посыл в эхо (моно).
    function createMix(sr, seconds) {
        const n = Math.ceil(seconds * sr);
        return {
            sr, n,
            L: new Float32Array(n), R: new Float32Array(n),
            S: new Float32Array(n), E: new Float32Array(n),
        };
    }

    // Равномощное панорамирование: pan −1…1.
    function panGains(pan) {
        const a = (clamp(pan, -1, 1) + 1) * Math.PI / 4;
        return [Math.cos(a), Math.sin(a)];
    }

    let scratch = new Float32Array(0);
    function scratchBuffer(len) {
        if (scratch.length < len) scratch = new Float32Array(len);
        else scratch.fill(0, 0, len);
        return scratch;
    }

    // Моно-буфер → микс с панорамой и посылами.
    function mixMono(mix, start, mono, len, gain, o) {
        const [gl, gr] = panGains(o.pan || 0);
        const send = (o.send || 0) * gain;
        const echo = (o.echo || 0) * gain;
        const end = Math.min(mix.n, start + len);
        const { L, R, S, E } = mix;
        for (let i = Math.max(0, start), j = i - start; i < end; i++, j++) {
            const y = mono[j];
            L[i] += y * gain * gl;
            R[i] += y * gain * gr;
            if (send) S[i] += y * send;
            if (echo) E[i] += y * echo;
        }
    }

    // ── Инструменты ───────────────────────────────────────────────────────────

    // Электропиано (FM, в духе «тайнов»): несущая с модулятором 1:1 даёт тело, которое
    // темнеет по мере затухания, а короткий высокий модулятор — звонкий удар молоточка.
    // Сила нажатия (vel) открывает индекс модуляции: громче = ярче, как у инструмента.
    // Два голоса с расстройкой ±1,5 цента разведены по панораме — лёгкий живой хорус.
    function tine(mix, t, o) {
        const sr = mix.sr;
        const f = o.f;
        const vel = o.vel ?? 0.8;
        const tau = o.tau ?? clamp(0.85 * Math.pow(440 / f, 0.6), 0.28, 1.8);
        const hold = Number.isFinite(o.hold) ? o.hold : Infinity;
        const relTau = 0.09;
        const seconds = Math.min(tau * 7, hold + relTau * 7);
        const start = Math.round(t * sr);
        const len = Math.min(Math.ceil(seconds * sr), mix.n - start);
        if (len <= 0) return;
        // Модулятор удара: как можно выше, но чтобы боковые полосы не лезли за Найквист.
        let strike = 0;
        for (const r of [14, 9, 7, 5, 4, 3]) {
            if (r * f <= 9500) { strike = r; break; }
        }
        const gain = (o.gain ?? 1) * (0.3 + 0.7 * vel) * 0.5;
        const [glA, grA] = panGains((o.pan || 0) - 0.3);
        const [glB, grB] = panGains((o.pan || 0) + 0.3);
        const send = o.send || 0;
        const echo = o.echo || 0;
        const wA = f / 1.00087 / sr;
        const wB = f * 1.00087 / sr;
        const ampK = Math.exp(-1 / (tau * sr));
        const bodyK = Math.exp(-1 / (tau * 0.45 * sr));
        const strikeK = Math.exp(-1 / (0.045 * sr));
        const relK = Math.exp(-1 / (relTau * sr));
        const attack = Math.max(1, Math.round(0.004 * sr));
        const holdSamples = hold * sr;
        let amp = 1, body = 1.5 * vel / TAU, strikeIdx = 1.1 * vel / TAU, rel = 1;
        const bodyFloor = 0.2 / TAU;
        let pA = 0, pB = 0.25;
        const { L, R, S, E } = mix;
        for (let j = 0, i = start; j < len; j++, i++) {
            const env = amp * rel * rise(j, attack);
            const idx = bodyFloor + body;
            let a = 0.8 * sinT(pA + idx * sinT(pA));
            let b = 0.8 * sinT(pB + idx * sinT(pB));
            if (strike) {
                a += 0.28 * sinT(pA + strikeIdx * sinT(pA * strike));
                b += 0.28 * sinT(pB + strikeIdx * sinT(pB * strike));
            }
            a *= env * gain;
            b *= env * gain;
            L[i] += a * glA + b * glB;
            R[i] += a * grA + b * grB;
            if (send) S[i] += (a + b) * send;
            if (echo) E[i] += (a + b) * echo;
            pA += wA; pB += wB;
            amp *= ampK; body *= bodyK; strikeIdx *= strikeK;
            if (j > holdSamples) rel *= relK;
        }
    }

    // Ударные с модальным спектром: [отношение частоты, уровень, доля времени затухания].
    // Верхние моды гаснут первыми — это и отличает «удар по бруску» от синтетического бипа.
    const MODES = {
        // Брусок маримбы настроен на 1 : 4 : ~10, удар мягкой палочкой.
        marimba: {
            partials: [[1, 1, 1], [3.98, 0.26, 0.25], [9.9, 0.08, 0.1]],
            tau: (f) => clamp(0.34 * Math.pow(440 / f, 0.55), 0.12, 0.9),
            click: 0.2, clickHz: 2800,
        },
        // Язычок калимбы: негармоничные обертоны около 5,4× и щипок ногтем.
        kalimba: {
            partials: [[1, 1, 1], [2, 0.07, 0.55], [5.42, 0.18, 0.16], [6.28, 0.07, 0.1]],
            tau: (f) => clamp(0.75 * Math.pow(440 / f, 0.4), 0.3, 1.4),
            click: 0.1, clickHz: 3800,
        },
        // Металлофон: моды свободного стержня 1 : 2,756 : 5,404 : 8,933, долгий звон.
        glock: {
            partials: [[1, 1, 1], [2.756, 0.3, 0.42], [5.404, 0.14, 0.2], [8.933, 0.05, 0.1]],
            tau: (f) => clamp(1.5 * Math.pow(880 / f, 0.5), 0.5, 2.0),
            click: 0.05, clickHz: 6000,
        },
        // Гребёнка музыкальной шкатулки: почти гармонично плюс металлический призвук.
        musicbox: {
            partials: [[1, 1, 1], [2, 0.16, 0.6], [3, 0.06, 0.4], [5.4, 0.13, 0.17], [8.9, 0.045, 0.09]],
            tau: (f) => clamp(1.0 * Math.pow(880 / f, 0.45), 0.4, 1.6),
            click: 0.08, clickHz: 5000,
        },
    };

    function mallet(mix, t, kind, o) {
        const sr = mix.sr;
        const mode = MODES[kind];
        const f = o.f;
        const vel = o.vel ?? 0.8;
        const tau = (o.tau ?? mode.tau(f));
        const start = Math.round(t * sr);
        const len = Math.min(Math.ceil(tau * 7 * sr), mix.n - start);
        if (len <= 0) return;
        const mono = scratchBuffer(len);
        const attack = Math.max(1, Math.round(0.003 * sr));
        for (const [ratio, level, decay] of mode.partials) {
            const pf = f * ratio;
            if (pf > 0.45 * sr) continue;
            // Резонатор второго порядка: синус без единого вызова sin в цикле.
            const w = TAU * pf / sr;
            const c = 2 * Math.cos(w);
            let y1 = 0, y2 = -Math.sin(w);
            // Яркость растёт с силой удара: верхним модам достаётся больше.
            let env = level * (ratio === 1 ? 1 : 0.45 + 0.55 * vel);
            const k = Math.exp(-1 / (tau * decay * sr));
            const plen = Math.min(len, Math.ceil(tau * decay * 7 * sr));
            for (let j = 0; j < plen; j++) {
                const y = c * y1 - y2;
                y2 = y1; y1 = y;
                mono[j] += y1 * env;
                env *= k;
            }
        }
        // Щелчок палочки/ногтя: полоса шума на пару миллисекунд.
        if (mode.click) {
            const rnd = prng(Math.round(f * 31) + start * 7);
            const clen = Math.min(len, Math.round(0.014 * sr));
            const aHi = 1 - Math.exp(-TAU * mode.clickHz / sr);
            const aLo = 1 - Math.exp(-TAU * (mode.clickHz / 4) / sr);
            const k = Math.exp(-1 / (0.0022 * sr));
            let hi = 0, lo = 0, env = mode.click * (0.4 + 0.6 * vel);
            for (let j = 0; j < clen; j++) {
                const x = rnd();
                hi += aHi * (x - hi);
                lo += aLo * (x - lo);
                mono[j] += (hi - lo) * env * 2.2;
                env *= k;
            }
        }
        for (let j = 0; j < attack && j < len; j++) mono[j] *= rise(j, attack);
        mixMono(mix, start, mono, len, (o.gain ?? 1) * (0.3 + 0.7 * vel) * 0.55, o);
    }

    // Щипковая струна (Карплус—Стронг): шум в линии задержки длиной в период, на каждом
    // обороте фильтр снимает верх — получается именно струна, а не её имитация огибающей.
    // Дробная часть периода добирается фазовым фильтром, иначе верхние ноты фальшивят.
    function pluck(mix, t, o) {
        const sr = mix.sr;
        const f = o.f;
        const vel = o.vel ?? 0.8;
        const tau = o.tau ?? clamp(1.1 * Math.pow(330 / f, 0.5), 0.4, 2.2);
        const bright = clamp(o.bright ?? 0.6, 0, 1);
        const start = Math.round(t * sr);
        const len = Math.min(Math.ceil(tau * 6.5 * sr), mix.n - start);
        if (len <= 0) return;
        const s = 0.5 - 0.4 * bright;
        const period = sr / f;
        const delay = period - s;
        const N = Math.floor(delay - 0.2);
        if (N < 2) return;
        const frac = delay - N;
        const C = (1 - frac) / (1 + frac);
        const damp = Math.exp(-1 / (f * tau));
        const line = new Float32Array(N);
        const rnd = prng(Math.round(f * 17) + start * 3);
        const a = clamp(0.12 + 0.8 * bright * (0.4 + 0.6 * vel), 0.05, 1);
        let lp1 = 0, lp2 = 0, mean = 0, power = 0;
        for (let i = 0; i < N; i++) {
            const x = rnd();
            lp1 += a * (x - lp1);
            lp2 += a * (lp1 - lp2);
            line[i] = lp2;
            mean += lp2;
        }
        mean /= N;
        for (let i = 0; i < N; i++) { line[i] -= mean; power += line[i] * line[i]; }
        const norm = 1 / Math.sqrt(power / N + 1e-12);
        for (let i = 0; i < N; i++) line[i] *= norm;
        const mono = scratchBuffer(len);
        let idx = 0, prev = 0, apX = 0, apY = 0;
        for (let j = 0; j < len; j++) {
            const x0 = line[idx];
            const filtered = damp * ((1 - s) * x0 + s * prev);
            prev = x0;
            const ap = C * filtered + apX - C * apY;
            apX = filtered; apY = ap;
            line[idx] = ap;
            idx = idx + 1 === N ? 0 : idx + 1;
            mono[j] = x0;
        }
        const pluckAttack = Math.max(1, Math.round(0.003 * sr));
        for (let j = 0; j < pluckAttack && j < len; j++) mono[j] *= rise(j, pluckAttack);
        mixMono(mix, start, mono, len, (o.gain ?? 1) * (0.3 + 0.7 * vel) * 0.32, o);
    }

    // Капля: синус, чья высота за сотые доли секунды взлетает к целевой — так звучит
    // схлопывающийся пузырёк воздуха в воде.
    function droplet(mix, t, o) {
        const sr = mix.sr;
        const vel = o.vel ?? 0.8;
        const tau = o.tau ?? 0.1;
        const start = Math.round(t * sr);
        const len = Math.min(Math.ceil(tau * 7 * sr), mix.n - start);
        if (len <= 0) return;
        const mono = scratchBuffer(len);
        const glideK = Math.exp(-1 / ((o.glide ?? 0.03) * sr));
        const ampK = Math.exp(-1 / (tau * sr));
        const attack = Math.max(1, Math.round(0.004 * sr));
        let phase = 0, diff = o.f0 - o.f1, amp = 1;
        for (let j = 0; j < len; j++) {
            const rise = j < attack ? 0.5 - 0.5 * Math.cos(Math.PI * j / attack) : 1;
            mono[j] = (sinT(phase) + 0.09 * sinT(phase * 2)) * amp * rise;
            phase += (o.f1 + diff) / sr;
            diff *= glideK;
            amp *= ampK;
        }
        mixMono(mix, start, mono, len, (o.gain ?? 1) * (0.3 + 0.7 * vel) * 0.6, o);
    }

    // Мягкая подкладка: три слегка расстроенных голоса на ноту, плавный вход и выход.
    function pad(mix, t, o) {
        const sr = mix.sr;
        const attack = o.attack ?? 0.5;
        const release = o.release ?? 0.8;
        const start = Math.round(t * sr);
        const len = Math.min(Math.ceil((o.dur + release) * sr), mix.n - start);
        if (len <= 0) return;
        const aN = Math.max(1, Math.round(attack * sr));
        const hN = Math.round(o.dur * sr);
        const rN = Math.max(1, Math.round(release * sr));
        const gain = (o.gain ?? 0.2) * 0.3;
        const send = o.send || 0;
        const { L, R, S } = mix;
        const voices = [[-7, -0.7, 0.7], [0, 0, 1], [7, 0.7, 0.7]];
        o.notes.forEach((f, noteIndex) => {
            const harmonics = clamp(Math.floor(0.4 * sr / f), 1, 6);
            const table = wavetable('pad', harmonics, (h) => 1 / Math.pow(h, 1.8));
            voices.forEach(([cents, pan, level], voiceIndex) => {
                const w = f * Math.pow(2, cents / 1200) / sr;
                const [gl, gr] = panGains(pan);
                const g = gain * level;
                let phase = (noteIndex * 0.37 + voiceIndex * 0.29) % 1;
                for (let j = 0, i = start; j < len; j++, i++) {
                    let env = 1;
                    if (j < aN) env = 0.5 - 0.5 * Math.cos(Math.PI * j / aN);
                    if (j > hN) env *= 0.5 + 0.5 * Math.cos(Math.PI * Math.min(1, (j - hN) / rN));
                    const y = wtRead(table, phase) * env * g;
                    L[i] += y * gl;
                    R[i] += y * gr;
                    if (send) S[i] += y * send;
                    phase += w;
                }
            });
        });
    }

    // Синтезаторный щипок: пила, у которой «фильтр» закрывается за доли секунды.
    // Фильтра как такового нет — две таблицы (яркая и тёмная) с общей фазой, кроссфейд
    // между ними и есть огибающая фильтра, только без алиасинга.
    function synthPluck(mix, t, o) {
        const sr = mix.sr;
        const f = o.f;
        const vel = o.vel ?? 0.8;
        const tau = o.tau ?? 0.3;
        const hold = Number.isFinite(o.hold) ? o.hold : Infinity;
        const relTau = 0.06;
        const start = Math.round(t * sr);
        const len = Math.min(Math.ceil(Math.min(tau * 7, hold + relTau * 7) * sr), mix.n - start);
        if (len <= 0) return;
        const harmonics = clamp(Math.floor(0.42 * sr / f), 1, 20);
        const brightTable = wavetable('saw', harmonics, (h) => 1 / h);
        const darkTable = wavetable('sawdark', harmonics, (h) => (1 / h) / (1 + Math.pow(h / 2, 2)));
        const gain = (o.gain ?? 1) * (0.3 + 0.7 * vel) * 0.3;
        const [glA, grA] = panGains((o.pan || 0) - 0.35);
        const [glB, grB] = panGains((o.pan || 0) + 0.35);
        const wA = f * Math.pow(2, -4 / 1200) / sr;
        const wB = f * Math.pow(2, 4 / 1200) / sr;
        const ampK = Math.exp(-1 / (tau * sr));
        const filterK = Math.exp(-1 / ((o.filterTau ?? 0.07) * sr));
        const relK = Math.exp(-1 / (relTau * sr));
        const attack = Math.max(1, Math.round(0.004 * sr));
        const holdSamples = hold * sr;
        let amp = 1, open = 0.25 + 0.75 * vel, rel = 1, pA = 0, pB = 0.4;
        const { L, R, S, E } = mix;
        const send = o.send || 0, echo = o.echo || 0;
        for (let j = 0, i = start; j < len; j++, i++) {
            const env = amp * rel * rise(j, attack) * gain;
            const dA = wtRead(darkTable, pA), dB = wtRead(darkTable, pB);
            const a = (dA + (wtRead(brightTable, pA) - dA) * open) * env;
            const b = (dB + (wtRead(brightTable, pB) - dB) * open) * env;
            L[i] += a * glA + b * glB;
            R[i] += a * grA + b * grB;
            if (send) S[i] += (a + b) * send;
            if (echo) E[i] += (a + b) * echo;
            pA += wA; pB += wB;
            amp *= ampK; open *= filterK;
            if (j > holdSamples) rel *= relK;
        }
    }

    // Бас: синус с двумя гармониками — их слышно и на динамике телефона, где самого
    // основного тона (100–250 Гц) почти нет.
    function bass(mix, t, o) {
        const sr = mix.sr;
        const vel = o.vel ?? 0.8;
        const tau = o.tau ?? 0.7;
        const hold = Number.isFinite(o.hold) ? o.hold : Infinity;
        const relTau = 0.08;
        const start = Math.round(t * sr);
        const len = Math.min(Math.ceil(Math.min(tau * 7, hold + relTau * 7) * sr), mix.n - start);
        if (len <= 0) return;
        const mono = scratchBuffer(len);
        const w = o.f / sr;
        const ampK = Math.exp(-1 / (tau * sr));
        const relK = Math.exp(-1 / (relTau * sr));
        const attack = Math.max(1, Math.round(0.007 * sr));
        const holdSamples = hold * sr;
        let phase = 0, amp = 1, rel = 1;
        for (let j = 0; j < len; j++) {
            const rise = j < attack ? 0.5 - 0.5 * Math.cos(Math.PI * j / attack) : 1;
            mono[j] = (sinT(phase) + 0.4 * sinT(phase * 2) + 0.15 * sinT(phase * 3)) * amp * rel * rise;
            phase += w;
            amp *= ampK;
            if (j > holdSamples) rel *= relK;
        }
        mixMono(mix, start, mono, len, (o.gain ?? 1) * (0.4 + 0.6 * vel) * 0.5, o);
    }

    // Мягкий удар-пульс: синус, падающий по высоте, — «сердцебиение» под арпеджио.
    function thump(mix, t, o) {
        const sr = mix.sr;
        const start = Math.round(t * sr);
        const len = Math.min(Math.ceil(0.5 * sr), mix.n - start);
        if (len <= 0) return;
        const mono = scratchBuffer(len);
        const sweepK = Math.exp(-1 / (0.03 * sr));
        const ampK = Math.exp(-1 / (0.1 * sr));
        const attack = Math.max(1, Math.round(0.004 * sr));
        const base = o.base ?? 62;
        let phase = 0, extra = o.sweep ?? 90, amp = 1;
        for (let j = 0; j < len; j++) {
            mono[j] = (sinT(phase) + 0.25 * sinT(phase * 2)) * amp * rise(j, attack);
            phase += (base + extra) / sr;
            extra *= sweepK;
            amp *= ampK;
        }
        mixMono(mix, start, mono, len, (o.gain ?? 1) * 0.6, o);
    }

    // Шумовой удар: полоса шума [low…high] Гц с быстрым затуханием. Из него собраны
    // хэт (верх, 15 мс), хлопок (середина, 45 мс) и щелчок бочки. Шум — от постоянного
    // сида: один и тот же удар звучит одинаково в каждом такте, как у драм-машины.
    function noiseHit(mix, t, o) {
        const sr = mix.sr;
        const tau = o.tau ?? 0.02;
        const start = Math.round(t * sr);
        const len = Math.min(Math.ceil(tau * 7 * sr), mix.n - start);
        if (len <= 0) return;
        const mono = scratchBuffer(len);
        const rnd = prng(o.seed ?? 1);
        const aHigh = 1 - Math.exp(-TAU * Math.min(o.high ?? 12000, 0.45 * sr) / sr);
        const aLow = 1 - Math.exp(-TAU * (o.low ?? 4000) / sr);
        const k = Math.exp(-1 / (tau * sr));
        const attack = Math.max(1, Math.round(0.0015 * sr));
        let hi = 0, lo = 0, env = 1;
        for (let j = 0; j < len; j++) {
            const x = rnd();
            hi += aHigh * (x - hi);
            lo += aLow * (hi - lo);
            mono[j] = (hi - lo) * env * rise(j, attack);
            env *= k;
        }
        mixMono(mix, start, mono, len, o.gain ?? 0.3, o);
    }

    // Взлёт: шум через полосовой фильтр (state-variable), центр которого за dur
    // поднимается от f0 до f1 по экспоненте, а громкость нарастает к концу — «вдох»
    // перед ударом; гаснет за 35 мс полукосинусом, а не обрывается. С down: true —
    // наоборот, «выдох»: центр падает от f1 к f0, звук стихает к концу. Уровень полосы
    // держится ровным: у SVF выход полосы растёт с добротностью, он делится на неё.
    function riser(mix, t, o) {
        const sr = mix.sr;
        const dur = o.dur ?? 0.25;
        const start = Math.round(t * sr);
        const len = Math.min(Math.ceil((dur + 0.04) * sr), mix.n - start);
        if (len <= 0) return;
        const mono = scratchBuffer(len);
        const rnd = prng(o.seed ?? 7);
        const f0 = o.f0 ?? 600, f1 = Math.min(o.f1 ?? 7000, 0.4 * sr);
        const q = o.q ?? 2.2;
        const down = !!o.down;
        const durN = Math.round(dur * sr);
        const fadeN = Math.max(1, Math.round(0.035 * sr));
        const attackN = Math.max(1, Math.round(0.005 * sr));
        let low = 0, band = 0;
        for (let j = 0; j < len; j++) {
            const x = Math.min(1, j / durN);
            const fc = f0 * Math.pow(f1 / f0, down ? 1 - x : x);
            const f = 2 * Math.sin(Math.PI * Math.min(fc, 0.24 * sr) / sr);
            const high = rnd() - low - band / q;
            band += f * high;
            low += f * band;
            let env;
            if (down) {
                env = (1 - x) * (1 - x) * rise(j, attackN);
            } else {
                // from — уровень, с которого начинается нарастание: с нуля «вдох»
                // первые десятки миллисекунд неслышен, и звук кажется запоздавшим.
                const from = o.from ?? 0;
                env = (from + (1 - from) * x * x) * rise(j, attackN);
                if (j > durN) env = 1 - rise(j - durN, fadeN);
            }
            mono[j] = band / q * env;
        }
        mixMono(mix, start, mono, len, o.gain ?? 0.5, o);
    }

    // ── Эффекты ───────────────────────────────────────────────────────────────

    // Пинг-понг эхо: повторы по очереди слева и справа, каждый темнее предыдущего.
    function echo(mix, o) {
        const { sr, n, L, R, S, E } = mix;
        const d = Math.max(1, Math.round(o.time * sr));
        const fb = o.feedback ?? 0.35;
        const level = o.level ?? 0.5;
        const toReverb = o.toReverb ?? 0.3;
        const a = 1 - Math.exp(-TAU * (o.cutoff ?? 3500) / sr);
        const oL = new Float32Array(n), oR = new Float32Array(n);
        let lpL = 0, lpR = 0;
        for (let i = d; i < n; i++) {
            lpR += a * (oR[i - d] - lpR);
            oL[i] = E[i - d] + fb * lpR;
            lpL += a * (oL[i - d] - lpL);
            oR[i] = fb * lpL;
            L[i] += oL[i] * level;
            R[i] += oR[i] * level;
            S[i] += (oL[i] + oR[i]) * 0.5 * level * toReverb;
        }
    }

    // Реверберация (схема Freeverb: 8 гребенчатых фильтров с демпфированием + 4 фазовых
    // на канал, каналы разнесены по длине линий). Посыл предварительно подрезается снизу
    // и сверху: гул и «песок» в хвосте — первое, что выдаёт дешёвый ревербератор.
    // level — уровень хвоста относительно сухого сигнала в дБ (по энергии всего буфера),
    // поэтому звучит одинаково «мокро» независимо от того, сколько нот в партии.
    const COMBS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
    const ALLPASSES = [556, 441, 341, 225];
    function reverb(mix, o) {
        const { sr, n, L, R, S } = mix;
        const scale = sr / 44100;
        const decay = o.decay ?? 1.2;
        const feedback = clamp(Math.pow(10, -3 * 0.0307 / decay), 0.3, 0.97);
        const damp = o.damp ?? 0.35;
        const pre = Math.round((o.predelay ?? 0.012) * sr);
        const aLp = 1 - Math.exp(-TAU * (o.highcut ?? 6500) / sr);
        const aHp = 1 - Math.exp(-TAU * (o.lowcut ?? 220) / sr);
        const input = new Float32Array(n);
        let lp = 0, low = 0;
        for (let i = pre; i < n; i++) {
            const x = S[i - pre];
            lp += aLp * (x - lp);
            low += aHp * (lp - low);
            input[i] = (lp - low) * 0.02;
        }
        const wet = [new Float32Array(n), new Float32Array(n)];
        for (let ch = 0; ch < 2; ch++) {
            const acc = wet[ch];
            for (const size of COMBS) {
                const len = Math.max(1, Math.round((size + ch * 23) * scale));
                const line = new Float32Array(len);
                let idx = 0, store = 0;
                for (let i = 0; i < n; i++) {
                    const out = line[idx];
                    store = out * (1 - damp) + store * damp;
                    line[idx] = input[i] + store * feedback;
                    acc[i] += out;
                    idx = idx + 1 === len ? 0 : idx + 1;
                }
            }
            for (const size of ALLPASSES) {
                const len = Math.max(1, Math.round((size + ch * 23) * scale));
                const line = new Float32Array(len);
                let idx = 0;
                for (let i = 0; i < n; i++) {
                    const delayed = line[idx];
                    const x = acc[i];
                    acc[i] = delayed - x;
                    line[idx] = x + delayed * 0.5;
                    idx = idx + 1 === len ? 0 : idx + 1;
                }
            }
        }
        let dry = 0, wetPower = 0;
        for (let i = 0; i < n; i++) {
            dry += L[i] * L[i] + R[i] * R[i];
            wetPower += wet[0][i] * wet[0][i] + wet[1][i] * wet[1][i];
        }
        if (wetPower <= 0 || dry <= 0) return;
        const g = Math.sqrt(dry / wetPower) * Math.pow(10, (o.level ?? -15) / 20);
        for (let i = 0; i < n; i++) {
            L[i] += wet[0][i] * g;
            R[i] += wet[1][i] * g;
        }
    }

    // ── Мастеринг ─────────────────────────────────────────────────────────────

    // Срез постоянной составляющей и инфразвука (линейный — применяется ДО склейки цикла).
    function dcBlock(buffer, sr) {
        const k = Math.exp(-TAU * 22 / sr);
        let x1 = 0, y1 = 0;
        for (let i = 0; i < buffer.length; i++) {
            const x = buffer[i];
            y1 = k * (y1 + x - x1);
            x1 = x;
            buffer[i] = y1;
        }
    }

    // Оценка громкости «как слышит ухо»: низ ослаблен, область 1,5 кГц+ приподнята
    // (грубое подобие K-взвешивания), максимум по окнам 100 мс. По ней все звуки
    // выводятся на один уровень — тихая маримба и звонкий металлофон звучат вровень.
    function loudness(L, R, sr, wrap) {
        const n = L.length;
        const aLow = 1 - Math.exp(-TAU * 100 / sr);
        const aHigh = 1 - Math.exp(-TAU * 1500 / sr);
        const win = Math.max(1, Math.round(0.1 * sr));
        const hop = Math.max(1, win >> 1);
        const power = new Float32Array(n);
        for (const ch of [L, R]) {
            let low = 0, high = 0;
            // Для цикла фильтры прогреваются предыдущим оборотом — иначе начало занижено.
            const from = wrap ? -Math.min(n, sr >> 1) : 0;
            for (let i = from; i < n; i++) {
                const x = ch[i < 0 ? i + n : i];
                low += aLow * (x - low);
                high += aHigh * (x - high);
                const y = (x - low) + 0.58 * (x - high);
                if (i >= 0) power[i] += y * y * 0.5;
            }
        }
        let best = 0, sum = 0;
        for (let i = 0; i < n; i++) {
            sum += power[i];
            if (i >= win) sum -= power[i - win];
            if (i >= win - 1 && (i - win + 1) % hop === 0) best = Math.max(best, sum / win);
        }
        if (n < win) best = sum / Math.max(1, n);
        return Math.sqrt(best);
    }

    const TARGET_LOUDNESS = 0.2;
    const PEAK_CEILING = 0.89;
    const KNEE = 0.62;

    // Мягкий ограничитель: до KNEE линейно, выше — плавное насыщение к 1.
    function softLimit(x) {
        const a = Math.abs(x);
        if (a <= KNEE) return x;
        const y = KNEE + (1 - KNEE) * Math.tanh((a - KNEE) / (1 - KNEE));
        return x < 0 ? -y : y;
    }

    function finalize(mix, spec) {
        const sr = mix.sr;
        dcBlock(mix.L, sr);
        dcBlock(mix.R, sr);
        let L, R;
        if (spec.loop) {
            const loopN = Math.round(spec.loop * sr);
            L = new Float32Array(loopN);
            R = new Float32Array(loopN);
            for (let i = 0; i < mix.n; i++) {
                const j = i % loopN;
                L[j] += mix.L[i];
                R[j] += mix.R[i];
            }
        } else {
            let peak = 0;
            for (let i = 0; i < mix.n; i++) peak = Math.max(peak, Math.abs(mix.L[i]), Math.abs(mix.R[i]));
            // Обрезать беззвучный хвост (ниже −66 дБ от пика) и закончить коротким фейдом.
            const floor = peak * 0.0005;
            let end = mix.n;
            while (end > 1 && Math.abs(mix.L[end - 1]) < floor && Math.abs(mix.R[end - 1]) < floor) end--;
            end = Math.min(mix.n, end + Math.round(0.03 * sr));
            L = mix.L.slice(0, end);
            R = mix.R.slice(0, end);
            const fade = Math.min(end, Math.round(0.03 * sr));
            for (let j = 0; j < fade; j++) {
                const g = 0.5 - 0.5 * Math.cos(Math.PI * j / fade);
                L[end - 1 - j] *= g;
                R[end - 1 - j] *= g;
            }
        }
        const n = L.length;
        const loud = loudness(L, R, sr, !!spec.loop);
        const gain = loud > 0 ? TARGET_LOUDNESS * Math.pow(10, (spec.trim || 0) / 20) / loud : 1;
        let peak = 0;
        for (let i = 0; i < n; i++) {
            L[i] = softLimit(L[i] * gain);
            R[i] = softLimit(R[i] * gain);
            peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
        }
        if (peak > PEAK_CEILING) {
            const down = PEAK_CEILING / peak;
            for (let i = 0; i < n; i++) { L[i] *= down; R[i] *= down; }
        }
        return { sampleRate: sr, left: L, right: R, loop: !!spec.loop, duration: n / sr };
    }

    // ── Партитуры ─────────────────────────────────────────────────────────────
    // build(mix) расставляет ноты в секундах. У рингтонов loop — длина цикла, tail —
    // сколько досчитывать после него (хвост вернётся в начало цикла).

    // Реверберации практически нет: только короткий след на −30 дБ, чтобы ноты не
    // обрывались «в вату». Хвосты и эхо в сигналах мессенджера мешают — звук должен
    // читаться сразу и не размазываться (решение пользователя, 2026-11-11).
    const ROOM = { decay: 0.4, level: -30 };

    // Голос «Грува» — один на рингтон и на парный звук сообщения: маримба даёт удар и
    // дерево, электропиано — тело ноты. Чем сильнее нота, тем ярче оба слоя.
    //   • звук сообщения: мягкая подача, акцент (vel ≥ 1) подсвечен калимбой октавой выше;
    //   • рингтон (drive): плотнее и ярче — маримба в полную силу, электропиано с «лаем»
    //     FM, вместо переливов калимбы — удвоение маримбой в октаву (octave — его уровень).
    function grooveNote(m, t, f, vel, o = {}) {
        if (o.drive) {
            mallet(m, t, 'marimba', { f, vel: Math.min(1, vel), pan: -0.1, send: 0.3 });
            tine(m, t, { f, vel: Math.min(1, vel * 0.8), hold: o.hold ?? 0.09, gain: 0.7, pan: 0.1, send: 0.3 });
            if (o.octave) mallet(m, t, 'marimba', { f: f * 2, vel, gain: o.octave * (vel >= 1 ? 1.6 : 1), pan: 0.2, send: 0.3 });
            return;
        }
        mallet(m, t, 'marimba', { f, vel: vel * 0.85, pan: -0.1, send: 0.3 });
        tine(m, t, { f, vel: vel * 0.5, hold: o.hold ?? 0.1, gain: 0.55, pan: 0.1, send: 0.3 });
        if (vel >= 1) mallet(m, t, 'kalimba', { f: f * 2, vel: 0.6, gain: 0.26, pan: 0.25, send: 0.3 });
    }

    const MESSAGE_SOUNDS = [
        {
            // Пара к рингтону «Грув»: начало его ячейки тем же голосом — ре, тихое ля и
            // синкопированный акцент на фа-диезе, — только сжатое до трети секунды.
            id: 'gruv', name: 'Грув', hint: 'В пару к рингтону «Грув»',
            seconds: 1.8,
            build(m) {
                grooveNote(m, 0, hz('D5'), 0.82);
                grooveNote(m, 0.12, hz('A4'), 0.58);
                grooveNote(m, 0.3, hz('F#5'), 1, { hold: 0.18 });
                bass(m, 0, { f: hz('D3'), vel: 0.7, hold: 0.25, tau: 0.4, gain: 0.45 });
                reverb(m, ROOM);
            },
        },
        {
            id: 'nota', name: 'Нота', hint: 'Тёплое электропиано',
            seconds: 2.4,
            build(m) {
                tine(m, 0, { f: hz('E5'), vel: 0.72, tau: 0.4, pan: -0.15, send: 0.5 });
                tine(m, 0.092, { f: hz('B5'), vel: 0.92, tau: 0.55, pan: 0.15, send: 0.6 });
                mallet(m, 0.092, 'glock', { f: hz('B6'), vel: 0.5, gain: 0.16, pan: 0.3, send: 0.8 });
                reverb(m, ROOM);
            },
        },
        {
            id: 'kaplya', name: 'Капля', hint: 'Две капли воды',
            seconds: 1.6,
            build(m) {
                droplet(m, 0, { f0: 480, f1: 1170, glide: 0.03, tau: 0.075, vel: 0.8, pan: -0.2, send: 0.5 });
                droplet(m, 0.118, { f0: 700, f1: 1560, glide: 0.034, tau: 0.13, vel: 1, pan: 0.2, send: 0.6 });
                reverb(m, ROOM);
            },
        },
        {
            id: 'kristall', name: 'Кристалл', hint: 'Звонкий перелив',
            seconds: 3.2,
            build(m) {
                mallet(m, 0, 'glock', { f: hz('D6'), vel: 0.65, pan: -0.4, send: 0.6 });
                mallet(m, 0.062, 'glock', { f: hz('F#6'), vel: 0.75, pan: -0.12, send: 0.6 });
                mallet(m, 0.124, 'glock', { f: hz('A6'), vel: 0.9, pan: 0.15, send: 0.7 });
                mallet(m, 0.2, 'glock', { f: hz('D7'), vel: 0.55, gain: 0.7, pan: 0.42, send: 0.8 });
                reverb(m, ROOM);
            },
        },
        {
            id: 'marimba', name: 'Маримба', hint: 'Мягкое дерево',
            seconds: 1.8,
            build(m) {
                mallet(m, 0, 'marimba', { f: hz('E5'), vel: 0.8, pan: -0.15, send: 0.5 });
                mallet(m, 0, 'marimba', { f: hz('E4'), vel: 0.6, gain: 0.45, pan: -0.15, send: 0.3 });
                mallet(m, 0.105, 'marimba', { f: hz('A5'), vel: 1, pan: 0.15, send: 0.5 });
                mallet(m, 0.105, 'marimba', { f: hz('A4'), vel: 0.7, gain: 0.4, pan: 0.15, send: 0.3 });
                reverb(m, ROOM);
            },
        },
        {
            id: 'struna', name: 'Струна', hint: 'Перебор арфы',
            seconds: 3.2,
            build(m) {
                pluck(m, 0, { f: hz('A4'), vel: 0.7, tau: 0.8, pan: -0.35, send: 0.5 });
                pluck(m, 0.055, { f: hz('C#5'), vel: 0.75, tau: 0.8, pan: -0.12, send: 0.5 });
                pluck(m, 0.11, { f: hz('E5'), vel: 0.82, tau: 0.85, pan: 0.12, send: 0.5 });
                pluck(m, 0.165, { f: hz('A5'), vel: 1, tau: 0.9, pan: 0.35, send: 0.6 });
                reverb(m, ROOM);
            },
        },
        {
            id: 'tuk', name: 'Тук', hint: 'Короткий и тихий',
            seconds: 0.9,
            build(m) {
                droplet(m, 0, { f0: 360, f1: 880, glide: 0.018, tau: 0.042, vel: 1, send: 0.5 });
                reverb(m, ROOM);
            },
        },
    ];

    const RINGTONES = [
        {
            // Рингтон-остинато. Устроен по тому же принципу, что рингтон Discord (ноты,
            // ритм и тембр — свои): не мелодия с развитием и не звонок с паузой, а ОДНА
            // короткая синкопированная ячейка длиной в такт, повторённая четыре раза.
            //   • ячейка — пять нот на восьми восьмых (x x . x . x x .), три высоты; паузы
            //     внутри рисунка и дают «пружину», отдельной тишины между повторами нет;
            //   • такты 1–2 почти одинаковы, в 3–4 меняется нота и бас (ре мажор → си минор →
            //     доминанта в конце) — цикл не надоедает, но остаётся тем же рисунком;
            //   • тембр круглый, средний регистр (440–880 Гц), без звона наверху — поэтому не
            //     раздражает на десятом повторе;
            //   • темп быстрый (174), ощущается вдвое медленнее.
            // Энергию даёт не мелодия, а ритм-секция (этого у Discord нет, это своё):
            //   • бочка на первую восьмую и хлопок на пятую — ровный «бум-хлоп» в половинном
            //     темпе; хэт на слабые доли; бочка-призрак под акцентом ячейки;
            //   • бас не тянет тонику, а прыгает на октаву вместе с акцентом (поз. 3) и в конце;
            //   • аккорды электропиано — короткие «уколы» в паузах ячейки;
            //   • вторая половина цикла плотнее: мелодия удвоена в октаву, хэт чаще, а в конце
            //     четвёртого такта — проходка из двух нот, которая вбрасывает цикл обратно.
            id: 'gruv', name: 'Грув', hint: 'Пружинящий ритм с драйвом',
            loop: 16 * 60 / 174, tail: 1.6,
            build(m) {
                const e = 60 / 174 / 2;
                const bar = 8 * e;
                const bars = [
                    { notes: [[0, 'D5', 0.9], [1, 'A4', 0.6], [3, 'F#5', 1], [5, 'E5', 0.75], [6, 'D5', 0.9]],
                        bass: [[0, 'D3'], [3, 'D4'], [6, 'D4']], chord: ['A3', 'D4', 'F#4'], stabs: [2, 7] },
                    { notes: [[0, 'D5', 0.9], [1, 'A4', 0.6], [2.5, 'E5', 0.5], [3, 'F#5', 1], [5, 'E5', 0.75], [6, 'D5', 0.9]],
                        bass: [[0, 'D3'], [3, 'D4'], [6, 'D4'], [7, 'A3']], chord: ['A3', 'D4', 'F#4'], stabs: [2, 7] },
                    { notes: [[0, 'D5', 0.9], [1, 'B4', 0.6], [3, 'F#5', 1], [5, 'E5', 0.75], [6, 'D5', 0.9]],
                        bass: [[0, 'B2'], [3, 'B3'], [6, 'B3']], chord: ['B3', 'D4', 'F#4'], stabs: [2, 7] },
                    { notes: [[0, 'D5', 0.9], [1, 'B4', 0.6], [2.5, 'F#5', 0.55], [3, 'A5', 1], [5, 'F#5', 0.8], [6, 'E5', 0.92],
                        [7, 'A4', 0.7], [7.5, 'C#5', 0.85]],
                        bass: [[0, 'B2'], [3, 'B3'], [4, 'A2'], [6, 'A3']], chord: ['B3', 'D4', 'F#4'], stabs: [2] },
                ];
                bars.forEach((spec, k) => {
                    const t0 = k * bar;
                    const lift = k >= 2;
                    for (const [pos, note, vel] of spec.notes) {
                        grooveNote(m, t0 + pos * e, hz(note), vel, { drive: true, octave: lift ? 0.3 : 0.14 });
                    }
                    for (const [pos, note] of spec.bass) {
                        const down = pos === 0 || pos === 4;
                        bass(m, t0 + pos * e, {
                            f: hz(note), vel: down ? 0.9 : 0.7, hold: (down ? 1.5 : 0.7) * e,
                            tau: 0.4, gain: down ? 0.75 : 0.5,
                        });
                    }
                    for (const pos of spec.stabs) {
                        for (const note of spec.chord) {
                            tine(m, t0 + pos * e, { f: hz(note), vel: 0.75, hold: 0.06, gain: 0.34, pan: pos === 2 ? -0.25 : 0.25, send: 0.3 });
                        }
                    }
                    // Ритм-секция.
                    const kick = (pos, gain) => {
                        thump(m, t0 + pos * e, { gain, base: 68, sweep: 120 });
                        noiseHit(m, t0 + pos * e, { low: 500, high: 3500, tau: 0.004, gain: gain * 0.35, seed: 11 });
                    };
                    kick(0, 0.9);
                    kick(3, 0.5);
                    if (k % 2 === 1) kick(7, 0.55);
                    // Хлопок — два слоя шума с разбегом в сотую секунды.
                    noiseHit(m, t0 + 4 * e - 0.011, { low: 900, high: 3200, tau: 0.012, gain: 0.3, pan: -0.15, seed: 21 });
                    noiseHit(m, t0 + 4 * e, { low: 900, high: 3200, tau: 0.045, gain: 0.5, pan: 0.1, seed: 22 });
                    for (const pos of [2, 6]) {
                        noiseHit(m, t0 + pos * e, { low: 6000, high: 14000, tau: 0.018, gain: 0.34, pan: 0.3, seed: 31 });
                    }
                    if (lift) {
                        for (const pos of [1, 5]) {
                            noiseHit(m, t0 + pos * e, { low: 6000, high: 14000, tau: 0.01, gain: 0.18, pan: -0.3, seed: 32 });
                        }
                    }
                });
                reverb(m, ROOM);
            },
        },
        {
            // Звонок, а не мелодия: две короткие трели и пауза — ритм телефонного
            // вызова (0,45 с звон, пауза, 0,45 с звон, две секунды тишины). Трель —
            // быстрое чередование ми и си тем же электропиано, что у «Ноты», с
            // металлофоном октавой выше для звонкости. Ни развития, ни аккомпанемента:
            // по первой же трели понятно, что звонят.
            id: 'trel', name: 'Трель', hint: 'Двойной звонок, как у телефона',
            loop: 3.1, tail: 1.6,
            build(m) {
                const step = 0.066;
                for (const burst of [0, 0.62]) {
                    for (let i = 0; i < 7; i++) {
                        const high = i % 2 === 0;
                        const last = i === 6;
                        const t = burst + i * step;
                        tine(m, t, {
                            f: hz(high ? 'E6' : 'B5'), vel: i === 0 ? 1 : 0.85,
                            tau: last ? 0.2 : 0.11, pan: high ? 0.15 : -0.15, send: 0.3,
                        });
                        mallet(m, t, 'glock', {
                            f: hz(high ? 'E7' : 'B6'), vel: 0.6, gain: 0.22,
                            tau: last ? 0.22 : 0.1, pan: high ? 0.3 : -0.3, send: 0.3,
                        });
                    }
                }
                reverb(m, ROOM);
            },
        },
        {
            // Ре мажор, 96 уд/мин, 2 такта: I – IV – vi – V. Мелодия взлетает по трезвучию,
            // спускается и замирает на второй ступени — цикл сам просится начаться снова.
            id: 'rassvet', name: 'Рассвет', hint: 'Светлое электропиано',
            loop: 8 * 60 / 96, tail: 3.2,
            build(m) {
                const b = 60 / 96;
                const lead = [
                    [0, 'D5', 0.7, 0.4], [0.5, 'F#5', 0.75, 0.4], [1, 'A5', 0.82, 0.4], [1.5, 'D6', 0.96, 1.2],
                    [2.5, 'B5', 0.82, 0.5], [3, 'A5', 0.76, 0.5], [3.5, 'F#5', 0.7, 0.5],
                    [4, 'A5', 0.86, 0.5], [4.5, 'F#5', 0.72, 0.5], [5, 'E5', 0.84, 1.7],
                ];
                lead.forEach(([beat, note, vel, hold], index) => {
                    tine(m, beat * b, { f: hz(note), vel, hold: hold * b, pan: index % 2 ? 0.12 : -0.12, send: 0.5 });
                });
                // Искры металлофона на вершине фразы и в её конце.
                mallet(m, 1.5 * b, 'glock', { f: hz('D7'), vel: 0.5, gain: 0.14, pan: 0.4, send: 0.9 });
                mallet(m, 5 * b, 'glock', { f: hz('E6'), vel: 0.5, gain: 0.16, pan: -0.4, send: 0.9 });
                pad(m, 0, { notes: [hz('D4'), hz('F#4'), hz('A4')], dur: 2 * b, attack: 0.25, release: 0.7, gain: 0.3, send: 0.5 });
                pad(m, 2 * b, { notes: [hz('D4'), hz('G4'), hz('B4')], dur: 2 * b, attack: 0.3, release: 0.7, gain: 0.3, send: 0.5 });
                pad(m, 4 * b, { notes: [hz('D4'), hz('F#4'), hz('B4')], dur: 1 * b, attack: 0.3, release: 0.6, gain: 0.3, send: 0.5 });
                pad(m, 5 * b, { notes: [hz('C#4'), hz('E4'), hz('A4')], dur: 1.9 * b, attack: 0.3, release: 0.9, gain: 0.3, send: 0.5 });
                bass(m, 0, { f: hz('D3'), vel: 0.8, hold: 1.8 * b, gain: 0.7, send: 0.1 });
                bass(m, 2 * b, { f: hz('G3'), vel: 0.7, hold: 1.8 * b, gain: 0.7, send: 0.1 });
                bass(m, 4 * b, { f: hz('B3'), vel: 0.7, hold: 0.9 * b, gain: 0.6, send: 0.1 });
                bass(m, 5 * b, { f: hz('A3'), vel: 0.75, hold: 1.8 * b, gain: 0.7, send: 0.1 });
                reverb(m, ROOM);
            },
        },
        {
            // До-мажорная пентатоника, 116 уд/мин, синкопы на шестнадцатых; последняя
            // доля — пауза, чтобы цикл «дышал».
            id: 'savanna', name: 'Саванна', hint: 'Живая маримба',
            loop: 8 * 60 / 116, tail: 2.2,
            build(m) {
                const s = 60 / 116 / 4;
                const lead = [
                    [0, 'E5', 0.9], [2, 'G5', 0.7], [3, 'A5', 0.86], [5, 'G5', 0.62], [6, 'E5', 0.8],
                    [8, 'D5', 0.75], [10, 'E5', 0.7], [11, 'G5', 0.9], [14, 'C6', 1],
                    [16, 'A5', 0.92], [18, 'G5', 0.7], [19, 'E5', 0.8], [21, 'D5', 0.65], [22, 'C5', 0.86],
                    [24, 'D5', 0.72], [26, 'E5', 0.96],
                ];
                lead.forEach(([step, note, vel], index) => {
                    mallet(m, step * s, 'marimba', { f: hz(note), vel, pan: ((index % 3) - 1) * 0.22, send: 0.5 });
                });
                // Вершины фраз подсвечены калимбой октавой выше.
                mallet(m, 14 * s, 'kalimba', { f: hz('C7'), vel: 0.6, gain: 0.2, pan: 0.35, send: 0.8 });
                mallet(m, 26 * s, 'kalimba', { f: hz('E6'), vel: 0.6, gain: 0.22, pan: -0.35, send: 0.8 });
                const low = [
                    [0, 'C4', 0.9], [6, 'C4', 0.6], [8, 'G3', 0.85], [14, 'G3', 0.55],
                    [16, 'A3', 0.9], [22, 'F3', 0.8], [24, 'G3', 0.85], [26, 'G3', 0.6],
                ];
                low.forEach(([step, note, vel]) => {
                    mallet(m, step * s, 'marimba', { f: hz(note), vel, gain: 0.85, pan: 0, send: 0.3 });
                });
                reverb(m, ROOM);
            },
        },
        {
            // Ля минор, 112 уд/мин: арпеджио Am9 – Fmaj9 – G с эхом в пунктирную восьмую.
            id: 'puls', name: 'Пульс', hint: 'Синтезаторное арпеджио',
            loop: 8 * 60 / 112, tail: 3.2,
            build(m) {
                const b = 60 / 112;
                const e = b / 2;
                const arp = [
                    [0, 'A4', 0.9], [1, 'E5', 0.7], [2, 'A5', 0.8], [3, 'B5', 0.86],
                    [4, 'C6', 0.96], [5, 'B5', 0.74], [6, 'A5', 0.78], [7, 'E5', 0.68],
                    [8, 'F4', 0.9], [9, 'C5', 0.7], [10, 'A5', 0.84], [11, 'G5', 0.76],
                    [12, 'G4', 0.9], [13, 'D5', 0.76], [14, 'B5', 1],
                ];
                arp.forEach(([step, note, vel], index) => {
                    synthPluck(m, step * e, {
                        f: hz(note), vel, tau: step === 14 ? 0.5 : 0.26,
                        pan: index % 2 ? 0.2 : -0.2, send: 0.35, echo: 0.5,
                    });
                });
                pad(m, 0, { notes: [hz('A3'), hz('C4'), hz('E4')], dur: 4 * b, attack: 0.2, release: 0.5, gain: 0.26, send: 0.4 });
                pad(m, 4 * b, { notes: [hz('A3'), hz('C4'), hz('F4')], dur: 2 * b, attack: 0.2, release: 0.5, gain: 0.26, send: 0.4 });
                pad(m, 6 * b, { notes: [hz('G3'), hz('B3'), hz('D4')], dur: 1.6 * b, attack: 0.2, release: 0.6, gain: 0.26, send: 0.4 });
                bass(m, 0, { f: hz('A2'), vel: 0.85, hold: 3.6 * b, tau: 1.2, gain: 0.55 });
                bass(m, 4 * b, { f: hz('F2'), vel: 0.8, hold: 1.8 * b, tau: 1.2, gain: 0.55 });
                bass(m, 6 * b, { f: hz('G2'), vel: 0.8, hold: 1.5 * b, tau: 1.2, gain: 0.55 });
                for (const beat of [0, 2, 4, 6]) thump(m, beat * b, { gain: 0.4 });
                echo(m, { time: 0.75 * b, feedback: 0.15, level: 0.18, cutoff: 3200, toReverb: 0 });
                reverb(m, ROOM);
            },
        },
        {
            // Ля мажор: A – D – E, по шесть восьмых на аккорд, как валик музыкальной шкатулки.
            id: 'shkatulka', name: 'Шкатулка', hint: 'Музыкальная шкатулка',
            loop: 16 * 0.28, tail: 3.4,
            build(m) {
                const e = 0.28;
                const tune = [
                    [0, 'A5', 0.8], [1, 'C#6', 0.7], [2, 'E6', 0.78], [3, 'A6', 0.95], [4, 'E6', 0.72], [5, 'C#6', 0.66],
                    [6, 'F#5', 0.8], [7, 'A5', 0.7], [8, 'D6', 0.8], [9, 'F#6', 0.95], [10, 'D6', 0.72], [11, 'A5', 0.66],
                    [12, 'G#5', 0.82], [13, 'B5', 0.76], [14, 'E6', 1],
                ];
                tune.forEach(([step, note, vel], index) => {
                    mallet(m, step * e, 'musicbox', { f: hz(note), vel, pan: ((index % 4) - 1.5) * 0.2, send: 0.6 });
                });
                const low = [[0, 'A4', 0.8], [6, 'D4', 0.8], [12, 'E4', 0.8]];
                low.forEach(([step, note, vel]) => {
                    mallet(m, step * e, 'musicbox', { f: hz(note), vel, gain: 0.7, tau: 1.3, pan: 0, send: 0.5 });
                });
                reverb(m, ROOM);
            },
        },
        {
            // Соль мажор, 66 уд/мин: G – Em – C – D, редкая калимба поверх подкладки.
            id: 'briz', name: 'Бриз', hint: 'Спокойный и мягкий',
            loop: 8 * 60 / 66, tail: 3.4,
            build(m) {
                const b = 60 / 66;
                const tune = [
                    [0, 'B5', 0.8], [0.5, 'D6', 0.86], [1.5, 'G5', 0.75],
                    [2.5, 'A5', 0.72], [3, 'G5', 0.8],
                    [4, 'G5', 0.78], [4.5, 'E6', 0.95], [5.5, 'D6', 0.8],
                    [6, 'A5', 0.85],
                ];
                tune.forEach(([beat, note, vel], index) => {
                    mallet(m, beat * b, 'kalimba', { f: hz(note), vel, pan: index % 2 ? 0.25 : -0.25, send: 0.7 });
                    // Тихий отзвук арфы под каждой нотой — калимба одна звучит суховато.
                    pluck(m, beat * b, { f: hz(note) / 2, vel: vel * 0.7, gain: 0.5, bright: 0.35, pan: index % 2 ? -0.2 : 0.2, send: 0.6 });
                });
                pad(m, 0, { notes: [hz('G3'), hz('D4'), hz('B4')], dur: 2 * b, attack: 0.5, release: 0.9, gain: 0.34, send: 0.6 });
                pad(m, 2 * b, { notes: [hz('E3'), hz('E4'), hz('G4'), hz('B4')], dur: 2 * b, attack: 0.5, release: 0.9, gain: 0.3, send: 0.6 });
                pad(m, 4 * b, { notes: [hz('C4'), hz('E4'), hz('G4')], dur: 2 * b, attack: 0.5, release: 0.9, gain: 0.34, send: 0.6 });
                pad(m, 6 * b, { notes: [hz('D4'), hz('F#4'), hz('A4')], dur: 1.7 * b, attack: 0.5, release: 1.0, gain: 0.34, send: 0.6 });
                reverb(m, ROOM);
            },
        },
    ];

    // Звуки голосового канала — тем же голосом, что пара «Грув», и без хвостов.
    // Звучат поверх разговора, поэтому короткие и на 4–5 дБ тише сигнала сообщения
    // (trim): заметны, но голос собеседника не перекрывают.
    const VOICE_SOUNDS = [
        {
            // Кто-то зашёл (или зашли вы сами): быстрое восходящее арпеджио ре мажора —
            // ля, ре, фа-диез, — последняя нота с акцентом и октавой сверху.
            id: 'join', name: 'Заход в канал', hint: 'Кто-то зашёл в голосовой канал',
            seconds: 1.1, trim: -4,
            build(m) {
                grooveNote(m, 0, hz('A4'), 0.62, { drive: true });
                grooveNote(m, 0.068, hz('D5'), 0.78, { drive: true });
                grooveNote(m, 0.136, hz('F#5'), 1, { drive: true, octave: 0.22, hold: 0.14 });
                reverb(m, ROOM);
            },
        },
        {
            // Кто-то вышел (или вышли вы сами): зеркало захода — то же арпеджио вниз,
            // фа-диез, ре, ля, — мягче и без октавы сверху: заметно, но не зовёт.
            id: 'leave', name: 'Выход из канала', hint: 'Кто-то вышел из голосового канала',
            seconds: 1.1, trim: -5,
            build(m) {
                grooveNote(m, 0, hz('F#5'), 0.78, { drive: true });
                grooveNote(m, 0.075, hz('D5'), 0.68, { drive: true });
                grooveNote(m, 0.15, hz('A4'), 0.85, { drive: true, hold: 0.14 });
                bass(m, 0.15, { f: hz('D3'), vel: 0.6, hold: 0.12, tau: 0.3, gain: 0.35 });
                reverb(m, ROOM);
            },
        },
        {
            // Включили демонстрацию: короткий «взлёт» шума и на его вершине — удар
            // аккордом ре мажора (электропиано + маримба в октаву) с бочкой. Ярче и
            // «шире» захода: это событие, на которое стоит посмотреть.
            id: 'stream', name: 'Включение стрима', hint: 'Кто-то начал демонстрацию экрана',
            seconds: 1.3, trim: -5,
            build(m) {
                const hit = 0.16;
                riser(m, 0, { dur: hit, from: 0.3, f0: 900, f1: 6500, gain: 0.55 });
                grooveNote(m, hit - 0.08, hz('A4'), 0.55, { drive: true });
                grooveNote(m, hit - 0.04, hz('D5'), 0.7, { drive: true });
                for (const [note, pan] of [['D5', -0.25], ['F#5', 0], ['A5', 0.25]]) {
                    grooveNote(m, hit, hz(note), 1, { drive: true, octave: 0.18, hold: 0.16 });
                    tine(m, hit, { f: hz(note), vel: 0.8, hold: 0.12, gain: 0.3, pan, send: 0.3 });
                }
                bass(m, hit, { f: hz('D3'), vel: 0.85, hold: 0.18, tau: 0.35, gain: 0.55 });
                thump(m, hit, { gain: 0.7, base: 68, sweep: 120 });
                mallet(m, hit, 'glock', { f: hz('D7'), vel: 0.6, gain: 0.16, tau: 0.3, pan: 0.3, send: 0.3 });
                reverb(m, ROOM);
            },
        },
    ];

    VOICE_SOUNDS.push({
        // Выключили демонстрацию: зеркало включения — мягкий аккорд и «выдох» шума
        // вниз, мелодически — шаг вниз ля → ре. Без бочки: событие закончилось, а не
        // началось.
        id: 'stream-stop', name: 'Конец стрима', hint: 'Кто-то выключил демонстрацию экрана',
        seconds: 1.2, trim: -6,
        build(m) {
            for (const [note, pan] of [['D5', -0.25], ['F#5', 0], ['A5', 0.25]]) {
                grooveNote(m, 0, hz(note), 0.8, { drive: true, hold: 0.1 });
                tine(m, 0, { f: hz(note), vel: 0.6, hold: 0.08, gain: 0.25, pan, send: 0.3 });
            }
            riser(m, 0.02, { down: true, dur: 0.26, f0: 450, f1: 5000, gain: 0.4 });
            grooveNote(m, 0.12, hz('A4'), 0.7, { drive: true });
            grooveNote(m, 0.2, hz('D4'), 0.8, { drive: true, hold: 0.14 });
            bass(m, 0.2, { f: hz('D3'), vel: 0.55, hold: 0.12, tau: 0.3, gain: 0.3 });
            reverb(m, ROOM);
        },
    });

    const BY_KIND = { message: MESSAGE_SOUNDS, ring: RINGTONES, voice: VOICE_SOUNDS };

    function find(kind, id) {
        return (BY_KIND[kind] || []).find((sound) => sound.id === id) || null;
    }

    function list(kind) {
        return (BY_KIND[kind] || []).map(({ id, name, hint }) => ({ id, name, hint }));
    }

    // → { sampleRate, left, right, loop, duration } или null, если такого звука нет.
    function render(kind, id, sampleRate) {
        const spec = find(kind, id);
        if (!spec) return null;
        const sr = clamp(Math.round(Number(sampleRate) || 48000), 8000, 192000);
        const seconds = spec.loop ? spec.loop + (spec.tail || 2.5) : spec.seconds;
        const mix = createMix(sr, seconds);
        spec.build(mix);
        return finalize(mix, spec);
    }

    root.ZaliSoundSynth = Object.freeze({ list, has: (kind, id) => !!find(kind, id), render });
})(typeof window !== 'undefined' ? window : globalThis);
