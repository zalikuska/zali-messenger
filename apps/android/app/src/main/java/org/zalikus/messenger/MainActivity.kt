package org.zalikus.messenger

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.net.Uri
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.WebViewCompat
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.union
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import androidx.compose.ui.viewinterop.AndroidView

private const val ASSET_BASE_URL = "file:///android_asset/web/"

private const val APPEARANCE_PREFS = "zali_appearance"
private const val DARK_BACKGROUND = 0xFF0B0D12.toInt()

/**
 * Thin native Android shell. Wraps the shared web UI (`Web/`, bundled by
 * `bundle_web.py`) in a WebView. The bottom navigation is the web dock itself
 * (`.mobile-dock`): the native Compose bar was removed 2026-11-15 — it duplicated
 * the dock (gestures, theme, sections) and drifted from it.
 */
class MainActivity : ComponentActivity() {

    private var bridge: NativeBridge? = null

    /** Светлота темы веба — запоминается, чтобы следующий запуск сразу был в ней. */
    private var uiLight by mutableStateOf(false)
    private var uiBackground by mutableStateOf(DARK_BACKGROUND)
    private var appWebView: WebView? = null

    private fun applySystemBars(light: Boolean) {
        val transparent = android.graphics.Color.TRANSPARENT
        // light(): тёмные значки на светлом фоне; dark(): светлые на тёмном.
        val style = if (light) SystemBarStyle.light(transparent, transparent) else SystemBarStyle.dark(transparent)
        enableEdgeToEdge(statusBarStyle = style, navigationBarStyle = style)
    }

    /** Веб держит свободный поворот: медиа на весь экран (SCREEN_ROTATION, media_viewer.js). */
    private var webRotationFree = false

    /** Видео из ленты на весь экран — `<video>` в полноэкранном режиме (onShowCustomView). */
    private var customView: View? = null
    private var customViewCallback: WebChromeClient.CustomViewCallback? = null

    /**
     * Интерфейс телефона — только портрет. Альбомный разрешён, пока на экране медиа
     * на весь экран: видео звонка, фото, видео из ленты. FULL_USER уважает системную
     * блокировку поворота. Планшет (sw ≥ 600dp) не ограничиваем — там раскладка
     * компьютера, и портрет-only был бы неудобен.
     */
    private fun applyOrientation() {
        val media = webRotationFree || customView != null
        requestedOrientation = when {
            resources.configuration.smallestScreenWidthDp >= 600 -> ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
            media -> ActivityInfo.SCREEN_ORIENTATION_FULL_USER
            else -> ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
        }
        // Медиа на весь экран — без строки состояния и панели навигации (свайп от края
        // показывает их на время).
        val controller = WindowCompat.getInsetsController(window, window.decorView)
        if (media) {
            controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            controller.hide(WindowInsetsCompat.Type.systemBars())
        } else {
            controller.show(WindowInsetsCompat.Type.systemBars())
        }
    }

    private fun setWebRotationFree(free: Boolean) {
        if (webRotationFree == free) return
        webRotationFree = free
        applyOrientation()
    }

    /** Выход из полноэкранного `<video>`; true — он был открыт. */
    private fun exitCustomView(): Boolean {
        val view = customView ?: return false
        val callback = customViewCallback
        customView = null
        customViewCallback = null
        (view.parent as? ViewGroup)?.removeView(view)
        applyOrientation()
        callback?.onCustomViewHidden()
        return true
    }

    private fun applyAppearance(light: Boolean, background: Int) {
        runOnUiThread {
            if (uiLight != light) applySystemBars(light)
            uiLight = light
            uiBackground = background
            appWebView?.setBackgroundColor(background)
            getSharedPreferences(APPEARANCE_PREFS, MODE_PRIVATE).edit()
                .putBoolean("light", light)
                .putInt("background", background)
                .apply()
        }
    }

    /** Нажатие на уведомление, ждущее моста (MessageNotifier кладёт переписку в extras). */
    private var pendingNotificationIntent: Intent? = null

    /** index.html загружен (onPageFinished) — до этого переход из уведомления ждёт. */
    private var webPageReady = false

    // Latest safe-area insets in dp, pushed into the web UI as CSS custom
    // properties (see applySafeAreaInsets). Kept as an Activity field because
    // they also have to be re-applied after every page load — a fresh document
    // starts with no inline style on <html>.
    private var safeTopDp = 0f
    private var safeBottomDp = 0f

    /**
     * Запрос камеры/микрофона из вебвью, ожидающий ответа ОС.
     *
     * `PermissionRequest.grant()` не выдаёт приложению того, чего у приложения нет:
     * `RECORD_AUDIO` и `CAMERA` — dangerous-разрешения, их нужно просить в рантайме
     * (minSdk 26, то есть на всех поддерживаемых версиях). В манифесте они были
     * объявлены с самого начала, а вот запрашивать их не запрашивал никто — в коде
     * стоял только `POST_NOTIFICATIONS`. Из-за этого `getUserMedia()` в вебвью падал,
     * и голосовой звонок на Android не мог начаться в принципе: сигналинг проходил,
     * микрофон — нет.
     */
    private var pendingMediaRequest: PermissionRequest? = null

    private val mediaPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { _ ->
        val request = pendingMediaRequest
        pendingMediaRequest = null
        if (request == null) return@registerForActivityResult
        // Отвечаем ровно тем, что ОС действительно дала: пользователь мог разрешить
        // микрофон и отказать камере, и тогда звонок обязан состояться без видео,
        // а не провалиться целиком.
        val granted = request.resources.filter {
            (it == PermissionRequest.RESOURCE_AUDIO_CAPTURE || it == PermissionRequest.RESOURCE_VIDEO_CAPTURE) &&
                osPermissionGranted(it)
        }.toTypedArray()
        if (granted.isEmpty()) request.deny() else request.grant(granted)
    }

    /** Есть ли у самого приложения OS-разрешение, стоящее за ресурсом вебвью. */
    private fun osPermissionGranted(resource: String): Boolean {
        val permission = when (resource) {
            PermissionRequest.RESOURCE_AUDIO_CAPTURE -> android.Manifest.permission.RECORD_AUDIO
            PermissionRequest.RESOURCE_VIDEO_CAPTURE -> android.Manifest.permission.CAMERA
            else -> return false
        }
        return ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED
    }

    private fun osPermissionFor(resource: String): String? = when (resource) {
        PermissionRequest.RESOURCE_AUDIO_CAPTURE -> android.Manifest.permission.RECORD_AUDIO
        PermissionRequest.RESOURCE_VIDEO_CAPTURE -> android.Manifest.permission.CAMERA
        else -> null
    }

    // START_SCREEN_CAPTURE (NativeBridge.kt) needs the system consent dialog
    // launched via ActivityResultContracts — must be registered as an Activity
    // property before onStart, not lazily inside the WebView factory lambda.
    private var pendingScreenCaptureRequestId: String? = null
    private val screenCaptureLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val requestId = pendingScreenCaptureRequestId
        pendingScreenCaptureRequestId = null
        if (requestId == null) return@registerForActivityResult
        val data = result.data
        if (result.resultCode == RESULT_OK && data != null) {
            ScreenCaptureService.start(this, result.resultCode, data, requestId)
        } else {
            bridge?.onScreenCaptureDenied(requestId)
        }
    }

    /**
     * `<input type="file">` в вебвью. Android WebView, в отличие от WKWebView и
     * WebView2, сам файловый диалог не открывает: без `onShowFileChooser`
     * `input.click()` не делает ничего — ни диалога, ни `change`, ни ошибки. Из-за
     * этого на Android нельзя было поставить аватар и баннер сервера, аватар
     * профиля и прикрепить вложение: кнопка «Загрузить» просто молчала.
     *
     * Колбэк обязан получить ответ ВСЕГДА, в том числе `null` при отмене: пока он
     * не закрыт, вебвью больше не откроет ни одного выбора файла до перезапуска.
     */
    private var pendingFileChooser: ValueCallback<Array<Uri>>? = null
    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val callback = pendingFileChooser
        pendingFileChooser = null
        callback?.onReceiveValue(pickedFileUris(result.resultCode, result.data))
    }

    // Галерея внутри приложения (GALLERY_* в NativeBridge.kt, MediaGallery.kt):
    // окно разрешения на фото, камера и настройки приложения — только через Activity.
    private var pendingGalleryAccessId: String? = null
    private val galleryPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) {
        val requestId = pendingGalleryAccessId ?: return@registerForActivityResult
        pendingGalleryAccessId = null
        bridge?.emitGalleryList(requestId, 240, askedBefore = true)
    }

    private var pendingCapture: Pair<String, String>? = null // requestId → имя файла
    private val cameraLauncher = registerForActivityResult(
        ActivityResultContracts.TakePicture()
    ) { saved ->
        val (requestId, name) = pendingCapture ?: return@registerForActivityResult
        pendingCapture = null
        bridge?.onGalleryCapture(requestId, name, saved)
    }

    // Камера объявлена в манифесте (звонки), а при объявленном и не выданном CAMERA
    // ACTION_IMAGE_CAPTURE падает SecurityException — сначала спрашиваем.
    private var pendingCameraPermissionId: String? = null
    private val cameraPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        val requestId = pendingCameraPermissionId ?: return@registerForActivityResult
        pendingCameraPermissionId = null
        if (granted) launchCamera(requestId) else bridge?.onGalleryCapture(requestId, null, false)
    }

    private fun captureGalleryPhoto(requestId: String) {
        val granted = ContextCompat.checkSelfPermission(this, android.Manifest.permission.CAMERA) ==
            PackageManager.PERMISSION_GRANTED
        if (granted) {
            launchCamera(requestId)
        } else {
            pendingCameraPermissionId = requestId
            cameraPermissionLauncher.launch(android.Manifest.permission.CAMERA)
        }
    }

    private fun launchCamera(requestId: String) {
        val gallery = bridge?.mediaGallery ?: return
        val (name, uri) = gallery.newCaptureTarget()
        pendingCapture = requestId to name
        try {
            cameraLauncher.launch(uri)
        } catch (e: ActivityNotFoundException) {
            pendingCapture = null
            bridge?.onGalleryCapture(requestId, name, false)
        }
    }

    private fun openAppSettings() {
        try {
            startActivity(
                Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                    .setData(Uri.fromParts("package", packageName, null))
            )
        } catch (e: ActivityNotFoundException) {
            // Настроек нет — ничего не делаем.
        }
    }

    /**
     * Фото и видео — системный Photo Picker (сетка галереи и альбомы, без доступа к
     * хранилищу), а не файловый менеджер `ACTION_GET_CONTENT`: тот открывал «Файлы»
     * с папками, и найти снимок из камеры было делом нескольких экранов. Где пикера
     * нет (старый Android без модуля из Google Play), androidx сам откатывается на
     * `ACTION_OPEN_DOCUMENT` с тем же фильтром. Ответ — тот же колбэк вебвью.
     */
    private val singleMediaLauncher = registerForActivityResult(
        ActivityResultContracts.PickVisualMedia()
    ) { uri ->
        val callback = pendingFileChooser
        pendingFileChooser = null
        callback?.onReceiveValue(uri?.let { arrayOf(it) })
    }

    private val multipleMediaLauncher = registerForActivityResult(
        ActivityResultContracts.PickMultipleVisualMedia()
    ) { uris ->
        val callback = pendingFileChooser
        pendingFileChooser = null
        callback?.onReceiveValue(uris.takeIf { it.isNotEmpty() }?.toTypedArray())
    }

    /**
     * Какие медиа показывать в Photo Picker, или null — поле не про фото/видео
     * (`.zali`, `.zip`) и ему нужен файловый менеджер. Пикер берём, когда поле явно
     * принимает картинки или видео целым классом (`image/` или `video/` со звёздочкой:
     * `"image/" + "*"` — буквально здесь не пишется, Kotlin счёл бы это началом
     * вложенного комментария). В пикере нет файлов, не являющихся медиа, поэтому
     * стикеры `.tgs` веб выбирает отдельным полем без картинок в `accept`
     * (`#anyFileInput`, плитка «Файл» в листе галереи) — оно попадает
     * сюда с null и открывает файловый менеджер.
     */
    private fun photoPickerMediaType(
        params: WebChromeClient.FileChooserParams,
    ): ActivityResultContracts.PickVisualMedia.VisualMediaType? {
        val accept = (params.acceptTypes ?: emptyArray())
            .flatMap { it.split(',') }
            .map { it.trim().lowercase() }
            .filter { it.isNotEmpty() }
        val images = accept.any { it == "image/*" }
        val videos = accept.any { it == "video/*" }
        return when {
            images && videos -> ActivityResultContracts.PickVisualMedia.ImageAndVideo
            images -> ActivityResultContracts.PickVisualMedia.ImageOnly
            videos -> ActivityResultContracts.PickVisualMedia.VideoOnly
            else -> null
        }
    }

    private fun launchFileChooser(params: WebChromeClient.FileChooserParams) {
        val mediaType = photoPickerMediaType(params)
        if (mediaType == null) {
            fileChooserLauncher.launch(fileChooserIntent(params))
            return
        }
        val request = PickVisualMediaRequest(mediaType)
        if (params.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) {
            multipleMediaLauncher.launch(request)
        } else {
            singleMediaLauncher.launch(request)
        }
    }

    private fun pickedFileUris(resultCode: Int, data: Intent?): Array<Uri>? {
        if (resultCode != RESULT_OK || data == null) return null
        // parseResult видит только data.data, а множественный выбор приходит в clipData.
        val clip = data.clipData
        if (clip != null && clip.itemCount > 0) {
            return (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri }
                .toTypedArray()
                .takeIf { it.isNotEmpty() }
        }
        return WebChromeClient.FileChooserParams.parseResult(resultCode, data)
    }

    /**
     * Свой intent вместо `FileChooserParams.createIntent()`: тот берёт из `accept`
     * только первый тип, и поле вложений (картинки, видео и `.tgs`) пускало бы
     * одни картинки. Расширение (`.tgs`) MIME-типом не является, поэтому при нём
     * фильтр не ставится вовсе — иначе стикеры в выборе не показались бы.
     */
    private fun fileChooserIntent(params: WebChromeClient.FileChooserParams): Intent {
        val accept = (params.acceptTypes ?: emptyArray())
            .flatMap { it.split(',') }
            .map { it.trim() }
            .filter { it.isNotEmpty() }
        val mimeTypes = accept.filter { it.contains('/') }
        val intent = Intent(Intent.ACTION_GET_CONTENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType("*/*")
        if (mimeTypes.isNotEmpty() && mimeTypes.size == accept.size) {
            if (mimeTypes.size == 1) {
                intent.type = mimeTypes[0]
            } else {
                intent.putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes.toTypedArray())
            }
        }
        if (params.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) {
            intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        }
        return intent
    }

    /**
     * Asks the compositor for the fastest display mode this panel supports.
     *
     * A 90/120/144 Hz Android panel does not give an app high refresh just for
     * having one: the OEM's "smart/adaptive refresh" policy keeps ordinary
     * (non-game, non-requesting) windows at 60 Hz to save battery, and a WebView
     * inherits whatever the window gets. Nothing here asks for it, so the web UI
     * was pinned to 60 fps on every high-refresh device regardless of how cheap
     * its frames were.
     *
     * Sets both knobs on purpose: [preferredDisplayModeId] is the precise one but
     * is only honoured from API 23 and only for modes at the *current* resolution
     * (picking one with a different width/height would force a mode switch and
     * visibly resize the app — hence the resolution filter), while
     * [preferredRefreshRate] is the softer hint some ROMs respect when the mode id
     * is ignored. Both are pacing hints only: no pixel changes, and if the system
     * declines, behaviour is exactly what it is today.
     */
    private fun requestHighestRefreshRate() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
        val display = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) display else windowManager.defaultDisplay
        val current = display?.mode ?: return
        val best = display.supportedModes
            ?.filter { it.physicalWidth == current.physicalWidth && it.physicalHeight == current.physicalHeight }
            ?.maxByOrNull { it.refreshRate }
            ?: return
        if (best.refreshRate <= current.refreshRate + 0.1f) return
        window.attributes = window.attributes.apply {
            preferredDisplayModeId = best.modeId
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                preferredRefreshRate = best.refreshRate
            }
        }
    }

    /**
     * The one origin allowed to occupy this WebView — the bundled UI loaded from
     * `file:///android_asset/web/`. Kept deliberately narrower than "any file://
     * URL": `settings.allowFileAccess` is on (the asset load needs it), so a
     * plain `file://` check would still let a `file:///sdcard/...` document into
     * the frame that owns the `ZaliAndroidBridge` interface.
     */
    private fun isBundledOrigin(url: String?): Boolean {
        val value = url?.trim().orEmpty()
        if (value.isEmpty()) return false
        if (value == "about:blank") return true
        return value.startsWith(ASSET_BASE_URL, ignoreCase = true)
    }

    /**
     * Permission-request variant of [isBundledOrigin]. WebView reports the origin
     * of a `file://` document as the bare scheme (`file://`), with no path, so the
     * exact-prefix check above can never match one — using it here would deny the
     * bundled UI its own microphone. The frame is guaranteed to hold the bundled
     * document anyway (`shouldOverrideUrlLoading` never lets anything else in);
     * this stays as a second, independent gate.
     */
    private fun isBundledPermissionOrigin(origin: String?): Boolean {
        val value = origin?.trim().orEmpty()
        if (isBundledOrigin(value)) return true
        return value.startsWith("file://", ignoreCase = true)
    }

    /** Hands a link the app itself must not open to the system browser/dialer/mail app. */
    private fun openExternally(url: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, url).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: ActivityNotFoundException) {
            // No handler installed for the scheme — dropping the tap is the
            // correct outcome, and is still strictly better than the previous
            // behaviour of loading it inside the bridge-bearing WebView.
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Значки статус-бара и навигации — по теме приложения, а не системы: тёмная
        // тема — светлые значки, светлая — тёмные (иначе часы и батарея сливаются с
        // фоном). Тема из прошлого запуска, потом её уточняет SET_APPEARANCE из веба.
        getSharedPreferences(APPEARANCE_PREFS, MODE_PRIVATE).let { prefs ->
            uiLight = prefs.getBoolean("light", false)
            uiBackground = prefs.getInt("background", DARK_BACKGROUND)
        }
        applySystemBars(uiLight)
        applyOrientation()
        pendingNotificationIntent = intent
        // Сессия, сохранённая на прошлом запуске, регистрирует FCM-токен и без нового входа.
        PushSession.syncRegistration(this)
        requestHighestRefreshRate()

        // Lets `chrome://inspect` on a desktop Chrome attach to this WebView over
        // adb — needed here because some vendor ROMs (confirmed on this Vivo
        // build) heavily restrict logcat, so JS console.error output never shows
        // up there at all. Debug-only; BuildConfig.DEBUG is false in release.
        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true)
        }

        setContent {
            var webView by remember { mutableStateOf<WebView?>(null) }

            // System bars ∪ display cutout: the notch/front camera and the
            // status bar at the top, the gesture pill or 3-button navigation bar
            // at the bottom. The web UI lays its app-bars and message input out
            // against these (var(--m-safe-top/bottom) in style.css).
            val safeInsets = WindowInsets.systemBars.union(WindowInsets.displayCutout).asPaddingValues()
            val insetTop = safeInsets.calculateTopPadding()
            // Клавиатура. Приложение edge-to-edge (targetSdk 35), и `adjustResize` окно
            // больше не ресайзит: поле ввода уходило ПОД клавиатуру, а `visualViewport`
            // не менялся (`--kbd-inset` оставался 0). Поэтому вебвью сжимается по IME
            // сам (`imePadding()` ниже), и `.input-area { bottom: 0 }` садится над ней.
            //
            // IME-инсет считается от нижнего края экрана и включает полосу навигации, а
            // нижний отступ веба (`--m-safe-bottom`) резервирует именно её. Над клавиатурой
            // он был бы пустым зазором под полем ввода — вычитаем: остаётся только то, что
            // клавиатура ещё не закрыла (непрерывно по ходу анимации).
            val imeBottom = WindowInsets.ime.asPaddingValues().calculateBottomPadding()
            val insetBottom = (safeInsets.calculateBottomPadding().value - imeBottom.value)
                .coerceAtLeast(0f).dp
            LaunchedEffect(insetTop, insetBottom, webView) {
                safeTopDp = insetTop.value
                safeBottomDp = insetBottom.value
                webView?.let { applySafeAreaInsets(it) }
            }

            // Системное «назад» (кнопка или жест). Обработчика не было вовсе, и
            // «назад» из открытого чата, меню сообщения или окна перевода сразу
            // закрывало Activity. Теперь оболочка спрашивает веб: тот закрывает
            // верхний слой (окно → вложенный экран → чат → список) и отвечает
            // true; на false — со списка диалогов или экрана входа — приложение
            // уходит в фон, а не завершается: сокет и идущий звонок остаются живы.
            // Клавиатуру система убирает сама, до этого обработчика.
            BackHandler(enabled = webView != null) {
                val wv = webView
                if (exitCustomView()) {
                    // «Назад» из видео на весь экран — только выход из него.
                } else if (wv == null) {
                    moveTaskToBack(true)
                } else {
                    wv.evaluateJavascript(
                        "(function(){try{return !!(window.__zaliHandleBack&&window.__zaliHandleBack());}" +
                            "catch(e){return false;}})()"
                    ) { handled ->
                        if (handled != "true") moveTaskToBack(true)
                    }
                }
            }

            Box(Modifier.fillMaxSize().background(Color(uiBackground))) {
                AndroidView(
                    modifier = Modifier.fillMaxSize().imePadding(),
                    factory = { ctx ->
                        val wv = WebView(ctx)
                        // MUST be set explicitly, and MUST be MATCH_PARENT.
                        //
                        // Without it the view keeps the default WRAP_CONTENT
                        // LayoutParams, so Compose's AndroidViewHolder measures it
                        // with an AT_MOST/UNSPECIFIED height spec instead of EXACTLY.
                        // Chromium then never receives a *definite* viewport height,
                        // and every vertical viewport unit collapses to zero —
                        // measured live on a V2036 (Android 13) via the DevTools
                        // protocol: 100vh/100dvh/100svh/100lvh all resolved to 0px
                        // while 100vw was correct (392.7px) and window.innerHeight
                        // still reported the true 875px.
                        //
                        // The shared web UI is built on those units: `.app` is
                        // `height: 100vh` (web/style.css), so the whole grid
                        // collapsed to 0 and #viewChat/#viewSettings/#viewHub — which
                        // are `position: absolute; inset: 0` inside it — rendered
                        // 40px tall, i.e. a black screen. The chat/server list kept
                        // working only because `.sidebar` is `position: fixed` with
                        // explicit top/bottom, which resolves against the real
                        // viewport rather than vh. Device-independent: it broke every
                        // Android device, unlike the separate first-paint compositor
                        // quirk worked around in onPageFinished below.
                        wv.layoutParams = android.view.ViewGroup.LayoutParams(
                            android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                            android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                        )
                        val nativeBridge = NativeBridge(ctx, wv)
                        bridge = nativeBridge
                        nativeBridge.setAppVisible(PushSession.appVisible)
                        webView = wv
                        appWebView = wv
                        nativeBridge.requestScreenCapturePermission = { requestId ->
                            pendingScreenCaptureRequestId = requestId
                            val manager = getSystemService(MediaProjectionManager::class.java)
                            screenCaptureLauncher.launch(manager.createScreenCaptureIntent())
                        }
                        nativeBridge.requestGalleryAccess = { requestId, permissions ->
                            pendingGalleryAccessId = requestId
                            galleryPermissionLauncher.launch(permissions)
                        }
                        nativeBridge.captureGalleryPhoto = { requestId -> captureGalleryPhoto(requestId) }
                        nativeBridge.openAppSettings = { openAppSettings() }
                        nativeBridge.applyAppearance = { light, background -> applyAppearance(light, background) }
                        nativeBridge.setScreenRotationFree = { free -> setWebRotationFree(free) }
                        wv.apply {
                            settings.javaScriptEnabled = true
                            settings.domStorageEnabled = true
                            settings.databaseEnabled = true
                            settings.mediaPlaybackRequiresUserGesture = false
                            settings.allowFileAccess = true
                            setBackgroundColor(uiBackground)

                            addJavascriptInterface(nativeBridge, "ZaliAndroidBridge")

                            // Inject before the page's own scripts run (document-start),
                            // same guarantee as iOS's WKUserScript(.atDocumentStart) — sets
                            // window.__ZALI_NATIVE_CAPS__ and re-adopts a persisted device
                            // identity before bootstrap.js reads either. Older WebView
                            // versions (no addDocumentStartJavaScript support) fall back to
                            // onPageStarted, which isn't guaranteed pre-script but is close.
                            if (NativeBridge.documentStartScriptSupported) {
                                WebViewCompat.addDocumentStartJavaScript(
                                    this, nativeBridge.documentStartScript(), setOf("*")
                                )
                            }

                            webChromeClient = object : WebChromeClient() {
                                // Grant camera/mic to the local bundled origin for calls —
                                // and to nothing else. `request.grant(request.resources)`
                                // granted whatever was asked for, by whatever document
                                // happened to be in a frame, which is the same mistake the
                                // macOS/iOS shells explicitly avoid in
                                // `requestMediaCapturePermissionFor` (main frame + known
                                // origin only). Resources are allowlisted too, so a future
                                // WebView resource id (protected media, MIDI sysex) is not
                                // granted just because it did not exist when this was
                                // written.
                                override fun onPermissionRequest(request: PermissionRequest) {
                                    if (!isBundledPermissionOrigin(request.origin?.toString())) {
                                        request.deny()
                                        return
                                    }
                                    val allowed = request.resources.filter {
                                        it == PermissionRequest.RESOURCE_AUDIO_CAPTURE ||
                                            it == PermissionRequest.RESOURCE_VIDEO_CAPTURE
                                    }
                                    if (allowed.isEmpty()) {
                                        request.deny()
                                        return
                                    }
                                    // Второй, независимый от вебвью барьер: у САМОГО приложения
                                    // должно быть OS-разрешение, иначе grant() ничего не значит и
                                    // getUserMedia() всё равно упадёт. Спрашиваем ровно то, чего
                                    // не хватает, и отвечаем вебвью уже после ответа пользователя.
                                    val missing = allowed.mapNotNull { resource ->
                                        osPermissionFor(resource)?.takeIf { !osPermissionGranted(resource) }
                                    }.distinct()
                                    if (missing.isEmpty()) {
                                        request.grant(allowed.toTypedArray())
                                        return
                                    }
                                    // Один запрос за раз: два одновременно открытых системных
                                    // диалога Android не покажет, а первый PermissionRequest
                                    // остался бы без ответа и вебвью ждал бы его вечно.
                                    pendingMediaRequest?.deny()
                                    pendingMediaRequest = request
                                    mediaPermissionLauncher.launch(missing.toTypedArray())
                                }

                                // Кнопка «на весь экран» в панели видео из ленты. Без этих двух
                                // методов вебвью её показывает, но нажатие ничего не делает.
                                override fun onShowCustomView(view: View, callback: CustomViewCallback) {
                                    if (customView != null) {
                                        callback.onCustomViewHidden()
                                        return
                                    }
                                    customView = view
                                    customViewCallback = callback
                                    view.setBackgroundColor(android.graphics.Color.BLACK)
                                    (window.decorView as ViewGroup).addView(
                                        view,
                                        ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
                                    )
                                    applyOrientation()
                                }

                                // Пока у <video> нет первого кадра, WebView рисует «постер по
                                // умолчанию» — чёрный треугольник на белом, растянутый на весь
                                // элемент (полсекунды при старте любого видео). Подменяем его
                                // прозрачной точкой: под ней остаётся фон оболочки медиа.
                                override fun getDefaultVideoPoster(): Bitmap? =
                                    Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888)

                                override fun onHideCustomView() {
                                    val view = customView ?: return
                                    customView = null
                                    customViewCallback = null
                                    (view.parent as? ViewGroup)?.removeView(view)
                                    applyOrientation()
                                }

                                override fun onShowFileChooser(
                                    webView: WebView,
                                    filePathCallback: ValueCallback<Array<Uri>>,
                                    fileChooserParams: FileChooserParams,
                                ): Boolean {
                                    // Предыдущий выбор, оставшийся без ответа, закрываем
                                    // отменой — иначе вебвью ждал бы его вечно.
                                    pendingFileChooser?.onReceiveValue(null)
                                    pendingFileChooser = filePathCallback
                                    return try {
                                        launchFileChooser(fileChooserParams)
                                        true
                                    } catch (e: ActivityNotFoundException) {
                                        // По контракту при false колбэк вызывать нельзя.
                                        pendingFileChooser = null
                                        false
                                    }
                                }
                            }
                            webViewClient = object : WebViewClient() {
                                // Origin pin. `addJavascriptInterface` above attaches
                                // `ZaliAndroidBridge` to the WebView, not to the document —
                                // every page this view ever loads can call it, and through
                                // it reach the session token, the conversation keys and the
                                // whole native API. Nothing in this app navigates: the UI is
                                // one bundled asset document that talks to the server through
                                // that bridge. Without this override a single link tap in a
                                // chat message loaded the attacker's page right into that
                                // frame (the shared UI's `openExternalLink` is a no-op here —
                                // Android does not advertise the `openExternalUrl` capability
                                // — so the default in-WebView navigation went through).
                                override fun shouldOverrideUrlLoading(
                                    view: WebView,
                                    request: WebResourceRequest,
                                ): Boolean {
                                    val url = request.url ?: return true
                                    if (isBundledOrigin(url.toString())) return false
                                    // Песочница аддона: `<iframe srcdoc>` — документ
                                    // собирает сам верхний фрейм, грузить нечего.
                                    if (!request.isForMainFrame && url.toString() == "about:srcdoc") return false
                                    when (url.scheme?.lowercase()) {
                                        "http", "https", "mailto", "tel" -> openExternally(url)
                                    }
                                    return true
                                }

                                // Превью и оригиналы галереи (MediaGallery.intercept):
                                // https://zali-gallery.invalid/<token>/… — в сеть не уходит.
                                override fun shouldInterceptRequest(
                                    view: WebView,
                                    request: WebResourceRequest,
                                ): WebResourceResponse? {
                                    val url = request.url ?: return null
                                    return bridge?.mediaGallery?.intercept(url)
                                }

                                override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                                    // Показ экрана прошлой страницы больше никому не нужен.
                                    nativeBridge.onPageStarted()
                                    if (!NativeBridge.documentStartScriptSupported) {
                                        view.evaluateJavascript(nativeBridge.documentStartScript(), null)
                                    }
                                }

                                // Confirmed live on a Vivo/MediaTek device (2026-07-23): the
                                // WebView's first paint after cold-loading never reaches the
                                // screen (solid black), even though the page itself is fully
                                // loaded and interactive (verified via chrome://inspect) — but
                                // a real hardware tap on the (separate, Compose-rendered)
                                // bottom bar (removed 2026-11-15; the fix below never
                                // depended on it) makes it appear immediately. A layout bounds
                                // nudge, an in-process synthetic MotionEvent on the WebView,
                                // and a visibility toggle were all tried and confirmed live to
                                // NOT fix it. Tapping the bottom bar changes Compose state,
                                // which schedules a full ViewRootImpl.performTraversals() for
                                // the whole window (not just a child invalidate) — that's a
                                // materially different, more global operation than anything
                                // above, so this forces the same thing directly on the window
                                // root, plus a scroll nudge (Chromium's WebView compositor has
                                // its own scroll-triggered redraw path, separate from generic
                                // View.invalidate()).
                                override fun onPageFinished(view: WebView, url: String?) {
                                    // A fresh document has no inline style on <html> yet.
                                    applySafeAreaInsets(view)
                                    // Переход из уведомления — только в загруженный документ: скрипт,
                                    // выполненный до загрузки, живёт в пустой странице и умирает с ней.
                                    webPageReady = true
                                    // Новый документ не знает, на экране ли приложение.
                                    bridge?.setAppVisible(PushSession.appVisible)
                                    consumeNotificationIntent()
                                    view.postDelayed({
                                        val root = view.rootView
                                        root.invalidate()
                                        root.requestLayout()
                                        view.scrollBy(0, 1)
                                        view.scrollBy(0, -1)
                                    }, 300)
                                }
                            }
                            loadUrl(ASSET_BASE_URL + "index.html")
                        }
                    }
                )
            }
        }
    }

    /**
     * Publishes the window's safe-area insets to the web UI as inline custom
     * properties on <html>, which override the `env(safe-area-inset-*)` defaults
     * declared at the top of style.css.
     *
     * Necessary because Android WebView reports only display cutouts through
     * env(), never the status bar or the navigation bar — with the Activity
     * edge-to-edge the page does render under both, so without this the chat
     * header sat under the clock and the message input under the 3-button
     * navigation bar. dp maps 1:1 to CSS px here (viewport is
     * `width=device-width, initial-scale=1`).
     */
    private fun applySafeAreaInsets(view: WebView) {
        val top = safeTopDp.coerceAtLeast(0f)
        val bottom = safeBottomDp.coerceAtLeast(0f)
        view.evaluateJavascript(
            """
            (function () {
              var r = document.documentElement;
              if (!r) return;
              r.style.setProperty('--m-safe-top', '${top}px');
              r.style.setProperty('--m-safe-bottom', '${bottom}px');
            })();
            """.trimIndent(),
            null,
        )
    }

    // Любое касание — действие на этом устройстве (маршрут уведомлений по активности,
    // NativeBridge.noteUserActivity). Касание приходит сюда раньше вебвью; частоту
    // отправки режет мост.
    override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
        bridge?.noteUserActivity()
        return super.dispatchTouchEvent(ev)
    }

    override fun onStart() {
        super.onStart()
        PushSession.appVisible = true
        bridge?.setAppVisible(true)
        // Приложение на экране звонит само (панель звонка в вебе) — уведомление-звонок
        // снимаем, иначе звенели бы оба.
        CallNotifier.dismiss(this, null)
    }

    override fun onStop() {
        PushSession.appVisible = false
        bridge?.setAppVisible(false)
        super.onStop()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        pendingNotificationIntent = intent
        consumeNotificationIntent()
    }

    private fun consumeNotificationIntent() {
        val intent = pendingNotificationIntent ?: return
        val nativeBridge = bridge ?: return
        if (!webPageReady) return
        pendingNotificationIntent = null
        // «Принять» в уведомлении-звонке (IncomingCall.kt): веб дождётся звонка из снимка
        // комнаты после подключения сокета и ответит на него.
        // Действие звонка — только из нашего же уведомления (секрет установки): иначе
        // любое приложение могло прислать «accept» (CallNotifier.isTrustedCallIntent).
        val callAction = intent.getStringExtra(CallNotifier.EXTRA_CALL_ACTION)
            ?.takeIf { CallNotifier.isTrustedCallIntent(this, intent) }
        if (!callAction.isNullOrBlank()) {
            nativeBridge.handleCallNotificationAction(
                callAction,
                intent.getStringExtra(CallNotifier.EXTRA_CALL_ROOM).orEmpty(),
                intent.getStringExtra(CallNotifier.EXTRA_CALL_FROM).orEmpty(),
            )
            return
        }
        val sender = intent.getStringExtra(MessageNotifier.EXTRA_SENDER)
        val serverId = intent.getStringExtra(MessageNotifier.EXTRA_SERVER_ID)
        val channelId = intent.getStringExtra(MessageNotifier.EXTRA_CHANNEL_ID)
        if (sender.isNullOrBlank() && (serverId.isNullOrBlank() || channelId.isNullOrBlank())) return
        nativeBridge.openConversationFromNotification(sender, serverId, channelId)
    }

    override fun onDestroy() {
        pendingFileChooser?.onReceiveValue(null)
        pendingFileChooser = null
        bridge?.teardown()
        super.onDestroy()
    }
}
