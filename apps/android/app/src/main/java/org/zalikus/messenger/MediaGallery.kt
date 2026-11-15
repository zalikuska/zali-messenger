package org.zalikus.messenger

import android.Manifest
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.util.Size
import android.webkit.WebResourceResponse
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * Галерея внутри приложения: лист с плитками последних фото и видео
 * (web/src/interface/media_sheet.js), первая плитка — камера.
 *
 * Превью и оригиналы вебвью получает обычными запросами по адресу
 * `https://zali-gallery.invalid/<token>/…`, который перехватывает
 * [intercept] (MainActivity, `shouldInterceptRequest`) — без base64 через мост и
 * без data:-адресов в разметке. Токен случайный на процесс и уходит только в
 * ответах моста, а мост отвечает лишь верхнему фрейму (bridgeNonce): песочница
 * аддона (iframe) адреса не знает и галерею прочитать не может. Домен `.invalid`
 * в сеть не уходит никогда — даже если перехват не сработал.
 */
class MediaGallery(private val context: Context) {

    companion object {
        const val HOST = "zali-gallery.invalid"
        private const val THUMB_PX = 360
        private const val CAPTURE_DIR = "attachments/camera"
    }

    private val token: String = UUID.randomUUID().toString().replace("-", "")

    /** Снимки камеры, ещё не забранные вебом: имя → файл. Живут до перезапуска. */
    private val captures = ConcurrentHashMap<String, File>()

    // MARK: - Доступ

    /** Что просить у ОС, чтобы читать галерею. */
    fun requiredPermissions(): Array<String> = when {
        Build.VERSION.SDK_INT >= 34 -> arrayOf(
            Manifest.permission.READ_MEDIA_IMAGES,
            Manifest.permission.READ_MEDIA_VIDEO,
            Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED,
        )
        Build.VERSION.SDK_INT >= 33 -> arrayOf(
            Manifest.permission.READ_MEDIA_IMAGES,
            Manifest.permission.READ_MEDIA_VIDEO,
        )
        else -> arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE)
    }

    private fun granted(permission: String) =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

    /**
     * `full` — вся галерея; `partial` — Android 14+ «только выбранные» (видно то,
     * что человек отметил в системном окне); `none` — доступа нет.
     */
    fun access(): String = when {
        Build.VERSION.SDK_INT >= 33 &&
            granted(Manifest.permission.READ_MEDIA_IMAGES) &&
            granted(Manifest.permission.READ_MEDIA_VIDEO) -> "full"
        Build.VERSION.SDK_INT >= 34 &&
            granted(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED) -> "partial"
        Build.VERSION.SDK_INT < 33 && granted(Manifest.permission.READ_EXTERNAL_STORAGE) -> "full"
        else -> "none"
    }

    // MARK: - Список

    /** Последние фото и видео, новые первыми. Вызывать не на главном потоке. */
    fun list(limit: Int): JSONArray {
        val items = JSONArray()
        if (access() == "none") return items
        val collection = MediaStore.Files.getContentUri("external")
        val projection = mutableListOf(
            MediaStore.Files.FileColumns._ID,
            MediaStore.Files.FileColumns.MEDIA_TYPE,
            MediaStore.Files.FileColumns.MIME_TYPE,
            MediaStore.Files.FileColumns.DISPLAY_NAME,
            MediaStore.Files.FileColumns.DATE_ADDED,
        )
        if (Build.VERSION.SDK_INT >= 29) projection += MediaStore.Files.FileColumns.DURATION
        val selection = "${MediaStore.Files.FileColumns.MEDIA_TYPE} IN (?, ?)"
        val args = arrayOf(
            MediaStore.Files.FileColumns.MEDIA_TYPE_IMAGE.toString(),
            MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO.toString(),
        )
        val order = "${MediaStore.Files.FileColumns.DATE_ADDED} DESC"
        try {
            context.contentResolver.query(collection, projection.toTypedArray(), selection, args, order)?.use { c ->
                val idCol = c.getColumnIndexOrThrow(MediaStore.Files.FileColumns._ID)
                val typeCol = c.getColumnIndexOrThrow(MediaStore.Files.FileColumns.MEDIA_TYPE)
                val mimeCol = c.getColumnIndexOrThrow(MediaStore.Files.FileColumns.MIME_TYPE)
                val nameCol = c.getColumnIndexOrThrow(MediaStore.Files.FileColumns.DISPLAY_NAME)
                val durCol = if (Build.VERSION.SDK_INT >= 29) c.getColumnIndex(MediaStore.Files.FileColumns.DURATION) else -1
                while (c.moveToNext() && items.length() < limit) {
                    val id = c.getLong(idCol)
                    val video = c.getInt(typeCol) == MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO
                    val kind = if (video) "video" else "image"
                    val mime = c.getString(mimeCol) ?: if (video) "video/mp4" else "image/jpeg"
                    items.put(JSONObject().apply {
                        put("id", "$kind-$id")
                        put("kind", kind)
                        put("mime", mime)
                        put("name", c.getString(nameCol) ?: "$kind-$id")
                        if (video && durCol >= 0) put("durationMs", c.getLong(durCol))
                        put("thumb", url("thumb/$kind/$id"))
                        put("full", url("full/$kind/$id"))
                    })
                }
            }
        } catch (e: Exception) {
            // Запрет, отозванный между проверкой и запросом, — пустой список.
        }
        return items
    }

    private fun url(path: String) = "https://$HOST/$token/$path"

    private fun mediaUri(kind: String, id: Long): Uri = ContentUris.withAppendedId(
        if (kind == "video") MediaStore.Video.Media.EXTERNAL_CONTENT_URI
        else MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
        id,
    )

    // MARK: - Камера

    /** Файл под снимок и content://-адрес для камеры (FileProvider, cache-path). */
    fun newCaptureTarget(): Pair<String, Uri> {
        val dir = File(context.cacheDir, CAPTURE_DIR).apply { mkdirs() }
        val name = "photo_${System.currentTimeMillis()}.jpg"
        val file = File(dir, name)
        captures[name] = file
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
        return name to uri
    }

    /** Снимок готов — описание для веба; null, если камера ничего не записала. */
    fun captureItem(name: String): JSONObject? {
        val file = captures[name] ?: return null
        if (!file.exists() || file.length() == 0L) {
            captures.remove(name)
            file.delete()
            return null
        }
        return JSONObject().apply {
            put("id", "capture-$name")
            put("kind", "image")
            put("mime", "image/jpeg")
            put("name", name)
            put("full", url("capture/$name"))
        }
    }

    fun discardCapture(name: String) {
        captures.remove(name)?.delete()
    }

    // MARK: - Перехват запросов вебвью

    /**
     * Ответ на `https://zali-gallery.invalid/<token>/…` или null — не наш адрес.
     * Вызывается вебвью на фоновом потоке.
     */
    fun intercept(uri: Uri): WebResourceResponse? {
        if (!uri.host.equals(HOST, ignoreCase = true)) return null
        val parts = uri.pathSegments
        // Наш домен, но чужой токен или мусор — 404, а не проход в сеть.
        if (parts.size < 2 || parts[0] != token) return notFound()
        return try {
            when (parts[1]) {
                "thumb" -> if (parts.size == 4) thumb(parts[2], parts[3].toLong()) else notFound()
                "full" -> if (parts.size == 4) full(parts[2], parts[3].toLong()) else notFound()
                "capture" -> if (parts.size == 3) capture(parts[2]) else notFound()
                else -> notFound()
            }
        } catch (e: Exception) {
            notFound()
        }
    }

    private fun thumb(kind: String, id: Long): WebResourceResponse {
        val uri = mediaUri(kind, id)
        val bitmap: Bitmap? = if (Build.VERSION.SDK_INT >= 29) {
            context.contentResolver.loadThumbnail(uri, Size(THUMB_PX, THUMB_PX), null)
        } else {
            @Suppress("DEPRECATION")
            if (kind == "video") {
                MediaStore.Video.Thumbnails.getThumbnail(
                    context.contentResolver, id, MediaStore.Video.Thumbnails.MINI_KIND, null,
                )
            } else {
                MediaStore.Images.Thumbnails.getThumbnail(
                    context.contentResolver, id, MediaStore.Images.Thumbnails.MINI_KIND, null,
                )
            }
        }
        bitmap ?: return notFound()
        val out = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.JPEG, 82, out)
        bitmap.recycle()
        return ok("image/jpeg", ByteArrayInputStream(out.toByteArray()), cache = true)
    }

    private fun full(kind: String, id: Long): WebResourceResponse {
        val uri = mediaUri(kind, id)
        val mime = context.contentResolver.getType(uri) ?: if (kind == "video") "video/mp4" else "image/jpeg"
        val stream = context.contentResolver.openInputStream(uri) ?: return notFound()
        return ok(mime, stream, cache = false)
    }

    private fun capture(name: String): WebResourceResponse {
        val file = captures[name] ?: return notFound()
        if (!file.exists()) return notFound()
        return ok("image/jpeg", FileInputStream(file), cache = false)
    }

    private fun headers(cache: Boolean) = mapOf(
        // Документ — file://, его fetch() идёт с Origin: null.
        "Access-Control-Allow-Origin" to "*",
        "Cache-Control" to if (cache) "private, max-age=3600" else "no-store",
    )

    private fun ok(mime: String, data: java.io.InputStream, cache: Boolean) =
        WebResourceResponse(mime, null, 200, "OK", headers(cache), data)

    private fun notFound() =
        WebResourceResponse("text/plain", "utf-8", 404, "Not Found", headers(false), ByteArrayInputStream(ByteArray(0)))
}
