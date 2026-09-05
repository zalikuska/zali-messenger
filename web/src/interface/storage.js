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
    //
    // 2026-09-05: production migrated from `zms` to `ms` with no data carried over
    // (old host lost/inaccessible) — a second, unrelated reset boundary, same purge.
    localResetEpoch() {
        return '2026-09-05T21:00:00Z';
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
            return this.restoreAttachmentPayloads({
                chats: Object.fromEntries(Object.entries(chats).filter(([, msgs]) => Array.isArray(msgs)).map(([peer, msgs]) => [peer, msgs.filter(msg => msg && typeof msg === 'object')])),
                serverChats: Object.fromEntries(Object.entries(serverChats).filter(([, msgs]) => Array.isArray(msgs)).map(([peer, msgs]) => [peer, msgs.filter(msg => msg && typeof msg === 'object')])),
            });
        } catch (e) {
            return this.loadInjectedMessageCache();
        }
    }

    // localStorage wins over the native-injected cache, so once an archive stops
    // fitting the quota and the payload-free copy takes over (see
    // writeMessageCacheToStorage), the winning copy is the one WITHOUT the
    // attachment bytes — that would silently turn every photo in history into a
    // name-only placeholder on the next native launch. The native cache file has
    // no quota and still holds the payloads: fold them back in, by message id.
    //
    // No-op in a plain browser tab (nothing is injected) and no-op when nothing
    // is missing, which is the normal case — the probe below stops at the first
    // attachment that already has its payload.
    restoreAttachmentPayloads(cache) {
        const needsPayload = (store) => Object.values(store || {}).some(msgs => (msgs || []).some(
            msg => (msg?.attachments || []).some(att => att && !att.dataUrl && !att.data_url),
        ));
        if (!needsPayload(cache.chats) && !needsPayload(cache.serverChats)) return cache;

        let injected;
        try {
            injected = this.loadInjectedMessageCache();
        } catch (e) {
            return cache;
        }
        const byId = new Map();
        for (const store of [injected.chats, injected.serverChats]) {
            for (const msgs of Object.values(store || {})) {
                for (const msg of msgs || []) {
                    const id = String(msg?.id || msg?.clientId || '').trim();
                    if (id && (msg.attachments || []).length) byId.set(id, msg.attachments);
                }
            }
        }
        if (!byId.size) return cache;

        let restored = 0;
        for (const store of [cache.chats, cache.serverChats]) {
            for (const msgs of Object.values(store || {})) {
                for (const msg of msgs || []) {
                    const attachments = msg?.attachments || [];
                    if (!attachments.length) continue;
                    const source = byId.get(String(msg.id || msg.clientId || '').trim());
                    if (!source) continue;
                    attachments.forEach((att, index) => {
                        if (!att || att.dataUrl || att.data_url) return;
                        const from = source[index];
                        // Position AND name must agree: a message edited on
                        // another device can carry a different attachment set
                        // under the same id.
                        if (!from || from.name !== att.name) return;
                        const payload = from.dataUrl || from.data_url || '';
                        if (payload) { att.dataUrl = payload; restored += 1; }
                    });
                }
            }
        }
        if (restored) this.trace(`restoreAttachmentPayloads restored=${restored}`);
        return cache;
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

    // The persisted shape of an attachment. Deliberately NOT the render shape:
    // normalizeAttachment() also returns `src`, a blob: URL that is dead the
    // moment the page reloads, and writing it to disk would both waste space and
    // leave a dangling reference in the cache.
    persistableAttachment(att) {
        return {
            id: att.id,
            name: att.name,
            mimeType: att.mimeType,
            kind: att.kind,
            size: att.size,
            dataUrl: att.dataUrl,
            archivePath: att.archivePath,
        };
    }

    // The same store with every attachment payload removed. This — not the full
    // copy — is what localStorage normally receives, and it is also the change
    // detector for the whole save. See saveStoredMessageCache().
    stripMessageCachePayloads(payload) {
        const strip = (store) => Object.fromEntries(Object.entries(store || {}).map(([key, msgs]) => [
            key,
            (msgs || []).map(msg => (
                (msg.attachments || []).length
                    ? { ...msg, attachments: msg.attachments.map(att => ({ ...att, dataUrl: '' })) }
                    : msg
            )),
        ]));
        return { chats: strip(payload.chats), serverChats: strip(payload.serverChats) };
    }

    // True when the attachment payloads are safe to leave out of the localStorage
    // copy, because something else on this platform is keeping them.
    //
    //   macOS  — declares saveMessageCache, so the full payload goes to the
    //            native cache file (no quota) and loadStoredMessageCache() folds
    //            it back in.
    //   browser— the payload is a blob: URL that is already dead on the next page
    //            load, so persisting it never achieved anything; history is
    //            repaired by the network resync instead.
    //   Windows/iOS/Android — no native cache file, so localStorage is the only
    //            copy there is. Payloads are kept until they stop fitting, and
    //            writeMessageCacheToStorage() drops them at that point.
    messageCachePayloadsHeldElsewhere() {
        if (this.nativeSupports('saveMessageCache')) return true;
        return !this.hasNativeBridge();
    }

    saveStoredMessageCache() {
        const sanitizeMessages = (store) => Object.fromEntries(Object.entries(store || {}).map(([key, msgs]) => [
            key,
            Array.isArray(msgs) ? msgs.map(msg => ({
                ...msg,
                attachments: this.normalizeAttachments(msg.attachments).map(att => this.persistableAttachment(att)),
            })) : [],
        ]));
        const payload = {
            chats: sanitizeMessages(this.S.chats),
            serverChats: sanitizeMessages(this.S.serverChats),
        };
        const storageKey = this.messageCacheStorageKey();

        // The change detector is the PAYLOAD-FREE serialisation, not the full one.
        //
        // This used to be JSON.stringify() of the entire store, attachment base64
        // and all: ~9 ms of main-thread work on a modest conversation with photos,
        // paid on every save including the many that change nothing (a status flip
        // that normalises away, a re-merge of already-known history). Attachment
        // bytes are immutable once received — a message whose attachments change
        // is a different message, with different ids and sizes, and those ARE in
        // this string — so the payload adds nothing a change detector can use.
        const json = JSON.stringify(this.stripMessageCachePayloads(payload));
        const unchanged = this._lastSavedMessageCacheJson === json
            && this._lastSavedMessageCacheKey === storageKey;
        // The object, not a string: loadInjectedMessageCache() accepts either, and
        // handing it the object skips a second full serialisation of the archive.
        this.saveInjectedMessageCache(payload);
        if (unchanged) return;

        this.writeMessageCacheToStorage(storageKey, json, payload);
        if (this.nativeSupports('saveMessageCache')) {
            this.postNativeMessage({
                type: NativeMessageTypes.SAVE_MESSAGE_CACHE,
                cache: payload,
            });
        }
    }

    // Writes the cache, and — this is the point — never gets stuck retrying a
    // write that cannot succeed.
    //
    // An archive with photos in it passes the localStorage quota (5–10 MB
    // everywhere) long before the account gets big. The write then throws, and
    // the old code answered that by clearing the "already saved" latch, so the
    // very next message rebuilt the entire archive, threw again, and copied the
    // whole thing over the native bridge again. Measured: ten consecutive
    // messages cost 80 MB of bridge traffic, ~8 MB each, permanently, for the
    // rest of the session. That is the shape of "it gets slower the longer you
    // use it".
    //
    // Two changes. Once a full write fails the client switches to a payload-free
    // copy for localStorage (text and history survive a reload; the attachment
    // bytes live on in the native cache file, and loadStoredMessageCache() folds
    // them back in). And a failed attempt is still recorded against the JSON it
    // failed on, so an unchanged store is not retried — a genuinely new message
    // produces different JSON and is always attempted.
    writeMessageCacheToStorage(storageKey, liteJson, payload) {
        // Platforms that keep the payloads elsewhere write the payload-free copy
        // outright — nothing is lost, and the write stays proportional to the
        // text of the conversation instead of to the photos in it.
        if (this._messageCacheLiteMode || this.messageCachePayloadsHeldElsewhere()) {
            try {
                localStorage.setItem(storageKey, liteJson);
            } catch (e) {
                this.trace(`saveStoredMessageCache localStorage failed reason=${e?.name || e?.message || e}`);
            }
            this._lastSavedMessageCacheJson = liteJson;
            this._lastSavedMessageCacheKey = storageKey;
            return;
        }

        // Windows, iOS and Android have no native cache file, so localStorage is
        // the only copy of an attachment there is — keep the payloads for as long
        // as they fit, then stop trying.
        try {
            localStorage.setItem(storageKey, JSON.stringify(payload));
        } catch (e) {
            this._messageCacheLiteMode = true;
            this.trace(`saveStoredMessageCache localStorage full, dropping attachment payloads reason=${e?.name || e?.message || e}`);
            this.warnStorageFallback('message_cache', 'Вложения не помещаются в локальный кеш — сохраняются только тексты сообщений.');
            try {
                localStorage.setItem(storageKey, liteJson);
            } catch (inner) {
                this.trace(`saveStoredMessageCache localStorage failed even without payloads reason=${inner?.name || inner?.message || inner}`);
            }
        }
        // Recorded whatever happened. The old code cleared this latch on failure
        // so the "retry" would not be skipped — but the retry was byte-identical
        // and failed identically, so every subsequent message re-serialised and
        // re-copied the entire archive for nothing: measured at 80 MB of bridge
        // traffic across ten messages, permanently, for the rest of the session.
        // A genuinely new message produces a different string and is always tried.
        this._lastSavedMessageCacheJson = liteJson;
        this._lastSavedMessageCacheKey = storageKey;
    }

    // Stored as the object it already is. loadInjectedMessageCache() accepts
    // either shape, and stringifying here meant a second full serialisation of
    // every attachment in the archive on every save, purely to hand the result
    // back to a JSON.parse() later in the same page.
    saveInjectedMessageCache(value) {
        try {
            window.__ZALI_MESSAGE_CACHE = value || { chats: {}, serverChats: {} };
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
            normalized[peer].sort((a, b) => this.compareMessagesByTime(a, b));
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
