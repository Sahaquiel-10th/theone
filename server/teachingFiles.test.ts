import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Database } from './types.js';
import type { Store } from './db.js';
import { AttachmentService } from './attachmentService.js';
import { installTeachingFileRoutes } from './teachingFiles.js';
import { installTeachingRoutes } from './teachingRoutes.js';
import { authTeachingSession, closeTeachingCourse, createTeachingActivity, createTeachingCourse, createTeachingSession, publishTeachingCourse, teachingState } from './teaching.js';
import type { TeachingScope } from './teachingTypes.js';
import {uploadTeachingFile,type TeachingRequest} from '../src/teachingUploads.js';

const teacher = { workspaceId: 'files-wa', userId: 'teacher-a' }, same = { workspaceId: 'files-wa', userId: 'teacher-b' }, other = { workspaceId: 'files-wb', userId: 'teacher-c' };
const ownerHeaders = { 'Content-Type': 'application/json', 'x-teacher': teacher.userId };
const video = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(20), Buffer.from('PRIVATE_ORIGINAL_VIDEO_BYTES')]);
function makeDb() {
  const scopes = [teacher, same, other];
  return { users: scopes.map(scope => ({ id: scope.userId, username: scope.userId, enabled: true, defaultWorkspaceId: scope.workspaceId })), workspaceMembers: scopes.map(scope => ({ ...scope, role: 'owner' })), workspaces: [{ id: teacher.workspaceId, status: 'active' }, { id: other.workspaceId, status: 'active' }], attachments: [], auditLogs: [] } as unknown as Database;
}
function addCourse(db: Database, scope: TeachingScope = teacher) {
  const course = createTeachingCourse(db, scope, { title: '现场调研课程' });
  const { activity } = createTeachingActivity(db, scope, course.id, { revision: course.revision, stage: 'after', kind: 'assignment', title: '提交观察视频', instructions: '上传原件即可。', status: 'published' });
  publishTeachingCourse(db, scope, course.id, { revision: course.revision, confirmed: true });
  return { course, activity };
}
async function fixture(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'one-teaching-file-http-'));
  t.after(() => fs.rm(directory, { force: true, recursive: true }));
  let db = makeDb(), tail: Promise<unknown> = Promise.resolve();
  const store: Store = { read: async () => db, mutate: <T>(fn: (db: Database) => T) => { const next = tail.then(() => { const previous = structuredClone(db); try { return fn(db); } catch (error) { db = previous; throw error; } }); tail = next.catch(() => undefined); return next; } };
  const auth: express.RequestHandler = (req, res, next) => { const user = db.users.find(value => value.id === req.headers['x-teacher']); if (!user) { res.sendStatus(401); return; } req.user = user; req.workspaceId = user.defaultWorkspaceId; next(); };
  const app = express(); app.use(express.json());
  installTeachingRoutes(app, [auth], store);
  installTeachingFileRoutes(app, [auth], store, directory, new AttachmentService(store, directory));
  app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.status ?? 500).json({ error: 'request rejected' }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/teaching`;
  const post = (url: string, body: unknown = {}, headers: Record<string, string> = ownerHeaders) => fetch(base + url, { method: 'POST', headers, body: JSON.stringify(body) });
  const upload = async (prefix: string, bytes = video, headers: Record<string, string> = ownerHeaders, name = 'fieldwork.mp4') => {
    const created = await post(prefix + '/uploads', { name, size: bytes.length, mimeType: 'video/mp4' }, headers); assert.equal(created.status, 200, await created.clone().text());
    const body = await created.json() as any; assert.doesNotMatch(JSON.stringify(body), /storagePath|workspaceId|userId|extractedText|PRIVATE_ORIGINAL_VIDEO_BYTES/);
    const id = body.attachment.id;
    const chunk = await fetch(`${base}${prefix}/uploads/${id}/chunks?offset=0`, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: bytes }); assert.equal(chunk.status, 200, await chunk.clone().text());
    assert.equal((await chunk.json() as any).uploadedBytes, bytes.length);
    const completed = await post(`${prefix}/uploads/${id}/complete`, {}, headers);
    return { id: id as string, completed };
  };
  return { get db() { return db; }, store, directory, base, post, upload };
}
const headers = (token: string) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });

test('a submitted video remains its private original; only its student and owning teacher can download it', async t => {
  const f = await fixture(t), { course, activity } = addCourse(f.db), secondCourse = addCourse(f.db), foreignCourse = addCourse(f.db, other);
  const one = createTeachingSession(f.db, course.slug!, { participantName: '一', participantRef: '1', consent: true });
  const two = createTeachingSession(f.db, course.slug!, { participantName: '二', participantRef: '2', consent: true });
  const anotherCourseSession = createTeachingSession(f.db, secondCourse.course.slug!, { participantName: '三', participantRef: '3', consent: true });
  const prefix = `/public/${course.slug}`, own = headers(one.token), uploaded = await f.upload(prefix, video, own);
  assert.equal(uploaded.completed.status, 200, await uploaded.completed.clone().text());
  const file = f.db.attachments.find(value => value.id === uploaded.id)!;
  assert.equal(file.status, 'ready'); assert.equal(file.mimeType, 'video/mp4'); assert.equal(file.extractedText, ''); assert.equal(file.textChars, 0); assert.equal(file.segmentCount, 0);
  assert.equal(file.userId, one.sessionId); assert.equal(file.workspaceId, teacher.workspaceId); assert.equal(file.conversationId, `teaching:${course.id}`);
  assert.equal((await fs.stat(file.storagePath)).mode & 0o777, 0o600);
  await assert.rejects(fs.access(file.storagePath + '.segments'), /ENOENT/);
  const submissionResponse = await f.post(prefix + '/submissions', { activityId: activity.id, operationId: 'video-submission-0001', attachmentIds: [uploaded.id] }, own); assert.equal(submissionResponse.status, 201, await submissionResponse.clone().text());
  const submission = (await submissionResponse.json() as any).submission;
  const route = `/submissions/${submission.id}/attachments/${uploaded.id}/content`;
  for (const [url, access] of [[prefix + route, own], [`/courses/${course.id}` + route, ownerHeaders]] as const) {
    const response = await fetch(f.base + url, { headers: access }); assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), video);
    assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('x-content-type-options'), 'nosniff'); assert.match(response.headers.get('content-security-policy') ?? '', /sandbox/); assert.match(response.headers.get('content-disposition') ?? '', /attachment/);
  }
  assert.equal((await fetch(f.base + prefix + route)).status, 401);
  assert.equal((await fetch(f.base + prefix + route, { headers: headers(two.token) })).status, 404);
  assert.equal((await fetch(f.base + `/public/${secondCourse.course.slug}` + route, { headers: headers(anotherCourseSession.token) })).status, 404);
  assert.equal((await fetch(f.base + `/courses/${secondCourse.course.id}` + route, { headers: ownerHeaders })).status, 404);
  assert.equal((await fetch(f.base + `/courses/${course.id}` + route, { headers: { ...ownerHeaders, 'x-teacher': same.userId } })).status, 404);
  assert.equal((await fetch(f.base + `/courses/${course.id}` + route, { headers: { ...ownerHeaders, 'x-teacher': other.userId } })).status, 404);
  assert.equal((await fetch(f.base + `/courses/${foreignCourse.course.id}` + route, { headers: { ...ownerHeaders, 'x-teacher': other.userId } })).status, 404);
  assert.equal((await f.post(prefix + '/submissions', { activityId: activity.id, operationId: 'stolen-video-attempt', attachmentIds: [uploaded.id] }, headers(two.token))).status, 400);
});

test('unsubmitted files stay inaccessible to the teacher and other sessions; chunks and metadata require exact course owner', async t => {
  const f = await fixture(t), { course, activity } = addCourse(f.db), secondCourse = addCourse(f.db);
  const one = createTeachingSession(f.db, course.slug!, { participantName: '一', participantRef: '1', consent: true });
  const two = createTeachingSession(f.db, course.slug!, { participantName: '二', participantRef: '2', consent: true });
  const otherSession = createTeachingSession(f.db, secondCourse.course.slug!, { participantName: '三', participantRef: '3', consent: true });
  const prefix = `/public/${course.slug}`, created = await f.post(prefix + '/uploads', { name: 'not-submitted.mp4', size: video.length }, headers(one.token));
  const id = (await created.json() as any).attachment.id;
  for (const [url, access] of [[prefix, headers(two.token)], [`/public/${secondCourse.course.slug}`, headers(otherSession.token)], [`/courses/${course.id}`, ownerHeaders]] as const) {
    assert.equal((await fetch(`${f.base}${url}/uploads/${id}`, { headers: access })).status, 404);
    assert.equal((await f.post(`${url}/uploads/${id}/complete`, {}, access)).status, 404);
    assert.equal((await fetch(`${f.base}${url}/uploads/${id}/chunks?offset=0`, { method: 'PUT', headers: { ...access, 'Content-Type': 'application/octet-stream' }, body: video })).status, 404);
  }
  assert.equal(f.db.attachments.find(value => value.id === id)?.uploadedBytes, 0);
  assert.equal((await f.post(prefix + '/submissions', { activityId: activity.id, operationId: 'incomplete-upload-001', attachmentIds: [id] }, headers(one.token))).status, 400);
  assert.equal((await f.post(prefix + `/uploads/${id}/complete`, {}, headers(one.token))).status, 400);
});

test('video completion checks actual bytes and preserves upload progress; forged suffix cannot become a ready submission', async t => {
  const f = await fixture(t), { course, activity } = addCourse(f.db);
  const session = createTeachingSession(f.db, course.slug!, { participantName: '一', participantRef: '1', consent: true }), prefix = `/public/${course.slug}`;
  const bad = await f.upload(prefix, Buffer.from('not an mp4 video at all'), headers(session.token));
  assert.equal(bad.completed.status, 400); assert.match(await bad.completed.text(), /视频格式/);
  const file = f.db.attachments.find(value => value.id === bad.id)!; assert.equal(file.status, 'uploading'); assert.equal(file.uploadedBytes, file.size);
  assert.equal((await f.post(prefix + '/submissions', { activityId: activity.id, operationId: 'invalid-video-000001', attachmentIds: [bad.id] }, headers(session.token))).status, 400);
  const created = await f.post(prefix + '/uploads', { name: 'oversize.mp4', size: 200 * 1024 ** 2 + 1 }, headers(session.token)); assert.equal(created.status, 400);
});

test('closing the course revokes student file and submission access while the teacher retains submitted originals', async t => {
  const f = await fixture(t), { course, activity } = addCourse(f.db);
  const session = createTeachingSession(f.db, course.slug!, { participantName: '一', participantRef: '1', consent: true }), prefix = `/public/${course.slug}`, h = headers(session.token);
  const uploaded = await f.upload(prefix, video, h); assert.equal(uploaded.completed.status, 200);
  const response = await f.post(prefix + '/submissions', { activityId: activity.id, operationId: 'closed-video-submit-01', attachmentIds: [uploaded.id] }, h);
  const submission = (await response.json() as any).submission, route = `/submissions/${submission.id}/attachments/${uploaded.id}/content`;
  await f.store.mutate(db => { const current = teachingState(db, teacher).courses.find(value => value.id === course.id)!; closeTeachingCourse(db, teacher, course.id, { revision: current.revision }); });
  assert.equal((await fetch(f.base + prefix + route, { headers: h })).status, 410);
  assert.equal((await fetch(f.base + prefix + `/uploads/${uploaded.id}`, { headers: h })).status, 410);
  assert.equal((await fetch(f.base + `/courses/${course.id}` + route, { headers: ownerHeaders })).status, 200);
});

test('upload and metadata responses never reveal private storage paths or file content', async t => {
  const f = await fixture(t), { course } = addCourse(f.db);
  const result = await f.upload(`/courses/${course.id}`, video, ownerHeaders, '../../private-name.mp4'); assert.equal(result.completed.status, 200);
  const response = await fetch(`${f.base}/courses/${course.id}/uploads/${result.id}`, { headers: ownerHeaders }); assert.equal(response.status, 200);
  const text = await response.text(); assert.doesNotMatch(text, /storagePath|PRIVATE_ORIGINAL_VIDEO_BYTES|workspaceId|userId|\/tmp\/|one-teaching-file-http/);
  const file = f.db.attachments.find(value => value.id === result.id)!; assert.equal(file.originalName, 'private-name.mp4'); assert.equal(path.dirname(file.storagePath), f.directory);
});

test('upload inventory, cleanup and teacher material download use exact course/session ownership; submitted originals cannot be deleted', async t => {
  const f = await fixture(t), { course, activity } = addCourse(f.db), second = addCourse(f.db), foreign = addCourse(f.db, other);
  const one = createTeachingSession(f.db, course.slug!, { participantName: '一', participantClass: '三年二班', consent: true }), two = createTeachingSession(f.db, course.slug!, { participantName: '二', consent: true });
  const prefix = `/public/${course.slug}`, own = headers(one.token), their = headers(two.token);
  const uploaded = await f.upload(prefix, video, own, 'student-one.mp4'), extra = await f.upload(prefix, video, own, 'student-two.mp4');
  assert.equal(uploaded.completed.status, 200); assert.equal(extra.completed.status, 200);
  const teacherFile = await f.upload(`/courses/${course.id}`, video, ownerHeaders, 'teacher-original.mp4'); assert.equal(teacherFile.completed.status, 200);
  const ownList = await (await fetch(f.base + prefix + '/uploads', { headers: own })).json() as any;
  assert.deepEqual(ownList.attachments.map((file: any) => file.id).sort(), [uploaded.id, extra.id].sort());
  assert.doesNotMatch(JSON.stringify(ownList), /storagePath|workspaceId|userId|PRIVATE_ORIGINAL_VIDEO_BYTES|teacher-original/);
  const theirList = await (await fetch(f.base + prefix + '/uploads', { headers: their })).json() as any; assert.deepEqual(theirList.attachments, []);
  const teacherList = await (await fetch(`${f.base}/courses/${course.id}/uploads`, { headers: ownerHeaders })).json() as any; assert.deepEqual(teacherList.attachments.map((file: any) => file.id), [teacherFile.id]);
  assert.equal((await fetch(f.base + prefix + '/uploads')).status, 401);
  assert.equal((await fetch(f.base + prefix + `/uploads/${uploaded.id}`, { method: 'DELETE', headers: their })).status, 404);
  assert.equal((await fetch(`${f.base}/courses/${course.id}/uploads/${uploaded.id}`, { method: 'DELETE', headers: ownerHeaders })).status, 404);
  for (const [url, access] of [[`/courses/${second.course.id}`, ownerHeaders], [`/courses/${course.id}`, { ...ownerHeaders, 'x-teacher': same.userId }], [`/courses/${course.id}`, { ...ownerHeaders, 'x-teacher': other.userId }], [`/courses/${foreign.course.id}`, { ...ownerHeaders, 'x-teacher': other.userId }]] as const) {
    assert.equal((await fetch(f.base + url + `/uploads/${teacherFile.id}/content`, { headers: access })).status, 404);
    assert.equal((await fetch(f.base + url + `/uploads/${teacherFile.id}`, { method: 'DELETE', headers: access })).status, 404);
  }
  assert.equal((await fetch(`${f.base}/courses/${course.id}/uploads/${teacherFile.id}/content`, { headers: own })).status, 401);
  assert.equal((await fetch(f.base + prefix + `/uploads/${teacherFile.id}/content`, { headers: own })).status, 404);
  const content = await fetch(`${f.base}/courses/${course.id}/uploads/${teacherFile.id}/content`, { headers: ownerHeaders }); assert.equal(content.status, 200); assert.deepEqual(Buffer.from(await content.arrayBuffer()), video);
  const response = await f.post(prefix + '/submissions', { activityId: activity.id, operationId: 'multi-attachment-only', attachmentIds: [uploaded.id, extra.id], participantClass: 'SPOOF' }, own); assert.equal(response.status, 201, await response.clone().text());
  const saved = (await response.json() as any).submission; assert.equal(saved.text, ''); assert.equal(saved.participantClass, '三年二班'); assert.equal(saved.attachmentIds.length, 2);
  assert.equal((await fetch(f.base + prefix + `/uploads/${uploaded.id}`, { method: 'DELETE', headers: own })).status, 409);
  assert.equal((await f.post(prefix + '/submissions', { activityId: activity.id, operationId: 'multi-attachment-only', attachmentIds: [uploaded.id, extra.id] }, own)).status, 200);
  const delegate = await f.post(`/courses/${course.id}/submissions`, { activityId: activity.id, operationId: 'teacher-delegate-file', participantName: '代传同学', participantClass: '四年一班', attachmentIds: [teacherFile.id] }); assert.equal(delegate.status, 201); assert.equal((await delegate.json() as any).submission.participantClass, '四年一班');
  const disposable = await f.upload(prefix, video, own, 'remove-unused.mp4'); assert.equal(disposable.completed.status, 200);
  const diskPath = f.db.attachments.find(file => file.id === disposable.id)!.storagePath;
  assert.equal((await fetch(f.base + prefix + `/uploads/${disposable.id}`, { method: 'DELETE', headers: own })).status, 200);
  assert.equal((await fetch(f.base + prefix + `/uploads/${disposable.id}`, { headers: own })).status, 404); await assert.rejects(fs.access(diskPath), /ENOENT/);
});

test('six explicitly cancelled allocations release the active quota and a later original can still be submitted', async t => {
  const f = await fixture(t), { course, activity } = addCourse(f.db), joined = createTeachingSession(f.db, course.slug!, { participantName: '取消测试', consent: true });
  const prefix = `/public/${course.slug}`, h = headers(joined.token);
  const request: TeachingRequest = async <T>(url: string, options: RequestInit = {}) => { const response = await fetch(f.base + url, { ...options, headers: { ...h, ...options.headers } }); const payload = await response.json(); if (!response.ok) throw new Error(`HTTP ${response.status}`); return payload as T; };
  for (let index = 0; index < 6; index++) { const controller = new AbortController(); await assert.rejects(uploadTeachingFile(request, prefix, new File([video], 'cancel.mp4', { type: 'video/mp4' }), () => {}, { signal: controller.signal, onCreated: () => controller.abort() }), { name: 'AbortError' }); }
  assert.equal(f.db.attachments.length, 0); assert.deepEqual(await fs.readdir(f.directory), []);
  const uploaded = await f.upload(prefix, video, h); assert.equal(uploaded.completed.status, 200);
  assert.equal((await f.post(prefix + '/submissions', { activityId: activity.id, operationId: 'after-cancel-submit01', attachmentIds: [uploaded.id] }, h)).status, 201);
});
