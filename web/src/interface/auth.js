// --- ZaliInterface: Бутстрап сессии, вход/регистрация, контакты. ---
// Часть класса ZaliInterface (см. web/src/interface.js). Тела методов
// перенесены сюда дословно; ZaliMixin копирует дескрипторы на прототип,
// поэтому поведение и неперечисляемость методов те же, что у class-тела.
ZaliMixin(ZaliInterface, class {

    async bootstrapSession() {
        this.trace('bootstrapSession start');
        this.sessionBootstrapInProgress = true;
        try {
            const stored = this.loadStoredSession();
            const lastStored = this.loadStoredSession(this.lastAuthStorageKey());
            const injected = this.loadInjectedSession();
            const seenTokens = new Set();
            const candidates = [stored, lastStored, injected]
                .map(s => this.normalizeSession(s))
                .filter(s => {
                    const token = String(s?.token || '').trim();
                    if (!token || seenTokens.has(token)) return false;
                    // Skip already-expired tokens. Otherwise an expired stored token
                    // was applied as a "fallback" session and every request hit the
                    // server's "невалидный JWT" rejection — manifesting as 12s timeouts
                    // and empty history instead of a clean re-login prompt.
                    if (this.isTokenExpired(token)) {
                        this.trace(`bootstrapSession skip expired token username=${s?.username || ''}`);
                        return false;
                    }
                    seenTokens.add(token);
                    return true;
                });
            const hasCandidates = candidates.length > 0;
            // If we had a saved session but every token was expired, tell the user why
            // they are back at the login screen and clear the dead tokens.
            const hadStoredToken = !!(String(stored?.token || '').trim() || String(lastStored?.token || '').trim());
            if (!hasCandidates && hadStoredToken) {
                this.clearStoredSession();
                this.clearLastStoredSession();
                this.S.auth.error = 'Сессия истекла. Войдите заново.';
                this.addLogEntry({ type: 'WARN', msg: 'Сохранённая сессия истекла — войдите заново', ts: new Date().toLocaleTimeString() });
            }

            let restored = false;
            let invalidateStoredSession = false;
            for (const candidate of candidates) {
                const result = await this.restoreSession(candidate);
                restored = !!result?.ok;
                invalidateStoredSession = invalidateStoredSession || !!result?.invalidate;
                if (restored) break;
            }

            if (!restored) {
                if (invalidateStoredSession && stored?.token) this.clearStoredSession();
                if (invalidateStoredSession && lastStored?.token) this.clearLastStoredSession();
                if (hasCandidates && !invalidateStoredSession) {
                    const fallback = candidates[0];
                    this.trace(`bootstrapSession fallback session username=${fallback?.username || ''} tokenSet=${!!fallback?.token}`);
                    this.applySession(fallback, { persist: false, syncNative: false });
                    this.startPostAuthSetup({
                        reason: 'bootstrapSession-fallback',
                        restoreStoredUnlockSecret: true,
                        resetVault: true,
                    });
                    this.S.auth.error = 'Не удалось проверить последний вход сейчас. Сессия будет восстановлена при следующей попытке.';
                    this.updateAuthView();
                } else {
                    this.applySession({ username: '', token: null, guest: true }, { persist: false });
                }
            }

            this.clearAuthInputs();
            this.S.auth.fieldsCleared = true;

            if (this.S.session?.token) {
                this.startPostAuthSetup({
                    reason: 'bootstrapSession',
                    restoreStoredUnlockSecret: true,
                });
            } else {
                this.S.contacts = [];
                this.S.users = [];
                this.S.servers = [];
                this.ensureServerSelection();
                this.renderContacts();
                this.renderServerInterface();
                this.scheduleRenderMessages();
            }
            this.updateAuthView();
            this.applyNetworkConfigToInputs();
            this.syncNativeNetworkConfig();
            this.updateSendButtonState();
            if (this.nativeSupports('sessionSync')) {
                this.syncNativeSession();
            }
            if (this.S.session?.token) {
                this.checkForAppUpdate();
            }
        } finally {
            this.sessionBootstrapInProgress = false;
            this.rehydratePendingOutbox();
            this.scheduleFlushPendingOutbox(300);
            this.trace('bootstrapSession done');
        }
    }

    async restoreSession(session) {
        try {
            const token = session?.token || null;
            if (!token) return false;
            this.trace(`restoreSession start username=${session?.username || ''} tokenSet=${!!token}`);
            const res = await this.apiFetch(this.apiRoutes.auth.me, {
                allowSessionInvalidation: true,
                timeoutMs: SESSION_RESTORE_TIMEOUT_MS,
                headers: {
                    Authorization: `Bearer ${token}`,
                },
            });
            if (!res.ok) {
                const status = Number(res.status || 0);
                if (status === 401 || status === 403) {
                    this.trace(`restoreSession unauthorized status=${status}`);
                    return { ok: false, invalidate: true };
                }
                this.trace(`restoreSession retryable status=${status}`);
                return { ok: false, invalidate: false };
            }
            const data = await res.json();
            this.trace(`restoreSession success username=${data.username || session.username || ''}`);
            this.applySession({
                username: data.username || session.username || '',
                token,
                guest: false,
            }, { persist: true, syncNative: true });
            if (typeof data.cloudVaultSyncEnabled !== 'undefined') {
                this.applyVaultCloudSyncEnabled(!!data.cloudVaultSyncEnabled, { persistLocal: true });
            }
            return {
                ok: true,
                invalidate: false,
                username: data.username || session.username || '',
                token,
            };
        } catch (e) {
            this.trace(`restoreSession failed error=${e?.message || e}`);
            return { ok: false, invalidate: false };
        }
    }

    applySession(session, { persist = true, syncNative = true, connectVoiceSocket = true } = {}) {
        const previousUsername = this.S.session?.username;
        const previousToken = this.S.session?.token;
        const username = session?.username || '';
        const token = session?.token || null;
        const guest = !!session?.guest || !token;
        this.trace(`applySession username=${username} tokenSet=${!!token} guest=${guest} persist=${persist} syncNative=${syncNative}`);

        if (previousUsername !== username || previousToken !== token) {
            // A deferred cache save scheduled under the OLD account must land now,
            // while _userSuffix() still resolves to that account — once the session
            // switches, the debounced timer would write the old user's chats under
            // the new user's storage key.
            this.flushPendingMessageCacheSave();
            // The one-shot cloud-vault fetch guard is per-account: without resetting it,
            // the next account logged in during this page session would skip its own
            // on-demand vault fetch and mint a temporary key instead of adopting the
            // real key from its vault (key divergence on the account-switch flow).
            this._cloudVaultResolveFetchDone = false;
            this.S.current = null;
            this.S.activeServer = null;
            this.S.activeChannel = null;
            this.S.activeConversationType = 'dm';
            this.S.draftAttachments = [];
            this.resetVoiceState({ preserveInvite: false });
            this.disconnectBrowserVoiceSocket();
            this.S.auth.vaultPassphrase = '';
            this.setServerModalState({
                mode: 'create',
                serverId: null,
                members: [],
                loading: false,
                saving: false,
                error: '',
            });
            this.closeServerOverlay();
        }

        this.S.session = { username, token, guest };
        if (username && username !== previousUsername) {
            const userCachedMessages = this.loadStoredMessageCache();
            this.S.chats = userCachedMessages.chats && typeof userCachedMessages.chats === 'object'
                ? userCachedMessages.chats
                : {};
            this.S.serverChats = userCachedMessages.serverChats && typeof userCachedMessages.serverChats === 'object'
                ? userCachedMessages.serverChats
                : {};
            const cachedContacts = this.loadStoredContacts();
            const localContacts = this.localConversationContacts();
            this.S.contacts = Array.from(new Set([...cachedContacts, ...localContacts]))
                .filter(contact => contact !== username);
            this.S.contacts.forEach(contact => this.initChat(contact));
            this.lastNativeConversationKeySignature = '';
            this.syncNativeConversationKeys(this.loadStoredConversationKeys());
            // Per-account, not per-instance: the sweep's coalescing window belongs to
            // the account that opened it, so switching users must not make the new
            // account wait out the previous one's cooldown before publishing its keys.
            this._lastKeyPublishSweepAt = 0;
            if (this._keyPublishSweepTrailing) {
                clearTimeout(this._keyPublishSweepTrailing);
                this._keyPublishSweepTrailing = null;
            }
        }
        if (token) {
            this.S.auth.dismissed = true;
        }
        if (persist) {
            if (token) {
                this.saveStoredSession(this.S.session);
            } else {
                this.clearStoredSession();
            }
        }

        this.updateAuthView();
        const overlay = document.getElementById('authOverlay');
        if (overlay && token) {
            overlay.classList.remove('visible');
        }
        this.normalizeDmChatStore();
        this.renderSidebarProfile();
        this.renderRecentAccounts();
        this.updateContactControls();
        this.renderContacts();
        this.scheduleRenderMessages();
        this.updateSendButtonState();
        if (syncNative) {
            this.syncNativeSession();
        }
        if (connectVoiceSocket && !this.nativeSupports('voice')) {
            this.connectBrowserVoiceSocket();
        }
        if (token && !this.hasNativeBridge()) {
            this.subscribeWebPush();
        }
        if (!this.sessionBootstrapInProgress) {
            this.rehydratePendingOutbox();
            this.recoverOrphanSendingMessages();
            this.scheduleFlushPendingOutbox(300);
        }
    }

    clearAuthInputs() {
        const usernameInput = document.getElementById('authUsername');
        const passwordInput = document.getElementById('authPassword');
        if (usernameInput) usernameInput.value = '';
        if (passwordInput) passwordInput.value = '';
    }

    updateContactControls() {
        const enabled = !!this.S.session?.token;
        const contactAddBtn = document.getElementById('contactAddBtn');
        if (contactAddBtn) {
            contactAddBtn.disabled = !enabled;
        }
        if (!enabled) {
            this.exitContactAddMode({ restoreSearch: false });
            this.setContactStatus('');
        }
        this.updateContactAddButtonState();
    }

    enterContactAddMode() {
        if (!this.S.session?.token) return;
        this.S.contactAddMode = true;
        this._searchQBeforeContactAdd = this.S.searchQ || '';
        const input = document.getElementById('searchInput');
        if (input) {
            input.value = '';
            input.placeholder = 'Логин контакта';
            input.focus();
        }
        this.setContactStatus('');
        this.updateContactAddButtonState();
        this.renderContactSuggestions(true);
        void this.loadUsers('').then(() => this.renderContactSuggestions(true));
    }

    exitContactAddMode({ restoreSearch = true } = {}) {
        if (!this.S.contactAddMode) return;
        this.S.contactAddMode = false;
        const input = document.getElementById('searchInput');
        const restoredQuery = restoreSearch ? (this._searchQBeforeContactAdd || '') : '';
        if (input) {
            input.value = restoredQuery;
            input.placeholder = 'Поиск...';
        }
        this.S.searchQ = restoredQuery;
        this._searchQBeforeContactAdd = '';
        this.hideContactSuggestions();
        this.setContactStatus('');
        this.updateContactAddButtonState();
        this.renderContacts();
    }

    updateContactAddButtonState() {
        const contactAddBtn = document.getElementById('contactAddBtn');
        const input = document.getElementById('searchInput');
        if (!contactAddBtn) return;
        const enabled = !!this.S.session?.token;
        const addMode = !!this.S.contactAddMode;
        const hasText = addMode && !!String(input?.value || '').trim();
        contactAddBtn.disabled = !enabled;
        contactAddBtn.classList.toggle('is-empty', addMode && !hasText);
        contactAddBtn.classList.toggle('is-active', addMode);
        contactAddBtn.title = !enabled
            ? 'Войдите, чтобы добавить контакт'
            : (!addMode ? 'Добавить контакт' : (hasText ? 'Добавить контакт' : 'Введите логин контакта'));
    }

    setContactStatus(message = '', tone = '') {
        const status = document.getElementById('contactStatus');
        if (!status) return;
        const text = String(message || '').trim();
        status.textContent = text;
        if (tone) {
            status.dataset.tone = tone;
        } else {
            delete status.dataset.tone;
        }
        status.hidden = !text;
    }

    resolveContactInputUsername(rawValue) {
        const query = String(rawValue || '').trim();
        if (!query) return '';
        const lower = query.toLowerCase();
        const users = Array.isArray(this.S.users) ? this.S.users.filter(Boolean) : [];
        const exactUser = users.find(user => String(user || '').trim().toLowerCase() === lower);
        if (exactUser) return String(exactUser).trim();
        const suggestions = this.getContactSuggestions(query);
        if (suggestions.length === 1) {
            return String(suggestions[0]).trim();
        }
        return query;
    }

    getContactSuggestions(query = '') {
        const q = String(query || '').trim().toLowerCase();
        const me = this.myName();
        const existing = new Set((this.S.contacts || []).map(contact => String(contact).toLowerCase()));
        return (this.S.users || [])
            .filter(Boolean)
            .filter(contact => contact !== me)
            .filter(contact => !existing.has(String(contact).toLowerCase()))
            .filter(contact => !q || String(contact).toLowerCase().includes(q))
            .slice(0, 8);
    }

    hideContactSuggestions() {
        const outer = document.getElementById('contactSuggestionsWrap');
        const wrap = document.getElementById('contactSuggestions');
        if (outer) outer.hidden = true;
        if (!wrap) return;
        wrap.hidden = true;
        wrap.innerHTML = '';
    }

    renderContactSuggestions(force = false) {
        const outer = document.getElementById('contactSuggestionsWrap');
        const wrap = document.getElementById('contactSuggestions');
        const input = document.getElementById('searchInput');
        if (!outer || !wrap || !input) return;

        if (!this.S.session?.token || !this.S.contactAddMode) {
            this.hideContactSuggestions();
            return;
        }

        const query = input.value || '';
        const list = this.getContactSuggestions(query);
        const hasFocus = document.activeElement === input;
        const shouldShow = force || hasFocus || query.trim().length > 0;

        if (!shouldShow) {
            outer.hidden = true;
            wrap.hidden = true;
            wrap.innerHTML = '';
            return;
        }

        if (list.length === 0) {
            outer.hidden = false;
            wrap.hidden = false;
            wrap.innerHTML = `
                <div class="contact-suggest-empty">
                    Ничего не найдено
                </div>
            `;
            return;
        }

        outer.hidden = false;
        wrap.hidden = false;
        wrap.innerHTML = list.map(username => {
            return `
                <button class="contact-suggest-item" type="button" data-username="${this.esc(username)}">
                    <div class="contact-suggest-ava">${this.renderAvatarHTML(username, 'avatar-img', username)}</div>
                    <div class="contact-suggest-meta">
                        <div class="contact-suggest-name">${this.esc(username)}</div>
                        <div class="contact-suggest-hint">Добавить и начать чат</div>
                    </div>
                    <div class="contact-suggest-plus">+</div>
                </button>
            `;
        }).join('');
    }

    setAuthMode(mode, { clearInputs = true, focus = true } = {}) {
        this.S.auth.mode = mode === 'register' ? 'register' : 'login';
        this.S.auth.error = '';
        this.S.auth.loading = false;
        this.S.auth.fieldsCleared = false;
        if (clearInputs) {
            this.clearAuthInputs();
            this.S.auth.fieldsCleared = true;
        }
        this.updateAuthView();
        if (focus) {
            const usernameInput = document.getElementById('authUsername');
            if (usernameInput) usernameInput.focus();
        }
    }

    syncNativeSession() {
        if (!this.nativeSupports('sessionSync')) return;
        const deviceId = this.currentDeviceId();
        const username = this.S.session.username;
        const token = this.S.session.token || '';
        const guest = this.S.session.guest;
        // Skip redundant SET_SESSION: startup/auth calls applySession several times,
        // and every identical re-send made native tear down and re-open the WebSocket,
        // which showed up as the connection flapping (connect/disconnect repeatedly)
        // and left the client briefly offline — so real-time messages were missed.
        const signature = `${username}|${token}|${guest ? 1 : 0}|${deviceId}`;
        if (signature === this._lastNativeSessionSignature) {
            this.trace(`syncNativeSession skip duplicate username=${username}`);
            return;
        }
        this._lastNativeSessionSignature = signature;
        this.trace(`syncNativeSession username=${username} tokenSet=${!!token} deviceId=${deviceId || 'none'}`);
        this.postNativeMessage({
            type: NativeMessageTypes.SET_SESSION,
            username,
            token,
            guest,
            deviceId,
        });
    }

    async loadContacts() {
        try {
            this.trace(`loadContacts start user=${this.myName()} tokenSet=${!!this.S.session?.token}`);
            if (!this.S.session?.token) {
                this.S.contacts = [];
                this.renderContacts();
                return;
            }
            const res = await this.apiFetch(this.apiRoutes.contacts.list);
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                this.trace(`loadContacts failed status=${res.status} body=${text.slice(0, 300)}`);
                if (!this.S.contacts.length) {
                    const cachedContacts = this.loadStoredContacts();
                    if (cachedContacts.length) this.setContacts(cachedContacts);
                }
                this.renderContacts();
                return;
            }
            const data = await res.json();
            const contacts = Array.isArray(data?.contacts) ? data.contacts : [];
            this.trace(`loadContacts success count=${contacts.length} contacts=${contacts.join(',')}`);
            this.setContacts(contacts);
        } catch (e) {
            this.trace(`loadContacts error=${e?.message || e}`);
            this.renderContacts();
        }
    }

    // Debounced user search for the contact-add field. Typing "alexander" used
    // to fire nine searches, one per keystroke, none of them cancelled — so the
    // suggestion list also flickered through stale results whenever an earlier
    // response overtook a later one. One request per pause in typing, and
    // loadUsers() below drops any answer that is no longer the newest.
    scheduleUserSearch(query, { delayMs = 220, onDone = null } = {}) {
        const value = String(query || '');
        if (this._userSearchTimer) clearTimeout(this._userSearchTimer);
        this._userSearchTimer = setTimeout(() => {
            this._userSearchTimer = 0;
            void this.loadUsers(value).then(() => { if (onDone) onDone(); });
        }, Math.max(0, Number(delayMs) || 0));
    }

    async loadUsers(query = '', { interactive = false } = {}) {
        const seq = (this._loadUsersSeq = (this._loadUsersSeq || 0) + 1);
        try {
            this.trace(`loadUsers start user=${this.myName()} tokenSet=${!!this.S.session?.token}`);
            if (!this.S.session?.token) {
                this.S.users = [];
                return;
            }
            const search = String(query || '').trim();
            const res = await this.apiFetch(this.apiRoutes.users.search(search), { interactive });
            // A slower earlier query must never overwrite a newer answer.
            if (seq !== this._loadUsersSeq) return;
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                this.trace(`loadUsers failed status=${res.status} body=${text.slice(0, 300)}`);
                return;
            }
            const users = await res.json();
            this.trace(`loadUsers success count=${Array.isArray(users) ? users.length : 0} users=${Array.isArray(users) ? users.join(',') : 'invalid'}`);
            this.setUsers(users);
        } catch (e) {
            this.trace(`loadUsers error=${e?.message || e}`);
        }
    }

    startPostAuthSetup({
        passphrase = '',
        reason = 'login',
        saveUnlockSecret = false,
        restoreStoredUnlockSecret = false,
        resetVault = false,
    } = {}) {
        const token = String(this.S.session?.token || '').trim();
        if (!token) return;
        const runId = ++this.postAuthSetupRunId;
        void (async () => {
            // A newer run supersedes this one. bootstrapSession can fire two setups
            // back-to-back (fallback + token branch); without a real guard both ran
            // the full request set concurrently, doubling load and causing 12s
            // timeouts. Bail at each checkpoint if a newer run started.
            const superseded = () => this.postAuthSetupRunId !== runId;
            this.postAuthSetupInFlight = true;
            const tStart = this.nowMs();
            try {
                let code = String(passphrase || this.S.auth?.vaultPassphrase || '').trim();
                if (!code && restoreStoredUnlockSecret) {
                    code = await this.timeStage('loadVaultUnlockSecret', () => this.loadVaultUnlockSecret(token));
                    if (code) {
                        this.S.auth.vaultPassphrase = code;
                    }
                }
                if (superseded()) { this.trace(`postAuthSetup superseded reason=${reason} run=${runId}`); return; }
                if (saveUnlockSecret && code) {
                    await this.timeStage('saveVaultUnlockSecret', () => this.saveVaultUnlockSecret(code, token));
                }
                if (resetVault) {
                    await this.timeStage('ensureServerVaultReset', () => this.ensureServerVaultReset({ reason }));
                }
                // Contacts/users/servers are independent of device registration, so fire
                // them NOW in parallel with bootstrapDeviceTrust instead of after it —
                // they all multiplex over the single HTTP/2 connection. Key envelopes do
                // need the device registered, so they wait for bootstrap.
                const uiLoads = Promise.allSettled([
                    this.timeStage('loadContacts', () => this.loadContacts()),
                    this.timeStage('loadUsers', () => this.loadUsers()),
                    this.timeStage('loadServers', () => this.loadServers({ silent: true })),
                    // Заявки в друзья нужны здесь, а не при открытии профиля:
                    // без них бейдж на своей аватарке остался бы пустым до
                    // первого захода в профиль, то есть о заявке никто бы не узнал.
                    this.timeStage('loadFriendRequests', () => this.loadFriendRequests()),
                ]);
                await this.timeStage('bootstrapDeviceTrust', () => this.bootstrapDeviceTrust());
                await this.timeStage('restoreCloudVaultSnapshot', () => this.restoreCloudVaultSnapshot({ reason }));
                if (superseded()) { this.trace(`postAuthSetup superseded reason=${reason} run=${runId}`); return; }
                await Promise.allSettled([
                    this.timeStage('syncIncomingKeyEnvelopes', () => this.syncIncomingKeyEnvelopes({ reason })),
                    uiLoads,
                ]);
                this.addLogEntry({ type: 'INFO', msg: `⏱ postAuthSetup ВСЕГО (reason=${reason}): ${Math.round(this.nowMs() - tStart)} мс`, ts: new Date().toLocaleTimeString() });
                this.trace(`postAuthSetup done reason=${reason} run=${runId}`);
                // Background, OFF the critical path. These are slow (cloud vault backup
                // POSTs a package + a history ticket per scope; key republish sends one
                // request per peer device) but none are needed to render the chat, so
                // they must not block or starve the loads above.
                if (!superseded()) {
                    if (code) {
                        void this.timeStage('syncCloudVaultPackage(bg)', () => this.syncCloudVaultPackage({ passphrase: code, reason }));
                    }
                    void this.timeStage('retryPublishConversationKeys(bg)', () => this.retryPublishConversationKeys({ reason }));
                }
            } catch (e) {
                this.trace(`postAuthSetup failed reason=${reason} run=${runId} error=${e?.message || e}`);
            } finally {
                if (runId === this.postAuthSetupRunId) {
                    this.postAuthSetupInFlight = false;
                }
            }
        })();
    }

    async executeAuth(mode, username, password, { logAttempt = true } = {}) {
        const errorBox = document.getElementById('authError');
        this.S.auth.loading = true;
        this.updateAuthView();

        try {
            if (this.isWindowsNativeAuth()) {
                return await this.executeNativeAuth(mode, username, password, { logAttempt });
            }

            const endpoint = mode === 'register' ? this.apiRoutes.auth.register : this.apiRoutes.auth.login;
            if (mode === 'register' && logAttempt) {
                this.addLogEntry({
                    type: 'INFO',
                    msg: `Попытка регистрации: ${username}`,
                    ts: new Date().toLocaleTimeString()
                });
            }

            const requestAuth = async () => {
                return await this.apiFetch(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password }),
                    timeoutMs: AUTH_REQUEST_TIMEOUT_MS,
                    interactive: true,
                });
            };

            let res;
            let lastError = null;
            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    res = await requestAuth();
                    lastError = null;
                    break;
                } catch (err) {
                    lastError = err;
                    const msg = String(err?.message || err || '');
                    if (!/load failed|failed to fetch|network error|abort/i.test(msg) || attempt === 1) {
                        break;
                    }
                    await new Promise(resolve => setTimeout(resolve, 250));
                }
            }

            if (!res) {
                throw lastError || new Error('Не удалось связаться с сервером');
            }

            if (mode === 'register') {
                if (!res.ok) {
                    const text = await res.text();
                    if (res.status === 409 || /Пользователь уже существует/i.test(text)) {
                        this.addLogEntry({
                            type: 'INFO',
                            msg: `Аккаунт ${username} уже есть, пробуем войти с этим паролем`,
                            ts: new Date().toLocaleTimeString()
                        });

                        const recovered = await this.executeAuth('login', username, password, { logAttempt: false });
                        if (recovered) {
                            this.addLogEntry({
                                type: 'SUCCESS',
                                msg: `Вход восстановлен для ${username}`,
                                ts: new Date().toLocaleTimeString()
                            });
                            return true;
                        }
                    }

                    this.addLogEntry({
                        type: 'WARN',
                        msg: `Регистрация отклонена для ${username}: ${text || res.status}`,
                        ts: new Date().toLocaleTimeString()
                    });
                    throw new Error(text || 'Не удалось зарегистрироваться');
                }

                const data = await res.json();
                this.applySession({
                    username: data.username || username,
                    token: data.token,
                    guest: false,
                });
                if (typeof data.cloudVaultSyncEnabled !== 'undefined') {
                    this.applyVaultCloudSyncEnabled(!!data.cloudVaultSyncEnabled, { persistLocal: true });
                }
                this.S.auth.vaultPassphrase = String(password || '').trim();
                this.setAuthMode('login', { clearInputs: true, focus: false });
                this.startPostAuthSetup({
                    passphrase: password,
                    reason: 'register',
                    saveUnlockSecret: true,
                    resetVault: true,
                });

                this.addLogEntry({
                    type: 'SUCCESS',
                    msg: `Регистрация успешна, вход выполнен как ${this.myName()}`,
                    ts: new Date().toLocaleTimeString()
                });
                this.clearAuthInputs();
                return true;
            }

            if (!res.ok) {
                const text = await res.text();
                throw new Error(text || 'Не удалось войти');
            }

            const data = await res.json();
            this.applySession({
                username: data.username || username,
                token: data.token,
                guest: false,
            });
            if (typeof data.cloudVaultSyncEnabled !== 'undefined') {
                this.applyVaultCloudSyncEnabled(!!data.cloudVaultSyncEnabled, { persistLocal: true });
            }
            this.S.auth.vaultPassphrase = String(password || '').trim();
            this.setAuthMode('login', { clearInputs: true, focus: false });
            this.startPostAuthSetup({
                passphrase: password,
                reason: 'login',
                saveUnlockSecret: true,
                resetVault: true,
            });
            this.clearAuthInputs();
            this.addLogEntry({ type: 'SUCCESS', msg: `Вход выполнен как ${this.myName()}`, ts: new Date().toLocaleTimeString() });
            return true;
        } catch (e) {
            const raw = e.message || 'Ошибка входа';
            const apiBaseUrl = this.getApiBaseUrl();
            const friendly = /load failed|failed to fetch|network error|abort/i.test(raw)
                ? `Не удалось связаться с сервером (${apiBaseUrl}). Проверь адрес или запусти backend.`
                : raw;
            this.S.auth.error = friendly;
            if (errorBox) errorBox.textContent = friendly;
            if (mode === 'register') {
                this.addLogEntry({
                    type: 'ERROR',
                    msg: `Ошибка регистрации для ${username}: ${friendly}`,
                    ts: new Date().toLocaleTimeString()
                });
            }
            return false;
        } finally {
            this.S.auth.loading = false;
            this.updateAuthView();
        }
    }

    async executeNativeAuth(mode, username, password, { logAttempt = true } = {}) {
        const requestId = `auth-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const request = {
            type: NativeMessageTypes.AUTH_REQUEST,
            mode,
            username,
            password,
            requestId,
        };

        if (mode === 'register' && logAttempt) {
            this.addLogEntry({
                type: 'INFO',
                msg: `Попытка регистрации: ${username}`,
                ts: new Date().toLocaleTimeString()
            });
        }

        const nativeAuthTimeoutMs = mode === 'register'
            ? AUTH_REQUEST_TIMEOUT_MS * 2
            : AUTH_REQUEST_TIMEOUT_MS;
        const payload = await new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                this.nativeAuthRequests.delete(requestId);
                reject(new Error('Не удалось связаться с сервером'));
            }, nativeAuthTimeoutMs);

            this.nativeAuthRequests.set(requestId, { resolve, reject, timeoutId });

            if (!this.postNativeMessage(request)) {
                clearTimeout(timeoutId);
                this.nativeAuthRequests.delete(requestId);
                reject(new Error('Не удалось связаться с сервером'));
            }
        });

        const data = payload?.data || payload;
        this.applySession({
            username: data.username || username,
            token: data.token,
            guest: false,
        });
        if (typeof data.cloudVaultSyncEnabled !== 'undefined') {
            this.applyVaultCloudSyncEnabled(!!data.cloudVaultSyncEnabled, { persistLocal: true });
        }
        this.S.auth.vaultPassphrase = String(password || '').trim();
        this.setAuthMode('login', { clearInputs: true, focus: false });
        this.startPostAuthSetup({
            passphrase: password,
            reason: 'native-auth',
            saveUnlockSecret: true,
            resetVault: true,
        });
        this.clearAuthInputs();
        this.addLogEntry({
            type: 'SUCCESS',
            msg: mode === 'register'
                ? `Регистрация успешна, вход выполнен как ${this.myName()}`
                : `Вход выполнен как ${this.myName()}`,
            ts: new Date().toLocaleTimeString()
        });
        return true;
    }

    async requestNativeAction(payload, timeoutMs = 15000) {
        const requestId = String(payload?.requestId || `native-${Date.now()}-${Math.random().toString(16).slice(2)}`);
        const request = { ...payload, requestId };
        return await new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                this.nativeRequests.delete(requestId);
                reject(new Error('Не удалось связаться с сервером'));
            }, timeoutMs);

            this.nativeRequests.set(requestId, { resolve, reject, timeoutId });

            if (!this.postNativeMessage(request)) {
                clearTimeout(timeoutId);
                this.nativeRequests.delete(requestId);
                reject(new Error('Не удалось связаться с сервером'));
            }
        });
    }

    onNativeResponse(payload) {
        if (!payload || typeof payload !== 'object') return;
        const requestId = String(payload.requestId || '').trim();
        if (!requestId) return;
        const pending = this.nativeRequests.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timeoutId);
        this.nativeRequests.delete(requestId);
        if (payload.ok) {
            pending.resolve(payload);
        } else {
            pending.reject(new Error(payload.error || 'Операция не удалась'));
        }
    }

    onNativeAuthResponse(payload) {
        if (!payload || typeof payload !== 'object') return;
        const requestId = String(payload.requestId || '').trim();
        if (!requestId) return;
        const pending = this.nativeAuthRequests.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timeoutId);
        this.nativeAuthRequests.delete(requestId);
        if (payload.ok) {
            pending.resolve(payload);
        } else {
            pending.reject(new Error(payload.error || 'Не удалось войти'));
        }
    }

    async submitAuth(mode) {
        if (this.S.auth.loading) {
            return;
        }

        const usernameInput = document.getElementById('authUsername');
        const passwordInput = document.getElementById('authPassword');
        const username = (usernameInput?.value || '').trim();
        const password = passwordInput?.value || '';
        const errorBox = document.getElementById('authError');

        if (errorBox) errorBox.textContent = '';
        this.S.auth.error = '';
        if (!username || !password) {
            const msg = 'Введите логин и пароль';
            this.S.auth.error = msg;
            if (errorBox) errorBox.textContent = msg;
            return;
        }

        if (mode === 'register') {
            if (username.length > 64) {
                const msg = 'Логин слишком длинный: максимум 64 символа';
                this.S.auth.error = msg;
                if (errorBox) errorBox.textContent = msg;
                this.addLogEntry({ type: 'WARN', msg: `Регистрация отклонена для ${username}: ${msg}`, ts: new Date().toLocaleTimeString() });
                return;
            }

            if (password.length < 6) {
                const msg = 'Пароль должен быть не менее 6 символов';
                this.S.auth.error = msg;
                if (errorBox) errorBox.textContent = msg;
                this.addLogEntry({ type: 'WARN', msg: `Регистрация отклонена для ${username}: ${msg}`, ts: new Date().toLocaleTimeString() });
                return;
            }
        }

        const authApiBaseUrl = document.getElementById('authApiBaseUrl');
        const typedApiBaseUrl = String(authApiBaseUrl?.value || '').trim();
        if (typedApiBaseUrl) {
            try {
                const current = this.loadNetworkConfig();
                const typedWsBaseUrl = this.deriveWsBaseUrl(typedApiBaseUrl);
                if (typedApiBaseUrl !== current.apiBaseUrl || typedWsBaseUrl !== current.wsBaseUrl) {
                    this.setNetworkConfig({
                        apiBaseUrl: typedApiBaseUrl,
                        wsBaseUrl: typedWsBaseUrl,
                        iceServers: current.iceServers,
                    });
                }
            } catch (e) {
                const msg = e?.message || 'Не удалось сохранить адрес сервера';
                this.S.auth.error = msg;
                if (errorBox) errorBox.textContent = msg;
                return;
            }
        }

        return this.executeAuth(mode, username, password);
    }

    continueAsGuest() {
        this.S.auth.dismissed = true;
        this.S.auth.error = '';
        this.clearAuthInputs();
        this.S.auth.fieldsCleared = true;
        this.applySession({ username: '', token: null, guest: true }, { persist: false });
        this.loadContacts();
        this.updateAuthView();
    }

    async logout() {
        this.S.auth.dismissed = false;
        this.S.auth.error = '';
        this.setAuthMode('login', { clearInputs: true, focus: false });
        this.clearStoredSession();
        this.applySession({ username: '', token: null, guest: true }, { persist: false, syncNative: false, connectVoiceSocket: false });
        this.S.contacts = [];
        this.S.users = [];
        this.S.current = null;
        this.S.unread = {};
        this.S.channelUnread = {};
        this.syncTaskbarBadge();
        this.resetVoiceState({ preserveInvite: false });
        this.disconnectBrowserVoiceSocket();
        this.renderContacts();
        this.scheduleRenderMessages();
        this.updateAuthView();
        this.addLogEntry({ type: 'WARN', msg: 'Сеанс завершён', ts: new Date().toLocaleTimeString() });
    }

    async addContactFromInput(usernameOverride = null) {
        if (!this.S.session?.token) {
            const msg = 'Сначала войдите в аккаунт, чтобы добавлять контакты';
            this.addLogEntry({ type: 'WARN', msg, ts: new Date().toLocaleTimeString() });
            this.S.auth.error = msg;
            this.setContactStatus(msg, 'error');
            this.updateAuthView();
            return;
        }

        const input = document.getElementById('searchInput');
        const rawUsername = (usernameOverride ?? input?.value ?? '').trim();
        if (!rawUsername) {
            const msg = 'Введите логин контакта';
            this.setContactStatus(msg);
            if (input) {
                input.focus();
                input.select?.();
            }
            this.renderContactSuggestions(true);
            return;
        }

        this.setContactStatus('');
        const lowerRawUsername = rawUsername.toLowerCase();
        const exactInCache = Array.isArray(this.S.users)
            ? this.S.users.some(user => String(user || '').trim().toLowerCase() === lowerRawUsername)
            : false;
        let username = this.resolveContactInputUsername(rawUsername);

        if (!exactInCache && rawUsername.length >= 3) {
            await this.loadUsers(rawUsername, { interactive: true });
            const exactAfterLoad = Array.isArray(this.S.users)
                ? this.S.users.find(user => String(user || '').trim().toLowerCase() === lowerRawUsername)
                : null;
            if (exactAfterLoad) {
                username = String(exactAfterLoad).trim();
            } else {
                const suggestions = this.getContactSuggestions(rawUsername);
                if (suggestions.length === 1) {
                    username = String(suggestions[0]).trim();
                } else if (suggestions.length > 1) {
                    const msg = 'Выберите контакт из списка';
                    this.setContactStatus(msg, 'error');
                    this.renderContactSuggestions(true);
                    if (input) input.focus();
                    return;
                }
            }
        }

        if (!username) {
            const msg = 'Введите логин контакта';
            this.setContactStatus(msg);
            if (input) input.focus();
            return;
        }

        if (this.S.contacts?.some?.(u => String(u || '').trim().toLowerCase() === username.toLowerCase())) {
            const msg = `Контакт уже добавлен: ${username}`;
            this.setContactStatus(msg, 'success');
            this.addLogEntry({ type: 'INFO', msg, ts: new Date().toLocaleTimeString() });
            if (input) {
                input.value = '';
                input.focus();
            }
            this.updateContactAddButtonState();
            this.hideContactSuggestions();
            return;
        }

        try {
            if (this.isWindowsNativeAuth()) {
                const payload = await this.requestNativeAction({
                    type: NativeMessageTypes.ADD_CONTACT_REQUEST,
                    username,
                });
                this.setContacts(Array.isArray(payload?.data?.contacts) ? payload.data.contacts : []);
                if (input) input.value = '';
                this.updateContactAddButtonState();
                this.hideContactSuggestions();
                this.setContactStatus(`Контакт добавлен: ${username}`, 'success');
                this.addLogEntry({ type: 'SUCCESS', msg: `Контакт добавлен: ${username}`, ts: new Date().toLocaleTimeString() });
                return;
            }
            const requestAddContact = async () => {
                return await this.apiFetch(this.apiRoutes.contacts.list, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username }),
                    interactive: true,
                });
            };

            let res = null;
            let lastError = null;
            for (let attempt = 0; attempt < 2; attempt += 1) {
                try {
                    res = await requestAddContact();
                    lastError = null;
                    break;
                } catch (err) {
                    lastError = err;
                    const msg = String(err?.message || err || '');
                    if (!/load failed|failed to fetch|network error|abort/i.test(msg) || attempt === 1) {
                        break;
                    }
                    await new Promise(resolve => setTimeout(resolve, 250));
                }
            }
            if (!res) {
                throw lastError || new Error('Не удалось добавить контакт');
            }
            if (!res.ok) {
                const text = await res.text();
                throw new Error(text || 'Не удалось добавить контакт');
            }
            const data = await res.json();
            this.setContacts(Array.isArray(data?.contacts) ? data.contacts : []);
            if (input) input.value = '';
            this.updateContactAddButtonState();
            this.hideContactSuggestions();
            this.setContactStatus(`Контакт добавлен: ${username}`, 'success');
            this.addLogEntry({ type: 'SUCCESS', msg: `Контакт добавлен: ${username}`, ts: new Date().toLocaleTimeString() });
        } catch (e) {
            const apiBase = this.getApiBaseUrl();
            const rawMessage = String(e?.message || 'Не удалось добавить контакт');
            const message = /load failed|failed to fetch|network error|abort/i.test(rawMessage)
                ? `Не удалось добавить контакт на ${apiBase}. Проверь адрес сервера и попробуй ещё раз.`
                : rawMessage;
            this.setContactStatus(message, 'error');
            if (/пользователь не найден/i.test(message)) {
                this.renderContactSuggestions(true);
            }
            this.addLogEntry({ type: 'ERROR', msg: message, ts: new Date().toLocaleTimeString() });
        }
    }

    async removeContact(username) {
        if (!this.S.session?.token) {
            this.addLogEntry({ type: 'WARN', msg: 'Удаление контактов доступно только после входа', ts: new Date().toLocaleTimeString() });
            return;
        }
        try {
            if (this.isWindowsNativeAuth()) {
                const payload = await this.requestNativeAction({
                    type: NativeMessageTypes.REMOVE_CONTACT_REQUEST,
                    username,
                });
                this.setContacts(Array.isArray(payload?.data?.contacts) ? payload.data.contacts : []);
                return;
            }
            const res = await this.apiFetch(this.apiRoutes.contacts.byUsername(username), { method: 'DELETE', interactive: true });
            if (!res.ok) {
                const text = await res.text();
                throw new Error(text || 'Не удалось удалить контакт');
            }
            const data = await res.json();
            this.setContacts(Array.isArray(data?.contacts) ? data.contacts : []);
        } catch (e) {
            this.addLogEntry({ type: 'ERROR', msg: e.message || 'Не удалось удалить контакт', ts: new Date().toLocaleTimeString() });
        }
    }

    updateAuthView() {
        const overlay = document.getElementById('authOverlay');
        if (overlay) {
            const shouldShow = !this.S.session?.token && !this.S.auth.dismissed;
            overlay.classList.toggle('visible', shouldShow);
            // The overlay covers whichever view is active underneath, so a
            // native bottom bar must come back while it is up and re-hide once
            // it closes onto the chat screen (notifyNativeMobileNav reads it).
            this.syncNativeMobileNav();
        }

        const authTitle = document.getElementById('authTitle');
        const authHint = document.getElementById('authHint');
        const authError = document.getElementById('authError');
        const loginBtn = document.getElementById('authLoginBtn');
        const regBtn = document.getElementById('authRegisterBtn');
        const guestBtn = document.getElementById('authGuestBtn');
        const vaultSyncNote = document.getElementById('authVaultSyncNote');
        if (authTitle) authTitle.textContent = this.S.auth.mode === 'register' ? 'Создание аккаунта' : 'Вход в аккаунт';
        if (authHint) authHint.textContent = this.S.auth.mode === 'register'
            ? 'Зарегистрируйтесь, чтобы сохранить контакты и историю.'
            : 'Войдите, чтобы синхронизировать сообщения и контакты.';
        if (vaultSyncNote) {
            vaultSyncNote.textContent = this.isVaultCloudSyncEnabled()
                ? 'Ключи переписки будут подгружены из облака при входе.'
                : 'Ключи переписки останутся только на этом устройстве.';
        }
        if (authError) authError.textContent = this.S.auth.error || '';
        if (loginBtn) loginBtn.textContent = this.S.auth.loading
            ? 'Входим...'
            : (this.S.auth.mode === 'register' ? 'Создать аккаунт' : 'Войти');
        if (regBtn) regBtn.textContent = this.S.auth.mode === 'register' ? 'Уже есть аккаунт' : 'Создать аккаунт';
        if (loginBtn) loginBtn.disabled = this.S.auth.loading;
        if (regBtn) regBtn.disabled = this.S.auth.loading;
        if (guestBtn) guestBtn.disabled = this.S.auth.loading;
        this.syncAuthNetworkInput();
        this.renderVaultCloudSyncControls();
        if (!this.S.session?.token && overlay && overlay.classList.contains('visible') && !this.S.auth.fieldsCleared && !this.S.auth.loading) {
            this.clearAuthInputs();
            this.S.auth.fieldsCleared = true;
        }
        this.renderSidebarProfile();
    }

    initChat(name) { 
        if (!this.S.chats[name]) this.S.chats[name] = []; 
    }

    ensureContact(name) {
        if (!name || name === this.myName()) return;
        if (!this.S.contacts.includes(name)) {
            this.S.contacts = [name, ...this.S.contacts];
        }
        this.initChat(name);
    }
});
