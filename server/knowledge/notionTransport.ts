import { Agent } from 'undici';
import { assertAllowedConnectorUrl } from '../connectors/securityPolicy.js';

// Resolve all current DNS addresses instead of relying on one unhealthy edge.
// This is connection establishment, not HTTP retry: sent writes are never replayed.
// Keep the original hostname, SNI, certificate verification and redirect denial.
export const notionTransportOptions = {
  autoSelectFamily: true,
  autoSelectFamilyAttemptTimeout: 750,
  connect: { timeout: 10_000 },
} as const;
const dispatcher = new Agent(notionTransportOptions);

export function createNotionFetch(fetcher: typeof fetch = fetch): typeof fetch {
  return (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    assertAllowedConnectorUrl(url, ['mcp.notion.com']);
    return fetcher(input, { ...init, redirect: 'error', dispatcher } as RequestInit);
  };
}
