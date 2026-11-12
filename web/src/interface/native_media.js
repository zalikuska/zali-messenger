// --- ZaliInterface: нативный захват микрофона, камеры и экрана (macOS, Windows). ---
// Часть класса ZaliInterface (см. web/src/interface.js).
//
// Зачем. WebKit на macOS захватывает микрофон только через системный VoiceProcessingIO:
// на каждый вход в звонок он приглушает звук всех остальных приложений (до −15 дБ) и
// пересобирает аудиоустройство — звук во всей системе заикается. Поэтому на десктопе
// устройства открывает оболочка: микрофон обычным HAL/WASAPI-вводом с нашей обработкой
// (core/src/audio_processing.rs: AEC3 → RNNoise → AGC2), камеру и экран — системными
// API со своим окном выбора. Страница получает кадры и делает из них MediaStreamTrack,
// а дальше всё идёт по обычным путям voice_*.js (attach/renegotiate не меняются).
//
// Управление — JSON-мост: MEDIA_REQUEST {op, requestId, stream, kind, deviceId,
// sourceId, options} туда, событие шины `media_event` {event, requestId?, stream?, …}
// обратно. Данные — НЕ через JSON-мост, а бинарными кадрами:
//   * macOS — WebSocket на 127.0.0.1 (window.__ZALI_MEDIA_BRIDGE = {kind:'websocket',
//     url, token}); первым сообщением страница шлёт {"hello": token}, оболочка проверяет
//     его и Origin, второе соединение не принимает. Токен в URL не кладётся.
//   * Windows — общая память WebView2 (PostSharedBufferToScript,
//     __ZALI_MEDIA_BRIDGE = {kind:'sharedbuffer'}), кадры без копирования.
//
// Формат кадра (little-endian), 32 байта заголовка + данные:
//   0 u8  0x5A        4 u32 stream      16 u16 width    21 u8  channels
//   1 u8  версия = 1  8 u64 ts, мкс     18 u16 height   22 u16 резерв
//   2 u8  вид: 1 звук, 2 видео          20 u8  флаги (бит 0 — ключевой кадр)
//   3 u8  кодек: звук 1 = f32 PCM 48 кГц; видео 1 = H.264 Annex B, 2 = NV12
//   24 u32 длина данных  28 u32 номер кадра
//
// Приёмники:
//   * Chromium (WebView2): MediaStreamTrackGenerator — AudioData и VideoFrame(NV12).
//   * WebKit: звук — AudioWorklet с кольцевым буфером → MediaStreamAudioDestinationNode;
//     видео — H.264 → VideoDecoder → VideoTrackGenerator в воркере, иначе canvas.
//
// Любой отказ нативного пути — повод вернуться к getUserMedia/getDisplayMedia (это
// решают вызывающие в voice_media.js), а не ошибка звонка.

const ZALI_MEDIA_MAGIC = 0x5a;
const ZALI_MEDIA_HEADER = 32;
const ZALI_MEDIA_KIND_AUDIO = 1;
const ZALI_MEDIA_KIND_VIDEO = 2;
const ZALI_MEDIA_CODEC_PCM_F32 = 1;
const ZALI_MEDIA_CODEC_H264 = 1;
const ZALI_MEDIA_CODEC_NV12 = 2;

/** Разбор заголовка кадра. `bytes` — Uint8Array с кадром целиком. */
function zaliParseMediaFrame(bytes) {
    if (!bytes || bytes.byteLength < ZALI_MEDIA_HEADER) return null;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (dv.getUint8(0) !== ZALI_MEDIA_MAGIC || dv.getUint8(1) !== 1) return null;
    const length = dv.getUint32(24, true);
    if (ZALI_MEDIA_HEADER + length > bytes.byteLength) return null;
    return {
        kind: dv.getUint8(2),
        codec: dv.getUint8(3),
        stream: dv.getUint32(4, true),
        timestamp: Number(dv.getBigUint64(8, true)),
        width: dv.getUint16(16, true),
        height: dv.getUint16(18, true),
        keyframe: (dv.getUint8(20) & 1) === 1,
        channels: dv.getUint8(21) || 1,
        seq: dv.getUint32(28, true),
        payload: bytes.subarray(ZALI_MEDIA_HEADER, ZALI_MEDIA_HEADER + length),
    };
}

/** Кодирование кадра — нужно тестам (FakeTransport) и для симметрии формата. */
function zaliEncodeMediaFrame({ kind, codec, stream, timestamp = 0, width = 0, height = 0, keyframe = false, channels = 1, seq = 0, payload }) {
    const data = payload instanceof Uint8Array ? payload : new Uint8Array(payload.buffer || payload);
    const out = new Uint8Array(ZALI_MEDIA_HEADER + data.byteLength);
    const dv = new DataView(out.buffer);
    dv.setUint8(0, ZALI_MEDIA_MAGIC);
    dv.setUint8(1, 1);
    dv.setUint8(2, kind);
    dv.setUint8(3, codec);
    dv.setUint32(4, stream, true);
    dv.setBigUint64(8, BigInt(Math.max(0, Math.floor(timestamp))), true);
    dv.setUint16(16, width, true);
    dv.setUint16(18, height, true);
    dv.setUint8(20, keyframe ? 1 : 0);
    dv.setUint8(21, channels);
    dv.setUint32(24, data.byteLength, true);
    dv.setUint32(28, seq >>> 0, true);
    out.set(data, ZALI_MEDIA_HEADER);
    return out;
}

// Кольцевой буфер в AudioWorklet: кадры приходят пачками по 10 мс из сети/IPC, а
// рендер тянет по 128 отсчётов. Держим 20–80 мс: меньше — щелчки на недоборе, больше —
// лишняя задержка в звонке. При переполнении выкидываем старое, при недоборе — тишина.
const ZALI_AUDIO_RING_WORKLET = `
class ZaliNativeAudioRing extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(48000);
    this.read = 0; this.write = 0; this.size = 0; this.primed = false;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (!(d instanceof Float32Array)) return;
      const cap = this.buf.length;
      if (this.size + d.length > 3840) { const drop = this.size + d.length - 1920; this.read = (this.read + drop) % cap; this.size -= drop; }
      for (let i = 0; i < d.length; i++) { this.buf[this.write] = d[i]; this.write = (this.write + 1) % cap; }
      this.size += d.length;
      if (this.size >= 960) this.primed = true;
    };
  }
  process(inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    if (!this.primed) { out.fill(0); return true; }
    const n = Math.min(out.length, this.size);
    for (let i = 0; i < n; i++) { out[i] = this.buf[this.read]; this.read = (this.read + 1) % this.buf.length; }
    for (let i = n; i < out.length; i++) out[i] = 0;
    this.size -= n;
    if (this.size === 0) this.primed = false;
    return true;
  }
}
registerProcessor('zali-native-audio-ring', ZaliNativeAudioRing);
`;

// Воркер с VideoTrackGenerator (WebKit: генератор живёт только в воркере, его дорожка
// передаётся в основной поток). Кадры приходят сюда уже декодированными.
const ZALI_VIDEO_GENERATOR_WORKER = `
let writer = null;
self.onmessage = async (e) => {
  const d = e.data || {};
  if (d.op === 'start') {
    try {
      const g = new VideoTrackGenerator();
      writer = g.writable.getWriter();
      self.postMessage({ op: 'track', track: g.track }, [g.track]);
    } catch (err) { self.postMessage({ op: 'error', error: String(err && err.message || err) }); }
  } else if (d.op === 'frame' && d.frame) {
    if (!writer) { d.frame.close(); return; }
    try { await writer.write(d.frame); } catch (err) {}
    try { d.frame.close(); } catch (err) {}
  } else if (d.op === 'stop') {
    try { await writer?.close(); } catch (err) {}
    writer = null;
  }
};
`;

class ZaliNativeAudioSink {
    constructor(onFirstFrame) {
        this.onFirstFrame = onFirstFrame;
        this.track = null;
        this.generator = null;
        this.writer = null;
        this.ctx = null;
        this.node = null;
        this.ready = null;
        this.frames = 0;
        this.closed = false;
    }

    static available() {
        return typeof MediaStreamTrackGenerator === 'function'
            || (typeof AudioWorkletNode === 'function' && !!(window.AudioContext || window.webkitAudioContext));
    }

    /** Готовит дорожку. Возвращает промис, который всегда завершается. */
    start() {
        if (this.ready) return this.ready;
        this.ready = (async () => {
            if (typeof MediaStreamTrackGenerator === 'function') {
                this.generator = new MediaStreamTrackGenerator({ kind: 'audio' });
                this.writer = this.generator.writable.getWriter();
                this.track = this.generator;
                return true;
            }
            const Ctx = window.AudioContext || window.webkitAudioContext;
            this.ctx = new Ctx({ sampleRate: 48000, latencyHint: 'interactive' });
            const url = URL.createObjectURL(new Blob([ZALI_AUDIO_RING_WORKLET], { type: 'text/javascript' }));
            try {
                await Promise.race([
                    this.ctx.audioWorklet.addModule(url),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('audioWorklet.addModule timeout')), 4000)),
                ]);
            } finally {
                URL.revokeObjectURL(url);
            }
            this.node = new AudioWorkletNode(this.ctx, 'zali-native-audio-ring', { numberOfInputs: 0, outputChannelCount: [1] });
            const dest = this.ctx.createMediaStreamDestination();
            this.node.connect(dest);
            this.track = dest.stream.getAudioTracks()[0] || null;
            // WebKit может никогда не разрешить resume() — ждём не дольше 1.5 с
            // (см. resumeVoiceAudioContext в voice_media.js).
            if (this.ctx.state !== 'running') {
                await Promise.race([this.ctx.resume().catch(() => {}), new Promise(r => setTimeout(r, 1500))]);
            }
            return !!this.track;
        })();
        return this.ready;
    }

    push(frame) {
        if (this.closed || frame.codec !== ZALI_MEDIA_CODEC_PCM_F32) return;
        const ch = frame.channels || 1;
        const count = Math.floor(frame.payload.byteLength / 4);
        // Отдельная копия: данные транспорта (общая память WebView2) освобождаются сразу.
        const pcm = new Float32Array(count);
        new Uint8Array(pcm.buffer).set(frame.payload.subarray(0, count * 4));
        if (this.writer) {
            const data = new AudioData({
                format: ch > 1 ? 'f32' : 'f32-planar',
                sampleRate: 48000,
                numberOfFrames: Math.floor(count / ch),
                numberOfChannels: ch,
                timestamp: frame.timestamp,
                data: pcm,
            });
            this.writer.write(data).catch(() => {});
        } else if (this.node) {
            let mono = pcm;
            if (ch > 1) {
                mono = new Float32Array(Math.floor(count / ch));
                for (let i = 0; i < mono.length; i++) {
                    let s = 0;
                    for (let c = 0; c < ch; c++) s += pcm[i * ch + c];
                    mono[i] = s / ch;
                }
            }
            this.node.port.postMessage(mono, [mono.buffer]);
        } else {
            return;
        }
        if (this.frames++ === 0) this.onFirstFrame?.();
    }

    close() {
        if (this.closed) return;
        this.closed = true;
        try { this.writer?.close(); } catch (e) {}
        try { this.node?.disconnect(); } catch (e) {}
        try { this.ctx?.close(); } catch (e) {}
    }
}

class ZaliNativeVideoSink {
    constructor({ onFirstFrame, onNeedKeyframe, trace }) {
        this.onFirstFrame = onFirstFrame;
        this.onNeedKeyframe = onNeedKeyframe;
        this.trace = trace || (() => {});
        this.track = null;
        this.writer = null;
        this.worker = null;
        this.canvas = null;
        this.ctx2d = null;
        this.decoder = null;
        this.decoderCodec = '';
        this.waitingKeyframe = true;
        this.frames = 0;
        this.closed = false;
        this.ready = null;
        this.mode = '';
    }

    static available() {
        if (typeof MediaStreamTrackGenerator === 'function' && typeof VideoFrame === 'function') return true;
        return typeof VideoDecoder === 'function' && typeof VideoFrame === 'function';
    }

    start() {
        if (this.ready) return this.ready;
        this.ready = (async () => {
            if (typeof MediaStreamTrackGenerator === 'function') {
                const g = new MediaStreamTrackGenerator({ kind: 'video' });
                this.writer = g.writable.getWriter();
                this.track = g;
                this.mode = 'generator';
                return true;
            }
            // WebKit: генератор в воркере; не вышло — canvas.captureStream.
            try {
                const url = URL.createObjectURL(new Blob([ZALI_VIDEO_GENERATOR_WORKER], { type: 'text/javascript' }));
                this.worker = new Worker(url);
                URL.revokeObjectURL(url);
                const track = await new Promise((resolve) => {
                    const timer = setTimeout(() => resolve(null), 3000);
                    this.worker.onmessage = (e) => {
                        if (e.data?.op === 'track') { clearTimeout(timer); resolve(e.data.track || null); }
                        else if (e.data?.op === 'error') { clearTimeout(timer); resolve(null); }
                    };
                    this.worker.postMessage({ op: 'start' });
                });
                if (track) {
                    this.track = track;
                    this.mode = 'worker-generator';
                    return true;
                }
            } catch (e) {}
            try { this.worker?.terminate(); } catch (e) {}
            this.worker = null;
            this.canvas = document.createElement('canvas');
            this.canvas.width = 2;
            this.canvas.height = 2;
            this.ctx2d = this.canvas.getContext('2d');
            this.track = this.canvas.captureStream(30).getVideoTracks()[0] || null;
            this.mode = 'canvas';
            return !!this.track;
        })();
        return this.ready;
    }

    deliver(frame) {
        if (this.closed) { try { frame.close(); } catch (e) {} return; }
        if (this.frames++ === 0) this.onFirstFrame?.();
        if (this.writer) {
            this.writer.write(frame).catch(() => {}).finally(() => { try { frame.close(); } catch (e) {} });
        } else if (this.worker) {
            this.worker.postMessage({ op: 'frame', frame }, [frame]);
        } else if (this.ctx2d) {
            const w = frame.displayWidth || frame.codedWidth;
            const h = frame.displayHeight || frame.codedHeight;
            if (this.canvas.width !== w || this.canvas.height !== h) {
                this.canvas.width = w;
                this.canvas.height = h;
            }
            try { this.ctx2d.drawImage(frame, 0, 0); } catch (e) {}
            try { frame.close(); } catch (e) {}
        } else {
            try { frame.close(); } catch (e) {}
        }
    }

    push(header, codecString) {
        if (this.closed) return;
        if (header.codec === ZALI_MEDIA_CODEC_NV12) {
            let frame;
            try {
                frame = new VideoFrame(header.payload, {
                    format: 'NV12',
                    codedWidth: header.width,
                    codedHeight: header.height,
                    timestamp: header.timestamp,
                });
            } catch (e) {
                return;
            }
            this.deliver(frame);
            return;
        }
        if (header.codec !== ZALI_MEDIA_CODEC_H264) return;
        if (!this.decoder || this.decoderCodec !== codecString || this.decoder.state === 'closed') {
            try { this.decoder?.close(); } catch (e) {}
            this.decoderCodec = codecString || 'avc1.42E01F';
            this.decoder = new VideoDecoder({
                output: (frame) => this.deliver(frame),
                error: (error) => {
                    this.resets = (this.resets || 0) + 1;
                    this.trace('native-video-decoder-error', { error: error?.message || String(error), codec: this.decoderCodec, resets: this.resets }, 'WARN');
                    this.waitingKeyframe = true;
                    this.onNeedKeyframe?.();
                },
            });
            this.decoder.configure({ codec: this.decoderCodec, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' });
            this.waitingKeyframe = true;
        }
        if (this.waitingKeyframe && !header.keyframe) {
            this.onNeedKeyframe?.();
            return;
        }
        this.waitingKeyframe = false;
        // Копия: EncodedVideoChunk копирует сам, но payload может жить в чужом буфере.
        try {
            this.decoder.decode(new EncodedVideoChunk({
                type: header.keyframe ? 'key' : 'delta',
                timestamp: header.timestamp,
                data: header.payload,
            }));
        } catch (e) {
            this.resets = (this.resets || 0) + 1;
            if (this.resets === 1 || this.resets % 50 === 0) {
                this.trace('native-video-decode-throw', { error: e?.message || String(e), resets: this.resets }, 'WARN');
            }
            this.waitingKeyframe = true;
            this.onNeedKeyframe?.();
        }
        // Декодер не успевает — копится очередь, растёт задержка: ждём ключевой кадр.
        if (this.decoder.decodeQueueSize > 8) {
            this.resets = (this.resets || 0) + 1;
            this.trace('native-video-decoder-behind', { queue: this.decoder.decodeQueueSize, resets: this.resets }, 'WARN');
            try { this.decoder.reset(); this.decoder.configure({ codec: this.decoderCodec, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' }); } catch (e) {}
            this.waitingKeyframe = true;
            this.onNeedKeyframe?.();
        }
    }

    close() {
        if (this.closed) return;
        this.closed = true;
        try { this.decoder?.close(); } catch (e) {}
        try { this.writer?.close(); } catch (e) {}
        try { this.worker?.postMessage({ op: 'stop' }); } catch (e) {}
        setTimeout(() => { try { this.worker?.terminate(); } catch (e) {} }, 500);
    }
}

ZaliMixin(ZaliInterface, class {

    /** Транспорт кадров, объявленный оболочкой, или null. */
    nativeMediaBridgeInfo() {
        const info = window.__ZALI_MEDIA_BRIDGE;
        if (!info || typeof info !== 'object') return null;
        if (info.kind === 'websocket' && typeof info.url === 'string' && /^ws:\/\/127\.0\.0\.1:\d+\//.test(info.url) && info.token) return info;
        if (info.kind === 'sharedbuffer' && window.chrome?.webview?.addEventListener) return info;
        if (info.kind === 'fake' && typeof info.attach === 'function') return info;
        return null;
    }

    /** Можно ли брать `kind` ('mic' | 'camera' | 'screen') у оболочки. */
    nativeCaptureAvailable(kind) {
        const cap = { mic: 'nativeMic', camera: 'nativeCamera', screen: 'nativeScreen' }[kind];
        if (!cap || !this.nativeSupports(cap) || !this.nativeMediaBridgeInfo()) return false;
        if (this.voice?.nativeCaptureDisabled?.[kind]) return false;
        // Оболочка сообщила, что кадры в страницу не доставить (Windows: старый WebView2
        // без общей памяти) — до перезагрузки только движок, без ожидания таймаутов.
        if (this._nativeMedia?.transportUnavailable) return false;
        return kind === 'mic' ? ZaliNativeAudioSink.available() : ZaliNativeVideoSink.available();
    }

    nativeMediaState() {
        if (!this._nativeMedia) {
            this._nativeMedia = {
                transport: null,
                connecting: null,
                streams: new Map(),
                pending: new Map(),
                nextStream: 1,
            };
        }
        return this._nativeMedia;
    }

    /** Поднимает транспорт кадров (один на сессию страницы). Всегда завершается. */
    ensureNativeMediaTransport() {
        const state = this.nativeMediaState();
        if (state.transport?.open) return Promise.resolve(true);
        if (state.connecting) return state.connecting;
        const info = this.nativeMediaBridgeInfo();
        if (!info) return Promise.resolve(false);
        const onBytes = (bytes) => this.handleNativeMediaFrame(bytes);
        state.connecting = new Promise((resolve) => {
            const done = (ok) => { state.connecting = null; resolve(ok); };
            if (info.kind === 'sharedbuffer') {
                const handler = (event) => {
                    let buffer = null;
                    try {
                        buffer = event.getBuffer();
                        onBytes(new Uint8Array(buffer));
                    } finally {
                        // Освобождаем сразу: приёмники копируют данные (VideoFrame/AudioData).
                        try { if (buffer) window.chrome.webview.releaseBuffer(buffer); } catch (e) {}
                    }
                };
                window.chrome.webview.addEventListener('sharedbufferreceived', handler);
                state.transport = { open: true, kind: 'sharedbuffer', close: () => window.chrome.webview.removeEventListener('sharedbufferreceived', handler) };
                done(true);
                return;
            }
            if (info.kind === 'fake') {
                state.transport = { open: true, kind: 'fake', close: () => {} };
                info.attach(onBytes);
                done(true);
                return;
            }
            let ws;
            try {
                ws = new WebSocket(info.url);
            } catch (e) {
                this.voiceDiag?.('native-media-transport-failed', { error: e?.message || String(e) }, 'WARN');
                done(false);
                return;
            }
            ws.binaryType = 'arraybuffer';
            const timer = setTimeout(() => { try { ws.close(); } catch (e) {} done(false); }, 4000);
            ws.onopen = () => {
                clearTimeout(timer);
                ws.send(JSON.stringify({ hello: info.token }));
                state.transport = { open: true, kind: 'websocket', close: () => { try { ws.close(); } catch (e) {} } };
                done(true);
            };
            ws.onmessage = (e) => { if (e.data instanceof ArrayBuffer) onBytes(new Uint8Array(e.data)); };
            ws.onclose = () => {
                clearTimeout(timer);
                const wasOpen = !!state.transport?.open;
                state.transport = null;
                if (wasOpen) {
                    this.voiceDiag?.('native-media-transport-closed', { streams: state.streams.size }, 'WARN');
                    for (const stream of Array.from(state.streams.keys())) this.endNativeMediaStream(stream, 'transport-closed');
                }
                done(false);
            };
            ws.onerror = () => {};
        });
        return state.connecting;
    }

    /** Запрос с ответом: MEDIA_REQUEST → `media_event` с тем же requestId. */
    nativeMediaRequest(op, fields = {}, timeoutMs = 8000) {
        const state = this.nativeMediaState();
        const requestId = this.newRequestId();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                state.pending.delete(requestId);
                reject(new Error(`MEDIA_REQUEST ${op}: нет ответа за ${timeoutMs} мс`));
            }, timeoutMs);
            state.pending.set(requestId, { resolve, reject, timer });
            const sent = this.postNativeMessage({ type: NativeMessageTypes.MEDIA_REQUEST, op, requestId, ...fields });
            if (!sent) {
                clearTimeout(timer);
                state.pending.delete(requestId);
                reject(new Error(`MEDIA_REQUEST ${op}: мост не принял сообщение`));
            }
        });
    }

    onNativeMediaEvent(payload = {}) {
        const state = this.nativeMediaState();
        const { event, requestId, stream } = payload || {};
        if (requestId && state.pending.has(requestId)) {
            const p = state.pending.get(requestId);
            state.pending.delete(requestId);
            clearTimeout(p.timer);
            if (event === 'error') p.reject(Object.assign(new Error(payload.message || 'native media error'), { code: payload.code || '' }));
            else p.resolve(payload);
        }
        const entry = stream ? state.streams.get(Number(stream)) : null;
        if (event === 'started' && entry) {
            entry.codec = payload.codec || entry.codec;
            entry.label = payload.label || entry.label;
            entry.info = payload;
        } else if (event === 'ended' && entry) {
            this.endNativeMediaStream(Number(stream), payload.reason || 'native');
        } else if (event === 'error' && entry && !requestId) {
            this.voiceDiag?.('native-media-stream-error', { stream, kind: entry.kind, message: payload.message || '' }, 'WARN');
            this.endNativeMediaStream(Number(stream), 'error');
        } else if (event === 'transport_unavailable') {
            state.transportUnavailable = true;
            this.voiceDiag?.('native-media-transport-unavailable', { streams: state.streams.size }, 'WARN');
            for (const id of Array.from(state.streams.keys())) this.endNativeMediaStream(id, 'transport-unavailable');
        } else if (event === 'devices_changed') {
            this.onNativeMediaDevicesChanged?.(payload);
        } else if (event === 'stats' && payload.processing) {
            this.voiceDiag?.('mic-processing-native', { stream, ...payload.processing, ...this.nativeMediaPageCounters(entry) });
        } else if (event === 'stats' && payload.video) {
            // Оболочка: кадры, кбит/с, пропуски (затор), повторы неподвижного экрана;
            // страница: сколько кадров дошло и сколько раз пересобирался декодер.
            const v = payload.video;
            const level = (Number(v.dropped) > 0 || (entry && entry.pageFramesWindow === 0)) ? 'WARN' : 'INFO';
            this.voiceDiag?.('native-video-stats', { stream, ...v, ...this.nativeMediaPageCounters(entry) }, level);
        }
    }

    /** Счётчики страницы за окно с прошлого вызова (кадры дошли/битые) и сброс окна. */
    nativeMediaPageCounters(entry) {
        if (!entry) return {};
        const out = {
            page_frames: entry.pageFramesWindow || 0,
            page_frames_total: entry.pageFrames || 0,
            page_bad_frames: entry.badFrames || 0,
        };
        entry.pageFramesWindow = 0;
        return out;
    }

    handleNativeMediaFrame(bytes) {
        const frame = zaliParseMediaFrame(bytes);
        const state = this.nativeMediaState();
        if (!frame) {
            state.badFrames = (state.badFrames || 0) + 1;
            if (state.badFrames === 1 || state.badFrames % 500 === 0) {
                this.voiceDiag?.('native-media-bad-frame', { count: state.badFrames, bytes: bytes?.byteLength || 0 }, 'WARN');
            }
            return;
        }
        const entry = state.streams.get(frame.stream);
        if (!entry || entry.ended) return;
        entry.pageFrames = (entry.pageFrames || 0) + 1;
        entry.pageFramesWindow = (entry.pageFramesWindow || 0) + 1;
        if (!entry.firstFrameAt) entry.firstFrameAt = Date.now();
        if (frame.kind === ZALI_MEDIA_KIND_AUDIO) {
            entry.audio?.push(frame);
        } else if (frame.kind === ZALI_MEDIA_KIND_VIDEO) {
            entry.video?.push(frame, entry.codec);
        }
    }

    /**
     * Открывает нативный поток и отдаёт MediaStream после первого кадра.
     * kind: 'mic' | 'camera' | 'screen'; options: для экрана {fps, maxHeight, audio, cursor},
     * для микрофона {processing: {aec, ns, agc}}.
     */
    /**
     * defaultIfUnknown: сохранённый id может быть от движка (WebKit/Chromium хешируют
     * id по origin) — оболочка его не знает (not_found). Тогда — устройство по
     * умолчанию из оболочки, а не getUserMedia (на macOS это снова VoiceProcessingIO).
     * Одно место для всех вызовов: микрофон, камера, превью.
     */
    async openNativeMediaStream(params = {}) {
        try {
            return await this.openNativeMediaStreamOnce(params);
        } catch (error) {
            if (!(params.defaultIfUnknown && params.deviceId && error?.code === 'not_found')) throw error;
            this.voiceDiag?.('native-media-unknown-device', { kind: params.kind, deviceId: String(params.deviceId).slice(0, 12) }, 'WARN');
            return this.openNativeMediaStreamOnce({ ...params, deviceId: '' });
        }
    }

    async openNativeMediaStreamOnce({ kind, deviceId = '', sourceId = '', options = {}, firstFrameTimeoutMs = 5000 } = {}) {
        if (!this.nativeCaptureAvailable(kind)) throw new Error(`нативный захват ${kind} недоступен`);
        const transportOk = await this.ensureNativeMediaTransport();
        if (!transportOk) throw new Error('транспорт кадров не поднялся');
        const state = this.nativeMediaState();
        const stream = state.nextStream++;
        let firstFrame;
        const firstFramePromise = new Promise((resolve) => { firstFrame = resolve; });
        const trace = (stage, details, level) => this.voiceDiag?.(stage, { stream, kind, ...details }, level);
        const entry = { stream, kind, codec: '', label: '', ended: false, audio: null, video: null, tracks: [], info: null };
        const wantsAudio = kind === 'mic' || (kind === 'screen' && !!options.audio);
        const wantsVideo = kind === 'camera' || kind === 'screen';
        if (wantsAudio) entry.audio = new ZaliNativeAudioSink(kind === 'mic' ? firstFrame : null);
        if (wantsVideo) {
            entry.video = new ZaliNativeVideoSink({
                onFirstFrame: firstFrame,
                onNeedKeyframe: () => this.requestNativeKeyframe(stream),
                trace,
            });
        }
        state.streams.set(stream, entry);
        entry.openedAt = Date.now();
        trace('native-media-open', { deviceId: String(deviceId || '').slice(0, 12), sourceId: String(sourceId || ''), options: JSON.stringify(options) });
        try {
            await Promise.all([entry.audio?.start(), entry.video?.start()]);
            const started = await this.nativeMediaRequest('start', { stream, kind, deviceId, sourceId, options }, 10000);
            entry.codec = started?.codec || entry.codec;
            entry.label = started?.label || '';
            entry.info = started || null;
            const gotFrame = await Promise.race([
                firstFramePromise.then(() => true),
                // Поток закрыли раньше первого кадра (транспорт пропал, оболочка
                // сообщила о недоступности) — не ждать таймаута.
                new Promise(r => { entry.onEnd = () => r(false); }),
                new Promise(r => setTimeout(() => r(false), firstFrameTimeoutMs)),
            ]);
            if (!gotFrame) throw new Error(entry.ended ? 'поток закрыт до первого кадра' : `нет кадров за ${firstFrameTimeoutMs} мс`);
        } catch (error) {
            trace('native-media-open-failed', {
                error: error?.message || String(error),
                code: error?.code || '',
                ms: Date.now() - entry.openedAt,
                started: !!entry.info,
                frames: entry.pageFrames || 0,
            }, 'WARN');
            this.endNativeMediaStream(stream, 'start-failed');
            throw error;
        }
        const tracks = [entry.video?.track, entry.audio?.track].filter(Boolean);
        for (const track of tracks) {
            // Остановка дорожки страницей (track.stop() в resetVoiceState, смена
            // устройства) должна закрыть захват в оболочке — у генератора своего
            // канала обратно нет.
            const nativeStop = track.stop.bind(track);
            track.stop = () => {
                nativeStop();
                this.stopNativeMediaStream(stream, 'track-stopped');
            };
            try {
                Object.defineProperty(track, 'label', { value: entry.label || `${kind} (native)`, configurable: true });
            } catch (e) {}
        }
        entry.tracks = tracks;
        trace('native-media-started', {
            ms: Date.now() - entry.openedAt,
            width: entry.info?.width || 0,
            height: entry.info?.height || 0,
            codec: entry.codec || '',
            video: entry.video?.mode || '',
            audio: entry.audio ? (entry.audio.writer ? 'generator' : 'worklet') : '',
            label: entry.label || '',
        });
        const media = new MediaStream(tracks);
        media.__zaliNativeStream = stream;
        // Фактическое устройство (камера по умолчанию, когда id не задан) — у
        // дорожки-генератора нет getSettings().deviceId.
        media.__zaliDeviceId = String(entry.info?.deviceId || deviceId || '');
        // Ответ started целиком (например, audioExcludesApp у экрана).
        media.__zaliNativeInfo = entry.info || null;
        return media;
    }

    requestNativeKeyframe(stream) {
        const entry = this.nativeMediaState().streams.get(stream);
        if (!entry || entry.ended) return;
        const now = Date.now();
        if (now - (entry.keyframeAskedAt || 0) < 500) return;
        entry.keyframeAskedAt = now;
        this.postNativeMessage({ type: NativeMessageTypes.MEDIA_REQUEST, op: 'request_keyframe', stream });
    }

    /** Страница больше не нуждается в потоке: закрыть захват в оболочке. */
    stopNativeMediaStream(stream, reason = 'page') {
        const entry = this.nativeMediaState().streams.get(stream);
        if (!entry || entry.ended) return;
        this.postNativeMessage({ type: NativeMessageTypes.MEDIA_REQUEST, op: 'stop', stream });
        this.endNativeMediaStream(stream, reason);
    }

    /** Поток закончился (любая сторона): закрыть приёмники, погасить дорожки. */
    endNativeMediaStream(stream, reason) {
        const state = this.nativeMediaState();
        const entry = state.streams.get(stream);
        if (!entry || entry.ended) return;
        entry.ended = true;
        state.streams.delete(stream);
        try { entry.onEnd?.(); } catch (e) {}
        entry.audio?.close();
        entry.video?.close();
        for (const track of entry.tracks) {
            if (track.readyState !== 'ended') {
                try { Object.getPrototypeOf(track).stop.call(track); } catch (e) {}
                // Генератор/канвас не шлёт 'ended' при собственном stop() — шлём сами,
                // на это подписаны stopScreenShare и др.
                try { track.dispatchEvent(new Event('ended')); } catch (e) {}
            }
        }
        this.voiceDiag?.('native-media-ended', {
            stream,
            kind: entry.kind,
            reason,
            seconds: entry.firstFrameAt ? Math.round((Date.now() - entry.firstFrameAt) / 1000) : 0,
            frames: entry.pageFrames || 0,
            video: entry.video?.mode || '',
            decoderResets: entry.video?.resets || 0,
        });
    }

    /** Список устройств оболочки: {audioinput: [...], videoinput: [...]}, элементы {id, label, isDefault}. */
    async listNativeMediaDevices() {
        const res = await this.nativeMediaRequest('list_devices', {}, 5000);
        return {
            audioinput: Array.isArray(res?.audioinput) ? res.audioinput : [],
            videoinput: Array.isArray(res?.videoinput) ? res.videoinput : [],
        };
    }

    /** Экраны и окна для окна выбора: [{id, kind:'display'|'window', title, app, thumb, width, height}]. */
    async listNativeScreenSources({ thumbWidth = 320 } = {}) {
        const res = await this.nativeMediaRequest('list_screen_sources', { options: { thumbWidth } }, 8000);
        return Array.isArray(res?.sources) ? res.sources : [];
    }

    /** Эхо/шум/громкость нашей обработки микрофона (core APM) — на лету. */
    setNativeVoiceProcessing(enabled) {
        const on = !!enabled;
        return this.postNativeMessage({
            type: NativeMessageTypes.MEDIA_REQUEST,
            op: 'set_processing',
            options: { aec: on, ns: on, agc: on },
        });
    }

    /** Хоть один поток идёт из оболочки (для журнала и тестов). */
    isNativeMediaStream(stream) {
        return !!stream && typeof stream.__zaliNativeStream === 'number';
    }
});

window.ZaliNativeMediaFormat = { parse: zaliParseMediaFrame, encode: zaliEncodeMediaFrame };
