import { Database, User } from "./types.js";

export function resolveWorkspaceAccess(database: Database, user: User, requestedWorkspaceId?: string) {
  const workspaceId = requestedWorkspaceId?.trim() || user.defaultWorkspaceId;
  const membership = database.workspaceMembers.find(
    (item) => item.userId === user.id && item.workspaceId === workspaceId
  );
  const workspace = database.workspaces.find(
    (item) => item.id === workspaceId && item.status === "active"
  );
  return membership && workspace ? { workspaceId, membership, workspace } : null;
}
