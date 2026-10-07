import type { RemoteMcpProviderConfig } from "./remoteMcpKnowledgeService.js";

export const flowusConfig: RemoteMcpProviderConfig = {
  provider: "flowus", label: "息流 FlowUs", mcpUrl: "https://mcp.flowus.cn/message",
  authorizationUrl: "https://api.flowus.cn/oauth/authorize", tokenUrl: "https://api.flowus.cn/oauth/token", registrationUrl: "https://api.flowus.cn/register", revokeUrl: "https://api.flowus.cn/oauth/revoke",
  hosts: ["mcp.flowus.cn", "api.flowus.cn"], sourceHosts: ["flowus.cn", "www.flowus.cn"], scope: "all",
  // FlowUs currently exposes scope=all. The reviewed adapter still refuses every write tool.
  readOnlyTools: ["search", "search_pages", "search_documents", "query", "fetch", "get_page", "read_page", "get_document"], searchTools: ["search", "search_pages", "search_documents", "query"], fetchTools: ["fetch", "get_page", "read_page", "get_document"], envPrefix: "FLOWUS_MCP"
};

export const flomoConfig: RemoteMcpProviderConfig = {
  provider: "flomo", label: "flomo", mcpUrl: "https://flomoapp.com/mcp",
  authorizationUrl: "https://flomoapp.com/integration/grant", tokenUrl: "https://flomoapp.com/oauth/token",
  registrationUrl: "https://flomoapp.com/oauth/register", revokeUrl: "https://flomoapp.com/oauth/revoke",
  hosts: ["flomoapp.com"], sourceHosts: ["flomoapp.com", "v.flomoapp.com"], scope: "mcp",
  // OAuth grants the broader MCP scope. ONE never invokes the provider's write tools.
  readOnlyTools: ["memo_search", "memo_batch_get"], searchTools: ["memo_search"], fetchTools: ["memo_batch_get"],
  requiredTools: ["memo_search", "memo_batch_get"], envPrefix: "FLOMO_MCP"
};
