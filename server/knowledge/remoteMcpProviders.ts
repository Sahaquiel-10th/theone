import type { RemoteMcpProviderConfig } from "./remoteMcpKnowledgeService.js";

export const flowusConfig: RemoteMcpProviderConfig = {
  provider: "flowus", label: "息流 FlowUs", mcpUrl: "https://mcp.flowus.cn/message",
  authorizationUrl: "https://api.flowus.cn/oauth/authorize", tokenUrl: "https://api.flowus.cn/oauth/token", registrationUrl: "https://api.flowus.cn/register", revokeUrl: "https://api.flowus.cn/oauth/revoke",
  hosts: ["mcp.flowus.cn", "api.flowus.cn"], sourceHosts: ["flowus.cn", "www.flowus.cn"], scope: "all",
  // FlowUs currently exposes scope=all. The reviewed adapter still refuses every write tool.
  readOnlyTools: ["search", "search_pages", "search_documents", "query", "fetch", "get_page", "read_page", "get_document"], searchTools: ["search", "search_pages", "search_documents", "query"], fetchTools: ["fetch", "get_page", "read_page", "get_document"], envPrefix: "FLOWUS_MCP"
};
