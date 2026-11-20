package org.zalikus.messenger

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * Идущий звонок (CALL_STATE из веба, `syncNativeCallState` в voice_ui.js).
 *
 * Без него звонок жил только пока активити видна. Живой журнал 2026-11-20 (Xiaomi,
 * Android 16): экран погас → через 7–12 с собеседник перестал получать пакеты, ICE
 * `failed`, восемь офферов перезапуска остались без ответа, звонок лежал 132 с — ровно
 * столько приложение было в фоне (`SmartPower … background->invisible(132825ms)`).
 * Камера отрезается ещё раньше — `CameraService: Access … restricted, isUidVisible 0`,
 * стоит открыться системному диалогу демонстрации экрана.
 *
 * Поэтому на весь звонок:
 * - сервис переднего плана типов `microphone` (+ `camera`, пока камера включена) —
 *   процесс не замораживается, камера и микрофон работают за экраном;
 * - Wi‑Fi lock LOW_LATENCY (API 29+, иначе HIGH_PERF) — без него Wi‑Fi в энергосбережении
 *   копит пакеты между маяками: RTT по ЛВС прыгал до 440 мс, джиттер видео 154 мс;
 * - частичный wake lock — процессор не засыпает при погасшем экране.
 *
 * Сервисы этих типов разрешено запускать только из видимого приложения: веб шлёт
 * CALL_STATE при начале звонка, когда пользователь в приложении. Отказ ОС — запись в
 * журнал, звонок идёт как раньше.
 */
class OngoingCallService : Service() {

    private var wifiLock: WifiManager.WifiLock? = null
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val camera = intent?.getBooleanExtra(EXTRA_CAMERA, false) ?: false
        val types = serviceTypes(this, camera)
        try {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(), types)
        } catch (e: Exception) {
            // ForegroundServiceStartNotAllowedException / SecurityException: приложение уже
            // в фоне или разрешение отозвано. Без переднего плана сервис бесполезен.
            Log.w(TAG, "startForeground refused types=$types: ${e.message}")
            if (types and ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA != 0) {
                // Камеру добавить не дали — удержать хотя бы микрофон.
                try {
                    ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(), serviceTypes(this, false))
                } catch (e2: Exception) {
                    stopSelf()
                    return START_NOT_STICKY
                }
            } else {
                stopSelf()
                return START_NOT_STICKY
            }
        }
        acquireLocks()
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        releaseLocks()
        super.onDestroy()
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // Приложение смахнули — звонка больше нет (вебвью умер вместе с задачей).
        stopSelf()
        super.onTaskRemoved(rootIntent)
    }

    private fun acquireLocks() {
        if (wifiLock == null) {
            val wifi = applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
            val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                WifiManager.WIFI_MODE_FULL_LOW_LATENCY
            } else {
                @Suppress("DEPRECATION")
                WifiManager.WIFI_MODE_FULL_HIGH_PERF
            }
            wifiLock = try {
                wifi?.createWifiLock(mode, "zali:call")?.apply { setReferenceCounted(false); acquire() }
            } catch (e: Exception) {
                Log.w(TAG, "wifi lock failed: ${e.message}"); null
            }
        }
        if (wakeLock == null) {
            val power = getSystemService(Context.POWER_SERVICE) as? PowerManager
            wakeLock = try {
                // Без таймаута: снимается вместе со звонком (CALL_STATE active=false,
                // смахивание задачи, onDestroy). Страховка — 4 ч.
                power?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "zali:call")?.apply {
                    setReferenceCounted(false); acquire(4 * 60 * 60 * 1000L)
                }
            } catch (e: Exception) {
                Log.w(TAG, "wake lock failed: ${e.message}"); null
            }
        }
    }

    private fun releaseLocks() {
        try { wifiLock?.takeIf { it.isHeld }?.release() } catch (_: Exception) {}
        try { wakeLock?.takeIf { it.isHeld }?.release() } catch (_: Exception) {}
        wifiLock = null
        wakeLock = null
    }

    private fun buildNotification(): android.app.Notification {
        val manager = getSystemService(NotificationManager::class.java)
        if (manager != null && manager.getNotificationChannel(CHANNEL_ID) == null) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Идущий звонок", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "Держит звонок, пока приложение свёрнуто или экран выключен"
                    setShowBadge(false)
                }
            )
        }
        val open = packageManager.getLaunchIntentForPackage(packageName)?.apply {
            addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
        }
        val content = open?.let {
            PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        }
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("Идёт звонок")
            .setContentText("Нажмите, чтобы вернуться")
            .setContentIntent(content)
            .setOngoing(true)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    companion object {
        private const val TAG = "ZaliCall"
        private const val CHANNEL_ID = "zali-ongoing-call-v1"
        private const val NOTIFICATION_ID = 0x5A1D
        private const val EXTRA_CAMERA = "camera"

        private fun granted(context: Context, permission: String) =
            ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

        /** Типы, на которые у приложения есть разрешения: тип без разрешения — SecurityException. */
        fun serviceTypes(context: Context, camera: Boolean): Int {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return 0
            var types = 0
            if (granted(context, Manifest.permission.RECORD_AUDIO)) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            if (camera && granted(context, Manifest.permission.CAMERA)) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
            return types
        }

        /** CALL_STATE из веба. Повторный вызов с тем же состоянием — дешёвое обновление типов. */
        fun sync(context: Context, active: Boolean, camera: Boolean) {
            val intent = Intent(context, OngoingCallService::class.java)
            if (!active) {
                context.stopService(intent)
                return
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && serviceTypes(context, camera) == 0) {
                Log.w(TAG, "no microphone/camera permission — call service not started")
                return
            }
            intent.putExtra(EXTRA_CAMERA, camera)
            try {
                ContextCompat.startForegroundService(context, intent)
            } catch (e: Exception) {
                Log.w(TAG, "call service start refused: ${e.message}")
            }
        }
    }
}
