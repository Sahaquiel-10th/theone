import type { Express, Request, RequestHandler, Response } from 'express';
import type { Store } from './db.js';
import { asyncRoute } from './middleware.js';
import type { TeachingScope } from './teachingTypes.js';
import { TeachingError, activeTeachingAccess, activeTeachingCourse, addTeachingSubmission, authTeachingSession, bindTeachingGradingBasis, closeTeachingCourse, createTeachingActivity, createTeachingCourse, createTeachingSession, createTeachingTask, listTeachingCourses, ownedTeachingCourse, publicTeachingCourse, publicTeachingSession, publicTeachingSubmission, publishTeachingCourse, reviewTeachingSubmission, teachingSubmissions, teachingState, teachingCourseView, teachingSessionActivity, updateTeachingActivity, updateTeachingCourse, updateTeachingGrading } from './teaching.js';
import {listTeachingTrash,mutateTeachingTrash,setTeachingActivityOpen} from './teachingLifecycle.js';
import {cleanTeachingPurgeFiles,commitTeachingPurge,ownedTeachingPurge,previewTeachingPurge,publicTeachingPurge} from './teachingPurge.js';
import { publicTeachingGameConfig, teachingGameHistory, teachingGameSnapshot, updateTeachingGameConfig } from './teachingGames.js';

type Dependencies = { verifyKey?: (req: Request) => Promise<void>;directory?:string;purgeRemoveFiles?:(storagePath:string)=>Promise<void> };
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

  app.post('/api/teaching/tasks', ...keyAuth, route(async (req, res) => {
    await verify(req);
    const result = await store.mutate(db => createTeachingTask(db, scope(req), req.body));
    return res.status(result.duplicate ? 200 : 201).json({ course: teachingCourseView(result.course), activity: result.activity });
  }));
  app.get(base, ...keyAuth, route(async (req, res) => res.json({ courses: listTeachingCourses(await store.read(), scope(req)) })));
  app.post(base, ...keyAuth, route(async (req, res) => {
    await verify(req); const result = await store.mutate(db => { const owned = scope(req), previous = new Set(listTeachingCourses(db, owned).map(course => course.id)), course = createTeachingCourse(db, owned, req.body); return { course, duplicate: previous.has(course.id) }; }); return res.status(result.duplicate ? 200 : 201).json({ course: teachingCourseView(result.course) });
  }));
  app.get(base + '/:id', ...keyAuth, route(async (req, res) => res.json({ course: teachingCourseView(ownedTeachingCourse(await store.read(), scope(req), String(req.params.id))) })));
  app.patch(base + '/:id', ...keyAuth, route(async (req, res) => {
    await verify(req); return res.json({ course: teachingCourseView(await store.mutate(db => updateTeachingCourse(db, scope(req), String(req.params.id), req.body))) });
  }));
  app.post(base + '/:id/publish', ...keyAuth, route(async (req, res) => {
    await verify(req); return res.json({ course: teachingCourseView(await store.mutate(db => publishTeachingCourse(db, scope(req), String(req.params.id), req.body))) });
  }));
  app.post(base + '/:id/close', ...keyAuth, route(async (req, res) => {
    await verify(req); return res.json({ course: teachingCourseView(await store.mutate(db => closeTeachingCourse(db, scope(req), String(req.params.id), req.body))) });
  }));
  app.post(base + '/:id/activities', ...keyAuth, route(async (req, res) => {
    await verify(req); const result=await store.mutate(db => createTeachingActivity(db, scope(req), String(req.params.id), req.body)); return res.status(result.duplicate?200:201).json({...result,course:teachingCourseView(result.course)});
  }));
  app.patch(base + '/:id/activities/:activityId', ...keyAuth, route(async (req, res) => {
    await verify(req); const result=await store.mutate(db => updateTeachingActivity(db, scope(req), String(req.params.id), String(req.params.activityId), req.body)); return res.json({...result,course:teachingCourseView(result.course)});
  }));
  app.patch(base + '/:id/activities/:activityId/grading', ...keyAuth, route(async (req, res) => {
    await verify(req); const result=await store.mutate(db => updateTeachingGrading(db, scope(req), String(req.params.id), String(req.params.activityId), req.body)); return res.json({...result,course:teachingCourseView(result.course)});
  }));
  for (const open of [true,false]) app.post(base + '/:id/activities/:activityId/' + (open?'open':'close'), ...keyAuth, route(async(req,res)=>{
    await verify(req); return res.json(await store.mutate(db=>setTeachingActivityOpen(db,scope(req),String(req.params.id),String(req.params.activityId),req.body,open)));
  }));
  app.get('/api/teaching/trash', ...keyAuth, route(async(req,res)=>res.json(listTeachingTrash(await store.read(),scope(req)))));
  app.post('/api/teaching/purge/preview',...keyAuth,route(async(req,res)=>res.json(previewTeachingPurge(await store.read(),scope(req),req.body))));
  app.get('/api/teaching/purge/:requestId',...keyAuth,route(async(req,res)=>res.json({purge:publicTeachingPurge(ownedTeachingPurge(await store.read(),scope(req),String(req.params.requestId)))})));
  app.post('/api/teaching/purge',...keyAuth,route(async(req,res)=>{
    await verify(req);const owner=scope(req),receipt=await store.mutate(db=>commitTeachingPurge(db,owner,req.body,{directoryAvailable:Boolean(deps.directory)}));
    if(receipt.status==='files_pending'&&deps.directory){try{return res.json({purge:await cleanTeachingPurgeFiles(store,owner,receipt.requestId,deps.directory,deps.purgeRemoveFiles)});}catch{/* A durable private journal remains available for explicit reconciliation. */}}
    return res.json({purge:publicTeachingPurge(ownedTeachingPurge(await store.read(),owner,receipt.requestId))});
  }));
  for (const restore of [false,true]) {
    app.post('/api/teaching/' + (restore?'restore':'trash'), ...keyAuth, route(async(req,res)=>{ await verify(req); return res.json(await store.mutate(db=>mutateTeachingTrash(db,scope(req),req.body,restore))); }));
    for (const child of [false,true]) {
      const url=base+'/:id'+(child?'/activities/:activityId':'')+(restore?'/restore':'');
      const handler=route(async(req,res)=>{ await verify(req); const result=await store.mutate(db=>{const owned=scope(req),courseId=String(req.params.id),activityId=child?String(req.params.activityId):undefined;const changed=mutateTeachingTrash(db,owned,{confirmed:req.body?.confirmed,items:[{courseId,revision:req.body?.revision,...(child?{activityId,activityRevision:req.body?.activityRevision}:{})}]},restore); const raw=teachingState(db,owned).courses.find(row=>row.id===courseId&&row.workspaceId===owned.workspaceId&&row.userId===owned.userId)!;return {course:teachingCourseView(raw),...(child?{activity:changed.activities[0].activity}:{})};}); return res.json(result);});
      if(restore)app.post(url,...keyAuth,handler);else app.delete(url,...keyAuth,handler);
    }
  }
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
  app.post(base + '/:id/submissions/:submissionId/grading-basis', ...keyAuth, route(async (req, res) => {
    await verify(req);
    return res.json({ submission: await store.mutate(db => bindTeachingGradingBasis(db, scope(req), String(req.params.id), String(req.params.submissionId), req.body)) });
  }));

  app.get(pub, route(async (req, res) => { classroomRate(req, 'read'); const found=activeTeachingAccess(await store.read(),String(req.params.slug)); return res.json({course:publicTeachingCourse(found.course,found.activity?.id)}); }));
  app.post(pub + '/sessions', route(async (req, res) => {
    classroomRate(req, 'sessions');
    return res.status(201).json(await store.mutate(db => createTeachingSession(db, String(req.params.slug), req.body)));
  }));
  app.get(pub + '/session', route(async (req, res) => {
    classroomRate(req, 'session-read');
    const { session } = authTeachingSession(await store.read(), String(req.params.slug), teachingBearer(req)); return res.json({ session: publicTeachingSession(session) });
  }));
  app.get(pub + '/activities/:activityId/game', route(async (req, res) => {
    classroomRate(req, 'game-read');
    const db = await store.read(), { course, session, scope: s } = authTeachingSession(db, String(req.params.slug), teachingBearer(req));
    const config = teachingGameSnapshot(db, s, course.id, String(req.params.activityId), session.id);
    return res.json({ config: publicTeachingGameConfig(config), history: teachingGameHistory(db, s, course.id, String(req.params.activityId), session.id) });
  }));
  app.patch(pub + '/activities/:activityId/game', route(async (req, res) => {
    classroomRate(req, 'game-save');
    return res.json(await store.mutate(db => {
      const { course, session, scope: s } = authTeachingSession(db, String(req.params.slug), teachingBearer(req));
      const config = updateTeachingGameConfig(db, s, course.id, String(req.params.activityId), session.id, req.body);
      return { config: publicTeachingGameConfig(config), history: teachingGameHistory(db, s, course.id, String(req.params.activityId), session.id) };
    }));
  }));
  app.get(pub + '/submissions', route(async (req, res) => {
    classroomRate(req, 'submission-read');
    const { course, session, scope: s } = authTeachingSession(await store.read(), String(req.params.slug), teachingBearer(req));
    return res.json({ submissions: teachingSubmissions(await store.read(), s, course.id).filter(item => {if(item.sessionId!==session.id)return false;try{teachingSessionActivity(course,session,item.activityId);return true;}catch{return false;}}).map(publicTeachingSubmission) });
  }));
  app.post(pub + '/submissions', route(async (req, res) => {
    classroomRate(req, 'submissions');
    const result = await store.mutate(db => { const { course, session, scope: s } = authTeachingSession(db, String(req.params.slug), teachingBearer(req)); return addTeachingSubmission(db, s, course, req.body, session); });
    return res.status(result.duplicate ? 200 : 201).json({ submission: publicTeachingSubmission(result.submission) });
  }));
}
