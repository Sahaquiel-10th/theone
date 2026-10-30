import type { Express, Request, RequestHandler, Response } from 'express';
import type { Store } from './db.js';
import { asyncRoute } from './middleware.js';
import type { TeachingScope } from './teachingTypes.js';
import { TeachingError, activeTeachingCourse, addTeachingSubmission, authTeachingSession, closeTeachingCourse, createTeachingActivity, createTeachingCourse, createTeachingSession, listTeachingCourses, ownedTeachingCourse, publicTeachingCourse, publicTeachingSession, publicTeachingSubmission, publishTeachingCourse, reviewTeachingSubmission, teachingSubmissions, updateTeachingActivity, updateTeachingCourse } from './teaching.js';

type Dependencies = { verifyKey?: (req: Request) => Promise<void> };
const scope = (req: Request): TeachingScope => {
  if (!req.user?.id || !req.workspaceId) throw new TeachingError('请登录后管理课程', 401, 'TEACHING_AUTH_REQUIRED');
  return { userId: req.user.id, workspaceId: req.workspaceId };
};
export function teachingBearer(req: Request) { return req.get('Authorization')?.match(/^Bearer ([A-Za-z0-9_-]{40,100})$/)?.[1] ?? ''; }
function route(fn: (req: Request, res: Response) => Promise<unknown>) {
  return asyncRoute(async (req, res) => {
    // A closed course and a student's grades must not survive in intermediary caches.
    res.setHeader('Cache-Control', 'no-store');
    try { return await fn(req, res); }
    catch (error) {
      if (error instanceof TeachingError) return res.status(error.status).json({ error: error.message, code: error.code });
      throw error;
    }
  });
}

export function installTeachingRoutes(app: Express, keyAuth: readonly RequestHandler[], store: Store, deps: Dependencies = {}) {
  const base = '/api/teaching/courses', pub = '/api/teaching/public/:slug';
  const verify = async (req: Request) => { await deps.verifyKey?.(req); };
  // Course-wide rate limits accommodate a whole classroom arriving behind one NAT.
  // These protect identity/storage endpoints only; AI concurrency and budgets are separate.
  const rates = new Map<string, { at: number; count: number }>();
  function classroomRate(req: Request, lane: string) {
    const at = Date.now(), key = `${String(req.params.slug)}:${lane}`;
    let window = rates.get(key);
    if (!window || at - window.at >= 60000) {
      if (!window && rates.size >= 10000) { for (const [k, value] of rates) if (at - value.at > 60000) rates.delete(k); }
      if (!window && rates.size >= 10000) throw new TeachingError('课程访问较集中，请稍后重试', 429, 'TEACHING_RATE_LIMIT');
      window = { at, count: 0 }; rates.set(key, window);
    }
    if (++window.count > 1200) throw new TeachingError('本班访问较集中，请稍后重试', 429, 'TEACHING_RATE_LIMIT');
    if (rates.size > 10000) for (const [k, value] of rates) if (at - value.at > 60000) rates.delete(k);
  }

  app.get(base, ...keyAuth, route(async (req, res) => res.json({ courses: listTeachingCourses(await store.read(), scope(req)) })));
  app.post(base, ...keyAuth, route(async (req, res) => {
    await verify(req); const course = await store.mutate(db => createTeachingCourse(db, scope(req), req.body)); return res.status(201).json({ course });
  }));
  app.get(base + '/:id', ...keyAuth, route(async (req, res) => res.json({ course: ownedTeachingCourse(await store.read(), scope(req), String(req.params.id)) })));
  app.patch(base + '/:id', ...keyAuth, route(async (req, res) => {
    await verify(req); return res.json({ course: await store.mutate(db => updateTeachingCourse(db, scope(req), String(req.params.id), req.body)) });
  }));
  app.post(base + '/:id/publish', ...keyAuth, route(async (req, res) => {
    await verify(req); return res.json({ course: await store.mutate(db => publishTeachingCourse(db, scope(req), String(req.params.id), req.body)) });
  }));
  app.post(base + '/:id/close', ...keyAuth, route(async (req, res) => {
    await verify(req); return res.json({ course: await store.mutate(db => closeTeachingCourse(db, scope(req), String(req.params.id), req.body)) });
  }));
  app.post(base + '/:id/activities', ...keyAuth, route(async (req, res) => {
    await verify(req); return res.status(201).json(await store.mutate(db => createTeachingActivity(db, scope(req), String(req.params.id), req.body)));
  }));
  app.patch(base + '/:id/activities/:activityId', ...keyAuth, route(async (req, res) => {
    await verify(req); return res.json(await store.mutate(db => updateTeachingActivity(db, scope(req), String(req.params.id), String(req.params.activityId), req.body)));
  }));
  app.get(base + '/:id/submissions', ...keyAuth, route(async (req, res) => res.json({ submissions: teachingSubmissions(await store.read(), scope(req), String(req.params.id)) })));
  app.post(base + '/:id/submissions', ...keyAuth, route(async (req, res) => {
    await verify(req);
    const result = await store.mutate(db => { const s = scope(req), course = ownedTeachingCourse(db, s, String(req.params.id)); return addTeachingSubmission(db, s, course, req.body); });
    return res.status(result.duplicate ? 200 : 201).json({ submission: result.submission });
  }));
  app.patch(base + '/:id/submissions/:submissionId/review', ...keyAuth, route(async (req, res) => {
    await verify(req);
    return res.json({ submission: await store.mutate(db => reviewTeachingSubmission(db, scope(req), String(req.params.id), String(req.params.submissionId), req.body?.grade)) });
  }));

  app.get(pub, route(async (req, res) => { classroomRate(req, 'read'); return res.json({ course: publicTeachingCourse(activeTeachingCourse(await store.read(), String(req.params.slug))) }); }));
  app.post(pub + '/sessions', route(async (req, res) => {
    classroomRate(req, 'sessions');
    return res.status(201).json(await store.mutate(db => createTeachingSession(db, String(req.params.slug), req.body)));
  }));
  app.get(pub + '/session', route(async (req, res) => {
    classroomRate(req, 'session-read');
    const { session } = authTeachingSession(await store.read(), String(req.params.slug), teachingBearer(req)); return res.json({ session: publicTeachingSession(session) });
  }));
  app.get(pub + '/submissions', route(async (req, res) => {
    classroomRate(req, 'submission-read');
    const { course, session, scope: s } = authTeachingSession(await store.read(), String(req.params.slug), teachingBearer(req));
    return res.json({ submissions: teachingSubmissions(await store.read(), s, course.id).filter(item => item.sessionId === session.id).map(publicTeachingSubmission) });
  }));
  app.post(pub + '/submissions', route(async (req, res) => {
    classroomRate(req, 'submissions');
    const result = await store.mutate(db => { const { course, session, scope: s } = authTeachingSession(db, String(req.params.slug), teachingBearer(req)); return addTeachingSubmission(db, s, course, req.body, session); });
    return res.status(result.duplicate ? 200 : 201).json({ submission: publicTeachingSubmission(result.submission) });
  }));
}
