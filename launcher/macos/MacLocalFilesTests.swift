import Foundation

@main struct MacLocalFilesTests {
    static func main() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("one-local-files-\(UUID().uuidString)")
        let outside = FileManager.default.temporaryDirectory.appendingPathComponent("one-local-sentinel-\(UUID().uuidString).txt")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        try workFolderPersistence(root: root)
        try "OUTSIDE_UNCHANGED".write(to: outside, atomically: true, encoding: .utf8)
        let files = try MacLocalFiles(root: root.path)
        let document = try files.createDocument("成品.md", content: String(repeating: "完整文档🙂\n", count: 10000))
        let receipt = try JSONSerialization.jsonObject(with: Data(document.utf8)) as! [String: Any]
        precondition(receipt["verified"] as? Bool == true && (receipt["bytes"] as? Int ?? 0) > 100000)
        _ = try files.createDocument("成品.md", content: "第二版")
        do { _ = try files.createDocument("成品.md", content: "不可覆盖", renameOnConflict: false); preconditionFailure("exact conflict accepted") } catch {}
        let secondDocument = try files.read("成品-2.md"); precondition(secondDocument == "第二版")
        try Data().write(to: root.appendingPathComponent("空壳.md"))
        _ = try files.createDocument("空壳.md", content: "不覆盖空壳")
        let emptyOriginal = try Data(contentsOf: root.appendingPathComponent("空壳.md")); precondition(emptyOriginal.isEmpty)
        let besideEmpty = try files.read("空壳-2.md"); precondition(besideEmpty == "不覆盖空壳")
        do { _ = try files.createDocument("不得创建.md", content: "  "); preconditionFailure("empty accepted") } catch {}
        precondition(!FileManager.default.fileExists(atPath: root.appendingPathComponent("不得创建.md").path))
        try FileManager.default.createSymbolicLink(atPath: root.appendingPathComponent("同名链接.md").path, withDestinationPath: outside.path)
        _ = try files.createDocument("同名链接.md", content: "另存")
        let besideLink = try files.read("同名链接-2.md"); precondition(besideLink == "另存")
        do { _ = try files.createDocument("../escape.md", content: "escape"); preconditionFailure("escape accepted") } catch {}
        do { _ = try files.createDocument("fake.xlsx", content: "fake"); preconditionFailure("binary fake accepted") } catch {}
        precondition(!FileManager.default.fileExists(atPath: root.appendingPathComponent("fake.xlsx").path))
        let publishedFiles = try FileManager.default.contentsOfDirectory(atPath: root.path)
        precondition(publishedFiles.allSatisfy { !$0.hasPrefix(".one-stage-") })
        let result = try files.create("测试 说明.md", content: "荷叶饼好吃，一个 5 块钱")
        precondition(result.contains("回读验证"))
        let initial = try files.read("测试 说明.md"); precondition(initial == "荷叶饼好吃，一个 5 块钱")
        func rejected(_ body: () throws -> Void) { do { try body(); preconditionFailure("must reject") } catch {} }
        rejected { _ = try files.create("测试 说明.md", content: "OVERWRITE") }
        rejected { _ = try files.read("../\(outside.lastPathComponent)") }
        rejected { _ = try files.read(outside.path) }
        rejected { _ = try files.create(".env", content: "fake") }
        rejected { _ = try files.create("credential.json", content: "fake") }
        rejected { _ = try MacLocalFiles(root: FileManager.default.homeDirectoryForCurrentUser.path) }
        rejected { _ = try files.create("fake.docx", content: "not a Word file") }
        let malformed = try JSONDecoder().decode(LocalFileArguments.self, from: Data("{\"path\":\"测试 说明.md\",\"oldText\":\"5 块钱\"}".utf8))
        rejected { try malformed.validate(tool: "replace_in_file") }
        let absent = try JSONDecoder().decode(LocalFileArguments.self, from: Data("{\"path\":\"empty.md\"}".utf8))
        rejected { try absent.validate(tool: "write_file") }
        try FileManager.default.createSymbolicLink(atPath: root.appendingPathComponent("linked.txt").path, withDestinationPath: outside.path)
        rejected { _ = try files.read("linked.txt") }
        rejected { _ = try files.replace("linked.txt", old: "OUTSIDE", new: "BROKEN") }
        try FileManager.default.linkItem(at: outside, to: root.appendingPathComponent("hard.txt"))
        rejected { _ = try files.read("hard.txt") }
        rejected { _ = try files.replace("hard.txt", old: "OUTSIDE", new: "BROKEN") }
        _ = try files.replace("测试 说明.md", old: "5 块钱", new: "6 块钱")
        let changed = try files.read("测试 说明.md"); precondition(changed == "荷叶饼好吃，一个 6 块钱")
        let sentinel = try String(contentsOf: outside, encoding: .utf8); precondition(sentinel == "OUTSIDE_UNCHANGED")
        let list = try files.list(".", depth: 2)
        precondition(!list.contains("linked.txt"))
        let repeatedList = try files.list(".", depth: 2); precondition(repeatedList == list)
        print("Mac native file create/read/replace/no-overwrite/traversal/symlink/hardlink checks passed: \(root.path)")
    }

    static func workFolderPersistence(root: URL) throws {
        let suite = "one-work-folder-test-\(UUID().uuidString)"
        final class ModalCancellationProbe: @unchecked Sendable {
            private let lock = NSLock()
            private var delivered = false
            func deliver() { lock.lock(); delivered = true; lock.unlock() }
            func wasDelivered() -> Bool { lock.lock(); defer { lock.unlock() }; return delivered }
        }
        let modalCancellation = ModalCancellationProbe()
        DispatchQueue.global().async { scheduleWorkFolderCancellation { modalCancellation.deliver() } }
        let modalDeadline = Date(timeIntervalSinceNow: 2)
        while !modalCancellation.wasDelivered(), Date() < modalDeadline {
            RunLoop.main.run(mode: RunLoop.Mode("NSModalPanelRunLoopMode"), before: Date(timeIntervalSinceNow: 0.02))
        }
        precondition(modalCancellation.wasDelivered(), "Stop must be delivered inside the picker's modal run loop")
        var picker = WorkFolderPickerOwnership()
        precondition(picker.begin("attempt-a"))
        precondition(!picker.begin("attempt-b"), "only one folder picker may be active")
        precondition(!picker.owns("attempt-b"), "another task cannot close the current permission picker")
        picker.finish("attempt-b")
        precondition(picker.owns("attempt-a"), "stale task finish must not release another picker")
        picker.finish("attempt-a")
        precondition(picker.begin("attempt-b"), "picker ownership releases only after original unwind")
        precondition(!picker.owns("attempt-a"), "late cancellation cannot close the next task's picker")
        picker.finish("attempt-b")
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite); defaults.synchronize() }
        let canonicalRoot = root.resolvingSymlinksInPath().path
        var selections = 0
        let select = { selections += 1; return root.path as String? }
        let initiallyConfigured = try MacWorkFolderConfiguration.configured(defaults: defaults, deviceId: "key-a")
        precondition(initiallyConfigured == nil)
        let first = try MacWorkFolderConfiguration.resolve(defaults: defaults, deviceId: "key-a", choose: select)
        precondition(first == canonicalRoot && selections == 1)
        for _ in 0..<3 {
            let saved = try MacWorkFolderConfiguration.resolve(defaults: defaults, deviceId: "key-a", choose: select)
            precondition(saved == canonicalRoot && selections == 1, "a new task must reuse the selected folder")
        }
        let relaunched = UserDefaults(suiteName: suite)!
        let restored = try MacWorkFolderConfiguration.resolve(defaults: relaunched, deviceId: "key-a", choose: select)
        precondition(restored == canonicalRoot && selections == 1, "relaunch must preserve the same Key folder")
        let otherKey = try MacWorkFolderConfiguration.configured(defaults: defaults, deviceId: "key-b")
        precondition(otherKey == nil, "another Key must not inherit authorization")
        let cancelled = try MacWorkFolderConfiguration.resolve(defaults: defaults, deviceId: "key-a", change: true, choose: { nil })
        precondition(cancelled == nil)
        let afterCancellation = try MacWorkFolderConfiguration.configured(defaults: defaults, deviceId: "key-a")
        precondition(afterCancellation == canonicalRoot, "cancelling change must preserve authorization")

        func rejectsWithoutChoosing(_ saved: String) {
            defaults.set(saved, forKey: MacWorkFolderConfiguration.key("key-stale"))
            do {
                _ = try MacWorkFolderConfiguration.resolve(defaults: defaults, deviceId: "key-stale", choose: select)
                preconditionFailure("unavailable or redirected saved root must not be authorized")
            } catch {}
            precondition(selections == 1, "an unavailable saved folder must not implicitly reopen the chooser")
            precondition(defaults.string(forKey: MacWorkFolderConfiguration.key("key-stale")) == saved)
        }
        rejectsWithoutChoosing(root.appendingPathComponent("missing").path)
        let notDirectory = root.appendingPathComponent("not-a-folder")
        try "fixture".write(to: notDirectory, atomically: true, encoding: .utf8)
        rejectsWithoutChoosing(notDirectory.path)
        let redirected = root.appendingPathComponent("redirected-folder")
        try FileManager.default.createSymbolicLink(at: redirected, withDestinationURL: root)
        rejectsWithoutChoosing(redirected.path)
        let recovered = try MacWorkFolderConfiguration.resolve(defaults: defaults, deviceId: "key-stale", change: true, choose: select)
        precondition(recovered == canonicalRoot && selections == 2)
        do {
            _ = try MacWorkFolderConfiguration.resolve(defaults: defaults, deviceId: "key-wide", choose: { FileManager.default.homeDirectoryForCurrentUser.path })
            preconditionFailure("folder configuration must not authorize the entire home directory")
        } catch {}
        print("Mac work folder persistence/new-task/relaunch/Key isolation/cancel/stale/redirect checks passed")
    }
}
