import Foundation
import CryptoKit

private func archive(_ entries: [(String, Data, UInt8)]) -> Data {
    var bytes = Data()
    for (path,data,kind) in entries {
        var header = [UInt8](repeating: 0, count: 512)
        func write(_ text: String, _ offset: Int) { for (i,c) in text.utf8.enumerated() { header[offset+i] = c } }
        write(path,0); write("0000700",100); write("0000000",108); write("0000000",116)
        write(String(format: "%011o", data.count),124); write("00000000000",136)
        for i in 148..<156 { header[i] = 32 }; header[156] = kind; write("ustar",257); write("00",263)
        write(String(format: "%06o", header.reduce(0) { $0 + Int($1) }),148); header[154] = 0; header[155] = 32
        bytes.append(contentsOf: header); bytes.append(data)
        bytes.append(Data(repeating: 0, count: (512 - data.count % 512) % 512))
    }
    bytes.append(Data(repeating: 0, count: 1024)); return bytes
}
private func fixture(_ bytes: Data, key: Curve25519.Signing.PrivateKey, version: String = "0.160.1", url: String = "https://one.example/executor-downloads/codex.tar") throws -> (ManagedCodexEnvelope,ManagedCodexRelease) {
    let release = ManagedCodexRelease(executor: "codex", version: version, platform: "macos", architecture: "arm64", url: url,
        sourceUrl: "https://github.com/openai/codex/releases/download/rust-v\(version)/codex-aarch64-apple-darwin.tar.gz",
        sha256: SHA256.hash(data: bytes).map({ String(format: "%02x", $0) }).joined(), size: bytes.count, entrypoint: "bin/codex", license: "Apache-2.0", licenseFiles: ["LICENSE", "NOTICE"])
    let raw: [String:Any] = ["kind":"one-managed-executors", "schemaVersion":1,"releasedAt":"2026-10-09T00:00:00.000Z", "releases":[try JSONSerialization.jsonObject(with: JSONEncoder().encode(release))]]
    let payload = try JSONSerialization.data(withJSONObject: raw)
    return (ManagedCodexEnvelope(payload: payload.base64EncodedString(), signature: try key.signature(for: payload).base64EncodedString()),release)
}
private func rejected(_ action: () throws -> Void) { do { try action(); fatalError("unsafe input accepted") } catch {} }
private final class DownloadProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let mode = request.url!.lastPathComponent
        let response = HTTPURLResponse(url:request.url!,statusCode:mode == "denied" ? 403 : 200,httpVersion:nil,headerFields:["Content-Length":mode == "size" ? "999" : "4"])!
        client?.urlProtocol(self,didReceive:response,cacheStoragePolicy:.notAllowed)
        client?.urlProtocol(self,didLoad:Data((mode == "short" ? "abc" : mode == "overflow" ? "abcde" : "abcd").utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
@main struct ManagedCodexTests {
    static func main() async throws {
        let key = Curve25519.Signing.PrivateKey(), publicKey = key.publicKey.rawRepresentation.base64EncodedString(), origin = URL(string:"https://one.example")!
        let license = Data("Apache License\nVersion 2.0".utf8), notice = Data("Official Codex notices".utf8)
        let entries: [(String,Data,UInt8)] = [("bin/codex",Data("executable".utf8),48),("LICENSE",license,48),("NOTICE",notice,48)]
        let bytes = archive(entries), (envelope,release) = try fixture(bytes,key:key)
        let verified = try managedCodexRelease(envelope,publicKey:publicKey,origin:origin,architecture:"arm64")
        assert(verified.version == "0.160.1")
        rejected { _ = try managedCodexRelease(envelope,publicKey:Curve25519.Signing.PrivateKey().publicKey.rawRepresentation.base64EncodedString(),origin:origin,architecture:"arm64") }
        rejected { _ = try managedCodexRelease(envelope,publicKey:publicKey,origin:origin,architecture:"x86_64") }
        let (foreign,_) = try fixture(bytes,key:key,url:"https://evil.example/executor-downloads/codex.tar")
        rejected { _ = try managedCodexRelease(foreign,publicKey:publicKey,origin:origin,architecture:"arm64") }
        for unsafe in [archive(entries + [("../escape",Data(),48)]),archive(entries + [("bin/link",Data(),50)]),archive(entries + [("bin/codex",Data(),48)]),archive(entries + [("bin/pax",Data(),120)])] {
            let (_,meta) = try fixture(unsafe,key:key)
            rejected { _ = try managedCodexFiles(unsafe,release:meta) }
        }
        rejected { _ = try managedCodexFiles(bytes.dropLast(),release:release) }
        let process = Process(), compressedPipe = Pipe(), inputPipe = Pipe()
        process.executableURL=URL(fileURLWithPath:"/usr/bin/gzip"); process.arguments=["-c"]
        process.standardInput=inputPipe; process.standardOutput=compressedPipe; try process.run()
        try inputPipe.fileHandleForWriting.write(contentsOf:bytes); try inputPipe.fileHandleForWriting.close()
        let compressed=compressedPipe.fileHandleForReading.readDataToEndOfFile(); process.waitUntilExit()
        let (_,compressedRelease) = try fixture(compressed,key:key,url:"https://one.example/executor-downloads/codex.tar.gz")
        let expandedFiles = try managedCodexFiles(compressed,release:compressedRelease)
        assert(expandedFiles["bin/codex"] == Data("executable".utf8))
        rejected { _ = try expandManagedArchive(compressed,maximumSize:32) }
        rejected { _ = try expandManagedArchive(Data("not-gzip".utf8)) }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("one-managed-tests-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at:root) }
        let installed = try commitManagedCodex(bytes:bytes,envelope:envelope,release:release,root:root) { _,_ in true }
        let contents = try Data(contentsOf:URL(fileURLWithPath:installed))
        assert(contents == Data("executable".utf8))
        let current = try installedManagedCodex(root:root,publicKey:publicKey,origin:origin,architecture:"arm64")
        assert(current?.version == "0.160.1")
        let nextBytes = archive(entries.dropLast().map{$0} + [("NOTICE",Data("new notice".utf8),48)])
        let (nextEnvelope,nextRelease) = try fixture(nextBytes,key:key,version:"0.160.2")
        rejected { _ = try commitManagedCodex(bytes:nextBytes,envelope:nextEnvelope,release:nextRelease,root:root) { _,_ in false } }
        let afterFailure = try installedManagedCodex(root:root,publicKey:publicKey,origin:origin,architecture:"arm64")
        assert(afterFailure?.path == installed)
        try Data("tampered".utf8).write(to:URL(fileURLWithPath:installed))
        rejected { _ = try installedManagedCodex(root:root,publicKey:publicKey,origin:origin,architecture:"arm64") }
        let activity = ManagedCodexActivity(); assert(activity.begin()); assert(!activity.begin()); activity.end(); assert(activity.begin()); activity.end()
        let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [DownloadProtocol.self]
        let downloaded = try await ManagedCodexDownload(expected:4,configuration:configuration).fetch(URL(string:"https://one.example/valid")!)
        assert(downloaded == Data("abcd".utf8))
        for mode in ["denied","size","short","overflow"] {
            do { _ = try await ManagedCodexDownload(expected:4,configuration:configuration).fetch(URL(string:"https://one.example/\(mode)")!); fatalError("bad download accepted") } catch {}
        }
        print("Managed Codex signature, scope, archive, rollback and health checks passed")
    }
}
