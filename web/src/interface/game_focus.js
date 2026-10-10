// --- ZaliInterface: Режим «в игре» — отложенные и тихие уведомления о сообщениях. ---
// Часть класса ZaliInterface (см. web/src/interface.js). Серверная половина и
// инварианты — server/src/focus.rs; определение игры — game_activity.js.
//
// Кто что решает:
//  - СЕРВЕР: настройки хранит он (`/api/game-focus`, чтобы режим одинаково
//    работал на всех устройствах и для пушей), он же решает, подпадает ли
//    конкретное сообщение под режим. Клиент ничего не вычисляет сам.
//  - ПОЛУЧАТЕЛЬ: перед сообщением приходит `notify_policy {messageId, mode}`.
//    notifyBackgroundMessage (notifications.js) спрашивает takeFocusPolicy():
//    `silent` — уведомление без звука, `defer` — тост не показывается, сообщение
//    ждёт в очереди до `focus_flush` (конец игровой сессии) или `notify_now`.
//    Сообщение при этом уже в чате, счётчик непрочитанного растёт.
//  - ОТПРАВИТЕЛЬ: `delivery_note` — заметка над полем ввода с кнопкой «Всё равно
//    оповестить» (`POST /api/message/:id/notify-now`). Названия игры в ней нет.
ZaliMixin(ZaliInterface, class {

    // ------------------------------------------------------------
    // Настройки
    // ------------------------------------------------------------

    gameFocusDefaults() {
        return { mode: 'off', audience: 'everyone', games: [], people: [] };
    }

    gameFocusSettings() {
        return this._gameFocus || this.gameFocusDefaults();
    }

    // Режим работает только при включённой «игре»: режим «выключено» и
    // аудитория «никому» — одно и то же.
    gameFocusEnabled() {
        const settings = this.gameFocusSettings();
        return settings.mode !== 'off' && settings.audience !== 'nobody';
    }

    normalizeGameFocus(raw) {
        const defaults = this.gameFocusDefaults();
        const modes = ['off', 'defer', 'silent'];
        const audiences = ['everyone', 'friends', 'only', 'except', 'nobody'];
        return {
            mode: modes.includes(raw?.mode) ? raw.mode : defaults.mode,
            audience: audiences.includes(raw?.audience) ? raw.audience : defaults.audience,
            games: Array.isArray(raw?.games) ? raw.games.map(String).filter(Boolean) : [],
            people: Array.isArray(raw?.people) ? raw.people.map(String).filter(Boolean) : [],
        };
    }

    async loadGameFocusSettings() {
        if (!this.S.session?.token) return;
        const user = this.myName?.() || '';
        try {
            const res = await this.apiFetch('/api/game-focus');
            if (!res.ok) return;
            // Пока шёл запрос, мог смениться аккаунт.
            if ((this.myName?.() || '') !== user) return;
            this._gameFocus = this.normalizeGameFocus(await res.json());
            this._gameFocusLoadedFor = user;
        } catch (e) {
            this.trace?.(`loadGameFocusSettings failed: ${e?.message || e}`);
            return;
        }
        this.afterGameFocusChanged();
    }

    // Режим включили/выключили — определение игры должно работать (или нет) и
    // тогда, когда показ статуса другим выключен.
    afterGameFocusChanged() {
        this.syncGameDetector?.();
        this.publishGameActivity?.({ force: true });
        this.renderGameFocusSettings();
    }

    async saveGameFocusSettings(patch = {}) {
        const previous = this.gameFocusSettings();
        const next = this.normalizeGameFocus({ ...previous, ...patch });
        this._gameFocus = next;
        this._gameFocusError = '';
        this.afterGameFocusChanged();
        try {
            const res = await this.apiFetch('/api/game-focus', {
                method: 'PUT',
                body: JSON.stringify(next),
                interactive: true,
            });
            if (!res.ok) throw new Error(res.status === 400 ? 'Сервер не принял настройки' : `Ошибка ${res.status}`);
            this._gameFocus = this.normalizeGameFocus(await res.json());
        } catch (e) {
            // Не сохранилось — вернуть прежнее, а не показывать то, чего на сервере нет.
            this._gameFocus = previous;
            this._gameFocusError = e?.message || String(e);
        }
        this.afterGameFocusChanged();
    }

    gameFocusAudienceLabel(value) {
        return ({
            everyone: 'Всем',
            friends: 'Только друзьям',
            only: 'Только выбранным людям',
            except: 'Всем, кроме выбранных',
            nobody: 'Никому',
        })[value] || value;
    }

    renderGameFocusSettings() {
        const card = document.getElementById('gameFocusSettingsCard');
        if (!card) return;
        const s = this.gameFocusSettings();
        const set = (id, fn) => { const el = document.getElementById(id); if (el) fn(el); };
        set('inputGameFocusMode', el => { el.value = s.mode; });
        set('inputGameFocusAudience', el => { el.value = s.audience; });
        set('gameFocusScope', el => { el.hidden = s.mode === 'off'; });
        set('gameFocusPeopleBox', el => { el.hidden = !(s.audience === 'only' || s.audience === 'except'); });
        set('gameFocusPeopleTitle', el => {
            el.textContent = s.audience === 'except' ? 'Не применять к этим людям' : 'Применять только к этим людям';
        });
        const chips = (items, attr) => items.length
            ? items.map(item => `<button type="button" class="btn-flat game-focus-chip" ${attr}="${this.esc(item)}" title="Убрать">${this.esc(item)} ×</button>`).join(' ')
            : '';
        set('gameFocusGamesList', el => this.setHTMLIfChanged(el, chips(s.games, 'data-game-focus-game')));
        set('gameFocusPeopleList', el => this.setHTMLIfChanged(el, chips(s.people, 'data-game-focus-person')));
        set('gameFocusGamesHint', el => {
            el.textContent = s.games.length
                ? 'Режим действует только в этих играх.'
                : 'Список пуст — режим действует в любой игре.';
        });
        set('gameFocusOptions', el => {
            const html = this.gameCatalog().map(([name]) => `<option value="${this.esc(name)}"></option>`).join('');
            this.setHTMLIfChanged(el, html);
        });
        set('gameFocusStatusText', el => {
            if (this._gameFocusError) {
                el.textContent = `Не сохранено: ${this._gameFocusError}`;
                return;
            }
            if (s.mode === 'off') {
                el.textContent = 'Выключено: уведомления приходят как обычно, даже когда вы в игре.';
                return;
            }
            const how = s.mode === 'defer'
                ? 'уведомления будут отложены до конца игровой сессии'
                : 'уведомления будут приходить без звука';
            const who = ({
                everyone: 'от всех',
                friends: 'от друзей',
                only: `только от выбранных (${s.people.length})`,
                except: `от всех, кроме выбранных (${s.people.length})`,
                nobody: '',
            })[s.audience];
            const needs = this.gameActivityDetectionSupported?.() || this.gameActivityPrefs?.().manual
                ? ''
                : ' Игру в браузере не определить — укажите её вручную в карточке «Игровой статус».';
            el.textContent = s.audience === 'nobody'
                ? 'Аудитория «Никому» — режим фактически выключен.'
                : `Когда вы в игре, ${how} ${who}.${needs}`;
        });
    }

    bindGameFocusSettings() {
        const byId = (id) => document.getElementById(id);
        byId('inputGameFocusMode')?.addEventListener('change', (event) => {
            void this.saveGameFocusSettings({ mode: event.target.value });
        });
        byId('inputGameFocusAudience')?.addEventListener('change', (event) => {
            void this.saveGameFocusSettings({ audience: event.target.value });
        });
        const addFrom = (inputId, key, normalize) => {
            const input = byId(inputId);
            if (!input) return;
            const commit = () => {
                const value = normalize(input.value);
                input.value = '';
                if (!value) return;
                const list = this.gameFocusSettings()[key];
                if (list.some(item => item.toLowerCase() === value.toLowerCase())) return;
                void this.saveGameFocusSettings({ [key]: [...list, value] });
            };
            input.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    commit();
                }
            });
            input.addEventListener('change', commit);
        };
        addFrom('inputGameFocusGame', 'games', (v) => String(v || '').trim().slice(0, 64));
        addFrom('inputGameFocusPerson', 'people', (v) => String(v || '').trim().replace(/^@/, '').slice(0, 64));
        byId('gameFocusCurrentGameBtn')?.addEventListener('click', () => {
            const name = this.effectiveGameActivity?.()?.name || this._detectedGame?.name;
            if (!name) return;
            const list = this.gameFocusSettings().games;
            if (list.some(item => item.toLowerCase() === name.toLowerCase())) return;
            void this.saveGameFocusSettings({ games: [...list, name] });
        });
        const removeFrom = (boxId, attr, key) => {
            byId(boxId)?.addEventListener('click', (event) => {
                const button = event.target.closest?.(`[${attr}]`);
                if (!button) return;
                const value = button.getAttribute(attr);
                void this.saveGameFocusSettings({
                    [key]: this.gameFocusSettings()[key].filter(item => item !== value),
                });
            });
        };
        removeFrom('gameFocusGamesList', 'data-game-focus-game', 'games');
        removeFrom('gameFocusPeopleList', 'data-game-focus-person', 'people');
    }

    // ------------------------------------------------------------
    // Получатель
    // ------------------------------------------------------------

    focusPolicyMap() {
        if (!this._focusPolicies) this._focusPolicies = new Map();
        return this._focusPolicies;
    }

    rememberFocusPolicy(payload) {
        const id = String(payload?.messageId || '');
        const mode = String(payload?.mode || '');
        if (!id || (mode !== 'defer' && mode !== 'silent')) return;
        const map = this.focusPolicyMap();
        map.set(id, { mode, ts: Date.now() });
        // Политика живёт ровно до сообщения; осиротевшие записи не копим.
        if (map.size > 200) {
            const cutoff = Date.now() - 10 * 60 * 1000;
            for (const [key, value] of map) if (value.ts < cutoff) map.delete(key);
        }
    }

    // Забирает политику сообщения (одноразово). null — обычное уведомление.
    takeFocusPolicy(messageId) {
        const id = String(messageId || '');
        if (!id || !this._focusPolicies) return null;
        const policy = this._focusPolicies.get(id) || null;
        if (policy) this._focusPolicies.delete(id);
        return policy;
    }

    // Что показывали (или придержали), чтобы «Всё равно оповестить» знало текст.
    rememberFocusMessage(note) {
        const id = String(note?.messageId || '');
        if (!id) return;
        if (!this._focusRecent) this._focusRecent = new Map();
        this._focusRecent.set(id, { ...note, ts: Date.now() });
        if (this._focusRecent.size > 60) {
            this._focusRecent.delete(this._focusRecent.keys().next().value);
        }
    }

    // Тоста и сигнала нет, но вне приложения должно быть видно, что пришло: кружок на
    // значке приложения (syncTaskbarBadge — Windows, macOS, PWA; тихий канал —
    // Android). Сам счётчик уже вырос в notifyBackgroundMessage.
    deferFocusNotification(note) {
        if (!this._focusHeld) this._focusHeld = [];
        this._focusHeld.push({ ...note, ts: Date.now() });
        this.rememberFocusMessage(note);
        this.trace?.(`focus: held message=${note.messageId} from=${note.sender} held=${this._focusHeld.length}`);
        this.syncQuietBadges();
    }

    // Отложенное уведомление о переписке, которую человек уже открыл и прочитал,
    // больше не нужно: сводка «N сообщений» после игры была бы враньём.
    syncFocusHeldWithUnread() {
        const held = this._focusHeld;
        if (!held || !held.length) return;
        const keep = held.filter(note => (this.S.unread?.[note.sender] || 0) > 0);
        if (keep.length === held.length) return;
        this._focusHeld = keep;
        this.syncQuietBadges();
    }

    // Android: кружок на значке рисует лаунчер, и только по уведомлению. Поэтому
    // на время отсрочки ставится тихое (канал LOW: без звука, вибрации и всплытия),
    // по одному на отправителя, и снимается, когда отложенных от него не осталось.
    syncQuietBadges() {
        if (!this.nativeSupports?.('quietBadge')) return;
        const counts = new Map();
        for (const note of this._focusHeld || []) {
            counts.set(note.sender, (counts.get(note.sender) || 0) + 1);
        }
        if (!this._quietShown) this._quietShown = new Map();
        for (const [sender, count] of counts) {
            if (this._quietShown.get(sender) === count) continue;
            this._quietShown.set(sender, count);
            this.postNativeMessage({
                type: NativeMessageTypes.SHOW_NOTIFICATION,
                quiet: true,
                sender,
                count,
                text: '',
                attachmentCount: 0,
                serverId: null,
                channelId: null,
            });
        }
        for (const sender of [...this._quietShown.keys()]) {
            if (counts.has(sender)) continue;
            this._quietShown.delete(sender);
            this.postNativeMessage({
                type: NativeMessageTypes.SHOW_NOTIFICATION,
                quiet: true,
                clear: true,
                sender,
                text: '',
                attachmentCount: 0,
                serverId: null,
                channelId: null,
            });
        }
    }

    // Конец игровой сессии (focus_flush с сервера или локальный запас на случай,
    // если кадр потерялся): по одному уведомлению на отправителя.
    flushFocusNotifications() {
        const held = this._focusHeld || [];
        this._focusHeld = [];
        this.syncQuietBadges();
        if (!held.length) return;
        const bySender = new Map();
        for (const note of held) {
            if (!bySender.has(note.sender)) bySender.set(note.sender, []);
            bySender.get(note.sender).push(note);
        }
        for (const [sender, notes] of bySender) {
            const last = notes[notes.length - 1];
            const text = notes.length === 1
                ? last.text
                : `${notes.length} ${this.ruPlural(notes.length, 'сообщение', 'сообщения', 'сообщений')}, пока вы играли`;
            this.presentMessageNotification({
                sender,
                text,
                attachmentCount: notes.length === 1 ? last.attachmentCount : 0,
                messageId: last.messageId,
            });
        }
    }

    // «Всё равно оповестить» от отправителя: громко и сразу, даже если тихое
    // уведомление об этом сообщении уже показывали.
    releaseFocusMessage(payload) {
        const id = String(payload?.messageId || '');
        if (!id) return;
        const held = this._focusHeld || [];
        const index = held.findIndex(note => note.messageId === id);
        let note = index >= 0 ? held.splice(index, 1)[0] : null;
        if (index >= 0) this.syncQuietBadges();
        if (!note) note = this._focusRecent?.get(id) || null;
        this.presentMessageNotification({
            sender: note?.sender || String(payload?.from || ''),
            text: note?.text || '',
            attachmentCount: note?.attachmentCount || 0,
            messageId: id,
            force: true,
        });
    }

    // Резерв на случай потерянного focus_flush: своя игра закончилась, а очередь
    // не опустела. Запас больше серверного (20 с), чтобы не опередить его.
    armLocalFocusFlush() {
        if (this._focusLocalFlushTimer || !(this._focusHeld || []).length) return;
        this._focusLocalFlushTimer = setTimeout(() => {
            this._focusLocalFlushTimer = null;
            if (this.effectiveGameActivity?.()) return;
            this.flushFocusNotifications();
        }, 45000);
    }

    // ------------------------------------------------------------
    // Отправитель
    // ------------------------------------------------------------

    focusNotes() {
        if (!this._focusNotes) this._focusNotes = new Map();
        return this._focusNotes;
    }

    rememberDeliveryNote(payload) {
        const to = String(payload?.to || '').trim();
        const messageId = String(payload?.messageId || '');
        const mode = String(payload?.mode || '');
        if (!to || !messageId || (mode !== 'defer' && mode !== 'silent')) return;
        this.focusNotes().set(to, { messageId, mode, ts: Date.now() });
        this.renderComposerFocusNote();
    }

    clearDeliveryNote(payload) {
        const to = String(payload?.to || '').trim();
        const ids = Array.isArray(payload?.messageIds) ? payload.messageIds.map(String) : [];
        const note = this.focusNotes().get(to);
        if (note && (!ids.length || ids.includes(note.messageId))) {
            this.focusNotes().delete(to);
            this.renderComposerFocusNote();
        }
    }

    renderComposerFocusNote() {
        const box = document.getElementById('composerFocusNote');
        if (!box) return;
        const peer = this.S.navMode !== 'servers' ? this.S.current : null;
        const note = peer ? this.focusNotes().get(peer) : null;
        // Заметка про сообщение, которому давно пора было дойти, — уже неправда.
        if (note && Date.now() - note.ts > 6 * 60 * 60 * 1000) {
            this.focusNotes().delete(peer);
            this.setHTMLIfChanged(box, '');
            box.hidden = true;
            return;
        }
        if (!note) {
            this.setHTMLIfChanged(box, '');
            box.hidden = true;
            return;
        }
        const who = this.esc(peer);
        const text = note.mode === 'defer'
            ? `<strong>${who}</strong> сейчас в игре и получит уведомление о сообщении по окончании игровой сессии.`
            : `Отправлено тихо: <strong>${who}</strong> сейчас в игре — уведомление придёт без звука.`;
        this.setHTMLIfChanged(box, `
            <span class="composer-focus-icon">${this.gameActivityIconHTML?.() || ''}</span>
            <span class="composer-focus-text">${text}</span>
            <button type="button" class="btn-flat composer-focus-btn" data-focus-notify-anyway="${this.esc(note.messageId)}">Всё равно оповестить</button>
        `);
        box.hidden = false;
    }

    async notifyAnyway(messageId) {
        const id = String(messageId || '');
        if (!id) return;
        try {
            // 404 — уже отпущено (сессия кончилась) или не наше: заметка в любом
            // случае больше не нужна.
            await this.apiFetch(`/api/message/${encodeURIComponent(id)}/notify-now`, {
                method: 'POST',
                interactive: true,
            });
        } catch (e) {
            this.trace?.(`notifyAnyway failed: ${e?.message || e}`);
            return;
        }
        for (const [peer, note] of this.focusNotes()) {
            if (note.messageId === id) this.focusNotes().delete(peer);
        }
        this.renderComposerFocusNote();
    }

    bindComposerFocusNote() {
        document.getElementById('composerFocusNote')?.addEventListener('click', (event) => {
            const button = event.target.closest?.('[data-focus-notify-anyway]');
            if (!button) return;
            void this.notifyAnyway(button.getAttribute('data-focus-notify-anyway'));
        });
    }

    // ------------------------------------------------------------
    // Realtime
    // ------------------------------------------------------------

    handleFocusRealtime(payload) {
        switch (String(payload?.type || '')) {
            case 'notify_policy':
                this.rememberFocusPolicy(payload);
                break;
            case 'notify_now':
                this.releaseFocusMessage(payload);
                break;
            case 'focus_flush':
                this.flushFocusNotifications();
                break;
            case 'delivery_note':
                this.rememberDeliveryNote(payload);
                break;
            case 'delivery_note_done':
                this.clearDeliveryNote(payload);
                break;
            default:
                break;
        }
    }
});
