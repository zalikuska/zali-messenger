package org.zalikus.messenger

import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.UUID

/**
 * Хранилище аддонов хаба: `ADDON_REQUEST` (веб — `web/src/interface/addons_store.js`).
 *
 * На Android оно обязательно: документ живёт на `file://`, и IndexedDB там не
 * открывается (см. шапку `web/src/interface/cache.js`).
 *
 * `filesDir/addons/<id>/`:
 *   - `addon.zali` — файл аддона как его установили (магик `ZALIEXTN`);
 *   - `meta.json`  — сведения, которые веб показывает в хабе; здесь только хранятся;
 *   - `data/…`     — данные аддона «путь → байты» (`kv.json`, `cache/…`).
 *
 * Зеркала — `apps/windows/src/native/addons.rs` и macOS `Services/AddonStore.swift`.
 * Пути проверяются заново теми же правилами, что `pathError` в addon_format.js:
 * путь не должен суметь выйти из папки аддона.
 */
object AddonStore {
    class Failure(message: String) : Exception(message)

    private val MAGIC = "ZALIEXTN".toByteArray(Charsets.US_ASCII)
    private const val MAX_ARCHIVE_BYTES = 32 * 1024 * 1024
    private const val MAX_DATA_BYTES = 32 * 1024 * 1024
    private const val MAX_META_BYTES = 512 * 1024
    private const val MAX_PATH_BYTES = 255
    private const val MAX_LIST_ENTRIES = 20_000

    private val ID_RE = Regex("^[a-z0-9][a-z0-9._-]{2,63}$")
    private val SEGMENT_RE = Regex("^[A-Za-z0-9._-]+$")

    fun isValidId(id: String): Boolean = ID_RE.matches(id) && !id.contains("..")

    /** Путь данных → сегменты; ошибка — текстом, как у веба. */
    fun pathSegments(path: String): List<String> {
        if (path.isEmpty()) throw Failure("пустой путь")
        if (path.toByteArray(Charsets.UTF_8).size > MAX_PATH_BYTES) throw Failure("путь длиннее 255 байт")
        if (path.startsWith("/") || path.endsWith("/")) throw Failure("путь начинается или кончается «/»")
        return path.split("/").map { segment ->
            if (segment.isEmpty()) throw Failure("пустой сегмент пути")
            if (segment == "." || segment == "..") throw Failure("сегмент «.» или «..»")
            if (!SEGMENT_RE.matches(segment)) throw Failure("недопустимые символы в пути")
            segment
        }
    }

    fun handle(root: File, dict: JSONObject): JSONObject {
        return when (val op = dict.optString("op", "")) {
            "store.list" -> {
                val addons = JSONArray()
                root.listFiles()?.forEach { dir ->
                    val id = dir.name
                    if (!isValidId(id) || !File(dir, "addon.zali").isFile) return@forEach
                    val meta = try { JSONObject(File(dir, "meta.json").readText()) } catch (e: Exception) { null }
                    if (meta != null) addons.put(JSONObject().put("addonId", id).put("meta", meta))
                }
                JSONObject().put("addons", addons)
            }
            "store.get" -> {
                val file = File(addonDir(root, dict), "addon.zali")
                if (!file.isFile) throw Failure("Файл аддона не найден")
                val bytes = file.readBytes()
                JSONObject()
                    .put("dataBase64", Base64.encodeToString(bytes, Base64.NO_WRAP))
                    .put("sha256", sha256Hex(bytes))
            }
            "store.put" -> {
                val dir = addonDir(root, dict)
                val id = dict.optString("addonId", "")
                val meta = dict.optJSONObject("meta") ?: throw Failure("Нет сведений об аддоне")
                if (meta.optString("id", "") != id) throw Failure("Сведения не от этого аддона")
                val metaBytes = meta.toString().toByteArray(Charsets.UTF_8)
                if (metaBytes.size > MAX_META_BYTES) throw Failure("Сведения об аддоне слишком большие")
                val bytes = decodeBase64(dict, MAX_ARCHIVE_BYTES)
                if (bytes.size < MAGIC.size || !bytes.copyOfRange(0, MAGIC.size).contentEquals(MAGIC)) {
                    throw Failure("Это не файл аддона")
                }
                writeAtomic(File(dir, "addon.zali"), bytes)
                writeAtomic(File(dir, "meta.json"), metaBytes)
                JSONObject().put("sha256", sha256Hex(bytes))
            }
            "store.remove" -> {
                val dir = addonDir(root, dict)
                if (dir.exists() && !dir.deleteRecursively()) throw Failure("Не удалось удалить аддон")
                JSONObject()
            }
            "data.read" -> {
                val file = dataFile(root, dict)
                if (!file.isFile) {
                    JSONObject().put("exists", false)
                } else {
                    JSONObject()
                        .put("exists", true)
                        .put("dataBase64", Base64.encodeToString(file.readBytes(), Base64.NO_WRAP))
                }
            }
            "data.write" -> {
                val file = dataFile(root, dict)
                if (!File(addonDir(root, dict), "addon.zali").isFile) throw Failure("Аддон не установлен")
                writeAtomic(file, decodeBase64(dict, MAX_DATA_BYTES))
                JSONObject()
            }
            "data.delete" -> {
                val file = dataFile(root, dict)
                if (file.exists() && !file.delete()) throw Failure("Не удалось удалить")
                JSONObject()
            }
            "data.list" -> {
                val dataDir = File(addonDir(root, dict), "data")
                val prefix = dict.optString("path", "")
                if (prefix.toByteArray(Charsets.UTF_8).size > MAX_PATH_BYTES || prefix.contains("\\") || prefix.contains("..")) {
                    throw Failure("Недопустимый префикс")
                }
                val out = JSONArray()
                listData(dataDir, "", prefix, out)
                JSONObject().put("entries", out)
            }
            else -> throw Failure("Неизвестная операция аддонов «${op.take(40)}»")
        }
    }

    private fun addonDir(root: File, dict: JSONObject): File {
        val id = dict.optString("addonId", "")
        if (!isValidId(id)) throw Failure("Некорректный id аддона")
        return File(root, id)
    }

    private fun dataFile(root: File, dict: JSONObject): File {
        val rel = dict.optString("path", "")
        val segments = try { pathSegments(rel) } catch (e: Failure) { throw Failure("Путь «$rel»: ${e.message}") }
        var file = File(addonDir(root, dict), "data")
        for (segment in segments) file = File(file, segment)
        return file
    }

    private fun decodeBase64(dict: JSONObject, limit: Int): ByteArray {
        val encoded = dict.optString("dataBase64", "")
        if (encoded.length > limit / 3 * 4 + 8) throw Failure("Слишком большие данные")
        val bytes = try { Base64.decode(encoded, Base64.DEFAULT) } catch (e: IllegalArgumentException) {
            throw Failure("Данные повреждены (base64)")
        }
        if (bytes.size > limit) throw Failure("Слишком большие данные")
        return bytes
    }

    /** Через временный файл и переименование: оборванная запись не оставит половину файла. */
    private fun writeAtomic(file: File, bytes: ByteArray) {
        val parent = file.parentFile ?: throw Failure("Нет папки для записи")
        if (!parent.isDirectory && !parent.mkdirs()) throw Failure("Не удалось создать папку")
        val tmp = File(parent, ".${file.name}.tmp-${UUID.randomUUID()}")
        try {
            FileOutputStream(tmp).use { out ->
                out.write(bytes)
                out.fd.sync()
            }
            if (!tmp.renameTo(file)) throw Failure("Не удалось записать файл")
        } catch (e: Failure) {
            tmp.delete()
            throw e
        } catch (e: Exception) {
            tmp.delete()
            throw Failure("Не удалось записать файл: ${e.message}")
        }
    }

    private fun sha256Hex(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    private fun listData(dir: File, rel: String, prefix: String, out: JSONArray) {
        val entries = dir.listFiles() ?: return
        for (entry in entries) {
            if (out.length() >= MAX_LIST_ENTRIES) return
            val name = entry.name
            // Временные файлы writeAtomic и всё, что не прошло бы проверку пути.
            if (name.startsWith(".") || !SEGMENT_RE.matches(name)) continue
            val path = if (rel.isEmpty()) name else "$rel/$name"
            if (entry.isDirectory) {
                val asDir = "$path/"
                if (prefix.startsWith(asDir) || asDir.startsWith(prefix)) listData(entry, path, prefix, out)
            } else if (entry.isFile && path.startsWith(prefix)) {
                out.put(JSONObject().put("path", path).put("size", entry.length()))
            }
        }
    }
}
