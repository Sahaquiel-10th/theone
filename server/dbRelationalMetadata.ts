import type { Database } from "./types.js";

export type CollectionName = Exclude<keyof Database, "settings">;
export type StoredRecord = { id: string; workspaceId?: string; userId?: string; [key: string]: unknown };

export function relationalRecordMetadata(collection: CollectionName, item: StoredRecord, db: Database) {
  return {
    workspaceId: recordWorkspaceId(collection, item, db),
    userId: recordUserId(collection, item),
    parentId: recordParentId(collection, item),
    lookupKey: recordLookupKey(collection, item)
  };
}

function recordWorkspaceId(collection: CollectionName, item: StoredRecord, db: Database): string | null {
  if (typeof item.workspaceId === "string" && item.workspaceId) return item.workspaceId;
  if (collection === "workspaces") return item.id;
  if (collection === "users" && typeof item.defaultWorkspaceId === "string") return item.defaultWorkspaceId;
  if ((collection === "deviceChallenges" || collection === "oneTimeLoginCodes") && typeof item.deviceId === "string") {
    return db.oneKeyDevices.find((device) => device.id === item.deviceId)?.workspaceId ?? null;
  }
  if (collection === "executionEvents" && typeof item.taskId === "string") {
    return db.executionTasks.find((task) => task.id === item.taskId)?.workspaceId ?? null;
  }
  return null;
}

function recordUserId(collection: CollectionName, item: StoredRecord): string | null {
  if (typeof item.userId === "string" && item.userId) return item.userId;
  if (collection === "users") return item.id;
  if (typeof item.ownerId === "string" && item.ownerId) return item.ownerId;
  if (typeof item.actorUserId === "string" && item.actorUserId) return item.actorUserId;
  return null;
}

function recordParentId(collection: CollectionName, item: StoredRecord): string | null {
  const fields = collection === "messages" || collection === "retrievalLogs" || collection === "contextTraces" || collection === "modelUsageRecords" || collection === "attachments"
    ? ["conversationId"]
    : collection === "deviceChallenges" || collection === "oneTimeLoginCodes" ? ["deviceId"]
    : collection === "executionEvents" ? ["taskId"] : [];
  const value = fields.length ? item[fields[0]] : undefined;
  return typeof value === "string" && value ? value : null;
}

function recordLookupKey(collection: CollectionName, item: StoredRecord): string | null {
  if (collection === "users" && typeof item.username === "string") return item.username.trim().toLowerCase();
  if (collection === "workspaces" && typeof item.slug === "string") return item.slug.trim().toLowerCase();
  if (collection === "workspaceMembers" && typeof item.workspaceId === "string" && typeof item.userId === "string") return `${item.workspaceId}:${item.userId}`;
  if (collection === "knowledgeConnections" && typeof item.workspaceId === "string" && typeof item.provider === "string") return `${item.workspaceId}:${item.provider}`;
  if (collection === "connectorAuthorizationSessions" && typeof item.stateHash === "string" && item.stateHash) return `${item.connectorId}:${item.stateHash}`;
  if (collection === "oneKeyDevices" && typeof item.serialNumber === "string") return item.serialNumber.trim();
  if (collection === "oneTimeLoginCodes" && typeof item.tokenHash === "string") return item.tokenHash;
  if (collection === "powerAccounts" && typeof item.workspaceId === "string" && typeof item.userId === "string") return `${item.workspaceId}:${item.userId}`;
  return null;
}
