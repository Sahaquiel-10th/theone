import type { Database, WorkspaceMember } from "./types.js";
import type { OfficialFeatureRecord } from "./officialFeatures.js";

export type EnterpriseScope = { workspaceId: string; userId: string };
export function activeMember(db: Database, scope: EnterpriseScope): WorkspaceMember | undefined {
  return db.workspaceMembers.find(m => m.workspaceId === scope.workspaceId && m.userId === scope.userId && m.status !== "disabled");
}
export function companyWorkspace(db: Database, workspaceId: string) {
  return db.workspaces?.find(w => w.id === workspaceId && w.kind === "company");
}
export function billingAccountUserId(db: Database, workspaceId: string, userId: string) {
  return companyWorkspace(db, workspaceId) ? `company:${workspaceId}` : userId;
}
export function canReadKnowledge(db: Database, scope: EnterpriseScope, connectionId: string) {
  const member = activeMember(db, scope);
  if (!member || !db.users.some(u => u.id === scope.userId && u.enabled) || !db.workspaces.some(w => w.id === scope.workspaceId && w.status === "active")) return false;
  if (!db.knowledgeConnections.some(c => c.id === connectionId && c.workspaceId === scope.workspaceId)) return false;
  return !companyWorkspace(db, scope.workspaceId) || member.role === "owner" || !!member.permissions?.knowledgeConnectionIds.includes(connectionId);
}
export function featureEntitled(db: Database, scope: EnterpriseScope, f: OfficialFeatureRecord) {
  const member = activeMember(db, scope);
  if (!member || !db.users.some(u => u.id === scope.userId && u.enabled) || !db.workspaces.some(w => w.id === scope.workspaceId && w.status === "active")) return false;
  if (f.workspaceId && f.workspaceId !== scope.workspaceId) return false;
  if (companyWorkspace(db, scope.workspaceId)) {
    return !!f.companyReleases?.some(r=>r.workspaceId===scope.workspaceId) && (member.role === "owner" || !!member.permissions?.featureIds.includes(f.id));
  }
  return !f.workspaceId && !!f.release?.userIds.includes(scope.userId);
}
export function featureRelease(db: Database, scope: EnterpriseScope, f: OfficialFeatureRecord) {
  if(companyWorkspace(db,scope.workspaceId)) {
    const release=f.companyReleases?.find(r=>r.workspaceId===scope.workspaceId);
    return release ? {...release,userIds:[] as string[]} : undefined;
  }
  return f.release;
}
export function publicSharingAllowed(db: Database, workspaceId: string) {
  const company = companyWorkspace(db, workspaceId);
  return !company || company.company?.allowPublicSharing === true;
}
export function identityAccess(db: Database, scope: EnterpriseScope) {
  const member = activeMember(db, scope), user = db.users.find(u => u.id === scope.userId && u.enabled);
  const workspace = db.workspaces.find(w => w.id === scope.workspaceId && w.status === "active");
  if (!member || !user || !workspace) throw new Error("账号或空间授权已失效");
  return { workspaceId: workspace.id, workspaceName: workspace.name, kind: workspace.kind ?? "personal", role: user.role === "admin" ? "platform_admin" : workspace.kind === "company" && member.role === "owner" ? "company_admin" : workspace.kind === "company" ? "employee" : "personal" } as const;
}
