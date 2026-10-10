import AppKit
import Foundation

/// Определяет, запущена ли сейчас игра, — для игрового статуса «Играет в …».
///
/// Оболочка только ВИДИТ процессы; что с этим делать (включено ли, ручной статус,
/// список «это не игра», отправка на сервер) решает веб-слой, `game_activity.js`.
/// Сюда из JS приходит один раз `GAME_DETECTOR_CONFIG` с флагом и каталогом
/// известных игр, отсюда уходит `native_game_activity` — и только при смене.
///
/// Игрой считается запущенное приложение, у которого есть один из двух
/// положительных признаков (ни один не «угадывает»):
///  1. имя процесса/приложения есть в каталоге;
///  2. исполняемый файл лежит в папке игры лаунчера — `steamapps/common/<Игра>/`,
///     `Epic Games/<Игра>/`, `GOG Games/<Игра>/` (название — имя папки).
/// Браузер, редактор или «неизвестный процесс» не совпадают ни с одним и в статус
/// не попадают.
///
/// Категория приложения (`LSApplicationCategoryType = …games`) как признак НЕ
/// используется: её ставят и лаунчерам — Steam, Epic, Modrinth App числятся
/// «играми», и у каждого с открытым лаунчером горело бы «Играет в Steam».
///
/// Наружу уходит только название и источник совпадения — не список процессов.
/// Все вызовы — с главного потока (обработчик моста и таймер главного run loop).
final class GameDetector {
    static let shared = GameDetector()

    struct Detection: Equatable {
        let name: String
        let id: String
        let source: String
    }

    /// Вызывается на главном потоке при смене результата; `nil` — игры нет.
    var onChange: ((Detection?) -> Void)?

    private static let pollInterval: TimeInterval = 10

    /// Папки внутри steamapps/common, которые не игры: рантаймы и инструменты.
    private static let notGameFolders: [String] = [
        "steamworks", "steamvr", "wallpaper engine", "steam linux runtime", "proton",
        "source sdk", "steam controller", "blender", "aseprite", "krita", "godot",
    ]

    /// Запись каталога. `path` — необязательная подстрока пути к exe: запись подходит,
    /// только если она в пути есть (для игр, у которых один и тот же процесс).
    struct CatalogEntry {
        let name: String
        let path: String?
    }

    private var timer: Timer?
    private var catalog: [String: [CatalogEntry]] = [:]
    private var current: Detection?

    private init() {}

    func configure(enabled: Bool, games: [[String: Any]]) {
        timer?.invalidate()
        timer = nil
        if !enabled {
            catalog = [:]
            publish(nil)
            return
        }
        var next: [String: [CatalogEntry]] = [:]
        for entry in games {
            guard let process = (entry["process"] as? String)?.lowercased(), !process.isEmpty,
                  let name = entry["name"] as? String, !name.isEmpty else { continue }
            let path = (entry["path"] as? String).map(Self.normalizePath).flatMap { $0.isEmpty ? nil : $0 }
            next[process, default: []].append(CatalogEntry(name: name, path: path))
        }
        catalog = next
        poll()
        let timer = Timer(timeInterval: Self.pollInterval, repeats: true) { [weak self] _ in
            self?.poll()
        }
        // Таймеру не нужна точность, и он не должен будить процессор ради себя.
        timer.tolerance = Self.pollInterval * 0.3
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    private func publish(_ next: Detection?) {
        guard next != current else { return }
        current = next
        onChange?(next)
    }

    private func poll() {
        let myPid = ProcessInfo.processInfo.processIdentifier
        var best: (detection: Detection, active: Bool, launched: Date)?
        for app in NSWorkspace.shared.runningApplications where !app.isTerminated && app.processIdentifier != myPid {
            guard let detection = detect(app) else { continue }
            let active = app.isActive
            let launched = app.launchDate ?? .distantPast
            if let existing = best {
                // Активная игра важнее фоновой, из двух фоновых — запущенная позже.
                if existing.active && !active { continue }
                if existing.active == active && existing.launched >= launched { continue }
            }
            best = (detection, active, launched)
        }
        publish(best?.detection)
    }

    private func detect(_ app: NSRunningApplication) -> Detection? {
        let executable = app.executableURL
        let bundleURL = app.bundleURL

        // 1. Каталог. Ключи сравниваются без расширения и в нижнем регистре.
        var keys: [String] = []
        if let file = executable?.deletingPathExtension().lastPathComponent { keys.append(file) }
        if let name = app.localizedName { keys.append(name) }
        if let bundle = bundleURL?.deletingPathExtension().lastPathComponent { keys.append(bundle) }
        if let id = app.bundleIdentifier { keys.append(id) }
        let executablePath = executable.map { Self.normalizePath($0.path) } ?? ""
        for key in keys {
            let lowered = key.lowercased()
            if let name = Self.catalogName(catalog[lowered], path: executablePath) {
                return Detection(name: name, id: "proc:\(lowered)", source: "process")
            }
        }

        // 2. Папка игры у лаунчера.
        for url in [executable, bundleURL].compactMap({ $0 }) {
            if let folder = Self.launcherGameFolder(in: url.path) {
                return Detection(name: folder, id: "launcher:\(folder.lowercased())", source: "steam")
            }
        }

        return nil
    }

    /// Нижний регистр, `/` как `\`: так одна подстрока работает для путей обеих систем.
    static func normalizePath(_ path: String) -> String {
        path.lowercased().replacingOccurrences(of: "/", with: "\\")
    }

    /// Какая из записей одного ключа подходит к пути. Сначала те, у которых есть
    /// ограничение по пути, потом без него: «osu!lazer» важнее общего «osu!».
    static func catalogName(_ entries: [CatalogEntry]?, path: String) -> String? {
        guard let entries else { return nil }
        for entry in entries {
            if let needle = entry.path, !path.isEmpty, path.contains(needle) { return entry.name }
        }
        return entries.first(where: { $0.path == nil })?.name
    }

    /// Имя папки игры, если путь лежит внутри каталога лаунчера.
    static func launcherGameFolder(in path: String) -> String? {
        let components = path.split(separator: "/").map(String.init)
        let markers: [(parent: String, grandparent: String?)] = [
            ("common", "steamapps"),
            ("Epic Games", nil),
            ("GOG Games", nil),
        ]
        for marker in markers {
            guard let index = components.firstIndex(where: { $0.caseInsensitiveCompare(marker.parent) == .orderedSame }) else { continue }
            if let grand = marker.grandparent {
                guard index > 0, components[index - 1].caseInsensitiveCompare(grand) == .orderedSame else { continue }
            }
            guard index + 1 < components.count - 1 else { continue }
            let folder = components[index + 1]
            let lowered = folder.lowercased()
            if notGameFolders.contains(where: { lowered.contains($0) }) { return nil }
            return folder
        }
        return nil
    }
}
