import SwiftUI
import WebKit
import CoreBridge

class ZaliNativeWebView: WKWebView {
    override var acceptsFirstResponder: Bool { true }
    override var canBecomeKeyView: Bool { true }
    
    override func mouseDown(with event: NSEvent) {
        self.window?.makeFirstResponder(self)
        super.mouseDown(with: event)
    }

    override func keyDown(with event: NSEvent) {
        super.keyDown(with: event)
    }
    
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        self.window?.makeKeyAndOrderFront(nil)
    }
}

struct WebView: NSViewRepresentable {
    private static let sharedMessageKey = ZaliCore.sharedMessageKey
    class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
        weak var webView: WKWebView?
        private var directHistoryReloadToken = UUID()
        private var serverHistoryReloadToken = UUID()

        private struct TenorResolvedPayload: Codable {
            let requestId: String
            let sourceUrl: String
            let mediaUrl: String?
            let mimeType: String?
            let kind: String?
        }

        private func decodedDataURL(_ value: String) -> (data: Data, mimeType: String, fileExtension: String) {
            guard value.hasPrefix("data:"),
                  let comma = value.firstIndex(of: ",") else {
                return (Data(), "application/octet-stream", "bin")
            }

            let meta = String(value[value.index(after: value.startIndex)..<comma])
            let payload = String(value[value.index(after: comma)...])
            let mimeType = meta.split(separator: ";").first.map(String.init) ?? "application/octet-stream"
            let fileExtension: String
            switch mimeType {
            case "image/png": fileExtension = "png"
            case "image/jpeg": fileExtension = "jpg"
            case "image/jpg": fileExtension = "jpg"
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
            if cleaned.isEmpty {
                return "attachment.\(fallbackExtension)"
            }
            return cleaned
        }

        private func inferMimeType(from url: String) -> String {
            let lower = url.lowercased()
            if lower.contains(".mp4") { return "video/mp4" }
            if lower.contains(".webm") { return "video/webm" }
            if lower.contains(".gif") { return "image/gif" }
            if lower.contains(".webp") { return "image/webp" }
            if lower.contains(".png") { return "image/png" }
            if lower.contains(".jpg") || lower.contains(".jpeg") { return "image/jpeg" }
            return "application/octet-stream"
        }

        private func inferKind(from mimeType: String) -> String {
            if mimeType.hasPrefix("video/") { return "video" }
            if mimeType == "image/gif" { return "gif" }
            if mimeType.hasPrefix("image/") { return "image" }
            return "file"
        }

        private static func makeDataURL(data: Data, mimeType: String) -> String {
            let base64 = data.base64EncodedString()
            return "data:\(mimeType);base64,\(base64)"
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
                    let mimeType = inferMimeType(from: raw)
                    return (raw, mimeType, inferKind(from: mimeType))
                }
            }

            return (nil, nil, nil)
        }

        private func resolveTenor(url: String, requestId: String) {
            guard let pageURL = URL(string: url) else {
                self.emitTenorResolution(requestId: requestId, sourceUrl: url, mediaUrl: nil, mimeType: nil, kind: nil)
                return
            }

            var request = URLRequest(url: pageURL)
            request.setValue("text/html,application/xhtml+xml", forHTTPHeaderField: "Accept")
            request.setValue("Mozilla/5.0", forHTTPHeaderField: "User-Agent")

            URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
                guard let self = self, error == nil, let data = data, !data.isEmpty else {
                    self?.emitTenorResolution(requestId: requestId, sourceUrl: url, mediaUrl: nil, mimeType: nil, kind: nil)
                    return
                }

                let html = String(decoding: data, as: UTF8.self)
                let resolved = self.extractTenorMediaURL(from: html)
                self.emitTenorResolution(requestId: requestId, sourceUrl: url, mediaUrl: resolved.mediaUrl, mimeType: resolved.mimeType, kind: resolved.kind)
            }.resume()
        }

        private func emitTenorResolution(requestId: String, sourceUrl: String, mediaUrl: String?, mimeType: String?, kind: String?) {
            let payload = TenorResolvedPayload(
                requestId: requestId,
                sourceUrl: sourceUrl,
                mediaUrl: mediaUrl,
                mimeType: mimeType,
                kind: kind
            )
            guard let json = try? JSONEncoder().encode(payload),
                  let jsonString = String(data: json, encoding: .utf8) else {
                return
            }

            DispatchQueue.main.async {
                self.webView?.evaluateJavaScript("window.loader?.bus?.send('zali_interface:tenor_resolved', \(WebView.javascriptLiteral(jsonString)))")
            }
        }

        private func saveAttachment(dataUrl: String, filename: String) {
            let decoded = decodedDataURL(dataUrl)
            guard !decoded.data.isEmpty else { return }

            let panel = NSSavePanel()
            panel.nameFieldStringValue = safeFileName(filename, fallbackExtension: decoded.fileExtension)
            panel.canCreateDirectories = true
            panel.isExtensionHidden = false
            panel.title = "Сохранить вложение"
            panel.message = "Выберите место для сохранения файла"

            DispatchQueue.main.async {
                panel.begin { response in
                    guard response == .OK, let destination = panel.url else { return }
                    do {
                        try decoded.data.write(to: destination, options: [.atomic])
                    } catch {
                        NSLog("Failed to save attachment: \(error.localizedDescription)")
                    }
                }
            }
        }

        private func reloadHistory(for username: String) {
            print("[ZALI][WEBVIEW] reloadHistory start user=\(username) keySet=\(!NetworkService.shared.currentKey.isEmpty)")
            let reloadToken = UUID()
            directHistoryReloadToken = reloadToken
            NetworkService.shared.fetchMessages(for: username) { [weak self] records in
                guard let self = self else { return }
                guard self.directHistoryReloadToken == reloadToken else { return }
                print("[ZALI][WEBVIEW] reloadHistory fetched user=\(username) count=\(records.count)")

                guard !records.isEmpty else {
                    DispatchQueue.main.async {
                        guard self.directHistoryReloadToken == reloadToken else { return }
                        self.webView?.evaluateJavaScript("window.loadHistory && window.loadHistory([])")
                    }
                    print("[ZALI][WEBVIEW] reloadHistory empty user=\(username)")
                    return
                }

                var renderedMessages: [[String: Any]] = []

                func processRecord(at index: Int) {
                    guard self.directHistoryReloadToken == reloadToken else { return }
                    guard index < records.count else {
                        renderedMessages.sort {
                            let lhs = ($0["timestamp"] as? String) ?? ""
                            let rhs = ($1["timestamp"] as? String) ?? ""
                            return lhs < rhs
                        }

                        let encodedHistory = WebView.javascriptLiteral(renderedMessages)
                        DispatchQueue.main.async {
                            guard self.directHistoryReloadToken == reloadToken else { return }
                            self.webView?.evaluateJavaScript("window.loadHistory && window.loadHistory(\(encodedHistory))")
                        }
                        print("[ZALI][WEBVIEW] reloadHistory dispatch user=\(username) rendered=\(renderedMessages.count)")
                        return
                    }

                    let record = records[index]
                    NetworkService.shared.downloadMessage(messageId: record.id) { fileURL in
                        guard self.directHistoryReloadToken == reloadToken else { return }

                        defer {
                            processRecord(at: index + 1)
                        }

                        guard let fileURL = fileURL else { return }

                        autoreleasepool {
                            let tempDirName = UUID().uuidString
                            let tempDir = (NSTemporaryDirectory() as NSString).appendingPathComponent(tempDirName)
                            try? FileManager.default.createDirectory(atPath: tempDir, withIntermediateDirectories: true)

                            defer {
                                try? FileManager.default.removeItem(at: fileURL)
                                try? FileManager.default.removeItem(atPath: tempDir)
                            }

                            guard let unpacked = ZaliCore.shared.unpackMessage(
                                archivePath: fileURL.path,
                                tempDir: tempDir,
                                keys: [
                                    NetworkService.shared.currentKey,
                                    ZaliCore.conversationMessageKey(participantA: record.sender, participantB: record.receiver),
                                    WebView.sharedMessageKey
                                ]
                            ) else {
                                print("[ZALI][WEBVIEW] unpack failed messageId=\(record.id) user=\(username) keySet=\(!NetworkService.shared.currentKey.isEmpty) sharedKeySet=\(!WebView.sharedMessageKey.isEmpty)")
                                return
                            }

                            let renderedAttachments = (unpacked.attachments ?? []).compactMap { attachment -> [String: Any]? in
                                let attachmentURL = URL(fileURLWithPath: tempDir).appendingPathComponent(attachment.archivePath)
                                guard let data = try? Data(contentsOf: attachmentURL) else { return nil }

                                return [
                                    "name": attachment.name,
                                    "mimeType": attachment.mimeType,
                                    "kind": attachment.kind,
                                    "size": attachment.size,
                                    "dataUrl": Self.makeDataURL(data: data, mimeType: attachment.mimeType)
                                ]
                            }

                            renderedMessages.append([
                                "id": record.id,
                                "clientId": record.clientId ?? record.client_id ?? "",
                                "sender": unpacked.sender,
                                "receiver": record.receiver,
                                "text": unpacked.text,
                                "attachments": renderedAttachments,
                                "timestamp": record.timestamp,
                                "reactions": record.reactions ?? [],
                                "myReaction": record.myReaction ?? ""
                            ])
                        }
                    }
                }

                processRecord(at: 0)
            }
        }

        private func syncCryptoKeyFromWebUI(reason: String, completion: @escaping () -> Void) {
            guard let webView = self.webView else {
                completion()
                return
            }

            let script = """
            (function () {
                try {
                    const input = document.getElementById('inputCryptoKey');
                    return String((window.__ZALI_SAVED_KEY || (input && input.value) || '')).trim();
                } catch (e) {
                    return '';
                }
            })()
            """

            webView.evaluateJavaScript(script) { result, error in
                defer { completion() }

                if let error = error {
                    print("[ZALI][WEBVIEW] syncCryptoKey reason=\(reason) evalError=\(error.localizedDescription)")
                    return
                }

                let key = ((result as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)).isEmpty
                    ? "ZALI_SECRET_E2E_KEY_2026"
                    : (result as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                let currentKey = NetworkService.shared.currentKey.trimmingCharacters(in: .whitespacesAndNewlines)
                print("[ZALI][WEBVIEW] syncCryptoKey reason=\(reason) keySet=\(!key.isEmpty) currentKeySet=\(!currentKey.isEmpty)")

                if currentKey != key {
                    NetworkService.shared.currentKey = key
                    UserDefaults.standard.set(key, forKey: "zali_crypto_key_v1")
                    print("[ZALI][WEBVIEW] syncCryptoKey updated reason=\(reason) length=\(key.count)")
                }
            }
        }

        private func isDirectMessageKey(_ key: String) -> Bool {
            key.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("zali-e2e:v1:dm:")
        }

        private func reloadServerHistory(serverId: String, channelId: String) {
            print("[ZALI][WEBVIEW] reloadServerHistory start server=\(serverId) channel=\(channelId)")
            let reloadToken = UUID()
            serverHistoryReloadToken = reloadToken
            NetworkService.shared.fetchServerMessages(serverId: serverId, channelId: channelId) { [weak self] records in
                guard let self = self else { return }
                guard self.serverHistoryReloadToken == reloadToken else { return }
                print("[ZALI][WEBVIEW] reloadServerHistory fetched server=\(serverId) channel=\(channelId) count=\(records.count)")

                guard !records.isEmpty else {
                    DispatchQueue.main.async {
                        guard self.serverHistoryReloadToken == reloadToken else { return }
                        self.webView?.evaluateJavaScript(
                            "window.loadServerHistory && window.loadServerHistory(\(WebView.javascriptLiteral(serverId)), \(WebView.javascriptLiteral(channelId)), [])"
                        )
                    }
                    print("[ZALI][WEBVIEW] reloadServerHistory empty server=\(serverId) channel=\(channelId)")
                    return
                }

                var renderedMessages: [[String: Any]] = []

                func processRecord(at index: Int) {
                    guard self.serverHistoryReloadToken == reloadToken else { return }
                    guard index < records.count else {
                        renderedMessages.sort {
                            let lhs = ($0["timestamp"] as? String) ?? ""
                            let rhs = ($1["timestamp"] as? String) ?? ""
                            return lhs < rhs
                        }

                        let encodedHistory = WebView.javascriptLiteral(renderedMessages)
                        let safeServerId = WebView.javascriptLiteral(serverId)
                        let safeChannelId = WebView.javascriptLiteral(channelId)
                        DispatchQueue.main.async {
                            guard self.serverHistoryReloadToken == reloadToken else { return }
                            self.webView?.evaluateJavaScript("window.loadServerHistory && window.loadServerHistory(\(safeServerId), \(safeChannelId), \(encodedHistory))")
                        }
                        print("[ZALI][WEBVIEW] reloadServerHistory dispatch server=\(serverId) channel=\(channelId) rendered=\(renderedMessages.count)")
                        return
                    }

                    let record = records[index]
                    NetworkService.shared.downloadMessage(messageId: record.id) { fileURL in
                        guard self.serverHistoryReloadToken == reloadToken else { return }

                        defer {
                            processRecord(at: index + 1)
                        }

                        guard let fileURL = fileURL else { return }

                        autoreleasepool {
                            let tempDirName = UUID().uuidString
                            let tempDir = (NSTemporaryDirectory() as NSString).appendingPathComponent(tempDirName)
                            try? FileManager.default.createDirectory(atPath: tempDir, withIntermediateDirectories: true)
                            let serverIdValue = record.serverId ?? record.server_id ?? serverId
                            let channelIdValue = record.channelId ?? record.channel_id ?? channelId

                            defer {
                                try? FileManager.default.removeItem(at: fileURL)
                                try? FileManager.default.removeItem(atPath: tempDir)
                            }

                            guard let unpacked = ZaliCore.shared.unpackMessage(
                                archivePath: fileURL.path,
                                tempDir: tempDir,
                                keys: [
                                    NetworkService.shared.currentKey,
                                    ZaliCore.conversationMessageKey(participantA: record.sender, participantB: record.receiver, serverId: serverIdValue, channelId: channelIdValue),
                                    WebView.sharedMessageKey
                                ]
                            ) else {
                                print("[ZALI][WEBVIEW] server unpack failed messageId=\(record.id) server=\(serverId) channel=\(channelId) keySet=\(!NetworkService.shared.currentKey.isEmpty) sharedKeySet=\(!WebView.sharedMessageKey.isEmpty)")
                                return
                            }

                            let renderedAttachments = (unpacked.attachments ?? []).compactMap { attachment -> [String: Any]? in
                                let attachmentURL = URL(fileURLWithPath: tempDir).appendingPathComponent(attachment.archivePath)
                                guard let data = try? Data(contentsOf: attachmentURL) else { return nil }

                                return [
                                    "name": attachment.name,
                                    "mimeType": attachment.mimeType,
                                    "kind": attachment.kind,
                                    "size": attachment.size,
                                    "dataUrl": Self.makeDataURL(data: data, mimeType: attachment.mimeType)
                                ]
                            }

                            renderedMessages.append([
                                "id": record.id,
                                "clientId": record.clientId ?? record.client_id ?? "",
                                "sender": unpacked.sender,
                                "receiver": record.receiver,
                                "text": unpacked.text,
                                "attachments": renderedAttachments,
                                "timestamp": record.timestamp,
                                "reactions": record.reactions ?? [],
                                "myReaction": record.myReaction ?? "",
                                "serverId": serverIdValue,
                                "channelId": channelIdValue
                            ])
                        }
                    }
                }

                processRecord(at: 0)
            }
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            if let dict = message.body as? [String: Any] {
                let type = dict["type"] as? String ?? ""
                let text = dict["text"] as? String ?? ""
                let clientId = dict["clientId"] as? String ?? UUID().uuidString
                let requestId = dict["requestId"] as? String ?? UUID().uuidString
                
                if type == "START_DRAG" {
                    DispatchQueue.main.async {
                        if let window = self.webView?.window, let event = NSApp.currentEvent {
                            window.performDrag(with: event)
                        }
                    }
                }

                if type == "DOWNLOAD_ATTACHMENT" {
                    let dataUrl = dict["dataUrl"] as? String ?? ""
                    let filename = dict["filename"] as? String ?? "attachment"
                    self.saveAttachment(dataUrl: dataUrl, filename: filename)
                }

                if type == "SAVE_PENDING_OUTBOX" {
                    let items = dict["items"] as? [[String: Any]] ?? []
                    if let data = try? JSONSerialization.data(withJSONObject: items, options: []),
                       let json = String(data: data, encoding: .utf8) {
                        NetworkService.shared.savePendingOutboxJSON(json)
                    } else {
                        NetworkService.shared.savePendingOutboxJSON("[]")
                    }
                }
                
                if type == "SEND_MESSAGE" {
                    let recipient = dict["recipient"] as? String ?? "Alice"
                    let sender = dict["sender"] as? String ?? NetworkService.shared.currentUser
                    let requestedKey = (dict["key"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                    let serverId = dict["serverId"] as? String
                    let channelId = dict["channelId"] as? String
                    let key = ZaliCore.conversationMessageKey(
                        participantA: sender,
                        participantB: recipient,
                        serverId: serverId,
                        channelId: channelId
                    )
                    let tempPath = NSTemporaryDirectory() + UUID().uuidString + ".zali"
                    let attachments = dict["attachments"] as? [[String: Any]] ?? []
                    var packedAttachments: [[String: Any]] = []
                    var tempAttachmentURLs: [URL] = []
                    print("[ZALI][WEBVIEW] SEND_MESSAGE start clientId=\(clientId) sender=\(sender) recipient=\(recipient) serverId=\(serverId ?? "nil") channelId=\(channelId ?? "nil") attachments=\(attachments.count) textBytes=\(text.count) requestedKeySet=\(!requestedKey.isEmpty) derivedKeySet=\(!key.isEmpty)")

                    for attachment in attachments {
                        guard let dataUrl = attachment["dataUrl"] as? String else { continue }
                        let name = attachment["name"] as? String ?? "attachment.bin"
                        let kind = attachment["kind"] as? String ?? "file"
                        let (data, mimeType, fileExtension) = self.decodedDataURL(dataUrl)
                        guard !data.isEmpty else { continue }

                        let safeName = self.safeFileName(name, fallbackExtension: fileExtension)
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
                            "size": (attachment["size"] as? NSNumber).map { $0.uint64Value } ?? UInt64(data.count)
                        ])
                    }
                    
                    if ZaliCore.shared.packMessage(sender: sender, text: text, output: tempPath, key: key, attachments: packedAttachments) {
                        DispatchQueue.main.async {
                            self.webView?.evaluateJavaScript("window.addLog('SUCCESS', 'Core: Сообщение успешно упаковано и зашифровано в Rust бэкенде')")
                        }
                        tempAttachmentURLs.forEach { try? FileManager.default.removeItem(at: $0) }
                        print("[ZALI][WEBVIEW] SEND_MESSAGE packed clientId=\(clientId) tempPath=\(tempPath) packedAttachments=\(packedAttachments.count)")
                        
                        let fileURL = URL(fileURLWithPath: tempPath)
                        NetworkService.shared.uploadMessage(sender: sender, receiver: recipient, clientId: clientId, fileURL: fileURL, serverId: serverId, channelId: channelId) { [weak self] success, messageId in
                            print("[ZALI][WEBVIEW] SEND_MESSAGE upload callback clientId=\(clientId) success=\(success) messageId=\(messageId ?? "nil")")
                            DispatchQueue.main.async {
                                let safeClientId = WebView.javascriptLiteral(clientId)
                                let safeMessageId = WebView.javascriptLiteral(messageId ?? "")
                                if success {
                                    self?.webView?.evaluateJavaScript("window.addLog('SUCCESS', 'Network: Сообщение отправлено на сервер')")
                                    self?.webView?.evaluateJavaScript("window.loader?.bus?.send('zali_interface:on_send_success', { clientId: \(safeClientId), messageId: \(safeMessageId) })")
                                } else {
                                    self?.webView?.evaluateJavaScript("window.addLog('ERROR', 'Network: Не удалось отправить сообщение на сервер')")
                                    self?.webView?.evaluateJavaScript("window.loader?.bus?.send('zali_interface:on_send_error', \(safeClientId))")
                                }
                            }
                            try? FileManager.default.removeItem(at: fileURL)
                        }
                    } else {
                        tempAttachmentURLs.forEach { try? FileManager.default.removeItem(at: $0) }
                        DispatchQueue.main.async {
                            self.webView?.evaluateJavaScript("window.addLog('ERROR', 'Core: Ошибка при упаковке сообщения в Rust бэкенде')")
                            let safeClientId = WebView.javascriptLiteral(clientId)
                            self.webView?.evaluateJavaScript("window.loader?.bus?.send('zali_interface:on_send_error', \(safeClientId))")
                        }
                    }
                }

                if type == "SET_SESSION" {
                    let username = dict["username"] as? String ?? "Zalikus"
                    let token = dict["token"] as? String
                    print("[ZALI][WEBVIEW] SET_SESSION username=\(username) tokenSet=\(!(token ?? "").isEmpty) currentUserBefore=\(NetworkService.shared.currentUser)")
                    NetworkService.shared.setSession(username: username, token: token) { [weak self] in
                        guard let self = self else { return }
                        print("[ZALI][WEBVIEW] SET_SESSION applied username=\(NetworkService.shared.currentUser) tokenSet=\(NetworkService.shared.currentKey.isEmpty ? "false" : "true")")

                        NetworkService.shared.fetchUsers { users in
                            let encodedUsers = WebView.javascriptLiteral(users)
                            DispatchQueue.main.async {
                                self.webView?.evaluateJavaScript("window.setUsers && window.setUsers(\(encodedUsers))")
                            }
                        }

                        NetworkService.shared.fetchContacts { contacts in
                            let encodedContacts = WebView.javascriptLiteral(contacts)
                            DispatchQueue.main.async {
                                self.webView?.evaluateJavaScript("window.setContacts && window.setContacts(\(encodedContacts))")
                            }
                        }

                        self.syncCryptoKeyFromWebUI(reason: "setSession") {
                            self.reloadHistory(for: username)
                        }
                    }
                }

                if type == "LOAD_SERVER_HISTORY" {
                    let serverId = dict["serverId"] as? String ?? ""
                    let channelId = dict["channelId"] as? String ?? ""
                    let key = (dict["key"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                    if !serverId.isEmpty && !channelId.isEmpty {
                        print("[ZALI][WEBVIEW] LOAD_SERVER_HISTORY request server=\(serverId) channel=\(channelId)")
                        if !key.isEmpty {
                            NetworkService.shared.currentKey = key
                            UserDefaults.standard.set(key, forKey: "zali_crypto_key_v1")
                        }
                        self.reloadServerHistory(serverId: serverId, channelId: channelId)
                    }
                }

                if type == "RESOLVE_TENOR" {
                    let url = dict["url"] as? String ?? ""
                    self.resolveTenor(url: url, requestId: requestId)
                }
                
                if type == "SET_KEY" {
                    let key = (dict["key"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                    print("[ZALI][WEBVIEW] SET_KEY keySet=\(!key.isEmpty) length=\(key.count)")
                    NetworkService.shared.currentKey = key
                    if key.isEmpty {
                        UserDefaults.standard.removeObject(forKey: "zali_crypto_key_v1")
                    } else {
                        UserDefaults.standard.set(key, forKey: "zali_crypto_key_v1")
                    }
                    if self.isDirectMessageKey(key) {
                        DispatchQueue.main.async {
                            self.webView?.evaluateJavaScript("console.log('Swift: E2E ключ обновлён')")
                            self.reloadHistory(for: NetworkService.shared.currentUser)
                        }
                    } else {
                        print("[ZALI][WEBVIEW] SET_KEY skipped direct refresh for non-DM key")
                    }
                }

                if type == "REFRESH_HISTORY" {
                    let key = (dict["key"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                    if !key.isEmpty {
                        NetworkService.shared.currentKey = key
                        UserDefaults.standard.set(key, forKey: "zali_crypto_key_v1")
                    }
                    if self.isDirectMessageKey(key.isEmpty ? NetworkService.shared.currentKey : key) {
                        print("[ZALI][WEBVIEW] REFRESH_HISTORY user=\(NetworkService.shared.currentUser)")
                        DispatchQueue.main.async {
                            self.reloadHistory(for: NetworkService.shared.currentUser)
                        }
                    } else {
                        print("[ZALI][WEBVIEW] REFRESH_HISTORY skipped direct refresh for non-DM key")
                    }
                }

                if type == "NETWORK_CONFIG" {
                    let apiBaseURL = dict["apiBaseUrl"] as? String
                    let wsBaseURL = dict["wsBaseUrl"] as? String
                    NetworkService.shared.configure(apiBaseURL: apiBaseURL, wsBaseURL: wsBaseURL)
                    DispatchQueue.main.async {
                        self.webView?.evaluateJavaScript("window.addLog('SUCCESS', 'Swift: Network config applied')")
                    }
                }

                if type == "VOICE_EVENT" {
                    let payload = dict["payload"] as? [String: Any] ?? dict["event"] as? [String: Any] ?? dict
                    let voiceType = payload["type"] as? String ?? ""
                    print("[VOICE][BRIDGE][OUT] type=\(voiceType) roomId=\(payload["roomId"] as? String ?? "") roomType=\(payload["roomType"] as? String ?? "") to=\(payload["to"] as? String ?? "") target=\(payload["target"] as? String ?? "")")
                    NetworkService.shared.sendWebSocketJSON(payload) { success in
                        DispatchQueue.main.async {
                            let level = success ? "SUCCESS" : "ERROR"
                            let text = success ? "Голосовое событие отправлено" : "Не удалось отправить голосовое событие"
                            self.webView?.evaluateJavaScript("window.addLog(\(WebView.javascriptLiteral(level)), \(WebView.javascriptLiteral(text)))")
                        }
                    }
                }
                
                if type == "SAVE_STYLE" {
                    let css = dict["css"] as? String ?? ""
                    UserDefaults.standard.set(css, forKey: "custom_css")

                    DispatchQueue.main.async {
                        self.webView?.evaluateJavaScript("console.log('Swift: Стили сохранены в UserDefaults')")
                    }
                }
            }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            print("[ZALI][WEBVIEW] didFinish currentUser=\(NetworkService.shared.currentUser) keySet=\(!NetworkService.shared.currentKey.isEmpty)")
            self.syncCryptoKeyFromWebUI(reason: "didFinish") { [weak self] in
                guard let self = self else { return }
                NetworkService.shared.fetchUsers { users in
                    let encodedUsers = WebView.javascriptLiteral(users)
                    DispatchQueue.main.async {
                        webView.evaluateJavaScript("window.setUsers && window.setUsers(\(encodedUsers)); window.setLoading && window.setLoading(false);")
                        webView.evaluateJavaScript("window.setConnectionStatus && window.setConnectionStatus(true);")
                    }
                }
                NetworkService.shared.fetchContacts { contacts in
                    let encodedContacts = WebView.javascriptLiteral(contacts)
                    DispatchQueue.main.async {
                        webView.evaluateJavaScript("window.setContacts && window.setContacts(\(encodedContacts))")
                    }
                }
                self.reloadHistory(for: NetworkService.shared.currentUser)
            }
        }

        func webView(
            _ webView: WKWebView,
            runOpenPanelWith parameters: WKOpenPanelParameters,
            initiatedByFrame frame: WKFrameInfo,
            completionHandler: @escaping ([URL]?) -> Void
        ) {
            let panel = NSOpenPanel()
            panel.allowsMultipleSelection = parameters.allowsMultipleSelection
            panel.canChooseDirectories = false
            panel.canChooseFiles = true
            panel.canCreateDirectories = false
            panel.resolvesAliases = true
            panel.prompt = "Выбрать"
            panel.message = "Выберите изображение для аватара"
            panel.begin { response in
                completionHandler(response == .OK ? panel.urls : nil)
            }
        }

        func webView(
            _ webView: WKWebView,
            requestMediaCapturePermissionFor origin: WKSecurityOrigin,
            initiatedByFrame frame: WKFrameInfo,
            type: WKMediaCaptureType,
            decisionHandler: @escaping (WKPermissionDecision) -> Void
        ) {
            decisionHandler(.grant)
        }
    }
    
    func makeCoordinator() -> Coordinator { Coordinator() }
    
    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.userContentController.add(context.coordinator, name: "nativeApp")
        let savedKey = (UserDefaults.standard.string(forKey: "zali_crypto_key_v1") ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let injectedKey = savedKey.isEmpty ? "ZALI_SECRET_E2E_KEY_2026" : savedKey
        let bootstrap = "window.__ZALI_SAVED_KEY = \(WebView.javascriptLiteral(injectedKey));"
        config.userContentController.addUserScript(WKUserScript(source: bootstrap, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let savedSession: [String: Any] = [
            "username": NetworkService.shared.currentUser,
            "token": UserDefaults.standard.string(forKey: "zali_session_token_v1") ?? "",
            "guest": (UserDefaults.standard.string(forKey: "zali_session_token_v1") ?? "").isEmpty
        ]
        let sessionBootstrap = "window.__ZALI_SAVED_SESSION = \(WebView.javascriptLiteral(savedSession));"
        config.userContentController.addUserScript(WKUserScript(source: sessionBootstrap, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let pendingOutbox = NetworkService.shared.currentPendingOutboxJSON()
        let pendingBootstrap = "window.__ZALI_PENDING_OUTBOX = \(pendingOutbox.isEmpty ? "[]" : pendingOutbox);"
        config.userContentController.addUserScript(WKUserScript(source: pendingBootstrap, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        
        let webView = ZaliNativeWebView(frame: .zero, configuration: config)
        context.coordinator.webView = webView
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.setValue(false, forKey: "drawsBackground")
        webView.allowsMagnification = false
        webView.configuration.allowsAirPlayForMediaPlayback = true
        if #available(macOS 10.12, *) {
            webView.configuration.mediaTypesRequiringUserActionForPlayback = []
        }
        webView.configuration.preferences.setValue(true, forKey: "javaScriptCanOpenWindowsAutomatically")
        
        webView.loadHTMLString(WebAssets.html, baseURL: URL(string: "http://localhost"))
        
        NetworkService.shared.onMessageReceived = { id, clientId, sender, receiver, text, attachments, serverId, channelId in
            let safeServerId = WebView.javascriptLiteral(serverId as Any)
            let safeChannelId = WebView.javascriptLiteral(channelId as Any)
            let safeId = WebView.javascriptLiteral(id)
            let safeClientId = WebView.javascriptLiteral(clientId as Any)
            let safeSender = WebView.javascriptLiteral(sender)
            let safeReceiver = WebView.javascriptLiteral(receiver)
            let safeText = WebView.javascriptLiteral(text)
            let safeAttachments = WebView.javascriptLiteral(attachments)
            
            DispatchQueue.main.async {
                webView.evaluateJavaScript("if (window.receiveMessage) { window.receiveMessage({ id: \(safeId), clientId: \(safeClientId), sender: \(safeSender), receiver: \(safeReceiver), text: \(safeText), attachments: \(safeAttachments), serverId: \(safeServerId), channelId: \(safeChannelId) }); }")
            }
        }
        NetworkService.shared.onReactionUpdated = { payload in
            let safePayload = WebView.javascriptLiteral(payload)
            DispatchQueue.main.async {
                webView.evaluateJavaScript("if (window.receiveReactionUpdate) { window.receiveReactionUpdate(\(safePayload)); }")
            }
        }
        NetworkService.shared.onAvatarChanged = { username, deleted in
            let safeUsername = WebView.javascriptLiteral(username)
            DispatchQueue.main.async {
                if deleted {
                    webView.evaluateJavaScript("if (window.avatarDeleted) { window.avatarDeleted(\(safeUsername)); }")
                } else {
                    webView.evaluateJavaScript("if (window.avatarUpdated) { window.avatarUpdated(\(safeUsername)); }")
                }
            }
        }
        NetworkService.shared.onVoiceEvent = { payload in
            let safePayload = WebView.javascriptLiteral(payload)
            DispatchQueue.main.async {
                webView.evaluateJavaScript("if (window.receiveVoiceEvent) { window.receiveVoiceEvent(\(safePayload)); }")
            }
        }
        NetworkService.shared.start()
        
        return webView
    }

    static func javascriptLiteral(_ value: Any) -> String {
        if let string = value as? String,
           let data = try? JSONEncoder().encode(string),
           let json = String(data: data, encoding: .utf8) {
            return json
        }

        guard JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value, options: []),
              let json = String(data: data, encoding: .utf8) else {
            return "null"
        }
        return json
    }
    
    func updateNSView(_ nsView: WKWebView, context: Context) {
        DispatchQueue.main.async {
            if let window = nsView.window {
                window.titlebarAppearsTransparent = true
                window.titleVisibility = .hidden
                window.styleMask.insert(.fullSizeContentView)
                window.isMovableByWindowBackground = true
            }
        }
    }
}
