import type { Database, User } from "./types.js";
import { uid } from "./security.js";

export type OnboardingHandbook = {
  fixedWorkflow?:import('./fixedWorkflows.js').FixedWorkflowInvocation;
  funding?: 'one' | 'customer';
  operationId: string;
  status: "pending" | "preparing" | "queued" | "skipped" | "failed";
  requestedAt: string;
  updatedAt: string;
  /** Customer-disclosed ceiling, or ONE's server-side ceiling for its first gift. */
  maxPower: number;
  taskId?: string;
  pricePower?: number;
  reason?: "not_configured" | "budget_required" | "insufficient_power" | "billing_review" | "unavailable";
};

export type AppearanceScene = "graphite" | "silver";
export type AccountAppearance = { scene: AppearanceScene };

export type AccountProfile = {
  workspaceId: string;
  displayName: string;
  /** Account-bound appearance, independent of the temporary execution state. */
  appearance?: AccountAppearance;
  onboarding: {
    nameSetAt?: string;
    knowledgeChoice: "pending" | "connected" | "skipped";
    knowledgeStepAt?: string;
    completedAt?: string;
    /** One server-allocated welcome gift, retained across setup restarts. */
    welcomeGiftOperationId?: string;
    /** A new explicit welcome-flow choice, never inferred for existing accounts. */
    handbook?: OnboardingHandbook;
    journey?: import('./onboardingJourney.js').OnboardingJourney;
    journeyHistory?: import('./onboardingJourney.js').OnboardingJourney[];
    practice?: import('./onboardingPractice.js').OnboardingPractice;
  };
  updatedAt: string;
};

export type AccountScope = { userId: string; workspaceId: string };
export type ProfilePatch = {
  displayName?: unknown;
  appearance?: unknown;
  onboardingAction?: unknown;
  handbookChoice?: unknown;
  handbookBudgetPower?: unknown;
};

export class BetaInputError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "INVALID_BETA_INPUT") { super(message); }
}

/** The scope must come from authenticated server state, never directly from a body. */
export function accountInScope(db: Database, scope: AccountScope): User & { profile?: AccountProfile } {
  const user = db.users.find((item) => item.id === scope.userId && item.enabled && item.defaultWorkspaceId === scope.workspaceId);
  const workspace = db.workspaces.find((item) => item.id === scope.workspaceId && item.status === "active");
  const membership = db.workspaceMembers.some((item) => item.status !== "disabled" && item.userId === scope.userId && item.workspaceId === scope.workspaceId);
  if (!user || !workspace || !membership) throw new BetaInputError("账号空间不存在或无权访问", 403, "WORKSPACE_FORBIDDEN");
  return user;
}

export function accountProfile(db: Database, scope: AccountScope): AccountProfile {
  const user = accountInScope(db, scope);
  if (user.profile && user.profile.workspaceId === scope.workspaceId) return structuredClone(user.profile);
  return { workspaceId: scope.workspaceId, displayName: "", onboarding: { knowledgeChoice: "pending" }, updatedAt: user.createdAt };
}

/** Practice metadata contains private source/goal information. It is available
 * only through the current owner's dedicated, live-verified practice API. */
export function publicAccountProfile(profile:AccountProfile):AccountProfile{
  const safe=structuredClone(profile);delete safe.onboarding.practice;return safe;
}

export function onboardingStep(profile: AccountProfile): "name" | "knowledge" | "ready" | "complete" {
  if (profile.onboarding.completedAt) return "complete";
  if (!profile.displayName || !profile.onboarding.nameSetAt) return "name";
  if (profile.onboarding.knowledgeChoice === "pending") return "knowledge";
  return "ready";
}

/** A submitted chat skips the welcome flow without inventing a name or a connection. */
export function completeOnboardingOnChat(db: Database, scope: AccountScope, timestamp = new Date().toISOString()) {
  const user = accountInScope(db, scope);
  const profile = accountProfile(db, scope);
  if (profile.onboarding.completedAt) return;
  if (profile.onboarding.journey?.experience === 5 && profile.onboarding.journey.stage !== 'complete') return;
  profile.onboarding.completedAt = timestamp;
  profile.updatedAt = timestamp;
  user.profile = profile;
}

export function updateAccountProfile(db: Database, scope: AccountScope, patch: ProfilePatch, currentTime = new Date().toISOString()) {
  const user = accountInScope(db, scope);
  const profile = accountProfile(db, scope);
  if (!patch || typeof patch !== "object") throw new BetaInputError("请填写要更新的资料");
  if (patch.displayName !== undefined) {
    if (typeof patch.displayName !== "string") throw new BetaInputError("请填写你的称呼");
    const name = patch.displayName.normalize("NFC").trim();
    if (!name || [...name].length > 40 || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(name)) {
      throw new BetaInputError("称呼请使用 1–40 个可见字符，不要包含换行或控制字符");
    }
    profile.displayName = name;
    profile.onboarding.nameSetAt ||= currentTime;
  }
  if (patch.appearance !== undefined) {
    const value = patch.appearance;
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => key !== "scene") || !("scene" in value) || (value.scene !== "graphite" && value.scene !== "silver")) {
      throw new BetaInputError("请选择石墨框景或浅银光场");
    }
    profile.appearance = { scene: value.scene };
  }
  if (patch.onboardingAction !== undefined) {
    if(patch.onboardingAction==='complete'&&profile.onboarding.journey&&profile.onboarding.journey.stage!=='complete')throw new BetaInputError('请从当前新手引导的最后一步完成。',409);
    if (typeof patch.onboardingAction !== "string" || !["knowledge_connected", "knowledge_skipped", "complete"].includes(patch.onboardingAction)) {
      throw new BetaInputError("引导步骤无效");
    }
    if (!profile.onboarding.nameSetAt || !profile.displayName) throw new BetaInputError("先告诉 ONE 应该怎么称呼你");
    if (patch.onboardingAction === "knowledge_connected") {
      if (!db.knowledgeConnections.some((item) => item.workspaceId === scope.workspaceId && item.status === "connected")) {
        throw new BetaInputError("还没有连接知识来源，也可以选择稍后连接");
      }
      profile.onboarding.knowledgeChoice = "connected";
      profile.onboarding.knowledgeStepAt = currentTime;
    } else if (patch.onboardingAction === "knowledge_skipped") {
      profile.onboarding.knowledgeChoice = "skipped";
      profile.onboarding.knowledgeStepAt = currentTime;
    } else {
      if (profile.onboarding.knowledgeChoice === "pending") throw new BetaInputError("请连接一个知识来源，或选择稍后连接");
      if (patch.handbookChoice !== undefined && (typeof patch.handbookChoice !== "string" || !["create", "skip"].includes(patch.handbookChoice))) throw new BetaInputError("请选择是否制作你的图片指南");
      if (patch.handbookChoice === "create" && (typeof patch.handbookBudgetPower !== "number" || !Number.isFinite(patch.handbookBudgetPower) || patch.handbookBudgetPower <= 0 || patch.handbookBudgetPower > .5)) throw new BetaInputError("图片指南的额度上限需要先确认");
      // Existing accounts or users who already started a conversation must
      // never receive a surprise paid task after this feature is deployed.
      const firstWelcome = !profile.onboarding.completedAt && !(db.conversations ?? []).some(c => c.workspaceId === scope.workspaceId && c.userId === scope.userId);
      if (firstWelcome && patch.handbookChoice === "create" && !profile.onboarding.handbook) {
        profile.onboarding.handbook = { operationId: uid("welcome"), status: "pending", maxPower: patch.handbookBudgetPower as number, requestedAt: currentTime, updatedAt: currentTime };
      }
      profile.onboarding.completedAt ||= currentTime;
    }
  }
  if (patch.handbookChoice !== undefined && patch.onboardingAction !== "complete") throw new BetaInputError("图片指南只会在首次引导完成时安排");
  if (patch.handbookBudgetPower !== undefined && (patch.onboardingAction !== "complete" || patch.handbookChoice !== "create")) throw new BetaInputError("图片指南的额度上限只用于这次首次引导");
  if (patch.displayName === undefined && patch.onboardingAction === undefined && patch.appearance === undefined) throw new BetaInputError("没有要更新的资料");
  profile.updatedAt = currentTime;
  user.profile = profile;
  return structuredClone(profile);
}
