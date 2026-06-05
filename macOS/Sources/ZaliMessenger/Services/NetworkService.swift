import Foundation

class NetworkService: NSObject, URLSessionWebSocketDelegate {
    static let shared = NetworkService()
    
    private let connectionQueue = DispatchQueue(label: "zali.network.websocket")
    private let configQueue = DispatchQueue(label: "zali.network.config")
    private let apiBaseURLStorageKey = "zali_network_api_base_url"
    private let wsBaseURLStorageKey = "zali_network_ws_base_url"
    private let cryptoKeyStorageKey = "zali_crypto_key_v1"
    private let sessionUsernameStorageKey = "zali_session_username_v1"
    private let sessionTokenStorageKey = "zali_session_token_v1"
    private let pendingOutboxStorageKey = "zali_pending_outbox_v1"
    private let messageCacheStorageKey = "zali_message_cache_v1"
    
    private var webSocketTask: URLSessionWebSocketTask?
    // Separate session for WebSocket (needs delegate); shared session for HTTP requests
    private var wsSession: URLSession?
    private let httpSession = URLSession.shared
    private var configuredServerURL: String?
    private var configuredWSBaseURL: String?
    private var authToken: String?
    private var currentUsername: String = "Zalikus"
    private var connectionGeneration: Int = 0
    private var reconnectAttempt: Int = 0
    private var reconnectWorkItem: DispatchWorkItem?
    private var receiveLoopTask: Task<Void, Never>?
    private var pendingOutboxJSON: String = "[]"
    private var messageCacheJSON: String = #"{"chats":{},"serverChats":{}}"#
    
    private func trace(_ message: String) {
        print("[ZALI][NET] \(message)")
    }
    
    // Callback to notify UI when a message is successfully received and unpacked
    var onMessageReceived: ((_ id: String, _ clientId: String?, _ sender: String, _ receiver: String, _ text: String, _ attachments: [[String: Any]], _ serverId: String?, _ channelId: String?) -> Void)?
    var onMessageDecryptFailed: ((_ id: String, _ sender: String, _ receiver: String, _ serverId: String?, _ channelId: String?) -> Void)?
    var onReactionUpdated: ((_ payload: [String: Any]) -> Void)?
    var onAvatarChanged: ((_ username: String, _ deleted: Bool) -> Void)?
    var onVoiceEvent: ((_ payload: [String: Any]) -> Void)?
    var currentKey: String = ""

    override init() {
        super.init()
        currentKey = (UserDefaults.standard.string(forKey: cryptoKeyStorageKey) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        currentUsername = (UserDefaults.standard.string(forKey: sessionUsernameStorageKey) ?? "Zalikus").trimmingCharacters(in: .whitespacesAndNewlines)
        if let storedToken = UserDefaults.standard.string(forKey: sessionTokenStorageKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
           !storedToken.isEmpty {
            authToken = storedToken
        } else {
            authToken = nil
        }
        pendingOutboxJSON = (UserDefaults.standard.string(forKey: pendingOutboxStorageKey) ?? "[]").trimmingCharacters(in: .whitespacesAndNewlines)
        if pendingOutboxJSON.isEmpty {
            pendingOutboxJSON = "[]"
        }
        messageCacheJSON = (UserDefaults.standard.string(forKey: messageCacheStorageKey) ?? #"{"chats":{},"serverChats":{}}"#).trimmingCharacters(in: .whitespacesAndNewlines)
        if messageCacheJSON.isEmpty {
            messageCacheJSON = #"{"chats":{},"serverChats":{}}"#
        }
        trace("init user=\(currentUsername) hasToken=\(authToken != nil) keySet=\(!currentKey.isEmpty) pendingBytes=\(pendingOutboxJSON.count)")
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
    }

    func configure(apiBaseURL: String?, wsBaseURL: String?) {
        let normalizedAPI = normalizedBaseURL(apiBaseURL)
        let normalizedWS = normalizedWebSocketURL(wsBaseURL)
        trace("configure api=\(normalizedAPI ?? "nil") ws=\(normalizedWS ?? "nil")")
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
        connectWebSocket()
    }

    func setSession(username: String, token: String?, completion: (() -> Void)? = nil) {
        connectionQueue.async { [weak self] in
            guard let self else { return }
            self.currentUsername = username.isEmpty ? "Zalikus" : username
            self.authToken = token?.isEmpty == false ? token : nil
            UserDefaults.standard.set(self.currentUsername, forKey: self.sessionUsernameStorageKey)
            if let token, !token.isEmpty {
                UserDefaults.standard.set(token, forKey: self.sessionTokenStorageKey)
            } else {
                UserDefaults.standard.removeObject(forKey: self.sessionTokenStorageKey)
            }
            self.trace("setSession user=\(self.currentUsername) hasToken=\(self.authToken != nil)")
            self.connectWebSocketLocked()
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
        return request
    }

    func sendWebSocketJSON(_ payload: [String: Any], completion: ((Bool) -> Void)? = nil) {
        connectionQueue.async { [weak self] in
            guard let self else {
                completion?(false)
                return
            }

            guard let task = self.webSocketTask else {
                completion?(false)
                return
            }

            guard let data = try? JSONSerialization.data(withJSONObject: payload, options: []),
                  let text = String(data: data, encoding: .utf8) else {
                completion?(false)
                return
            }

            task.send(.string(text)) { error in
                if let error = error {
                    self.trace("ws send error=\(error)")
                    completion?(false)
                } else {
                    completion?(true)
                }
            }
        }
    }
    
    private func scheduleReconnect(reason: String, generation: Int) {
        connectionQueue.async { [weak self] in
            guard let self else { return }
            guard generation == self.connectionGeneration else { return }

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
                    self.scheduleReconnect(reason: "receive failure", generation: generation)
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

        if let eventType = raw["type"] as? String, eventType.hasPrefix("voice_") {
            trace("handleWebSocketMessage voice dispatch type=\(eventType) roomId=\(raw["roomId"] as? String ?? "") from=\(raw["from"] as? String ?? "") target=\(raw["target"] as? String ?? "")")
            DispatchQueue.main.async {
                self.onVoiceEvent?(raw)
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
            downloadMessage(messageId: wsMsg.id) { [weak self] fileURL in
                guard let fileURL = fileURL else { return }
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

                    let candidateKeys = ZaliCore.candidateMessageKeys(
                        currentKey: self?.currentKey ?? "",
                        participantA: wsMsg.sender,
                        participantB: wsMsg.receiver,
                        serverId: serverId,
                        channelId: channelId,
                        keyVersion: wsMsg.keyVersion ?? wsMsg.key_version
                    )
                    if let unpacked = ZaliCore.shared.unpackMessage(archivePath: fileURL.path, tempDir: tempDir, keys: candidateKeys) {
                        self?.trace("unpack success messageId=\(wsMsg.id) sender=\(unpacked.sender) textBytes=\(unpacked.text.count) attachments=\((unpacked.attachments ?? []).count)")
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

                        DispatchQueue.main.async {
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
    
    func uploadMessage(sender: String, receiver: String, clientId: String, fileURL: URL, serverId: String? = nil, channelId: String? = nil, keyVersion: Int = 2, completion: @escaping (Bool, String?) -> Void) {
        trace("upload start sender=\(sender) receiver=\(receiver) clientId=\(clientId) server=\(serverId ?? "nil") channel=\(channelId ?? "nil") file=\(fileURL.lastPathComponent)")
        guard let uploadURL = URL(string: "\(serverURL)/api/upload") else {
            completion(false, nil)
            return
        }
        
        var request = URLRequest(url: uploadURL)
        request.httpMethod = "POST"
        if let authToken, !authToken.isEmpty {
            request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        }
        
        let boundary = "Boundary-\(UUID().uuidString)"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        
        let bodyURL = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("upload-\(UUID().uuidString).multipart")
        guard FileManager.default.createFile(atPath: bodyURL.path, contents: nil) else {
            completion(false, nil)
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
            completion(false, nil)
            return
        }

        httpSession.uploadTask(with: request, fromFile: bodyURL) { data, response, error in
            if let error = error {
                self.trace("upload failed error=\(error)")
                try? FileManager.default.removeItem(at: bodyURL)
                completion(false, nil)
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
                completion(true, messageId)
            } else {
                let status = (response as? HTTPURLResponse)?.statusCode ?? -1
                let bodyPreview = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
                self.trace("upload rejected http=\(status) body=\(bodyPreview.prefix(300))")
                try? FileManager.default.removeItem(at: bodyURL)
                completion(false, nil)
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

        guard let body = try? JSONSerialization.data(withJSONObject: ["emoji": trimmedEmoji], options: []) else {
            completion(false, nil)
            return
        }
        request.httpBody = body

        httpSession.dataTask(with: request) { data, response, error in
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

    func fetchUsers(completion: @escaping ([String]) -> Void) {
        trace("fetchUsers start user=\(currentUsername)")
        guard let usersURL = URL(string: "\(serverURL)/api/users") else {
            completion(["Alice", "Bob", currentUsername])
            return
        }

        var request = URLRequest(url: usersURL)
        if let authToken, !authToken.isEmpty {
            request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        }

        httpSession.dataTask(with: request) { data, response, error in
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

    func fetchContacts(completion: @escaping ([String]) -> Void) {
        trace("fetchContacts start user=\(currentUsername)")
        guard let contactsURL = URL(string: "\(serverURL)/api/contacts") else {
            completion([])
            return
        }

        var request = URLRequest(url: contactsURL)
        if let authToken, !authToken.isEmpty {
            request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        }

        httpSession.dataTask(with: request) { data, response, error in
            guard error == nil,
                  let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode),
                  let data = data,
                  let payload = try? JSONDecoder().decode([String: [String]].self, from: data) else {
                self.trace("fetchContacts fallback status=\((response as? HTTPURLResponse)?.statusCode ?? -1) err=\(error?.localizedDescription ?? "nil")")
                completion([])
                return
            }

            let contacts = payload["contacts"] ?? []
            self.trace("fetchContacts success count=\(contacts.count) contacts=\(contacts.joined(separator: ","))")
            completion(contacts)
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

    func fetchMessages(for user: String, completion: @escaping ([RemoteMessageRecord]) -> Void) {
        self.fetchMessagesPage(for: user, limit: 200, offset: 0, accumulated: []) { messages in
            completion(messages)
        }
    }

    func fetchServerMessages(serverId: String, channelId: String, completion: @escaping ([RemoteMessageRecord]) -> Void) {
        self.fetchServerMessagesPage(serverId: serverId, channelId: channelId, limit: 200, offset: 0, accumulated: []) { messages in
            completion(messages)
        }
    }

    private func fetchMessagesPage(
        for user: String,
        limit: Int,
        offset: Int,
        accumulated: [RemoteMessageRecord],
        completion: @escaping ([RemoteMessageRecord]) -> Void
    ) {
        trace("fetchMessages page start user=\(user) limit=\(limit) offset=\(offset)")
        guard var components = URLComponents(string: "\(serverURL)/api/messages/\(user.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? user)") else {
            completion(accumulated)
            return
        }
        components.queryItems = [
            URLQueryItem(name: "limit", value: String(limit)),
            URLQueryItem(name: "offset", value: String(offset))
        ]
        guard let messagesURL = components.url else {
            completion(accumulated)
            return
        }

        var request = URLRequest(url: messagesURL)
        if let authToken, !authToken.isEmpty {
            request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        }

        httpSession.dataTask(with: request) { data, response, error in
            guard error == nil,
                  let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode),
                  let data = data else {
                self.trace("fetchMessages fallback user=\(user) http=\((response as? HTTPURLResponse)?.statusCode ?? -1) err=\(error?.localizedDescription ?? "nil")")
                completion(accumulated)
                return
            }

            let decoder = JSONDecoder()
            if let messages = try? decoder.decode([RemoteMessageRecord].self, from: data) {
                let merged = accumulated + messages
                self.trace("fetchMessages page success user=\(user) offset=\(offset) count=\(messages.count) total=\(merged.count)")
                if messages.count < limit {
                    completion(merged)
                } else {
                    self.fetchMessagesPage(for: user, limit: limit, offset: offset + limit, accumulated: merged, completion: completion)
                }
            } else {
                self.trace("fetchMessages decode failed user=\(user) bytes=\(data.count)")
                completion(accumulated)
            }
        }.resume()
    }

    private func fetchServerMessagesPage(
        serverId: String,
        channelId: String,
        limit: Int,
        offset: Int,
        accumulated: [RemoteMessageRecord],
        completion: @escaping ([RemoteMessageRecord]) -> Void
    ) {
        trace("fetchServerMessages page start server=\(serverId) channel=\(channelId) limit=\(limit) offset=\(offset)")
        let sid = serverId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? serverId
        let cid = channelId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? channelId
        guard var components = URLComponents(string: "\(serverURL)/api/servers/\(sid)/channels/\(cid)/messages") else {
            completion(accumulated)
            return
        }
        components.queryItems = [
            URLQueryItem(name: "limit", value: String(limit)),
            URLQueryItem(name: "offset", value: String(offset))
        ]
        guard let messagesURL = components.url else {
            completion(accumulated)
            return
        }

        var request = URLRequest(url: messagesURL)
        if let authToken, !authToken.isEmpty {
            request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        }

        httpSession.dataTask(with: request) { data, response, error in
            guard error == nil,
                  let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode),
                  let data = data else {
                self.trace("fetchServerMessages fallback server=\(serverId) channel=\(channelId) http=\((response as? HTTPURLResponse)?.statusCode ?? -1) err=\(error?.localizedDescription ?? "nil")")
                completion(accumulated)
                return
            }

            let decoder = JSONDecoder()
            if let messages = try? decoder.decode([RemoteMessageRecord].self, from: data) {
                let merged = accumulated + messages
                self.trace("fetchServerMessages page success server=\(serverId) channel=\(channelId) offset=\(offset) count=\(messages.count) total=\(merged.count)")
                if messages.count < limit {
                    completion(merged)
                } else {
                    self.fetchServerMessagesPage(serverId: serverId, channelId: channelId, limit: limit, offset: offset + limit, accumulated: merged, completion: completion)
                }
            } else {
                self.trace("fetchServerMessages decode failed server=\(serverId) channel=\(channelId) bytes=\(data.count)")
                completion(accumulated)
            }
        }.resume()
    }
    
    func downloadMessage(messageId: String, completion: @escaping (URL?) -> Void) {
        trace("downloadMessage start id=\(messageId)")
        guard let downloadURL = URL(string: "\(serverURL)/api/download/\(messageId)") else {
            completion(nil)
            return
        }

        var request = URLRequest(url: downloadURL)
        if let authToken, !authToken.isEmpty {
            request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        }

        httpSession.dataTask(with: request) { data, response, error in
            guard let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode),
                  let data = data,
                  error == nil else {
                self.trace("downloadMessage failed id=\(messageId) http=\((response as? HTTPURLResponse)?.statusCode ?? -1) err=\(error?.localizedDescription ?? "nil")")
                completion(nil)
                return
            }
            
            let tempFileURL = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("\(messageId).zali")
            do {
                try data.write(to: tempFileURL)
                self.trace("downloadMessage saved id=\(messageId) bytes=\(data.count) path=\(tempFileURL.path)")
                completion(tempFileURL)
            } catch {
                self.trace("downloadMessage save failed id=\(messageId) err=\(error)")
                completion(nil)
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
            self.scheduleReconnect(reason: "didCloseWith", generation: self.connectionGeneration)
        }
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol `protocol`: String?) {
        connectionQueue.async { [weak self] in
            guard let self else { return }
            self.reconnectAttempt = 0
            let proto = `protocol` ?? "nil"
            self.trace("ws didOpen protocol=\(proto) user=\(self.currentUsername)")
        }
    }
}
