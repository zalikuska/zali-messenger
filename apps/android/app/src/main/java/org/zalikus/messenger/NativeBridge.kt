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
import androidx.core.content.ContextCompat
import androidx.core.app.NotificationManagerCompat
import androidx.webkit.WebViewFeature
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
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
    //
    // Small JSON API calls ONLY. Bulk transfers must never share this client: every
    // `.zali` archive download during a history load, every avatar, and every send
    // used to run through here too, so a history reload (which downloads and
    // decrypts each message one by one) held both slots for its entire duration and
    // everything else — including the user's own outgoing message — queued behind
    // it. That is the "huge send delay + requests timing out" symptom macOS
    // documents from the other direction in NetworkService.swift (it raised its API
    // pool to 16 after the same burst-timeout signature). Splitting the two pools
    // keeps iOS's deliberately narrow API cap while giving transfers their own.
    private val httpClient = OkHttpClient.Builder()
        .dispatcher(okhttp3.Dispatcher().apply { maxRequestsPerHost = 2 })
        .build()

    // Message uploads/downloads and avatars. Mirrors macOS's separate `httpSession`
    // (NetworkService.swift), including its far more generous timeouts — OkHttp
    // defaults to a 10s read timeout, which a multi-megabyte attachment upload on a
    // mobile link can easily exceed, silently failing the send.
    private val transferClient = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .callTimeout(300, TimeUnit.SECONDS)
        .build()

    // Pack/unpack are CPU-bound (PBKDF2-SHA256 at 210 000 iterations + AES-GCM over
    // the whole payload) and MUST NOT run on either the JS bridge thread or the
    // Android main thread — see handleSendMessage / decryptAndDeliver for why.
    private val cryptoExecutor = java.util.concurrent.Executors.newFixedThreadPool(2) { runnable ->
        Thread(runnable, "zali-crypto").apply { isDaemon = true }
    }

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

    // MARK: - Screen capture (START_SCREEN_CAPTURE / STOP_SCREEN_CAPTURE)
    //
    // ScreenCaptureService can't be handed a NativeBridge reference directly
    // (Android starts services via Intent, not direct construction), so it
    // reaches back through this static instance to push frames/errors — same
    // reasoning as why it can't just call back into MainActivity. Set/cleared
    // alongside this bridge's own lifecycle (init / teardown below).
    @Volatile
    private var activeScreenCaptureRequestId = ""

    /** Set by MainActivity right after constructing this bridge: launches the
     * system screen-capture consent dialog via ActivityResultContracts, which
     * only an Activity can own. */
    var requestScreenCapturePermission: ((requestId: String) -> Unit)? = null

    /**
     * Mobile list↔chat navigation progress reported by the web UI
     * (`setMobileNavProgress` in interface.js): 0 = dialog list, 1 = chat.
     *
     * The native bottom bar has to follow it, because `documentStartScript()`
     * hides the web `.mobile-dock` and draws that bar over the WebView instead —
     * so the web transform that slides the dock away on the chat screen is
     * invisible to it, and without this the bar just sat on top of the message
     * input. `animate` is false while a swipe is tracking the finger (follow it
     * frame by frame) and true for a committed transition (run our own slide).
     */
    var onMobileNavProgress: ((progress: Float, animate: Boolean) -> Unit)? = null

    /**
     * Активная секция по версии веба: `chats` / `servers` / `hub` / `settings`.
     *
     * Нативная панель рисуется поверх вебвью и прячет веб-док, поэтому её
     * подсветка — локальное состояние Compose, меняющееся только от тапа по ней
     * самой. А уйти в Хаб или Настройки можно и другим путём (сегмент-контрол
     * внутри настроек), после чего подсветка начинала врать. Веб сообщает секцию
     * тем же сообщением, что и прогресс навигации.
     */
    var onMobileNavSection: ((section: String) -> Unit)? = null

    init {
        val lastUser = prefs.getString(LAST_USERNAME_KEY, null)
        if (!lastUser.isNullOrEmpty()) {
            wsDeviceId = readSharedDeviceIdentity(lastUser)?.let { json ->
                try { JSONObject(json).optString("deviceId", "") } catch (e: Exception) { "" }
            }.orEmpty()
        }
        activeInstance = this
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
        // Re-adopt the conversation keys saved on the last run. The shared UI cannot
        // tell an empty key map apart from "this conversation has no key yet" — it
        // generates a fresh random key and encrypts real messages with it — so losing
        // them across a relaunch or a WebView data wipe silently forks every chat.
        // macOS and Windows already mirror + re-inject these; Android did not.
        val conversationKeysJson = if (!lastUser.isNullOrEmpty()) readStoredConversationKeys(lastUser) else null
        val conversationKeysLine = if (conversationKeysJson != null) "window.__ZALI_CONVERSATION_KEYS = $conversationKeysJson;" else ""
        // Who the two lines above belong to. Everything injected here is read out of
        // the LAST logged-in user's files and then lives for the whole life of the
        // document, so without this stamp a different account signing in afterwards
        // merged the previous account's conversation keys into its own store and
        // adopted its device identity (private ECDH key included). The shared UI
        // refuses injected material whose stamp does not match the signed-in account
        // — see injectedMaterialMatchesAccount() in web/src/interface/key_resolution.js.
        val injectedForUserLine = if (!lastUser.isNullOrEmpty()) {
            "window.__ZALI_INJECTED_FOR_USER = ${JSONObject.quote(lastUser)};"
        } else ""
        return """
        (function () {
          $injectedForUserLine
          $identityLine
          $conversationKeysLine
          window.__ZALI_NATIVE_CAPS__ = {
            apiRequest: true,
            networkConfig: true,
            setKey: true,
            sendMessage: true,
            sessionSync: false,
            saveStyle: false,
            saveMessageCache: false,
            downloadAttachment: true,
            // История канала расшифровывается ЗДЕСЬ, тем же нативным конвейером,
            // что и личная переписка. Пока стояло false, веб уходил в браузерную
            // ветку loadServerMessages(), а та требует WASM-сборки ядра, которой в
            // ассетах нет и из `file://`-документа быть не может (Chromium не
            // грузит ES-модули с этой схемы). Каналы на телефоне просто не имели
            // истории: живые сообщения приходили, всё до открытия — нет.
            serverHistory: true,
            avatarFetch: true,
            // Правка тоже нативная, по той же причине: browserEditMessage()
            // переупаковывает архив в WASM и отправляет его multipart'ом мимо моста,
            // то есть с Origin: null, который сервер отвергает по CORS.
            editMessage: true,
            tenor: true,
            voice: false,
            windowDrag: false,
            screenCapture: true,
            mobileNav: true
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
          // Здесь стояло document.body.classList.add('zali-native-android') — мёртвый
          // код с двух сторон: на document-start document.body ещё null, а в CSS этот
          // класс не используется нигде.
        })();
        """.trimIndent()
    }

    /** Switch the visible section by driving the shared web UI. */
    fun selectTab(name: String) {
        // Через JSONObject.quote, а не интерполяцией: имя приходит из перечисления и
        // сейчас безопасно, но строка, собираемая для evaluateJavascript вручную, —
        // это ровно тот шов, на котором такие вещи потом и ломаются.
        val quoted = JSONObject.quote(name)
        mainHandler.post {
            webView.evaluateJavascript("window.__zaliSelectTab && window.__zaliSelectTab($quoted);", null)
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
                    persistConversationKeys()
                }
            }
            "REFRESH_HISTORY" -> handleRefreshHistory(dict)
            "LOAD_SERVER_HISTORY" -> handleLoadServerHistory(dict)
            "SEND_MESSAGE" -> handleSendMessage(dict)
            "EDIT_MESSAGE" -> handleEditMessage(dict)
            "UPLOAD_AVATAR_REQUEST" -> handleAvatarUploadRequest(dict, delete = false)
            "DELETE_AVATAR_REQUEST" -> handleAvatarUploadRequest(dict, delete = true)
            "LOAD_AVATAR_REQUEST" -> handleLoadAvatarRequest(dict)
            "RESOLVE_TENOR" -> resolveTenor(dict.optString("url", ""), dict.optString("requestId", UUID.randomUUID().toString()))
            "DOWNLOAD_ATTACHMENT" -> saveAttachment(dict.optString("dataUrl", ""), dict.optString("filename", "attachment"))
            "MOBILE_NAV_PROGRESS" -> {
                val progress = dict.optDouble("progress", 0.0).toFloat().coerceIn(0f, 1f)
                val animate = dict.optBoolean("animate", true)
                val section = dict.optString("section", "").trim()
                mainHandler.post {
                    onMobileNavProgress?.invoke(progress, animate)
                    if (section.isNotEmpty()) onMobileNavSection?.invoke(section)
                }
            }
            "START_SCREEN_CAPTURE" -> handleStartScreenCapture(dict)
            "STOP_SCREEN_CAPTURE" -> handleStopScreenCapture()
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

    /// Per-conversation E2E keys mirrored out of the WebView so they survive a
    /// relaunch or a WebView data wipe. See documentStartScript() for why.
    private fun readStoredConversationKeys(username: String): String? {
        val user = username.trim().lowercase()
        if (user.isEmpty()) return null
        val file = File(context.filesDir, "conversation_keys_$user.json")
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

    private fun persistConversationKeys() {
        val user = currentUsername()
        if (user.isEmpty()) return
        try {
            val obj = JSONObject()
            for ((scope, key) in conversationKeys) obj.put(scope, key)
            File(context.filesDir, "conversation_keys_$user.json").writeText(obj.toString())
        } catch (e: Exception) {
            // Best effort — a failed mirror still leaves the in-memory map usable.
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
        // OkHttp's BridgeInterceptor overwrites the "Content-Type" header with
        // the RequestBody's own contentType() unconditionally, even when the
        // header above was already set explicitly — a hardcoded
        // "application/octet-stream" here silently clobbered JS's
        // "application/json" on every POST (e.g. login), and the server's JSON
        // extractor rejected the request outright. Must reuse whatever
        // Content-Type JS actually sent.
        val contentTypeKey = rawHeaders.keys().asSequence().firstOrNull { it.equals("Content-Type", ignoreCase = true) }
        val mediaType = (contentTypeKey?.let { rawHeaders.optString(it) } ?: "application/octet-stream").toMediaTypeOrNull()
        val needsBody = method == "POST" || method == "PUT" || method == "PATCH"
        // interface.js's nativeApiFetch always sends body:'' (empty string, not
        // null/undefined) even for bodyless GETs — bodyStr is therefore "" rather
        // than null there. OkHttp's Request.Builder throws synchronously
        // ("method GET must not have a request body") if ANY RequestBody,
        // even an empty one, is attached to GET/HEAD/DELETE — so the body must
        // be gated on the method needing one, not merely on bodyStr being
        // non-null. This crashed every native GET call (contacts/users/key
        // envelopes) with "Java exception was raised during method invocation".
        val reqBody = if (needsBody) (bodyStr ?: "").toRequestBody(mediaType) else null
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
                    val headers = JSONObject()
                    for (name in it.headers.names()) {
                        headers.put(name, it.header(name))
                    }
                    val contentType = it.header("Content-Type")
                    val data = JSONObject().apply {
                        put("status", it.code)
                        put("ok", it.code in 200..299)
                        put("headers", headers)
                    }
                    // Бинарь не проходит через строковое поле: `body.string()` декодирует
                    // байты как UTF-8 и подставляет replacement-символы вместо всего, что
                    // в UTF-8 не укладывается, — то есть портит PNG/JPEG необратимо. Так
                    // молча не работали иконки и баннеры серверов.
                    if (isTextualContentType(contentType)) {
                        data.put("body", try { it.body?.string() ?: "" } catch (e: IOException) { "" })
                    } else {
                        val raw = try { it.body?.bytes() } catch (e: IOException) { null } ?: ByteArray(0)
                        data.put("body", "")
                        data.put("bodyBase64", android.util.Base64.encodeToString(raw, android.util.Base64.NO_WRAP))
                    }
                    sendNativeResponse(requestId, ok = true, data = data)
                }
            }
        })
    }

    /**
     * Можно ли отдать это тело JS-у строкой без потерь.
     *
     * Правило одно на все оболочки (macOS `NetworkService.isTextualContentType`,
     * Windows `native/api::is_textual_content_type`) — иначе одна и та же ссылка
     * приезжала бы текстом на одной платформе и base64 на другой.
     *
     * Отсутствующий Content-Type считается текстом: так вели себя все ответы до
     * появления этой развилки, и менять это для эндпойнтов, которые тип не ставят,
     * незачем.
     */
    private fun isTextualContentType(value: String?): Boolean {
        val type = value.orEmpty().substringBefore(';').trim().lowercase()
        if (type.isEmpty()) return true
        if (type.startsWith("text/")) return true
        if (type.endsWith("+json") || type.endsWith("+xml")) return true
        return type == "application/json" ||
            type == "application/javascript" ||
            type == "application/xml" ||
            type == "application/x-www-form-urlencoded"
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
        // Dedup guard stays on the calling thread so two rapid sends of the same
        // clientId can't both get past it.
        if (!inFlightSendClientIds.add(clientId)) return
        // Everything below is heavy (base64-decoding every attachment data URL,
        // writing temp files, then PBKDF2 210k + AES-GCM in packMessage) and this
        // method is reached straight from `@JavascriptInterface postMessage`, which
        // Android runs SYNCHRONOUSLY — the JS caller blocks until it returns. Doing
        // the work inline froze the entire web UI for the whole pack (hundreds of ms
        // for text, seconds with an attachment) on every single send. macOS/iOS
        // (WKScriptMessageHandler) and Windows (async IPC) never block their JS side
        // this way, which is why only Android showed it.
        cryptoExecutor.execute { performSendMessage(dict, clientId) }
    }

    private fun performSendMessage(dict: JSONObject, clientId: String) {
        val text = dict.optString("text", "")
        val recipient = dict.optString("recipient", "")
        val sender = dict.optString("sender", "")
        val key = dict.optString("key", "").trim()
        val keyVersion = if (dict.has("keyVersion")) dict.optInt("keyVersion", 2) else 2
        val serverId = dict.optString("serverId", "").ifEmpty { null }
        val channelId = dict.optString("channelId", "").ifEmpty { null }
        // Цитата ответа и запись о звонке — непрозрачные JSON-строки, которые ядро
        // шифрует тем же ключом, что и текст. До 0.2b33 их здесь просто не читали,
        // и ответ, отправленный с телефона, приезжал собеседнику без цитаты —
        // безвозвратно, потому что восстанавливать её неоткуда.
        val callPayload = dict.optString("call", "").trim().ifEmpty { null }
        val replyPayload = dict.optString("reply", "").trim().ifEmpty { null }

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
        val (packedAttachments, tempAttachmentFiles) = stageAttachmentsForPacking(dict.optJSONArray("attachments"))

        val packed = ZaliCoreBridge.packMessage(
            sender, text, tempPath, key, keyVersion, packedAttachments,
            call = callPayload, reply = replyPayload,
        )
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

    /**
     * Раскладывает вложения из `data:`-URL по временным файлам и собирает описания
     * в том виде, в каком их ждёт `zali_net:pack_message`.
     *
     * Общая для отправки и для правки: правка заменяет архив ЦЕЛИКОМ, поэтому она
     * обязана переупаковать сообщение вместе со всеми вложениями — пропустить их
     * значит молча выбросить их из сообщения.
     *
     * Возвращает и список временных файлов: вызывающий удаляет их сразу после
     * упаковки, независимо от её исхода.
     */
    private fun stageAttachmentsForPacking(attachmentsIn: JSONArray?): Pair<List<JSONObject>, List<File>> {
        val packedAttachments = mutableListOf<JSONObject>()
        val tempAttachmentFiles = mutableListOf<File>()
        val source = attachmentsIn ?: JSONArray()

        for (i in 0 until source.length()) {
            val attachment = source.optJSONObject(i) ?: continue
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
        return packedAttachments to tempAttachmentFiles
    }

    // MARK: - Message edit (EDIT_MESSAGE)
    //
    // Порт macOS'ового `.editMessage` (WebView.swift) + `NetworkService.editMessage`.
    // Правка заменяет архив целиком: сервер принимает `PUT /api/message/:id` с тем же
    // multipart'ом, что и отправка (`key_version` + `file`), и сам проверяет, что
    // правит автор.

    private fun handleEditMessage(dict: JSONObject) {
        val requestId = dict.optString("requestId", dict.optString("request_id", UUID.randomUUID().toString()))
        cryptoExecutor.execute { performEditMessage(dict, requestId) }
    }

    private fun performEditMessage(dict: JSONObject, requestId: String) {
        val messageId = dict.optString("messageId", "").trim()
        val text = dict.optString("text", "")
        val key = dict.optString("key", "").trim()
        val keyVersion = if (dict.has("keyVersion")) dict.optInt("keyVersion", 2) else 2
        val callPayload = dict.optString("call", "").trim().ifEmpty { null }
        val replyPayload = dict.optString("reply", "").trim().ifEmpty { null }

        if (messageId.isEmpty() || key.isEmpty()) {
            sendNativeResponse(requestId, ok = false,
                error = if (key.isEmpty()) "Core: E2E-ключ не задан" else "Не указано сообщение")
            return
        }
        if (!ZaliCoreBridge.isAvailable) {
            sendNativeResponse(requestId, ok = false, error = "Core: нативная библиотека не загружена")
            return
        }

        val tempPath = File(context.cacheDir, "${UUID.randomUUID()}.zali").path
        val (packedAttachments, tempAttachmentFiles) = stageAttachmentsForPacking(dict.optJSONArray("attachments"))
        // Автор берётся из payload'а, а не из currentUsername(): последний хранится в
        // нижнем регистре (см. handlePersistDeviceIdentity), а это поле попадает
        // внутрь архива и оттуда читается при отрисовке — правка переименовала бы
        // автора. currentUsername() остаётся страховкой на случай старого веба.
        val sender = dict.optString("sender", "").trim().ifEmpty { currentUsername() }
        val packed = ZaliCoreBridge.packMessage(
            sender, text, tempPath, key, keyVersion, packedAttachments,
            call = callPayload, reply = replyPayload,
        )
        tempAttachmentFiles.forEach { it.delete() }
        if (!packed) {
            sendNativeResponse(requestId, ok = false, error = "Core: Ошибка при упаковке сообщения")
            return
        }

        val archiveFile = File(tempPath)
        val bodyBuilder = MultipartBody.Builder().setType(MultipartBody.FORM)
            .addFormDataPart("key_version", max(1, keyVersion).toString())
            .addFormDataPart(
                "file", "msg.zali",
                archiveFile.asRequestBody("application/octet-stream".toMediaTypeOrNull())
            )

        // Путь собирается сегментами (`addPathSegment` кодирует их сам), а не
        // интерполяцией: id приходит из серверных данных и не должен уметь выйти за
        // пределы пути. Тот же приём, что у Windows-шелла (`path_segments_mut().push()`)
        // и macOS (`appendingPathComponent`).
        val base = apiBaseUrl.toHttpUrlOrNull()
        if (base == null) {
            archiveFile.delete()
            sendNativeResponse(requestId, ok = false, error = "Некорректный адрес сервера")
            return
        }
        val url = base.newBuilder()
            .addPathSegment("api").addPathSegment("message").addPathSegment(messageId)
            .build()

        val requestBuilder = Request.Builder().url(url).put(bodyBuilder.build())
        if (wsAuthToken.isNotEmpty()) requestBuilder.header("Authorization", "Bearer $wsAuthToken")
        if (wsDeviceId.isNotEmpty()) requestBuilder.header("X-Zali-Device-ID", wsDeviceId)

        transferClient.newCall(requestBuilder.build()).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                archiveFile.delete()
                sendNativeResponse(requestId, ok = false, error = e.message ?: "Не удалось отправить изменения")
            }
            override fun onResponse(call: Call, response: Response) {
                response.use {
                    archiveFile.delete()
                    val bodyString = try { it.body?.string() ?: "" } catch (e: IOException) { "" }
                    if (!it.isSuccessful) {
                        sendNativeResponse(requestId, ok = false,
                            error = bodyString.trim().ifEmpty { "Не удалось отправить изменения" })
                        return
                    }
                    // Кэш расшифровки ключуется id, а содержимое под этим id только что
                    // сменилось — без сброса история вечно перерисовывала бы текст «до
                    // правки». Отрицательный кэш сбрасывается по той же причине: архив
                    // другой, прежний вердикт «не открывается» к нему не относится.
                    forgetDecryptedMessage(messageId)
                    sendNativeResponse(requestId, ok = true, data = JSONObject().put("messageId", messageId))
                }
            }
        })
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

        transferClient.newCall(requestBuilder.build()).enqueue(object : Callback {
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
            transferClient.newCall(requestBuilder.build()).enqueue(object : Callback {
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

        transferClient.newCall(requestBuilder.build()).enqueue(object : Callback {
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

        transferClient.newCall(requestBuilder.build()).enqueue(object : Callback {
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

    // MARK: - Screen capture (START_SCREEN_CAPTURE / STOP_SCREEN_CAPTURE)
    //
    // Android WebView has no getDisplayMedia() at all (Chromium/WebView
    // limitation — see project_mobile_parity_effort memory), so this drives
    // native MediaProjection capture (ScreenCaptureService) instead. Frames
    // come back on that service's own background thread via
    // onScreenCaptureFrame and are relayed to JS as screen_capture_frame bus
    // events; interface.js's onNativeScreenCaptureFrame paints them onto an
    // offscreen <canvas> and turns canvas.captureStream() into the same kind
    // of MediaStreamTrack a desktop getDisplayMedia() call would produce.

    private fun handleStartScreenCapture(dict: JSONObject) {
        val requestId = dict.optString("requestId", "")
        if (requestId.isEmpty()) return
        activeScreenCaptureRequestId = requestId
        val launcher = requestScreenCapturePermission
        if (launcher == null) {
            emitScreenCaptureError(requestId, "Демонстрация экрана недоступна")
            return
        }
        mainHandler.post { launcher(requestId) }
    }

    private fun handleStopScreenCapture() {
        if (activeScreenCaptureRequestId.isEmpty()) return
        activeScreenCaptureRequestId = ""
        context.stopService(android.content.Intent(context, ScreenCaptureService::class.java))
    }

    /** Called by MainActivity when the user declines the system screen-capture
     * consent dialog (or it's dismissed without a result). */
    fun onScreenCaptureDenied(requestId: String) {
        if (requestId != activeScreenCaptureRequestId) return
        activeScreenCaptureRequestId = ""
        emitScreenCaptureError(requestId, null)
    }

    /** Called by [ScreenCaptureService] on its own background capture thread —
     * the base64 encode happens off the main thread on purpose; only the
     * final evaluateJavascript hop needs to run there. */
    fun onScreenCaptureFrame(requestId: String, jpegBytes: ByteArray) {
        if (requestId != activeScreenCaptureRequestId) return
        val dataUrl = "data:image/jpeg;base64," + android.util.Base64.encodeToString(jpegBytes, android.util.Base64.NO_WRAP)
        val payload = JSONObject().apply {
            put("requestId", requestId)
            put("dataUrl", dataUrl)
        }
        val js = "window.loader && window.loader.bus.send('zali_interface:screen_capture_frame', $payload);"
        mainHandler.post { webView.evaluateJavascript(js, null) }
    }

    /** Called by [ScreenCaptureService] when MediaProjection setup itself fails
     * (distinct from the user simply declining the consent dialog). */
    fun onScreenCaptureError(requestId: String, message: String?) {
        if (requestId != activeScreenCaptureRequestId) return
        activeScreenCaptureRequestId = ""
        emitScreenCaptureError(requestId, message)
    }

    private fun emitScreenCaptureError(requestId: String, message: String?) {
        val payload = JSONObject().apply {
            put("requestId", requestId)
            if (message != null) put("message", message)
        }
        val js = "window.loader && window.loader.bus.send('zali_interface:screen_capture_error', $payload);"
        mainHandler.post { webView.evaluateJavascript(js, null) }
    }

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
            "device_approved" -> {
                // A peer registered or approved a device — push our conversation keys out
                // again instead of waiting for our own next login. Android handled neither
                // event before, so a phone was a permanent dead end for key redistribution.
                webView.evaluateJavascript("window.retryPublishKeys && window.retryPublishKeys();", null)
            }
            "key_republish_request" -> {
                // Deliberately NOT folded into retryPublishKeys() above, which is exactly
                // what this used to do. The sweep publishes each scope's ACTIVE key only,
                // while a participant sends this event precisely because the messages it
                // cannot read were encrypted under a key we have since demoted to an
                // `alt:` candidate — so the sweep answers with the one key the requester
                // is guaranteed to already have. It is also coalesced on a 60 s window,
                // so a targeted request often produced nothing at all. Only
                // handleKeyRepublishRequest replies with every candidate for the scope,
                // and it needs the payload to know which scope that is. Mirrors Windows
                // (native/transport.rs) and macOS (NetworkService.swift).
                webView.evaluateJavascript("window.keyRepublishRequest && window.keyRepublishRequest($raw);", null)
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
            else -> {
                // Общий проброс: кадр уходит в JS как есть, смысл события знает
                // только он (dispatchRealtimeEvent в web/src/interface/state_sync.js).
                // До этого `when` просто не имел ветки else, и каждая новая
                // серверная нотификация молча терялась на Android до тех пор,
                // пока сюда не впишут её тип руками — ровно так фичи и «выходили
                // на десктопе, минуя телефон».
                //
                // voice_* исключены намеренно: голосовой сигналинг в вебе идёт по
                // собственному сокету JS, а ICE-кандидаты летят десятками в секунду —
                // гнать их ещё и через evaluateJavascript значит греть телефон впустую.
                if (!type.startsWith("voice_")) {
                    webView.evaluateJavascript(
                        "window.receiveRealtimeEvent && window.receiveRealtimeEvent($raw);",
                        null,
                    )
                }
            }
        }
    }

    // MARK: - DM history load (REFRESH_HISTORY)
    //
    // Ported from macOS's `.refreshHistory` IPC case + `WebView.reloadHistory(for:)` /
    // `NetworkService.fetchMessages`. interface.js sends this whenever a chat is
    // opened or refreshed (`syncActiveConversation()`, `refreshAfterKey()`) — until
    // this handler existed, it was silently dropped here, so DM history never loaded
    // on Android ("Начните диалог" for every real contact).
    private var historyReloadToken = 0

    private fun handleRefreshHistory(dict: JSONObject) {
        val key = dict.optString("key", "").trim()
        if (key.isNotEmpty()) currentE2eKey = key
        val peer = dict.optString("peer", "").trim()
        if (peer.isEmpty()) return
        val token = ++historyReloadToken
        fetchMessagesPage(peer, limit = 200, offset = 0, accumulated = mutableListOf()) { records, ok ->
            if (token != historyReloadToken) return@fetchMessagesPage // a newer reload superseded this one
            if (!ok) return@fetchMessagesPage // transient fetch failure — keep whatever's already shown, don't blank it
            if (records.isEmpty()) {
                mainHandler.post { webView.evaluateJavascript("window.loadHistory && window.loadHistory([]);", null) }
                return@fetchMessagesPage
            }
            renderHistoryRecords(records, peer, token) { rendered ->
                if (token != historyReloadToken) return@renderHistoryRecords
                val json = JSONArray(rendered)
                mainHandler.post { webView.evaluateJavascript("window.loadHistory && window.loadHistory($json);", null) }
            }
        }
    }

    // MARK: - Channel history load (LOAD_SERVER_HISTORY)
    //
    // Порт macOS'ового `.loadServerHistory` (WebView.swift::reloadServerHistory).
    // Тот же конвейер, что и у личной переписки: страничная выборка метаданных, затем
    // последовательное скачивание и расшифровка каждого архива нативным ядром — то
    // есть с теми же кандидатами ключей и теми же кэшами.
    //
    // До 0.2b33 Android объявлял `serverHistory: false`, веб уходил в браузерную
    // ветку на WASM, а её на этой платформе нет и быть не может (ES-модули с `file://`
    // Chromium не грузит). Каналы на телефоне просто не имели истории.

    private fun handleLoadServerHistory(dict: JSONObject) {
        val serverId = dict.optString("serverId", dict.optString("server_id", "")).trim()
        val channelId = dict.optString("channelId", dict.optString("channel_id", "")).trim()
        if (serverId.isEmpty() || channelId.isEmpty()) return
        val key = dict.optString("key", "").trim()
        if (key.isNotEmpty()) currentE2eKey = key

        val token = ++historyReloadToken
        fetchChannelMessagesPage(serverId, channelId, limit = 200, offset = 0, accumulated = mutableListOf()) { records, ok ->
            if (token != historyReloadToken) return@fetchChannelMessagesPage
            // Неудача выборки не бланкует канал: пустой пуш стёр бы то, что уже видно.
            if (!ok) return@fetchChannelMessagesPage
            if (records.isEmpty()) {
                emitServerHistory(serverId, channelId, JSONArray())
                return@fetchChannelMessagesPage
            }
            renderHistoryRecords(records, peer = "", token = token, serverId = serverId, channelId = channelId) { rendered ->
                if (token != historyReloadToken) return@renderHistoryRecords
                emitServerHistory(serverId, channelId, JSONArray(rendered))
            }
        }
    }

    private fun emitServerHistory(serverId: String, channelId: String, messages: JSONArray) {
        val payload = JSONObject().apply {
            put("serverId", serverId)
            put("channelId", channelId)
            put("messages", messages)
        }
        mainHandler.post {
            webView.evaluateJavascript("window.loadServerHistory && window.loadServerHistory($payload);", null)
        }
    }

    private fun fetchChannelMessagesPage(
        serverId: String,
        channelId: String,
        limit: Int,
        offset: Int,
        accumulated: MutableList<JSONObject>,
        completion: (List<JSONObject>, Boolean) -> Unit,
    ) {
        val base = apiBaseUrl.toHttpUrlOrNull()
        if (base == null) {
            completion(accumulated, false)
            return
        }
        val url = base.newBuilder()
            .addPathSegment("api").addPathSegment("servers").addPathSegment(serverId)
            .addPathSegment("channels").addPathSegment(channelId).addPathSegment("messages")
            .addQueryParameter("limit", limit.toString())
            .addQueryParameter("offset", offset.toString())
            .build()
        val request = Request.Builder().url(url).apply {
            if (wsAuthToken.isNotEmpty()) header("Authorization", "Bearer $wsAuthToken")
        }.build()
        httpClient.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                completion(accumulated, false)
            }
            override fun onResponse(call: Call, response: Response) {
                response.use {
                    if (!it.isSuccessful) {
                        completion(accumulated, false)
                        return
                    }
                    val bodyString = try { it.body?.string() } catch (e: IOException) { null }
                    val page = try { bodyString?.let { s -> JSONArray(s) } } catch (e: Exception) { null }
                    if (page == null) {
                        completion(accumulated, false)
                        return
                    }
                    for (i in 0 until page.length()) accumulated.add(page.getJSONObject(i))
                    if (page.length() < limit) {
                        completion(accumulated, true)
                    } else {
                        fetchChannelMessagesPage(serverId, channelId, limit, offset + limit, accumulated, completion)
                    }
                }
            }
        })
    }

    /** `GET /api/messages/{user}?limit&offset`, same pagination as macOS's
     * `fetchMessagesPage` — recurse while a page comes back full. */
    private fun fetchMessagesPage(
        username: String,
        limit: Int,
        offset: Int,
        accumulated: MutableList<JSONObject>,
        completion: (List<JSONObject>, Boolean) -> Unit,
    ) {
        val encodedUser = java.net.URLEncoder.encode(username, "UTF-8")
        val request = Request.Builder().url("$apiBaseUrl/api/messages/$encodedUser?limit=$limit&offset=$offset").apply {
            if (wsAuthToken.isNotEmpty()) header("Authorization", "Bearer $wsAuthToken")
        }.build()
        httpClient.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                completion(accumulated, false)
            }
            override fun onResponse(call: Call, response: Response) {
                response.use {
                    if (!it.isSuccessful) {
                        completion(accumulated, false)
                        return
                    }
                    val bodyString = try { it.body?.string() } catch (e: IOException) { null }
                    val page = try { bodyString?.let { s -> JSONArray(s) } } catch (e: Exception) { null }
                    if (page == null) {
                        completion(accumulated, false)
                        return
                    }
                    for (i in 0 until page.length()) accumulated.add(page.getJSONObject(i))
                    if (page.length() < limit) {
                        completion(accumulated, true)
                    } else {
                        fetchMessagesPage(username, limit, offset + limit, accumulated, completion)
                    }
                }
            }
        })
    }

    // MARK: - Decrypt caches (положительный и отрицательный)
    //
    // Расшифровка одного сообщения — это PBKDF2-SHA256 по 210 000 итераций дважды на
    // КАЖДЫЙ неподошедший ключ-кандидат. История перечитывается на каждый
    // `key_envelope_available`, а он приходит именно тогда, когда переписка ещё
    // нечитаема, — то есть ровно в тот момент, когда перебор самый дорогой и самый
    // бесполезный. Оба кэша есть у macOS (`WebView.swift`) и Windows
    // (`native/cache.rs`); на Android их не было вовсе.

    private val decryptedMessageCache = object : LinkedHashMap<String, JSONObject>(64, 0.75f, false) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, JSONObject>): Boolean =
            size > DECRYPTED_CACHE_MAX_ENTRIES
    }

    /**
     * id сообщений, которые открыть НЕ удалось, вместе с отпечатком того набора
     * ключей, которым пробовали. Самопочинка сохраняется: появился новый ключ —
     * отпечаток другой, запись протухла, и повтор происходит на следующем же проходе.
     */
    private val failedDecryptFingerprints = object : LinkedHashMap<String, String>(64, 0.75f, false) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, String>): Boolean =
            size > DECRYPTED_CACHE_MAX_ENTRIES
    }

    private fun cachedDecryptedMessage(messageId: String): JSONObject? =
        synchronized(decryptedMessageCache) { decryptedMessageCache[messageId] }

    private fun cacheDecryptedMessage(messageId: String, decrypted: JSONObject) {
        val id = messageId.trim()
        if (id.isEmpty()) return
        // Вложения лежат внутри как inline data:-URL, поэтому кэш обязан оставаться
        // щитом от процессора, а не свалкой в памяти.
        if (decrypted.toString().length > DECRYPTED_CACHE_MAX_ENTRY_CHARS) return
        synchronized(decryptedMessageCache) { decryptedMessageCache[id] = decrypted }
    }

    private fun decryptKnownToFail(messageId: String, fingerprint: String): Boolean =
        synchronized(failedDecryptFingerprints) { failedDecryptFingerprints[messageId] == fingerprint }

    private fun rememberDecryptFailure(messageId: String, fingerprint: String) {
        val id = messageId.trim()
        if (id.isEmpty()) return
        synchronized(failedDecryptFingerprints) { failedDecryptFingerprints[id] = fingerprint }
    }

    /**
     * Забывает про сообщение в ОБОИХ кэшах. Зовётся после правки: архив под этим id
     * заменён целиком, поэтому и расшифрованный текст, и вердикт «не открывается»
     * относятся к тому, чего больше нет.
     */
    private fun forgetDecryptedMessage(messageId: String) {
        val id = messageId.trim()
        if (id.isEmpty()) return
        synchronized(decryptedMessageCache) { decryptedMessageCache.remove(id) }
        synchronized(failedDecryptFingerprints) { failedDecryptFingerprints.remove(id) }
    }

    /** Sequentially downloads + decrypts every record (mirrors macOS's `for record in
     * records { await ... }` — not parallel: a burst of many concurrent downloads
     * previously saturated the connection pool and stalled every request, see
     * NativeBridge's httpClient dispatcher comment above). */
    private fun renderHistoryRecords(
        records: List<JSONObject>,
        peer: String,
        token: Int,
        serverId: String? = null,
        channelId: String? = null,
        completion: (List<JSONObject>) -> Unit,
    ) {
        val rendered = mutableListOf<JSONObject>()
        fun next(index: Int) {
            if (token != historyReloadToken) return
            if (index >= records.size) {
                completion(rendered)
                return
            }
            renderHistoryRecord(records[index], peer, serverId, channelId) { result ->
                if (result != null) rendered.add(result)
                next(index + 1)
            }
        }
        next(0)
    }

    /** archivePath comes from message.json INSIDE the (peer-authored) archive — the
     * SDK never validates it, so a malicious value like "../../secret" would make
     * `File(tempDir, archivePath)` resolve outside tempDir and read an arbitrary
     * local file. Mirrors the guard in apps/windows/src/native/messages.rs and
     * macOS's NetworkService.safeAttachmentURL: only a plain relative path with no
     * ".." segments is accepted. */
    private fun isSafeArchivePath(path: String): Boolean {
        if (path.isEmpty() || path.startsWith("/") || path.contains('\\')) return false
        return path.split('/').none { it.isEmpty() || it == ".." }
    }

    /**
     * Вложения расшифрованного архива в том виде, в каком их ждёт веб. Мелкие
     * вкладываются inline как `data:`-URL (порог 2 МБ — тот же, что у macOS/iOS),
     * крупные едут только описанием и докачиваются по требованию.
     */
    private fun renderedAttachments(payload: ZaliCoreBridge.MessagePayload, tempDir: File): JSONArray {
        val attachments = JSONArray()
        for (attachment in payload.attachments) {
            val rendered = JSONObject().apply {
                put("name", attachment.name)
                put("mimeType", attachment.mimeType)
                put("kind", attachment.kind)
                put("size", attachment.size)
            }
            if (attachment.size <= 2 * 1024 * 1024 && isSafeArchivePath(attachment.archivePath)) {
                val attachmentFile = File(tempDir, attachment.archivePath)
                if (attachmentFile.exists()) {
                    val b64 = android.util.Base64.encodeToString(attachmentFile.readBytes(), android.util.Base64.NO_WRAP)
                    rendered.put("dataUrl", "data:${attachment.mimeType};base64,$b64")
                }
            }
            attachments.put(rendered)
        }
        return attachments
    }

    /**
     * Расшифрованное содержимое (`sender`/`text`/`call`/`reply`/`attachments`) —
     * ровно то, что кладётся в положительный кэш. Метаданные (реакции, время) в него
     * НЕ попадают: они меняются независимо от архива, и закэшировать их значило бы
     * показывать вчерашние реакции.
     */
    private fun decryptedContent(payload: ZaliCoreBridge.MessagePayload, tempDir: File): JSONObject =
        JSONObject().apply {
            put("sender", payload.sender)
            put("text", payload.text)
            payload.call?.let { put("call", it) }
            payload.reply?.let { put("reply", it) }
            put("attachments", renderedAttachments(payload, tempDir))
        }

    /** Склейка расшифрованного содержимого со свежими метаданными записи истории. */
    private fun buildHistoryOutput(
        messageId: String,
        record: JSONObject,
        decrypted: JSONObject,
        receiver: String,
        serverId: String?,
        channelId: String?,
    ): JSONObject = JSONObject().apply {
        put("id", messageId)
        put("clientId", record.optString("clientId", record.optString("client_id", "")))
        put("sender", decrypted.optString("sender"))
        put("receiver", receiver)
        put("text", decrypted.optString("text"))
        put("attachments", decrypted.optJSONArray("attachments") ?: JSONArray())
        if (decrypted.has("call")) put("call", decrypted.optString("call"))
        if (decrypted.has("reply")) put("reply", decrypted.optString("reply"))
        put("timestamp", record.opt("timestamp"))
        put("reactions", record.optJSONArray("reactions") ?: JSONArray())
        put("myReactions", record.optJSONArray("myReactions") ?: JSONArray())
        if (serverId != null) put("serverId", serverId)
        if (channelId != null) put("channelId", channelId)
    }

    private fun renderHistoryRecord(
        record: JSONObject,
        peer: String,
        serverId: String?,
        channelId: String?,
        completion: (JSONObject?) -> Unit,
    ) {
        val messageId = record.optString("id", "").trim()
        if (messageId.isEmpty()) {
            completion(null)
            return
        }
        val sender = record.optString("sender", peer)
        val receiver = record.optString("receiver", peer)
        val clientId = record.optString("clientId", record.optString("client_id", ""))

        fun placeholder(text: String): JSONObject = JSONObject().apply {
            put("id", messageId)
            put("clientId", clientId)
            put("sender", sender)
            put("receiver", receiver)
            put("text", text)
            put("attachments", JSONArray())
            put("timestamp", record.opt("timestamp"))
            put("reactions", record.optJSONArray("reactions") ?: JSONArray())
            put("myReactions", record.optJSONArray("myReactions") ?: JSONArray())
            if (serverId != null) put("serverId", serverId)
            if (channelId != null) put("channelId", channelId)
        }

        if (!ZaliCoreBridge.isAvailable) {
            completion(placeholder("⚠️ Не удалось загрузить сообщение"))
            return
        }

        // Уже расшифровано в этой сессии — ни скачивания, ни PBKDF2.
        cachedDecryptedMessage(messageId)?.let { cached ->
            completion(buildHistoryOutput(messageId, record, cached, receiver, serverId, channelId))
            return
        }

        val keys = ZaliCoreBridge.candidateMessageKeys(
            currentKey = currentE2eKey, conversationKeys = conversationKeys,
            participantA = sender, participantB = receiver,
            serverId = serverId, channelId = channelId,
        )
        val fingerprint = ZaliCoreBridge.candidateKeysFingerprint(keys)
        if (decryptKnownToFail(messageId, fingerprint)) {
            // Тот же плейсхолдер, что и у неудачной ветки ниже, а не null: вернуть
            // ничего значило бы выкинуть сообщение из истории, то есть разменять
            // сэкономленный PBKDF2 на исчезающее сообщение.
            val hasScopeKey = ZaliCoreBridge.hasConversationScopeKey(
                conversationKeys = conversationKeys,
                participantA = sender, participantB = receiver,
                serverId = serverId, channelId = channelId,
            )
            completion(placeholder(
                if (hasScopeKey) "🔒 Сообщение зашифровано другим ключом"
                else "🔑 Получение ключа…"
            ))
            return
        }

        val encodedId = java.net.URLEncoder.encode(messageId, "UTF-8")
        val request = Request.Builder().url("$apiBaseUrl/api/download/$encodedId").apply {
            if (wsAuthToken.isNotEmpty()) header("Authorization", "Bearer $wsAuthToken")
        }.build()
        transferClient.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                completion(placeholder("⚠️ Не удалось загрузить сообщение"))
            }
            override fun onResponse(call: Call, response: Response) {
                response.use {
                    if (it.code == 413) {
                        completion(placeholder("📦 Файл сообщения превышает допустимый размер"))
                        return
                    }
                    if (!it.isSuccessful) {
                        completion(placeholder("⚠️ Не удалось загрузить сообщение"))
                        return
                    }
                    val bytes = try { it.body?.bytes() } catch (e: IOException) { null }
                    if (bytes == null) {
                        completion(placeholder("⚠️ Не удалось загрузить сообщение"))
                        return
                    }

                    val workDirName = UUID.randomUUID().toString()
                    val archiveFile = File(context.cacheDir, "$workDirName.zali")
                    val tempDir = File(context.cacheDir, "$workDirName-unpack")
                    try {
                        archiveFile.writeBytes(bytes)
                        tempDir.mkdirs()

                        val payload = ZaliCoreBridge.unpackMessage(archiveFile.path, tempDir.path, keys)
                        if (payload == null) {
                            rememberDecryptFailure(messageId, fingerprint)
                            // Before key sync converges on a freshly logged-in device the
                            // only candidate is currentE2eKey, so this fails for every
                            // message. "Encrypted with another key" is a permanent-sounding
                            // verdict on a state that repairs itself once the envelope lands.
                            val hasScopeKey = ZaliCoreBridge.hasConversationScopeKey(
                                conversationKeys = conversationKeys,
                                participantA = sender, participantB = receiver,
                                serverId = serverId, channelId = channelId,
                            )
                            completion(placeholder(
                                if (hasScopeKey) "🔒 Сообщение зашифровано другим ключом"
                                else "🔑 Получение ключа…"
                            ))
                            return
                        }

                        val decrypted = decryptedContent(payload, tempDir)
                        cacheDecryptedMessage(messageId, decrypted)
                        completion(buildHistoryOutput(messageId, record, decrypted, receiver, serverId, channelId))
                    } finally {
                        archiveFile.delete()
                        tempDir.deleteRecursively()
                    }
                }
            }
        })
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
        transferClient.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {}
            override fun onResponse(call: Call, response: Response) {
                response.use {
                    if (!it.isSuccessful) return
                    val bytes = try { it.body?.bytes() } catch (e: IOException) { null } ?: return
                    // NOT mainHandler: unpackMessage is PBKDF2 210k + AES-GCM, and
                    // running it on the UI thread janked (and on slow devices ANR'd)
                    // the app on every single incoming message.
                    cryptoExecutor.execute { decryptAndDeliver(bytes, id, sender, receiver, serverId, channelId) }
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

            // Кандидаты: ключ своего scope, текущий активный, затем ограниченный и
            // отсортированный хвост из остальных (см. candidateMessageKeys). Раньше
            // здесь дописывались ВСЕ значения мапы без потолка — на каждый
            // неподошедший ключ два прохода PBKDF2 по 210 000 итераций.
            val keys = ZaliCoreBridge.candidateMessageKeys(
                currentKey = currentE2eKey, conversationKeys = conversationKeys,
                participantA = sender, participantB = receiver, serverId = serverId, channelId = channelId
            )
            val fingerprint = ZaliCoreBridge.candidateKeysFingerprint(keys)
            if (decryptKnownToFail(id, fingerprint)) return

            val payload = ZaliCoreBridge.unpackMessage(archiveFile.path, tempDir.path, keys)
            if (payload == null) {
                rememberDecryptFailure(id, fingerprint)
                return
            }

            val decrypted = decryptedContent(payload, tempDir)
            cacheDecryptedMessage(id, decrypted)

            val messagePayload = JSONObject().apply {
                put("id", id)
                put("sender", payload.sender)
                put("receiver", receiver)
                put("text", payload.text)
                put("attachments", decrypted.optJSONArray("attachments") ?: JSONArray())
                // Цитата ответа и запись о звонке лежат ВНУТРИ шифротекста. receiveMessage()
                // в interface.js собирает сообщение по полям, а не спредом, — поле,
                // забытое здесь, теряется при живой доставке и «чинится» только
                // следующей перезагрузкой истории.
                payload.call?.let { put("call", it) }
                payload.reply?.let { put("reply", it) }
                // Времени здесь намеренно нет: в архиве оно лежит unix-секундами, а вся
                // остальная история оперирует ISO-строками, и смешивать их в одном поле
                // нельзя. Для только что доставленного сообщения веб сам подставляет
                // текущий момент — как и на macOS/Windows, которые тоже его не шлют.
                if (serverId != null) put("serverId", serverId)
                if (channelId != null) put("channelId", channelId)
            }
            // evaluateJavascript must be called on the main thread — this method now
            // runs on cryptoExecutor.
            mainHandler.post {
                webView.evaluateJavascript("window.receiveMessage && window.receiveMessage($messagePayload);", null)
            }
        } finally {
            archiveFile.delete()
            tempDir.deleteRecursively()
        }
    }

    private fun setConnectionStatusJs(connected: Boolean) {
        webView.evaluateJavascript("window.setConnectionStatus && window.setConnectionStatus($connected);", null)
    }

    fun teardown() {
        cryptoExecutor.shutdown()
        wsInstance?.cancel()
        if (activeInstance === this) activeInstance = null
        context.stopService(android.content.Intent(context, ScreenCaptureService::class.java))
    }

    companion object {
        private const val LAST_USERNAME_KEY = "last_username"

        /** Потолки обоих кэшей расшифровки — те же, что у Windows (`native/cache.rs`). */
        private const val DECRYPTED_CACHE_MAX_ENTRIES = 400
        private const val DECRYPTED_CACHE_MAX_ENTRY_CHARS = 512 * 1024

        private const val REQUEST_CODE_NOTIFICATIONS = 4201
        /** Feature-checked at the call site before using [androidx.webkit.WebViewCompat.addDocumentStartJavaScript]. */
        val documentStartScriptSupported: Boolean
            get() = WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
        /** See the "Screen capture" section above — lets [ScreenCaptureService]
         * (started via Intent, not direct construction) reach back into the
         * live bridge to push frames/errors. */
        @Volatile
        var activeInstance: NativeBridge? = null
    }
}
