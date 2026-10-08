import Foundation

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
        func quoted(_ value: String) -> String { "\"" + value.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"").replacingOccurrences(of: "\n", with: "\\n") + "\"" }
        var isolated = environment
        for key in ["OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_API_KEY", "CODEX_SQLITE_HOME"] { isolated.removeValue(forKey: key) }
        isolated["CODEX_HOME"] = home.path
        isolated["ONE_EXECUTOR_TOKEN"] = token
        let settings = [
            "model=\(quoted(model))", "model_provider=\"one\"", "web_search=\"disabled\"",
            "model_providers.one.name=\"ONE\"", "model_providers.one.base_url=\(quoted(baseUrl))",
            "model_providers.one.wire_api=\"responses\"", "model_providers.one.env_key=\"ONE_EXECUTOR_TOKEN\"",
            "model_providers.one.requires_openai_auth=false", "model_providers.one.request_max_retries=0",
            "model_providers.one.stream_max_retries=0"
        ]
        return (settings.flatMap { ["-c", $0] }, isolated)
    }
}
