package org.zalikus.messenger

import android.Manifest
import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.webkit.WebViewFeature
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.random.Random

/**
 * Native bridge for the shared web UI (`Web/src/interface.js`), registered as
 * `window.ZaliAndroidBridge` via `WebView.addJavascriptInterface`. Mirrors the iOS
 * shell's `WebViewStore` (see `iOS/ZaliMessenger/WebView.swift`) — same protocol,
 * same timeouts/backoff: HTTP `API_REQUEST` bridge, WS transport, device identity
 * persistence, and message send/receive via `.zali` pack/unpack (see
 * `ZaliCoreBridge.kt`, the Rust Core FFI wrapper).
 *
 * Why a bridge is needed at all: the shared UI loads via `file:///android_asset/...`,
 * and a `file://` page's `fetch()` sends `Origin: null`, which the server's CORS
 * allowlist (`allowed_origins` in `src/lib.rs`, no wildcard) always rejects. Routing
 * requests through OkHttp instead sidesteps the WebView's CORS enforcement entirely
 * — exactly the same fix as iOS's `URLSession`-based bridge.
 */
class NativeBridge(private val context: Context, private val webView: WebView) {

    private val mainHandler = Handler(Looper.getMainLooper())

    /** Matches the JS default in `Web/index.html`'s server-address field. */
    @Volatile
    private var apiBaseUrl = "https://msgs.zalikus.org"

    // `startPostAuthSetup()` in interface.js fires ~5 API calls the instant login
    // succeeds; capping per-host connections avoids asking a slow/narrow link to
    // open several at once (same reasoning as iOS's httpMaximumConnectionsPerHost).
    private val httpClient = OkHttpClient.Builder()
        .dispatcher(okhttp3.Dispatcher().apply { maxRequestsPerHost = 2 })
        .build()

    // MARK: - WebSocket transport (connection status, message decrypt, metadata push)
    //
    // OkHttp's WebSocket has a built-in ping interval (unlike iOS's URLSessionWebSocketTask,
    // which needs a hand-rolled heartbeat), so this is a little leaner than the iOS version.
    // A message-envelope frame (id/sender/receiver) triggers download + decrypt via
    // ZaliCoreBridge — see handleWsFrame / downloadAndDecryptMessage below.
    private val wsClient = OkHttpClient.Builder()
        .pingInterval(25, TimeUnit.SECONDS)
        .build()
    private var wsInstance: WebSocket? = null
    private var wsGeneration = 0
    private var wsReconnectAttempt = 0
    @Volatile
    private var wsAuthToken = ""
    @Volatile
    private var wsDeviceId = ""

    private val prefs = context.getSharedPreferences("zali_native_bridge", Context.MODE_PRIVATE)

    // Set via SET_KEY — JS pushes the active E2E key and the full per-conversation
    // key map here whenever either changes. Used by candidateMessageKeys when
    // decrypting an incoming message.
    @Volatile
    private var currentE2eKey = ""
    @Volatile
    private var conversationKeys: Map<String, String> = emptyMap()

    /** In-flight SEND_MESSAGE clientId guard — mirrors macOS/iOS's dedup guard. */
    private val inFlightSendClientIds = java.util.Collections.synchronizedSet(mutableSetOf<String>())

    init {
        val lastUser = prefs.getString(LAST_USERNAME_KEY, null)
        if (!lastUser.isNullOrEmpty()) {
            wsDeviceId = readSharedDeviceIdentity(lastUser)?.let { json ->
                try { JSONObject(json).optString("deviceId", "") } catch (e: Exception) { "" }
            }.orEmpty()
        }
    }

    /**
     * JS injected at document-start (before `bootstrap.js` runs), mirroring iOS's
     * `WKUserScript(.atDocumentStart)`. Sets `window.__ZALI_NATIVE_CAPS__` so
     * `bootstrap.js` wires this bridge into `window.__ZALI_NATIVE`, re-adopts a
     * previously persisted device identity, and defines the tab-switch/dock-hide
     * helpers the native bottom bar drives.
     *
     * `window.ZaliAndroidBridge` falls into `bootstrap.js`'s generic "transport but
     * not macBridge" branch, whose *defaults* already claim `sendMessage`,
     * `setKey`, `sessionSync`, `saveStyle`, and `saveMessageCache` — before any of
     * those were actually handled here, JS believed outgoing messages were
     * natively sent and silently dropped them instead of queueing them for retry
     * (`flushPendingOutbox()` in interface.js). Every capability is listed
     * explicitly below so that never happens silently again — update this list
     * when adding a new case to `postMessage`.
     */
    fun documentStartScript(): String {
        val lastUser = prefs.getString(LAST_USERNAME_KEY, null)
        val identityJson = if (!lastUser.isNullOrEmpty()) readSharedDeviceIdentity(lastUser) else null
        val identityLine = if (identityJson != null) "window.__ZALI_INJECTED_DEVICE_IDENTITY = $identityJson;" else ""
        return """
        (function () {
          $identityLine
          window.__ZALI_NATIVE_CAPS__ = {
            apiRequest: true,
            networkConfig: true,
            setKey: true,
            sendMessage: true,
            sessionSync: false,
            saveStyle: false,
            saveMessageCache: false,
            downloadAttachment: true,
            serverHistory: false,
            avatarFetch: true,
            tenor: true,
            voice: false,
            windowDrag: false
          };
          window.__zaliSelectTab = function (name) {
            var map = { chats: 'mobileChatsBtn', servers: 'mobileServersBtn',
                        hub: 'mobileHubBtn', settings: 'mobileSettingsBtn' };
            var el = document.getElementById(map[name]);
            if (el) { el.click(); }
          };
          var hide = function () {
            if (document.getElementById('__zaliNativeBarCss')) return;
            var st = document.createElement('style');
            st.id = '__zaliNativeBarCss';
            st.textContent = '.mobile-dock{display:none !important;}';
            (document.head || document.documentElement).appendChild(st);
          };
          if (document.readyState !== 'loading') hide();
          document.addEventListener('DOMContentLoaded', hide);
          document.body && document.body.classList.add('zali-native-android');
        })();
        """.trimIndent()
    }

    /** Switch the visible section by driving the shared web UI. */
    fun selectTab(name: String) {
        mainHandler.post {
            webView.evaluateJavascript("window.__zaliSelectTab && window.__zaliSelectTab('$name');", null)
        }
    }

    /** Entry point for every `postNativeMessage(...)` call from `Web/src/interface.js`. */
    @JavascriptInterface
    fun postMessage(json: String) {
        val dict = try { JSONObject(json) } catch (e: Exception) { return }
        when (dict.optString("type", "")) {
            "NETWORK_CONFIG" -> {
                val base = dict.optString("apiBaseUrl", "")
                if (base.isNotEmpty() && base != apiBaseUrl) {
                    apiBaseUrl = base
                    if (wsAuthToken.isNotEmpty()) connectWebSocket()
                }
            }
            "API_REQUEST" -> handleApiRequest(dict)
            "PERSIST_DEVICE_IDENTITY" -> handlePersistDeviceIdentity(dict)
            "SET_KEY" -> {
                if (dict.has("key")) currentE2eKey = dict.optString("key", currentE2eKey)
                dict.optJSONObject("conversationKeys")?.let { convKeys ->
                    val next = mutableMapOf<String, String>()
                    val keys = convKeys.keys()
                    while (keys.hasNext()) {
                        val k = keys.next()
                        next[k] = convKeys.optString(k)
                    }
                    conversationKeys = next
                }
            }
            "SEND_MESSAGE" -> handleSendMessage(dict)
            "UPLOAD_AVATAR_REQUEST" -> handleAvatarUploadRequest(dict, delete = false)
            "DELETE_AVATAR_REQUEST" -> handleAvatarUploadRequest(dict, delete = true)
            "LOAD_AVATAR_REQUEST" -> handleLoadAvatarRequest(dict)
            "RESOLVE_TENOR" -> resolveTenor(dict.optString("url", ""), dict.optString("requestId", UUID.randomUUID().toString()))
            "DOWNLOAD_ATTACHMENT" -> saveAttachment(dict.optString("dataUrl", ""), dict.optString("filename", "attachment"))
            "SHOW_NOTIFICATION" -> showMessageNotification(
                sender = dict.optString("sender", "").trim(),
                text = dict.optString("text", ""),
                attachmentCount = dict.optInt("attachmentCount", 0),
                serverId = dict.optString("serverId", "").ifEmpty { null },
                channelId = dict.optString("channelId", "").ifEmpty { null },
            )
        }
    }

    // MARK: - Device identity persistence (key envelope sync)
    //
    // Mirrors iOS's WebViewStore / macOS's exportDeviceIdentityToSharedFile: without
    // this, a WebView data wipe mints a fresh device_id, orphaning every key envelope
    // addressed to the old one. Plain file under app-private storage — Android has no
    // Keychain-style consent friction, so there's no "no Keychain" workaround needed
    // here the way there is on macOS/iOS; filesDir is already private and simple.
    private fun readSharedDeviceIdentity(username: String): String? {
        val user = username.trim().lowercase()
        if (user.isEmpty()) return null
        val file = File(context.filesDir, "shared_device_identity_$user.json")
        if (!file.exists()) return null
        return try {
            val raw = file.readText().trim()
            if (raw.isEmpty()) return null
            JSONObject(raw) // validate it parses before handing back to JS
            raw
        } catch (e: Exception) {
            null
        }
    }

    private fun handlePersistDeviceIdentity(dict: JSONObject) {
        val username = dict.optString("username", "").trim().lowercase()
        val identityJson = dict.optString("identity", "")
        if (username.isEmpty() || identityJson.isEmpty()) return
        prefs.edit().putString(LAST_USERNAME_KEY, username).apply()
        try {
            val file = File(context.filesDir, "shared_device_identity_$username.json")
            file.writeText(identityJson)
        } catch (e: Exception) {
            return
        }
        try {
            wsDeviceId = JSONObject(identityJson).optString("deviceId", wsDeviceId)
        } catch (e: Exception) {
            // keep previous wsDeviceId
        }
    }

    // MARK: - HTTP API bridge

    private fun handleApiRequest(dict: JSONObject) {
        val requestId = dict.optString("requestId", UUID.randomUUID().toString())
        val method = dict.optString("method", "GET").uppercase()
        val path = dict.optString("path", "")
        val rawHeaders = dict.optJSONObject("headers") ?: JSONObject()
        val bodyStr = if (dict.has("body") && !dict.isNull("body")) dict.optString("body", "") else null
        val timeoutMs = dict.optDouble("timeoutMs", 12000.0)

        val authKey = rawHeaders.keys().asSequence().firstOrNull { it.equals("Authorization", ignoreCase = true) }
        if (authKey != null) {
            val token = rawHeaders.optString(authKey, "").removePrefix("Bearer ").trim()
            if (token.isNotEmpty() && token != wsAuthToken) {
                wsAuthToken = token
                connectWebSocket()
            }
        }

        val forbidden = listOf("..", "%2F", "%2f", "%5C", "%5c")
        if (!path.startsWith("/api/") || forbidden.any { path.contains(it) }) {
            sendNativeResponse(requestId, ok = false, error = "Некорректный путь запроса")
            return
        }
        val url = apiBaseUrl + path

        // Two attempts, second on a brand-new client (own connection pool) — a
        // half-open pooled connection otherwise gets reused on retry and stalls
        // again (mirrors iOS's ephemeral-session retry). First attempt is short:
        // a dead pooled socket shouldn't cost the whole budget before falling
        // back to a fresh connection.
        val totalBudget = max(timeoutMs / 1000.0, 3.0)
        val firstAttemptTimeout = min(2.0, totalBudget * 0.4)
        val finalAttemptTimeout = max(totalBudget - firstAttemptTimeout, 3.0)
        attemptApiRequest(url, method, rawHeaders, bodyStr, requestId, attempt = 1, maxAttempts = 2,
            perAttemptTimeout = firstAttemptTimeout, finalAttemptTimeout = finalAttemptTimeout)
    }

    private fun attemptApiRequest(
        url: String, method: String, rawHeaders: JSONObject, bodyStr: String?,
        requestId: String, attempt: Int, maxAttempts: Int,
        perAttemptTimeout: Double, finalAttemptTimeout: Double,
    ) {
        val timeoutSeconds = perAttemptTimeout.toLong().coerceAtLeast(1)
        val client = if (attempt == 1) {
            httpClient.newBuilder()
                .connectTimeout(timeoutSeconds, TimeUnit.SECONDS)
                .readTimeout(timeoutSeconds, TimeUnit.SECONDS)
                .callTimeout(timeoutSeconds, TimeUnit.SECONDS)
                .build()
        } else {
            OkHttpClient.Builder()
                .connectTimeout(timeoutSeconds, TimeUnit.SECONDS)
                .readTimeout(timeoutSeconds, TimeUnit.SECONDS)
                .callTimeout(timeoutSeconds, TimeUnit.SECONDS)
                .build()
        }

        val builder = Request.Builder().url(url)
        val keys = rawHeaders.keys()
        while (keys.hasNext()) {
            val k = keys.next()
            builder.header(k, rawHeaders.optString(k))
        }
        val mediaType = "application/octet-stream".toMediaTypeOrNull()
        val needsBody = method == "POST" || method == "PUT" || method == "PATCH"
        val reqBody = when {
            bodyStr != null -> bodyStr.toRequestBody(mediaType)
            needsBody -> "".toRequestBody(mediaType)
            else -> null
        }
        builder.method(method, reqBody)

        client.newCall(builder.build()).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                if (attempt < maxAttempts) {
                    val nextAttempt = attempt + 1
                    val nextTimeout = if (nextAttempt == maxAttempts) finalAttemptTimeout else perAttemptTimeout
                    attemptApiRequest(url, method, rawHeaders, bodyStr, requestId, nextAttempt, maxAttempts,
                        nextTimeout, finalAttemptTimeout)
                    return
                }
                sendNativeResponse(requestId, ok = false, error = e.message ?: "Не удалось связаться с сервером")
            }

            override fun onResponse(call: Call, response: Response) {
                response.use {
                    val bodyString = try { it.body?.string() ?: "" } catch (e: IOException) { "" }
                    val headers = JSONObject()
                    for (name in it.headers.names()) {
                        headers.put(name, it.header(name))
                    }
                    val data = JSONObject().apply {
                        put("status", it.code)
                        put("ok", it.code in 200..299)
                        put("body", bodyString)
                        put("headers", headers)
                    }
                    sendNativeResponse(requestId, ok = true, data = data)
                }
            }
        })
    }

    /** Delivers a native bridge response into the JS bus (`onNativeResponse` in interface.js). */
    private fun sendNativeResponse(requestId: String, ok: Boolean, data: JSONObject? = null, error: String? = null) {
        val payload = JSONObject().apply {
            put("requestId", requestId)
            put("ok", ok)
            if (data != null) put("data", data)
            if (error != null) put("error", error)
        }
        val js = "window.loader && window.loader.bus.send('zali_interface:native_response', $payload);"
        mainHandler.post { webView.evaluateJavascript(js, null) }
    }

    // MARK: - Message sending (ZaliCoreBridge pack + multipart upload)
    //
    // Ported from macOS's `.sendMessage` IPC case + `NetworkService.uploadMessage`.
    // Packing (`ZaliCoreBridge.packMessage`) does the actual AES-256-GCM encryption
    // via Rust Core; this just builds the multipart body and uploads it.

    private fun handleSendMessage(dict: JSONObject) {
        val clientId = dict.optString("clientId", UUID.randomUUID().toString())
        if (!inFlightSendClientIds.add(clientId)) return

        val text = dict.optString("text", "")
        val recipient = dict.optString("recipient", "")
        val sender = dict.optString("sender", "")
        val key = dict.optString("key", "").trim()
        val keyVersion = if (dict.has("keyVersion")) dict.optInt("keyVersion", 2) else 2
        val serverId = dict.optString("serverId", "").ifEmpty { null }
        val channelId = dict.optString("channelId", "").ifEmpty { null }

        if (key.isEmpty()) {
            inFlightSendClientIds.remove(clientId)
            sendBusEvent("on_send_error", JSONObject().apply {
                put("clientId", clientId); put("statusCode", 0); put("responseBody", "Core: E2E-ключ не задан")
            })
            return
        }
        if (!ZaliCoreBridge.isAvailable) {
            inFlightSendClientIds.remove(clientId)
            sendBusEvent("on_send_error", JSONObject().apply {
                put("clientId", clientId); put("statusCode", 0); put("responseBody", "Core: нативная библиотека не загружена")
            })
            return
        }

        val tempPath = File(context.cacheDir, "${UUID.randomUUID()}.zali").path
        val attachmentsIn = dict.optJSONArray("attachments") ?: JSONArray()
        val packedAttachments = mutableListOf<JSONObject>()
        val tempAttachmentFiles = mutableListOf<File>()

        for (i in 0 until attachmentsIn.length()) {
            val attachment = attachmentsIn.getJSONObject(i)
            val dataUrl = attachment.optString("dataUrl", "")
            if (dataUrl.isEmpty()) continue
            val name = attachment.optString("name", "attachment.bin")
            val kind = attachment.optString("kind", "file")
            val (bytes, mimeType, fileExtension) = decodeDataUrl(dataUrl)
            if (bytes.isEmpty()) continue

            val safeName = safeFileName(name, fileExtension)
            val tempFile = File(context.cacheDir, "${UUID.randomUUID()}_$safeName")
            tempFile.writeBytes(bytes)
            tempAttachmentFiles.add(tempFile)

            packedAttachments.add(JSONObject().apply {
                put("path", tempFile.path)
                put("archivePath", "attachments/$safeName")
                put("name", name)
                put("mimeType", if (attachment.has("mimeType")) attachment.optString("mimeType") else mimeType)
                put("kind", kind)
                put("size", if (attachment.has("size")) attachment.optLong("size") else bytes.size.toLong())
            })
        }

        val packed = ZaliCoreBridge.packMessage(sender, text, tempPath, key, keyVersion, packedAttachments)
        tempAttachmentFiles.forEach { it.delete() }
        if (!packed) {
            inFlightSendClientIds.remove(clientId)
            sendBusEvent("on_send_error", JSONObject().apply {
                put("clientId", clientId); put("statusCode", 0)
                put("responseBody", "Core: Ошибка при упаковке сообщения в Rust бэкенде")
            })
            return
        }

        val archiveFile = File(tempPath)
        uploadMessage(sender, recipient, clientId, archiveFile, serverId, channelId, keyVersion) { success, messageId, statusCode, responseBody ->
            inFlightSendClientIds.remove(clientId)
            if (success) {
                sendBusEvent("on_send_success", JSONObject().apply {
                    put("clientId", clientId); put("messageId", messageId ?: "")
                })
            } else {
                sendBusEvent("on_send_error", JSONObject().apply {
                    put("clientId", clientId); put("statusCode", statusCode ?: 0)
                    put("responseBody", (responseBody ?: "").trim())
                })
            }
            archiveFile.delete()
        }
    }

    private fun decodeDataUrl(value: String): Triple<ByteArray, String, String> {
        val maxDataUrlBytes = 100 * 1024 * 1024 // 100 MB
        if (value.length > maxDataUrlBytes || !value.startsWith("data:")) return Triple(ByteArray(0), "application/octet-stream", "bin")
        val comma = value.indexOf(',')
        if (comma < 0) return Triple(ByteArray(0), "application/octet-stream", "bin")
        val meta = value.substring(5, comma)
        val payload = value.substring(comma + 1)
        val mimeType = meta.split(";").firstOrNull() ?: "application/octet-stream"
        val fileExtension = when (mimeType) {
            "image/png" -> "png"
            "image/jpeg", "image/jpg" -> "jpg"
            "image/gif" -> "gif"
            "image/webp" -> "webp"
            "video/mp4" -> "mp4"
            "video/webm" -> "webm"
            else -> "bin"
        }
        val bytes = try { android.util.Base64.decode(payload, android.util.Base64.DEFAULT) } catch (e: Exception) { ByteArray(0) }
        return Triple(bytes, mimeType, fileExtension)
    }

    private fun safeFileName(name: String, fallbackExtension: String): String {
        val cleaned = name.replace(Regex("[/\\\\:?%*|\"<>]"), "_")
        return cleaned.ifEmpty { "attachment.$fallbackExtension" }
    }

    /** Multipart upload to `/api/upload`, mirroring macOS `NetworkService.uploadMessage`. */
    private fun uploadMessage(
        sender: String, receiver: String, clientId: String, archiveFile: File,
        serverId: String?, channelId: String?, keyVersion: Int,
        completion: (success: Boolean, messageId: String?, statusCode: Int?, responseBody: String?) -> Unit,
    ) {
        val bodyBuilder = okhttp3.MultipartBody.Builder().setType(okhttp3.MultipartBody.FORM)
            .addFormDataPart("sender", sender)
            .addFormDataPart("client_id", clientId)
            .addFormDataPart("key_version", max(1, keyVersion).toString())
            .addFormDataPart("receiver", receiver)
        if (!serverId.isNullOrEmpty() && !channelId.isNullOrEmpty()) {
            bodyBuilder.addFormDataPart("server_id", serverId)
            bodyBuilder.addFormDataPart("channel_id", channelId)
        }
        bodyBuilder.addFormDataPart(
            "file", "msg.zali",
            archiveFile.asRequestBody("application/octet-stream".toMediaTypeOrNull())
        )

        val requestBuilder = Request.Builder().url("$apiBaseUrl/api/upload").post(bodyBuilder.build())
        if (wsAuthToken.isNotEmpty()) requestBuilder.header("Authorization", "Bearer $wsAuthToken")
        if (wsDeviceId.isNotEmpty()) requestBuilder.header("X-Zali-Device-ID", wsDeviceId)

        httpClient.newCall(requestBuilder.build()).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                mainHandler.post { completion(false, null, null, e.message) }
            }
            override fun onResponse(call: Call, response: Response) {
                response.use {
                    val bodyString = try { it.body?.string() ?: "" } catch (e: IOException) { "" }
                    mainHandler.post {
                        if (it.code == 201) {
                            val messageId = try { JSONObject(bodyString).optString("id") } catch (e: Exception) { null }
                            completion(true, messageId, it.code, bodyString)
                        } else {
                            completion(false, null, it.code, bodyString)
                        }
                    }
                }
            }
        })
    }

    // MARK: - Attachment download (DOWNLOAD_ATTACHMENT)
    //
    // Ported from macOS's `.downloadAttachment` IPC case + `saveAttachment`
    // (`NSSavePanel`), mirroring the iOS shell's `saveAttachment`
    // (`UIActivityViewController`). Android has no save panel either — writes to
    // the app's cache dir and launches the system share sheet via a FileProvider
    // `content://` Uri (a raw `file://` Uri throws `FileUriExposedException` on
    // targetSdk 24+); "Save to Downloads"/"Save to Drive" etc. are share-sheet
    // targets the OS already provides.

    private fun saveAttachment(dataUrl: String, filename: String) {
        val (bytes, _, fileExtension) = decodeDataUrl(dataUrl)
        if (bytes.isEmpty()) return
        val safeName = safeFileName(filename, fileExtension)

        val attachmentsDir = File(context.cacheDir, "attachments").apply { mkdirs() }
        val file = File(attachmentsDir, "${UUID.randomUUID()}_$safeName")
        try {
            file.writeBytes(bytes)
        } catch (e: Exception) {
            return
        }

        val uri = try {
            androidx.core.content.FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
        } catch (e: Exception) {
            return
        }

        val shareIntent = android.content.Intent(android.content.Intent.ACTION_SEND).apply {
            type = context.contentResolver.getType(uri) ?: "application/octet-stream"
            putExtra(android.content.Intent.EXTRA_STREAM, uri)
            addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        val chooser = android.content.Intent.createChooser(shareIntent, null).apply {
            addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        mainHandler.post {
            try {
                context.startActivity(chooser)
            } catch (e: Exception) {
                // No activity available to handle the share sheet — drop silently.
            }
        }
    }

    // MARK: - Avatar (UPLOAD/DELETE/LOAD_AVATAR_REQUEST)
    //
    // Ported from macOS's `.uploadAvatarRequest`/`.deleteAvatarRequest`/`.loadAvatarRequest`
    // IPC cases + `NetworkService.performAvatarRequest`/`performAvatarFetch`, mirroring
    // the iOS shell's `handleAvatarUploadRequest`/`handleLoadAvatarRequest`.

    private fun handleAvatarUploadRequest(dict: JSONObject, delete: Boolean) {
        val requestId = dict.optString("requestId", UUID.randomUUID().toString())
        val requestBuilder = Request.Builder().url("$apiBaseUrl/api/avatar")
        if (wsAuthToken.isNotEmpty()) requestBuilder.header("Authorization", "Bearer $wsAuthToken")
        if (wsDeviceId.isNotEmpty()) requestBuilder.header("X-Zali-Device-ID", wsDeviceId)

        if (delete) {
            requestBuilder.delete()
            httpClient.newCall(requestBuilder.build()).enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    sendNativeResponse(requestId, ok = false, error = e.message ?: "Не удалось выполнить операцию")
                }
                override fun onResponse(call: Call, response: Response) {
                    response.use {
                        if (!it.isSuccessful) {
                            val bodyPreview = try { it.body?.string() ?: "" } catch (e: IOException) { "" }
                            sendNativeResponse(requestId, ok = false, error = bodyPreview.ifEmpty { "Не удалось выполнить операцию" })
                            return
                        }
                        sendNativeResponse(requestId, ok = true, data = JSONObject().put("username", currentUsername()))
                    }
                }
            })
            return
        }

        val dataUrl = dict.optString("dataUrl", "")
        val mimeType = dict.optString("mimeType", "image/png")
        val filename = dict.optString("filename", "avatar.png")
        val base64 = dataUrl.substringAfterLast(",", "")
        val imageBytes = try { android.util.Base64.decode(base64, android.util.Base64.DEFAULT) } catch (e: Exception) { null }
        if (imageBytes == null || imageBytes.isEmpty()) {
            sendNativeResponse(requestId, ok = false, error = "Invalid avatar data URL")
            return
        }

        val body = MultipartBody.Builder().setType(MultipartBody.FORM)
            .addFormDataPart("file", filename, imageBytes.toRequestBody(mimeType.toMediaTypeOrNull()))
            .build()
        requestBuilder.post(body)

        httpClient.newCall(requestBuilder.build()).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                sendNativeResponse(requestId, ok = false, error = e.message ?: "Не удалось выполнить операцию")
            }
            override fun onResponse(call: Call, response: Response) {
                response.use {
                    if (!it.isSuccessful) {
                        val bodyPreview = try { it.body?.string() ?: "" } catch (e: IOException) { "" }
                        sendNativeResponse(requestId, ok = false, error = bodyPreview.ifEmpty { "Не удалось выполнить операцию" })
                        return
                    }
                    sendNativeResponse(requestId, ok = true, data = JSONObject().put("username", currentUsername()))
                }
            }
        })
    }

    private fun handleLoadAvatarRequest(dict: JSONObject) {
        val requestId = dict.optString("requestId", UUID.randomUUID().toString())
        val username = dict.optString("username", "").trim()
        if (username.isEmpty()) {
            sendNativeResponse(requestId, ok = false, error = "Не удалось загрузить аватар")
            return
        }
        val encoded = java.net.URLEncoder.encode(username, "UTF-8")
        val maxAvatarBytes = 2 * 1024 * 1024
        val requestBuilder = Request.Builder().url("$apiBaseUrl/api/avatar/$encoded")
        if (wsAuthToken.isNotEmpty()) requestBuilder.header("Authorization", "Bearer $wsAuthToken")

        httpClient.newCall(requestBuilder.build()).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                // No avatar set is a normal, non-error outcome (mirrors macOS's 404-as-empty).
                sendNativeResponse(requestId, ok = true, data = JSONObject().put("dataUrl", ""))
            }
            override fun onResponse(call: Call, response: Response) {
                response.use {
                    if (!it.isSuccessful) {
                        sendNativeResponse(requestId, ok = true, data = JSONObject().put("dataUrl", ""))
                        return
                    }
                    val bytes = try { it.body?.bytes() } catch (e: IOException) { null }
                    if (bytes == null || bytes.size > maxAvatarBytes) {
                        sendNativeResponse(requestId, ok = false, error = "Аватар слишком большой")
                        return
                    }
                    val mimeType = it.header("Content-Type")?.trim().takeUnless { m -> m.isNullOrEmpty() } ?: "image/png"
                    val dataUrl = "data:$mimeType;base64," + android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
                    sendNativeResponse(requestId, ok = true, data = JSONObject().put("dataUrl", dataUrl))
                }
            }
        })
    }

    /** The bridge doesn't track a `SET_SESSION`-supplied username (unlike macOS), so
     * the avatar response falls back to the last-persisted device-identity username. */
    private fun currentUsername(): String = prefs.getString(LAST_USERNAME_KEY, "") ?: ""

    // MARK: - Tenor GIF preview resolution (RESOLVE_TENOR)
    //
    // Ported from macOS's `.resolveTenor` IPC case + `resolveTenor`/`extractTenorMediaURL`,
    // mirroring the iOS shell's `resolveTenor`/`extractTenorMediaURL`. Fire-and-forget:
    // result comes back via the `tenor_resolved` bus event, not `native_response`.

    private val tenorHttpClient = OkHttpClient.Builder().build()

    private fun resolveTenor(url: String, requestId: String) {
        val pageUrl = try { java.net.URL(url) } catch (e: Exception) { null }
        val host = pageUrl?.host
        if (pageUrl == null || pageUrl.protocol != "https" || host == null ||
            !(host == "tenor.com" || host.endsWith(".tenor.com"))) {
            emitTenorResolution(requestId, url, null, null, null)
            return
        }

        val request = Request.Builder().url(url)
            .header("Accept", "text/html,application/xhtml+xml")
            .header("User-Agent", "Mozilla/5.0")
            .build()

        tenorHttpClient.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                emitTenorResolution(requestId, url, null, null, null)
            }
            override fun onResponse(call: Call, response: Response) {
                response.use {
                    val html = try { it.body?.string() ?: "" } catch (e: IOException) { "" }
                    if (html.isEmpty()) {
                        emitTenorResolution(requestId, url, null, null, null)
                        return
                    }
                    val resolved = extractTenorMediaUrl(html)
                    emitTenorResolution(requestId, url, resolved?.first, resolved?.second, resolved?.third)
                }
            }
        })
    }

    private fun extractTenorMediaUrl(html: String): Triple<String, String, String>? {
        val patterns = listOf(
            Regex("""property=["']og:video["'][^>]*content=["']([^"']+)["']""", RegexOption.IGNORE_CASE),
            Regex("""property=["']og:image["'][^>]*content=["']([^"']+)["']""", RegexOption.IGNORE_CASE),
            Regex("""name=["']twitter:image["'][^>]*content=["']([^"']+)["']""", RegexOption.IGNORE_CASE),
            Regex("""name=["']twitter:player:stream["'][^>]*content=["']([^"']+)["']""", RegexOption.IGNORE_CASE),
        )
        for (pattern in patterns) {
            val raw = pattern.find(html)?.groupValues?.get(1)?.trim()
            if (!raw.isNullOrEmpty()) {
                val mimeType = inferTenorMimeType(raw)
                val kind = if (mimeType.startsWith("video/")) "video" else "image"
                return Triple(raw, mimeType, kind)
            }
        }
        return null
    }

    private fun inferTenorMimeType(url: String): String {
        val lower = url.lowercase()
        return when {
            lower.contains(".mp4") -> "video/mp4"
            lower.contains(".webm") -> "video/webm"
            lower.contains(".gif") -> "image/gif"
            lower.contains(".webp") -> "image/webp"
            else -> "image/png"
        }
    }

    // MARK: - Local notifications (SHOW_NOTIFICATION)
    //
    // Ported from macOS's `.showNotification` IPC case + `NativeNotificationService`,
    // mirroring the iOS shell's `showMessageNotification`/`deliverMessageNotification`.
    // Local notifications only, no FCM. `Web/src/interface.js`'s
    // `notifyBackgroundMessage()` fires this unconditionally (no capability gate), so
    // this always attempts delivery and just no-ops if permission isn't granted.

    private var notificationChannelReady = false

    private fun ensureNotificationChannel() {
        if (notificationChannelReady) return
        notificationChannelReady = true
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val channel = NotificationChannel(
            "zali-message", "Сообщения", NotificationManager.IMPORTANCE_HIGH
        ).apply { description = "Новые сообщения Zali Messenger" }
        manager.createNotificationChannel(channel)
    }

    private fun hasNotificationPermission(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true
        return ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
    }

    private fun requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || hasNotificationPermission()) return
        val activity = context as? Activity ?: return
        ActivityCompat.requestPermissions(activity, arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQUEST_CODE_NOTIFICATIONS)
    }

    private fun showMessageNotification(sender: String, text: String, attachmentCount: Int, serverId: String?, channelId: String?) {
        if (!hasNotificationPermission()) {
            requestNotificationPermissionIfNeeded()
            return
        }
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return
        ensureNotificationChannel()

        val titleSender = sender.ifEmpty { "Zali Messenger" }
        val trimmedText = text.trim()
        val body = when {
            trimmedText.isNotEmpty() -> trimmedText.take(180)
            attachmentCount == 1 -> "Вложение"
            attachmentCount > 1 -> "Вложения: $attachmentCount"
            else -> "Новое сообщение"
        }
        val title = if (serverId == null && channelId == null) titleSender else "$titleSender в канале"

        val notification = NotificationCompat.Builder(context, "zali-message")
            .setSmallIcon(android.R.drawable.ic_dialog_email)
            .setContentTitle(title)
            .setContentText(body)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setGroup(serverId ?: "dm")
            .build()

        try {
            NotificationManagerCompat.from(context).notify(java.util.UUID.randomUUID().hashCode(), notification)
        } catch (e: SecurityException) {
            // Permission revoked between the check above and here — drop silently.
        }
    }

    private fun emitTenorResolution(requestId: String, sourceUrl: String, mediaUrl: String?, mimeType: String?, kind: String?) {
        val payload = JSONObject().apply {
            put("requestId", requestId)
            put("sourceUrl", sourceUrl)
            if (mediaUrl != null) put("mediaUrl", mediaUrl)
            if (mimeType != null) put("mimeType", mimeType)
            if (kind != null) put("kind", kind)
        }
        val js = "window.loader && window.loader.bus.send('zali_interface:tenor_resolved', $payload);"
        mainHandler.post { webView.evaluateJavascript(js, null) }
    }

    /** Delivers a bus event (send success/error) into the JS bus — same envelope
     * macOS/iOS use (`zali_interface:on_send_success/on_send_error`). */
    private fun sendBusEvent(event: String, payload: JSONObject) {
        val js = "window.loader && window.loader.bus.send('zali_interface:$event', $payload);"
        mainHandler.post { webView.evaluateJavascript(js, null) }
    }

    // MARK: - WebSocket connect / reconnect

    private fun wsUrl(): String? {
        val base = when {
            apiBaseUrl.startsWith("https://") -> "wss://" + apiBaseUrl.removePrefix("https://")
            apiBaseUrl.startsWith("http://") -> "ws://" + apiBaseUrl.removePrefix("http://")
            else -> return "wss://msgs.zalikus.org/ws"
        }
        return "$base/ws"
    }

    private fun connectWebSocket() {
        if (wsAuthToken.isEmpty()) return
        val url = wsUrl() ?: return
        wsGeneration += 1
        val generation = wsGeneration
        wsInstance?.cancel()

        val reqBuilder = Request.Builder().url(url).header("Authorization", "Bearer $wsAuthToken")
        if (wsDeviceId.isNotEmpty()) reqBuilder.header("X-Zali-Device-ID", wsDeviceId)

        wsInstance = wsClient.newWebSocket(reqBuilder.build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                mainHandler.post {
                    if (generation != wsGeneration) return@post
                    wsReconnectAttempt = 0
                    setConnectionStatusJs(true)
                }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                mainHandler.post {
                    if (generation != wsGeneration) return@post
                    handleWsFrame(text)
                }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                mainHandler.post { scheduleWsReconnect(generation) }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                mainHandler.post { scheduleWsReconnect(generation) }
            }
        })
    }

    private fun scheduleWsReconnect(generation: Int) {
        if (generation != wsGeneration) return
        setConnectionStatusJs(false)
        wsReconnectAttempt = min(wsReconnectAttempt + 1, 6)
        val baseDelay = min(2.0.pow((wsReconnectAttempt - 1).toDouble()) * 1.5, 30.0)
        val delay = baseDelay + Random.nextDouble(0.0, 0.75)
        mainHandler.postDelayed({
            if (generation == wsGeneration) connectWebSocket()
        }, (delay * 1000).toLong())
    }

    /**
     * Dispatches a decoded WS frame. A message-envelope frame (id/sender/receiver,
     * no `type` — matches macOS's `WsMessage`) triggers a download + decrypt via
     * [ZaliCoreBridge]; everything else here carries plaintext metadata already.
     */
    private fun handleWsFrame(text: String) {
        val raw = try { JSONObject(text) } catch (e: Exception) { return }
        val type = raw.optString("type", "")
        when (type) {
            "avatar_updated", "avatar_deleted" -> {
                val username = raw.optString("username", "")
                if (username.isEmpty()) return
                val fn = if (type == "avatar_updated") "avatarUpdated" else "avatarDeleted"
                val arg = JSONObject.quote(username)
                webView.evaluateJavascript("window.$fn && window.$fn($arg);", null)
            }
            "reaction_updated" -> {
                webView.evaluateJavascript("window.receiveReactionUpdate && window.receiveReactionUpdate($raw);", null)
            }
            "key_envelope_available" -> {
                webView.evaluateJavascript("window.refreshAfterKey && window.refreshAfterKey();", null)
            }
            "" -> {
                val id = raw.optString("id", "")
                val sender = if (raw.has("sender")) raw.optString("sender") else null
                val receiver = if (raw.has("receiver")) raw.optString("receiver") else null
                if (id.isNotEmpty() && sender != null && receiver != null) {
                    val serverId = raw.optString("serverId", raw.optString("server_id", "")).ifEmpty { null }
                    val channelId = raw.optString("channelId", raw.optString("channel_id", "")).ifEmpty { null }
                    downloadAndDecryptMessage(id, sender, receiver, serverId, channelId)
                }
            }
        }
    }

    // MARK: - Message download + decrypt (ZaliCoreBridge)

    /** Downloads the `.zali` archive for a WS-pushed message envelope. Server-side
     * authorization (the download endpoint only serves archives the caller is
     * entitled to) is the relevance filter — no client-side pre-check. */
    private fun downloadAndDecryptMessage(id: String, sender: String, receiver: String, serverId: String?, channelId: String?) {
        if (!ZaliCoreBridge.isAvailable) return
        val encodedId = java.net.URLEncoder.encode(id, "UTF-8")
        val request = Request.Builder().url("$apiBaseUrl/api/download/$encodedId").apply {
            if (wsAuthToken.isNotEmpty()) header("Authorization", "Bearer $wsAuthToken")
        }.build()
        httpClient.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {}
            override fun onResponse(call: Call, response: Response) {
                response.use {
                    if (!it.isSuccessful) return
                    val bytes = try { it.body?.bytes() } catch (e: IOException) { null } ?: return
                    mainHandler.post { decryptAndDeliver(bytes, id, sender, receiver, serverId, channelId) }
                }
            }
        })
    }

    /** Unpacks + decrypts a downloaded `.zali` archive via [ZaliCoreBridge] and calls
     * `window.receiveMessage(...)` with the plaintext. A message encrypted under a
     * key this device hasn't synced yet is silently dropped, matching macOS. */
    private fun decryptAndDeliver(archiveBytes: ByteArray, id: String, sender: String, receiver: String, serverId: String?, channelId: String?) {
        val workDirName = UUID.randomUUID().toString()
        val archiveFile = File(context.cacheDir, "$workDirName.zali")
        val tempDir = File(context.cacheDir, "$workDirName-unpack")
        try {
            archiveFile.writeBytes(archiveBytes)
            tempDir.mkdirs()

            val keys = ZaliCoreBridge.candidateMessageKeys(
                currentKey = currentE2eKey, conversationKeys = conversationKeys,
                participantA = sender, participantB = receiver, serverId = serverId, channelId = channelId
            )
            val payload = ZaliCoreBridge.unpackMessage(archiveFile.path, tempDir.path, keys) ?: return

            val attachments = JSONArray()
            for (attachment in payload.attachments) {
                val rendered = JSONObject().apply {
                    put("name", attachment.name)
                    put("mimeType", attachment.mimeType)
                    put("kind", attachment.kind)
                    put("size", attachment.size)
                }
                // Inline small attachments as a data: URL, same 2 MB threshold as macOS/iOS.
                if (attachment.size <= 2 * 1024 * 1024) {
                    val attachmentFile = File(tempDir, attachment.archivePath)
                    if (attachmentFile.exists()) {
                        val b64 = android.util.Base64.encodeToString(attachmentFile.readBytes(), android.util.Base64.NO_WRAP)
                        rendered.put("dataUrl", "data:${attachment.mimeType};base64,$b64")
                    }
                }
                attachments.put(rendered)
            }

            val messagePayload = JSONObject().apply {
                put("id", id)
                put("sender", payload.sender)
                put("receiver", receiver)
                put("text", payload.text)
                put("attachments", attachments)
                if (serverId != null) put("serverId", serverId)
                if (channelId != null) put("channelId", channelId)
            }
            webView.evaluateJavascript("window.receiveMessage && window.receiveMessage($messagePayload);", null)
        } finally {
            archiveFile.delete()
            tempDir.deleteRecursively()
        }
    }

    private fun setConnectionStatusJs(connected: Boolean) {
        webView.evaluateJavascript("window.setConnectionStatus && window.setConnectionStatus($connected);", null)
    }

    fun teardown() {
        wsInstance?.cancel()
    }

    companion object {
        private const val LAST_USERNAME_KEY = "last_username"
        private const val REQUEST_CODE_NOTIFICATIONS = 4201
        /** Feature-checked at the call site before using [androidx.webkit.WebViewCompat.addDocumentStartJavaScript]. */
        val documentStartScriptSupported: Boolean
            get() = WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
    }
}
