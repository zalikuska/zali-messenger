import AppKit

/// Светлота окна — за веб-темой (styler.js шлёт SET_APPEARANCE).
///
/// Окно раньше было жёстко `.darkAqua` с почти чёрным фоном. В светлой теме это
/// давало тёмные «светофоры» на светлом заголовке, тёмные системные меню и
/// полосы прокрутки, а при ресайзе или запуске под WebView мигал чёрный фон.
/// Выбор хранится в UserDefaults, чтобы следующий запуск сразу открыл окно в
/// нужной теме, ещё до загрузки страницы.
enum WindowAppearance {
    private static let modeKey = "zali_window_appearance"
    private static let backgroundKey = "zali_window_background"

    static let darkBackground = NSColor(srgbRed: 0x09 / 255.0, green: 0x0a / 255.0, blue: 0x0c / 255.0, alpha: 1)
    static let lightBackground = NSColor(srgbRed: 0xe7 / 255.0, green: 0xe7 / 255.0, blue: 0xe0 / 255.0, alpha: 1)

    static func persist(mode: String, background: String) {
        UserDefaults.standard.set(mode == "light" ? "light" : "dark", forKey: modeKey)
        UserDefaults.standard.set(background, forKey: backgroundKey)
    }

    static var storedIsLight: Bool {
        UserDefaults.standard.string(forKey: modeKey) == "light"
    }

    static var storedBackground: NSColor {
        let fallback = storedIsLight ? lightBackground : darkBackground
        return color(fromHex: UserDefaults.standard.string(forKey: backgroundKey)) ?? fallback
    }

    /// Применить к окну и его контейнеру (под WebView, виден при ресайзе).
    static func apply(to window: NSWindow?, light: Bool, background: NSColor) {
        guard let window = window else { return }
        window.appearance = NSAppearance(named: light ? .aqua : .darkAqua)
        window.backgroundColor = background
        window.contentView?.layer?.backgroundColor = background.cgColor
    }

    static func applyStored(to window: NSWindow?) {
        apply(to: window, light: storedIsLight, background: storedBackground)
    }

    /// "#rrggbb" → NSColor; всё прочее — nil.
    static func color(fromHex raw: String?) -> NSColor? {
        guard var hex = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !hex.isEmpty else { return nil }
        if hex.hasPrefix("#") { hex.removeFirst() }
        guard hex.count == 6, let value = UInt32(hex, radix: 16) else { return nil }
        return NSColor(
            srgbRed: CGFloat((value >> 16) & 0xff) / 255.0,
            green: CGFloat((value >> 8) & 0xff) / 255.0,
            blue: CGFloat(value & 0xff) / 255.0,
            alpha: 1
        )
    }
}
