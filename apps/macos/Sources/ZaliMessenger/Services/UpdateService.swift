import AppKit
import CryptoKit
import Foundation

/// Downloads a new `.app` build, verifies it, and swaps it in for the running
/// app on relaunch. The app is ad-hoc signed only (see project notes on
/// `build_app.sh`), so `xattr -cr` after extraction is what today's launch
/// already relies on — this doesn't change the trust model, just repeats it
/// for the downloaded copy.
final class UpdateService: NSObject {
    static let shared = UpdateService()

    private let maxDownloadBytes = 300 * 1024 * 1024
    private var activeSession: URLSession?

    private static var updatesDir: URL? = {
        guard let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            return nil
        }
        let dir = base.appendingPathComponent("ZaliMessenger/updates", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }()

    // Plain (success, value, errorMessage) completion tuples — matching NetworkService's
    // convention elsewhere in this file — instead of Result<T, Error>: deeply nested
    // escaping closures over Result<> generics here previously produced a Swift-mangled
    // symbol name long enough to crash ld64 (`Assertion failed: name.size() <= maxLength`
    // in makeSymbolStringInPlace), confirmed by bisecting against a clean baseline build.
    func downloadUpdate(
        urlString: String,
        expectedSha256: String,
        progress: @escaping (Double) -> Void,
        completion: @escaping (Bool, URL?, String?) -> Void
    ) {
        guard let url = URL(string: urlString), url.scheme == "https" else {
            completion(false, nil, "Некорректный URL обновления")
            return
        }
        guard let dir = Self.updatesDir else {
            completion(false, nil, "Нет доступа к директории обновлений")
            return
        }
        let archivePath = dir.appendingPathComponent("update-\(UUID().uuidString).zip")
        FileManager.default.createFile(atPath: archivePath.path, contents: nil)
        guard let handle = try? FileHandle(forWritingTo: archivePath) else {
            completion(false, nil, "Не удалось создать файл для загрузки")
            return
        }

        let delegate = StreamingDownloadDelegate(fileHandle: handle, maxBytes: maxDownloadBytes, onProgress: progress)
        delegate.onComplete = { [weak self] ok, errorMessage in
            guard let self else { return }
            try? handle.close()
            self.activeSession = nil
            if ok {
                self.verify(archivePath: archivePath, expectedSha256: expectedSha256, completion: completion)
            } else {
                try? FileManager.default.removeItem(at: archivePath)
                completion(false, nil, errorMessage)
            }
        }
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 120
        let session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
        activeSession = session
        session.dataTask(with: url).resume()
    }

    private func verify(archivePath: URL, expectedSha256: String, completion: @escaping (Bool, URL?, String?) -> Void) {
        DispatchQueue.global(qos: .utility).async {
            guard let data = try? Data(contentsOf: archivePath, options: .mappedIfSafe) else {
                try? FileManager.default.removeItem(at: archivePath)
                DispatchQueue.main.async { completion(false, nil, "Не удалось прочитать загруженный файл") }
                return
            }
            let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
            guard digest.lowercased() == expectedSha256.lowercased() else {
                try? FileManager.default.removeItem(at: archivePath)
                DispatchQueue.main.async { completion(false, nil, "Контрольная сумма обновления не совпадает") }
                return
            }
            DispatchQueue.main.async { completion(true, archivePath, nil) }
        }
    }

    /// Unzips the downloaded archive, strips the quarantine flag (this app has no
    /// stable code-signing identity for Gatekeeper to trust anyway — see the
    /// no-Keychain note in CLAUDE.md), and writes+launches a relaunch helper
    /// script that waits for this process to exit, swaps the `.app` bundle in
    /// place, and reopens it. Call `NSApp.terminate` right after this returns.
    func installAndRelaunch(archivePath: URL, completion: @escaping (Bool, String?) -> Void) {
        guard let dir = Self.updatesDir else {
            completion(false, "Нет доступа к директории обновлений")
            return
        }
        let extractDir = dir.appendingPathComponent("extract-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: extractDir, withIntermediateDirectories: true)

        let unzip = Process()
        unzip.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
        unzip.arguments = ["-x", "-k", archivePath.path, extractDir.path]
        do {
            try unzip.run()
            unzip.waitUntilExit()
        } catch {
            completion(false, error.localizedDescription)
            return
        }
        guard unzip.terminationStatus == 0,
              let newAppPath = (try? FileManager.default.contentsOfDirectory(at: extractDir, includingPropertiesForKeys: nil))?
                .first(where: { $0.pathExtension == "app" }) else {
            completion(false, "Не удалось распаковать обновление")
            return
        }

        let xattr = Process()
        xattr.executableURL = URL(fileURLWithPath: "/usr/bin/xattr")
        xattr.arguments = ["-cr", newAppPath.path]
        try? xattr.run()
        xattr.waitUntilExit()

        let currentAppPath = Bundle.main.bundlePath
        let stagedAppPath = currentAppPath + ".update-staged"
        let scriptPath = dir.appendingPathComponent("relaunch-\(UUID().uuidString).sh")
        let script = """
        #!/bin/sh
        while kill -0 \(ProcessInfo.processInfo.processIdentifier) 2>/dev/null; do
            sleep 0.3
        done
        rm -rf "\(stagedAppPath)"
        if ditto "\(newAppPath.path)" "\(stagedAppPath)"; then
            rm -rf "\(currentAppPath)"
            mv "\(stagedAppPath)" "\(currentAppPath)"
            open "\(currentAppPath)"
        else
            rm -rf "\(stagedAppPath)"
        fi
        rm -rf "\(extractDir.path)"
        rm -f "\(archivePath.path)"
        rm -f "\(scriptPath.path)"
        """
        do {
            try script.write(to: scriptPath, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: scriptPath.path)
        } catch {
            completion(false, error.localizedDescription)
            return
        }

        let relaunch = Process()
        relaunch.executableURL = URL(fileURLWithPath: "/bin/sh")
        relaunch.arguments = [scriptPath.path]
        do {
            try relaunch.run()
            completion(true, nil)
        } catch {
            completion(false, error.localizedDescription)
        }
    }
}

/// Streams response bytes straight to a file handle instead of buffering the
/// whole body in memory (unlike NetworkService's SizeCappedDataTaskDelegate,
/// sized for small avatars/attachments) — an update archive can be tens to
/// hundreds of MB. Reports fractional progress via `onProgress`, throttled to
/// avoid flooding the JS bridge with a bus event per chunk. `onComplete` is a
/// plain `var` set after init (not passed via a nested init closure param) —
/// keeping the delegate's own init signature small was part of avoiding the
/// ld64 long-symbol-name crash this file's completion style works around.
private final class StreamingDownloadDelegate: NSObject, URLSessionDataDelegate {
    private let fileHandle: FileHandle
    private let maxBytes: Int
    private let onProgress: (Double) -> Void
    var onComplete: ((Bool, String?) -> Void)?
    private var expectedContentLength: Int64 = 0
    private var receivedBytes: Int64 = 0
    private var lastReportedProgress: Double = -1
    private var finished = false

    init(fileHandle: FileHandle, maxBytes: Int, onProgress: @escaping (Double) -> Void) {
        self.fileHandle = fileHandle
        self.maxBytes = maxBytes
        self.onProgress = onProgress
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        expectedContentLength = response.expectedContentLength
        if expectedContentLength > 0, expectedContentLength > Int64(maxBytes) {
            completionHandler(.cancel)
            finish(false, "Обновление превышает допустимый размер")
            return
        }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        receivedBytes += Int64(data.count)
        if receivedBytes > Int64(maxBytes) {
            dataTask.cancel()
            finish(false, "Обновление превышает допустимый размер")
            return
        }
        fileHandle.write(data)
        if expectedContentLength > 0 {
            let fraction = Double(receivedBytes) / Double(expectedContentLength)
            if fraction - lastReportedProgress >= 0.02 || fraction >= 1.0 {
                lastReportedProgress = fraction
                let clamped = min(max(fraction, 0), 1)
                DispatchQueue.main.async { self.onProgress(clamped) }
            }
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        finish(error == nil, error?.localizedDescription)
    }

    private func finish(_ ok: Bool, _ errorMessage: String?) {
        guard !finished else { return }
        finished = true
        DispatchQueue.main.async { self.onComplete?(ok, errorMessage) }
    }
}
