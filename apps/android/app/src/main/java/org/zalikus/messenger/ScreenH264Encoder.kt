package org.zalikus.messenger

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.media.MediaFormat
import android.os.Bundle
import android.os.Handler
import android.view.Surface
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Аппаратный H.264 для демонстрации экрана по протоколу MEDIA_REQUEST (как у macOS и
 * Windows, см. web/src/interface/native_media.js и скилл voice-calls → native-capture.md).
 *
 * VirtualDisplay рисует прямо во входную поверхность MediaCodec — без копий кадра через
 * Bitmap/JPEG/base64. Готовые NAL (Annex B) уходят в страницу двоичными кадрами формата
 * zaliEncodeMediaFrame (32 байта заголовка), там их декодирует WebCodecs и отдаёт дорожке.
 * Прежний путь (JPEG → data: URL → canvas.captureStream(8)) давал ~8 к/с при 960 px.
 *
 * `mime` — кодек: H.264 по умолчанию; слои нативной демонстрации через SFU — ещё H.265 и AV1
 * (2026-11-24), когда их декодируют все в комнате и есть аппаратный кодировщик
 * ([hardwareEncoderAvailable]). Превью странице — тем же кодеком (номер кодека в кадре: 3/4).
 */
class ScreenH264Encoder(
    val width: Int,
    val height: Int,
    private val fps: Int,
    private val stream: Int,
    private val handler: Handler,
    /** CSD появились (SPS/PPS): строка кодека `avc1.PPCCLL` для VideoDecoder. */
    private val onStarted: (codec: String) -> Unit,
    /** Кадр формата native_media.js; `false` — не взят (очередь в WebView полна). */
    private val onFrame: (bytes: ByteArray, keyframe: Boolean) -> Boolean,
    private val onError: (message: String) -> Unit,
    /** Бит/с; 0 — запас под второе кодирование страницей (~0,15 бит на пиксель). */
    private val bitrate: Int = 0,
    /** Слой SFU: каждый готовый кадр (Annex B, у ключевого SPS/PPS внутри, метка мкс). */
    private val onEncoded: ((data: ByteArray, keyframe: Boolean, ptsUs: Long) -> Unit)? = null,
    /** Кадры в страницу (превью или единственный поток). Слоям SFU без превью — нет. */
    private val toPage: Boolean = true,
    private val mime: String = MediaFormat.MIMETYPE_VIDEO_AVC,
) {
    private val label = when (mime) {
        MediaFormat.MIMETYPE_VIDEO_HEVC -> "H.265"
        MediaFormat.MIMETYPE_VIDEO_AV1 -> "AV1"
        else -> "H.264"
    }
    private var codec: MediaCodec? = null
    var inputSurface: Surface? = null
        private set
    private var csd: ByteArray? = null
    private var started = false
    private var seq = 0
    @Volatile private var closed = false

    fun start(): Boolean {
        val format = MediaFormat.createVideoFormat(mime, width, height).apply {
            setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
            // Промежуточное кодирование: дальше WebRTC кодирует ещё раз, поэтому запас по
            // качеству — ~0,15 бит на пиксель, но не больше 20 Мбит/с.
            val bps = if (bitrate > 0) bitrate.toLong()
                else (width.toLong() * height * fps * 15 / 100).coerceIn(2_000_000L, 20_000_000L)
            setInteger(MediaFormat.KEY_BIT_RATE, bps.toInt())
            setInteger(MediaFormat.KEY_BITRATE_MODE, MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_VBR)
            setInteger(MediaFormat.KEY_FRAME_RATE, fps)
            // Ключевые кадры — по запросу страницы (request_keyframe), не по таймеру.
            setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 10)
            // VirtualDisplay не шлёт кадров, пока экран неподвижен; повтор раз в 100 мс
            // держит дорожку живой (≥ 10 к/с), иначе WebRTC считает поток замёрзшим.
            setLong(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER, 100_000L)
            setInteger(MediaFormat.KEY_PRIORITY, 0) // реальное время
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
                setFloat(MediaFormat.KEY_MAX_FPS_TO_ENCODER, fps.toFloat())
            }
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R) {
                setInteger(MediaFormat.KEY_LOW_LATENCY, 1)
            }
        }
        return try {
            val c = MediaCodec.createEncoderByType(mime)
            codec = c
            c.setCallback(callback, handler)
            try {
                c.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            } catch (e: Exception) {
                // Кодировщик без low-latency/max-fps — пробуем без них.
                format.removeKey(MediaFormat.KEY_LOW_LATENCY)
                format.removeKey(MediaFormat.KEY_MAX_FPS_TO_ENCODER)
                c.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            }
            inputSurface = c.createInputSurface()
            c.start()
            true
        } catch (e: Exception) {
            onError("Кодировщик $label не запустился: ${e.message ?: e.javaClass.simpleName}")
            release()
            false
        }
    }

    fun requestKeyframe() {
        if (closed) return
        try {
            codec?.setParameters(Bundle().apply { putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0) })
        } catch (e: Exception) {}
    }

    /** Бюджет слоя от издателя SFU (бит/с). */
    fun setBitrate(bps: Int) {
        if (closed || bps <= 0) return
        try {
            codec?.setParameters(Bundle().apply { putInt(MediaCodec.PARAMETER_KEY_VIDEO_BITRATE, bps) })
        } catch (e: Exception) {}
    }

    /**
     * Слой SFU на паузе (бюджет 0): кодировщик не берёт кадры с поверхности — и повторов
     * KEY_REPEAT_PREVIOUS_FRAME_AFTER тоже нет. После снятия паузы — ключевой кадр.
     */
    fun setSuspended(suspended: Boolean) {
        if (closed) return
        try {
            codec?.setParameters(Bundle().apply { putInt(MediaCodec.PARAMETER_KEY_SUSPEND, if (suspended) 1 else 0) })
        } catch (e: Exception) {}
        if (!suspended) requestKeyframe()
    }

    fun release() {
        closed = true
        try { codec?.stop() } catch (e: Exception) {}
        try { codec?.release() } catch (e: Exception) {}
        codec = null
        try { inputSurface?.release() } catch (e: Exception) {}
        inputSurface = null
    }

    private val callback = object : MediaCodec.Callback() {
        override fun onInputBufferAvailable(codec: MediaCodec, index: Int) {}

        override fun onOutputFormatChanged(codec: MediaCodec, format: MediaFormat) {
            // Часть кодировщиков отдаёт SPS/PPS только в формате (csd-0/csd-1), а не
            // буфером CODEC_CONFIG.
            val parts = listOf("csd-0", "csd-1").mapNotNull { key ->
                if (format.containsKey(key)) format.getByteBuffer(key)?.let { bytesOf(it) } else null
            }
            if (parts.isNotEmpty()) setCsd(parts.fold(ByteArray(0)) { acc, b -> acc + b })
        }

        override fun onOutputBufferAvailable(codec: MediaCodec, index: Int, info: MediaCodec.BufferInfo) {
            if (closed) return
            try {
                val buffer = codec.getOutputBuffer(index)
                if (buffer != null && info.size > 0) {
                    buffer.position(info.offset)
                    buffer.limit(info.offset + info.size)
                    val data = ByteArray(info.size)
                    buffer.get(data)
                    if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) {
                        setCsd(data)
                    } else {
                        val key = info.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME != 0
                        // Декодер страницы настроен без description — SPS/PPS нужны внутри
                        // каждого ключевого кадра.
                        val payload = if (key) (csd ?: ByteArray(0)) + data else data
                        onEncoded?.invoke(payload, key, info.presentationTimeUs)
                        if (started && toPage) {
                            val taken = onFrame(frame(payload, info.presentationTimeUs, key), key)
                            // Выброшенный разностный кадр ломает цепочку у декодера — сразу
                            // новый ключевой, иначе страница будет ждать его по таймеру.
                            if (!taken) requestKeyframe()
                        }
                    }
                }
            } catch (e: Exception) {
            } finally {
                try { codec.releaseOutputBuffer(index, false) } catch (e: Exception) {}
            }
        }

        override fun onError(codec: MediaCodec, e: MediaCodec.CodecException) {
            if (!closed) onError("Ошибка кодировщика $label: ${e.diagnosticInfo}")
        }
    }

    private fun setCsd(raw: ByteArray) {
        // AV1: csd-0 — запись av1C (маркер 0x81, 4 байта), за ней OBU заголовка последовательности.
        val bytes = if (mime == MediaFormat.MIMETYPE_VIDEO_AV1 && raw.size > 4 && raw[0] == 0x81.toByte()) raw.copyOfRange(4, raw.size) else raw
        if (bytes.isEmpty()) return
        csd = bytes
        if (!started) {
            started = true
            onStarted(when (mime) {
                // Типовые строки: декодер страницы берёт параметры из самого потока.
                MediaFormat.MIMETYPE_VIDEO_HEVC -> "hvc1.1.6.L120.B0"
                MediaFormat.MIMETYPE_VIDEO_AV1 -> "av01.0.08M.08"
                else -> codecString(bytes)
            })
        }
    }

    private fun frame(payload: ByteArray, timestampUs: Long, keyframe: Boolean): ByteArray {
        val out = ByteBuffer.allocate(HEADER + payload.size).order(ByteOrder.LITTLE_ENDIAN)
        out.put(0x5A.toByte())          // магия
        out.put(1)                      // версия
        out.put(2)                      // вид: видео
        out.put(when (mime) {            // кодек: 1 — H.264, 3 — H.265 (Annex B), 4 — AV1 (OBU)
            MediaFormat.MIMETYPE_VIDEO_HEVC -> 3
            MediaFormat.MIMETYPE_VIDEO_AV1 -> 4
            else -> 1
        }.toByte())
        out.putInt(stream)
        out.putLong(timestampUs.coerceAtLeast(0))
        out.putShort(width.toShort())
        out.putShort(height.toShort())
        out.put(if (keyframe) 1 else 0)
        out.put(0)                      // каналы (только звук)
        out.putShort(0)                 // резерв
        out.putInt(payload.size)
        out.putInt(seq++)
        out.put(payload)
        return out.array()
    }

    companion object {
        private const val HEADER = 32

        /**
         * Есть ли АППАРАТНЫЙ кодировщик `mime` (программный HEVC/AV1 на телефоне — горячо и
         * медленно). До Android 10 флага нет — отсекаем программные по имени.
         */
        fun hardwareEncoderAvailable(mime: String): Boolean = try {
            MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos.any { info ->
                info.isEncoder && info.supportedTypes.any { it.equals(mime, ignoreCase = true) } &&
                    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) info.isHardwareAccelerated
                    else !info.name.lowercase().let { it.startsWith("omx.google.") || it.startsWith("c2.android.") }
            }
        } catch (e: Exception) {
            false
        }

        /** MIME по имени кодека страницы («H264», «H265», «AV1»). */
        fun mimeOf(codec: String): String? = when (codec.uppercase()) {
            "H264" -> MediaFormat.MIMETYPE_VIDEO_AVC
            "H265" -> MediaFormat.MIMETYPE_VIDEO_HEVC
            "AV1" -> if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) MediaFormat.MIMETYPE_VIDEO_AV1 else null
            else -> null
        }

        /** Есть ли аппаратный (или хоть какой-то) кодировщик H.264 этого размера. */
        fun available(): Boolean = try {
            MediaCodecList(MediaCodecList.REGULAR_CODECS)
                .findEncoderForFormat(MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, 1280, 720)) != null
        } catch (e: Exception) {
            false
        }

        private fun bytesOf(b: ByteBuffer): ByteArray {
            val dup = b.duplicate()
            dup.position(0)
            val out = ByteArray(dup.remaining())
            dup.get(out)
            return out
        }

        /** `avc1.PPCCLL` из первого SPS (NAL 7) в Annex B. */
        fun codecString(annexB: ByteArray): String {
            var i = 0
            while (i + 4 < annexB.size) {
                val sc3 = annexB[i] == 0.toByte() && annexB[i + 1] == 0.toByte() && annexB[i + 2] == 1.toByte()
                if (sc3) {
                    val h = i + 3
                    if (h + 3 < annexB.size && (annexB[h].toInt() and 0x1F) == 7) {
                        return "avc1.%02X%02X%02X".format(
                            annexB[h + 1].toInt() and 0xFF,
                            annexB[h + 2].toInt() and 0xFF,
                            annexB[h + 3].toInt() and 0xFF,
                        )
                    }
                    i = h
                } else {
                    i++
                }
            }
            return "avc1.42E01F"
        }
    }
}
