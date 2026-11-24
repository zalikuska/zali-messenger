package org.zalikus.messenger

import org.json.JSONObject
import java.util.concurrent.locks.ReentrantReadWriteLock
import kotlin.concurrent.read
import kotlin.concurrent.write

/**
 * Издатель экрана на SFU из ядра (core/src/sfu_publisher.rs, JNI — модуль `android` там же):
 * клиент WebRTC (str0m) шлёт слои MediaCodec прямо на сервер, мимо WebRTC страницы.
 * Сигналинг ведёт страница (voice_sfu.js → startVoiceNativeSfuScreen): оффер уходит ей в
 * `started`, ответ приходит op `sfu_answer`. Так же устроено на macOS и Windows.
 */
object ZaliSfuNative {
    /** Колбэк ядра: JSON-событие, с потока издателя. */
    interface Sink {
        fun onEvent(json: String)
    }

    external fun create(configJson: String, sink: Sink): Long
    external fun offer(ptr: Long): String?
    external fun answer(ptr: Long, sdp: String)
    external fun push(ptr: Long, layer: Int, data: ByteArray, keyframe: Boolean, ptsUs: Long)
    external fun free(ptr: Long)
}

class SfuPublisher private constructor(private var ptr: Long, val offerSdp: String, val mid: String) {
    private val lock = ReentrantReadWriteLock()

    fun answer(sdp: String) = lock.read { if (ptr != 0L) ZaliSfuNative.answer(ptr, sdp) }

    fun push(layer: Int, data: ByteArray, keyframe: Boolean, ptsUs: Long) = lock.read {
        if (ptr != 0L) ZaliSfuNative.push(ptr, layer, data, keyframe, ptsUs)
    }

    /**
     * Останавливает поток издателя. `onEvent` после возврата не зовётся. Звать НЕ из
     * колбэка издателя (free ждёт его поток) и не держа замков, которые нужны колбэку.
     */
    fun close() {
        val p = lock.write {
            val p = ptr
            ptr = 0L
            p
        }
        if (p != 0L) ZaliSfuNative.free(p)
    }

    companion object {
        /** null — ядро без издателя (старая .so) или конфиг не принят. */
        fun create(config: JSONObject, onEvent: (JSONObject) -> Unit): SfuPublisher? {
            if (!ZaliCoreBridge.isAvailable) return null
            val sink = object : ZaliSfuNative.Sink {
                override fun onEvent(json: String) {
                    try { onEvent(JSONObject(json)) } catch (e: Exception) {}
                }
            }
            val ptr = try {
                ZaliSfuNative.create(config.toString(), sink)
            } catch (e: UnsatisfiedLinkError) {
                0L
            }
            if (ptr == 0L) return null
            val offer = try { JSONObject(ZaliSfuNative.offer(ptr) ?: "") } catch (e: Exception) { null }
            val sdp = offer?.optString("sdp", "") ?: ""
            val mid = offer?.optString("mid", "") ?: ""
            if (sdp.isEmpty() || mid.isEmpty()) {
                ZaliSfuNative.free(ptr)
                return null
            }
            return SfuPublisher(ptr, sdp, mid)
        }
    }
}
