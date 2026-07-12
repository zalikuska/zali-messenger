import Foundation
import CoreBridge

class ZaliCore {
    static let shared = ZaliCore()

    static func dmConversationScope(_ a: String, _ b: String) -> String? {
        let first = a.trimmingCharacters(in: .whitespacesAndNewlines)
        let second = b.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !first.isEmpty, !second.isEmpty else { return nil }
        let sorted = [first, second].sorted()
        return "dm:\(sorted[0]):\(sorted[1])"
    }

    static func serverConversationScope(_ serverId: String, _ channelId: String) -> String? {
        let sid = serverId.trimmingCharacters(in: .whitespacesAndNewlines)
        let cid = channelId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !sid.isEmpty, !cid.isEmpty else { return nil }
        return "server:\(sid):\(cid)"
    }

    private static func pushCandidateKey(_ keys: inout [String], _ key: String?) {
        guard let key else { return }
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !keys.contains(trimmed) else { return }
        keys.append(trimmed)
    }

    static func candidateMessageKeys(
        currentKey: String,
        conversationKeys: [String: String] = [:],
        participantA: String?,
        participantB: String?,
        serverId: String? = nil,
        channelId: String? = nil
    ) -> [String] {
        var keys: [String] = []

        // A message scoped to a server is never a DM, even if channelId is missing —
        // falling through to a DM-scope lookup here would key it under the wrong scope.
        if let serverId, !serverId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            if let channelId, let scope = serverConversationScope(serverId, channelId) {
                pushCandidateKey(&keys, conversationKeys[scope])
            }
        } else if let participantA, let participantB, let scope = dmConversationScope(participantA, participantB) {
            pushCandidateKey(&keys, conversationKeys[scope])
        }

        // Always keep currentKey as a candidate (deduped, appended after any scope key):
        // a message may have been encrypted under currentKey even when a differing
        // conversation-scope key now exists (key rotation / legacy messages). Dropping it
        // whenever a scope key was present made those messages undecryptable.
        pushCandidateKey(&keys, currentKey)

        return keys
    }

    struct AttachmentPayload: Codable {
        let name: String
        let archivePath: String
        let mimeType: String
        let kind: String
        let size: UInt64
    }

    struct MessagePayload: Codable {
        let sender: String
        let text: String
        let timestamp: UInt64
        let keyVersion: Int?
        let attachments: [AttachmentPayload]?
    }
    
    /// Sends a JSON-serialized command payload to the Rust ZaliBus and returns the result.
    func dispatch(addressCommand: String, args: [String: Any]) -> [String: Any]? {
        guard let argsData = try? JSONSerialization.data(withJSONObject: args, options: []),
              let argsStr = String(data: argsData, encoding: .utf8) else {
            return ["success": false, "error": "Failed to serialize arguments to JSON"]
        }
        
        guard let cResult = zali_bus_dispatch(addressCommand, argsStr) else {
            return nil
        }
        defer {
            zali_bus_free_string(cResult)
        }
        
        let resultStr = String(cString: cResult)
        guard let resultData = resultStr.data(using: .utf8),
              let dict = try? JSONSerialization.jsonObject(with: resultData, options: []) as? [String: Any] else {
            return ["success": false, "error": "Failed to parse JSON result from bus"]
        }
        
        return dict
    }
    
    func packMessage(
        sender: String,
        text: String,
        output: String,
        key: String,
        keyVersion: Int = 2,
        attachments: [[String: Any]] = []
    ) -> Bool {
        guard !key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return false
        }
        var args: [String: Any] = [
            "sender": sender,
            "text": text,
            "key": key,
            "output_path": output
        ]
        if !attachments.isEmpty {
            args["attachments"] = attachments
        }
        args["key_version"] = max(1, keyVersion)
        if let result = dispatch(addressCommand: "zali_net:pack_message", args: args),
           let success = result["success"] as? Bool {
            return success
        }
        return false
    }
    
    func unpackMessage(archivePath: String, tempDir: String, key: String) -> MessagePayload? {
        guard !key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }
        let args: [String: Any] = [
            "archive_path": archivePath,
            "temp_dir": tempDir,
            "key": key
        ]
        if let result = dispatch(addressCommand: "zali_net:unpack_message", args: args),
           let success = result["success"] as? Bool, success,
           let data = result["data"] {
            guard let json = try? JSONSerialization.data(withJSONObject: data, options: []),
                  let payload = try? JSONDecoder().decode(MessagePayload.self, from: json) else {
                return nil
            }
            return payload
        }
        return nil
    }

    func unpackMessage(archivePath: String, tempDir: String, keys: [String]) -> MessagePayload? {
        var tried = Set<String>()
        for key in keys {
            let normalized = key.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !normalized.isEmpty, tried.insert(normalized).inserted else { continue }
            if let payload = unpackMessage(archivePath: archivePath, tempDir: tempDir, key: normalized) {
                return payload
            }
        }
        return nil
    }
}
