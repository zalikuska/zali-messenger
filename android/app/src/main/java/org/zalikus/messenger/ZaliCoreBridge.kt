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
 *       build --release --manifest-path Core/Cargo.toml --features android
 *
 * (`android/build_android_core.sh` wraps this.) Run it whenever `Core/src/*.rs`
 * changes, before building the APK.
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
    )

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
        return keys
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
    ): Boolean {
        if (key.trim().isEmpty() || !isAvailable) return false
        val args = JSONObject().apply {
            put("sender", sender)
            put("text", text)
            put("key", key)
            put("output_path", output)
            put("key_version", maxOf(1, keyVersion))
            if (attachments.isNotEmpty()) put("attachments", JSONArray(attachments))
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
