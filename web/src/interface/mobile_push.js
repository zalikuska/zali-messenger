// --- ZaliInterface: экраны, открытые из Хаба, въезжают поверх него (телефон). ---
// Часть класса ZaliInterface (см. web/src/interface.js).
//
// Чат на телефоне лежит поверх списка: въезжает справа, «назад» — свайп вправо
// откуда угодно, системный жест или стрелка в шапке (mobile.js). Так же теперь
// открывается всё, что ведёт из Хаба вглубь: «Настройки» (#viewSettings), «Аддоны»,
// «Поддержка» и их вложенные страницы («Для разработчиков», страница нарушения —
// панели #viewHub [data-hub-pane]). Хаб остаётся под ними на месте, со своей
// прокруткой, и открывается из-под пальца при свайпе.
//
//  • Настройки — отдельный экран: пока он поверх, #viewHub не `.active`, а `.is-under`
//    (виден, но это не раздел), чтобы все проверки «какой экран активен» остались
//    прежними (activeMobileNavSection, handleMobileBack…).
//  • Панели хаба — слой: `hidden` снят не только у открытой панели, но и у всей цепочки
//    под ней (hubPaneChain), открытая лежит над ними `position: absolute`.
//
// Анимация — только transform (compositor): CSS-класс `hub-push-enter` на время въезда,
// жест и закрытие пишут transform инлайном, как setMobileNavProgress для #viewChat.
const HUB_PUSH_ENTER_MS = 320;
const HUB_PUSH_CLOSE_MS = 240;

ZaliMixin(ZaliInterface, class {

    /** Цепочка панелей хаба от главной до открытой: ['overview', 'addons', 'signing']. */
    hubPaneChain(tab) {
        const chains = {
            addons: ['overview', 'addons'],
            signing: ['overview', 'addons', 'signing'],
            support: ['overview', 'support'],
            violation: ['overview', 'support', 'violation'],
        };
        return chains[tab] || ['overview'];
    }

    /** Куда ведёт «назад» с панели хаба. */
    hubPaneParent(tab) {
        const chain = this.hubPaneChain(tab);
        return chain[chain.length - 2] || 'overview';
    }

    /** Телефон показывает всю цепочку (нижние панели видны под верхней), десктоп — одну. */
    syncHubPaneVisibility() {
        const tab = this._hubTab || 'overview';
        const chain = this.isMobileLayout?.() ? this.hubPaneChain(tab) : [tab];
        document.querySelectorAll('[data-hub-pane]').forEach((pane) => {
            pane.hidden = !chain.includes(pane.getAttribute('data-hub-pane'));
        });
    }

    /** Въезд слоя: класс живёт ровно столько, сколько идёт анимация. */
    mobileHubMarkEnter(el) {
        if (!el) return;
        el.classList.add('hub-push-enter');
        clearTimeout(el.__hubEnterTimer);
        el.__hubEnterTimer = setTimeout(() => el.classList.remove('hub-push-enter'), HUB_PUSH_ENTER_MS);
    }

    /** Снимает состояние «Настройки поверх Хаба». Зовут все open*View, кроме самих Настроек. */
    mobileHubPushReset() {
        const sv = document.getElementById('viewSettings');
        if (sv) {
            sv.classList.remove('is-push', 'hub-push-enter');
            sv.style.transform = '';
            sv.style.transition = '';
        }
        document.getElementById('viewHub')?.classList.remove('is-under', 'view-noenter');
    }

    /** Верхний слой, который закрывает «назад»: { el, kind: 'settings' | 'pane', tab } или null. */
    mobileHubTopLayer() {
        if (!this.isMobileLayout?.()) return null;
        const sv = document.getElementById('viewSettings');
        if (sv?.classList.contains('active') && sv.classList.contains('is-push')) {
            return { el: sv, kind: 'settings' };
        }
        const hv = document.getElementById('viewHub');
        if (hv?.classList.contains('active')) {
            const tab = hv.getAttribute('data-hub-current') || 'overview';
            if (tab !== 'overview') {
                const pane = hv.querySelector(`[data-hub-pane="${tab}"]`);
                if (pane && !pane.hidden) return { el: pane, kind: 'pane', tab };
            }
        }
        return null;
    }

    /**
     * Слой уезжает вправо, и по окончании состояние переключается по-настоящему.
     * Из жеста стартует с текущего положения (transform уже записан инлайном).
     */
    mobileHubClose(layer = this.mobileHubTopLayer()) {
        if (!layer || layer.el.__hubClosing) return false;
        const el = layer.el;
        el.__hubClosing = true;
        el.classList.remove('hub-push-enter');
        clearTimeout(el.__hubEnterTimer);
        let timer = 0;
        const finish = () => {
            if (!el.__hubClosing) return;
            el.__hubClosing = false;
            clearTimeout(timer);
            el.removeEventListener('transitionend', onEnd);
            if (layer.kind === 'settings') this.openHubView();
            else this.setHubTab(this.hubPaneParent(layer.tab));
            el.style.transition = '';
            el.style.transform = '';
        };
        const onEnd = (e) => {
            if (e.target === el && e.propertyName === 'transform') finish();
        };
        el.addEventListener('transitionend', onEnd);
        timer = setTimeout(finish, HUB_PUSH_CLOSE_MS + 120);
        el.style.transition = `transform ${HUB_PUSH_CLOSE_MS}ms cubic-bezier(.2,.8,.2,1)`;
        // Без сброса стилей transition стартовал бы не от текущего положения.
        void el.offsetWidth;
        el.style.transform = 'translateX(100%)';
        return true;
    }

    /** Кнопка «Назад в …» на панели: закрывает верхнюю панель с анимацией, если она ведёт туда. */
    mobileHubPopTo(target) {
        const layer = this.mobileHubTopLayer();
        if (!layer || layer.kind !== 'pane') return false;
        if (this.hubPaneParent(layer.tab) !== target) return false;
        return this.mobileHubClose(layer);
    }

    // Свайп вправо откуда угодно на верхнем слое — назад, слой едет за пальцем. Зеркало
    // жеста чата (setupMobileNavGestures): вертикаль отдана прокрутке, слушатели
    // пассивные, горизонтальные прокрутки и поля ввода жест не начинают.
    setupMobileHubPushGesture() {
        if (this.__hubPushGestureBound) return;
        this.__hubPushGestureBound = true;
        const LOCK_SLOP = 10;
        const OWN_GESTURE = 'input, textarea, select, [contenteditable="true"], pre, video[controls], '
            + '.server-rail, [data-no-swipe]';
        let mode = null;            // null | 'pending' | 'back'
        let layer = null;
        let startX = 0;
        let startY = 0;
        let dx = 0;
        let width = 1;
        let velocity = 0;
        let lastT = 0;
        let lastDx = 0;

        // Полоса категорий настроек, фильтры магазина и т.п. листаются вбок сами.
        const scrollsSideways = (node, boundary) => {
            for (let el = node; el && el !== boundary && el.nodeType === 1; el = el.parentElement) {
                if (el.scrollWidth > el.clientWidth + 1) {
                    const overflowX = getComputedStyle(el).overflowX;
                    if (overflowX === 'auto' || overflowX === 'scroll') return true;
                }
            }
            return false;
        };

        const reset = () => {
            mode = null;
            layer = null;
            dx = 0;
            velocity = 0;
            lastT = 0;
            lastDx = 0;
        };

        const onStart = (e) => {
            reset();
            if (!this.isMobileLayout?.() || e.touches.length !== 1) return;
            const top = this.mobileHubTopLayer();
            if (!top || top.el.__hubClosing || !top.el.contains(e.target)) return;
            if (e.target.closest?.(OWN_GESTURE) || scrollsSideways(e.target, top.el)) return;
            const touch = e.touches[0];
            layer = top;
            mode = 'pending';
            startX = touch.clientX;
            startY = touch.clientY;
            width = window.innerWidth || 1;
        };

        const onMove = (e) => {
            if (!mode) return;
            if (e.touches.length !== 1) { this.__hubPushSettle(layer, false); reset(); return; }
            const touch = e.touches[0];
            const mx = touch.clientX - startX;
            const my = touch.clientY - startY;
            if (mode === 'pending') {
                if (Math.abs(my) >= LOCK_SLOP && Math.abs(my) >= Math.abs(mx)) { reset(); return; }
                if (Math.abs(mx) < LOCK_SLOP || Math.abs(mx) < Math.abs(my) * 1.3) return;
                if (mx < 0) { reset(); return; }
                mode = 'back';
                layer.el.classList.remove('hub-push-enter');
                layer.el.style.transition = 'none';
                // Отсчёт пути — от точки выбора направления, без скачка на LOCK_SLOP.
                startX = touch.clientX;
                return;
            }
            const now = e.timeStamp || Date.now();
            dx = Math.max(0, touch.clientX - startX);
            if (lastT && now > lastT) velocity = (dx - lastDx) / (now - lastT); // px/ms
            lastT = now;
            lastDx = dx;
            layer.el.style.transform = `translateX(${dx.toFixed(1)}px)`;
        };

        const onEnd = (cancelled) => {
            if (mode !== 'back') { reset(); return; }
            // Быстрый смах подтверждает «назад» и на коротком пути; иначе решает
            // положение (40% ширины) — как у чата.
            const close = !cancelled && (velocity > 0.45 || dx > width * 0.4);
            const target = layer;
            reset();
            if (close) this.mobileHubClose(target);
            else this.__hubPushSettle(target, true);
        };

        for (const id of ['viewHub', 'viewSettings']) {
            const host = document.getElementById(id);
            if (!host) continue;
            host.addEventListener('touchstart', onStart, { passive: true });
            host.addEventListener('touchmove', onMove, { passive: true });
            host.addEventListener('touchend', () => onEnd(false), { passive: true });
            host.addEventListener('touchcancel', () => onEnd(true), { passive: true });
        }
    }

    /** Жест не дотянул: слой возвращается на место. */
    __hubPushSettle(layer, animate) {
        const el = layer?.el;
        if (!el) return;
        const clear = () => { el.style.transition = ''; el.style.transform = ''; };
        if (!animate) { clear(); return; }
        el.style.transition = 'transform .22s cubic-bezier(.2,.8,.2,1)';
        el.style.transform = 'translateX(0)';
        setTimeout(clear, 260);
    }
});
