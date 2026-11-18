// --- ZaliInterface: движение — смена облика волной, появление новых сообщений. ---
// Часть класса ZaliInterface (см. web/src/interface.js, порядок — web/src/manifest.json).
//
// Правило гайдлайнов (§5) остаётся в силе: навигация — переход между каналами,
// диалогами, вкладками, строки списков, лента при открытии чата — мгновенная.
// Анимируется только то, что появилось само или по явному действию человека:
// отправленное/пришедшее сообщение, смена темы/схемы/стиля, окна и меню (CSS,
// блок «ДВИЖЕНИЕ» в конце web/style.css). Всё гаснет при prefers-reduced-motion.
ZaliMixin(ZaliInterface, class {

    motionReduced() {
        try { return !!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches; } catch (e) { return false; }
    }

    /** Смена облика всего приложения (тема, схема, стиль) — круговая волна от точки
     *  нажатия через View Transitions. Без поддержки, в скрытом окне или с
     *  reduced-motion — мгновенно. `change` выполняется ровно один раз. */
    applyLookWave(event, change) {
        const doc = document;
        if (this.motionReduced() || doc.hidden || typeof doc.startViewTransition !== 'function' || this._lookWaveBusy) {
            change();
            return;
        }
        const x = Number.isFinite(event?.clientX) && event.clientX > 0 ? event.clientX : window.innerWidth / 2;
        const y = Number.isFinite(event?.clientY) && event.clientY > 0 ? event.clientY : window.innerHeight / 2;
        const r = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
        const html = doc.documentElement;
        html.classList.add('look-vt');
        this._lookWaveBusy = true;
        let vt;
        try {
            vt = doc.startViewTransition(() => change());
        } catch (err) {
            html.classList.remove('look-vt');
            this._lookWaveBusy = false;
            change();
            return;
        }
        vt.ready.then(() => {
            html.animate(
                { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
                { duration: 560, easing: 'cubic-bezier(.2,.8,.2,1)', pseudoElement: '::view-transition-new(root)' },
            );
        }).catch(() => {});
        let settled = false;
        const cleanup = () => {
            if (settled) return;
            settled = true;
            clearTimeout(guard);
            html.classList.remove('look-vt');
            this._lookWaveBusy = false;
        };
        // Колбэк перехода ждёт кадра отрисовки: в окне, которое сейчас не рисует
        // (перекрыто, фоновая панель), смена задержалась бы, а флаг «волна идёт» —
        // застрял. Через 1,2 с переход пропускается: skipTransition() всё равно
        // вызывает колбэк, смена применяется без волны.
        const guard = setTimeout(() => {
            try { vt.skipTransition?.(); } catch (e) {}
            cleanup();
        }, 1200);
        vt.finished.finally(cleanup);
    }

    /** Последняя строка ленты до перерисовки — точка отсчёта «новых» строк. */
    messageTailBeforeRender(box) {
        const rows = box?.querySelectorAll?.(':scope > .msg');
        return rows && rows.length ? rows[rows.length - 1] : null;
    }

    /** Появление сообщений, добавленных в конец открытого разговора: отправленное
     *  поднимается от поля ввода, входящее въезжает слева. Только когда:
     *  - разговор тот же (открытие чата — мгновенно),
     *  - прежняя последняя строка жива (если её заменили — это смена статуса
     *    «отправляется → отправлено» или пересборка окна, а не новое сообщение),
     *  - новых строк 1–3 (пакет истории/синхронизации не анимируется).
     *  Web Animations, а не класс: следующая перерисовка (статус доставки через
     *  сотню мс) переписывает class строки и оборвала бы CSS-анимацию. */
    animateArrivedMessages(box, oldTail, { conversationChanged = false } = {}) {
        if (conversationChanged || !oldTail || !oldTail.isConnected || oldTail.parentNode !== box) return;
        if (this.motionReduced() || document.hidden) return;
        const fresh = [];
        for (let el = oldTail.nextElementSibling; el; el = el.nextElementSibling) {
            if (el.classList.contains('msg')) fresh.push(el);
        }
        if (!fresh.length || fresh.length > 3) return;
        fresh.forEach((row, i) => {
            if (row.classList.contains('notice')) return;
            const out = row.classList.contains('out');
            const target = row.querySelector('.bubble') || row;
            target.style.transformOrigin = out ? '100% 100%' : '0% 100%';
            target.animate(
                out
                    ? [{ opacity: 0, transform: 'translateY(18px) scale(.94)' }, { opacity: 1, transform: 'none' }]
                    : [{ opacity: 0, transform: 'translateX(-14px) scale(.96)' }, { opacity: 1, transform: 'none' }],
                { duration: out ? 420 : 380, delay: i * 60, easing: 'cubic-bezier(.2,1.22,.36,1)', fill: 'backwards' },
            );
        });
    }
});
