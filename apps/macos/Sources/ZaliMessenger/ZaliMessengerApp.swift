import AppKit
import WebKit
import UserNotifications

// Pure AppKit host. There is no SwiftUI anywhere in the window: the WKWebView is a
// direct subview of the window's content view.
//
// This is not a style preference — it is the fix for a hard crash. WebKit installs a
// `WKMouseTrackingObserver` tracking area on the web view and, on EVERY mouse-moved
// event, calls `-hitTest:` on the window's content view to decide whether the web view
// is topmost under the cursor. While the content view was SwiftUI's `NSHostingView`,
// that hit test ran SwiftUI's responder machinery, whose
// `NSViewResponder.platformCurrentEvent` getter goes through `MainActor.assumeIsolated`
// — and on macOS 27 (26A5425a) that call dereferences a garbage executor pointer and
// segfaults. Stack, identical across every report:
//
//   swift_getObjectType <- swift_task_isMainExecutorImpl <- MainActor.assumeIsolated
//   <- NSViewResponder.platformCurrentEvent.getter <- ...ViewResponder.hitTest
//   <- NSHostingView.hitTest <- -[WKMouseTrackingObserver mouseMoved:]
//
// With a plain NSView content view the same tracking area hit-tests plain AppKit views
// and never enters that code path, so the crash cannot occur. It also stops running a
// full SwiftUI hit test on every mouse move over a window that is 100% web view.
//
// Everything the SwiftUI `App`/`WindowGroup` used to provide is reproduced here: the
// hidden title bar, the minimum size, the dark appearance, the window background colour,
// and the main menu (without it Cmd+C/V/X/A/Q do not work in a WKWebView — the same
// reason the Rust shell builds a menu with `muda`).
class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    private var window: NSWindow?
    private let webViewFactory = WebView()
    private var coordinator: WebView.Coordinator?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        installMainMenu()
        buildWindow()
        NSApp.activate(ignoringOtherApps: true)
        maximizeMainWindow()
        UNUserNotificationCenter.current().delegate = self
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            DispatchQueue.main.async {
                if settings.authorizationStatus == .denied {
                    self.showNotificationDeniedAlert()
                } else {
                    NativeNotificationService.shared.requestAuthorization()
                }
            }
        }
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        NativeNotificationService.shared.recheckAuthorizationStatus()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { window?.makeKeyAndOrderFront(nil) }
        return true
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound, .list])
    }

    // MARK: - Window

    private func buildWindow() {
        let coordinator = webViewFactory.makeCoordinator()
        self.coordinator = coordinator
        let webView = webViewFactory.makeWebView(coordinator: coordinator)

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1200, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "Zali Messenger"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isMovableByWindowBackground = true
        window.minSize = NSSize(width: 900, height: 700)
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = NSColor(srgbRed: 0x09 / 255.0, green: 0x0a / 255.0, blue: 0x0c / 255.0, alpha: 1)
        // Restoration would otherwise reopen whatever size the window was left at, and
        // maximizeMainWindow() below already picks the frame on every launch.
        window.isRestorable = false

        let container = NSView(frame: window.contentLayoutRect)
        container.autoresizingMask = [.width, .height]
        container.wantsLayer = true
        container.layer?.backgroundColor = window.backgroundColor.cgColor
        window.contentView = container

        webView.frame = container.bounds
        webView.autoresizingMask = [.width, .height]
        container.addSubview(webView)

        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(webView)
        self.window = window
    }

    // Fills the screen like clicking the zoom button, without going into native
    // fullscreen (no Space switch, menu bar/dock stay visible, traffic lights stay put).
    private func maximizeMainWindow() {
        DispatchQueue.main.async { [weak self] in
            guard let window = self?.window else { return }
            guard let screen = window.screen ?? NSScreen.main else { return }
            window.setFrame(screen.visibleFrame, display: true)
        }
    }

    // MARK: - Menu

    private func installMainMenu() {
        let appName = (Bundle.main.infoDictionary?["CFBundleName"] as? String) ?? "Zali Messenger"
        let mainMenu = NSMenu()

        let appMenuItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "О программе \(appName)", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Скрыть \(appName)", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = appMenu.addItem(withTitle: "Скрыть остальные", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(withTitle: "Показать все", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Завершить \(appName)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appMenuItem.submenu = appMenu
        mainMenu.addItem(appMenuItem)

        let editMenuItem = NSMenuItem()
        let editMenu = NSMenu(title: "Правка")
        editMenu.addItem(withTitle: "Отменить", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = editMenu.addItem(withTitle: "Повторить", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "Вырезать", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Копировать", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Вставить", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Выбрать все", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editMenuItem.submenu = editMenu
        mainMenu.addItem(editMenuItem)

        let windowMenuItem = NSMenuItem()
        let windowMenu = NSMenu(title: "Окно")
        windowMenu.addItem(withTitle: "Свернуть", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Закрыть", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowMenuItem.submenu = windowMenu
        mainMenu.addItem(windowMenuItem)

        NSApp.mainMenu = mainMenu
        NSApp.windowsMenu = windowMenu
    }

    private func showNotificationDeniedAlert() {
        let alert = NSAlert()
        alert.messageText = "Уведомления отключены"
        alert.informativeText = "Разрешите уведомления для Zali Messenger в Системных настройках."
        alert.addButton(withTitle: "Открыть настройки")
        alert.addButton(withTitle: "Позже")

        if alert.runModal() == .alertFirstButtonReturn {
            if let url = URL(string: "x-apple.systempreferences:com.apple.preference.notifications") {
                NSWorkspace.shared.open(url)
            }
        }
    }
}

@main
enum ZaliMessengerMain {
    // NSApplication.delegate is a weak reference, so the delegate has to outlive main().
    private static let delegate = AppDelegate()

    static func main() {
        let app = NSApplication.shared
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        app.run()
    }
}
