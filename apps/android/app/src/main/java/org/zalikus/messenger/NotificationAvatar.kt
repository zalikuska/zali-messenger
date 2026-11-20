package org.zalikus.messenger

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Typeface
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Аватарка отправителя для уведомления (`setLargeIcon`).
 *
 * Уведомление собирается и без WebView — в фоне, из FCM, — поэтому веб-кеш аватарок
 * (IndexedDB, `ensureAvatarLoaded`) недоступен, и аватарку тянет сам натив: тем же
 * `GET /api/avatar/<имя>` и тем же токеном сессии, что лежит в [PushSession].
 *
 * Готовый круг 192×192 хранится в `cacheDir/notif_avatars/` (ОС вправе его очистить —
 * тогда скачается заново). Устаревшая запись показывается сразу, а обновляется в фоне:
 * уведомление не ждёт сеть ради картинки, которая почти всегда не менялась.
 * Нет аватарки (404) или сеть не ответила — рисуется кружок с буквой в акцентном лайме,
 * как заглушка в самом приложении; об этом помним [MISS_MS], чтобы не стучаться на
 * каждое сообщение.
 */
object NotificationAvatar {
    private const val DIR = "notif_avatars"
    private const val SIZE = 192
    private const val FRESH_MS = 60L * 60 * 1000
    private const val MISS_MS = 10L * 60 * 1000
    private const val ACCENT = 0xFFCBFF00.toInt()   // --accent-rgb 203,255,0
    private const val INK = 0xFF090B0E.toInt()      // --bg

    private val client = OkHttpClient.Builder()
        .callTimeout(4, TimeUnit.SECONDS)
        .build()
    private val executor = Executors.newSingleThreadExecutor()
    private val misses = ConcurrentHashMap<String, Long>()
    private val inflight = ConcurrentHashMap.newKeySet<String>()

    private fun key(username: String) = username.trim().lowercase()

    private fun file(context: Context, username: String): File {
        val digest = MessageDigest.getInstance("SHA-1").digest(key(username).toByteArray())
        val name = digest.joinToString("") { "%02x".format(it) }
        return File(File(context.applicationContext.cacheDir, DIR), "$name.png")
    }

    /** Круг из диска (любой давности) или null. Быстро — годится для вызова с любого потока. */
    fun cached(context: Context, username: String): Bitmap? {
        if (key(username).isEmpty()) return null
        val f = file(context, username)
        if (!f.isFile) return null
        return try {
            BitmapFactory.decodeFile(f.path)
        } catch (e: Exception) {
            null
        }
    }

    fun isStale(context: Context, username: String): Boolean {
        val f = file(context, username)
        return !f.isFile || System.currentTimeMillis() - f.lastModified() > FRESH_MS
    }

    /**
     * Скачать и сохранить. Блокирует поток до [OkHttpClient.callTimeout] — вызывать только
     * не с главного. Null — аватарки нет или сеть не ответила.
     */
    fun fetch(context: Context, username: String): Bitmap? {
        val name = username.trim()
        val k = key(name)
        if (k.isEmpty()) return null
        val missAt = misses[k]
        if (missAt != null && System.currentTimeMillis() - missAt < MISS_MS) return null
        val session = PushSession.load(context) ?: return null
        return try {
            val request = Request.Builder()
                .url("${session.apiBaseUrl}/api/avatar/${android.net.Uri.encode(name)}")
                .header("Authorization", "Bearer ${session.authToken}")
                .header("X-Zali-Device-ID", session.deviceId)
                .build()
            client.newCall(request).execute().use { response ->
                if (response.code == 404) {
                    // Окончательно: картинки у человека нет. Старый файл (если был) уже не нужен.
                    misses[k] = System.currentTimeMillis()
                    file(context, name).delete()
                    return null
                }
                if (!response.isSuccessful) {
                    misses[k] = System.currentTimeMillis()
                    return null
                }
                val bytes = response.body?.bytes() ?: return null
                val circle = circle(bytes) ?: run {
                    misses[k] = System.currentTimeMillis()
                    return null
                }
                val f = file(context, name)
                f.parentFile?.mkdirs()
                f.outputStream().use { circle.compress(Bitmap.CompressFormat.PNG, 100, it) }
                misses.remove(k)
                circle
            }
        } catch (e: Exception) {
            misses[k] = System.currentTimeMillis()
            null
        }
    }

    /** Обновить в фоне, не дожидаясь; [onFresh] — на фоновом потоке, только если скачалось. */
    fun refreshAsync(context: Context, username: String, onFresh: ((Bitmap) -> Unit)? = null) {
        val k = key(username)
        if (k.isEmpty() || !inflight.add(k)) return
        val appContext = context.applicationContext
        executor.execute {
            try {
                fetch(appContext, username)?.let { onFresh?.invoke(it) }
            } finally {
                inflight.remove(k)
            }
        }
    }

    fun clear(context: Context) {
        misses.clear()
        File(context.applicationContext.cacheDir, DIR).deleteRecursively()
    }

    /** Квадрат по центру → круг [SIZE]. Null — не картинка. */
    private fun circle(bytes: ByteArray): Bitmap? {
        val source = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return null
        val side = minOf(source.width, source.height)
        if (side <= 0) return null
        val square = Bitmap.createBitmap(
            source, (source.width - side) / 2, (source.height - side) / 2, side, side,
        )
        val scaled = Bitmap.createScaledBitmap(square, SIZE, SIZE, true)
        val out = Bitmap.createBitmap(SIZE, SIZE, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(out)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        canvas.drawCircle(SIZE / 2f, SIZE / 2f, SIZE / 2f, paint)
        paint.xfermode = android.graphics.PorterDuffXfermode(android.graphics.PorterDuff.Mode.SRC_IN)
        canvas.drawBitmap(scaled, 0f, 0f, paint)
        return out
    }

    /** Заглушка без картинки: буква на лайме, как `.ava` без аватарки в приложении. */
    fun letter(username: String): Bitmap {
        val out = Bitmap.createBitmap(SIZE, SIZE, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(out)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        paint.color = ACCENT
        canvas.drawCircle(SIZE / 2f, SIZE / 2f, SIZE / 2f, paint)
        val initial = username.trim().codePoints().findFirst().let {
            if (it.isPresent) String(Character.toChars(it.asInt)).uppercase() else "Z"
        }
        paint.color = INK
        paint.typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
        paint.textSize = SIZE * 0.5f
        paint.textAlign = Paint.Align.CENTER
        val baseline = SIZE / 2f - (paint.descent() + paint.ascent()) / 2f
        canvas.drawText(initial, SIZE / 2f, baseline, paint)
        return out
    }
}
