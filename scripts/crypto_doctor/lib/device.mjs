// One simulated device = one real ZaliInterface instance with its own sandbox
// (so its own localStorage, its own device identity, its own key store), wired to
// the shared SimBackend at the `apiFetch` seam.
//
// Everything below that seam is production code: scope canonicalisation, the
// registry claim/promote/reconcile dance, ECDH envelope sealing and opening, the
// write lock, the candidate pool. WebCrypto is Node's real implementation, so the
// crypto is genuinely exercised rather than stubbed.
import { loadZaliInterface } from '../../voice_doctor/lib/load_interface.mjs';

let deviceSeq = 0;

export class Device {
    /**
     * @param {string} user account name
     * @param {SimBackend} backend
     * @param {object} opts { label, vaultPassphrase, deviceId }
     */
    constructor(user, backend, opts = {}) {
        this.user = user;
        this.backend = backend;
        this.opts = opts;
        this.deviceId = opts.deviceId || `dev_sim_${++deviceSeq}`;
        this.traces = [];
        this.logs = [];

        const { ZaliInterface, sandbox, apiRoutes } = loadZaliInterface({});
        // `sandbox` in opts models a relaunch: a brand-new interface instance over
        // storage that survived, so anything the previous instance kept in memory is
        // gone while everything it persisted is still there. That distinction is the
        // whole point of some checks — a queue held on the instance looks identical
        // to a persisted one until the process restarts.
        if (opts.sandbox) {
            sandbox.localStorage = opts.sandbox.localStorage;
            sandbox.sessionStorage = opts.sandbox.sessionStorage;
            sandbox.window.localStorage = opts.sandbox.localStorage;
            sandbox.window.sessionStorage = opts.sandbox.sessionStorage;
        }
        this.sandbox = sandbox;
        const api = Object.create(ZaliInterface.prototype);
        this.api = api;

        api.S = {
            current: user,
            session: { token: `token-${user}`, username: user },
            auth: {
                vaultPassphrase: opts.vaultPassphrase || '',
                // The cloud vault is how an account's own devices share the FULL key
                // set (envelopes only ever carry the current key). Off by default here
                // so scenarios can test both configurations explicitly.
                cloudVaultSyncEnabled: !!opts.vaultPassphrase,
            },
            deviceTrust: { current: null, devices: [] },
            contacts: [], servers: [], chats: {}, serverChats: {},
        };
        api.apiRoutes = apiRoutes;
        if (!api.apiRoutes) throw new Error('could not read DefaultApiRoutes from interface.js');

        // --- boundaries -------------------------------------------------------
        api.myName = () => user;
        api.trace = (msg) => { this.traces.push(String(msg)); };
        api.addLogEntry = (entry) => { this.logs.push(entry); };
        api.updateCryptoKeyDisplay = () => {};
        api.syncNativeConversationKeys = () => {};
        api.setKey = (key) => { this.activeKey = key; };
        api.refreshAfterKey = () => {};
        api.renderChat = () => {};
        api.renderHub = () => {};
        api.nativeSupports = () => false;
        api.persistDeviceIdentityToNative = () => {};
        api.loadInjectedDeviceIdentity = () => null;
        api.defaultDeviceLabel = () => opts.label || `${user}/${this.deviceId}`;
        api.resolveKnownUsernameCasing = (name) => {
            const rec = backend.users.get(String(name || '').toLowerCase());
            return rec ? rec.name : String(name || '');
        };

        // Single seam for every server interaction.
        api.apiFetch = async (path, options = {}) => {
            return backend.handle(user, this.deviceId, path, options);
        };
        api.apiHeaders = (extra = {}) => ({ ...extra });
        api.loadVaultUnlockSecret = async () => opts.vaultPassphrase || '';

        // Seed the device identity so the id is stable and known to the harness;
        // ensureDeviceCryptoIdentity() still generates the real ECDH key pair.
        sandbox.localStorage.setItem(api.deviceIdentityStorageKey(), JSON.stringify({
            deviceId: this.deviceId,
            label: api.defaultDeviceLabel(),
            publicKey: 'seed',
        }));
    }

    /**
     * Server->client push (the WebSocket in production). Only the key-related
     * events are routed; the client-side handler under test is the real one.
     */
    async onServerPush(payload) {
        if (payload?.type === 'key_republish_request') {
            return this.api.handleKeyRepublishRequest(payload);
        }
        return false;
    }

    /** Publishes this device's public key package to the backend directory. */
    async register() {
        this.backend.attach(this);
        const identity = await this.api.ensureDeviceCryptoIdentity();
        this.backend.registerDevice(this.user, {
            deviceId: identity.deviceId,
            label: identity.label,
            revoked: false,
            keyPackage: identity.keyPackage,
        });
        return identity;
    }

    storedKeys() { return this.api.loadStoredConversationKeys(); }

    activeKeyFor(scope) {
        return String(this.storedKeys()[this.api.canonicalConversationScope(scope)] || '').trim();
    }

    /** Active key plus every `alt:` candidate — what this device can decrypt with. */
    candidatesFor(scope) {
        const canonical = this.api.canonicalConversationScope(scope);
        return this.api.conversationKeyCandidates(this.storedKeys(), canonical);
    }

    canDecrypt(scope, key) {
        return !!key && this.candidatesFor(scope).includes(key);
    }

    async resolve(args) { return this.api.resolveConversationCryptoKey(args); }
    async syncEnvelopes(reason = 'test') {
        return this.api.syncIncomingKeyEnvelopes({ reason, triggerRefresh: false });
    }
}
