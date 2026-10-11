import Foundation
import Network

/// Static text assets only. No subprocess, directory listing, upload or public bind.
final class LocalPreview: @unchecked Sendable {
    private let queue = DispatchQueue(label: "one.static-preview")
    private var listener: NWListener?
    private var timer: DispatchSourceTimer?
    private var clients: [ObjectIdentifier: NWConnection] = [:]
    private let files: MacLocalFiles
    private let entry: String
    private let prefix: String
    private let token = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    private let present: @Sendable () -> Bool
    private let expires = Date().addingTimeInterval(30 * 60)

    init(root: String, entry: String, present: @escaping @Sendable () -> Bool) throws {
        guard !entry.hasPrefix("/"), !entry.contains("\\"), !entry.split(separator: "/").contains(where: { $0 == ".." || $0.hasPrefix(".") }),
              ["html", "htm"].contains(URL(fileURLWithPath: entry).pathExtension.lowercased()) else { throw LocalFileFailure.message("请选择授权目录内的 HTML 相对路径") }
        self.files = try MacLocalFiles(root: root)
        _ = try files.read(entry)
        self.entry = URL(fileURLWithPath: entry).lastPathComponent
        let parts = entry.split(separator: "/").dropLast()
        self.prefix = parts.isEmpty ? "" : parts.joined(separator: "/") + "/"
        self.present = present
    }

    static func mime(_ path: String) -> String? {
        switch URL(fileURLWithPath: path).pathExtension.lowercased() {
        case "html", "htm": return "text/html; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "svg": return "image/svg+xml"
        default: return nil
        }
    }

    func start() async throws -> String {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<String, Error>) in
            queue.async { [self] in
                do {
                    guard present() else { throw LocalFileFailure.message("请插入当前 ONE Key") }
                    let parameters = NWParameters.tcp
                    parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
                    let server = try NWListener(using: parameters)
                    listener = server
                    var replied = false
                    server.stateUpdateHandler = { [weak self, weak server] state in
                        guard let self, let server else { return }
                        switch state {
                        case .ready:
                            guard !replied, let port = server.port else { return }; replied = true
                            let clock = DispatchSource.makeTimerSource(queue: queue)
                            clock.schedule(deadline: .now() + 2, repeating: 2)
                            clock.setEventHandler { [weak self] in if let self, !self.present() || Date() > self.expires { self.close() } }
                            timer = clock; clock.resume()
                            let name = entry.addingPercentEncoding(withAllowedCharacters: CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~"))!
                            continuation.resume(returning: "http://127.0.0.1:\(port.rawValue)/\(token)/\(name)")
                        case .failed(let error):
                            if !replied { replied = true; continuation.resume(throwing: error) }; close()
                        case .cancelled:
                            if !replied { replied = true; continuation.resume(throwing: LocalFileFailure.message("预览已停止")) }
                        default: break
                        }
                    }
                    server.newConnectionHandler = { [weak self, weak server] connection in
                        guard let self else { connection.cancel(); return }
                        guard clients.count < 16 else { connection.cancel(); return }
                        clients[ObjectIdentifier(connection)] = connection
                        connection.start(queue: queue)
                        receive(connection, accumulated: Data(), port: server?.port?.rawValue ?? 0)
                        queue.asyncAfter(deadline: .now() + 5) { [self] in self.clients.removeValue(forKey: ObjectIdentifier(connection)); connection.cancel() }
                    }
                    server.start(queue: queue)
                    queue.asyncAfter(deadline: .now() + 10) { if !replied { server.cancel() } }
                } catch { continuation.resume(throwing: error) }
            }
        }
    }

    private func receive(_ connection: NWConnection, accumulated: Data, port: UInt16) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: max(1, 8193 - accumulated.count)) { [self] data, _, complete, error in
            let bytes = accumulated + (data ?? Data())
            if bytes.count <= 8192 && !complete && error == nil && bytes.range(of: Data("\r\n\r\n".utf8)) == nil {
                receive(connection, accumulated: bytes, port: port); return
            }
            connection.send(content: reply(bytes, port: port), completion: .contentProcessed { [self] _ in clients.removeValue(forKey: ObjectIdentifier(connection)); connection.cancel() })
        }
    }

    private func reply(_ data: Data, port: UInt16) -> Data {
        func response(_ status: String, _ body: String = "", _ mime: String = "text/plain; charset=utf-8") -> Data {
            let bytes = Data(body.utf8)
            let headers = "HTTP/1.1 \(status)\r\nContent-Type: \(mime)\r\nContent-Length: \(bytes.count)\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'\r\n\r\n"
            return Data(headers.utf8) + bytes
        }
        guard present(), Date() <= expires else { close(); return response("403 Forbidden") }
        guard data.count <= 8192, let request = String(data: data, encoding: .utf8), request.contains("\r\n\r\n") else { return response("400 Bad Request") }
        let lines = request.components(separatedBy: "\r\n"), first = lines[0].split(separator: " ")
        guard first.count == 3, first[0] == "GET", first[2] == "HTTP/1.1" else { return response("405 Method Not Allowed") }
        let hosts = lines.filter { $0.lowercased().hasPrefix("host:") }
        guard hosts.count == 1, hosts[0].dropFirst(5).trimmingCharacters(in: .whitespaces) == "127.0.0.1:\(port)" else { return response("403 Forbidden") }
        let raw = String(first[1]).components(separatedBy: "?")[0]
        guard let path = raw.removingPercentEncoding, path.hasPrefix("/\(token)/") else { return response("404 Not Found") }
        let relative = String(path.dropFirst(token.count + 2))
        guard !relative.isEmpty, !relative.split(separator: "/").contains(where: { $0 == ".." || $0.hasPrefix(".") }), let mime = Self.mime(relative) else { return response("404 Not Found") }
        do { return response("200 OK", try files.read(prefix + relative), mime) }
        catch { return response("404 Not Found") }
    }

    private func close() {
        timer?.cancel(); timer = nil
        listener?.cancel(); listener = nil
        for client in clients.values { client.cancel() }; clients.removeAll()
    }
    func stop() { queue.sync { close() } }
}
