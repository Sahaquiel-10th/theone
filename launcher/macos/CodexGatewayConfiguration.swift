import Foundation
import Darwin

private func codexTOMLString(_ value: String) -> String {
    "\"" + value.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
        .replacingOccurrences(of: "\n", with: "\\n").replacingOccurrences(of: "\r", with: "\\r").replacingOccurrences(of: "\t", with: "\\t") + "\""
}

/// The legacy workspace-write policy limits writes, but permits broad reads.
/// New bridge runs use a fresh named policy so project config cannot merge an
/// extra root into a predictable profile name. It never grants the task home
/// (which contains the provider token) or the user's home directory.
struct CodexWorkspacePermissions {
    let name: String
    let setting: String
    let runtimeReadPaths: [String]
    private let projectTrustSetting: String

    init(workspace: String, scratch: String, documentTool: String?, environment: [String: String]) throws {
        func canonicalDirectory(_ path: String) throws -> String {
            var directory: ObjCBool = false
            guard path.hasPrefix("/"), !path.contains("\0"),
                  FileManager.default.fileExists(atPath: path, isDirectory: &directory), directory.boolValue,
                  URL(fileURLWithPath: path).resolvingSymlinksInPath().path == URL(fileURLWithPath: path).standardizedFileURL.path else {
                throw NSError(domain: "ONE", code: 1, userInfo: [NSLocalizedDescriptionKey: "本轮工作目录权限无法确认，尚未开始操作"])
            }
            return URL(fileURLWithPath: path).standardizedFileURL.path
        }
        let workspace = try canonicalDirectory(workspace)
        let scratch = try canonicalDirectory(scratch)
        guard URL(fileURLWithPath: scratch).lastPathComponent.hasPrefix("scratch-"),
              environment["TMPDIR"].map({ URL(fileURLWithPath: $0).resolvingSymlinksInPath().path == scratch }) == true else { throw NSError(domain: "ONE", code: 1) }
        name = "one-workspace-" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        var projectRoots: [String] = []
        var projectRoot = URL(fileURLWithPath: workspace, isDirectory: true)
        while true {
            projectRoots.append("\(codexTOMLString(projectRoot.path))={trust_level=\"untrusted\"}")
            let parent = projectRoot.deletingLastPathComponent()
            if parent.path == projectRoot.path { break }
            projectRoot = parent
        }
        projectTrustSetting = "projects={\(projectRoots.joined(separator: ","))}"
        var readable = Set(Self.runtimePaths(environment: environment))
        if let documentTool {
            guard documentTool.hasPrefix("/"), !documentTool.contains("\0"), FileManager.default.isExecutableFile(atPath: documentTool) else {
                throw NSError(domain: "ONE", code: 1, userInfo: [NSLocalizedDescriptionKey: "本机文档工具暂时不可用，尚未开始操作"])
            }
            readable.insert(URL(fileURLWithPath: documentTool).resolvingSymlinksInPath().path)
            readable.insert(URL(fileURLWithPath: documentTool).standardizedFileURL.path)
        }
        runtimeReadPaths = readable.sorted()
        // TMPDIR has just been bound to this exact private scratch. Denying
        // :tmpdir would deny the same path even if its literal rule says write.
        var rules = ["\":root\"=\"deny\"", "\":minimal\"=\"read\"", "\":tmpdir\"=\"write\"", "\":slash_tmp\"=\"deny\"",
                     "\":workspace_roots\"={\".\"=\"write\"}"]
        rules += runtimeReadPaths.map { "\(codexTOMLString($0))=\"read\"" }
        rules.append("\(codexTOMLString(scratch))=\"write\"")
        setting = "permissions.\(name)={extends=\":workspace\",filesystem={\(rules.joined(separator: ","))},network={enabled=false}}"
    }

    var arguments: [String] { ["-c", "default_permissions=\(codexTOMLString(name))", "-c", setting,
                                "-c", "features.multi_agent=false", "-c", "features.goals=false",
                                "-c", projectTrustSetting, "-c", "features.plugins=false", "-c", "features.plugin_hooks=false",
                                "-c", "features.codex_hooks=false", "-c", "features.hooks=false", "-c", "features.apps=false",
                                "-c", "shell_environment_policy.inherit=\"core\"", "-c", "shell_environment_policy.ignore_default_excludes=false",
                                // Codex applies `set` after excludes. This final
                                // allowlist runs after `set`, so a project cannot
                                // merge a TOKEN back into the command environment.
                                "-c", "shell_environment_policy.include_only=[\"PATH\",\"SHELL\",\"TMPDIR\",\"TEMP\",\"TMP\",\"TMPPREFIX\",\"HOME\",\"LANG\",\"LC_ALL\",\"LC_CTYPE\",\"LOGNAME\",\"USER\",\"ONE_DOCUMENT_TOOL\",\"ONE_DOCUMENT_ROOT\"]"] }

    // :minimal already includes the operating-system runtime. Homebrew and
    // framework Python runtimes need their own package and dynamic libraries;
    // resolve only installed executable/dependency paths, never a whole package
    // manager, Applications, Library, Documents, or home directory.
    private static func runtimePaths(environment: [String: String]) -> [String] {
        let prefixes = ["/opt/homebrew/Cellar/", "/usr/local/Cellar/", "/Library/Frameworks/Python.framework/Versions/"]
        func package(_ path: String) -> String? {
            let resolved = URL(fileURLWithPath: path).resolvingSymlinksInPath().path
            for prefix in prefixes where resolved.hasPrefix(prefix) {
                let parts = resolved.dropFirst(prefix.count).split(separator: "/")
                let count = prefix.contains("Python.framework") ? 1 : 2
                if parts.count >= count { return prefix + parts.prefix(count).joined(separator: "/") }
            }
            return nil
        }
        let directories = (environment["PATH"] ?? "").split(separator: ":").map(String.init)
            + ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]
        var paths = Set<String>(), packages = Set<String>(), inspect = Set<String>()
        for binary in ["node", "python3"] {
            guard let candidate = directories.map({ $0 + "/" + binary }).first(where: { $0.hasPrefix("/") && FileManager.default.isExecutableFile(atPath: $0) }),
                  let root = package(candidate) else { continue }
            paths.insert(candidate); paths.insert(root); packages.insert(root)
        }
        // otool only inspects trusted runtime images; it never invokes them.
        // A bounded or failed dependency scan leaves unavailable tools denied.
        for _ in 0..<4 {
            var images: [String] = []
            for root in packages where !inspect.contains(root) {
                inspect.insert(root)
                for subdirectory in ["bin", "lib"] {
                    let folder = URL(fileURLWithPath: root).appendingPathComponent(subdirectory)
                    let entries = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? []
                    images += entries.filter { subdirectory == "bin" ? ["node", "python3"].contains($0.lastPathComponent) : $0.pathExtension == "dylib" }.prefix(40).map(\.path)
                }
            }
            guard !images.isEmpty, images.count <= 128, let output = inspectLibraries(images) else { break }
            for line in output.split(separator: "\n") {
                let dependency = line.trimmingCharacters(in: .whitespaces).components(separatedBy: " (compatibility version")[0]
                if dependency.hasPrefix("/"), let root = package(dependency), packages.count < 128 {
                    packages.insert(root); paths.insert(root)
                }
            }
        }
        for prefix in ["/opt/homebrew", "/usr/local"] where packages.contains(where: { $0.hasPrefix(prefix + "/Cellar/") }) {
            // Seatbelt needs to traverse the alias directories as well as read
            // each canonical package target. These do not grant unrelated
            // Cellar targets through their symlinks (covered by a real probe).
            paths.insert(prefix + "/bin"); paths.insert(prefix + "/opt")
            if packages.contains(where: { $0.hasPrefix(prefix + "/Cellar/openssl@") }) {
                let config = prefix + "/etc/openssl@3/openssl.cnf"
                if FileManager.default.fileExists(atPath: config) { paths.insert(config) }
            }
        }
        return paths.sorted()
    }

    private static func inspectLibraries(_ paths: [String]) -> String? {
        let process = Process(), output = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/otool")
        process.arguments = ["-L"] + paths
        process.environment = ["PATH": "/usr/bin:/bin", "LC_ALL": "C"]
        process.standardOutput = output; process.standardError = FileHandle.nullDevice; process.standardInput = FileHandle.nullDevice
        do { try process.run() } catch { return nil }
        try? output.fileHandleForWriting.close()
        let deadline = ProcessInfo.processInfo.systemUptime + 2
        while process.isRunning && ProcessInfo.processInfo.systemUptime < deadline { Thread.sleep(forTimeInterval: 0.01) }
        if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        process.waitUntilExit()
        let data = output.fileHandleForReading.readDataToEndOfFile()
        guard process.terminationStatus == 0, data.count <= 512 * 1024 else { return nil }
        return String(data: data, encoding: .utf8)
    }
}

func createCodexScratch(home: URL) throws -> URL {
    guard let resolved = realpath(home.path, nil) else { throw NSError(domain: "ONE", code: 1) }
    let parent = URL(fileURLWithPath: String(cString: resolved), isDirectory: true)
    free(resolved)
    var info = stat()
    guard lstat(parent.path, &info) == 0, info.st_mode & S_IFMT == S_IFDIR, info.st_uid == getuid() else {
        throw NSError(domain: "ONE", code: 1, userInfo: [NSLocalizedDescriptionKey: "无法准备本轮私有临时目录"])
    }
    let scratch = parent.appendingPathComponent("scratch-\(UUID().uuidString)", isDirectory: true)
    guard mkdir(scratch.path, 0o700) == 0 else { throw NSError(domain: "ONE", code: 1) }
    return scratch
}

struct CodexGatewayConfiguration: Decodable {
    let baseUrl: String
    let token: String
    let model: String

    func launchOverrides(home: URL, environment: [String: String]) throws -> (arguments: [String], environment: [String: String]) {
        guard let url = URLComponents(string: baseUrl), url.scheme == "https", url.host != nil,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.path.hasSuffix("/api/executor-gateway/v1"), model == "one-executor",
              token.count == 43, token.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-") }) else {
            throw NSError(domain: "ONE", code: 1, userInfo: [NSLocalizedDescriptionKey: "ONE 执行授权无效，本机尚未开始操作"])
        }
        func quoted(_ value: String) -> String { codexTOMLString(value) }
        var isolated = environment
        for key in ["OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_API_KEY", "CODEX_SQLITE_HOME"] { isolated.removeValue(forKey: key) }
        isolated["CODEX_HOME"] = home.path
        isolated["ONE_EXECUTOR_TOKEN"] = token
        var settings = [
            "model=\(quoted(model))", "model_provider=\"one\"", "web_search=\"disabled\"",
            "model_providers.one.name=\"ONE\"", "model_providers.one.base_url=\(quoted(baseUrl))",
            "model_providers.one.wire_api=\"responses\"", "model_providers.one.env_key=\"ONE_EXECUTOR_TOKEN\"",
            "model_providers.one.requires_openai_auth=false", "model_providers.one.request_max_retries=0",
            "model_providers.one.stream_max_retries=0"
        ]
        let shellKeys = ["TMPDIR", "TMPPREFIX", "ONE_DOCUMENT_TOOL", "ONE_DOCUMENT_ROOT"]
        let shellValues = shellKeys.compactMap { key in isolated[key].map { "\(key)=\(quoted($0))" } }
        if !shellValues.isEmpty { settings.append("shell_environment_policy.set={\(shellValues.joined(separator: ","))}") }
        return (settings.flatMap { ["-c", $0] }, isolated)
    }
}
