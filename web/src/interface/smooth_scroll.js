// --- ZaliInterface: плавная прокрутка колесом мыши и размытие в движении. ---
// Часть класса ZaliInterface (см. web/src/interface.js).
//
// Было (setupScrollInertia в events.js): пассивный слушатель КАЖДОГО wheel, который
// после 70 мс без событий «докатывал» ленту сам через scrollTop. На трекпаде пауза
// в 70 мс случается посреди жеста (палец замедлился) и между жестом и системной
// инерцией — и докат начинался поверх родной инерции. WebKit прерывает инерцию,
// когда страница сама двигает scrollTop, — прокрутка рвалась при идеальном FPS.
// На колесе было «прыжок на 40–120 px за кадр, потом докат» — ступеньки.
//
// Стало:
//  • трекпад и Magic Mouse — не трогаем вообще: у системы своя инерция, и она лучше;
//  • колесо в Chromium (Windows, Android, браузер) — тоже не трогаем: Chromium сам
//    анимирует щелчки колеса на компоновщике;
//  • колесо в WebKit (macOS-оболочка, Safari) — щелчок не прыгает, а плавно доезжает:
//    у каждой области прокрутки своя цель, щелчки прибавляются к ней, позиция
//    догоняет цель по экспоненте (~95% пути за ~350 мс, не зависит от частоты кадров).
//
// Колесо от трекпада отличается по первому событию жеста: щелчок колеса сразу даёт
// большой сдвиг (строка = 40 px), жест трекпада начинается с единиц пикселей. Тип
// запоминается на весь жест (пауза > GESTURE_GAP_MS — новый жест), поэтому быстрый
// взмах трекпадом посреди жеста за колесо не примется.
//
// Если прокрутку в это время сдвинул кто-то ещё (якорь окна виртуализации после
// перерисовки, прилипание к низу при новом сообщении), цель и позиция сдвигаются на
// ту же величину — анимация продолжается от нового места, а не тянет ленту назад.
//
// Размытие в движении — капля, только пока движение быстрое: до 0,6 px на прокрутке
// колесом и до 1 px на смене экранов (motionBlurAnimate). prefers-reduced-motion —
// ни сглаживания, ни размытия.
ZaliMixin(ZaliInterface, class {
    /** Движок без собственного сглаживания колеса: WebKit на компьютере. */
    smoothWheelWanted() {
        if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
        if (window.__zaliSmoothWheelForce === true) return true;
        if (this.prefersReducedMotion()) return false;
        if (this.isHandheldDevice?.()) return false;
        const ua = String(navigator.userAgent || '');
        const webkit = /AppleWebKit/i.test(ua) && !/(Chrome|Chromium|CriOS|Edg|OPR|Android)/i.test(ua)
            && typeof navigator.userAgentData === 'undefined';
        return webkit;
    }

    prefersReducedMotion() {
        try { return !!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches; } catch (e) { return false; }
    }

    setupSmoothWheel() {
        if (this._smoothWheelBound || !this.smoothWheelWanted()) return;
        this._smoothWheelBound = true;
        const GESTURE_GAP_MS = 160;
        const WHEEL_START_MIN = 30;   // px: первое событие жеста не меньше — это колесо
        const LINE_PX = 40;
        const TAU_MS = 115;           // постоянная времени догона цели (~95% пути за ~350 мс)
        const SKIP = 'textarea, input, select, [contenteditable="true"], [data-native-wheel]';
        let gesture = { at: 0, wheel: false };
        let anim = null;              // { el, target, pos, lastSet, raf, lastT }

        const scrollerFor = (start, dy) => {
            for (let el = start; el && el !== document.documentElement; el = el.parentElement) {
                if (el.nodeType !== 1) continue;
                const cs = getComputedStyle(el);
                if (!/(auto|scroll)/.test(cs.overflowY)) continue;
                if (cs.scrollSnapType && cs.scrollSnapType !== 'none') return null;
                const max = el.scrollHeight - el.clientHeight;
                if (max <= 1) continue;
                const base = anim && anim.el === el ? anim.target : el.scrollTop;
                if ((dy < 0 && base > 0.5) || (dy > 0 && base < max - 0.5)) return el;
            }
            return null;
        };

        const stop = () => {
            if (!anim) return;
            if (anim.raf) cancelAnimationFrame(anim.raf);
            if (anim.blurred) anim.el.style.filter = '';
            anim = null;
        };

        const tick = (now) => {
            const a = anim;
            if (!a) return;
            a.raf = 0;
            const el = a.el;
            const max = Math.max(0, el.scrollHeight - el.clientHeight);
            const actual = el.scrollTop;
            if (a.lastSet !== null && Math.abs(actual - a.lastSet) > 1.5) {
                const shift = actual - a.lastSet;
                a.pos += shift;
                a.target += shift;
            }
            a.target = Math.max(0, Math.min(max, a.target));
            const dt = Math.min(64, Math.max(1, now - (a.lastT || now - 16.7)));
            a.lastT = now;
            const before = a.pos;
            a.pos += (a.target - a.pos) * (1 - Math.exp(-dt / TAU_MS));
            const done = Math.abs(a.target - a.pos) < 0.5;
            if (done) a.pos = a.target;
            el.scrollTop = a.pos;
            a.lastSet = el.scrollTop;
            // Размытие по скорости (px за 1/60 с): с 8 px/кадр, максимум 0,6 px.
            const speed = Math.abs(a.pos - before) * (16.7 / dt);
            const blur = done || this.prefersReducedMotion() ? 0 : Math.min(0.6, Math.max(0, (speed - 8) / 40));
            if (blur > 0.05) {
                el.style.filter = `blur(${blur.toFixed(2)}px)`;
                a.blurred = true;
            } else if (a.blurred) {
                el.style.filter = '';
                a.blurred = false;
            }
            if (done) { stop(); return; }
            a.raf = requestAnimationFrame(tick);
        };

        document.addEventListener('wheel', (e) => {
            const now = performance.now();
            if (now - gesture.at > GESTURE_GAP_MS) {
                const magnitude = Math.abs(e.deltaMode ? 1e3 : e.deltaY);
                // Запасной признак щелчка: wheelDeltaY кратно 120 (тик колеса), у трекпада
                // первые события жеста — единицы.
                const ticks = Number(e.wheelDeltaY || 0);
                gesture.wheel = magnitude >= WHEEL_START_MIN || (Math.abs(ticks) >= 120 && ticks % 120 === 0);
            }
            gesture.at = now;
            if (!gesture.wheel || e.defaultPrevented || e.ctrlKey || e.metaKey) return;
            if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) return;
            if (e.target?.closest?.(SKIP)) return;
            const unit = e.deltaMode === 1 ? LINE_PX : (e.deltaMode === 2 ? 0 : 1);
            const dy = e.deltaY;
            const el = scrollerFor(e.target, dy);
            if (!el) { stop(); return; }
            const page = e.deltaMode === 2 ? el.clientHeight * 0.9 : 0;
            e.preventDefault();
            if (!anim || anim.el !== el) {
                stop();
                anim = { el, target: el.scrollTop, pos: el.scrollTop, lastSet: null, raf: 0, lastT: 0, blurred: false };
            }
            anim.target += unit ? dy * unit : Math.sign(dy) * page;
            if (!anim.raf) anim.raf = requestAnimationFrame(tick);
        }, { passive: false });

        // Перетаскивание ползунка, клавиши, касание — пользователь взял прокрутку сам.
        const interrupt = () => stop();
        document.addEventListener('pointerdown', interrupt, { passive: true, capture: true });
        document.addEventListener('keydown', (e) => {
            if (/^(PageUp|PageDown|Home|End|ArrowUp|ArrowDown| )$/.test(e.key)) stop();
        }, { capture: true });
    }

    /**
     * Капля размытия в движении на смене экранов: отдельная анимация filter поверх
     * transform той же длительности, пик в начале пути, где скорость наибольшая.
     * Возвращает Animation или null.
     */
    motionBlurAnimate(el, { duration = 320, peak = 1, easing = 'linear' } = {}) {
        if (!el || typeof el.animate !== 'function' || this.prefersReducedMotion()) return null;
        try {
            return el.animate([
                { filter: 'blur(0px)' },
                { filter: `blur(${peak}px)`, offset: 0.25 },
                { filter: 'blur(0px)' },
            ], { duration, easing });
        } catch (e) {
            return null;
        }
    }
});
