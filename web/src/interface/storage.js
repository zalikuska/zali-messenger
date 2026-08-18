// --- ZaliInterface: Ключи localStorage, кэш сообщений, персист контактов. ---
// Часть класса ZaliInterface (см. web/src/interface.js). Тела методов
// перенесены сюда дословно; ZaliMixin копирует дескрипторы на прототип,
// поэтому поведение и неперечисляемость методов те же, что у class-тела.
ZaliMixin(ZaliInterface, class {

    _userSuffix() {
        const u = this.S.session?.username;
        return u ? `_${u}` : '';
    }

    activeServerStorageKey() {
        return `zali_active_server_v1${this._userSuffix()}`;
    }

    activeChannelStorageKey() {
        return `zali_active_channel_v1${this._userSuffix()}`;
    }

    currentContactStorageKey() {
        return `zali_current_contact_v1${this._userSuffix()}`;
    }

    contactsStorageKey() {
        return `zali_contacts_v1${this._userSuffix()}`;
    }

    serverChatsStorageKey() {
        return `zali_server_chats_v1${this._userSuffix()}`;
    }

    mutedChatsStorageKey() {
        return `zali_muted_chats_v1${this._userSuffix()}`;
    }

    // Server-side reset boundary: the production database, uploads and assets were
    // wiped at this moment, so every locally cached account, message, attachment
    // reference and E2E key from before it is dangling. Bumping this string performs
    // exactly one purge per client; clients that already purged carry the same value
    // in `zali_local_reset_v1` and skip it forever after.
    localResetEpoch() {
        return '2026-07-31T19:00:00Z';
    }

    localResetMarkerKey() {
        return 'zali_local_reset_v1';
    }

    // Wipes every local trace of the pre-reset world: localStorage/sessionStorage,
    // the values the native shells inject at document-start (they come from native
    // storage, not from localStorage, so clearing localStorage alone would leave the
    // old crypto key and message cache live for this session), and the native copies
    // themselves via CLEAR_LOCAL_DATA. Network settings survive on purpose — a client
    // pointed at a non-default server must not silently jump back to the default.
    applyLocalDataResetIfNeeded() {
        const epoch = this.localResetEpoch();
        const marker = this.localResetMarkerKey();
        let stored = null;
        try {
            stored = localStorage.getItem(marker);
        } catch (e) {
            return false;
        }
        if (stored === epoch) return false;

        const preserved = new Map();
        const keepKeys = ['zali_network_config_v1'];
        for (const key of keepKeys) {
            try {
                const value = localStorage.getItem(key);
                if (value !== null) preserved.set(key, value);
            } catch (e) {}
        }
        for (const store of [localStorage, sessionStorage]) {
            try {
                const doomed = [];
                for (let i = 0; i < store.length; i += 1) {
                    const key = store.key(i);
                    if (key && key.startsWith('zali_')) doomed.push(key);
                }
                doomed.forEach(key => { try { store.removeItem(key); } catch (e) {} });
            } catch (e) {}
        }
        for (const [key, value] of preserved) {
            try { localStorage.setItem(key, value); } catch (e) {}
        }
        try { localStorage.setItem(marker, epoch); } catch (e) {}

        // Injected at document-start from native storage — already in memory by now.
        try { window.__ZALI_SAVED_KEY = ''; } catch (e) {}
        try { window.__ZALI_MESSAGE_CACHE = { chats: {}, serverChats: {} }; } catch (e) {}
        try { window.__ZALI_CONVERSATION_KEYS = {}; } catch (e) {}
        try { window.__ZALI_PENDING_OUTBOX = []; } catch (e) {}
        try { window.__ZALI_INJECTED_DEVICE_IDENTITY = null; } catch (e) {}
        try { window.__ZALI_SAVED_SESSION = null; } catch (e) {}
        try { window.__ZALI_ACTIVE_CONVERSATION_SCOPE = null; } catch (e) {}

        try {
            if (window.__ZALI_NATIVE?.available) {
                this.postNativeMessage({ type: NativeMessageTypes.CLEAR_LOCAL_DATA, payload: {} });
            }
        } catch (e) {}

        try {
            console.log('[ZALI] local data reset applied for epoch', epoch);
        } catch (e) {}
        return true;
    }

    messageCacheStorageKey() {
        return `zali_message_cache_v1${this._userSuffix()}`;
    }

    networkConfigStorageKey() {
        return 'zali_network_config_v1';
    }

    cryptoKeyStorageKey() {
        return `zali_crypto_key_v2${this._userSuffix()}`;
    }

    deviceIdentityStorageKey() {
        return `zali_device_identity_v1${this._userSuffix()}`;
    }

    authStorageKey() {
        return 'zali_session_v1';
    }

    lastAuthStorageKey() {
        return 'zali_last_session_v1';
    }

    recentAccountsStorageKey() {
        return 'zali_recent_accounts_v1';
    }

    pendingOutboxStorageKey() {
        return `zali_pending_outbox_v1${this._userSuffix()}`;
    }

    loadStoredMessageCache() {
        try {
            // Deliberately does NOT fall back to the old unsuffixed 'zali_message_cache_v1'
            // key: that was a one-time migration for the pre-per-account-storage era, but
            // left active it means every brand-new account's first load silently adopts
            // whatever chats a DIFFERENT previous account left behind on this browser —
            // "ghost" conversations with people this account never talked to. Same reasoning
            // applies to the crypto key / conversation keys / device identity loaders below.
            let raw = localStorage.getItem(this.messageCacheStorageKey());
            if (!raw) return this.loadInjectedMessageCache();
            const parsed = JSON.parse(raw);
            const chats = parsed && typeof parsed === 'object' && parsed.chats && typeof parsed.chats === 'object'
                ? parsed.chats
                : {};
            const serverChats = parsed && typeof parsed === 'object' && parsed.serverChats && typeof parsed.serverChats === 'object'
                ? parsed.serverChats
                : {};
            if (!Object.keys(chats).length && !Object.keys(serverChats).length) {
                return this.loadInjectedMessageCache();
            }
            return {
                chats: Object.fromEntries(Object.entries(chats).filter(([, msgs]) => Array.isArray(msgs)).map(([peer, msgs]) => [peer, msgs.filter(msg => msg && typeof msg === 'object')])),
                serverChats: Object.fromEntries(Object.entries(serverChats).filter(([, msgs]) => Array.isArray(msgs)).map(([peer, msgs]) => [peer, msgs.filter(msg => msg && typeof msg === 'object')])),
            };
        } catch (e) {
            return this.loadInjectedMessageCache();
        }
    }

    loadInjectedMessageCache() {
        try {
            const raw = window.__ZALI_MESSAGE_CACHE;
            if (!raw) return { chats: {}, serverChats: {} };
            const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (!parsed || typeof parsed !== 'object') return { chats: {}, serverChats: {} };
            const chats = parsed.chats && typeof parsed.chats === 'object' ? parsed.chats : {};
            const serverChats = parsed.serverChats && typeof parsed.serverChats === 'object' ? parsed.serverChats : {};
            return {
                chats: Object.fromEntries(Object.entries(chats).filter(([, msgs]) => Array.isArray(msgs)).map(([peer, msgs]) => [peer, msgs.filter(msg => msg && typeof msg === 'object')])),
                serverChats: Object.fromEntries(Object.entries(serverChats).filter(([, msgs]) => Array.isArray(msgs)).map(([peer, msgs]) => [peer, msgs.filter(msg => msg && typeof msg === 'object')])),
            };
        } catch (e) {
            return { chats: {}, serverChats: {} };
        }
    }

    // Debounced wrapper for saveStoredMessageCache(). The full save serializes EVERY
    // chat (JSON.stringify of the whole store), writes localStorage AND ships the whole
    // payload over the native bridge — doing that once per received message made bursts
    // (history merge, reconnect catch-up, busy group chat) quadratic in total work.
    // Trailing-edge coalesce: bursts collapse into one save ≤400ms after the first call.
    scheduleSaveStoredMessageCache(delayMs = 400) {
        if (this._messageCacheSaveTimer) return;
        this._messageCacheSaveTimer = setTimeout(() => {
            this._messageCacheSaveTimer = null;
            this.saveStoredMessageCache();
        }, Math.max(0, Number(delayMs) || 0));
    }

    // Flush a pending debounced save immediately (page hide, logout, account switch) so
    // the last ≤400ms of messages are never lost to a teardown racing the timer.
    flushPendingMessageCacheSave() {
        if (!this._messageCacheSaveTimer) return;
        clearTimeout(this._messageCacheSaveTimer);
        this._messageCacheSaveTimer = null;
        this.saveStoredMessageCache();
    }

    saveStoredMessageCache() {
        // Keeps dataUrl (native: self-contained data: URL, survives reload; browser: a
        // blob: URL, already dead on the next page load regardless of what's cached —
        // that case is repaired by the network resync in loadBrowserDmHistory/
        // syncActiveConversation, not by this cache). Dropping dataUrl here used to mean
        // every attachment permanently degraded to a name-only, undownloadable placeholder
        // on the next native launch, since archivePath was never wired to any re-fetch.
        // localStorage quota overflow (large attachments) already falls back gracefully
        // via warnStorageFallback below.
        const sanitizeMessages = (store) => Object.fromEntries(Object.entries(store || {}).map(([key, msgs]) => [
            key,
            Array.isArray(msgs) ? msgs.map(msg => ({
                ...msg,
                attachments: this.normalizeAttachments(msg.attachments),
            })) : [],
        ]));
        const payload = {
            chats: sanitizeMessages(this.S.chats),
            serverChats: sanitizeMessages(this.S.serverChats),
        };
        const json = JSON.stringify(payload);
        const storageKey = this.messageCacheStorageKey();
        // The two expensive halves of a save are the synchronous localStorage write
        // (disk I/O on the main thread) and the native bridge post, which serialises
        // the whole store a second time to cross the IPC boundary. Plenty of saves are
        // scheduled by state churn that leaves the persisted shape byte-identical
        // (status flips that normalise away, re-merges of already-known history), and
        // those used to pay both costs for nothing. The storage key is part of the
        // guard so an account switch never inherits the previous account's "already
        // saved" verdict.
        const unchanged = this._lastSavedMessageCacheJson === json
            && this._lastSavedMessageCacheKey === storageKey;
        this.saveInjectedMessageCache(json);
        if (unchanged) return;

        try {
            localStorage.setItem(storageKey, json);
            this._lastSavedMessageCacheJson = json;
            this._lastSavedMessageCacheKey = storageKey;
        } catch (e) {
            // A failed write must not be remembered as saved, or the retry that the
            // next scheduled save would have been gets skipped too.
            this._lastSavedMessageCacheJson = null;
            this._lastSavedMessageCacheKey = null;
            this.trace(`saveStoredMessageCache localStorage failed reason=${e?.name || e?.message || e}`);
            this.warnStorageFallback('message_cache', `Не удалось сохранить кеш сообщений в localStorage: ${e?.name || e?.message || e}`);
        }
        if (this.nativeSupports('saveMessageCache')) {
            this.postNativeMessage({
                type: NativeMessageTypes.SAVE_MESSAGE_CACHE,
                cache: payload,
            });
        }
    }

    saveInjectedMessageCache(value) {
        try {
            window.__ZALI_MESSAGE_CACHE = typeof value === 'string' ? value : JSON.stringify(value || { chats: {}, serverChats: {} });
        } catch (e) {}
    }

    normalizeDmChatStore() {
        const me = String(this.myName() || '').trim();
        if (!me) return false;

        const normalized = {};
        let changed = false;

        const pushMessage = (peer, msg, originalKey) => {
            const nextPeer = String(peer || '').trim();
            if (!nextPeer) return;
            if (!normalized[nextPeer]) normalized[nextPeer] = [];
            normalized[nextPeer].push(msg);
            if (String(originalKey || '').trim() !== nextPeer) {
                changed = true;
            }
        };

        Object.entries(this.S.chats || {}).forEach(([key, msgs]) => {
            if (!Array.isArray(msgs)) return;
            msgs.forEach(msg => {
                if (!msg || typeof msg !== 'object') return;
                const sender = String(msg.sender || '').trim();
                const receiver = String(msg.receiver || '').trim();
                const canonicalPeer = sender === me
                    ? receiver
                    : (receiver === me ? sender : '');

                if (canonicalPeer) {
                    pushMessage(canonicalPeer, msg, key);
                } else {
                    pushMessage(String(key || '').trim(), msg, key);
                }
            });
        });

        Object.keys(normalized).forEach(peer => {
            normalized[peer].sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));
        });

        const before = JSON.stringify(this.S.chats || {});
        const after = JSON.stringify(normalized);
        if (before !== after) {
            this.S.chats = normalized;
            this.saveStoredMessageCache();
            this.trace(`normalizeDmChatStore changed peers=${Object.keys(normalized).length}`);
            return true;
        }

        this.S.chats = normalized;
        return changed;
    }

    loadStoredCurrentContact() {
        try {
            const raw = localStorage.getItem(this.currentContactStorageKey());
            const value = String(raw || '').trim();
            return value || null;
        } catch (e) {
            return null;
        }
    }

    saveStoredCurrentContact(name) {
        try {
            const value = String(name || '').trim();
            if (value) {
                localStorage.setItem(this.currentContactStorageKey(), value);
            } else {
                localStorage.removeItem(this.currentContactStorageKey());
            }
        } catch (e) {}
    }

    loadStoredContacts() {
        try {
            const raw = localStorage.getItem(this.contactsStorageKey());
            const parsed = raw ? JSON.parse(raw) : [];
            return Array.isArray(parsed)
                ? parsed.map(item => String(item || '').trim()).filter(Boolean)
                : [];
        } catch (e) {
            return [];
        }
    }

    saveStoredContacts(contacts) {
        try {
            const list = Array.isArray(contacts)
                ? contacts.map(item => String(item || '').trim()).filter(Boolean)
                : [];
            localStorage.setItem(this.contactsStorageKey(), JSON.stringify(list));
        } catch (e) {}
    }

    localConversationContacts() {
        const me = String(this.myName() || '').trim();
        const names = new Set();
        const add = (name) => {
            const value = String(name || '').trim();
            if (value && value !== me) names.add(value);
        };
        Object.entries(this.S.chats || {}).forEach(([peer, msgs]) => {
            if (Array.isArray(msgs) && msgs.length > 0) add(peer);
        });
        add(this.S.current);
        add(this.loadStoredCurrentContact());
        return Array.from(names);
    }

    loadStoredCryptoKey() {
        try {
            const scope = String(this.activeConversationScope || window.__ZALI_ACTIVE_CONVERSATION_SCOPE || '').trim();
            if (scope) {
                const scoped = this.getStoredConversationKey(scope);
                if (scoped) return scoped;
            }
            // No fallback to the legacy unsuffixed 'zali_crypto_key_v2' key — see the
            // comment in loadStoredMessageCache() for why: it would hand a brand-new
            // account a previous, unrelated account's leftover E2E key.
            let stored = (sessionStorage.getItem(this.cryptoKeyStorageKey()) || localStorage.getItem(this.cryptoKeyStorageKey()) || '').trim();
            this.trace(`loadStoredCryptoKey stored=${!!stored}`);
            if (stored) {
                try {
                    sessionStorage.setItem(this.cryptoKeyStorageKey(), stored);
                    localStorage.removeItem(this.cryptoKeyStorageKey());
                } catch (e) {}
                return stored;
            }
            return '';
        } catch (e) {
            this.trace('loadStoredCryptoKey error fallback empty');
            return '';
        }
    }
});
