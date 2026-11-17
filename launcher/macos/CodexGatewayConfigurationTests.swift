import Foundation
import Darwin

@main struct CodexGatewayConfigurationTests {
    static func main() throws {
        let config = CodexGatewayConfiguration(baseUrl: "https://one.example/api/executor-gateway/v1", token: String(repeating: "a", count: 43), model: "one-executor")
        let result = try config.launchOverrides(home: URL(fileURLWithPath: "/tmp/one-isolated"), environment: ["OPENAI_API_KEY": "personal", "OPENAI_BASE_URL": "personal-url", "CODEX_HOME": "/personal", "PATH": "/bin"])
        precondition(result.environment["OPENAI_API_KEY"] == nil && result.environment["OPENAI_BASE_URL"] == nil)
        precondition(result.environment["CODEX_HOME"] == "/tmp/one-isolated" && result.environment["ONE_EXECUTOR_TOKEN"] == config.token)
        precondition(!result.arguments.joined(separator: " ").contains(config.token))
        precondition(result.arguments.contains("model_providers.one.requires_openai_auth=false"))
        let runtimeEnv = try config.launchOverrides(home: URL(fileURLWithPath: "/tmp/one-isolated"), environment: ["TMPDIR": "/private/one/scratch-1", "TMPPREFIX": "/private/one/scratch-1/zsh", "ONE_DOCUMENT_TOOL": "/Applications/ONE.app/Contents/MacOS/ONE", "ONE_DOCUMENT_ROOT": "/Users/test/work"])
        precondition(runtimeEnv.arguments.contains { $0.hasPrefix("shell_environment_policy.set=") && $0.contains("TMPPREFIX=") && $0.contains("ONE_DOCUMENT_TOOL=") })
        precondition(!runtimeEnv.arguments.joined(separator: " ").contains(config.token))
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("one-scratch-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: false)
        let scratchA = try createCodexScratch(home: home), scratchB = try createCodexScratch(home: home)
        precondition(scratchA != scratchB && scratchA.deletingLastPathComponent().lastPathComponent == home.lastPathComponent)
        let permissions = try FileManager.default.attributesOfItem(atPath: scratchA.path)[.posixPermissions] as! NSNumber
        precondition(permissions.intValue & 0o777 == 0o700)
        // Real zsh here-document regression, not a model/prompt simulation.
        let work = home.appendingPathComponent("work")
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: false)
        let document = String(repeating: "长文本临时文件验证🙂\n", count: 5000)
        func canonical(_ url: URL) -> String {
            let value = realpath(url.path, nil)!; defer { free(value) }
            return String(cString: value)
        }
        func hereDocument(allowScratch: Bool) throws -> Int32 {
            let process = Process()
            let allowedPath = canonical(allowScratch ? home : work)
            let policy = "(version 1)(allow default)(deny network*)(deny file-write* (require-not (subpath \"\(allowedPath)\")))"
            process.executableURL = URL(fileURLWithPath: "/usr/bin/sandbox-exec")
            process.arguments = ["-p", policy, "/bin/zsh", "-f", "-c", "cat > \"$ONE_TEST_ROOT/long.md\" <<'ONE_QA_BODY'\n\(document)ONE_QA_BODY\n"]
            var environment = ProcessInfo.processInfo.environment
            environment["TMPDIR"] = scratchA.path; environment["ONE_TEST_ROOT"] = canonical(work)
            environment["TMPPREFIX"] = scratchA.appendingPathComponent("zsh").path
            process.environment = environment
            let errors = Pipe()
            process.standardOutput = FileHandle.nullDevice; process.standardError = errors
            try process.run(); process.waitUntilExit()
            let detail = errors.fileHandleForReading.readDataToEndOfFile()
            if allowScratch && process.terminationStatus != 0 { FileHandle.standardError.write(detail) }
            return process.terminationStatus
        }
        let denied = try hereDocument(allowScratch: false)
        precondition(denied != 0, "old root-only boundary should reproduce here-document failure")
        let allowed = try hereDocument(allowScratch: true)
        let actualDocument = try String(contentsOf: work.appendingPathComponent("long.md"), encoding: .utf8)
        precondition(allowed == 0 && actualDocument == document, "exact private scratch must enable complete long-text writes")
        let profile = try CodexWorkspacePermissions(workspace: canonical(work), scratch: scratchA.path,
            documentTool: "/usr/bin/true", environment: ["PATH": "/usr/bin:/bin", "TMPDIR": scratchA.path])
        let anotherProfile = try CodexWorkspacePermissions(workspace: canonical(work), scratch: scratchA.path,
            documentTool: "/usr/bin/true", environment: ["PATH": "/usr/bin:/bin", "TMPDIR": scratchA.path])
        precondition(profile.name != anotherProfile.name && profile.name.hasPrefix("one-workspace-"), "loaded profiles cannot merge into a predictable name")
        precondition(profile.setting.contains("\":root\"=\"deny\"") && profile.setting.contains("\":minimal\"=\"read\""))
        precondition(profile.setting.contains("network={enabled=false}") && !profile.setting.contains(config.token))
        precondition(profile.arguments.contains("features.multi_agent=false") && profile.arguments.contains("features.goals=false"))
        precondition(profile.arguments.contains("shell_environment_policy.inherit=\"core\"") && profile.arguments.contains("shell_environment_policy.ignore_default_excludes=false"))
        precondition(profile.arguments.contains { $0.hasPrefix("shell_environment_policy.include_only=") && $0.contains("ONE_DOCUMENT_TOOL") && !$0.contains("TOKEN") })
        precondition(!profile.runtimeReadPaths.contains(home.deletingLastPathComponent().path), "no broad temporary or task-home grant")
        precondition(!profile.runtimeReadPaths.contains("/opt/homebrew") && !profile.runtimeReadPaths.contains("/usr/local"), "runtime dependencies must stay narrower than package-manager roots")
        if let executable = ProcessInfo.processInfo.environment["ONE_CODEX_PERMISSION_TEST_BIN"] {
            try fixedRuntimePermissions(executable: executable, home: home, work: work, scratch: scratchA, profile: profile)
        }
        for url in ["http://one.example/api/executor-gateway/v1", "https://user:pass@one.example/api/executor-gateway/v1", "https://one.example/api/executor-gateway/v1?key=secret"] {
            do {
                _ = try CodexGatewayConfiguration(baseUrl: url, token: config.token, model: config.model).launchOverrides(home: URL(fileURLWithPath: "/tmp/one-isolated"), environment: [:])
                fatalError("invalid gateway accepted")
            } catch { }
        }
        print("Codex gateway configuration isolation tests passed")
    }

    private static func fixedRuntimePermissions(executable: String, home: URL, work: URL, scratch: URL, profile: CodexWorkspacePermissions) throws {
        let outside = home.appendingPathComponent("outside.txt")
        try Data("SYNTHETIC_OUTSIDE".utf8).write(to: outside)
        try FileManager.default.createSymbolicLink(atPath: work.appendingPathComponent("outside-link").path, withDestinationPath: outside.path)
        // Known profiles/config cannot widen this fresh per-process profile.
        try Data("sandbox_mode=\"danger-full-access\"\n[permissions.one-workspace.workspace_roots]\n\"\(home.path)\"=true\n".utf8).write(to: home.appendingPathComponent("config.toml"))
        func run(_ command: [String], profileName: String? = nil) throws -> (Int32, String) {
            let process = Process(), output = Pipe()
            process.executableURL = URL(fileURLWithPath: executable)
            process.arguments = profile.arguments + ["sandbox", "-P", profileName ?? profile.name, "-C", work.path, "--"] + command
            var environment = ProcessInfo.processInfo.environment
            environment["CODEX_HOME"] = home.path; environment["TMPDIR"] = scratch.path; environment["TMPPREFIX"] = scratch.appendingPathComponent("zsh").path
            process.environment = environment; process.standardInput = FileHandle.nullDevice
            process.standardOutput = output; process.standardError = output
            try process.run(); try output.fileHandleForWriting.close()
            let data = output.fileHandleForReading.readDataToEndOfFile(); process.waitUntilExit()
            return (process.terminationStatus, String(decoding: data, as: UTF8.self))
        }
        let body = "set -e; printf INSIDE > inside.txt; cat inside.txt; printf SCRATCH > \"$TMPDIR/probe\"; "
            + "if cat \"\(outside.path)\"; then exit 31; fi; if cat outside-link; then exit 32; fi; "
            + "if echo BAD > \"\(home.appendingPathComponent("bad.txt").path)\"; then exit 33; fi; echo ONE_BOUNDARY_OK"
        let result = try run(["/bin/zsh", "-f", "-c", body])
        precondition(result.0 == 0 && result.1.contains("ONE_BOUNDARY_OK"), result.1)
        precondition(!FileManager.default.fileExists(atPath: home.appendingPathComponent("bad.txt").path))
        let originalOutside = try String(contentsOf: outside, encoding: .utf8)
        precondition(originalOutside == "SYNTHETIC_OUTSIDE")
        // Real standard-library OOXML generation/read-back. No vendor/model or
        // preinstalled spreadsheet package is involved in this boundary test.
        let python = """
        import zipfile, xml.etree.ElementTree as E
        files={
        '[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
        '_rels/.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
        'xl/workbook.xml':'<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="验收" sheetId="1" r:id="rId1"/></sheets></workbook>',
        'xl/_rels/workbook.xml.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
        'xl/worksheets/sheet1.xml':'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>ONE-QA</t></is></c><c r="B1"><v>3000</v></c></row></sheetData></worksheet>'}
        with zipfile.ZipFile('synthetic.xlsx','x',zipfile.ZIP_DEFLATED) as z:
            for name,content in files.items(): z.writestr(name,content)
        with zipfile.ZipFile('synthetic.xlsx') as z:
            assert z.testzip() is None
            sheet=E.fromstring(z.read('xl/worksheets/sheet1.xml'))
            assert sheet.find('.//{*}c[@r="B1"]/{*}v').text=='3000'
        print('ONE_EXCEL_OK')
        """
        let excel = try run(["/usr/bin/python3", "-c", python])
        precondition(excel.0 == 0 && excel.1.contains("ONE_EXCEL_OK"), excel.1)
        if let node = profile.runtimeReadPaths.first(where: { $0.hasSuffix("/bin/node") }) {
            let nodeResult = try run([node, "-e", "console.log('ONE_NODE_OK')"])
            precondition(nodeResult.0 == 0 && nodeResult.1.contains("ONE_NODE_OK"), nodeResult.1)
            let aliases = URL(fileURLWithPath: node).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("opt")
            let entries = (try? FileManager.default.contentsOfDirectory(at: aliases, includingPropertiesForKeys: nil)) ?? []
            let unrelated = entries.flatMap { package in ["LICENSE", "COPYING", "README.md"].map { package.appendingPathComponent($0) } }.first { file in
                let resolved = file.resolvingSymlinksInPath().path
                return FileManager.default.fileExists(atPath: file.path) && !profile.runtimeReadPaths.contains { resolved == $0 || resolved.hasPrefix($0 + "/") }
            }
            if let unrelated {
                let deniedRuntime = try run(["/bin/cat", unrelated.path])
                precondition(deniedRuntime.0 != 0, "runtime alias traversal must not grant an unrelated package")
            }
        }
        if let documentTool = ProcessInfo.processInfo.environment["ONE_DOCUMENT_PERMISSION_TEST_TOOL"] {
            var permissionEnvironment = ProcessInfo.processInfo.environment
            permissionEnvironment["TMPDIR"] = scratch.path
            let documentProfile = try CodexWorkspacePermissions(workspace: work.resolvingSymlinksInPath().path, scratch: scratch.path,
                documentTool: documentTool, environment: permissionEnvironment)
            let helper = Process(), input = Pipe(), output = Pipe()
            helper.executableURL = URL(fileURLWithPath: executable)
            var environment = ProcessInfo.processInfo.environment
            environment["CODEX_HOME"] = home.path; environment["TMPDIR"] = scratch.path; environment["ONE_DOCUMENT_ROOT"] = work.resolvingSymlinksInPath().path
            environment["ONE_DOCUMENT_TOOL"] = documentTool
            let gateway = CodexGatewayConfiguration(baseUrl:"https://one.example/api/executor-gateway/v1",token:String(repeating:"a",count:43),model:"one-executor")
            let overrides = try gateway.launchOverrides(home:home,environment:environment)
            helper.arguments = overrides.arguments + documentProfile.arguments + ["sandbox", "-P", documentProfile.name, "-C", work.path, "--", documentTool, "--one-create-document-exact", "helper.txt"]
            helper.environment = overrides.environment; helper.standardInput = input; helper.standardOutput = output; helper.standardError = output
            try helper.run(); try output.fileHandleForWriting.close(); try input.fileHandleForReading.close()
            try input.fileHandleForWriting.write(contentsOf: Data("SYNTHETIC_DOCUMENT_HELPER".utf8)); try input.fileHandleForWriting.close()
            let detail = output.fileHandleForReading.readDataToEndOfFile(); helper.waitUntilExit()
            precondition(helper.terminationStatus == 0, String(decoding: detail, as: UTF8.self))
            let savedHelper = try String(contentsOf: work.appendingPathComponent("helper.txt"), encoding: .utf8)
            precondition(savedHelper == "SYNTHETIC_DOCUMENT_HELPER")
        }
        let refused = try run(["/bin/sh", "-c", "echo SHOULD_NOT_RUN"], profileName: "one-workspace-" + String(repeating: "b", count: 32))
        precondition(refused.0 != 0 && !refused.1.contains("SHOULD_NOT_RUN"), "unknown policy must fail closed")
        print("Pinned Codex permission profile: folder/scratch write, outside read/write/symlink refusal, OOXML and runtime checks passed")
    }
}
