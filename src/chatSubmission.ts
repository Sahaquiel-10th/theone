type Submission = { operationId: string; fingerprint: string; createdAt: string };
const key = (userId: string) => `one.pending-chat:${userId}`;
export function pendingChatSubmissions(userId: string): Submission[] {
  let stored: Submission[] = [];
  try { const values = JSON.parse(sessionStorage.getItem(key(userId)) || "[]"); stored = Array.isArray(values) ? values.filter(item => item && typeof item.operationId === "string" && typeof item.fingerprint === "string").slice(-50) : []; } catch { /* Browser storage is optional. */ }
  return [...new Map([...stored, ...(volatile.get(userId) || [])].map(item => [item.operationId, item])).values()];
}
function save(userId: string, values: Submission[]) {
  // Save only a hash and request identifier, never prompts, files or credentials.
  try { sessionStorage.setItem(key(userId), JSON.stringify(values.slice(-50))); } catch { /* In-memory caller still retains the operation ID. */ }
}
const volatile = new Map<string, Submission[]>();
export async function chatSubmission(userId: string, payload: unknown) {
  const fingerprint = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(payload))))].map(n => n.toString(16).padStart(2, "0")).join("");
  const values = pendingChatSubmissions(userId);
  const existing = values.find(item => item.fingerprint === fingerprint);
  if (existing) return existing.operationId;
  if (values.length >= 50) throw new Error("尚未确认的消息较多，请先查看原结果后再继续，避免重复提交。");
  const value = { operationId: crypto.randomUUID(), fingerprint, createdAt: new Date().toISOString() };
  const next = [...values, value]; volatile.set(userId, next); save(userId, next);
  return value.operationId;
}
export function forgetChatSubmission(userId: string, operationId: string) {
  volatile.set(userId, (volatile.get(userId) || []).filter(item => item.operationId !== operationId));
  save(userId, pendingChatSubmissions(userId).filter(item => item.operationId !== operationId));
}
