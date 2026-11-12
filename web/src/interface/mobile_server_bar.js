// --- ZaliInterface: Телефон — слот «шапка сервера ↔ лента серверов» над каналами. ---
// Часть класса ZaliInterface (см. web/src/interface.js).
//
// На экране каналов (телефон) сверху один слот (#mobileServerBar): обычно в нём
// шапка выбранного сервера (#mobileServerCard: «↶», аватарка, имя, меню), по
// кнопке «↶» — лента выбора серверов (#serverRailSidebar). Обе лежат в одной
// ячейке сетки, и переход между ними — общий элемент: аватарка сервера.
//
//   шапка → лента: лента появляется так, что аватарка выбранного сервера стоит
//     ровно там, где была в шапке (лента при этом может оказаться за своим
//     краем); остальные аватарки проявляются, шапка гаснет, а за 500 мс лента
//     доезжает до допустимого положения — «отскакивает» в норму.
//   лента → шапка (выбор сервера): наоборот — лента едет так, что выбранная
//     аватарка приходит на место аватарки шапки, остальные гаснут, шапка нового
//     сервера проявляется вокруг неё; за те же 500 мс старые каналы уходят, а
//     новые входят лесенкой со стороны, где сервер стоял в ленте.
//
// Это единственное место, где смена содержимого при навигации анимируется
// (docs/UI_GUIDELINES.md, §5): переход запущен человеком явно, длится ровно
// MOBILE_SERVER_BAR_MS и ничего не перерисовывает повторно. С reduced-motion —
// мгновенная смена.
ZaliMixin(ZaliInterface, class {

    static get MOBILE_SERVER_BAR_MS() { return 500; }
    static get MOBILE_SERVER_BAR_EASE() { return 'cubic-bezier(.2,.8,.2,1)'; }

    mobileServerBarElements() {
        return {
            bar: document.getElementById('mobileServerBar'),
            rail: document.getElementById('serverRailSidebar'),
            card: document.getElementById('mobileServerCard'),
        };
    }

    /** Без выбранного сервера шапке показать нечего — тогда только выбор. */
    mobileServerBarMode() {
        if (!this.currentServer()) return 'picker';
        return this.S.mobileServerBar === 'picker' ? 'picker' : 'header';
    }

    syncMobileServerBar() {
        const { bar } = this.mobileServerBarElements();
        if (!bar || bar.__animating) return;
        const mode = this.mobileServerBarMode();
        bar.classList.toggle('is-picker', mode === 'picker');
        bar.classList.toggle('is-header', mode === 'header');
    }

    mobileServerBarAnimated() {
        return this.isMobileLayout()
            && typeof Element.prototype.animate === 'function'
            && !window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    }

    /**
     * Кольцо выбора у едущей аватарки проявляется/гаснет вместе с переходом, а
     * не скачком в последнем кадре: у аватарки шапки кольца нет.
     */
    mobileServerBarRing(ava) {
        const ring = getComputedStyle(ava).boxShadow;
        const none = '0 0 0 2px rgba(0,0,0,0), 0 0 0 4px rgba(0,0,0,0)';
        return { ring: ring && ring !== 'none' ? ring : none, none };
    }

    /** Начало перехода: оба слоя видны и лежат друг на друге, касания — мимо. */
    beginMobileServerBarTransition(bar, kind) {
        bar.__animating = true;
        bar.classList.add('is-animating', kind);
        let finished = false;
        const animations = [];
        const cleanups = [];
        const finish = () => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            animations.forEach(animation => { try { animation.cancel(); } catch (e) { /* уже снят */ } });
            cleanups.forEach(fn => { try { fn(); } catch (e) { /* узел уже заменён */ } });
            bar.__animating = false;
            bar.classList.remove('is-animating', kind);
            this.syncMobileServerBar();
        };
        // Страховка: в скрытом окне кадров нет, и твин ленты может не доиграть.
        const timer = setTimeout(finish, ZaliInterface.MOBILE_SERVER_BAR_MS + 200);
        return { finish, animations, cleanups };
    }

    // ── шапка → лента ────────────────────────────────────────────────────

    openMobileServerPicker() {
        const { bar, rail, card } = this.mobileServerBarElements();
        if (!bar || bar.__animating || this.mobileServerBarMode() === 'picker') return;
        const st = rail?.__rail;
        const cardAva = card?.querySelector('.m-server-card-ava');
        const from = cardAva?.getBoundingClientRect();
        this.S.mobileServerBar = 'picker';
        if (!st || !from || !from.width || !this.mobileServerBarAnimated()) {
            this.syncMobileServerBar();
            st?.measure();
            st?.revealActive();
            return;
        }

        const ms = ZaliInterface.MOBILE_SERVER_BAR_MS;
        const easing = ZaliInterface.MOBILE_SERVER_BAR_EASE;
        const run = this.beginMobileServerBarTransition(bar, 'is-opening');
        bar.classList.remove('is-header');
        bar.classList.add('is-picker');
        st.measure();
        const item = rail.querySelector('.server-rail-item.active');
        const ava = item?.querySelector('.server-rail-avatar');
        if (!item || !ava) { run.finish(); return; }

        // Положение ленты, при котором центр выбранной аватарки совпадает с
        // центром аватарки шапки. Может выйти за края — так и задумано.
        const railLeft = rail.getBoundingClientRect().left;
        const itemCenter = railLeft + item.offsetLeft + item.offsetWidth / 2;
        const startX = itemCenter - (from.left + from.width / 2);
        st.placeAt(startX);
        st.lastActive = String(this.S.activeServer || '');

        cardAva.style.visibility = 'hidden';
        run.cleanups.push(() => { cardAva.style.visibility = ''; });
        const scale = from.width / (ava.getBoundingClientRect().width || from.width);
        // Конец перехода — по аватарке (ровно ms), а не по ленте: когда отскок
        // не нужен, лента «доезжает» мгновенно и оборвала бы проявление.
        const { ring, none } = this.mobileServerBarRing(ava);
        const lead = ava.animate(
            [{ transform: `scale(${scale})`, boxShadow: none }, { transform: 'none', boxShadow: ring }],
            { duration: ms, easing },
        );
        lead.onfinish = run.finish;
        run.animations.push(lead);
        rail.querySelectorAll('.server-rail-item:not(.active), .server-rail-sep').forEach(el => {
            run.animations.push(el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms * 0.6, easing }));
        });
        run.animations.push(card.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms * 0.5, easing, fill: 'forwards' }));
        // «Отскок в норму»: из положения шапки — в ближайшее допустимое, за 500 мс.
        st.glideTo(st.clamp(startX), ms);
    }

    // ── лента → шапка ────────────────────────────────────────────────────

    /** «Назад» на телефоне при открытой ленте — свернуть её в шапку текущего сервера. */
    closeMobileServerPicker() {
        if (this.mobileServerBarMode() !== 'picker' || !this.currentServer()) return false;
        this.selectServerFromMobileBar(this.S.activeServer);
        return true;
    }

    selectServerFromMobileBar(serverId) {
        const sid = String(serverId || '').trim();
        const { bar, rail, card } = this.mobileServerBarElements();
        if (!sid || !bar) return;
        if (bar.__animating) return;
        const servers = (this.S.servers || []).filter(Boolean);
        const prevId = String(this.S.activeServer || '');
        const changing = sid !== prevId;
        const st = rail?.__rail;
        const animate = !!st && this.mobileServerBarAnimated();
        const contacts = document.getElementById('contacts');
        const oldList = changing && animate ? contacts?.querySelector('.sidebar-channel-list')?.cloneNode(true) : null;
        const oldScroll = contacts?.scrollTop || 0;
        const indexOf = (id) => servers.findIndex(server => server.id === id);
        const dir = indexOf(sid) >= indexOf(prevId) ? 1 : -1;

        this.S.mobileServerBar = 'header';
        // Своё движение ленты здесь — не даём renderServerRails «довести» её до
        // выбранной аватарки поверх нашего перехода.
        if (st) st.lastActive = sid;
        const run = animate ? this.beginMobileServerBarTransition(bar, 'is-closing') : null;
        if (changing) {
            this.setActiveServer(sid, { keepMobileList: true });
            if (contacts) contacts.scrollTop = 0;
        }
        if (!run) {
            this.syncMobileServerBar();
            return;
        }
        bar.classList.remove('is-picker');
        bar.classList.add('is-header');

        // Узлы — после перерисовки: смена активного сервера пересобрала ленту.
        const item = rail.querySelector(`.server-rail-item[data-server-id="${CSS.escape(sid)}"]`);
        const ava = item?.querySelector('.server-rail-avatar');
        const cardAva = card?.querySelector('.m-server-card-ava');
        if (!item || !ava || !cardAva || card.hidden) { run.finish(); return; }

        const ms = ZaliInterface.MOBILE_SERVER_BAR_MS;
        const easing = ZaliInterface.MOBILE_SERVER_BAR_EASE;
        const to = cardAva.getBoundingClientRect();
        const now = ava.getBoundingClientRect();
        const delta = (now.left + now.width / 2) - (to.left + to.width / 2);

        cardAva.style.visibility = 'hidden';
        run.cleanups.push(() => { cardAva.style.visibility = ''; });
        // Лента уходит из вида — следующее её открытие начнётся с допустимого положения.
        run.cleanups.push(() => st.placeAt(st.clamp(st.x)));
        const { ring, none } = this.mobileServerBarRing(ava);
        const lead = ava.animate(
            [{ transform: 'none', boxShadow: ring }, { transform: `scale(${to.width / (now.width || to.width)})`, boxShadow: none }],
            { duration: ms, easing, fill: 'forwards' },
        );
        lead.onfinish = run.finish;
        run.animations.push(lead);
        rail.querySelectorAll('.server-rail-item, .server-rail-sep').forEach(el => {
            if (el === item) return;
            // Гаснут раньше, чем проявится шапка: лента лежит над ней, и
            // недогоревшие аватарки просвечивали бы сквозь имя сервера.
            run.animations.push(el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms * 0.3, easing, fill: 'forwards' }));
        });
        run.animations.push(card.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms * 0.6, delay: ms * 0.2, easing, fill: 'backwards' }));
        st.glideTo(st.x + delta, ms);
        if (oldList) this.animateMobileChannelSwap(oldList, oldScroll, dir, ms);
    }

    /**
     * Замена списка каналов за время перехода: снимок старого списка уходит в
     * сторону и гаснет, новые строки входят лесенкой с противоположной стороны.
     * Последняя строка заканчивает ровно к концу перехода (задержка ≤ 40 %).
     */
    animateMobileChannelSwap(oldList, oldScroll, dir, ms) {
        const box = document.getElementById('contacts');
        if (!box) return;
        const easing = ZaliInterface.MOBILE_SERVER_BAR_EASE;
        const cs = getComputedStyle(box);
        box.classList.add('is-swapping');
        oldList.classList.add('m-channel-ghost');
        oldList.setAttribute('aria-hidden', 'true');
        oldList.style.top = `${parseFloat(cs.paddingTop) - oldScroll}px`;
        oldList.style.left = cs.paddingLeft;
        oldList.style.right = cs.paddingRight;
        box.prepend(oldList);
        const shift = 28;
        const ghost = oldList.animate(
            [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translateX(${-dir * shift}px)` }],
            { duration: ms * 0.3, easing, fill: 'forwards' },
        );
        const cleanup = () => {
            oldList.remove();
            box.classList.remove('is-swapping');
        };
        ghost.onfinish = cleanup;
        setTimeout(cleanup, ms + 200);

        // Новые строки стартуют, когда старые уже почти погасли (12 % перехода),
        // и последняя заканчивает ровно к концу: старт ≤ 50 %, длина 50 %.
        const fresh = box.querySelector('.sidebar-channel-list:not(.m-channel-ghost)');
        const rows = fresh ? Array.from(fresh.children) : Array.from(box.children).filter(el => el !== oldList);
        const first = ms * 0.12;
        const step = rows.length > 1 ? Math.min(40, (ms * 0.5 - first) / (rows.length - 1)) : 0;
        rows.forEach((row, index) => {
            row.animate(
                [{ opacity: 0, transform: `translateX(${dir * shift}px)` }, { opacity: 1, transform: 'none' }],
                { duration: ms * 0.5, delay: first + index * step, easing, fill: 'backwards' },
            );
        });
    }
});
