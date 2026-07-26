import SwiftUI

/// Root screen: the shared web UI fills the whole window; the native Liquid Glass
/// bar floats over the bottom safe area. Selecting a tab drives the web UI via JS.
struct ContentView: View {
    @StateObject private var store = WebViewStore()
    @State private var selection: ZaliTab = .chats
    @State private var barHeight: CGFloat = 0

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
                    .background {
                        GeometryReader { geo in
                            Color.clear.preference(key: TabBarHeightKey.self, value: geo.size.height)
                        }
                    }
                    .onPreferenceChange(TabBarHeightKey.self) { barHeight = $0 }
                    // Parks the bar below the bottom edge on the chat screen —
                    // it used to cover the message input, since the web's own
                    // dock (which slides away there) is hidden on this shell.
                    // See WebViewStore.mobileNavProgress. The extra 48pt covers
                    // the home indicator / bottom safe area the bar floats over;
                    // exact travel is not critical because it fades out too.
                    .offset(y: store.mobileNavProgress * (barHeight + 48))
                    .opacity(1 - store.mobileNavProgress)
                    .allowsHitTesting(store.mobileNavProgress < 0.5)
                    // nil spec = follow the finger with no animation while a
                    // back/forward swipe is dragging.
                    .animation(store.mobileNavAnimated ? .easeInOut(duration: 0.24) : nil,
                               value: store.mobileNavProgress)
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

/// Measures the tab bar so it can be translated exactly its own height off-screen.
private struct TabBarHeightKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}
