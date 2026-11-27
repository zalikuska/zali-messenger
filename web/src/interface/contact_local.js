// --- ZaliInterface: личные имена контактов и блокировка (только на этом устройстве). ---
// Часть класса ZaliInterface (см. web/src/interface.js).
//
//  - Ник — подпись, которую видит только владелец устройства: список чатов, шапка
//    чата, подписи над сообщениями. Логин собеседника не меняется и по-прежнему
//    виден в подсказке и в профиле.
//  - Блокировка — клиентская: сообщения заблокированного не попадают в ленту,
//    не растят счётчик и не дают уведомлений, входящий звонок сбрасывается
//    (voice_call_reject). Сервер о блокировке не знает; список живёт в
//    localStorage аккаунта (ключ зависит от _userSuffix, как у закреплённых).
ZaliMixin(ZaliInterface, class {

    nicknamesStorageKey() {
        return `zali_nicknames_v1${this._userSuffix()}`;
    }

    blockedUsersStorageKey() {
        return `zali_blocked_users_v1${this._userSuffix()}`;
    }

    _readLocalMap(key, accept) {
        let map = {};
        try {
            const parsed = JSON.parse(localStorage.getItem(key) || '{}');
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                for (const [name, value] of Object.entries(parsed)) {
                    const clean = accept(value);
                    if (name && clean) map[name] = clean;
                }
            }
        } catch (e) {
            map = {};
        }
        return map;
    }

    // Имена хранятся в нижнем регистре: логин в сообщении и в сессии пишут по-разному.
    localNicknames() {
        const key = this.nicknamesStorageKey();
        if (this._nicknamesKey === key && this._nicknames) return this._nicknames;
        this._nicknames = this._readLocalMap(key, v => String(v || '').trim().slice(0, 40));
        this._nicknamesKey = key;
        return this._nicknames;
    }

    localNickname(name) {
        return this.localNicknames()[String(name || '').trim().toLowerCase()] || '';
    }

    // Что показывать вместо логина: личный ник, иначе сам логин.
    contactDisplayName(name) {
        const login = String(name || '').trim();
        return this.localNickname(login) || login;
    }

    setLocalNickname(name, nickname) {
        const key = String(name || '').trim().toLowerCase();
        if (!key) return;
        const map = this.localNicknames();
        const value = String(nickname || '').trim().slice(0, 40);
        if (value && value.toLowerCase() !== key) map[key] = value;
        else delete map[key];
        try {
            localStorage.setItem(this.nicknamesStorageKey(), JSON.stringify(map));
        } catch (e) {
            // ignore storage failures
        }
        this.refreshLocalNames();
    }

    blockedUsers() {
        const key = this.blockedUsersStorageKey();
        if (this._blockedKey === key && this._blocked) return this._blocked;
        this._blocked = this._readLocalMap(key, v => (Number(v) > 0 ? Number(v) : 0));
        this._blockedKey = key;
        return this._blocked;
    }

    isUserBlocked(name) {
        const key = String(name || '').trim().toLowerCase();
        return !!key && !!this.blockedUsers()[key];
    }

    hasBlockedUsers() {
        return Object.keys(this.blockedUsers()).length > 0;
    }

    setUserBlocked(name, blocked) {
        const key = String(name || '').trim().toLowerCase();
        if (!key || key === String(this.myName?.() || '').trim().toLowerCase()) return;
        const map = this.blockedUsers();
        if (blocked) map[key] = Date.now();
        else delete map[key];
        try {
            localStorage.setItem(this.blockedUsersStorageKey(), JSON.stringify(map));
        } catch (e) {
            // ignore storage failures
        }
        this._blockedFilterCache = null;
        this.refreshLocalNames();
        this.syncTaskbarBadge?.();
    }

    // Сообщения без заблокированных. Тот же массив, если фильтровать нечего:
    // вызывается из каждого кадра отрисовки ленты.
    withoutBlockedMessages(list) {
        if (!Array.isArray(list) || !list.length || !this.hasBlockedUsers()) return list;
        if (!list.some(msg => this.isUserBlocked(msg?.sender))) return list;
        const cache = this._blockedFilterCache;
        if (cache && cache.src === list && cache.len === list.length) return cache.out;
        const out = list.filter(msg => !this.isUserBlocked(msg?.sender));
        this._blockedFilterCache = { src: list, len: list.length, out };
        return out;
    }

    async toggleBlockUser(name) {
        const login = String(name || '').trim();
        if (!login) return;
        if (this.isUserBlocked(login)) {
            this.setUserBlocked(login, false);
            return;
        }
        const ok = await this.confirmAction({
            title: `Заблокировать ${this.contactDisplayName(login)}?`,
            message: 'Сообщения и звонки этого человека перестанут приходить на это устройство: без ленты, счётчика и уведомлений. Он об этом не узнает. Разблокировать можно в том же меню.',
            confirmLabel: 'Заблокировать',
        });
        if (ok) this.setUserBlocked(login, true);
    }

    refreshLocalNames() {
        try {
            this.renderContacts();
            if (this.S.navMode !== 'servers' && this.S.current) {
                const name = this.contactDisplayName(this.S.current);
                const hdr = document.getElementById('chatHdrName');
                if (hdr) hdr.textContent = name;
                const tb = document.getElementById('tbChat');
                if (tb) tb.textContent = name;
                this.updateChatHeaderCryptoKey?.({ peer: this.S.current });
            }
            this.scheduleRenderMessages?.();
        } catch (e) {
            this.trace?.(`refreshLocalNames failed: ${e?.message || e}`);
        }
    }

    // Окно «Имя только для вас». Пустое поле возвращает логин.
    promptLocalNickname(name) {
        const login = String(name || '').trim();
        if (!login) return;
        if (this._nicknameDialogDismiss) this._nicknameDialogDismiss();
        const host = document.querySelector('.main') || document.body;
        const previousFocus = document.activeElement;
        const overlay = document.createElement('div');
        overlay.className = 'coin-transfer-modal confirm-dialog';
        overlay.innerHTML = `
            <div class="coin-transfer-box confirm-dialog-box" role="dialog" aria-modal="true" aria-labelledby="nicknameDialogTitle">
                <div class="coin-transfer-head"><h2 id="nicknameDialogTitle">Имя только для вас</h2></div>
                <p class="confirm-dialog-text"></p>
                <input type="text" class="auth-input" maxlength="40" autocomplete="off" spellcheck="false" data-nickname-input>
                <div class="coin-transfer-actions">
                    <button class="btn-flat" type="button" data-nickname-cancel>Отмена</button>
                    <button class="auth-btn primary" type="button" data-nickname-ok>Сохранить</button>
                </div>
            </div>`;
        overlay.querySelector('.confirm-dialog-text').textContent =
            `Так ${login} будет подписан у вас в списке чатов и в переписке. Другие этого не увидят. Пустое поле вернёт обычное имя.`;
        const input = overlay.querySelector('[data-nickname-input]');
        input.value = this.localNickname(login);
        input.placeholder = login;
        const finish = (save) => {
            if (this._nicknameDialogDismiss !== dismiss) return;
            this._nicknameDialogDismiss = null;
            document.removeEventListener('keydown', onKey, true);
            overlay.remove();
            try { previousFocus?.focus?.(); } catch (e) { /* элемента уже нет */ }
            if (save) this.setLocalNickname(login, input.value);
        };
        const dismiss = () => finish(false);
        const onKey = (e) => {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
            else if (e.key === 'Enter' && document.activeElement === input) { e.preventDefault(); finish(true); }
        };
        this._nicknameDialogDismiss = dismiss;
        overlay.querySelector('[data-nickname-cancel]').addEventListener('click', () => finish(false));
        overlay.querySelector('[data-nickname-ok]').addEventListener('click', () => finish(true));
        overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(false); });
        document.addEventListener('keydown', onKey, true);
        host.appendChild(overlay);
        input.focus();
        input.select();
    }
});
