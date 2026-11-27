// --- ZaliInterface: «в сети» у собеседников (server/src/presence.rs). ---
// Часть класса ZaliInterface (см. web/src/interface.js).
//
// Точка на аватарке в списке чатов, в шапке чата и в участниках сервера — то же, что своя точка на
// аватарке в сайдбаре (device_activity.js): сплошной акцент — в сети, луна с
// фазами — в сети, но давно ничего не делает (ME_MOON_PHASES), нет точки — не в
// сети или сервер о человеке не рассказывает (видят только связанные люди: контакты,
// собеседники по личке, друзья, соседи по серверам).
//
// Откуда данные: снимок `GET /api/presence` при подключении сокета, раз в минуту
// (фазы луны растут сами, полуоткрытый сокет собеседника гаснет только по опросу) и
// при возврате на вкладку; переходы «вошёл / вышел / вернулся» сервер присылает сам
// кадром `user_presence` (dispatchRealtimeEvent). Старый сервер без маршрута
// отвечает 404 — тогда точек просто нет, до следующего подключения.
ZaliMixin(ZaliInterface, class {
    presenceMap() {
        if (!this.S.presence || typeof this.S.presence !== 'object') this.S.presence = {};
        return this.S.presence;
    }

    /** {state: 'on'|'idle', phase, idleMinutes} или null — не в сети / неизвестно. */
    presenceFor(username) {
        const name = String(username || '').trim();
        if (!name) return null;
        let idleMinutes;
        if (name === (this.myName?.() || '')) {
            // Своя строка (участники сервера) — то же, что точка на своей аватарке.
            if (this.S.wsOn !== true) return null;
            idleMinutes = this.meIdleMinutes?.() ?? 0;
        } else {
            const entry = this.presenceMap()[name];
            if (!entry) return null;
            idleMinutes = Math.max(0, Number(entry.idleMinutes) || 0);
        }
        const phase = ZaliInterface.ME_MOON_PHASES.filter(minutes => idleMinutes >= minutes).length;
        return { state: phase > 0 ? 'idle' : 'on', phase, idleMinutes };
    }

    presenceLabel(presence) {
        if (!presence) return '';
        return presence.state === 'idle' ? `неактивен ${this.formatMeIdle(presence.idleMinutes)}` : 'в сети';
    }

    presenceDotHTML(username) {
        const presence = this.presenceFor(username);
        if (!presence) return '';
        const phase = presence.state === 'idle' ? ` data-phase="${this.esc(String(presence.phase))}"` : '';
        return `<span class="presence-dot ${this.esc(presence.state)}"${phase} aria-hidden="true"></span>`;
    }

    /**
     * Аватарка строки списка с точкой: точка — соседка аватарки, потому что .ava
     * обрезает содержимое. data-presence-user — чтобы updatePresenceSlots мог
     * обновить точку на месте, не перерисовывая список.
     */
    presenceAvatarSlotHTML(username, avatarHTML) {
        const dot = this.presenceDotHTML(username);
        return `<div class="ava-slot${dot ? ' has-presence' : ''}" data-presence-user="${this.esc(String(username || ''))}">${avatarHTML}${dot}</div>`;
    }

    /**
     * Обновить точки в уже нарисованных слотах внутри root. Для списков, которые
     * перерисовываются целиком через innerHTML (участники сервера): полная
     * перерисовка на каждую перемену статуса закрыла бы открытый выбор роли.
     */
    updatePresenceSlots(root) {
        if (!root?.querySelectorAll) return;
        for (const slot of root.querySelectorAll('.ava-slot[data-presence-user]')) {
            const presence = this.presenceFor(slot.dataset.presenceUser);
            let dot = slot.querySelector(':scope > .presence-dot');
            slot.classList.toggle('has-presence', !!presence);
            if (!presence) {
                dot?.remove();
                continue;
            }
            if (!dot) {
                dot = document.createElement('span');
                dot.setAttribute('aria-hidden', 'true');
                slot.appendChild(dot);
            }
            const cls = `presence-dot ${presence.state}`;
            if (dot.className !== cls) dot.className = cls;
            const phase = presence.state === 'idle' ? String(presence.phase) : '';
            if ((dot.dataset.phase || '') !== phase) {
                if (phase) dot.dataset.phase = phase;
                else delete dot.dataset.phase;
            }
        }
    }

    // ------------------------------------------------------------
    // Данные
    // ------------------------------------------------------------

    async refreshPresence() {
        this.installPresencePolling();
        if (this._presenceInFlight || this._presenceUnsupported) return;
        // Статус сокета ещё неизвестен (оболочка не успела сказать) — не повод жить без точек:
        // сервер отдаёт снимок по HTTP. Не спрашиваем, только когда сокет точно лежит.
        if (!this.S.session?.token || this.S.wsOn === false) return;
        this._presenceInFlight = true;
        try {
            const res = await this.apiFetch(this.apiRoutes.presence);
            if (res.status === 404) {
                this._presenceUnsupported = true;
                this.setPresenceMap({});
                return;
            }
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            const users = data?.users && typeof data.users === 'object' ? data.users : {};
            const me = this.myName?.() || '';
            const next = {};
            for (const [name, raw] of Object.entries(users)) {
                if (!name || name === me) continue;
                next[name] = { idleMinutes: Math.max(0, Number(raw?.idleMinutes) || 0) };
            }
            this.setPresenceMap(next);
        } catch (e) {
            this.trace?.(`refreshPresence failed: ${e?.message || e}`);
        } finally {
            this._presenceInFlight = false;
        }
    }

    handlePresenceRealtime(payload) {
        const name = String(payload?.username || '').trim();
        if (!name || name === (this.myName?.() || '')) return;
        const next = { ...this.presenceMap() };
        if (payload.online === true) next[name] = { idleMinutes: Math.max(0, Number(payload.idleMinutes) || 0) };
        else delete next[name];
        this.setPresenceMap(next);
    }

    /** Заменить снимок и перерисовать, только если видимое что-то поменялось. */
    setPresenceMap(next) {
        // Минуты простоя видны в подписи шапки («неактивен 20 мин»), поэтому входят в ключ.
        const key = (map) => Object.keys(map).sort()
            .map(name => `${name}:${Number(map[name]?.idleMinutes) || 0}`)
            .join('|');
        const before = key(this.presenceMap());
        this.S.presence = next;
        if (key(next) !== before) this.schedulePresenceRender();
    }

    /** Сокет упал: о других мы больше ничего не знаем. Короткий реконнект точки не гасит. */
    onPresenceConnectionChange(connected) {
        clearTimeout(this._presenceStaleTimer);
        if (connected) {
            this._presenceUnsupported = false;
            void this.refreshPresence();
            return;
        }
        this._presenceStaleTimer = setTimeout(() => {
            if (!this.S.wsOn) this.setPresenceMap({});
        }, ZaliInterface.PRESENCE_STALE_MS);
    }

    installPresencePolling() {
        if (this._presencePollingInstalled) return;
        if (typeof window === 'undefined' || typeof document === 'undefined') return;
        this._presencePollingInstalled = true;
        setInterval(() => {
            if (!document.hidden) void this.refreshPresence();
        }, ZaliInterface.PRESENCE_POLL_MS);
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) void this.refreshPresence();
        });
    }

    // ------------------------------------------------------------
    // Отрисовка
    // ------------------------------------------------------------

    schedulePresenceRender() {
        if (this._presenceRenderQueued) return;
        this._presenceRenderQueued = true;
        const run = () => {
            this._presenceRenderQueued = false;
            try {
                if (this.S.navMode !== 'servers') this.renderContacts();
                this.updateChatHeaderPresence();
                this.updatePresenceSlots(document.getElementById('serverMembersList'));
                if (this.S.navMode !== 'servers' && this.S.current) {
                    this.updateChatHeaderCryptoKey({ peer: this.S.current });
                }
            } catch (e) {
                this.trace?.(`presence render failed: ${e?.message || e}`);
            }
        };
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
        else setTimeout(run, 0);
    }

    /** Точка на аватарке в шапке — только у лички. */
    updateChatHeaderPresence() {
        const slot = document.getElementById('chatHdrAvaSlot');
        const dot = document.getElementById('chatHdrPresence');
        if (!slot || !dot) return;
        const peer = this.S.navMode !== 'servers' ? String(this.S.current || '') : '';
        const presence = peer ? this.presenceFor(peer) : null;
        const cls = 'presence-dot' + (presence ? ` ${presence.state}` : '');
        if (dot.className !== cls) dot.className = cls;
        if (dot.hidden === !!presence) dot.hidden = !presence;
        const phase = presence?.state === 'idle' ? String(presence.phase) : '';
        if ((dot.dataset.phase || '') !== phase) {
            if (phase) dot.dataset.phase = phase;
            else delete dot.dataset.phase;
        }
        slot.classList.toggle('has-presence', !!presence);
    }

    /** Подпись под именем в шапке лички, когда строка свободна: «в сети» / «неактивен 20 мин». */
    chatHeaderPresenceHTML(peer) {
        const presence = this.presenceFor(peer);
        if (!presence) return '';
        const cls = presence.state === 'on' ? 'chat-hdr-presence is-online' : 'chat-hdr-presence';
        return `<span class="${this.esc(cls)}">${this.esc(this.presenceLabel(presence))}</span>`;
    }
});

ZaliInterface.PRESENCE_POLL_MS = 60 * 1000;
ZaliInterface.PRESENCE_STALE_MS = 30 * 1000;
