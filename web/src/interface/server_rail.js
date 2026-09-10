// --- ZaliInterface: Лента серверов — аватарки с подсказкой и инерционной прокруткой. ---
// Часть класса ZaliInterface (см. web/src/interface.js). Лента живёт в двух местах:
// в шапке чата (десктоп, там, где раньше были пилюли каналов) и наверху сайдбара
// (телефон: у экрана-списка нет шапки чата, а выбирать сервер надо именно там).
// Каналы активного сервера при этом — список в левой колонке (renderServers).
ZaliMixin(ZaliInterface, class {

    serverRailElements() {
        return ['serverRail', 'serverRailSidebar']
            .map(id => document.getElementById(id))
            .filter(Boolean);
    }

    serverRailHTML() {
        this.ensureServersState();
        const servers = (this.S.servers || []).filter(Boolean);
        const items = servers.map(server => {
            const active = server.id === this.S.activeServer ? ' active' : '';
            // Same aggregate the old server list showed, minus voice channels: they
            // never accrue unread (see renderServerToolbar history), so counting them
            // only ever added stale zeros.
            const unread = (server.channels || []).reduce((sum, ch) => (
                this.normalizeChannelKind(ch.kind) === 'voice'
                    ? sum
                    : sum + Number(this.S.channelUnread?.[`${server.id}:${ch.id}`] || 0)
            ), 0);
            const badge = unread > 0 ? `<span class="server-rail-badge">${unread > 99 ? '99+' : unread}</span>` : '';
            return `<button class="server-rail-item${active}" type="button" data-server-id="${this.esc(server.id)}" data-rail-tip="${this.esc(server.name || 'Сервер')}" aria-label="${this.esc(server.name || 'Сервер')}">${this.renderServerAvatarHTML(server, 'server-rail-avatar')}${badge}</button>`;
        }).join('');
        const action = (cls, glyph, label) => `<button class="server-rail-item server-rail-action ${cls}" type="button" data-rail-tip="${this.esc(label)}" aria-label="${this.esc(label)}"><span class="server-avatar server-rail-avatar">${glyph}</span></button>`;
        return items
            + (servers.length ? '<span class="server-rail-sep" aria-hidden="true"></span>' : '')
            + action('server-create', '+', 'Создать сервер')
            + action('server-join', '↗', 'Войти по коду')
            + action('server-public', '☰', 'Публичные серверы');
    }

    // Called from renderServerToolbar (the choke point for server/channel/unread
    // changes) and renderServers. commitListHTML makes the common case a string
    // compare, and the track element itself is never replaced — so the scroll
    // offset, which lives in its transform, survives every re-render.
    renderServerRails() {
        const isServers = this.S.navMode === 'servers';
        const html = isServers ? this.serverRailHTML() : '';
        for (const rail of this.serverRailElements()) {
            rail.hidden = !isServers;
            const track = rail.querySelector('.server-rail-track');
            if (!track) continue;
            this.setupServerRail(rail);
            const changed = this.commitListHTML(track, `server-rail:${rail.id}`, html);
            const state = rail.__rail;
            if (!state) continue;
            if (changed) state.measure();
            const activeKey = String(this.S.activeServer || '');
            if (isServers && state.lastActive !== activeKey) {
                state.lastActive = activeKey;
                requestAnimationFrame(() => state.revealActive());
            }
        }
    }

    bindServerRailEvents() {
        for (const rail of this.serverRailElements()) {
            if (rail.__railEventsBound) continue;
            rail.__railEventsBound = true;
            rail.addEventListener('click', (e) => {
                const item = e.target.closest('.server-rail-item');
                if (!item) return;
                this.hideServerRailTip();
                if (item.classList.contains('server-create')) { this.openServerModal('create'); return; }
                if (item.classList.contains('server-join')) { this.openJoinCodeModal(); return; }
                if (item.classList.contains('server-public')) { this.openPublicServersModal(); return; }
                const serverId = item.getAttribute('data-server-id');
                if (!serverId) return;
                this.closeChatPanelModals();
                // On the phone the sidebar rail sits on the list screen: picking a
                // server there should show its channels, not jump into a chat.
                this.setActiveServer(serverId, { keepMobileList: rail.id === 'serverRailSidebar' });
            });
        }
    }

    // --- tooltip -------------------------------------------------------------
    // One element on <body>, positioned fixed: the rail clips its own overflow
    // (that is how it scrolls), so a tooltip inside it would be cut off.

    serverRailTipElement() {
        let tip = document.getElementById('serverRailTip');
        if (!tip) {
            tip = document.createElement('div');
            tip.id = 'serverRailTip';
            tip.className = 'server-rail-tip';
            tip.setAttribute('role', 'tooltip');
            document.body.appendChild(tip);
        }
        return tip;
    }

    showServerRailTip(item) {
        const label = item?.getAttribute('data-rail-tip');
        if (!label) return;
        const tip = this.serverRailTipElement();
        tip.textContent = label;
        const rect = item.getBoundingClientRect();
        const width = tip.offsetWidth;
        const half = width / 2;
        const center = Math.max(half + 8, Math.min(window.innerWidth - half - 8, rect.left + rect.width / 2));
        tip.style.left = `${Math.round(center)}px`;
        tip.style.top = `${Math.round(rect.bottom + 8)}px`;
        tip.classList.add('visible');
    }

    hideServerRailTip() {
        document.getElementById('serverRailTip')?.classList.remove('visible');
    }

    // --- physics -------------------------------------------------------------
    // The rail does not use native overflow scrolling: native scroll has no
    // overshoot on desktop and no mouse dragging at all. Position lives in the
    // track's transform; a rAF loop coasts it with friction and springs it back
    // when it has flown past an edge.

    setupServerRail(rail) {
        if (!rail || rail.__rail) return;
        const track = rail.querySelector('.server-rail-track');
        if (!track) return;
        const reduceMotion = !!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;

        // The wheel coasts a little and barely flies past the edge; a mouse or
        // finger fling carries noticeably further and stretches further.
        const WHEEL = { friction: 0.86, overshoot: 26 };
        const DRAG = { friction: 0.94, overshoot: 70 };
        const SPRING = 0.16;
        const EDGE_DAMPING = 0.62;
        const DRAG_THRESHOLD = 4;
        const MAX_VELOCITY = 70;

        const st = {
            x: 0,
            v: 0,
            max: 0,
            raf: 0,
            lastTs: 0,
            mode: WHEEL,
            target: null,
            lastActive: null,
            press: null,
            dragging: false,
            suppressClick: false,
        };

        const apply = () => {
            track.style.transform = `translate3d(${(-st.x).toFixed(2)}px, 0, 0)`;
            rail.classList.toggle('can-scroll-left', st.x > 1);
            rail.classList.toggle('can-scroll-right', st.x < st.max - 1);
        };

        st.measure = () => {
            st.max = Math.max(0, track.scrollWidth - rail.clientWidth);
            rail.classList.toggle('is-scrollable', st.max > 0);
            if (!st.raf && !st.dragging) {
                st.x = Math.max(0, Math.min(st.max, st.x));
            }
            apply();
        };

        // Past an edge the finger pulls with diminishing effect, so the track can
        // be stretched but never dragged away.
        const rubber = (value, limit) => {
            if (value >= 0 && value <= st.max) return value;
            const over = value < 0 ? -value : value - st.max;
            const eased = limit * (1 - 1 / (over / limit * 0.55 + 1));
            return value < 0 ? -eased : st.max + eased;
        };

        const step = (ts) => {
            const dt = st.lastTs ? Math.min(48, ts - st.lastTs) : 16.67;
            st.lastTs = ts;
            const k = dt / 16.67;

            if (st.target !== null) {
                const diff = st.target - st.x;
                st.x += diff * Math.min(1, 0.2 * k);
                if (Math.abs(diff) < 0.5) {
                    st.x = st.target;
                    st.target = null;
                }
            } else {
                const past = st.x < 0 ? st.x : (st.x > st.max ? st.x - st.max : 0);
                if (past !== 0) {
                    st.v *= Math.pow(EDGE_DAMPING, k);
                    st.v -= past * SPRING * k;
                } else {
                    st.v *= Math.pow(st.mode.friction, k);
                }
                const before = st.x;
                st.x += st.v * k;
                // Hard cap on how far the momentum may carry past an edge.
                const limit = st.mode.overshoot;
                if (st.x < -limit) { st.x = -limit; st.v = Math.max(0, st.v); }
                if (st.x > st.max + limit) { st.x = st.max + limit; st.v = Math.min(0, st.v); }
                // Coming back from past an edge, stop AT the edge. The spring's return
                // velocity otherwise carried on under ordinary friction and parked the
                // rail tens of pixels inside, as if it had bounced off the wall.
                if (before > st.max && st.x <= st.max) { st.x = st.max; st.v = 0; }
                if (before < 0 && st.x >= 0) { st.x = 0; st.v = 0; }
                const nowPast = st.x < 0 ? st.x : (st.x > st.max ? st.x - st.max : 0);
                if (Math.abs(st.v) < 0.05 && Math.abs(nowPast) < 0.5) {
                    st.x = Math.max(0, Math.min(st.max, st.x));
                    st.v = 0;
                }
            }
            apply();
            // Keep running while the rail is past an edge even at zero velocity: the
            // overshoot cap zeroes it right at the peak, and stopping there left the
            // rail stuck beyond its end with no spring to bring it back.
            const pastEdge = st.x < 0 || st.x > st.max;
            if (st.target !== null || st.v !== 0 || pastEdge) {
                st.raf = requestAnimationFrame(step);
            } else {
                st.raf = 0;
                st.lastTs = 0;
            }
        };

        const run = () => {
            if (reduceMotion) {
                st.x = Math.max(0, Math.min(st.max, st.target ?? (st.x + st.v * 8)));
                st.v = 0;
                st.target = null;
                apply();
                return;
            }
            if (!st.raf) {
                st.lastTs = 0;
                st.raf = requestAnimationFrame(step);
            }
        };

        st.revealActive = () => {
            st.measure();
            const item = track.querySelector('.server-rail-item.active');
            if (!item || st.max <= 0 || st.dragging) return;
            const pad = 16;
            const left = item.offsetLeft;
            const right = left + item.offsetWidth;
            const view = rail.clientWidth;
            let target = null;
            if (left - pad < st.x) target = left - pad;
            else if (right + pad > st.x + view) target = right + pad - view;
            if (target === null) return;
            st.v = 0;
            st.target = Math.max(0, Math.min(st.max, target));
            run();
        };

        rail.addEventListener('wheel', (e) => {
            st.measure();
            if (st.max <= 0) return;
            const unit = e.deltaMode === 1 ? 16 : (e.deltaMode === 2 ? rail.clientWidth : 1);
            const delta = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * unit;
            if (!delta) return;
            e.preventDefault();
            this.hideServerRailTip();
            st.target = null;
            st.mode = WHEEL;
            st.v = Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, st.v + delta * 0.16));
            run();
        }, { passive: false });

        rail.addEventListener('pointerdown', (e) => {
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            // Measured while a coast is still running, so a rail caught past its
            // edge is not first snapped back (measure only clamps a resting rail).
            st.measure();
            // Grabbing a coasting rail stops it where it is, like a real one — and
            // it has to stop HERE, not once the drag threshold is crossed: the
            // offset and pointer origin are fixed at this moment, and a drag
            // measured from a later origin loses every pixel travelled before it.
            if (st.raf) { cancelAnimationFrame(st.raf); st.raf = 0; st.lastTs = 0; }
            st.v = 0;
            st.target = null;
            st.press = {
                id: e.pointerId,
                startX: e.clientX,
                startOffset: st.x,
                samples: [{ t: e.timeStamp, x: e.clientX }],
            };
        });

        rail.addEventListener('pointermove', (e) => {
            if (e.pointerType === 'mouse' && !st.press) {
                const item = e.target.closest?.('.server-rail-item');
                if (item && !st.dragging) this.showServerRailTip(item);
            }
            const press = st.press;
            if (!press || press.id !== e.pointerId) return;
            const dx = e.clientX - press.startX;
            if (!st.dragging) {
                if (Math.abs(dx) < DRAG_THRESHOLD || st.max <= 0) return;
                // Origin and offset stay where pointerdown put them (the coast was
                // stopped there too): the pixels travelled before the threshold
                // belong to the drag, and resetting here dropped them.
                st.dragging = true;
                rail.classList.add('dragging');
                this.hideServerRailTip();
                try { rail.setPointerCapture(e.pointerId); } catch (_) {}
            }
            st.x = rubber(press.startOffset - (e.clientX - press.startX), DRAG.overshoot);
            apply();
            press.samples.push({ t: e.timeStamp, x: e.clientX });
            while (press.samples.length > 2 && e.timeStamp - press.samples[0].t > 90) press.samples.shift();
        });

        const release = (e, fling) => {
            const press = st.press;
            if (!press || press.id !== e.pointerId) return;
            st.press = null;
            if (!st.dragging) return;
            st.dragging = false;
            rail.classList.remove('dragging');
            try { rail.releasePointerCapture(e.pointerId); } catch (_) {}
            // The pointerup of a drag is followed by a click on whatever avatar the
            // pointer ended on; that click is not a choice.
            st.suppressClick = true;
            setTimeout(() => { st.suppressClick = false; }, 0);
            const first = press.samples[0];
            const last = press.samples[press.samples.length - 1];
            const dt = Math.max(1, last.t - first.t);
            const pxPerFrame = fling && e.timeStamp - last.t < 80 ? -((last.x - first.x) / dt) * 16.67 : 0;
            st.mode = DRAG;
            st.v = Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, pxPerFrame));
            run();
        };
        rail.addEventListener('pointerup', (e) => release(e, true));
        rail.addEventListener('pointercancel', (e) => release(e, false));
        rail.addEventListener('click', (e) => {
            if (!st.suppressClick) return;
            e.preventDefault();
            e.stopPropagation();
        }, true);

        rail.addEventListener('pointerleave', (e) => {
            if (e.pointerType === 'mouse') this.hideServerRailTip();
        });
        rail.addEventListener('focusin', (e) => {
            const item = e.target.closest?.('.server-rail-item');
            if (item && e.target.matches?.(':focus-visible')) this.showServerRailTip(item);
        });
        rail.addEventListener('focusout', () => this.hideServerRailTip());

        if (typeof ResizeObserver === 'function') {
            new ResizeObserver(() => st.measure()).observe(rail);
        }
        rail.__rail = st;
        st.measure();
    }
});
