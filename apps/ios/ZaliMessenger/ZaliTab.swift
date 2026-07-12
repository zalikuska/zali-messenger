import SwiftUI

/// The bottom-bar sections. Mirrors the four buttons in the shared web dock
/// (`#mobileChatsBtn`, `#mobileServersBtn`, `#mobileHubBtn`, `#mobileSettingsBtn`).
/// `jsId` is the element id the native bar clicks via the JS bridge.
enum ZaliTab: String, CaseIterable, Identifiable {
    case chats
    case servers
    case hub
    case settings

    var id: String { rawValue }

    /// Element id of the corresponding hidden web dock button.
    var jsId: String {
        switch self {
        case .chats:    return "mobileChatsBtn"
        case .servers:  return "mobileServersBtn"
        case .hub:      return "mobileHubBtn"
        case .settings: return "mobileSettingsBtn"
        }
    }

    var title: String {
        switch self {
        case .chats:    return "Чаты"
        case .servers:  return "Сервера"
        case .hub:      return "Хаб"
        case .settings: return "Настройки"
        }
    }

    /// SF Symbol matching the web SVG for each section.
    var symbol: String {
        switch self {
        case .chats:    return "bubble.left.fill"
        case .servers:  return "square.stack.3d.up.fill"
        case .hub:      return "house.fill"
        case .settings: return "gearshape.fill"
        }
    }
}
