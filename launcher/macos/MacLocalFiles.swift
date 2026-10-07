import Foundation
import Darwin

struct LocalFileArguments: Decodable {
    var path: String?
    var content: String?
    var oldText: String?
    var newText: String?
    var query: String?
    var maxDepth: Int?
    var maxResults: Int?
    var caseSensitive: Bool?
    var startLine: Int?
    var endLine: Int?
}

enum LocalFileFailure: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let text) = self { return text }; return nil }
}

/// No shell: every path component is opened relative to the authorized root.
/// Symlinks are rejected, not followed. Existing files require exact replacement.
final class MacLocalFiles {
    let root: String
    private let rootFD: Int32
    init(root: String) throws {
        self.root = URL(fileURLWithPath: root).resolvingSymlinksInPath().path
        let sensitiveRoots = Set([".ssh", ".aws", ".codex", ".one", ".gnupg", ".kube", "keychains"])
        if self.root == "/" || self.root == FileManager.default.homeDirectoryForCurrentUser.path || self.root.split(separator: "/").contains(where: { sensitiveRoots.contains($0.lowercased()) }) { throw LocalFileFailure.message("不能把系统根目录、整个用户目录或凭证目录授权给文件工具，请选择具体工作文件夹") }
        rootFD = open(self.root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        if rootFD < 0 { throw LocalFileFailure.message("工作目录无法打开，请重新选择") }
    }
    deinit { close(rootFD) }
    private func components(_ path: String) throws -> [String] {
        if path.hasPrefix("/") || path.contains("\0") || path.contains("\\") { throw LocalFileFailure.message("只能使用授权目录内的相对路径") }
        let parts = path.split(separator: "/").map(String.init)
        let sensitive = Set([".ssh", ".aws", ".codex", ".one", ".gnupg", ".kube", ".git", "keychains", "auth.json", "credential.json", "credentials.json", "id_rsa", "id_ed25519"])
        if parts.contains(where: { $0 == ".." || sensitive.contains($0.lowercased()) || $0.lowercased().hasPrefix(".env") || $0.lowercased().hasSuffix(".pem") || $0.lowercased().hasSuffix(".key") }) { throw LocalFileFailure.message("此路径越界或属于受保护内容，未操作") }
        return parts.filter { $0 != "." }
    }
    private func parent(_ path: String) throws -> (Int32, String) {
        let parts = try components(path)
        guard let name = parts.last else { throw LocalFileFailure.message("请指定文件名") }
        var fd = dup(rootFD)
        for part in parts.dropLast() {
            let next = openat(fd, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            close(fd)
            if next < 0 { throw LocalFileFailure.message("目录不存在或包含链接，未操作") }
            fd = next
        }
        return (fd, name)
    }
    func read(_ path: String) throws -> String {
        let (dir, name) = try parent(path); defer { close(dir) }
        let fd = openat(dir, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
        if fd < 0 { throw LocalFileFailure.message("文件不存在、不可读或为链接") }
        defer { close(fd) }
        var info = stat()
        if fstat(fd, &info) != 0 || info.st_mode & S_IFMT != S_IFREG || info.st_nlink != 1 || info.st_size > 2_000_000 { throw LocalFileFailure.message("只支持 2 MB 以内的无链接普通 UTF-8 文件") }
        var data = Data(), buffer = [UInt8](repeating: 0, count: 8192)
        while true {
            let count = Darwin.read(fd, &buffer, buffer.count)
            if count < 0 { throw LocalFileFailure.message("文件读取失败") }
            if count == 0 { break }
            data.append(contentsOf: buffer.prefix(count))
            if data.count > 2_000_000 { throw LocalFileFailure.message("文件过大") }
        }
        guard let text = String(data: data, encoding: .utf8) else { throw LocalFileFailure.message("文件不是 UTF-8 文本") }
        return text
    }
    func create(_ path: String, content: String) throws -> String {
        let binaryExtensions = Set(["doc", "docx", "xls", "xlsx", "pdf", "ppt", "pptx", "png", "jpg", "jpeg", "gif", "zip", "app", "exe"])
        if binaryExtensions.contains(URL(fileURLWithPath: path).pathExtension.lowercased()) { throw LocalFileFailure.message("原生文件工具只能创建文本，不能用文本伪装此格式；未创建") }
        let data = Data(content.utf8)
        if data.count > 2_000_000 { throw LocalFileFailure.message("内容超过 2 MB") }
        let (dir, name) = try parent(path); defer { close(dir) }
        let fd = openat(dir, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        if fd < 0 { throw LocalFileFailure.message("文件已存在或不可创建；未覆盖") }
        defer { close(fd) }
        try writeAll(fd, data)
        if fsync(fd) != 0 { throw LocalFileFailure.message("文件写入后同步失败，结果需检查，不会重跑") }
        let returned = try read(path)
        if returned != content { throw LocalFileFailure.message("文件回读与要求不一致，结果需检查") }
        return "已创建并回读验证：\(root)/\(path)\n内容（\(data.count) 字节）：\n\(returned)"
    }
    func replace(_ path: String, old: String, new: String) throws -> String {
        if old.isEmpty { throw LocalFileFailure.message("替换原文不能为空") }
        let original = try read(path)
        let occurrences = original.components(separatedBy: old)
        if occurrences.count != 2 { throw LocalFileFailure.message("原文必须恰好匹配一处，未修改") }
        let changed = occurrences.joined(separator: new), data = Data(changed.utf8)
        if data.count > 2_000_000 { throw LocalFileFailure.message("内容超过 2 MB") }
        let (dir, name) = try parent(path); defer { close(dir) }
        let fd = openat(dir, name, O_RDWR | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
        if fd < 0 { throw LocalFileFailure.message("文件无法安全打开，未修改") }
        defer { close(fd) }
        var info = stat()
        if fstat(fd, &info) != 0 || info.st_mode & S_IFMT != S_IFREG || info.st_nlink != 1 { throw LocalFileFailure.message("不修改链接或特殊文件") }
        // Check the opened inode, not a second pathname that can be substituted.
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: false)
        guard let bytes = try handle.readToEnd(), String(data: bytes, encoding: .utf8) == original else { throw LocalFileFailure.message("文件已变化，未修改") }
        if lseek(fd, 0, SEEK_SET) < 0 { throw LocalFileFailure.message("无法定位文件") }
        try writeAll(fd, data)
        if ftruncate(fd, off_t(data.count)) != 0 || fsync(fd) != 0 { throw LocalFileFailure.message("修改同步失败，请检查文件") }
        if try read(path) != changed { throw LocalFileFailure.message("修改回读不一致，请检查文件") }
        return "已替换一处并回读验证：\(root)/\(path)\n\(changed)"
    }
    private func writeAll(_ fd: Int32, _ data: Data) throws {
        try data.withUnsafeBytes { bytes in
            var offset = 0
            while offset < bytes.count {
                let written = Darwin.write(fd, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
                if written <= 0 { throw LocalFileFailure.message("写入中断，文件可能部分写入，请检查，不会自动重跑") }
                offset += written
            }
        }
    }
    func list(_ path: String, depth: Int) throws -> [String] {
        let parts = try components(path), base = parts.joined(separator: "/")
        // Open each directory with NOFOLLOW before enumerating by descriptor.
        func walk(_ fd: Int32, _ prefix: String, _ level: Int, _ output: inout [String]) {
            guard output.count < 300, let directory = fdopendir(dup(fd)) else { return }
            defer { closedir(directory) }
            rewinddir(directory)
            while let entry = readdir(directory), output.count < 300 {
                let name = withUnsafePointer(to: entry.pointee.d_name) { pointer in pointer.withMemoryRebound(to: CChar.self, capacity: MemoryLayout.size(ofValue: entry.pointee.d_name)) { String(cString: $0) } }
                if name == "." || name == ".." || (try? components(name)) == nil { continue }
                let child = prefix.isEmpty ? name : "\(prefix)/\(name)"
                var info = stat()
                if fstatat(fd, name, &info, AT_SYMLINK_NOFOLLOW) != 0 || info.st_mode & S_IFMT == S_IFLNK { continue }
                let isDir = info.st_mode & S_IFMT == S_IFDIR
                output.append(child + (isDir ? "/" : ""))
                if isDir && level < depth {
                    let next = openat(fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
                    if next >= 0 { walk(next, child, level + 1, &output); close(next) }
                }
            }
        }
        var fd = dup(rootFD)
        for part in parts {
            let next = openat(fd, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC); close(fd)
            if next < 0 { throw LocalFileFailure.message("目录不存在或包含链接") }; fd = next
        }
        defer { close(fd) }
        var output = [String](); walk(fd, base, 1, &output)
        return output.sorted()
    }
}
