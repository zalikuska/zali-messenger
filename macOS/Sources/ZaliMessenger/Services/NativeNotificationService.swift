import Foundation
import AppKit
import UserNotifications

@MainActor
final class NativeNotificationService {
    static let shared = NativeNotificationService()

    private struct PendingNotification {
        let sender: String
        let text: String
        let attachmentCount: Int
        let serverId: String?
        let channelId: String?
    }

    private var authorizationKnown = false
    private var authorizationGranted = false
    private var pendingNotifications: [PendingNotification] = []
    private var isRequestingAuthorization = false

    private init() {}

    func requestAuthorization() {
        guard !isRequestingAuthorization else { return }
        isRequestingAuthorization = true
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
            DispatchQueue.main.async {
                self.isRequestingAuthorization = false
                self.authorizationKnown = true
                self.authorizationGranted = granted
                if let error {
                    print("[ZALI][NOTIFY] authorization error=\(error.localizedDescription)")
                    return
                }
                print("[ZALI][NOTIFY] authorization granted=\(granted)")
                if granted {
                    self.flushPendingNotifications()
                }
            }
        }
    }

    func showMessageNotification(sender: String, text: String, attachmentCount: Int, serverId: String?, channelId: String?) {
        refreshAuthorizationStatusIfNeeded()
        if !authorizationKnown {
            pendingNotifications.append(PendingNotification(
                sender: sender,
                text: text,
                attachmentCount: attachmentCount,
                serverId: serverId,
                channelId: channelId
            ))
            requestAuthorization()
            return
        }
        guard authorizationGranted else {
            print("[ZALI][NOTIFY] notification skipped because authorization is denied")
            NSApp.requestUserAttention(.criticalRequest)
            return
        }
        deliverMessageNotification(
            sender: sender,
            text: text,
            attachmentCount: attachmentCount,
            serverId: serverId,
            channelId: channelId
        )
    }

    private func flushPendingNotifications() {
        guard authorizationGranted, !pendingNotifications.isEmpty else { return }
        let queue = pendingNotifications
        pendingNotifications.removeAll()
        for notification in queue {
            deliverMessageNotification(
                sender: notification.sender,
                text: notification.text,
                attachmentCount: notification.attachmentCount,
                serverId: notification.serverId,
                channelId: notification.channelId
            )
        }
    }

    private func deliverMessageNotification(sender: String, text: String, attachmentCount: Int, serverId: String?, channelId: String?) {
        let cleanSender = sender.trimmingCharacters(in: .whitespacesAndNewlines)
        let titleSender = cleanSender.isEmpty ? "Zali Messenger" : cleanSender
        let trimmedText = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let body: String

        if !trimmedText.isEmpty {
            body = String(trimmedText.prefix(180))
        } else if attachmentCount > 0 {
            body = attachmentCount == 1 ? "Вложение" : "Вложения: \(attachmentCount)"
        } else {
            body = "Новое сообщение"
        }

        let content = UNMutableNotificationContent()
        content.title = serverId == nil && channelId == nil ? titleSender : "\(titleSender) в канале"
        content.body = body
        content.sound = .default
        content.threadIdentifier = serverId ?? "dm"
        content.categoryIdentifier = "zali-message"
        if #available(macOS 12.0, *) {
            content.interruptionLevel = .timeSensitive
            content.relevanceScore = 1.0
        }

        let request = UNNotificationRequest(
            identifier: "zali-message-\(UUID().uuidString)",
            content: content,
            trigger: nil
        )

        UNUserNotificationCenter.current().add(request) { error in
            if let error {
                print("[ZALI][NOTIFY] delivery error=\(error.localizedDescription)")
                NSApp.requestUserAttention(.criticalRequest)
            }
        }
    }

    private func refreshAuthorizationStatusIfNeeded() {
        guard !authorizationKnown else { return }
        recheckAuthorizationStatus()
    }

    func recheckAuthorizationStatus() {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            DispatchQueue.main.async {
                let granted = [.authorized, .provisional].contains(settings.authorizationStatus)
                    || settings.authorizationStatus.rawValue == 4
                let wasGranted = self.authorizationGranted
                self.authorizationKnown = settings.authorizationStatus != .notDetermined
                self.authorizationGranted = granted

                if granted && !wasGranted {
                    self.flushPendingNotifications()
                }
            }
        }
    }
}
