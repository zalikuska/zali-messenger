// --- ZaliInterface: Журнал диагностики и голосовая телеметрия. ---
// Часть класса ZaliInterface (см. web/src/interface.js). Тела методов
// перенесены сюда дословно; ZaliMixin копирует дескрипторы на прототип,
// поэтому поведение и неперечисляемость методов те же, что у class-тела.
ZaliMixin(ZaliInterface, class {

    addLogEntry({ type, msg, ts }) {
        // Mirror to console so the native console-hook persists the full in-app
        // journal to zali-debug.log on disk (readable without the UI).
        try { console.log(`[ZALI][JOURNAL] ${type}: ${msg}`); } catch (e) {}
        const body = document.getElementById('logBody');
        if (body) {
            const div = document.createElement('div');
            div.className = `log-entry log-${type}`;
            div.innerHTML = `<span class="ts">[${ts}]</span>${this.esc(type)}: ${this.esc(msg)}`;
            body.appendChild(div);
            body.scrollTop = body.scrollHeight;
            if (body.childElementCount > 300) body.removeChild(body.firstElementChild);
        }
    }

    // Always-on counterpart of voiceTrace, for the handful of facts that decide
    // whether a call carries audio: ICE/connection state, which candidate pair won
    // (host/srflx/relay), and why a link died. voiceTrace is gated behind a dev
    // toggle nobody has enabled *before* a call goes wrong, which is exactly when
    // the data is needed — every failed call so far had to be diagnosed from the
    // server's signalling log alone, which cannot see ICE at all. A handful of lines
    // per call; on macOS they land in zali-debug.log via the console mirror.
    voiceDiag(stage, details = {}, level = 'INFO') {
        const ts = new Date().toLocaleTimeString();
        const compact = this.formatVoiceDetails(details);
        const message = compact ? `${stage} ${compact}` : stage;
        // Kept whatever the dev trace toggle says, and kept ACROSS calls: the
        // question asked after a bad call is always "what happened", and by then
        // voice.traceLines has been wiped by resetVoiceState and the 14-line window
        // was long gone anyway. This ring is the record that survives to be read.
        this.pushVoiceDiagLine({ ts, level, stage, message });
        if (this.voiceTraceEnabled) {
            // Trace prints the same line with the full detail objects; printing it
            // twice would only double the journal.
            this.voiceTrace(stage, details, level);
            return;
        }
        this.addLogEntry({ type: level, msg: `[VOICE] ${message}`, ts });
        try {
            const fn = level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log;
            fn?.('[VOICE]', message);
        } catch (e) {}
    }

    // One formatter for both voiceDiag and voiceTrace, so a line reads the same
    // whichever of the two produced it — a log where the same fact is spelled two
    // ways cannot be grepped, and grepping it is the entire point.
    formatVoiceDetails(details = {}) {
        return Object.entries(details)
            .filter(([, value]) => value !== undefined && value !== null && value !== '')
            .map(([key, value]) => {
                if (Array.isArray(value)) {
                    const hasObjects = value.some(item => item !== null && typeof item === 'object');
                    if (hasObjects) {
                        try { return `${key}=${JSON.stringify(value)}`; } catch (e) { return `${key}=[object]`; }
                    }
                    return `${key}=[${value.join(',')}]`;
                }
                if (typeof value === 'object') {
                    try { return `${key}=${JSON.stringify(value)}`; } catch (e) { return `${key}=[object]`; }
                }
                return `${key}=${String(value)}`;
            })
            .join(' ');
    }

    // Bounded and deliberately NOT part of this.voice: resetVoiceState clears voice
    // state at the exact moment the interesting call ends, so anything kept there is
    // erased before anyone can look at it. 400 lines is a couple of full calls with
    // per-peer health sampling, and each line is a short string — no payloads, no
    // MediaStream references, nothing that can pin memory (see the perf invariants
    // in CLAUDE.md).
    pushVoiceDiagLine(line) {
        const ring = this._voiceDiagRing || (this._voiceDiagRing = []);
        ring.push(line);
        if (ring.length > 400) ring.splice(0, ring.length - 400);
    }

    // A rebuilt peer connection loses every counter it was carrying, so the tally
    // lives on the call instead of the entry. Rebuilds are the loudest signal that a
    // link was fighting the session state rather than the network: one is routine
    // recovery, five in a call means something upstream keeps producing offers this
    // side cannot take.
    countVoicePeerRebuild(peer, reason = '') {
        this.voice.rebuilds = Number(this.voice.rebuilds || 0) + 1;
        this.voiceDiag('peer-rebuild', {
            peer,
            reason,
            roomId: this.voice.roomId || '',
            total: this.voice.rebuilds,
            ...this.voicePeerSnapshot(peer),
        }, 'WARN');
    }

    // The whole ring as text, newest last — what to paste into a bug report. Also
    // what the "скопировать диагностику" control in the voice panel hands over.
    dumpVoiceDiagnostics() {
        const ring = Array.isArray(this._voiceDiagRing) ? this._voiceDiagRing : [];
        return ring.map(line => `[${line.ts}] ${line.level} ${line.message}`).join('\n');
    }

    // Compact, always-cheap description of one peer link. Every diagnostic that
    // names a peer includes it, so a single line answers "in what state did this
    // happen" without cross-referencing three others.
    voicePeerSnapshot(peer) {
        const entry = this.voice.peerConnections.get(String(peer || '').trim());
        if (!entry?.pc) return {};
        return {
            pcState: entry.pc.connectionState || '',
            ice: entry.pc.iceConnectionState || '',
            gathering: entry.pc.iceGatheringState || '',
            signaling: entry.pc.signalingState || '',
            offerSent: !!entry.offerSent,
            negotiating: !!entry.negotiating,
            renegPending: !!entry.renegotiationPending,
            needsIceRestart: !!entry.needsIceRestart,
            answerWatchdog: !!entry.answerWatchdog,
            answerRetries: Number(entry.answerRetries || 0),
            linkRecovery: Number(entry.linkRecoveryAttempts || 0),
            candOut: Number(entry.generatedIceCandidates || 0),
            candIn: Number(entry.receivedIceCandidates || 0),
            candTypes: entry.gatheredCandidateTypes ? Array.from(entry.gatheredCandidateTypes).join('/') : '',
            pendingIce: entry.pendingIceCandidates?.length || 0,
        };
    }

    // Answers "connected but silent" without guesswork, on a real call: does RTP
    // actually arrive, and is the sink able to play it? Every silent call so far had
    // to be argued about from first principles because nothing recorded these two
    // facts together. One line per peer every 10 s, always on.
    async reportVoiceAudioHealth(peer) {
        const entry = this.voice.peerConnections.get(peer);
        if (!entry?.pc?.getStats) return;
        try {
            const stats = await entry.pc.getStats();
            let inPackets = 0;
            let inBytes = 0;
            let inLost = 0;
            let inJitter = null;
            let level = null;
            let concealed = null;
            let outPackets = 0;
            let outBytes = 0;
            let outLevel = null;
            // remote-inbound-rtp is what the PEER reports about OUR stream. It is the
            // only view of the upstream direction we have: local outbound counters
            // rise happily while every packet is dropped in the network, so "we are
            // sending" and "they are receiving" are different questions and only this
            // report answers the second one.
            let remoteLost = null;
            let remoteJitter = null;
            let rtt = null;
            let availableOut = null;
            stats.forEach(report => {
                const isAudio = report.kind === 'audio' || report.mediaType === 'audio';
                if (report.type === 'inbound-rtp' && isAudio) {
                    inPackets = report.packetsReceived ?? inPackets;
                    inBytes = report.bytesReceived ?? inBytes;
                    inLost = report.packetsLost ?? inLost;
                    if (typeof report.jitter === 'number') inJitter = report.jitter;
                    if (typeof report.audioLevel === 'number') level = report.audioLevel;
                    if (typeof report.concealedSamples === 'number') concealed = report.concealedSamples;
                }
                if (report.type === 'outbound-rtp' && isAudio) {
                    outPackets = report.packetsSent ?? outPackets;
                    outBytes = report.bytesSent ?? outBytes;
                }
                if (report.type === 'media-source' && isAudio && typeof report.audioLevel === 'number') {
                    outLevel = report.audioLevel;
                }
                if (report.type === 'remote-inbound-rtp' && isAudio) {
                    if (typeof report.packetsLost === 'number') remoteLost = report.packetsLost;
                    if (typeof report.jitter === 'number') remoteJitter = report.jitter;
                    if (typeof report.roundTripTime === 'number') rtt = report.roundTripTime;
                }
                if (report.type === 'candidate-pair' && (report.selected || (report.state === 'succeeded' && report.nominated))) {
                    if (typeof report.currentRoundTripTime === 'number') rtt = report.currentRoundTripTime;
                    if (typeof report.availableOutgoingBitrate === 'number') availableOut = report.availableOutgoingBitrate;
                }
            });
            const audio = this.voice.remoteAudios.get(peer);
            const prevIn = entry.lastInboundBytes || 0;
            const prevOut = entry.lastOutboundBytes || 0;
            entry.lastInboundBytes = inBytes;
            entry.lastOutboundBytes = outBytes;
            const arriving = inBytes > prevIn;
            // A dead upstream is as silent as a dead downstream and used to be
            // invisible here: the old line reported only what we RECEIVE, so "он меня
            // не слышит" had no evidence at all. A muted mic legitimately stops the
            // byte counter, so mute is reported next to it rather than mixed into the
            // verdict.
            const sending = outBytes > prevOut;
            const localTrack = this.voice.localStream?.getAudioTracks?.()[0] || null;
            // This used to only *report* a paused or muted sink. Reporting it is the
            // hard part, but doing nothing about it means the one condition we can
            // actually fix is the one we watch go by every 10 s — retry the playback
            // as well. It costs a play() call and is a no-op when the sink is healthy.
            if (audio && (audio.paused || (audio.muted && !this.voice.deafened))) {
                this.syncRemoteAudioPlaybackMode();
            }
            const snapshot = this.voicePeerSnapshot(peer);
            // "No RTP" is only a fault once the link claims to be up. Before that it
            // is just a call in the middle of connecting, and a WARN on every single
            // call — several per peer in a group — is how a diagnostic line stops
            // being read at all. The failure of a link that never connects is
            // reported by pc-state and link-recovery, which are about that.
            const live = snapshot.pcState === 'connected' || snapshot.pcState === 'completed';
            const healthy = arriving
                && (sending || this.voice.muted)
                && !!audio && !audio.paused && (!audio.muted || this.voice.deafened);
            this.voiceDiag('audio-health', {
                peer,
                roomId: this.voice.roomId || '',
                rx: arriving ? 'flowing' : 'STALLED',
                tx: sending ? 'flowing' : (this.voice.muted ? 'muted' : 'STALLED'),
                pcState: snapshot.pcState || '',
                ice: snapshot.ice || '',
                signaling: snapshot.signaling || '',
                inPackets,
                inBytes,
                inLost,
                inJitter: inJitter === null ? '' : inJitter.toFixed(4),
                concealed: concealed === null ? '' : concealed,
                outPackets,
                outBytes,
                peerLost: remoteLost === null ? '' : remoteLost,
                peerJitter: remoteJitter === null ? '' : remoteJitter.toFixed(4),
                rtt: rtt === null ? '' : rtt.toFixed(3),
                availOutKbps: availableOut === null ? '' : Math.round(availableOut / 1000),
                rxLevel: level === null ? '' : level.toFixed(3),
                txLevel: outLevel === null ? '' : outLevel.toFixed(3),
                sink: audio ? (audio.muted ? 'MUTED' : audio.paused ? 'PAUSED' : 'playing') : 'NO ELEMENT',
                volume: audio ? audio.volume : '',
                ctx: this.voice.audioContext?.state || 'none',
                mic: localTrack ? `${localTrack.readyState}:${localTrack.enabled ? 'on' : 'off'}` : 'none',
                muted: !!this.voice.muted,
                deafened: !!this.voice.deafened,
                candTypes: snapshot.candTypes || '',
            }, (healthy || !live) ? 'INFO' : 'WARN');
        } catch (error) {
            this.voiceDiag('audio-health-failed', { peer, error: error?.message || String(error) }, 'WARN');
        }
    }

    // Written once when a call ends, from resetVoiceState, while the peer entries
    // still exist. Answers "how did that call actually go" in one line per peer —
    // without it the only record is a scattering of per-event lines whose totals
    // nobody reconstructs by hand.
    logVoiceCallSummary(reason = 'end') {
        const roomId = String(this.voice.roomId || '').trim();
        if (!roomId && !this.voice.peerConnections.size) return;
        const track = this.voice.callTrack || null;
        const startedAt = Number(track?.startedAt || 0);
        const connectedAt = Number(track?.connectedAt || 0);
        this.voiceDiag('call-summary', {
            reason,
            roomId,
            roomType: this.voice.roomType || '',
            status: this.voice.status || '',
            peers: this.voice.peerConnections.size,
            participants: Array.isArray(this.voice.participants) ? this.voice.participants : [],
            setupMs: startedAt && connectedAt ? connectedAt - startedAt : '',
            talkMs: connectedAt ? Date.now() - connectedAt : '',
            outcome: track?.outcome || '',
            micError: this.voice.micError || '',
            negotiationRetries: Number(this.voice.negotiationRetries || 0),
            peerRebuilds: Number(this.voice.rebuilds || 0),
            ctx: this.voice.audioContext?.state || 'none',
            playbackUnlocked: !!this.voice.playbackUnlocked,
        }, 'INFO');
        for (const [peer, entry] of this.voice.peerConnections) {
            const stats = entry.lastStats || {};
            this.voiceDiag('call-summary-peer', {
                peer,
                ...this.voicePeerSnapshot(peer),
                inBytes: stats.inBytes ?? entry.lastInboundBytes ?? '',
                outBytes: stats.outBytes ?? entry.lastOutboundBytes ?? '',
                inPackets: stats.inPackets ?? '',
                outPackets: stats.outPackets ?? '',
                selectedPair: stats.candidatePair
                    ? `${stats.candidatePair.localLabel || ''}<->${stats.candidatePair.remoteLabel || ''}`
                    : '',
                iceRestarts: Number(entry.iceRestartCount || 0),
                exhausted: !!entry.linkRecoveryExhausted,
            }, entry.linkRecoveryExhausted ? 'WARN' : 'INFO');
        }
    }

    // Names the candidate pair actually carrying media, which is the difference
    // between "ICE said connected" and "audio has a path". Read once per successful
    // connect, so it costs one getStats() call per peer per call.
    async reportVoiceSelectedPair(peer) {
        const entry = this.voice.peerConnections.get(peer);
        if (!entry?.pc?.getStats) return;
        try {
            const stats = await entry.pc.getStats();
            const byId = new Map();
            let pair = null;
            stats.forEach(report => {
                byId.set(report.id, report);
                if (report.type === 'candidate-pair' && (report.selected || report.state === 'succeeded' && report.nominated)) {
                    pair = report;
                }
            });
            if (!pair) return;
            const local = byId.get(pair.localCandidateId);
            const remote = byId.get(pair.remoteCandidateId);
            this.voiceDiag('selected-pair', {
                peer,
                local: local ? `${local.candidateType}/${local.protocol}` : '?',
                remote: remote ? `${remote.candidateType}/${remote.protocol}` : '?',
                rtt: pair.currentRoundTripTime ?? '',
                bytesIn: pair.bytesReceived ?? '',
                bytesOut: pair.bytesSent ?? '',
            }, 'SUCCESS');
        } catch (error) {
            this.voiceDiag('selected-pair-failed', { peer, error: error?.message || String(error) }, 'WARN');
        }
    }

    voiceTrace(stage, details = {}, level = 'INFO') {
        if (!this.voiceTraceEnabled) return;
        const ts = new Date().toLocaleTimeString();
        const compact = this.formatVoiceDetails(details);
        const message = compact ? `${stage} ${compact}` : stage;
        this.voice.traceLines = Array.isArray(this.voice.traceLines) ? this.voice.traceLines : [];
        this.voice.traceLines.push({ ts, level, stage, message });
        if (this.voice.traceLines.length > 14) {
            this.voice.traceLines.splice(0, this.voice.traceLines.length - 14);
        }
        this.addLogEntry({ type: level, msg: `[VOICE] ${message}`, ts });
        try {
            const fn = level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.debug;
            fn?.('[VOICE]', stage, details);
        } catch (e) {}
    }
});
