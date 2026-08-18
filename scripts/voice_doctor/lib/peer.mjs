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

        this.pcs = [];
        const PC = makeRTCPeerConnectionClass({
            faults: opts.faults || {},
            clock: this.clock,
            onCreate: (pc) => this.pcs.push(pc),
        });
        const audioBehaviour = opts.audio || {};
        class BoundAudioContext extends FakeAudioContext {
            constructor() { super(audioBehaviour); }
        }

        // Mutable so a check can lift the block mid-scenario, the way a real user
        // gesture lifts autoplay policy.
        this.autoplayBlocked = !!opts.autoplayBlocked;
        const { ZaliInterface, sandbox } = loadZaliInterface({
            RTCPeerConnection: PC,
            AudioContext: BoundAudioContext,
            webkitAudioContext: BoundAudioContext,
            MediaStream: FakeMediaStream,
        }, this.clock, { autoplayBlocked: () => this.autoplayBlocked });
        this.sandbox = sandbox;
        this.doc = sandbox.document;
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
            // Models an open permission dialog: getUserMedia stays pending for as long
            // as the user takes to answer it, and anything awaiting it waits too.
            if (opts.micDelayMs) {
                await new Promise(resolve => (this.clock
                    ? this.clock.setTimeout(resolve, opts.micDelayMs)
                    : setTimeout(resolve, opts.micDelayMs)));
            }
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

    /** The <audio> element this side plays `peer` through — the actual sink. */
    remoteSinkFor(peer) { return this.api.voice.remoteAudios.get(peer) || null; }

    /** Fires a user gesture at the document, the way a real click would. */
    gesture(type = 'pointerdown') { return this.doc.dispatch(type); }

    /**
     * How many times this side tried to add a track that already had a sender.
     * A real browser throws InvalidAccessError there, which aborts whatever was
     * negotiating — so this must stay at zero even under concurrent sync passes.
     */
    duplicateAddTrackAttempts() {
        return this.pcs.reduce((sum, pc) => sum + (pc.duplicateAddTrackAttempts || 0), 0);
    }

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

    /**
     * Kills the media transport with `peer` the way a Wi-Fi roam or a NAT rebind
     * does: connectionState reports the failure once and then never changes again.
     */
    breakLinkWith(peer) {
        const entry = this.entryFor(peer);
        if (!entry) return false;
        entry.pc.breakTransport('failed');
        return true;
    }

    /** connectionState as the client sees it for this peer. */
    linkStateWith(peer) { return this.entryFor(peer)?.pc.connectionState || 'none'; }

    /**
     * The full definition of a working call: a negotiated two-way audio session
     * AND a transport that can actually carry it. hasTwoWayAudio alone stays true
     * across a dead link — that is precisely how a call "stays connected" while
     * carrying nothing.
     */
    hasLiveTwoWayAudio(peer) {
        if (!this.hasTwoWayAudio(peer)) return false;
        const state = this.linkStateWith(peer);
        return state === 'connected' || state === 'completed';
    }

    /** How many ICE restarts this side actually put on the wire for `peer`. */
    iceRestartsWith(peer) { return this.entryFor(peer)?.pc.iceRestartsSeen || 0; }

    tracesOf(stage) { return this.traces.filter(t => t.stage === stage); }
}
