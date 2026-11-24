package org.zalikus.messenger

import android.graphics.SurfaceTexture
import android.opengl.EGL14
import android.opengl.EGLConfig
import android.opengl.EGLContext
import android.opengl.EGLDisplay
import android.opengl.EGLExt
import android.opengl.EGLSurface
import android.opengl.GLES11Ext
import android.opengl.GLES20
import android.os.Handler
import android.view.Surface
import org.json.JSONArray
import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer

/**
 * Демонстрация экрана слоями simulcast прямо на SFU (как macOS/Windows: скилл voice-calls →
 * native-capture.md, раздел про sfu_publisher.rs).
 *
 * У MediaProjection один VirtualDisplay (с Android 14 второй createVirtualDisplay запрещён),
 * а кодировщиков — по слою. Поэтому VirtualDisplay рисует в SurfaceTexture, а этот класс
 * раздаёт кадр OpenGL ES во входные поверхности всех MediaCodec, каждому со своей частотой
 * и размером. Готовые кадры слоёв уходят в издатель ядра (SfuPublisher), слой превью — ещё
 * и в страницу (её плитка «вы показываете экран»).
 */
class ScreenSfuLayers private constructor(
    private val handler: Handler,
    private val srcWidth: Int,
    private val srcHeight: Int,
    val publisher: SfuPublisher,
    private val layers: List<Layer>,
    val previewIndex: Int,
    /** Кодек слоёв («H264», «H265», «AV1») — в `started.sfu.codec`. */
    val codecName: String = "H264",
) {
    class Layer(
        val rid: String,
        val width: Int,
        val height: Int,
        val fps: Int,
        /** Расчётный битрейт слоя (с ним стартует кодировщик). */
        val bps: Int,
        val encoder: ScreenH264Encoder,
    ) {
        var eglSurface: EGLSurface = EGL14.EGL_NO_SURFACE
        var lastNs = 0L
        @Volatile var paused = false
    }

    private var display: EGLDisplay = EGL14.EGL_NO_DISPLAY
    private var context: EGLContext = EGL14.EGL_NO_CONTEXT
    private var config: EGLConfig? = null
    private var pbuffer: EGLSurface = EGL14.EGL_NO_SURFACE
    private var texture = 0
    private var program = 0
    private var surfaceTexture: SurfaceTexture? = null
    /** Сюда рисует VirtualDisplay. */
    var inputSurface: Surface? = null
        private set
    private val matrix = FloatArray(16)
    @Volatile private var released = false
    /** Издатель снят, страница шлёт превью сама (sfu_fallback): кодируется только превью. */
    @Volatile private var fallback = false

    val previewWidth get() = layers[previewIndex].width
    val previewHeight get() = layers[previewIndex].height

    /** `{sdp, mid, codec, layers:[{rid,width,height,fps}]}` для ответа `started`. */
    fun offerJson(): JSONObject = JSONObject().apply {
        put("sdp", publisher.offerSdp)
        put("mid", publisher.mid)
        put("codec", codecName)
        put("layers", JSONArray().apply {
            layers.forEach { l -> put(JSONObject().apply { put("rid", l.rid); put("width", l.width); put("height", l.height); put("fps", l.fps) }) }
        })
    }

    fun requestKeyframe(layer: Int?) {
        if (layer == null) layers.forEach { it.encoder.requestKeyframe() } else layers.getOrNull(layer)?.encoder?.requestKeyframe()
    }

    /** Бюджет слоёв от издателя: 0 — слой не рисуется и не кодируется (кроме превью). */
    fun setBitrates(list: List<Int>) {
        if (fallback) return
        list.forEachIndexed { i, bps ->
            val layer = layers.getOrNull(i) ?: return@forEachIndexed
            if (bps <= 0) {
                if (!layer.paused) {
                    layer.paused = true
                    // Превью нужно странице и на паузе: его кодировщик работает дальше.
                    if (i != previewIndex) layer.encoder.setSuspended(true)
                }
            } else {
                layer.encoder.setBitrate(bps)
                if (layer.paused) {
                    layer.paused = false
                    if (i != previewIndex) layer.encoder.setSuspended(false) else layer.encoder.requestKeyframe()
                }
            }
        }
    }

    /**
     * Издатель не смог (или звонок ушёл в mesh), а перезапуск захвата на Android — новое
     * окно согласия. Страница шлёт превью сама; остальные слои встают, издатель закрывается.
     * На потоке handler (close ждёт поток издателя — не из его колбэка).
     */
    fun fallbackToPreview() {
        if (released || fallback) return
        fallback = true
        layers.forEachIndexed { i, layer ->
            if (i == previewIndex) {
                layer.paused = false
                layer.encoder.setBitrate(layer.bps)
            } else if (!layer.paused) {
                layer.paused = true
                layer.encoder.setSuspended(true)
            }
        }
        publisher.close()
    }

    // --- OpenGL (всё на потоке handler) ---------------------------------------------------

    private fun setupGl(): Boolean {
        display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY)
        if (display == EGL14.EGL_NO_DISPLAY) return false
        val version = IntArray(2)
        if (!EGL14.eglInitialize(display, version, 0, version, 1)) return false
        val attribs = intArrayOf(
            EGL14.EGL_RED_SIZE, 8, EGL14.EGL_GREEN_SIZE, 8, EGL14.EGL_BLUE_SIZE, 8,
            EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT,
            EGL_RECORDABLE_ANDROID, 1,
            EGL14.EGL_SURFACE_TYPE, EGL14.EGL_WINDOW_BIT or EGL14.EGL_PBUFFER_BIT,
            EGL14.EGL_NONE,
        )
        val configs = arrayOfNulls<EGLConfig>(1)
        val count = IntArray(1)
        if (!EGL14.eglChooseConfig(display, attribs, 0, configs, 0, 1, count, 0) || count[0] == 0) return false
        config = configs[0]
        context = EGL14.eglCreateContext(display, config, EGL14.EGL_NO_CONTEXT, intArrayOf(EGL14.EGL_CONTEXT_CLIENT_VERSION, 2, EGL14.EGL_NONE), 0)
        if (context == EGL14.EGL_NO_CONTEXT) return false
        pbuffer = EGL14.eglCreatePbufferSurface(display, config, intArrayOf(EGL14.EGL_WIDTH, 1, EGL14.EGL_HEIGHT, 1, EGL14.EGL_NONE), 0)
        if (!EGL14.eglMakeCurrent(display, pbuffer, pbuffer, context)) return false
        for (layer in layers) {
            val surface = layer.encoder.inputSurface ?: return false
            layer.eglSurface = EGL14.eglCreateWindowSurface(display, config, surface, intArrayOf(EGL14.EGL_NONE), 0)
            if (layer.eglSurface == EGL14.EGL_NO_SURFACE) return false
        }
        program = buildProgram() ?: return false
        val tex = IntArray(1)
        GLES20.glGenTextures(1, tex, 0)
        texture = tex[0]
        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, texture)
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR)
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR)
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE)
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE)
        val st = SurfaceTexture(texture)
        st.setDefaultBufferSize(srcWidth, srcHeight)
        st.setOnFrameAvailableListener({ drawFrame() }, handler)
        surfaceTexture = st
        inputSurface = Surface(st)
        return true
    }

    private fun drawFrame() {
        if (released) return
        val st = surfaceTexture ?: return
        try {
            EGL14.eglMakeCurrent(display, pbuffer, pbuffer, context)
            st.updateTexImage()
            st.getTransformMatrix(matrix)
            val ns = st.timestamp
            for ((i, layer) in layers.withIndex()) {
                if (layer.paused && i != previewIndex) continue
                // Своя частота слоя: кадр не раньше, чем через ~0,9 интервала.
                val interval = 1_000_000_000L / layer.fps
                if (layer.lastNs != 0L && ns - layer.lastNs < interval * 9 / 10) continue
                layer.lastNs = ns
                if (!EGL14.eglMakeCurrent(display, layer.eglSurface, layer.eglSurface, context)) continue
                viewport(layer)
                draw()
                EGLExt.eglPresentationTimeANDROID(display, layer.eglSurface, ns)
                EGL14.eglSwapBuffers(display, layer.eglSurface)
            }
        } catch (e: Exception) {
        }
    }

    /**
     * Стороны слоя кратны 16 и округлены независимо — картинка вписывается с полями, а не
     * растягивается (на нижнем слое растяжение доходило до ~5 %, текст плыл).
     */
    private fun viewport(layer: Layer) {
        val k = minOf(layer.width.toDouble() / srcWidth, layer.height.toDouble() / srcHeight)
        val w = Math.round(srcWidth * k).toInt().coerceAtMost(layer.width)
        val h = Math.round(srcHeight * k).toInt().coerceAtMost(layer.height)
        if (layer.width - w <= 2 && layer.height - h <= 2) {
            GLES20.glViewport(0, 0, layer.width, layer.height)
            return
        }
        GLES20.glViewport(0, 0, layer.width, layer.height)
        GLES20.glClearColor(0f, 0f, 0f, 1f)
        GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT)
        GLES20.glViewport(((layer.width - w) / 2) and 1.inv(), ((layer.height - h) / 2) and 1.inv(), w, h)
    }

    private fun draw() {
        GLES20.glUseProgram(program)
        val pos = GLES20.glGetAttribLocation(program, "aPos")
        val uv = GLES20.glGetAttribLocation(program, "aUv")
        GLES20.glEnableVertexAttribArray(pos)
        GLES20.glVertexAttribPointer(pos, 2, GLES20.GL_FLOAT, false, 16, QUAD.position(0))
        GLES20.glEnableVertexAttribArray(uv)
        GLES20.glVertexAttribPointer(uv, 2, GLES20.GL_FLOAT, false, 16, QUAD.position(2))
        GLES20.glUniformMatrix4fv(GLES20.glGetUniformLocation(program, "uTex"), 1, false, matrix, 0)
        GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, texture)
        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)
    }

    private fun buildProgram(): Int? {
        fun shader(type: Int, src: String): Int? {
            val s = GLES20.glCreateShader(type)
            GLES20.glShaderSource(s, src)
            GLES20.glCompileShader(s)
            val ok = IntArray(1)
            GLES20.glGetShaderiv(s, GLES20.GL_COMPILE_STATUS, ok, 0)
            return if (ok[0] == 0) null else s
        }
        val vs = shader(GLES20.GL_VERTEX_SHADER, VERTEX) ?: return null
        val fs = shader(GLES20.GL_FRAGMENT_SHADER, FRAGMENT) ?: return null
        val p = GLES20.glCreateProgram()
        GLES20.glAttachShader(p, vs)
        GLES20.glAttachShader(p, fs)
        GLES20.glLinkProgram(p)
        val ok = IntArray(1)
        GLES20.glGetProgramiv(p, GLES20.GL_LINK_STATUS, ok, 0)
        return if (ok[0] == 0) null else p
    }

    /** На потоке handler: GL, кодировщики, издатель. */
    fun release() {
        if (released) return
        released = true
        try { surfaceTexture?.setOnFrameAvailableListener(null) } catch (e: Exception) {}
        if (display != EGL14.EGL_NO_DISPLAY) {
            EGL14.eglMakeCurrent(display, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT)
            layers.forEach { if (it.eglSurface != EGL14.EGL_NO_SURFACE) EGL14.eglDestroySurface(display, it.eglSurface) }
            if (pbuffer != EGL14.EGL_NO_SURFACE) EGL14.eglDestroySurface(display, pbuffer)
            if (context != EGL14.EGL_NO_CONTEXT) EGL14.eglDestroyContext(display, context)
            EGL14.eglReleaseThread()
            EGL14.eglTerminate(display)
        }
        display = EGL14.EGL_NO_DISPLAY
        try { inputSurface?.release() } catch (e: Exception) {}
        try { surfaceTexture?.release() } catch (e: Exception) {}
        inputSurface = null
        surfaceTexture = null
        layers.forEach { it.encoder.release() }
        publisher.close()
    }

    class Spec(val rid: String, val scale: Double, val fps: Int, val bpp: Double, val minBps: Int, val maxBps: Int)

    companion object {
        private const val EGL_RECORDABLE_ANDROID = 0x3142

        private const val VERTEX = """
            attribute vec4 aPos;
            attribute vec4 aUv;
            uniform mat4 uTex;
            varying vec2 vUv;
            void main() { gl_Position = aPos; vUv = (uTex * aUv).xy; }
        """
        private const val FRAGMENT = """
            #extension GL_OES_EGL_image_external : require
            precision mediump float;
            varying vec2 vUv;
            uniform samplerExternalOES sTex;
            void main() { gl_FragColor = texture2D(sTex, vUv); }
        """

        /** x, y, u, v — полноэкранный прямоугольник. */
        private val QUAD: FloatBuffer = ByteBuffer.allocateDirect(16 * 4).order(ByteOrder.nativeOrder()).asFloatBuffer().apply {
            put(floatArrayOf(-1f, -1f, 0f, 0f, 1f, -1f, 1f, 0f, -1f, 1f, 0f, 1f, 1f, 1f, 1f, 1f))
        }

        /** `options.sfu` страницы (voiceNativeSfuScreenSpec): до трёх слоёв от меньшего. */
        fun parseSpecs(sfu: JSONObject, fps: Int): List<Spec> {
            val list = sfu.optJSONArray("layers") ?: return emptyList()
            return (0 until minOf(3, list.length())).mapNotNull { i ->
                val l = list.optJSONObject(i) ?: return@mapNotNull null
                val minBps = l.optInt("minBps", 300_000).coerceAtLeast(100_000)
                Spec(
                    l.optString("rid", listOf("q", "h", "f")[i]).take(8),
                    l.optDouble("scale", 1.0).coerceAtLeast(1.0),
                    l.optInt("fps", fps).coerceIn(1, fps),
                    l.optDouble("bpp", 0.08).coerceIn(0.01, 1.0),
                    minBps,
                    l.optInt("maxBps", 8_000_000).coerceIn(minBps, 200_000_000),
                )
            }
        }

        /**
         * Кодировщики, издатель и раздача кадров. null — что-то не поднялось (тогда
         * демонстрация идёт прежним путём, через WebRTC страницы). Звать на потоке handler.
         */
        fun create(
            handler: Handler,
            codecHandler: Handler,
            req: NativeBridge.MediaScreenRequest,
            sfu: JSONObject,
            topWidth: Int,
            topHeight: Int,
            srcWidth: Int,
            srcHeight: Int,
            /** `started` странице: с готовым объектом (оффер издателя), не раньше. */
            onPreviewStarted: (layers: ScreenSfuLayers, codec: String) -> Unit,
            onPreviewFrame: (bytes: ByteArray, keyframe: Boolean) -> Boolean,
            onError: (String) -> Unit,
            onPublisherEvent: (ScreenSfuLayers, JSONObject) -> Unit,
        ): ScreenSfuLayers? {
            val specs = parseSpecs(sfu, req.fps)
            if (specs.isEmpty()) return null
            // Кодек: первый из списка страницы (его декодируют все в комнате), который здесь
            // кодируется аппаратно и который страница декодирует для превью (слой превью сжат
            // тем же кодеком). Не завёлся — следующий; H.264 — последний.
            val previewOk = sfu.optJSONArray("previewDecode")?.let { a -> (0 until a.length()).map { a.optString(it).uppercase() }.toSet() } ?: setOf("H264")
            val wanted = sfu.optJSONArray("codecs")?.let { a -> (0 until a.length()).map { a.optString(it).uppercase() } } ?: emptyList()
            val candidates = (wanted.filter { it != "H264" && it in previewOk } + "H264").distinct().filter { name ->
                val mime = ScreenH264Encoder.mimeOf(name) ?: return@filter false
                name == "H264" || ScreenH264Encoder.hardwareEncoderAvailable(mime)
            }
            for (name in candidates) {
                val out = createWith(name, specs, handler, codecHandler, req, sfu, topWidth, topHeight, srcWidth, srcHeight,
                    onPreviewStarted, onPreviewFrame, onError, onPublisherEvent)
                if (out != null) return out
                android.util.Log.w("ZaliSfu", "native screen: $name не завёлся, следующий кодек")
            }
            return null
        }

        private fun createWith(
            codecName: String,
            specs: List<Spec>,
            handler: Handler,
            codecHandler: Handler,
            req: NativeBridge.MediaScreenRequest,
            sfu: JSONObject,
            topWidth: Int,
            topHeight: Int,
            srcWidth: Int,
            srcHeight: Int,
            onPreviewStarted: (layers: ScreenSfuLayers, codec: String) -> Unit,
            onPreviewFrame: (bytes: ByteArray, keyframe: Boolean) -> Boolean,
            onError: (String) -> Unit,
            onPublisherEvent: (ScreenSfuLayers, JSONObject) -> Unit,
        ): ScreenSfuLayers? {
            val mime = ScreenH264Encoder.mimeOf(codecName) ?: return null
            // Отказ H.265/AV1 при старте — не ошибка показа: create возьмёт следующий кодек.
            var starting = true
            val reportError: (String) -> Unit = { msg -> if (!(starting && codecName != "H264")) onError(msg) }
            val preview = sfu.optInt("previewLayer", 0).coerceIn(0, specs.size - 1)
            // Стороны кратны 16: часть аппаратных кодировщиков иначе отказывает.
            fun align(v: Double) = ((v.toInt() / 16) * 16).coerceAtLeast(16)
            val dims = specs.map { s ->
                val w = align(topWidth / s.scale)
                val h = align(topHeight / s.scale)
                val bps = (w.toDouble() * h * s.fps * s.bpp).toLong().coerceIn(s.minBps.toLong(), s.maxBps.toLong()).toInt()
                Triple(w, h, bps)
            }
            val config = JSONObject().apply {
                put("layers", JSONArray().apply {
                    specs.forEachIndexed { i, s ->
                        put(JSONObject().apply {
                            put("rid", s.rid); put("width", dims[i].first); put("height", dims[i].second)
                            put("fps", s.fps); put("max_bitrate", s.maxBps)
                        })
                    }
                })
                put("start_bitrate", sfu.optInt("startBitrate", 2_500_000))
                put("codec", codecName)
            }
            // Событие издателя может прийти раньше, чем объект собран: держим ссылку здесь.
            var self: ScreenSfuLayers? = null
            // CSD превью часть кодировщиков отдаёт сразу после start() — с потока кодека,
            // пока объект ещё не собран. Тогда `started` ушёл бы без оффера: откладываем
            // строку кодека до конца create (под замком — потоки разные).
            val startLock = Any()
            var ready: ScreenSfuLayers? = null
            var pendingCodec: String? = null
            val publisher = SfuPublisher.create(config) { ev -> handler.post { self?.let { onPublisherEvent(it, ev) } } } ?: return null
            val layers = ArrayList<Layer>()
            for ((i, s) in specs.withIndex()) {
                val (w, h, bps) = dims[i]
                val isPreview = i == preview
                val encoder = ScreenH264Encoder(
                    w, h, s.fps, req.stream, codecHandler,
                    onStarted = { codec ->
                        if (isPreview) {
                            val target = synchronized(startLock) { ready ?: run { pendingCodec = codec; null } }
                            if (target != null) onPreviewStarted(target, codec)
                        }
                    },
                    onFrame = { bytes, key -> if (isPreview) onPreviewFrame(bytes, key) else true },
                    onError = reportError,
                    bitrate = bps,
                    onEncoded = { data, key, pts -> publisher.push(i, data, key, pts) },
                    toPage = isPreview,
                    mime = mime,
                )
                if (!encoder.start()) {
                    layers.forEach { it.encoder.release() }
                    publisher.close()
                    return null
                }
                layers.add(Layer(s.rid, w, h, s.fps, bps, encoder))
            }
            starting = false
            val out = ScreenSfuLayers(handler, srcWidth, srcHeight, publisher, layers, preview, codecName)
            if (!out.setupGl()) {
                out.release()
                return null
            }
            self = out
            val codec = synchronized(startLock) {
                ready = out
                pendingCodec.also { pendingCodec = null }
            }
            if (codec != null) onPreviewStarted(out, codec)
            return out
        }
    }
}
