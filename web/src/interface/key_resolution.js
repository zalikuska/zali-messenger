// --- ZaliInterface: Разрешение ключа разговора, идентичность устройства, крипто-примитивы конвертов и vault. ---
// Часть класса ZaliInterface (см. web/src/interface.js). Тела методов
// перенесены сюда дословно; ZaliMixin копирует дескрипторы на прототип,
// поэтому поведение и неперечисляемость методов те же, что у class-тела.
ZaliMixin(ZaliInterface, class {

    async resolveConversationCryptoKey({ peer = null, serverId = null, channelId = null, reason = 'auto' } = {}) {
        const scope = this.conversationScopeKey(peer, serverId, channelId);
        if (!scope) return '';
        if (!this._resolveKeyInFlight) this._resolveKeyInFlight = new Map();
        if (this._resolveKeyInFlight.has(scope)) return this._resolveKeyInFlight.get(scope);
        const promise = this._resolveConversationCryptoKeyImpl({ peer, serverId, channelId, reason });
        this._resolveKeyInFlight.set(scope, promise);
        try { return await promise; } finally { this._resolveKeyInFlight.delete(scope); }
    }

    async _resolveConversationCryptoKeyImpl({ peer = null, serverId = null, channelId = null, reason = 'auto' } = {}) {
        const scope = this.conversationScopeKey(peer, serverId, channelId);
        if (!scope) return '';
        this.activeConversationScope = scope;
        try {
            window.__ZALI_ACTIVE_CONVERSATION_SCOPE = scope;
        } catch (e) {}

        const existing = this.getStoredConversationKey(scope);
        if (existing) {
            this.syncNativeConversationKeys();
            this.updateCryptoKeyDisplay({
                key: existing,
                peer,
                serverId,
                channelId,
            });
            // Reconcile with the server registry in the background: a key that is
            // present locally can still be a fork invented by this device before
            // the real one arrived. Not awaited — a stale-but-working key must not
            // delay opening the chat.
            void this.reconcileConversationKey(scope, existing, { reason: `existing:${reason}` });
            return existing;
        }

        if (this.S.session?.token) {
            const recoveredVaultPassphrase = this.S.auth?.vaultPassphrase || await this.loadVaultUnlockSecret(this.S.session.token);
            if (recoveredVaultPassphrase) {
                this.S.auth.vaultPassphrase = recoveredVaultPassphrase;
                await this.restoreCloudVaultSnapshot({ reason: `resolveConversationCryptoKey:${reason}` });
                // restoreCloudVaultSnapshot читает только локальный кэш — на свежем
                // устройстве он пуст, а фоновый sync из postAuthSetup ещё не успел
                // сходить в облако. Без этого await ключ генерировался временным,
                // хотя настоящий уже лежал в cloud vault (гонка на ~1 секунду).
                if (!this.getStoredConversationKey(scope) && !this._cloudVaultResolveFetchDone) {
                    this._cloudVaultResolveFetchDone = true;
                    await this.syncCloudVaultPackage({ passphrase: recoveredVaultPassphrase, reason: `resolveConversationCryptoKey:${reason}` });
                }
            }
            await this.syncIncomingKeyEnvelopes({ reason: `resolveConversationCryptoKey:${reason}`, triggerRefresh: false });

            // A timed-out/dropped vault or envelope fetch above looks identical to "this
            // conversation genuinely has no key yet" — both just leave the scope unresolved.
            // That distinction matters a lot here: inventing a local key below is NOT
            // reversible — it gets published to the peer as the new canonical key, silently
            // orphaning the real key (and all history encrypted under it) that a slower
            // network round-trip would have found. So retry a couple of times with backoff
            // before giving up, instead of inventing on the very first empty result.
            // Does a canonical key already exist for this scope? If so, inventing
            // one here would be strictly wrong — the answer is to make the holders
            // republish an envelope for this device, not to fork the conversation.
            await this.fetchCanonicalKeyIds([scope]);
            const knownCanonical = this.canonicalKeyIdCache().get(scope) || '';
            if (knownCanonical) {
                const promoted = await this.promoteCanonicalConversationKey(scope, knownCanonical, { reason });
                if (!promoted) await this.requestKeyRepublish(scope, { reason });
            }

            // Wait only when there is something to wait FOR.
            //
            // This used to sleep 1.5 s and then 3 s unconditionally, with a vault sync
            // and an envelope sync inside each round — up to 4.5 s of dead time plus
            // six round trips, awaited on the path that opens a chat and on the path
            // that sends a message. The reason for waiting at all is sound and stays:
            // inventing a key here is irreversible, it gets published as the scope's
            // key, and doing that because a slow round trip had not landed yet orphans
            // the real key along with every message under it.
            //
            // But that risk only exists when a key we do not have might be out there.
            // The registry answers exactly that question, and it has already been asked
            // above: `knownCanonical` set means somebody holds a key for this scope, so
            // waiting is warranted. Empty means the lookup succeeded and found no claim
            // — nothing to lose the race to — and the retries were pure latency.
            //
            // A FAILED lookup is not "no claim": fetchCanonicalKeyIds returns its cache
            // on error and an absent entry means "unknown". That case is treated as
            // worth waiting for, same as a known claim.
            //
            // Which is why this asks canonicalLookupSucceeded() rather than looking at
            // the cache: an absent cache entry is produced BOTH by "the registry has no
            // claim" and by "we never got an answer", so testing the cache would have
            // reported "unknown" every single time and this whole branch would have
            // waited exactly as long as before while looking like it did not.
            const worthWaiting = !!knownCanonical || !this.canonicalLookupSucceeded(scope);
            if (worthWaiting) {
                for (let attempt = 0; attempt < 2 && !this.getStoredConversationKey(scope); attempt += 1) {
                    this.trace(`resolveConversationCryptoKey reason=${reason} scope=${scope} retry=${attempt} canonical=${knownCanonical ? 'known' : 'unknown'}`);
                    await new Promise(resolve => setTimeout(resolve, 600 + attempt * 1200));
                    if (recoveredVaultPassphrase) {
                        await this.syncCloudVaultPackage({ passphrase: recoveredVaultPassphrase, reason: `resolveConversationCryptoKey:${reason}:retry${attempt}` });
                    }
                    await this.syncIncomingKeyEnvelopes({ reason: `resolveConversationCryptoKey:${reason}:retry${attempt}`, triggerRefresh: false });
                    if (knownCanonical && !this.getStoredConversationKey(scope)) {
                        await this.promoteCanonicalConversationKey(scope, knownCanonical, { reason: `${reason}:retry${attempt}` });
                    }
                }
            } else {
                this.trace(`resolveConversationCryptoKey reason=${reason} scope=${scope} no_wait=true registry_empty=true`);
            }
        }

        const restored = this.getStoredConversationKey(scope);
        if (restored) {
            this.syncNativeConversationKeys();
            this.updateCryptoKeyDisplay({
                key: restored,
                peer,
                serverId,
                channelId,
            });
            void this.reconcileConversationKey(scope, restored, { reason: `restored:${reason}` });
            return restored;
        }

        const localKey = this.randomBase64(32).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
        // Through the same write lock promoteCanonicalConversationKey uses below —
        // this scope's first write must not race a concurrent background
        // reconcile/promote running for a different scope at the same time.
        await this.withConversationKeysWriteLock(() => {
            const stored = this.loadStoredConversationKeys();
            stored[scope] = localKey;
            this.saveStoredConversationKeys(stored);
        });
        this.setKey(localKey);
        this.trace(`resolveConversationCryptoKey reason=${reason} scope=${scope} generated=true`);

        // Register the new key as this scope's canonical one. First-write-wins, so
        // if another device already claimed the scope while we were generating,
        // reconcileConversationKey adopts the winner (from a candidate we already
        // hold, or by asking the holders to republish) instead of leaving two live
        // keys behind. This is the step that makes divergence self-correcting
        // rather than permanent.
        const reconciled = await this.reconcileConversationKey(scope, localKey, { reason: `generated:${reason}` });
        if (reconciled && reconciled !== localKey) {
            this.updateCryptoKeyDisplay({ key: reconciled, peer, serverId, channelId });
            return reconciled;
        }

        const owner = this.dmScopeOwner(scope);
        const meName = String(this.myName() || '').trim().toLowerCase();
        const isChannelScope = !!(serverId && channelId);
        if (owner && meName && owner !== meName) {
            // Non-owner had to invent a key because the owner's envelope was not
            // available/decryptable yet — incoming messages from the peer will stay
            // unreadable until the owner's key is adopted.
            this.addLogEntry({ type: 'WARN', msg: `Ключ диалога не получен от собеседника, сгенерирован временный (scope=${scope})`, ts: new Date().toLocaleTimeString() });
        } else if (isChannelScope) {
            this.addLogEntry({ type: 'INFO', msg: `Сгенерирован новый ключ канала (scope=${scope})`, ts: new Date().toLocaleTimeString() });
        } else {
            this.addLogEntry({ type: 'INFO', msg: `Сгенерирован новый ключ диалога (scope=${scope})`, ts: new Date().toLocaleTimeString() });
        }
        this.updateCryptoKeyDisplay({ key: localKey, peer, serverId, channelId });

        // Own devices first, and for every scope kind: a channel key is just as
        // unreachable for our other devices as a DM key is, and they have no other
        // way back to it once the cloud vault lags.
        void this.publishConversationKeyToOwnDevices({ scope, key: localKey, reason });

        const requiresPeerEnvelope = !!(peer && !serverId && !channelId && String(peer).trim() !== this.myName());
        if (requiresPeerEnvelope) {
            void this.publishConversationKeyToPeer({ peer, scope, key: localKey, reason }).then((published) => {
                if (published === true) {
                    if (!this._publishedKeyScopes) this._publishedKeyScopes = new Set();
                    this._publishedKeyScopes.add(scope);
                } else {
                    // 'no_devices' included: the peer has no registered devices yet, so
                    // nothing was delivered — keep the scope unmarked so the next send
                    // retries once the peer's device appears.
                    this.trace(`resolveConversationCryptoKey reason=${reason} scope=${scope} publish_pending=true result=${published}`);
                }
            });
        } else if (isChannelScope) {
            // Channel keys used to only ever be generated locally and never handed
            // to the rest of the server — every member who opened the channel before
            // anyone else's envelope arrived invented their own random key, so only
            // members who happened to share crypto material some other way (e.g.
            // multi-device vault sync) could read each other. Fan the new key out to
            // every other current server member the same way DM keys are published.
            void this.publishConversationKeyToServerMembers({ serverId, channelId, scope, key: localKey, reason });
        }
        return localKey;
    }

    ensureConversationCryptoKey({ peer = null, serverId = null, channelId = null, reason = 'auto' } = {}) {
        const scope = this.conversationScopeKey(peer, serverId, channelId);
        if (!scope) return '';
        const stored = this.getStoredConversationKey(scope);
        if (stored) {
            this.activeConversationScope = scope;
            try {
                window.__ZALI_ACTIVE_CONVERSATION_SCOPE = scope;
            } catch (e) {}
            this.syncNativeConversationKeys();
            this.updateCryptoKeyDisplay({
                key: stored,
                peer,
                serverId,
                channelId,
            });
            return stored;
        }

        this.trace(`ensureConversationCryptoKey reason=${reason} scope=${scope} missing`);
        void this.resolveConversationCryptoKey({ peer, serverId, channelId, reason });
        this.updateCryptoKeyDisplay({
            key: '',
            peer,
            serverId,
            channelId,
        });
        return '';
    }

    updateCryptoKeyDisplay({ key = null, peer = null, serverId = null, channelId = null } = {}) {
        const valueEl = document.getElementById('currentCryptoKeyValue');
        const metaEl = document.getElementById('currentCryptoKeyMeta');
        const currentKey = String(key || this.loadStoredCryptoKey() || '').trim();
        if (valueEl) valueEl.textContent = currentKey ? `задан (${currentKey.length} символов)` : 'не задан';
        if (metaEl) {
            if (serverId && channelId) {
                metaEl.textContent = `Контекст: сервер ${serverId} / канал ${channelId}`;
            } else if (peer) {
                metaEl.textContent = `Контекст: диалог с ${peer}`;
            } else {
                metaEl.textContent = 'Контекст: общий ключ';
            }
        }
    }

    base64FromBytes(bytes) {
        const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
        let binary = '';
        for (let i = 0; i < arr.length; i += 0x8000) {
            binary += String.fromCharCode(...arr.subarray(i, i + 0x8000));
        }
        return btoa(binary);
    }

    bytesFromBase64(value) {
        const binary = atob(String(value || ''));
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    }

    randomBase64(size = 32) {
        const bytes = new Uint8Array(size);
        if (window.crypto?.getRandomValues) {
            window.crypto.getRandomValues(bytes);
        } else {
            throw new Error('Secure random unavailable: window.crypto.getRandomValues is required');
        }
        return this.base64FromBytes(bytes);
    }

    defaultDeviceLabel() {
        const platform = navigator.userAgentData?.platform || navigator.platform || 'Web';
        const agent = /Windows/i.test(navigator.userAgent) ? 'Windows'
            : /Mac/i.test(navigator.userAgent) ? 'Mac'
                : /iPhone|iPad/i.test(navigator.userAgent) ? 'iOS'
                    : /Android/i.test(navigator.userAgent) ? 'Android'
                        : 'Browser';
        return `${agent} ${platform}`.trim();
    }

    loadDeviceIdentity() {
        try {
            const raw = localStorage.getItem(this.deviceIdentityStorageKey());
            const parsed = raw ? JSON.parse(raw) : null;
            if (parsed?.deviceId && parsed?.publicKey) return parsed;
            // Deliberately no fallback to the legacy unsuffixed 'zali_device_identity_v1'
            // key here — see the comment in loadStoredMessageCache() for why: it would
            // hand a brand-new account a previous, unrelated account's device identity
            // (and with it, that account's approved-device status on the server).
            // This WKWebView's own storage has no identity yet — before generating a
            // fresh one (which the server would treat as a brand-new, unapproved
            // device with no key envelopes), check for an identity exported by another
            // shell on the same machine (see native.rs's injected_device_identity).
            const injected = this.loadInjectedDeviceIdentity();
            if (injected?.deviceId && injected?.publicKey) {
                try { localStorage.setItem(this.deviceIdentityStorageKey(), JSON.stringify(injected)); } catch (e) {}
                this.trace(`loadDeviceIdentity adopted injected identity deviceId=${injected.deviceId}`);
                return injected;
            }
        } catch (e) {}
        const identity = {
            deviceId: `dev_${this.randomBase64(18).replace(/[+/=]/g, '').slice(0, 24)}`,
            label: this.defaultDeviceLabel(),
            publicKey: this.randomBase64(32),
            signingKey: this.randomBase64(32),
            keyPackage: {
                version: 1,
                kind: 'zali-device-key-package',
                createdAt: new Date().toISOString(),
            },
        };
        try {
            localStorage.setItem(this.deviceIdentityStorageKey(), JSON.stringify(identity));
        } catch (e) {}
        return identity;
    }

    saveDeviceIdentity(identity) {
        try {
            localStorage.setItem(this.deviceIdentityStorageKey(), JSON.stringify(identity || {}));
        } catch (e) {}
        // Mirror the identity to the native shell so it survives a WebView storage wipe
        // (rebuild / restart / cleared data dir). Without this the Rust/Windows shell had
        // no persistence beyond localStorage — every wipe minted a fresh device_id, which
        // orphaned all previously-published key envelopes (they are addressed to a specific
        // recipient_device_id) and broke key convergence. See persistDeviceIdentityToNative.
        this.persistDeviceIdentityToNative(identity);
    }

    // Push the full device identity (incl. privateKeyJwk + e2ee keyPackage) to the native
    // shell, which writes shared_device_identity_{username}.json and re-injects it on the
    // next launch via window.__ZALI_INJECTED_DEVICE_IDENTITY. Mirrors what the macOS Swift
    // client already does; makes the identity stable per (machine, account) on all shells.
    persistDeviceIdentityToNative(identity) {
        try {
            if (!this.hasNativeBridge()) return;
            const username = String(this.myName() || '').trim();
            const deviceId = String(identity?.deviceId || '').trim();
            // No username yet (pre-auth) → we cannot name the per-user file; a later
            // post-auth save (bootstrapDeviceTrust) will persist it once the user is known.
            if (!username || !deviceId) return;
            this.postNativeMessage({
                type: NativeMessageTypes.PERSIST_DEVICE_IDENTITY,
                username,
                identity: JSON.stringify(identity),
            });
        } catch (e) {}
    }

    // Whose account the native shell's document-start injection belongs to.
    //
    // macOS, Windows and Android all inject the LAST logged-in user's device
    // identity and conversation keys before the page script runs, and nothing
    // cleared them when a different account signed in — the globals live for the
    // lifetime of the document, while applySession only swaps the in-page session.
    // So logging in as B on a device that last ran as A merged A's conversation keys
    // into B's key store (from there into B's cloud vault) and, when B had no local
    // identity yet, handed B A's device identity including its private ECDH key.
    // The localStorage legacy fallbacks two functions below were removed for exactly
    // this hazard; the injected channel had no such guard.
    //
    // Shells that stamp `__ZALI_INJECTED_FOR_USER` get checked against it. Older
    // shells do not set it at all, and for them the pre-existing behaviour stands —
    // wrong only on the account-switch path, which is what the stamp fixes going
    // forward. An empty myName() means we are still booting and do not yet know who
    // we are; adopting is right there, and it is the normal single-account path.
    injectedMaterialMatchesAccount() {
        try {
            const stamped = String(window.__ZALI_INJECTED_FOR_USER || '').trim().toLowerCase();
            if (!stamped) return true;
            const me = String(this.myName() || '').trim().toLowerCase();
            if (!me) return true;
            return me === stamped;
        } catch (e) {
            return true;
        }
    }

    loadInjectedDeviceIdentity() {
        try {
            if (!this.injectedMaterialMatchesAccount()) return null;
            const raw = window.__ZALI_INJECTED_DEVICE_IDENTITY;
            if (!raw) return null;
            const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
            return (parsed && typeof parsed === 'object') ? parsed : null;
        } catch (e) {
            return null;
        }
    }

    currentDeviceId() {
        return String(this.S.deviceTrust?.current?.deviceId || this.loadDeviceIdentity()?.deviceId || '').trim();
    }

    async ensureDeviceCryptoIdentity() {
        const identity = this.loadDeviceIdentity();
        const e2ee = identity?.keyPackage?.e2ee;
        if (e2ee?.publicJwk && identity?.privateKeyJwk && e2ee?.alg === 'ECDH-P-256+A256GCM') {
            return identity;
        }
        if (!window.crypto?.subtle) {
            throw new Error('WebCrypto недоступен для E2E ключей устройства');
        }
        const keyPair = await crypto.subtle.generateKey(
            { name: 'ECDH', namedCurve: 'P-256' },
            true,
            ['deriveKey']
        );
        const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
        const privateJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
        const next = {
            ...identity,
            publicKey: JSON.stringify(publicJwk),
            privateKeyJwk: privateJwk,
            keyPackage: {
                ...(identity.keyPackage && typeof identity.keyPackage === 'object' ? identity.keyPackage : {}),
                version: 2,
                kind: 'zali-device-key-package',
                createdAt: identity.keyPackage?.createdAt || new Date().toISOString(),
                e2ee: {
                    alg: 'ECDH-P-256+A256GCM',
                    publicJwk,
                    createdAt: new Date().toISOString(),
                },
            },
        };
        this.saveDeviceIdentity(next);
        this.S.deviceTrust.current = next;
        return next;
    }

    devicePublicJwk(device) {
        const kp = device?.keyPackage && typeof device.keyPackage === 'object' ? device.keyPackage : {};
        if (kp?.e2ee?.alg === 'ECDH-P-256+A256GCM' && kp?.e2ee?.publicJwk) {
            return kp.e2ee.publicJwk;
        }
        try {
            const parsed = JSON.parse(String(device?.publicKey || ''));
            if (parsed?.kty === 'EC' && parsed?.crv === 'P-256') return parsed;
        } catch (e) {}
        return null;
    }

    async importEcdhPublicKey(jwk) {
        return await crypto.subtle.importKey(
            'jwk',
            jwk,
            { name: 'ECDH', namedCurve: 'P-256' },
            false,
            []
        );
    }

    async importEcdhPrivateKey(jwk) {
        return await crypto.subtle.importKey(
            'jwk',
            jwk,
            { name: 'ECDH', namedCurve: 'P-256' },
            false,
            ['deriveKey']
        );
    }

    async deriveEnvelopeAesKey(privateKey, publicKey, usages) {
        return await crypto.subtle.deriveKey(
            { name: 'ECDH', public: publicKey },
            privateKey,
            { name: 'AES-GCM', length: 256 },
            false,
            usages
        );
    }

    async encryptConversationKeyEnvelope({ scope, key, recipientDevice, peer }) {
        const identity = await this.ensureDeviceCryptoIdentity();
        const recipientJwk = this.devicePublicJwk(recipientDevice);
        if (!recipientJwk) throw new Error('Устройство получателя без E2E public key');
        const recipientPublicKey = await this.importEcdhPublicKey(recipientJwk);
        const ephemeral = await crypto.subtle.generateKey(
            { name: 'ECDH', namedCurve: 'P-256' },
            true,
            ['deriveKey']
        );
        const aesKey = await this.deriveEnvelopeAesKey(ephemeral.privateKey, recipientPublicKey, ['encrypt']);
        const iv = new Uint8Array(12);
        crypto.getRandomValues(iv);
        const plain = new TextEncoder().encode(JSON.stringify({
            scope,
            key,
            sender: this.myName(),
            peer,
            senderDeviceId: identity.deviceId,
            recipientDeviceId: recipientDevice.deviceId,
            createdAt: new Date().toISOString(),
        }));
        const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, plain);
        const ephemeralPublicJwk = await crypto.subtle.exportKey('jwk', ephemeral.publicKey);
        return JSON.stringify({
            version: 2,
            kind: 'zali-conversation-key-envelope',
            alg: 'ECDH-P-256+A256GCM',
            scope,
            sender: this.myName(),
            senderDeviceId: identity.deviceId,
            recipientDeviceId: recipientDevice.deviceId,
            ephemeralPublicJwk,
            iv: this.base64FromBytes(iv),
            ciphertext: this.base64FromBytes(ciphertext),
        });
    }

    async decryptConversationKeyEnvelope(encryptedKey) {
        const identity = await this.ensureDeviceCryptoIdentity();
        const envelope = JSON.parse(String(encryptedKey || ''));
        if (envelope?.version !== 2 || envelope?.kind !== 'zali-conversation-key-envelope') {
            throw new Error('Неподдерживаемый key envelope');
        }
        if (String(envelope.recipientDeviceId || '') !== String(identity.deviceId || '')) {
            throw new Error('Envelope предназначен другому устройству');
        }
        const privateKey = await this.importEcdhPrivateKey(identity.privateKeyJwk);
        const ephemeralPublicKey = await this.importEcdhPublicKey(envelope.ephemeralPublicJwk);
        const aesKey = await this.deriveEnvelopeAesKey(privateKey, ephemeralPublicKey, ['decrypt']);
        const plain = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: this.bytesFromBase64(envelope.iv) },
            aesKey,
            this.bytesFromBase64(envelope.ciphertext)
        );
        const payload = JSON.parse(new TextDecoder().decode(new Uint8Array(plain)));
        return {
            scope: String(payload.scope || envelope.scope || '').trim(),
            key: String(payload.key || '').trim(),
            sender: String(payload.sender || envelope.sender || '').trim(),
        };
    }


    async deriveVaultAesKey(code, saltBytes) {
        const passphrase = String(code || '').trim();
        if (!passphrase) throw new Error('Введите одноразовый код vault');
        if (!window.crypto?.subtle) throw new Error('WebCrypto недоступен');
        const material = await crypto.subtle.importKey(
            'raw',
            new TextEncoder().encode(passphrase),
            'PBKDF2',
            false,
            ['deriveKey']
        );
        return crypto.subtle.deriveKey(
            {
                name: 'PBKDF2',
                salt: saltBytes,
                iterations: 210000,
                hash: 'SHA-256',
            },
            material,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
        );
    }

    async encryptVaultPackage(payload, code) {
        const salt = new Uint8Array(16);
        const iv = new Uint8Array(12);
        crypto.getRandomValues(salt);
        crypto.getRandomValues(iv);
        const key = await this.deriveVaultAesKey(code, salt);
        const plain = new TextEncoder().encode(JSON.stringify(payload));
        const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain);
        return `zali-vault:${this.base64FromBytes(new TextEncoder().encode(JSON.stringify({
            v: 1,
            kdf: 'PBKDF2-SHA256',
            iterations: 210000,
            aead: 'AES-256-GCM',
            salt: this.base64FromBytes(salt),
            iv: this.base64FromBytes(iv),
            ciphertext: this.base64FromBytes(ciphertext),
        })))}`;
    }

    async decryptVaultPackage(packageText, code) {
        const raw = String(packageText || '').trim();
        const encoded = raw.startsWith('zali-vault:') ? raw.slice('zali-vault:'.length) : raw;
        const envelope = JSON.parse(new TextDecoder().decode(this.bytesFromBase64(encoded)));
        const salt = this.bytesFromBase64(envelope.salt);
        const iv = this.bytesFromBase64(envelope.iv);
        const ciphertext = this.bytesFromBase64(envelope.ciphertext);
        const key = await this.deriveVaultAesKey(code, salt);
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
        return JSON.parse(new TextDecoder().decode(new Uint8Array(plain)));
    }

    buildVaultPlainPayload(targetDeviceId = '') {
        const stored = this.loadStoredConversationKeys();
        const scopedKeys = {};
        for (const [scope, value] of Object.entries(stored)) {
            const key = String(value || '').trim();
            if (!key) continue;
            scopedKeys[scope] = key;
        }
        // Every scope goes into the cloud package, including DM keys whose
        // lexicographic "owner" is the peer.
        //
        // Those used to be excluded, on the theory that the owner's envelopes
        // deliver them canonically and a locally invented temporary key must not
        // spread. In practice that made the cloud vault useless exactly where it
        // was needed most: for an account whose username sorts late (`zalikus` vs
        // `GRIBOED`/`Pivovarca`/`test67`), the peer owns *every* DM, so a second
        // device of that account could never recover a single conversation key and
        // invented a fresh one for each chat instead. Spreading a provisional key
        // is now harmless: applyVaultPlainPayload keeps the previous key as a
        // decryption candidate, and the server registry — not whoever wrote last —
        // decides which key is canonical.
        return {
            version: 2,
            keyEpoch: 2,
            kind: 'zali-account-vault-bootstrap',
            accountId: this.myName(),
            issuedByDevice: this.currentDeviceId(),
            issuedToDevice: String(targetDeviceId || '').trim(),
            vaultEpoch: Date.now(),
            allowedHistoryPolicy: '30_days',
            createdAt: new Date().toISOString(),
            conversationKeys: scopedKeys,
        };
    }

    applyVaultPlainPayload(payload) {
        if (!payload || typeof payload !== 'object' || payload.kind !== 'zali-account-vault-bootstrap') {
            throw new Error('Это не Zali vault package');
        }
        if (Number(payload.version || 0) !== 2 || Number(payload.keyEpoch || 0) !== 2) {
            throw new Error('Vault package создан старой схемой ключей');
        }
        const accountId = String(payload.accountId || '').trim();
        if (accountId && accountId !== this.myName()) {
            throw new Error(`Vault предназначен для аккаунта ${accountId}`);
        }
        const nextKeys = this.loadStoredConversationKeys();
        const incomingKeys = payload.conversationKeys && typeof payload.conversationKeys === 'object'
            ? payload.conversationKeys
            : {};
        for (const [rawScope, value] of Object.entries(incomingKeys)) {
            // A vault package written by an older device carries legacy-cased scopes.
            const scope = this.canonicalConversationScope(String(rawScope || ''));
            const current = String(nextKeys[scope] || '').trim();
            const next = String(value || '').trim();
            if (!next) continue;
            if (current && current !== next) {
                // Облачный ключ замещает локальный, но локальный сохраняется как
                // кандидат расшифровки: если в облако попал не тот ключ (например,
                // временный с нового устройства), история, зашифрованная прежним,
                // не должна стать нечитаемой.
                this.addAltConversationKey(nextKeys, scope, current);
            }
            nextKeys[scope] = next;
        }
        this.saveStoredConversationKeys(nextKeys);
        const displayKey = String(Object.values(nextKeys)[0] || '').trim();
        this.updateCryptoKeyDisplay({ key: displayKey });
        this.refreshAfterKey();
        // The vault merge above is last-writer-wins on the active key (the previous
        // one is kept as a decryption candidate, so nothing becomes unreadable).
        // That is fine as an interim state, but the registry has the final say —
        // reconcile in the background so the active/sending key converges on the
        // canonical one instead of on whichever device synced most recently.
        void this.reconcileVaultScopes(
            Object.keys(incomingKeys).map(scope => this.canonicalConversationScope(scope))
        );
        return Object.keys(nextKeys).length;
    }

    // Align the active key of each freshly merged vault scope with the server
    // registry. Runs off the critical path; a failure just leaves the interim
    // (still decryptable) state in place until the next sync.
    async reconcileVaultScopes(scopes = []) {
        const list = (Array.isArray(scopes) ? scopes : [])
            .map(scope => String(scope || '').trim())
            .filter(scope => scope.startsWith('dm:') || scope.startsWith('server:'))
            .slice(0, 200);
        if (!list.length || !this.S.session?.token) return 0;
        const canonical = await this.fetchCanonicalKeyIds(list);
        let promoted = 0;
        for (const scope of list) {
            const wanted = String(canonical.get(scope) || '').trim();
            if (!wanted) continue;
            if (await this.promoteCanonicalConversationKey(scope, wanted, { reason: 'vault' })) promoted += 1;
        }
        if (promoted) this.trace(`reconcileVaultScopes promoted=${promoted}`);
        return promoted;
    }

    // Does the vault event we just read already contain every key this device holds?
    //
    // Compared entry by entry over the whole stored map, `alt:` candidates included:
    // those are exactly the historical keys a second device needs in order to read
    // anything written before the conversation converged, and they are the ones the
    // republish sweep deliberately never sends (see retryPublishConversationKeys), so
    // the vault is their only route between an account's own devices.
    //
    // Note that `payload` is read BEFORE applyVaultPlainPayload merges it, or the
    // comparison would be against a map that just absorbed it and always match.
    vaultPayloadCoversLocalKeys(payload) {
        const remote = payload?.conversationKeys && typeof payload.conversationKeys === 'object'
            ? payload.conversationKeys
            : {};
        const local = this.loadStoredConversationKeys();
        for (const [scope, value] of Object.entries(local)) {
            const key = String(value || '').trim();
            if (!key) continue;
            if (String(remote[scope] || '').trim() !== key) return false;
        }
        return true;
    }

    scheduleCloudVaultSync(delayMs = 300) {
        if (!this.S.session?.token || !this.S.auth?.vaultPassphrase || !this.isVaultCloudSyncEnabled()) return;
        if (this.cloudVaultSyncTimer) {
            clearTimeout(this.cloudVaultSyncTimer);
        }
        this.cloudVaultSyncTimer = window.setTimeout(() => {
            this.cloudVaultSyncTimer = 0;
            void this.syncCloudVaultPackage({ reason: 'scheduled' });
        }, Math.max(0, Number(delayMs) || 0));
    }

    async syncCloudVaultPackage({ passphrase = null, reason = 'auto' } = {}) {
        if (!this.S.session?.token) return false;
        if (!this.isVaultCloudSyncEnabled()) {
            this.trace(`syncCloudVaultPackage skipped reason=${reason} disabled=true`);
            return false;
        }
        const code = String(passphrase || this.S.auth?.vaultPassphrase || '').trim();
        if (!code) return false;
        if (this.cloudVaultSyncInFlight) return false;

        this.cloudVaultSyncInFlight = true;
        try {
            this.S.auth.vaultPassphrase = code;
            await this.ensureServerVaultReset({ reason: `syncCloudVaultPackage:${reason}` });

            let imported = false;
            let sawCompatibleServerEvents = false;
            let serverAlreadyHasEverything = false;
            let undecryptableServerEvents = false;
            try {
                const res = await this.apiFetch(this.apiRoutes.vault.events);
                if (res.ok) {
                    const events = await res.json();
                    if (Array.isArray(events) && events.length > 0) {
                        // Scan backward for the newest event THIS passphrase can decrypt,
                        // instead of only ever looking at events[events.length-1]. The vault
                        // event stream is shared with one-time-code exports
                        // (approveDeviceAndExport/exportCurrentVaultPackage) that are never
                        // encrypted with the account passphrase — those used to permanently
                        // "poison" auto-sync the moment one landed after a real event, because
                        // the old code gave up for good the first time the single newest row
                        // failed to decrypt. Scanning a bounded window back makes this
                        // self-healing: any account already stuck on this recovers
                        // automatically once this ships, no server/data change needed.
                        const SCAN_WINDOW = 8;
                        const scanStart = Math.max(0, events.length - SCAN_WINDOW);
                        let matchIndex = -1;
                        let payload = null;
                        let anyDecryptAttempted = false;
                        for (let i = events.length - 1; i >= scanStart; i -= 1) {
                            const encrypted = String(events[i]?.encryptedVaultEvent || '').trim();
                            if (!encrypted) continue;
                            anyDecryptAttempted = true;
                            try {
                                payload = await this.decryptVaultPackage(encrypted, code);
                                matchIndex = i;
                                break;
                            } catch (e) {
                                this.trace(`syncCloudVaultPackage decrypt failed reason=${reason} index=${i} error=${e?.message || e}`);
                            }
                        }
                        if (payload) {
                            try {
                                // Measured against the key map as it stands BEFORE the merge:
                                // applyVaultPlainPayload folds this very payload into it, so
                                // asking afterwards would compare the server against a copy of
                                // itself for every scope it happened to carry.
                                const covers = this.vaultPayloadCoversLocalKeys(payload);
                                this.applyVaultPlainPayload(payload);
                                await this.saveCloudVaultSnapshot(payload, this.S.session?.token);
                                imported = true;
                                // Only skip republishing when the newest event itself was the
                                // match — an older match means newer, undecryptable rows
                                // (foreign-code exports) sit on top of it; falling through to
                                // publish below pushes "latest" back to something every device
                                // can read again instead of leaving it stuck behind them.
                                sawCompatibleServerEvents = matchIndex === events.length - 1;
                                // ...and only when that newest event actually carries everything
                                // this device holds. Position alone used to decide it, which
                                // froze the vault after its very first publish: from then on the
                                // newest event was always ours and always decryptable, so this
                                // returned before the publish below every single time, and no
                                // key created afterwards ever reached the cloud. A second device
                                // of the account then recovered the key set as it stood on day
                                // one and invented fresh keys for every conversation opened
                                // since. It only ever unstuck itself by accident, when a
                                // one-time-code export (approveDeviceAndExport) landed on top
                                // and pushed the match off the end of the stream.
                                serverAlreadyHasEverything = covers;
                                this.trace(`syncCloudVaultPackage imported reason=${reason} events=${events.length} matchIndex=${matchIndex} covers=${serverAlreadyHasEverything}`);
                            } catch (e) {
                                // Расшифровалось, но пакет старой схемы — публикация ниже
                                // выступает как upgrade до v2, это допустимо.
                                this.trace(`syncCloudVaultPackage import failed reason=${reason} error=${e?.message || e}`);
                            }
                        } else if (anyDecryptAttempted) {
                            undecryptableServerEvents = true;
                        }
                    }
                }
            } catch (e) {
                this.trace(`syncCloudVaultPackage fetch failed reason=${reason} error=${e?.message || e}`);
            }

            if (!this.isVaultCloudSyncEnabled()) {
                this.trace(`syncCloudVaultPackage aborted reason=${reason} disabled_after_fetch=true`);
                return imported;
            }

            if (sawCompatibleServerEvents && serverAlreadyHasEverything) {
                return imported;
            }

            if (undecryptableServerEvents) {
                // Ни одно из последних SCAN_WINDOW событий не расшифровалось этой
                // passphrase — похоже на реальную смену пароля на другом устройстве, а
                // не на one-time-code экспорт. Публиковать поверх нельзя: локальные
                // ключи здесь могут быть свежесгенерированными временными.
                this.trace(`syncCloudVaultPackage publish skipped reason=${reason} undecryptable_server_events=true`);
                this.addLogEntry({ type: 'WARN', msg: 'Cloud vault: события на сервере не расшифровались текущей passphrase, публикация ключей пропущена', ts: new Date().toLocaleTimeString() });
                return false;
            }

            const payload = this.buildVaultPlainPayload('');
            const hasKeys = Object.keys(payload.conversationKeys || {}).length > 0;
            if (!hasKeys) {
                return imported;
            }

            const encryptedVaultEvent = await this.encryptVaultPackage(payload, code);
            const vaultRes = await this.apiFetch(this.apiRoutes.vault.events, {
                method: 'POST',
                body: JSON.stringify({
                    issuedToDeviceId: null,
                    vaultEpoch: payload.vaultEpoch,
                    encryptedVaultEvent,
                }),
            });
            if (!vaultRes.ok) {
                throw new Error(await vaultRes.text().catch(() => 'Не удалось сохранить cloud vault event'));
            }
            await this.saveCloudVaultSnapshot(payload, this.S.session?.token);
            this.trace(`syncCloudVaultPackage published reason=${reason} imported=${imported}`);
            return true;
        } catch (e) {
            this.trace(`syncCloudVaultPackage error reason=${reason} error=${e?.message || e}`);
            return false;
        } finally {
            this.cloudVaultSyncInFlight = false;
        }
    }
});
