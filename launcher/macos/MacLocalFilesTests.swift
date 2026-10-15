import Foundation

@main struct MacLocalFilesTests {
    static func main() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("one-local-files-\(UUID().uuidString)")
        let outside = FileManager.default.temporaryDirectory.appendingPathComponent("one-local-sentinel-\(UUID().uuidString).txt")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
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
}
