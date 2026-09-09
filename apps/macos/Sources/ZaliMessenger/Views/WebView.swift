import WebKit
import AppKit
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

struct WebView {
    class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
        // In-flight SEND_MESSAGE clientId guard, mirroring Windows' in_flight_send_client_ids
        // (native.rs). Without it a rapid double-trigger (double Enter, a retry racing the
        // first attempt) could pack+upload the same message twice.
        private static let sendGuardQueue = DispatchQueue(label: "com.zali.messenger.sendGuard")
        private static var inFlightSendClientIds = Set<String>()

        private static func tryClaimSendClientId(_ id: String) -> Bool {
            guard !id.isEmpty else { return true }
            return sendGuardQueue.sync {
                guard !inFlightSendClientIds.contains(id) else { return false }
                inFlightSendClientIds.insert(id)
                return true
            }
        }

        private static func releaseSendClientId(_ id: String) {
            guard !id.isEmpty else { return }
            sendGuardQueue.sync { _ = inFlightSendClientIds.remove(id) }
        }

        weak var webView: WKWebView?
        private var directHistoryReloadToken = UUID()
        private var serverHistoryReloadToken = UUID()
        private var reloadHistoryTask: Task<Void, Never>?
        private var reloadServerHistoryTask: Task<Void, Never>?
        /// Successful decryptions, keyed by message id. Archives are immutable once
        /// stored, so a hit is always valid (an edit replaces the archive behind the
        /// id and explicitly evicts it — see forgetDecryptedMessage).
        ///
        /// Bounded, unlike the version this replaces. Entries hold every attachment
        /// inline as a base64 data URL, and nothing ever evicted one, so a long
        /// conversation with photos pinned its entire decrypted self in memory for the
        /// life of the process. The Windows shell has carried these same two limits
        /// from the start (`DECRYPTED_CACHE_MAX_ENTRIES` / `_MAX_ENTRY_BYTES` in
        /// native/cache.rs); this is the missing half of that pair.
        private var decryptedMessageCache: [String: [String: Any]] = [:]
        private var decryptedMessageCacheOrder: [String] = []
        /// Guards the three decryption caches below.
        ///
        /// renderHistoryRecord runs inside a TaskGroup — four records concurrently —
        /// so every read and write of these lives on an arbitrary thread. The positive
        /// cache was already being mutated that way; adding the eviction order and the
        /// negative cache alongside it made an unsynchronised Dictionary/Array a
        /// genuine hazard rather than a latent one (a Dictionary resized from two
        /// threads corrupts, it does not merely lose a write). A plain lock is enough
        /// here: every critical section is a handful of dictionary operations, and the
        /// alternative — making the Coordinator an actor — would ripple through every
        /// bridge callback for no additional safety.
        private let decryptCacheLock = NSLock()
        private static let decryptedCacheMaxEntries = 2048
        private static let decryptedCacheMaxEntryBytes = 1024 * 1024
        /// Ceiling on the keys tried against one archive. See the fallback loop in
        /// renderHistoryRecord for why an unbounded sweep is not affordable.
        private static let maxDecryptCandidates = 12

        /// Message ids that could NOT be opened, and the key material that failed.
        ///
        /// Failures were deliberately not cached, on the reasoning that the state
        /// repairs itself once key sync converges. It does — but until it does, every
        /// history refresh re-downloaded each unreadable archive and re-ran the whole
        /// candidate sweep against it, and each attempt is two PBKDF2-SHA256 passes at
        /// 210 000 iterations. Twenty candidates on fifty unreadable messages is
        /// thousands of derivations, repeated on every `key_envelope_available` push —
        /// which is exactly when a conversation is unreadable and pushes are frequent.
        ///
        /// The self-repair is kept by storing WHICH key set failed: the moment any new
        /// key material arrives the fingerprint changes, every entry is stale, and the
        /// retry happens immediately. Re-running the sweep against a key set already
        /// known not to work is the only thing this removes.
        private var failedDecryptKeyFingerprint: [String: Int] = [:]
        // All trailing-edge debounced refreshes share one keyed store (see debounce()).
        // Distinct keys are independent, so e.g. per-peer history reloads
        // ("reloadHistory:<username>") never cancel each other — a single shared work item
        // would reload only the last peer of a reconnect catch-up burst.
        private var debounceWorkItems: [String: DispatchWorkItem] = [:]
        private var pendingUpdateArchivePath: URL?

        /// Plain file, not Keychain (see sharedAppSupportDir below for why): a Keychain
        /// item's ACL is bound to the app's code signature, and build_app.sh's ad-hoc
        /// signature changes on every rebuild — each rebuild made macOS treat the app as
        /// "a different app" wanting access to its own previously-stored key, showing a
        /// consent dialog on every single launch after a rebuild. This key is a single
        /// legacy value (not per-user, matching the original Keychain account naming).
        private static var legacyCryptoKeyFilePath: URL? {
            sharedAppSupportDir?.appendingPathComponent("legacy_crypto_key.txt")
        }

        static func saveLegacyCryptoKey(_ value: String) {
            guard let path = legacyCryptoKeyFilePath else { return }
            if value.isEmpty {
                try? FileManager.default.removeItem(at: path)
                return
            }
            try? value.write(to: path, atomically: true, encoding: .utf8)
        }

        static func loadLegacyCryptoKey() -> String {
            guard let path = legacyCryptoKeyFilePath,
                  let value = try? String(contentsOf: path, encoding: .utf8) else { return "" }
            return value.trimmingCharacters(in: .whitespacesAndNewlines)
        }

        /// Drops every `shared_device_identity_*.json` export (all accounts). After a
        /// server reset the device ids inside them are unknown to the server, and an
        /// injected unknown identity is worse than none: it keeps the client claiming a
        /// device nobody ever addressed a key envelope to.
        static func removeSharedDeviceIdentities() {
            guard let dir = sharedAppSupportDir else { return }
            let files = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
            for name in files where name.hasPrefix("shared_device_identity_") && name.hasSuffix(".json") {
                try? FileManager.default.removeItem(at: dir.appendingPathComponent(name))
            }
        }

        /// Loads the shared device identity for `username` so it can be injected at
        /// document-start (mirror of `exportDeviceIdentityToSharedFile`, and of the Rust
        /// shell's read at native.rs). Without this, a WebView localStorage wipe (rebuild
        /// or cleared data) mints a fresh device_id even though a valid identity sits on
        /// disk — orphaning every key envelope addressed to the old recipient_device_id.
        /// Returns the raw JSON only if it parses; a corrupt export must never break page load.
        static func loadSharedDeviceIdentity(for username: String) -> String? {
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

        /// Deliberately a plain file, not Keychain: this app and the Rust shell
        /// (`dist/macos-rust`) run unsandboxed under the same OS user, so a shared
        /// directory needs no cross-app consent dialog. Mirrors native.rs's own
        /// app_data_dir() so both shells agree on the location.
        private static var sharedAppSupportDir: URL? = {
            guard let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
                return nil
            }
            let dir = base.appendingPathComponent("ZaliMessenger", isDirectory: true)
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            return dir
        }()

        /// Appends a line to zali-debug.log under the shared app-support dir. Fed by the
        /// injected console hook (all JS console.* output) so the full in-app journal is
        /// tail-able from disk. Serialized on a dedicated queue; best-effort, never throws.
        private static let debugLogQueue = DispatchQueue(label: "com.zali.messenger.debuglog")
        static func appendDebugLog(_ line: String) {
            guard let dir = sharedAppSupportDir else { return }
            let url = dir.appendingPathComponent("zali-debug.log")
            let stamped = "[\(ISO8601DateFormatter().string(from: Date()))] \(line)\n"
            debugLogQueue.async {
                guard let data = stamped.data(using: .utf8) else { return }
                if let handle = try? FileHandle(forWritingTo: url) {
                    defer { try? handle.close() }
                    _ = try? handle.seekToEnd()
                    try? handle.write(contentsOf: data)
                } else {
                    try? data.write(to: url, options: .atomic)
                }
            }
        }

        /// Exports the JS-side device identity (ECDH keypair + deviceId) so a Rust-shell
        /// launch on this same Mac can adopt the already-approved device instead of
        /// registering a new, unknown one with no key envelopes waiting for it. Safe to
        /// call repeatedly — just overwrites the file with the current identity.
        fileprivate func exportDeviceIdentityToSharedFile() {
            let username = NetworkService.shared.currentUser.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            guard !username.isEmpty, let dir = WebView.Coordinator.sharedAppSupportDir else { return }
            let script = """
            (function () {
                try {
                    const iface = window.__ZALI_INTERFACE;
                    const key = iface && typeof iface.deviceIdentityStorageKey === 'function'
                        ? iface.deviceIdentityStorageKey() : null;
                    return key ? localStorage.getItem(key) : null;
                } catch (e) { return null; }
            })()
            """
            runJavaScript(script) { result, error in
                guard error == nil, let raw = result as? String, !raw.isEmpty else { return }
                let path = dir.appendingPathComponent("shared_device_identity_\(username).json")
                do {
                    try raw.write(to: path, atomically: true, encoding: .utf8)
                } catch {
                    print("[ZALI][WEBVIEW] exportDeviceIdentity write failed err=\(error.localizedDescription)")
                }
            }
        }

        fileprivate enum BusEvent: String {
            case tenorResolved = "zali_interface:tenor_resolved"
            case onSendSuccess = "zali_interface:on_send_success"
            case onSendError = "zali_interface:on_send_error"
            case syncActiveConversation = "zali_interface:sync_active_conversation"
            case authResponse = "zali_interface:auth_response"
            case nativeResponse = "zali_interface:native_response"
            case updateEvent = "zali_interface:update_event"
        }

        fileprivate enum WindowFunction: String {
            case addLog
            case setUsers
            case setContacts
            case setLoading
            case setConnectionStatus
            case loadHistory
            case loadServerHistory
            case receiveMessage
            case receiveReactionUpdate
            case receiveMessageDeleted
            case receiveMessageEdited
            case avatarUpdated
            case avatarDeleted
            case receiveVoiceEvent
            case refreshAfterKey
            case retryPublishKeys
            case keyRepublishRequest
            case receiveRealtimeEvent
        }

        private struct TenorResolvedPayload: Codable {
            let requestId: String
            let sourceUrl: String
            let mediaUrl: String?
            let mimeType: String?
            let kind: String?
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

        fileprivate func runJavaScript(_ script: String, completion: ((Any?, Error?) -> Void)? = nil) {
            webView?.evaluateJavaScript(script, completionHandler: { result, error in
                completion?(result, error)
            })
        }

        fileprivate func callWindowFunction(_ function: WindowFunction, arguments: [String]) {
            let name = function.rawValue
            let args = arguments.joined(separator: ", ")
            runJavaScript("window.\(name) && window.\(name)(\(args))")
        }

        fileprivate func sendBusEvent(_ event: BusEvent, payload: String) {
            runJavaScript("window.loader?.bus?.send(\(WebView.javascriptLiteral(event.rawValue)), \(payload));")
        }

        fileprivate func logToWeb(level: String, text: String) {
            callWindowFunction(.addLog, arguments: [WebView.javascriptLiteral(level), WebView.javascriptLiteral(text)])
        }

        fileprivate func addLog(level: String, text: String) {
            logToWeb(level: level, text: text)
        }

        fileprivate func consoleLog(_ text: String) {
            runJavaScript("console.log(\(WebView.javascriptLiteral(text)))")
        }

        fileprivate func setUsers(_ encodedUsers: String) {
            callWindowFunction(.setUsers, arguments: [encodedUsers])
        }

        fileprivate func setContacts(_ encodedContacts: String) {
            callWindowFunction(.setContacts, arguments: [encodedContacts])
        }

        fileprivate func setLoading(_ on: Bool) {
            callWindowFunction(.setLoading, arguments: [on ? "true" : "false"])
        }

        fileprivate func setConnectionStatus(_ connected: Bool) {
            callWindowFunction(.setConnectionStatus, arguments: [connected ? "true" : "false"])
        }

        fileprivate func loadHistory(_ encodedHistory: String) {
            callWindowFunction(.loadHistory, arguments: [encodedHistory])
        }

        fileprivate func loadServerHistory(serverId: String, channelId: String, encodedHistory: String) {
            callWindowFunction(.loadServerHistory, arguments: [
                WebView.javascriptLiteral(serverId),
                WebView.javascriptLiteral(channelId),
                encodedHistory
            ])
        }

        fileprivate func receiveMessage(_ payload: String) {
            callWindowFunction(.receiveMessage, arguments: [payload])
        }

        fileprivate func receiveReactionUpdate(_ payload: String) {
            callWindowFunction(.receiveReactionUpdate, arguments: [payload])
        }

        fileprivate func receiveMessageDeleted(_ payload: String) {
            callWindowFunction(.receiveMessageDeleted, arguments: [payload])
        }

        fileprivate func receiveMessageEdited(_ payload: String) {
            callWindowFunction(.receiveMessageEdited, arguments: [payload])
        }

        fileprivate func avatarUpdated(_ username: String) {
            callWindowFunction(.avatarUpdated, arguments: [WebView.javascriptLiteral(username)])
        }

        fileprivate func avatarDeleted(_ username: String) {
            callWindowFunction(.avatarDeleted, arguments: [WebView.javascriptLiteral(username)])
        }

        fileprivate func receiveVoiceEvent(_ payload: String) {
            callWindowFunction(.receiveVoiceEvent, arguments: [payload])
        }

        fileprivate func refreshAfterKey() {
            callWindowFunction(.refreshAfterKey, arguments: [])
        }

        fileprivate func retryPublishKeys() {
            callWindowFunction(.retryPublishKeys, arguments: [])
        }

        /// Not debounced and not coalesced with retryPublishKeys: each request names a
        /// scope, and answering it is what hands a peer the historical key it is stuck
        /// on. Dropping or merging these is how a conversation stays unreadable.
        fileprivate func keyRepublishRequest(_ payload: [String: Any]) {
            callWindowFunction(.keyRepublishRequest, arguments: [WebView.javascriptLiteral(payload)])
        }

        /// Отдаёт в JS WS-кадр, который нативный слой не разобрал сам. Никакой
        /// интерпретации здесь нет намеренно: смысл события знает только JS
        /// (dispatchRealtimeEvent), и держать его знание ещё и тут означало бы
        /// обновлять три оболочки на каждый новый тип события.
        fileprivate func receiveRealtimeEvent(_ payload: [String: Any]) {
            callWindowFunction(.receiveRealtimeEvent, arguments: [WebView.javascriptLiteral(payload)])
        }

        /// Coalesces bursts of key_envelope_available notifications (e.g. several pending
        /// envelopes delivered together) into a single refreshAfterKey() call instead of
        /// triggering a redundant JS-side history re-decrypt for each one.
        fileprivate func scheduleRefreshAfterKey() {
            debounce("refreshAfterKey", delay: 0.5) { [weak self] in self?.refreshAfterKey() }
        }

        /// Trailing-edge debounce keyed by name. A new call for the same key cancels the
        /// pending one; different keys are independent. Used for all coalesced refreshes.
        private func debounce(_ key: String, delay: Double = 0.4, _ body: @escaping () -> Void) {
            debounceWorkItems[key]?.cancel()
            let workItem = DispatchWorkItem { [weak self] in
                self?.debounceWorkItems.removeValue(forKey: key)
                body()
            }
            debounceWorkItems[key] = workItem
            DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: workItem)
        }

        /// Drops one message from the decrypted-render cache. Called whenever the
        /// archive behind that id is replaced, locally or by the peer.
        fileprivate func forgetDecryptedMessage(_ messageId: String) {
            decryptCacheLock.lock()
            defer { decryptCacheLock.unlock() }
            decryptedMessageCache.removeValue(forKey: messageId)
            decryptedMessageCacheOrder.removeAll { $0 == messageId }
            failedDecryptKeyFingerprint.removeValue(forKey: messageId)
        }

        /// Everything the caches can say about one message, read under one lock.
        private func decryptVerdict(for messageId: String) -> (cached: [String: Any]?, failedWith: Int?) {
            decryptCacheLock.lock()
            defer { decryptCacheLock.unlock() }
            return (decryptedMessageCache[messageId], failedDecryptKeyFingerprint[messageId])
        }

        private func rememberDecryptFailure(_ messageId: String, fingerprint: Int) {
            decryptCacheLock.lock()
            defer { decryptCacheLock.unlock() }
            failedDecryptKeyFingerprint[messageId] = fingerprint
            if failedDecryptKeyFingerprint.count > Coordinator.decryptedCacheMaxEntries {
                failedDecryptKeyFingerprint.removeAll()
            }
        }

        private func clearDecryptCaches() {
            decryptCacheLock.lock()
            defer { decryptCacheLock.unlock() }
            decryptedMessageCache.removeAll()
            decryptedMessageCacheOrder.removeAll()
            failedDecryptKeyFingerprint.removeAll()
        }

        /// Stores a decrypted message, evicting the oldest entries past the cap.
        /// Oversized entries (an attachment inlined as a data URL) are not cached at
        /// all: this exists to save CPU, and it must not become a memory sink.
        private func cacheDecryptedMessage(_ messageId: String, _ entry: [String: Any]) {
            guard !messageId.isEmpty else { return }
            guard let data = zaliJSONData(entry) else { return }
            if data.count > Coordinator.decryptedCacheMaxEntryBytes { return }
            decryptCacheLock.lock()
            defer { decryptCacheLock.unlock() }
            if decryptedMessageCache[messageId] == nil {
                decryptedMessageCacheOrder.append(messageId)
            }
            decryptedMessageCache[messageId] = entry
            // Succeeding voids any earlier "no key of ours opens this" verdict.
            failedDecryptKeyFingerprint.removeValue(forKey: messageId)
            while decryptedMessageCacheOrder.count > Coordinator.decryptedCacheMaxEntries {
                let oldest = decryptedMessageCacheOrder.removeFirst()
                decryptedMessageCache.removeValue(forKey: oldest)
            }
        }

        /// Cheap identity of the key material currently available for decryption.
        /// Any change — a new envelope imported, a key promoted, a vault merge — moves
        /// it, which is what makes the negative cache above self-repairing.
        private func currentKeyFingerprint() -> Int {
            var hasher = Hasher()
            hasher.combine(NetworkService.shared.currentKey)
            for key in NetworkService.shared.allConversationKeys.keys.sorted() {
                hasher.combine(key)
                hasher.combine(NetworkService.shared.allConversationKeys[key] ?? "")
            }
            return hasher.finalize()
        }

        private func sendNativeResponse(_ payload: [String: Any]) {
            sendBusEvent(.nativeResponse, payload: WebView.javascriptLiteral(payload))
        }

        private func sendAuthResponse(_ payload: [String: Any]) {
            sendBusEvent(.authResponse, payload: WebView.javascriptLiteral(payload))
        }

        private func handleAuthRequest(dict: [String: Any]) {
            let mode = dict["mode"] as? String ?? "login"
            let username = dict["username"] as? String ?? ""
            let password = dict["password"] as? String ?? ""
            let requestId = dict["requestId"] as? String ?? dict["request_id"] as? String ?? UUID().uuidString
            if username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || password.isEmpty || requestId.isEmpty {
                self.sendAuthResponse([
                    "requestId": requestId,
                    "ok": false,
                    "error": "Не удалось связаться с сервером",
                ])
                return
            }

            NetworkService.shared.performAuthRequest(mode: mode, username: username, password: password, requestId: requestId) { [weak self] success, payload, error in
                DispatchQueue.main.async {
                    guard let self = self else { return }
                    if success, let payload {
                        self.sendAuthResponse(payload)
                    } else {
                        self.sendAuthResponse([
                            "requestId": requestId,
                            "ok": false,
                            "error": error ?? "Не удалось войти",
                        ])
                    }
                }
            }
        }

        private func handleContactRequest(dict: [String: Any], add: Bool) {
            let username = (dict["username"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let requestId = dict["requestId"] as? String ?? dict["request_id"] as? String ?? UUID().uuidString
            if username.isEmpty || requestId.isEmpty {
                self.sendNativeResponse([
                    "requestId": requestId,
                    "ok": false,
                    "error": "Не удалось выполнить операцию",
                ])
                return
            }

            NetworkService.shared.performContactsRequest(username: username, add: add) { [weak self] success, contacts, error in
                DispatchQueue.main.async {
                    guard let self = self else { return }
                    if success {
                        self.sendNativeResponse([
                            "requestId": requestId,
                            "ok": true,
                            "data": [
                                "contacts": contacts ?? [],
                            ],
                        ])
                    } else {
                        self.sendNativeResponse([
                            "requestId": requestId,
                            "ok": false,
                            "error": error ?? "Не удалось выполнить операцию",
                        ])
                    }
                }
            }
        }

        private func handleDownloadUpdateRequest(dict: [String: Any], requestId: String) {
            let url = (dict["url"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let sha256 = (dict["sha256"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !url.isEmpty, sha256.count == 64 else {
                self.sendNativeResponse(["requestId": requestId, "ok": false, "error": "Некорректные параметры обновления"])
                return
            }
            UpdateService.shared.downloadUpdate(
                urlString: url,
                expectedSha256: sha256,
                progress: { [weak self] fraction in
                    self?.sendBusEvent(.updateEvent, payload: WebView.javascriptLiteral(["kind": "progress", "progress": fraction]))
                },
                completion: { [weak self] ok, archivePath, errorMessage in
                    guard let self else { return }
                    if ok, let archivePath {
                        self.pendingUpdateArchivePath = archivePath
                        self.sendNativeResponse(["requestId": requestId, "ok": true, "data": [:]])
                    } else {
                        self.sendNativeResponse(["requestId": requestId, "ok": false, "error": errorMessage ?? "Не удалось загрузить обновление"])
                    }
                }
            )
        }

        private func handleInstallUpdateRequest(requestId: String) {
            guard let archivePath = self.pendingUpdateArchivePath else {
                self.sendNativeResponse(["requestId": requestId, "ok": false, "error": "Обновление ещё не загружено"])
                return
            }
            UpdateService.shared.installAndRelaunch(archivePath: archivePath) { [weak self] ok, errorMessage in
                if ok {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                        NSApp.terminate(nil)
                    }
                } else {
                    self?.sendNativeResponse(["requestId": requestId, "ok": false, "error": errorMessage ?? "Не удалось установить обновление"])
                }
            }
        }

        private func handleAvatarRequest(dict: [String: Any], delete: Bool) {
            let requestId = dict["requestId"] as? String ?? dict["request_id"] as? String ?? UUID().uuidString
            let dataUrl = dict["dataUrl"] as? String
            let mimeType = dict["mimeType"] as? String
            let filename = dict["filename"] as? String
            if requestId.isEmpty {
                self.sendNativeResponse([
                    "requestId": requestId,
                    "ok": false,
                    "error": "Не удалось выполнить операцию",
                ])
                return
            }

            NetworkService.shared.performAvatarRequest(mode: delete ? "delete" : "upload", dataUrl: dataUrl, mimeType: mimeType, filename: filename) { [weak self] success, usernameValue, error in
                DispatchQueue.main.async {
                    guard let self = self else { return }
                    if success {
                        let currentUsername = usernameValue ?? NetworkService.shared.currentUser
                        self.sendNativeResponse([
                            "requestId": requestId,
                            "ok": true,
                            "data": [
                                "username": currentUsername,
                            ],
                        ])
                        if delete {
                            self.avatarDeleted(currentUsername)
                        } else {
                            self.avatarUpdated(currentUsername)
                        }
                    } else {
                        self.sendNativeResponse([
                            "requestId": requestId,
                            "ok": false,
                            "error": error ?? "Не удалось выполнить операцию",
                        ])
                    }
                }
            }
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
            guard let pageURL = URL(string: url),
                  pageURL.scheme == "https",
                  let host = pageURL.host,
                  host == "tenor.com" || host.hasSuffix(".tenor.com") else {
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
                self.sendBusEvent(.tenorResolved, payload: WebView.javascriptLiteral(jsonString))
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
            reloadHistoryTask?.cancel()
            reloadHistoryTask = Task { [weak self] in
                guard let self = self else { return }
                let (records, ok) = await self.fetchMessagesAsync(for: username)
                guard self.directHistoryReloadToken == reloadToken else { return }
                print("[ZALI][WEBVIEW] reloadHistory fetched user=\(username) count=\(records.count) ok=\(ok)")

                guard ok else {
                    // Fetch failed (auth/HTTP/decode). Do NOT overwrite the view with an
                    // empty history — that made a transient error look like "no messages".
                    print("[ZALI][WEBVIEW] reloadHistory fetch failed user=\(username) — keeping existing view")
                    DispatchQueue.main.async {
                        guard self.directHistoryReloadToken == reloadToken else { return }
                        self.addLog(level: "ERROR", text: "Не удалось загрузить историю переписки с \(username). Показаны ранее загруженные сообщения.")
                    }
                    return
                }

                guard !records.isEmpty else {
                    DispatchQueue.main.async {
                        guard self.directHistoryReloadToken == reloadToken else { return }
                        self.loadHistory("[]")
                    }
                    print("[ZALI][WEBVIEW] reloadHistory empty user=\(username)")
                    return
                }

                let renderedMessages = await self.renderHistoryRecords(
                    records: records,
                    serverId: nil,
                    channelId: nil,
                    logPrefix: "reloadHistory"
                )

                guard self.directHistoryReloadToken == reloadToken else { return }
                let encodedHistory = WebView.javascriptLiteral(renderedMessages)
                DispatchQueue.main.async {
                    guard self.directHistoryReloadToken == reloadToken else { return }
                    self.loadHistory(encodedHistory)
                }
                print("[ZALI][WEBVIEW] reloadHistory dispatch user=\(username) rendered=\(renderedMessages.count)")
            }
        }

        private func syncCryptoKeyFromWebUI(reason: String, completion: @escaping () -> Void) {
            guard self.webView != nil else {
                completion()
                return
            }

            let script = """
            (function () {
                try {
                    const input = document.getElementById('inputCryptoKey');
                    const scope = String(window.__ZALI_ACTIVE_CONVERSATION_SCOPE || '').trim();
                    const stored = scope
                        ? (() => {
                            try {
                                const raw = localStorage.getItem('zali_conversation_keys_v2');
                                const parsed = raw ? JSON.parse(raw) : {};
                                return String(parsed?.[scope] || '').trim();
                            } catch (e) {
                                return '';
                            }
                        })()
                        : '';
                    const iface = window.__ZALI_INTERFACE;
                    const ifaceStored = scope && iface && typeof iface.getStoredConversationKey === 'function'
                        ? String(iface.getStoredConversationKey(scope) || '').trim()
                        : '';
                    const ifaceFallback = iface && typeof iface.loadStoredCryptoKey === 'function'
                        ? String(iface.loadStoredCryptoKey() || '').trim()
                        : '';
                    return String((ifaceStored || stored || (input && input.value) || ifaceFallback || '')).trim();
                } catch (e) {
                    return '';
                }
            })()
            """

            runJavaScript(script) { result, error in
                defer { completion() }

                if let error = error {
                    print("[ZALI][WEBVIEW] syncCryptoKey reason=\(reason) evalError=\(error.localizedDescription)")
                    return
                }

                let key = (result as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                let currentKey = NetworkService.shared.currentKey.trimmingCharacters(in: .whitespacesAndNewlines)
                print("[ZALI][WEBVIEW] syncCryptoKey reason=\(reason) keySet=\(!key.isEmpty) currentKeySet=\(!currentKey.isEmpty)")

                if !key.isEmpty && currentKey != key {
                    NetworkService.shared.currentKey = key
                    NetworkService.shared.persistCurrentKey()
                    print("[ZALI][WEBVIEW] syncCryptoKey updated reason=\(reason) length=\(key.count)")
                }
            }
        }

        /// Coalesces bursts of setKey/refreshHistory bridge messages (e.g. postAuthSetup
        /// firing cloud-vault import, envelope sync, and key republish back-to-back, each
        /// emitting its own SET_KEY) into a single reload. Without this, reloadHistoryTask's
        /// cancel-on-new-task guard was not enough: cancellation races the network request,
        /// which had often already been dispatched — the burst saturated the connection
        /// pool and every request timed out ("чат не грузит" symptom).
        fileprivate func scheduleRefreshActiveConversationHistory(reason: String) {
            // Note: the cross-shell identity export is NOT piggybacked here. It ran a
            // runJavaScript round-trip + atomic file write on every setKey/refreshHistory
            // (which fire constantly), re-writing byte-identical data. The dedicated
            // PERSIST_DEVICE_IDENTITY IPC and the SET_SESSION handler already export it
            // exactly when the identity is created/changed.
            debounce("refreshActiveConversation") { [weak self] in
                self?.refreshActiveConversationHistory(reason: reason)
            }
        }

        /// Same rationale as scheduleRefreshActiveConversationHistory, for REFRESH_HISTORY's
        /// peer-addressed path which calls reloadHistory(for:) directly and previously bypassed
        /// any debounce entirely.
        fileprivate func scheduleReloadHistory(for username: String, reason: String) {
            // Per-peer key so distinct peers debounce independently — a shared item would
            // let a reconnect catch-up burst reload only the last peer.
            debounce("reloadHistory:\(username)") { [weak self] in self?.reloadHistory(for: username) }
        }

        fileprivate func refreshActiveConversationHistory(reason: String) {
            guard self.webView != nil else { return }
            let script = """
            (function () {
                try {
                    const iface = window.__ZALI_INTERFACE;
                    return {
                        navMode: String(iface?.S?.navMode || ''),
                        current: String(iface?.S?.current || ''),
                        activeServer: String(iface?.S?.activeServer || ''),
                        activeChannel: String(iface?.S?.activeChannel || ''),
                    };
                } catch (e) {
                    return {};
                }
            })()
            """

            runJavaScript(script) { result, error in
                if let error = error {
                    print("[ZALI][WEBVIEW] refreshActiveConversation reason=\(reason) evalError=\(error.localizedDescription)")
                    return
                }

                guard let dict = result as? [String: Any] else { return }
                let navMode = String(dict["navMode"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                let current = String(dict["current"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                let activeServer = String(dict["activeServer"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                let activeChannel = String(dict["activeChannel"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)

                if navMode == "servers", !activeServer.isEmpty, !activeChannel.isEmpty {
                    print("[ZALI][WEBVIEW] refreshActiveConversation server=\(activeServer) channel=\(activeChannel) reason=\(reason)")
                    self.reloadServerHistory(serverId: activeServer, channelId: activeChannel)
                    return
                }

                if !current.isEmpty {
                    print("[ZALI][WEBVIEW] refreshActiveConversation dm=\(current) reason=\(reason)")
                    self.reloadHistory(for: current)
                }
            }
        }

        private func fetchMessagesAsync(for username: String) async -> ([NetworkService.RemoteMessageRecord], Bool) {
            await withCheckedContinuation { continuation in
                NetworkService.shared.fetchMessages(for: username) { records, ok in
                    continuation.resume(returning: (records, ok))
                }
            }
        }

        private func fetchServerMessagesAsync(serverId: String, channelId: String) async -> ([NetworkService.RemoteMessageRecord], Bool) {
            await withCheckedContinuation { continuation in
                NetworkService.shared.fetchServerMessages(serverId: serverId, channelId: channelId) { records, ok in
                    continuation.resume(returning: (records, ok))
                }
            }
        }

        private func downloadMessageAsync(messageId: String) async -> (URL?, Int?) {
            await withCheckedContinuation { continuation in
                NetworkService.shared.downloadMessage(messageId: messageId) { fileURL, statusCode in
                    continuation.resume(returning: (fileURL, statusCode))
                }
            }
        }

        private func retryDelayNanoseconds(attempt: Int) -> UInt64 {
            let boundedAttempt = max(1, min(attempt, 5))
            let base: UInt64 = 250_000_000
            let multiplier = UInt64(1 << (boundedAttempt - 1))
            return min(base * multiplier, 2_000_000_000)
        }

        private func unpackHistoryMessage(
            archivePath: String,
            tempDir: String,
            keys: [String]
        ) -> ZaliCore.MessagePayload? {
            ZaliCore.shared.unpackMessage(archivePath: archivePath, tempDir: tempDir, keys: keys)
        }

        private func renderHistoryRecord(
            record: NetworkService.RemoteMessageRecord,
            serverId: String?,
            channelId: String?,
            logPrefix: String
        ) async -> [String: Any]? {
            let messageId = record.id.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !messageId.isEmpty else { return nil }

            let verdict = decryptVerdict(for: messageId)
            if let cached = verdict.cached { return cached }

            let keyFingerprint = currentKeyFingerprint()
            // Already tried, against exactly this key material, and none of it worked.
            // Re-running the sweep would burn the same thousands of PBKDF2 passes for
            // the same answer. A single new key anywhere moves the fingerprint and
            // this stops matching, so the repair still lands the moment it can.
            if verdict.failedWith == keyFingerprint {
                return decryptFailurePlaceholder(
                    record: record,
                    serverId: serverId,
                    channelId: channelId,
                    decryptFailed: true,
                    lastDownloadError: nil
                )
            }

            let keys: [String] = {
                var candidates = ZaliCore.candidateMessageKeys(
                    currentKey: NetworkService.shared.currentKey,
                    conversationKeys: NetworkService.shared.allConversationKeys,
                    participantA: record.sender,
                    participantB: record.receiver,
                    serverId: serverId,
                    channelId: channelId
                )
                // Last-resort fallback: try every other known conversation key too.
                //
                // Bounded, because this is charged per message: every candidate that
                // does not fit costs two PBKDF2-SHA256 passes at 210 000 iterations
                // (the archive session key, then the message body), so an account that
                // has accumulated dozens of `alt:` keys was paying seconds of CPU per
                // unreadable message. The scope's own keys are added first by
                // candidateMessageKeys and are the ones that can realistically work;
                // this tail is a heuristic for mis-scoped material, and a heuristic
                // does not deserve an unbounded budget.
                //
                // Walked in sorted scope order, not Dictionary order. Once the tail is
                // capped, an unordered walk would make the *contents* of the list vary
                // between calls for the same message — decryption would succeed or fail
                // depending on which twelve keys the dictionary happened to yield first.
                for scope in NetworkService.shared.allConversationKeys.keys.sorted() {
                    if candidates.count >= Coordinator.maxDecryptCandidates { break }
                    let normalized = (NetworkService.shared.allConversationKeys[scope] ?? "")
                        .trimmingCharacters(in: .whitespacesAndNewlines)
                    if !normalized.isEmpty, !candidates.contains(normalized) { candidates.append(normalized) }
                }
                return candidates
            }()

            var lastDownloadError: String? = nil
            var decryptFailed = false

            for attempt in 1...3 {
                guard !Task.isCancelled else { return nil }

                let (fileURL, statusCode) = await self.downloadMessageAsync(messageId: messageId)
                guard let fileURL else {
                    if statusCode == 403 {
                        print("[ZALI][WEBVIEW] \(logPrefix) download forbidden messageId=\(messageId)")
                        DispatchQueue.main.async {
                            self.addLog(level: "ERROR", text: "Загрузка отклонена сервером (403): \(record.sender)→\(record.receiver) — нет доступа к файлу сообщения")
                        }
                        lastDownloadError = "403"
                        break
                    }
                    if statusCode == 413 {
                        // Sentinel from downloadMessage's size cap — permanent, not retryable.
                        print("[ZALI][WEBVIEW] \(logPrefix) download too large messageId=\(messageId)")
                        DispatchQueue.main.async {
                            self.addLog(level: "ERROR", text: "Файл сообщения превышает допустимый размер: \(record.sender)→\(record.receiver)")
                        }
                        lastDownloadError = "413"
                        break
                    }
                    lastDownloadError = "status=\(statusCode ?? -1)"
                    print("[ZALI][WEBVIEW] \(logPrefix) download retry=\(attempt) messageId=\(messageId)")
                    if attempt < 3 {
                        try? await Task.sleep(nanoseconds: self.retryDelayNanoseconds(attempt: attempt))
                    }
                    continue
                }

                // downloadMessage now hands back a uniquely-named temp file that nothing
                // else reclaims — delete it once this iteration is done with it.
                defer { try? FileManager.default.removeItem(at: fileURL) }

                let tempDirName = UUID().uuidString
                let tempDir = (NSTemporaryDirectory() as NSString).appendingPathComponent(tempDirName)
                try? FileManager.default.createDirectory(atPath: tempDir, withIntermediateDirectories: true)

                defer {
                    try? FileManager.default.removeItem(atPath: tempDir)
                }

                if let unpacked = self.unpackHistoryMessage(
                    archivePath: fileURL.path,
                    tempDir: tempDir,
                    keys: keys
                ) {
                    let renderedAttachments = (unpacked.attachments ?? []).compactMap { attachment -> [String: Any]? in
                        // Same peer-authored-archivePath validation as live delivery
                        // (NetworkService) and the Windows shell (native/messages.rs).
                        guard let attachmentURL = NetworkService.safeAttachmentURL(tempDir: tempDir, archivePath: attachment.archivePath),
                              let data = try? Data(contentsOf: attachmentURL) else { return nil }

                        return [
                            "name": attachment.name,
                            "mimeType": attachment.mimeType,
                            "kind": attachment.kind,
                            "size": attachment.size,
                            "dataUrl": Self.makeDataURL(data: data, mimeType: attachment.mimeType)
                        ]
                    }

                    let result: [String: Any] = [
                        "id": messageId,
                        "clientId": record.clientId ?? record.client_id ?? "",
                        "sender": unpacked.sender,
                        "receiver": record.receiver,
                        "text": unpacked.text,
                        "call": unpacked.call ?? "",
                        "reply": unpacked.reply ?? "",
                        "attachments": renderedAttachments,
                        "timestamp": record.timestamp,
                        // Flattened to plain JSON types on purpose. `record.reactions` is
                        // [RemoteReactionSummary] — a Codable struct with no Foundation
                        // bridge, so leaving it here boxed each element as __SwiftValue and
                        // made every serialization of this payload raise an ObjC exception
                        // (see zaliJSONData). It also meant reactions never reached the UI
                        // on history load: javascriptLiteral's isValidJSONObject guard
                        // turned the whole message into `null`.
                        "reactions": (record.reactions ?? []).map { ["emoji": $0.emoji, "count": $0.count] },
                        "myReactions": record.myReactions ?? []
                    ]
                    self.cacheDecryptedMessage(messageId, result)
                    return result
                }

                // File downloaded but decryption failed — no point re-downloading
                decryptFailed = true
                print("[ZALI][WEBVIEW] \(logPrefix) decrypt failed messageId=\(messageId) keys=\(keys.count)")
                DispatchQueue.main.async {
                    self.addLog(level: "WARN", text: "Расшифровка не удалась: \(record.sender)→\(record.receiver) перебрано ключей \(keys.count) (ни один не подошёл)")
                }
                break
            }

            print("[ZALI][WEBVIEW] \(logPrefix) render failed messageId=\(messageId) decryptFailed=\(decryptFailed) downloadError=\(lastDownloadError ?? "none")")
            if decryptFailed {
                // Remembered against the key material that failed, so the identical
                // sweep is not re-run on the next refresh. Only decryption failures:
                // a download failure is transient and must always be retried.
                self.rememberDecryptFailure(messageId, fingerprint: keyFingerprint)
            }
            return decryptFailurePlaceholder(
                record: record,
                serverId: serverId,
                channelId: channelId,
                decryptFailed: decryptFailed,
                lastDownloadError: lastDownloadError
            )
        }

        /// The visible stand-in for a message this device could not render, so it shows
        /// up in the conversation instead of silently going missing.
        private func decryptFailurePlaceholder(
            record: NetworkService.RemoteMessageRecord,
            serverId: String?,
            channelId: String?,
            decryptFailed: Bool,
            lastDownloadError: String?
        ) -> [String: Any] {
            let placeholderText: String
            if decryptFailed {
                // A freshly logged-in device renders history before the conversation key
                // has arrived over /api/key-envelopes. Until then the only candidate is
                // currentKey, decryption fails, and the old wording claimed the message
                // was encrypted under someone else's key — a permanent-sounding verdict
                // on a state that repairs itself seconds later, once key sync converges
                // and history re-renders.
                let hasScopeKey = ZaliCore.hasConversationScopeKey(
                    conversationKeys: NetworkService.shared.allConversationKeys,
                    participantA: record.sender,
                    participantB: record.receiver,
                    serverId: serverId,
                    channelId: channelId
                )
                placeholderText = hasScopeKey
                    ? "🔒 Сообщение зашифровано другим ключом"
                    : "🔑 Получение ключа…"
            } else if lastDownloadError == "413" {
                placeholderText = "📦 Файл сообщения превышает допустимый размер"
            } else {
                placeholderText = "⚠️ Не удалось загрузить сообщение"
            }
            return [
                "id": record.id.trimmingCharacters(in: .whitespacesAndNewlines),
                "clientId": record.clientId ?? record.client_id ?? "",
                "sender": record.sender,
                "receiver": record.receiver,
                "text": placeholderText,
                "attachments": [],
                "timestamp": record.timestamp,
                "reactions": [],
                "myReactions": []
            ]
        }

        private func renderHistoryRecords(
            records: [NetworkService.RemoteMessageRecord],
            serverId: String?,
            channelId: String?,
            logPrefix: String
        ) async -> [[String: Any]] {
            // Sliding window instead of "one task per record, all at once".
            //
            // Every record that is not already in decryptedMessageCache costs a
            // download, and this used to start all of them simultaneously. URLSession
            // only opens httpMaximumConnectionsPerHost sockets, so on a history of any
            // size most tasks just queued — and a queued task still ages against
            // timeoutIntervalForRequest, so it expired without ever being sent. Each
            // expiry burned its three retries into the same jam and then rendered
            // "⚠️ Не удалось загрузить сообщение", which is why a single screenful mixed
            // perfectly readable messages with failed ones: the difference between them
            // was only whether they won a connection, not the key and not the data.
            //
            // Kept below the connection cap on purpose, so live message and avatar
            // downloads sharing httpSession are not starved by a history load.
            let maxConcurrentRenders = 4
            var renderedMessages = await withTaskGroup(of: [String: Any]?.self) { group -> [[String: Any]] in
                var items: [[String: Any]] = []
                var next = 0

                func addTask(for record: NetworkService.RemoteMessageRecord) {
                    group.addTask { [weak self] in
                        guard let self = self else { return nil }
                        return await self.renderHistoryRecord(
                            record: record,
                            serverId: serverId,
                            channelId: channelId,
                            logPrefix: logPrefix
                        )
                    }
                }

                while next < min(maxConcurrentRenders, records.count) {
                    addTask(for: records[next])
                    next += 1
                }
                while let item = await group.next() {
                    if let item = item { items.append(item) }
                    // Refill as each one finishes, so the window stays full without ever
                    // exceeding it.
                    if next < records.count {
                        addTask(for: records[next])
                        next += 1
                    }
                }
                return items
            }

            renderedMessages.sort {
                let lhs = ($0["timestamp"] as? String) ?? ""
                let rhs = ($1["timestamp"] as? String) ?? ""
                return lhs < rhs
            }
            return renderedMessages
        }

        private func isDirectMessageKey(_ key: String) -> Bool {
            key.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("zali-e2e:v1:dm:")
        }

        private func reloadServerHistory(serverId: String, channelId: String) {
            print("[ZALI][WEBVIEW] reloadServerHistory start server=\(serverId) channel=\(channelId)")
            let reloadToken = UUID()
            serverHistoryReloadToken = reloadToken
            reloadServerHistoryTask?.cancel()
            reloadServerHistoryTask = Task { [weak self] in
                guard let self = self else { return }
                let (records, ok) = await self.fetchServerMessagesAsync(serverId: serverId, channelId: channelId)
                guard self.serverHistoryReloadToken == reloadToken else { return }
                print("[ZALI][WEBVIEW] reloadServerHistory fetched server=\(serverId) channel=\(channelId) count=\(records.count) ok=\(ok)")

                guard ok else {
                    // Fetch failed — keep whatever is already shown instead of blanking
                    // the channel, which is what an empty "[]" push would do here.
                    print("[ZALI][WEBVIEW] reloadServerHistory fetch failed server=\(serverId) channel=\(channelId) — keeping existing view")
                    DispatchQueue.main.async {
                        guard self.serverHistoryReloadToken == reloadToken else { return }
                        self.addLog(level: "ERROR", text: "Не удалось загрузить историю канала. Показаны ранее загруженные сообщения.")
                    }
                    return
                }

                guard !records.isEmpty else {
                    DispatchQueue.main.async {
                        guard self.serverHistoryReloadToken == reloadToken else { return }
                        self.loadServerHistory(serverId: serverId, channelId: channelId, encodedHistory: "[]")
                    }
                    print("[ZALI][WEBVIEW] reloadServerHistory empty server=\(serverId) channel=\(channelId)")
                    return
                }

                let renderedMessages = await self.renderHistoryRecords(
                    records: records,
                    serverId: serverId,
                    channelId: channelId,
                    logPrefix: "reloadServerHistory"
                )

                guard self.serverHistoryReloadToken == reloadToken else { return }
                let encodedHistory = WebView.javascriptLiteral(renderedMessages)
                DispatchQueue.main.async {
                    guard self.serverHistoryReloadToken == reloadToken else { return }
                    self.loadServerHistory(serverId: serverId, channelId: channelId, encodedHistory: encodedHistory)
                }
                print("[ZALI][WEBVIEW] reloadServerHistory dispatch server=\(serverId) channel=\(channelId) rendered=\(renderedMessages.count)")
            }
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.frameInfo.isMainFrame else { return }
            if message.name == "zaliLog" {
                if let batch = message.body as? String {
                    // JS batches multiple console.* lines per message.body (see
                    // consoleHook) — split back out so each still gets its own
                    // timestamped line on disk.
                    for line in batch.split(separator: "\n", omittingEmptySubsequences: true) {
                        Coordinator.appendDebugLog(String(line))
                    }
                }
                return
            }
            if let dict = message.body as? [String: Any] {
                let type = dict["type"] as? String ?? ""
                let text = dict["text"] as? String ?? ""
                let clientId = dict["clientId"] as? String ?? UUID().uuidString
                let requestId = dict["requestId"] as? String ?? UUID().uuidString
                guard let messageType = BridgeProtocolMessageType(rawValue: type) else {
                    print("[ZALI][WEBVIEW] unknown native message type=\(type)")
                    return
                }
                switch messageType {
                case .startDrag: do {
                    DispatchQueue.main.async {
                        if let window = self.webView?.window, let event = NSApp.currentEvent {
                            window.performDrag(with: event)
                        }
                    }
                }

                case .downloadAttachment: do {
                    let dataUrl = dict["dataUrl"] as? String ?? ""
                    let filename = dict["filename"] as? String ?? "attachment"
                    self.saveAttachment(dataUrl: dataUrl, filename: filename)
                }

                case .openExternalUrl: do {
                    let urlString = dict["url"] as? String ?? ""
                    // The scheme check is defense in depth, not the primary gate — the
                    // JS side (openExternalLink in interface.js) already only calls
                    // this for http(s) hrefs it auto-linked itself. Still worth
                    // enforcing here so a message with a hand-crafted target="_blank"
                    // anchor (e.g. a future rich-text surface) can't get this to shell
                    // out to something like file:// or a registered custom scheme.
                    guard let url = URL(string: urlString),
                          let scheme = url.scheme?.lowercased(),
                          scheme == "http" || scheme == "https" else {
                        print("[ZALI][WEBVIEW] OPEN_EXTERNAL_URL rejected url=\(urlString)")
                        return
                    }
                    NSWorkspace.shared.open(url)
                }

                case .savePendingOutbox: do {
                    let items = dict["items"] as? [[String: Any]] ?? []
                    if let json = zaliJSONString(items) {
                        NetworkService.shared.savePendingOutboxJSON(json)
                    } else {
                        NetworkService.shared.savePendingOutboxJSON("[]")
                    }
                }

                case .saveMessageCache: do {
                    // Hand the raw object over and let NetworkService encode it on its
                    // own queue — this handler runs on the main thread, and the message
                    // cache is the largest payload that crosses the bridge.
                    let cache = dict["cache"] ?? dict["messageCache"] ?? [:]
                    NetworkService.shared.saveMessageCacheObject(cache)
                }

                case .authRequest: do {
                    self.handleAuthRequest(dict: dict)
                    return
                }

                case .apiRequest: do {
                    let method = (dict["method"] as? String ?? "GET").uppercased()
                    let path = dict["path"] as? String ?? ""
                    let rawHeaders = dict["headers"] as? [String: Any] ?? [:]
                    var headers: [String: String] = [:]
                    for (k, v) in rawHeaders {
                        if let sv = v as? String { headers[k] = sv }
                    }
                    let body = dict["body"] as? String
                    let timeoutMs = (dict["timeoutMs"] as? Double) ?? 12000
                    NetworkService.shared.performApiRequest(
                        method: method, path: path, headers: headers,
                        body: body, timeoutMs: timeoutMs
                    ) { [weak self] status, bodyStr, bodyBase64, respHeaders, error in
                        DispatchQueue.main.async {
                            guard let self else { return }
                            if let error, status == 0 {
                                // Genuine transport failure (no HTTP response at all — DNS,
                                // connection refused, timeout). Top-level "ok": false here
                                // is correct: onNativeResponse() rejects the JS promise.
                                self.sendNativeResponse([
                                    "requestId": requestId,
                                    "ok": false,
                                    "error": error,
                                ])
                                return
                            }
                            // Any real HTTP response, even 4xx/5xx, is a successful native
                            // round-trip — top-level "ok" must stay true so onNativeResponse()
                            // resolves the JS promise instead of rejecting it. The actual
                            // HTTP-level outcome goes in data.ok/status, which
                            // nativeApiResponse() on the JS side already expects (matches
                            // the Windows/Rust client's perform_api_request). Previously this
                            // set top-level "ok" from the HTTP status itself, so every
                            // non-2xx server response (409 "user exists", 400 validation,
                            // 429 rate limit, ...) was treated as a native failure and
                            // collapsed into the generic "Операция не удалась" — hiding the
                            // real reason and breaking executeAuth's 409 recovery logic.
                            // Только String/Number/Bool/Array/Dictionary — см. JSONSafe.swift:
                            // Optional и любой Swift-тип приезжают к писателю как
                            // __SwiftValue и поднимают ObjC-исключение прямо сквозь
                            // async-кадры.
                            var responseData: [String: Any] = [
                                "status": status,
                                "ok": (status >= 200 && status < 300),
                                "body": bodyStr ?? "",
                                "headers": respHeaders ?? [:],
                            ]
                            // Непустой только для нетекстовых ответов — см.
                            // NetworkService.isTextualContentType.
                            if let bodyBase64, !bodyBase64.isEmpty {
                                responseData["bodyBase64"] = bodyBase64
                            }
                            self.sendNativeResponse([
                                "requestId": requestId,
                                "ok": true,
                                "data": responseData,
                            ])
                        }
                    }
                    return
                }

                case .addContactRequest: do {
                    self.handleContactRequest(dict: dict, add: true)
                    return
                }

                case .removeContactRequest: do {
                    self.handleContactRequest(dict: dict, add: false)
                    return
                }

                case .uploadAvatarRequest: do {
                    self.handleAvatarRequest(dict: dict, delete: false)
                    return
                }

                case .deleteAvatarRequest: do {
                    self.handleAvatarRequest(dict: dict, delete: true)
                    return
                }

                case .loadAvatarRequest: do {
                    let requestId = dict["requestId"] as? String ?? dict["request_id"] as? String ?? UUID().uuidString
                    let username = (dict["username"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                    if username.isEmpty || requestId.isEmpty {
                        self.sendBusEvent(.nativeResponse, payload: WebView.javascriptLiteral([
                            "requestId": requestId,
                            "ok": false,
                            "error": "Не удалось загрузить аватар",
                        ]))
                        return
                    }
                    NetworkService.shared.performAvatarFetch(username: username) { [weak self] success, payload, error in
                        DispatchQueue.main.async {
                            guard let self = self else { return }
                            if success, let payload {
                                self.sendBusEvent(.nativeResponse, payload: WebView.javascriptLiteral([
                                    "requestId": requestId,
                                    "ok": true,
                                    "data": payload,
                                ]))
                            } else {
                                self.sendBusEvent(.nativeResponse, payload: WebView.javascriptLiteral([
                                    "requestId": requestId,
                                    "ok": false,
                                    "error": error ?? "Не удалось загрузить аватар",
                                ]))
                            }
                        }
                    }
                    return
                }

                case .downloadUpdateRequest: do {
                    self.handleDownloadUpdateRequest(dict: dict, requestId: requestId)
                    return
                }

                case .installUpdateRequest: do {
                    self.handleInstallUpdateRequest(requestId: requestId)
                    return
                }

                case .sendMessage: do {
                    guard Coordinator.tryClaimSendClientId(clientId) else {
                        print("[ZALI][WEBVIEW] SEND_MESSAGE duplicate_in_flight clientId=\(clientId)")
                        return
                    }
                    let recipient = dict["recipient"] as? String ?? "Alice"
                    let sender = dict["sender"] as? String ?? NetworkService.shared.currentUser
                    let requestedKey = (dict["key"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                    let keyVersion = (dict["keyVersion"] as? NSNumber)?.intValue
                        ?? (dict["key_version"] as? NSNumber)?.intValue
                        ?? (dict["keyVersion"] as? Int)
                        ?? (dict["key_version"] as? Int)
                        ?? 2
                    let serverId = dict["serverId"] as? String
                    let channelId = dict["channelId"] as? String
                    let key = requestedKey
                    guard !key.isEmpty else {
                        print("[ZALI][WEBVIEW] SEND_MESSAGE missing requested key clientId=\(clientId)")
                        Coordinator.releaseSendClientId(clientId)
                        DispatchQueue.main.async {
                            self.addLog(level: "ERROR", text: "Core: E2E-ключ не задан")
                            self.sendBusEvent(.onSendError, payload: WebView.javascriptLiteral([
                                "clientId": clientId,
                                "statusCode": 0,
                                "responseBody": "Core: E2E-ключ не задан"
                            ]))
                        }
                        return
                    }
                    let tempPath = NSTemporaryDirectory() + UUID().uuidString + ".zali"
                    let attachments = dict["attachments"] as? [[String: Any]] ?? []
                    var packedAttachments: [[String: Any]] = []
                    var tempAttachmentURLs: [URL] = []
                    print("[ZALI][WEBVIEW] SEND_MESSAGE start clientId=\(clientId) sender=\(sender) recipient=\(recipient) serverId=\(serverId ?? "nil") channelId=\(channelId ?? "nil") attachments=\(attachments.count) textBytes=\(text.count) requestedKeySet=\(!requestedKey.isEmpty)")

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
                    
                    // Opaque structured payload (call records) — forwarded to the core,
                    // which encrypts it with the conversation key like the body.
                    let callPayload = (dict["call"] as? String)?
                        .trimmingCharacters(in: .whitespacesAndNewlines)
                    // Quote of the message being replied to — opaque here, encrypted
                    // by the core exactly like the call payload above.
                    let replyPayload = (dict["reply"] as? String)?
                        .trimmingCharacters(in: .whitespacesAndNewlines)
                    if ZaliCore.shared.packMessage(sender: sender, text: text, output: tempPath, key: key, keyVersion: keyVersion, attachments: packedAttachments, call: (callPayload?.isEmpty == false) ? callPayload : nil, reply: (replyPayload?.isEmpty == false) ? replyPayload : nil) {
                        DispatchQueue.main.async {
                            self.addLog(level: "SUCCESS", text: "Core: Сообщение успешно упаковано и зашифровано в Rust бэкенде")
                        }
                        tempAttachmentURLs.forEach { try? FileManager.default.removeItem(at: $0) }
                        print("[ZALI][WEBVIEW] SEND_MESSAGE packed clientId=\(clientId) tempPath=\(tempPath) packedAttachments=\(packedAttachments.count)")
                        
                        let fileURL = URL(fileURLWithPath: tempPath)
                        NetworkService.shared.uploadMessage(sender: sender, receiver: recipient, clientId: clientId, fileURL: fileURL, serverId: serverId, channelId: channelId, keyVersion: keyVersion) { [weak self] success, messageId, statusCode, responseBody in
                            print("[ZALI][WEBVIEW] SEND_MESSAGE upload callback clientId=\(clientId) success=\(success) messageId=\(messageId ?? "nil") status=\(statusCode.map(String.init) ?? "nil") body=\((responseBody ?? "").prefix(200))")
                            Coordinator.releaseSendClientId(clientId)
                            DispatchQueue.main.async {
                                let safeClientId = WebView.javascriptLiteral(clientId)
                                let safeMessageId = WebView.javascriptLiteral(messageId ?? "")
                                if success {
                                    self?.addLog(level: "SUCCESS", text: "Network: Сообщение отправлено на сервер")
                                    self?.sendBusEvent(.onSendSuccess, payload: "{ clientId: \(safeClientId), messageId: \(safeMessageId) }")
                                } else {
                                    let statusLabel = statusCode.map { "HTTP \($0)" } ?? "без статуса"
                                    let bodyText = (responseBody ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                                    let detail = bodyText.isEmpty ? "" : " (\(bodyText.prefix(140)))"
                                    self?.addLog(level: "ERROR", text: "Network: Не удалось отправить сообщение на сервер \(statusLabel)\(detail)")
                                    self?.sendBusEvent(.onSendError, payload: WebView.javascriptLiteral([
                                        "clientId": clientId,
                                        "statusCode": statusCode ?? 0,
                                        "responseBody": bodyText
                                    ]))
                                }
                            }
                            try? FileManager.default.removeItem(at: fileURL)
                        }
                    } else {
                        tempAttachmentURLs.forEach { try? FileManager.default.removeItem(at: $0) }
                        Coordinator.releaseSendClientId(clientId)
                        DispatchQueue.main.async {
                            self.addLog(level: "ERROR", text: "Core: Ошибка при упаковке сообщения в Rust бэкенде")
                            self.sendBusEvent(.onSendError, payload: WebView.javascriptLiteral([
                                "clientId": clientId,
                                "statusCode": 0,
                                "responseBody": "Core: Ошибка при упаковке сообщения в Rust бэкенде"
                            ]))
                        }
                    }
                }

                case .editMessage: do {
                    let requestId = dict["requestId"] as? String ?? dict["request_id"] as? String ?? UUID().uuidString
                    let messageId = (dict["messageId"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                    let text = dict["text"] as? String ?? ""
                    let key = (dict["key"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                    let keyVersion = (dict["keyVersion"] as? NSNumber)?.intValue
                        ?? (dict["key_version"] as? NSNumber)?.intValue
                        ?? (dict["keyVersion"] as? Int)
                        ?? (dict["key_version"] as? Int)
                        ?? 2
                    let callPayload = (dict["call"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
                    let replyPayload = (dict["reply"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)

                    guard !messageId.isEmpty, !key.isEmpty else {
                        print("[ZALI][WEBVIEW] EDIT_MESSAGE missing messageId/key messageId=\(messageId) keySet=\(!key.isEmpty)")
                        self.sendNativeResponse([
                            "requestId": requestId,
                            "ok": false,
                            "error": key.isEmpty ? "Core: E2E-ключ не задан" : "Не указано сообщение",
                        ])
                        return
                    }

                    // The edit carries the WHOLE message, attachments included: the
                    // archive is replaced wholesale server-side, so anything omitted
                    // here is genuinely dropped from the message.
                    let tempPath = NSTemporaryDirectory() + UUID().uuidString + ".zali"
                    let attachments = dict["attachments"] as? [[String: Any]] ?? []
                    var packedAttachments: [[String: Any]] = []
                    var tempAttachmentURLs: [URL] = []
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

                    print("[ZALI][WEBVIEW] EDIT_MESSAGE start messageId=\(messageId) attachments=\(packedAttachments.count) textBytes=\(text.count)")

                    guard ZaliCore.shared.packMessage(
                        sender: NetworkService.shared.currentUser,
                        text: text,
                        output: tempPath,
                        key: key,
                        keyVersion: keyVersion,
                        attachments: packedAttachments,
                        call: (callPayload?.isEmpty == false) ? callPayload : nil,
                        reply: (replyPayload?.isEmpty == false) ? replyPayload : nil
                    ) else {
                        tempAttachmentURLs.forEach { try? FileManager.default.removeItem(at: $0) }
                        self.addLog(level: "ERROR", text: "Core: Ошибка при упаковке отредактированного сообщения")
                        self.sendNativeResponse([
                            "requestId": requestId,
                            "ok": false,
                            "error": "Core: Ошибка при упаковке сообщения",
                        ])
                        return
                    }
                    tempAttachmentURLs.forEach { try? FileManager.default.removeItem(at: $0) }

                    let fileURL = URL(fileURLWithPath: tempPath)
                    NetworkService.shared.editMessage(messageId: messageId, fileURL: fileURL, keyVersion: keyVersion) { [weak self] success, statusCode, responseBody in
                        try? FileManager.default.removeItem(at: fileURL)
                        DispatchQueue.main.async {
                            guard let self = self else { return }
                            if success {
                                // The cache is keyed by message id and holds the text
                                // decrypted from the archive we just replaced — leaving
                                // it would make every later history reload re-render the
                                // pre-edit message and look like the edit was lost.
                                // Through forgetDecryptedMessage, not a bare removeValue:
                                // the entry also has a slot in the eviction order and may
                                // have a "no key opens this" verdict attached, and both
                                // describe the archive that was just replaced.
                                self.forgetDecryptedMessage(messageId)
                                self.addLog(level: "SUCCESS", text: "Network: Сообщение отредактировано")
                                self.sendNativeResponse(["requestId": requestId, "ok": true])
                            } else {
                                let bodyText = (responseBody ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                                let statusLabel = statusCode.map { "HTTP \($0)" } ?? "без статуса"
                                self.addLog(level: "ERROR", text: "Network: Не удалось отредактировать сообщение \(statusLabel)")
                                self.sendNativeResponse([
                                    "requestId": requestId,
                                    "ok": false,
                                    "error": bodyText.isEmpty ? "Не удалось отредактировать сообщение (\(statusLabel))" : bodyText,
                                ])
                            }
                        }
                    }
                }

                case .setSession: do {
                    let username = dict["username"] as? String ?? "Zalikus"
                    let token = dict["token"] as? String
                    let deviceId = dict["deviceId"] as? String
                    print("[ZALI][WEBVIEW] SET_SESSION username=\(username) tokenSet=\(!(token ?? "").isEmpty) deviceId=\(deviceId ?? "") currentUserBefore=\(NetworkService.shared.currentUser)")
                    NetworkService.shared.setSession(username: username, token: token, deviceId: deviceId) { [weak self] in
                        guard let self = self else { return }
                        print("[ZALI][WEBVIEW] SET_SESSION applied username=\(NetworkService.shared.currentUser) tokenSet=\(NetworkService.shared.currentKey.isEmpty ? "false" : "true")")
                        self.setLoading(false)
                        // setConnectionStatus is no longer forced true here — it used to fire
                        // unconditionally regardless of whether the message WebSocket (or even
                        // a valid token) existed, so the "Подключено" badge stayed green for
                        // sessions that could never receive anything live (e.g. a stale
                        // username with an empty token). onWebSocketConnected/Disconnected now
                        // own this signal end-to-end, driven by the actual socket state.

                        NetworkService.shared.fetchUsers { users in
                            let encodedUsers = WebView.javascriptLiteral(users)
                            DispatchQueue.main.async {
                                self.setUsers(encodedUsers)
                            }
                        }

                        NetworkService.shared.fetchContacts { contacts in
                            guard let contacts = contacts else { return }
                            let encodedContacts = WebView.javascriptLiteral(contacts)
                            DispatchQueue.main.async {
                                self.setContacts(encodedContacts)
                            }
                        }

                        self.syncCryptoKeyFromWebUI(reason: "setSession") {
                            self.refreshActiveConversationHistory(reason: "setSession")
                        }
                        self.exportDeviceIdentityToSharedFile()
                    }
                }

                case .loadServerHistory: do {
                    let serverId = dict["serverId"] as? String ?? ""
                    let channelId = dict["channelId"] as? String ?? ""
                    let key = (dict["key"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                    if !serverId.isEmpty && !channelId.isEmpty {
                        print("[ZALI][WEBVIEW] LOAD_SERVER_HISTORY request server=\(serverId) channel=\(channelId)")
                        if !key.isEmpty {
                            NetworkService.shared.currentKey = key
                            NetworkService.shared.persistCurrentKey()
                        }
                        self.reloadServerHistory(serverId: serverId, channelId: channelId)
                    }
                }

                case .resolveTenor: do {
                    let url = dict["url"] as? String ?? ""
                    self.resolveTenor(url: url, requestId: requestId)
                }

                // Sent once by the JS side when it applies the local-data reset epoch
                // (see applyLocalDataResetIfNeeded in interface.js). Clearing
                // localStorage there is not enough: the crypto key, session, message
                // cache and conversation keys also live in UserDefaults and in plain
                // files under Application Support, and are injected back into every
                // fresh WebView at document-start.
                case .clearLocalData: do {
                    print("[ZALI][WEBVIEW] CLEAR_LOCAL_DATA received")
                    NetworkService.shared.clearAllLocalData()
                    Coordinator.saveLegacyCryptoKey("")
                    Coordinator.removeSharedDeviceIdentities()
                    self.clearDecryptCaches()
                    self.consoleLog("Swift: локальные данные очищены (сброс базы)")
                }
                
                case .setKey: do {
                    let key = (dict["key"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                    let conversationKeys = (dict["conversationKeys"] as? [String: String]) ?? [:]
                    print("[ZALI][WEBVIEW] SET_KEY keySet=\(!key.isEmpty) length=\(key.count) scopes=\(conversationKeys.count)")
                    NetworkService.shared.currentKey = key
                    if !conversationKeys.isEmpty {
                        NetworkService.shared.allConversationKeys = conversationKeys
                        NetworkService.shared.persistConversationKeys()
                    }
                    if !key.isEmpty {
                        NetworkService.shared.persistCurrentKey()
                    }
                    Coordinator.saveLegacyCryptoKey(key)
                    DispatchQueue.main.async {
                        if self.isDirectMessageKey(key) {
                            self.consoleLog("Swift: E2E ключ обновлён")
                        }
                        self.scheduleRefreshActiveConversationHistory(reason: "setKey")
                    }
                }

                case .refreshHistory: do {
                    let key = (dict["key"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                    let peer = (dict["peer"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                    if !key.isEmpty {
                        NetworkService.shared.currentKey = key
                        NetworkService.shared.persistCurrentKey()
                        Coordinator.saveLegacyCryptoKey(key)
                    }
                    if !peer.isEmpty {
                        print("[ZALI][WEBVIEW] REFRESH_HISTORY peer=\(peer)")
                        DispatchQueue.main.async {
                            self.scheduleReloadHistory(for: peer, reason: "refreshHistory")
                        }
                        return
                    }
                    print("[ZALI][WEBVIEW] REFRESH_HISTORY user=\(NetworkService.shared.currentUser)")
                    DispatchQueue.main.async {
                        self.scheduleRefreshActiveConversationHistory(reason: "refreshHistory")
                    }
                }

                case .networkConfig: do {
                    let apiBaseURL = dict["apiBaseUrl"] as? String
                    let wsBaseURL = dict["wsBaseUrl"] as? String
                    NetworkService.shared.configure(apiBaseURL: apiBaseURL, wsBaseURL: wsBaseURL)
                    DispatchQueue.main.async {
                        self.addLog(level: "SUCCESS", text: "Swift: Network config applied")
                    }
                }

                case .setMessageReaction: do {
                    let messageId = dict["messageId"] as? String ?? ""
                    let emoji = dict["emoji"] as? String ?? ""
                    NetworkService.shared.setMessageReaction(messageId: messageId, emoji: emoji) { success, payload in
                        DispatchQueue.main.async {
                            if success, let payload {
                                let safePayload = WebView.javascriptLiteral(payload)
                                self.receiveReactionUpdate(safePayload)
                            } else {
                                self.addLog(level: "ERROR", text: "Не удалось сохранить реакцию на сервере")
                            }
                        }
                    }
                }

                case .voiceEvent: do {
                    let payload = dict["payload"] as? [String: Any] ?? dict["event"] as? [String: Any] ?? dict
                    let voiceType = payload["type"] as? String ?? ""
                    print("[VOICE][BRIDGE][OUT] type=\(voiceType) roomId=\(payload["roomId"] as? String ?? "") roomType=\(payload["roomType"] as? String ?? "") to=\(payload["to"] as? String ?? "") target=\(payload["target"] as? String ?? "")")
                    NetworkService.shared.sendVoiceEvent(payload) { success in
                        DispatchQueue.main.async {
                            let level = success ? "SUCCESS" : "ERROR"
                            let text = success ? "Голосовое событие отправлено" : "Не удалось отправить голосовое событие"
                            self.logToWeb(level: level, text: text)
                        }
                    }
                }
                
                case .saveStyle: do {
                    let css = dict["css"] as? String ?? ""
                    UserDefaults.standard.set(css, forKey: "custom_css")

                    DispatchQueue.main.async {
                        self.consoleLog("Swift: Стили сохранены в UserDefaults")
                    }
                }

                case .showNotification: do {
                    let sender = (dict["sender"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                    let text = dict["text"] as? String ?? ""
                    let attachmentCount = (dict["attachmentCount"] as? NSNumber)?.intValue ?? 0
                    let serverId = dict["serverId"] as? String
                    let channelId = dict["channelId"] as? String
                    NativeNotificationService.shared.showMessageNotification(
                        sender: sender,
                        text: text,
                        attachmentCount: attachmentCount,
                        serverId: serverId,
                        channelId: channelId
                    )
                }

                case .persistDeviceIdentity: do {
                    // JS signals that the device identity was created/changed. Re-export it to
                    // the shared per-user file so a Rust-shell (or a rebuild that wipes this
                    // WebView's localStorage) re-adopts the same device_id instead of minting a
                    // fresh one — the churn that orphaned key envelopes. Reuses the existing
                    // localStorage-reading exporter; the JS payload itself is not trusted/needed.
                    DispatchQueue.main.async {
                        self.exportDeviceIdentityToSharedFile()
                    }
                }

                case .setUnreadBadge:
                    // Windows-only feature (taskbar overlay badge, see CLAUDE.md /
                    // apps/windows/src/native/taskbar_badge.rs) — `taskbarBadge` is never
                    // advertised as a supported capability here, so the JS side never
                    // actually sends this on macOS. No-op kept only for switch exhaustiveness.
                    break

                case .startScreenCapture, .stopScreenCapture:
                    // Android-only (MediaProjection capture, see NativeBridge.kt /
                    // ScreenCaptureService.kt). macOS's WKWebView already supports
                    // getDisplayMedia() natively, so interface.js's screen-share
                    // path never takes the native branch here. No-op kept only for
                    // switch exhaustiveness.
                    break

                case .mobileNavProgress:
                    // Android-only (see MainActivity.kt/NativeBridge.kt): syncs the
                    // mobile list<->chat push-nav progress into the native Compose
                    // bottom bar, which sits outside the WebView there and can't see
                    // interface.js's own transform. macOS has no such native bar —
                    // `mobileNav` is never advertised as a supported capability here,
                    // so interface.js never sends this. No-op kept only for switch
                    // exhaustiveness.
                    break

                case .minimizeWindow, .maximizeWindow, .closeWindow:
                    // Windows-only (native OS decorations are switched off there in
                    // favor of an in-app titlebar, see apps/windows/src/main.rs). This
                    // client keeps native decorations with the real traffic-light
                    // buttons via titlebarAppearsTransparent, so `windowControls` is
                    // never advertised as a supported capability here and JS never
                    // sends these. No-op kept only for switch exhaustiveness.
                    break
            }
            }
        }

        /// Origin pin for the app's own web UI.
        ///
        /// The whole native API — session token, conversation keys, filesystem
        /// writes, message sending — is reachable from JS as
        /// `window.webkit.messageHandlers.*`, and WebKit hands those handlers to
        /// *whatever* document occupies the frame, not only to the one that was
        /// loaded at startup. So a single navigation away from `http://localhost`
        /// (a link the auto-linker missed, a `location.href` from anything
        /// injected into the 21.5k-line shared UI, a redirect) would put a remote
        /// page in the main frame holding the full bridge. `isMainFrame` checks in
        /// `userContentController` do not help there — the attacker page *is* the
        /// main frame.
        ///
        /// Nothing in this app ever needs to navigate: the UI is a single
        /// `loadHTMLString` document that talks to the server over the native
        /// HTTP bridge. So the policy is a pin, not a filter — allow the initial
        /// load and same-document/about: URLs, hand http(s) to the real browser
        /// (same path `openExternalUrl` already uses), and cancel everything else.
        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            guard let url = navigationAction.request.url else {
                decisionHandler(.cancel)
                return
            }
            if WebView.isAppOriginURL(url) {
                decisionHandler(.allow)
                return
            }
            let scheme = url.scheme?.lowercased() ?? ""
            if ["http", "https", "mailto", "tel"].contains(scheme) {
                print("[ZALI][WEBVIEW] navigation to external origin handed to the OS url=\(url.absoluteString)")
                NSWorkspace.shared.open(url)
            } else {
                print("[ZALI][WEBVIEW] navigation blocked url=\(url.absoluteString)")
            }
            decisionHandler(.cancel)
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            print("[ZALI][WEBVIEW] didFinish currentUser=\(NetworkService.shared.currentUser) keySet=\(!NetworkService.shared.currentKey.isEmpty)")
            self.setLoading(false)
            // Was unconditionally true here too — page load finishing says nothing about
            // network state. See the SET_SESSION handler's comment for the full story.
            self.syncCryptoKeyFromWebUI(reason: "didFinish") { [weak self] in
                guard let self = self else { return }
                NetworkService.shared.fetchUsers { users in
                    let encodedUsers = WebView.javascriptLiteral(users)
                    DispatchQueue.main.async {
                        self.setUsers(encodedUsers)
                    }
                }
                NetworkService.shared.fetchContacts { contacts in
                    guard let contacts = contacts else { return }
                    let encodedContacts = WebView.javascriptLiteral(contacts)
                    DispatchQueue.main.async {
                        self.setContacts(encodedContacts)
                    }
                }
                self.refreshActiveConversationHistory(reason: "didFinish")
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
            let allowed = ["localhost", "127.0.0.1", "::1"]
            guard frame.isMainFrame,
                  allowed.contains(origin.host) else {
                decisionHandler(.deny)
                return
            }
            decisionHandler(.grant)
        }
    }
    
    func makeCoordinator() -> Coordinator { Coordinator() }

    /// The only origin allowed to occupy the WebView's frames. Must stay in
    /// sync with the `baseURL` passed to `loadHTMLString` in `makeNSView`.
    static func isAppOriginURL(_ url: URL) -> Bool {
        let scheme = url.scheme?.lowercased() ?? ""
        if scheme == "about" || scheme == "blob" { return true }
        guard scheme == "http" else { return false }
        let host = url.host?.lowercased() ?? ""
        return host == "localhost" || host == "127.0.0.1" || host == "::1"
    }

    private static func loadBridgeProtocolBootstrap() -> String {
        let candidates = [
            Bundle.module.url(forResource: "bridge_protocol", withExtension: "json", subdirectory: "Web"),
            Bundle.module.url(forResource: "bridge_protocol", withExtension: "json"),
        ]
        for url in candidates.compactMap({ $0 }) {
            if let raw = try? String(contentsOf: url, encoding: .utf8) {
                let json = raw.trimmingCharacters(in: .whitespacesAndNewlines)
                if !json.isEmpty {
                    return "window.__ZALI_BRIDGE_PROTOCOL__ = \(json);"
                }
            }
        }
        return "window.__ZALI_BRIDGE_PROTOCOL__ = {\"version\":1,\"messages\":{}};"
    }
    
    func makeWebView(coordinator: Coordinator) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.userContentController.add(coordinator, name: "nativeApp")
        // Debug log capture: mirror every JS console.* call to a file on disk
        // (~/Library/Application Support/ZaliMessenger/zali-debug.log) so the whole
        // in-app journal is readable without copy-pasting from the UI.
        config.userContentController.add(coordinator, name: "zaliLog")
        let consoleHook = """
        (function(){
          if (window.__zaliConsoleHooked) return; window.__zaliConsoleHooked = true;
          // Buffered: a naive per-call postMessage() here was the dominant source of
          // UI-click latency on macOS — every console.log/trace() in the app (there
          // are hundreds along common paths like switchChat) took its own synchronous
          // hop across the WKWebView JS<->native bridge, contending with the main
          // thread that also has to paint. Batch lines and flush on a short timer
          // instead, so one click costs at most one bridge hop, not dozens.
          var buf = [];
          var flushTimer = null;
          var flush = function(){
            flushTimer = null;
            if (!buf.length) return;
            var payload = buf.join('\\n');
            buf = [];
            try { window.webkit.messageHandlers.zaliLog.postMessage(payload); } catch(e){}
          };
          var post = function(lvl, args){
            try {
              var parts = Array.prototype.map.call(args, function(a){
                try { return (typeof a === 'string') ? a : JSON.stringify(a); } catch(e){ return String(a); }
              });
              buf.push(lvl + ' ' + parts.join(' '));
              if (buf.length > 200) { flush(); return; }
              if (!flushTimer) flushTimer = setTimeout(flush, 200);
            } catch(e){}
          };
          window.addEventListener('pagehide', flush);
          ['log','info','warn','error'].forEach(function(k){
            var orig = console[k] ? console[k].bind(console) : function(){};
            console[k] = function(){ post(k.toUpperCase(), arguments); orig.apply(console, arguments); };
          });
        })();
        """
        config.userContentController.addUserScript(WKUserScript(source: consoleHook, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let bridgeProtocolBootstrap = WebView.loadBridgeProtocolBootstrap()
        config.userContentController.addUserScript(WKUserScript(source: bridgeProtocolBootstrap, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let nativeCapabilities: [String: Any] = [
            "sendMessage": true,
            "sessionSync": true,
            "networkConfig": true,
            "setKey": true,
            "saveStyle": true,
            "saveMessageCache": true,
            "downloadAttachment": true,
            "openExternalUrl": true,
            "serverHistory": true,
            "avatarFetch": true,
            "tenor": true,
            "voice": true,
            "windowDrag": true,
            "apiRequest": true,
            "appUpdate": true,
        ]
        let nativeCapsBootstrap = "window.__ZALI_NATIVE_CAPS__ = \(WebView.javascriptLiteral(nativeCapabilities));"
        config.userContentController.addUserScript(WKUserScript(source: nativeCapsBootstrap, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let appVersion = (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "0.0"
        let versionBootstrap = "window.__ZALI_NATIVE_APP_VERSION = \(WebView.javascriptLiteral(appVersion)); window.__ZALI_NATIVE_PLATFORM = \(WebView.javascriptLiteral("macos"));"
        config.userContentController.addUserScript(WKUserScript(source: versionBootstrap, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let savedCss = UserDefaults.standard.string(forKey: "custom_css") ?? ""
        let savedCssBootstrap = "window.__ZALI_SAVED_CSS = \(WebView.javascriptLiteral(savedCss));"
        config.userContentController.addUserScript(WKUserScript(source: savedCssBootstrap, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let inMemorySavedKey = NetworkService.shared.currentKey.trimmingCharacters(in: .whitespacesAndNewlines)
        let savedKey = inMemorySavedKey.isEmpty ? Coordinator.loadLegacyCryptoKey().trimmingCharacters(in: .whitespacesAndNewlines) : inMemorySavedKey
        let bootstrap = "window.__ZALI_SAVED_KEY = \(WebView.javascriptLiteral(savedKey));"
        config.userContentController.addUserScript(WKUserScript(source: bootstrap, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let conversationKeysForBootstrap = NetworkService.shared.allConversationKeys
        let convKeysBootstrap = "window.__ZALI_CONVERSATION_KEYS = \(WebView.javascriptLiteral(conversationKeysForBootstrap));"
        config.userContentController.addUserScript(WKUserScript(source: convKeysBootstrap, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        // Stamps whose account the injected key map and device identity belong to.
        // Both are read from the LAST logged-in user's storage and then live for the
        // whole life of the document, while applySession only swaps the in-page
        // session — so signing in as someone else afterwards used to merge the
        // previous account's conversation keys into the new one's store and hand it
        // the previous account's device identity, private ECDH key included. The
        // shared UI now refuses injected material stamped for a different account
        // (injectedMaterialMatchesAccount() in web/src/interface/key_resolution.js).
        let injectedForUser = NetworkService.shared.currentUser.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if !injectedForUser.isEmpty {
            let injectedForUserBootstrap = "window.__ZALI_INJECTED_FOR_USER = \(WebView.javascriptLiteral(injectedForUser));"
            config.userContentController.addUserScript(WKUserScript(source: injectedForUserBootstrap, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }

        // Re-adopt the on-disk device identity so a WebView localStorage wipe doesn't mint a
        // fresh device_id and orphan the key envelopes addressed to the old one. Raw JSON is
        // already validated by loadSharedDeviceIdentity; JS only consumes it when it has no
        // identity of its own (loadDeviceIdentity's injected-fallback). Mirrors native.rs.
        if let identityRaw = Coordinator.loadSharedDeviceIdentity(for: NetworkService.shared.currentUser) {
            let identityBootstrap = "window.__ZALI_INJECTED_DEVICE_IDENTITY = \(identityRaw);"
            config.userContentController.addUserScript(WKUserScript(source: identityBootstrap, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
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
        let messageCache = NetworkService.shared.currentMessageCacheJSON()
        let messageCacheObject: Any = (try? JSONSerialization.jsonObject(with: Data(messageCache.utf8), options: [])) ?? ["chats": [:], "serverChats": [:]]
        let messageCacheBootstrap = "window.__ZALI_MESSAGE_CACHE = \(WebView.javascriptLiteral(messageCacheObject));"
        config.userContentController.addUserScript(WKUserScript(source: messageCacheBootstrap, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        
        let webView = ZaliNativeWebView(frame: .zero, configuration: config)
        coordinator.webView = webView
        webView.navigationDelegate = coordinator
        webView.uiDelegate = coordinator
        webView.setValue(false, forKey: "drawsBackground")
        webView.allowsMagnification = false
        webView.configuration.allowsAirPlayForMediaPlayback = true
        if #available(macOS 10.12, *) {
            webView.configuration.mediaTypesRequiringUserActionForPlayback = []
        }
        webView.configuration.preferences.setValue(false, forKey: "javaScriptCanOpenWindowsAutomatically")
        
        webView.loadHTMLString(WebAssets.html, baseURL: URL(string: "http://localhost"))
        
        NetworkService.shared.onMessageReceived = { id, clientId, sender, receiver, text, call, attachments, serverId, channelId in
            let safeServerId = WebView.javascriptLiteral(serverId as Any)
            let safeChannelId = WebView.javascriptLiteral(channelId as Any)
            let safeId = WebView.javascriptLiteral(id)
            let safeClientId = WebView.javascriptLiteral(clientId as Any)
            let safeSender = WebView.javascriptLiteral(sender)
            let safeReceiver = WebView.javascriptLiteral(receiver)
            let safeText = WebView.javascriptLiteral(text)
            let safeCall = WebView.javascriptLiteral(call ?? "")
            let safeAttachments = WebView.javascriptLiteral(attachments)
            
            DispatchQueue.main.async {
                let payload = "{ id: \(safeId), clientId: \(safeClientId), sender: \(safeSender), receiver: \(safeReceiver), text: \(safeText), call: \(safeCall), attachments: \(safeAttachments), serverId: \(safeServerId), channelId: \(safeChannelId) }"
                coordinator.receiveMessage(payload)
            }
        }
        NetworkService.shared.onMessageDecryptFailed = { _, sender, receiver, serverId, channelId in
            let payload: [String: Any] = [
                "force": true,
                "peer": sender == NetworkService.shared.currentUser ? receiver : sender,
                "serverId": serverId ?? "",
                "channelId": channelId ?? "",
            ]
            let safePayload = WebView.javascriptLiteral(payload)
            DispatchQueue.main.async {
                coordinator.sendBusEvent(.syncActiveConversation, payload: safePayload)
            }
        }
        NetworkService.shared.onReactionUpdated = { payload in
            let safePayload = WebView.javascriptLiteral(payload)
            DispatchQueue.main.async {
                coordinator.receiveReactionUpdate(safePayload)
            }
        }
        NetworkService.shared.onMessageDeleted = { payload in
            let safePayload = WebView.javascriptLiteral(payload)
            DispatchQueue.main.async {
                coordinator.receiveMessageDeleted(safePayload)
            }
        }
        NetworkService.shared.onMessageEdited = { payload in
            // The stale entry must go before the JS side asks for history again,
            // otherwise renderHistoryRecord answers that request from the cache and
            // hands back the pre-edit text.
            if let editedId = (payload["messageId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
               !editedId.isEmpty {
                DispatchQueue.main.async {
                    coordinator.forgetDecryptedMessage(editedId)
                }
            }
            let safePayload = WebView.javascriptLiteral(payload)
            DispatchQueue.main.async {
                coordinator.receiveMessageEdited(safePayload)
            }
        }
        NetworkService.shared.onAvatarChanged = { username, deleted in
            DispatchQueue.main.async {
                if deleted {
                    coordinator.avatarDeleted(username)
                } else {
                    coordinator.avatarUpdated(username)
                }
            }
        }
        NetworkService.shared.onVoiceEvent = { payload in
            let safePayload = WebView.javascriptLiteral(payload)
            DispatchQueue.main.async {
                coordinator.receiveVoiceEvent(safePayload)
            }
        }
        NetworkService.shared.onKeyEnvelopeAvailable = {
            DispatchQueue.main.async {
                coordinator.scheduleRefreshAfterKey()
            }
        }
        NetworkService.shared.onDeviceApproved = {
            DispatchQueue.main.async {
                coordinator.retryPublishKeys()
            }
        }
        NetworkService.shared.onKeyRepublishRequest = { payload in
            DispatchQueue.main.async {
                coordinator.keyRepublishRequest(payload)
            }
        }
        NetworkService.shared.onRealtimeEvent = { payload in
            DispatchQueue.main.async {
                coordinator.receiveRealtimeEvent(payload)
            }
        }
        NetworkService.shared.onWebSocketConnected = {
            coordinator.setConnectionStatus(true)
            coordinator.refreshActiveConversationHistory(reason: "wsReconnect")
        }
        NetworkService.shared.onWebSocketDisconnected = {
            coordinator.setConnectionStatus(false)
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

        guard let json = zaliJSONString(value) else {
            return "null"
        }
        return json
    }
    
}
