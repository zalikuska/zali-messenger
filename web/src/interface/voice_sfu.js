// --- ZaliInterface: видео звонка через SFU (server/src/sfu.rs). ---
// Часть класса ZaliInterface (см. web/src/interface.js).
//
// Режим видео комнаты решает СЕРВЕР (`videoTransport` в voice_room_state): 'sfu' —
// только когда его умеют все участники и ни у кого он не сломался. В режиме SFU
// камера, экран и звук экрана уходят ОДНИМ потоком на сервер (simulcast: q/h/f), а не
// копией каждому собеседнику; сервер раздаёт каждому зрителю слой, который пролезает в
// его канал. Микрофон и каналы данных (удалённое управление, «Общий браузер») остаются в
// mesh-соединениях voice_media.js — им SFU не нужен.
//
// Два соединения с сервером: публикация (оффер шлём мы) и подписка (оффер шлёт сервер).
// Встречных офферов поэтому нет. Сервер — ICE-lite с публичным адресом в ответе: свои
// кандидаты ему слать не нужно, а клиент без UDP дойдёт через TURN из getVoiceRtcConfig.
ZaliMixin(ZaliInterface, class {

    // Слои simulcast. Битрейт каждого — потолок; реальный ведёт оценка канала до сервера
    // (у отправителя) и выбор слоя на сервере (у каждого зрителя).
    //
    // Камера — вес по умолчанию ('low'); экрану в voiceSfuScreenEncodings — 'high'.
    static get SFU_CAMERA_LAYERS() {
        return [
            { rid: 'q', scaleResolutionDownBy: 4, maxBitrate: 150000, maxFramerate: 15 },
            { rid: 'h', scaleResolutionDownBy: 2, maxBitrate: 600000 },
            { rid: 'f', scaleResolutionDownBy: 1, maxBitrate: 2500000 },
        ];
    }

    // Экран через SFU: верхний слой — кадр как выбран в пикере, до 4K (сторона ≤
    // SFU_SCREEN_MAX_SIDE) и до 120 к/с; ниже — половина и четверть для слабых каналов и
    // маленьких плиток. Потолок mesh (VOICE_SCREEN_MAX_SIDE, 1920) здесь не действует:
    // отправитель грузит одну копию, а не по копии на каждого.
    static get SFU_SCREEN_MAX_SIDE() { return 3840; }
    // Битрейт слоя = пиксели × к/с × SFU_BITS_PER_PIXEL. 0,08 — H.264 в реальном времени
    // без B-кадров и lookahead на подвижной картинке (игры, видео): 1080p60 ≈ 10, 1440p120
    // ≈ 35, 4K60 ≈ 40 Мбит/с. Это потолок — статичный текст кодировщик сожмёт сильнее сам.
    static get SFU_BITS_PER_PIXEL() { return 0.08; }
    static get SFU_SCREEN_MAX_BPS() { return 40000000; }
    // Сколько ждём подключения соединения с сервером, прежде чем признать SFU недоступным.
    static get SFU_CONNECT_TIMEOUT_MS() { return 12000; }

    // --- Кодек потока через SFU ---------------------------------------------------------
    // Все зрители получают ОДИН поток отправителя, поэтому кодек — лучший из тех, что
    // отправитель кодирует аппаратно и ВСЕ в комнате декодируют аппаратно. Порядок —
    // по качеству на бит: AV1, H.265, H.264, VP8. H.264 — общий знаменатель: его аппаратно
    // тянут VideoToolbox, MediaCodec и Media Foundation, а программный AV1 на 4K60 положил
    // бы отправителя (у Apple Silicon до M3 нет даже аппаратного декодера AV1).
    //
    // В выбор попадают только кодеки, прошедшие у нас сквозную проверку ВМЕСТЕ с оценкой
    // канала (SFU_CODECS_VERIFIED; прогон — scripts/voice_doctor/sfu_e2e/codecs.mjs и
    // loss.mjs с CODEC=…). 2026-11-22, 1080p60 canvas: H.265 — 1080p60 при ~4,2 Мбит/с
    // против ~8 у H.264, держит 5 % потерь в каждую сторону; AV1 (программный libaom,
    // 720p30) — все три слоя, 5 % потерь. «Замерзание оценки» H.265 оказалось тремя
    // нашими багами: старт без x-google-start-bitrate (voiceSdpForPeer не знал H265),
    // пересылка кадров после разрыва (sfu.rs forward_media) и simulcast AV1 без
    // scalabilityMode (applyVoiceSfuEncodings). Аппаратный AV1-кодировщик не проверен —
    // на машине прогона его нет; в выбор он попадает только по powerEfficient.
    static get SFU_CODEC_ORDER() { return ['AV1', 'H265', 'H264', 'VP8']; }
    static get SFU_CODECS_VERIFIED() { return ['AV1', 'H265', 'H264', 'VP8']; }

    // Замер умений этого движка (один раз): send — что есть в RTCRtpSender, encode —
    // что кодируется аппаратно (mediaCapabilities.powerEfficient), decode — что
    // декодируется аппаратно (H.264/VP8 — достаточно поддержки: умеют все).
    ensureVoiceCodecCaps() {
        if (this._voiceCodecCapsPromise) return this._voiceCodecCapsPromise;
        const nameOf = (mime) => String(mime || '').replace(/^video\//i, '').toUpperCase();
        const probe = { width: 1920, height: 1080, bitrate: 8000000, framerate: 60 };
        const mime = { AV1: 'video/AV1', H265: 'video/H265', H264: 'video/H264', VP8: 'video/VP8', VP9: 'video/VP9' };
        this._voiceCodecCapsPromise = (async () => {
            const caps = { send: [], recv: [], encode: [], decode: [], preview: [] };
            try {
                caps.send = [...new Set((RTCRtpSender.getCapabilities?.('video')?.codecs || []).map(c => nameOf(c.mimeType)))];
                caps.recv = [...new Set((RTCRtpReceiver.getCapabilities?.('video')?.codecs || []).map(c => nameOf(c.mimeType)))];
            } catch (e) {}
            const mc = navigator.mediaCapabilities;
            for (const name of Object.keys(mime)) {
                if (caps.send.includes(name) && mc?.encodingInfo) {
                    try {
                        const r = await mc.encodingInfo({ type: 'webrtc', video: { contentType: mime[name], ...probe } });
                        if (r?.supported && r.powerEfficient) caps.encode.push(name);
                    } catch (e) {}
                }
                if (caps.recv.includes(name)) {
                    let ok = name === 'H264' || name === 'VP8';
                    if (!ok && mc?.decodingInfo) {
                        try {
                            const r = await mc.decodingInfo({ type: 'webrtc', video: { contentType: mime[name], ...probe } });
                            ok = !!(r?.supported && r.powerEfficient);
                        } catch (e) {}
                    }
                    if (ok) caps.decode.push(name);
                }
            }
            // Что эта страница декодирует через WebCodecs: превью своего экрана, когда его
            // слой сжимает оболочка (macOS, Android) кодеком нативной демонстрации.
            if (typeof VideoDecoder === 'function' && VideoDecoder.isConfigSupported) {
                for (const [name, codec] of Object.entries(ZaliInterface.NATIVE_PREVIEW_CODEC_STRINGS)) {
                    try {
                        const r = await VideoDecoder.isConfigSupported({ codec, optimizeForLatency: true });
                        if (r?.supported) caps.preview.push(name);
                    } catch (e) {}
                }
            }
            this._voiceCodecCaps = caps;
            this.voiceDiag?.('video-codec-caps', { encode: caps.encode.join('/') || '-', decode: caps.decode.join('/') || '-', send: caps.send.join('/'), preview: caps.preview.join('/') || '-' });
            return caps;
        })();
        return this._voiceCodecCapsPromise;
    }

    // Какие кодеки мы декодируем аппаратно — уходит серверу в каждом voice_* событии.
    voiceVideoDecodeCodecs() {
        if (!this._voiceCodecCapsPromise) void this.ensureVoiceCodecCaps();
        const list = this._voiceCodecCaps?.decode;
        return list ? list.filter(c => !this.voiceCodecBanned('decode', c)) : null;
    }

    // Рантайм-проверка поверх mediaCapabilities: powerEfficient — эвристика, и в WKWebView
    // она может врать. Кодек, который в звонке упёрся в процессор (отправитель) или роняет
    // кадры (зритель), выбывает на SFU_CODEC_BAN_MS. H.264 — пол: не выбывает никогда.
    static get SFU_CODEC_BAN_MS() { return 5 * 60 * 1000; }

    voiceCodecBanned(side, codec) {
        if (codec === 'H264') return false;
        const until = this._voiceCodecBans?.[side]?.[codec] || 0;
        return until > Date.now();
    }

    banVoiceCodec(side, codec, reason) {
        if (!codec || codec === 'H264' || this.voiceCodecBanned(side, codec)) return false;
        if (!this._voiceCodecBans) this._voiceCodecBans = { encode: {}, decode: {} };
        this._voiceCodecBans[side][codec] = Date.now() + ZaliInterface.SFU_CODEC_BAN_MS;
        this.voiceDiag('sfu-codec-banned', { side, codec, reason, minutes: ZaliInterface.SFU_CODEC_BAN_MS / 60000 }, 'WARN');
        return true;
    }

    // Годится ли кодек, на котором уже идёт публикация: все в комнате его декодируют и он
    // не выбыл у нас самих.
    voiceSfuCodecStillValid(codec) {
        if (!codec) return false;
        if (codec === 'H264') return true;
        if (this.voiceCodecBanned('encode', codec)) return false;
        const me = String(this.myName?.() || '');
        const lists = this.voice.videoCodecs || {};
        return (this.voice.participants || []).filter(n => n && n !== me).every(n => {
            const list = lists[n];
            return Array.isArray(list) ? list.includes(codec) : (codec === 'VP8');
        });
    }

    voiceSfuChooseCodec() {
        const caps = this._voiceCodecCaps;
        if (!caps) return 'H264';
        const me = String(this.myName?.() || '');
        const others = (this.voice.participants || []).filter(n => n && n !== me);
        const lists = this.voice.videoCodecs || {};
        for (const codec of ZaliInterface.SFU_CODEC_ORDER) {
            if (!ZaliInterface.SFU_CODECS_VERIFIED.includes(codec)) continue;
            if (!caps.send.includes(codec) || !caps.recv.includes(codec)) continue;
            // H.264 годится и программным (нижний предел для всех); прочее — только железом
            // и только если в звонке не выбыло (voiceCodecBanned).
            if (codec !== 'H264' && (!caps.encode.includes(codec) || this.voiceCodecBanned('encode', codec))) continue;
            const everyone = others.every(n => {
                const list = lists[n];
                // Старый клиент без списка: знаем только, что H.264/VP8 он тянет.
                return Array.isArray(list) ? list.includes(codec) : (codec === 'H264' || codec === 'VP8');
            });
            if (everyone) return codec;
        }
        return 'H264';
    }

    // Выбранный кодек — первым у каждого видео-transceiver'а публикации, H.264 — сразу за
    // ним (запасной), остальное — как у движка. Служебные (rtx/red/ulpfec) остаются.
    preferVoiceSfuCodec(pc, codec) {
        if (!pc?.getTransceivers || typeof RTCRtpReceiver === 'undefined' || !RTCRtpReceiver.getCapabilities) return;
        let all;
        try { all = RTCRtpReceiver.getCapabilities('video')?.codecs || []; } catch (e) { return; }
        const is = (c, name) => String(c.mimeType || '').toUpperCase() === `VIDEO/${name}`;
        const ordered = [
            ...all.filter(c => is(c, codec)),
            ...(codec === 'H264' ? [] : all.filter(c => is(c, 'H264'))),
            ...all.filter(c => !is(c, codec) && !is(c, 'H264')),
        ];
        for (const tr of pc.getTransceivers()) {
            const kind = tr.sender?.track?.kind || tr.receiver?.track?.kind;
            if (kind !== 'video' || tr.stopped || typeof tr.setCodecPreferences !== 'function') continue;
            try { tr.setCodecPreferences(ordered); } catch (error) {
                this.voiceTrace('sfu-codec-preferences-failed', { codec, error: error?.message || String(error) }, 'WARN');
            }
        }
    }

    // Отправитель шлёт ПЕРВЫМ кодеком из ответа, а str0m в ответе ставит кодеки в порядке
    // своего конфига (H.264 первым) — предпочтение из setCodecPreferences терялось, и при
    // выбранном H.265 шёл H.264 (локальный прогон 2026-11-22). Переставляем payload-типы
    // выбранного кодека в начало каждой m=video: набор тот же, меняется только порядок.
    voiceSdpPreferCodec(sdp, codec) {
        const text = String(sdp || '');
        if (!text || !codec) return text;
        const eol = text.includes('\r\n') ? '\r\n' : '\n';
        const lines = text.split(eol);
        const want = new Set();
        for (const line of lines) {
            const m = /^a=rtpmap:(\d+) ([A-Za-z0-9-]+)\/90000/.exec(line);
            if (m && m[2].toUpperCase() === String(codec).toUpperCase()) want.add(m[1]);
        }
        if (!want.size) return text;
        return lines.map(line => {
            const m = /^(m=video \d+ [A-Z/]+ )(.*)$/.exec(line);
            if (!m) return line;
            const pts = m[2].split(' ').filter(Boolean);
            const first = pts.filter(pt => want.has(pt));
            if (!first.length) return line;
            return m[1] + [...first, ...pts.filter(pt => !want.has(pt))].join(' ');
        }).join(eol);
    }

    // Уровень H.264 в ответе сервера — 3.1 (42e01f/42001f): кодировщик, который его
    // соблюдает (VideoToolbox в WKWebView), на 1440p60/4K60 ушёл бы в понижение или отказ.
    // Отправитель держит уровень, объявленный ПОЛУЧАТЕЛЕМ, — а получатель здесь сервер,
    // которому уровень безразличен (он пересылает кадры). Поднимаем до 5.2 (0x34: 4K60,
    // 1440p120), профиль не трогаем; level-asymmetry-allowed=1 str0m уже ставит.
    voiceSdpRaiseH264Level(sdp) {
        const text = String(sdp || '');
        if (!text) return text;
        const eol = text.includes('\r\n') ? '\r\n' : '\n';
        const h264 = new Set();
        for (const line of text.split(eol)) {
            const m = /^a=rtpmap:(\d+) H264\/90000/i.exec(line);
            if (m) h264.add(m[1]);
        }
        return text.split(eol).map(line => {
            const m = /^a=fmtp:(\d+) /.exec(line);
            if (!m || !h264.has(m[1])) return line;
            return line.replace(/profile-level-id=([0-9a-fA-F]{4})([0-9a-fA-F]{2})/, (all, pc, lvl) =>
                parseInt(lvl, 16) < 0x34 ? `profile-level-id=${pc}34` : all);
        }).join(eol);
    }

    voiceSfuSupported() {
        if (typeof RTCPeerConnection === 'undefined') return false;
        try {
            if (localStorage.getItem('zali_voice_sfu_off') === '1') return false;
        } catch (e) {}
        return true;
    }

    voiceVideoViaSfu() {
        return this.voice.videoTransport === 'sfu';
    }

    sfuState() {
        if (!this.voice.sfu) {
            this.voice.sfu = {
                roomId: '',
                joined: false,
                pub: null,
                sub: null,
                failures: 0,
                reported: false,
                healthTimer: null,
            };
        }
        return this.voice.sfu;
    }

    sendVoiceSfuEvent(type, extra = {}) {
        return this.sendVoiceEvent({
            type,
            roomId: this.voice.roomId,
            roomType: this.voice.roomType,
            serverId: this.voice.serverId,
            channelId: this.voice.channelId,
            ...extra,
        });
    }

    // Зовётся из обработчика voice_room_state на каждое состояние комнаты.
    async applyVoiceVideoTransport(raw) {
        const next = raw === 'sfu' && this.voiceSfuSupported() ? 'sfu' : 'mesh';
        const prev = this.voice.videoTransport || 'mesh';
        const sfu = this.sfuState();
        if (sfu.roomId && sfu.roomId !== this.voice.roomId) {
            this.teardownVoiceSfu({ announce: true });
        }
        if (next === prev) {
            if (next === 'sfu') {
                await this.ensureVoiceSfuSession();
                // Состав или чьи-то кодеки поменялись: пришёл зритель без AV1 — переходим
                // на общий кодек (и обратно, когда он ушёл).
                // Смена кодека — перезапуск потока и ключевой кадр у ВСЕХ зрителей. Поэтому вниз —
                // только когда текущий кто-то не декодирует (вошёл без него, у зрителя он выбыл,
                // у нас упёрся в процессор); вверх — не посреди показа, а при следующем старте
                // публикации (publishVoiceSfu выбирает заново). Уход участника поток не трогает.
                const pub = this.voice.sfu?.pub;
                if (pub?.codec && !pub.inFlight && !this.voiceSfuCodecStillValid(pub.codec)) {
                    this.voiceDiag('sfu-codec-switch', { from: pub.codec, to: this.voiceSfuChooseCodec() });
                    await this.publishVoiceSfu();
                }
                // Нативная демонстрация: кодек выбран при старте захвата — сменить его можно
                // только перезапуском показа (оболочка заводит кодировщики заново). Не
                // сбой издателя: счётчик nativeScreenFailures не трогаем.
                const ns = this.voice.sfu?.nativeScreen;
                if (ns?.codec && ns.codec !== 'H264' && !ns.failing && !ns.codecSwitching && !this.voiceSfuCodecStillValid(ns.codec)) {
                    ns.codecSwitching = true;
                    this.voiceDiag('sfu-native-codec-switch', { from: ns.codec, to: this.voiceNativeSfuScreenCodecs()[0] });
                    void this.restartVoiceScreenShare('native-sfu-codec');
                }
            }
            return;
        }
        this.voice.videoTransport = next;
        this.voiceDiag('video-transport', { roomId: this.voice.roomId || '', from: prev, to: next });
        if (next === 'sfu') {
            // Пересогласовывать mesh — только если из него правда что-то убрали. В начале
            // звонка убирать нечего, а пересогласование запускали ОБЕ стороны разом:
            // встречные офферы, у вежливой стороны откат. WebKit после отката сбрасывает
            // ICE (ice=new) и больше не шлёт микрофон: outPackets=0 до конца звонка
            // (Mac ↔ Windows, 2026-11-22, все звонки с переходом на SFU).
            if (this.moveLocalVideoOffMesh()) await this.renegotiateAllVoicePeers();
            await this.ensureVoiceSfuSession();
        } else {
            const nativeScreen = !!this.voice.screenViaNativeSfu;
            const inPlace = !!sfu.nativeScreen?.inPlace;
            const nativeStream = sfu.nativeScreen?.stream;
            this.teardownVoiceSfu({ announce: !sfu.reported });
            this.voice.screenViaNativeSfu = false;
            await this.moveLocalVideoToMesh();
            // Слои оболочки умеют только в SFU; в mesh собеседникам ушло бы превью —
            // демонстрация заново прежним путём. Android — превью этого же захвата (новое
            // окно согласия посреди звонка хуже, чем картинка поменьше).
            if (nativeScreen && inPlace) {
                if (nativeStream) void this.nativeMediaRequest?.('sfu_fallback', { stream: nativeStream }, 5000).catch(() => {});
            } else if (nativeScreen) void this.restartVoiceScreenShare('transport-mesh');
        }
        this.renderVoicePanel();
    }

    // Убирает камеру/экран из mesh-соединений (их теперь несёт SFU).
    // Возвращает, убрано ли хоть что-то (тогда и только тогда нужно пересогласование).
    moveLocalVideoOffMesh() {
        let removed = 0;
        for (const entry of this.voice.peerConnections.values()) {
            for (const field of ['videoSender', 'screenSender', 'screenAudioSender']) {
                if (!entry[field]) continue;
                try { entry.pc.removeTrack(entry[field]); } catch (e) {}
                entry[field] = null;
                removed += 1;
            }
        }
        return removed > 0;
    }

    // Обратно в mesh: каждому собеседнику своя копия, как до SFU.
    async moveLocalVideoToMesh() {
        const camera = this.voice.cameraOn ? this.voice.localStream?.getVideoTracks?.()[0] : null;
        for (const [peer, entry] of this.voice.peerConnections.entries()) {
            if (camera && !entry.videoSender) {
                try {
                    entry.videoSender = entry.pc.addTrack(camera, this.voice.localStream);
                    await this.applyVoiceVideoBitrateLimit(entry.videoSender, 'camera', entry);
                } catch (error) {
                    this.voiceTrace('sfu-mesh-camera-failed', { peer, error: error?.message || String(error) }, 'WARN');
                }
            }
            this.attachLocalScreenTrackToPeer(peer);
        }
        await this.renegotiateAllVoicePeers();
    }

    async ensureVoiceSfuSession() {
        if (!this.voiceVideoViaSfu() || !this.voice.roomId) return;
        const sfu = this.sfuState();
        sfu.roomId = this.voice.roomId;
        if (!sfu.joined) {
            sfu.joined = true;
            // Первый вход этой страницы — всегда с reset: после перезагрузки посреди звонка
            // старая подписка на сервере ещё жива (её Rtc держится до разрыва ICE + 8 с), все
            // её дорожки Open — нового оффера для нового RTCPeerConnection не было бы, и
            // видео собеседников не появлялось 10–20 с, до voice_sfu_closed.
            this.sendVoiceSfuEvent('voice_sfu_join', { reset: true, maxPixelRate: this.voiceSfuMaxPixelRate() });
        }
        this.ensureVoiceSfuHealth();
        // Только первая публикация (камера/экран включены до перехода в SFU). Дальше
        // набор источников меняют их собственные пути (enableVoiceCamera, startScreenShare…):
        // переоффер на каждое состояние комнаты гонял бы SDP впустую.
        if (!sfu.pub && this.voiceSfuLocalSources().length) await this.publishVoiceSfu();
    }

    // Что сейчас публикуем: [{ kind, track, stream }].
    voiceSfuLocalSources() {
        const out = [];
        const camera = this.voice.cameraOn ? this.voice.localStream?.getVideoTracks?.().find(t => t.readyState === 'live') : null;
        if (camera) out.push({ kind: 'camera', track: camera, stream: this.voice.localStream });
        const screenStream = this.voice.screenSharing ? this.voice.localScreenStream : null;
        const screen = screenStream?.getVideoTracks?.().find(t => t.readyState === 'live');
        if (screen) {
            // Картинку экрана несёт издатель оболочки (startVoiceNativeSfuScreen): дорожка
            // страницы — лишь превью нижнего слоя. Звук экрана — по-прежнему отсюда.
            if (!this.voice.screenViaNativeSfu) out.push({ kind: 'screen', track: screen, stream: screenStream });
            const audio = screenStream.getAudioTracks().find(t => t.readyState === 'live');
            if (audio) out.push({ kind: 'screen_audio', track: audio, stream: screenStream });
        }
        return out;
    }

    voiceScreenTrackSize(track) {
        const settings = track?.getSettings?.() || {};
        let width = Number(settings.width) || 0;
        let height = Number(settings.height) || 0;
        if ((!width || !height) && this.voice.screenSourceSize) {
            width = this.voice.screenSourceSize.width;
            height = this.voice.screenSourceSize.height;
        }
        return { width: width || 1920, height: height || 1080 };
    }

    voiceSfuScreenEncodings(track) {
        const { width, height } = this.voiceScreenTrackSize(track);
        const longSide = Math.max(width, height);
        const base = longSide > ZaliInterface.SFU_SCREEN_MAX_SIDE ? longSide / ZaliInterface.SFU_SCREEN_MAX_SIDE : 1;
        const fps = Math.max(15, Math.min(240, Number(this.voice.screenFps) || 30));
        const px = (scale) => (width / scale) * (height / scale);
        const bps = (scale, rate, lo, hi) => Math.round(Math.max(lo, Math.min(hi, px(scale) * rate * ZaliInterface.SFU_BITS_PER_PIXEL)));
        const midFps = Math.min(60, fps);
        const top = bps(base, fps, 2500000, ZaliInterface.SFU_SCREEN_MAX_BPS);
        // priority — вес отправителя при дележе аплинка (Chrome: bitrate_priority, high = 4×
        // low). Без него камера и экран делили канал поровну: на 5 Мбит/с верхнему слою экрана
        // доставалось 800 кбит/с и 6–8 к/с, а стоило выключить камеру — 1080p@30 (локальный
        // прогон 2026-11-22). Chrome принимает его ТОЛЬКО на первом слое — на остальных
        // addTransceiver/setParameters бросают «unimplemented parameter», и simulcast пропадал.
        return [
            // q — запасной слой для плохих каналов: у подвижной картинки (игры, видео) — до 30
            // к/с, иначе на 10 % потерь зритель получал 480×270 при ~9 к/с (прогон 2026-11-22).
            { rid: 'q', scaleResolutionDownBy: base * 4, maxBitrate: 400000, maxFramerate: Math.min(this.voiceScreenContentHint() === 'motion' ? 30 : 15, fps), priority: 'high' },
            { rid: 'h', scaleResolutionDownBy: base * 2, maxBitrate: bps(base * 2, midFps, 1000000, 12000000), maxFramerate: midFps },
            { rid: 'f', scaleResolutionDownBy: base, maxBitrate: top, maxFramerate: fps },
        ];
    }

    // Подсказка кодировщику, что за картинка. Без неё дорожка нативного захвата (генератор
    // кадров) и canvas идут как «камера»: ни режима демонстрации, ни правильного выбора, чем
    // жертвовать на узком канале. 60+ к/с выбирают ради плавности (игры, видео) — 'motion';
    // иначе текст и интерфейс — 'detail'.
    voiceScreenContentHint() {
        if (this.voice.screenActivity === 'browser') return 'motion';
        return (Number(this.voice.screenFps) || 30) >= 50 ? 'motion' : 'detail';
    }

    ensureVoiceSfuPublisher() {
        const sfu = this.sfuState();
        if (sfu.pub?.pc) return sfu.pub;
        const pc = new RTCPeerConnection(this.getVoiceRtcConfig());
        const pub = {
            pc,
            transceivers: { camera: null, screen: null, screen_audio: null },
            session: 0,
            inFlight: false,
            again: false,
            answerTimer: null,
            createdAt: Date.now(),
            connectedOnce: false,
        };
        pc.onconnectionstatechange = () => this.onVoiceSfuConnectionState('publish', pub);
        sfu.pub = pub;
        this.voiceTrace('sfu-publisher-create', { roomId: this.voice.roomId || '' });
        return pub;
    }

    // Публикует текущий набор источников: заводит/обновляет transceiver'ы и шлёт оффер.
    // Вызовы во время идущего согласования склеиваются в один повтор после ответа.
    async publishVoiceSfu() {
        if (!this.voiceVideoViaSfu() || !this.voice.roomId) return;
        const sfu = this.sfuState();
        const sources = this.voiceSfuLocalSources();
        if (!sources.length && !sfu.pub) return;
        const pub = this.ensureVoiceSfuPublisher();
        if (pub.inFlight) {
            pub.again = true;
            return;
        }
        pub.inFlight = true;
        pub.again = false;
        try {
            const active = new Set();
            for (const { kind, track, stream } of sources) {
                active.add(kind);
                let tr = pub.transceivers[kind];
                if (kind === 'screen') {
                    try { track.contentHint = this.voiceScreenContentHint(); } catch (e) {}
                }
                if (!tr) {
                    tr = this.addVoiceSfuTransceiver(pub.pc, kind, track, stream);
                    pub.transceivers[kind] = tr;
                } else {
                    if (tr.sender.track !== track) await tr.sender.replaceTrack(track);
                    try { tr.sender.setStreams?.(stream); } catch (e) {}
                    if (tr.direction !== 'sendonly') tr.direction = 'sendonly';
                    if (kind === 'screen') {
                        // Новая демонстрация может быть другого размера и частоты.
                        await this.applyVoiceSfuEncodings(tr.sender, this.voiceSfuScreenEncodings(track), kind);
                    }
                }
            }
            for (const [kind, tr] of Object.entries(pub.transceivers)) {
                if (!tr || active.has(kind)) continue;
                try { await tr.sender.replaceTrack(null); } catch (e) {}
                if (tr.direction !== 'inactive') tr.direction = 'inactive';
            }
            // Новый источник (камера/экран только что включены) — повод выбрать лучший кодек
            // заново; пересогласование уже идущего набора кодек не повышает.
            const newSource = sources.some(({ kind }) => !pub.published?.has(kind));
            if (!pub.codec || newSource || !this.voiceSfuCodecStillValid(pub.codec)) {
                pub.codec = this.voiceSfuChooseCodec();
            }
            pub.published = new Set(sources.map(({ kind }) => kind));
            this.preferVoiceSfuCodec(pub.pc, pub.codec);
            const offer = await pub.pc.createOffer();
            await pub.pc.setLocalDescription(offer);
            const mids = {};
            const layers = {};
            for (const [kind, tr] of Object.entries(pub.transceivers)) {
                if (!tr || !active.has(kind) || tr.mid == null) continue;
                mids[tr.mid] = kind;
                const px = this.voiceSfuLayerPixelRates(kind, tr);
                if (px) layers[tr.mid] = px;
            }
            this.voiceDiag('sfu-publish', { roomId: this.voice.roomId || '', codec: pub.codec, sources: JSON.stringify(mids) });
            // fresh — первый оффер этого RTCPeerConnection: живую старую сессию (страница
            // перезагружена) сервер не переиспользует, у неё чужие ключи DTLS.
            const fresh = !pub.offered;
            pub.offered = true;
            this.sendVoiceSfuEvent('voice_sfu_publish', { sdp: pub.pc.localDescription.sdp, sources: mids, layers, fresh });
            clearTimeout(pub.answerTimer);
            pub.answerTimer = setTimeout(() => this.onVoiceSfuAnswerTimeout(pub), 10000);
        } catch (error) {
            pub.inFlight = false;
            this.voiceDiag('sfu-publish-failed', { error: error?.message || String(error), name: error?.name || '' }, 'ERROR');
            this.noteVoiceSfuFailure('publish-error');
        }
    }

    // Пиксели в секунду каждого слоя (rid → ширина × высота × к/с): сервер не шлёт зрителю
    // слой тяжелее его декодера (voiceSfuMaxPixelRate).
    voiceSfuLayerPixelRates(kind, tr) {
        if (kind === 'screen_audio') return null;
        const track = tr.sender?.track;
        let size = kind === 'screen' ? this.voiceScreenTrackSize(track) : null;
        if (!size) {
            const st = track?.getSettings?.() || {};
            size = { width: Number(st.width) || 1280, height: Number(st.height) || 720 };
        }
        const defaultFps = kind === 'screen' ? (Number(this.voice.screenFps) || 30) : 30;
        let encodings = [];
        try { encodings = tr.sender.getParameters().encodings || []; } catch (e) {}
        const out = {};
        for (const enc of encodings) {
            const scale = Number(enc.scaleResolutionDownBy) || 1;
            const fps = Number(enc.maxFramerate) || defaultFps;
            out[enc.rid || '-'] = Math.round((size.width / scale) * (size.height / scale) * fps);
        }
        return Object.keys(out).length ? out : null;
    }

    // Сколько пикселей в секунду мы готовы декодировать. Телефону 4K60 не нужно (и
    // не по силам) — потолок 1080p60; компьютер берёт всё, что пролезет в канал.
    voiceSfuMaxPixelRate() {
        const mobile = !!(navigator.userAgentData?.mobile) || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '')
            || !!this.isMobileLayout?.();
        return mobile ? 1920 * 1080 * 60 : 0;
    }

    addVoiceSfuTransceiver(pc, kind, track, stream) {
        const init = { direction: 'sendonly', streams: [stream] };
        let encodings = null;
        if (kind === 'camera') encodings = ZaliInterface.SFU_CAMERA_LAYERS.map(l => ({ ...l }));
        if (kind === 'screen') encodings = this.voiceSfuScreenEncodings(track);
        if (encodings) {
            try {
                const tr = pc.addTransceiver(track, { ...init, sendEncodings: encodings });
                this.voiceTrace('sfu-transceiver', { kind, layers: encodings.length });
                return tr;
            } catch (error) {
                // Движок без simulcast — один слой с верхним потолком.
                this.voiceDiag('sfu-simulcast-unsupported', { kind, error: error?.message || String(error) }, 'WARN');
                const top = encodings[encodings.length - 1];
                return pc.addTransceiver(track, {
                    ...init,
                    sendEncodings: [{ maxBitrate: top.maxBitrate, scaleResolutionDownBy: top.scaleResolutionDownBy, maxFramerate: top.maxFramerate, ...(encodings[0].priority ? { priority: encodings[0].priority } : {}) }],
                });
            }
        }
        return pc.addTransceiver(track, init);
    }

    // Слои и чем жертвовать — после согласования (до него Chromium теряет параметры).
    async applyVoiceSfuEncodings(sender, layers, kind) {
        try {
            const params = sender.getParameters();
            if (!params.encodings?.length) return;
            if (layers && params.encodings.length === layers.length) {
                params.encodings.forEach((enc, i) => {
                    const l = layers[i];
                    enc.maxBitrate = l.maxBitrate;
                    enc.scaleResolutionDownBy = l.scaleResolutionDownBy;
                    if (l.maxFramerate) enc.maxFramerate = l.maxFramerate;
                    if (i === 0 && l.priority) enc.priority = l.priority;
                });
            } else if (layers && params.encodings.length === 1) {
                const top = layers[layers.length - 1];
                params.encodings[0].maxBitrate = top.maxBitrate;
                params.encodings[0].scaleResolutionDownBy = top.scaleResolutionDownBy;
                if (top.maxFramerate) params.encodings[0].maxFramerate = top.maxFramerate;
                if (layers[0].priority) params.encodings[0].priority = layers[0].priority;
            }
            if (kind === 'screen') {
                params.degradationPreference = this.voiceScreenContentHint() === 'motion' ? 'maintain-framerate' : 'maintain-resolution';
            } else if (kind === 'camera') {
                params.degradationPreference = 'balanced';
            }
            // AV1/VP9 с несколькими encodings без scalabilityMode Chromium кодирует в старом
            // SVC-режиме: уходит ОДИН поток с параметрами encodings[0] (слой q, 320×180), а
            // оценка канала отправителя, ограниченная 1,5 × отправленного, застревает на
            // ~0,8 Мбит/с — прогон 2026-11-22. 'L1T1' у каждого слоя включает настоящий
            // simulcast. Только для них: WebKit на scalabilityMode у H.264 может бросить.
            const codec = this.voice.sfu?.pub?.codec;
            const needMode = params.encodings.length > 1 && (codec === 'AV1' || codec === 'VP9');
            if (needMode) params.encodings.forEach(enc => { enc.scalabilityMode = 'L1T1'; });
            try {
                await sender.setParameters(params);
            } catch (error) {
                if (!needMode) throw error;
                this.voiceTrace('sfu-scalability-mode-rejected', { codec, error: error?.message || String(error) }, 'WARN');
                params.encodings.forEach(enc => { delete enc.scalabilityMode; });
                await sender.setParameters(params);
            }
        } catch (error) {
            this.voiceTrace('sfu-encodings-failed', { kind, error: error?.message || String(error) }, 'WARN');
        }
    }

    async onVoiceSfuPublishAnswer(payload = {}) {
        const pub = this.voice.sfu?.pub;
        if (!pub || String(payload.roomId || '') !== this.voice.roomId) return;
        clearTimeout(pub.answerTimer);
        pub.answerTimer = null;
        if (pub.pc.signalingState !== 'have-local-offer') {
            pub.inFlight = false;
            return;
        }
        try {
            const answerSdp = this.voiceSdpRaiseH264Level(
                this.voiceSdpPreferCodec(this.voiceSdpForPeer(String(payload.sdp || ''), this.voiceSfuStartKbps(pub)), pub.codec));
            await pub.pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
            const camera = pub.transceivers.camera;
            if (camera?.sender?.track) await this.applyVoiceSfuEncodings(camera.sender, ZaliInterface.SFU_CAMERA_LAYERS, 'camera');
            const screen = pub.transceivers.screen;
            if (screen?.sender?.track) await this.applyVoiceSfuEncodings(screen.sender, this.voiceSfuScreenEncodings(screen.sender.track), 'screen');
            this.armVoiceSfuConnectTimer(pub, 'publish');
        } catch (error) {
            this.voiceDiag('sfu-publish-answer-failed', { error: error?.message || String(error) }, 'ERROR');
            // Ответ от НОВОЙ сессии сервера к старому соединению (сервер её пересоздал):
            // соединение заводим заново.
            this.resetVoiceSfuPublisher();
            pub.again = true;
        } finally {
            pub.inFlight = false;
        }
        const current = this.voice.sfu?.pub;
        if (pub.again || (current && current !== pub)) {
            pub.again = false;
            await this.publishVoiceSfu();
        }
    }

    // Старт оценки канала до сервера. Первый участок — до дата-центра, а не до чужого
    // Wi-Fi: начинать с половины суммы верхних слоёв (до 10 Мбит/с), а не с 2,5, —
    // иначе 4K60 разгоняется до своих 40 Мбит/с десятки секунд. Перелёт оценка срежет.
    voiceSfuStartKbps(pub) {
        let total = 0;
        for (const tr of Object.values(pub.transceivers)) {
            if (!tr?.sender?.track) continue;
            try {
                const enc = tr.sender.getParameters().encodings || [];
                total += Math.max(0, ...enc.map(e => Number(e.maxBitrate) || 0));
            } catch (e) {}
        }
        return Math.max(ZaliInterface.VOICE_VIDEO_START_KBPS, Math.min(10000, Math.round(total / 2000)));
    }

    onVoiceSfuAnswerTimeout(pub) {
        if (this.voice.sfu?.pub !== pub || pub.pc.signalingState !== 'have-local-offer') return;
        this.voiceDiag('sfu-publish-answer-timeout', { roomId: this.voice.roomId || '' }, 'WARN');
        pub.inFlight = false;
        pub.publishTimeouts = (pub.publishTimeouts || 0) + 1;
        if (pub.publishTimeouts >= 2) {
            this.noteVoiceSfuFailure('publish-answer-timeout');
            return;
        }
        pub.pc.setLocalDescription({ type: 'rollback' }).catch(() => {}).finally(() => this.publishVoiceSfu());
    }

    resetVoiceSfuPublisher() {
        const sfu = this.sfuState();
        if (!sfu.pub) return;
        clearTimeout(sfu.pub.answerTimer);
        clearTimeout(sfu.pub.connectTimer);
        try { sfu.pub.pc.close(); } catch (e) {}
        sfu.pub = null;
    }

    resetVoiceSfuSubscriber() {
        const sfu = this.sfuState();
        if (!sfu.sub) return;
        clearTimeout(sfu.sub.connectTimer);
        try { sfu.sub.pc.close(); } catch (e) {}
        // Видео, пришедшее по этому соединению, снимаем: следующая подписка привезёт своё.
        for (const info of sfu.sub.tracks.values()) {
            if (info.source === 'camera') {
                const video = this.voice.remoteVideos.get(info.user);
                if (video?.srcObject && video.srcObject.__zaliSfu) {
                    try { video.pause?.(); video.srcObject = null; video.remove?.(); } catch (e) {}
                    this.voice.remoteVideos.delete(info.user);
                }
            } else if (info.source === 'screen') {
                const screen = this.voice.remoteScreens.get(info.user);
                if (screen?.srcObject?.__zaliSfu) this.detachRemoteScreenStream(info.user);
            }
        }
        sfu.sub = null;
        this.scheduleRenderVoicePanel();
    }

    ensureVoiceSfuSubscriber(session) {
        const sfu = this.sfuState();
        if (sfu.sub && sfu.sub.session && session && sfu.sub.session !== session) {
            // Сервер завёл новую сессию подписки — старое соединение к ней не подходит.
            this.resetVoiceSfuSubscriber();
        }
        if (sfu.sub?.pc) return sfu.sub;
        const pc = new RTCPeerConnection(this.getVoiceRtcConfig());
        const sub = {
            pc,
            session: Number(session) || 0,
            tracks: new Map(),
            chain: Promise.resolve(),
            createdAt: Date.now(),
            connectedOnce: false,
        };
        pc.onconnectionstatechange = () => this.onVoiceSfuConnectionState('subscribe', sub);
        pc.ontrack = (event) => this.onVoiceSfuTrack(sub, event);
        sfu.sub = sub;
        this.voiceTrace('sfu-subscriber-create', { roomId: this.voice.roomId || '', session: sub.session });
        return sub;
    }

    onVoiceSfuOffer(payload = {}) {
        if (String(payload.roomId || '') !== this.voice.roomId || !this.voiceVideoViaSfu()) return;
        const sub = this.ensureVoiceSfuSubscriber(Number(payload.session) || 0);
        sub.chain = sub.chain.then(() => this.applyVoiceSfuOffer(sub, payload)).catch(() => {});
    }

    async applyVoiceSfuOffer(sub, payload) {
        if (this.voice.sfu?.sub !== sub) return;
        const tracks = payload.tracks && typeof payload.tracks === 'object' ? payload.tracks : {};
        // Карта ДО setRemoteDescription: ontrack срабатывает внутри него.
        sub.tracks = new Map(Object.entries(tracks).map(([mid, info]) => [String(mid), {
            user: String(info?.user || ''),
            source: String(info?.source || ''),
        }]));
        try {
            await sub.pc.setRemoteDescription({ type: 'offer', sdp: String(payload.sdp || '') });
            const answer = await sub.pc.createAnswer();
            await sub.pc.setLocalDescription(answer);
            this.sendVoiceSfuEvent('voice_sfu_answer', { sdp: sub.pc.localDescription.sdp, rev: Number(payload.rev) || 0 });
            this.voiceTrace('sfu-subscribe-answer', { rev: Number(payload.rev) || 0, tracks: sub.tracks.size });
            this.armVoiceSfuConnectTimer(sub, 'subscribe');
            // Переназначение после пересогласования: дорожка, чей mid ушёл из карты, снята.
            this.syncVoiceSfuRemoteTracks(sub);
        } catch (error) {
            this.voiceDiag('sfu-subscribe-offer-failed', { error: error?.message || String(error), name: error?.name || '' }, 'ERROR');
            this.resetVoiceSfuSubscriber();
            this.sfuState().joined = true;
            this.sendVoiceSfuEvent('voice_sfu_join', { reset: true, maxPixelRate: this.voiceSfuMaxPixelRate() });
        }
    }

    onVoiceSfuTrack(sub, event) {
        const mid = String(event.transceiver?.mid ?? '');
        const info = sub.tracks.get(mid);
        const track = event.track;
        const stream = event.streams?.[0] || new MediaStream([track]);
        stream.__zaliSfu = true;
        if (!info?.user) {
            this.voiceTrace('sfu-track-unmapped', { mid, kind: track?.kind || '' }, 'WARN');
            return;
        }
        this.voiceTrace('sfu-track', { mid, user: info.user, source: info.source, kind: track?.kind || '', streamId: stream.id });
        const refresh = () => {
            if (this.voice.sfu?.sub !== sub) return;
            if (info.source === 'camera') this.attachRemoteVideoStream(info.user, stream);
        };
        if (track) {
            track.onmute = refresh;
            track.onunmute = refresh;
            track.onended = refresh;
        }
        if (info.source === 'camera') {
            this.attachRemoteVideoStream(info.user, stream);
        } else if (info.source === 'screen' || info.source === 'screen_audio') {
            this.attachRemoteScreenStream(info.user, this.mergeVoiceSfuScreenTrack(sub, info.user, track) || stream);
        }
    }

    // Картинка и звук экрана одного человека могут прийти от разных серверных сессий
    // (картинку шлёт издатель оболочки, звук — страница) и в разных потоках, а плитка у
    // человека одна: последний пришедший поток подменял srcObject — чёрная плитка со звуком
    // или картинка без звука. Сервер ставит им общий msid, но держим и здесь: один
    // MediaStream на человека, по дорожке каждого вида (новая заменяет старую).
    mergeVoiceSfuScreenTrack(sub, user, track) {
        if (!track || typeof MediaStream !== 'function') return null;
        const map = sub.screenStreams || (sub.screenStreams = new Map());
        let merged = map.get(user);
        if (!merged) {
            merged = new MediaStream();
            merged.__zaliSfu = true;
            map.set(user, merged);
        }
        for (const old of merged.getTracks()) {
            if (old !== track && (old.kind === track.kind || old.readyState === 'ended')) merged.removeTrack(old);
        }
        if (!merged.getTracks().includes(track)) merged.addTrack(track);
        return merged;
    }

    // Камера, чей mid пропал из карты подписки (собеседник её выключил), убирается сразу,
    // не дожидаясь событий дорожки.
    syncVoiceSfuRemoteTracks(sub) {
        const cameraUsers = new Set();
        const screenUsers = new Set();
        for (const info of sub.tracks.values()) {
            if (info.source === 'camera') cameraUsers.add(info.user);
            if (info.source === 'screen') screenUsers.add(info.user);
        }
        for (const [user, video] of Array.from(this.voice.remoteVideos.entries())) {
            if (video?.srcObject?.__zaliSfu && !cameraUsers.has(user)) {
                try { video.pause?.(); video.srcObject = null; video.remove?.(); } catch (e) {}
                this.voice.remoteVideos.delete(user);
                this.scheduleRenderVoicePanel();
            }
        }
        for (const [user, video] of Array.from(this.voice.remoteScreens.entries())) {
            if (video?.srcObject?.__zaliSfu && !screenUsers.has(user)) this.detachRemoteScreenStream(user);
        }
        for (const user of Array.from(sub.screenStreams?.keys() || [])) {
            if (!screenUsers.has(user)) sub.screenStreams.delete(user);
        }
    }

    armVoiceSfuConnectTimer(conn, role) {
        if (conn.connectedOnce || conn.connectTimer) return;
        conn.connectTimer = setTimeout(() => {
            conn.connectTimer = null;
            const sfu = this.voice.sfu;
            const current = role === 'publish' ? sfu?.pub : sfu?.sub;
            if (current !== conn || conn.connectedOnce) return;
            this.voiceDiag('sfu-connect-timeout', { role, state: conn.pc.connectionState, ice: conn.pc.iceConnectionState }, 'WARN');
            this.noteVoiceSfuFailure(`${role}-connect-timeout`);
        }, ZaliInterface.SFU_CONNECT_TIMEOUT_MS);
    }

    onVoiceSfuConnectionState(role, conn) {
        const sfu = this.voice.sfu;
        const current = role === 'publish' ? sfu?.pub : sfu?.sub;
        if (current !== conn) return;
        const state = conn.pc.connectionState;
        this.voiceDiag('sfu-pc-state', { role, state, ice: conn.pc.iceConnectionState }, state === 'failed' ? 'ERROR' : 'INFO');
        if (state === 'connected') {
            conn.connectedOnce = true;
            clearTimeout(conn.connectTimer);
            conn.connectTimer = null;
            sfu.failures = 0;
            return;
        }
        if (state === 'failed') {
            // Было соединение и порвалось (смена сети, рестарт сервера) — поднимаем заново;
            // не подключилось ни разу — SFU с этой сети недоступен.
            if (!conn.connectedOnce) {
                this.noteVoiceSfuFailure(`${role}-failed`);
                return;
            }
            this.recoverVoiceSfu(role);
        }
    }

    recoverVoiceSfu(role) {
        const sfu = this.sfuState();
        sfu.failures += 1;
        if (sfu.failures > 3) {
            this.noteVoiceSfuFailure(`${role}-recover-exhausted`);
            return;
        }
        this.voiceDiag('sfu-recover', { role, attempt: sfu.failures }, 'WARN');
        if (role === 'publish') {
            this.resetVoiceSfuPublisher();
            void this.publishVoiceSfu();
        } else {
            this.resetVoiceSfuSubscriber();
            sfu.joined = true;
            this.sendVoiceSfuEvent('voice_sfu_join', { reset: true, maxPixelRate: this.voiceSfuMaxPixelRate() });
        }
    }

    // Сервер потерял нашу сессию (разрыв ICE дольше 8 с) — поднимаем её заново.
    onVoiceSfuClosed(payload = {}) {
        if (String(payload.roomId || '') !== this.voice.roomId || !this.voiceVideoViaSfu()) return;
        if (payload.slot === 'native') {
            this.failVoiceNativeSfuScreen('server-closed');
            return;
        }
        this.recoverVoiceSfu(payload.role === 'publish' ? 'publish' : 'subscribe');
    }

    onVoiceSfuError(payload = {}) {
        if (String(payload.roomId || '') !== this.voice.roomId) return;
        const code = String(payload.code || '');
        this.voiceDiag('sfu-error', { code, slot: String(payload.slot || ''), message: String(payload.message || '') }, 'WARN');
        // Слот издателя оболочки: не принят его оффер — откат только экрана, сам SFU живой.
        if (payload.slot === 'native') {
            if (code === 'bad_offer') this.failVoiceNativeSfuScreen('bad-offer');
            return;
        }
        if (code === 'bad_offer') {
            const pub = this.voice.sfu?.pub;
            if (pub) pub.inFlight = false;
            this.noteVoiceSfuFailure('bad-offer');
        }
        // room_mesh / sfu_disabled: сервер пришлёт voice_room_state с mesh — ждём его.
    }

    // SFU с этой сети не работает: говорим серверу, комната уйдёт в mesh (для всех, пока
    // мы в ней) — иначе нас никто не увидит, а мы никого.
    noteVoiceSfuFailure(reason) {
        const sfu = this.sfuState();
        if (sfu.reported || !this.voiceVideoViaSfu()) return;
        sfu.reported = true;
        this.voiceDiag('sfu-unavailable', { reason, roomId: this.voice.roomId || '' }, 'ERROR');
        this.sendVoiceSfuEvent('voice_sfu_failed', { reason });
    }

    teardownVoiceSfu({ announce = false } = {}) {
        const sfu = this.voice.sfu;
        if (!sfu) return;
        if (announce && sfu.joined && sfu.roomId) {
            this.sendVoiceEvent({ type: 'voice_sfu_leave', roomId: sfu.roomId });
        }
        this.resetVoiceSfuPublisher();
        this.resetVoiceSfuSubscriber();
        clearInterval(sfu.healthTimer);
        if (sfu.nativeScreen) clearTimeout(sfu.nativeScreen.answerTimer);
        this.voice.sfu = null;
    }

    // ---------------- экран из оболочки прямо на SFU ----------------
    //
    // Экран снимает и сжимает оболочка (macOS — VideoToolbox, Windows — Media Foundation,
    // Android — MediaCodec). Раньше кадры шли в WebView, распаковывались в дорожку и WebRTC
    // сжимал их второй раз. Теперь оболочка кодирует слои simulcast сама, издатель в
    // Rust-ядре (core/src/sfu_publisher.rs) шлёт их на SFU в отдельный слот пользователя
    // (`slot: "native"`), а странице приходит только слой для превью. Сигналинг — здесь:
    // оффер из ответа `started`, ответ сервера — обратно в оболочку (`sfu_answer`). Любой
    // сбой — откат на прежний путь через WebRTC страницы: перезапуском демонстрации, а на
    // Android (`inPlace`) — превью этого же захвата, без нового окна согласия.

    voiceNativeSfuScreenAvailable() {
        if (!this.nativeSupports?.('nativeSfuScreen') || !this.voiceVideoViaSfu() || !this.voice.roomId) return false;
        return !(this.sfuState().nativeScreenFailures >= 2);
    }

    // Слои для оболочки — те же, что у браузерного simulcast (voiceSfuScreenEncodings), но
    // в долях от кадра захвата: его размер знает только оболочка (потолок — maxSide).
    voiceNativeSfuScreenSpec(fps) {
        const rate = Math.max(15, Math.min(240, Number(fps) || 30));
        const midFps = Math.min(60, rate);
        const bpp = ZaliInterface.SFU_BITS_PER_PIXEL;
        const motion = rate >= 50;
        return {
            // Оболочка берёт первый кодек списка, который кодирует аппаратно (H.264 — всегда),
            // и называет его в started.sfu.codec. previewDecode — что страница декодирует
            // сама: превью слоем, сжатым оболочкой (macOS, Android), только в этих кодеках.
            codecs: this.voiceNativeSfuScreenCodecs(),
            previewDecode: this._voiceCodecCaps?.preview || ['H264'],
            maxSide: ZaliInterface.SFU_SCREEN_MAX_SIDE,
            // Превью своего экрана — средний слой: нижний (¼) на плитке мылит текст.
            previewLayer: 1,
            startBitrate: 2500000,
            layers: [
                { rid: 'q', scale: 4, fps: Math.min(motion ? 30 : 15, rate), bpp, minBps: 150000, maxBps: 400000 },
                { rid: 'h', scale: 2, fps: midFps, bpp, minBps: 1000000, maxBps: 12000000 },
                { rid: 'f', scale: 1, fps: rate, bpp, minBps: 2500000, maxBps: ZaliInterface.SFU_SCREEN_MAX_BPS },
            ],
        };
    }

    // Кодеки нативной демонстрации, лучший первым: из SFU_CODEC_ORDER те, что декодируют все
    // в комнате (тот же критерий, что у публикации страницы, voiceSfuCodecStillValid), без
    // VP8 — его оболочки не кодируют. Кодирует ли оболочка аппаратно, решает она сама.
    // H.264 — последним и всегда: пол, который тянут все.
    voiceNativeSfuScreenCodecs() {
        const list = ZaliInterface.SFU_CODEC_ORDER
            .filter(c => c !== 'VP8' && c !== 'H264' && ZaliInterface.SFU_CODECS_VERIFIED.includes(c))
            .filter(c => this.voiceSfuCodecStillValid(c));
        list.push('H264');
        return list;
    }

    // Строки для проверки декодера превью (VideoDecoder.isConfigSupported). Точные профиль
    // и уровень оболочка сообщит в started.codec; здесь — типовые для экрана.
    static get NATIVE_PREVIEW_CODEC_STRINGS() {
        return { H264: 'avc1.640028', H265: 'hvc1.1.6.L120.B0', AV1: 'av01.0.08M.08' };
    }

    startVoiceNativeSfuScreen(stream, info, { inPlace = false } = {}) {
        const sfu = this.sfuState();
        const layers = Array.isArray(info?.layers) ? info.layers : [];
        if (!stream || !info?.sdp || !info?.mid || !layers.length) return false;
        // Старая оболочка кодека не называет — это H.264.
        const codec = String(info.codec || 'H264').toUpperCase();
        sfu.nativeScreen = { stream, sdp: String(info.sdp), mid: String(info.mid), layers, codec, state: 'offer', answerTimer: null, startedAt: Date.now(), inPlace: !!inPlace };
        this.voice.screenViaNativeSfu = true;
        this.voiceTrace('sfu-native-screen-start', {
            stream,
            codec,
            layers: layers.map(l => `${l.rid}:${l.width}x${l.height}@${l.fps}`).join(','),
        });
        this.sendVoiceNativeSfuScreenOffer();
        return true;
    }

    sendVoiceNativeSfuScreenOffer() {
        const ns = this.voice.sfu?.nativeScreen;
        if (!ns) return;
        const pixels = {};
        for (const l of ns.layers) pixels[String(l.rid)] = (Number(l.width) || 0) * (Number(l.height) || 0) * (Number(l.fps) || 0);
        ns.state = 'offer';
        clearTimeout(ns.answerTimer);
        ns.answerTimer = setTimeout(() => {
            if (this.voice.sfu?.nativeScreen === ns && ns.state === 'offer') this.failVoiceNativeSfuScreen('answer-timeout');
        }, 10000);
        // Издатель оболочки каждый раз новый (свой str0m) — сессию слота не переиспользовать.
        this.sendVoiceSfuEvent('voice_sfu_publish', { slot: 'native', sdp: ns.sdp, sources: { [ns.mid]: 'screen' }, layers: { [ns.mid]: pixels }, fresh: true });
    }

    async onVoiceSfuNativeAnswer(payload = {}) {
        const ns = this.voice.sfu?.nativeScreen;
        if (!ns || String(payload.roomId || '') !== this.voice.roomId || ns.state !== 'offer') return;
        clearTimeout(ns.answerTimer);
        ns.state = 'answered';
        try {
            await this.nativeMediaRequest('sfu_answer', { stream: ns.stream, options: { sdp: String(payload.sdp || '') } }, 5000);
            // Не соединился за 15 с — оболочка сама пришлёт closed/connect_timeout.
        } catch (error) {
            this.voiceDiag('sfu-native-answer-failed', { error: error?.message || String(error) }, 'WARN');
            this.failVoiceNativeSfuScreen('answer-relay');
        }
    }

    // События издателя оболочки (`media_event` с event: 'sfu').
    onNativeSfuEvent(stream, ev = {}) {
        const ns = this.voice.sfu?.nativeScreen;
        if (!ns || ns.stream !== stream) return;
        const kind = String(ev.event || '');
        if (kind === 'connected') {
            ns.state = 'connected';
            this.sfuState().nativeScreenFailures = 0;
            this.voiceTrace('sfu-native-screen-connected', { stream, ms: Date.now() - ns.startedAt });
        } else if (kind === 'closed') {
            if (ev.reason !== 'local') this.failVoiceNativeSfuScreen(String(ev.reason || 'closed'));
        } else if (kind === 'bitrates') {
            ns.bitrates = ev.bitrates;
            this.voiceTrace('sfu-native-screen-bitrates', { kbps: (ev.bitrates || []).map(b => Math.round(b / 1000)).join('/'), estimate: Math.round((Number(ev.estimate) || 0) / 1000) });
        } else if (kind === 'stats') {
            // Раз в 2 с от ядра; в журнал — раз в 10 с.
            ns.stats = ev;
            if (Date.now() - (ns.statsLoggedAt || 0) >= 10000) {
                ns.statsLoggedAt = Date.now();
                this.voiceDiag('sfu-native-screen-stats', {
                    codec: ev.codec || ns.codec, estimate: ev.estimate_kbps, alloc: (ev.alloc_kbps || []).join('/'), sent: (ev.sent_kbps || []).join('/'), wire: ev.wire_kbps, dropped: ev.dropped, connected: ev.connected,
                }, ev.connected ? 'INFO' : 'WARN');
            }
        } else if (kind === 'state' || kind === 'warn') {
            this.voiceTrace('sfu-native-screen-' + kind, { state: ev.state || '', message: ev.message || '' }, 'WARN');
        }
    }

    // Демонстрация кончилась (или уходит на прежний путь): снять слот на сервере.
    stopVoiceNativeSfuScreen() {
        const sfu = this.voice.sfu;
        const ns = sfu?.nativeScreen;
        this.voice.screenViaNativeSfu = false;
        if (!ns) return;
        clearTimeout(ns.answerTimer);
        sfu.nativeScreen = null;
        this.sendVoiceSfuEvent('voice_sfu_unpublish', { slot: 'native' });
    }

    // Издатель оболочки не смог (UDP закрыт, сервер закрыл сессию, нет ответа): та же
    // демонстрация заново — после двух сбоев за звонок прежним путём через WebRTC страницы.
    failVoiceNativeSfuScreen(reason) {
        const sfu = this.voice.sfu;
        const ns = sfu?.nativeScreen;
        if (!ns || ns.failing) return;
        ns.failing = true;
        sfu.nativeScreenFailures = (sfu.nativeScreenFailures || 0) + 1;
        this.voiceDiag('sfu-native-screen-failed', { reason, failures: sfu.nativeScreenFailures, state: ns.state, inPlace: ns.inPlace }, 'WARN');
        if (ns.inPlace) {
            this.fallbackVoiceNativeSfuScreenInPlace(reason);
            return;
        }
        void this.restartVoiceScreenShare('native-sfu-' + reason);
    }

    // Без перезапуска захвата: слот оболочки снят, дорожка превью уходит обычной публикацией
    // страницы. Оболочке — `sfu_fallback`: остальные слои она больше не кодирует.
    fallbackVoiceNativeSfuScreenInPlace(reason) {
        const ns = this.voice.sfu?.nativeScreen;
        const stream = ns?.stream;
        this.stopVoiceNativeSfuScreen();
        this.voiceTrace('sfu-native-screen-in-place', { reason, stream });
        if (stream) void this.nativeMediaRequest?.('sfu_fallback', { stream }, 5000).catch(() => {});
        if (this.voice.screenSharing && this.voiceVideoViaSfu()) void this.publishVoiceSfu();
    }

    // Два плохих замера подряд (20 с) — кодек выбывает: гистерезис, чтобы одна пауза
    // процессора не гоняла поток между кодеками. Отправитель: упёрся в процессор или
    // кодирует кадр дольше, чем есть на кадр (≤ 16 мс; на 120 к/с — 8). Зритель:
    // декодер не аппаратный или роняет/замораживает кадры.
    checkVoiceSfuCodecHealth(encodeChecks, decodeChecks) {
        const sfu = this.voice.sfu;
        if (!sfu) return;
        const strikes = sfu.codecStrikes || (sfu.codecStrikes = { encode: {}, decode: {} });
        const judge = (side, codec, bad, reason) => {
            if (!codec || codec === 'H264') return false;
            strikes[side][codec] = bad ? (strikes[side][codec] || 0) + 1 : 0;
            if (strikes[side][codec] < 2) return false;
            strikes[side][codec] = 0;
            return this.banVoiceCodec(side, codec, reason);
        };
        let republish = false;
        const encWorst = {};
        for (const c of encodeChecks) {
            const budget = Math.min(16, 1000 / Math.max(30, c.fps || 30));
            const bad = c.limit === 'cpu' || c.ms > budget || c.efficient === false;
            encWorst[c.codec] = encWorst[c.codec] || bad;
            if (bad) this.voiceTrace('sfu-encode-slow', { codec: c.codec, ms: Math.round(c.ms * 10) / 10, budget, limit: c.limit, efficient: c.efficient }, 'WARN');
        }
        for (const [codec, bad] of Object.entries(encWorst)) {
            if (judge('encode', codec, bad, 'cpu/encode-time')) republish = true;
        }
        const decWorst = {};
        for (const c of decodeChecks) {
            const dropRate = c.recv > 0 ? c.dropped / c.recv : 0;
            const bad = c.efficient === false || dropRate > 0.15 || c.freezes > 1;
            decWorst[c.codec] = decWorst[c.codec] || bad;
        }
        let announce = false;
        for (const [codec, bad] of Object.entries(decWorst)) {
            if (judge('decode', codec, bad, 'drops/freezes/software')) announce = true;
        }
        // Свой список декодеров ушёл — сообщаем серверу сразу, отправители перейдут на общий.
        if (announce) this.sendVoiceRoomPresence();
        if (republish) void this.publishVoiceSfu();
    }

    // Always-on телеметрия SFU в журнал звонка: какие слои уходят на сервер и что
    // приходит от него — разрешение, частота, битрейт, фризы, чем ограничено качество.
    ensureVoiceSfuHealth() {
        const sfu = this.sfuState();
        if (sfu.healthTimer) return;
        sfu.healthTimer = setInterval(() => { void this.reportVoiceSfuHealth(); }, 10000);
    }

    async reportVoiceSfuHealth() {
        const sfu = this.voice.sfu;
        if (!sfu) return;
        const prev = sfu.lastStats || new Map();
        const next = new Map();
        const now = Date.now();
        const kbps = (key, bytes) => {
            const p = prev.get(key);
            next.set(key, { bytes, at: now });
            if (!p || now <= p.at) return 0;
            return Math.round(((bytes - p.bytes) * 8) / (now - p.at));
        };
        const out = [];
        const inbound = [];
        const encodeChecks = [];
        const decodeChecks = [];
        const delta = (key, value) => {
            const p = prev.get(key);
            next.set(key, { bytes: value, at: now });
            return p ? value - p.bytes : null;
        };
        const codecName = (stats, r) => String(stats.get(r.codecId)?.mimeType || '').replace(/^video\//i, '').toUpperCase();
        // Через что идёт соединение с сервером: udp, или tcp — запасной путь, когда UDP
        // закрыт (ICE-TCP, sfu.rs). На TCP потери превращаются в задержку.
        const transportOf = (stats) => {
            let proto = '';
            stats.forEach(r => {
                if (r.type === 'candidate-pair' && (r.nominated || r.selected) && r.state === 'succeeded') {
                    proto = String(stats.get(r.localCandidateId)?.protocol || '');
                }
            });
            return proto;
        };
        const transport = {};
        try {
            if (sfu.pub?.pc) {
                const stats = await sfu.pub.pc.getStats();
                transport.pub = transportOf(stats);
                stats.forEach(r => {
                    if (r.type !== 'outbound-rtp' || r.kind !== 'video') return;
                    const frames = delta(`of:${r.id}`, r.framesEncoded || 0);
                    const encSec = delta(`oe:${r.id}`, r.totalEncodeTime || 0);
                    if (frames > 0 && encSec !== null) {
                        encodeChecks.push({
                            codec: codecName(stats, r),
                            ms: (encSec * 1000) / frames,
                            fps: r.framesPerSecond || 0,
                            limit: r.qualityLimitationReason || '',
                            efficient: r.powerEfficientEncoder,
                        });
                    }
                    out.push({
                        rid: r.rid || '-',
                        res: r.frameWidth ? `${r.frameWidth}x${r.frameHeight}` : '',
                        fps: Math.round(r.framesPerSecond || 0),
                        kbps: kbps(`o:${r.id}`, r.bytesSent || 0),
                        limit: r.qualityLimitationReason || '',
                        enc: r.encoderImplementation || '',
                    });
                });
            }
            if (sfu.sub?.pc) {
                const stats = await sfu.sub.pc.getStats();
                transport.sub = transportOf(stats);
                stats.forEach(r => {
                    if (r.type !== 'inbound-rtp' || r.kind !== 'video') return;
                    const info = sfu.sub.tracks.get(String(r.mid ?? '')) || {};
                    const recv = delta(`ir:${r.id}`, r.framesReceived || 0);
                    const dropped = delta(`id:${r.id}`, r.framesDropped || 0);
                    const freezes = delta(`if:${r.id}`, r.freezeCount || 0);
                    if (recv !== null) {
                        decodeChecks.push({
                            codec: codecName(stats, r),
                            recv, dropped: dropped || 0, freezes: freezes || 0,
                            efficient: r.powerEfficientDecoder,
                        });
                    }
                    inbound.push({
                        from: info.user || '?',
                        src: info.source || '?',
                        res: r.frameWidth ? `${r.frameWidth}x${r.frameHeight}` : '',
                        fps: Math.round(r.framesPerSecond || 0),
                        kbps: kbps(`i:${r.id}`, r.bytesReceived || 0),
                        lost: r.packetsLost || 0,
                        freezes: r.freezeCount || 0,
                        dec: r.decoderImplementation || '',
                    });
                });
            }
        } catch (e) {
            return;
        }
        sfu.lastStats = next;
        this.checkVoiceSfuCodecHealth(encodeChecks, decodeChecks);
        if (!out.length && !inbound.length) return;
        this.voiceDiag('sfu-health', {
            out: out.map(o => `${o.rid}:${o.res}@${o.fps}:${o.kbps}k${o.limit && o.limit !== 'none' ? `:${o.limit}` : ''}${o.enc ? `:${o.enc}` : ''}`).join(' '),
            in: inbound.map(i => `${i.from}/${i.src}:${i.res}@${i.fps}:${i.kbps}k:lost${i.lost}:frz${i.freezes}${i.dec ? `:${i.dec}` : ''}`).join(' '),
            via: `${transport.pub || '-'}/${transport.sub || '-'}`,
        });
    }
});
