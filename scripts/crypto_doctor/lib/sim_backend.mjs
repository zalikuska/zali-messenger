// Simulated zali-server, limited to everything key material touches. Mirrors:
//   server/src/devices.rs            GET  /api/users/:user/devices   (public key packages)
//   server/src/conversation_keys.rs  POST /api/conversation-keys/claim      (first write wins)
//                                    GET  /api/conversation-keys?scopes=…
//                                    POST /api/conversation-keys/republish
//   key envelopes                    POST /api/key-envelopes  (sealed per recipient device)
//                                    GET  /api/key-envelopes?deviceId=…
//   cloud vault                      GET/POST /api/vault/events
//
// The server never sees key material: envelopes are opaque ciphertext and the
// registry stores only a SHA-256 fingerprint. The harness asserts that too.
export class SimBackend {
    constructor(opts = {}) {
        this.opts = opts;
        this.rng = opts.rng || Math.random;
        this.users = new Map();          // username -> { devices: Map<deviceId, record> }
        this.envelopes = [];             // { recipient, recipientDeviceId, scope, encryptedKey, senderDeviceId }
        this.registry = new Map();       // canonical scope -> { keyId, claimedBy, claimedDeviceId }
        this.vault = [];                 // opaque encrypted vault events
        this.republishRequests = [];
        this.serverMembers = new Map();  // serverId -> Set<username>
        this.calls = [];
        this.failures = 0;
        this.devices = [];               // attached Device objects, for WS-style pushes
        this.pendingPushes = [];
        // Virtual clock, so a check can age a registry row past the takeover window
        // without sleeping for it. `advance(ms)` moves it; Date.now() is the base.
        this.clockOffsetMs = 0;
        this.staleClaimTakeoverMs = opts.staleClaimTakeoverMs ?? 15 * 60 * 1000;
    }

    now() { return Date.now() + this.clockOffsetMs; }

    /** Moves the backend's clock forward — used to age a claim past its window. */
    advance(ms) { this.clockOffsetMs += Math.max(0, Number(ms) || 0); }

    /**
     * Registers a Device so the backend can push to it the way the real server
     * pushes over the WebSocket. Without this, `key_republish_request` — the whole
     * mechanism that lets a brand-new device get the key it is missing — would be
     * an unanswered write into a list, and the checks would be measuring a
     * crippled system rather than the shipping one.
     */
    attach(device) { this.devices.push(device); }

    /** Delivers queued server->client pushes; call it where the WS would fire. */
    async flushPushes(limit = 50) {
        let delivered = 0;
        while (this.pendingPushes.length && delivered < limit) {
            const { username, payload } = this.pendingPushes.shift();
            for (const device of this.devices) {
                if (String(device.user).toLowerCase() !== String(username).toLowerCase()) continue;
                delivered += 1;
                try { await device.onServerPush(payload); } catch (e) { /* client-side handling is under test */ }
            }
        }
        return delivered;
    }

    user(name) {
        const key = String(name || '').toLowerCase();
        if (!this.users.has(key)) this.users.set(key, { name, devices: new Map() });
        return this.users.get(key);
    }

    registerDevice(username, record) {
        this.user(username).devices.set(String(record.deviceId), { ...record });
    }

    setServerMembers(serverId, members) {
        this.serverMembers.set(String(serverId), new Set(members.map(m => String(m).toLowerCase())));
    }

    // Mirrors canonical_scope() in server/src/conversation_keys.rs: dm scopes are
    // lowercased and their two participants sorted, so both ends address one row.
    canonicalScope(scope) {
        const raw = String(scope || '').trim();
        const parts = raw.split(':');
        if (parts[0] !== 'dm' || parts.length !== 3) return raw;
        const a = String(parts[1] || '').toLowerCase();
        const b = String(parts[2] || '').toLowerCase();
        return `dm:${[a, b].sort().join(':')}`;
    }

    _participants(scope, caller) {
        const s = this.canonicalScope(scope);
        const parts = s.split(':');
        if (parts[0] === 'dm') {
            const set = new Set([parts[1], parts[2]]);
            return set.has(String(caller).toLowerCase()) ? set : null;
        }
        if (parts[0] === 'server') {
            const members = this.serverMembers.get(parts[1]);
            if (!members) return null;
            return members.has(String(caller).toLowerCase()) ? members : null;
        }
        return null;
    }

    _res(status, body) {
        const text = typeof body === 'string' ? body : JSON.stringify(body ?? null);
        return {
            ok: status >= 200 && status < 300,
            status,
            async json() { return JSON.parse(text); },
            async text() { return text; },
        };
    }

    /**
     * @param {string} caller username making the request
     * @param {string} deviceId X-Device-Id header value
     * @param {string} path e.g. '/api/key-envelopes?deviceId=…'
     * @param {object} options fetch-like { method, body }
     */
    async handle(caller, deviceId, path, options = {}) {
        const method = String(options.method || 'GET').toUpperCase();
        const [rawPath, rawQuery = ''] = String(path).split('?');
        const query = new URLSearchParams(rawQuery);
        const body = options.body ? JSON.parse(options.body) : null;
        this.calls.push({ caller, deviceId, method, path: rawPath });

        // Injected transport faults: the client must treat a failed lookup as
        // "unknown", never as "no key exists" — that distinction is what stops it
        // from inventing a key and forking the conversation.
        if (this.opts.failRate && this.rng() < this.opts.failRate) {
            this.failures += 1;
            return this._res(503, 'simulated backend failure');
        }

        if (rawPath.endsWith('/devices') && rawPath.startsWith('/api/users/')) {
            const who = decodeURIComponent(rawPath.slice('/api/users/'.length, -'/devices'.length));
            const rec = this.users.get(String(who).toLowerCase());
            return this._res(200, rec ? [...rec.devices.values()] : []);
        }

        if (rawPath === '/api/key-envelopes' && method === 'POST') {
            const scope = this.canonicalScope(body?.scope);
            if (!this._participants(scope, caller)) return this._res(403, 'forbidden');
            if (typeof body?.encryptedKey !== 'string' || !body.encryptedKey) {
                return this._res(400, 'missing envelope');
            }
            // Upsert on (owner, scope, senderDevice, recipientDevice, keyId), like the
            // real ON CONFLICT — and, as there, a republish keeps the row's identity
            // while stamping a fresh createdAt, which is what tells a client the
            // content behind that id changed and has to be opened again.
            //
            // Modelling this at all matters: while these rows were append-only here,
            // the harness could not see that the server's narrower constraint (no
            // keyId) collapsed every candidate key for a scope onto one row, so
            // answering a republish request with all of them delivered only the last.
            const recipient = String(body.recipient || '').toLowerCase();
            const recipientDeviceId = String(body.recipientDeviceId || '');
            const senderDeviceId = String(body.senderDeviceId || '');
            const keyId = String(body.keyId || '');
            const existing = this.envelopes.find(e => e.recipient === recipient
                && e.scope === scope
                && e.senderDeviceId === senderDeviceId
                && e.recipientDeviceId === recipientDeviceId
                && e.keyId === keyId);
            if (existing) {
                existing.encryptedKey = body.encryptedKey;
                existing.createdAt = new Date(this.now() + (this.envelopeSeq = (this.envelopeSeq || 0) + 1)).toISOString();
            } else {
                this.envelopes.push({
                    envelopeId: `env_${this.envelopes.length + 1}`,
                    recipient,
                    recipientDeviceId,
                    senderDeviceId,
                    keyId,
                    scope,
                    encryptedKey: body.encryptedKey,
                    createdAt: new Date(this.now() + (this.envelopeSeq = (this.envelopeSeq || 0) + 1)).toISOString(),
                    at: this.envelopes.length,
                });
            }
            return this._res(200, { ok: true });
        }

        if (rawPath === '/api/key-envelopes' && method === 'GET') {
            const wanted = String(query.get('deviceId') || deviceId || '');
            const rows = this.envelopes.filter(e =>
                e.recipient === String(caller).toLowerCase() && e.recipientDeviceId === wanted);
            // envelopeId/createdAt are part of the real response and the client keys a
            // "already opened this exact row" memo on the pair. Omitting them here made
            // every row look identical to that memo, which is how a fragile version of
            // it passed review and then skipped nearly every import.
            return this._res(200, rows.map(({ envelopeId, scope, encryptedKey, senderDeviceId, createdAt }) => ({
                envelopeId, scope, encryptedKey, senderDeviceId, createdAt,
            })));
        }

        if (rawPath === '/api/conversation-keys' && method === 'GET') {
            const scopes = String(query.get('scopes') || '').split(',')
                .map(s => this.canonicalScope(s)).filter(Boolean).slice(0, 200);
            const out = [];
            for (const scope of scopes) {
                if (!this._participants(scope, caller)) continue;
                const row = this.registry.get(scope);
                if (row) out.push({ scope, keyId: row.keyId, claimedBy: row.claimedBy });
            }
            return this._res(200, out);
        }

        if (rawPath === '/api/conversation-keys/claim' && method === 'POST') {
            const scope = this.canonicalScope(body?.scope);
            const keyId = String(body?.keyId || '');
            if (!scope || keyId.length < 8) return this._res(400, 'bad claim');
            if (!this._participants(scope, caller)) return this._res(403, 'forbidden');
            const existing = this.registry.get(scope);
            if (!existing || body?.force === true) {
                this.registry.set(scope, {
                    keyId, claimedBy: caller, claimedDeviceId: deviceId, updatedAt: this.now(),
                });
            } else if (body?.takeover === true && existing.keyId !== keyId) {
                // Mirrors STALE_CLAIM_TAKEOVER in server/src/conversation_keys.rs: the
                // first takeover in a window replaces the row and refreshes updatedAt,
                // so everyone else crossing the threshold at the same moment is refused
                // and gets the winner back instead. Without modelling the refusal the
                // harness would be testing a design that ping-pongs forever.
                const updatedAt = Number(existing.updatedAt || 0);
                if (this.now() - updatedAt >= this.staleClaimTakeoverMs) {
                    this.registry.set(scope, {
                        keyId, claimedBy: caller, claimedDeviceId: deviceId, updatedAt: this.now(),
                    });
                }
            }
            const row = this.registry.get(scope);
            return this._res(200, {
                scope, keyId: row.keyId, claimedBy: row.claimedBy, mine: row.keyId === keyId,
            });
        }

        if (rawPath === '/api/conversation-keys/republish' && method === 'POST') {
            const scope = this.canonicalScope(body?.scope);
            const participants = this._participants(scope, caller);
            if (!participants) return this._res(403, 'forbidden');
            this.republishRequests.push({ scope, caller, deviceId });
            // Mirrors server/src/conversation_keys.rs: every participant is notified,
            // INCLUDING the caller — the account's own other devices are usually the
            // only holders of the key a brand-new device is asking for.
            const payload = {
                type: 'key_republish_request',
                scope, requester: caller, requesterDeviceId: deviceId,
            };
            for (const participant of participants) {
                this.pendingPushes.push({ username: participant, payload });
            }
            // The real server pushes immediately over the WebSocket; the client's
            // retry loop sleeps 1.5–3 s waiting for exactly this. Delivering only at
            // an explicit settle() point would make every republish arrive too late
            // and the checks would blame the client for the harness's timing.
            setTimeout(() => { void this.flushPushes(); }, 0);
            return this._res(200, { notified: participants.size });
        }

        if (rawPath.startsWith('/api/servers/') && rawPath.endsWith('/members') && method === 'GET') {
            const sid = rawPath.slice('/api/servers/'.length, -'/members'.length);
            const members = this.serverMembers.get(decodeURIComponent(sid));
            if (!members) return this._res(404, 'no such server');
            return this._res(200, [...members].map(username => ({
                username: this.users.get(username)?.name || username,
                role: 'member',
            })));
        }

        if (rawPath === '/api/vault/events' && method === 'GET') {
            return this._res(200, this.vault
                .filter(v => v.owner === String(caller).toLowerCase())
                .map(v => ({ encryptedVaultEvent: v.encryptedVaultEvent, createdAt: v.createdAt })));
        }

        if (rawPath === '/api/vault/events' && method === 'POST') {
            this.vault.push({
                owner: String(caller).toLowerCase(),
                encryptedVaultEvent: String(body?.encryptedVaultEvent || ''),
                vaultEpoch: body?.vaultEpoch ?? null,
                createdAt: new Date().toISOString(),
            });
            return this._res(200, { ok: true });
        }

        if (rawPath === '/api/vault/events' && method === 'DELETE') {
            this.vault = this.vault.filter(v => v.owner !== String(caller).toLowerCase());
            return this._res(200, { ok: true });
        }

        // Anything else this harness does not model: 404 rather than a fake 200,
        // so a check can never silently pass on an endpoint nobody implemented.
        return this._res(404, `unmodelled endpoint ${method} ${rawPath}`);
    }

    /** Every distinct piece of plaintext key material the server ever saw. */
    plaintextLeaks(secrets) {
        const blob = JSON.stringify({
            envelopes: this.envelopes, registry: [...this.registry.entries()], vault: this.vault,
        });
        return secrets.filter(secret => secret && blob.includes(secret));
    }
}
