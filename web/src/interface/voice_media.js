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
    // 15 peers = a room of MAX_VOICE_TILES. voiceVideoBudget already divides a fixed
    // uplink total by the peer count (floored at 150 kbit/s), so a full room costs
    // no more than a small one — each stream just gets thinner.
    static get MAX_MESH_VIDEO_PEERS() { return 15; }

    // Not enforced — a mesh audio call this large still works, it just stops being
    // comfortable, and refusing to connect people who asked to be connected is worse
    // than a warning in the log. Crossing it is recorded so that "звонок тормозил at
    // 11 people" is a fact in the journal rather than a recollection.
    static get MAX_MESH_AUDIO_PEERS() { return 15; }
    // Сколько личный звонок может простоять без собеседника в комнате, прежде чем
    // считаться оконченным (concludeAbandonedDmCallIfNeeded). Больше трёх тактов пинга
    // присутствия (8 с): живой собеседник после restore_dm_room возвращается за один.
    static get VOICE_DM_ALONE_END_MS() { return 30000; }
    // Наибольшая сторона кадра демонстрации на отправке (scaleResolutionDownBy).
    static get VOICE_SCREEN_MAX_SIDE() { return 1920; }

    // How many participants get a 16:9 tile; the rest collapse into small circles
    // under the grid (renderVoiceTiles). Smaller while a screen share owns the stage:
    // the tiles are a one-row strip then.
    static get MAX_VOICE_TILES() { return 16; }
    static get MAX_VOICE_TILES_WITH_STAGE() { return 8; }

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

    // Микрофон из оболочки (interface/native_media.js): обычный HAL/WASAPI-ввод и наша
    // обработка (AEC3 → RNNoise → AGC2) вместо системного VoiceProcessingIO, который на
    // macOS глушит звук всей системы на каждый вход в звонок. null — пути нет или он
    // отказал; тогда вызывающий идёт в getUserMedia, звонок не падает.
    // Сохранённый id от движка оболочка не знает — defaultIfUnknown (native_media.js).
    async tryNativeMicStream(deviceId = this.audioPrefs?.micDeviceId || '') {
        if (!this.nativeCaptureAvailable?.('mic')) return null;
        try {
            return await this.openNativeMediaStream({
                kind: 'mic',
                deviceId,
                defaultIfUnknown: true,
                options: { processing: this.voiceProcessingEnabled() },
            });
        } catch (error) {
            this.voiceDiag('native-mic-fallback', { error: error?.message || String(error), code: error?.code || '' }, 'WARN');
            return null;
        }
    }

    // Видеодорожка камеры: из оболочки, при отказе — getUserMedia. deviceId === null —
    // сохранённый выбор (как `ideal`: пропавшую камеру заменит системная), строка —
    // именно эта камера.
    async captureVoiceCameraTrack(deviceId = null) {
        const pref = this.loadVoiceDevicePref(ZaliInterface.VOICE_CAMERA_PREF_KEY);
        const id = deviceId === null ? String(pref.deviceId || '') : String(deviceId || '');
        if (this.nativeCaptureAvailable?.('camera')) {
            try {
                const stream = await this.openNativeMediaStream({
                    kind: 'camera',
                    deviceId: id,
                    // Сохранённый выбор — как `ideal`: неизвестный оболочке id (от движка)
                    // заменяет камера по умолчанию. Явный выбор — именно эта камера.
                    defaultIfUnknown: deviceId === null,
                    options: { width: 1280, height: 720, fps: 30 },
                });
                const track = stream.getVideoTracks()[0];
                if (track) {
                    track.__zaliDeviceId = stream.__zaliDeviceId || id;
                    return track;
                }
            } catch (error) {
                this.voiceDiag('native-camera-fallback', { error: error?.message || String(error), code: error?.code || '' }, 'WARN');
            }
        }
        const video = deviceId === null
            ? this.voiceCameraConstraint()
            : { deviceId: { exact: id }, width: { ideal: 1280 }, height: { ideal: 720 } };
        const camStream = await navigator.mediaDevices.getUserMedia({ video });
        const track = camStream.getVideoTracks()[0];
        if (!track) throw new Error('Камера не отдала видео');
        return track;
    }

    async captureVoiceLocalStream() {
        if (this.voice.localStream) return this.voice.localStream;
        if (!this.voice.supported) {
            throw new Error('Голосовые звонки не поддерживаются в этом окружении');
        }
        // Эпоха сброса (resetVoiceState увеличивает): если звонок закончился, пока шёл
        // getUserMedia, пришедший поток никому не нужен — его нельзя класть в
        // this.voice.localStream, иначе микрофон остаётся включённым после выхода.
        const epoch = this._voiceResetEpoch || 0;
        const micConstraint = this.micAudioConstraints();
        const hasPickedDevice = !!this.audioPrefs?.micDeviceId;
        // На WebKit/macOS при выключенной обработке просим ОБЯЗАТЕЛЬНО без неё (см.
        // micAudioConstraints); отказ движка — не ошибка звонка, идём на обычные.
        const strictFirst = this.isWebKitOnMac() && !this.voiceProcessingEnabled();
        const getAudioOnlyStream = async () => {
            const native = await this.tryNativeMicStream();
            if (native) return native;
            if (strictFirst) {
                try {
                    return await navigator.mediaDevices.getUserMedia({ audio: this.micAudioConstraints({ strict: true }), video: false });
                } catch (error) {
                    this.voiceTrace('mic-strict-constraints-rejected', { name: error?.name || '', error: error?.message || String(error) }, 'WARN');
                }
            }
            try {
                return await navigator.mediaDevices.getUserMedia({ audio: micConstraint, video: false });
            } catch (error) {
                // Saved device id may no longer exist (unplugged/removed) — fall
                // back to the system default rather than failing the whole call.
                if (!hasPickedDevice) throw error;
                this.voiceTrace('mic-fallback-default', { error: error?.message || String(error) }, 'WARN');
                const { deviceId, ...withoutDevice } = micConstraint;
                return navigator.mediaDevices.getUserMedia({ audio: withoutDevice, video: false });
            }
        };
        let stream;
        const nativeMicForVideo = this.voice.videoEnabled ? await this.tryNativeMicStream() : null;
        if (nativeMicForVideo) {
            // Микрофон из оболочки, камера — отдельно (тоже из оболочки, если умеет).
            stream = nativeMicForVideo;
            try {
                stream.addTrack(await this.captureVoiceCameraTrack());
                this.voice.cameraOn = true;
            } catch (error) {
                this.voiceTrace('camera-request-failed', { error: error?.message || String(error) }, 'WARN');
                this.addLogEntry({ type: 'WARN', msg: 'Камера недоступна — продолжаем аудиозвонком', ts: new Date().toLocaleTimeString() });
                this.voice.videoEnabled = false;
            }
        } else if (this.voice.videoEnabled) {
            try {
                stream = await navigator.mediaDevices.getUserMedia({
                    audio: micConstraint,
                    video: this.voiceCameraConstraint(),
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
        if ((this._voiceResetEpoch || 0) !== epoch) {
            for (const track of stream.getTracks()) {
                try { track.stop(); } catch (e) {}
            }
            this.voiceTrace('local-stream-discarded', { reason: 'session-reset-during-capture' });
            return null;
        }
        this.voice.localStream = stream;
        await this.enforceMicProcessing(stream);
        this.voice.micError = '';
        this.voice.muted = false;
        this.voiceDiag('local-stream-ready', {
            tracks: stream.getTracks().map(track => `${track.kind}:${track.readyState}:${track.enabled ? 'on' : 'off'}`),
        });
        this.ensureVoiceMeterLoop();
        this.attachLocalVideoPreview();
        return stream;
    }

    // Движок мог не принять ограничения обработки при захвате (они «желательные», а не
    // обязательные): на WebKit/macOS это значит, что VoiceProcessingIO всё же занял
    // микрофон и другие приложения слышат с него тишину. Сверяем фактические настройки
    // дорожки с желаемыми и при расхождении применяем их повторно; итог — в журнал звонка.
    async enforceMicProcessing(stream) {
        const track = stream?.getAudioTracks?.()[0];
        if (!track) return;
        const want = this.voiceProcessingEnabled();
        // Нативный микрофон: обработку делает наш APM в оболочке, у дорожки-генератора
        // настроек движка нет. Итог обработки оболочка присылает событием `stats`.
        if (this.isNativeMediaStream?.(stream)) {
            this.voiceDiag('mic-processing', { want, native: true, label: track.label || '' });
            return;
        }
        const read = () => {
            const s = track.getSettings?.() || {};
            return { echoCancellation: s.echoCancellation, noiseSuppression: s.noiseSuppression, autoGainControl: s.autoGainControl };
        };
        let actual = read();
        const mismatch = ['echoCancellation', 'noiseSuppression', 'autoGainControl']
            .some(key => typeof actual[key] === 'boolean' && actual[key] !== want);
        if (mismatch && typeof track.applyConstraints === 'function') {
            try {
                await track.applyConstraints({
                    echoCancellation: { exact: want },
                    noiseSuppression: { exact: want },
                    autoGainControl: { exact: want },
                });
            } catch (error) {
                this.voiceTrace('mic-apply-constraints-failed', { error: error?.message || String(error) }, 'WARN');
            }
            actual = read();
        }
        this.voiceDiag('mic-processing', { want, webkitMac: this.isWebKitOnMac(), ...actual, label: track.label || '' }, mismatch ? 'WARN' : 'INFO');
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
        // Через SFU камера уходит одной копией — потолок mesh к ней не относится.
        if (!this.voiceVideoViaSfu() && peerCount > ZaliInterface.MAX_MESH_VIDEO_PEERS) {
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
                    if (this.voiceVideoViaSfu()) await this.publishVoiceSfu();
                } catch (error) {
                    this.voiceTrace('camera-enable-failed', { error: error?.message || String(error) }, 'WARN');
                    this.addLogEntry({ type: 'WARN', msg: error?.message || 'Не удалось включить камеру', ts: new Date().toLocaleTimeString() });
                }
                this.renderVoicePanel();
                return;
            }
            try {
                const track = await this.captureVoiceCameraTrack();
                if (!track) return;
                this.voice.localStream.addTrack(track);
                this.voice.videoEnabled = true;
                this.voice.cameraOn = true;
                this.attachLocalVideoPreview();
                if (this.voiceVideoViaSfu()) {
                    await this.publishVoiceSfu();
                    this.renderVoicePanel();
                    return;
                }
                for (const peer of this.voice.peerConnections.keys()) {
                    const entry = this.getVoicePeerEntry(peer);
                    if (entry.videoSender) {
                        await entry.videoSender.replaceTrack(track);
                    } else {
                        entry.videoSender = entry.pc.addTrack(track, this.voice.localStream);
                    }
                    await this.applyVoiceVideoBitrateLimit(entry.videoSender, 'camera', entry);
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
        if (this.voiceVideoViaSfu()) void this.publishVoiceSfu();
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
    // H.264 первым у каждого видео-transceiver'а. Без этого кодек решал тот, кто слал
    // оффер: Mac (WebKit) ставит H.264 первым, Chrome/Android — VP8. Живой звонок
    // 2026-11-20 после перезапусков (оффер слал телефон) шёл в VP8 в обе стороны, и
    // всё программно (libvpx): телефон кодировал 720p камеры и декодировал экран Mac
    // 1710×1107 @ 58 к/с процессором, Mac кодировал экран без VideoToolbox — фризы. В
    // звонке, где оффер слал Mac, был H.264 с аппаратными кодеками (MediaCodec /
    // c2.mtk.avc.encoder / VideoToolbox). Порядок H.264 между собой — как у движка;
    // VP8/VP9/AV1 остаются запасными, служебные (rtx/red/ulpfec) — как были.
    preferVoiceVideoCodecs(pc) {
        if (!pc?.getTransceivers || typeof RTCRtpReceiver === 'undefined' || !RTCRtpReceiver.getCapabilities) return;
        let codecs;
        try { codecs = RTCRtpReceiver.getCapabilities('video')?.codecs || []; } catch (e) { return; }
        if (!codecs.length) return;
        const isH264 = (c) => /h264/i.test(String(c.mimeType || ''));
        if (!codecs.some(isH264)) return;
        const ordered = [...codecs.filter(isH264), ...codecs.filter(c => !isH264(c))];
        for (const transceiver of pc.getTransceivers()) {
            const kind = transceiver.receiver?.track?.kind || transceiver.sender?.track?.kind;
            if (kind !== 'video' || transceiver.stopped || typeof transceiver.setCodecPreferences !== 'function') continue;
            try {
                transceiver.setCodecPreferences(ordered);
            } catch (error) {
                this.voiceTrace('codec-preferences-failed', { error: error?.message || String(error) }, 'WARN');
            }
        }
    }

    // Стартовый битрейт видео. libwebrtc начинает оценку канала с ~300 кбит/с и
    // поднимает её секундами: первые 20–40 с звонка и после каждого переподключения
    // камера шла 180×320, экран — 339×220 (живой звонок 2026-11-20). Параметр кодека
    // x-google-start-bitrate (кбит/с) в SDP, который ОТПРАВИТЕЛЬ получает от
    // собеседника, задаёт старт его оценки — оба клиента наши, поэтому каждый
    // вписывает его в SDP, уходящий собеседнику. Читают и Chrome (Android), и WebKit
    // (Mac): оба на libwebrtc. Не выше потолка камеры: старт выше реального канала на
    // 2,4 ГГц сразу дал бы всплеск потерь.
    static get VOICE_VIDEO_START_KBPS() { return 2500; }

    voiceSdpForPeer(sdp, startKbps = ZaliInterface.VOICE_VIDEO_START_KBPS) {
        const text = String(sdp || '');
        if (!text) return text;
        // Значение обязано МЕНЯТЬСЯ от SDP к SDP: libwebrtc перезапускает оценку канала
        // стартовым битрейтом только при изменении x-google-start-bitrate (повтор того
        // же числа намеренно игнорируется). Звонок начинается со звука, оценка за это
        // время сползает до ~500 кбит/с, и камера/экран, включённые посреди звонка,
        // разгонялись ~23 с (замер 2026-11-20, через ретранслятор). Чередование 2500/2501
        // перезапускает старт на каждом пересогласовании (добавили видео — старт ~2,5).
        this._voiceSdpStartSeq = (Number(this._voiceSdpStartSeq) || 0) + 1;
        const start = Math.round(Number(startKbps) || ZaliInterface.VOICE_VIDEO_START_KBPS) + (this._voiceSdpStartSeq % 2);
        const eol = text.includes('\r\n') ? '\r\n' : '\n';
        const lines = text.split(eol);
        const videoPts = new Set();
        const withFmtp = new Set();
        for (const line of lines) {
            const rtp = /^a=rtpmap:(\d+) (H264|H265|VP8|VP9|AV1)\/90000/i.exec(line);
            if (rtp) videoPts.add(rtp[1]);
        }
        if (!videoPts.size) return text;
        const out = [];
        for (const line of lines) {
            const fmtp = /^a=fmtp:(\d+) /.exec(line);
            if (fmtp && videoPts.has(fmtp[1])) {
                withFmtp.add(fmtp[1]);
                out.push(/x-google-start-bitrate=/.test(line) ? line.replace(/x-google-start-bitrate=\d+/, `x-google-start-bitrate=${start}`) : `${line};x-google-start-bitrate=${start}`);
                continue;
            }
            out.push(line);
            const rtp = /^a=rtpmap:(\d+) /.exec(line);
            if (rtp && videoPts.has(rtp[1])) {
                // fmtp кодека может идти ниже rtpmap — решаем после прохода.
                out.push(`__ZALI_FMTP_${rtp[1]}__`);
            }
        }
        return out
            .map(line => {
                const m = /^__ZALI_FMTP_(\d+)__$/.exec(line);
                if (!m) return line;
                return withFmtp.has(m[1]) ? null : `a=fmtp:${m[1]} x-google-start-bitrate=${start}`;
            })
            .filter(line => line !== null)
            .join(eol);
    }

    createVoiceOfferFor(entry) {
        if (!entry?.pc) return Promise.reject(new Error('no peer connection'));
        this.preferVoiceVideoCodecs(entry.pc);
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
                        sdp: this.voiceSdpForPeer(entry.pc.localDescription?.sdp || ''),
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
        } else if (!navigator.mediaDevices?.getDisplayMedia && this.nativeSupports('screenCapture')) {
            // Android: MediaProjection shows the system's own dialog, nothing to pick.
            this.startScreenShare();
        } else {
            this.openVoiceScreenPicker();
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
        if (this.voiceVideoViaSfu()) {
            // Экран несёт SFU (voice_sfu.js); собеседнику — только состояние «Общего
            // браузера», один раз на показ.
            if (!entry.sfuScreenAnnounced) {
                entry.sfuScreenAnnounced = true;
                this.onSharedBrowserPeerAttached?.(peer);
            }
            return false;
        }
        const track = this.voice.localScreenStream.getVideoTracks()[0];
        if (!track) return false;
        entry.screenSender = entry.pc.addTrack(track, this.voice.localScreenStream);
        void this.applyVoiceVideoBitrateLimit(entry.screenSender, 'screen', entry);
        // Звук идёт в том же MediaStream, что и картинка: по id потока принимающая
        // сторона отличает его от голоса (см. isRemoteScreenStream).
        const screenAudio = this.voice.localScreenStream.getAudioTracks()[0];
        if (screenAudio) entry.screenAudioSender = entry.pc.addTrack(screenAudio, this.voice.localScreenStream);
        this.sendScreenShareMeta(peer, 'start');
        this.onSharedBrowserPeerAttached?.(peer);
        this.voiceTrace('screen-track-attached', { peer, streamId: this.voice.localScreenStream.id || '' });
        return true;
    }

    // options: { surface: 'monitor'|'window', height, fps } from the
    // screen picker; absent = last saved choice (or the old defaults).
    async startScreenShare(options = null) {
        // Guards the getDisplayMedia() call itself — screenSharing only flips
        // true once it resolves, so a fast double-click before the OS picker
        // even returns would otherwise fire two concurrent capture requests;
        // whichever resolves last silently overwrites localScreenStream,
        // leaking the other capture (its track.stop() never runs, so the OS's
        // "sharing your screen" indicator can stay on for it indefinitely).
        if (this.voice.screenSharing || this.voice.screenShareRequestInFlight) return;
        // Android: аппаратный H.264 оболочки по протоколу MEDIA_REQUEST (как на macOS и
        // Windows, ScreenH264Encoder.kt) — дальше обычный путь ниже. Нет поддержки
        // WebMessage с ArrayBuffer — прежний JPEG → canvas (startNativeScreenCapture).
        const androidNative = !navigator.mediaDevices?.getDisplayMedia && !!this.nativeCaptureAvailable?.('screen');
        if (!navigator.mediaDevices?.getDisplayMedia && !androidNative) {
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
            const pickedChoice = options || this.loadVoiceDevicePref(ZaliInterface.VOICE_SCREEN_PREF_KEY);
            // Для перезапуска той же демонстрации (restartVoiceScreenShare) — выбор как есть.
            this.voice.screenShareChoice = pickedChoice;
            // 1440p/4K и 120 к/с рассчитаны на SFU (одна копия на сервер); в mesh и при откате
            // с SFU нативный H.264 на таких значениях уходит в десятки Мбит/с — потолок 1080p60.
            const choice = this.voiceVideoViaSfu()
                ? pickedChoice
                : { ...pickedChoice, height: Number(pickedChoice.height) > 1080 ? 1080 : pickedChoice.height, fps: Math.min(60, Number(pickedChoice.fps) || 30) };
            const video = { cursor: 'always', frameRate: Number(choice.fps) || 30 };
            const height = Number(choice.height) || 0;
            if (height) {
                video.height = { ideal: height };
                video.width = { ideal: Math.round(height * 16 / 9) };
            }
            // Звук демонстрации — по выбору в окне «Что показать» (по умолчанию да).
            // Эхо/шумодав/АРУ для системного звука вредны: они режут музыку и игры.
            // Звук экрана Android-оболочка пока не захватывает.
            const wantAudio = !androidNative && !(choice.audio === 0 || choice.audio === false);
            const request = {
                video,
                // restrictOwnAudio — подсказка Chromium (Windows): не захватывать звук самого
                // приложения, иначе голоса звонка из наших динамиков уйдут в демонстрацию и
                // собеседники услышат себя с задержкой. Неизвестный ключ движок игнорирует.
                audio: wantAudio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, restrictOwnAudio: true } : false,
            };
            if (wantAudio) request.systemAudio = 'include';
            if (['monitor', 'window'].includes(choice.surface)) {
                // Hints only: a browser that does not know them ignores them.
                video.displaySurface = choice.surface;
                if (choice.surface === 'window') request.monitorTypeSurfaces = 'exclude';
            }
            let stream;
            // Звук приложения без звонка (уведомления приглушённо, видео из переписки
            // как есть) — при показе всего экрана и окна самого мессенджера. Окно
            // другого приложения — только его звук (interface/share_audio.js).
            const isDisplay = choice.sourceKind === 'display' || String(choice.sourceId || '').startsWith('display:');
            const ownWindow = !!choice.own;
            let appAudio = false;
            // Номер нативного потока: к нему оболочка привязывает разрешение на
            // удалённое управление (смесь со звуком приложения его теряет).
            let nativeScreenStream = 0;
            // Слои для SFU кодирует оболочка и шлёт их сама (voice_sfu.js →
            // startVoiceNativeSfuScreen) — без второго кодирования в WebRTC страницы.
            // macOS/Windows — выбранный источник, Android — весь экран.
            const nativeSfu = !choice.browser && (androidNative || !!choice.sourceId)
                && !!this.nativeCaptureAvailable?.('screen') && !!this.voiceNativeSfuScreenAvailable?.();
            // Номер нативного потока для издателя оболочки (у Android nativeScreenStream
            // не ставится: удалённого управления там нет).
            let sfuStream = 0;
            if (choice.browser) {
                // «Общий браузер» (shared_browser.js): кадры — со скрытого встроенного
                // браузера оболочки, а не с экрана; звука у него пока нет.
                stream = await this.openNativeMediaStream({
                    kind: 'browser',
                    options: choice.browser,
                    firstFrameTimeoutMs: 15000,
                });
                nativeScreenStream = Number(stream?.__zaliNativeStream) || 0;
                // Частота экрана запустившего (оболочка выбрала сама) — её держит и отправка.
                this.voice.screenFps = Number(stream?.__zaliNativeInfo?.fps) || 60;
                const browserTrack = stream.getVideoTracks()[0];
                if (browserTrack) { try { browserTrack.contentHint = 'motion'; } catch (e) {} }
            } else if (androidNative) {
                // Источник — всегда весь экран, согласие — системное окно MediaProjection
                // (до ответа `started` человек может думать долго).
                stream = await this.openNativeMediaStream({
                    kind: 'screen',
                    sourceId: 'display:0',
                    options: {
                        fps: Math.min(60, Number(choice.fps) || 30),
                        maxHeight: height,
                        ...(nativeSfu ? { sfu: this.voiceNativeSfuScreenSpec(Math.min(60, Number(choice.fps) || 30)) } : {}),
                    },
                    firstFrameTimeoutMs: 8000,
                    startTimeoutMs: 120000,
                });
                sfuStream = Number(stream?.__zaliNativeStream) || 0;
            } else if (choice.sourceId && this.nativeCaptureAvailable?.('screen')) {
                appAudio = wantAudio && (isDisplay || ownWindow);
                // Источник выбран в нашем окне с превью (openVoiceScreenPicker) — захват
                // в оболочке: ScreenCaptureKit / Windows.Graphics.Capture, звук системы
                // без звука самого приложения (иначе собеседники слышат себя).
                stream = await this.openNativeMediaStream({
                    kind: 'screen',
                    sourceId: String(choice.sourceId),
                    options: {
                        fps: Number(choice.fps) || 30,
                        maxHeight: height,
                        // Своё окно: звук оболочки не нужен — весь звук приложения
                        // соберёт страница без голосов звонка.
                        audio: wantAudio && !ownWindow && this.nativeSupports('nativeScreenAudio'),
                        cursor: true,
                        ...(nativeSfu ? { sfu: this.voiceNativeSfuScreenSpec(Number(choice.fps) || 30) } : {}),
                    },
                    firstFrameTimeoutMs: 8000,
                });
                nativeScreenStream = Number(stream?.__zaliNativeStream) || 0;
                sfuStream = nativeScreenStream;
            } else {
                try {
                    stream = await navigator.mediaDevices.getDisplayMedia(request);
                } catch (error) {
                    // An engine that rejects the hints (TypeError) gets the plain request.
                    if (error?.name !== 'TypeError') throw error;
                    stream = await navigator.mediaDevices.getDisplayMedia({ video: { cursor: 'always', frameRate: 30 }, audio: wantAudio });
                }
            }
            const track = stream.getVideoTracks()[0];
            if (!track) return;
            // Размер источника — до возможной подмены потока смесью со звуком ниже: дорожка
            // нативного захвата (генератор в воркере) своих width/height в getSettings не
            // сообщает, а без них потолок стороны кадра (VOICE_SCREEN_MAX_SIDE) не работал
            // — Mac слал 3420×2214 (2026-11-20).
            const sourceInfo = stream.__zaliNativeInfo || null;
            this.voice.screenSourceSize = sourceInfo?.width && sourceInfo?.height
                ? { width: Number(sourceInfo.width), height: Number(sourceInfo.height) }
                : null;
            // Звук системы от оболочки уже несёт звук приложения (macOS < 14.2: SCStream
            // не исключает процесс WebKit) — подмешивание удвоило бы уведомления и видео.
            if (appAudio && !ownWindow && stream.__zaliNativeInfo?.audioExcludesApp === false) {
                appAudio = false;
                this.voiceTrace('screen-share-app-audio-skipped', { reason: 'system-audio-includes-app' }, 'WARN');
            }
            if (appAudio) {
                const systemAudio = stream.getAudioTracks()[0] || null;
                const mixed = this.startShareAppAudio?.(systemAudio);
                if (mixed) {
                    // Звук системы остаётся в исходном потоке оболочки (питает смесь и
                    // гаснет вместе с картинкой), наружу идёт смесь.
                    stream = new MediaStream([track, mixed]);
                    track.addEventListener('ended', () => this.stopShareAppAudio?.('track-ended'));
                }
                this.voiceTrace('screen-share-app-audio', { mixed: !!mixed, system: !!systemAudio, own: ownWindow, display: isDisplay });
            }
            this.voice.localScreenStream = stream;
            this.voice.screenNativeStream = nativeScreenStream;
            this.voice.screenIsDisplay = !!nativeScreenStream && isDisplay && !choice.browser;
            this.voice.screenActivity = choice.browser ? 'browser' : '';
            // Что за картинка — для кодировщика (voiceScreenContentHint в voice_sfu.js). Без
            // подсказки дорожка нативного захвата (генератор кадров) кодировалась как камера —
            // и в mesh, и через SFU. Частота из пикера: 60 к/с выбирают ради плавности.
            if (!choice.browser) this.voice.screenFps = Number(choice.fps) || 30;
            try { track.contentHint = this.voiceScreenContentHint(); } catch (e) {}
            // Аудиодорожки может не быть: платформа не умеет (macOS WKWebView),
            // не отдан системный звук, или в системном окне не отмечено «Поделиться
            // звуком». Тогда демонстрация идёт как раньше — только картинка.
            this.voice.screenAudioShared = stream.getAudioTracks().length > 0;
            if (wantAudio && !this.voice.screenAudioShared && !choice.browser) {
                this.addLogEntry({ type: 'INFO', msg: 'Звук демонстрации недоступен — передаётся только картинка', ts: new Date().toLocaleTimeString() });
            }
            this.voice.screenSharing = true;
            if (!this.voice.screenRestarting) this.playVoiceEventSound?.('stream');
            // Оффер — из sourceInfo, снятого до подмены потока: со звуком приложения `stream`
            // выше стал смесью (new MediaStream), у неё нет __zaliNativeInfo, и оболочка
            // вечно сидела в connected:false, а на сервер шёл только запасной путь страницы
            // (Windows, 2026-11-22).
            const sfuOffer = nativeSfu ? sourceInfo?.sfu : null;
            if (nativeSfu && !sfuOffer) {
                this.voiceTrace('sfu-native-screen-unavailable', { error: sourceInfo?.sfuError || 'no offer' }, 'WARN');
            }
            // До publishVoiceSfu: экран страницы (превью) в её публикацию не идёт.
            // Android: перезапуск захвата — новое системное окно согласия, поэтому при сбое
            // издателя страница остаётся на этом захвате и шлёт превью сама (inPlace).
            if (sfuOffer && this.voiceVideoViaSfu()) this.startVoiceNativeSfuScreen(sfuStream, sfuOffer, { inPlace: androidNative });
            // Fires when the user stops sharing via the browser/OS's own
            // "Stop sharing" control, not just our in-app button.
            track.addEventListener('ended', () => this.stopScreenShare());
            this.attachLocalScreenPreview();
            this.voiceTrace('screen-share-start', { streamId: stream.id, label: track.label || '' });
            for (const peer of this.voice.peerConnections.keys()) {
                this.attachLocalScreenTrackToPeer(peer);
            }
            if (this.voiceVideoViaSfu()) await this.publishVoiceSfu();
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
            // Нативный путь: code 'denied' — отказ в системном окне согласия.
            if (error?.name !== 'NotAllowedError' && error?.name !== 'AbortError' && error?.code !== 'denied') {
                this.addLogEntry({ type: 'WARN', msg: error?.message || 'Не удалось начать демонстрацию экрана', ts: new Date().toLocaleTimeString() });
            }
            this.voiceTrace('screen-share-failed', { error: error?.message || String(error) }, 'WARN');
        } finally {
            this.voice.screenShareRequestInFlight = false;
        }
    }

    // Та же демонстрация заново, без звуков и без окна выбора: издатель оболочки отказал
    // (откат на WebRTC страницы) или звонок ушёл из SFU в mesh, где слоёв оболочки нет.
    async restartVoiceScreenShare(reason) {
        const choice = this.voice.screenShareChoice;
        if (!this.voice.screenSharing || !choice || this.voice.screenRestarting) return;
        this.voiceTrace('screen-share-restart', { reason });
        this.voice.screenRestarting = true;
        try {
            this.stopScreenShare();
            await this.startScreenShare(choice);
        } catch (error) {
            this.voiceDiag('screen-share-restart-failed', { reason, error: error?.message || String(error) }, 'WARN');
        } finally {
            this.voice.screenRestarting = false;
        }
    }

    stopScreenShare() {
        if (!this.voice.screenSharing) return;
        // Без экрана нечем управлять: разрешение снимается раньше остановки захвата.
        this.revokeRemoteControlHost?.('screen-stop');
        // «Общий браузер» закрывается вместе со своей трансляцией.
        this.onSharedBrowserShareStopping?.('screen-stop');
        // Свой выход из канала гасит демонстрацию через resetVoiceState, не через этот
        // метод, — поэтому здесь только намеренная остановка, и звук не двоится с выходом.
        if (!this.voice.screenRestarting) this.playVoiceEventSound?.('stream-stop');
        this.stopVoiceNativeSfuScreen?.();
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
        this.voice.screenNativeStream = 0;
        this.voice.screenIsDisplay = false;
        this.voice.screenActivity = '';
        this.voice.screenFps = 0;
        this.stopShareAppAudio?.('screen-stop');
        this.voice.screenSharing = false;
        this.voice.screenAudioShared = false;
        this.resetNativeScreenCaptureState();
        this.detachLocalScreenPreview();
        for (const [peer, entry] of this.voice.peerConnections.entries()) {
            entry.sfuScreenAnnounced = false;
            if (entry.screenAudioSender) {
                try { entry.pc.removeTrack(entry.screenAudioSender); } catch (e) {}
                entry.screenAudioSender = null;
            }
            if (entry.screenSender) {
                try { entry.pc.removeTrack(entry.screenSender); } catch (e) {}
                entry.screenSender = null;
                this.sendScreenShareMeta(peer, 'stop');
            }
        }
        this.voiceTrace('screen-share-stop', {});
        this.renegotiateAllVoicePeers();
        if (this.voiceVideoViaSfu()) void this.publishVoiceSfu();
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
        this.playVoiceEventSound?.('stream');
        this.voice.screenCaptureFromNative = true;
        this.voice.screenShareRequestInFlight = false;
        try { track.contentHint = 'detail'; } catch (e) {}
        // Native-originated stream has no browser "Stop sharing" control, but
        // the track still ends if the underlying canvas stream is torn down.
        track.addEventListener('ended', () => this.stopScreenShare());
        this.attachLocalScreenPreview();
        this.voiceTrace('screen-share-start', { streamId: stream.id, label: 'native-capture' });
        for (const peer of this.voice.peerConnections.keys()) {
            this.attachLocalScreenTrackToPeer(peer);
        }
        if (this.voiceVideoViaSfu()) await this.publishVoiceSfu();
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
                screenAudioSender: null,
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
                if (entry.pc.signalingState === 'stable') void this.ensureVoiceSenderLimits(entry);
                if (entry.pc.signalingState === 'stable' && entry.renegotiationPending && !entry.negotiating) {
                    entry.renegotiationPending = false;
                    this.renegotiateVoicePeer(name).catch(() => {});
                }
            };
            // Канал удалённого управления от зрителя (interface/remote_control.js).
            entry.pc.ondatachannel = (event) => this.onVoiceDataChannel?.(name, event.channel);
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
                    // pc.close() в resetVoiceState (и пересоздание пира) гасит
                    // дорожки — onmute/onended приходят уже ПОСЛЕ очистки
                    // remoteScreens/remoteVideos, и attach заводил элемент заново:
                    // в следующем звонке висела «Экран: <прошлый собеседник>» с
                    // кнопкой «Смотреть» и плитка-призрак. Мёртвый пир ничего не
                    // подключает.
                    if (this.voice.peerConnections.get(name) !== entry) return;
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
                const voiceStream = this.voice.remoteAudios.get(name)?.srcObject || null;
                if (this.isRemoteScreenStream(entry, name, stream, track)) {
                    this.attachRemoteScreenStream(name, stream);
                } else if (track?.kind === 'video' && voiceStream && voiceStream.id !== stream.id
                    && !stream.getAudioTracks().length) {
                    // Камера пришла отдельным потоком без звука (так бывает в WebKit):
                    // в плитку человека, но голос не трогаем — attachRemoteVoiceStream
                    // подменил бы им <audio> и собеседник замолчал бы.
                    this.attachRemoteVideoStream(name, stream);
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
            // 80 мс (было 125): плавнее кольцо при том же сглаживании.
            this.voice.meterRaf = setTimeout(tick, 80);
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
        // Voice goes first when the uplink is short. Every encoding defaults to
        // priority 'low', so on a video call or a screen share the bandwidth allocator
        // split a congested link evenly — and audio is the stream where a queue turns
        // straight into delay: the receiver's jitter buffer grows to ride out the loss
        // and stays grown. 'high' makes video give way first; `networkPriority` asks
        // for an expedited-forwarding DSCP mark where the engine and OS apply one.
        // Nothing is taken from the voice itself, so no quality is traded for it.
        // A separate setParameters on purpose: an engine that refuses these fields
        // must not take the bitrate cap above down with it.
        try {
            const params = sender.getParameters();
            if (!params.encodings || !params.encodings.length) return;
            params.encodings[0].priority = 'high';
            params.encodings[0].networkPriority = 'high';
            await sender.setParameters(params);
        } catch (error) {
            this.voiceTrace('audio-priority-failed', { error: error?.message || String(error) }, 'WARN');
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
    voiceVideoBudget(kind = 'camera', entry = null) {
        const direct = this.voiceDirectVideoBudget(kind);
        const relayCap = entry?.relayed ? this.voiceRelayVideoCap(kind) : 0;
        return relayCap ? Math.min(direct, relayCap) : direct;
    }

    // Через TURN-ретранслятор всё медиа пира идёт одной сессией (max-bundle), и
    // ретранслятор режет её потолком (`max-bps` coturn); всё сверх него теряется —
    // фризы почти в каждом звонке между разными сетями. Прежний прод-потолок 3 Мбит/с
    // был подобран под лимиты 1,2 + 2,0 и делал нынешние 2,5 + 8 недостижимыми
    // («на бумаге»). Поэтому потолок сессии — одна константа, которую обязана давать
    // конфигурация coturn (скилл zali-ops-turn-nginx: max-bps = это число), и лимиты
    // через ретранслятор считаются из неё: видео вместе ≤ 88 % потолка (остальное —
    // звук, повторы, заголовки RTP/SRTP/TURN). При 12 Мбит/с это полные прямые лимиты
    // (экран 8 + камера 2,5), то есть ретранслятор ничего не урезает; ограничение
    // срабатывает, только если потолок окажется ниже.
    static get VOICE_RELAY_MAX_BPS() { return 12000000; }

    voiceRelayVideoCap(kind) {
        const allowance = Math.floor(ZaliInterface.VOICE_RELAY_MAX_BPS * 0.88);
        const camera = !!this.voice.cameraOn;
        const screen = !!this.voice.screenSharing;
        const cameraDirect = this.voiceDirectVideoBudget('camera');
        const screenDirect = this.voiceDirectVideoBudget('screen');
        if (kind === 'screen') {
            const reserve = camera ? Math.min(cameraDirect, Math.floor(allowance * 0.25)) : 0;
            return Math.max(500000, Math.min(screenDirect, allowance - reserve));
        }
        const reserve = screen ? Math.min(screenDirect, Math.floor(allowance * 0.75)) : 0;
        return Math.max(300000, Math.min(cameraDirect, allowance - reserve));
    }

    voiceDirectVideoBudget(kind = 'camera') {
        const peers = Math.max(1, this.voice.peerConnections.size || 1);
        // «Общий браузер»: плавность важнее — на 60+ к/с 720p нужно больше, чем демонстрации.
        if (kind === 'screen' && this.voice.screenActivity === 'browser') {
            // Поднят вместе с экраном (было 12 / 6): браузеру нужно больше демонстрации.
            return Math.max(1000000, Math.min(10000000, Math.floor(20000000 / peers)));
        }
        // Подняты 2026-11-20 по просьбе пользователя (было 3 / 2 / 0,25 Мбит/с у экрана,
        // 2,5 / 1,2 / 0,15 у камеры; экран — 8 Мбит/с на собеседника). Это потолки:
        // фактический битрейт по-прежнему ведёт оценка канала WebRTC, на слабом канале
        // он сам опустится ниже.
        const total = kind === 'screen' ? 16000000 : 5000000;
        const ceiling = kind === 'screen' ? 8000000 : 2500000;
        const floor = kind === 'screen' ? 500000 : 300000;
        return Math.max(floor, Math.min(ceiling, Math.floor(total / peers)));
    }

    // Лимит, поставленный ДО согласования, Chromium теряет: отправитель из addTrack,
    // сделанного до применения оффера собеседника, связывается с его m-line, и
    // encodings приходят пустыми. Живой звонок 2026-11-20: у видеоотправителя
    // телефона maxBitrate не было вовсе (у звука — был), камера слала ~2,75 Мбит/с
    // при потолке 1,2 (цель кодировщика 2500 — умолчание WebRTC для 720p), забивая
    // общий 2,4 ГГц эфир. Поэтому после каждого согласования (signalingState →
    // stable) лимиты сверяются и, если слетели, ставятся заново.
    async ensureVoiceSenderLimits(entry) {
        if (!entry?.pc) return;
        const maxOf = (sender) => {
            try { return sender.getParameters().encodings?.[0]?.maxBitrate; } catch (e) { return undefined; }
        };
        try {
            if (entry.audioSender?.track && maxOf(entry.audioSender) !== 64000) {
                await this.applyVoiceAudioBitrateLimit(entry.audioSender);
            }
            if (entry.videoSender?.track && maxOf(entry.videoSender) !== this.voiceVideoBudget('camera', entry)) {
                await this.applyVoiceVideoBitrateLimit(entry.videoSender, 'camera', entry);
            }
            if (entry.screenSender?.track && maxOf(entry.screenSender) !== this.voiceVideoBudget('screen', entry)) {
                await this.applyVoiceVideoBitrateLimit(entry.screenSender, 'screen', entry);
            }
        } catch (error) {
            this.voiceTrace('sender-limits-failed', { error: error?.message || String(error) }, 'WARN');
        }
    }

    async applyVoiceVideoBitrateLimit(sender, kind = 'camera', entry = null) {
        if (!sender) return;
        try {
            const params = sender.getParameters();
            if (!params.encodings || !params.encodings.length) params.encodings = [{}];
            const maxBitrate = this.voiceVideoBudget(kind, entry);
            params.encodings[0].maxBitrate = maxBitrate;
            // Демонстрация тоже 'balanced' (было 'maintain-resolution'): при просевшем
            // канале «держать разрешение» значит уронить частоту до слайд-шоу. Замер
            // 2026-11-20: экран Mac 3420×2214 при ~400 кбит/с — 16 фризов, картинка
            // стояла 8,5 с из каждых 20. И большая сторона кадра — не больше 1920:
            // «Оригинал» на Retina отдаёт в 3 раза больше пикселей, чем вмещает бюджет.
            // Экран всё же держит разрешение: 'balanced' на просевшем канале (88–290
            // кбит/с сразу после переподключения) ужал демонстрацию до 339×220 и
            // поднимал обратно минутами — «разрешение и качество упали в 0». Фризы
            // прежнего 'maintain-resolution' были от 3420×2214 — теперь сторона кадра
            // ограничена VOICE_SCREEN_MAX_SIDE, и кадр в 3+ раза меньше.
            params.degradationPreference = kind === 'screen' ? 'maintain-resolution' : 'balanced';
            if (kind === 'screen') {
                const settings = sender.track?.getSettings?.() || {};
                let longSide = Math.max(Number(settings.width) || 0, Number(settings.height) || 0);
                if (!longSide && this.voice.screenSourceSize) {
                    longSide = Math.max(this.voice.screenSourceSize.width, this.voice.screenSourceSize.height);
                }
                params.encodings[0].scaleResolutionDownBy = longSide > ZaliInterface.VOICE_SCREEN_MAX_SIDE
                    ? longSide / ZaliInterface.VOICE_SCREEN_MAX_SIDE
                    : 1;
            }
            if (kind === 'screen' && this.voice.screenActivity === 'browser') {
                // Частота экрана запустившего без потолка WebRTC по умолчанию (60), а при
                // нехватке канала или процессора падает разрешение, не плавность.
                params.encodings[0].maxFramerate = Math.max(30, Math.min(240, Number(this.voice.screenFps) || 60));
                params.degradationPreference = 'maintain-framerate';
            }
            await sender.setParameters(params);
            this.voiceTrace('video-bitrate-limit', { kind, maxBitrate, relayed: !!entry?.relayed, peers: this.voice.peerConnections.size });
        } catch (error) {
            this.voiceTrace('video-bitrate-limit-failed', { kind, error: error?.message || String(error) }, 'WARN');
        }
    }

    // Re-divides the budget when the roster changes. A limit computed for a
    // two-person call is four times too generous once four more people join, and the
    // senders were created long before that happened.
    async refreshVoiceSenderLimits() {
        for (const entry of this.voice.peerConnections.values()) {
            if (entry.videoSender) await this.applyVoiceVideoBitrateLimit(entry.videoSender, 'camera', entry);
            if (entry.screenSender) await this.applyVoiceVideoBitrateLimit(entry.screenSender, 'screen', entry);
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
                // Камеру в режиме SFU несёт соединение публикации, а не каждый пир.
                if (track.kind === 'video' && this.voiceVideoViaSfu()) continue;
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
                await this.applyVoiceVideoBitrateLimit(sender, 'camera', entry);
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
        // В режиме SFU голосовой поток пира видео не несёт: без проверки его пустой
        // список видеодорожек снёс бы камеру, пришедшую через сервер.
        if (!this.voiceVideoViaSfu() || stream.getVideoTracks().length) this.attachRemoteVideoStream(name, stream);
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
        const tracks = stream.getVideoTracks();
        const hasVideo = tracks.some(t => t.readyState === 'live' && !t.muted);
        const trackEnded = !tracks.some(t => t.readyState === 'live');
        let video = this.voice.remoteVideos.get(name);
        const dropVideo = () => {
            const current = this.voice.remoteVideos.get(name);
            if (!current) return;
            try { current.pause?.(); current.srcObject = null; current.remove?.(); } catch (e) {}
            this.voice.remoteVideos.delete(name);
            this.scheduleRenderVoicePanel();
        };
        if (!hasVideo) {
            if (!video) return;
            // Дорожка кончилась — убираем сразу. А вот краткое «mute» (пауза RTP, смена
            // битрейта, ожидание ключевого кадра) раньше тоже сносило <video> и
            // пересоздавало его через долю секунды: картинка мигала чёрным. Теперь
            // ждём: вернётся кадр — элемент остаётся на месте, нет — убираем.
            if (trackEnded) {
                clearTimeout(video._dropTimer);
                dropVideo();
            } else if (!video._dropTimer) {
                video._dropTimer = setTimeout(() => {
                    video._dropTimer = 0;
                    const stillGone = !(video.srcObject?.getVideoTracks?.() || []).some(t => t.readyState === 'live' && !t.muted);
                    if (stillGone) dropVideo();
                }, 2500);
            }
            return;
        }
        if (video?._dropTimer) {
            clearTimeout(video._dropTimer);
            video._dropTimer = 0;
        }
        if (!video) {
            video = document.createElement('video');
            video.autoplay = true;
            video.playsInline = true;
            video.muted = true;
            video.dataset.peer = name;
            this.voice.remoteVideos.set(name, video);
        }
        // Присваиваем поток, только если он другой или у элемента нет данных. Раньше
        // присваивание шло на КАЖДОЕ событие дорожки (unmute/mute/ended, новый
        // ontrack) — а каждое присваивание srcObject сбрасывает видеоэлемент, и между
        // кадрами вставал чёрный. Вернувшаяся после паузы дорожка играет и без этого.
        if (video.srcObject !== stream || video.readyState === 0) {
            video.srcObject = stream;
        }
        if (video.paused) {
            video.play?.().catch(error => this.voiceTrace('remote-video-play-failed', { peer: name, error: error?.message || String(error) }, 'WARN'));
        }
        this.scheduleRenderVoicePanel();
    }

    // Принадлежит ли пришедшая дорожка демонстрации экрана собеседника. Раньше
    // решала только пара «видео + id из screen-meta»; теперь в потоке экрана едет
    // ещё и звук, и без этой проверки он попадал в голосовой <audio> человека и
    // ВЫТЕСНЯЛ его микрофон. Звуковая дорожка из потока с другим id, чем у уже
    // играющего голоса этого человека, — это звук экрана, даже если screen-meta
    // ещё не дошёл (голос и камера едут в одном потоке, экран — в отдельном).
    //
    // Видео (2026-11-20). screen-meta шлётся при начале показа и после
    // пересогласования; клиент, перезапущенный посреди чужой демонстрации, его не
    // получал — экран лёг в плитку человека и вытеснял камеру. Правило «id потока не
    // совпал с голосом — значит экран» для видео НЕНАДЁЖНО: на Mac (WebKit) камера
    // телефона пришла в потоке с другим id и стала «демонстрацией». Поэтому решает
    // состояние с сервера (voice_state каждого клиента): экрана нет — это камера;
    // экран есть, камеры нет — экран; есть оба — по id; состояния нет — как раньше,
    // только по screen-meta.
    isRemoteScreenStream(entry, name, stream, track) {
        if (entry.remoteScreenStreamId && stream.id === entry.remoteScreenStreamId) return true;
        const voiceStream = this.voice.remoteAudios.get(name)?.srcObject;
        if (track?.kind === 'audio') {
            if (voiceStream && voiceStream.id !== stream.id) {
                entry.remoteScreenStreamId = stream.id;
                return true;
            }
            return false;
        }
        if (track?.kind === 'video') {
            const st = this.voice.memberStates?.[String(name).toLowerCase()];
            if (!st || !st.screen) return false;
            if (!st.camera || (voiceStream && voiceStream.id !== stream.id)) {
                entry.remoteScreenStreamId = stream.id;
                return true;
            }
        }
        return false;
    }

    attachRemoteScreenStream(peer, stream) {
        const name = String(peer || '').trim();
        if (!name || !stream) return;
        let video = this.voice.remoteScreens.get(name);
        if (!video) {
            // Новая демонстрация собеседника (не смена потока у уже идущей).
            this.playVoiceEventSound?.('stream');
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
        this.applyScreenVolume(name);
        if (this.audioPrefs?.speakerDeviceId && typeof video.setSinkId === 'function') {
            video.setSinkId(this.audioPrefs.speakerDeviceId).catch(() => {});
        }
        video.play?.().catch(error => this.voiceTrace('remote-screen-play-failed', { peer: name, error: error?.message || String(error) }, 'WARN'));
        video.dataset.attachedAt = String(Date.now());
        // Закончившаяся дорожка экрана — конец показа, даже без screen-meta stop.
        const screenTrack = stream.getVideoTracks?.()[0];
        if (screenTrack && !screenTrack.__zaliScreenEndHook) {
            screenTrack.__zaliScreenEndHook = true;
            screenTrack.addEventListener('ended', () => {
                if (this.voice.remoteScreens.get(name)?.srcObject === stream) {
                    this.voiceTrace('remote-screen-track-ended', { peer: name, streamId: stream.id || '' }, 'WARN');
                    this.detachRemoteScreenStream(name);
                }
            });
        }
        this.voiceTrace('remote-screen-attach', { peer: name, streamId: stream.id || '' });
        this.scheduleRenderVoicePanel();
    }

    // Фантомная демонстрация (2026-11-20): плитка экрана снималась только сигналом
    // screen-meta stop или разрывом соединения. Собеседник, перезапустивший приложение
    // посреди показа, «стоп» не шлёт, а его новые офферы применялись в старом
    // соединении — на Mac навсегда оставалась плитка с последним кадром экрана телефона.
    // Сервер же знает правду: каждый клиент шлёт voice_state {screen}. Если сервер
    // дольше 6 с говорит «не показывает», а плитка висит дольше 6 с — снимаем.
    // Состояния нет (старый клиент его не шлёт) — не трогаем.
    pruneStaleRemoteScreens() {
        const states = this.voice.memberStates || {};
        const now = Date.now();
        if (!this._screenStateFalseSince) this._screenStateFalseSince = new Map();
        for (const [name, video] of this.voice.remoteScreens) {
            const st = states[String(name).toLowerCase()];
            if (!st || st.screen) {
                this._screenStateFalseSince.delete(name);
                continue;
            }
            const since = this._screenStateFalseSince.get(name) || now;
            this._screenStateFalseSince.set(name, since);
            const attachedAt = Number(video?.dataset?.attachedAt) || 0;
            if (now - since < 6000 || now - attachedAt < 6000) continue;
            this._screenStateFalseSince.delete(name);
            const entry = this.voice.peerConnections.get(name);
            if (entry) entry.remoteScreenStreamId = null;
            const stream = video?.srcObject || null;
            const liveVideo = stream?.getVideoTracks?.().some(t => t.readyState === 'live');
            // Экрана нет, а камера есть и дорожка жива — это была камера, ошибочно
            // принятая за экран: переносим в плитку человека, а не выбрасываем.
            const toCamera = !!(st.camera && liveVideo);
            this.voiceDiag('remote-screen-pruned', {
                peer: name,
                reason: 'server-state-no-screen',
                rerouted: toCamera ? 'camera' : '',
            }, 'WARN');
            this.detachRemoteScreenStream(name);
            // Только видео: attachRemoteVoiceStream подменил бы звук голоса этим
            // потоком, а в нём аудио нет.
            if (toCamera) this.attachRemoteVideoStream(name, stream);
        }
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
