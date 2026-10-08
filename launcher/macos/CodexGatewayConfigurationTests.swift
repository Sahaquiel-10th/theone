import Foundation

@main struct CodexGatewayConfigurationTests {
    static func main() throws {
        let config = CodexGatewayConfiguration(baseUrl: "https://one.example/api/executor-gateway/v1", token: String(repeating: "a", count: 43), model: "one-executor")
        let result = try config.launchOverrides(home: URL(fileURLWithPath: "/tmp/one-isolated"), environment: ["OPENAI_API_KEY": "personal", "OPENAI_BASE_URL": "personal-url", "CODEX_HOME": "/personal", "PATH": "/bin"])
        precondition(result.environment["OPENAI_API_KEY"] == nil && result.environment["OPENAI_BASE_URL"] == nil)
        precondition(result.environment["CODEX_HOME"] == "/tmp/one-isolated" && result.environment["ONE_EXECUTOR_TOKEN"] == config.token)
        precondition(!result.arguments.joined(separator: " ").contains(config.token))
        precondition(result.arguments.contains("model_providers.one.requires_openai_auth=false"))
        for url in ["http://one.example/api/executor-gateway/v1", "https://user:pass@one.example/api/executor-gateway/v1", "https://one.example/api/executor-gateway/v1?key=secret"] {
            do {
                _ = try CodexGatewayConfiguration(baseUrl: url, token: config.token, model: config.model).launchOverrides(home: URL(fileURLWithPath: "/tmp/one-isolated"), environment: [:])
                fatalError("invalid gateway accepted")
            } catch { }
        }
        print("Codex gateway configuration isolation tests passed")
    }
}
