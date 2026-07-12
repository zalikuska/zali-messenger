import Foundation
import CryptoKit
import CommonCrypto

class ZaliArc {
    private let magic = "ZALI".data(using: .utf8)!
    private let currentVersion: UInt8 = 1
    private let bufferSize = 1024 * 1024

    private func readExact(_ handle: FileHandle, count: Int) throws -> Data {
        guard let data = try handle.read(upToCount: count), data.count == count else {
            throw NSError(domain: "ZaliArc", code: 999, userInfo: [NSLocalizedDescriptionKey: "EOF"])
        }
        return data
    }

    private func writeLE32(_ handle: FileHandle, _ value: UInt32) {
        var v = value.littleEndian; handle.write(Data(bytes: &v, count: 4))
    }
    private func writeLE64(_ handle: FileHandle, _ value: UInt64) {
        var v = value.littleEndian; handle.write(Data(bytes: &v, count: 8))
    }
    private func readLE16(_ handle: FileHandle) throws -> UInt16 {
        let d = try readExact(handle, count: 2); return d.withUnsafeBytes { $0.load(as: UInt16.self).littleEndian }
    }
    private func readLE32(_ handle: FileHandle) throws -> UInt32 {
        let d = try readExact(handle, count: 4); return d.withUnsafeBytes { $0.load(as: UInt32.self).littleEndian }
    }
    private func readLE64(_ handle: FileHandle) throws -> UInt64 {
        let d = try readExact(handle, count: 8); return d.withUnsafeBytes { $0.load(as: UInt64.self).littleEndian }
    }

    private func addNonceCounter(_ base: Data, counter: UInt32) throws -> AES.GCM.Nonce {
        var n = base
        try n.withUnsafeMutableBytes { ptr in
            let b = ptr.baseAddress!.assumingMemoryBound(to: UInt8.self)
            let val = UInt32(b[8]) | (UInt32(b[9]) << 8) | (UInt32(b[10]) << 16) | (UInt32(b[11]) << 24)
            let (next, overflow) = val.addingReportingOverflow(counter)
            if overflow { throw NSError(domain: "ZaliArc", code: 666, userInfo: nil) }
            b[8] = UInt8(next & 0xFF); b[9] = UInt8((next >> 8) & 0xFF); b[10] = UInt8((next >> 16) & 0xFF); b[11] = UInt8((next >> 24) & 0xFF)
        }
        return try AES.GCM.Nonce(data: n)
    }

    private func isPathSafe(outputDir: String, relPath: String) -> Bool {
        let baseURL = URL(fileURLWithPath: outputDir).standardized
        let fullURL = baseURL.appendingPathComponent(relPath).standardized
        return fullURL.path.hasPrefix(baseURL.path)
    }

    func pack(files: [(path: String, arcPath: String)], outputPath: String, zaliId: String, domain: String, password: String?) throws {
        let outURL = URL(fileURLWithPath: outputPath)
        FileManager.default.createFile(atPath: outputPath, contents: nil)
        let handle = try FileHandle(forWritingTo: outURL)
        defer { try? handle.close() }

        handle.write(magic); handle.write(Data([currentVersion]))
        for s in [zaliId, domain] {
            let d = s.data(using: .utf8)!.prefix(255)
            handle.write(Data([UInt8(d.count)])); handle.write(d)
        }
        
        let isEnc = password != nil
        handle.write(Data([isEnc ? 1 : 0]))
        
        let validFiles = files.filter { FileManager.default.fileExists(atPath: $0.path) }
        writeLE32(handle, UInt32(validFiles.count))

        var masterKey: SymmetricKey?, baseNonce: Data?
        if let pwd = password {
            var salt = Data(count: 16); _ = salt.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!) }
            handle.write(salt)
            baseNonce = Data(AES.GCM.Nonce()); handle.write(baseNonce!)
            masterKey = deriveKeyPBKDF2(password: pwd, salt: salt)
        }

        var globalChunkIdx: UInt32 = 1
        for f in validFiles {
            let attr = try FileManager.default.attributesOfItem(atPath: f.path)
            let fileSize = attr[.size] as! UInt64
            let arcPathD = f.arcPath.data(using: .utf8)!
            let pLen = UInt16(min(65535, arcPathD.count))
            var pLenLE = pLen.littleEndian; handle.write(Data(bytes: &pLenLE, count: 2))
            handle.write(arcPathD.prefix(Int(pLen)))
            writeLE64(handle, fileSize)
            
            let numChunks = UInt64(ceil(Double(fileSize) / Double(bufferSize)))
            writeLE64(handle, isEnc ? (fileSize + numChunks * 16) : fileSize)

            let source = try FileHandle(forReadingFrom: URL(fileURLWithPath: f.path))
            defer { try? source.close() }
            var rem = fileSize
            while rem > 0 {
                let n = Int(min(UInt64(bufferSize), rem))
                guard let chunk = try source.read(upToCount: n) else { break }
                if isEnc, let key = masterKey, let bNonce = baseNonce {
                    let nonce = try addNonceCounter(bNonce, counter: globalChunkIdx); globalChunkIdx += 1
                    let sealed = try AES.GCM.seal(chunk, using: key, nonce: nonce)
                    handle.write(sealed.ciphertext); handle.write(sealed.tag)
                } else {
                    handle.write(chunk)
                }
                rem -= UInt64(chunk.count)
            }
        }
    }

    func unpack(archivePath: String, outputDir: String, password: String?, expectedId: String = "ZALI") throws {
        let handle = try FileHandle(forReadingFrom: URL(fileURLWithPath: archivePath))
        defer { try? handle.close() }

        guard try readExact(handle, count: 4) == magic else { throw NSError(domain: "Z", code: 1, userInfo: nil) }
        guard try readExact(handle, count: 1)[0] == currentVersion else { throw NSError(domain: "Z", code: 2, userInfo: nil) }
        let idLen = try readExact(handle, count: 1)[0]
        guard String(data: try readExact(handle, count: Int(idLen)), encoding: .utf8) == expectedId else { throw NSError(domain: "Z", code: 3, userInfo: nil) }
        let domLen = try readExact(handle, count: 1)[0]; _ = try readExact(handle, count: Int(domLen))
        
        let flags = try readExact(handle, count: 1)[0]
        let isEnc = (flags & 1) != 0
        let count = try readLE32(handle)

        var masterKey: SymmetricKey?, baseNonce: Data?
        if isEnc {
            guard let pwd = password else { throw NSError(domain: "Z", code: 4, userInfo: nil) }
            let salt = try readExact(handle, count: 16); baseNonce = try readExact(handle, count: 12)
            masterKey = deriveKeyPBKDF2(password: pwd, salt: salt)
        }

        var globalChunkIdx: UInt32 = 1
        for _ in 0..<count {
            let pL = try readLE16(handle)
            let relP = String(data: try readExact(handle, count: Int(pL)), encoding: .utf8) ?? "file"
            let oSize = try readLE64(handle); let eSize = try readLE64(handle)

            guard isPathSafe(outputDir: outputDir, relPath: relP) else { throw NSError(domain: "Z", code: 5, userInfo: nil) }
            let fullURL = URL(fileURLWithPath: outputDir).appendingPathComponent(relP)
            try FileManager.default.createDirectory(at: fullURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            let tmpURL = fullURL.appendingPathExtension("tmp")
            FileManager.default.createFile(atPath: tmpURL.path, contents: nil)
            let outH = try FileHandle(forWritingTo: tmpURL)

            do {
                var rem = eSize
                while rem > 0 {
                    if isEnc, let key = masterKey, let bNonce = baseNonce {
                        if rem < 16 { throw NSError(domain: "Z", code: 6, userInfo: nil) }
                        let cSize = Int(min(UInt64(bufferSize), rem - 16))
                        let cipher = try readExact(handle, count: cSize); let tag = try readExact(handle, count: 16)
                        let nonce = try addNonceCounter(bNonce, counter: globalChunkIdx); globalChunkIdx += 1
                        let sealed = try AES.GCM.SealedBox(nonce: nonce, ciphertext: cipher, tag: tag)
                        outH.write(try AES.GCM.open(sealed, using: key))
                        rem -= UInt64(cSize + 16)
                    } else {
                        let n = Int(min(UInt64(bufferSize), rem))
                        outH.write(try readExact(handle, count: n)); rem -= UInt64(n)
                    }
                }
                try outH.close()
                let attr = try FileManager.default.attributesOfItem(atPath: tmpURL.path)
                if (attr[.size] as! UInt64) != oSize { throw NSError(domain: "Z", code: 7, userInfo: nil) }
                if FileManager.default.fileExists(atPath: fullURL.path) { try FileManager.default.removeItem(at: fullURL) }
                try FileManager.default.moveItem(at: tmpURL, to: fullURL)
            } catch { try? outH.close(); try? FileManager.default.removeItem(at: tmpURL); throw error }
        }
    }

    private func deriveKeyPBKDF2(password: String, salt: Data) -> SymmetricKey {
        var key = [UInt8](repeating: 0, count: 32)
        _ = salt.withUnsafeBytes { sPtr in
            CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2), password, password.count, sPtr.baseAddress!.assumingMemoryBound(to: UInt8.self), salt.count, CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256), 100_000, &key, 32)
        }
        return SymmetricKey(data: key)
    }
}
