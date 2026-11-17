import Foundation

// Opt-in integration fixture: production controller + real pinned Codex process,
// with a local synthetic Responses service supplied by qa-codex-tool-bridge.ts.
// It never reads an account, supplier credential, Key, or user project.
private struct FixtureFailure: Error { let reason: String }
private func check(_ value: Bool, _ reason: String) throws {
    if !value { throw FixtureFailure(reason: reason) }
}
private actor FixtureTools {
    let project: URL
    let marker: String
    var calls: [String] = []
    var writes = 0
    init(project: URL, marker: String) { self.project = project; self.marker = marker }
    func invoke(_ call: CodexDynamicToolCall) throws -> CodexDynamicToolResult {
        calls.append(call.tool)
        let result: String
        switch call.tool {
        case "one_fixture_read": result = "{\"source\":\"synthetic\",\"content\":\"\(marker)\"}"
        case "one_fixture_save":
            try check(call.arguments["content"]?.string == marker, "wrong synthetic content")
            let target = project.appendingPathComponent("result.txt")
            try check(!FileManager.default.fileExists(atPath: target.path), "duplicate write")
            try Data(marker.utf8).write(to: target, options: .withoutOverwriting)
            writes += 1
            result = "{\"saved\":true,\"artifactRef\":\"fixture_artifact\",\"deliveryId\":\"fixture_delivery\"}"
        default: throw FixtureFailure(reason: "undeclared fixture tool")
        }
        return CodexDynamicToolResult(contentItems: [.object(["type": .string("inputText"), "text": .string(result)])], success: true)
    }
    func evidence() -> ([String], Int) { (calls, writes) }
}

@main struct CodexToolBridgeRuntimeFixture {
    static func main() async throws {
        let args = CommandLine.arguments
        try check(args.count == 6 || args.count == 7, "expected executable endpoint project home marker [thread]")
        let executable = args[1], endpoint = args[2], project = URL(fileURLWithPath: args[3]), home = args[4], marker = args[5]
        let resume = args.count == 7 ? args[6] : nil
        try check(endpoint.hasPrefix("http://127.0.0.1:"), "fixture endpoint must be loopback")
        let process = Process(), input = Pipe(), output = Pipe(), errors = Pipe()
        let scratch = try createCodexScratch(home: URL(fileURLWithPath: home))
        var permissionEnvironment = ProcessInfo.processInfo.environment
        permissionEnvironment["TMPDIR"] = scratch.path
        let permissions = try CodexWorkspacePermissions(workspace: project.resolvingSymlinksInPath().path,
            scratch: scratch.path, documentTool: nil, environment: permissionEnvironment)
        let writer = try CodexAppServerInput(fileHandle: input.fileHandleForWriting, timeout: .seconds(3))
        let toolState = FixtureTools(project: project, marker: marker)
        let schema: CodexAppServerJSON = .object(["type": .string("object"), "properties": .object([:]), "additionalProperties": .bool(false)])
        let saveSchema: CodexAppServerJSON = .object(["type": .string("object"), "properties": .object(["content": .object(["type": .string("string")])]), "required": .array([.string("content")]), "additionalProperties": .bool(false)])
        let controller = try CodexAppServerController(attemptId: resume == nil ? "attempt_real_fixture" : "attempt_resume_fixture", authorizedCWD: project.path,
            permissionProfile: permissions.name, resumeThreadId: resume,
            clientVersion: "fixture", requestTimeout: 10,
            dynamicTools: [CodexDynamicToolDefinition(name: "one_fixture_read", description: "Read synthetic source", inputSchema: schema),
                CodexDynamicToolDefinition(name: "one_fixture_save", description: "Save synthetic result", inputSchema: saveSchema)],
            onToolCall: { try await toolState.invoke($0) },
            sendLine: { try await writer.sendLine($0) }, onExecEvent: { _ in })
        let settings = ["model=\"one-executor\"", "model_provider=\"one_fixture\"", "web_search=\"disabled\"",
            "model_providers.one_fixture.name=\"ONE fixture\"", "model_providers.one_fixture.base_url=\"\(endpoint)\"",
            "model_providers.one_fixture.wire_api=\"responses\"", "model_providers.one_fixture.requires_openai_auth=false",
            "model_providers.one_fixture.request_max_retries=0", "model_providers.one_fixture.stream_max_retries=0"]
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = settings.flatMap { ["-c", $0] } + permissions.arguments + ["app-server", "--listen", "stdio://"]
        var environment = ProcessInfo.processInfo.environment
        environment["CODEX_HOME"] = home
        environment["TMPDIR"] = scratch.path
        process.environment = environment; process.currentDirectoryURL = project
        process.standardInput = input; process.standardOutput = output; process.standardError = errors
        try process.run()
        try input.fileHandleForReading.close(); try output.fileHandleForWriting.close(); try errors.fileHandleForWriting.close()
        let reading = Task.detached {
            var pending = Data()
            while true {
                let bytes = output.fileHandleForReading.availableData
                if bytes.isEmpty { break }
                pending.append(bytes)
                while let end = pending.firstIndex(of: 10) {
                    let line = String(decoding: pending[..<end], as: UTF8.self)
                    pending.removeSubrange(...end)
                    await controller.receive(line: line)
                }
            }
            if !pending.isEmpty { await controller.receive(line: String(decoding: pending, as: UTF8.self)) }
            await controller.transportClosed()
        }
        let draining = Task.detached { while !errors.fileHandleForReading.availableData.isEmpty {} }
        defer { writer.close(); if process.isRunning { process.terminate() } }
        let identity = try await controller.start(instruction: "Read the synthetic source, save it using the provided tools, then report completion.")
        let status = try await controller.waitForTurnEnd(timeout: 30)
        try check(status == .completed, "real turn not complete")
        writer.close()
        let deadline = ProcessInfo.processInfo.systemUptime + 5
        while process.isRunning && ProcessInfo.processInfo.systemUptime < deadline { try await Task.sleep(for: .milliseconds(10)) }
        try check(!process.isRunning, "Codex did not exit after stdin closed")
        await reading.value; await draining.value
        let snapshot = await controller.snapshot(), evidence = await toolState.evidence()
        try check(snapshot.canCompleteNormally(treeCleanupVerified: true, processExitCode: process.terminationStatus, requestSucceeded: true), "production controller rejected real completed tool turn")
        try check(evidence.0 == (resume == nil ? ["one_fixture_read", "one_fixture_save"] : ["one_fixture_read"]) && evidence.1 == (resume == nil ? 1 : 0), "wrong callback or write count")
        try check(resume == nil || identity.threadId == resume, "resume changed thread")
        try check(snapshot.finalResponse?.contains(marker) == true, "missing final result")
        let result: [String: Any] = ["passed": true, "controller": "production Swift", "writes": evidence.1, "toolCallbacks": evidence.0,
            "threadId": identity.threadId, "turnId": identity.turnId, "canCompleteNormally": true, "processExitCode": process.terminationStatus,
            "permissionProfile": permissions.name]
        print(String(decoding: try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]), as: UTF8.self))
    }
}
