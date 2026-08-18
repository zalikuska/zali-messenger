// One simulated browser tab = one real ZaliInterface instance with no native
// bridge, wired to a fake server at the `apiFetch` seam and to a fake WASM
// unpacker at the `window.ZaliWasm` seam.
//
// The point of this harness is retention, so the two things that actually hold
// bytes are instrumented rather than stubbed away: object URLs are tracked in a
// live set (created minus revoked), and every archive download is counted. Both
// are real production call sites — nothing in interface.js is replaced.
import { loadZaliInterface } from '../../voice_doctor/lib/load_interface.mjs';

/** Tracks createObjectURL/revokeObjectURL so a leak is a number, not a hunch. */
export class ObjectUrlTracker {
    constructor() {
        this.created = 0;
        this.revoked = 0;
        /** @type {Map<string, number>} url -> bytes held by its blob */
        this.live = new Map();
        this.seq = 0;
    }

    install(sandbox) {
        const tracker = this;
        // Only the two static methods are replaced; the URL constructor stays real
        // because interface.js parses API/WS URLs with it.
        const RealURL = sandbox.URL;
        const Shim = new Proxy(RealURL, {
            get(target, prop, receiver) {
                if (prop === 'createObjectURL') {
                    return (blob) => {
                        const url = `blob:zali/${++tracker.seq}`;
                        tracker.created += 1;
                        tracker.live.set(url, Number(blob?.size || 0));
                        return url;
                    };
                }
                if (prop === 'revokeObjectURL') {
                    return (url) => {
                        if (tracker.live.delete(String(url))) tracker.revoked += 1;
                    };
                }
                return Reflect.get(target, prop, receiver);
            },
        });
        sandbox.URL = Shim;
        sandbox.window.URL = Shim;
        return this;
    }

    /** Bytes still pinned by un-revoked blob URLs. */
    liveBytes() {
        let total = 0;
        for (const size of this.live.values()) total += size;
        return total;
    }

    get liveCount() {
        return this.live.size;
    }
}

/**
 * A conversation history the fake server will serve, and the archives behind it.
 * `attachmentBytes` is per attachment; one attachment per message keeps the
 * arithmetic in the check output readable.
 */
export function makeHistory({ peer, me, count, attachmentBytes = 256 * 1024 }) {
    const rows = [];
    for (let i = 0; i < count; i += 1) {
        rows.push({
            id: `msg-${i}`,
            clientId: `client-${i}`,
            sender: i % 2 === 0 ? me : peer,
            receiver: i % 2 === 0 ? peer : me,
            timestamp: 1_700_000_000 + i,
            attachmentBytes,
        });
    }
    return rows;
}

export class BrowserTab {
    /**
     * @param {object} opts { me, peer, history }
     */
    constructor(opts = {}) {
        this.me = opts.me || 'alice';
        this.peer = opts.peer || 'bob';
        this.history = opts.history || [];
        this.downloads = 0;
        this.unpacks = 0;
        this.traces = [];

        this.tracker = new ObjectUrlTracker();
        // Node's real Blob: attachment size has to be genuine for liveBytes() to
        // mean anything, and interface.js wraps every attachment in one.
        const { ZaliInterface, sandbox, apiRoutes } = loadZaliInterface({ Blob });
        this.sandbox = sandbox;
        this.tracker.install(sandbox);

        const api = Object.create(ZaliInterface.prototype);
        this.api = api;
        api.S = {
            current: this.peer,
            session: { token: 'token', username: this.me },
            auth: {},
            deviceTrust: { current: null, devices: [] },
            contacts: [], servers: [], chats: {}, serverChats: {},
        };
        api.apiRoutes = apiRoutes;
        if (!api.apiRoutes) throw new Error('could not read DefaultApiRoutes from interface.js');

        api.myName = () => this.me;
        api.trace = (msg) => { this.traces.push(String(msg)); };
        api.addLogEntry = () => {};
        api.nativeSupports = () => false;
        api.hasNativeBridge = () => false;
        api.reportDecryptFailure = async () => {};
        api.ensureConversationCryptoKey = () => 'conversation-key';
        api.resolveConversationCryptoKey = async () => 'conversation-key';
        // Messages land here instead of the DOM; the harness only cares that the
        // decoded payload arrived, not how it renders.
        this.received = [];
        api.bus = { send: (_event, data) => { this.received.push(data); } };

        // Fake WASM: returns one attachment whose byte length matches the row, so
        // the tracker's liveBytes() reflects what a real image would pin.
        sandbox.window.ZaliWasm = {
            unpackMessage: async (archiveBytes, _key) => {
                this.unpacks += 1;
                const size = archiveBytes.length;
                return {
                    sender: this.me,
                    text: 'attachment message',
                    timestamp: 1_700_000_000,
                    attachments: [{
                        name: 'photo.png',
                        mimeType: 'image/png',
                        kind: 'image',
                        bytes: new Uint8Array(size),
                        archivePath: 'photo.png',
                    }],
                };
            },
        };
        api.wasmAvailable = async () => true;

        api.apiFetch = async (path, _options = {}) => {
            const value = String(path || '');
            // GET /api/download/:id — the .zali archive itself.
            if (value.includes('/download/')) {
                const id = decodeURIComponent(value.split('/download/').pop() || '');
                const row = this.history.find(r => r.id === id);
                this.downloads += 1;
                const bytes = new Uint8Array(row ? row.attachmentBytes : 0);
                return {
                    ok: true,
                    status: 200,
                    arrayBuffer: async () => bytes.buffer,
                    json: async () => ({}),
                    text: async () => '',
                };
            }
            // GET /api/messages/:user — the history listing.
            if (value.includes('/messages/')) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => this.history,
                    text: async () => '',
                    arrayBuffer: async () => new ArrayBuffer(0),
                };
            }
            return { ok: true, status: 200, json: async () => ({}), text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) };
        };
    }

    /** One full history sync, exactly as syncActiveConversation/refreshAfterKey do it. */
    async syncHistory() {
        await this.api.loadBrowserDmHistory(this.peer, 'conversation-key');
    }
}
