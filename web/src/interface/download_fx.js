// --- ZaliMessenger: анимация скачивания файла. ---
// Часть класса ZaliInterface (см. web/src/interface.js).
//
// Всегда по центру окна, поверх интерфейса. Круг со значком скачивания «сходится»
// к центру из большого и прозрачного, мягко садится (стрелка падает в лоток, круг
// чуть проседает и распрямляется), стрелка сменяется галочкой «готово» — и всё
// расходится наружу: волны от края круга, а сам круг расширяется и растворяется.
// Один акцентный цвет, без конфетти. Только WAAPI и слой, который сам себя убирает:
// на сообщения, прокрутку и фокус не влияет. `prefers-reduced-motion` — короткое
// появление круга без движения.
ZaliMixin(ZaliInterface, class {

    /** Центр области, где живёт интерфейс (с учётом клавиатуры на телефоне). */
    downloadFxOrigin() {
        const vw = window.innerWidth || 800;
        const vh = typeof zaliUsableViewportHeight === 'function' ? zaliUsableViewportHeight() : (window.innerHeight || 600);
        return { x: vw / 2, y: vh / 2 };
    }

    // `anchor` остаётся в сигнатуре ради вызовов (downloads.js, avatars.js): место теперь
    // одно — центр экрана.
    playDownloadFx() {
        if (typeof document === 'undefined' || typeof Element === 'undefined' || !Element.prototype.animate) return;
        try {
            document.querySelectorAll('.dl-fx').forEach(node => node.remove());
            const reduce = !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
            const { x, y } = this.downloadFxOrigin();
            const root = document.createElement('div');
            root.className = 'dl-fx';
            root.setAttribute('aria-hidden', 'true');
            root.style.setProperty('--dl-x', `${x}px`);
            root.style.setProperty('--dl-y', `${y}px`);
            const mk = (cls, parent = root) => {
                const el = document.createElement('span');
                el.className = cls;
                parent.appendChild(el);
                return el;
            };
            const scrim = mk('dl-scrim');
            const stage = mk('dl-stage');
            const trail = [mk('dl-ring dl-trail', stage), mk('dl-ring dl-trail', stage)];
            const waves = [mk('dl-ring dl-wave', stage), mk('dl-ring dl-wave', stage)];
            const badge = mk('dl-badge', stage);
            badge.innerHTML = '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'
                + '<g class="dl-down"><path class="dl-shaft" d="M16 7v12" pathLength="1"/><path class="dl-head" d="m10.5 14 5.5 5.5 5.5-5.5" pathLength="1"/></g>'
                + '<path class="dl-tray" d="M8 24.5h16" pathLength="1"/>'
                + '<path class="dl-check" d="m9.5 16.6 4.6 4.6 8.4-9.2" pathLength="1"/></svg>';
            document.body.appendChild(root);

            const anims = [];
            const run = (el, frames, options) => {
                const a = el.animate(frames, { fill: 'both', ...options });
                anims.push(a);
                return a;
            };
            const q = (sel) => badge.querySelector(sel);

            if (reduce) {
                run(badge, [{ opacity: 0 }, { opacity: 1, offset: 0.2 }, { opacity: 1, offset: 0.8 }, { opacity: 0 }], { duration: 1000, easing: 'linear' });
                q('.dl-down').style.display = 'none';
                q('.dl-tray').style.display = 'none';
                q('.dl-check').style.strokeDashoffset = '0';
                for (const el of [scrim, ...trail, ...waves]) el.style.display = 'none';
            } else {
                const EASE_OUT = 'cubic-bezier(.16,1,.3,1)';
                const EASE_IO = 'cubic-bezier(.65,0,.35,1)';
                // 0 — 600. Подложка чуть притемняет интерфейс и держится до конца.
                run(scrim, [{ opacity: 0 }, { opacity: 1, offset: 0.2 }, { opacity: 1, offset: 0.72 }, { opacity: 0 }], { duration: 1900, easing: 'linear' });
                // 1. Сходится: большой прозрачный круг стягивается к центру, за ним — два тонких следа.
                run(badge, [
                    { transform: 'scale(2.7)', opacity: 0, offset: 0 },
                    { transform: 'scale(1.9)', opacity: 1, offset: 0.22 },
                    { transform: 'scale(1)', opacity: 1, offset: 0.6 },
                    // 2. Посадка: проседает под ударом, чуть выпрямляется, встаёт.
                    { transform: 'scale(.93)', opacity: 1, offset: 0.68 },
                    { transform: 'scale(1.05)', opacity: 1, offset: 0.8 },
                    { transform: 'scale(1)', opacity: 1, offset: 0.88 },
                    { transform: 'scale(1)', opacity: 1, offset: 1 },
                ], { duration: 1050, easing: EASE_OUT });
                trail.forEach((ring, i) => {
                    run(ring, [
                        { transform: 'scale(2.7)', opacity: 0 },
                        { transform: 'scale(1.9)', opacity: 0.5 - i * 0.18, offset: 0.25 },
                        { transform: 'scale(1)', opacity: 0 },
                    ], { duration: 560, delay: 70 + i * 80, easing: EASE_OUT });
                });
                // Стрелка падает в лоток: шафт дорисовывается сверху вниз, голова и лоток — следом.
                run(q('.dl-shaft'), [{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: 300, delay: 400, easing: EASE_OUT });
                run(q('.dl-head'), [{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: 260, delay: 520, easing: EASE_OUT });
                run(q('.dl-tray'), [{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: 300, delay: 600, easing: EASE_OUT });
                run(q('.dl-down'), [
                    { transform: 'translateY(-6px)' },
                    { transform: 'translateY(0)', offset: 0.45 },
                    { transform: 'translateY(0)', offset: 0.7 },
                    { transform: 'translateY(5px)', opacity: 0 },
                ], { duration: 980, delay: 400, easing: EASE_IO });
                run(q('.dl-tray'), [{ opacity: 1 }, { opacity: 1, offset: 0.62 }, { opacity: 0 }], { duration: 1300, delay: 400, easing: 'linear' });
                // 3. «Готово»: галочка дорисовывается на месте стрелки.
                run(q('.dl-check'), [{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: 340, delay: 1020, easing: EASE_OUT });
                // 4. Расходится: волны от края круга, сам круг раскрывается и растворяется.
                waves.forEach((ring, i) => {
                    run(ring, [
                        { transform: 'scale(1)', opacity: 0.75, borderWidth: '2px' },
                        { transform: 'scale(3.2)', opacity: 0, borderWidth: '0.5px' },
                    ], { duration: 760, delay: 1180 + i * 120, easing: EASE_OUT, fill: 'forwards' });
                });
                run(badge, [
                    { transform: 'scale(1)', opacity: 1 },
                    { transform: 'scale(1.5)', opacity: 0 },
                ], { duration: 520, delay: 1330, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' });
            }
            const done = () => root.remove();
            Promise.allSettled(anims.map(a => a.finished)).then(done);
            setTimeout(done, 3600);
        } catch (e) {
            this.trace?.(`playDownloadFx failed error=${e?.message || e}`);
        }
    }
});
