// Builds a live ZaliInterface instance whose voice methods are the real ones.
//
// Only these boundaries are replaced: the WebSocket (routed into the simulated
// server), the microphone, the DOM, and the audio graph. Everything the checks
// assert on — who offers, who answers, when a rollback happens, when a retry is
// scheduled, whether tracks get attached — runs the shipping implementation.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { loadZaliInterface, REPO_ROOT } from './load_interface.mjs';
import {
    makeRTCPeerConnectionClass, FakeAudioContext, makeLocalStream,
    FakeMediaStream, FakeMediaStreamTrack,
} from './fake_webrtc.mjs';

export class VoicePeer {
    /**
     * @param {string} name username
     * @param {object} server simulated server (sim_server.mjs)
     * @param {object} opts { micFails, audio: {resumeNeverSettles}, faults, collator }
     */
    constructor(name, server, opts = {}) {
        this.name = name;
        this.server = server;
        this.opts = opts;
        this.clock = opts.clock || server.clock || null;
        this.traces = [];
        this.logs = [];
        this.sent = [];

        const PC = makeRTCPeerConnectionClass({ faults: opts.faults || {}, clock: this.clock });
        const audioBehaviour = opts.audio || {};
        class BoundAudioContext extends FakeAudioContext {
            constructor() { super(audioBehaviour); }
        }

        const { ZaliInterface, sandbox } = loadZaliInterface({
            RTCPeerConnection: PC,
            AudioContext: BoundAudioContext,
            webkitAudioContext: BoundAudioContext,
            MediaStream: FakeMediaStream,
        }, this.clock);
        this.sandbox = sandbox;
        sandbox.navigator.mediaDevices.getUserMedia = async () => {
            if (opts.micFails) {
                const err = new Error('Permission denied');
                err.name = opts.micFails === true ? 'NotAllowedError' : opts.micFails;
                throw err;
            }
            return makeLocalStream({ video: false });
        };

        // Load the canonical voice state slice into the same sandbox so the
        // instance's voice state is exactly what ships, field for field.
        const sliceSrc = fs.readFileSync(path.join(REPO_ROOT, 'web/src/modules/voice.js'), 'utf8');
        vm.runInContext(sliceSrc, sandbox, { filename: 'web/src/modules/voice.js' });

        const api = Object.create(ZaliInterface.prototype);
        this.api = api;
        api.voice = sandbox.window.ZaliStateSlices.voice.createState();
        api.voice.supported = true;
        api.S = { current: name, token: 't', contacts: [], servers: [], updateStatus: {} };
        api.audioPrefs = { masterVolumePercent: 100, peerVolumePercents: {}, micDeviceId: '', speakerDeviceId: '' };
        api.voiceTraceEnabled = false;

        // --- boundaries -------------------------------------------------------
        api.myName = () => name;
        api.voiceTrace = (stage, details = {}, level = 'INFO') => {
            this.traces.push({ stage, details, level });
        };
        api.voiceDiag = (stage, details = {}, level = 'INFO') => {
            this.traces.push({ stage, details, level, diag: true });
        };
        api.addLogEntry = (entry) => { this.logs.push(entry); };
        api.trace = () => {};
        api.renderVoicePanel = () => {};
        api.scheduleRenderVoicePanel = () => {};
        api.mountVoiceVideoElements = () => {};
        api.renderHub = () => {};
        api.renderChat = () => {};
        api.renderContacts = () => {};
        api.updateVoiceMeterDom = () => {};
        api.updateVoiceMeters = async () => {};
        api.playVoiceRingtone = () => {};
        api.stopVoiceRingtone = () => {};
        api.notifyIncomingCall = () => {};
        api.recordVoiceCallHistory = () => {};
        api.saveAudioPrefs = () => {};
        api.esc = (s) => String(s ?? '');
        api.sampleVoicePeerStats = async () => {};
        api.reportVoiceSelectedPair = async () => {};
        api.ensureVoicePresenceKeepalive = () => {};
        api.stopVoicePresenceKeepalive = () => {};
        api.attachLocalVideoPreview = () => {};
        api.detachLocalVideoPreview = () => {};
        api.detachLocalScreenPreview = () => {};
        api.attachLocalScreenTrackToPeer = () => {};

        // The mic itself is faked; ensureVoiceLocalStream (dedupe, micError,
        // renegotiation on late tracks) stays real.
        api.captureVoiceLocalStream = async () => {
            const stream = await sandbox.navigator.mediaDevices.getUserMedia({ audio: true });
            api.voice.localStream = stream;
            api.voice.micError = '';
            api.voice.muted = false;
            return stream;
        };

        api.sendVoiceEvent = (payload) => {
            if (!payload || !payload.type) return false;
            const enriched = api.voiceEventPayload ? api.voiceEventPayload(payload) : payload;
            this.sent.push(enriched);
            return this.server.fromClient(name, enriched);
        };

        this.rtcClass = PC;
    }

    /** Deliver a server->client event through the real handler. */
    async deliver(event) {
        if (typeof this.api.handleVoiceEvent === 'function') {
            await this.api.handleVoiceEvent(event);
        }
    }

    entryFor(peer) { return this.api.voice.peerConnections.get(peer) || null; }

    /**
     * True when this side has a fully negotiated session with `peer` that carries
     * audio in BOTH directions — the actual definition of "the call has sound".
     */
    hasTwoWayAudio(peer) {
        const entry = this.entryFor(peer);
        if (!entry) return false;
        const pc = entry.pc;
        if (pc.signalingState !== 'stable') return false;
        if (!pc.localDescription || !pc.remoteDescription) return false;
        return pc.negotiatedOutgoingKinds().includes('audio')
            && pc.negotiatedIncomingKinds().includes('audio');
    }

    tracesOf(stage) { return this.traces.filter(t => t.stage === stage); }
}
