package org.zalikus.messenger

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.URLEncoder
import java.util.UUID
import java.util.concurrent.TimeUnit

/**
 * Фоновый приём FCM (server/src/fcm.rs).
 *
 * Пуш не содержит текста — переписка сквозная. Сервис скачивает архив сообщения,
 * расшифровывает его ключами, сохранёнными на устройстве, и показывает настоящий текст.
 * Не получилось (нет сети, нет ключа, архив велик) — «Новое сообщение» от того же
 * отправителя: уведомление важнее содержимого.
 *
 * На всё у data-сообщения с высоким приоритетом около десяти секунд, поэтому и
 * скачивание, и перебор ключей здесь урезаны сильнее, чем в истории.
 */
class PushMessagingService : FirebaseMessagingService() {

    private val client = OkHttpClient.Builder()
        .callTimeout(6, TimeUnit.SECONDS)
        .build()

    override fun onNewToken(token: String) {
        PushSession.register(applicationContext, token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        if (data["kind"] != "message") return
        // Приложение на экране: сообщение уже пришло по WebSocket.
        if (PushSession.appVisible) return
        val session = PushSession.load(applicationContext) ?: return
        // Пуш аккаунту, из которого на этом телефоне уже вышли, показывать нельзя.
        val recipient = data["recipient"].orEmpty()
        if (!recipient.equals(session.username, ignoreCase = true)) return
        if (!MessageNotifier.canNotify(applicationContext)) return

        val messageId = data["messageId"].orEmpty()
        if (MessageNotifier.isShowing(applicationContext, messageId)) return
        val sender = data["sender"].orEmpty()
        val serverId = data["serverId"].orEmpty().ifEmpty { null }
        val channelId = data["channelId"].orEmpty().ifEmpty { null }

        val payload = if (messageId.isNotEmpty()) {
            decrypt(session, messageId, sender, recipient, serverId, channelId)
        } else null
        // Запись о звонке — не сообщение; веб её и сам не показывает уведомлением.
        if (payload?.call != null) return
        // Пока расшифровывали, сообщение могло прийти по сокету и уже быть показано.
        if (MessageNotifier.isShowing(applicationContext, messageId)) return

        MessageNotifier.show(
            context = applicationContext,
            sender = payload?.sender?.ifEmpty { null } ?: sender,
            text = payload?.text.orEmpty(),
            attachmentCount = payload?.attachments?.size ?: 0,
            serverId = serverId,
            channelId = channelId,
            messageId = messageId,
        )
    }

    private fun decrypt(
        session: PushSession.Session,
        messageId: String,
        sender: String,
        recipient: String,
        serverId: String?,
        channelId: String?,
    ): ZaliCoreBridge.MessagePayload? {
        if (!ZaliCoreBridge.isAvailable) return null
        val conversationKeys = readConversationKeys(session.username).toMutableMap()
        // Ключ канала выводится из scope (deriveServerChannelKey в вебе) и попадает в файл,
        // только когда канал открывали на этом устройстве, — выводим его сами.
        if (serverId != null && channelId != null) {
            ZaliCoreBridge.serverConversationScope(serverId, channelId)?.let { scope ->
                if (conversationKeys[scope].isNullOrBlank()) conversationKeys[scope] = derivedChannelKey(scope)
            }
        }
        val keys = ZaliCoreBridge.candidateMessageKeys(
            currentKey = "",
            conversationKeys = conversationKeys,
            participantA = sender,
            participantB = recipient,
            serverId = serverId,
            channelId = channelId,
        ).take(MAX_PUSH_DECRYPT_CANDIDATES)
        if (keys.isEmpty()) return null

        val request = Request.Builder()
            .url("${session.apiBaseUrl}/api/download/${URLEncoder.encode(messageId, "UTF-8")}")
            .header("Authorization", "Bearer ${session.authToken}")
            .build()
        val bytes = try {
            client.newCall(request).execute().use { response ->
                val body = response.body
                if (!response.isSuccessful || body == null) return null
                if (body.contentLength() > MAX_PUSH_ARCHIVE_BYTES) return null
                body.bytes()
            }
        } catch (e: IOException) {
            return null
        }
        if (bytes.size > MAX_PUSH_ARCHIVE_BYTES) return null

        val workDirName = UUID.randomUUID().toString()
        val archiveFile = File(cacheDir, "push-$workDirName.zali")
        val tempDir = File(cacheDir, "push-$workDirName-unpack")
        return try {
            archiveFile.writeBytes(bytes)
            tempDir.mkdirs()
            ZaliCoreBridge.unpackMessage(archiveFile.path, tempDir.path, keys)
        } catch (e: Exception) {
            null
        } finally {
            archiveFile.delete()
            tempDir.deleteRecursively()
        }
    }

    /** base64url без паддинга от SHA-256("zali-channel-key-v1:" + scope) — как в вебе. */
    private fun derivedChannelKey(scope: String): String {
        val digest = java.security.MessageDigest.getInstance("SHA-256")
            .digest("zali-channel-key-v1:$scope".toByteArray(Charsets.UTF_8))
        return android.util.Base64.encodeToString(
            digest, android.util.Base64.URL_SAFE or android.util.Base64.NO_PADDING or android.util.Base64.NO_WRAP
        )
    }

    /** Те же ключи, что NativeBridge зеркалит из вебвью (`persistConversationKeys`). */
    private fun readConversationKeys(username: String): Map<String, String> {
        val file = File(filesDir, "conversation_keys_${username.trim().lowercase()}.json")
        if (!file.exists()) return emptyMap()
        return try {
            val obj = JSONObject(file.readText())
            obj.keys().asSequence()
                .associateWith { obj.optString(it) }
                .filterValues { it.isNotBlank() }
        } catch (e: Exception) {
            emptyMap()
        }
    }

    companion object {
        /** Ключ своего scope идёт первым; каждый неподошедший — два прохода PBKDF2. */
        private const val MAX_PUSH_DECRYPT_CANDIDATES = 3

        /** Большое вложение за отведённые секунды не скачать — лучше общее уведомление. */
        private const val MAX_PUSH_ARCHIVE_BYTES = 8L * 1024 * 1024
    }
}
