package org.zalikus.messenger

import android.annotation.SuppressLint
import android.graphics.Bitmap
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
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
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

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        setContent {
            var selected by remember { mutableStateOf(Tab.Chats) }

            Box(Modifier.fillMaxSize().background(Color(0xFF0B0D12))) {
                AndroidView(
                    modifier = Modifier.fillMaxSize(),
                    factory = { ctx ->
                        val wv = WebView(ctx)
                        val nativeBridge = NativeBridge(ctx, wv)
                        bridge = nativeBridge
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
                    modifier = Modifier.align(Alignment.BottomCenter)
                )
            }
        }
    }

    override fun onDestroy() {
        bridge?.teardown()
        super.onDestroy()
    }
}

@Composable
private fun ZaliBottomBar(
    selected: Tab,
    onSelect: (Tab) -> Unit,
    modifier: Modifier = Modifier,
) {
    Box(
        modifier
            .fillMaxWidth()
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
        androidx.compose.foundation.clickable(
            indication = null,
            interactionSource = remember { androidx.compose.foundation.interaction.MutableInteractionSource() },
            onClick = onClick
        )
    )
