import SwiftUI

/// Root screen: the shared web UI fills the whole window; the native Liquid Glass
/// bar floats over the bottom safe area. Selecting a tab drives the web UI via JS.
struct ContentView: View {
    @StateObject private var store = WebViewStore()
    @State private var selection: ZaliTab = .chats

    private var tabs: [ZaliTab] {
        store.includeHub
            ? [.chats, .servers, .hub, .settings]
            : [.chats, .servers, .settings]
    }

    var body: some View {
        WebView(store: store)
            .ignoresSafeArea()
            .overlay(alignment: .bottom) {
                LiquidGlassTabBar(selection: $selection, tabs: tabs)
            }
            .onChange(of: selection) { _, tab in
                store.select(tab)
            }
            .onChange(of: store.includeHub) { _, on in
                // If hub disappears while selected, fall back to chats.
                if !on && selection == .hub { selection = .chats }
            }
            .task {
                store.loadBundledUI()
            }
    }
}
