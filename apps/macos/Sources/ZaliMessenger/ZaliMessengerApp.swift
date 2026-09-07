import SwiftUI
import AppKit
import UserNotifications

class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
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

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound, .list])
    }

    // Fills the screen like clicking the zoom button, without going into native
    // fullscreen (no Space switch, menu bar/dock stay visible, traffic lights stay put).
    // Runs on every launch — SwiftUI/AppKit window state restoration would otherwise
    // reopen whatever size the window was left at.
    private func maximizeMainWindow() {
        DispatchQueue.main.async {
            guard let window = NSApp.windows.first(where: { $0.isVisible }) ?? NSApp.windows.first else { return }
            guard let screen = window.screen ?? NSScreen.main else { return }
            window.setFrame(screen.visibleFrame, display: true)
        }
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
struct ZaliMessengerApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        WindowGroup {
            ContentView()
                .frame(minWidth: 900, minHeight: 700)
                .background(Color.clear)
        }
        .windowStyle(.hiddenTitleBar)
        .commands {
            CommandGroup(replacing: .pasteboard) {
                Button("Cut") { NSApp.sendAction(#selector(NSText.cut(_:)), to: nil, from: nil) }.keyboardShortcut("x")
                Button("Copy") { NSApp.sendAction(#selector(NSText.copy(_:)), to: nil, from: nil) }.keyboardShortcut("c")
                Button("Paste") { NSApp.sendAction(#selector(NSText.paste(_:)), to: nil, from: nil) }.keyboardShortcut("v")
                Button("Select All") { NSApp.sendAction(#selector(NSText.selectAll(_:)), to: nil, from: nil) }.keyboardShortcut("a")
            }
        }
    }
}
