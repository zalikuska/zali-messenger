package org.zalikus.messenger

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewCompat
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.widthIn
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Chat
import androidx.compose.material.icons.filled.Dns
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView

/** Sections, mirroring the shared web dock buttons. */
private enum class Tab(val jsId: String, val title: String, val icon: ImageVector) {
    Chats("mobileChatsBtn", "Чаты", Icons.Filled.Chat),
    Servers("mobileServersBtn", "Сервера", Icons.Filled.Dns),
    Settings("mobileSettingsBtn", "Настройки", Icons.Filled.Settings),
}

private val Accent = Color(0xFFC7FA48)      // brand lime
private val BarGlass = Color(0xCC0E1014)    // translucent dark glass

/**
 * Thin native Android shell. Wraps the shared web UI (`Web/`, bundled by
 * `bundle_web.py`) in a WebView and draws a translucent bottom bar that mirrors
 * the web Liquid Glass bar (Android has no true Liquid Glass API; this
 * approximates it with translucency + a blurred backdrop on Android 12+).
 */
class MainActivity : ComponentActivity() {

    private var bridge: NativeBridge? = null

    // Latest safe-area insets in dp, pushed into the web UI as CSS custom
    // properties (see applySafeAreaInsets). Kept as an Activity field because
    // they also have to be re-applied after every page load — a fresh document
    // starts with no inline style on <html>.
    private var safeTopDp = 0f
    private var safeBottomDp = 0f

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

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        requestHighestRefreshRate()

        // Lets `chrome://inspect` on a desktop Chrome attach to this WebView over
        // adb — needed here because some vendor ROMs (confirmed on this Vivo
        // build) heavily restrict logcat, so JS console.error output never shows
        // up there at all. Debug-only; BuildConfig.DEBUG is false in release.
        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true)
        }

        setContent {
            var selected by remember { mutableStateOf(Tab.Chats) }
            // 0 = dialog list on screen (bar visible), 1 = chat (bar gone).
            var navProgress by remember { mutableFloatStateOf(0f) }
            var navAnimate by remember { mutableStateOf(true) }
            var webView by remember { mutableStateOf<WebView?>(null) }

            // System bars ∪ display cutout: the notch/front camera and the
            // status bar at the top, the gesture pill or 3-button navigation bar
            // at the bottom. The web UI lays its app-bars and message input out
            // against these (var(--m-safe-top/bottom) in style.css).
            val safeInsets = WindowInsets.systemBars.union(WindowInsets.displayCutout).asPaddingValues()
            val insetTop = safeInsets.calculateTopPadding()
            val insetBottom = safeInsets.calculateBottomPadding()
            LaunchedEffect(insetTop, insetBottom, webView) {
                safeTopDp = insetTop.value
                safeBottomDp = insetBottom.value
                webView?.let { applySafeAreaInsets(it) }
            }

            Box(Modifier.fillMaxSize().background(Color(0xFF0B0D12))) {
                AndroidView(
                    modifier = Modifier.fillMaxSize(),
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
                        webView = wv
                        nativeBridge.onMobileNavProgress = { progress, animate ->
                            navAnimate = animate
                            navProgress = progress
                        }
                        nativeBridge.requestScreenCapturePermission = { requestId ->
                            pendingScreenCaptureRequestId = requestId
                            val manager = getSystemService(MediaProjectionManager::class.java)
                            screenCaptureLauncher.launch(manager.createScreenCaptureIntent())
                        }
                        wv.apply {
                            settings.javaScriptEnabled = true
                            settings.domStorageEnabled = true
                            settings.databaseEnabled = true
                            settings.mediaPlaybackRequiresUserGesture = false
                            settings.allowFileAccess = true
                            setBackgroundColor(0xFF0B0D12.toInt())

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
                                // Grant camera/mic to the local bundled origin for calls.
                                override fun onPermissionRequest(request: PermissionRequest) {
                                    request.grant(request.resources)
                                }
                            }
                            webViewClient = object : WebViewClient() {
                                override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                                    if (!NativeBridge.documentStartScriptSupported) {
                                        view.evaluateJavascript(nativeBridge.documentStartScript(), null)
                                    }
                                }

                                // Confirmed live on a Vivo/MediaTek device (2026-07-23): the
                                // WebView's first paint after cold-loading never reaches the
                                // screen (solid black), even though the page itself is fully
                                // loaded and interactive (verified via chrome://inspect) — but
                                // a real hardware tap on the (separate, Compose-rendered)
                                // bottom bar makes it appear immediately. A layout bounds
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
                                    view.postDelayed({
                                        val root = view.rootView
                                        root.invalidate()
                                        root.requestLayout()
                                        view.scrollBy(0, 1)
                                        view.scrollBy(0, -1)
                                    }, 300)
                                }
                            }
                            loadUrl("file:///android_asset/web/index.html")
                        }
                    }
                )

                ZaliBottomBar(
                    selected = selected,
                    onSelect = { tab ->
                        selected = tab
                        bridge?.selectTab(tab.name.lowercase())
                    },
                    navProgress = navProgress,
                    animateProgress = navAnimate,
                    modifier = Modifier.align(Alignment.BottomCenter)
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

    override fun onDestroy() {
        bridge?.teardown()
        super.onDestroy()
    }
}

/**
 * @param navProgress 0 = dialog list (bar shown), 1 = chat screen (bar parked
 *   below the bottom edge). Reported by the web UI through
 *   NativeBridge.onMobileNavProgress — the chat needs the full height for its
 *   message input, and the bar used to cover it.
 * @param animateProgress false while a back/forward swipe is tracking the
 *   finger, so the bar follows it 1:1; true for a committed transition, where
 *   this runs its own slide (the web dock's is a CSS transition we can't see).
 */
@Composable
private fun ZaliBottomBar(
    selected: Tab,
    onSelect: (Tab) -> Unit,
    navProgress: Float,
    animateProgress: Boolean,
    modifier: Modifier = Modifier,
) {
    var barHeightPx by remember { mutableFloatStateOf(0f) }
    val progress by animateFloatAsState(
        targetValue = navProgress.coerceIn(0f, 1f),
        animationSpec = if (animateProgress) tween(240, easing = FastOutSlowInEasing) else snap(),
        label = "zaliBottomBarNav",
    )
    Box(
        modifier
            .fillMaxWidth()
            .onSizeChanged { barHeightPx = it.height.toFloat() }
            .graphicsLayer {
                // Past its own height it is fully off-window, so it also stops
                // taking touches meant for the chat's input area.
                translationY = progress * barHeightPx
                alpha = 1f - progress
            }
            .navigationBarsPadding()
            .padding(horizontal = 12.dp, vertical = 8.dp),
        contentAlignment = Alignment.Center,
    ) {
        androidx.compose.foundation.layout.Row(
            Modifier
                .widthIn(max = 460.dp)
                .fillMaxWidth()
                .clip(RoundedCornerShape(30.dp))
                .then(
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
                        Modifier.graphicsLayer { } // RenderEffect blur can be attached on the host View
                    else Modifier
                )
                .background(BarGlass, RoundedCornerShape(30.dp))
                .padding(6.dp),
            horizontalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(4.dp),
        ) {
            Tab.entries.forEach { tab ->
                TabItem(
                    tab = tab,
                    active = tab == selected,
                    onClick = { onSelect(tab) },
                    modifier = Modifier.weight(1f),
                )
            }
        }
    }
}

@Composable
private fun TabItem(
    tab: Tab,
    active: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val fg = if (active) Color(0xFF05210B) else Color.White.copy(alpha = 0.62f)
    Column(
        modifier
            .clip(RoundedCornerShape(22.dp))
            .then(
                if (active) Modifier.background(
                    Brush.verticalGradient(listOf(Accent, Accent.copy(alpha = 0.82f)))
                ) else Modifier
            )
            .clickableNoRipple(onClick)
            .height(48.dp)
            .padding(vertical = 6.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = androidx.compose.foundation.layout.Arrangement.Center,
    ) {
        Icon(tab.icon, contentDescription = tab.title, tint = fg, modifier = Modifier.height(22.dp))
        Text(tab.title, color = fg, fontSize = 10.sp, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
private fun Modifier.clickableNoRipple(onClick: () -> Unit): Modifier =
    this.then(
        Modifier.clickable(
            indication = null,
            interactionSource = remember { androidx.compose.foundation.interaction.MutableInteractionSource() },
            onClick = onClick
        )
    )
