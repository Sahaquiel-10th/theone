import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { Database, ModelConfig } from './types.js';
import type { Store } from './db.js';
import { installStudentLearningRoutes } from './studentLearningRoutes.js';
import { installTeachingRoutes } from './teachingRoutes.js';
import { installTeachingAiRoutes } from './teachingAiRoutes.js';
import { addTeachingSubmission, authTeachingSession, createTeachingActivity, createTeachingCourse, createTeachingSession, publishTeachingCourse, teachingState } from './teaching.js';
import { createStudentClass, updateStudentClass, prepareStudentProvision, provisionStudents, studentLogin, studentActivityAccess, studentCourses, saveStudentScript, submitStudentScript, authenticatedStudent, studentPasswordMatches, assertStudentStoryPermission, studentPasswordHash } from './studentLearning.js';
import { publicUser } from './serializers.js';
import { decryptCredential } from './knowledge/credentialCipher.js';
import { previewTeachingPurge, commitTeachingPurge } from './teachingPurge.js';
import { mutateTeachingTrash, setTeachingActivityOpen } from './teachingLifecycle.js';
const teacher = { userId: 'teacher-a', workspaceId: 'wa' }, other = { userId: 'teacher-b', workspaceId: 'wb' }, sameUser = { userId: 'teacher-a', workspaceId: 'wb' };
function data() { const scopes = [teacher, other, sameUser]; return { users: [{ id: teacher.userId, username: '老师甲', enabled: true }, { id: other.userId, username: '老师乙', enabled: true }], workspaces: [{ id: 'wa', status: 'active' }, { id: 'wb', status: 'active' }], workspaceMembers: scopes.map(s => ({ ...s, role: 'owner' })), attachments: [], models: [{ id: 'synthetic', provider: 'synthetic', model: 'synthetic', baseUrl: 'https://never-used.invalid', apiKey: 'SYNTHETIC_NOT_SENT', enabled: true, isDefault: true, kind: 'chat', protocol: 'openai', inputPowerPerMillion: 1, outputPowerPerMillion: 1, costInputPowerPerMillion: 0, costOutputPowerPerMillion: 0 } as ModelConfig], settings: { safetyRules: 'Synthetic QA only' }, modelUsageRecords: [], powerAccounts: scopes.map(s => ({ ...s, id: s.userId + s.workspaceId, balanceMicros: 20000000, reservedMicros: 0 })), powerLedger: [], auditLogs: [], knowledgeConnections: [], conversations: [], messages: [], executionTasks: [], executionEvents: [] } as unknown as Database; }
function courseIn(db: Database, scope = teacher) {
    const course = createTeachingCourse(db, scope, { title: '合成课程', budgetMicros: 5000000 });
    delete course.sourceMode;
    course.materialText = '合成教学资料';
    const inquiry = createTeachingActivity(db, scope, course.id, { revision: course.revision, title: '课程辅导', stage: 'before', kind: 'inquiry', status: 'published' }).activity;
    const quiz = createTeachingActivity(db, scope, course.id, { revision: course.revision, title: '单元测验', stage: 'after', kind: 'quiz', status: 'published', questions: [{ id: 'q1', type: 'single', prompt: '选择甲', options: ['甲', '乙'], answer: '甲', points: 10 }] }).activity;
    publishTeachingCourse(db, scope, course.id, { revision: course.revision, confirmed: true });
    for (const activity of [inquiry, quiz])
        setTeachingActivityOpen(db, scope, course.id, activity.id, { revision: course.revision, activityRevision: activity.revision, confirmed: true }, true);
    return { course, inquiry, quiz };
}
const row = { name: '学生甲', phone: '13800001001', studentNumber: '2026001' };
function classFor(db: Database, scope: typeof teacher, cid: string, key = 'class-create-0001') { return createStudentClass(db, scope, { name: '通识一班', courseIds: [cid], createKey: key }); }
async function enroll(db: Database, cid: string, scope = teacher, phone = row.phone) { const classroom = classFor(db, scope, cid), rows = [{ ...row, phone }], prepared = await prepareStudentProvision(rows); const provision = provisionStudents(db, scope, classroom.id, { rows, classRevision: classroom.revision, requestId: 'import-fixture-' + phone }, prepared); return { classroom, provision, password: prepared[0].password, account: db.users.flatMap(u => u.teaching?.studentAccounts ?? []).find(a => a.phone === phone)!, membership: teachingState(db, scope).studentMemberships!.find(m => m.classId === classroom.id)! }; }
async function fixture(t: TestContext) {
    let db = data(), tail: Promise<unknown> = Promise.resolve(), models = 0, beforeMutation: ((db: Database) => void) | undefined;
    const store: Store = { read: async () => db, mutate: <T>(fn: (db: Database) => T) => {
            const p = tail.then(() => {
                beforeMutation?.(db);
                const before = structuredClone(db);
                try {
                    return fn(db);
                }
                catch (e) {
                    if (JSON.stringify(db) !== JSON.stringify(before))
                        db = before;
                    throw e;
                }
            });
            tail = p.catch(() => { });
            return p;
        } };
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    const auth: express.RequestHandler = (req, res, next) => {
        if (req.get('X-Key') !== 'present') {
            res.sendStatus(401);
            return;
        }
        req.user = db.users.find(u => u.id === (req.get('X-Teacher') ?? teacher.userId));
        req.workspaceId = req.get('X-Workspace') ?? teacher.workspaceId;
        next();
    };
    const verifyKey = async () => { };
    installStudentLearningRoutes(app, [auth], store, { verifyKey });
    installTeachingRoutes(app, [auth], store, { verifyKey });
    installTeachingAiRoutes(app, [auth], store, { verifyKey, modelCall: async () => { models++; return { content: JSON.stringify({ answer: '合成回答', materialInsufficient: true, needsLocationClarification: false, locationCandidates: [], citations: [] }), toolCalls: [], finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, source: 'provider' } }; } });
    app.use((e: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(e.status ?? 500).json({ error: e.message }));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => { server.closeAllConnections(); server.close(); });
    const root = `http://127.0.0.1:${(server.address() as any).port}`;
    const request = async (url: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => {
        const response = await fetch(root + url, { method, headers: { 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const text = await response.text();
        let result: any;
        try {
            result = JSON.parse(text);
        }
        catch {
            result = text;
        }
        return { status: response.status, body: result, cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '', cache: response.headers.get('cache-control') };
    };
    return { db: () => db, store, request, models: () => models, setBeforeMutation: (fn: (db: Database) => void) => { beforeMutation = fn; } };
}
const owner = { 'X-Key': 'present' }, write = { 'X-Student-Request': '1' };
test('teacher account issuance is idempotent, encrypted and isolated; existing phones only gain an enrollment', async (t) => {
    const f = await fixture(t), a = courseIn(f.db()), b = courseIn(f.db(), other), ws = courseIn(f.db(), sameUser), base = '/api/teaching/student-classes';
    let r = await f.request(base, 'POST', { name: '一班', courseIds: [a.course.id], createKey: 'new-class-0001' }, owner);
    assert.equal(r.status, 201);
    const c = r.body.classroom;
    assert.equal((await f.request(base, 'POST', { name: '一班', courseIds: [a.course.id], createKey: 'new-class-0001' }, owner)).body.classroom.id, c.id);
    assert.equal((await f.request(base, 'POST', { name: '覆盖', courseIds: [a.course.id], createKey: 'new-class-0001' }, owner)).status, 409);
    const input = { rows: [row], classRevision: c.revision, requestId: 'issuance-once-0001' };
    r = await f.request(base + '/' + c.id + '/import', 'POST', input, owner);
    assert.equal(r.status, 200);
    const p = r.body.provision;
    assert.equal(p.newAccounts, 1);
    const csv = await f.request(`${base}/${c.id}/provisions/${p.id}/export`, 'GET', undefined, owner);
    assert.equal(csv.status, 200);
    const stored = teachingState(f.db(), teacher).studentProvisions![0], initial = JSON.parse(decryptCredential(stored.encryptedCredentials, `student-provision:wa:teacher-a:${p.id}`))[0]['初始密码'];
    assert.match(initial, /^[A-Za-z0-9_-]{16}$/);
    assert.match(csv.body, new RegExp(initial));
    assert.doesNotMatch(JSON.stringify(f.db()), new RegExp(initial));
    const repeat = await f.request(base + '/' + c.id + '/import', 'POST', input, owner);
    assert.equal(repeat.body.provision.id, p.id);
    assert.equal(f.db().users.length, 2);
    assert.equal(f.db().workspaceMembers.length, 3);
    assert.equal((await f.request(base + '/' + c.id + '/import', 'POST', { ...input, rows: [{ ...row, name: '不同人' }] }, owner)).status, 409);
    assert.equal((await f.request(`${base}/${c.id}/provisions/${p.id}/export`, 'GET', undefined, { ...owner, 'X-Workspace': 'wb' })).status, 404);
    assert.equal((await f.request(`${base}/${c.id}/provisions/${p.id}/export`, 'GET', undefined, { ...owner, 'X-Workspace': 'wb', 'X-Teacher': other.userId })).status, 404);
    const wsClass = classFor(f.db(), sameUser, ws.course.id, 'same-user-class');
    assert.equal((await f.request(base, 'GET', undefined, owner)).body.classes.length, 1);
    assert.equal((await f.request(base, 'GET', undefined, { ...owner, 'X-Workspace': 'wb' })).body.classes[0].id, wsClass.id);
    const account = teachingState(f.db(), teacher).studentAccounts![0], hash = account.passwordHash, bClass = classFor(f.db(), other, b.course.id);
    const foreign = await f.request(`${base}/${bClass.id}/import`, 'POST', { rows: [{ ...row, name: '乙老师的学生' }], classRevision: bClass.revision, requestId: 'other-import-001' }, { ...owner, 'X-Workspace': 'wb', 'X-Teacher': other.userId });
    assert.equal(foreign.body.provision.newAccounts, 0);
    assert.equal(account.passwordHash, hash);
    assert.equal(teachingState(f.db(), other).studentAccounts?.length ?? 0, 0);
    const forbidden = await f.request(`${base}/${bClass.id}/members/${teachingState(f.db(), other).studentMemberships![0].id}/reissue`, 'POST', { requestId: 'other-reissue-001' }, { ...owner, 'X-Workspace': 'wb', 'X-Teacher': other.userId });
    assert.equal(forbidden.status, 403);
    const view = await f.request(base, 'GET', undefined, { ...owner, 'X-Workspace': 'wb', 'X-Teacher': other.userId });
    assert.doesNotMatch(JSON.stringify(view.body), /passwordHash|encryptedCredentials|drafts|studentAccounts/);
    assert.equal(view.body.memberships[0].name, '乙老师的学生');
    assert.doesNotMatch(JSON.stringify(publicUser(f.db().users[0])), /teaching|studentAccounts|studentMemberships/);
});
test('login is not ONE membership; first password, recovery and per-device revocation protect stable cross-device work', async (t) => {
    const f = await fixture(t), { course, quiz, inquiry } = courseIn(f.db()), e = await enroll(f.db(), course.id);
    const l = '/api/learning';
    assert.equal((await f.request(l + '/register', 'POST', { phone: row.phone }, write)).status, 404);
    assert.equal((await f.request(l + '/login', 'POST', { phone: row.phone, password: e.password })).status, 403);
    assert.equal((await f.request(l + '/login', 'POST', { phone: row.phone, password: e.password }, { ...write, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await f.request(l + '/login', 'POST', { phone: row.phone, password: 'wrong' }, write)).status, 401);
    let r = await f.request(l + '/login', 'POST', { phone: '+86 ' + row.phone, password: e.password }, write);
    assert.equal(r.status, 200);
    let h = { ...write, Cookie: r.cookie };
    assert.equal(r.body.student.mustChangePassword, true);
    assert.equal(r.cache, 'no-store');
    assert.doesNotMatch(JSON.stringify(r.body), /token|Hash|workspaceId|userId/);
    assert.equal((await f.request(l + '/courses', 'GET', undefined, h)).status, 403);
    assert.equal((await f.request('/api/teaching/courses', 'GET', undefined, h)).status, 401);
    assert.equal((await f.request(l + '/password', 'POST', { currentPassword: e.password, newPassword: e.password }, h)).status, 400);
    const initialCookie = h.Cookie;
    r = await f.request(l + '/password', 'POST', { currentPassword: e.password, newPassword: 'Student-new-secret-001' }, h);
    assert.equal(r.status, 200);
    h = { ...write, Cookie: r.cookie };
    const recovery = r.body.recoveryCode;
    assert.equal((await f.request(l + '/me', 'GET', undefined, { Cookie: initialCookie })).status, 401);
    assert.equal((await f.request(l + '/courses', 'GET', undefined, h)).body.courses[0].className, e.classroom.name);
    const access = { courseId: course.id, membershipId: e.membership.id, activityId: quiz.id };
    r = await f.request(l + '/access', 'POST', access, h);
    assert.equal(r.status, 200);
    const first = r.body;
    const bearer = { Authorization: `Bearer ${first.token}` };
    const sessionId = authTeachingSession(f.db(), first.slug, first.token).session.id;
    r = await f.request(`/api/teaching/public/${first.slug}/submissions`, 'POST', { activityId: quiz.id, operationId: 'student-submit-0001', answers: { q1: '甲' }, participantName: '冒充姓名' }, { ...bearer });
    assert.equal(r.status, 201);
    assert.equal(r.body.submission.participantName, row.name);
    const secondLogin = await f.request(l + '/login', 'POST', { phone: row.phone, password: 'Student-new-secret-001' }, write), h2 = { ...write, Cookie: secondLogin.cookie };
    const second = (await f.request(l + '/access', 'POST', access, h2)).body;
    assert.equal(authTeachingSession(f.db(), second.slug, second.token).session.id, sessionId);
    assert.equal((await f.request(`/api/teaching/public/${second.slug}/submissions`, 'GET', undefined, { Authorization: `Bearer ${second.token}` })).body.submissions.length, 1);
    assert.equal((await f.request(l + `/submissions?courseId=${course.id}&membershipId=${e.membership.id}`, 'GET', undefined, h2)).body.submissions.length, 1);
    const otherEnrolled = await enroll(f.db(), course.id, teacher, '13800001002');
    otherEnrolled.account.mustChangePassword = false;
    const otherToken = studentLogin(f.db(), otherEnrolled.account.id).token;
    assert.equal((await f.request(l + `/submissions?courseId=${course.id}&membershipId=${e.membership.id}`, 'GET', undefined, { Cookie: 'one_student_session=' + otherToken })).status, 403);
    await f.request(l + '/logout', 'POST', {}, h);
    assert.equal((await f.request(`/api/teaching/public/${first.slug}/session`, 'GET', undefined, bearer)).status, 401);
    assert.equal((await f.request(`/api/teaching/public/${second.slug}/session`, 'GET', undefined, { Authorization: `Bearer ${second.token}` })).status, 200);
    r = await f.request(l + '/recover', 'POST', { phone: row.phone, recoveryCode: recovery, newPassword: 'Recovered-new-secret-002' }, write);
    assert.equal(r.status, 200);
    assert.notEqual(r.body.recoveryCode, recovery);
    assert.equal((await f.request(l + '/me', 'GET', undefined, h2)).status, 401);
    assert.equal((await f.request(l + '/recover', 'POST', { phone: row.phone, recoveryCode: recovery, newPassword: 'Another-secret-003' }, write)).status, 401);
    assert.equal((await f.request(`/api/teaching/public/${second.slug}/session`, 'GET', undefined, { Authorization: `Bearer ${second.token}` })).status, 401);
    assert.equal((await f.request('/api/teaching/student-classes/' + e.classroom.id + '/members/' + e.membership.id + '/reissue', 'POST', { requestId: 'activated-reset-1' }, owner)).status, 409);
    assert.equal(f.models(), 0);
    assert.equal(f.db().modelUsageRecords.length, 0);
    assert.ok(inquiry);
});
test('rostered courses reject anonymous and old guest tokens; membership, class, workspace and course changes revoke grants', async (t) => {
    const f = await fixture(t), { course, inquiry } = courseIn(f.db());
    const guest = createTeachingSession(f.db(), course.slug!, { participantName: '旧匿名', consent: true }), e = await enroll(f.db(), course.id);
    e.account.mustChangePassword = false;
    const token = studentLogin(f.db(), e.account.id).token, access = { courseId: course.id, membershipId: e.membership.id, activityId: inquiry.id };
    assert.throws(() => authTeachingSession(f.db(), course.slug!, guest.token), /学生账号/);
    const publicView = await f.request('/api/teaching/public/' + course.slug);
    assert.equal(publicView.body.course.accountLoginRequired, true);
    assert.deepEqual(publicView.body.course.activities, []);
    assert.doesNotMatch(JSON.stringify(publicView.body), /选择甲|"answer"|materialText/);
    assert.equal((await f.request('/api/teaching/public/' + course.slug + '/sessions', 'POST', { participantName: '伪造', consent: true, studentAccountId: e.account.id })).status, 401);
    const grant = studentActivityAccess(f.db(), token, access);
    assert.ok(authTeachingSession(f.db(), grant.slug, grant.token));
    e.membership.active = false;
    assert.throws(() => authTeachingSession(f.db(), grant.slug, grant.token), /过期/);
    assert.throws(() => studentActivityAccess(f.db(), token, access), /未加入/);
    e.membership.active = true;
    updateStudentClass(f.db(), teacher, e.classroom.id, { name: e.classroom.name, revision: e.classroom.revision, courseIds: [course.id], active: false });
    assert.throws(() => authTeachingSession(f.db(), grant.slug, grant.token));
    e.classroom.active = true;
    f.db().workspaceMembers.find(m => m.userId === teacher.userId && m.workspaceId === teacher.workspaceId)!.role = 'member';
    assert.equal(studentCourses(f.db(), e.account.id).length, 0);
    assert.throws(() => authTeachingSession(f.db(), grant.slug, grant.token));
    f.db().workspaceMembers[0].role = 'owner';
    const replacement = courseIn(f.db()).course;
    updateStudentClass(f.db(), teacher, e.classroom.id, { name: e.classroom.name, revision: e.classroom.revision, courseIds: [replacement.id] });
    assert.throws(() => studentActivityAccess(f.db(), token, access), /未分配/);
    assert.throws(() => createTeachingSession(f.db(), course.slug!, { participantName: '仍然不能绕过', consent: true }), /学生账号/);
    const legacy = courseIn(f.db()).course;
    assert.ok(createTeachingSession(f.db(), legacy.slug!, { participantName: '未建班旧入口', consent: true }));
});
test('private scripts are separate from immutable teacher submissions, replay remains valid after editing, private AI is never charged', async (t) => {
    const f = await fixture(t), { course, inquiry } = courseIn(f.db()), e = await enroll(f.db(), course.id);
    e.account.mustChangePassword = false;
    const token = studentLogin(f.db(), e.account.id).token, h = { ...write, Cookie: 'one_student_session=' + token }, l = '/api/learning';
    let r = await f.request(l + '/scripts', 'POST', { id: 'private-script-0001', revision: 0, title: '普通人的一天', text: 'PRIVATE_DRAFT_TEXT' }, h);
    assert.equal(r.status, 200);
    assert.doesNotMatch(JSON.stringify(r.body), /workspaceId|userId|passwordHash/);
    const d = r.body.draft;
    const teacherView = await f.request('/api/teaching/student-script-submissions', 'GET', undefined, owner);
    assert.deepEqual(teacherView.body.submissions, []);
    assert.equal((await f.request(l + '/scripts', 'POST', { id: d.id, revision: 0, title: d.title, text: d.text }, h)).body.draft.revision, 1);
    const p = { requestId: 'submit-script-0001', membershipId: e.membership.id, courseId: course.id, draftId: d.id, draftRevision: 1 };
    r = await f.request(l + '/scripts/submit', 'POST', p, h);
    assert.equal(r.status, 200);
    const submitted = r.body.submission;
    const revision2 = saveStudentScript(f.db(), token, { ...d, text: 'PRIVATE_LATER_REVISION' });
    assert.equal(revision2.revision, 2);
    assert.equal((await f.request(l + '/scripts/submit', 'POST', p, h)).body.submission.id, submitted.id);
    const tv = await f.request('/api/teaching/student-script-submissions', 'GET', undefined, owner);
    assert.equal(tv.body.submissions[0].text, 'PRIVATE_DRAFT_TEXT');
    assert.doesNotMatch(JSON.stringify(tv.body), /PRIVATE_LATER_REVISION/);
    assert.deepEqual((await f.request('/api/teaching/student-script-submissions', 'GET', undefined, { ...owner, 'X-Workspace': 'wb' })).body.submissions, []);
    const grant = studentActivityAccess(f.db(), token, { membershipId: e.membership.id, courseId: course.id, activityId: inquiry.id });
    r = await f.request(`/api/teaching/public/${grant.slug}/questions`, 'POST', { activityId: inquiry.id, kind: 'script', operationId: 'private-ai-denied-001', content: 'AI帮我编写剧本' }, { Authorization: 'Bearer ' + grant.token });
    assert.equal(r.status, 403);
    assert.equal(f.models(), 0);
    assert.equal(f.db().powerLedger.length, 0);
    assert.equal(f.db().modelUsageRecords.length, 0);
    assert.throws(() => assertStudentStoryPermission(f.db(), authTeachingSession(f.db(), grant.slug, grant.token).session, 'story_turn', 'unassigned-story'), /未布置/);
    r = await f.request(l + '/scripts/' + d.id + '/trash', 'PATCH', { revision: 2, restore: false }, h);
    assert.equal(r.status, 200);
    assert.equal((await f.request(l + '/scripts/submit', 'POST', p, h)).body.submission.id, submitted.id);
    await f.request(l + '/scripts/' + d.id + '/trash', 'PATCH', { revision: 3, restore: true }, h);
    assert.equal((await f.request(l + '/scripts', 'GET', undefined, h)).body.drafts[0].deletedAt, undefined);
    const foreign = await enroll(f.db(), course.id, teacher, '13800001003');
    foreign.account.mustChangePassword = false;
    const fh = { ...write, Cookie: 'one_student_session=' + studentLogin(f.db(), foreign.account.id).token };
    assert.deepEqual((await f.request(l + '/scripts', 'GET', undefined, fh)).body.drafts, []);
    assert.equal((await f.request(l + '/scripts/' + d.id + '/trash', 'PATCH', { revision: 4, restore: false }, fh)).status, 404);
});
test('course permanent purge previews submitted scripts, invalidates stale impact, and retains personal drafts', async () => {
    const db = data(), { course } = courseIn(db), e = await enroll(db, course.id);
    e.account.mustChangePassword = false;
    const token = studentLogin(db, e.account.id).token, d = saveStudentScript(db, token, { id: 'purge-private-script', revision: 0, title: '保留个人作品', text: '个人正文' }), p = { courseId: course.id, membershipId: e.membership.id, draftId: d.id, draftRevision: 1, requestId: 'purge-submit-001' };
    submitStudentScript(db, token, p);
    mutateTeachingTrash(db, teacher, { confirmed: true, items: [{ courseId: course.id, revision: course.revision }] }, false);
    const body = { items: [{ courseId: course.id, revision: course.revision }] }, preview = previewTeachingPurge(db, teacher, body);
    assert.equal(preview.impact.scriptSubmissions, 1);
    db.users[0].teaching!.studentScriptSubmissions![0].text += ' changed';
    assert.throws(() => commitTeachingPurge(db, teacher, { ...body, ...preview, requestId: 'purge-student-00001', confirmed: true }, { directoryAvailable: true }), /变化/);
    const fresh = previewTeachingPurge(db, teacher, body);
    commitTeachingPurge(db, teacher, { ...body, ...fresh, requestId: 'purge-student-00001', confirmed: true }, { directoryAvailable: true });
    assert.equal(db.users[0].teaching!.studentScriptSubmissions!.length, 0);
    assert.equal(e.account.drafts[0].text, '个人正文');
    assert.equal(e.account.drafts.length, 1);
});
test('initial credential reissue has a durable repeatable receipt, stops at activation and does not change user passwords', async (t) => {
    const f = await fixture(t), { course } = courseIn(f.db()), e = await enroll(f.db(), course.id), base = `/api/teaching/student-classes/${e.classroom.id}/members/${e.membership.id}/reissue`, before = e.account.passwordHash;
    const r = await f.request(base, 'POST', { requestId: 'initial-reissue-0001' }, owner);
    assert.equal(r.status, 200);
    assert.notEqual(e.account.passwordHash, before);
    const current = e.account.passwordHash;
    const repeat = await f.request(base, 'POST', { requestId: 'initial-reissue-0001' }, owner);
    assert.equal(repeat.body.provision.id, r.body.provision.id);
    assert.equal(e.account.passwordHash, current);
    e.account.mustChangePassword = false;
    assert.equal((await f.request(base, 'POST', { requestId: 'initial-reissue-0002' }, owner)).status, 409);
});
test('student records survive real JSON store restart and stay private in user serialization', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'one-student-restart-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const env = { PATH: process.env.PATH, NODE_ENV: 'test', DB_PROVIDER: 'json', ONE_DATA_DIR: directory, ADMIN_INITIAL_PASSWORD: 'synthetic-student-store-password', PROVIDER_CREDENTIALS_KEY: 'synthetic-student-encryption-key-only' };
    const run = async (script: string) => (await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: process.cwd(), env, timeout: 120000 })).stdout;
    const setup = `const {store}=await import('./server/db.ts');const {createTeachingCourse}=await import('./server/teaching.ts');const {createStudentClass,prepareStudentProvision,provisionStudents,studentLogin,saveStudentScript}=await import('./server/studentLearning.ts');let db=await store.read();const scope={userId:db.users[0].id,workspaceId:db.users[0].defaultWorkspaceId};const c=await store.mutate(db=>createTeachingCourse(db,scope,{title:'重启合成课程'}));const classroom=await store.mutate(db=>createStudentClass(db,scope,{name:'重启合成班级',courseIds:[c.id],createKey:'restart-create-001'}));const rows=[{name:'合成学生',phone:'13800001999',studentNumber:'001'}],prepared=await prepareStudentProvision(rows);await store.mutate(db=>{provisionStudents(db,scope,classroom.id,{rows,classRevision:1,requestId:'restart-import-001'},prepared);const a=db.users[0].teaching.studentAccounts[0];a.mustChangePassword=false;const login=studentLogin(db,a.id);saveStudentScript(db,login.token,{id:'restart-private-001',title:'重启个人剧本',text:'PRIVATE_RESTART_SCRIPT',revision:0});});`;
    await run(setup);
    const output = JSON.parse(await run(`const {store}=await import('./server/db.ts');const {publicUser}=await import('./server/serializers.ts');const db=await store.read();const t=db.users[0].teaching;console.log(JSON.stringify({classes:t.studentClasses.length,members:t.studentMemberships.length,account:t.studentAccounts[0].phone,privateText:t.studentAccounts[0].drafts[0].text,public:publicUser(db.users[0])}));`));
    assert.equal(output.classes, 1);
    assert.equal(output.members, 1);
    assert.equal(output.account, '13800001999');
    assert.equal(output.privateText, 'PRIVATE_RESTART_SCRIPT');
    assert.doesNotMatch(JSON.stringify(output.public), /PRIVATE_RESTART_SCRIPT|studentAccounts|studentClasses|teaching/);
});
test('classroom stories require explicit class assignment, exclude peer scripts and prevent private legacy game spending', async (t) => {
    const f = await fixture(t), { course } = courseIn(f.db()), e = await enroll(f.db(), course.id);
    const game = createTeachingActivity(f.db(), teacher, course.id, { revision: course.revision, title: '课堂文字游戏', kind: 'game', stage: 'during', status: 'published' }).activity;
    setTeachingActivityOpen(f.db(), teacher, course.id, game.id, { revision: course.revision, activityRevision: game.revision, confirmed: true }, true);
    e.account.mustChangePassword = false;
    const login = studentLogin(f.db(), e.account.id), h = { ...write, Cookie: 'one_student_session=' + login.token };
    const result = { kind: 'script', approved: true, title: '普通船工的一天', role: '普通船工', event: '运河', feedback: '合成审核通过', annotations: [], citations: [{ quote: '合成教学资料' }], directorPrompt: 'PRIVATE_TEACHER_DIRECTOR' };
    const state = teachingState(f.db(), teacher), seed = { ...teacher, id: 'teacher-approved-story', courseId: course.id, activityId: game.id, kind: 'script', status: 'completed', result, createdAt: new Date().toISOString() } as any;
    state.operations.push(seed, { ...seed, id: 'peer-approved-story', sessionId: 'peer-session', result: { ...result, title: '同学私人剧本' } });
    assert.throws(() => updateStudentClass(f.db(), teacher, e.classroom.id, { name: e.classroom.name, revision: e.classroom.revision, courseIds: [course.id], storyIds: ['peer-approved-story'] }), /老师审核/);
    updateStudentClass(f.db(), teacher, e.classroom.id, { name: e.classroom.name, revision: e.classroom.revision, courseIds: [course.id], storyIds: [seed.id] });
    assert.deepEqual(studentCourses(f.db(), e.account.id)[0].stories.map(s => s.id), [seed.id]);
    const grant = studentActivityAccess(f.db(), login.token, { membershipId: e.membership.id, courseId: course.id, activityId: game.id, storyId: seed.id }), bearer = { Authorization: 'Bearer ' + grant.token };
    let response = await f.request(`/api/teaching/public/${grant.slug}/stories/${seed.id}?activityId=${game.id}`, 'GET', undefined, bearer);
    assert.equal(response.status, 200);
    assert.doesNotMatch(JSON.stringify(response.body), /PRIVATE_TEACHER_DIRECTOR|directorPrompt/);
    response = await f.request(`/api/teaching/public/${grant.slug}/questions`, 'POST', { activityId: game.id, operationId: 'private-legacy-game-001', content: '修改提示词玩自己的剧本' }, bearer);
    assert.equal(response.status, 403);
    assert.equal(f.models(), 0);
    assert.equal(f.db().modelUsageRecords.length, 0);
    updateStudentClass(f.db(), teacher, e.classroom.id, { name: e.classroom.name, revision: e.classroom.revision, courseIds: [course.id], storyIds: [] });
    assert.equal((await f.request(`/api/teaching/public/${grant.slug}/stories/${seed.id}?activityId=${game.id}`, 'GET', undefined, bearer)).status, 403);
    assert.equal((await f.request(`/api/teaching/public/${grant.slug}/questions`, 'POST', { activityId: game.id, kind: 'story_turn', operationId: 'revoked-class-story-001', runId: 'revoked-story-run-0001', storyId: seed.id, content: '开始' }, bearer)).status, 403);
    assert.equal(f.models(), 0);
    assert.equal(f.db().powerLedger.length, 0);
});
test('membership revocation immediately before the billing mutation prevents any model reservation or call', async (t) => {
    const f = await fixture(t), { course, inquiry } = courseIn(f.db()), e = await enroll(f.db(), course.id);
    e.account.mustChangePassword = false;
    const login = studentLogin(f.db(), e.account.id), grant = studentActivityAccess(f.db(), login.token, { membershipId: e.membership.id, courseId: course.id, activityId: inquiry.id });
    let revoked = false;
    f.setBeforeMutation(db => { if (!revoked && teachingState(db, teacher).operations.some(o => o.status === 'running')) {
        revoked = true;
        teachingState(db, teacher).studentMemberships!.find(m => m.id === e.membership.id)!.active = false;
    } });
    const r = await f.request(`/api/teaching/public/${grant.slug}/questions`, 'POST', { activityId: inquiry.id, operationId: 'atomic-revoke-qa-001', content: '请根据课程资料回答' }, { Authorization: 'Bearer ' + grant.token });
    assert.equal(r.status, 202);
    for (let i = 0; i < 40 && teachingState(f.db(), teacher).operations[0]?.status === 'running'; i++)
        await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(revoked, true);
    assert.equal(teachingState(f.db(), teacher).operations[0].status, 'failed');
    assert.equal(f.models(), 0);
    assert.equal(f.db().modelUsageRecords.length, 0);
    assert.equal(f.db().powerLedger.length, 0);
});
test('password attempts are throttled without granting membership or leaking authentication data', async (t) => {
    const f = await fixture(t);
    for (let i = 0; i < 12; i++)
        assert.equal((await f.request('/api/learning/login', 'POST', { phone: row.phone, password: 'incorrect' }, write)).status, 401);
    const r = await f.request('/api/learning/login', 'POST', { phone: row.phone, password: 'incorrect' }, write);
    assert.equal(r.status, 429);
    assert.doesNotMatch(JSON.stringify(r.body), /Hash|token|salt|studentAccounts/);
    assert.equal(f.db().users.length, 2);
});
test('class recycle bin immediately revokes course access, retains student private work and restores with entry closed', async (t) => {
    const f = await fixture(t), { course, inquiry } = courseIn(f.db()), e = await enroll(f.db(), course.id);
    e.account.mustChangePassword = false;
    const token = studentLogin(f.db(), e.account.id).token, grant = studentActivityAccess(f.db(), token, { membershipId: e.membership.id, courseId: course.id, activityId: inquiry.id });
    saveStudentScript(f.db(), token, { id: 'archived-class-private', title: '保留', text: '私人作品', revision: 0 });
    const base = '/api/teaching/student-classes/' + e.classroom.id + '/trash';
    assert.equal((await f.request(base, 'PATCH', { revision: e.classroom.revision, restore: false }, owner)).status, 200);
    assert.throws(() => authTeachingSession(f.db(), grant.slug, grant.token));
    assert.equal(studentCourses(f.db(), e.account.id).length, 0);
    assert.equal(authenticatedStudent(f.db(), token).account.drafts[0].text, '私人作品');
    assert.equal((await f.request(base, 'PATCH', { revision: e.classroom.revision, restore: true }, { ...owner, 'X-Workspace': 'wb' })).status, 404);
    let c = teachingState(f.db(), teacher).studentClasses![0];
    assert.equal((await f.request(base, 'PATCH', { revision: c.revision, restore: true }, owner)).status, 200);
    c = teachingState(f.db(), teacher).studentClasses![0];
    assert.equal(c.deletedAt, undefined);
    assert.equal(c.active, false);
    assert.equal(studentCourses(f.db(), e.account.id).length, 0);
    updateStudentClass(f.db(), teacher, c.id, { name: c.name, courseIds: c.courseIds, revision: c.revision, active: true });
    assert.equal(studentCourses(f.db(), e.account.id).length, 1);
});
