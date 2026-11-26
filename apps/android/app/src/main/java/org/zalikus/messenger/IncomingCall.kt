package org.zalikus.messenger

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Color
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.text.SpannableString
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Входящий звонок, пока приложение не на экране: уведомление-звонок с зелёной «Принять»
 * и красной «Отклонить» (не полноэкранное — так решил пользователь).
 *
 * Пуш приходит с сервера (server/src/push.rs, `send_incoming_call_push`), снимается пушем
 * `call_end` (принят на другом устройстве, отклонён, пропущен) или через 60 с — столько же
 * звонок живёт на сервере (voice.rs).
 *
 * Почему через сервис переднего плана. Цветные кнопки рисует `CallStyle`, а Android 12+
 * принимает уведомление с этим стилем, только если оно принадлежит сервису переднего плана
 * или открывает полноэкранный экран; иначе `notify` бросает исключение. Полноэкранный
 * экран не нужен, поэтому — короткий сервис (`shortService`, без особых разрешений; пуш с
 * высоким приоритетом разрешает запустить его из фона). Заодно система не даёт смахнуть
 * звонящее уведомление и не душит звук. Не вышло запустить сервис — то же уведомление без
 * сервиса, кнопки окрашены цветом текста.
 */
object CallNotifier {
    private const val CHANNEL_ID = "zali-call-v1"
    private const val MISSED_CHANNEL_ID = "zali-missed-call-v1"
    const val NOTIFICATION_ID = 0x5A1C
    private const val MISSED_TTL_MS = 6L * 60 * 60 * 1000
    /** Столько же звонок живёт на сервере, прежде чем стать пропущенным. */
    const val RING_TIMEOUT_MS = 60_000L

    const val EXTRA_CALL_ACTION = "org.zalikus.messenger.extra.CALL_ACTION"
    const val EXTRA_CALL_ROOM = "org.zalikus.messenger.extra.CALL_ROOM"
    const val EXTRA_CALL_FROM = "org.zalikus.messenger.extra.CALL_FROM"
    const val EXTRA_CALL_TOKEN = "org.zalikus.messenger.extra.CALL_TOKEN"
    const val ACTION_DECLINE = "org.zalikus.messenger.action.DECLINE_CALL"
    const val EXTRA_CALL_SECRET = "org.zalikus.messenger.extra.CALL_SECRET"

    /**
     * Секрет установки в PendingIntent «Принять/Отклонить». MainActivity экспортирована
     * (лаунчер), и любое приложение без разрешений присылало ей EXTRA_CALL_ACTION=accept —
     * звонок принимался, микрофон включался без нажатия (аудит 2026-11-18). Intent внутри
     * чужого PendingIntent другим приложениям не виден, поэтому секрет знаем только мы.
     */
    fun callSecret(context: Context): String {
        val prefs = context.applicationContext.getSharedPreferences("zali_call_secret", Context.MODE_PRIVATE)
        prefs.getString("secret", null)?.takeIf { it.length >= 32 }?.let { return it }
        val bytes = ByteArray(16).also { java.security.SecureRandom().nextBytes(it) }
        val secret = bytes.joinToString("") { "%02x".format(it) }
        prefs.edit().putString("secret", secret).apply()
        return secret
    }

    fun isTrustedCallIntent(context: Context, intent: Intent): Boolean {
        val presented = intent.getStringExtra(EXTRA_CALL_SECRET) ?: return false
        return java.security.MessageDigest.isEqual(presented.toByteArray(), callSecret(context).toByteArray())
    }

    private val ANSWER_COLOR = Color.rgb(0x1E, 0x8E, 0x3E)
    private val DECLINE_COLOR = Color.rgb(0xD9, 0x30, 0x25)

    /** Комната звонка, который сейчас на экране: `call_end` чужой комнаты его не снимает. */
    @Volatile
    var activeRoomId: String? = null
        private set

    private fun ensureChannels(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL_ID) == null) {
            val ringtone = AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build()
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Входящие звонки", NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "Звонок, пока приложение закрыто или свёрнуто"
                    setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE), ringtone)
                    enableVibration(true)
                    vibrationPattern = longArrayOf(0, 800, 600, 800)
                    lockscreenVisibility = Notification.VISIBILITY_PUBLIC
                }
            )
        }
        if (manager.getNotificationChannel(MISSED_CHANNEL_ID) == null) {
            manager.createNotificationChannel(
                NotificationChannel(MISSED_CHANNEL_ID, "Пропущенные звонки", NotificationManager.IMPORTANCE_DEFAULT)
                    .apply { description = "Звонки, на которые не ответили" }
            )
        }
    }

    /** Вызывается из PushMessagingService — пуш с высоким приоритетом разрешает старт сервиса. */
    fun showIncoming(context: Context, roomId: String, from: String, declineToken: String) {
        val appContext = context.applicationContext
        ensureChannels(appContext)
        activeRoomId = roomId
        val intent = Intent(appContext, IncomingCallService::class.java).apply {
            putExtra(EXTRA_CALL_ROOM, roomId)
            putExtra(EXTRA_CALL_FROM, from)
            putExtra(EXTRA_CALL_TOKEN, declineToken)
        }
        try {
            ContextCompat.startForegroundService(appContext, intent)
        } catch (e: Exception) {
            // ForegroundServiceStartNotAllowedException и т. п. — звонок всё равно показать.
            postPlain(appContext, roomId, from, declineToken)
        }
    }

    /** Снять звонок. `roomId == null` — любой (приложение открыли, вышло время). */
    fun dismiss(context: Context, roomId: String?) {
        val active = activeRoomId
        if (roomId != null && active != null && roomId != active) return
        activeRoomId = null
        val appContext = context.applicationContext
        appContext.stopService(Intent(appContext, IncomingCallService::class.java))
        try {
            NotificationManagerCompat.from(appContext).cancel(NOTIFICATION_ID)
        } catch (e: SecurityException) {
        }
    }

    fun showMissed(context: Context, roomId: String, from: String) {
        val appContext = context.applicationContext
        if (!MessageNotifier.canNotify(appContext)) return
        ensureChannels(appContext)
        val id = "zali-missed:$roomId".hashCode()
        val notification = NotificationCompat.Builder(appContext, MISSED_CHANNEL_ID)
            .setSmallIcon(android.R.drawable.sym_call_missed)
            .setContentTitle("Пропущенный звонок")
            .setContentText(from.ifEmpty { "Zali Messenger" })
            .setCategory(NotificationCompat.CATEGORY_MISSED_CALL)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setAutoCancel(true)
            // Пропущенный звонок теряет смысл, когда чат с этим человеком открыли (запись о
            // звонке лежит в нём — MessageNotifier.clearConversation) или прошло несколько часов.
            .setTimeoutAfter(MISSED_TTL_MS)
            .addExtras(android.os.Bundle().apply {
                putString(MessageNotifier.EXTRA_CONVERSATION, MessageNotifier.conversationKey(from, null, null))
            })
            .setContentIntent(openIntent(appContext, id, from, action = null, roomId = roomId))
            .build()
        try {
            NotificationManagerCompat.from(appContext).notify(id, notification)
        } catch (e: SecurityException) {
        }
    }

    private fun openIntent(context: Context, requestCode: Int, from: String, action: String?, roomId: String): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra(MessageNotifier.EXTRA_SENDER, from)
            putExtra(EXTRA_CALL_ROOM, roomId)
            putExtra(EXTRA_CALL_FROM, from)
            if (action != null) putExtra(EXTRA_CALL_ACTION, action)
            putExtra(EXTRA_CALL_SECRET, callSecret(context))
        }
        return PendingIntent.getActivity(
            context, requestCode, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    private fun declineIntent(context: Context, roomId: String, token: String): PendingIntent {
        val intent = Intent(context, CallActionReceiver::class.java).apply {
            action = ACTION_DECLINE
            putExtra(EXTRA_CALL_ROOM, roomId)
            putExtra(EXTRA_CALL_TOKEN, token)
        }
        return PendingIntent.getBroadcast(
            context, roomId.hashCode() + 2, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    private fun colored(text: String, color: Int): CharSequence =
        SpannableString(text).apply { setSpan(ForegroundColorSpan(color), 0, length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE) }

    private fun baseBuilder(context: Context, roomId: String, from: String): NotificationCompat.Builder {
        val caller = from.ifEmpty { "Zali Messenger" }
        return NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.sym_call_incoming)
            .setContentTitle(caller)
            .setContentText("Входящий звонок")
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setAutoCancel(false)
            .setTimeoutAfter(RING_TIMEOUT_MS)
            // Нажатие на само уведомление — открыть приложение, там звонок со своими кнопками.
            .setContentIntent(openIntent(context, roomId.hashCode(), from, action = null, roomId = roomId))
    }

    /** CallStyle: зелёная «Принять», красная «Отклонить» рисует система. Только для сервиса. */
    fun buildCallStyle(context: Context, roomId: String, from: String, token: String): Notification {
        val person = Person.Builder().setName(from.ifEmpty { "Zali Messenger" }).setImportant(true).build()
        val answer = openIntent(context, roomId.hashCode() + 1, from, action = "accept", roomId = roomId)
        val notification = baseBuilder(context, roomId, from)
            .setStyle(NotificationCompat.CallStyle.forIncomingCall(person, declineIntent(context, roomId, token), answer))
            .build()
        // Рингтон канала повторяется, пока звонок висит, а не звучит один раз.
        notification.flags = notification.flags or Notification.FLAG_INSISTENT
        return notification
    }

    /** То же без CallStyle — когда сервис не запустился. Цвет — у текста кнопок. */
    fun buildPlain(context: Context, roomId: String, from: String, token: String): Notification {
        val answer = openIntent(context, roomId.hashCode() + 1, from, action = "accept", roomId = roomId)
        val notification = baseBuilder(context, roomId, from)
            .addAction(0, colored("Отклонить", DECLINE_COLOR), declineIntent(context, roomId, token))
            .addAction(0, colored("Принять", ANSWER_COLOR), answer)
            .build()
        notification.flags = notification.flags or Notification.FLAG_INSISTENT
        return notification
    }

    fun postPlain(context: Context, roomId: String, from: String, token: String) {
        if (!MessageNotifier.canNotify(context)) return
        try {
            NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, buildPlain(context, roomId, from, token))
        } catch (e: SecurityException) {
        }
    }
}

/**
 * Держит уведомление-звонок как уведомление сервиса переднего плана — см. CallNotifier.
 * Живёт не дольше звонка: «Принять», «Отклонить», пуш `call_end`, открытое приложение
 * или 60 с.
 */
class IncomingCallService : Service() {
    private val handler = Handler(Looper.getMainLooper())
    private val timeout = Runnable { CallNotifier.dismiss(this, null) }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val roomId = intent?.getStringExtra(CallNotifier.EXTRA_CALL_ROOM).orEmpty()
        val from = intent?.getStringExtra(CallNotifier.EXTRA_CALL_FROM).orEmpty()
        val token = intent?.getStringExtra(CallNotifier.EXTRA_CALL_TOKEN).orEmpty()
        // startForegroundService обязывает вызвать startForeground — даже если звонок пустой.
        val notification = try {
            CallNotifier.buildCallStyle(this, roomId, from, token)
        } catch (e: Exception) {
            CallNotifier.buildPlain(this, roomId, from, token)
        }
        try {
            ServiceCompat.startForeground(
                this,
                CallNotifier.NOTIFICATION_ID,
                notification,
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_SHORT_SERVICE
                } else {
                    0
                },
            )
        } catch (e: Exception) {
            CallNotifier.postPlain(this, roomId, from, token)
            stopSelf()
            return START_NOT_STICKY
        }
        if (roomId.isEmpty()) {
            CallNotifier.dismiss(this, null)
            return START_NOT_STICKY
        }
        handler.removeCallbacks(timeout)
        handler.postDelayed(timeout, CallNotifier.RING_TIMEOUT_MS)
        return START_NOT_STICKY
    }

    /** shortService: система просит закончиться (3 мин) — звонок к этому времени давно снят. */
    override fun onTimeout(startId: Int) {
        CallNotifier.dismiss(this, null)
    }

    override fun onDestroy() {
        handler.removeCallbacks(timeout)
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }
}

/**
 * «Отклонить» в уведомлении-звонке. Отказ уходит без вебвью и без сессии — секретом
 * звонка из пуша (`POST /api/voice/call/decline`, server/src/voice.rs).
 */
class CallActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != CallNotifier.ACTION_DECLINE) return
        val roomId = intent.getStringExtra(CallNotifier.EXTRA_CALL_ROOM).orEmpty()
        val token = intent.getStringExtra(CallNotifier.EXTRA_CALL_TOKEN).orEmpty()
        CallNotifier.dismiss(context, roomId)
        if (roomId.isEmpty() || token.isEmpty()) return
        val session = PushSession.load(context.applicationContext) ?: return
        val pending = goAsync()
        Thread {
            try {
                val body = JSONObject().put("roomId", roomId).put("token", token).toString()
                val request = Request.Builder()
                    .url("${session.apiBaseUrl.trimEnd('/')}/api/voice/call/decline")
                    .post(body.toRequestBody("application/json".toMediaType()))
                    .build()
                client.newCall(request).execute().close()
            } catch (e: Exception) {
                // Нет сети — звонок станет пропущенным у звонящего через минуту.
            } finally {
                pending.finish()
            }
        }.start()
    }

    companion object {
        private val client = OkHttpClient.Builder().callTimeout(8, TimeUnit.SECONDS).build()
    }
}
