import Foundation

class NetworkService: NSObject, URLSessionWebSocketDelegate {
    static let shared = NetworkService()
    
    private let connectionQueue = DispatchQueue(label: "zali.network.websocket")
    private let configQueue = DispatchQueue(label: "zali.network.config")
    private let apiBaseURLStorageKey = "zali_network_api_base_url"
    private let wsBaseURLStorageKey = "zali_network_ws_base_url"
    private let cryptoKeyStorageKey = "zali_crypto_key_v2"
    private let sessionUsernameStorageKey = "zali_session_username_v1"
    private let sessionTokenStorageKey = "zali_session_token_v1"
    private let deviceIdStorageKey = "zali_device_id_v1"
    private let pendingOutboxBaseKey = "zali_pending_outbox_v1"
    private let messageCacheBaseKey = "zali_message_cache_v1"
    private let conversationKeysBaseKey = "zali_conversation_keys_v1"

    // Per-account UserDefaults keys. Previously these were bare constants shared by
    // every account ever logged into on this Mac — switching accounts silently kept
    // the PREVIOUS account's chat history, pending outbox, and E2E conversation keys
    // in memory and re-injected them into the new account's WebView bootstrap via
    // currentMessageCacheJSON()/currentPendingOutboxJSON() below. Confirmed live: a
    // brand-new account's own localStorage ended up with byte-for-byte the same
    // message cache as a different, previously-active account. Scoping by username
    // here (and reloading on setSession, see below) is the actual fix; unlike the
    // JS-side per-account keys this deliberately has NO legacy-unsuffixed-key
    // migration fallback, since that exact pattern was what caused the JS-side
    // instance of this same bug (see interface.js's loadStoredMessageCache et al.).
    private var pendingOutboxStorageKey: String {
        currentUsername.isEmpty ? pendingOutboxBaseKey : "\(pendingOutboxBaseKey)_\(currentUsername)"
    }
    private var messageCacheStorageKey: String {
        currentUsername.isEmpty ? messageCacheBaseKey : "\(messageCacheBaseKey)_\(currentUsername)"
    }
    private var conversationKeysStorageKey: String {
        currentUsername.isEmpty ? conversationKeysBaseKey : "\(conversationKeysBaseKey)_\(currentUsername)"
    }


    private var webSocketTask: URLSessionWebSocketTask?
    // Separate session for WebSocket (needs delegate); shared session for HTTP requests
    private var wsSession: URLSession?
    private let httpSession: URLSession
    private let apiSession: URLSession
    private var configuredServerURL: String?
    private var configuredWSBaseURL: String?
    private var authToken: String?
    private var currentUsername: String = ""
    private var currentDeviceId: String = ""
    private var connectionGeneration: Int = 0
    private var reconnectAttempt: Int = 0
    private var reconnectWorkItem: DispatchWorkItem?
    private var heartbeatWorkItem: DispatchWorkItem?
    private var receiveLoopTask: Task<Void, Never>?
    private var pendingOutboxJSON: String = "[]"
    private var messageCacheJSON: String = #"{"chats":{},"serverChats":{}}"#

    // Voice signaling runs on its own dedicated WebSocket, independent of the
    // message socket's connection health — mirrors Windows' VoiceBridge/run_voice_transport.
    private var voiceWebSocketTask: URLSessionWebSocketTask?
    private var voiceSession: URLSession?
    private var voiceConnectionGeneration: Int = 0
    private var voiceReconnectAttempt: Int = 0
    private var voiceReconnectWorkItem: DispatchWorkItem?
    private var voiceHeartbeatWorkItem: DispatchWorkItem?
    private var voiceReceiveLoopTask: Task<Void, Never>?
    private var voicePendingQueue: [(payload: [String: Any], completion: ((Bool) -> Void)?)] = []

    private func apiURL(_ path: String) -> String {
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalized = trimmed.hasPrefix("/") ? String(trimmed.dropFirst()) : trimmed
        return "\(serverURL)/api/\(normalized)"
    }
    
    private func trace(_ message: String) {
        print("[ZALI][NET] \(message)")
    }
    
    // Callback to notify UI when a message is successfully received and unpacked
    var onMessageReceived: ((_ id: String, _ clientId: String?, _ sender: String, _ receiver: String, _ text: String, _ attachments: [[String: Any]], _ serverId: String?, _ channelId: String?) -> Void)?
    var onMessageDecryptFailed: ((_ id: String, _ sender: String, _ receiver: String, _ serverId: String?, _ channelId: String?) -> Void)?
    var onReactionUpdated: ((_ payload: [String: Any]) -> Void)?
    var onAvatarChanged: ((_ username: String, _ deleted: Bool) -> Void)?
    var onVoiceEvent: ((_ payload: [String: Any]) -> Void)?
    var onKeyEnvelopeAvailable: (() -> Void)?
    var onWebSocketConnected: (() -> Void)?
    var onWebSocketDisconnected: (() -> Void)?
    var currentKey: String = ""
    var allConversationKeys: [String: String] = [:]

    override init() {
        let httpConfig = URLSessionConfiguration.default
        httpConfig.timeoutIntervalForRequest = 60
        httpConfig.timeoutIntervalForResource = 300
        httpSession = URLSession(configuration: httpConfig)

        let apiConfig = URLSessionConfiguration.default
        apiConfig.timeoutIntervalForRequest = 12
        apiConfig.timeoutIntervalForResource = 15
        apiConfig.waitsForConnectivity = false
        // postAuthSetup fires 8-10+ concurrent apiFetch calls (contacts, users, servers,
        // device trust, vault, key envelopes, republish, history reload) all sharing this
        // one session. The system default (6 connections/host on Apple platforms) meant
        // the overflow just queued for a free slot and blew its 12s timeout before ever
        // sending — a burst of simultaneous "request timed out" across every endpoint at
        // once, not any single slow request.
        apiConfig.httpMaximumConnectionsPerHost = 16
        apiSession = URLSession(configuration: apiConfig)

        super.init()
        let storedKey = WebView.Coordinator.loadLegacyCryptoKey().trimmingCharacters(in: .whitespacesAndNewlines)
        if !storedKey.isEmpty {
            currentKey = storedKey
        } else {
            // One-time migration: an earlier version of this app stored the crypto key in
            // UserDefaults, then a later version moved it into Keychain (since replaced by
            // a plain file — see loadLegacyCryptoKey). Move any UserDefaults leftover into
            // the current storage and stop reading/writing UserDefaults for it.
            let legacyKey = (UserDefaults.standard.string(forKey: cryptoKeyStorageKey) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if !legacyKey.isEmpty {
                WebView.Coordinator.saveLegacyCryptoKey(legacyKey)
            }
            currentKey = legacyKey
        }
        UserDefaults.standard.removeObject(forKey: cryptoKeyStorageKey)
        currentUsername = (UserDefaults.standard.string(forKey: sessionUsernameStorageKey) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if let storedToken = UserDefaults.standard.string(forKey: sessionTokenStorageKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
           !storedToken.isEmpty {
            authToken = storedToken
        } else {
            authToken = nil
        }
        currentDeviceId = (UserDefaults.standard.string(forKey: deviceIdStorageKey) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        pendingOutboxJSON = (UserDefaults.standard.string(forKey: pendingOutboxStorageKey) ?? "[]").trimmingCharacters(in: .whitespacesAndNewlines)
        if pendingOutboxJSON.isEmpty {
            pendingOutboxJSON = "[]"
        }
        messageCacheJSON = (UserDefaults.standard.string(forKey: messageCacheStorageKey) ?? #"{"chats":{},"serverChats":{}}"#).trimmingCharacters(in: .whitespacesAndNewlines)
        if messageCacheJSON.isEmpty {
            messageCacheJSON = #"{"chats":{},"serverChats":{}}"#
        }
        if let storedKeysJSON = UserDefaults.standard.string(forKey: conversationKeysStorageKey),
           let data = storedKeysJSON.data(using: .utf8),
           let decoded = try? JSONDecoder().decode([String: String].self, from: data) {
            allConversationKeys = decoded
        }
        trace("init user=\(currentUsername) hasToken=\(authToken != nil) keySet=\(!currentKey.isEmpty) pendingBytes=\(pendingOutboxJSON.count)")
    }

    func persistCurrentKey() {
        let key = currentKey
        connectionQueue.async {
            WebView.Coordinator.saveLegacyCryptoKey(key)
        }
    }

    func persistConversationKeys() {
        connectionQueue.async { [weak self] in
            guard let self else { return }
            guard let data = try? JSONEncoder().encode(self.allConversationKeys),
                  let json = String(data: data, encoding: .utf8) else { return }
            UserDefaults.standard.set(json, forKey: self.conversationKeysStorageKey)
        }
    }

    var currentUser: String {
        currentUsername
    }

    private var serverURL: String {
        if let configured = configQueue.sync(execute: { configuredServerURL }), !configured.isEmpty {
            return configured
        }
        if let stored = normalizedBaseURL(UserDefaults.standard.string(forKey: apiBaseURLStorageKey)) {
            return stored
        }
        let env = ProcessInfo.processInfo.environment
        if let value = normalizedBaseURL(env["ZALI_API_BASE_URL"]) {
            return value
        }
        return "https://msgs.zalikus.org"
    }

    private var wsBaseURL: String {
        if let configured = configQueue.sync(execute: { configuredWSBaseURL }), !configured.isEmpty {
            return configured
        }
        if let apiBaseURL = configQueue.sync(execute: { configuredServerURL }), !apiBaseURL.isEmpty {
            if apiBaseURL.hasPrefix("https://") {
                return apiBaseURL.replacingOccurrences(of: "https://", with: "wss://") + "/ws"
            }
            if apiBaseURL.hasPrefix("http://") {
                return apiBaseURL.replacingOccurrences(of: "http://", with: "ws://") + "/ws"
            }
        }
        if let stored = normalizedWebSocketURL(UserDefaults.standard.string(forKey: wsBaseURLStorageKey)) {
            return stored
        }
        let env = ProcessInfo.processInfo.environment
        if let value = normalizedWebSocketURL(env["ZALI_WS_BASE_URL"]) {
            return value
        }
        if let apiBaseURL = normalizedBaseURL(env["ZALI_API_BASE_URL"]) {
            if apiBaseURL.hasPrefix("https://") {
                return apiBaseURL.replacingOccurrences(of: "https://", with: "wss://") + "/ws"
            }
            if apiBaseURL.hasPrefix("http://") {
                return apiBaseURL.replacingOccurrences(of: "http://", with: "ws://") + "/ws"
            }
        }
        return "wss://msgs.zalikus.org/ws"
    }

    private func normalizedBaseURL(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !trimmed.isEmpty else { return nil }
        return trimmed.replacingOccurrences(of: #"/+$"#, with: "", options: .regularExpression)
    }

    private func normalizedWebSocketURL(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !trimmed.isEmpty else { return nil }
        return trimmed.replacingOccurrences(of: #"/+$"#, with: "", options: .regularExpression)
    }

    func currentPendingOutboxJSON() -> String {
        connectionQueue.sync {
            pendingOutboxJSON
        }
    }

    func savePendingOutboxJSON(_ value: String) {
        connectionQueue.async { [weak self] in
            guard let self else { return }
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            self.pendingOutboxJSON = trimmed.isEmpty ? "[]" : trimmed
            UserDefaults.standard.set(self.pendingOutboxJSON, forKey: self.pendingOutboxStorageKey)
            self.trace("pendingOutbox saved bytes=\(self.pendingOutboxJSON.count)")
        }
    }

    func currentMessageCacheJSON() -> String {
        connectionQueue.sync {
            messageCacheJSON
        }
    }

    func saveMessageCacheJSON(_ value: String) {
        connectionQueue.async { [weak self] in
            guard let self else { return }
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            self.messageCacheJSON = trimmed.isEmpty ? #"{"chats":{},"serverChats":{}}"# : trimmed
            UserDefaults.standard.set(self.messageCacheJSON, forKey: self.messageCacheStorageKey)
            self.trace("messageCache saved bytes=\(self.messageCacheJSON.count)")
        }
    }
    
    func start() {
        trace("start api=\(serverURL) ws=\(wsBaseURL) user=\(currentUsername)")
        connectWebSocket()
        connectVoiceWebSocket()
    }

    func configure(apiBaseURL: String?, wsBaseURL: String?) {
        let normalizedAPI = normalizedBaseURL(apiBaseURL)
        let normalizedWS = normalizedWebSocketURL(wsBaseURL)
        trace("configure api=\(normalizedAPI ?? "nil") ws=\(normalizedWS ?? "nil")")
        let changed = configQueue.sync {
            configuredServerURL != normalizedAPI || configuredWSBaseURL != normalizedWS
        }
        configQueue.sync {
            configuredServerURL = normalizedAPI
            configuredWSBaseURL = normalizedWS
        }
        if let normalizedAPI {
            UserDefaults.standard.set(normalizedAPI, forKey: apiBaseURLStorageKey)
        } else {
            UserDefaults.standard.removeObject(forKey: apiBaseURLStorageKey)
        }
        if let normalizedWS {
            UserDefaults.standard.set(normalizedWS, forKey: wsBaseURLStorageKey)
        } else {
            UserDefaults.standard.removeObject(forKey: wsBaseURLStorageKey)
        }
        if changed || webSocketTask == nil {
            connectWebSocket()
        } else {
            trace("configure unchanged; keeping existing websocket")
        }
        if changed || voiceWebSocketTask == nil {
            connectVoiceWebSocket()
        }
    }

    func setSession(username: String, token: String?, completion: (() -> Void)? = nil) {
        setSession(username: username, token: token, deviceId: nil, completion: completion)
    }

    func setSession(username: String, token: String?, deviceId: String?, completion: (() -> Void)? = nil) {
        connectionQueue.async { [weak self] in
            guard let self else { return }
            let nextUsername = username.trimmingCharacters(in: .whitespacesAndNewlines)
            let nextToken = token?.isEmpty == false ? token : nil
            let nextDeviceId = (deviceId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let usernameChanged = self.currentUsername != nextUsername
            let changed = usernameChanged
                || self.authToken != nextToken
                || self.currentDeviceId != nextDeviceId
            self.currentUsername = nextUsername
            self.authToken = nextToken
            self.currentDeviceId = nextDeviceId
            if usernameChanged {
                // Reload from the NEW account's own scoped keys (storageKey computed
                // properties above already reflect currentUsername at this point) —
                // without this, the previous account's cache/outbox/keys stay in memory
                // and get re-injected into the new account's WebView bootstrap.
                self.pendingOutboxJSON = (UserDefaults.standard.string(forKey: self.pendingOutboxStorageKey) ?? "[]")
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                if self.pendingOutboxJSON.isEmpty { self.pendingOutboxJSON = "[]" }
                self.messageCacheJSON = (UserDefaults.standard.string(forKey: self.messageCacheStorageKey) ?? #"{"chats":{},"serverChats":{}}"#)
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                if self.messageCacheJSON.isEmpty { self.messageCacheJSON = #"{"chats":{},"serverChats":{}}"# }
                if let storedKeysJSON = UserDefaults.standard.string(forKey: self.conversationKeysStorageKey),
                   let data = storedKeysJSON.data(using: .utf8),
                   let decoded = try? JSONDecoder().decode([String: String].self, from: data) {
                    self.allConversationKeys = decoded
                } else {
                    self.allConversationKeys = [:]
                }
                self.trace("setSession reloaded per-account caches user=\(nextUsername) pendingBytes=\(self.pendingOutboxJSON.count) cacheBytes=\(self.messageCacheJSON.count) keys=\(self.allConversationKeys.count)")
            }
            UserDefaults.standard.set(self.currentUsername, forKey: self.sessionUsernameStorageKey)
            if let token, !token.isEmpty {
                UserDefaults.standard.set(token, forKey: self.sessionTokenStorageKey)
            } else {
                UserDefaults.standard.removeObject(forKey: self.sessionTokenStorageKey)
            }
            if self.currentDeviceId.isEmpty {
                UserDefaults.standard.removeObject(forKey: self.deviceIdStorageKey)
            } else {
                UserDefaults.standard.set(self.currentDeviceId, forKey: self.deviceIdStorageKey)
            }
            self.trace("setSession user=\(self.currentUsername) hasToken=\(self.authToken != nil) changed=\(changed)")
            if changed || self.webSocketTask == nil {
                self.connectWebSocketLocked()
            } else {
                self.trace("setSession unchanged; keeping existing websocket")
            }
            if changed || self.voiceWebSocketTask == nil {
                self.connectVoiceWebSocketLocked()
            }
            if let completion {
                DispatchQueue.main.async {
                    completion()
                }
            }
        }
    }
    
    private func connectWebSocket() {
        connectionQueue.async { [weak self] in
            self?.connectWebSocketLocked()
        }
    }

    private func connectWebSocketLocked() {
        reconnectWorkItem?.cancel()
        reconnectWorkItem = nil
        heartbeatWorkItem?.cancel()
        heartbeatWorkItem = nil
        receiveLoopTask?.cancel()
        receiveLoopTask = nil
        connectionGeneration += 1
        let generation = connectionGeneration

        guard let url = URL(string: wsBaseURL) else { return }
        trace("ws connect generation=\(generation) url=\(wsBaseURL) token=\(authToken != nil)")
        // Cancel the previous task, but keep the old session object alive until the system releases it.
        webSocketTask?.cancel(with: .goingAway, reason: nil)
        let config = URLSessionConfiguration.default
        let newSession = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        wsSession = newSession
        let request = makeWebSocketRequest(url: url)
        webSocketTask = newSession.webSocketTask(with: request)
        webSocketTask?.resume()
        trace("ws resume generation=\(generation) authHeader=\(authToken != nil)")
        
        listenWebSocket(generation: generation)
    }

    private func makeWebSocketRequest(url: URL) -> URLRequest {
        var request = URLRequest(url: url)
        if let authToken, !authToken.isEmpty {
            request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        }
        if !currentDeviceId.isEmpty {
            request.setValue(currentDeviceId, forHTTPHeaderField: "X-Zali-Device-ID")
        }
        return request
    }

    private func addHistoryHeaders(to request: inout URLRequest) {
        if let authToken, !authToken.isEmpty {
            request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        }
        if !currentDeviceId.isEmpty {
            request.setValue(currentDeviceId, forHTTPHeaderField: "X-Zali-Device-ID")
        }
    }

    private func scheduleReconnect(reason: String, generation: Int) {
        connectionQueue.async { [weak self] in
            guard let self else { return }
            guard generation == self.connectionGeneration else { return }

            // Report the drop on EVERY reconnect path — not just clean didCloseWith.
            // Ping-failure and receive-failure land here too; without this the badge
            // stays green on silent drops (wifi switch / sleep / NAT idle) and, worse,
            // the JS reconnect catch-up sweep is gated on a false→true transition
            // (interface.js), so background messages to non-open chats never get pulled.
            DispatchQueue.main.async {
                self.onWebSocketDisconnected?()
            }

            self.heartbeatWorkItem?.cancel()
            self.heartbeatWorkItem = nil
            self.reconnectWorkItem?.cancel()
            self.reconnectAttempt = min(self.reconnectAttempt + 1, 6)
            let baseDelay = min(pow(2.0, Double(self.reconnectAttempt - 1)) * 1.5, 30.0)
            let jitter = Double.random(in: 0.0...0.75)
            let delay = baseDelay + jitter
            let workItem = DispatchWorkItem { [weak self] in
                guard let self else { return }
                guard generation == self.connectionGeneration else { return }
                self.connectWebSocketLocked()
            }
            self.reconnectWorkItem = workItem
            self.trace("ws reconnect scheduled reason=\(reason) delay=\(String(format: "%.2f", delay))s gen=\(generation)")
            self.connectionQueue.asyncAfter(deadline: .now() + delay, execute: workItem)
        }
    }

    private func scheduleHeartbeat(generation: Int) {
        connectionQueue.async { [weak self] in
            guard let self else { return }
            guard generation == self.connectionGeneration else { return }

            self.heartbeatWorkItem?.cancel()
            let workItem = DispatchWorkItem { [weak self] in
                guard let self else { return }
                guard generation == self.connectionGeneration else { return }
                guard let task = self.webSocketTask else { return }

                task.sendPing { [weak self] error in
                    guard let self else { return }
                    self.connectionQueue.async {
                        guard generation == self.connectionGeneration else { return }
                        if let error {
                            self.trace("ws ping failed err=\(error)")
                            self.scheduleReconnect(reason: "ping failure", generation: generation)
                            return
                        }
                        self.trace("ws ping ok gen=\(generation)")
                        self.scheduleHeartbeat(generation: generation)
                    }
                }
            }

            self.heartbeatWorkItem = workItem
            self.connectionQueue.asyncAfter(deadline: .now() + 25, execute: workItem)
        }
    }

    private func listenWebSocket(generation: Int) {
        guard let task = webSocketTask else { return }
        receiveLoopTask?.cancel()
        receiveLoopTask = Task { [weak self] in
            guard let self else { return }

            while !Task.isCancelled {
                guard self.connectionQueue.sync(execute: { self.connectionGeneration == generation }) else {
                    return
                }

                do {
                    let message = try await task.receive()
                    guard self.connectionQueue.sync(execute: { self.connectionGeneration == generation }) else {
                        return
                    }

                    switch message {
                    case .string(let text):
                        self.trace("ws recv string bytes=\(text.count)")
                        if let data = text.data(using: .utf8),
                           let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                           let eventType = raw["type"] as? String,
                           eventType.hasPrefix("voice_") {
                            self.trace("ws recv voice type=\(eventType) roomId=\(raw["roomId"] as? String ?? "") from=\(raw["from"] as? String ?? "") target=\(raw["target"] as? String ?? "")")
                        }
                        self.handleWebSocketMessage(text)
                    case .data(let data):
                        self.trace("ws recv binary bytes=\(data.count)")
                        if let text = String(data: data, encoding: .utf8) {
                            if let rawData = text.data(using: .utf8),
                               let raw = try? JSONSerialization.jsonObject(with: rawData) as? [String: Any],
                               let eventType = raw["type"] as? String,
                               eventType.hasPrefix("voice_") {
                                self.trace("ws recv voice type=\(eventType) roomId=\(raw["roomId"] as? String ?? "") from=\(raw["from"] as? String ?? "") target=\(raw["target"] as? String ?? "")")
                            }
                            self.handleWebSocketMessage(text)
                        }
                    @unknown default:
                        break
                    }
                } catch {
                    guard self.connectionQueue.sync(execute: { self.connectionGeneration == generation }) else {
                        return
                    }
                    self.trace("ws connection error=\(error)")
                    self.connectionQueue.async {
                        guard self.connectionGeneration == generation else { return }
                        if self.webSocketTask === task {
                            self.webSocketTask = nil
                        }
                    }
                    self.scheduleReconnect(reason: "receive failure", generation: generation)
                    return
                }
            }
        }
    }

    // MARK: - Voice transport (dedicated WebSocket, independent of the message socket)

    private func connectVoiceWebSocket() {
        connectionQueue.async { [weak self] in
            self?.connectVoiceWebSocketLocked()
        }
    }

    private func connectVoiceWebSocketLocked() {
        voiceReconnectWorkItem?.cancel()
        voiceReconnectWorkItem = nil
        voiceHeartbeatWorkItem?.cancel()
        voiceHeartbeatWorkItem = nil
        voiceReceiveLoopTask?.cancel()
        voiceReceiveLoopTask = nil
        voiceConnectionGeneration += 1
        let generation = voiceConnectionGeneration

        guard let url = URL(string: wsBaseURL) else { return }
        trace("voice ws connect generation=\(generation) url=\(wsBaseURL) token=\(authToken != nil)")
        voiceWebSocketTask?.cancel(with: .goingAway, reason: nil)
        let config = URLSessionConfiguration.default
        let newSession = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        voiceSession = newSession
        var request = URLRequest(url: url)
        if let authToken, !authToken.isEmpty {
            request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        }
        voiceWebSocketTask = newSession.webSocketTask(with: request)
        voiceWebSocketTask?.resume()
        trace("voice ws resume generation=\(generation)")

        listenVoiceWebSocket(generation: generation)
    }

    func sendVoiceEvent(_ payload: [String: Any], completion: ((Bool) -> Void)? = nil) {
        connectionQueue.async { [weak self] in
            guard let self else {
                completion?(false)
                return
            }

            guard let task = self.voiceWebSocketTask else {
                self.voicePendingQueue.append((payload, completion))
                self.trace("voice ws queued while disconnected queueLen=\(self.voicePendingQueue.count)")
                self.connectVoiceWebSocketLocked()
                // Do not report success yet — completion fires later, once flushVoicePendingQueue
                // actually sends (or permanently fails to send) this payload.
                return
            }

            guard let data = try? JSONSerialization.data(withJSONObject: payload, options: []),
                  let text = String(data: data, encoding: .utf8) else {
                completion?(false)
                return
            }

            task.send(.string(text)) { error in
                if let error {
                    self.trace("voice ws send error=\(error)")
                    self.connectionQueue.async {
                        self.voicePendingQueue.insert((payload, completion), at: 0)
                        if self.voiceWebSocketTask === task {
                            self.voiceWebSocketTask = nil
                            self.scheduleVoiceReconnect(reason: "send failure", generation: self.voiceConnectionGeneration)
                        }
                    }
                } else {
                    completion?(true)
                }
            }
        }
    }

    private func flushVoicePendingQueue(generation: Int) {
        connectionQueue.async { [weak self] in
            self?.flushNextVoicePendingItem(generation: generation)
        }
    }

    /// Sends queued voice payloads one at a time (rather than firing all sends at once and
    /// clearing the queue upfront) so a mid-flush failure re-queues the failed item — and
    /// everything still behind it — instead of silently dropping it.
    private func flushNextVoicePendingItem(generation: Int) {
        guard generation == voiceConnectionGeneration else { return }
        guard let task = voiceWebSocketTask else { return }
        guard let item = voicePendingQueue.first else { return }

        guard let data = try? JSONSerialization.data(withJSONObject: item.payload, options: []),
              let text = String(data: data, encoding: .utf8) else {
            // Malformed payload — drop just this one and keep draining the rest.
            voicePendingQueue.removeFirst()
            item.completion?(false)
            connectionQueue.async { [weak self] in
                self?.flushNextVoicePendingItem(generation: generation)
            }
            return
        }

        task.send(.string(text)) { [weak self] error in
            guard let self else { return }
            self.connectionQueue.async {
                guard generation == self.voiceConnectionGeneration else { return }
                if let error {
                    self.trace("voice ws flush send failed err=\(error)")
                    if self.voiceWebSocketTask === task {
                        self.voiceWebSocketTask = nil
                        self.scheduleVoiceReconnect(reason: "flush failure", generation: generation)
                    }
                    return
                }
                if !self.voicePendingQueue.isEmpty {
                    let sent = self.voicePendingQueue.removeFirst()
                    sent.completion?(true)
                }
                self.flushNextVoicePendingItem(generation: generation)
            }
        }
    }

    private func scheduleVoiceReconnect(reason: String, generation: Int) {
        connectionQueue.async { [weak self] in
            guard let self else { return }
            guard generation == self.voiceConnectionGeneration else { return }

            self.voiceHeartbeatWorkItem?.cancel()
            self.voiceHeartbeatWorkItem = nil
            self.voiceReconnectWorkItem?.cancel()
            self.voiceReconnectAttempt += 1
            let delay = min(pow(2.0, Double(self.voiceReconnectAttempt - 1)), 30.0)
            let workItem = DispatchWorkItem { [weak self] in
                guard let self else { return }
                guard generation == self.voiceConnectionGeneration else { return }
                self.connectVoiceWebSocketLocked()
            }
            self.voiceReconnectWorkItem = workItem
            self.trace("voice ws reconnect scheduled reason=\(reason) delay=\(String(format: "%.2f", delay))s gen=\(generation)")
            self.connectionQueue.asyncAfter(deadline: .now() + delay, execute: workItem)
        }
    }

    private func scheduleVoiceHeartbeat(generation: Int) {
        connectionQueue.async { [weak self] in
            guard let self else { return }
            guard generation == self.voiceConnectionGeneration else { return }

            self.voiceHeartbeatWorkItem?.cancel()
            let workItem = DispatchWorkItem { [weak self] in
                guard let self else { return }
                guard generation == self.voiceConnectionGeneration else { return }
                guard let task = self.voiceWebSocketTask else { return }

                task.sendPing { [weak self] error in
                    guard let self else { return }
                    self.connectionQueue.async {
                        guard generation == self.voiceConnectionGeneration else { return }
                        if let error {
                            self.trace("voice ws ping failed err=\(error)")
                            self.scheduleVoiceReconnect(reason: "ping failure", generation: generation)
                            return
                        }
                        self.trace("voice ws ping ok gen=\(generation)")
                        self.scheduleVoiceHeartbeat(generation: generation)
                    }
                }
            }
            self.voiceHeartbeatWorkItem = workItem
            self.connectionQueue.asyncAfter(deadline: .now() + 25, execute: workItem)
        }
    }

    private func listenVoiceWebSocket(generation: Int) {
        guard let task = voiceWebSocketTask else { return }
        voiceReceiveLoopTask?.cancel()
        voiceReceiveLoopTask = Task { [weak self] in
            guard let self else { return }

            while !Task.isCancelled {
                guard self.connectionQueue.sync(execute: { self.voiceConnectionGeneration == generation }) else {
                    return
                }

                do {
                    let message = try await task.receive()
                    guard self.connectionQueue.sync(execute: { self.voiceConnectionGeneration == generation }) else {
                        return
                    }

                    var text: String?
                    switch message {
                    case .string(let s): text = s
                    case .data(let d): text = String(data: d, encoding: .utf8)
                    @unknown default: text = nil
                    }

                    if let text,
                       let data = text.data(using: .utf8),
                       let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                       let eventType = raw["type"] as? String,
                       eventType.hasPrefix("voice_") {
                        self.trace("voice ws recv type=\(eventType) roomId=\(raw["roomId"] as? String ?? "")")
                        DispatchQueue.main.async {
                            self.onVoiceEvent?(raw)
                        }
                    }
                } catch {
                    guard self.connectionQueue.sync(execute: { self.voiceConnectionGeneration == generation }) else {
                        return
                    }
                    self.trace("voice ws connection error=\(error)")
                    self.connectionQueue.async {
                        guard self.voiceConnectionGeneration == generation else { return }
                        if self.voiceWebSocketTask === task {
                            self.voiceWebSocketTask = nil
                        }
                    }
                    self.scheduleVoiceReconnect(reason: "receive failure", generation: generation)
                    return
                }
            }
        }
    }

    private func handleWebSocketMessage(_ jsonString: String) {
        struct AvatarEvent: Codable {
            let type: String
            let username: String
            let deleted: Bool?
        }

        struct WsMessage: Codable {
            let id: String
            let clientId: String?
            let client_id: String?
            let sender: String
            let receiver: String
            let filename: String
            let keyVersion: Int?
            let key_version: Int?
            let serverId: String?
            let channelId: String?
            let server_id: String?
            let channel_id: String?
        }
        
        guard let data = jsonString.data(using: .utf8),
              let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            trace("handleWebSocketMessage invalid json bytes=\(jsonString.count)")
            return
        }

        if let eventType = raw["type"] as? String,
           eventType == "avatar_updated" || eventType == "avatar_deleted",
           let avatarEvent = try? JSONDecoder().decode(AvatarEvent.self, from: data) {
            trace("handleWebSocketMessage avatar event type=\(eventType) username=\(avatarEvent.username)")
            DispatchQueue.main.async {
                self.onAvatarChanged?(avatarEvent.username, avatarEvent.deleted ?? (eventType == "avatar_deleted"))
            }
            return
        }

        if let eventType = raw["type"] as? String, eventType == "reaction_updated" {
            trace("handleWebSocketMessage reaction_updated")
            DispatchQueue.main.async {
                self.onReactionUpdated?(raw)
            }
            return
        }

        // Voice events are handled exclusively by the dedicated voice WebSocket
        // (see listenVoiceWebSocket) — ignoring them here avoids double-dispatch,
        // since the server delivers voice_* events to every active connection
        // for this user, including the message socket.
        if let eventType = raw["type"] as? String, eventType.hasPrefix("voice_") {
            return
        }

        if let eventType = raw["type"] as? String, eventType == "key_envelope_available" {
            trace("handleWebSocketMessage key_envelope_available")
            DispatchQueue.main.async {
                self.onKeyEnvelopeAvailable?()
            }
            return
        }

        guard let wsMsg = try? JSONDecoder().decode(WsMessage.self, from: data) else {
            trace("handleWebSocketMessage non-message keys=\(raw.keys.sorted())")
            return
        }
        
        let serverId = wsMsg.serverId ?? wsMsg.server_id
        let channelId = wsMsg.channelId ?? wsMsg.channel_id
        trace("handleWebSocketMessage message id=\(wsMsg.id) sender=\(wsMsg.sender) receiver=\(wsMsg.receiver) server=\(serverId ?? "nil") channel=\(channelId ?? "nil") currentUser=\(currentUsername) clientId=\(wsMsg.clientId ?? wsMsg.client_id ?? "")")

        // Server messages are broadcast to all connected clients.
        // For DMs, accept messages that involve the current account on either side,
        // so a second session of the same user also receives its own outgoing echoes.
        if serverId != nil || wsMsg.receiver == currentUsername || wsMsg.sender == currentUsername {
            downloadMessageWithRetry(messageId: wsMsg.id) { [weak self] fileURL, statusCode in
                guard let fileURL = fileURL else {
                    if statusCode == 403 {
                        self?.trace("download forbidden messageId=\(wsMsg.id)")
                    } else if statusCode == 413 {
                        self?.trace("download too_large messageId=\(wsMsg.id)")
                    }
                    return
                }
                self?.trace("download complete messageId=\(wsMsg.id) path=\(fileURL.path)")

                autoreleasepool {
                    // Temp directory for unpacking
                    let tempDirName = UUID().uuidString
                    let tempDir = (NSTemporaryDirectory() as NSString).appendingPathComponent(tempDirName)
                    try? FileManager.default.createDirectory(atPath: tempDir, withIntermediateDirectories: true)

                    defer {
                        try? FileManager.default.removeItem(at: fileURL)
                        try? FileManager.default.removeItem(atPath: tempDir)
                    }

                    var candidateKeys = ZaliCore.candidateMessageKeys(
                        currentKey: self?.currentKey ?? "",
                        conversationKeys: self?.allConversationKeys ?? [:],
                        participantA: wsMsg.sender,
                        participantB: wsMsg.receiver,
                        serverId: serverId,
                        channelId: channelId
                    )
                    // Last-resort fallback: try every other known conversation key too,
                    // matching WebView.renderHistoryRecord's fallback for history replay —
                    // without this, the same message can decrypt via history reload but
                    // fail on live delivery if allConversationKeys hasn't caught up yet.
                    (self?.allConversationKeys ?? [:]).values.forEach { k in
                        let normalized = k.trimmingCharacters(in: .whitespacesAndNewlines)
                        if !normalized.isEmpty, !candidateKeys.contains(normalized) { candidateKeys.append(normalized) }
                    }
	                    if let unpacked = ZaliCore.shared.unpackMessage(archivePath: fileURL.path, tempDir: tempDir, keys: candidateKeys) {
	                        self?.trace("unpack success messageId=\(wsMsg.id) sender=\(unpacked.sender) textBytes=\(unpacked.text.count) attachments=\((unpacked.attachments ?? []).count)")
	                        let renderedAttachments = (unpacked.attachments ?? []).compactMap { attachment -> [String: Any]? in
	                            let attachmentURL = URL(fileURLWithPath: tempDir).appendingPathComponent(attachment.archivePath)
	                            var rendered: [String: Any] = [
	                                "name": attachment.name,
	                                "mimeType": attachment.mimeType,
	                                "kind": attachment.kind,
	                                "size": attachment.size
	                            ]
	                            if attachment.size <= 2 * 1024 * 1024,
	                               let data = try? Data(contentsOf: attachmentURL) {
	                                rendered["dataUrl"] = Self.makeDataURL(data: data, mimeType: attachment.mimeType)
	                            }
	                            return rendered
	                        }

                        DispatchQueue.main.async {
                            // Notification decision (self-sender filter, "is this chat already
                            // open" guard, mute state) lives in JS's receiveMessage() ->
                            // SHOW_NOTIFICATION bridge message, matching Windows (see
                            // transport.rs handle_message_ws_payload) — native has no visibility
                            // into which chat is open in the WebView, so it can't apply that
                            // guard itself. Calling showMessageNotification directly here (as
                            // this used to) fired unconditionally for every incoming message
                            // regardless of visibility, duplicating/short-circuiting the JS gate.
                            self?.onMessageReceived?(wsMsg.id, wsMsg.clientId ?? wsMsg.client_id, unpacked.sender, wsMsg.receiver, unpacked.text, renderedAttachments, serverId, channelId)
                        }
                    } else {
                        let keyPreview = candidateKeys
                            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                            .filter { !$0.isEmpty }
                            .map { String($0.prefix(12)) }
                            .joined(separator: ",")
                        self?.trace("unpack failed messageId=\(wsMsg.id) keysTried=\(keyPreview.isEmpty ? "none" : keyPreview) tempDir=\(tempDir)")
                        DispatchQueue.main.async {
                            self?.onMessageDecryptFailed?(wsMsg.id, wsMsg.sender, wsMsg.receiver, serverId, channelId)
                        }
                    }
                }
            }
        }
    }
    
    func uploadMessage(
        sender: String,
        receiver: String,
        clientId: String,
        fileURL: URL,
        serverId: String? = nil,
        channelId: String? = nil,
        keyVersion: Int = 2,
        completion: @escaping (Bool, String?, Int?, String?) -> Void
    ) {
        trace("upload start sender=\(sender) receiver=\(receiver) clientId=\(clientId) server=\(serverId ?? "nil") channel=\(channelId ?? "nil") file=\(fileURL.lastPathComponent)")
        guard let uploadURL = URL(string: apiURL("upload")) else {
            completion(false, nil, nil, "invalid upload URL")
            return
        }
        
        var request = URLRequest(url: uploadURL)
        request.httpMethod = "POST"
        if let authToken, !authToken.isEmpty {
            request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        }
        if !currentDeviceId.isEmpty {
            request.setValue(currentDeviceId, forHTTPHeaderField: "X-Zali-Device-ID")
        }
        
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
            try write("Content-Disposition: form-data; name=\"sender\"\r\n\r\n")
            try write(sender)
            try write("\r\n")

            try write("--\(boundary)\r\n")
            try write("Content-Disposition: form-data; name=\"client_id\"\r\n\r\n")
            try write(clientId)
            try write("\r\n")

            try write("--\(boundary)\r\n")
            try write("Content-Disposition: form-data; name=\"key_version\"\r\n\r\n")
            try write(String(max(1, keyVersion)))
            try write("\r\n")

            try write("--\(boundary)\r\n")
            try write("Content-Disposition: form-data; name=\"receiver\"\r\n\r\n")
            try write(receiver)
            try write("\r\n")

            if let serverId, !serverId.isEmpty, let channelId, !channelId.isEmpty {
                try write("--\(boundary)\r\n")
                try write("Content-Disposition: form-data; name=\"server_id\"\r\n\r\n")
                try write(serverId)
                try write("\r\n")

                try write("--\(boundary)\r\n")
                try write("Content-Disposition: form-data; name=\"channel_id\"\r\n\r\n")
                try write(channelId)
                try write("\r\n")
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

        httpSession.uploadTask(with: request, fromFile: bodyURL) { data, response, error in
            if let error = error {
                self.trace("upload failed error=\(error)")
                try? FileManager.default.removeItem(at: bodyURL)
                completion(false, nil, nil, error.localizedDescription)
                return
            }
            
            if let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 201 {
                let messageId: String? = {
                    guard let data else { return nil }
                    guard let json = try? JSONSerialization.jsonObject(with: data, options: []),
                          let dict = json as? [String: Any] else {
                        return nil
                    }
                    return dict["id"] as? String
                }()
                let bodyPreview = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
                self.trace("upload success http=201 messageId=\(messageId ?? "nil") body=\(bodyPreview.prefix(300))")
                try? FileManager.default.removeItem(at: bodyURL)
                completion(true, messageId, httpResponse.statusCode, bodyPreview)
            } else {
                let status = (response as? HTTPURLResponse)?.statusCode ?? -1
                let bodyPreview = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
                self.trace("upload rejected http=\(status) body=\(bodyPreview.prefix(300))")
                try? FileManager.default.removeItem(at: bodyURL)
                completion(false, nil, status, bodyPreview)
            }
        }.resume()
    }

    func setMessageReaction(messageId: String, emoji: String, completion: @escaping (Bool, [String: Any]?) -> Void) {
        let trimmedMessageId = messageId.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedEmoji = emoji.trimmingCharacters(in: .whitespacesAndNewlines)
        trace("setMessageReaction start messageId=\(trimmedMessageId) emoji=\(trimmedEmoji)")

        guard !trimmedMessageId.isEmpty else {
            completion(false, nil)
            return
        }

        guard let baseURL = URL(string: serverURL) else {
            completion(false, nil)
            return
        }

        let requestURL = baseURL
            .appendingPathComponent("api")
            .appendingPathComponent("message")
            .appendingPathComponent(trimmedMessageId)
            .appendingPathComponent("reaction")

        var request = URLRequest(url: requestURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let authToken, !authToken.isEmpty {
            request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        }
        if !currentDeviceId.isEmpty {
            request.setValue(currentDeviceId, forHTTPHeaderField: "X-Zali-Device-ID")
        }

        guard let body = try? JSONSerialization.data(withJSONObject: ["emoji": trimmedEmoji], options: []) else {
            completion(false, nil)
            return
        }
        request.httpBody = body

        apiSession.dataTask(with: request) { data, response, error in
            if let error = error {
                self.trace("setMessageReaction failed messageId=\(trimmedMessageId) err=\(error.localizedDescription)")
                completion(false, nil)
                return
            }

            guard let httpResponse = response as? HTTPURLResponse else {
                self.trace("setMessageReaction missing response messageId=\(trimmedMessageId)")
                completion(false, nil)
                return
            }

            guard (200..<300).contains(httpResponse.statusCode) else {
                let bodyPreview = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
                self.trace("setMessageReaction rejected http=\(httpResponse.statusCode) messageId=\(trimmedMessageId) body=\(bodyPreview.prefix(200))")
                completion(false, nil)
                return
            }

            let payload = data.flatMap { try? JSONSerialization.jsonObject(with: $0, options: []) as? [String: Any] }
            self.trace("setMessageReaction success messageId=\(trimmedMessageId) hasPayload=\(payload != nil)")
            completion(true, payload)
        }.resume()
    }

    func performAuthRequest(mode: String, username: String, password: String, requestId: String, completion: @escaping (Bool, [String: Any]?, String?) -> Void) {
        let registerMode = mode.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "register"
        let endpoint = registerMode ? apiURL("auth/register") : apiURL("auth/login")
        guard let url = URL(string: endpoint) else {
            completion(false, nil, "Не удалось связаться с сервером")
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        guard let body = try? JSONSerialization.data(withJSONObject: [
            "username": username,
            "password": password,
        ], options: []) else {
            completion(false, nil, "Не удалось войти")
            return
        }
        request.httpBody = body

        func finish(_ response: HTTPURLResponse?, _ data: Data?, _ error: Error?, retryLogin: Bool = false) {
            if let error {
                self.trace("AUTH_REQUEST transport_error url=\(url.absoluteString) err=\(error)")
                completion(false, nil, "Не удалось связаться с сервером")
                return
            }
            guard let httpResponse = response else {
                completion(false, nil, "Не удалось войти")
                return
            }
            if retryLogin {
                self.trace("AUTH_REQUEST register_conflict url=\(url.absoluteString) retry=login")
            }
            guard (200..<300).contains(httpResponse.statusCode) else {
                let bodyPreview = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
                if registerMode && httpResponse.statusCode == 409 && !retryLogin {
                    guard let loginURL = URL(string: self.apiURL("auth/login")) else {
                        self.trace("AUTH_REQUEST retry_login_invalid_url url=\(self.apiURL("auth/login"))")
                        completion(false, nil, "Не удалось связаться с сервером")
                        return
                    }
                    var loginRequest = URLRequest(url: loginURL)
                    loginRequest.httpMethod = "POST"
                    loginRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
                    loginRequest.setValue("application/json", forHTTPHeaderField: "Accept")
                    loginRequest.httpBody = body
                    self.apiSession.dataTask(with: loginRequest) { data, response, error in
                        finish(response as? HTTPURLResponse, data, error, retryLogin: true)
                    }.resume()
                    return
                }
                self.trace("AUTH_REQUEST http_fail url=\(url.absoluteString) status=\(httpResponse.statusCode) body=\(bodyPreview.prefix(200))")
                completion(false, nil, bodyPreview.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "\(httpResponse.statusCode)" : bodyPreview)
                return
            }
            guard let data,
                  let json = try? JSONSerialization.jsonObject(with: data, options: []),
                  let dict = json as? [String: Any] else {
                self.trace("AUTH_REQUEST decode_error url=\(url.absoluteString) err=invalid_json")
                completion(false, nil, "Не удалось войти")
                return
            }
            let token = String(describing: dict["token"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if token.isEmpty {
                self.trace("AUTH_REQUEST empty_token url=\(url.absoluteString)")
                completion(false, nil, "Не удалось войти")
                return
            }
            self.trace("AUTH_REQUEST success url=\(url.absoluteString) username=\(String(describing: dict["username"] ?? username)) token_set=true")
            completion(true, [
                "requestId": requestId,
                "ok": true,
                "data": [
                    "username": dict["username"] as? String ?? username,
                    "token": token,
                    "cloudVaultSyncEnabled": dict["cloudVaultSyncEnabled"] as? Bool ?? true,
                ],
            ], nil)
        }

        apiSession.dataTask(with: request) { data, response, error in
            if registerMode, let response = response as? HTTPURLResponse, response.statusCode == 409 {
                finish(response, data, error, retryLogin: false)
                return
            }
            finish(response as? HTTPURLResponse, data, error)
        }.resume()
    }

    func performContactsRequest(username: String, add: Bool, completion: @escaping (Bool, [String]?, String?) -> Void) {
        let endpoint = add ? apiURL("contacts") : apiURL("contacts/\(username.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? username)")
        guard let url = URL(string: endpoint) else {
            completion(false, nil, "Не удалось выполнить операцию")
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = add ? "POST" : "DELETE"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let authToken, !authToken.isEmpty {
            request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        }
        if !currentDeviceId.isEmpty {
            request.setValue(currentDeviceId, forHTTPHeaderField: "X-Zali-Device-ID")
        }
        if add {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: ["username": username], options: [])
        }

        apiSession.dataTask(with: request) { data, response, error in
            if let error {
                self.trace("CONTACT_REQUEST transport_error add=\(add) username=\(username) err=\(error)")
                completion(false, nil, "Не удалось выполнить операцию")
                return
            }
            guard let httpResponse = response as? HTTPURLResponse else {
                completion(false, nil, "Не удалось выполнить операцию")
                return
            }
            guard (200..<300).contains(httpResponse.statusCode) else {
                let bodyPreview = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
                completion(false, nil, bodyPreview.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "\(httpResponse.statusCode)" : bodyPreview)
                return
            }
            guard let data,
                  let payload = try? JSONSerialization.jsonObject(with: data, options: []) as? [String: Any] else {
                completion(true, [], nil)
                return
            }
            let contacts = (payload["contacts"] as? [String]) ?? []
            completion(true, contacts, nil)
        }.resume()
    }

    func performAvatarRequest(mode: String, dataUrl: String?, mimeType: String?, filename: String?, completion: @escaping (Bool, String?, String?) -> Void) {
        let delete = mode.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "delete"
        guard let url = URL(string: apiURL("avatar")) else {
            completion(false, nil, "Не удалось выполнить операцию")
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = delete ? "DELETE" : "POST"
        if let authToken, !authToken.isEmpty {
            request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        }
        if !currentDeviceId.isEmpty {
            request.setValue(currentDeviceId, forHTTPHeaderField: "X-Zali-Device-ID")
        }

        if !delete {
            guard let dataUrl,
                  let data = Data(base64Encoded: dataUrl.components(separatedBy: ",").last ?? "") else {
                completion(false, nil, "Invalid avatar data URL")
                return
            }
            let boundary = "Boundary-\(UUID().uuidString)"
            request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
            let bodyURL = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("avatar-\(UUID().uuidString).multipart")
            guard FileManager.default.createFile(atPath: bodyURL.path, contents: nil) else {
                completion(false, nil, "Не удалось выполнить операцию")
                return
            }

            do {
                let handle = try FileHandle(forWritingTo: bodyURL)
                defer { try? handle.close() }
                func write(_ string: String) throws {
                    if let data = string.data(using: .utf8) { try handle.write(contentsOf: data) }
                }
                try write("--\(boundary)\r\n")
                try write(#"Content-Disposition: form-data; name="file"; filename="\#(filename ?? "avatar.png")"\#r\#n"#)
                try write(#"Content-Type: \#(mimeType ?? "image/png")\#r\#n\#r\#n"#)
                try handle.write(contentsOf: data)
                try write("\r\n--\(boundary)--\r\n")
            } catch {
                try? FileManager.default.removeItem(at: bodyURL)
                completion(false, nil, "Не удалось выполнить операцию")
                return
            }

            httpSession.uploadTask(with: request, fromFile: bodyURL) { data, response, error in
                try? FileManager.default.removeItem(at: bodyURL)
                if let error {
                    self.trace("AVATAR_REQUEST transport_error mode=\(mode) err=\(error)")
                    completion(false, nil, "Не удалось выполнить операцию")
                    return
                }
                guard let httpResponse = response as? HTTPURLResponse, (200..<300).contains(httpResponse.statusCode) else {
                    let bodyPreview = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
                    completion(false, nil, bodyPreview.isEmpty ? "Не удалось выполнить операцию" : bodyPreview)
                    return
                }
                completion(true, self.currentUsername, nil)
            }.resume()
            return
        }

        apiSession.dataTask(with: request) { data, response, error in
            if let error {
                self.trace("AVATAR_REQUEST transport_error mode=\(mode) err=\(error)")
                completion(false, nil, "Не удалось выполнить операцию")
                return
            }
            guard let httpResponse = response as? HTTPURLResponse, (200..<300).contains(httpResponse.statusCode) else {
                let bodyPreview = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
                completion(false, nil, bodyPreview.isEmpty ? "Не удалось выполнить операцию" : bodyPreview)
                return
            }
            completion(true, self.currentUsername, nil)
        }.resume()
    }

    /// A URLSessionDataDelegate that aborts a download as soon as either the server's
    /// declared Content-Length or the actually-received byte count exceeds `maxBytes`,
    /// instead of buffering the full body first — mirrors Windows' content_length()
    /// pre-check plus streamed-byte-counter pattern for the same endpoints.
    private final class SizeCappedDataTaskDelegate: NSObject, URLSessionDataDelegate {
        static let tooLargeErrorDomain = "SizeCappedDataTaskDelegate.tooLarge"

        private let maxBytes: Int
        private let completion: (Data?, URLResponse?, Error?) -> Void
        private var buffer = Data()
        private var response: URLResponse?
        private var finished = false
        /// Keeps the dedicated one-off URLSession (which retains this delegate) alive
        /// for the duration of the request.
        var retainedSession: URLSession?

        init(maxBytes: Int, completion: @escaping (Data?, URLResponse?, Error?) -> Void) {
            self.maxBytes = maxBytes
            self.completion = completion
        }

        func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
            self.response = response
            if response.expectedContentLength > 0, response.expectedContentLength > Int64(maxBytes) {
                completionHandler(.cancel)
                finishTooLarge()
                return
            }
            completionHandler(.allow)
        }

        func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
            buffer.append(data)
            if buffer.count > maxBytes {
                dataTask.cancel()
                finishTooLarge()
            }
        }

        func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
            finish(data: error == nil ? buffer : nil, response: response, error: error)
        }

        private func finishTooLarge() {
            let error = NSError(domain: Self.tooLargeErrorDomain, code: 413, userInfo: [NSLocalizedDescriptionKey: "Payload exceeds size cap"])
            finish(data: nil, response: response, error: error)
        }

        private func finish(data: Data?, response: URLResponse?, error: Error?) {
            guard !finished else { return }
            finished = true
            completion(data, response, error)
            retainedSession = nil
        }
    }

    func performAvatarFetch(username: String, completion: @escaping (Bool, [String: Any]?, String?) -> Void) {
        guard let url = URL(string: apiURL("avatar/\(username.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? username)")) else {
            completion(false, nil, "Не удалось загрузить аватар")
            return
        }

        var request = URLRequest(url: url)
        if let authToken, !authToken.isEmpty {
            request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        }

        // Same stale-HTTP/2-connection resilience as performApiRequest (see attemptApiRequest):
        // the shared apiSession's connection pool can hand back a half-open socket that just
        // stalls for the full 12s timeout — routinely hit during the post-login request burst.
        // First attempt uses the shared session with a SHORT timeout; on any transport error we
        // retry once on a fresh ephemeral connection. Kept separate from attemptApiRequest
        // because that path stringifies the body, which would corrupt the binary image bytes.
        attemptAvatarFetch(request, username: username, attempt: 1)  { success, payload, error in
            completion(success, payload, error)
        }
    }

    private func attemptAvatarFetch(_ request: URLRequest, username: String, attempt: Int, completion: @escaping (Bool, [String: Any]?, String?) -> Void) {
        let maxAvatarBytes = 2 * 1024 * 1024
        let maxAttempts = 2
        var attemptRequest = request
        attemptRequest.timeoutInterval = attempt == 1 ? 3.0 : 8.0

        let session: URLSession
        if attempt == 1 {
            session = apiSession
        } else {
            let config = URLSessionConfiguration.ephemeral
            config.timeoutIntervalForRequest = 8.0
            config.waitsForConnectivity = false
            session = URLSession(configuration: config)
        }

        session.dataTask(with: attemptRequest) { data, response, error in
            if let error {
                if attempt < maxAttempts {
                    self.trace("LOAD_AVATAR_REQUEST attempt=\(attempt) failed err=\(error.localizedDescription); retrying on fresh connection")
                    self.attemptAvatarFetch(request, username: username, attempt: attempt + 1, completion: completion)
                    return
                }
                self.trace("LOAD_AVATAR_REQUEST transport_error username=\(username) err=\(error)")
                completion(false, nil, "Не удалось загрузить аватар")
                return
            }
            guard let httpResponse = response as? HTTPURLResponse, (200..<300).contains(httpResponse.statusCode), let data else {
                let bodyPreview = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
                completion(false, nil, bodyPreview.isEmpty ? "Не удалось загрузить аватар" : bodyPreview)
                return
            }
            guard data.count <= maxAvatarBytes else {
                self.trace("LOAD_AVATAR_REQUEST too_large username=\(username) bytes=\(data.count)")
                completion(false, nil, "Аватар слишком большой")
                return
            }
            let mimeType = httpResponse.value(forHTTPHeaderField: "Content-Type")?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "image/png"
            let dataUrl = Self.makeDataURL(data: data, mimeType: mimeType)
            completion(true, [
                "username": username,
                "mimeType": mimeType,
                "dataUrl": dataUrl,
            ], nil)
        }.resume()
    }

    func fetchUsers(completion: @escaping ([String]) -> Void) {
        trace("fetchUsers start user=\(currentUsername)")
        guard let usersURL = URL(string: apiURL("users")) else {
            completion(["Alice", "Bob", currentUsername])
            return
        }

        var request = URLRequest(url: usersURL)
        if let authToken, !authToken.isEmpty {
            request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        }

        apiSession.dataTask(with: request) { data, response, error in
            guard error == nil,
                  let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode),
                  let data = data,
                  let users = try? JSONDecoder().decode([String].self, from: data) else {
                self.trace("fetchUsers fallback user=\(self.currentUsername) status=\((response as? HTTPURLResponse)?.statusCode ?? -1) err=\(error?.localizedDescription ?? "nil")")
                completion(["Alice", "Bob", self.currentUsername])
                return
            }

            self.trace("fetchUsers success count=\(users.count) users=\(users.joined(separator: ","))")
            completion(users)
        }.resume()
    }

    func fetchContacts(completion: @escaping ([String]?) -> Void) {
        trace("fetchContacts start user=\(currentUsername)")
        guard let contactsURL = URL(string: apiURL("contacts")) else {
            completion(nil)
            return
        }

        var request = URLRequest(url: contactsURL)
        if let authToken, !authToken.isEmpty {
            request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        }

        apiSession.dataTask(with: request) { data, response, error in
            guard error == nil,
                  let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode),
                  let data = data,
                  let payload = try? JSONDecoder().decode([String: [String]].self, from: data) else {
                self.trace("fetchContacts fallback status=\((response as? HTTPURLResponse)?.statusCode ?? -1) err=\(error?.localizedDescription ?? "nil")")
                completion(nil)
                return
            }

            let contacts = payload["contacts"] ?? []
            self.trace("fetchContacts success count=\(contacts.count) contacts=\(contacts.joined(separator: ","))")
            completion(contacts)
        }.resume()
    }

    func performApiRequest(method: String, path: String, headers: [String: String], body: String?, timeoutMs: Double, completion: @escaping (Int, String?, [String: String]?, String?) -> Void) {
        let forbiddenPathTokens = ["..", "%2F", "%2f", "%5C", "%5c"]
        guard path.hasPrefix("/api/"), !forbiddenPathTokens.contains(where: path.contains) else {
            completion(0, nil, nil, "Некорректный путь запроса")
            return
        }
        guard let url = URL(string: "\(serverURL)\(path)") else {
            completion(0, nil, nil, "Некорректный путь запроса")
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        if let authToken, !authToken.isEmpty {
            request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        }
        for (key, value) in headers {
            request.setValue(value, forHTTPHeaderField: key)
        }
        if let body {
            request.httpBody = body.data(using: .utf8)
        }

        // Force a brand-new connection on retry — the shared apiSession's HTTP/2
        // connection pool can hand back a half-open connection that just stalls, and
        // reusing that same session/pool on retry would hit the identical stall again.
        //
        // The first attempt gets a SHORT timeout, not half the total budget: a stale
        // pooled connection doesn't mean the server is slow, it means this particular
        // socket is dead, so waiting several seconds to find that out just delays the
        // fresh-connection retry that was going to succeed quickly anyway. Confirmed
        // live: with an even 50/50 split (e.g. 4s/4s of an 8s budget) a UI action like
        // "add contact" routinely burned the entire first-attempt timeout on a stale
        // connection before succeeding on attempt 2, making a sub-second operation
        // visibly take ~5s. The final attempt still gets the bulk of the budget so a
        // genuinely slow-but-working request isn't cut short.
        let maxAttempts = 2
        let totalBudget = timeoutMs / 1000.0
        let firstAttemptTimeout = min(2.0, totalBudget * 0.4)
        let finalAttemptTimeout = max(totalBudget - firstAttemptTimeout, 3.0)
        attemptApiRequest(request, attempt: 1, maxAttempts: maxAttempts, perAttemptTimeout: firstAttemptTimeout, finalAttemptTimeout: finalAttemptTimeout, completion: completion)
    }

    private func attemptApiRequest(_ request: URLRequest, attempt: Int, maxAttempts: Int, perAttemptTimeout: TimeInterval, finalAttemptTimeout: TimeInterval, completion: @escaping (Int, String?, [String: String]?, String?) -> Void) {
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
            guard let self else { return }
            if let error {
                if attempt < maxAttempts {
                    let nextAttempt = attempt + 1
                    let nextTimeout = nextAttempt == maxAttempts ? finalAttemptTimeout : perAttemptTimeout
                    self.trace("performApiRequest attempt=\(attempt) failed err=\(error.localizedDescription); retrying on fresh connection")
                    self.attemptApiRequest(request, attempt: nextAttempt, maxAttempts: maxAttempts, perAttemptTimeout: nextTimeout, finalAttemptTimeout: finalAttemptTimeout, completion: completion)
                    return
                }
                completion(0, nil, nil, error.localizedDescription)
                return
            }
            let httpResponse = response as? HTTPURLResponse
            let status = httpResponse?.statusCode ?? 0
            let bodyStr = data.flatMap { String(data: $0, encoding: .utf8) }
            var respHeaders: [String: String] = [:]
            httpResponse?.allHeaderFields.forEach { key, value in
                respHeaders[String(describing: key)] = String(describing: value)
            }
            completion(status, bodyStr, respHeaders, nil)
        }.resume()
    }

    struct RemoteMessageRecord: Codable {
        let id: String
        let clientId: String?
        let client_id: String?
        let sender: String
        let receiver: String
        let filename: String
        let timestamp: String
        let keyVersion: Int?
        let key_version: Int?
        let serverId: String?
        let channelId: String?
        let server_id: String?
        let channel_id: String?
        let reactions: [RemoteReactionSummary]?
        let myReaction: String?
    }

    struct RemoteReactionSummary: Codable {
        let emoji: String
        let count: Int
    }

    // completion carries `ok`: true only when the whole history was fetched cleanly.
    // false means a page failed (auth/HTTP/decode) — callers must NOT treat the
    // (possibly empty) list as authoritative, or a transient error wipes the view.
    func fetchMessages(for user: String, completion: @escaping ([RemoteMessageRecord], Bool) -> Void) {
        self.fetchMessagesPage(for: user, limit: 200, offset: 0, accumulated: []) { messages, ok in
            completion(messages, ok)
        }
    }

    func fetchServerMessages(serverId: String, channelId: String, completion: @escaping ([RemoteMessageRecord], Bool) -> Void) {
        self.fetchServerMessagesPage(serverId: serverId, channelId: channelId, limit: 200, offset: 0, accumulated: []) { messages, ok in
            completion(messages, ok)
        }
    }

    private func fetchMessagesPage(
        for user: String,
        limit: Int,
        offset: Int,
        accumulated: [RemoteMessageRecord],
        completion: @escaping ([RemoteMessageRecord], Bool) -> Void
    ) {
        trace("fetchMessages page start user=\(user) limit=\(limit) offset=\(offset)")
        // Encode `/` too (.urlPathAllowed leaves it intact): a username is a single
        // path segment, so a stray slash must not be able to inject extra segments.
        let encodedUser = user.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? user
        guard var components = URLComponents(string: apiURL("messages/\(encodedUser)")) else {
            completion(accumulated, false)
            return
        }
        components.queryItems = [
            URLQueryItem(name: "limit", value: String(limit)),
            URLQueryItem(name: "offset", value: String(offset))
        ]
        guard let messagesURL = components.url else {
            completion(accumulated, false)
            return
        }

        var request = URLRequest(url: messagesURL)
        addHistoryHeaders(to: &request)

        httpSession.dataTask(with: request) { data, response, error in
            guard error == nil,
                  let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode),
                  let data = data else {
                self.trace("fetchMessages fallback user=\(user) http=\((response as? HTTPURLResponse)?.statusCode ?? -1) err=\(error?.localizedDescription ?? "nil")")
                completion(accumulated, false)
                return
            }

            let decoder = JSONDecoder()
            if let messages = try? decoder.decode([RemoteMessageRecord].self, from: data) {
                let merged = accumulated + messages
                self.trace("fetchMessages page success user=\(user) offset=\(offset) count=\(messages.count) total=\(merged.count)")
                if messages.count < limit {
                    completion(merged, true)
                } else {
                    self.fetchMessagesPage(for: user, limit: limit, offset: offset + limit, accumulated: merged, completion: completion)
                }
            } else {
                self.trace("fetchMessages decode failed user=\(user) bytes=\(data.count)")
                completion(accumulated, false)
            }
        }.resume()
    }

    private func fetchServerMessagesPage(
        serverId: String,
        channelId: String,
        limit: Int,
        offset: Int,
        accumulated: [RemoteMessageRecord],
        completion: @escaping ([RemoteMessageRecord], Bool) -> Void
    ) {
        trace("fetchServerMessages page start server=\(serverId) channel=\(channelId) limit=\(limit) offset=\(offset)")
        let sid = serverId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? serverId
        let cid = channelId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? channelId
        guard var components = URLComponents(string: apiURL("servers/\(sid)/channels/\(cid)/messages")) else {
            completion(accumulated, false)
            return
        }
        components.queryItems = [
            URLQueryItem(name: "limit", value: String(limit)),
            URLQueryItem(name: "offset", value: String(offset))
        ]
        guard let messagesURL = components.url else {
            completion(accumulated, false)
            return
        }

        var request = URLRequest(url: messagesURL)
        addHistoryHeaders(to: &request)

        httpSession.dataTask(with: request) { data, response, error in
            guard error == nil,
                  let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode),
                  let data = data else {
                self.trace("fetchServerMessages fallback server=\(serverId) channel=\(channelId) http=\((response as? HTTPURLResponse)?.statusCode ?? -1) err=\(error?.localizedDescription ?? "nil")")
                completion(accumulated, false)
                return
            }

            let decoder = JSONDecoder()
            if let messages = try? decoder.decode([RemoteMessageRecord].self, from: data) {
                let merged = accumulated + messages
                self.trace("fetchServerMessages page success server=\(serverId) channel=\(channelId) offset=\(offset) count=\(messages.count) total=\(merged.count)")
                if messages.count < limit {
                    completion(merged, true)
                } else {
                    self.fetchServerMessagesPage(serverId: serverId, channelId: channelId, limit: limit, offset: offset + limit, accumulated: merged, completion: completion)
                }
            } else {
                self.trace("fetchServerMessages decode failed server=\(serverId) channel=\(channelId) bytes=\(data.count)")
                completion(accumulated, false)
            }
        }.resume()
    }
    
    /// Retries transient download failures (mirrors Windows' retry_with_backoff(3),
    /// 250ms/500ms/... capped at 2s). 403 (forbidden) and 413 (too-large sentinel) are
    /// permanent conditions — retrying them would just waste 3 round-trips, so only the
    /// live WS-push path (which previously dropped the message on any single failure)
    /// gets this; history replay already has its own attempt loop in WebView.swift.
    func downloadMessageWithRetry(messageId: String, attempt: Int = 1, completion: @escaping (URL?, Int?) -> Void) {
        downloadMessage(messageId: messageId) { [weak self] fileURL, statusCode in
            if fileURL != nil || statusCode == 403 || statusCode == 413 || attempt >= 3 {
                completion(fileURL, statusCode)
                return
            }
            let delayMs = min(250 * (1 << (attempt - 1)), 2000)
            self?.trace("downloadMessage retry id=\(messageId) nextAttempt=\(attempt + 1) delayMs=\(delayMs)")
            DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(delayMs)) {
                self?.downloadMessageWithRetry(messageId: messageId, attempt: attempt + 1, completion: completion)
            }
        }
    }

    func downloadMessage(messageId: String, completion: @escaping (URL?, Int?) -> Void) {
        trace("downloadMessage start id=\(messageId)")
        guard let downloadURL = URL(string: apiURL("download/\(messageId)")) else {
            completion(nil, nil)
            return
        }

        var request = URLRequest(url: downloadURL)
        addHistoryHeaders(to: &request)

	        httpSession.downloadTask(with: request) { sourceURL, response, error in
	            guard let httpResponse = response as? HTTPURLResponse,
	                  (200..<300).contains(httpResponse.statusCode),
	                  let sourceURL = sourceURL,
	                  error == nil else {
	                self.trace("downloadMessage failed id=\(messageId) http=\((response as? HTTPURLResponse)?.statusCode ?? -1) err=\(error?.localizedDescription ?? "nil")")
	                completion(nil, (response as? HTTPURLResponse)?.statusCode)
	                return
	            }
	            
	            let maxMessageFileBytes = 512 * 1024 * 1024
	            // Unique per download: two concurrent downloads of the SAME message id
	            // (e.g. a history reload racing a WS-triggered fetch) previously shared
	            // "\(messageId).zali" and clobbered/deleted each other's file mid-use.
	            // Callers are responsible for deleting the returned URL when done.
	            let tempFileURL = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("\(messageId)-\(UUID().uuidString).zali")
	            do {
	                try? FileManager.default.removeItem(at: tempFileURL)
	                try FileManager.default.moveItem(at: sourceURL, to: tempFileURL)
	                let bytes = (try? FileManager.default.attributesOfItem(atPath: tempFileURL.path)[.size] as? NSNumber)?.intValue ?? 0
	                guard bytes <= maxMessageFileBytes else {
	                    self.trace("downloadMessage too_large id=\(messageId) bytes=\(bytes)")
	                    try? FileManager.default.removeItem(at: tempFileURL)
	                    // 413 (Payload Too Large) is a sentinel, not a real HTTP status from the
	                    // server — callers use it to skip pointless retries for a permanent condition.
	                    completion(nil, 413)
	                    return
	                }
	                self.trace("downloadMessage saved id=\(messageId) bytes=\(bytes) path=\(tempFileURL.path)")
	                completion(tempFileURL, nil)
	            } catch {
                self.trace("downloadMessage save failed id=\(messageId) err=\(error)")
                completion(nil, nil)
            }
        }.resume()
    }

    private static func makeDataURL(data: Data, mimeType: String) -> String {
        let base64 = data.base64EncodedString()
        return "data:\(mimeType);base64,\(base64)"
    }
    
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        trace("ws didClose code=\(closeCode.rawValue) reasonBytes=\(reason?.count ?? 0)")
        connectionQueue.async { [weak self] in
            guard let self else { return }
            if self.voiceWebSocketTask === webSocketTask {
                self.voiceWebSocketTask = nil
                self.scheduleVoiceReconnect(reason: "didCloseWith", generation: self.voiceConnectionGeneration)
                return
            }
            guard self.webSocketTask === webSocketTask else {
                self.trace("ws didClose ignored for stale task")
                return
            }
            self.heartbeatWorkItem?.cancel()
            self.heartbeatWorkItem = nil
            self.webSocketTask = nil
            // onWebSocketDisconnected is fired centrally inside scheduleReconnect now.
            self.scheduleReconnect(reason: "didCloseWith", generation: self.connectionGeneration)
        }
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol `protocol`: String?) {
        connectionQueue.async { [weak self] in
            guard let self else { return }
            if self.voiceWebSocketTask === webSocketTask {
                self.voiceReconnectAttempt = 0
                self.trace("voice ws didOpen user=\(self.currentUsername)")
                let generation = self.voiceConnectionGeneration
                self.flushVoicePendingQueue(generation: generation)
                self.scheduleVoiceHeartbeat(generation: generation)
                return
            }
            guard self.webSocketTask === webSocketTask else {
                self.trace("ws didOpen ignored for stale task")
                return
            }
            self.reconnectAttempt = 0
            let proto = `protocol` ?? "nil"
            self.trace("ws didOpen protocol=\(proto) user=\(self.currentUsername)")
            DispatchQueue.main.async {
                self.onWebSocketConnected?()
            }
            self.scheduleHeartbeat(generation: self.connectionGeneration)
        }
    }
}
