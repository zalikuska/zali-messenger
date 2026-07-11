import SwiftUI

/// The bottom navigation bar, styled like the iOS 26 App Store: a floating
/// Liquid Glass capsule with icon+label items and a green "pill" behind the
/// active item (matching the shared web bar and the brand accent).
///
/// On iOS 26 it uses the Liquid Glass SDK (`GlassEffectContainer` + `.glassEffect`).
/// On earlier iOS it falls back to `.ultraThinMaterial` so the shell still builds
/// and looks close.
struct LiquidGlassTabBar: View {
    @Binding var selection: ZaliTab
    /// Only the tabs the UI should show. `hub` is included only when the web
    /// "UI v2" mode is on (mirrors `body[data-ui-v2="off"] #mobileHubBtn{display:none}`).
    var tabs: [ZaliTab]

    private let accent = Color(red: 0.78, green: 0.98, blue: 0.28) // brand lime

    var body: some View {
        Group {
            if #available(iOS 26.0, *) {
                GlassEffectContainer(spacing: 6) {
                    bar
                        .glassEffect(.regular.interactive(), in: .capsule)
                }
            } else {
                bar
                    .background(.ultraThinMaterial, in: Capsule())
                    .overlay(Capsule().strokeBorder(.white.opacity(0.14)))
            }
        }
        .shadow(color: .black.opacity(0.42), radius: 24, x: 0, y: 14)
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
        .frame(maxWidth: 460)
    }

    private var bar: some View {
        HStack(spacing: 4) {
            ForEach(tabs) { tab in
                item(tab)
            }
        }
        .padding(6)
    }

    private func item(_ tab: ZaliTab) -> some View {
        let isActive = tab == selection
        return Button {
            withAnimation(.spring(response: 0.32, dampingFraction: 0.78)) {
                selection = tab
            }
        } label: {
            VStack(spacing: 3) {
                Image(systemName: tab.symbol)
                    .font(.system(size: 20, weight: .semibold))
                Text(tab.title)
                    .font(.system(size: 10, weight: .semibold))
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity)
            .frame(minHeight: 48)
            .foregroundStyle(isActive ? Color(red: 0.02, green: 0.13, blue: 0.04) : Color.white.opacity(0.62))
            .background {
                if isActive {
                    Capsule()
                        .fill(
                            LinearGradient(colors: [accent, accent.opacity(0.82)],
                                           startPoint: .top, endPoint: .bottom)
                        )
                        .shadow(color: accent.opacity(0.34), radius: 8, y: 4)
                }
            }
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
    }
}
