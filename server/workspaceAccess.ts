import { Database, User } from "./types.js";
import { activeMember } from "./enterprisePolicy.js";

export function resolveWorkspaceAccess(database: Database, user: User, requestedWorkspaceId?: string) {
  const workspaceId = requestedWorkspaceId?.trim() || user.defaultWorkspaceId;
  const membership = activeMember(database, { userId: user.id, workspaceId });
  const workspace = database.workspaces.find(
    (item) => item.id === workspaceId && item.status === "active"
  );
  return membership && workspace ? { workspaceId, membership, workspace } : null;
}
