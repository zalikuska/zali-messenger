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
        if (this.voiceTraceEnabled) {
            // Enabled trace already emits everything; don't log each event twice.
            this.voiceTrace(stage, details, level);
            return;
        }
        this.voiceTrace(stage, details, level);
        const ts = new Date().toLocaleTimeString();
        const compact = Object.entries(details)
            .filter(([, value]) => value !== undefined && value !== null && value !== '')
            .map(([key, value]) => `${key}=${Array.isArray(value) ? `[${value.join(',')}]` : String(value)}`)
            .join(' ');
        const message = compact ? `${stage} ${compact}` : stage;
        this.addLogEntry({ type: level, msg: `[VOICE] ${message}`, ts });
        try {
            const fn = level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log;
            fn?.('[VOICE]', message);
        } catch (e) {}
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
            let packets = 0;
            let bytes = 0;
            let level = null;
            stats.forEach(report => {
                if (report.type === 'inbound-rtp' && (report.kind === 'audio' || report.mediaType === 'audio')) {
                    packets = report.packetsReceived ?? packets;
                    bytes = report.bytesReceived ?? bytes;
                    if (typeof report.audioLevel === 'number') level = report.audioLevel;
                }
            });
            const audio = this.voice.remoteAudios.get(peer);
            const prev = entry.lastInboundBytes || 0;
            entry.lastInboundBytes = bytes;
            const arriving = bytes > prev;
            // This used to only *report* a paused or muted sink. Reporting it is the
            // hard part, but doing nothing about it means the one condition we can
            // actually fix is the one we watch go by every 10 s — retry the playback
            // as well. It costs a play() call and is a no-op when the sink is healthy.
            if (audio && (audio.paused || audio.muted)) {
                this.syncRemoteAudioPlaybackMode();
            }
            this.voiceDiag('audio-health', {
                peer,
                rtp: arriving ? 'flowing' : 'STALLED',
                packets,
                bytes,
                level: level === null ? '' : level.toFixed(3),
                sink: audio ? (audio.muted ? 'MUTED' : audio.paused ? 'PAUSED' : 'playing') : 'NO ELEMENT',
                volume: audio ? audio.volume : '',
                ctx: this.voice.audioContext?.state || 'none',
            }, (arriving && audio && !audio.muted && !audio.paused) ? 'INFO' : 'WARN');
        } catch (error) {
            this.voiceDiag('audio-health-failed', { peer, error: error?.message || String(error) }, 'WARN');
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
        const compact = Object.entries(details)
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
