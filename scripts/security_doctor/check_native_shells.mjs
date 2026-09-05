// Origin-pin invariants for the four native shells.
//
// Every shell hands the web UI a native bridge: the session token, the
// conversation keys, message sending, filesystem writes. On all four platforms
// that bridge is attached to the *webview*, not to the document — WKWebView's
// script message handlers, WebView2's `window.ipc`, and Android's
// `addJavascriptInterface` are all handed to whatever page occupies the frame.
//
// So the single property that matters is: no document other than the app's own
// bundled UI may ever occupy that frame. Without it, one link tap in a chat
// message loads an attacker's page directly onto the bridge. That was the state
// of all four shells before this check existed, and Android was reachable with
// nothing but a plain `<a href>`.
//
// These have no runtime test — none of the shells are exercised by `cargo test`
// or the JS harnesses — which is exactly why they are pinned here.

import { record, section, finish, read, stripLineComments } from './lib/report.mjs';

section('macOS (Swift, apps/macos)');
{
    const src = stripLineComments(read('apps/macos/Sources/ZaliMessenger/Views/WebView.swift'));
    record('navigation policy is installed',
        /func webView\([\s\S]{0,200}?decidePolicyFor navigationAction: WKNavigationAction/.test(src),
        'WKNavigationDelegate.decidePolicyFor is the only place a foreign origin can be refused');
    record('the policy denies by default',
        /decidePolicyFor navigationAction[\s\S]{0,2000}?decisionHandler\(\.cancel\)/.test(src),
        'an allow-listing policy that falls through to .allow pins nothing');
    record('the allowed origin is a named helper, not an inline string',
        /func isAppOriginURL\(/.test(src),
        'keeps the pin and the loadHTMLString baseURL reviewable side by side');
    record('media capture is gated on the main frame and a known host',
        /requestMediaCapturePermissionFor[\s\S]{0,600}?frame\.isMainFrame[\s\S]{0,300}?decisionHandler\(\.deny\)/.test(src));
    record('IPC handler rejects subframes',
        /userContentController[\s\S]{0,4000}?message\.frameInfo\.isMainFrame/.test(src));
    record('JS cannot open windows on its own',
        /javaScriptCanOpenWindowsAutomatically"\)/.test(src) && /setValue\(false, forKey: "javaScriptCanOpenWindowsAutomatically"\)/.test(src));
}

section('iOS (Swift, apps/ios)');
{
    const src = stripLineComments(read('apps/ios/ZaliMessenger/WebView.swift'));
    record('navigation policy is installed',
        /func webView\([\s\S]{0,200}?decidePolicyFor navigationAction: WKNavigationAction/.test(src));
    record('the policy denies by default',
        /decidePolicyFor navigationAction[\s\S]{0,1500}?decisionHandler\(\.cancel\)/.test(src));
    record('media capture is gated on the main frame',
        /requestMediaCapturePermissionFor[\s\S]{0,600}?frame\.isMainFrame/.test(src));
}

section('Android (Kotlin, apps/android)');
{
    const src = stripLineComments(read('apps/android/app/src/main/java/org/zalikus/messenger/MainActivity.kt'));
    record('navigation is intercepted',
        /override fun shouldOverrideUrlLoading\(/.test(src),
        'without it a chat link loads straight into the frame that owns ZaliAndroidBridge');
    record('only the bundled asset origin may load in-webview',
        /shouldOverrideUrlLoading[\s\S]{0,900}?isBundledOrigin\(/.test(src));
    record('external links leave the app',
        /fun openExternally\(/.test(src) && /Intent\.ACTION_VIEW/.test(src));
    record('media permissions are not granted wholesale',
        !/request\.grant\(request\.resources\)/.test(src),
        'grant(request.resources) hands over whatever was asked for, from any origin');
    record('media permissions check the origin',
        /onPermissionRequest[\s\S]{0,900}?isBundledPermissionOrigin\(/.test(src));
    record('media permissions allowlist the resources',
        /RESOURCE_AUDIO_CAPTURE[\s\S]{0,200}?RESOURCE_VIDEO_CAPTURE/.test(src),
        'so a future WebView resource id is not granted by default');
    record('devtools stay behind BuildConfig.DEBUG',
        /if \(BuildConfig\.DEBUG\)[\s\S]{0,200}?setWebContentsDebuggingEnabled\(true\)/.test(src));
}

section('Windows / macOS Rust shell (WRY, apps/windows)');
{
    const src = stripLineComments(read('apps/windows/src/main.rs'));
    record('navigation handler is installed',
        /\.with_navigation_handler\(/.test(src));
    record('the handler refuses foreign origins',
        /with_navigation_handler\([\s\S]{0,900}?is_app_origin_url\(/.test(src));
    record('window.open / target=_blank is refused too',
        /\.with_new_window_req_handler\(/.test(src),
        'WebView2 would otherwise spawn a second webview inheriting the same IPC');
    record('the allowed origin is a named helper',
        /fn is_app_origin_url\(/.test(src));
    record('media capture policy is installed on the macOS build',
        /install_media_capture_policy/.test(src));
}

finish('native shells');
