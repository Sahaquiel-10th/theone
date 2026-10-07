import Foundation

@main struct MacLocalFilesTests {
    static func main() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("one-local-files-\(UUID().uuidString)")
        let outside = FileManager.default.temporaryDirectory.appendingPathComponent("one-local-sentinel-\(UUID().uuidString).txt")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        try "OUTSIDE_UNCHANGED".write(to: outside, atomically: true, encoding: .utf8)
        let files = try MacLocalFiles(root: root.path)
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
