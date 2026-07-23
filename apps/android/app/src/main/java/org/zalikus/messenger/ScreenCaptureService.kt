package org.zalikus.messenger

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.util.DisplayMetrics
import androidx.core.app.NotificationCompat
import java.io.ByteArrayOutputStream

/**
 * Foreground service hosting the MediaProjection capture loop for
 * START_SCREEN_CAPTURE (NativeBridge.kt). Android's WebView has no
 * getDisplayMedia() at all (a Chromium/WebView limitation, not a missing
 * bridge hook — see project_mobile_parity_effort memory), so this captures
 * the screen natively and pushes JPEG frames to NativeBridge, which relays
 * them to interface.js's onNativeScreenCaptureFrame — that repaints them onto
 * an offscreen <canvas> and feeds canvas.captureStream() into the existing
 * JS-managed RTCPeerConnection, exactly like a desktop getDisplayMedia() track.
 *
 * Must run as a foreground service with foregroundServiceType="mediaProjection"
 * (declared in AndroidManifest.xml) — required by Android 14+ (targetSdk 35)
 * before MediaProjection.createVirtualDisplay() will succeed at all.
 */
class ScreenCaptureService : Service() {

    private var mediaProjection: MediaProjection? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var imageReader: ImageReader? = null
    private var captureThread: HandlerThread? = null
    @Volatile private var lastFrameAtMs = 0L

    private val projectionCallback = object : MediaProjection.Callback() {
        override fun onStop() {
            // Fires when the user stops sharing via the OS's own screen-share
            // indicator/notification, not just our STOP_SCREEN_CAPTURE path.
            stopCaptureInternal()
            stopSelf()
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val resultCode = intent?.getIntExtra(EXTRA_RESULT_CODE, 0) ?: 0
        val resultData = intent?.getParcelableExtra<Intent>(EXTRA_RESULT_DATA)
        val requestId = intent?.getStringExtra(EXTRA_REQUEST_ID) ?: ""
        if (resultData == null || requestId.isEmpty()) {
            stopSelf()
            return START_NOT_STICKY
        }

        // The 3-arg overload (foreground service *type*) only exists from API 29 —
        // this app's minSdk is 26, so it must be guarded rather than called
        // unconditionally (the framework method itself doesn't exist below 29).
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        } else {
            startForeground(NOTIFICATION_ID, buildNotification())
        }

        val projectionManager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        val projection = try {
            projectionManager.getMediaProjection(resultCode, resultData)
        } catch (e: Exception) {
            null
        }
        if (projection == null) {
            NativeBridge.activeInstance?.onScreenCaptureError(requestId, "Не удалось получить доступ к экрану")
            stopSelf()
            return START_NOT_STICKY
        }
        mediaProjection = projection
        projection.registerCallback(projectionCallback, null)
        startCapture(projection, requestId)
        return START_NOT_STICKY
    }

    private fun startCapture(projection: MediaProjection, requestId: String) {
        val metrics = DisplayMetrics()
        @Suppress("DEPRECATION")
        (getSystemService(WINDOW_SERVICE) as android.view.WindowManager).defaultDisplay.getRealMetrics(metrics)

        val scale = if (metrics.widthPixels > MAX_WIDTH) MAX_WIDTH.toFloat() / metrics.widthPixels else 1f
        val width = (metrics.widthPixels * scale).toInt().coerceAtLeast(2)
        val height = (metrics.heightPixels * scale).toInt().coerceAtLeast(2)
        val density = metrics.densityDpi

        val thread = HandlerThread("ZaliScreenCapture").apply { start() }
        captureThread = thread
        val handler = Handler(thread.looper)

        val reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)
        imageReader = reader
        reader.setOnImageAvailableListener({ imgReader ->
            val image = try { imgReader.acquireLatestImage() } catch (e: Exception) { null } ?: return@setOnImageAvailableListener
            try {
                val now = System.currentTimeMillis()
                if (now - lastFrameAtMs < FRAME_INTERVAL_MS) return@setOnImageAvailableListener
                lastFrameAtMs = now
                val bytes = encodeJpeg(image, width, height)
                if (bytes != null) {
                    NativeBridge.activeInstance?.onScreenCaptureFrame(requestId, bytes)
                }
            } finally {
                image.close()
            }
        }, handler)

        virtualDisplay = projection.createVirtualDisplay(
            "ZaliScreenCapture", width, height, density,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            reader.surface, null, handler
        )
    }

    /** RGBA_8888 ImageReader frame -> JPEG bytes, accounting for row padding
     * (the buffer's row stride is rarely exactly width*pixelStride). */
    private fun encodeJpeg(image: android.media.Image, width: Int, height: Int): ByteArray? {
        return try {
            val plane = image.planes[0]
            val pixelStride = plane.pixelStride
            val rowStride = plane.rowStride
            val rowPadding = rowStride - pixelStride * width
            val paddedWidth = width + rowPadding / pixelStride
            val bitmap = Bitmap.createBitmap(paddedWidth, height, Bitmap.Config.ARGB_8888)
            bitmap.copyPixelsFromBuffer(plane.buffer)
            val cropped = if (rowPadding == 0) bitmap else Bitmap.createBitmap(bitmap, 0, 0, width, height)
            val out = ByteArrayOutputStream()
            cropped.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out)
            if (cropped !== bitmap) bitmap.recycle()
            out.toByteArray()
        } catch (e: Exception) {
            null
        }
    }

    private fun buildNotification(): android.app.Notification {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (manager.getNotificationChannel(CHANNEL_ID) == null) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Демонстрация экрана", NotificationManager.IMPORTANCE_LOW)
            )
        }
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_share)
            .setContentTitle("Демонстрация экрана")
            .setContentText("Zali Messenger транслирует ваш экран")
            .setOngoing(true)
            .build()
    }

    override fun onDestroy() {
        stopCaptureInternal()
        super.onDestroy()
    }

    private fun stopCaptureInternal() {
        virtualDisplay?.release()
        virtualDisplay = null
        imageReader?.close()
        imageReader = null
        captureThread?.quitSafely()
        captureThread = null
        try { mediaProjection?.unregisterCallback(projectionCallback) } catch (e: Exception) {}
        mediaProjection?.stop()
        mediaProjection = null
    }

    companion object {
        private const val CHANNEL_ID = "zali-screen-capture"
        private const val NOTIFICATION_ID = 4301
        private const val MAX_WIDTH = 960
        private const val TARGET_FPS = 8
        private const val FRAME_INTERVAL_MS = 1000L / TARGET_FPS
        private const val JPEG_QUALITY = 55

        private const val EXTRA_RESULT_CODE = "resultCode"
        private const val EXTRA_RESULT_DATA = "resultData"
        private const val EXTRA_REQUEST_ID = "requestId"

        fun start(context: Context, resultCode: Int, resultData: Intent, requestId: String) {
            val intent = Intent(context, ScreenCaptureService::class.java)
                .putExtra(EXTRA_RESULT_CODE, resultCode)
                .putExtra(EXTRA_RESULT_DATA, resultData)
                .putExtra(EXTRA_REQUEST_ID, requestId)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }
    }
}
