// Public OAuth application used by @getnote/cli's production device flow.
// This is an application identifier, never an API key. Keep legacy personal
// GETNOTE_CLIENT_ID separate: it belongs only to administrator test-connect.
export const GETNOTE_CLI_OAUTH_CLIENT_ID = "cli_a1b2c3d4e5f6789012345678abcdef90";

export function getNoteOAuthClientId(env: Record<string, string | undefined> = process.env): string {
  return env.GETNOTE_OAUTH_CLIENT_ID?.trim() || GETNOTE_CLI_OAUTH_CLIENT_ID;
}
