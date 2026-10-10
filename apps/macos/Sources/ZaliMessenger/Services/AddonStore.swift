import Foundation
import CryptoKit

/// Хранилище аддонов хаба: `ADDON_REQUEST` (веб — `web/src/interface/addons_store.js`).
///
/// `~/Library/Application Support/ZaliMessenger/addons/<id>/`:
///   - `addon.zali` — файл аддона как его установили (магик `ZALIEXTN`);
///   - `meta.json`  — сведения, которые веб показывает в хабе; здесь только хранятся;
///   - `data/…`     — данные аддона «путь → байты» (`kv.json`, `cache/…`).
///
/// Зеркало `apps/windows/src/native/addons.rs` (тот же каталог — экспериментальный
/// macOS Rust-шелл видит те же аддоны) и Android `AddonStore.kt`. Пути
/// проверяются заново теми же правилами, что `pathError` в addon_format.js:
/// путь не должен суметь выйти из папки аддона.
enum AddonStore {
    struct Failure: Error {
        let message: String
        init(_ message: String) { self.message = message }
    }

    static let magic = Array("ZALIEXTN".utf8)
    static let maxArchiveBytes = 32 * 1024 * 1024
    static let maxDataBytes = 32 * 1024 * 1024
    static let maxMetaBytes = 512 * 1024
    static let maxPathBytes = 255
    static let maxListEntries = 20_000

    /// Один последовательный поток на все операции: запись kv.json и чтение
    /// списка не перемешиваются, а окно не ждёт диска.
    static let queue = DispatchQueue(label: "com.zali.messenger.addons", qos: .userInitiated)

    static let root: URL? = {
        guard let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            return nil
        }
        return base
            .appendingPathComponent("ZaliMessenger", isDirectory: true)
            .appendingPathComponent("addons", isDirectory: true)
    }()

    /// `^[a-z0-9][a-z0-9._-]{2,63}$` без `..` — как ID_RE в addon_format.js.
    static func isValidId(_ id: String) -> Bool {
        let bytes = Array(id.utf8)
        guard (3...64).contains(bytes.count), !id.contains("..") else { return false }
        func allowed(_ b: UInt8) -> Bool {
            (b >= 0x61 && b <= 0x7a) || (b >= 0x30 && b <= 0x39) || b == 0x2e || b == 0x5f || b == 0x2d
        }
        let first = bytes[0]
        guard (first >= 0x61 && first <= 0x7a) || (first >= 0x30 && first <= 0x39) else { return false }
        return bytes.allSatisfy(allowed)
    }

    /// Путь данных → сегменты; ошибка — текстом, как у веба.
    static func pathSegments(_ path: String) throws -> [String] {
        if path.isEmpty { throw Failure("пустой путь") }
        if path.utf8.count > maxPathBytes { throw Failure("путь длиннее 255 байт") }
        if path.hasPrefix("/") || path.hasSuffix("/") { throw Failure("путь начинается или кончается «/»") }
        var segments: [String] = []
        for segment in path.split(separator: "/", omittingEmptySubsequences: false) {
            if segment.isEmpty { throw Failure("пустой сегмент пути") }
            if segment == "." || segment == ".." { throw Failure("сегмент «.» или «..»") }
            let ok = segment.utf8.allSatisfy { b in
                (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a)
                    || b == 0x2e || b == 0x5f || b == 0x2d
            }
            if !ok { throw Failure("недопустимые символы в пути") }
            segments.append(String(segment))
        }
        return segments
    }

    static func handle(_ dict: [String: Any]) throws -> [String: Any] {
        guard let root else { throw Failure("Нет папки данных приложения") }
        return try handle(dict, root: root)
    }

    static func handle(_ dict: [String: Any], root: URL) throws -> [String: Any] {
        let op = dict["op"] as? String ?? ""
        let fm = FileManager.default
        switch op {
        case "store.list":
            var addons: [[String: Any]] = []
            let entries = (try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []
            for dir in entries {
                let id = dir.lastPathComponent
                guard isValidId(id), fm.fileExists(atPath: dir.appendingPathComponent("addon.zali").path),
                      let data = try? Data(contentsOf: dir.appendingPathComponent("meta.json")),
                      let meta = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
                addons.append(["addonId": id, "meta": meta])
            }
            return ["addons": addons]

        case "store.get":
            let dir = try addonDir(dict, root: root)
            guard let data = try? Data(contentsOf: dir.appendingPathComponent("addon.zali")) else {
                throw Failure("Файл аддона не найден")
            }
            return ["dataBase64": data.base64EncodedString(), "sha256": sha256Hex(data)]

        case "store.put":
            let dir = try addonDir(dict, root: root)
            let id = dict["addonId"] as? String ?? ""
            guard let meta = dict["meta"] as? [String: Any] else { throw Failure("Нет сведений об аддоне") }
            guard (meta["id"] as? String) == id else { throw Failure("Сведения не от этого аддона") }
            guard JSONSerialization.isValidJSONObject(meta),
                  let metaData = try? JSONSerialization.data(withJSONObject: meta) else {
                throw Failure("Сведения об аддоне повреждены")
            }
            if metaData.count > maxMetaBytes { throw Failure("Сведения об аддоне слишком большие") }
            let data = try decodeBase64(dict, limit: maxArchiveBytes)
            guard data.count >= magic.count, Array(data.prefix(magic.count)) == magic else {
                throw Failure("Это не файл аддона")
            }
            try writeAtomic(data, to: dir.appendingPathComponent("addon.zali"))
            try writeAtomic(metaData, to: dir.appendingPathComponent("meta.json"))
            return ["sha256": sha256Hex(data)]

        case "store.remove":
            let dir = try addonDir(dict, root: root)
            if fm.fileExists(atPath: dir.path) {
                do { try fm.removeItem(at: dir) } catch { throw Failure("Не удалось удалить аддон: \(error.localizedDescription)") }
            }
            return [:]

        case "data.read":
            let file = try dataFile(dict, root: root)
            guard fm.fileExists(atPath: file.path) else { return ["exists": false] }
            do {
                let data = try Data(contentsOf: file)
                return ["exists": true, "dataBase64": data.base64EncodedString()]
            } catch {
                throw Failure("Не удалось прочитать: \(error.localizedDescription)")
            }

        case "data.write":
            let file = try dataFile(dict, root: root)
            guard fm.fileExists(atPath: try addonDir(dict, root: root).appendingPathComponent("addon.zali").path) else {
                throw Failure("Аддон не установлен")
            }
            let data = try decodeBase64(dict, limit: maxDataBytes)
            try writeAtomic(data, to: file)
            return [:]

        case "data.delete":
            let file = try dataFile(dict, root: root)
            if fm.fileExists(atPath: file.path) {
                do { try fm.removeItem(at: file) } catch { throw Failure("Не удалось удалить: \(error.localizedDescription)") }
            }
            return [:]

        case "data.list":
            let dataDir = try addonDir(dict, root: root).appendingPathComponent("data", isDirectory: true)
            let prefix = dict["path"] as? String ?? ""
            if prefix.utf8.count > maxPathBytes || prefix.contains("\\") || prefix.contains("..") {
                throw Failure("Недопустимый префикс")
            }
            var out: [[String: Any]] = []
            listData(dataDir, rel: "", prefix: prefix, out: &out)
            return ["entries": out]

        default:
            throw Failure("Неизвестная операция аддонов «\(String(op.prefix(40)))»")
        }
    }

    private static func addonDir(_ dict: [String: Any], root: URL) throws -> URL {
        let id = dict["addonId"] as? String ?? ""
        guard isValidId(id) else { throw Failure("Некорректный id аддона") }
        return root.appendingPathComponent(id, isDirectory: true)
    }

    private static func dataFile(_ dict: [String: Any], root: URL) throws -> URL {
        let rel = dict["path"] as? String ?? ""
        let segments: [String]
        do { segments = try pathSegments(rel) } catch let failure as Failure {
            throw Failure("Путь «\(rel)»: \(failure.message)")
        }
        var url = try addonDir(dict, root: root).appendingPathComponent("data", isDirectory: true)
        for segment in segments { url.appendPathComponent(segment) }
        return url
    }

    private static func decodeBase64(_ dict: [String: Any], limit: Int) throws -> Data {
        let encoded = dict["dataBase64"] as? String ?? ""
        if encoded.utf8.count > limit / 3 * 4 + 8 { throw Failure("Слишком большие данные") }
        guard let data = Data(base64Encoded: encoded) else { throw Failure("Данные повреждены (base64)") }
        if data.count > limit { throw Failure("Слишком большие данные") }
        return data
    }

    /// `.atomic` пишет во временный файл и переименовывает: оборванная запись
    /// не оставит наполовину записанный kv.json или файл аддона.
    private static func writeAtomic(_ data: Data, to url: URL) throws {
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: url, options: .atomic)
        } catch {
            throw Failure("Не удалось записать файл: \(error.localizedDescription)")
        }
    }

    private static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private static func listData(_ dir: URL, rel: String, prefix: String, out: inout [[String: Any]]) {
        let fm = FileManager.default
        let keys: [URLResourceKey] = [.isDirectoryKey, .isRegularFileKey, .fileSizeKey]
        guard let entries = try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: keys) else { return }
        for entry in entries {
            if out.count >= maxListEntries { return }
            let name = entry.lastPathComponent
            if name.hasPrefix(".") || (try? pathSegments(name)) == nil { continue }
            let path = rel.isEmpty ? name : "\(rel)/\(name)"
            guard let values = try? entry.resourceValues(forKeys: Set(keys)) else { continue }
            if values.isDirectory == true {
                let asDir = path + "/"
                if prefix.hasPrefix(asDir) || asDir.hasPrefix(prefix) {
                    listData(entry, rel: path, prefix: prefix, out: &out)
                }
            } else if values.isRegularFile == true, path.hasPrefix(prefix) {
                out.append(["path": path, "size": values.fileSize ?? 0])
            }
        }
    }
}
