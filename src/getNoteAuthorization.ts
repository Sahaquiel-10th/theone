export type GetNotePollFailureAction = "retry_key" | "retry_provider" | "end";

type ApiLikeError = {
  status?: number;
  code?: string;
  retryable?: boolean;
};

export function getNotePollFailureAction(error: unknown): GetNotePollFailureAction {
  const value = error && typeof error === "object" ? error as ApiLikeError : {};
  if (value.status === 428 || value.code === "ONE_KEY_REQUIRED" || value.code === "ONE_KEY_UPGRADE_REQUIRED") return "retry_key";
  if (value.retryable === true || value.status === 429 || ["POLL_TOO_FAST", "GETNOTE_RATE_LIMITED", "GETNOTE_UNAVAILABLE"].includes(value.code || "")) return "retry_provider";
  return "end";
}

export type PreparedAuthorizationWindow = {
  closed: boolean;
  opener: unknown;
  location: { replace(url: string): void };
  close(): void;
};

export function prepareGetNoteAuthorizationWindow(openWindow: (url: string, target: string) => PreparedAuthorizationWindow | null) {
  const authorizationWindow = openWindow("about:blank", "one-getnote-authorization");
  if (authorizationWindow) authorizationWindow.opener = null;
  return authorizationWindow;
}
