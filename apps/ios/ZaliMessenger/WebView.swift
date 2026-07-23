import SwiftUI
import WebKit
import UserNotifications

/// Owns the single shared `WKWebView` that renders the whole app. Held as an
/// `ObservableObject` so the native Liquid Glass bar can drive it without SwiftUI
/// recreating the web view on every tab change (which would drop app state).
///
/// Also implements the native API bridge that `Web/src/interface.js` expects
/// (`window.__ZALI_NATIVE`, message handler name `nativeApp`) — the shared web UI
/// is loaded via `loadFileURL` (`file://`), and a `file://` page's `fetch()` sends
/// `Origin: null`, which the server's CORS allowlist (`allowed_origins`, no
/// wildcard — see `src/lib.rs`) always rejects. Routing API calls through a native
/// `URLSession` request instead sidesteps the browser's CORS enforcement entirely,
/// exactly like the macOS Swift client's `NetworkService.performApiRequest` and the
/// Windows Rust client's `perform_api_request`.
@MainActor
final class WebViewStore: NSObject, ObservableObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, URLSessionWebSocketDelegate, UNUserNotificationCenterDelegate {
    // `nonisolated(unsafe)`: `deinit` can't hop to the main actor (there's no async
    // deinit), so cleanup there needs unisolated access to these two. Safe in
    // practice — deinit only runs once nothing else references this instance, so
    // there's no concurrent access to race with.
    nonisolated(unsafe) let webView: WKWebView

    /// Whether the "Хаб" tab should be shown — mirrors the web's `data-ui-v2` flag
    /// (`body[data-ui-v2="off"] #mobileHubBtn { display:none }`).
    @Published var includeHub: Bool = false

    /// Matches the JS default in `Web/index.html`'s server-address field; overridden
    /// live when the web UI posts a `NETWORK_CONFIG` message (user changes the
    /// server address on the login screen).
    private var apiBaseURL = "https://msgs.zalikus.org"

    /// `startPostAuthSetup()` in `Web/src/interface.js` fires ~5 API calls the
    /// instant login succeeds (contacts/users/servers/device-trust/vault), all
    /// multiplexed over whatever connection `.default`'s pool opens first. Over a
    /// narrow/high-latency link that first connection's handshake can stall, and
    /// every request queued behind it times out together — while the earlier, solo
    /// login request (no contention) went through fine. Capping concurrent
    /// connections keeps a slow link from being asked to open several at once.
    private lazy var apiSession: URLSession = {
        let config = URLSessionConfiguration.default
        config.httpMaximumConnectionsPerHost = 2
        return URLSession(configuration: config)
    }()

    // MARK: - WebSocket transport (realtime connection status, message + metadata push)
    //
    // Mirrors macOS `NetworkService`'s message socket: connect with the same auth
    // headers as HTTP, ping-based heartbeat, exponential-backoff reconnect. A
    // message-envelope frame (id/sender/receiver, no `type`) is downloaded and
    // decrypted via `ZaliCore` (Rust Core FFI, see `ZaliCore.swift` and
    // `build_ios_core.sh`) the same way macOS's `handleWebSocketMessage` does.
    // Sending is NOT implemented yet — only receiving; see `iOS/README.md`.
    nonisolated(unsafe) private var wsTask: URLSessionWebSocketTask?
    private var wsSession: URLSession?
    private var wsGeneration = 0
    private var wsReconnectAttempt = 0
    private var wsReconnectWorkItem: DispatchWorkItem?
    private var wsHeartbeatWorkItem: DispatchWorkItem?
    private var wsReceiveTask: Task<Void, Never>?
    /// Extracted from the Authorization header of the first authenticated API_REQUEST
    /// seen (see `handleApiRequest`) — there's no separate SET_SESSION message on the
    /// `webkit` transport (that's an `ipc`/`webview2`-only native-auth path), so this
    /// is the only place a bearer token is ever visible to native code.
    private var wsAuthToken = ""
    /// Parsed from `PERSIST_DEVICE_IDENTITY`'s identity JSON — same device id the
    /// server already associates with this client's HTTP requests.
    private var wsDeviceId = ""

    /// In-flight SEND_MESSAGE clientId guard, mirroring macOS's Coordinator.
    /// Without it a rapid double-trigger (double Enter, a retry racing the first
    /// attempt) could pack+upload the same message twice.
    private var inFlightSendClientIds = Set<String>()

    // MARK: - Message decryption (ZaliCore / Rust Core FFI)
    //
    // Set via SET_KEY (see handleNativeMessage) — JS pushes the active E2E key and
    // the full per-conversation key map here whenever either changes.
    private var currentE2eKey = ""
    private var conversationKeys: [String: String] = [:]

    override init() {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []

        // Bridge injected before the page scripts run:
        //  - window.__ZALI_NATIVE_CAPS__: bootstrap.js merges this into
        //    window.__ZALI_NATIVE.supports once it detects the `nativeApp` message
        //    handler below (registered under the SAME name macOS uses, so JS's
        //    `macBridge` detection branch fires for iOS too). That branch's
        //    *default* caps assume full macOS-level support (avatarFetch, voice,
        //    windowDrag, ...) — capabilities this shell doesn't implement. Left
        //    uncorrected, JS believed e.g. sendMessage was natively handled and
        //    silently dropped outgoing messages instead of queueing them in its
        //    local retry outbox (`flushPendingOutbox` — see interface.js). This
        //    object overrides every cap explicitly so JS's own already-tested
        //    "native available but this capability isn't" fallbacks kick in
        //    instead of assuming success.
        //  - window.__ZALI_INJECTED_DEVICE_IDENTITY: re-adopts the device identity saved
        //    from the last launch (see `PERSIST_DEVICE_IDENTITY` below) — mirrors the
        //    macOS Swift client. Without this, every WKWebView data wipe (reinstall,
        //    Xcode relaunch that clears storage) mints a fresh device_id, which orphans
        //    every key envelope addressed to the old one ("на сервере нет конвертов для
        //    этого устройства" never resolves). `loadDeviceIdentity()` in interface.js
        //    only consults this when its own localStorage has no identity yet.
        var bridge = """
        (function () {
          window.__ZALI_NATIVE_CAPS__ = {
            apiRequest: true,
            networkConfig: true,
            setKey: true,
            sendMessage: true,
            sessionSync: false,
            saveStyle: false,
            saveMessageCache: false,
            downloadAttachment: true,
            serverHistory: false,
            avatarFetch: true,
            tenor: true,
            voice: false,
            windowDrag: false
          };
          window.__zaliSelectTab = function (name) {
            var map = { chats: 'mobileChatsBtn', servers: 'mobileServersBtn',
                        hub: 'mobileHubBtn', settings: 'mobileSettingsBtn' };
            var el = document.getElementById(map[name]);
            if (el) { el.click(); }
          };
          var hide = function () {
            if (document.getElementById('__zaliNativeBarCss')) return;
            var st = document.createElement('style');
            st.id = '__zaliNativeBarCss';
            st.textContent = '.mobile-dock{display:none !important;}';
            (document.head || document.documentElement).appendChild(st);
          };
          if (document.readyState !== 'loading') hide();
          document.addEventListener('DOMContentLoaded', hide);
          document.body && document.body.classList.add('zali-native-ios');
        })();
        """
        if let lastUser = UserDefaults.standard.string(forKey: WebViewStore.lastUsernameKey),
           let identityJSON = WebViewStore.loadSharedDeviceIdentity(for: lastUser) {
            bridge = "window.__ZALI_INJECTED_DEVICE_IDENTITY = \(identityJSON);\n" + bridge
        }
        let script = WKUserScript(source: bridge,
                                  injectionTime: .atDocumentStart,
                                  forMainFrameOnly: true)
        config.userContentController.addUserScript(script)

        let wv = WKWebView(frame: .zero, configuration: config)
        wv.isOpaque = false
        wv.backgroundColor = .black
        wv.scrollView.backgroundColor = .black
        wv.scrollView.contentInsetAdjustmentBehavior = .never
        self.webView = wv
        super.init()
        wv.navigationDelegate = self
        // `add(_:name:)` retains its handler strongly; a weak proxy avoids a
        // permanent retain cycle (webView → userContentController → self → webView).
        config.userContentController.add(WeakScriptMessageHandler(self), name: "nativeApp")
        UNUserNotificationCenter.current().delegate = self
        wv.uiDelegate = self
    }

    /// Grants camera/mic to voice calls (`getUserMedia`/`RTCPeerConnection` — both
    /// pure browser WebRTC APIs, no native bridge involved; `voice.js` feature-detects
    /// them directly). Without this delegate, WKWebView silently denies every capture
    /// request from iOS 14.5+ on. The shared UI loads via `loadFileURL` (`file://`),
    /// so `origin.host` is empty — scope the grant to the main frame only, mirroring
    /// macOS's `requestMediaCapturePermissionFor` (which instead allowlists
    /// localhost/127.0.0.1, since macOS serves over local HTTP rather than file://).
    func webView(_ webView: WKWebView,
                 requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo,
                 type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        guard frame.isMainFrame, origin.host.isEmpty else {
            decisionHandler(.deny)
            return
        }
        decisionHandler(.grant)
    }

    deinit {
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "nativeApp")
        wsTask?.cancel(with: .goingAway, reason: nil)
    }

    /// Entry point for every `postNativeMessage(...)` call from the shared web UI
    /// (`Web/src/interface.js`). `API_REQUEST`, `NETWORK_CONFIG`, `SET_KEY`, and
    /// `PERSIST_DEVICE_IDENTITY` are handled — everything else (voice, avatars,
    /// drag, ...) is native-shell functionality not yet ported to iOS; see
    /// `iOS/README.md`.
    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard let dict = message.body as? [String: Any] else { return }
        handleNativeMessage(dict)
    }

    private func handleNativeMessage(_ dict: [String: Any]) {
        let type = dict["type"] as? String ?? ""
        switch type {
        case "NETWORK_CONFIG":
            if let base = dict["apiBaseUrl"] as? String, !base.isEmpty, base != apiBaseURL {
                apiBaseURL = base
                if !wsAuthToken.isEmpty { connectWebSocket() }
            }
        case "API_REQUEST":
            handleApiRequest(dict)
        case "PERSIST_DEVICE_IDENTITY":
            handlePersistDeviceIdentity(dict)
        case "SET_KEY":
            if let key = dict["key"] as? String { currentE2eKey = key }
            if let convKeys = dict["conversationKeys"] as? [String: Any] {
                var next: [String: String] = [:]
                for (k, v) in convKeys {
                    if let sv = v as? String { next[k] = sv }
                }
                conversationKeys = next
            }
        case "REFRESH_HISTORY":
            handleRefreshHistory(dict)
        case "SEND_MESSAGE":
            handleSendMessage(dict)
        case "UPLOAD_AVATAR_REQUEST":
            handleAvatarUploadRequest(dict, delete: false)
        case "DELETE_AVATAR_REQUEST":
            handleAvatarUploadRequest(dict, delete: true)
        case "LOAD_AVATAR_REQUEST":
            handleLoadAvatarRequest(dict)
        case "RESOLVE_TENOR":
            let url = dict["url"] as? String ?? ""
            let requestId = dict["requestId"] as? String ?? UUID().uuidString
            resolveTenor(url: url, requestId: requestId)
        case "SHOW_NOTIFICATION":
            let sender = (dict["sender"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let text = dict["text"] as? String ?? ""
            let attachmentCount = (dict["attachmentCount"] as? NSNumber)?.intValue ?? 0
            let serverId = dict["serverId"] as? String
            let channelId = dict["channelId"] as? String
            showMessageNotification(sender: sender, text: text, attachmentCount: attachmentCount, serverId: serverId, channelId: channelId)
        case "DOWNLOAD_ATTACHMENT":
            let dataUrl = dict["dataUrl"] as? String ?? ""
            let filename = dict["filename"] as? String ?? "attachment"
            saveAttachment(dataUrl: dataUrl, filename: filename)
        default:
            break
        }
    }

    // MARK: - Attachment download (DOWNLOAD_ATTACHMENT)
    //
    // Ported from macOS's `.downloadAttachment` IPC case + `saveAttachment`
    // (`NSSavePanel`). iOS has no save panel — writes to a temp file and presents
    // a `UIActivityViewController` share sheet, whose "Save to Files" action is the
    // iOS equivalent of macOS's save dialog.

    private func saveAttachment(dataUrl: String, filename: String) {
        let decoded = decodedDataURL(dataUrl)
        guard !decoded.data.isEmpty else { return }
        let safeName = safeFileName(filename, fallbackExtension: decoded.fileExtension)
        let fileURL = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("\(UUID().uuidString)_\(safeName)")
        do {
            try decoded.data.write(to: fileURL, options: [.atomic])
        } catch {
            return
        }

        guard let rootViewController = Self.keyWindowRootViewController() else { return }
        let activityVC = UIActivityViewController(activityItems: [fileURL], applicationActivities: nil)
        activityVC.completionWithItemsHandler = { _, _, _, _ in
            try? FileManager.default.removeItem(at: fileURL)
        }
        if let popover = activityVC.popoverPresentationController {
            popover.sourceView = rootViewController.view
            popover.sourceRect = CGRect(x: rootViewController.view.bounds.midX, y: rootViewController.view.bounds.maxY, width: 0, height: 0)
            popover.permittedArrowDirections = []
        }
        rootViewController.present(activityVC, animated: true, completion: nil)
    }

    private static func keyWindowRootViewController() -> UIViewController? {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }
            .first { $0.isKeyWindow }?
            .rootViewController
    }

    // MARK: - Local notifications (SHOW_NOTIFICATION)
    //
    // Ported from macOS's `.showNotification` IPC case + `NativeNotificationService`
    // (`apps/macos/Sources/ZaliMessenger/Services/NativeNotificationService.swift`).
    // Local notifications only — no APNs, matches how `interface.js`'s
    // `notifyBackgroundMessage()` drives this: it fires on every muted-aware new
    // message regardless of platform, so authorization is requested lazily on first
    // use rather than eagerly at launch.

    private struct PendingNotification {
        let sender: String
        let text: String
        let attachmentCount: Int
        let serverId: String?
        let channelId: String?
    }

    private var notificationAuthorizationKnown = false
    private var notificationAuthorizationGranted = false
    private var isRequestingNotificationAuthorization = false
    private var pendingNotifications: [PendingNotification] = []

    private func showMessageNotification(sender: String, text: String, attachmentCount: Int, serverId: String?, channelId: String?) {
        if !notificationAuthorizationKnown {
            pendingNotifications.append(PendingNotification(sender: sender, text: text, attachmentCount: attachmentCount, serverId: serverId, channelId: channelId))
            requestNotificationAuthorizationIfNeeded()
            return
        }
        guard notificationAuthorizationGranted else { return }
        deliverMessageNotification(sender: sender, text: text, attachmentCount: attachmentCount, serverId: serverId, channelId: channelId)
    }

    private func requestNotificationAuthorizationIfNeeded() {
        guard !isRequestingNotificationAuthorization else { return }
        isRequestingNotificationAuthorization = true
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { [weak self] granted, _ in
            Task { @MainActor in
                guard let self else { return }
                self.isRequestingNotificationAuthorization = false
                self.notificationAuthorizationKnown = true
                self.notificationAuthorizationGranted = granted
                let queue = self.pendingNotifications
                self.pendingNotifications.removeAll()
                guard granted else { return }
                for notification in queue {
                    self.deliverMessageNotification(sender: notification.sender, text: notification.text, attachmentCount: notification.attachmentCount, serverId: notification.serverId, channelId: notification.channelId)
                }
            }
        }
    }

    private func deliverMessageNotification(sender: String, text: String, attachmentCount: Int, serverId: String?, channelId: String?) {
        let titleSender = sender.isEmpty ? "Zali Messenger" : sender
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
        content.interruptionLevel = .timeSensitive
        content.relevanceScore = 1.0

        let request = UNNotificationRequest(identifier: "zali-message-\(UUID().uuidString)", content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request, withCompletionHandler: nil)
    }

    /// Show the banner + play sound even while the app is in the foreground —
    /// without this, `UNUserNotificationCenter` silently swallows notifications
    /// delivered while the app is active.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound, .badge])
    }

    // MARK: - Tenor GIF preview resolution (RESOLVE_TENOR)
    //
    // Ported from macOS's `.resolveTenor` IPC case + `resolveTenor`/`extractTenorMediaURL`.
    // Fire-and-forget: result comes back via the `tenor_resolved` bus event, not
    // `native_response` (matches macOS/interface.js's `onTenorResolved`).

    private func resolveTenor(url: String, requestId: String) {
        guard let pageURL = URL(string: url), pageURL.scheme == "https",
              let host = pageURL.host, host == "tenor.com" || host.hasSuffix(".tenor.com") else {
            emitTenorResolution(requestId: requestId, sourceUrl: url, mediaUrl: nil, mimeType: nil, kind: nil)
            return
        }

        var request = URLRequest(url: pageURL)
        request.setValue("text/html,application/xhtml+xml", forHTTPHeaderField: "Accept")
        request.setValue("Mozilla/5.0", forHTTPHeaderField: "User-Agent")

        URLSession.shared.dataTask(with: request) { [weak self] data, _, error in
            Task { @MainActor in
                guard let self, error == nil, let data, !data.isEmpty else {
                    self?.emitTenorResolution(requestId: requestId, sourceUrl: url, mediaUrl: nil, mimeType: nil, kind: nil)
                    return
                }
                let html = String(decoding: data, as: UTF8.self)
                let resolved = self.extractTenorMediaURL(from: html)
                self.emitTenorResolution(requestId: requestId, sourceUrl: url, mediaUrl: resolved.mediaUrl, mimeType: resolved.mimeType, kind: resolved.kind)
            }
        }.resume()
    }

    private func extractTenorMediaURL(from html: String) -> (mediaUrl: String?, mimeType: String?, kind: String?) {
        let patterns = [
            #"property=["']og:video["'][^>]*content=["']([^"']+)["']"#,
            #"property=["']og:image["'][^>]*content=["']([^"']+)["']"#,
            #"name=["']twitter:image["'][^>]*content=["']([^"']+)["']"#,
            #"name=["']twitter:player:stream["'][^>]*content=["']([^"']+)["']"#
        ]
        for pattern in patterns {
            if let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]),
               let match = regex.firstMatch(in: html, options: [], range: NSRange(html.startIndex..., in: html)),
               let range = Range(match.range(at: 1), in: html) {
                let raw = String(html[range]).trimmingCharacters(in: .whitespacesAndNewlines)
                guard !raw.isEmpty else { continue }
                let mimeType = inferTenorMimeType(from: raw)
                return (raw, mimeType, inferTenorKind(from: mimeType))
            }
        }
        return (nil, nil, nil)
    }

    private func inferTenorMimeType(from url: String) -> String {
        let lower = url.lowercased()
        if lower.contains(".mp4") { return "video/mp4" }
        if lower.contains(".webm") { return "video/webm" }
        if lower.contains(".gif") { return "image/gif" }
        if lower.contains(".webp") { return "image/webp" }
        return "image/png"
    }

    private func inferTenorKind(from mimeType: String) -> String {
        mimeType.hasPrefix("video/") ? "video" : "image"
    }

    private func emitTenorResolution(requestId: String, sourceUrl: String, mediaUrl: String?, mimeType: String?, kind: String?) {
        var payload: [String: Any] = ["requestId": requestId, "sourceUrl": sourceUrl]
        if let mediaUrl { payload["mediaUrl"] = mediaUrl }
        if let mimeType { payload["mimeType"] = mimeType }
        if let kind { payload["kind"] = kind }
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.loader && window.loader.bus.send('zali_interface:tenor_resolved', \(json));", completionHandler: nil)
    }

    // MARK: - Avatar (UPLOAD/DELETE/LOAD_AVATAR_REQUEST)
    //
    // Ported from macOS's `.uploadAvatarRequest`/`.deleteAvatarRequest`/`.loadAvatarRequest`
    // IPC cases + `NetworkService.performAvatarRequest`/`performAvatarFetch`. Multipart
    // upload reuses the same boundary-writing approach as `uploadMessage` above.

    private func handleAvatarUploadRequest(_ dict: [String: Any], delete: Bool) {
        let requestId = dict["requestId"] as? String ?? dict["request_id"] as? String ?? UUID().uuidString
        guard !requestId.isEmpty, let avatarURL = URL(string: apiBaseURL + "/api/avatar") else {
            sendNativeResponse(["requestId": requestId, "ok": false, "error": "Не удалось выполнить операцию"])
            return
        }

        var request = URLRequest(url: avatarURL)
        request.httpMethod = delete ? "DELETE" : "POST"
        if !wsAuthToken.isEmpty { request.setValue("Bearer \(wsAuthToken)", forHTTPHeaderField: "Authorization") }
        if !wsDeviceId.isEmpty { request.setValue(wsDeviceId, forHTTPHeaderField: "X-Zali-Device-ID") }

        if delete {
            apiSession.dataTask(with: request) { [weak self] data, response, error in
                Task { @MainActor in
                    guard let self else { return }
                    guard error == nil, let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                        let bodyPreview = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
                        self.sendNativeResponse(["requestId": requestId, "ok": false, "error": bodyPreview.isEmpty ? "Не удалось выполнить операцию" : bodyPreview])
                        return
                    }
                    self.sendNativeResponse(["requestId": requestId, "ok": true, "data": ["username": self.currentUsername]])
                }
            }.resume()
            return
        }

        let dataUrl = dict["dataUrl"] as? String ?? ""
        let mimeType = dict["mimeType"] as? String ?? "image/png"
        let filename = dict["filename"] as? String ?? "avatar.png"
        guard let imageData = Data(base64Encoded: dataUrl.components(separatedBy: ",").last ?? ""), !imageData.isEmpty else {
            sendNativeResponse(["requestId": requestId, "ok": false, "error": "Invalid avatar data URL"])
            return
        }

        let boundary = "Boundary-\(UUID().uuidString)"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        let bodyURL = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("avatar-\(UUID().uuidString).multipart")
        guard FileManager.default.createFile(atPath: bodyURL.path, contents: nil) else {
            sendNativeResponse(["requestId": requestId, "ok": false, "error": "Не удалось выполнить операцию"])
            return
        }

        do {
            let handle = try FileHandle(forWritingTo: bodyURL)
            defer { try? handle.close() }
            func write(_ string: String) throws {
                guard let data = string.data(using: .utf8) else { return }
                try handle.write(contentsOf: data)
            }
            try write("--\(boundary)\r\n")
            try write("Content-Disposition: form-data; name=\"file\"; filename=\"\(filename)\"\r\n")
            try write("Content-Type: \(mimeType)\r\n\r\n")
            try handle.write(contentsOf: imageData)
            try write("\r\n--\(boundary)--\r\n")
        } catch {
            try? FileManager.default.removeItem(at: bodyURL)
            sendNativeResponse(["requestId": requestId, "ok": false, "error": "Не удалось выполнить операцию"])
            return
        }

        apiSession.uploadTask(with: request, fromFile: bodyURL) { [weak self] data, response, error in
            Task { @MainActor in
                guard let self else { return }
                try? FileManager.default.removeItem(at: bodyURL)
                guard error == nil, let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                    let bodyPreview = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
                    self.sendNativeResponse(["requestId": requestId, "ok": false, "error": bodyPreview.isEmpty ? "Не удалось выполнить операцию" : bodyPreview])
                    return
                }
                self.sendNativeResponse(["requestId": requestId, "ok": true, "data": ["username": self.currentUsername]])
            }
        }.resume()
    }

    private func handleLoadAvatarRequest(_ dict: [String: Any]) {
        let requestId = dict["requestId"] as? String ?? dict["request_id"] as? String ?? UUID().uuidString
        let username = (dict["username"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !username.isEmpty, !requestId.isEmpty,
              let encoded = username.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed),
              let url = URL(string: apiBaseURL + "/api/avatar/" + encoded) else {
            sendNativeResponse(["requestId": requestId, "ok": false, "error": "Не удалось загрузить аватар"])
            return
        }

        var request = URLRequest(url: url)
        if !wsAuthToken.isEmpty { request.setValue("Bearer \(wsAuthToken)", forHTTPHeaderField: "Authorization") }

        let maxAvatarBytes = 2 * 1024 * 1024
        apiSession.dataTask(with: request) { [weak self] data, response, error in
            Task { @MainActor in
                guard let self else { return }
                guard error == nil, let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode), let data else {
                    // No avatar set is a normal, non-error outcome (macOS treats 404 as empty).
                    self.sendNativeResponse(["requestId": requestId, "ok": true, "data": ["dataUrl": ""]])
                    return
                }
                guard data.count <= maxAvatarBytes else {
                    self.sendNativeResponse(["requestId": requestId, "ok": false, "error": "Аватар слишком большой"])
                    return
                }
                let mimeType = http.value(forHTTPHeaderField: "Content-Type")?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "image/png"
                let dataUrl = "data:\(mimeType);base64,\(data.base64EncodedString())"
                self.sendNativeResponse(["requestId": requestId, "ok": true, "data": ["dataUrl": dataUrl]])
            }
        }.resume()
    }

    /// The bridge doesn't track a `SET_SESSION`-supplied username (unlike macOS), so
    /// the avatar response falls back to the last-persisted device-identity username.
    private var currentUsername: String {
        UserDefaults.standard.string(forKey: WebViewStore.lastUsernameKey) ?? ""
    }

    private static let lastUsernameKey = "zali_last_username"

    /// Deliberately a plain file, not Keychain — this app installs fresh on every
    /// TestFlight/App Store build (no stable code-signing identity across ad-hoc
    /// rebuilds during development), so Keychain ACLs would re-prompt on every
    /// reinstall. Mirrors the macOS client's explicit "no Keychain" rule.
    private static var sharedAppSupportDir: URL? = {
        guard let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            return nil
        }
        let dir = base.appendingPathComponent("ZaliMessenger", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }()

    /// Loads the shared device identity for `username`, for injection at document-start.
    /// Returns the raw JSON only if it parses — a corrupt file must never break page load.
    private static func loadSharedDeviceIdentity(for username: String) -> String? {
        let user = username.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !user.isEmpty, let dir = sharedAppSupportDir else { return nil }
        let path = dir.appendingPathComponent("shared_device_identity_\(user).json")
        guard let raw = try? String(contentsOf: path, encoding: .utf8) else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              let data = trimmed.data(using: .utf8),
              (try? JSONSerialization.jsonObject(with: data)) != nil else { return nil }
        return trimmed
    }

    /// `Web/src/interface.js`'s `persistDeviceIdentityToNative()` sends this whenever the
    /// device identity is created or changed, so it survives a WKWebView storage wipe.
    /// Unlike macOS (which ignores the payload and re-reads localStorage itself), this
    /// uses the given `identity` JSON directly — it's the same page instructing its own
    /// trusted native shell, not untrusted input.
    private func handlePersistDeviceIdentity(_ dict: [String: Any]) {
        let username = (dict["username"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let identityJSON = dict["identity"] as? String ?? ""
        guard !username.isEmpty, !identityJSON.isEmpty,
              let dir = WebViewStore.sharedAppSupportDir else { return }
        UserDefaults.standard.set(username, forKey: WebViewStore.lastUsernameKey)
        let path = dir.appendingPathComponent("shared_device_identity_\(username).json")
        try? identityJSON.write(to: path, atomically: true, encoding: .utf8)

        if let identityData = identityJSON.data(using: .utf8),
           let identityDict = try? JSONSerialization.jsonObject(with: identityData) as? [String: Any],
           let deviceId = identityDict["deviceId"] as? String, !deviceId.isEmpty {
            wsDeviceId = deviceId
        }
    }

    /// Mirrors macOS `NetworkService.performApiRequest` / Windows `perform_api_request`:
    /// a plain `URLSession` request (no CORS enforcement applies to native networking),
    /// with the response handed back to JS in the exact envelope `nativeApiResponse()`
    /// expects (`Web/src/interface.js`).
    private func handleApiRequest(_ dict: [String: Any]) {
        let requestId = dict["requestId"] as? String ?? UUID().uuidString
        let method = (dict["method"] as? String ?? "GET").uppercased()
        let path = dict["path"] as? String ?? ""
        let rawHeaders = dict["headers"] as? [String: Any] ?? [:]
        let body = dict["body"] as? String
        let timeoutMs = (dict["timeoutMs"] as? Double) ?? 12000

        for (key, value) in rawHeaders {
            if key.caseInsensitiveCompare("Authorization") == .orderedSame, let sv = value as? String {
                let token = sv.replacingOccurrences(of: "Bearer ", with: "").trimmingCharacters(in: .whitespaces)
                if !token.isEmpty, token != wsAuthToken {
                    wsAuthToken = token
                    connectWebSocket()
                }
            }
        }

        let forbidden = ["..", "%2F", "%2f", "%5C", "%5c"]
        guard path.hasPrefix("/api/"), !forbidden.contains(where: path.contains),
              let url = URL(string: apiBaseURL + path) else {
            sendNativeResponse(["requestId": requestId, "ok": false, "error": "Некорректный путь запроса"])
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        for (key, value) in rawHeaders {
            if let sv = value as? String { request.setValue(sv, forHTTPHeaderField: key) }
        }
        if let body { request.httpBody = body.data(using: .utf8) }

        // Two attempts, second on a brand-new ephemeral session — a half-open
        // pooled connection otherwise gets reused on retry and stalls again
        // (same fix as macOS's attemptApiRequest; the timeouts observed on-device
        // for /api/key-envelopes and /api/vault/events motivated porting this).
        // First attempt is short: a dead pooled socket shouldn't cost the whole
        // budget before falling back to a fresh connection.
        let totalBudget = max(timeoutMs / 1000.0, 3.0)
        let firstAttemptTimeout = min(2.0, totalBudget * 0.4)
        let finalAttemptTimeout = max(totalBudget - firstAttemptTimeout, 3.0)
        attemptApiRequest(request, requestId: requestId, attempt: 1, maxAttempts: 2,
                          perAttemptTimeout: firstAttemptTimeout, finalAttemptTimeout: finalAttemptTimeout)
    }

    private func attemptApiRequest(_ request: URLRequest, requestId: String, attempt: Int, maxAttempts: Int,
                                   perAttemptTimeout: TimeInterval, finalAttemptTimeout: TimeInterval) {
        var attemptRequest = request
        attemptRequest.timeoutInterval = perAttemptTimeout

        let session: URLSession
        if attempt == 1 {
            session = apiSession
        } else {
            let config = URLSessionConfiguration.ephemeral
            config.timeoutIntervalForRequest = perAttemptTimeout
            config.waitsForConnectivity = false
            session = URLSession(configuration: config)
        }

        session.dataTask(with: attemptRequest) { [weak self] data, response, error in
            Task { @MainActor in
                guard let self else { return }
                guard let http = response as? HTTPURLResponse else {
                    if attempt < maxAttempts {
                        let nextAttempt = attempt + 1
                        let nextTimeout = nextAttempt == maxAttempts ? finalAttemptTimeout : perAttemptTimeout
                        self.attemptApiRequest(request, requestId: requestId, attempt: nextAttempt, maxAttempts: maxAttempts,
                                               perAttemptTimeout: nextTimeout, finalAttemptTimeout: finalAttemptTimeout)
                        return
                    }
                    self.sendNativeResponse([
                        "requestId": requestId,
                        "ok": false,
                        "error": error?.localizedDescription ?? "Не удалось связаться с сервером",
                    ])
                    return
                }
                let bodyString = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
                var headers: [String: String] = [:]
                for (k, v) in http.allHeaderFields {
                    if let ks = k as? String, let vs = v as? String { headers[ks] = vs }
                }
                self.sendNativeResponse([
                    "requestId": requestId,
                    "ok": true,
                    "data": [
                        "status": http.statusCode,
                        "ok": (200..<300).contains(http.statusCode),
                        "body": bodyString,
                        "headers": headers,
                    ],
                ])
            }
        }.resume()
    }

    // MARK: - Message sending (ZaliCore pack + multipart upload)
    //
    // Ported from macOS's `.sendMessage` IPC case + `NetworkService.uploadMessage`.
    // Packing (`ZaliCore.packMessage`) does the actual AES-256-GCM encryption via
    // Rust Core; this just builds the multipart body and uploads it to /api/upload.

    private func handleSendMessage(_ dict: [String: Any]) {
        let clientId = dict["clientId"] as? String ?? UUID().uuidString
        guard !inFlightSendClientIds.contains(clientId) else { return }
        inFlightSendClientIds.insert(clientId)

        let text = dict["text"] as? String ?? ""
        let recipient = dict["recipient"] as? String ?? ""
        let sender = dict["sender"] as? String ?? ""
        let key = (dict["key"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let keyVersion = (dict["keyVersion"] as? NSNumber)?.intValue ?? 2
        let serverIdRaw = dict["serverId"] as? String ?? ""
        let channelIdRaw = dict["channelId"] as? String ?? ""
        let serverId = serverIdRaw.isEmpty ? nil : serverIdRaw
        let channelId = channelIdRaw.isEmpty ? nil : channelIdRaw

        guard !key.isEmpty else {
            inFlightSendClientIds.remove(clientId)
            sendBusEvent("on_send_error", payload: ["clientId": clientId, "statusCode": 0, "responseBody": "Core: E2E-ключ не задан"])
            return
        }

        let tempPath = NSTemporaryDirectory() + UUID().uuidString + ".zali"
        let attachments = dict["attachments"] as? [[String: Any]] ?? []
        var packedAttachments: [[String: Any]] = []
        var tempAttachmentURLs: [URL] = []

        for attachment in attachments {
            guard let dataUrl = attachment["dataUrl"] as? String else { continue }
            let name = attachment["name"] as? String ?? "attachment.bin"
            let kind = attachment["kind"] as? String ?? "file"
            let (data, mimeType, fileExtension) = decodedDataURL(dataUrl)
            guard !data.isEmpty else { continue }

            let safeName = safeFileName(name, fallbackExtension: fileExtension)
            let tempAttachmentURL = URL(fileURLWithPath: NSTemporaryDirectory())
                .appendingPathComponent("\(UUID().uuidString)_\(safeName)")
            try? data.write(to: tempAttachmentURL)

            tempAttachmentURLs.append(tempAttachmentURL)
            packedAttachments.append([
                "path": tempAttachmentURL.path,
                "archivePath": "attachments/\(safeName)",
                "name": name,
                "mimeType": attachment["mimeType"] as? String ?? mimeType,
                "kind": kind,
                "size": (attachment["size"] as? NSNumber).map { $0.uint64Value } ?? UInt64(data.count),
            ])
        }

        guard ZaliCore.shared.packMessage(sender: sender, text: text, output: tempPath, key: key,
                                          keyVersion: keyVersion, attachments: packedAttachments) else {
            tempAttachmentURLs.forEach { try? FileManager.default.removeItem(at: $0) }
            inFlightSendClientIds.remove(clientId)
            sendBusEvent("on_send_error", payload: ["clientId": clientId, "statusCode": 0,
                                                     "responseBody": "Core: Ошибка при упаковке сообщения в Rust бэкенде"])
            return
        }
        tempAttachmentURLs.forEach { try? FileManager.default.removeItem(at: $0) }

        let fileURL = URL(fileURLWithPath: tempPath)
        uploadMessage(sender: sender, receiver: recipient, clientId: clientId, fileURL: fileURL,
                     serverId: serverId, channelId: channelId, keyVersion: keyVersion) { [weak self] success, messageId, statusCode, responseBody in
            guard let self else { return }
            self.inFlightSendClientIds.remove(clientId)
            if success {
                self.sendBusEvent("on_send_success", payload: ["clientId": clientId, "messageId": messageId ?? ""])
            } else {
                self.sendBusEvent("on_send_error", payload: [
                    "clientId": clientId,
                    "statusCode": statusCode ?? 0,
                    "responseBody": (responseBody ?? "").trimmingCharacters(in: .whitespacesAndNewlines),
                ])
            }
            try? FileManager.default.removeItem(at: fileURL)
        }
    }

    private func decodedDataURL(_ value: String) -> (data: Data, mimeType: String, fileExtension: String) {
        let maxDataURLBytes = 100 * 1024 * 1024 // 100 MB
        guard value.utf8.count <= maxDataURLBytes,
              value.hasPrefix("data:"),
              let comma = value.firstIndex(of: ",") else {
            return (Data(), "application/octet-stream", "bin")
        }
        let meta = String(value[value.index(after: value.startIndex)..<comma])
        let payload = String(value[value.index(after: comma)...])
        let mimeType = meta.split(separator: ";").first.map(String.init) ?? "application/octet-stream"
        let fileExtension: String
        switch mimeType {
        case "image/png": fileExtension = "png"
        case "image/jpeg", "image/jpg": fileExtension = "jpg"
        case "image/gif": fileExtension = "gif"
        case "image/webp": fileExtension = "webp"
        case "video/mp4": fileExtension = "mp4"
        case "video/webm": fileExtension = "webm"
        default: fileExtension = "bin"
        }
        return (Data(base64Encoded: payload) ?? Data(), mimeType, fileExtension)
    }

    private func safeFileName(_ name: String, fallbackExtension: String) -> String {
        let invalid = CharacterSet(charactersIn: "/\\:?%*|\"<>")
        let cleaned = name.components(separatedBy: invalid).joined(separator: "_")
        return cleaned.isEmpty ? "attachment.\(fallbackExtension)" : cleaned
    }

    /// Multipart upload to `/api/upload`, mirroring macOS `NetworkService.uploadMessage`.
    private func uploadMessage(
        sender: String, receiver: String, clientId: String, fileURL: URL,
        serverId: String?, channelId: String?, keyVersion: Int,
        completion: @escaping (Bool, String?, Int?, String?) -> Void
    ) {
        guard let uploadURL = URL(string: apiBaseURL + "/api/upload") else {
            completion(false, nil, nil, "invalid upload URL")
            return
        }
        var request = URLRequest(url: uploadURL)
        request.httpMethod = "POST"
        if !wsAuthToken.isEmpty { request.setValue("Bearer \(wsAuthToken)", forHTTPHeaderField: "Authorization") }
        if !wsDeviceId.isEmpty { request.setValue(wsDeviceId, forHTTPHeaderField: "X-Zali-Device-ID") }

        let boundary = "Boundary-\(UUID().uuidString)"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")

        let bodyURL = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("upload-\(UUID().uuidString).multipart")
        guard FileManager.default.createFile(atPath: bodyURL.path, contents: nil) else {
            completion(false, nil, nil, "failed to create multipart body")
            return
        }

        do {
            let handle = try FileHandle(forWritingTo: bodyURL)
            defer { try? handle.close() }
            func write(_ string: String) throws {
                guard let data = string.data(using: .utf8) else { return }
                try handle.write(contentsOf: data)
            }
            try write("--\(boundary)\r\n")
            try write("Content-Disposition: form-data; name=\"sender\"\r\n\r\n\(sender)\r\n")
            try write("--\(boundary)\r\n")
            try write("Content-Disposition: form-data; name=\"client_id\"\r\n\r\n\(clientId)\r\n")
            try write("--\(boundary)\r\n")
            try write("Content-Disposition: form-data; name=\"key_version\"\r\n\r\n\(max(1, keyVersion))\r\n")
            try write("--\(boundary)\r\n")
            try write("Content-Disposition: form-data; name=\"receiver\"\r\n\r\n\(receiver)\r\n")
            if let serverId, !serverId.isEmpty, let channelId, !channelId.isEmpty {
                try write("--\(boundary)\r\n")
                try write("Content-Disposition: form-data; name=\"server_id\"\r\n\r\n\(serverId)\r\n")
                try write("--\(boundary)\r\n")
                try write("Content-Disposition: form-data; name=\"channel_id\"\r\n\r\n\(channelId)\r\n")
            }
            try write("--\(boundary)\r\n")
            try write("Content-Disposition: form-data; name=\"file\"; filename=\"msg.zali\"\r\n")
            try write("Content-Type: application/octet-stream\r\n\r\n")

            let inputHandle = try FileHandle(forReadingFrom: fileURL)
            defer { try? inputHandle.close() }
            while true {
                let chunk = try inputHandle.read(upToCount: 64 * 1024) ?? Data()
                if chunk.isEmpty { break }
                try handle.write(contentsOf: chunk)
            }
            try write("\r\n")
            try write("--\(boundary)--\r\n")
        } catch {
            try? FileManager.default.removeItem(at: bodyURL)
            completion(false, nil, nil, "failed to build multipart body")
            return
        }

        apiSession.uploadTask(with: request, fromFile: bodyURL) { data, response, error in
            Task { @MainActor in
                try? FileManager.default.removeItem(at: bodyURL)
                if let error {
                    completion(false, nil, nil, error.localizedDescription)
                    return
                }
                guard let httpResponse = response as? HTTPURLResponse else {
                    completion(false, nil, nil, "no response")
                    return
                }
                let bodyPreview = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
                if httpResponse.statusCode == 201 {
                    let messageId = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }?["id"] as? String
                    completion(true, messageId, httpResponse.statusCode, bodyPreview)
                } else {
                    completion(false, nil, httpResponse.statusCode, bodyPreview)
                }
            }
        }.resume()
    }

    /// Delivers a bus event (send success/error) into the JS bus — same envelope
    /// macOS's `sendBusEvent` uses (`zali_interface:on_send_success/on_send_error`).
    private func sendBusEvent(_ event: String, payload: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.loader && window.loader.bus.send('zali_interface:\(event)', \(json));", completionHandler: nil)
    }

    // MARK: - WebSocket connect / reconnect / heartbeat

    private func wsURL() -> URL? {
        let ws: String
        if apiBaseURL.hasPrefix("https://") {
            ws = "wss://" + apiBaseURL.dropFirst("https://".count) + "/ws"
        } else if apiBaseURL.hasPrefix("http://") {
            ws = "ws://" + apiBaseURL.dropFirst("http://".count) + "/ws"
        } else {
            ws = "wss://msgs.zalikus.org/ws"
        }
        return URL(string: ws)
    }

    private func connectWebSocket() {
        wsReconnectWorkItem?.cancel()
        wsReconnectWorkItem = nil
        wsHeartbeatWorkItem?.cancel()
        wsHeartbeatWorkItem = nil
        wsReceiveTask?.cancel()
        wsReceiveTask = nil
        wsGeneration += 1
        let generation = wsGeneration

        guard !wsAuthToken.isEmpty, let url = wsURL() else { return }
        wsTask?.cancel(with: .goingAway, reason: nil)
        let session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
        wsSession = session
        var request = URLRequest(url: url)
        request.setValue("Bearer \(wsAuthToken)", forHTTPHeaderField: "Authorization")
        if !wsDeviceId.isEmpty {
            request.setValue(wsDeviceId, forHTTPHeaderField: "X-Zali-Device-ID")
        }
        let task = session.webSocketTask(with: request)
        wsTask = task
        task.resume()
        listenWebSocket(generation: generation)
    }

    private func scheduleWsReconnect(generation: Int) {
        guard generation == wsGeneration else { return }
        setConnectionStatusJS(false)
        wsHeartbeatWorkItem?.cancel()
        wsHeartbeatWorkItem = nil
        wsReconnectWorkItem?.cancel()
        wsReconnectAttempt = min(wsReconnectAttempt + 1, 6)
        let baseDelay = min(pow(2.0, Double(wsReconnectAttempt - 1)) * 1.5, 30.0)
        let delay = baseDelay + Double.random(in: 0...0.75)
        let workItem = DispatchWorkItem { [weak self] in
            guard let self, generation == self.wsGeneration else { return }
            self.connectWebSocket()
        }
        wsReconnectWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: workItem)
    }

    private func scheduleWsHeartbeat(generation: Int) {
        wsHeartbeatWorkItem?.cancel()
        let workItem = DispatchWorkItem { [weak self] in
            guard let self, generation == self.wsGeneration, let task = self.wsTask else { return }
            task.sendPing { [weak self] error in
                Task { @MainActor in
                    guard let self, generation == self.wsGeneration else { return }
                    if error != nil {
                        self.scheduleWsReconnect(generation: generation)
                        return
                    }
                    self.scheduleWsHeartbeat(generation: generation)
                }
            }
        }
        wsHeartbeatWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + 25, execute: workItem)
    }

    private func listenWebSocket(generation: Int) {
        guard let task = wsTask else { return }
        wsReceiveTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                guard await MainActor.run(body: { generation == self.wsGeneration }) else { return }
                do {
                    let message = try await task.receive()
                    guard await MainActor.run(body: { generation == self.wsGeneration }) else { return }
                    switch message {
                    case .string(let text):
                        await MainActor.run { self.handleWsFrame(text) }
                    case .data(let data):
                        if let text = String(data: data, encoding: .utf8) {
                            await MainActor.run { self.handleWsFrame(text) }
                        }
                    @unknown default:
                        break
                    }
                } catch {
                    await MainActor.run { self.scheduleWsReconnect(generation: generation) }
                    return
                }
            }
        }
    }

    /// Dispatches a decoded WS frame. Message-envelope frames (id/sender/receiver,
    /// no `type` field — matches macOS's `WsMessage`) trigger a download + decrypt
    /// via `ZaliCore`; everything else here carries plaintext metadata already.
    private func handleWsFrame(_ text: String) {
        guard let data = text.data(using: .utf8),
              let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        let type = raw["type"] as? String ?? ""
        switch type {
        case "avatar_updated", "avatar_deleted":
            guard let username = raw["username"] as? String, !username.isEmpty,
                  let arg = jsStringLiteral(username) else { return }
            let fn = (type == "avatar_updated") ? "avatarUpdated" : "avatarDeleted"
            webView.evaluateJavaScript("window.\(fn) && window.\(fn)(\(arg));", completionHandler: nil)
        case "reaction_updated":
            guard let payloadData = try? JSONSerialization.data(withJSONObject: raw),
                  let payloadJSON = String(data: payloadData, encoding: .utf8) else { return }
            webView.evaluateJavaScript("window.receiveReactionUpdate && window.receiveReactionUpdate(\(payloadJSON));", completionHandler: nil)
        case "key_envelope_available":
            webView.evaluateJavaScript("window.refreshAfterKey && window.refreshAfterKey();", completionHandler: nil)
        case "":
            if let id = raw["id"] as? String, !id.isEmpty,
               let sender = raw["sender"] as? String, let receiver = raw["receiver"] as? String {
                let serverId = (raw["serverId"] as? String) ?? (raw["server_id"] as? String)
                let channelId = (raw["channelId"] as? String) ?? (raw["channel_id"] as? String)
                downloadAndDecryptMessage(id: id, sender: sender, receiver: receiver,
                                          serverId: serverId, channelId: channelId)
            }
        default:
            break
        }
    }

    // MARK: - DM history load (REFRESH_HISTORY)
    //
    // Ported from macOS's `.refreshHistory` IPC case + `WebView.reloadHistory(for:)` /
    // `NetworkService.fetchMessages`. `Web/src/interface.js` sends this whenever a
    // chat is opened or refreshed (`syncActiveConversation()`, `refreshAfterKey()`)
    // — until this handler existed, it was silently dropped here, so DM history
    // never loaded on iOS ("Начните диалог" for every real contact).
    private var historyReloadToken = 0

    private func handleRefreshHistory(_ dict: [String: Any]) {
        if let key = dict["key"] as? String, !key.isEmpty { currentE2eKey = key }
        guard let peer = (dict["peer"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !peer.isEmpty else { return }
        historyReloadToken += 1
        let token = historyReloadToken
        fetchMessagesPage(username: peer, limit: 200, offset: 0, accumulated: []) { [weak self] records, ok in
            guard let self, token == self.historyReloadToken else { return }
            guard ok else { return } // transient fetch failure — keep whatever's already shown
            guard !records.isEmpty else {
                self.webView.evaluateJavaScript("window.loadHistory && window.loadHistory([]);", completionHandler: nil)
                return
            }
            self.renderHistoryRecords(records: records, peer: peer, token: token) { rendered in
                guard token == self.historyReloadToken,
                      let jsonData = try? JSONSerialization.data(withJSONObject: rendered),
                      let json = String(data: jsonData, encoding: .utf8) else { return }
                self.webView.evaluateJavaScript("window.loadHistory && window.loadHistory(\(json));", completionHandler: nil)
            }
        }
    }

    /// `GET /api/messages/{user}?limit&offset`, same pagination as macOS's
    /// `fetchMessagesPage` — recurse while a page comes back full.
    private func fetchMessagesPage(
        username: String, limit: Int, offset: Int, accumulated: [[String: Any]],
        completion: @escaping ([[String: Any]], Bool) -> Void
    ) {
        guard let encodedUser = username.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))),
              var components = URLComponents(string: apiBaseURL + "/api/messages/" + encodedUser) else {
            completion(accumulated, false)
            return
        }
        components.queryItems = [URLQueryItem(name: "limit", value: String(limit)), URLQueryItem(name: "offset", value: String(offset))]
        guard let url = components.url else {
            completion(accumulated, false)
            return
        }
        var request = URLRequest(url: url)
        if !wsAuthToken.isEmpty { request.setValue("Bearer \(wsAuthToken)", forHTTPHeaderField: "Authorization") }

        apiSession.dataTask(with: request) { [weak self] data, response, error in
            guard let self else { return }
            guard error == nil, let data, let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
                  let page = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]] else {
                Task { @MainActor in completion(accumulated, false) }
                return
            }
            let merged = accumulated + page
            Task { @MainActor in
                if page.count < limit {
                    completion(merged, true)
                } else {
                    self.fetchMessagesPage(username: username, limit: limit, offset: offset + limit, accumulated: merged, completion: completion)
                }
            }
        }.resume()
    }

    /// Sequentially downloads + decrypts every record (mirrors macOS's `for record in
    /// records { await ... }` — not parallel: a burst of many concurrent downloads
    /// previously saturated the connection pool and stalled every request, see
    /// `apiSession`'s doc comment above).
    private func renderHistoryRecords(
        records: [[String: Any]], peer: String, token: Int, completion: @escaping ([[String: Any]]) -> Void
    ) {
        var rendered: [[String: Any]] = []
        func next(_ index: Int) {
            guard token == historyReloadToken else { return }
            guard index < records.count else {
                completion(rendered)
                return
            }
            renderHistoryRecord(record: records[index], peer: peer) { result in
                if let result { rendered.append(result) }
                next(index + 1)
            }
        }
        next(0)
    }

    private func renderHistoryRecord(record: [String: Any], peer: String, completion: @escaping ([String: Any]?) -> Void) {
        guard let messageId = (record["id"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !messageId.isEmpty else {
            completion(nil)
            return
        }
        let sender = (record["sender"] as? String) ?? peer
        let receiver = (record["receiver"] as? String) ?? peer
        let clientId = (record["clientId"] as? String) ?? (record["client_id"] as? String) ?? ""

        func placeholder(_ text: String) -> [String: Any] {
            [
                "id": messageId, "clientId": clientId, "sender": sender, "receiver": receiver,
                "text": text, "attachments": [],
                "timestamp": record["timestamp"] ?? NSNull(),
                "reactions": record["reactions"] ?? [],
                "myReactions": record["myReactions"] ?? [],
            ]
        }

        guard let encodedId = messageId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed),
              let url = URL(string: apiBaseURL + "/api/download/" + encodedId) else {
            completion(placeholder("⚠️ Не удалось загрузить сообщение"))
            return
        }
        var request = URLRequest(url: url)
        if !wsAuthToken.isEmpty { request.setValue("Bearer \(wsAuthToken)", forHTTPHeaderField: "Authorization") }

        apiSession.dataTask(with: request) { [weak self] data, response, _ in
            guard let self else { return }
            let http = response as? HTTPURLResponse
            Task { @MainActor in
                if http?.statusCode == 413 {
                    completion(placeholder("📦 Файл сообщения превышает допустимый размер"))
                    return
                }
                guard let data, let http, (200..<300).contains(http.statusCode) else {
                    completion(placeholder("⚠️ Не удалось загрузить сообщение"))
                    return
                }

                let workDirName = UUID().uuidString
                let archivePath = NSTemporaryDirectory() + workDirName + ".zali"
                let tempDir = NSTemporaryDirectory() + workDirName + "-unpack"
                defer {
                    try? FileManager.default.removeItem(atPath: archivePath)
                    try? FileManager.default.removeItem(atPath: tempDir)
                }
                guard (try? data.write(to: URL(fileURLWithPath: archivePath))) != nil else {
                    completion(placeholder("⚠️ Не удалось загрузить сообщение"))
                    return
                }
                try? FileManager.default.createDirectory(atPath: tempDir, withIntermediateDirectories: true)

                // Same candidate-key list as macOS's renderHistoryRecord: the
                // conversation-scoped key plus every other known conversation key
                // as a last resort (covers a stale/renamed scope).
                var keys = ZaliCore.candidateMessageKeys(
                    currentKey: self.currentE2eKey, conversationKeys: self.conversationKeys,
                    participantA: sender, participantB: receiver
                )
                for value in self.conversationKeys.values {
                    let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !normalized.isEmpty, !keys.contains(normalized) { keys.append(normalized) }
                }

                guard let payload = ZaliCore.shared.unpackMessage(archivePath: archivePath, tempDir: tempDir, keys: keys) else {
                    completion(placeholder("🔒 Сообщение зашифровано другим ключом"))
                    return
                }

                let attachments: [[String: Any]] = (payload.attachments ?? []).compactMap { attachment in
                    var renderedAttachment: [String: Any] = [
                        "name": attachment.name, "mimeType": attachment.mimeType,
                        "kind": attachment.kind, "size": attachment.size,
                    ]
                    let attachmentURL = URL(fileURLWithPath: tempDir).appendingPathComponent(attachment.archivePath)
                    if attachment.size <= 2 * 1024 * 1024, let fileData = try? Data(contentsOf: attachmentURL) {
                        renderedAttachment["dataUrl"] = "data:\(attachment.mimeType);base64,\(fileData.base64EncodedString())"
                    }
                    return renderedAttachment
                }

                completion([
                    "id": messageId, "clientId": clientId, "sender": payload.sender, "receiver": receiver,
                    "text": payload.text, "attachments": attachments,
                    "timestamp": record["timestamp"] ?? NSNull(),
                    "reactions": record["reactions"] ?? [],
                    "myReactions": record["myReactions"] ?? [],
                ])
            }
        }.resume()
    }

    // MARK: - Message download + decrypt (ZaliCore)

    /// Downloads the `.zali` archive for a WS-pushed message envelope and hands it
    /// to `decryptAndDeliver`. Server-side authorization (the download endpoint only
    /// serves archives the caller is entitled to) is the relevance filter — no
    /// client-side "is this addressed to me" check before downloading.
    private func downloadAndDecryptMessage(id: String, sender: String, receiver: String,
                                           serverId: String?, channelId: String?) {
        guard let encodedId = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed),
              let url = URL(string: apiBaseURL + "/api/download/" + encodedId) else { return }
        var request = URLRequest(url: url)
        if !wsAuthToken.isEmpty {
            request.setValue("Bearer \(wsAuthToken)", forHTTPHeaderField: "Authorization")
        }
        apiSession.dataTask(with: request) { [weak self] data, response, _ in
            guard let self, let data,
                  let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { return }
            Task { @MainActor in
                self.decryptAndDeliver(archiveData: data, id: id, sender: sender, receiver: receiver,
                                       serverId: serverId, channelId: channelId)
            }
        }.resume()
    }

    /// Unpacks + decrypts a downloaded `.zali` archive via `ZaliCore` (Rust Core
    /// FFI) and hands the plaintext to `window.receiveMessage(...)`. Tries every
    /// candidate key for the conversation (current key, scoped conversation key,
    /// in that order — see `ZaliCore.candidateMessageKeys`); a message encrypted
    /// under a key we don't have (not yet synced, wrong device) is silently
    /// dropped, matching macOS's behavior for the same case.
    private func decryptAndDeliver(archiveData: Data, id: String, sender: String, receiver: String,
                                   serverId: String?, channelId: String?) {
        let workDirName = UUID().uuidString
        let archivePath = NSTemporaryDirectory() + workDirName + ".zali"
        let tempDir = NSTemporaryDirectory() + workDirName + "-unpack"
        defer {
            try? FileManager.default.removeItem(atPath: archivePath)
            try? FileManager.default.removeItem(atPath: tempDir)
        }
        guard (try? archiveData.write(to: URL(fileURLWithPath: archivePath))) != nil else { return }
        try? FileManager.default.createDirectory(atPath: tempDir, withIntermediateDirectories: true)

        let keys = ZaliCore.candidateMessageKeys(
            currentKey: currentE2eKey, conversationKeys: conversationKeys,
            participantA: sender, participantB: receiver, serverId: serverId, channelId: channelId
        )
        guard let payload = ZaliCore.shared.unpackMessage(archivePath: archivePath, tempDir: tempDir, keys: keys) else { return }

        let attachments: [[String: Any]] = (payload.attachments ?? []).compactMap { attachment in
            var rendered: [String: Any] = [
                "name": attachment.name,
                "mimeType": attachment.mimeType,
                "kind": attachment.kind,
                "size": attachment.size,
            ]
            // Inline small attachments as a data: URL so the UI can render them
            // immediately, same 2 MB threshold as macOS's handleWebSocketMessage.
            let attachmentURL = URL(fileURLWithPath: tempDir).appendingPathComponent(attachment.archivePath)
            if attachment.size <= 2 * 1024 * 1024, let fileData = try? Data(contentsOf: attachmentURL) {
                rendered["dataUrl"] = "data:\(attachment.mimeType);base64,\(fileData.base64EncodedString())"
            }
            return rendered
        }

        var messagePayload: [String: Any] = [
            "id": id,
            "sender": payload.sender,
            "receiver": receiver,
            "text": payload.text,
            "attachments": attachments,
        ]
        if let serverId { messagePayload["serverId"] = serverId }
        if let channelId { messagePayload["channelId"] = channelId }

        guard let jsonData = try? JSONSerialization.data(withJSONObject: messagePayload),
              let json = String(data: jsonData, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.receiveMessage && window.receiveMessage(\(json));", completionHandler: nil)
    }

    private func jsStringLiteral(_ value: String) -> String? {
        guard let data = try? JSONSerialization.data(withJSONObject: [value]),
              let arrayJSON = String(data: data, encoding: .utf8) else { return nil }
        return String(arrayJSON.dropFirst().dropLast())
    }

    private func setConnectionStatusJS(_ connected: Bool) {
        webView.evaluateJavaScript("window.setConnectionStatus && window.setConnectionStatus(\(connected));", completionHandler: nil)
    }

    nonisolated func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                                didOpenWithProtocol protocol: String?) {
        Task { @MainActor in
            // Guard against a stale callback from a superseded task (e.g. the server
            // address changed and connectWebSocket() already created a new one) —
            // without this, an old task's late didOpen could reset the reconnect
            // backoff for a connection that isn't even the current one.
            guard webSocketTask === self.wsTask else { return }
            self.wsReconnectAttempt = 0
            self.setConnectionStatusJS(true)
            self.scheduleWsHeartbeat(generation: self.wsGeneration)
        }
    }

    nonisolated func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                                didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        Task { @MainActor in
            guard webSocketTask === self.wsTask else { return }
            self.scheduleWsReconnect(generation: self.wsGeneration)
        }
    }

    /// Delivers a native bridge response into the JS bus (`onNativeResponse` in
    /// `Web/src/interface.js`, listening on `zali_interface:native_response`).
    private func sendNativeResponse(_ payload: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        let js = "window.loader && window.loader.bus.send('zali_interface:native_response', \(json));"
        webView.evaluateJavaScript(js, completionHandler: nil)
    }

    /// Loads the bundled shared web UI. The `Web` folder (index.html, style.css,
    /// app.js — produced by `bundle_web.py`) is copied into the app bundle as a
    /// folder reference named `Web` (see project.yml / README).
    func loadBundledUI() {
        guard let root = Bundle.main.url(forResource: "index",
                                         withExtension: "html",
                                         subdirectory: "Web") else {
            webView.loadHTMLString("<h2 style='color:#fff;font-family:-apple-system'>Web bundle missing — run scripts/bundle_web.py and add Web/ to the target.</h2>",
                                   baseURL: nil)
            return
        }
        let dir = root.deletingLastPathComponent()
        webView.loadFileURL(root, allowingReadAccessTo: dir)
    }

    /// Switch the visible section by driving the shared web UI.
    func select(_ tab: ZaliTab) {
        webView.evaluateJavaScript("window.__zaliSelectTab && window.__zaliSelectTab('\(tab.rawValue)');",
                                   completionHandler: nil)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        webView.evaluateJavaScript("document.body && document.body.getAttribute('data-ui-v2')") { [weak self] value, _ in
            let on = (value as? String) == "on"
            self?.includeHub = on
        }
    }
}

/// Breaks the retain cycle `WKUserContentController.add(_:name:)` would otherwise
/// create by holding only a weak reference to the real handler.
private final class WeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
    private weak var target: WKScriptMessageHandler?

    init(_ target: WKScriptMessageHandler) {
        self.target = target
    }

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        target?.userContentController(userContentController, didReceive: message)
    }
}

/// Bridges the shared `WKWebView` into SwiftUI. `makeUIView` returns the store's
/// single instance so the web view is never rebuilt.
struct WebView: UIViewRepresentable {
    @ObservedObject var store: WebViewStore

    func makeUIView(context: Context) -> WKWebView { store.webView }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
