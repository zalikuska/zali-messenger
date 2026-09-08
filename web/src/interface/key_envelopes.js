// --- ZaliInterface: Публикация/приём ключевых конвертов, доверие устройств. ---
// Часть класса ZaliInterface (см. web/src/interface.js). Тела методов
// перенесены сюда дословно; ZaliMixin копирует дескрипторы на прототип,
// поэтому поведение и неперечисляемость методов те же, что у class-тела.
ZaliMixin(ZaliInterface, class {

    // Fan a scope's key out to every non-revoked device of `recipient` that has a
    // usable public key — NOT only approved ones.
    //
    // The `approved` filter used to be here to limit envelope churn, but
    // device approval is a manual step almost nobody performs: production
    // showed one account with 11 registered devices and exactly 1 approved.
    // The other 10 received zero envelopes, so each of them invented its own
    // conversation key and encrypted real messages with it. Starving a
    // legitimately logged-in device of key material does not make anything
    // safer — the envelope is sealed to that device's own ECDH public key
    // and only that device can open it — it just breaks the conversation.
    // `keys` publishes several candidates for one scope in a single pass. It exists
    // because the per-recipient DEVICE lookup is the expensive part: calling this once
    // per candidate re-fetched `/api/users/<peer>/devices` for every one of them, so a
    // republish answer carrying six candidates to a twenty-member channel spent a
    // hundred and twenty directory round trips through a five-slot pool before it had
    // published anything. The envelope POSTs themselves are irreducible — one per key
    // per device — but the lookups are not.
    async publishConversationKeyEnvelopes({ recipient, scope, key, keys = null, reason = 'auto', excludeCurrentDevice = false } = {}) {
        const target = String(recipient || '').trim();
        const scoped = String(scope || '').trim();
        const secrets = Array.from(new Set(
            (Array.isArray(keys) ? keys : [key])
                .map(value => String(value || '').trim())
                .filter(Boolean)
        )).slice(0, ZaliInterface.MAX_REPUBLISH_CANDIDATES);
        if (!this.S.session?.token || !target || !scoped || !secrets.length) return false;
        try {
            await this.ensureDeviceCryptoIdentity();
            const res = await this.apiFetch(this.apiRoutes.devices.publicByUser(target));
            if (!res.ok) throw new Error(await res.text().catch(() => 'Не удалось получить устройства контакта'));
            const devices = await res.json();
            const selfDeviceId = String(this.currentDeviceId() || '');
            const usable = Array.isArray(devices)
                ? devices.filter(device => !device?.revoked
                    && this.devicePublicJwk(device)
                    // Publishing to ourselves would be a no-op envelope this very
                    // device would then re-import; skip it when fanning out to the
                    // account's own devices.
                    && !(excludeCurrentDevice && String(device?.deviceId || '') === selfDeviceId))
                : [];
            if (!usable.length) {
                this.trace(`publishConversationKeyEnvelopes skipped reason=${reason} recipient=${target} devices=0`);
                return 'no_devices';
            }
            // Non-secret SHA-256 fingerprint — the same id the registry stores, never
            // the key. It is part of the envelope row's identity on the server, so
            // several candidate keys for one scope reach one device as several
            // envelopes instead of overwriting each other down to the last one.
            const keyIds = await Promise.all(secrets.map(secret => this.conversationKeyId(secret)));
            const jobs = [];
            for (const device of usable) {
                secrets.forEach((secret, i) => jobs.push({ device, secret, keyId: keyIds[i] }));
            }
            const results = await Promise.allSettled(jobs.map(async ({ device, secret, keyId }) => {
                const encryptedKey = await this.encryptConversationKeyEnvelope({
                    scope: scoped,
                    key: secret,
                    recipientDevice: device,
                    peer: target,
                });
                const post = await this.apiFetch(this.apiRoutes.keyEnvelopes.base, {
                    method: 'POST',
                    includeDeviceId: true,
                    body: JSON.stringify({
                        recipient: target,
                        scope: scoped,
                        recipientDeviceId: device.deviceId,
                        senderDeviceId: selfDeviceId,
                        keyId,
                        encryptedKey,
                    }),
                });
                if (!post.ok) throw new Error(await post.text().catch(() => 'Не удалось сохранить key envelope'));
            }));
            const succeeded = results.filter(r => r.status === 'fulfilled').length;
            if (!succeeded) {
                const firstErr = results.find(r => r.status === 'rejected')?.reason;
                throw new Error(firstErr?.message || 'Не удалось опубликовать ни один key envelope');
            }
            this.trace(`publishConversationKeyEnvelopes reason=${reason} recipient=${target} devices=${usable.length} keys=${secrets.length}`);
            return true;
        } catch (e) {
            this.trace(`publishConversationKeyEnvelopes failed reason=${reason} recipient=${target} error=${e?.message || e}`);
            return false;
        }
    }

    async publishConversationKeyToPeer({ peer, scope, key, keys = null, reason = 'auto' } = {}) {
        const recipient = String(peer || '').trim();
        // Self is not a peer: own devices go through publishConversationKeyToOwnDevices,
        // which excludes this device and reports separately.
        if (!recipient || recipient === this.myName()) return false;
        return this.publishConversationKeyEnvelopes({ recipient, scope, key, keys, reason });
    }

    // The account's *other* devices need this key just as much as the peer's do,
    // and until this existed nothing delivered it to them: publishConversationKeyToPeer
    // refuses `recipient === myName()` by design, so own-device key sync rode
    // entirely on the cloud vault. A single device missing that one channel was
    // enough for it to invent its own key and encrypt real messages with it —
    // messages no other device of the same account could ever read. Observed in
    // production: a Mac holding the registry-canonical key for a DM could not
    // decrypt a message the same account had sent 14 seconds earlier from another
    // device, after trying all 19 keys it knew.
    //
    // This widens nothing: each envelope is sealed to one of our own devices'
    // ECDH public keys, and the cloud vault already hands every own device the
    // full key set — this is the same reach over a channel that actually works.
    async publishConversationKeyToOwnDevices({ scope, key, keys = null, reason = 'auto' } = {}) {
        const me = String(this.myName() || '').trim();
        if (!me) return false;
        return this.publishConversationKeyEnvelopes({
            recipient: me,
            scope,
            key,
            keys,
            reason: `self:${reason}`,
            excludeCurrentDevice: true,
        });
    }

    peerFromConversationScope(scope) {
        const parts = String(scope || '').trim().split(':');
        if (parts.length !== 3 || parts[0] !== 'dm') return '';
        const me = String(this.myName() || '').trim().toLowerCase();
        if (!me) return '';
        const a = String(parts[1] || '').trim().toLowerCase();
        const b = String(parts[2] || '').trim().toLowerCase();
        // Back to the casing the server stores — the result goes straight into
        // request paths (`/api/users/<peer>/devices`), which match exactly.
        if (a === me) return this.resolveKnownUsernameCasing(b);
        if (b === me) return this.resolveKnownUsernameCasing(a);
        return '';
    }

    channelFromConversationScope(scope) {
        const parts = String(scope || '').trim().split(':');
        if (parts.length !== 3 || parts[0] !== 'server') return null;
        const serverId = parts[1] || '';
        const channelId = parts[2] || '';
        if (!serverId || !channelId) return null;
        return { serverId, channelId };
    }

    // Fans a channel's conversation key out to every other current server member
    // via the same per-device key-envelope mechanism used for DMs. Unlike a DM
    // (single recipient), a channel can have any number of members and the
    // membership list can change, so this is re-run on every resolve/retry
    // rather than tracked with a one-shot "published" flag.
    // `keys` may carry several candidates for one scope (a republish request is
    // answered with every key we hold for it). They are fanned out per member in one
    // pass rather than by calling this once per key: each call costs a members
    // lookup and, inside publishConversationKeyToPeer, a devices lookup per member,
    // so the per-key loop it replaces multiplied both by the candidate count. A
    // twenty-member server answering one request with three candidates spent sixty
    // directory lookups before publishing anything — and every member that cannot
    // read the channel sends a request of its own.
    async publishConversationKeyToServerMembers({ serverId, channelId, scope, key, keys = null, reason = 'auto' } = {}) {
        const sid = String(serverId || '').trim();
        const cid = String(channelId || '').trim();
        const scoped = String(scope || '').trim();
        const secrets = Array.from(new Set(
            (Array.isArray(keys) ? keys : [key])
                .map(value => String(value || '').trim())
                .filter(Boolean)
        )).slice(0, ZaliInterface.MAX_REPUBLISH_CANDIDATES);
        if (!this.S.session?.token || !sid || !cid || !scoped || !secrets.length) return 0;
        const me = String(this.myName() || '').trim();
        let members = [];
        try {
            members = await this.loadServerMembers(sid);
        } catch (e) {
            this.trace(`publishConversationKeyToServerMembers failed reason=${reason} scope=${scoped} error=${e?.message || e}`, {}, 'WARN');
            return 0;
        }
        const recipients = members
            .map(member => String(member?.username || '').trim())
            .filter(username => username && username !== me);
        const results = await Promise.allSettled(recipients.map(peer =>
            this.publishConversationKeyToPeer({ peer, scope: scoped, keys: secrets, reason })
        ));
        const published = results.filter(r => r.status === 'fulfilled' && r.value === true).length;
        this.trace(`publishConversationKeyToServerMembers reason=${reason} scope=${scoped} members=${recipients.length} keys=${secrets.length} published=${published}`);
        return published;
    }

    // Someone in a conversation we share told the server they cannot decrypt it.
    // If we hold that scope's key, push it straight back to them — this is the
    // targeted counterpart of retryPublishConversationKeys' full sweep and is what
    // lets a brand-new device become readable in seconds instead of at next login.
    async handleKeyRepublishRequest(payload) {
        const scope = String(payload?.scope || '').trim();
        const requester = String(payload?.requester || '').trim();
        if (!scope || !this.S.session?.token) return false;
        // EVERY key we hold for this scope, not just the active one. The requester
        // is asking because something is unreadable for it, and the active key is
        // the one it is most likely to already have — the messages it cannot read
        // are exactly the ones encrypted under a key we have since demoted to an
        // `alt:` candidate. Sending only the active key answered the request with
        // the one key that could not possibly help.
        // Bounded. Every candidate costs an envelope POST per device of every
        // participant, and `alt:` entries accumulate without limit, so an old scope
        // could answer a single request with dozens of keys times dozens of devices.
        // The newest candidates are the ones a requester is most likely to be missing;
        // anything older is still reachable by asking again after this batch lands.
        const candidates = this
            .conversationKeyCandidates(this.loadStoredConversationKeys(), scope)
            .slice(0, ZaliInterface.MAX_REPUBLISH_CANDIDATES);
        if (!candidates.length) {
            this.trace(`handleKeyRepublishRequest scope=${scope} requester=${requester} noLocalKey=true`);
            return false;
        }
        const channel = this.channelFromConversationScope(scope);
        if (channel) {
            // One pass over the membership for all candidates, not one pass per key.
            await this.publishConversationKeyToServerMembers({
                serverId: channel.serverId,
                channelId: channel.channelId,
                scope,
                keys: candidates,
                reason: 'republish_request',
            });
            return true;
        }
        const peer = requester || this.peerFromConversationScope(scope);
        // A request from our own account is another of our devices asking for this
        // key. That used to be dropped on the floor here, which is precisely the
        // device that has no other way to obtain it.
        // Every candidate goes out in ONE call per recipient, not one call per key:
        // each call re-fetches that recipient's device list, and the answer to a
        // republish request is by definition several keys.
        if (peer === this.myName()) {
            const selfResult = await this.publishConversationKeyToOwnDevices({
                scope,
                keys: candidates,
                reason: 'republish_request',
            });
            this.trace(`handleKeyRepublishRequest scope=${scope} self=true keys=${candidates.length} result=${selfResult}`);
            return selfResult === true;
        }
        if (!peer) return false;
        const result = await this.publishConversationKeyToPeer({
            peer,
            scope,
            keys: candidates,
            reason: 'republish_request',
        });
        this.trace(`handleKeyRepublishRequest scope=${scope} peer=${peer} keys=${candidates.length} result=${result}`);
        return result === true;
    }

    // Collapses bursts of full-sweep requests into one sweep per cooldown window.
    //
    // The sweep itself is expensive — a devices lookup plus one envelope POST per
    // device for every scope this account holds — and it is driven by the
    // `device_approved` WS push, which the server fans out to *every* account that
    // has ever shared a key with the one whose device just registered
    // (notify_key_republish_peers). Several peers reconnecting therefore queued
    // several full sweeps back to back. Worse, the loop closes on itself: every
    // envelope POST makes the server push `key_envelope_available` to the recipient
    // — including straight back to this device for its own-device envelopes — and
    // each of those schedules another refreshAfterKey(). Once started it fed itself,
    // at a sustained ~100 envelope POSTs/minute for hours.
    //
    // Requests are coalesced, never dropped: anything arriving during the window
    // schedules exactly one trailing sweep, so a genuinely new device still gets its
    // envelopes — just once, after the burst, instead of once per notification.
    async retryPublishConversationKeys({ reason = 'auto', limit = 200, cooldownMs = 60000 } = {}) {
        if (!this.S.session?.token) return 0;
        const now = Date.now();
        const last = Number(this._lastKeyPublishSweepAt || 0);
        if (last && (now - last) < cooldownMs) {
            if (!this._keyPublishSweepTrailing) {
                this._keyPublishSweepTrailing = setTimeout(() => {
                    this._keyPublishSweepTrailing = null;
                    void this.retryPublishConversationKeys({ reason: `${reason}:trailing`, limit, cooldownMs });
                }, Math.max(0, cooldownMs - (now - last)));
            }
            this.trace(`retryPublishConversationKeys coalesced reason=${reason}`);
            return 0;
        }
        // The cooldown alone does not serialise anything: it is stamped here, before
        // the sweep starts, while the sweep itself runs for minutes (one devices
        // lookup plus an envelope POST per device for every scope, all queued through
        // a five-slot pool). A trailing timer armed during that run fires as soon as
        // the window elapses — with the first sweep still in flight — and a second
        // full sweep piles onto the same pool, doubling the storm this coalescing was
        // added to prevent. Anything arriving while one is running becomes a trailing
        // sweep instead, so nothing is dropped.
        if (this._keyPublishSweepInFlight) {
            if (!this._keyPublishSweepTrailing) {
                this._keyPublishSweepTrailing = setTimeout(() => {
                    this._keyPublishSweepTrailing = null;
                    void this.retryPublishConversationKeys({ reason: `${reason}:trailing`, limit, cooldownMs });
                }, cooldownMs);
            }
            this.trace(`retryPublishConversationKeys deferred reason=${reason} in_flight=true`);
            return 0;
        }
        this._lastKeyPublishSweepAt = now;
        this._keyPublishSweepInFlight = true;
        try {
            return await this._retryPublishConversationKeysImpl({ reason, limit });
        } finally {
            this._keyPublishSweepInFlight = false;
            // Stamped again on the way out: the window that matters is the gap between
            // sweeps, not the moment one happened to start.
            this._lastKeyPublishSweepAt = Date.now();
        }
    }

    async _retryPublishConversationKeysImpl({ reason = 'auto', limit = 200 } = {}) {
        if (!this.S.session?.token) return 0;
        const stored = this.loadStoredConversationKeys();
        const scopes = Object.keys(stored)
            .filter(scope => (String(scope || '').startsWith('dm:') || String(scope || '').startsWith('server:'))
                && String(stored[scope] || '').trim())
            .slice(0, Math.max(1, Number(limit) || 20));
        // ACTIVE key per scope only. This sweep briefly published every `alt:`
        // candidate too, so that a historical key whose first publish failed could
        // still reach the peer — correct in principle, ruinous in practice: each
        // (scope, key) pair costs a devices lookup plus one envelope POST per
        // device, every request is serialized through the API slot pool, and a real
        // account has ~18 scopes with several candidates each. The client spent
        // minutes saturating its own pool, `syncIncomingKeyEnvelopes` and history
        // loads timed out behind it, and the chat came up empty — observed in
        // production 2026-08-02 as a continuous POST /api/key-envelopes storm with
        // "The request timed out." on every envelope fetch.
        //
        // Historical keys still get out, but only down the targeted path:
        // handleKeyRepublishRequest answers a specific "I cannot decrypt this scope"
        // with every candidate. That fires once per affected scope instead of on
        // every login for every scope.
        const entries = scopes.map(scope => [scope, String(stored[scope] || '').trim()]);
        let published = 0;
        for (const [scope, key] of entries) {
            // Unconditional, and before the peer/channel split: this sweep is the
            // one path that can retroactively hand our other devices the keys they
            // never received, so it must cover every scope we hold — including
            // channel scopes and DMs whose peer is momentarily unresolvable.
            await this.publishConversationKeyToOwnDevices({ scope, key, reason: `retry:${reason}` });
            const channel = this.channelFromConversationScope(scope);
            if (channel) {
                published += await this.publishConversationKeyToServerMembers({
                    serverId: channel.serverId,
                    channelId: channel.channelId,
                    scope,
                    key,
                    reason: `retry:${reason}`,
                });
                continue;
            }
            const peer = this.peerFromConversationScope(scope);
            if (!peer) continue;
            const result = await this.publishConversationKeyToPeer({ peer, scope, key, reason: `retry:${reason}` });
            // 'no_devices' is truthy but means nothing was delivered — the peer has
            // no registered devices yet, so the envelope must be retried later.
            if (result === true) {
                published += 1;
            }
        }
        if (published) {
            this.trace(`retryPublishConversationKeys reason=${reason} published=${published}`);
        }
        return published;
    }

    // Concurrent callers (e.g. bootstrapDeviceTrust's background sync overlapping
    // postAuthSetup's own awaited call) used to each run an independent
    // load-mutate-save cycle over the same stored-conversation-keys object with no
    // locking, so a freshly generated local key from _resolveConversationCryptoKeyImpl
    // could be silently clobbered by whichever save landed last. Dedup to a single
    // in-flight run, mirroring _resolveKeyInFlight/_restoreVaultInFlight.
    async syncIncomingKeyEnvelopes(opts = {}) {
        if (this._syncEnvelopesInFlight) return this._syncEnvelopesInFlight;
        this._syncEnvelopesInFlight = this._syncIncomingKeyEnvelopesImpl(opts);
        try {
            return await this._syncEnvelopesInFlight;
        } finally {
            this._syncEnvelopesInFlight = null;
        }
    }

    async _syncIncomingKeyEnvelopesImpl({ reason = 'auto', triggerRefresh = true } = {}) {
        if (!this.S.session?.token) return 0;
        try {
            const identity = await this.ensureDeviceCryptoIdentity();
            // Priority slot, despite being background work. This fetch is the ONLY
            // step that can repair a key this device is missing, and it shares the
            // 5-slot pool with the envelope *publishing* sweep, which issues one POST
            // per device per scope. Measured on a real client: 11 098 envelope POSTs
            // against 689 fetches, 465 of the fetches (67%) timing out behind them.
            // Recovery was queued behind the storm it was supposed to end, so a device
            // holding the wrong key stayed that way and its messages stayed unreadable.
            const res = await this.apiFetch(this.apiRoutes.keyEnvelopes.list(identity.deviceId), {
                includeDeviceId: true,
                interactive: true,
            });
            if (!res.ok) throw new Error(await res.text().catch(() => 'Не удалось получить key envelopes'));
            const envelopes = await res.json();
            if (!Array.isArray(envelopes) || !envelopes.length) {
                this.addLogEntry({ type: 'INFO', msg: `Ключи: на сервере нет конвертов для этого устройства (${String(identity.deviceId || '').slice(0, 12)})`, ts: new Date().toLocaleTimeString() });
                return 0;
            }
            // One batched lookup of the canonical key id per scope in this batch.
            // With it, adoption is a fact ("this envelope carries the registered
            // key") instead of the old lexicographic-owner guess, which had no rule
            // at all for `server:` channel scopes — every channel member kept their
            // own key forever and only ever converged by luck.
            const batchScopes = Array.from(new Set(
                envelopes
                    .map(record => this.canonicalConversationScope(String(record?.scope || '').trim()))
                    .filter(Boolean)
            ));
            const canonical = await this.fetchCanonicalKeyIds(batchScopes);

            // Envelopes are never deleted server-side, and every sync re-downloads the
            // whole set for this device — a full ECDH derive plus AES open per row, on
            // a path that runs on login, on every key_envelope_available push, on every
            // refreshAfterKey and on every decrypt failure.
            //
            // The skip condition is deliberately the strongest one available: not "we
            // have seen this row" but "we already hold the exact key this row was
            // carrying, for the scope it named". Anything weaker can drop key material.
            // The first version of this skipped a row whenever its scope held *any*
            // key, which is wrong the moment a scope has more than one (the normal
            // state — that is what `alt:` candidates are), and the harness caught it as
            // devices ending up with one candidate out of thirty-seven envelopes.
            //
            // A row with no id or no timestamp is never memoised: a missing field must
            // degrade to "open it again", never to "skip everything".
            //
            // In memory only, so a relaunch re-imports the lot — that is the recovery
            // path for a device whose key store was wiped, and it must not be memoised
            // away.
            if (!this._openedEnvelopeStamps) this._openedEnvelopeStamps = new Map();
            const seen = this._openedEnvelopeStamps;

            // Opened OUTSIDE the write lock, on a snapshot of the key store used only
            // to answer "would re-opening this row tell us anything new?".
            //
            // Decryption is per-envelope ECDH: two key imports and a derive apiece, and
            // a real account fetches a few hundred rows. Doing that inside the lock
            // meant every other writer — the "generate a key for this new chat" write
            // on the chat-open path above all — queued behind the whole batch. The lock
            // exists to serialise the load-mutate-save cycle, and that is all it now
            // covers; the decrypted results are applied to a freshly loaded map inside
            // it, so nothing is decided from the snapshot.
            const snapshot = this.loadStoredConversationKeys();
            let decryptFailed = 0;
            let skippedKnown = 0;
            const opened = [];
            for (const record of envelopes) {
                try {
                    const envelopeId = String(record?.envelopeId || '').trim();
                    const createdAt = String(record?.createdAt || '').trim();
                    // A republish upserts the row with a fresh created_at, so an
                    // updated envelope misses the memo and is opened again.
                    const stamp = (envelopeId && createdAt) ? `${envelopeId}|${createdAt}` : '';
                    const memo = stamp ? seen.get(stamp) : null;
                    if (memo && this.conversationKeyCandidates(snapshot, memo.scope).includes(memo.key)) {
                        skippedKnown += 1;
                        continue;
                    }
                    const payload = await this.decryptConversationKeyEnvelope(record?.encryptedKey);
                    if (!payload.scope || !payload.key) continue;
                    // The sender may predate canonicalConversationScope, so fold
                    // its scope before it is used as a storage/registry key.
                    const scope = this.canonicalConversationScope(String(payload.scope));
                    // Remember exactly what this row was carrying, so the check
                    // above can prove the re-open would be a no-op before skipping.
                    if (stamp) {
                        seen.set(stamp, { scope, key: payload.key });
                        if (seen.size > 4000) seen.delete(seen.keys().next().value);
                    }
                    opened.push({ scope, payload });
                } catch (e) {
                    decryptFailed += 1;
                    this.trace(`syncIncomingKeyEnvelopes decrypt failed reason=${reason} error=${e?.message || e}`);
                }
            }

            // The load-mutate-save below must not race promoteCanonicalConversationKey
            // or the "generate a new key" write in _resolveConversationCryptoKeyImpl —
            // both can run concurrently in the background for a different scope. See
            // withConversationKeysWriteLock.
            const { imported, skippedSame } = await this.withConversationKeysWriteLock(async () => {
                const stored = this.loadStoredConversationKeys();
                let imported = 0;
                let skippedSame = 0;
                for (const { scope, payload } of opened) {
                    const current = String(stored[scope] || '').trim();
                    const wantedKeyId = String(canonical.get(scope) || '').trim();
                    const isCanonical = wantedKeyId
                        ? (await this.conversationKeyId(payload.key)) === wantedKeyId
                        : false;
                    if (!current) {
                        stored[scope] = payload.key;
                        imported += 1;
                    } else if (current !== payload.key && isCanonical) {
                        this.trace(`syncIncomingKeyEnvelopes adopt canonical key scope=${scope} sender=${payload.sender}`);
                        this.setActiveConversationKey(stored, scope, payload.key);
                        imported += 1;
                    } else if (current !== payload.key && !wantedKeyId && this.keyEnvelopeOverridesLocal(scope, payload)) {
                        // The canonical owner's key becomes the active (sending) key so
                        // both peers converge. Preserve the previous key as a decryption
                        // candidate so messages already encrypted with it stay readable.
                        this.trace(`syncIncomingKeyEnvelopes adopt owner key scope=${scope} sender=${payload.sender}`);
                        this.setActiveConversationKey(stored, scope, payload.key);
                        imported += 1;
                    } else if (current !== payload.key) {
                        // Not the canonical key, but keep it as a decryption candidate:
                        // the peer may have encrypted messages with it before convergence.
                        if (this.addAltConversationKey(stored, scope, payload.key)) imported += 1;
                        else skippedSame += 1;
                    } else {
                        skippedSame += 1;
                    }
                }
                if (imported > 0) {
                    this.saveStoredConversationKeys(stored);
                }
                return { imported, skippedSame };
            });
            // Surface the outcome in the in-app log panel. decryptFailed>0 means the
            // envelope was encrypted to a device key this client cannot open (device
            // identity mismatch) — that is why a delivered message stays unreadable.
            this.addLogEntry({
                type: decryptFailed > 0 ? 'WARN' : 'INFO',
                msg: `Ключи: получено ${envelopes.length}, принято ${imported}, совпало ${skippedSame}, уже разобрано ${skippedKnown}, не расшифровано ${decryptFailed} (reason=${reason})`,
                ts: new Date().toLocaleTimeString()
            });
            if (imported > 0) {
                this.trace(`syncIncomingKeyEnvelopes reason=${reason} imported=${imported}`);
                if (triggerRefresh) this.refreshAfterKey();
            }
            return imported;
        } catch (e) {
            this.trace(`syncIncomingKeyEnvelopes failed reason=${reason} error=${e?.message || e}`);
            return 0;
        }
    }

    async bootstrapDeviceTrust() {
        if (!this.S.session?.token) return;
        const identity = await this.timeStage('  ├ ensureDeviceCryptoIdentity', () => this.ensureDeviceCryptoIdentity());
        this.S.deviceTrust.current = identity;
        // Persist to the native shell now that the user is authenticated: ensureDeviceCryptoIdentity
        // returns early (no saveDeviceIdentity) when the identity is already complete, so the
        // in-memory identity might never have been mirrored to the native per-user file yet.
        this.persistDeviceIdentityToNative(identity);
        try {
            const res = await this.timeStage('  ├ devices.register(POST)', () => this.apiFetch(this.apiRoutes.devices.list, {
                method: 'POST',
                includeDeviceId: true,
                body: JSON.stringify({
                    deviceId: identity.deviceId,
                    label: identity.label,
                    publicKey: identity.publicKey,
                    signingKey: identity.signingKey,
                    keyPackage: identity.keyPackage,
                }),
            }));
            if (res.ok) {
                this.S.deviceTrust.current = await res.json();
            }
            // Neither the device-trust panel refresh nor a key-envelope sync is needed
            // before the chat can render, and postAuthSetup already syncs envelopes on
            // its critical path. Run these in the background so device registration does
            // not block startup (the sync could stall for the full request timeout).
            void this.timeStage('  ├ refreshDeviceTrust(bg)', () => this.refreshDeviceTrust());
            void this.timeStage('  └ syncIncomingKeyEnvelopes(bootstrap,bg)', () => this.syncIncomingKeyEnvelopes({ reason: 'bootstrapDeviceTrust' }));
        } catch (e) {
            this.S.deviceTrust.status = `Устройство не зарегистрировано: ${e?.message || e}`;
            this.renderDeviceTrustPanel();
        }
    }

    async resetEncryptionKeys() {
        this.trace('resetEncryptionKeys start');
        // 1. Clear local AES conversation keys
        this._publishedKeyScopes = new Set();
        this._vaultSnapshotApplied = false;
        // The key store is about to be emptied, so every envelope has to be openable
        // again — the memo would otherwise skip exactly the rows that refill it.
        this._openedEnvelopeStamps = null;
        // The user explicitly asked for new keys, so the sweep that fans them out
        // must not sit out retryPublishConversationKeys' coalescing window.
        this._lastKeyPublishSweepAt = 0;
        // Remember which scopes are being reset. Without this the registry would
        // defeat the reset: every regenerated key would lose the (non-forced)
        // claim to the pre-reset row and the client would keep asking the peer to
        // republish a key the user just deliberately threw away.
        //
        // Persisted, not held in a Set on the instance: a scope is only force-claimed
        // when that conversation is next resolved, so an in-memory queue silently
        // expired at the next relaunch and the reset never reached any chat the user
        // had not happened to open in that session.
        this.queueForceClaimScopes(
            Object.keys(this.loadStoredConversationKeys())
                .filter(scope => scope.startsWith('dm:') || scope.startsWith('server:'))
        );
        // Every scope is about to get a brand-new key of our own making, so no scope
        // is waiting on an unreachable canonical key any more.
        this.saveScopeMarkMap(this.staleCanonicalStorageKey(), {});
        this.canonicalKeyIdCache().clear();
        this.saveStoredConversationKeys({});
        try { sessionStorage.removeItem(this.cryptoKeyStorageKey()); } catch (e) {}
        try { localStorage.removeItem(this.cryptoKeyStorageKey()); } catch (e) {}

        // 2. Delete all server-side key envelopes (sent and received)
        try {
            await this.apiFetch(this.apiRoutes.keyEnvelopes.base, {
                method: 'DELETE',
                includeDeviceId: true,
            });
        } catch (e) {
            this.trace(`resetEncryptionKeys server delete failed: ${e?.message || e}`);
        }

        // 3. Regenerate ECDH keypair — strip e2ee from identity, let ensureDeviceCryptoIdentity rebuild it
        const identity = this.loadDeviceIdentity();
        const stripped = { ...identity, privateKeyJwk: undefined };
        if (stripped.keyPackage && typeof stripped.keyPackage === 'object') {
            stripped.keyPackage = { ...stripped.keyPackage };
            delete stripped.keyPackage.e2ee;
        }
        delete stripped.privateKeyJwk;
        this.saveDeviceIdentity(stripped);

        // 4. Generate new ECDH keypair and push new public key to server
        await this.bootstrapDeviceTrust();
        this.trace('resetEncryptionKeys done');
    }

    async refreshDeviceTrust() {
        if (!this.S.session?.token) return;
        try {
            const res = await this.apiFetch(this.apiRoutes.devices.list, { includeDeviceId: true });
            if (!res.ok) throw new Error(await res.text().catch(() => 'Не удалось загрузить устройства'));
            this.S.deviceTrust.devices = await res.json();
            this.renderDeviceTrustPanel();
        } catch (e) {
            this.S.deviceTrust.status = `Список устройств недоступен: ${e?.message || e}`;
            this.renderDeviceTrustPanel();
        }
    }

    async approveDeviceAndExport(deviceId) {
        const targetId = String(deviceId || '').trim();
        if (!targetId) return;
        if (!this.loadStoredCryptoKey() && !Object.keys(this.loadStoredConversationKeys()).length) {
            this.S.deviceTrust.status = 'Сначала задайте ключ шифрования или откройте чат с уже заданным ключом.';
            this.renderDeviceTrustPanel();
            return;
        }
        const code = this.randomBase64(12).replace(/[+/=]/g, '').slice(0, 16);
        try {
            const res = await this.apiFetch(this.apiRoutes.devices.approve, {
                method: 'POST',
                includeDeviceId: true,
                body: JSON.stringify({
                    deviceId: targetId,
                    approvedByDeviceId: this.currentDeviceId(),
                    historyDays: 30,
                }),
            });
            if (!res.ok) throw new Error(await res.text().catch(() => 'Не удалось подтвердить устройство'));

            const payload = this.buildVaultPlainPayload(targetId);
            const encryptedVaultEvent = await this.encryptVaultPackage(payload, code);
            const vaultRes = await this.apiFetch(this.apiRoutes.vault.events, {
                method: 'POST',
                body: JSON.stringify({
                    // Targeted at the new device specifically — it's encrypted with a
                    // one-time code, not the account passphrase, so it must not be
                    // mistaken for the regular auto-sync broadcast event by any client
                    // that filters on issuedToDeviceId.
                    issuedToDeviceId: targetId,
                    vaultEpoch: payload.vaultEpoch,
                    encryptedVaultEvent,
                }),
            });
            if (!vaultRes.ok) {
                throw new Error(await vaultRes.text().catch(() => 'Не удалось сохранить vault event'));
            }

            const now = new Date();
            const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
            const expires = new Date(now.getTime() + 60 * 60 * 1000);
            const scopes = Object.keys(payload.conversationKeys || {})
                .filter(scope => !String(scope).startsWith('alt:'));
            await Promise.all(scopes.slice(0, 50).map(async scope => {
                const res = await this.apiFetch(this.apiRoutes.historyTickets, {
                    method: 'POST',
                    includeDeviceId: true,
                    body: JSON.stringify({
                        issuedByDeviceId: this.currentDeviceId(),
                        issuedToDeviceId: targetId,
                        conversationId: scope,
                        fromTime: from.toISOString(),
                        toTime: now.toISOString(),
                        expiresAt: expires.toISOString(),
                        encryptedExportSecrets: encryptedVaultEvent,
                    }),
                });
                if (!res.ok) {
                    throw new Error(await res.text().catch(() => 'Не удалось сохранить history ticket'));
                }
                return res;
            }));

            this.S.deviceTrust.exportPackage = encryptedVaultEvent;
            this.S.deviceTrust.exportCode = code;
            this.S.deviceTrust.status = `Устройство подтверждено. Передайте bootstrap package и код ${code} на новое устройство.`;
            await this.refreshDeviceTrust();
        } catch (e) {
            this.S.deviceTrust.status = `Не удалось подтвердить устройство: ${e?.message || e}`;
            this.renderDeviceTrustPanel();
        }
    }

    async importVaultPackageFromInputs() {
        const packageText = String(document.getElementById('deviceVaultPackageInput')?.value || this.S.deviceTrust.importPackage || '').trim();
        const code = String(document.getElementById('deviceVaultCodeInput')?.value || this.S.deviceTrust.importCode || '').trim();
        if (!packageText || !code) {
            this.S.deviceTrust.status = 'Вставьте vault package и одноразовый код.';
            this.renderDeviceTrustPanel();
            return;
        }
        try {
            const payload = await this.decryptVaultPackage(packageText, code);
            const count = this.applyVaultPlainPayload(payload);
            this.S.deviceTrust.status = `Vault импортирован: ключей чатов ${count}. История перечитывается с учетом разрешенного окна.`;
            await this.refreshAfterKey();
            this.renderDeviceTrustPanel();
        } catch (e) {
            this.S.deviceTrust.status = `Vault не расшифрован: ${e?.message || e}`;
            this.renderDeviceTrustPanel();
        }
    }

    async exportCurrentVaultPackage() {
        const code = String(document.getElementById('deviceVaultManualCodeInput')?.value || '').trim() || this.randomBase64(12).replace(/[+/=]/g, '').slice(0, 16);
        try {
            const payload = this.buildVaultPlainPayload('');
            const encrypted = await this.encryptVaultPackage(payload, code);
            this.S.deviceTrust.exportPackage = encrypted;
            this.S.deviceTrust.exportCode = code;
            this.S.deviceTrust.status = `Vault package создан. Код: ${code}`;
            if (this.S.session?.token) {
                const vaultRes = await this.apiFetch(this.apiRoutes.vault.events, {
                    method: 'POST',
                    body: JSON.stringify({
                        vaultEpoch: payload.vaultEpoch,
                        encryptedVaultEvent: encrypted,
                    }),
                });
                if (!vaultRes.ok) {
                    throw new Error(await vaultRes.text().catch(() => 'Не удалось сохранить vault event'));
                }
            }
            this.renderDeviceTrustPanel();
        } catch (e) {
            this.S.deviceTrust.status = `Не удалось создать vault package: ${e?.message || e}`;
            this.renderDeviceTrustPanel();
        }
    }

    async revokeTrustedDevice(deviceId) {
        const id = String(deviceId || '').trim();
        if (!id || id === this.currentDeviceId()) {
            this.S.deviceTrust.status = 'Текущее устройство нельзя отозвать из этого блока.';
            this.renderDeviceTrustPanel();
            return;
        }
        try {
            const res = await this.apiFetch(this.apiRoutes.devices.byId(id), { method: 'DELETE', includeDeviceId: true });
            if (!res.ok) throw new Error(await res.text().catch(() => 'Не удалось отозвать устройство'));
            this.S.deviceTrust.status = 'Устройство отозвано, сервер создал новую эпоху device group.';
            await this.refreshDeviceTrust();
        } catch (e) {
            this.S.deviceTrust.status = `Отзыв не выполнен: ${e?.message || e}`;
            this.renderDeviceTrustPanel();
        }
    }

    renderDeviceTrustPanel() {
        const currentEl = document.getElementById('deviceTrustCurrent');
        const listEl = document.getElementById('deviceTrustList');
        const statusEl = document.getElementById('deviceTrustStatus');
        const packageEl = document.getElementById('deviceVaultExportPackage');
        const codeEl = document.getElementById('deviceVaultExportCode');
        if (currentEl) {
            const current = this.S.deviceTrust.current || this.loadDeviceIdentity();
            currentEl.textContent = current?.deviceId ? `${current.label || 'Устройство'} · ${current.deviceId}` : 'не зарегистрировано';
        }
        if (statusEl) statusEl.textContent = this.S.deviceTrust.status || '';
        if (packageEl && packageEl.value !== this.S.deviceTrust.exportPackage) packageEl.value = this.S.deviceTrust.exportPackage || '';
        if (codeEl) codeEl.textContent = this.S.deviceTrust.exportCode ? `Код: ${this.S.deviceTrust.exportCode}` : 'Код появится после экспорта';
        if (!listEl) return;
        const devices = Array.isArray(this.S.deviceTrust.devices) ? this.S.deviceTrust.devices : [];
        if (!devices.length) {
            listEl.innerHTML = '<p class="settings-help">После входа устройство зарегистрируется автоматически.</p>';
            return;
        }
        listEl.innerHTML = devices.map(device => {
            const id = String(device.deviceId || '').trim();
            const isCurrent = id === this.currentDeviceId();
            const state = device.revoked ? 'отозвано' : device.approved ? 'доверенное' : 'ожидает';
            const actions = device.revoked ? ''
                : !device.approved
                    ? `<button class="btn-flat" type="button" data-device-approve="${this.esc(id)}">Подтвердить</button>`
                    : (!isCurrent ? `<button class="btn-flat" type="button" data-device-revoke="${this.esc(id)}">Отозвать</button>` : '');
            return `
                <div class="device-row">
                    <div>
                        <strong>${this.esc(device.label || 'Устройство')}</strong>
                        <small>${this.esc(id)} · эпоха ${this.esc(device.groupEpoch || 1)} · ${this.esc(state)}</small>
                    </div>
                    <div class="settings-inline-actions">${actions}</div>
                </div>
            `;
        }).join('');
    }

    updateChatHeaderCryptoKey({ peer = null, serverId = null, channelId = null } = {}) {
        const chatHdrSub = document.getElementById('chatHdrSub');
        if (!chatHdrSub) return;
        const key = this.ensureConversationCryptoKey({ peer, serverId, channelId, reason: 'updateChatHeaderCryptoKey' });
        const desc = serverId && channelId
            ? `${String(serverId).trim()} / ${String(channelId).trim()}`
            : peer
                ? `Диалог с ${String(peer).trim()}`
                : 'Личное сообщение';
        chatHdrSub.innerHTML = `
            <span class="chat-hdr-desc">${this.esc(desc)}</span>
            <span class="chat-hdr-key">${this.esc(key ? 'Ключ: задан' : 'Ключ: не задан')}</span>
        `;
    }

    saveStoredCryptoKey(key) {
        try {
            const value = (key || '').trim();
            this.trace(`saveStoredCryptoKey keySet=${!!value} length=${value.length}`);
            if (value) {
                sessionStorage.setItem(this.cryptoKeyStorageKey(), value);
                localStorage.removeItem(this.cryptoKeyStorageKey());
            } else {
                sessionStorage.removeItem(this.cryptoKeyStorageKey());
                localStorage.removeItem(this.cryptoKeyStorageKey());
            }
            try {
                window.__ZALI_SAVED_KEY = value;
            } catch (e) {}
            try {
                const scope = String(window.__ZALI_ACTIVE_CONVERSATION_SCOPE || this.activeConversationScope || '').trim();
                if (scope) {
                    const stored = this.loadStoredConversationKeys();
                    if (value) {
                        stored[scope] = value;
                    } else {
                        delete stored[scope];
                    }
                    this.saveStoredConversationKeys(stored);
                }
            } catch (e) {}
            if (this.nativeSupports('setKey')) {
                this.trace(`saveStoredCryptoKey native setKey keySet=${!!value}`);
                this.syncNativeConversationKeys();
            }
            if (this.S.session?.token && this.S.auth?.vaultPassphrase && !this.cloudVaultSyncInFlight) {
                this.scheduleCloudVaultSync(300);
            }
        } catch (e) {}
    }
});
