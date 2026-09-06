// --- ZaliInterface: Захват микрофона/камеры/экрана, треки, индикаторы уровня. ---
// Часть класса ZaliInterface (см. web/src/interface.js). Тела методов
// перенесены сюда дословно; ZaliMixin копирует дескрипторы на прототип,
// поэтому поведение и неперечисляемость методов те же, что у class-тела.
ZaliMixin(ZaliInterface, class {

    // Full mesh has no server-side mixer: every camera is encoded and uploaded once
    // per other participant. Past this many peers a consumer uplink cannot carry
    // video without starving the audio that shares it, and audio is what the call is
    // for — so video is refused with a reason rather than allowed to break the call.
    // Audio alone stays fine well past this; see MAX_MESH_AUDIO_PEERS.
    static get MAX_MESH_VIDEO_PEERS() { return 6; }

    // Not enforced — a mesh audio call this large still works, it just stops being
    // comfortable, and refusing to connect people who asked to be connected is worse
    // than a warning in the log. Crossing it is recorded so that "звонок тормозил at
    // 11 people" is a fact in the journal rather than a recollection.
    static get MAX_MESH_AUDIO_PEERS() { return 8; }

    // Dedupes concurrent capture requests. In a group call every incoming offer
    // handler (and every voice_room_state) calls this, and handleVoiceEvent is
    // dispatched fire-and-forget — so with 3+ participants two or three offers
    // land while localStream is still null and each used to fire its own
    // getUserMedia(). Best case that opened several independent mic captures
    // (mute via track.enabled then only reached some peers, and the surplus
    // captures were never stopped); worst case the 2nd/3rd capture failed with
    // NotReadableError/AbortError because the device was already claimed, so
    // attachLocalVoiceTracks() no-oped for that peer and it answered recvonly —
    // exactly the "некоторые не слышат некоторых" symptom.
    async ensureVoiceLocalStream() {
        if (this.voice.localStream) return this.voice.localStream;
        if (this.voice.localStreamInFlight) return this.voice.localStreamInFlight;
        const pending = this.captureVoiceLocalStream();
        this.voice.localStreamInFlight = pending;
        try {
            return await pending;
        } catch (error) {
            // Without local tracks syncVoicePeers never sends an offer, so the call
            // stays in the room and silent forever. Keep the reason so the panel can
            // say why instead of leaving the user with a mute "connected" call.
            this.voice.micError = this.describeMicError(error);
            this.voiceTrace('local-stream-failed', { error: error?.message || String(error), name: error?.name || '' }, 'ERROR');
            this.renderVoicePanel();
            throw error;
        } finally {
            if (this.voice.localStreamInFlight === pending) {
                this.voice.localStreamInFlight = null;
            }
        }
    }

    // Resolves true once the local stream exists, false if the wait runs out first —
    // and still rejects if the capture itself failed, so a denied microphone stays
    // distinguishable from a slow one. For callers that must make progress on a
    // deadline (answering an offer) rather than block on a permission dialog.
    async awaitVoiceLocalStream(timeoutMs = 4000) {
        if (this.voice.localStream) return true;
        const pending = this.ensureVoiceLocalStream();
        let timer = null;
        // Promise.race attaches its own handlers to both, so a capture that fails
        // after the deadline already won is not an unhandled rejection.
        const deadline = new Promise(resolve => {
            timer = setTimeout(() => resolve(false), Math.max(0, Number(timeoutMs) || 0));
        });
        try {
            return await Promise.race([pending.then(() => true), deadline]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    // getUserMedia's DOMException names are the only reliable signal here (messages
    // differ per browser and are usually empty), and each one needs a different
    // action from the user, so they must not collapse into one generic string.
    describeMicError(error) {
        const name = String(error?.name || '').trim();
        if (name === 'NotAllowedError' || name === 'SecurityError') {
            return 'Доступ к микрофону запрещён. Разрешите его в настройках сайта и переподключитесь к звонку.';
        }
        if (name === 'NotFoundError' || name === 'OverconstrainedError') {
            return 'Микрофон не найден. Подключите устройство ввода и переподключитесь к звонку.';
        }
        if (name === 'NotReadableError' || name === 'AbortError') {
            return 'Микрофон занят другим приложением. Освободите его и переподключитесь к звонку.';
        }
        return error?.message ? `Микрофон недоступен: ${error.message}` : 'Микрофон недоступен.';
    }

    async captureVoiceLocalStream() {
        if (this.voice.localStream) return this.voice.localStream;
        if (!this.voice.supported) {
            throw new Error('Голосовые звонки не поддерживаются в этом окружении');
        }
        const micConstraint = this.audioPrefs?.micDeviceId
            ? { deviceId: { exact: this.audioPrefs.micDeviceId } }
            : true;
        const getAudioOnlyStream = async () => {
            try {
                return await navigator.mediaDevices.getUserMedia({ audio: micConstraint, video: false });
            } catch (error) {
                // Saved device id may no longer exist (unplugged/removed) — fall
                // back to the system default rather than failing the whole call.
                if (micConstraint === true) throw error;
                this.voiceTrace('mic-fallback-default', { error: error?.message || String(error) }, 'WARN');
                return navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            }
        };
        let stream;
        if (this.voice.videoEnabled) {
            try {
                stream = await navigator.mediaDevices.getUserMedia({
                    audio: micConstraint,
                    video: { width: { ideal: 1280 }, height: { ideal: 720 } },
                });
                this.voice.cameraOn = true;
            } catch (error) {
                this.voiceTrace('camera-request-failed', { error: error?.message || String(error) }, 'WARN');
                this.addLogEntry({ type: 'WARN', msg: 'Камера недоступна — продолжаем аудиозвонком', ts: new Date().toLocaleTimeString() });
                this.voice.videoEnabled = false;
                stream = await getAudioOnlyStream();
            }
        } else {
            stream = await getAudioOnlyStream();
        }
        this.voice.localStream = stream;
        this.voice.micError = '';
        this.voice.muted = false;
        this.voiceDiag('local-stream-ready', {
            tracks: stream.getTracks().map(track => `${track.kind}:${track.readyState}:${track.enabled ? 'on' : 'off'}`),
        });
        this.ensureVoiceMeterLoop();
        this.attachLocalVideoPreview();
        return stream;
    }

    attachLocalVideoPreview() {
        if (!this.voice.localStream || !this.voice.localStream.getVideoTracks().length) return;
        let video = this.voice.localVideoEl;
        if (!video) {
            video = document.createElement('video');
            video.autoplay = true;
            video.playsInline = true;
            video.muted = true;
            this.voice.localVideoEl = video;
        }
        if (video.srcObject !== this.voice.localStream) {
            video.srcObject = this.voice.localStream;
        }
        video.play?.().catch(() => {});
        this.scheduleRenderVoicePanel();
    }

    detachLocalVideoPreview() {
        const video = this.voice.localVideoEl;
        if (video) {
            try { video.pause?.(); video.srcObject = null; video.remove?.(); } catch (e) {}
        }
        this.voice.localVideoEl = null;
    }

    async setVoiceCameraEnabled(enabled) {
        if (enabled) {
            await this.enableVoiceCamera();
        } else {
            this.disableVoiceCamera();
        }
    }

    async enableVoiceCamera() {
        // Guards the getUserMedia() call itself, not just the cameraOn result —
        // cameraOn only flips true once the call resolves, so without this a
        // fast double-click fires two concurrent capture requests; whichever
        // resolves last would silently overwrite this.voice.localStream's video
        // track, leaking the other's camera lock with no track.stop() ever called.
        if (this.voice.cameraOn || this.voice.cameraRequestInFlight) return;
        const peerCount = this.voice.peerConnections.size;
        if (peerCount > ZaliInterface.MAX_MESH_VIDEO_PEERS) {
            this.voiceDiag('camera-refused-mesh-size', {
                peers: peerCount,
                limit: ZaliInterface.MAX_MESH_VIDEO_PEERS,
                roomId: this.voice.roomId || '',
            }, 'WARN');
            this.addLogEntry({
                type: 'WARN',
                msg: `Камера недоступна: в звонке ${peerCount} собеседников, видео на всех сразу не поместится в канал`,
                ts: new Date().toLocaleTimeString(),
            });
            return;
        }
        this.voice.cameraRequestInFlight = true;
        try {
            if (!this.voice.localStream) {
                this.voice.videoEnabled = true;
                try {
                    await this.ensureVoiceLocalStream();
                    for (const peer of this.voice.peerConnections.keys()) {
                        await this.attachLocalVoiceTracks(peer);
                    }
                    await this.renegotiateAllVoicePeers();
                } catch (error) {
                    this.voiceTrace('camera-enable-failed', { error: error?.message || String(error) }, 'WARN');
                    this.addLogEntry({ type: 'WARN', msg: error?.message || 'Не удалось включить камеру', ts: new Date().toLocaleTimeString() });
                }
                this.renderVoicePanel();
                return;
            }
            try {
                const camStream = await navigator.mediaDevices.getUserMedia({
                    video: { width: { ideal: 1280 }, height: { ideal: 720 } },
                });
                const track = camStream.getVideoTracks()[0];
                if (!track) return;
                this.voice.localStream.addTrack(track);
                this.voice.videoEnabled = true;
                this.voice.cameraOn = true;
                this.attachLocalVideoPreview();
                for (const peer of this.voice.peerConnections.keys()) {
                    const entry = this.getVoicePeerEntry(peer);
                    if (entry.videoSender) {
                        await entry.videoSender.replaceTrack(track);
                    } else {
                        entry.videoSender = entry.pc.addTrack(track, this.voice.localStream);
                    }
                    await this.applyVoiceVideoBitrateLimit(entry.videoSender, 'camera');
                }
                await this.renegotiateAllVoicePeers();
                this.renderVoicePanel();
            } catch (error) {
                this.voiceTrace('camera-enable-failed', { error: error?.message || String(error) }, 'WARN');
                this.addLogEntry({ type: 'WARN', msg: error?.message || 'Не удалось включить камеру', ts: new Date().toLocaleTimeString() });
            }
        } finally {
            this.voice.cameraRequestInFlight = false;
        }
    }

    disableVoiceCamera() {
        if (!this.voice.cameraOn) return;
        const stream = this.voice.localStream;
        if (stream) {
            for (const track of stream.getVideoTracks()) {
                try { track.stop(); } catch (e) {}
                try { stream.removeTrack(track); } catch (e) {}
            }
        }
        this.voice.cameraOn = false;
        this.voice.videoEnabled = false;
        this.detachLocalVideoPreview();
        for (const entry of this.voice.peerConnections.values()) {
            if (entry.videoSender) {
                try { entry.pc.removeTrack(entry.videoSender); } catch (e) {}
                entry.videoSender = null;
            }
        }
        this.renegotiateAllVoicePeers();
        this.renderVoicePanel();
    }

    async renegotiateAllVoicePeers() {
        for (const peer of this.voice.peerConnections.keys()) {
            await this.renegotiateVoicePeer(peer);
        }
    }

    // Builds this peer's next offer. The only decision it makes is whether the
    // offer must restart ICE — and it must whenever the link is known to be down.
    //
    // Only restartVoicePeer used to pass iceRestart, and it is not the path that
    // ends up sending most recovery offers: a restart requested outside 'stable'
    // parks on renegotiationPending and drains through renegotiateVoicePeer, an
    // unanswered restart offer is retried by the answer watchdog through
    // renegotiateVoicePeer, and syncVoicePeers re-offers through sendVoiceOffer.
    // All three built a PLAIN offer, which re-agrees the media over the transport
    // that is already dead: negotiation completes, signalingState returns to
    // 'stable', both sides look fully negotiated — and not a single packet can
    // flow. Making the flag a property of the link instead of an argument to one
    // function is what keeps every path honest.
    createVoiceOfferFor(entry) {
        if (!entry?.pc) return Promise.reject(new Error('no peer connection'));
        if (entry.needsIceRestart) {
            // Counted so the end-of-call summary can say "this link was restarted
            // nine times" — one restart is a blip, nine is a network worth naming.
            entry.iceRestartCount = Number(entry.iceRestartCount || 0) + 1;
            return entry.pc.createOffer({ iceRestart: true });
        }
        return entry.pc.createOffer();
    }

    async renegotiateVoicePeer(peer) {
        const entry = this.getVoicePeerEntry(peer);
        if (!entry) return;
        // `entry.negotiating` is set synchronously below, before any `await` —
        // closing the race window that `signalingState` alone leaves open
        // (createOffer() doesn't flip signalingState; only setLocalDescription
        // does, so two renegotiations triggered back-to-back — e.g. disabling
        // the camera then immediately stopping screen share — could otherwise
        // both observe 'stable' and both proceed). A call arriving while busy,
        // or while the connection is already mid-negotiation for any other
        // reason (glare, an in-flight initial offer/answer), is queued instead
        // of dropped — onsignalingstatechange drains it once stable again.
        if (entry.negotiating || entry.pc.signalingState !== 'stable') {
            entry.renegotiationPending = true;
            this.voiceTrace('renegotiate-queued', { peer, state: entry.pc.signalingState, negotiating: !!entry.negotiating });
            return;
        }
        entry.negotiating = true;
        try {
            const offer = await this.createVoiceOfferFor(entry);
            await entry.pc.setLocalDescription(offer);
            this.voiceDiag('renegotiate-offer', { peer, roomId: this.voice.roomId || '', iceRestart: !!entry.needsIceRestart });
            const delivered = this.sendVoiceEvent({
                type: 'voice_signal',
                roomId: this.voice.roomId,
                roomType: this.voice.roomType,
                serverId: this.voice.serverId,
                channelId: this.voice.channelId,
                to: peer,
                signal: {
                    type: 'offer',
                    sdp: {
                        type: entry.pc.localDescription?.type || 'offer',
                        sdp: entry.pc.localDescription?.sdp || '',
                    },
                },
            });
            if (!delivered) {
                this.voiceDiag('renegotiate-send-failed', { peer, roomId: this.voice.roomId || '' }, 'WARN');
            }
            // Whether the offer was lost on the way out or its answer never came
            // back, the outcome is identical and equally invisible: this connection
            // stays in 'have-local-offer' and every later renegotiation for it
            // queues forever. The watchdog is the only thing that notices.
            this.armVoiceAnswerWatchdog(entry, peer);
        } catch (error) {
            this.voiceTrace('renegotiate-error', { peer, error: error?.message || String(error) }, 'WARN');
        } finally {
            entry.negotiating = false;
        }
    }

    attachLocalScreenPreview() {
        if (!this.voice.localScreenStream) return;
        let video = this.voice.localScreenVideoEl;
        if (!video) {
            video = document.createElement('video');
            video.autoplay = true;
            video.playsInline = true;
            video.muted = true;
            this.voice.localScreenVideoEl = video;
        }
        if (video.srcObject !== this.voice.localScreenStream) {
            video.srcObject = this.voice.localScreenStream;
        }
        video.play?.().catch(() => {});
        this.scheduleRenderVoicePanel();
    }

    detachLocalScreenPreview() {
        const video = this.voice.localScreenVideoEl;
        if (video) {
            try { video.pause?.(); video.srcObject = null; video.remove?.(); } catch (e) {}
        }
        this.voice.localScreenVideoEl = null;
    }

    toggleScreenShare() {
        if (this.voice.screenSharing) {
            this.stopScreenShare();
        } else {
            this.startScreenShare();
        }
    }

    // Announces which local MediaStream carries the screen share so the peer's
    // ontrack handler can tell it apart from the camera stream (both arrive as
    // separate video tracks from the same peer) — see handleVoiceSignal's
    // 'screen-meta' branch. Relayed through the existing voice_signal envelope,
    // no server changes needed since route_voice_signal is payload-agnostic.
    sendScreenShareMeta(peer, action) {
        this.sendVoiceEvent({
            type: 'voice_signal',
            roomId: this.voice.roomId,
            roomType: this.voice.roomType,
            serverId: this.voice.serverId,
            channelId: this.voice.channelId,
            to: peer,
            signal: {
                type: 'screen-meta',
                action,
                streamId: action === 'start' ? (this.voice.localScreenStream?.id || '') : '',
            },
        });
    }

    // Attaches the already-captured screen track to one peer's connection.
    // Shared by startScreenShare (existing peers) and syncVoicePeers (peers
    // that join/are created after screen sharing already started).
    attachLocalScreenTrackToPeer(peer) {
        if (!this.voice.screenSharing || !this.voice.localScreenStream) return false;
        const entry = this.getVoicePeerEntry(peer);
        if (!entry || entry.screenSender) return false;
        const track = this.voice.localScreenStream.getVideoTracks()[0];
        if (!track) return false;
        entry.screenSender = entry.pc.addTrack(track, this.voice.localScreenStream);
        void this.applyVoiceVideoBitrateLimit(entry.screenSender, 'screen');
        this.sendScreenShareMeta(peer, 'start');
        this.voiceTrace('screen-track-attached', { peer, streamId: this.voice.localScreenStream.id || '' });
        return true;
    }

    async startScreenShare() {
        // Guards the getDisplayMedia() call itself — screenSharing only flips
        // true once it resolves, so a fast double-click before the OS picker
        // even returns would otherwise fire two concurrent capture requests;
        // whichever resolves last silently overwrites localScreenStream,
        // leaking the other capture (its track.stop() never runs, so the OS's
        // "sharing your screen" indicator can stay on for it indefinitely).
        if (this.voice.screenSharing || this.voice.screenShareRequestInFlight) return;
        if (!navigator.mediaDevices?.getDisplayMedia) {
            // Android WebView has no getDisplayMedia() at all (Chromium/WebView
            // limitation, not a missing bridge hook) — route through native
            // MediaProjection capture instead when the platform offers it.
            if (this.nativeSupports('screenCapture')) {
                this.startNativeScreenCapture();
                return;
            }
            this.addLogEntry({ type: 'WARN', msg: 'Демонстрация экрана не поддерживается в этом окружении', ts: new Date().toLocaleTimeString() });
            return;
        }
        this.voice.screenShareRequestInFlight = true;
        try {
            const stream = await navigator.mediaDevices.getDisplayMedia({
                video: { cursor: 'always', frameRate: 30 },
                audio: false,
            });
            const track = stream.getVideoTracks()[0];
            if (!track) return;
            this.voice.localScreenStream = stream;
            this.voice.screenSharing = true;
            // Fires when the user stops sharing via the browser/OS's own
            // "Stop sharing" control, not just our in-app button.
            track.addEventListener('ended', () => this.stopScreenShare());
            this.attachLocalScreenPreview();
            this.voiceTrace('screen-share-start', { streamId: stream.id, label: track.label || '' });
            for (const peer of this.voice.peerConnections.keys()) {
                this.attachLocalScreenTrackToPeer(peer);
            }
            await this.renegotiateAllVoicePeers();
            // screen-meta travels as an independent signal from the SDP that
            // actually carries the track (see sendScreenShareMeta) — if that
            // first send is lost (e.g. a socket reconnect at exactly the wrong
            // moment), the peer's ontrack fires with no id to match and files
            // the screen under camera video with no way to self-correct. A
            // second, post-renegotiation send is cheap, idempotent insurance
            // against a single dropped message.
            for (const peer of this.voice.peerConnections.keys()) {
                if (this.voice.peerConnections.get(peer)?.screenSender) {
                    this.sendScreenShareMeta(peer, 'start');
                }
            }
            this.renderVoicePanel();
        } catch (error) {
            // AbortError/NotAllowedError just mean the user cancelled the
            // browser's screen/window/tab picker — not worth surfacing as a warning.
            if (error?.name !== 'NotAllowedError' && error?.name !== 'AbortError') {
                this.addLogEntry({ type: 'WARN', msg: error?.message || 'Не удалось начать демонстрацию экрана', ts: new Date().toLocaleTimeString() });
            }
            this.voiceTrace('screen-share-failed', { error: error?.message || String(error) }, 'WARN');
        } finally {
            this.voice.screenShareRequestInFlight = false;
        }
    }

    stopScreenShare() {
        if (!this.voice.screenSharing) return;
        if (this.voice.screenCaptureFromNative) {
            this.postNativeMessage({
                type: NativeMessageTypes.STOP_SCREEN_CAPTURE,
                requestId: this.voice.screenCaptureRequestId,
            });
        }
        const stream = this.voice.localScreenStream;
        if (stream) {
            for (const track of stream.getTracks()) {
                try { track.stop(); } catch (e) {}
            }
        }
        this.voice.localScreenStream = null;
        this.voice.screenSharing = false;
        this.resetNativeScreenCaptureState();
        this.detachLocalScreenPreview();
        for (const [peer, entry] of this.voice.peerConnections.entries()) {
            if (entry.screenSender) {
                try { entry.pc.removeTrack(entry.screenSender); } catch (e) {}
                entry.screenSender = null;
                this.sendScreenShareMeta(peer, 'stop');
            }
        }
        this.voiceTrace('screen-share-stop', {});
        this.renegotiateAllVoicePeers();
        this.renderVoicePanel();
    }

    // --- Android-only screen capture path (MediaProjection → <canvas> →
    // canvas.captureStream()). See CLAUDE.md / project_mobile_parity_effort
    // memory: Android WebView has no getDisplayMedia() at the engine level, so
    // native captures frames and this repaints them onto an offscreen canvas;
    // the resulting MediaStreamTrack then flows through the exact same
    // attach/renegotiate/sendScreenShareMeta code the browser path uses above.

    resetNativeScreenCaptureState() {
        this.voice.screenCaptureFromNative = false;
        this.voice.screenCaptureRequestId = '';
        this.voice.screenCaptureCanvas = null;
        this.voice.screenCaptureCtx = null;
        this.voice.screenShareRequestInFlight = false;
    }

    startNativeScreenCapture() {
        this.voice.screenShareRequestInFlight = true;
        const requestId = this.newRequestId();
        this.voice.screenCaptureRequestId = requestId;
        const canvas = document.createElement('canvas');
        this.voice.screenCaptureCanvas = canvas;
        this.voice.screenCaptureCtx = canvas.getContext('2d');
        const sent = this.postNativeMessage({ type: NativeMessageTypes.START_SCREEN_CAPTURE, requestId });
        if (!sent) {
            this.resetNativeScreenCaptureState();
            this.addLogEntry({ type: 'WARN', msg: 'Не удалось начать демонстрацию экрана', ts: new Date().toLocaleTimeString() });
        }
    }

    // Fires once per captured frame (~8fps) while native MediaProjection
    // capture is active. First frame sizes the canvas and turns it into a
    // real MediaStreamTrack via captureStream(); later frames just repaint.
    async onNativeScreenCaptureFrame(payload = {}) {
        const { requestId, dataUrl } = payload;
        if (!requestId || requestId !== this.voice.screenCaptureRequestId || !dataUrl) return;
        const canvas = this.voice.screenCaptureCanvas;
        const ctx = this.voice.screenCaptureCtx;
        if (!canvas || !ctx) return;

        let bitmap;
        try {
            const blob = await (await fetch(dataUrl)).blob();
            bitmap = await createImageBitmap(blob);
        } catch (error) {
            return;
        }
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
        }
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close?.();

        if (!this.voice.screenSharing) {
            await this.beginNativeScreenCaptureStream();
        }
    }

    async beginNativeScreenCaptureStream() {
        const canvas = this.voice.screenCaptureCanvas;
        if (!canvas) return;
        const stream = canvas.captureStream(8);
        const track = stream.getVideoTracks()[0];
        if (!track) return;
        this.voice.localScreenStream = stream;
        this.voice.screenSharing = true;
        this.voice.screenCaptureFromNative = true;
        this.voice.screenShareRequestInFlight = false;
        // Native-originated stream has no browser "Stop sharing" control, but
        // the track still ends if the underlying canvas stream is torn down.
        track.addEventListener('ended', () => this.stopScreenShare());
        this.attachLocalScreenPreview();
        this.voiceTrace('screen-share-start', { streamId: stream.id, label: 'native-capture' });
        for (const peer of this.voice.peerConnections.keys()) {
            this.attachLocalScreenTrackToPeer(peer);
        }
        await this.renegotiateAllVoicePeers();
        for (const peer of this.voice.peerConnections.keys()) {
            if (this.voice.peerConnections.get(peer)?.screenSender) {
                this.sendScreenShareMeta(peer, 'start');
            }
        }
        this.renderVoicePanel();
    }

    onNativeScreenCaptureError(payload = {}) {
        const { requestId, message } = payload;
        if (requestId && requestId !== this.voice.screenCaptureRequestId) return;
        this.resetNativeScreenCaptureState();
        // Native sends no `message` when the user just declined the system
        // screen-capture consent dialog — matches the browser path's silent
        // handling of getDisplayMedia()'s NotAllowedError/AbortError. A
        // non-empty message means a real failure worth surfacing.
        if (message) {
            this.addLogEntry({ type: 'WARN', msg: message, ts: new Date().toLocaleTimeString() });
        }
        this.voiceTrace('screen-share-failed', { error: message || 'native-capture-cancelled' }, 'WARN');
    }

    // Never awaits a raw ctx.resume(). Callers run this on the critical path of
    // starting, accepting and joining a call, and in WebKit a refused resume() is a
    // promise that never settles (see resumeVoiceAudioContext) — so `await ctx.resume()`
    // here did not merely fail to unlock audio, it stopped call setup dead: no
    // voice_call_invite, no voice_call_accept, no mic, no offer. What the user sees is
    // a call that is "in the room" and silent forever, and in acceptIncomingCall the
    // callSetupInFlight latch is never released either, so every later attempt to
    // answer is dropped as "busy" until the app is restarted. That is exactly what the
    // server log shows for the last sessions: voice_join and not a single voice_signal.
    //
    // Audio unlocking is best-effort by nature (it only ever succeeds when the browser
    // feels the call is user-initiated), so it must never be able to block the call.
    async unlockVoicePlayback() {
        if (this.voice.playbackUnlocked) return true;
        try {
            // Goes through ensureVoiceAudioContext rather than constructing the context
            // inline, so the state-change watcher that re-routes remote audio when the
            // context stalls is always installed.
            const ctx = this.ensureVoiceAudioContext();
            let resumed = true;
            if (ctx && ctx.state === 'suspended') {
                resumed = await this.resumeVoiceAudioContext(ctx);
            }
            // 'Unlocked' means "we spent our user-gesture credit here", not "the
            // context is running" — retrying on every later call would re-enter the
            // same deadline wait. The meter loop keeps retrying the resume in the
            // background, and syncRemoteAudioPlaybackMode routes remote audio through
            // the plain <audio> elements for as long as the graph is not running.
            this.voice.playbackUnlocked = true;
            this.ensureVoiceMeterLoop();
            this.syncRemoteAudioPlaybackMode();
            this.voiceTrace('audio-unlock', {
                contextState: this.voice.audioContext?.state || 'none',
                resumed,
            }, resumed ? 'SUCCESS' : 'WARN');
            return resumed;
        } catch (error) {
            this.voiceTrace('audio-unlock-failed', { error: error?.message || String(error) }, 'WARN');
            return false;
        }
    }

    getVoicePeerEntry(peer) {
        const name = String(peer || '').trim();
        if (!name) return null;
        let entry = this.voice.peerConnections.get(name);
        if (!entry) {
            this.voiceTrace('peer-create', {
                peer: name,
                roomId: this.voice.roomId || '',
                roomType: this.voice.roomType || '',
                supported: this.voice.supported,
            });
            entry = {
                pc: new RTCPeerConnection(this.getVoiceRtcConfig()),
                localTracksAttached: false,
                offerSent: false,
                pendingIceCandidates: [],
                statsTimer: null,
                healthTimer: null,
                answerWatchdog: null,
                answerRetries: 0,
                audioSender: null,
                videoSender: null,
                screenSender: null,
                remoteScreenStreamId: null,
                negotiating: false,
                renegotiationPending: false,
                generatedIceCandidates: 0,
                receivedIceCandidates: 0,
                // Sticky "this link's ICE transport is dead". Set the moment the
                // connection reports disconnected/failed, cleared only when it is
                // genuinely connected again. Every offer built while it is set
                // carries iceRestart — see createVoiceOfferFor.
                needsIceRestart: false,
                // Budget and spacing for the level-triggered supervisor below.
                linkRecoveryAttempts: 0,
                linkRecoverySkipTicks: 0,
            };
            const rtcConfig = entry.pc.getConfiguration?.() || this.getVoiceRtcConfig();
            this.voiceTrace('rtc-config', {
                peer: name,
                policy: rtcConfig.iceTransportPolicy || 'all',
                servers: (rtcConfig.iceServers || []).map(server => ({
                    urls: server.urls,
                    username: server.username ? 'set' : '',
                })),
            });
            this.ensureVoicePeerStatsTimer(name, entry, 5000);
            entry.pc.onicecandidate = (event) => {
                if (event.candidate) {
                    entry.generatedIceCandidates = (entry.generatedIceCandidates || 0) + 1;
                    // Which candidate *types* we managed to gather is the one fact that
                    // separates "TURN is unreachable/misconfigured" from "TURN is fine
                    // and the pairing failed" — no relay candidate here means the call
                    // can only ever work between NAT-friendly peers.
                    (entry.gatheredCandidateTypes || (entry.gatheredCandidateTypes = new Set()))
                        .add(this.describeIceCandidate(event.candidate.candidate).type || '?');
                    this.voiceTrace('ice-candidate', {
                        peer: name,
                        index: entry.generatedIceCandidates,
                        mid: event.candidate.sdpMid,
                        line: event.candidate.sdpMLineIndex,
                        protocol: this.describeIceCandidate(event.candidate.candidate).protocol,
                        candidateType: this.describeIceCandidate(event.candidate.candidate).type,
                        address: this.describeIceCandidate(event.candidate.candidate).address,
                    });
                    // ICE candidates arrive in bursts (dozens within a second); a full
                    // panel re-render per candidate is wasted work — coalesce them.
                    this.scheduleRenderVoicePanel();
                } else {
                    this.voiceDiag('ice-candidate-end', {
                        peer: name,
                        count: entry.generatedIceCandidates || 0,
                        types: entry.gatheredCandidateTypes ? Array.from(entry.gatheredCandidateTypes).join('/') : 'none',
                        state: entry.pc.iceGatheringState,
                    }, entry.gatheredCandidateTypes?.has('relay') ? 'INFO' : 'WARN');
                }
                if (!event.candidate || !this.voice.roomId) return;
                this.sendVoiceEvent({
                    type: 'voice_signal',
                    roomId: this.voice.roomId,
                    roomType: this.voice.roomType,
                    serverId: this.voice.serverId,
                    channelId: this.voice.channelId,
                    to: name,
                    signal: {
                        type: 'ice',
                        candidate: {
                            candidate: event.candidate.candidate,
                            sdpMid: event.candidate.sdpMid,
                            sdpMLineIndex: event.candidate.sdpMLineIndex,
                            usernameFragment: event.candidate.usernameFragment || null,
                        },
                    },
                });
            };
            entry.pc.onicecandidateerror = (event) => {
                // 401/403 from the TURN server, an unresolvable host, or a blocked port
                // all surface only here — and only as a warning nobody sees.
                this.voiceDiag('ice-candidate-error', {
                    peer: name,
                    errorCode: event?.errorCode || '',
                    errorText: event?.errorText || '',
                    url: event?.url || '',
                    roomId: this.voice.roomId || '',
                }, 'WARN');
            };
            entry.pc.onicegatheringstatechange = () => {
                this.voiceTrace('ice-gathering', { peer: name, state: entry.pc.iceGatheringState, roomId: this.voice.roomId || '' });
            };
            entry.pc.oniceconnectionstatechange = () => {
                this.voiceTrace('ice-connection', { peer: name, state: entry.pc.iceConnectionState, roomId: this.voice.roomId || '' });
            };
            entry.pc.onsignalingstatechange = () => {
                this.voiceTrace('signaling-state', { peer: name, state: entry.pc.signalingState, roomId: this.voice.roomId || '' });
                if (entry.pc.signalingState === 'stable' && entry.renegotiationPending && !entry.negotiating) {
                    entry.renegotiationPending = false;
                    this.renegotiateVoicePeer(name).catch(() => {});
                }
            };
            entry.pc.ontrack = (event) => {
                const stream = event.streams?.[0] || new MediaStream([event.track]);
                const track = event.track;
                // A remote camera/screen toggle-off doesn't remove the track from the
                // stream (browsers keep the transceiver, just mute it) — so the old
                // code (trace-only) left the last frame frozen on screen forever, and
                // a later toggle-on reused the same stream/track objects, which
                // attachRemoteVideoStream's reference-equality check then skipped as
                // "already attached", so the picture never resumed either. Route these
                // lifecycle events back through the same attach/detach helpers so the
                // element actually reflects live track state.
                const refreshRemoteVideoTrack = () => {
                    const isScreen = !!(entry.remoteScreenStreamId && stream.id === entry.remoteScreenStreamId);
                    if (isScreen) {
                        this.attachRemoteScreenStream(name, stream);
                    } else {
                        this.attachRemoteVideoStream(name, stream);
                    }
                };
                if (track) {
                    track.onunmute = () => {
                        this.voiceTrace('remote-track-unmute', { peer: name, kind: track.kind, readyState: track.readyState }, 'INFO');
                        if (track.kind === 'video') refreshRemoteVideoTrack();
                    };
                    track.onmute = () => {
                        this.voiceTrace('remote-track-mute', { peer: name, kind: track.kind, readyState: track.readyState }, 'WARN');
                        if (track.kind === 'video') refreshRemoteVideoTrack();
                    };
                    track.onended = () => {
                        this.voiceTrace('remote-track-ended', { peer: name, kind: track.kind, readyState: track.readyState }, 'WARN');
                        if (track.kind === 'video') refreshRemoteVideoTrack();
                    };
                }
                this.voiceTrace('remote-track', {
                    peer: name,
                    kind: event.track?.kind || 'unknown',
                    readyState: event.track?.readyState || '',
                    streamId: stream.id || '',
                    transceiverDirection: event.transceiver?.direction || '',
                    transceiverCurrentDirection: event.transceiver?.currentDirection || '',
                    receiverTrack: event.receiver?.track ? `${event.receiver.track.kind}:${event.receiver.track.readyState}:${event.receiver.track.enabled ? 'on' : 'off'}` : '',
                    tracks: stream.getTracks().map(t => `${t.kind}:${t.readyState}:${t.enabled ? 'on' : 'off'}`),
                });
                if (track && track.kind === 'video' && entry.remoteScreenStreamId && stream.id === entry.remoteScreenStreamId) {
                    this.attachRemoteScreenStream(name, stream);
                } else {
                    this.attachRemoteVoiceStream(name, stream);
                }
            };
            entry.pc.onconnectionstatechange = () => {
                const state = entry.pc.connectionState;
                if (entry.lastConnectionState !== state) {
                    this.voiceDiag('pc-state', {
                        peer: name,
                        from: entry.lastConnectionState || '',
                        to: state,
                        ice: entry.pc.iceConnectionState || '',
                        gathering: entry.pc.iceGatheringState || '',
                        localCand: entry.gatheredCandidateTypes ? Array.from(entry.gatheredCandidateTypes).join('/') : '',
                        remoteCand: entry.receivedIceCandidates || 0,
                    }, state === 'failed' ? 'ERROR' : 'INFO');
                    entry.lastConnectionState = state;
                }
                if (state === 'connected' || state === 'completed') {
                    // The link is genuinely carrying traffic again, so the next
                    // offer on it can be an ordinary one.
                    entry.needsIceRestart = false;
                    entry.linkRecoveryAttempts = 0;
                    entry.linkRecoverySkipTicks = 0;
                    entry.linkRecoveryExhausted = false;
                    if (entry.reconnectTimer) {
                        clearTimeout(entry.reconnectTimer);
                        entry.reconnectTimer = null;
                    }
                    if (entry.healthTimer) {
                        clearTimeout(entry.healthTimer);
                        entry.healthTimer = null;
                    }
                    // Re-armed unconditionally, NOT `if (!entry.statsTimer)`. The
                    // entry is created with a 5 s sampler that nothing on the healthy
                    // path ever cleared, so that guard was always false here and the
                    // health sampler was only ever installed on a link that had
                    // already failed once (statsTimer is cleared in the failed/
                    // disconnected branch below). Which is to say: the always-on
                    // "does RTP flow and can the sink play it" telemetry — written
                    // precisely for calls that look connected and carry no audio —
                    // never ran on the calls it was for, and neither did the sink
                    // self-heal it drives.
                    this.ensureVoicePeerStatsTimer(name, entry, 10000);
                    void this.reportVoiceSelectedPair(name);
                    this.voice.status = 'connected';
                    if (this.voice.callTrack && !this.voice.callTrack.connectedAt) {
                        this.voice.callTrack.connectedAt = Date.now();
                        this.voice.callTrack.outcome = 'connected';
                    }
                    this.renderVoicePanel();
                    return;
                }
                if (state === 'connecting' || state === 'checking') {
                    if (entry.reconnectTimer) {
                        clearTimeout(entry.reconnectTimer);
                        entry.reconnectTimer = null;
                    }
                    if (entry.healthTimer) {
                        clearTimeout(entry.healthTimer);
                        entry.healthTimer = null;
                    }
                    if (this.voice.status !== 'connected') {
                        this.voice.status = 'connecting';
                        this.renderVoicePanel();
                    }
                    const isDmCall = this.voice.roomType === 'dm';
                    const shouldWatchHealth = isDmCall;
                    if (shouldWatchHealth && !entry.healthTimer) {
                        entry.healthTimer = setTimeout(async () => {
                            entry.healthTimer = null;
                            const currentState = entry.pc?.connectionState || '';
                            const currentIce = entry.pc?.iceConnectionState || '';
                            const stats = entry.lastStats || {};
                            const hasTraffic = Number(stats.inBytes || 0) > 0 || Number(stats.outBytes || 0) > 0;
                            if (!this.voice.roomId) return;
                            if (['connected', 'completed'].includes(currentState)) return;
                            if (hasTraffic) return;
                            if (!['new', 'checking', 'connecting'].includes(currentState) && !['new', 'checking'].includes(currentIce)) return;
                            this.voiceDiag('health-restart', {
                                peer: name,
                                roomId: this.voice.roomId || '',
                                state: currentState,
                                ice: currentIce,
                                hasTraffic,
                            }, 'WARN');
                            try {
                                await this.restartVoicePeer(name);
                            } catch (error) {
                                this.addLogEntry({
                                    type: 'WARN',
                                    msg: error?.message || `Не удалось выполнить ICE restart для ${name}`,
                                    ts: new Date().toLocaleTimeString(),
                                });
                            }
                        }, 8000);
                    }
                    return;
                }
                if (state === 'disconnected' || state === 'failed') {
                    this.addLogEntry({ type: 'WARN', msg: `Voice peer ${name} connection ${state}`, ts: new Date().toLocaleTimeString() });
                    // From here on this link can only be revived by an ICE restart,
                    // and this is the LAST event it will ever emit unless something
                    // succeeds — so hand it to the supervisor rather than relying on
                    // the single reconnect timer armed below.
                    entry.needsIceRestart = true;
                    this.ensureVoiceLinkSupervisor();
                    if (entry.reconnectTimer) {
                        clearTimeout(entry.reconnectTimer);
                    }
                    if (entry.healthTimer) {
                        clearTimeout(entry.healthTimer);
                        entry.healthTimer = null;
                    }
                    // Slowed, not stopped. Clearing it outright meant that during
                    // the ~8 minutes the supervisor spends trying to revive a link
                    // there was no health telemetry at all — precisely the window
                    // where "did RTP ever come back" is the question being asked.
                    this.ensureVoicePeerStatsTimer(name, entry, 20000);
                    const isDmCall = this.voice.roomType === 'dm';
                    const allowAutoRestart = true;
                    if (allowAutoRestart) {
                        // Both ends of the pair see the same failure and both used to
                        // fire an ICE restart at the same moment — permanent glare on
                        // exactly the link that was already broken. The side that owns
                        // the offer for this pair (deterministic, both agree) retries
                        // first; the other only steps in later, if that didn't take.
                        const stagger = this.shouldInitiateVoiceOffer(name) ? 0 : 5000;
                        const delay = (state === 'failed' ? 8000 : 10000) + stagger;
                        entry.reconnectTimer = setTimeout(async () => {
                            entry.reconnectTimer = null;
                            if (!this.voice.roomId) return;
                            if (!['disconnected', 'failed'].includes(entry.pc.connectionState)) return;
                            try {
                                await this.restartVoicePeer(name);
                            } catch (error) {
                                this.addLogEntry({ type: 'WARN', msg: error?.message || `Не удалось восстановить голосовую связь с ${name}`, ts: new Date().toLocaleTimeString() });
                            }
                        }, delay);
                    }
                    if (!isDmCall && this.voice.status !== 'connected') {
                        this.voice.status = 'connecting';
                        this.renderVoicePanel();
                    }
                }
            };
            this.voice.peerConnections.set(name, entry);
        }
        return entry;
    }

    // Single owner of the per-peer sampling timer. Every call site used to install
    // its own interval and guess whether one was already running, which is how the
    // health sampler ended up unreachable on a healthy call. Idempotent for the same
    // cadence, so calling it from a state handler that fires repeatedly is free.
    ensureVoicePeerStatsTimer(peer, entry, intervalMs) {
        if (!entry) return;
        if (entry.statsTimer && entry.statsIntervalMs === intervalMs) return;
        if (entry.statsTimer) clearInterval(entry.statsTimer);
        entry.statsIntervalMs = intervalMs;
        entry.statsTimer = setInterval(() => {
            void this.sampleVoicePeerStats(peer);
            void this.reportVoiceAudioHealth(peer);
        }, intervalMs);
    }

    async flushPendingVoiceIceCandidates(entry, peer) {
        if (!entry || !entry.pendingIceCandidates?.length) return;
        const pending = entry.pendingIceCandidates.splice(0, entry.pendingIceCandidates.length);
        this.voiceTrace('ice-flush', { peer, count: pending.length, roomId: this.voice.roomId || '' });
        for (const candidate of pending) {
            try {
                await entry.pc.addIceCandidate(candidate);
            } catch (e) {
                console.warn(`Failed to flush ICE candidate for ${peer}`, e);
            }
        }
    }

    async sampleVoicePeerStats(peer) {
        const name = String(peer || '').trim();
        if (!name) return;
        const entry = this.voice.peerConnections.get(name);
        if (!entry?.pc) return;
        try {
            const stats = await entry.pc.getStats();
            const summary = {
                peer: name,
                connection: entry.pc.connectionState,
                ice: entry.pc.iceConnectionState,
                signaling: entry.pc.signalingState,
                localCandidateCount: entry.generatedIceCandidates || 0,
                remoteCandidateCount: entry.receivedIceCandidates || 0,
            };
            // The per-candidate map below is only ever read by the trace line, and
            // building it means one object plus one summary key for EVERY candidate
            // the connection knows — on a mesh call that is a few hundred short-lived
            // objects per peer per sampling tick, all of it thrown away when the dev
            // trace toggle is off, which it is by default. The compact half of this
            // summary is what the health timer and the call summary read, so that
            // part is always built.
            const verbose = !!this.voiceTraceEnabled;
            const candidatesById = {};
            stats.forEach(report => {
                if (report.type === 'outbound-rtp' && report.kind === 'audio') {
                    summary.outBytes = report.bytesSent;
                    summary.outPackets = report.packetsSent;
                    summary.outAudioLevel = report.audioLevel;
                    summary.outHeaderBytes = report.headerBytesSent;
                }
                if (report.type === 'inbound-rtp' && report.kind === 'audio') {
                    summary.inBytes = report.bytesReceived;
                    summary.inPackets = report.packetsReceived;
                    summary.inAudioLevel = report.audioLevel;
                    summary.inJitter = report.jitter;
                    summary.inHeaderBytes = report.headerBytesReceived;
                }
                if (report.type === 'track' && report.kind === 'audio') {
                    summary.trackAudioLevel = report.audioLevel;
                    summary.trackMuted = report.muted;
                    summary.trackEnded = report.ended;
                }
                if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated) {
                    summary.candidatePair = {
                        local: report.localCandidateId || '',
                        remote: report.remoteCandidateId || '',
                        currentRoundTripTime: report.currentRoundTripTime,
                        availableOutgoingBitrate: report.availableOutgoingBitrate,
                        bytesSent: report.bytesSent,
                        bytesReceived: report.bytesReceived,
                    };
                }
                if (report.type === 'local-candidate' || report.type === 'remote-candidate') {
                    const candidate = {
                        candidateType: report.candidateType,
                        ip: report.ip || report.address,
                        port: report.port,
                        protocol: report.protocol,
                        priority: report.priority,
                    };
                    // Kept either way: the selected pair is labelled from this map,
                    // and "host/udp vs relay/tcp" is the first thing anyone asks of a
                    // bad call. The flat per-candidate summary keys next to it are
                    // pure trace fodder and cost one more key each.
                    candidatesById[report.id] = candidate;
                    if (verbose) {
                        summary[`${report.type.replace('-', '')}_${report.id || 'unknown'}`] = candidate;
                    }
                }
            });
            if (summary.candidatePair) {
                const local = candidatesById[summary.candidatePair.local];
                const remote = candidatesById[summary.candidatePair.remote];
                summary.candidatePair.localLabel = local ? `${local.candidateType}/${local.protocol}/${local.ip || ''}:${local.port || ''}` : summary.candidatePair.local;
                summary.candidatePair.remoteLabel = remote ? `${remote.candidateType}/${remote.protocol}/${remote.ip || ''}:${remote.port || ''}` : summary.candidatePair.remote;
            }
            entry.lastStats = summary;
            entry.lastStatsAt = Date.now();
            this.voiceTrace('rtc-stats', summary);
        } catch (error) {
            this.voiceTrace('rtc-stats-error', { peer: name, error: error?.message || String(error) }, 'WARN');
        }
    }

    // WebKit (WKWebView — the macOS client, and every browser on iOS) does not
    // reject AudioContext.resume() when it refuses: it returns a promise that is
    // NEVER settled. Measured directly in a bare WKWebView: `new AudioContext()` →
    // state 'suspended', `resume()` still pending after 45 s, no rejection, no
    // state change. Every await of it therefore hangs its caller forever, and every
    // `.then()` chain that clears a latch leaves the latch stuck.
    //
    // resumeVoiceAudioContext returns a promise that ALWAYS settles: the real
    // resume if it ever lands, `false` once the deadline passes. Nothing on the
    // call-setup path may await the raw resume().
    resumeVoiceAudioContext(ctx, timeoutMs = 1500) {
        if (!ctx || typeof ctx.resume !== 'function') return Promise.resolve(false);
        let settled = false;
        return new Promise(resolve => {
            const finish = (value) => {
                if (settled) return;
                settled = true;
                resolve(value);
            };
            const timer = setTimeout(() => {
                this.voiceTrace('audio-context-resume-timeout', {
                    state: ctx.state || '',
                    timeoutMs,
                }, 'WARN');
                finish(false);
            }, timeoutMs);
            Promise.resolve(ctx.resume()).then(() => {
                clearTimeout(timer);
                finish(true);
            }).catch(error => {
                clearTimeout(timer);
                this.voiceTrace('audio-context-resume-failed', { error: error?.message || String(error) }, 'WARN');
                finish(false);
            });
        });
    }

    ensureVoiceAudioContext() {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return null;
        if (!this.voice.audioContext) {
            this.voice.audioContext = new AudioCtx();
            // Remote audio is rendered through this graph only (the <audio> elements
            // are muted so nothing is heard twice), so a context that is 'suspended'
            // — created outside a user gesture, or interrupted by the OS/WebView
            // mid-call — means a call that connects and carries RTP but plays nothing.
            this.voice.audioContext.onstatechange = () => {
                this.voiceTrace('audio-context-state', { state: this.voice.audioContext?.state || '' });
                this.syncRemoteAudioPlaybackMode();
            };
        }
        // Throttled with a pending flag: this helper runs on every meter tick (125 ms),
        // and firing a fresh resume() each time would pile up promises while the
        // context stays suspended. The flag is cleared by resumeVoiceAudioContext's
        // deadline even when WebKit never answers — otherwise one refused resume
        // latches it forever and no later user gesture is ever able to retry.
        const now = Date.now();
        if (this.voice.audioContext.state === 'suspended'
            && !this.voice.audioResumePending
            && now >= Number(this.voice.audioResumeNextAttemptAt || 0)) {
            this.voice.audioResumePending = true;
            this.resumeVoiceAudioContext(this.voice.audioContext).then(resumed => {
                this.voice.audioResumePending = false;
                // Each refused attempt abandons a promise WebKit will never settle, and
                // this runs on the 125 ms meter tick — back off so a context that stays
                // suspended for a whole call doesn't accumulate hundreds of them.
                this.voice.audioResumeNextAttemptAt = resumed ? 0 : Date.now() + 5000;
                this.syncRemoteAudioPlaybackMode();
            });
        }
        return this.voice.audioContext;
    }

    // Autoplay policy can refuse audio.play() outright, and when it does the element
    // simply stays paused: RTP arrives, the WebRTC layer reports a healthy connection,
    // and the call is silent with nothing in it to blame. Only a user gesture lifts
    // the refusal, and the call is not guaranteed to have started with one on this
    // device — a call answered from a notification, a page restored mid-call, or a
    // gesture credit already spent elsewhere all end up here. Nothing retried the
    // playback afterwards, so the silence lasted until the call was restarted.
    // Capture-phase listeners, dropped together with the call.
    ensureVoicePlaybackGestureHook() {
        if (this.voice.playbackGestureHook) return;
        if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
        const events = ['pointerdown', 'touchend', 'keydown', 'click'];
        const handler = () => {
            void this.unlockVoicePlayback();
            this.syncRemoteAudioPlaybackMode();
        };
        for (const type of events) {
            try { document.addEventListener(type, handler, true); } catch (e) {}
        }
        this.voice.playbackGestureHook = () => {
            for (const type of events) {
                try { document.removeEventListener(type, handler, true); } catch (e) {}
            }
        };
    }

    releaseVoicePlaybackGestureHook() {
        const release = this.voice.playbackGestureHook;
        this.voice.playbackGestureHook = null;
        if (typeof release === 'function') {
            try { release(); } catch (e) {}
        }
    }

    // Remote audio has exactly one sink: the per-peer <audio> element. This keeps it
    // unmuted, at the configured volume and actually playing. Called whenever
    // something could have disturbed it (a user gesture, an AudioContext state
    // change, a fresh attach, a health sample that found it paused) — autoplay policy
    // pauses these elements silently. The WebAudio graph drives the level meters
    // only; playback deliberately does not depend on it.
    syncRemoteAudioPlaybackMode() {
        for (const [peer, audio] of this.voice.remoteAudios) {
            if (!audio) continue;
            if ((audio.muted || audio.defaultMuted) && !this.voice.deafened) {
                this.voiceDiag('remote-audio-unmute', { peer }, 'WARN');
            }
            audio.muted = !!this.voice.deafened;
            audio.defaultMuted = false;
            audio.volume = this.effectiveRemoteVolume(peer);
            if (audio.paused) {
                audio.play?.().catch(error => this.voiceDiag('remote-audio-play-failed', {
                    peer, error: error?.message || String(error),
                }, 'WARN'));
            }
        }
    }

    ensureVoiceMeterLoop() {
        if (this.voice.meterRaf) return;
        const tick = async () => {
            if (!this.voice.roomId && !this.voice.localStream && this.voice.peerConnections.size === 0) {
                this.voice.meterRaf = 0;
                return;
            }
            if (document.hidden) {
                this.voice.meterRaf = setTimeout(tick, 1000);
                return;
            }
            try {
                await this.updateVoiceMeters();
            } catch (error) {
                this.voiceTrace('meter-update-error', { error: error?.message || String(error) }, 'WARN');
            }
            this.voice.meterRaf = setTimeout(tick, 125);
        };
        this.voice.meterRaf = setTimeout(tick, 0);
    }

    stopVoiceMeterLoop() {
        if (this.voice.meterRaf) {
            clearTimeout(this.voice.meterRaf);
            this.voice.meterRaf = 0;
        }
    }

    // `buffer` is the per-meter scratch array allocated once in ensureMeterEntry.
    // This used to allocate a fresh Uint8Array(512) on every call, and the loop runs
    // 8×/s for the local mic plus once per remote peer — a steady stream of
    // short-lived typed arrays whose only visible effect was GC pauses during calls.
    // The for-of over a typed array also allocated an iterator per call; an index
    // loop reads the same samples with no allocation at all.
    computeAnalyserLevel(analyser, buffer = null) {
        if (!analyser) return 0;
        const bufferLength = analyser.fftSize;
        const data = (buffer && buffer.length === bufferLength) ? buffer : new Uint8Array(bufferLength);
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < bufferLength; i++) {
            const normalized = (data[i] - 128) / 128;
            sum += normalized * normalized;
        }
        const rms = Math.sqrt(sum / bufferLength);
        return Math.max(0, Math.min(1, rms * 2.8));
    }

    ensureMeterEntry(key, stream) {
        const ctx = this.ensureVoiceAudioContext();
        if (!ctx || !stream) return null;
        if (key === 'local') {
            const currentId = stream.id || '';
            if (!this.voice.meterLocal || this.voice.meterLocal.streamId !== currentId) {
                try {
                    if (this.voice.meterLocal?.source) this.voice.meterLocal.source.disconnect?.();
                    if (this.voice.meterLocal?.analyser) this.voice.meterLocal.analyser.disconnect?.();
                } catch (e) {}
                const source = ctx.createMediaStreamSource(stream);
                const analyser = ctx.createAnalyser();
                analyser.fftSize = 512;
                analyser.smoothingTimeConstant = 0.8;
                source.connect(analyser);
                this.voice.meterLocal = {
                    streamId: currentId,
                    source,
                    analyser,
                    data: new Uint8Array(analyser.fftSize),
                };
                this.voiceTrace('meter-local-ready', { streamId: currentId, tracks: stream.getTracks().length });
            }
            return this.voice.meterLocal;
        }

        const peer = String(key || '').trim();
        if (!peer) return null;
        const currentId = stream.id || '';
        const existing = this.voice.meterRemote.get(peer);
        if (!existing || existing.streamId !== currentId) {
            try {
                if (existing?.source) existing.source.disconnect?.();
                if (existing?.analyser) existing.analyser.disconnect?.();
            } catch (e) {}
            const source = ctx.createMediaStreamSource(stream);
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 512;
            analyser.smoothingTimeConstant = 0.8;
            source.connect(analyser);
            const next = {
                streamId: currentId,
                source,
                analyser,
                data: new Uint8Array(analyser.fftSize),
            };
            this.voice.meterRemote.set(peer, next);
            this.voiceTrace('meter-remote-ready', { peer, streamId: currentId, tracks: stream.getTracks().length });
            return next;
        }
        return existing;
    }

    updateVoiceMeterDom(kind, percent) {
        const fill = document.getElementById(kind === 'local' ? 'voiceMicLevelFill' : 'voiceServerLevelFill');
        const text = document.getElementById(kind === 'local' ? 'voiceMicLevelText' : 'voiceServerLevelText');
        const row = document.getElementById(kind === 'local' ? 'voiceMicMeter' : 'voiceServerMeter');
        const next = Math.max(0, Math.min(100, Math.round(percent || 0)));
        if (fill) {
            fill.style.width = `${next}%`;
        }
        if (text) {
            text.textContent = `${next}%`;
        }
        if (row) {
            row.dataset.level = String(next);
        }
    }

    async updateVoiceMeters() {
        const localMeter = this.voice.localStream ? this.ensureMeterEntry('local', this.voice.localStream) : null;
        const remoteStreams = [];
        for (const [peer, audio] of this.voice.remoteAudios.entries()) {
            const stream = audio?.srcObject;
            if (stream instanceof MediaStream) {
                remoteStreams.push({ peer, stream });
            }
        }
        const remoteMeters = remoteStreams
            .map(({ peer, stream }) => ({ peer, meter: this.ensureMeterEntry(peer, stream) }))
            .filter(item => item.meter);

        let localLevel = 0;
        if (localMeter?.analyser) {
            localLevel = this.computeAnalyserLevel(localMeter.analyser, localMeter.data);
        }

        let remoteLevel = 0;
        // Per-peer levels feed the tiles' speaking ring; the aggregate max still
        // feeds the single "с сервера" meter below them.
        const tileLevels = {};
        for (const item of remoteMeters) {
            const level = this.computeAnalyserLevel(item.meter.analyser, item.meter.data);
            remoteLevel = Math.max(remoteLevel, level);
            tileLevels[String(item.peer || '').trim().toLowerCase()] = Math.round(level * 100);
        }

        const nextLocal = Math.round(localLevel * 100);
        const nextRemote = Math.round(remoteLevel * 100);
        // A muted mic still produces analyser output on some platforms (the track
        // is disabled downstream), so never light our own ring while muted.
        tileLevels[String(this.myName() || '').trim().toLowerCase()] = this.voice.muted ? 0 : nextLocal;
        this.applyVoiceSpeakingState(tileLevels);
        const changed = nextLocal !== this.voice.meterLevels.local || nextRemote !== this.voice.meterLevels.remote;
        this.voice.meterLevels = { local: nextLocal, remote: nextRemote };
        if (changed || !this.voice.meterUiRenderedOnce) {
            this.updateVoiceMeterDom('local', nextLocal);
            this.updateVoiceMeterDom('remote', nextRemote);
            this.voice.meterUiRenderedOnce = true;
        }
    }

    // 512 kbit/s was not a limit, it was a decoration: Opus voice runs at 24–32
    // kbit/s and would never have reached it. 64 kbit/s is still twice what the
    // encoder asks for — no quality is given up — while actually bounding a runaway
    // encoder, which matters because in a mesh this is paid once PER PEER.
    async applyVoiceAudioBitrateLimit(sender) {
        if (!sender) return;
        try {
            const params = sender.getParameters();
            if (!params.encodings || !params.encodings.length) params.encodings = [{}];
            params.encodings[0].maxBitrate = 64000;
            await sender.setParameters(params);
        } catch (error) {
            this.voiceTrace('audio-bitrate-limit-failed', { error: error?.message || String(error) }, 'WARN');
        }
    }

    // Mesh means every video track is encoded and uploaded once per peer, and
    // nothing capped that at all: five people with cameras on asked each machine for
    // four unconstrained 720p encodes, i.e. 4–10 Mbit/s upstream. The browser's own
    // congestion control reacts to loss, which on an already-saturated uplink means
    // it reacts after the audio has started breaking up — and audio is the one thing
    // a call cannot lose. So the budget is fixed here and divided by the roster.
    //
    // degradationPreference is the other half: with a hard cap, something has to
    // give. Camera gives up resolution and keeps motion smooth; a shared screen is
    // mostly still and unreadable when downscaled, so it gives up frame rate instead.
    voiceVideoBudget(kind = 'camera') {
        const peers = Math.max(1, this.voice.peerConnections.size || 1);
        const total = kind === 'screen' ? 3000000 : 2500000;
        const ceiling = kind === 'screen' ? 2000000 : 1200000;
        const floor = kind === 'screen' ? 250000 : 150000;
        return Math.max(floor, Math.min(ceiling, Math.floor(total / peers)));
    }

    async applyVoiceVideoBitrateLimit(sender, kind = 'camera') {
        if (!sender) return;
        try {
            const params = sender.getParameters();
            if (!params.encodings || !params.encodings.length) params.encodings = [{}];
            const maxBitrate = this.voiceVideoBudget(kind);
            params.encodings[0].maxBitrate = maxBitrate;
            params.degradationPreference = kind === 'screen' ? 'maintain-resolution' : 'balanced';
            await sender.setParameters(params);
            this.voiceTrace('video-bitrate-limit', { kind, maxBitrate, peers: this.voice.peerConnections.size });
        } catch (error) {
            this.voiceTrace('video-bitrate-limit-failed', { kind, error: error?.message || String(error) }, 'WARN');
        }
    }

    // Re-divides the budget when the roster changes. A limit computed for a
    // two-person call is four times too generous once four more people join, and the
    // senders were created long before that happened.
    async refreshVoiceSenderLimits() {
        for (const entry of this.voice.peerConnections.values()) {
            if (entry.videoSender) await this.applyVoiceVideoBitrateLimit(entry.videoSender, 'camera');
            if (entry.screenSender) await this.applyVoiceVideoBitrateLimit(entry.screenSender, 'screen');
        }
    }

    // Returns true when tracks were actually added on this call, so callers can tell
    // "already attached" from "just attached" — an attach that happens after the
    // connection is established needs a renegotiation or the peer never receives it.
    async attachLocalVoiceTracks(peer) {
        const entry = this.getVoicePeerEntry(peer);
        if (!entry || !this.voice.localStream || entry.localTracksAttached) return false;
        const tracks = this.voice.localStream.getTracks();
        this.voiceTrace('attach-local-tracks', { peer, tracks: tracks.length, roomId: this.voice.roomId || '' });
        // The latch is taken, and every addTrack is done, BEFORE the first await —
        // the same discipline `entry.negotiating` needs, and for the same reason.
        // This used to set the flag only after awaiting the bitrate limit, so two
        // overlapping passes (they overlap on every call: voice_call_accepted and
        // voice_call_connected arrive back to back and are dispatched
        // fire-and-forget, and a mic that resolves late releases several waiters at
        // once) both walked past the guard and added the same track twice. A real
        // browser throws InvalidAccessError on the second one — and syncVoicePeers
        // does not guard this call, so the whole pass is abandoned: any peer after
        // this one gets no offer, and the late-track renegotiation never happens.
        entry.localTracksAttached = true;
        const added = [];
        try {
            for (const track of tracks) {
                const senderField = track.kind === 'video' ? 'videoSender' : 'audioSender';
                const sender = entry.pc.addTrack(track, this.voice.localStream);
                entry[senderField] = sender;
                added.push({ track, sender });
            }
        } catch (error) {
            // Nothing was added, so nothing can be double-added by a retry: release
            // the latch. A partial attach keeps it, since re-running would duplicate
            // whatever did land.
            if (!added.length) entry.localTracksAttached = false;
            this.voiceDiag('attach-local-tracks-failed', {
                peer,
                added: added.length,
                error: error?.message || String(error),
                name: error?.name || '',
            }, 'ERROR');
            throw error;
        }
        for (const { track, sender } of added) {
            if (track.kind === 'audio') {
                await this.applyVoiceAudioBitrateLimit(sender);
            } else if (track.kind === 'video') {
                await this.applyVoiceVideoBitrateLimit(sender, 'camera');
            }
            this.voiceTrace('attach-local-track-added', {
                peer,
                track: `${track.kind}:${track.readyState}:${track.enabled ? 'on' : 'off'}`,
                senderTrack: sender?.track ? `${sender.track.kind}:${sender.track.readyState}:${sender.track.enabled ? 'on' : 'off'}` : 'none',
            });
        }
        this.ensureMeterEntry('local', this.voice.localStream);
        this.ensureVoiceMeterLoop();
        return true;
    }

    attachRemoteVoiceStream(peer, stream) {
        const name = String(peer || '').trim();
        if (!name || !stream) return;
        let audio = this.voice.remoteAudios.get(name);
        if (!audio) {
            audio = document.createElement('audio');
            audio.autoplay = true;
            audio.playsInline = true;
            audio.hidden = true;
            audio.preload = 'auto';
            // The element is the PRIMARY sink, not a muted decoy. Remote audio used
            // to be rendered only by the WebAudio graph, and the fallback to the
            // element fired only when the context was not 'running' — so a graph that
            // is running but produces no sound had no fallback and no detection at
            // all. That is a single point of failure for the one thing a call is for.
            // Metering still runs on the graph; playback no longer depends on it.
            audio.muted = !!this.voice.deafened;
            audio.defaultMuted = false;
            audio.volume = this.effectiveRemoteVolume(name);
            audio.dataset.peer = name;
            audio.addEventListener('play', () => this.voiceTrace('remote-audio-play', { peer: name, muted: audio.muted, volume: audio.volume }, 'INFO'));
            audio.addEventListener('playing', () => this.voiceTrace('remote-audio-playing', { peer: name, muted: audio.muted, volume: audio.volume }, 'SUCCESS'));
            audio.addEventListener('pause', () => this.voiceTrace('remote-audio-pause', { peer: name }, 'WARN'));
            audio.addEventListener('ended', () => this.voiceTrace('remote-audio-ended', { peer: name }, 'WARN'));
            audio.addEventListener('error', () => this.voiceTrace('remote-audio-error', { peer: name, error: audio.error?.message || audio.error?.code || 'unknown' }, 'ERROR'));
            document.body.appendChild(audio);
            this.voice.remoteAudios.set(name, audio);
        }
        audio.srcObject = stream;
        this.ensureMeterEntry(name, stream);
        if (this.audioPrefs?.speakerDeviceId && typeof audio.setSinkId === 'function') {
            audio.setSinkId(this.audioPrefs.speakerDeviceId).catch(error => {
                this.voiceTrace?.('speaker-sink-failed', { peer: name, error: error?.message || String(error) }, 'WARN');
            });
        }
        this.syncRemoteAudioPlaybackMode();
        this.ensureVoicePlaybackGestureHook();
        this.ensureVoiceMeterLoop();
        this.attachRemoteVideoStream(name, stream);
        this.voiceTrace('remote-audio-attach', {
            peer: name,
            streamId: stream.id || '',
            tracks: stream.getTracks().map(t => `${t.kind}:${t.readyState}:${t.enabled ? 'on' : 'off'}`),
            readyState: audio.readyState,
            paused: audio.paused,
            muted: audio.muted,
        });
        const attemptPlay = () => audio.play?.().catch(error => this.voiceTrace('remote-audio-play-failed', { peer: name, error: error?.message || String(error) }, 'WARN'));
        attemptPlay();
        requestAnimationFrame(() => attemptPlay());
        setTimeout(attemptPlay, 250);
    }

    attachRemoteVideoStream(peer, stream) {
        const name = String(peer || '').trim();
        if (!name || !stream) return;
        // A track being muted (peer toggled their camera off) doesn't remove it
        // from the stream — only readyState 'ended' or a genuinely absent track
        // does. Treating a muted-but-present track as "no video" is what makes
        // toggling the camera off actually clear the frozen frame instead of
        // just leaving the last rendered picture on screen forever.
        const hasVideo = stream.getVideoTracks().some(t => t.readyState === 'live' && !t.muted);
        let video = this.voice.remoteVideos.get(name);
        if (!hasVideo) {
            if (video) {
                try { video.pause?.(); video.srcObject = null; video.remove?.(); } catch (e) {}
                this.voice.remoteVideos.delete(name);
                this.scheduleRenderVoicePanel();
            }
            return;
        }
        if (!video) {
            video = document.createElement('video');
            video.autoplay = true;
            video.playsInline = true;
            video.muted = true;
            video.dataset.peer = name;
            this.voice.remoteVideos.set(name, video);
        }
        // Always (re)assign + play, even if this exact stream object was already
        // set as srcObject before: a camera turned back on reuses the same local
        // MediaStream/transceiver, so the object reference here is often
        // unchanged even though the track just came back to life — skipping the
        // reassignment on a reference-equality check is what left a re-enabled
        // camera showing nothing for the peer.
        video.srcObject = stream;
        video.play?.().catch(error => this.voiceTrace('remote-video-play-failed', { peer: name, error: error?.message || String(error) }, 'WARN'));
        this.scheduleRenderVoicePanel();
    }

    attachRemoteScreenStream(peer, stream) {
        const name = String(peer || '').trim();
        if (!name || !stream) return;
        let video = this.voice.remoteScreens.get(name);
        if (!video) {
            video = document.createElement('video');
            video.autoplay = true;
            video.playsInline = true;
            video.muted = true;
            video.dataset.peer = name;
            this.voice.remoteScreens.set(name, video);
        }
        if (video.srcObject !== stream) {
            video.srcObject = stream;
        }
        video.play?.().catch(error => this.voiceTrace('remote-screen-play-failed', { peer: name, error: error?.message || String(error) }, 'WARN'));
        this.voiceTrace('remote-screen-attach', { peer: name, streamId: stream.id || '' });
        this.scheduleRenderVoicePanel();
    }

    detachRemoteScreenStream(peer) {
        const name = String(peer || '').trim();
        if (!name) return;
        const video = this.voice.remoteScreens.get(name);
        if (video) {
            try { video.pause?.(); video.srcObject = null; video.remove?.(); } catch (e) {}
            this.voice.remoteScreens.delete(name);
        }
        this.scheduleRenderVoicePanel();
    }
});
