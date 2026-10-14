import express, { type Express, type RequestHandler } from "express";
import type { Store } from "./db.js";
import { accountInScope, accountProfile, updateAccountProfile, type AccountScope } from "./betaProfile.js";
import { asyncRoute } from "./middleware.js";
import { onboardingHandbookOffer, resolvedOnboardingHandbookProfile, startOnboardingHandbook, type OnboardingImageInput } from "./onboardingHandbook.js";

export type OnboardingProfileDependencies = {
  storageAvailable: boolean;
  verifyKey: (req: express.Request) => Promise<void>;
  enqueueImage: (scope: AccountScope, input: OnboardingImageInput, verifyKey: () => Promise<void>) => Promise<string>;
  resume: (scope: AccountScope, verifyKey: () => Promise<void>) => Promise<unknown>;
};

/** The middleware supplies the exact authenticated account; bodies cannot
 * select another user/workspace or provide a welcome image prompt. */
export function installOnboardingProfileRoutes(app: Express, keyAuth: readonly RequestHandler[], store: Store, deps: OnboardingProfileDependencies) {
  const router = express.Router();
  router.use(...keyAuth);
  router.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  const scope = (req: express.Request): AccountScope => ({ userId: req.user!.id, workspaceId: req.workspaceId! });
  router.get("/", asyncRoute(async (req, res) => {
    const db = await store.read(), current = resolvedOnboardingHandbookProfile(db, scope(req));
    res.json({ profile: current.profile, handbookNotice: current.notice, handbookOffer: onboardingHandbookOffer(db, deps.storageAvailable) });
  }));
  router.patch("/", asyncRoute(async (req, res) => {
    const s = scope(req), body = req.body ?? {};
    const savedProfile = await store.mutate(db => updateAccountProfile(db, s, { displayName: body.displayName, onboardingAction: body.onboardingAction, handbookChoice: body.handbookChoice, handbookBudgetPower: body.handbookBudgetPower }));
    let handbookNotice: string | undefined;
    if (body.onboardingAction === "complete" && body.handbookChoice === "create") {
      try {
        const result = await startOnboardingHandbook(store, s, { storageAvailable: deps.storageAvailable, verifyKey: () => deps.verifyKey(req), enqueueImage: deps.enqueueImage });
        handbookNotice = result.notice;
        // Do not wait for a model response and do not rebuild the task if its
        // runner cannot reconnect. The existing queue is the source of truth.
        if (result.handbook?.status === "queued") void deps.resume(s, () => deps.verifyKey(req)).catch(() => {});
      } catch {
        handbookNotice = "图片指南这次还没安排好，你可以先开始聊天；我不会自动再画一张。";
        // A second Key check can fail before the queue claim. Persist that
        // narrow outcome so refresh does not look like an endless pending job.
        // Never terminate another request's preparing claim or a durable task.
        const attemptedId = savedProfile.onboarding.handbook?.operationId;
        if (attemptedId) {
          try {
            await store.mutate(db => {
              const user = accountInScope(db, s), profile = accountProfile(db, s), marker = profile.onboarding.handbook;
              if (marker?.operationId !== attemptedId || marker.status !== "pending") return;
              const accepted = db.chatOperations?.some(op => op.workspaceId === s.workspaceId && op.userId === s.userId && op.operationId === `${attemptedId}_image` && op.workRun?.kind === "image" && db.conversations.some(c => c.id === op.conversationId && c.workspaceId === s.workspaceId && c.userId === s.userId));
              if (accepted) return;
              marker.status = "failed"; marker.reason = "unavailable"; marker.updatedAt = new Date().toISOString(); user.profile = profile;
            });
          } catch { /* Completing onboarding remains independent of this optional welcome task. */ }
        }
      }
    }
    const db = await store.read(), current = resolvedOnboardingHandbookProfile(db, s);
    res.json({ profile: current.profile, handbookNotice: handbookNotice || current.notice, handbookOffer: onboardingHandbookOffer(db, deps.storageAvailable) });
  }));
  app.use("/api/me/profile", router);
}
