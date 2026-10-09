import Foundation
import CryptoKit
import Darwin

final class ManagedCodexActivity: @unchecked Sendable {
    private let lock = NSLock()
    private var active = false
    func begin() -> Bool { lock.lock(); defer { lock.unlock() }; if active { return false }; active = true; return true }
    func end() { lock.lock(); active = false; lock.unlock() }
    func isActive() -> Bool { lock.lock(); defer { lock.unlock() }; return active }
}

struct ManagedCodexRelease: Codable {
    let executor: String, version: String, platform: String, architecture: String
    let url: String, sourceUrl: String, sha256: String
    let size: Int
    let entrypoint: String, license: String
    let licenseFiles: [String]
}
struct ManagedCodexCatalog: Decodable {
    let kind: String, schemaVersion: Int, releasedAt: String
    let releases: [ManagedCodexRelease]
}
struct ManagedCodexEnvelope: Codable { let payload: String, signature: String }
enum ManagedCodexError: Error, LocalizedError {
    case invalid, incomplete, unsafe, unhealthy, busy
    var errorDescription: String? {
        switch self {
        case .invalid: return "执行工具签名、来源或版本不符，未安装"
        case .incomplete: return "下载未完成或校验不符，原执行工具保持不变"
        case .unsafe: return "执行工具包结构不安全，未安装"
        case .unhealthy: return "新执行工具未通过启动检查，原版本保持不变"
        case .busy: return "本机正在准备或执行，请完成后再试"
        }
    }
}
private func managedBase64(_ value: String) -> Data? {
    let normalized = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    return Data(base64Encoded: normalized + String(repeating: "=", count: (4 - normalized.count % 4) % 4))
}
private func managedSafePath(_ path: String) -> Bool {
    !path.isEmpty && path.utf8.count <= 240 && path.range(of: "^[a-zA-Z0-9_./-]+$", options: .regularExpression) != nil
        && !path.split(separator: "/", omittingEmptySubsequences: false).contains(where: { $0.isEmpty || $0 == "." || $0 == ".." })
}
private func managedVersion(_ value: String) -> Bool {
    value.count <= 40 && value.range(of: "^(0|[1-9][0-9]*)(\\.(0|[1-9][0-9]*)){1,3}$", options: .regularExpression) != nil
}
private func managedHTTPS(_ value: String) -> URL? {
    guard let url = URL(string: value), url.scheme == "https", url.host != nil,
          url.user == nil, url.password == nil, url.query == nil, url.fragment == nil else { return nil }
    return url
}
private func managedDate(_ value: String) -> Bool {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.date(from: value) != nil || ISO8601DateFormatter().date(from: value) != nil
}
func managedCodexRelease(_ envelope: ManagedCodexEnvelope, publicKey: String, origin: URL, architecture: String) throws -> ManagedCodexRelease {
    guard envelope.payload.count <= 180_000, let payload = managedBase64(envelope.payload),
          let signature = managedBase64(envelope.signature), signature.count == 64,
          let keyData = managedBase64(publicKey), keyData.count == 32,
          let key = try? Curve25519.Signing.PublicKey(rawRepresentation: keyData), key.isValidSignature(signature, for: payload),
          let catalog = try? JSONDecoder().decode(ManagedCodexCatalog.self, from: payload),
          catalog.kind == "one-managed-executors", catalog.schemaVersion == 1,
          managedDate(catalog.releasedAt),
          !catalog.releases.isEmpty, catalog.releases.count <= 24,
          let trusted = managedHTTPS(origin.absoluteString) else { throw ManagedCodexError.invalid }
    var identities = Set<String>()
    for release in catalog.releases {
        guard release.executor == "codex", managedVersion(release.version), release.license == "Apache-2.0",
              ["macos", "windows"].contains(release.platform),
              (release.platform == "macos" ? ["arm64", "x86_64"].contains(release.architecture) : release.architecture == "amd64"),
              let url = managedHTTPS(release.url), url.host == trusted.host, url.port == trusted.port,
              url.path.hasPrefix("/executor-downloads/"), url.path.hasSuffix(".tar") || url.path.hasSuffix(".tar.gz"),
              let source = managedHTTPS(release.sourceUrl), source.host == "github.com", source.port == nil,
              source.path.hasPrefix("/openai/codex/releases/download/"),
              release.sha256.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              release.size > 0, release.size <= 384 * 1024 * 1024,
              managedSafePath(release.entrypoint), !release.licenseFiles.isEmpty, release.licenseFiles.count <= 24,
              release.licenseFiles.allSatisfy(managedSafePath), Set(release.licenseFiles).count == release.licenseFiles.count,
              release.licenseFiles.contains(where: { $0 == "LICENSE" || $0.hasSuffix("/LICENSE") }),
              identities.insert("\(release.platform):\(release.architecture):\(release.version)").inserted
        else { throw ManagedCodexError.invalid }
    }
    guard let release = catalog.releases.filter({ $0.platform == "macos" && $0.architecture == architecture })
        .sorted(by: { $0.version.compare($1.version, options: .numeric) == .orderedDescending }).first else { throw ManagedCodexError.invalid }
    return release
}

// Bound both declared and received bytes. No redirects, authentication, cookies
// or scripts; only the signed same-origin public artifact is fetched.
final class ManagedCodexDownload: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private var bytes = Data()
    private let expected: Int
    private let configuration: URLSessionConfiguration
    private var continuation: CheckedContinuation<Data, Error>?
    init(expected: Int, configuration: URLSessionConfiguration = .ephemeral) { self.expected = expected; self.configuration = configuration }
    func fetch(_ url: URL) async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            let config = self.configuration
            config.httpCookieStorage = nil; config.urlCredentialStorage = nil
            config.timeoutIntervalForRequest = 60; config.timeoutIntervalForResource = 480
            let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
            session.dataTask(with: url).resume()
        }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard (response as? HTTPURLResponse)?.statusCode == 200,
              response.expectedContentLength == -1 || response.expectedContentLength == Int64(expected) else { completionHandler(.cancel); return }
        completionHandler(.allow)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard bytes.count + data.count <= expected else { dataTask.cancel(); return }
        bytes.append(data)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let result = continuation; continuation = nil
        if error != nil || bytes.count != expected { result?.resume(throwing: ManagedCodexError.incomplete) }
        else { result?.resume(returning: bytes) }
        session.finishTasksAndInvalidate()
    }
}

// Deliberately narrow USTAR reader: no scripts, compression bombs, symlinks,
// hardlinks, PAX overrides, devices or extraction through an external shell.
func expandManagedArchive(_ bytes: Data, maximumSize: Int = 384 * 1024 * 1024) throws -> Data {
    let temp = FileManager.default.temporaryDirectory.appendingPathComponent("one-codex-archive-\(UUID().uuidString)")
    try bytes.write(to:temp,options:.withoutOverwriting)
    try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:temp.path)
    defer { try? FileManager.default.removeItem(at:temp) }
    let input = try FileHandle(forReadingFrom:temp); defer { try? input.close() }
    let process = Process(), output = Pipe()
    process.executableURL = URL(fileURLWithPath:"/usr/bin/gzip"); process.arguments = ["-dc"]
    process.standardInput=input; process.standardOutput=output; process.standardError=FileHandle.nullDevice
    try process.run()
    let timeout = DispatchWorkItem { if process.isRunning { process.terminate() } }
    DispatchQueue.global().asyncAfter(deadline:.now()+60,execute:timeout)
    defer { timeout.cancel(); if process.isRunning { kill(process.processIdentifier,SIGKILL) }; process.waitUntilExit(); try? output.fileHandleForReading.close() }
    var expanded=Data()
    while let chunk = try output.fileHandleForReading.read(upToCount:65536), !chunk.isEmpty {
        guard expanded.count + chunk.count <= maximumSize else { throw ManagedCodexError.unsafe }
        expanded.append(chunk)
    }
    process.waitUntilExit()
    guard process.terminationStatus == 0 else { throw ManagedCodexError.incomplete }
    return expanded
}
func managedCodexFiles(_ archive: Data, release: ManagedCodexRelease) throws -> [String: Data] {
    let bytes: Data
    guard archive.count == release.size, SHA256.hash(data: archive).map({ String(format: "%02x", $0) }).joined() == release.sha256 else { throw ManagedCodexError.incomplete }
    bytes = release.url.hasSuffix(".tar.gz") ? try expandManagedArchive(archive) : archive
    var result = [String: Data](), offset = 0, total = 0, terminated = false
    while offset + 512 <= bytes.count {
        let header = Array(bytes[offset..<offset+512])
        if header.allSatisfy({ $0 == 0 }) {
            guard bytes.count - offset >= 1024, bytes[offset...].allSatisfy({ $0 == 0 }) else { throw ManagedCodexError.unsafe }
            terminated = true; break
        }
        func field(_ start: Int, _ length: Int) -> String? {
            let raw = header[start..<start+length].prefix(while: { $0 != 0 })
            return String(bytes: raw, encoding: .utf8)
        }
        guard let name = field(0,100), let prefix = field(345,155),
              let sizeText = field(124,12), let size = Int(sizeText.trimmingCharacters(in: .whitespaces), radix: 8),
              let checksumText = field(148,8), let checksum = Int(checksumText.trimmingCharacters(in: .whitespaces), radix: 8),
              field(257,6) == "ustar", header[156] == 48 || header[156] == 0,
              checksum == header.enumerated().reduce(0, { $0 + ((148..<156).contains($1.offset) ? 32 : Int($1.element)) }),
              size >= 0, size <= 320 * 1024 * 1024, offset + 512 + size <= bytes.count else { throw ManagedCodexError.unsafe }
        let path = prefix.isEmpty ? name : prefix + "/" + name
        guard managedSafePath(path), result[path] == nil, result.count < 40 else { throw ManagedCodexError.unsafe }
        total += size
        guard total <= 384 * 1024 * 1024 else { throw ManagedCodexError.unsafe }
        result[path] = bytes.subdata(in: offset+512..<offset+512+size)
        offset += 512 + ((size + 511) / 512) * 512
    }
    guard terminated, let executable = result[release.entrypoint], !executable.isEmpty,
          release.licenseFiles.allSatisfy({ !(result[$0]?.isEmpty ?? true) }),
          let license = result.first(where: { $0.key == "LICENSE" || $0.key.hasSuffix("/LICENSE") })?.value,
          let text = String(data: license, encoding: .utf8), text.contains("Apache License"), text.contains("Version 2.0") else { throw ManagedCodexError.unsafe }
    return result
}

struct ManagedCodexPointer: Codable {
    let envelope: ManagedCodexEnvelope
    let architecture: String
    let hashes: [String: String]
}
// A health-checked immutable directory is committed before the pointer. A crash
// before pointer commit leaves the previous version active. Old versions remain.
func commitManagedCodex(bytes: Data, envelope: ManagedCodexEnvelope, release: ManagedCodexRelease, root: URL,
                        health: (String, String) -> Bool) throws -> String {
    let files = try managedCodexFiles(bytes, release: release), fm = FileManager.default
    try fm.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let staging = root.appendingPathComponent(".prepare-\(UUID().uuidString)")
    try fm.createDirectory(at: staging, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    defer { try? fm.removeItem(at: staging) }
    for (path,data) in files {
        let file = staging.appendingPathComponent(path)
        try fm.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try data.write(to: file, options: .withoutOverwriting)
        let executable = path == release.entrypoint || path == "bin/codex-code-mode-host" || path == "codex-path/rg"
        try fm.setAttributes([.posixPermissions: executable ? 0o700 : 0o600], ofItemAtPath: file.path)
    }
    guard health(staging.appendingPathComponent(release.entrypoint).path, release.version) else { throw ManagedCodexError.unhealthy }
    let target = root.appendingPathComponent("codex-\(release.architecture)-\(release.version)-\(release.sha256.prefix(16))")
    // A pre-existing immutable version is only reused after verifying all files.
    if fm.fileExists(atPath: target.path) {
        for (path,data) in files {
            let file = target.appendingPathComponent(path)
            guard try file.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey]).isRegularFile == true,
                  file.resolvingSymlinksInPath().path == file.path,
                  try Data(contentsOf: file) == data else { throw ManagedCodexError.unsafe }
        }
    } else { try fm.moveItem(at: staging, to: target) }
    let hashes = files.mapValues { SHA256.hash(data: $0).map({ String(format: "%02x", $0) }).joined() }
    try JSONEncoder().encode(ManagedCodexPointer(envelope: envelope, architecture: release.architecture, hashes: hashes))
        .write(to: root.appendingPathComponent("active.json"), options: .atomic)
    return target.appendingPathComponent(release.entrypoint).path
}
func installedManagedCodex(root: URL, publicKey: String, origin: URL, architecture: String) throws -> (path: String, version: String)? {
    let pointerURL = root.appendingPathComponent("active.json")
    guard FileManager.default.fileExists(atPath: pointerURL.path) else { return nil }
    guard (try pointerURL.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0) <= 200_000 else { throw ManagedCodexError.unsafe }
    let pointer = try JSONDecoder().decode(ManagedCodexPointer.self, from: Data(contentsOf: pointerURL))
    let release = try managedCodexRelease(pointer.envelope, publicKey: publicKey, origin: origin, architecture: architecture)
    guard pointer.architecture == architecture, pointer.hashes[release.entrypoint] != nil else { throw ManagedCodexError.invalid }
    let target = root.appendingPathComponent("codex-\(release.architecture)-\(release.version)-\(release.sha256.prefix(16))")
    for (path,hash) in pointer.hashes {
        guard managedSafePath(path) else { throw ManagedCodexError.unsafe }
        let file = target.appendingPathComponent(path)
        guard file.resolvingSymlinksInPath().path == file.path,
              try file.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true,
              SHA256.hash(data: try Data(contentsOf: file)).map({ String(format: "%02x", $0) }).joined() == hash else { throw ManagedCodexError.unsafe }
    }
    return (target.appendingPathComponent(release.entrypoint).path, release.version)
}
