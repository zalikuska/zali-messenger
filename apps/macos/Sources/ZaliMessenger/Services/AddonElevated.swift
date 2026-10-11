import Foundation
import AppKit

/// Повышенные права аддонов хаба: файлы на всём диске (`fs.read`/`fs.write`),
/// запуск программ (`launch`) и собственный процесс-бэкенд (`process`).
///
/// Зеркало `apps/windows/src/native/addon_elevated.rs`, модель та же:
/// - права берутся из манифеста внутри самого файла аддона;
/// - при установке (`store.put`) — системный диалог и `grant.json` с отпечатком
///   SHA-256 файла и подтверждёнными правами;
/// - при каждом запуске (`session.start`) — снова диалог, и только для того же
///   отпечатка; выдаётся `sessionId`, без которого ни одна операция ниже не
///   выполняется, и только в пределах прав этой сессии;
/// - `session.end` закрывает сессию и завершает бэкенд.
///
/// Всё, кроме чтения вывода бэкенда, выполняется в `AddonStore.queue`, поэтому
/// словарь сессий ничем больше не защищён.
enum AddonElevated {
    static let elevatedPermissions = ["network.any", "fs.read", "fs.write", "launch", "process"]
    static let maxFsBytes = 32 * 1024 * 1024
    static let maxListEntries = 5_000
    static let maxBackendLine = 1024 * 1024

    /// Доставка событий в веб (bus `addon_event`); ставит WebView.Coordinator.
    static var emit: (([String: Any]) -> Void)?

    static var backendPlatformKey: String {
        #if arch(arm64)
        return "macos-arm64"
        #else
        return "macos-x64"
        #endif
    }

    // MARK: - Файл аддона: контейнер и манифест

    struct Archive {
        let bytes: [UInt8]
        let entries: [String: Range<Int>]
        let manifest: [String: Any]

        var name: String { String(((manifest["name"] as? String) ?? "Аддон").prefix(64)) }

        var elevated: [String] {
            let declared = Set((manifest["permissions"] as? [Any] ?? []).compactMap { $0 as? String })
            return AddonElevated.elevatedPermissions.filter { declared.contains($0) }
        }

        func file(_ name: String) -> Data? {
            guard let range = entries[name.lowercased()] else { return nil }
            return Data(bytes[range])
        }
    }

    /// Тот же разбор, что `parseContainer` в web/src/modules/addon_format.js.
    static func parseArchive(_ data: Data) throws -> Archive {
        let b = [UInt8](data)
        var o = 0
        func broken(_ what: String) -> AddonStore.Failure { AddonStore.Failure("Файл аддона повреждён: \(what)") }
        func need(_ n: Int) throws { if n < 0 || o + n > b.count { throw broken("обрезан") } }
        func u16(_ at: Int) -> Int { Int(b[at]) | (Int(b[at + 1]) << 8) }
        func u32(_ at: Int) -> Int { (0..<4).reduce(0) { $0 | (Int(b[at + $1]) << (8 * $1)) } }
        func u64(_ at: Int) -> UInt64 { (0..<8).reduce(UInt64(0)) { $0 | (UInt64(b[at + $1]) << UInt64(8 * $1)) } }

        try need(8)
        guard Array(b[0..<8]) == AddonStore.magic else { throw broken("не тот магик") }
        o = 8
        try need(1)
        guard b[o] == 1 else { throw broken("версия формата") }
        o += 1
        for _ in 0..<2 {
            try need(1)
            let len = Int(b[o])
            o += 1
            try need(len)
            o += len
        }
        try need(5)
        guard b[o] == 0 else { throw broken("зашифрован") }
        o += 1
        let count = u32(o)
        o += 4
        guard count <= 2000 else { throw broken("слишком много записей") }
        var entries: [String: Range<Int>] = [:]
        for _ in 0..<count {
            try need(2)
            let nameLen = u16(o)
            o += 2
            try need(nameLen + 16)
            guard let name = String(bytes: b[o..<(o + nameLen)], encoding: .utf8) else { throw broken("имя") }
            o += nameLen
            _ = try AddonStore.pathSegments(name)
            let size = u64(o)
            let stored = u64(o + 8)
            o += 16
            guard size == stored, size <= UInt64(b.count) else { throw broken("размеры") }
            try need(Int(size))
            let key = name.lowercased()
            guard entries[key] == nil else { throw broken("повтор имени") }
            entries[key] = o..<(o + Int(size))
            o += Int(size)
        }
        guard o == b.count else { throw broken("лишние данные") }
        guard let raw = entries["manifest.json"] else { throw AddonStore.Failure("В файле нет manifest.json") }
        guard let manifest = (try? JSONSerialization.jsonObject(with: Data(b[raw]))) as? [String: Any] else {
            throw AddonStore.Failure("manifest.json — не JSON-объект")
        }
        return Archive(bytes: b, entries: entries, manifest: manifest)
    }

    private static func permissionLines(_ permissions: [String]) -> String {
        permissions.compactMap { p -> String? in
            switch p {
            case "network.any": return "• обращаться к любым серверам в интернете и передавать им данные аддона"
            case "fs.read": return "• читать любые файлы и папки компьютера"
            case "fs.write": return "• создавать, менять и удалять любые файлы компьютера"
            case "launch": return "• открывать файлы и запускать программы"
            case "process": return "• запускать свою программу с вашими правами"
            default: return nil
            }
        }.joined(separator: "\n")
    }

    /// Системный диалог; «Отмена» — кнопка по умолчанию. Зовётся из
    /// AddonStore.queue, ответ ждёт на главном потоке.
    static func confirm(title: String, message: String, action: String) -> Bool {
        let ask = { () -> Bool in
            let alert = NSAlert()
            alert.alertStyle = .warning
            alert.messageText = title
            alert.informativeText = message
            alert.addButton(withTitle: "Отмена")
            alert.addButton(withTitle: action)
            NSApp.activate(ignoringOtherApps: true)
            return alert.runModal() == .alertSecondButtonReturn
        }
        if Thread.isMainThread { return ask() }
        return DispatchQueue.main.sync(execute: ask)
    }

    private static func grantURL(_ dir: URL) -> URL { dir.appendingPathComponent("grant.json") }

    /// `store.put`: подтверждение до записи файла; отказ отменяет установку.
    static func confirmInstall(_ archive: Archive, sha256: String) throws -> [String] {
        let elevated = archive.elevated
        if elevated.isEmpty { return elevated }
        let message = "Аддон «\(archive.name)» просит повышенные права:\n\n\(permissionLines(elevated))\n\nОн сможет делать это от вашего имени, пока открыт. Устанавливайте его, только если доверяете автору.\n\nОтпечаток: \(sha256.prefix(32))"
        guard confirm(title: "Установить аддон с повышенными правами?", message: message, action: "Установить") else {
            throw AddonStore.Failure("Установка отменена")
        }
        return elevated
    }

    static func writeGrant(_ dir: URL, sha256: String, elevated: [String]) throws {
        if elevated.isEmpty {
            try? FileManager.default.removeItem(at: grantURL(dir))
            return
        }
        let body = try JSONSerialization.data(withJSONObject: ["sha256": sha256, "permissions": elevated])
        do { try body.write(to: grantURL(dir), options: .atomic) } catch {
            throw AddonStore.Failure("Не удалось сохранить подтверждение: \(error.localizedDescription)")
        }
    }

    // MARK: - Сессии

    final class Session {
        let addonId: String
        let permissions: Set<String>
        let dataDir: URL
        var process: Process?
        var stdin: FileHandle?

        init(addonId: String, permissions: Set<String>, dataDir: URL) {
            self.addonId = addonId
            self.permissions = permissions
            self.dataDir = dataDir
        }

        func stopBackend() {
            process?.terminationHandler = nil
            if process?.isRunning == true { process?.terminate() }
            try? stdin?.close()
            process = nil
            stdin = nil
        }
    }

    private static var sessions: [String: Session] = [:]

    private static func session(_ dict: [String: Any], _ permission: String?) throws -> Session {
        let id = dict["sessionId"] as? String ?? ""
        guard let session = sessions[id] else { throw AddonStore.Failure("Аддон не запущен с повышенными правами") }
        if let permission, !session.permissions.contains(permission) {
            throw AddonStore.Failure("Нет разрешения «\(permission)»")
        }
        return session
    }

    private static func readArchive(_ dir: URL) throws -> (Archive, String) {
        guard let data = try? Data(contentsOf: dir.appendingPathComponent("addon.zali")) else {
            throw AddonStore.Failure("Файл аддона не найден")
        }
        return (try parseArchive(data), AddonStore.sha256Hex(data))
    }

    static func sessionStart(_ dict: [String: Any], root: URL) throws -> [String: Any] {
        let addonId = dict["addonId"] as? String ?? ""
        guard AddonStore.isValidId(addonId) else { throw AddonStore.Failure("Некорректный id аддона") }
        let dir = root.appendingPathComponent(addonId, isDirectory: true)
        let (archive, sha256) = try readArchive(dir)
        let elevated = archive.elevated
        let grant = (try? Data(contentsOf: grantURL(dir))).flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]
        let granted = Set((grant?["permissions"] as? [Any] ?? []).compactMap { $0 as? String })
        guard (grant?["sha256"] as? String) == sha256, elevated.allSatisfy({ granted.contains($0) }) else {
            throw AddonStore.Failure("Повышенные права этого файла не подтверждались при установке — переустановите аддон")
        }
        if !elevated.isEmpty {
            let message = "Аддон «\(archive.name)» запускается с повышенными правами:\n\n\(permissionLines(elevated))"
            guard confirm(title: "Запустить аддон с повышенными правами?", message: message, action: "Запустить") else {
                throw AddonStore.Failure("Запуск отменён")
            }
        }
        // Одна сессия на аддон: прежняя (если веб её не закрыл) закрывается.
        for (key, old) in sessions where old.addonId == addonId {
            old.stopBackend()
            sessions.removeValue(forKey: key)
        }
        let sessionId = UUID().uuidString.replacingOccurrences(of: "-", with: "") + UUID().uuidString.replacingOccurrences(of: "-", with: "")
        let dataDir = dir.appendingPathComponent("data", isDirectory: true)
        try? FileManager.default.createDirectory(at: dataDir, withIntermediateDirectories: true)
        let session = Session(addonId: addonId, permissions: Set(elevated), dataDir: dataDir)
        if session.permissions.contains("process") {
            try startBackend(session, sessionId: sessionId, dir: dir, archive: archive, sha256: sha256)
        }
        sessions[sessionId] = session
        return ["sessionId": sessionId, "granted": elevated, "backend": session.process != nil]
    }

    // MARK: - Бэкенд-процесс

    /// Копит вывод бэкенда и режет на строки; вызывается из потока чтения Pipe.
    private final class LineReader {
        private var buffer = Data()
        private let lock = NSLock()
        let onLine: (Data) -> Void
        let onOverflow: () -> Void

        init(onLine: @escaping (Data) -> Void, onOverflow: @escaping () -> Void) {
            self.onLine = onLine
            self.onOverflow = onOverflow
        }

        func feed(_ chunk: Data) {
            var lines: [Data] = []
            var overflow = false
            lock.lock()
            buffer.append(chunk)
            while let nl = buffer.firstIndex(of: 0x0a) {
                lines.append(Data(buffer[buffer.startIndex..<nl]))
                buffer = Data(buffer[(nl + 1)...])
            }
            if buffer.count > AddonElevated.maxBackendLine {
                buffer = Data()
                overflow = true
            }
            lock.unlock()
            lines.forEach(onLine)
            if overflow { onOverflow() }
        }
    }

    private static func startBackend(_ session: Session, sessionId: String, dir: URL, archive: Archive, sha256: String) throws {
        guard let backend = archive.manifest["backend"] as? [String: Any],
              let command = (backend["commands"] as? [String: Any])?[backendPlatformKey] as? String else {
            throw AddonStore.Failure("У аддона нет программы для этой системы")
        }
        let segments = try AddonStore.pathSegments(command)
        guard let body = archive.file(command) else { throw AddonStore.Failure("Программы бэкенда нет в файле аддона") }
        let args = Array((backend["args"] as? [Any] ?? []).compactMap { $0 as? String }.prefix(32))

        // Распаковка: bin/<отпечаток>/<путь>; старые версии удаляются, а
        // распакованный файл сверяется с архивом при каждом запуске.
        let fm = FileManager.default
        let binRoot = dir.appendingPathComponent("bin", isDirectory: true)
        let versionDir = binRoot.appendingPathComponent(String(sha256.prefix(16)), isDirectory: true)
        for old in (try? fm.contentsOfDirectory(at: binRoot, includingPropertiesForKeys: nil)) ?? [] where old.lastPathComponent != versionDir.lastPathComponent {
            try? fm.removeItem(at: old)
        }
        var exe = versionDir
        for s in segments { exe.appendPathComponent(s) }
        if (try? Data(contentsOf: exe)) != body {
            do {
                try fm.createDirectory(at: exe.deletingLastPathComponent(), withIntermediateDirectories: true)
                try body.write(to: exe, options: .atomic)
            } catch {
                throw AddonStore.Failure("Не удалось распаковать бэкенд: \(error.localizedDescription)")
            }
        }
        try? fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: exe.path)

        let process = Process()
        process.executableURL = exe
        process.arguments = args
        process.currentDirectoryURL = session.dataDir
        var env = ProcessInfo.processInfo.environment
        env["ZALI_ADDON_ID"] = session.addonId
        env["ZALI_ADDON_DIR"] = versionDir.path
        env["ZALI_ADDON_DATA"] = session.dataDir.path
        process.environment = env
        let inPipe = Pipe(), outPipe = Pipe(), errPipe = Pipe()
        process.standardInput = inPipe
        process.standardOutput = outPipe
        process.standardError = errPipe

        let reader = LineReader(
            onLine: { line in
                guard let text = String(data: line, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return }
                let data: Any = (try? JSONSerialization.jsonObject(with: Data(text.utf8), options: [.fragmentsAllowed])) ?? ["text": text]
                AddonElevated.emit?(["sessionId": sessionId, "event": "backend", "data": data])
            },
            onOverflow: {
                AddonElevated.emit?(["sessionId": sessionId, "event": "backend-error", "data": ["message": "Строка от бэкенда длиннее 1 МБ"]])
            }
        )
        outPipe.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            if chunk.isEmpty {
                handle.readabilityHandler = nil
                return
            }
            reader.feed(chunk)
        }
        // stderr — только чтобы трубка не забилась и не остановила процесс.
        errPipe.fileHandleForReading.readabilityHandler = { handle in
            if handle.availableData.isEmpty { handle.readabilityHandler = nil }
        }
        process.terminationHandler = { finished in
            AddonElevated.emit?(["sessionId": sessionId, "event": "backend-exit", "data": ["code": Int(finished.terminationStatus)]])
        }
        do { try process.run() } catch {
            throw AddonStore.Failure("Не удалось запустить бэкенд: \(error.localizedDescription)")
        }
        session.process = process
        session.stdin = inPipe.fileHandleForWriting
    }

    // MARK: - Операции

    private static func absolutePath(_ dict: [String: Any]) throws -> URL {
        let raw = dict["path"] as? String ?? ""
        guard !raw.isEmpty, raw.utf8.count <= 4096, !raw.contains("\0"), raw.hasPrefix("/") else {
            throw AddonStore.Failure("Нужен полный путь (от корня диска)")
        }
        return URL(fileURLWithPath: raw).standardizedFileURL
    }

    private static func kind(_ attrs: [FileAttributeKey: Any]) -> String {
        let type = attrs[.type] as? FileAttributeType
        if type == .typeDirectory { return "dir" }
        if type == .typeRegular { return "file" }
        return "other"
    }

    private static func modifiedMs(_ attrs: [FileAttributeKey: Any]) -> Any {
        guard let date = attrs[.modificationDate] as? Date else { return NSNull() }
        return Int64(date.timeIntervalSince1970 * 1000)
    }

    /// Ответ кладётся в `data` NativeResponse; `nil` — операция не отсюда (её разбирает AddonStore).
    static func handle(_ dict: [String: Any], root: URL) throws -> Any? {
        let op = dict["op"] as? String ?? ""
        let fm = FileManager.default
        switch op {
        case "session.start":
            return try sessionStart(dict, root: root)

        case "session.end":
            let id = dict["sessionId"] as? String ?? ""
            sessions.removeValue(forKey: id)?.stopBackend()
            return [:]

        case "backend.send":
            let s = try session(dict, "process")
            guard let stdin = s.stdin, s.process?.isRunning == true else { throw AddonStore.Failure("Бэкенд не запущен") }
            let message = dict["message"] ?? NSNull()
            guard let line = try? JSONSerialization.data(withJSONObject: message, options: [.fragmentsAllowed]), line.count <= maxBackendLine else {
                throw AddonStore.Failure("Сообщение не JSON или больше 1 МБ")
            }
            do {
                try stdin.write(contentsOf: line + Data([0x0a]))
            } catch {
                throw AddonStore.Failure("Бэкенд не принимает сообщения (завершился?)")
            }
            return true

        case "backend.restart":
            let s = try session(dict, "process")
            s.stopBackend()
            let dir = root.appendingPathComponent(s.addonId, isDirectory: true)
            let (archive, sha256) = try readArchive(dir)
            try startBackend(s, sessionId: dict["sessionId"] as? String ?? "", dir: dir, archive: archive, sha256: sha256)
            return true

        case "fs.paths":
            let s = try session(dict, nil)
            guard s.permissions.contains("fs.read") || s.permissions.contains("fs.write") else {
                throw AddonStore.Failure("Нет разрешения на файлы")
            }
            let home = fm.homeDirectoryForCurrentUser
            return [
                "home": home.path,
                "documents": home.appendingPathComponent("Documents").path,
                "downloads": home.appendingPathComponent("Downloads").path,
                "desktop": home.appendingPathComponent("Desktop").path,
                "temp": fm.temporaryDirectory.path,
                "addonData": s.dataDir.path,
                "separator": "/",
                "platform": backendPlatformKey,
            ]

        case "fs.read":
            _ = try session(dict, "fs.read")
            let url = try absolutePath(dict)
            guard let attrs = try? fm.attributesOfItem(atPath: url.path), kind(attrs) == "file" else {
                throw AddonStore.Failure("Это не файл или к нему нет доступа")
            }
            if let size = attrs[.size] as? NSNumber, size.intValue > maxFsBytes { throw AddonStore.Failure("Файл больше 32 МБ") }
            do {
                return ["dataBase64": try Data(contentsOf: url).base64EncodedString()]
            } catch {
                throw AddonStore.Failure("Не удалось прочитать: \(error.localizedDescription)")
            }

        case "fs.stat":
            _ = try session(dict, "fs.read")
            let url = try absolutePath(dict)
            guard let attrs = try? fm.attributesOfItem(atPath: url.path) else { return ["exists": false] }
            return ["exists": true, "type": kind(attrs), "size": (attrs[.size] as? NSNumber)?.int64Value ?? 0, "modifiedMs": modifiedMs(attrs)]

        case "fs.list":
            _ = try session(dict, "fs.read")
            let url = try absolutePath(dict)
            let names: [String]
            do { names = try fm.contentsOfDirectory(atPath: url.path) } catch {
                throw AddonStore.Failure("Не удалось открыть папку: \(error.localizedDescription)")
            }
            let items: [[String: Any]] = names.prefix(maxListEntries).map { name in
                let attrs = (try? fm.attributesOfItem(atPath: url.appendingPathComponent(name).path)) ?? [:]
                return ["name": name, "type": kind(attrs), "size": (attrs[.size] as? NSNumber)?.int64Value ?? 0, "modifiedMs": modifiedMs(attrs)]
            }
            return items

        case "fs.write":
            _ = try session(dict, "fs.write")
            let url = try absolutePath(dict)
            let encoded = dict["dataBase64"] as? String ?? ""
            guard encoded.utf8.count <= maxFsBytes / 3 * 4 + 8, let data = Data(base64Encoded: encoded) else {
                throw AddonStore.Failure("Данные повреждены или больше 32 МБ")
            }
            do {
                if (dict["append"] as? Bool) == true, fm.fileExists(atPath: url.path) {
                    let handle = try FileHandle(forWritingTo: url)
                    defer { try? handle.close() }
                    try handle.seekToEnd()
                    try handle.write(contentsOf: data)
                } else {
                    try data.write(to: url)
                }
            } catch {
                throw AddonStore.Failure("Не удалось записать: \(error.localizedDescription)")
            }
            return true

        case "fs.mkdir":
            _ = try session(dict, "fs.write")
            let url = try absolutePath(dict)
            do { try fm.createDirectory(at: url, withIntermediateDirectories: true) } catch {
                throw AddonStore.Failure("Не удалось создать папку: \(error.localizedDescription)")
            }
            return true

        case "fs.remove":
            _ = try session(dict, "fs.write")
            let url = try absolutePath(dict)
            // Корень диска, /Users, папка пользователя и её предки — никогда.
            let home = fm.homeDirectoryForCurrentUser.standardizedFileURL.pathComponents
            let target = url.pathComponents
            if target.count <= 2 || (target.count <= home.count && Array(home.prefix(target.count)) == target) {
                throw AddonStore.Failure("Эту папку удалять нельзя")
            }
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: url.path, isDirectory: &isDir) else { return false }
            if isDir.boolValue, (dict["recursive"] as? Bool) != true,
               !((try? fm.contentsOfDirectory(atPath: url.path))?.isEmpty ?? true) {
                throw AddonStore.Failure("Папка не пуста — нужен recursive")
            }
            do { try fm.removeItem(at: url) } catch {
                throw AddonStore.Failure("Не удалось удалить: \(error.localizedDescription)")
            }
            return true

        case "system.open":
            _ = try session(dict, "launch")
            let url = try absolutePath(dict)
            guard fm.fileExists(atPath: url.path) else { throw AddonStore.Failure("Такого файла или папки нет") }
            let opened = DispatchQueue.main.sync { NSWorkspace.shared.open(url) }
            if !opened { throw AddonStore.Failure("Не удалось открыть") }
            return true

        case "system.exec":
            _ = try session(dict, "launch")
            let url = try absolutePath(dict)
            let process = Process()
            process.executableURL = url
            process.arguments = Array((dict["args"] as? [Any] ?? []).compactMap { $0 as? String }.prefix(64))
            if let cwd = dict["cwd"] as? String, !cwd.isEmpty {
                guard cwd.hasPrefix("/") else { throw AddonStore.Failure("cwd — полный путь") }
                process.currentDirectoryURL = URL(fileURLWithPath: cwd)
            }
            process.standardInput = FileHandle.nullDevice
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            do { try process.run() } catch {
                throw AddonStore.Failure("Не удалось запустить: \(error.localizedDescription)")
            }
            return ["pid": Int(process.processIdentifier)]

        default:
            return nil
        }
    }
}
