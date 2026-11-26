package org.zalikus.messenger

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Текстовые сообщения, которые фоновый пуш расшифровал, пока приложение свёрнуто.
 *
 * Без этого уведомление приходит сразу, а сама переписка получает сообщение только
 * после того, как сокет переподключится (минуты в фоне). Здесь пуш оставляет
 * расшифрованный payload в приватном файле пользователя; при показе приложения веб
 * получает его через тот же `receiveMessage`, что и живая доставка, и только после
 * подтверждения (`true`) запись удаляется.
 *
 * Открытый текст лежит на диске, пока его не доставили, — осознанное решение. Поэтому:
 * только текст без вложений и звонков (вложения — отдельные файлы, их пуш не
 * сохраняет), не дольше [MAX_AGE_MS], не больше [MAX_ITEMS], файл удаляется при выходе
 * из аккаунта (`PushSession.clear`), и `allowBackup` выключен.
 */
object PendingPush {
    private const val MAX_ITEMS = 100
    private const val MAX_AGE_MS = 3L * 24 * 60 * 60 * 1000
    private val lock = Any()

    private fun file(context: Context, username: String): File =
        File(context.applicationContext.filesDir, "pending_push_${username.trim().lowercase()}.json")

    /** [item] — payload в форме `receiveMessage` (id, sender, receiver, text, …). */
    fun add(context: Context, username: String, item: JSONObject) {
        val id = item.optString("id")
        if (id.isEmpty() || username.isBlank()) return
        synchronized(lock) {
            val now = System.currentTimeMillis()
            val kept = read(context, username)
                .filter { it.optString("id") != id && now - it.optLong("savedAt") < MAX_AGE_MS }
                .toMutableList()
            kept.add(JSONObject(item.toString()).put("savedAt", now))
            write(context, username, kept.takeLast(MAX_ITEMS))
        }
    }

    fun all(context: Context, username: String): List<JSONObject> = synchronized(lock) {
        val now = System.currentTimeMillis()
        read(context, username).filter { now - it.optLong("savedAt") < MAX_AGE_MS }
    }

    fun remove(context: Context, username: String, id: String) {
        synchronized(lock) {
            write(context, username, read(context, username).filter { it.optString("id") != id })
        }
    }

    /** Выход из аккаунта: чужие непрочитанные тексты на устройстве не оставляем. */
    fun clearAll(context: Context) {
        synchronized(lock) {
            context.applicationContext.filesDir.listFiles { f -> f.name.startsWith("pending_push_") }
                ?.forEach { it.delete() }
        }
    }

    private fun read(context: Context, username: String): List<JSONObject> {
        val f = file(context, username)
        if (!f.isFile) return emptyList()
        return try {
            val arr = JSONArray(f.readText())
            (0 until arr.length()).mapNotNull { arr.optJSONObject(it) }
        } catch (e: Exception) {
            emptyList()
        }
    }

    private fun write(context: Context, username: String, items: List<JSONObject>) {
        val f = file(context, username)
        if (items.isEmpty()) {
            f.delete()
            return
        }
        val arr = JSONArray()
        items.forEach { arr.put(it) }
        f.writeText(arr.toString())
    }
}
