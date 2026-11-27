package org.zalikus.messenger

import org.json.JSONObject

/**
 * Строка из JSON или null, если ключа нет, значение — JSON `null` или пустая строка.
 *
 * Зачем не `optString(name, "").ifEmpty { null }`: у org.json `optString` на
 * `JSONObject.NULL` возвращает литерал "null", а не запасное значение. Сервер шлёт
 * в кадре личного сообщения `"serverId": null` (server/src/messages.rs), и с
 * `optString` личка на Android превращалась в «канал null:null»: сообщение
 * падало не в ту ленту, а расшифровывалось ключом scope `server:null:null`
 * (отчёты `decrypt wrong-key/awaiting-key`, 403 на `server:null:null`).
 */
fun JSONObject.optStringOrNull(name: String, trim: Boolean = false): String? {
    if (isNull(name)) return null
    val raw = optString(name, "")
    val value = if (trim) raw.trim() else raw
    return value.ifEmpty { null }
}
