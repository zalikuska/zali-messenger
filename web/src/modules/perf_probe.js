// @ts-check
// Замер фреймтайма в живом приложении. Выключен, пока шелл не выставил
// window.__ZALI_PERF_PROBE (macOS: переменная окружения ZALI_PERF_PROBE=1 при
// запуске бинарника). Включённый — дожидается входа, даёт приложению успокоиться
// и прогоняет сценарии, которые ничего не меняют ни на сервере, ни у собеседников:
// не отправляет, не ставит реакций, не открывает чаты с непрочитанными (их открытие
// разослало бы отметки о прочтении). Всё, что сценарий сдвинул в интерфейсе
// (открытый чат, экран, прокрутка, черновик), возвращается на место.
//
// Результат — по строке `[perf-probe] {...}` на сценарий в console.log; на macOS
// консоль зеркалится в ~/Library/Application Support/ZaliMessenger/zali-debug.log.
// Строка на сценарий, а не на кадр: зеркало консоли само ходит через мост WKWebView,
// и поток логов исказил бы то, что меряем.
//
// В каждом кадре меряются две величины:
//   interval — между соседними requestAnimationFrame: то, что видит пользователь;
//   work     — сколько главный поток потратил на шаг сценария, стили и раскладку
//              внутри кадра (шаг + принудительная раскладка). Отрисовку и
//              композитинг WebKit из JS не показывает — их видно только в
//              xctrace (Animation Hitches).
// 1000 / p95(work) — оценка потолка FPS по главному потоку.
(function() {
    'use strict';

    const config = window.__ZALI_PERF_PROBE;
    if (!config) return;

    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const round = (value, digits = 2) => Number(value.toFixed(digits));
    const log = (payload) => console.log(`[perf-probe] ${JSON.stringify(payload)}`);

    function stats(values) {
        if (!values.length) return null;
        const sorted = [...values].sort((a, b) => a - b);
        const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
        const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
        const sd = Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length);
        return {
            mean: round(mean), sd: round(sd), p50: round(pick(0.5)), p95: round(pick(0.95)),
            p99: round(pick(0.99)), max: round(sorted[sorted.length - 1]),
        };
    }

    // Задержка главного потока вне кадров (таймеры, сеть, мост): MessageChannel
    // не привязан к rAF и показывает, на сколько поток был занят целиком.
    function startLagMonitor() {
        let max = 0;
        let over50 = 0;
        let last = performance.now();
        let stopped = false;
        const channel = new MessageChannel();
        channel.port1.onmessage = () => {
            const now = performance.now();
            const gap = now - last;
            if (gap > max) max = gap;
            if (gap > 50) over50 += 1;
            last = now;
            if (!stopped) setTimeout(() => { last = performance.now(); channel.port2.postMessage(0); }, 0);
        };
        channel.port2.postMessage(0);
        return () => { stopped = true; channel.port1.onmessage = null; return { maxLag: round(max, 1), tasksOver50: over50 }; };
    }

    async function measure(name, durationMs, step, extra = {}) {
        const intervals = [];
        const work = [];
        const stopLag = startLagMonitor();
        probeState.profile = {};
        let frame = 0;
        let last = 0;
        const end = performance.now() + durationMs;
        await new Promise((resolve) => {
            const tick = (ts) => {
                if (last) intervals.push(ts - last);
                last = ts;
                const t0 = performance.now();
                try { step?.(frame); } catch (e) { /* шаг сценария не должен рвать замер */ }
                // Принудительная раскладка — чтобы стиль и раскладка этого кадра
                // попали в work, а не размазались по следующему.
                document.body.getBoundingClientRect();
                work.push(performance.now() - t0);
                frame += 1;
                if (performance.now() < end) requestAnimationFrame(tick);
                else resolve();
            };
            requestAnimationFrame(tick);
        });
        const lag = stopLag();
        const methods = topMethods(probeState.profile);
        probeState.profile = null;
        const st = stats(intervals);
        const wk = stats(work);
        const vsync = probeState.vsync || st?.p50 || 16.67;
        const dropped = intervals.filter((v) => v > vsync * 1.5).length;
        const result = {
            scenario: name,
            frames: intervals.length,
            fps: st ? round(1000 / st.mean, 1) : 0,
            interval: st,
            work: wk,
            headroomFps: wk ? Math.round(1000 / Math.max(wk.p95, 0.1)) : null,
            dropped,
            ...lag,
            ...extra,
            methods,
            series: intervals.map((v) => round(v, 1)),
            workSeries: work.map((v) => round(v, 2)),
        };
        log(result);
        return result;
    }

    // Серия дискретных действий: каждое — в своём кадре, после него кадры
    // досчитываются до `settleMs`, чтобы в замер попала и вызванная им отрисовка.
    async function measureActions(name, actions, settleMs) {
        let index = 0;
        let nextAt = 0;
        const total = actions.length * settleMs + 200;
        return measure(name, total, () => {
            const now = performance.now();
            if (index < actions.length && now >= nextAt) {
                actions[index]();
                index += 1;
                nextAt = now + settleMs;
            }
        }, { actions: actions.length });
    }

    const probeState = { vsync: 0, profile: null };

    // Профиль методов ZaliInterface: на время замера каждый метод прототипа
    // оборачивается счётчиком (время включительно, число вызовов). Так видно
    // работу, которая идёт вне шага сценария — обработчик прокрутки, отложенная
    // перерисовка в собственном rAF, таймеры.
    function installMethodProfiler(Z) {
        const seen = new Set();
        let proto = Object.getPrototypeOf(Z);
        while (proto && proto !== Object.prototype) {
            for (const name of Object.getOwnPropertyNames(proto)) {
                if (name === 'constructor' || seen.has(name)) continue;
                const desc = Object.getOwnPropertyDescriptor(proto, name);
                if (!desc || typeof desc.value !== 'function') continue;
                seen.add(name);
                const original = desc.value;
                Z[name] = function(...args) {
                    const prof = probeState.profile;
                    if (!prof) return original.apply(this, args);
                    const t0 = performance.now();
                    try {
                        return original.apply(this, args);
                    } finally {
                        const entry = prof[name] || (prof[name] = { ms: 0, calls: 0, max: 0 });
                        const dt = performance.now() - t0;
                        entry.ms += dt;
                        entry.calls += 1;
                        if (dt > entry.max) entry.max = dt;
                    }
                };
            }
            proto = Object.getPrototypeOf(proto);
        }
    }

    function topMethods(prof, limit = 12) {
        return Object.entries(prof || {})
            .filter(([, e]) => e.ms >= 1)
            .sort((a, b) => b[1].ms - a[1].ms)
            .slice(0, limit)
            .map(([name, e]) => `${name}:${Math.round(e.ms)}ms/${e.calls}x/max${Math.round(e.max)}`);
    }

    // Видимые элементы с эффектами, которые WebKit перерисовывает дорого.
    function heavyEffects() {
        const out = [];
        for (const el of document.querySelectorAll('*')) {
            if (!el.offsetParent && el !== document.body) continue;
            const cs = getComputedStyle(el);
            const fx = [];
            const bf = cs.backdropFilter || cs.webkitBackdropFilter;
            if (bf && bf !== 'none') fx.push(`backdrop:${bf}`);
            if (cs.filter && cs.filter !== 'none') fx.push(`filter:${cs.filter}`);
            const mask = cs.maskImage || cs.webkitMaskImage;
            if (mask && mask !== 'none') fx.push('mask');
            if (!fx.length) continue;
            const r = el.getBoundingClientRect();
            if (r.width * r.height < 400) continue;
            out.push(`${el.id ? '#' + el.id : el.className.toString().split(' ')[0] || el.tagName} ${Math.round(r.width)}x${Math.round(r.height)} ${fx.join(' ')}`.slice(0, 160));
        }
        return out.slice(0, 25);
    }

    async function run(Z) {
        const box = document.getElementById('msgs');
        const scroller = box;
        const inp = /** @type {HTMLTextAreaElement|null} */ (document.getElementById('msgInput'));
        const startChat = Z.S.current;
        const startScroll = scroller ? scroller.scrollTop : 0;
        const startDraft = inp ? inp.value : '';
        const chatViewActive = !!document.getElementById('viewChat')?.classList.contains('active');

        log({
            event: 'start', ua: navigator.userAgent, dpr: devicePixelRatio,
            viewport: [innerWidth, innerHeight], cores: navigator.hardwareConcurrency,
            designMode: document.body.dataset.designMode || '', nodes: document.getElementsByTagName('*').length,
            bubbles: box ? box.querySelectorAll('.msg').length : 0, contacts: (Z.S.contacts || []).length,
            messages: (Z.getCurrentMessages?.() || []).length, heavyEffects: heavyEffects(),
        });

        const idle = await measure('idle', 5000, null);
        probeState.vsync = idle.interval?.p50 || 16.67;

        if (scroller && scroller.scrollHeight > scroller.clientHeight + 40) {
            let dir = -1;
            await measure('scroll-messages', 6000, () => {
                scroller.scrollTop += dir * 40;
                if (scroller.scrollTop <= 0) dir = 1;
                if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) dir = -1;
            }, { scrollHeight: scroller.scrollHeight });
            scroller.scrollTop = startScroll;
            await wait(300);
        }

        const sidebar = document.getElementById('contacts');
        if (sidebar && sidebar.scrollHeight > sidebar.clientHeight + 40) {
            let dir = 1;
            const startSidebar = sidebar.scrollTop;
            await measure('scroll-contacts', 4000, () => {
                sidebar.scrollTop += dir * 30;
                if (sidebar.scrollTop + sidebar.clientHeight >= sidebar.scrollHeight - 2) dir = -1;
                if (sidebar.scrollTop <= 0) dir = 1;
            });
            sidebar.scrollTop = startSidebar;
            await wait(300);
        }

        // Только чаты без непрочитанных: открытие остальных разослало бы прочтение.
        const readChats = (Z.S.contacts || [])
            .filter((name) => name && name !== startChat && !(Z.S.unread || {})[name])
            .slice(0, 4);
        if (startChat && readChats.length) {
            const order = [...readChats, startChat, ...readChats, startChat];
            await measureActions('switch-chat', order.map((name) => () => Z.switchChat(name)), 700);
            if (Z.S.current !== startChat) Z.switchChat(startChat);
            await wait(500);
            if (scroller) scroller.scrollTop = startScroll;
        }

        await measureActions('views', [
            () => Z.openSettingsView(), () => Z.openHubView(), () => Z.openChatView(),
            () => Z.openSettingsView(), () => Z.openChatView(),
        ], 700);
        if (!chatViewActive) Z.openSettingsView?.();
        await wait(300);

        const msgEl = box?.querySelector('.msg[data-message-id]:last-of-type') || box?.querySelector('.msg[data-message-id]');
        if (msgEl) {
            const id = msgEl.getAttribute('data-message-id');
            const rect = msgEl.getBoundingClientRect();
            const actions = [];
            for (let i = 0; i < 6; i += 1) {
                actions.push(() => Z.showReactionMenu(msgEl, id, rect.left + 20, rect.top + 10));
                actions.push(() => Z.hideReactionMenu());
            }
            await measureActions('reaction-menu', actions, 250);
        }

        const me = Z.myName?.();
        if (me && typeof Z.openProfile === 'function') {
            await measureActions('profile-overlay', [
                () => { void Z.openProfile(me); }, () => Z.closeProfile(),
                () => { void Z.openProfile(me); }, () => Z.closeProfile(),
            ], 600);
            await wait(300);
        }

        if (inp) {
            const sample = 'проверка скорости набора текста в поле ввода ';
            await measure('typing', 3000, (frame) => {
                if (frame % 2) return;
                inp.value = startDraft + sample.slice(0, (frame / 2) % sample.length);
                inp.dispatchEvent(new Event('input', { bubbles: true }));
            });
            inp.value = startDraft;
            inp.dispatchEvent(new Event('input', { bubbles: true }));
        }

        await measure('idle-after', 3000, null);
        log({ event: 'done' });
    }

    async function waitForApp() {
        for (let i = 0; i < 600; i += 1) {
            const Z = /** @type {any} */ (window).__ZALI_INTERFACE;
            if (Z && Z.S?.session?.token && Z.sessionBootstrapInProgress === false && Z.S.current) return Z;
            await wait(500);
        }
        return null;
    }

    // Режим старта (ZALI_PERF_PROBE=startup): с самой загрузки страницы и до
    // `durationMs` пишет каждую блокировку главного потока длиннее 50 мс и
    // методы ZaliInterface, которые в неё выполнялись, плюс вехи запуска.
    // Профиль методов сбрасывается на каждом тике монитора, так что в отчёт о
    // блокировке попадает ровно то, что выполнялось внутри неё.
    function runStartup() {
        const durationMs = Number(config.durationMs) || 30000;
        const gaps = [];
        const milestones = {};
        const intervals = [];
        let profiled = false;
        let last = performance.now();
        const mark = (name, cond) => { if (!milestones[name] && cond) milestones[name] = Math.round(performance.now()); };
        const channel = new MessageChannel();
        channel.port1.onmessage = () => {
            const now = performance.now();
            const gap = now - last;
            if (gap > 50) {
                gaps.push({ at: Math.round(last), ms: Math.round(gap), methods: topMethods(probeState.profile, 6) });
            }
            probeState.profile = profiled ? {} : null;
            const Z = /** @type {any} */ (window).__ZALI_INTERFACE;
            if (Z && !profiled) { installMethodProfiler(Z); profiled = true; probeState.profile = {}; mark('interface', true); }
            if (Z) {
                mark('session', !!Z.S?.session?.token);
                mark('bootstrapDone', Z.sessionBootstrapInProgress === false);
                mark('chatOpen', !!Z.S?.current);
                mark('bubbles', !!document.querySelector('#msgs .msg'));
            }
            mark('splashHidden', !!document.getElementById('bootSplash')?.hidden);
            last = performance.now();
            if (now < durationMs) setTimeout(() => { last = performance.now(); channel.port2.postMessage(0); }, 0);
            else finish();
        };
        let lastFrame = 0;
        const frame = (ts) => {
            if (lastFrame) intervals.push(ts - lastFrame);
            lastFrame = ts;
            if (ts < durationMs) requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
        channel.port2.postMessage(0);
        let done = false;
        function finish() {
            if (done) return;
            done = true;
            probeState.profile = null;
            const blocked = gaps.reduce((sum, g) => sum + g.ms, 0);
            const fr = stats(intervals);
            log({
                event: 'startup', durationMs, milestones, blockedMs: blocked, gapsOver50: gaps.length,
                frames: intervals.length, frameInterval: fr,
                framesOver100: intervals.filter((v) => v > 100).length,
                gaps: gaps.sort((a, b) => b.ms - a.ms).slice(0, 25),
            });
        }
    }

    if (config.mode === 'startup') {
        runStartup();
        return;
    }

    (async () => {
        const Z = await waitForApp();
        if (!Z) { log({ event: 'skipped', reason: 'no session within 5 min' }); return; }
        // Дать догрузиться истории, аватаркам и кешу — меряем установившийся режим.
        await wait(Number(config.settleMs) || 8000);
        installMethodProfiler(Z);
        try {
            await run(Z);
        } catch (error) {
            log({ event: 'error', error: String(error && error.stack || error) });
        }
    })();
})();
