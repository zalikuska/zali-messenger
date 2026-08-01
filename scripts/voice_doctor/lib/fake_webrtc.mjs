// A deliberately strict RTCPeerConnection model.
//
// The point is NOT to emulate a browser generously — it is to throw exactly where
// a real browser throws, so illegal state transitions in the client surface as
// failures instead of being silently absorbed. Every rule below is from the WebRTC
// spec's JSEP state machine, and each one has already cost this project a silent call:
//
//   stable            + setRemoteDescription(answer)  -> InvalidStateError
//   stable            + setLocalDescription(rollback) -> InvalidStateError
//   have-local-offer  + setRemoteDescription(offer)   -> InvalidStateError  (glare)
//   have-remote-offer + setLocalDescription(rollback) -> InvalidStateError
//   any               + addIceCandidate before remoteDescription -> InvalidStateError
//
// Media is modelled as "which tracks the SDP actually agreed to carry", so the
// harness can assert audibility rather than merely "connectionState === connected".

let trackSeq = 0;
let streamSeq = 0;

export class FakeMediaStreamTrack {
    constructor(kind) {
        this.kind = kind;
        this.id = `track-${++trackSeq}`;
        this.readyState = 'live';
        this.enabled = true;
        this.muted = false;
        this.onended = null;
        this.onmute = null;
        this.onunmute = null;
    }
    stop() { this.readyState = 'ended'; this.onended?.(); }
}

export class FakeMediaStream {
    constructor(tracks = []) {
        this.id = `stream-${++streamSeq}`;
        this._tracks = [...tracks];
    }
    getTracks() { return [...this._tracks]; }
    getAudioTracks() { return this._tracks.filter(t => t.kind === 'audio'); }
    getVideoTracks() { return this._tracks.filter(t => t.kind === 'video'); }
    addTrack(t) { if (!this._tracks.includes(t)) this._tracks.push(t); }
    removeTrack(t) { this._tracks = this._tracks.filter(x => x !== t); }
}

export function makeLocalStream({ video = false } = {}) {
    const tracks = [new FakeMediaStreamTrack('audio')];
    if (video) tracks.unshift(new FakeMediaStreamTrack('video'));
    return new FakeMediaStream(tracks);
}

class InvalidStateError extends Error {
    constructor(message) { super(message); this.name = 'InvalidStateError'; }
}

class FakeRTCRtpSender {
    constructor(track, pc) { this.track = track; this._pc = pc; this._params = { encodings: [{}] }; }
    getParameters() { return JSON.parse(JSON.stringify(this._params)); }
    async setParameters(p) { this._params = JSON.parse(JSON.stringify(p)); }
    async replaceTrack(track) { this.track = track; }
}

/**
 * @param {object} opts
 * @param {(pc: FakeRTCPeerConnection) => void} [opts.onCreate] registry hook
 * @param {object} [opts.faults] { noRelay, iceFails, gatherNothing }
 */
export function makeRTCPeerConnectionClass(opts = {}) {
    const faults = opts.faults || {};
    const clock = opts.clock;
    const later = (fn, ms) => (clock ? clock.setTimeout(fn, ms) : setTimeout(fn, ms));
    const cancel = (id) => (clock ? clock.clearTimeout(id) : clearTimeout(id));

    class FakeRTCPeerConnection {
        constructor(config = {}) {
            this._config = config;
            this.signalingState = 'stable';
            this.iceGatheringState = 'new';
            this.iceConnectionState = 'new';
            this.connectionState = 'new';
            this.localDescription = null;
            this.remoteDescription = null;
            this.pendingLocalOffer = null;
            this._senders = [];
            this._remoteTracks = [];
            this._iceTimers = [];
            this._closed = false;
            this._remoteCandidates = 0;
            // Set by the harness when the two ends are paired.
            this.peerLink = null;
            this.onicecandidate = null;
            this.onicecandidateerror = null;
            this.onicegatheringstatechange = null;
            this.oniceconnectionstatechange = null;
            this.onsignalingstatechange = null;
            this.onconnectionstatechange = null;
            this.ontrack = null;
            this.onnegotiationneeded = null;
            opts.onCreate?.(this);
        }

        getConfiguration() { return this._config; }

        _assertOpen() {
            if (this._closed) throw new InvalidStateError('peer connection is closed');
        }

        _setSignaling(next) {
            if (this.signalingState === next) return;
            this.signalingState = next;
            this.onsignalingstatechange?.();
        }

        addTrack(track, stream) {
            this._assertOpen();
            const sender = new FakeRTCRtpSender(track, this);
            sender._stream = stream;
            this._senders.push(sender);
            return sender;
        }

        getSenders() { return [...this._senders]; }

        // The SDP is just the facts the harness needs: which kinds this side offers
        // to send, and a nonce so a stale description is distinguishable.
        _describe(type, iceRestart = false) {
            return {
                type,
                sdp: JSON.stringify({
                    type,
                    sends: this._senders.filter(s => s.track && s.track.readyState === 'live').map(s => s.track.kind),
                    streamIds: this._senders.map(s => s._stream?.id || ''),
                    ufrag: `${Math.random().toString(36).slice(2, 8)}${iceRestart ? '-restart' : ''}`,
                }),
            };
        }

        async createOffer(options = {}) {
            this._assertOpen();
            if (this.signalingState !== 'stable' && this.signalingState !== 'have-local-offer') {
                throw new InvalidStateError(`createOffer in ${this.signalingState}`);
            }
            return this._describe('offer', !!options.iceRestart);
        }

        async createAnswer() {
            this._assertOpen();
            if (this.signalingState !== 'have-remote-offer') {
                throw new InvalidStateError(`createAnswer in ${this.signalingState}`);
            }
            return this._describe('answer');
        }

        async setLocalDescription(desc) {
            this._assertOpen();
            const type = desc?.type;
            if (type === 'rollback') {
                if (this.signalingState !== 'have-local-offer') {
                    throw new InvalidStateError(`rollback in ${this.signalingState}`);
                }
                this.pendingLocalOffer = null;
                this._setSignaling('stable');
                return;
            }
            if (type === 'offer') {
                if (this.signalingState !== 'stable') {
                    throw new InvalidStateError(`setLocalDescription(offer) in ${this.signalingState}`);
                }
                this.localDescription = desc;
                this.pendingLocalOffer = desc;
                this._setSignaling('have-local-offer');
                this._startGathering();
                return;
            }
            if (type === 'answer') {
                if (this.signalingState !== 'have-remote-offer') {
                    throw new InvalidStateError(`setLocalDescription(answer) in ${this.signalingState}`);
                }
                this.localDescription = desc;
                this._setSignaling('stable');
                this._startGathering();
                this._maybeConnect();
                return;
            }
            throw new InvalidStateError(`setLocalDescription(${type})`);
        }

        async setRemoteDescription(desc) {
            this._assertOpen();
            const type = desc?.type;
            if (type === 'offer') {
                if (this.signalingState !== 'stable') {
                    throw new InvalidStateError(`setRemoteDescription(offer) in ${this.signalingState}`);
                }
                this.remoteDescription = desc;
                this._setSignaling('have-remote-offer');
                this._emitRemoteTracks(desc);
                return;
            }
            if (type === 'answer') {
                if (this.signalingState !== 'have-local-offer') {
                    throw new InvalidStateError(`setRemoteDescription(answer) in ${this.signalingState}`);
                }
                this.remoteDescription = desc;
                this.pendingLocalOffer = null;
                this._setSignaling('stable');
                this._emitRemoteTracks(desc);
                this._maybeConnect();
                return;
            }
            throw new InvalidStateError(`setRemoteDescription(${type})`);
        }

        _emitRemoteTracks(desc) {
            let parsed;
            try { parsed = JSON.parse(desc.sdp); } catch (e) { return; }
            const kinds = parsed.sends || [];
            const stream = new FakeMediaStream();
            for (const kind of kinds) {
                const track = new FakeMediaStreamTrack(kind);
                stream.addTrack(track);
                this._remoteTracks.push(track);
                const event = {
                    track,
                    streams: [stream],
                    receiver: { track },
                    transceiver: { direction: 'sendrecv', currentDirection: 'sendrecv' },
                };
                queueMicrotask(() => { if (!this._closed) this.ontrack?.(event); });
            }
        }

        _startGathering() {
            if (faults.gatherNothing) return;
            if (this.iceGatheringState === 'complete') return;
            this.iceGatheringState = 'gathering';
            this.onicegatheringstatechange?.();
            const types = faults.noRelay ? ['host', 'srflx'] : ['host', 'srflx', 'relay'];
            types.forEach((type, i) => {
                const t = later(() => {
                    if (this._closed) return;
                    this.onicecandidate?.({
                        candidate: {
                            candidate: `candidate:${i} 1 udp 100 10.0.0.${i + 1} ${40000 + i} typ ${type}`,
                            sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'uf',
                        },
                    });
                }, 1 + i);
                this._iceTimers.push(t);
            });
            const done = later(() => {
                if (this._closed) return;
                this.iceGatheringState = 'complete';
                this.onicegatheringstatechange?.();
                this.onicecandidate?.({ candidate: null });
            }, 5);
            this._iceTimers.push(done);
        }

        async addIceCandidate(candidate) {
            this._assertOpen();
            if (!this.remoteDescription) {
                throw new InvalidStateError('addIceCandidate before setRemoteDescription');
            }
            this._remoteCandidates += 1;
        }

        _maybeConnect() {
            if (this._closed) return;
            if (!this.localDescription || !this.remoteDescription) return;
            if (faults.iceFails) {
                later(() => {
                    if (this._closed) return;
                    this.iceConnectionState = 'failed';
                    this.oniceconnectionstatechange?.();
                    this.connectionState = 'failed';
                    this.onconnectionstatechange?.();
                }, 3);
                return;
            }
            later(() => {
                if (this._closed) return;
                this.iceConnectionState = 'connected';
                this.oniceconnectionstatechange?.();
                this.connectionState = 'connected';
                this.onconnectionstatechange?.();
            }, 3);
        }

        async getStats() {
            const map = new Map();
            map.forEach = Map.prototype.forEach.bind(map);
            return map;
        }

        close() {
            this._closed = true;
            this._iceTimers.forEach(cancel);
            this._iceTimers = [];
            this.signalingState = 'closed';
            this.connectionState = 'closed';
        }

        // ---- assertions used by the checks -------------------------------------
        /** Kinds this side agreed to RECEIVE from the peer (i.e. what it can play). */
        negotiatedIncomingKinds() {
            if (!this.remoteDescription) return [];
            try { return JSON.parse(this.remoteDescription.sdp).sends || []; } catch (e) { return []; }
        }
        /** Kinds this side agreed to SEND (present in the applied local description). */
        negotiatedOutgoingKinds() {
            if (!this.localDescription || this.signalingState !== 'stable') return [];
            try { return JSON.parse(this.localDescription.sdp).sends || []; } catch (e) { return []; }
        }
    }

    return FakeRTCPeerConnection;
}

export class FakeAudioContext {
    /** @param {{ resumeNeverSettles?: boolean, startSuspended?: boolean }} behaviour */
    constructor(behaviour = FakeAudioContext.behaviour) {
        this._behaviour = behaviour || {};
        this.state = this._behaviour.startSuspended === false ? 'running' : 'suspended';
        this.sampleRate = 48000;
        this.onstatechange = null;
        this.destination = { connect() {}, disconnect() {} };
    }
    resume() {
        // WebKit's real behaviour when it refuses: a promise that never settles.
        if (this._behaviour.resumeNeverSettles) return new Promise(() => {});
        this.state = 'running';
        queueMicrotask(() => this.onstatechange?.());
        return Promise.resolve();
    }
    close() { this.state = 'closed'; return Promise.resolve(); }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
    createAnalyser() { return { fftSize: 512, smoothingTimeConstant: 0.8, connect() {}, disconnect() {}, getByteTimeDomainData(a) { a.fill(128); } }; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
}
FakeAudioContext.behaviour = {};
