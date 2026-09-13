package org.zalikus.messenger

import android.content.Context
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Сессия для фонового приёма FCM (PushMessagingService) и регистрация FCM-токена на
 * сервере (server/src/fcm.rs).
 *
 * Пуш будит процесс без Activity, WebView и NativeBridge, поэтому всё, что нужно для
 * скачивания и расшифровки сообщения, — адрес API, токен сессии, имя аккаунта и id
 * устройства — хранится здесь, а не в памяти моста. Каждый вызывающий знает только
 * часть: токен приходит из API_REQUEST, имя и устройство — из PERSIST_DEVICE_IDENTITY,
 * поэтому [update] сливает, а не перезаписывает.
 *
 * SharedPreferences лежат в том же приватном каталоге приложения, что и ключи переписок
 * (`conversation_keys_<user>.json`), с тем же запретом бэкапа (AndroidManifest).
 */
object PushSession {
    private const val PREFS = "zali_push_session"
    private const val KEY_API = "api_base_url"
    private const val KEY_TOKEN = "auth_token"
    private const val KEY_USER = "username"
    private const val KEY_DEVICE = "device_id"
    private const val KEY_REGISTERED = "registered_fingerprint"

    /**
     * Приложение на экране. Пуш в этом состоянии не показывается: сообщение уже пришло по
     * WebSocket, и веб сам решил, нужно ли уведомление. Тот же факт уходит серверу
     * (`client_presence`), чтобы он такой пуш и не слал.
     */
    @Volatile
    var appVisible: Boolean = false

    data class Session(
        val apiBaseUrl: String,
        val authToken: String,
        val username: String,
        val deviceId: String,
    )

    private val client = OkHttpClient.Builder()
        .callTimeout(15, TimeUnit.SECONDS)
        .build()

    private fun prefs(context: Context) =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun load(context: Context): Session? {
        val p = prefs(context)
        val api = p.getString(KEY_API, null).orEmpty()
        val token = p.getString(KEY_TOKEN, null).orEmpty()
        val user = p.getString(KEY_USER, null).orEmpty()
        val device = p.getString(KEY_DEVICE, null).orEmpty()
        if (api.isEmpty() || token.isEmpty() || user.isEmpty() || device.isEmpty()) return null
        return Session(api, token, user, device)
    }

    fun update(
        context: Context,
        apiBaseUrl: String? = null,
        authToken: String? = null,
        username: String? = null,
        deviceId: String? = null,
    ) {
        val editor = prefs(context).edit()
        apiBaseUrl?.trim()?.takeIf { it.isNotEmpty() }?.let { editor.putString(KEY_API, it) }
        authToken?.trim()?.takeIf { it.isNotEmpty() }?.let { editor.putString(KEY_TOKEN, it) }
        username?.trim()?.takeIf { it.isNotEmpty() }?.let { editor.putString(KEY_USER, it) }
        deviceId?.trim()?.takeIf { it.isNotEmpty() }?.let { editor.putString(KEY_DEVICE, it) }
        editor.apply()
        syncRegistration(context)
    }

    /** Выход из аккаунта: пуши ушедшего аккаунта больше не расшифровываются и не показываются. */
    fun clear(context: Context) {
        prefs(context).edit().clear().apply()
    }

    /**
     * Firebase инициализирован. Без `google-services.json` при сборке плагин
     * google-services не применяется, FirebaseApp не создаётся, и любой вызов
     * FirebaseMessaging бросил бы исключение — приложение просто живёт без пушей.
     */
    fun firebaseAvailable(context: Context): Boolean = try {
        FirebaseApp.getApps(context.applicationContext).isNotEmpty()
    } catch (e: Throwable) {
        false
    }

    fun syncRegistration(context: Context) {
        val appContext = context.applicationContext
        if (!firebaseAvailable(appContext) || load(appContext) == null) return
        try {
            FirebaseMessaging.getInstance().token.addOnSuccessListener { token ->
                if (!token.isNullOrBlank()) register(appContext, token)
            }
        } catch (e: Throwable) {
            // Нет Google Play Services и т. п. — живём без фоновых пушей.
        }
    }

    fun register(context: Context, fcmToken: String) {
        val appContext = context.applicationContext
        val session = load(appContext) ?: return
        val fingerprint = "${session.apiBaseUrl}|${session.username}|${session.deviceId}|$fcmToken"
        if (prefs(appContext).getString(KEY_REGISTERED, null) == fingerprint) return

        val body = JSONObject()
            .put("token", fcmToken)
            .put("deviceId", session.deviceId)
            .toString()
            .toRequestBody("application/json".toMediaTypeOrNull())
        val request = Request.Builder()
            .url("${session.apiBaseUrl}/api/push/fcm/register")
            .header("Authorization", "Bearer ${session.authToken}")
            .header("X-Zali-Device-ID", session.deviceId)
            .post(body)
            .build()
        client.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {}
            override fun onResponse(call: Call, response: Response) {
                response.use {
                    if (it.isSuccessful) {
                        prefs(appContext).edit().putString(KEY_REGISTERED, fingerprint).apply()
                    }
                }
            }
        })
    }
}
