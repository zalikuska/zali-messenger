import SwiftUI

/// Entry point for the iOS shell.
///
/// The iOS client — like the macOS and Windows clients — is a thin native shell
/// around the shared web UI (`Web/src/interface.js`, bundled by `bundle_web.py`).
/// The only platform-specific chrome is the bottom navigation: on iOS 26 it is a
/// native Liquid Glass tab bar styled like the App Store, defined in
/// `LiquidGlassTabBar.swift`. The web UI's own `.mobile-dock` is hidden inside the
/// shell (see `WebView.swift`) so there is exactly one bar.
@main
struct ZaliApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
                .preferredColorScheme(.dark)
                .ignoresSafeArea(.keyboard) // let the web UI manage its own input area
        }
    }
}
