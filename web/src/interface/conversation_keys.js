// --- ZaliInterface: Реестр ключей разговоров и облачный vault-снапшот. ---
// Часть класса ZaliInterface (см. web/src/interface.js). Тела методов
// перенесены сюда дословно; ZaliMixin копирует дескрипторы на прототип,
// поэтому поведение и неперечисляемость методов те же, что у class-тела.
ZaliMixin(ZaliInterface, class {

    conversationKeysStorageKey() {
        return `zali_conversation_keys_v2${this._userSuffix()}`;
    }

    cloudVaultSnapshotStorageKey() {
        return `zali_cloud_vault_snapshot_v2${this._userSuffix()}`;
    }

    vaultUnlockStorageKey() {
        return `zali_vault_unlock_v2${this._userSuffix()}`;
    }

    keyMaterialEpochStorageKey() {
        return `zali_key_material_epoch${this._userSuffix()}`;
    }

    vaultResetPendingStorageKey() {
        return `zali_vault_reset_pending_v2${this._userSuffix()}`;
    }

    vaultCloudSyncEnabledStorageKey() {
        return `zali_vault_cloud_sync_enabled_v1${this._userSuffix()}`;
    }

    loadVaultCloudSyncEnabled() {
        try {
            const raw = localStorage.getItem(this.vaultCloudSyncEnabledStorageKey());
            if (raw == null) return false;
            return String(raw).trim().toLowerCase() !== 'false';
        } catch (e) {
            return false;
        }
    }

    saveVaultCloudSyncEnabled(enabled) {
        try {
            localStorage.setItem(this.vaultCloudSyncEnabledStorageKey(), enabled ? 'true' : 'false');
        } catch (e) {}
    }

    applyVaultCloudSyncEnabled(enabled, { persistLocal = true } = {}) {
        const next = !!enabled;
        this.S.auth.cloudVaultSyncEnabled = next;
        if (persistLocal) {
            this.saveVaultCloudSyncEnabled(next);
        }
        this.renderVaultCloudSyncControls();
        this.updateAuthView();
    }

    isVaultCloudSyncEnabled() {
        return !!this.S.auth?.cloudVaultSyncEnabled;
    }

    async saveAccountVaultCloudSyncEnabled(enabled) {
        if (!this.S.session?.token) return false;
        try {
            const res = await this.apiFetch(this.apiRoutes.auth.me, {
                method: 'PATCH',
                body: JSON.stringify({ cloudVaultSyncEnabled: !!enabled }),
            });
            if (!res.ok) {
                throw new Error(await res.text().catch(() => 'Не удалось сохранить настройку'));
            }
            const data = await res.json().catch(() => null);
            if (data && typeof data.cloudVaultSyncEnabled !== 'undefined') {
                this.applyVaultCloudSyncEnabled(!!data.cloudVaultSyncEnabled, { persistLocal: true });
            }
            return true;
        } catch (e) {
            this.trace(`saveAccountVaultCloudSyncEnabled failed error=${e?.message || e}`);
            this.S.auth.error = e?.message || 'Не удалось сохранить настройку облачной синхронизации ключей';
            this.updateAuthView();
            return false;
        }
    }

    async setVaultCloudSyncEnabled(enabled) {
        const next = !!enabled;
        const previous = this.isVaultCloudSyncEnabled();
        this.applyVaultCloudSyncEnabled(next, { persistLocal: true });
        if (this.S.session?.token) {
            const ok = await this.saveAccountVaultCloudSyncEnabled(next);
            if (!ok) {
                this.applyVaultCloudSyncEnabled(previous, { persistLocal: true });
                return;
            }
        }
        if (this.cloudVaultSyncTimer) {
            clearTimeout(this.cloudVaultSyncTimer);
            this.cloudVaultSyncTimer = 0;
        }
        if (this.S.auth.cloudVaultSyncEnabled && this.S.session?.token && this.S.auth?.vaultPassphrase) {
            void this.syncCloudVaultPackage({ passphrase: this.S.auth.vaultPassphrase, reason: 'vault-sync-enabled' });
        }
    }

    renderVaultCloudSyncControls() {
        const checkbox = document.getElementById('inputVaultCloudSyncEnabled');
        if (checkbox) {
            checkbox.checked = this.isVaultCloudSyncEnabled();
        }
    }

    // Canonical form of a conversation scope.
    //
    // The scope string used to be built from whatever casing the caller happened
    // to hold — a contact typed by hand, a username off a message, a roster entry
    // — while the registry, the envelope table and the server's participant check
    // all compare it byte-exactly. One differently-cased character therefore
    // forked a conversation into two scopes that could never converge: separate
    // registry claims, separate envelope buckets, and a 403 from the server for
    // whichever side held the mis-cased form (its own username no longer matches
    // either participant). Production carried both `dm:pivovarca:zalikus` and
    // `dm:Pivovarca:zalikus` in the registry although only `Pivovarca` exists as
    // an account, plus scopes naming users that never existed at all.
    //
    // `server:` scopes are left alone: their ids come from the server, so every
    // participant already derives the identical string.
    canonicalConversationScope(scope) {
        const value = String(scope || '').trim();
        if (!value.startsWith('dm:')) return value;
        const parts = value.split(':');
        if (parts.length !== 3) return value;
        const a = parts[1].trim().toLowerCase();
        const b = parts[2].trim().toLowerCase();
        if (!a || !b) return value;
        // Sorted on the lowercased form, not merely lowercased after sorting:
        // `Zulu` sorts before `test` by UTF-16 code unit but after it once
        // lowercased, so sorting the original casing would leave the participant
        // order itself case-dependent.
        return `dm:${[a, b].sort().join(':')}`;
    }

    // Scopes are canonically lowercased, but the API addresses users by their real
    // casing (`users.username` is a case-sensitive primary key), so a name taken
    // back out of a scope must be mapped to the casing the server knows before it
    // can be used in a request path.
    resolveKnownUsernameCasing(username) {
        const value = String(username || '').trim();
        if (!value) return '';
        const lower = value.toLowerCase();
        const me = String(this.myName() || '').trim();
        if (me && me.toLowerCase() === lower) return me;
        for (const pool of [this.S.contacts, this.S.users]) {
            if (!Array.isArray(pool)) continue;
            const hit = pool.find(item => String(item || '').trim().toLowerCase() === lower);
            if (hit) return String(hit).trim();
        }
        return value;
    }

    conversationScopeKey(peer = null, serverId = null, channelId = null) {
        const sid = String(serverId || '').trim();
        const cid = String(channelId || '').trim();
        if (sid && cid) {
            return `server:${sid}:${cid}`;
        }
        const me = String(this.myName() || '').trim();
        const other = String(peer || this.S.current || '').trim();
        if (!me || !other) return '';
        return this.canonicalConversationScope(`dm:${me}:${other}`);
    }

    dmScopeOwner(scope) {
        // For a DM scope `dm:a:b` (participants sorted), the lexicographically
        // smaller participant is the canonical owner of the conversation key.
        // Lowercased, like the scope itself — compare it case-insensitively.
        const parts = String(scope || '').split(':');
        if (parts[0] !== 'dm') return '';
        return String(parts[1] || '').trim().toLowerCase();
    }

    addAltConversationKey(stored, scope, key) {
        // Store a non-active conversation key so it still appears in the candidate
        // pool used for decryption (native tries every value of the keys map), while
        // leaving stored[scope] — the active key used for sending — untouched.
        const value = String(key || '').trim();
        if (!value || !scope) return false;
        if (String(stored[scope] || '').trim() === value) return false;
        // Map key embeds the value, so re-adding the same key is idempotent.
        const altKey = `alt:${scope}:${value}`;
        if (Object.prototype.hasOwnProperty.call(stored, altKey)) return false;
        stored[altKey] = value;
        return true;
    }

    // Switches the active (sending) key for a scope while keeping the outgoing one
    // in the candidate pool.
    //
    // Every adoption site used to do this by hand as
    //     addAltConversationKey(stored, scope, current); stored[scope] = next;
    // which silently dropped `current` every single time: at that moment
    // stored[scope] IS current, so addAltConversationKey's "already the active key"
    // guard returned false without storing anything, and the next line overwrote it.
    // The device then could not decrypt its own already-sent messages — the exact
    // «перебрано ключей N (ни один не подошёл)» symptom, produced by the very code
    // meant to prevent it. Doing the demotion in one place makes the order
    // impossible to get wrong again.
    setActiveConversationKey(stored, scope, nextKey) {
        const scoped = String(scope || '').trim();
        const next = String(nextKey || '').trim();
        if (!scoped || !next) return false;
        const current = String(stored[scoped] || '').trim();
        if (current === next) return false;
        stored[scoped] = next;
        if (current) this.addAltConversationKey(stored, scoped, current);
        return true;
    }

    // ---------------------------------------------------------------------
    // Canonical conversation-key registry (server-backed, see
    // server/src/conversation_keys.rs).
    //
    // Historically "which key is the real one for this conversation" had no
    // answer anywhere: whoever opened a chat with an empty local key store
    // invented a random key and started encrypting with it, and convergence was
    // attempted after the fact with a lexicographic-owner tiebreak that did not
    // apply to channels at all. The registry replaces guessing with a fact: the
    // first claim for a scope wins, everyone else can see they hold the wrong
    // key and ask for a republish instead of silently forking the conversation.
    //
    // Only a SHA-256 fingerprint of the key ever leaves the device.
    // ---------------------------------------------------------------------

    async conversationKeyId(key) {
        const value = String(key || '').trim();
        if (!value) return '';
        if (!this._keyIdCache) this._keyIdCache = new Map();
        const cached = this._keyIdCache.get(value);
        if (cached) return cached;
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
        const id = this.base64FromBytes(new Uint8Array(digest))
            .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
        this._keyIdCache.set(value, id);
        return id;
    }

    canonicalKeyIdCache() {
        if (!this._canonicalKeyIds) this._canonicalKeyIds = new Map();
        return this._canonicalKeyIds;
    }

    // Serializes read-modify-write cycles over the conversation-key store.
    //
    // promoteCanonicalConversationKey is fired in the background (not awaited)
    // from several places at once — resolveConversationCryptoKey for every chat
    // that already has a key, and reconcileVaultScopes after a vault sync. Each
    // call does loadStoredConversationKeys() → mutate → saveStoredConversationKeys(),
    // and without serializing them, two concurrent calls for different scopes can
    // race: the second one's load can miss the first one's not-yet-saved write,
    // and its save then clobbers it. The lost update is a promotion, not real key
    // material — self-heals on the next resolve/sync — but there is no reason to
    // leave the race in when queuing the callback is nearly free.
    withConversationKeysWriteLock(fn) {
        const previous = this._conversationKeysWriteLock || Promise.resolve();
        const run = previous.then(fn, fn);
        this._conversationKeysWriteLock = run.catch(() => {});
        return run;
    }

    // Every key this device could decrypt with for a scope: the active one plus
    // every `alt:` candidate. Used to promote an already-held key to active once
    // the registry tells us which one is canonical.
    conversationKeyCandidates(stored, scope) {
        const scoped = String(scope || '').trim();
        if (!scoped) return [];
        const out = [];
        const push = (value) => {
            const key = String(value || '').trim();
            if (key && !out.includes(key)) out.push(key);
        };
        push(stored[scoped]);
        const prefix = `alt:${scoped}:`;
        for (const [name, value] of Object.entries(stored || {})) {
            if (name.startsWith(prefix)) push(value);
        }
        return out;
    }

    async fetchCanonicalKeyIds(scopes = []) {
        const list = Array.from(new Set(
            (Array.isArray(scopes) ? scopes : [scopes])
                .map(scope => String(scope || '').trim())
                .filter(Boolean)
        )).slice(0, 200);
        if (!list.length || !this.S.session?.token) return new Map();
        try {
            const res = await this.apiFetch(this.apiRoutes.conversationKeys.lookup(list.join(',')), { includeDeviceId: true });
            if (!res.ok) throw new Error(await res.text().catch(() => 'lookup failed'));
            const rows = await res.json();
            const cache = this.canonicalKeyIdCache();
            if (Array.isArray(rows)) {
                for (const row of rows) {
                    const scope = String(row?.scope || '').trim();
                    const keyId = String(row?.keyId || '').trim();
                    if (scope && keyId) cache.set(scope, keyId);
                }
            }
            return cache;
        } catch (e) {
            // A failed lookup must never be read as "no canonical key exists" —
            // that is exactly the mistake that made clients invent keys. Callers
            // check `has(scope)`, and an absent entry means "unknown", not "none".
            this.trace(`fetchCanonicalKeyIds failed error=${e?.message || e}`);
            return this.canonicalKeyIdCache();
        }
    }

    // Returns { keyId, mine, claimedBy } or null when the claim could not be made.
    // `mine === false` means another device already owns this scope's key and the
    // caller is holding a fork.
    async claimConversationKey(scope, key, { force = false, reason = 'auto' } = {}) {
        const scoped = String(scope || '').trim();
        const secret = String(key || '').trim();
        if (!scoped || !secret || !this.S.session?.token) return null;
        try {
            const keyId = await this.conversationKeyId(secret);
            const res = await this.apiFetch(this.apiRoutes.conversationKeys.claim, {
                method: 'POST',
                includeDeviceId: true,
                body: JSON.stringify({ scope: scoped, keyId, force: !!force }),
            });
            if (!res.ok) throw new Error(await res.text().catch(() => 'claim failed'));
            const data = await res.json();
            const winner = String(data?.keyId || '').trim();
            if (winner) this.canonicalKeyIdCache().set(scoped, winner);
            this.trace(`claimConversationKey reason=${reason} scope=${scoped} mine=${!!data?.mine} claimedBy=${data?.claimedBy || ''}`);
            return { keyId: winner, mine: !!data?.mine, claimedBy: String(data?.claimedBy || '') };
        } catch (e) {
            this.trace(`claimConversationKey failed reason=${reason} scope=${scoped} error=${e?.message || e}`);
            return null;
        }
    }

    async requestKeyRepublish(scope, { reason = 'auto' } = {}) {
        const scoped = String(scope || '').trim();
        if (!scoped || !this.S.session?.token) return false;
        try {
            const res = await this.apiFetch(this.apiRoutes.conversationKeys.republish, {
                method: 'POST',
                includeDeviceId: true,
                body: JSON.stringify({ scope: scoped }),
            });
            if (!res.ok) throw new Error(await res.text().catch(() => 'republish request failed'));
            this.trace(`requestKeyRepublish reason=${reason} scope=${scoped}`);
            return true;
        } catch (e) {
            this.trace(`requestKeyRepublish failed reason=${reason} scope=${scoped} error=${e?.message || e}`);
            return false;
        }
    }

    // If one of the keys this device already holds for `scope` matches the
    // canonical key id, make it the active (sending) key. Returns the promoted
    // key, or '' when none of the local candidates is the canonical one.
    async promoteCanonicalConversationKey(scope, canonicalKeyId, { reason = 'auto' } = {}) {
        const scoped = String(scope || '').trim();
        const wanted = String(canonicalKeyId || '').trim();
        if (!scoped || !wanted) return '';
        // See withConversationKeysWriteLock: this fires unawaited from several
        // places at once, so its load-mutate-save must not race a concurrent call
        // for a different scope.
        return this.withConversationKeysWriteLock(async () => {
            const stored = this.loadStoredConversationKeys();
            const active = String(stored[scoped] || '').trim();
            if (active && await this.conversationKeyId(active) === wanted) return active;
            for (const candidate of this.conversationKeyCandidates(stored, scoped)) {
                if (await this.conversationKeyId(candidate) !== wanted) continue;
                this.setActiveConversationKey(stored, scoped, candidate);
                this.saveStoredConversationKeys(stored);
                this.trace(`promoteCanonicalConversationKey reason=${reason} scope=${scoped} promoted=true`);
                return candidate;
            }
            return '';
        });
    }

    // Reconcile the local active key for a scope with the server registry.
    // Returns the key that should be used for sending.
    async reconcileConversationKey(scope, localKey, { reason = 'auto' } = {}) {
        const scoped = String(scope || '').trim();
        const local = String(localKey || '').trim();
        if (!scoped || !local) return local;
        // A scope queued by resetEncryptionKeys takes the registry over by force —
        // the user explicitly asked for new keys, so the old claim must not win.
        const force = !!this._forceClaimScopes?.has(scoped);
        const claim = await this.claimConversationKey(scoped, local, { reason, force });
        if (force) this._forceClaimScopes.delete(scoped);
        if (!claim || claim.mine) return local;

        // Someone else claimed this scope first. Prefer a key we already hold
        // that matches, otherwise ask the holders to republish an envelope for
        // this device and pick it up on the next sync.
        const promoted = await this.promoteCanonicalConversationKey(scoped, claim.keyId, { reason });
        if (promoted) {
            this.setKey(promoted);
            this.updateCryptoKeyDisplay({ key: promoted });
            return promoted;
        }
        await this.requestKeyRepublish(scoped, { reason });
        await this.syncIncomingKeyEnvelopes({ reason: `reconcile:${reason}`, triggerRefresh: false });
        const afterSync = await this.promoteCanonicalConversationKey(scoped, claim.keyId, { reason: `${reason}:afterSync` });
        if (afterSync) {
            this.setKey(afterSync);
            this.updateCryptoKeyDisplay({ key: afterSync });
            return afterSync;
        }
        // Still missing. Keep sending with the local key rather than blocking the
        // user — the peer stores every incoming envelope key as a decryption
        // candidate, so these messages stay readable on their side — and keep the
        // scope marked so a later sync can still promote the canonical key.
        this.addLogEntry({
            type: 'WARN',
            msg: `Канонический ключ диалога ещё не получен (scope=${scoped}), запрошена повторная публикация`,
            ts: new Date().toLocaleTimeString(),
        });
        return local;
    }

    keyEnvelopeOverridesLocal(scope, payload) {
        // Only the canonical owner's envelope may replace an existing local key.
        // The owner always keeps its own key; the non-owner adopts the owner's,
        // so both peers converge on a single key regardless of who generated
        // a key first (otherwise each side keeps its own and decryption fails).
        const owner = this.dmScopeOwner(scope);
        if (!owner) return false;
        // Both sides lowercased: the owner comes out of a canonical scope, while
        // myName()/payload.sender carry the account's real casing.
        const me = String(this.myName() || '').trim().toLowerCase();
        const sender = String(payload?.sender || '').trim().toLowerCase();
        return sender === owner && me !== owner;
    }

    // Fold legacy, differently-cased scope strings onto their canonical form.
    //
    // Applied on every load rather than once: a legacy-cased scope can arrive at
    // any time from the cloud vault or from a peer still running a client that
    // predates canonicalConversationScope, and a key filed under a scope nobody
    // looks up any more is a key that has been silently lost.
    canonicalizeConversationKeyScopes(map) {
        const source = map && typeof map === 'object' ? map : {};
        const out = {};
        const demoted = [];
        for (const [rawScope, rawValue] of Object.entries(source)) {
            const value = String(rawValue || '').trim();
            if (!value) continue;
            const scope = String(rawScope || '');
            if (scope.startsWith('alt:')) {
                // `alt:<scope>:<value>`; both scope kinds are exactly 3 segments and
                // the value is base64url, so it never contributes a colon. The map
                // key embeds the value, so it is rebuilt rather than renamed.
                const parts = scope.split(':');
                const rebuilt = `alt:${this.canonicalConversationScope(parts.slice(1, 4).join(':'))}:${value}`;
                out[rebuilt] = value;
                continue;
            }
            const canonical = this.canonicalConversationScope(scope);
            if (!Object.prototype.hasOwnProperty.call(out, canonical)) {
                out[canonical] = value;
            } else if (out[canonical] !== value) {
                // Two casings of one conversation each carried a key. Neither may be
                // dropped: whichever loses the active slot still decrypts whatever
                // history was written under it, so it survives as a candidate.
                demoted.push([canonical, value]);
            }
        }
        for (const [canonical, value] of demoted) {
            this.addAltConversationKey(out, canonical, value);
        }
        return out;
    }

    loadStoredConversationKeys() {
        try {
            // No fallback to the legacy unsuffixed 'zali_conversation_keys_v2' key — see
            // the comment in loadStoredMessageCache() for why: this one is the most
            // severe case, since it would hand a brand-new account every per-DM E2E key
            // a previous, unrelated account on this browser ever had.
            // Both stores are read AND merged, never one-or-the-other. Conversation
            // keys used to live in sessionStorage with localStorage actively deleted
            // on every save, which meant every browser/PWA restart (and every native
            // shell without a key-injection bridge — iOS and Android have none) came
            // up with an empty key map. An empty map is indistinguishable from "this
            // conversation has no key yet", so the client invented a fresh random key
            // and encrypted real messages with it. Losing key material is strictly
            // worse than storing it at rest in a store the same origin already owns.
            const readStore = (store) => {
                try {
                    const raw = store.getItem(this.conversationKeysStorageKey());
                    if (!raw) return null;
                    const parsed = JSON.parse(raw);
                    return parsed && typeof parsed === 'object' ? parsed : null;
                } catch (e) {
                    return null;
                }
            };
            const injected = window.__ZALI_CONVERSATION_KEYS && typeof window.__ZALI_CONVERSATION_KEYS === 'object'
                ? window.__ZALI_CONVERSATION_KEYS
                : {};
            const persisted = readStore(localStorage);
            const session = readStore(sessionStorage);
            if (!persisted && !session) return this.canonicalizeConversationKeyScopes(injected);
            // sessionStorage last: within one session it is the freshest writer.
            const merged = this.canonicalizeConversationKeyScopes({
                ...injected,
                ...(persisted || {}),
                ...(session || {}),
            });
            try {
                const encoded = JSON.stringify(merged || {});
                sessionStorage.setItem(this.conversationKeysStorageKey(), encoded);
                localStorage.setItem(this.conversationKeysStorageKey(), encoded);
            } catch (e) {}
            return merged && typeof merged === 'object' ? merged : {};
        } catch (e) {
            return {};
        }
    }

    getStoredConversationKey(scope) {
        const key = String(scope || '').trim();
        if (!key) return '';
        const stored = this.loadStoredConversationKeys();
        return String(stored[key] || '').trim();
    }

    syncNativeConversationKeys(keys = null) {
        if (!this.nativeSupports('setKey')) return;
        const conversationKeys = keys && typeof keys === 'object' ? keys : this.loadStoredConversationKeys();
        const scope = String(window.__ZALI_ACTIVE_CONVERSATION_SCOPE || this.activeConversationScope || '').trim();
        const key = scope
            ? String(conversationKeys[scope] || '').trim()
            : String(sessionStorage.getItem(this.cryptoKeyStorageKey()) || localStorage.getItem(this.cryptoKeyStorageKey()) || '').trim();
        let signature = '';
        try {
            signature = JSON.stringify({
                scope,
                key,
                conversationKeys: Object.keys(conversationKeys || {}).sort().reduce((acc, itemKey) => {
                    acc[itemKey] = String(conversationKeys[itemKey] || '').trim();
                    return acc;
                }, {}),
            });
        } catch (e) {
            signature = `${scope}:${key}:${Object.keys(conversationKeys || {}).length}`;
        }
        if (signature && signature === this.lastNativeConversationKeySignature) {
            return;
        }
        this.lastNativeConversationKeySignature = signature;
        this.postNativeMessage({
            type: NativeMessageTypes.SET_KEY,
            key,
            scope,
            conversationKeys,
        });
    }

    saveStoredConversationKeys(keys) {
        try {
            const encoded = JSON.stringify(keys || {});
            sessionStorage.setItem(this.conversationKeysStorageKey(), encoded);
            // Durable copy — see loadStoredConversationKeys() for why dropping this
            // was the single largest source of "сообщение зашифровано не тем ключом".
            localStorage.setItem(this.conversationKeysStorageKey(), encoded);
            this.syncNativeConversationKeys(keys || {});
            if (this.S.session?.token && this.S.auth?.vaultPassphrase && !this.cloudVaultSyncInFlight) {
                this.scheduleCloudVaultSync(300);
            }
        } catch (e) {}
    }

    clearLegacyKeyMaterial() {
        try {
            if (localStorage.getItem(this.keyMaterialEpochStorageKey()) === '2') return;
            [
                'zali_crypto_key_v1',
                'zali_conversation_keys_v1',
                'zali_cloud_vault_snapshot_v1',
                'zali_vault_unlock_v1',
            ].forEach(key => {
                try { localStorage.removeItem(key); } catch (e) {}
                try { sessionStorage.removeItem(key); } catch (e) {}
            });
            try { window.__ZALI_SAVED_KEY = ''; } catch (e) {}
            try { window.__ZALI_CONVERSATION_KEYS = {}; } catch (e) {}
            localStorage.setItem(this.vaultResetPendingStorageKey(), 'true');
            localStorage.setItem(this.keyMaterialEpochStorageKey(), '2');
            this.trace('clearLegacyKeyMaterial epoch=2 legacy_keys_cleared=true');
        } catch (e) {
            this.trace(`clearLegacyKeyMaterial failed error=${e?.message || e}`);
        }
    }

    async ensureServerVaultReset({ reason = 'auto' } = {}) {
        if (!this.S.session?.token) return false;
        try {
            if (localStorage.getItem(this.vaultResetPendingStorageKey()) !== 'true') return false;
            const res = await this.apiFetch(this.apiRoutes.vault.events, { method: 'DELETE' });
            if (!res.ok) {
                throw new Error(await res.text().catch(() => 'Не удалось очистить server vault'));
            }
            localStorage.removeItem(this.vaultResetPendingStorageKey());
            this.trace(`ensureServerVaultReset reason=${reason} cleared=true`);
            return true;
        } catch (e) {
            this.trace(`ensureServerVaultReset failed reason=${reason} error=${e?.message || e}`);
            return false;
        }
    }

    async encryptCloudVaultSnapshot(payload, secret) {
        const salt = new Uint8Array(16);
        const iv = new Uint8Array(12);
        crypto.getRandomValues(salt);
        crypto.getRandomValues(iv);
        const key = await this.deriveVaultAesKey(secret, salt);
        const plain = new TextEncoder().encode(JSON.stringify(payload || {}));
        const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain);
        return JSON.stringify({
            v: 1,
            kdf: 'PBKDF2-SHA256',
            iterations: 210000,
            aead: 'AES-256-GCM',
            salt: this.base64FromBytes(salt),
            iv: this.base64FromBytes(iv),
            ciphertext: this.base64FromBytes(ciphertext),
        });
    }

    async decryptCloudVaultSnapshot(packageText, secret) {
        const raw = String(packageText || '').trim();
        if (!raw) return null;
        const envelope = JSON.parse(raw);
        if (envelope.v !== 1) throw new Error('Unsupported vault version');
        if (typeof envelope.iterations === 'number' && envelope.iterations < 100000) {
            throw new Error('Vault KDF iterations too low');
        }
        const salt = this.bytesFromBase64(envelope.salt);
        const iv = this.bytesFromBase64(envelope.iv);
        const ciphertext = this.bytesFromBase64(envelope.ciphertext);
        const key = await this.deriveVaultAesKey(secret, salt);
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
        return JSON.parse(new TextDecoder().decode(new Uint8Array(plain)));
    }

    async saveCloudVaultSnapshot(payload, secret = null) {
        const token = String(secret || this.S.session?.token || '').trim();
        if (!token || !payload || typeof payload !== 'object') return false;
        try {
            const encrypted = await this.encryptCloudVaultSnapshot(payload, token);
            localStorage.setItem(this.cloudVaultSnapshotStorageKey(), encrypted);
            this._vaultSnapshotApplied = false; // invalidate cache so next restore re-decrypts
            return true;
        } catch (e) {
            this.trace(`saveCloudVaultSnapshot error=${e?.message || e}`);
            return false;
        }
    }

    async encryptVaultUnlockSecret(secret, token) {
        const passphrase = String(secret || '').trim();
        const guard = String(token || '').trim();
        if (!passphrase || !guard) return '';
        const salt = new Uint8Array(16);
        const iv = new Uint8Array(12);
        crypto.getRandomValues(salt);
        crypto.getRandomValues(iv);
        const key = await this.deriveVaultAesKey(guard, salt);
        const plain = new TextEncoder().encode(passphrase);
        const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain);
        return JSON.stringify({
            v: 1,
            kdf: 'PBKDF2-SHA256',
            iterations: 210000,
            aead: 'AES-256-GCM',
            salt: this.base64FromBytes(salt),
            iv: this.base64FromBytes(iv),
            ciphertext: this.base64FromBytes(ciphertext),
        });
    }

    async decryptVaultUnlockSecret(raw, token) {
        const guard = String(token || '').trim();
        const encoded = String(raw || '').trim();
        if (!guard || !encoded) return '';
        const envelope = JSON.parse(encoded);
        if (envelope.v !== 1) throw new Error('Unsupported vault version');
        if (typeof envelope.iterations === 'number' && envelope.iterations < 100000) {
            throw new Error('Vault KDF iterations too low');
        }
        const salt = this.bytesFromBase64(envelope.salt);
        const iv = this.bytesFromBase64(envelope.iv);
        const ciphertext = this.bytesFromBase64(envelope.ciphertext);
        const key = await this.deriveVaultAesKey(guard, salt);
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
        return new TextDecoder().decode(new Uint8Array(plain)).trim();
    }

    async saveVaultUnlockSecret(secret, token = null) {
        const passphrase = String(secret || '').trim();
        const guard = String(token || this.S.session?.token || '').trim();
        try {
            if (!passphrase || !guard) {
                localStorage.removeItem(this.vaultUnlockStorageKey());
                return false;
            }
            const encrypted = await this.encryptVaultUnlockSecret(passphrase, guard);
            localStorage.setItem(this.vaultUnlockStorageKey(), encrypted);
            return true;
        } catch (e) {
            this.trace(`saveVaultUnlockSecret error=${e?.message || e}`);
            return false;
        }
    }

    async loadVaultUnlockSecret(token = null) {
        const guard = String(token || this.S.session?.token || '').trim();
        if (!guard) return '';
        try {
            const raw = localStorage.getItem(this.vaultUnlockStorageKey());
            if (!raw) return '';
            return await this.decryptVaultUnlockSecret(raw, guard);
        } catch (e) {
            this.trace(`loadVaultUnlockSecret error=${e?.message || e}`);
            return '';
        }
    }

    async restoreCloudVaultSnapshot({ reason = 'auto' } = {}) {
        const token = String(this.S.session?.token || '').trim();
        if (!token) return false;
        // Skip if already applied this session (vault snapshot doesn't change until saveCloudVaultSnapshot)
        if (this._vaultSnapshotApplied) return false;
        // Deduplicate concurrent calls — only one PBKDF2 derivation at a time
        if (this._restoreVaultInFlight) return this._restoreVaultInFlight;
        this._restoreVaultInFlight = (async () => {
            try {
                const raw = localStorage.getItem(this.cloudVaultSnapshotStorageKey());
                if (!raw) return false;
                const payload = await this.decryptCloudVaultSnapshot(raw, token);
                const count = this.applyVaultPlainPayload(payload);
                this.trace(`restoreCloudVaultSnapshot reason=${reason} count=${count}`);
                if (count >= 0) this._vaultSnapshotApplied = true;
                return count > 0;
            } catch (e) {
                this.trace(`restoreCloudVaultSnapshot failed reason=${reason} error=${e?.message || e}`);
                return false;
            } finally {
                this._restoreVaultInFlight = null;
            }
        })();
        return this._restoreVaultInFlight;
    }
});
