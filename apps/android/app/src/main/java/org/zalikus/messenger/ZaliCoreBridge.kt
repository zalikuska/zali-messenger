package org.zalikus.messenger

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

/**
 * Kotlin wrapper around the Rust Core crate's JNI bridge (`Core/src/android_jni.rs`),
 * loaded from `libzali_messenger_core.so`. Ported from `ZaliCore.swift` (macOS/iOS) —
 * same `busDispatch` JSON-in/JSON-out protocol, same `candidateMessageKeys` scoping,
 * so this should stay in sync with the Swift versions if the Core crate's API
 * ever changes.
 *
 * The `.so` is NOT built by this Gradle project — cross-compiling for Android
 * requires the Android NDK (for the C toolchain `cargo` links against), which
 * this repo's dev environment may not have installed. Build it with `cargo-ndk`
 * (`cargo install cargo-ndk`) from the repo root:
 *
 *   cargo ndk -t arm64-v8a -t x86_64 -o android/app/src/main/jniLibs \
 *       build --release --manifest-path core/Cargo.toml --features android
 *
 * (`android/build_android_core.sh` wraps this.) Run it whenever the Rust
 * sources under `Core/src` change, before building the APK.
 */
object ZaliCoreBridge {
    /** True once `libzali_messenger_core.so` loaded successfully. */
    val isAvailable: Boolean = try {
        System.loadLibrary("zali_messenger_core")
        true
    } catch (e: UnsatisfiedLinkError) {
        false
    }

    private external fun busDispatch(addressCommand: String, argsJson: String): String?

    data class Attachment(
        val name: String,
        val archivePath: String,
        val mimeType: String,
        val kind: String,
        val size: Long,
    )

    data class MessagePayload(
        val sender: String,
        val text: String,
        val timestamp: Long,
        val keyVersion: Int?,
        val attachments: List<Attachment>,
        /** Opaque structured payload (call records), decrypted by the core. */
        val call: String?,
        /** Opaque quote of the message this one replies to, decrypted by the core. */
        val reply: String?,
    )

    /**
     * Потолок перебора ключей при расшифровке. Ровно тот же, что у Windows
     * (`native/cache.rs::MAX_DECRYPT_CANDIDATES`) и macOS
     * (`WebView.swift::maxDecryptCandidates`).
     *
     * Каждый неподошедший кандидат — два прохода PBKDF2-SHA256 по 210 000
     * итераций (сессионный ключ архива, затем тело), а `alt:`-записи копятся всю
     * жизнь переписки и ничем не чистятся. Без потолка цена ОДНОГО нечитаемого
     * сообщения росла вместе с историей ключей аккаунта — на телефоне, то есть на
     * самом слабом железе из всех оболочек, это и выглядело как «со временем
     * начинает тормозить».
     */
    const val MAX_DECRYPT_CANDIDATES: Int = 12

    fun dmConversationScope(a: String, b: String): String? {
        val first = a.trim()
        val second = b.trim()
        if (first.isEmpty() || second.isEmpty()) return null
        val sorted = listOf(first, second).sorted()
        return "dm:${sorted[0]}:${sorted[1]}"
    }

    fun serverConversationScope(serverId: String, channelId: String): String? {
        val sid = serverId.trim()
        val cid = channelId.trim()
        if (sid.isEmpty() || cid.isEmpty()) return null
        return "server:$sid:$cid"
    }

    private fun pushCandidateKey(keys: MutableList<String>, key: String?) {
        val trimmed = key?.trim() ?: return
        if (trimmed.isEmpty() || keys.contains(trimmed)) return
        keys.add(trimmed)
    }

    /**
     * The conversation scope a message belongs to, or null when it can't be derived.
     * Mirrors the branch order in [candidateMessageKeys] — a server-scoped message is
     * never treated as a DM. Ported from the macOS shell's ZaliCore.
     */
    fun conversationScope(
        participantA: String?,
        participantB: String?,
        serverId: String? = null,
        channelId: String? = null,
    ): String? {
        if (!serverId.isNullOrBlank()) {
            if (channelId == null) return null
            return serverConversationScope(serverId, channelId)
        }
        if (participantA == null || participantB == null) return null
        return dmConversationScope(participantA, participantB)
    }

    /**
     * Whether the conversation key for this message's own scope is already known.
     * Distinguishes "the key hasn't reached this device yet" (transient — it repairs
     * itself once key sync converges) from "we had the key and it didn't work".
     */
    fun hasConversationScopeKey(
        conversationKeys: Map<String, String>,
        participantA: String?,
        participantB: String?,
        serverId: String? = null,
        channelId: String? = null,
    ): Boolean {
        val scope = conversationScope(participantA, participantB, serverId, channelId)
            ?: return false
        return !conversationKeys[scope].isNullOrBlank()
    }

    /**
     * Ключи-кандидаты для расшифровки одного сообщения, в порядке убывания шансов:
     * ключ собственного scope, затем текущий активный, затем — как эвристика на
     * случай устаревшего или разъехавшегося отображения scope→ключ — весь
     * остальной набор.
     *
     * Хвост **ограничен** [MAX_DECRYPT_CANDIDATES] и обходится в отсортированном
     * порядке scope'ов, а не обходом `Map` (её порядок задаёт `JSONObject.keys()`,
     * то есть HashMap). Без сортировки состав ограниченного списка менялся бы от
     * вызова к вызову: одно и то же сообщение расшифровывалось бы или нет в
     * зависимости от того, какие двенадцать ключей мапа выдала в этот раз, а
     * отпечаток «этот набор уже пробовали» никогда не совпал бы дважды.
     *
     * Зеркало `native/cache.rs::candidate_message_keys` (Windows) и одноимённой
     * логики в `WebView.swift` (macOS).
     */
    fun candidateMessageKeys(
        currentKey: String,
        conversationKeys: Map<String, String> = emptyMap(),
        participantA: String?,
        participantB: String?,
        serverId: String? = null,
        channelId: String? = null,
    ): List<String> {
        val keys = mutableListOf<String>()
        if (!serverId.isNullOrBlank()) {
            if (channelId != null) {
                serverConversationScope(serverId, channelId)?.let { pushCandidateKey(keys, conversationKeys[it]) }
            }
        } else if (participantA != null && participantB != null) {
            dmConversationScope(participantA, participantB)?.let { pushCandidateKey(keys, conversationKeys[it]) }
        }
        pushCandidateKey(keys, currentKey)
        for (scope in conversationKeys.keys.sorted()) {
            if (keys.size >= MAX_DECRYPT_CANDIDATES) break
            pushCandidateKey(keys, conversationKeys[scope])
        }
        return if (keys.size > MAX_DECRYPT_CANDIDATES) keys.take(MAX_DECRYPT_CANDIDATES) else keys
    }

    /**
     * Тождество того самого списка кандидатов, которым уже пробовали открыть
     * сообщение. На нём держится отрицательный кэш: тот же список — тот же исход,
     * переделывать нечего. Появился новый ключ — отпечаток другой, запись протухла,
     * и повтор происходит сразу, так что самопочинка сохраняется.
     */
    fun candidateKeysFingerprint(keys: List<String>): String {
        val digest = java.security.MessageDigest.getInstance("SHA-256")
        digest.update(keys.size.toString().toByteArray(Charsets.UTF_8))
        for (key in keys) {
            digest.update(0)
            digest.update(key.toByteArray(Charsets.UTF_8))
        }
        return android.util.Base64.encodeToString(digest.digest(), android.util.Base64.NO_WRAP)
    }

    private fun dispatch(addressCommand: String, args: JSONObject): JSONObject? {
        if (!isAvailable) return null
        val raw = try { busDispatch(addressCommand, args.toString()) } catch (e: Throwable) { return null }
        return raw?.let { try { JSONObject(it) } catch (e: Exception) { null } }
    }

    fun packMessage(
        sender: String,
        text: String,
        output: String,
        key: String,
        keyVersion: Int = 2,
        attachments: List<JSONObject> = emptyList(),
        call: String? = null,
        reply: String? = null,
    ): Boolean {
        if (key.trim().isEmpty() || !isAvailable) return false
        val args = JSONObject().apply {
            put("sender", sender)
            put("text", text)
            put("key", key)
            put("output_path", output)
            put("key_version", maxOf(1, keyVersion))
            if (attachments.isNotEmpty()) put("attachments", JSONArray(attachments))
            // Пересылается как есть; ядро шифрует его тем же ключом разговора, что и
            // текст. Пропустить здесь = молча выбросить из сообщения: цитата ответа
            // и запись о звонке живут ВНУТРИ шифротекста, а не рядом с ним.
            call?.trim()?.takeIf { it.isNotEmpty() }?.let { put("call", it) }
            reply?.trim()?.takeIf { it.isNotEmpty() }?.let { put("reply", it) }
        }
        val result = dispatch("zali_net:pack_message", args) ?: return false
        return result.optBoolean("success", false)
    }

    fun unpackMessage(archivePath: String, tempDir: String, key: String): MessagePayload? {
        if (key.trim().isEmpty() || !isAvailable) return null
        val args = JSONObject().apply {
            put("archive_path", archivePath)
            put("temp_dir", tempDir)
            put("key", key)
        }
        val result = dispatch("zali_net:unpack_message", args) ?: return null
        if (!result.optBoolean("success", false)) return null
        val data = result.optJSONObject("data") ?: return null
        val attachmentsArray = data.optJSONArray("attachments") ?: JSONArray()
        val attachments = (0 until attachmentsArray.length()).map { i ->
            val a = attachmentsArray.getJSONObject(i)
            Attachment(
                name = a.optString("name"),
                archivePath = a.optString("archivePath", a.optString("archive_path")),
                mimeType = a.optString("mimeType", a.optString("mime_type")),
                kind = a.optString("kind"),
                size = a.optLong("size"),
            )
        }
        return MessagePayload(
            sender = data.optString("sender"),
            text = data.optString("text"),
            timestamp = data.optLong("timestamp"),
            keyVersion = if (data.has("keyVersion")) data.optInt("keyVersion") else null,
            attachments = attachments,
            call = data.optString("call", "").ifEmpty { null },
            reply = data.optString("reply", "").ifEmpty { null },
        )
    }

    fun unpackMessage(archivePath: String, tempDir: String, keys: List<String>): MessagePayload? {
        val tried = mutableSetOf<String>()
        for (key in keys) {
            val normalized = key.trim()
            if (normalized.isEmpty() || !tried.add(normalized)) continue
            unpackMessage(archivePath, tempDir, normalized)?.let { return it }
        }
        return null
    }
}
