package org.zalikus.messenger

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

/**
 * Уведомление о сообщении — одно на оба пути доставки: живой (веб → SHOW_NOTIFICATION в
 * NativeBridge) и фоновый (FCM → PushMessagingService).
 *
 * id уведомления выводится из id сообщения. Приложение, ушедшее в фон с ещё живым
 * WebSocket, получает сообщение дважды — по сокету и пушем, — и без общего id показало
 * бы два уведомления. С ним второе заменяет первое без повторного звука
 * (`setOnlyAlertOnce`), а пуш, пришедший к уже показанному, не показывается вовсе.
 */
object MessageNotifier {
    private const val CHANNEL_ID = "zali-message"
    // Тихий канал для режима «в игре»: без звука, вибрации и всплывающей плашки —
    // нужен только затем, чтобы лаунчер нарисовал кружок на значке.
    private const val QUIET_CHANNEL_ID = "zali-quiet"
    private const val QUIET_TAG = "zali-quiet"
    private const val NOTIFICATION_TAG = "zali-message"
    const val EXTRA_SENDER = "org.zalikus.messenger.extra.SENDER"
    const val EXTRA_SERVER_ID = "org.zalikus.messenger.extra.SERVER_ID"
    const val EXTRA_CHANNEL_ID = "org.zalikus.messenger.extra.CHANNEL_ID"

    fun hasPermission(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true
        return ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
    }

    fun canNotify(context: Context): Boolean =
        hasPermission(context) && NotificationManagerCompat.from(context).areNotificationsEnabled()

    private fun ensureChannel(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(CHANNEL_ID, "Сообщения", NotificationManager.IMPORTANCE_HIGH)
            .apply { description = "Новые сообщения Zali Messenger" }
        manager.createNotificationChannel(channel)
    }

    private fun ensureQuietChannel(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(QUIET_CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            QUIET_CHANNEL_ID, "Тихие (пока вы играете)", NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Сообщения, уведомления о которых отложены до конца игры"
            setSound(null, null)
            enableVibration(false)
            setShowBadge(true)
        }
        manager.createNotificationChannel(channel)
    }

    private fun quietId(sender: String): Int = "zali-quiet:${sender.lowercase()}".hashCode()

    /**
     * Режим «в игре» (game_focus.js): отложенные сообщения от [sender] — одно тихое
     * уведомление со счётчиком. Лаунчер рисует по нему кружок на значке; ни звука, ни
     * вибрации, ни всплытия поверх игры.
     */
    fun showQuiet(context: Context, sender: String, count: Int) {
        if (!canNotify(context)) return
        val appContext = context.applicationContext
        ensureQuietChannel(appContext)
        val id = quietId(sender)
        val intent = Intent(appContext, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra(EXTRA_SENDER, sender)
        }
        val pendingIntent = PendingIntent.getActivity(
            appContext, id, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notification = NotificationCompat.Builder(appContext, QUIET_CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_email)
            .setContentTitle(sender.ifEmpty { "Zali Messenger" })
            .setContentText("Новых сообщений: $count")
            .setNumber(count)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setSilent(true)
            .setOnlyAlertOnce(true)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .build()
        try {
            NotificationManagerCompat.from(appContext).notify(QUIET_TAG, id, notification)
        } catch (e: SecurityException) {
            // Разрешение отозвали между проверкой и показом.
        }
    }

    fun clearQuiet(context: Context, sender: String) {
        try {
            NotificationManagerCompat.from(context.applicationContext).cancel(QUIET_TAG, quietId(sender))
        } catch (e: SecurityException) {
        }
    }

    private fun notificationId(messageId: String): Int =
        if (messageId.isBlank()) java.util.UUID.randomUUID().hashCode() else "zali-msg:$messageId".hashCode()

    fun isShowing(context: Context, messageId: String): Boolean {
        if (messageId.isBlank()) return false
        val manager = context.getSystemService(NotificationManager::class.java) ?: return false
        val id = notificationId(messageId)
        return try {
            manager.activeNotifications.any { it.id == id && it.tag == NOTIFICATION_TAG }
        } catch (e: Exception) {
            false
        }
    }

    /** Текст, затем вложения, затем общее — как `notificationBodyFor` в вебе и Windows. */
    fun bodyFor(text: String, attachmentCount: Int): String {
        var trimmed = text.trim()
        // Карточка ZaliCoin несёт служебную ссылку последней строкой — в уведомлении ей не место.
        val lastBreak = trimmed.lastIndexOf('\n')
        if (lastBreak >= 0) {
            val last = trimmed.substring(lastBreak + 1).trim()
            if ((last.startsWith("[zc-gift:") || last.startsWith("[zc-tx:")) && last.endsWith("]")) {
                trimmed = trimmed.substring(0, lastBreak).trim()
            }
        }
        return when {
            trimmed.isNotEmpty() -> trimmed.take(180)
            attachmentCount == 1 -> "Вложение"
            attachmentCount > 1 -> "Вложения: $attachmentCount"
            else -> "Новое сообщение"
        }
    }

    fun show(
        context: Context,
        sender: String,
        text: String,
        attachmentCount: Int,
        serverId: String?,
        channelId: String?,
        messageId: String,
        // Режим «в игре» получателя (game_focus.js, server/src/focus.rs): показать, но
        // без звука. `alertAgain` — «Всё равно оповестить»: заменить уже стоящее
        // уведомление этого сообщения и зазвучать (иначе setOnlyAlertOnce промолчит).
        silent: Boolean = false,
        alertAgain: Boolean = false,
    ) {
        if (!canNotify(context)) return
        val appContext = context.applicationContext
        ensureChannel(appContext)

        val id = notificationId(messageId)
        val titleSender = sender.ifEmpty { "Zali Messenger" }
        val title = if (serverId == null && channelId == null) titleSender else "$titleSender в канале"
        // Нажатие ведёт в переписку уведомления (MainActivity.consumeNotificationIntent).
        val intent = Intent(appContext, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra(EXTRA_SENDER, sender)
            serverId?.let { putExtra(EXTRA_SERVER_ID, it) }
            channelId?.let { putExtra(EXTRA_CHANNEL_ID, it) }
        }
        val pendingIntent = PendingIntent.getActivity(
            appContext, id, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(appContext, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_email)
            .setContentTitle(title)
            .setContentText(bodyFor(text, attachmentCount))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setAutoCancel(true)
            .setOnlyAlertOnce(!alertAgain)
            .setSilent(silent)
            .setContentIntent(pendingIntent)
            .setGroup(serverId ?: "dm")
            .build()

        try {
            NotificationManagerCompat.from(appContext).notify(NOTIFICATION_TAG, id, notification)
        } catch (e: SecurityException) {
            // Разрешение отозвали между проверкой и показом.
        }
    }
}
