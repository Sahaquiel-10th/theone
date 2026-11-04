import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Database } from './types.js';
import { publicUser } from './serializers.js';
import { TeachingError, bindTeachingGradingBasis, activeTeachingCourse, addTeachingSubmission, authTeachingSession, closeTeachingCourse, createTeachingActivity, createTeachingCourse, createTeachingSession, createTeachingTask, listTeachingCourses, ownedTeachingCourse, publicTeachingCourse, publicTeachingSubmission, publishTeachingCourse, reviewTeachingSubmission, teachingState, updateTeachingActivity, updateTeachingCourse, updateTeachingGrading } from './teaching.js';

const a = { workspaceId: 'wa', userId: 'teacher-a' }, b = { workspaceId: 'wb', userId: 'teacher-b' }, same = { workspaceId: 'wa', userId: 'teacher-b' };
function fixture() {
  return { users: [{ id: a.userId, username: 'a', enabled: true }, { id: b.userId, username: 'b', enabled: true }], workspaces: [{ id: 'wa', kind: 'company', status: 'active' }, { id: 'wb', status: 'active' }], workspaceMembers: [{ ...a, role: 'owner' }, { ...b, role: 'owner' }, { ...same, role: 'owner' }], attachments: [] } as unknown as Database;
}
function setup(db = fixture()) {
  const course = createTeachingCourse(db, a, { title: '通用课程', materialText: 'TEACHER_PRIVATE_MATERIAL', workspaceId: 'wb', userId: 'teacher-b' });
  const { activity } = createTeachingActivity(db, a, course.id, { revision: course.revision, stage: 'after', kind: 'quiz', title: '课程测验', status: 'published', questions: [{ id: 'q1', type: 'single', prompt: '选择一个', options: ['正确', '错误'], answer: '正确', points: 10 }], scenes: [{ id: 'scene', title: '现场', content: '观察并选择', choices: ['行动', '观察'], reflection: 'PRIVATE_REFLECTION' }] });
  publishTeachingCourse(db, a, course.id, { revision: course.revision, confirmed: true });
  return { db, course, activity };
}
const fails = (fn: () => unknown, status: number) => assert.throws(fn, error => error instanceof TeachingError && error.status === status);

test('teacher ownership and membership are checked independently of supplied workspace and user ids', () => {
  const { db, course } = setup();
  assert.equal(course.workspaceId, a.workspaceId); assert.equal(course.userId, a.userId);
  fails(() => ownedTeachingCourse(db, b, course.id), 404);
  fails(() => ownedTeachingCourse(db, same, course.id), 404);
  fails(() => ownedTeachingCourse(db, { workspaceId: 'wb', userId: a.userId }, course.id), 403);
  db.workspaceMembers.find(m => m.workspaceId === 'wa' && m.userId === a.userId)!.status = 'disabled';
  fails(() => ownedTeachingCourse(db, a, course.id), 403);
  fails(() => activeTeachingCourse(db, course.slug!), 403);
});

test('teaching needs the exact workspace owner and platform admin membership cannot spend company funds', () => {
  const { db, course } = setup();
  db.users[1].role = 'admin';
  db.workspaceMembers.find(m => m.workspaceId === same.workspaceId && m.userId === same.userId)!.role = 'member';
  fails(() => createTeachingCourse(db, same, { title: '不能开通的课程', budgetMicros: 1000000 }), 403);
  assert.equal(db.users[1].teaching, undefined);
  // Demotion immediately revokes both teacher access and the already shared student entry.
  db.workspaceMembers.find(m => m.workspaceId === a.workspaceId && m.userId === a.userId)!.role = 'member';
  fails(() => ownedTeachingCourse(db, a, course.id), 403);
  fails(() => activeTeachingCourse(db, course.slug!), 403);
  // Being an owner elsewhere is not an authorization for this workspace.
  fails(() => createTeachingCourse(db, { workspaceId: 'wb', userId: a.userId }, { title: '跨空间' }), 403);
});

test('read-only teaching list and lookup do not initialize or mutate private user state', () => {
  const db = fixture(), before = JSON.stringify(db);
  assert.deepEqual(listTeachingCourses(db, a), []);
  assert.deepEqual(teachingState(db, a), { courses: [], sessions: [], submissions: [], operations: [] });
  fails(() => ownedTeachingCourse(db, a, 'missing'), 404);
  assert.equal(db.users[0].teaching, undefined); assert.equal(JSON.stringify(db), before);
});

test('explicit task creation is idempotent, private and supplies an editable activity for each supported job', () => {
  const db = fixture();
  for (const kind of ['grade', 'ask', 'quiz', 'game'] as const) {
    const created = createTeachingTask(db, a, { draftId: `teacher_draft_${kind}`, kind, workspaceId: b.workspaceId, userId: b.userId });
    assert.equal(created.course.status, 'draft'); assert.equal(created.course.slug, undefined);
    assert.equal(created.activity.status, 'published'); assert.equal(created.course.taskKind, kind);
    assert.equal(created.course.workspaceId, a.workspaceId); assert.equal(created.activity.userId, a.userId);
    assert.equal(created.activity.kind, kind === 'grade' ? 'assignment' : kind === 'ask' ? 'inquiry' : kind);
    const repeated = createTeachingTask(db, a, { draftId: `teacher_draft_${kind}`, kind, title: '不会覆盖已创建内容', budgetMicros: 1 });
    assert.equal(repeated.duplicate, true); assert.equal(repeated.course.id, created.course.id); assert.equal(repeated.activity.id, created.activity.id);
    assert.notEqual(repeated.course.title, '不会覆盖已创建内容');
    if (kind === 'grade') assert.equal(created.activity.rubric[0].maxScore, 100);
    if (kind === 'game') assert.equal(created.activity.allowStudentPrompt, true);
  }
  assert.equal(teachingState(db, a).courses.length, 4);
  fails(() => createTeachingTask(db, a, { draftId: 'teacher_draft_grade', kind: 'game' }), 409);
  fails(() => createTeachingTask(db, { workspaceId: b.workspaceId, userId: a.userId }, { draftId: 'teacher_draft_grade', kind: 'grade' }), 403);
  const other = createTeachingTask(db, b, { draftId: 'teacher_draft_grade', kind: 'grade' });
  assert.notEqual(other.course.id, teachingState(db, a).courses[0].id);
});

test('public teaching projection exposes only the teacher-approved avatar prompt, never source grants or private task ids', () => {
  const { db, course, activity } = setup();
  // Distinct markers also protect against future accidental rest/spread serializers.
  course.clientDraftId = 'PRIVATE_CLIENT_DRAFT';
  course.knowledgeSources = [{ provider: 'notion', connectionId: 'PRIVATE_CONNECTION', binding: 'PRIVATE_BINDING', scope: 'page', pageId: 'PRIVATE_PAGE', label: 'PRIVATE_LABEL' }];
  activity.kind = 'inquiry'; activity.knowledgeSources = structuredClone(course.knowledgeSources); activity.avatarPrompt = 'PUBLIC_TEACHER_ROLE';
  const projection = JSON.stringify(publicTeachingCourse(course));
  assert.match(projection, /PUBLIC_TEACHER_ROLE/);
  assert.doesNotMatch(projection, /PRIVATE_CLIENT_DRAFT|PRIVATE_CONNECTION|PRIVATE_BINDING|PRIVATE_PAGE|PRIVATE_LABEL|knowledgeSources|tokenHash/);
  assert.equal(teachingState(db, a).sessions.length, 0);
});

test('public course, student receipt and publicUser project no teacher materials, answers, owner identifiers or session secrets', () => {
  const { db, course, activity } = setup();
  const publicJson = JSON.stringify(publicTeachingCourse(course));
  assert.doesNotMatch(publicJson, /TEACHER_PRIVATE_MATERIAL|PRIVATE_REFLECTION|tokenHash|workspaceId|userId|materialAttachmentIds|"answer":/);
  const guest = createTeachingSession(db, course.slug!, { participantName: '学生一', participantRef: '001', consent: true });
  const auth = authTeachingSession(db, course.slug!, guest.token);
  const { submission } = addTeachingSubmission(db, a, course, { activityId: activity.id, operationId: 'submission_001', answers: { q1: '错误' }, participantName: 'SPOOFED' }, auth.session);
  submission.grade = { criteria: [], total: 0, feedback: 'UNREVIEWED_PRIVATE_FEEDBACK', source: 'ai', status: 'suggested', needsReview: true };
  const receipt = JSON.stringify(publicTeachingSubmission(submission));
  assert.doesNotMatch(receipt, /UNREVIEWED_PRIVATE_FEEDBACK|activitySnapshot|payloadHash|workspaceId|userId|sessionId|"answer":/);
  assert.equal(submission.participantName, '学生一');
  assert.doesNotMatch(JSON.stringify(publicUser(db.users[0])), /teaching|TEACHER_PRIVATE_MATERIAL|tokenHash|participantName/);
  submission.grade.status = 'published';
  (submission.grade as any).referenceText = 'PRIVATE_FUTURE_GRADE_FIELD';
  (submission.grade as any).sourceAttachmentIds = ['PRIVATE_SOURCE'];
  assert.doesNotMatch(JSON.stringify(publicTeachingSubmission(submission)), /PRIVATE_FUTURE_GRADE_FIELD|PRIVATE_SOURCE|referenceText|sourceAttachmentIds/);
});

test('scenario review comes only from the submitted snapshot and only includes scenes this student answered', () => {
  const db = fixture(), course = createTeachingCourse(db, a, { title: '情境教学' });
  const { activity } = createTeachingActivity(db, a, course.id, { revision: course.revision, stage: 'during', kind: 'scenario', title: '决策体验', status: 'published', referenceText: 'PRIVATE_REFERENCE', scenes: [{ id: 's1', title: '已体验情境', content: '观察', choices: ['先观察', '直接行动'], reflection: '选择前核对证据' }, { id: 's2', title: '未体验情境', content: '观察', choices: ['继续'], reflection: 'UNANSWERED_PRIVATE_REVIEW' }] });
  publishTeachingCourse(db, a, course.id, { revision: course.revision, confirmed: true });
  assert.doesNotMatch(JSON.stringify(publicTeachingCourse(course)), /选择前核对证据|UNANSWERED_PRIVATE_REVIEW|PRIVATE_REFERENCE/);
  const guest = createTeachingSession(db, course.slug!, { participantName: '一', participantRef: '1', consent: true }), { session } = authTeachingSession(db, course.slug!, guest.token);
  const { submission } = addTeachingSubmission(db, a, course, { activityId: activity.id, operationId: 'scenario_submit_001', answers: { s1: '先观察' } }, session);
  assert.deepEqual(publicTeachingSubmission(submission).learningReview, [{ title: '已体验情境', reflection: '选择前核对证据' }]);
  assert.doesNotMatch(JSON.stringify(publicTeachingSubmission(submission)), /UNANSWERED_PRIVATE_REVIEW|PRIVATE_REFERENCE|activitySnapshot|tokenHash|workspaceId|userId/);
  closeTeachingCourse(db, a, course.id, { revision: course.revision });
  updateTeachingActivity(db, a, course.id, activity.id, { revision: course.revision, scenes: [{ ...activity.scenes[0], reflection: 'NEW_REVIEW' }] });
  assert.deepEqual(publicTeachingSubmission(submission).learningReview, [{ title: '已体验情境', reflection: '选择前核对证据' }]);
});

test('student tokens and ready attachments bind to exact course, session, and workspace', () => {
  const { db, course, activity } = setup();
  const one = createTeachingSession(db, course.slug!, { participantName: '一', participantRef: '1', consent: true });
  const two = createTeachingSession(db, course.slug!, { participantName: '二', participantRef: '2', consent: true });
  const s1 = authTeachingSession(db, course.slug!, one.token).session, s2 = authTeachingSession(db, course.slug!, two.token).session;
  const other = createTeachingCourse(db, a, { title: '另一课程' });
  db.attachments.push({ id: 'file', workspaceId: a.workspaceId, userId: s1.id, conversationId: `teaching:${course.id}`, status: 'ready' } as any);
  const payload = { activityId: activity.id, operationId: 'submission_001', attachmentIds: ['file'] };
  addTeachingSubmission(db, a, course, payload, s1);
  fails(() => addTeachingSubmission(db, a, course, payload, s2), 400);
  fails(() => addTeachingSubmission(db, a, course, { ...payload, participantName: '教师代交', participantRef: '3' }), 400);
  fails(() => addTeachingSubmission(db, a, other, payload, s1), 404);
  db.attachments[0].status = 'parsing';
  fails(() => addTeachingSubmission(db, a, course, { ...payload, operationId: 'submission_002' }, s1), 400);
  db.attachments[0].status = 'ready'; db.attachments[0].conversationId = `teaching:${other.id}`;
  fails(() => addTeachingSubmission(db, a, course, { ...payload, operationId: 'submission_003' }, s1), 400);
});

test('activity paper and reference attachments remain private and require exact teacher course binding', () => {
  const db = fixture(), course = createTeachingCourse(db, a, { title: '课程' });
  db.attachments.push({ id: 'paper', ...a, conversationId: `teaching:${course.id}`, status: 'ready' } as any);
  db.attachments.push({ id: 'foreign', ...b, conversationId: `teaching:${course.id}`, status: 'ready' } as any);
  const input = { revision: course.revision, stage: 'after', kind: 'assignment', title: '作业', status: 'published', referenceText: 'PRIVATE_REFERENCE_ANSWER', sourceAttachmentIds: ['foreign'], rubric: [{ id: 'reasoning', label: '论证', description: '论证清晰', maxScore: 20 }] };
  fails(() => createTeachingActivity(db, a, course.id, input), 400);
  const { activity } = createTeachingActivity(db, a, course.id, { ...input, sourceAttachmentIds: ['paper'] });
  assert.equal(activity.referenceText, 'PRIVATE_REFERENCE_ANSWER');
  publishTeachingCourse(db, a, course.id, { revision: course.revision, confirmed: true });
  assert.doesNotMatch(JSON.stringify(publicTeachingCourse(course)), /PRIVATE_REFERENCE_ANSWER|sourceAttachmentIds|referenceText|paper/);
  const { submission } = addTeachingSubmission(db, a, course, { activityId: activity.id, operationId: 'assignment_001', participantName: '学生', participantRef: '1', text: '我的论证' });
  assert.equal(submission.activitySnapshot.referenceText, 'PRIVATE_REFERENCE_ANSWER');
  assert.doesNotMatch(JSON.stringify(publicTeachingSubmission(submission)), /PRIVATE_REFERENCE_ANSWER|sourceAttachmentIds|referenceText|paper/);
  reviewTeachingSubmission(db, a, course.id, submission.id, { criteria: [{ criterionId: 'reasoning', score: 15, comment: '', evidence: '' }], total: 15, feedback: '' });
  assert.equal(submission.grade?.total, 15);
});

test('idempotent submissions, explicit revisions, immutable activity snapshots, and publication rotation', () => {
  const { db, course, activity } = setup();
  const guest = createTeachingSession(db, course.slug!, { participantName: '一', participantRef: '1', consent: true }), oldSlug = course.slug!;
  const session = authTeachingSession(db, oldSlug, guest.token).session;
  const payload = { activityId: activity.id, activityRevision: activity.revision, operationId: 'submission_001', answers: { q1: '错误' } };
  const first = addTeachingSubmission(db, a, course, payload, session);
  assert.equal(first.duplicate, false); assert.equal(addTeachingSubmission(db, a, course, payload, session).duplicate, true);
  fails(() => addTeachingSubmission(db, a, course, { ...payload, answers: { q1: '正确' } }, session), 409);
  fails(() => updateTeachingCourse(db, a, course.id, { revision: course.revision - 1, title: '覆盖' }), 409);
  fails(() => updateTeachingActivity(db, a, course.id, activity.id, { revision: course.revision, title: '覆盖' }), 409);
  closeTeachingCourse(db, a, course.id, { revision: course.revision });
  fails(() => authTeachingSession(db, oldSlug, guest.token), 410);
  fails(() => addTeachingSubmission(db, a, course, { ...payload, operationId: 'submission_002' }, session), 410);
  updateTeachingActivity(db, a, course.id, activity.id, { revision: course.revision, questions: [{ ...activity.questions[0], answer: '错误', points: 20 }] });
  assert.equal(first.submission.activitySnapshot.questions[0].answer, '正确'); assert.equal(first.submission.activitySnapshot.questions[0].points, 10);
  publishTeachingCourse(db, a, course.id, { revision: course.revision, confirmed: true });
  assert.notEqual(course.slug, oldSlug); fails(() => activeTeachingCourse(db, oldSlug), 404);
  fails(() => authTeachingSession(db, course.slug!, guest.token), 401);
});

test('teacher review uses the submitted contract, rejects excess or incomplete grades and publishes only confirmed results', () => {
  const { db, course, activity } = setup();
  const { submission } = addTeachingSubmission(db, a, course, { activityId: activity.id, participantName: '一', participantRef: '1', operationId: 'submission_001', text: '答案' });
  const grade = { criteria: [{ criterionId: 'q1', score: 8, comment: '解释', evidence: '原文' }], total: 8, feedback: '总体建议' };
  fails(() => reviewTeachingSubmission(db, b, course.id, submission.id, grade), 404);
  fails(() => reviewTeachingSubmission(db, a, course.id, submission.id, { ...grade, total: 9 }), 400);
  fails(() => reviewTeachingSubmission(db, a, course.id, submission.id, { ...grade, criteria: [{ ...grade.criteria[0], score: 11 }] }), 400);
  fails(() => reviewTeachingSubmission(db, a, course.id, submission.id, { ...grade, criteria: [] }), 400);
  closeTeachingCourse(db, a, course.id, { revision: course.revision });
  const reviewed = reviewTeachingSubmission(db, a, course.id, submission.id, grade);
  assert.equal(reviewed.grade?.status, 'published'); assert.equal(reviewed.grade?.source, 'teacher'); assert.equal(reviewed.grade?.needsReview, false);
  assert.equal(publicTeachingSubmission(reviewed).grade?.total, 8);
});

test('bounded course input rejects oversized and malformed values without accepting privileged fields', () => {
  const db = fixture();
  fails(() => createTeachingCourse(db, a, { title: 'x', materialText: 'x'.repeat(120001) }), 400);
  fails(() => createTeachingCourse(db, a, { title: 'x', budgetMicros: Infinity }), 400);
  const course = createTeachingCourse(db, a, { title: 'x', status: 'published', slug: 'attacker', activities: [{ title: 'injected' }] });
  assert.equal(course.status, 'draft'); assert.equal(course.slug, undefined); assert.equal(course.activities.length, 0);
  fails(() => createTeachingActivity(db, a, course.id, { revision: course.revision, stage: 'before', kind: 'quiz', title: 'x', questions: [{ id: 'q', type: 'single', prompt: 'x', options: ['one', 'two'], answer: 'A', points: 10 }] }), 400);
  for (let index = 1; index < 30; index++) createTeachingCourse(db, a, { title: String(index) });
  fails(() => createTeachingCourse(db, a, { title: 'overflow' }), 409);
  assert.equal(teachingState(db, a).courses.length, 30);
});

test('real JSON Store restart preserves private course, student identity, submission snapshot and reviewed grade', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'one-teaching-restart-'));
  try {
    const env = { ...process.env, NODE_ENV: 'test', DB_PROVIDER: 'json', ONE_DATA_DIR: directory, ADMIN_INITIAL_PASSWORD: 'isolated-teaching-test-password' };
    const imports = `import {store} from './server/db.ts'; import * as t from './server/teaching.ts';`;
    const create = `${imports} const info=await store.mutate(db=>{const u=db.users[0],scope={workspaceId:u.defaultWorkspaceId,userId:u.id};const c=t.createTeachingCourse(db,scope,{title:'持久化课程',materialText:'PRIVATE_DURABLE'});const {activity}=t.createTeachingActivity(db,scope,c.id,{revision:c.revision,stage:'after',kind:'quiz',title:'测验',status:'published',questions:[{id:'q',type:'text',prompt:'描述',options:[],answer:'PRIVATE_ANSWER',points:10}]});t.publishTeachingCourse(db,scope,c.id,{revision:c.revision,confirmed:true});const guest=t.createTeachingSession(db,c.slug,{participantName:'耐久测试',participantRef:'001',consent:true});const {session}=t.authTeachingSession(db,c.slug,guest.token);const {submission}=t.addTeachingSubmission(db,scope,c,{activityId:activity.id,operationId:'durable_submission',answers:{q:'学生答案'}},session);t.reviewTeachingSubmission(db,scope,c.id,submission.id,{criteria:[{criterionId:'q',score:7,comment:'评价',evidence:'学生答案'}],total:7,feedback:'已复核'});return {slug:c.slug,token:guest.token};});console.log(JSON.stringify(info));`;
    const first = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', create], { cwd: process.cwd(), env, encoding: 'utf8' }).trim();
    const read = `${imports} const info=${first};const db=await store.read();const {course,session,scope}=t.authTeachingSession(db,info.slug,info.token);const s=t.teachingSubmissions(db,scope,course.id).find(s=>s.sessionId===session.id);console.log(JSON.stringify({title:course.title,material:course.materialText,snapshot:s.activitySnapshot.questions[0].answer,total:s.grade.total,public:t.publicTeachingSubmission(s)}));`;
    const actual = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', read], { cwd: process.cwd(), env, encoding: 'utf8' }).trim());
    assert.equal(actual.title, '持久化课程'); assert.equal(actual.material, 'PRIVATE_DURABLE'); assert.equal(actual.snapshot, 'PRIVATE_ANSWER'); assert.equal(actual.total, 7);
    assert.doesNotMatch(JSON.stringify(actual.public), /PRIVATE_ANSWER|PRIVATE_DURABLE|activitySnapshot|tokenHash/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('collect first, adopt an explicit rubric later; original snapshot, grading revision and published result stay protected', () => {
  const db = fixture(), course = createTeachingCourse(db, a, { title: '先收作业' });
  const { activity } = createTeachingActivity(db, a, course.id, { revision: course.revision, stage: 'after', kind: 'assignment', title: '观察作业', instructions: '原始任务', status: 'published', rubric: [] });
  publishTeachingCourse(db, a, course.id, { revision: course.revision, confirmed: true });
  const joined = createTeachingSession(db, course.slug!, { participantName: '一', participantClass: '三年二班', consent: true }), session = authTeachingSession(db, course.slug!, joined.token).session;
  const { submission } = addTeachingSubmission(db, a, course, { activityId: activity.id, text: '原始作业', operationId: 'collect-first-request', participantClass: '伪造班级' }, session);
  assert.equal(submission.participantClass, '三年二班'); assert.equal(publicTeachingSubmission(submission).participantClass, '三年二班');
  const original = structuredClone(submission.activitySnapshot);
  closeTeachingCourse(db, a, course.id, { revision: course.revision });
  updateTeachingActivity(db, a, course.id, activity.id, { revision: course.revision, activityRevision: activity.revision, instructions: '后来的任务说明', rubric: [{ id: 'late', label: '观察', description: '有观察', maxScore: 10 }], referenceText: 'PRIVATE_LATE_REFERENCE' });
  const body = { confirmed: true, submissionActivityRevision: submission.activityRevision, activityRevision: activity.revision, expectedGradingRevision: 0 };
  fails(() => bindTeachingGradingBasis(db, b, course.id, submission.id, body), 404);
  fails(() => bindTeachingGradingBasis(db, a, course.id, submission.id, { ...body, confirmed: false }), 400);
  bindTeachingGradingBasis(db, a, course.id, submission.id, body);
  assert.equal(submission.gradingRevision, 1); assert.equal(submission.gradingSnapshot?.instructions, '原始任务'); assert.deepEqual(submission.activitySnapshot, original);
  submission.grade = { criteria: [{ criterionId: 'late', score: 7, comment: '', evidence: '' }], total: 7, feedback: '暂存建议', source: 'ai', status: 'suggested', needsReview: true, gradingRevision: 1 };
  bindTeachingGradingBasis(db, a, course.id, submission.id, body); assert.equal(submission.gradingRevision, 1); assert.equal(submission.grade.total, 7, 'duplicate adoption cannot delete a newer suggestion');
  updateTeachingActivity(db, a, course.id, activity.id, { revision: course.revision, activityRevision: activity.revision, rubric: [{ id: 'late', label: '观察', description: '细化标准', maxScore: 10 }] });
  const next = { ...body, activityRevision: activity.revision, expectedGradingRevision: 1 };
  bindTeachingGradingBasis(db, a, course.id, submission.id, next); assert.equal(submission.gradingRevision, 2); assert.equal(submission.grade, undefined);
  const grade = { criteria: [{ criterionId: 'late', score: 8, comment: '确认', evidence: '原始作业' }], total: 8, feedback: '已复核' };
  fails(() => reviewTeachingSubmission(db, a, course.id, submission.id, { ...grade, gradingRevision: 1 }), 409);
  reviewTeachingSubmission(db, a, course.id, submission.id, { ...grade, gradingRevision: 2 });
  const published = structuredClone(submission.grade);
  reviewTeachingSubmission(db, a, course.id, submission.id, { ...grade, gradingRevision: 2 }); assert.deepEqual(submission.grade, published);
  fails(() => reviewTeachingSubmission(db, a, course.id, submission.id, { ...grade, feedback: '试图覆盖', gradingRevision: 2 }), 409);
  fails(() => bindTeachingGradingBasis(db, a, course.id, submission.id, next), 409);
  assert.doesNotMatch(JSON.stringify(publicTeachingSubmission(submission)), /gradingSnapshot|PRIVATE_LATE_REFERENCE|后来的任务说明/);
});

test('course creation receipt is scoped, payload-bound, separate from old task drafts and replayed before capacity', () => {
  const db = fixture(), body = { clientRequestId: 'course-create-original', title: '物理', subject: '科学', budgetMicros: 100 };
  const first = createTeachingCourse(db, a, body); assert.equal(first.clientCreateKey, body.clientRequestId);
  updateTeachingCourse(db, a, first.id, { revision: first.revision, title: '后来重命名' });
  assert.equal(createTeachingCourse(db, a, { ...body, title: ' 物理 ' }).id, first.id, 'normalised original request is replayable even after teacher edits');
  fails(() => createTeachingCourse(db, a, { ...body, title: '另一门课' }), 409);
  assert.notEqual(createTeachingCourse(db, b, body).id, first.id);
  assert.notEqual(createTeachingCourse(db, same, body).id, first.id);
  const task = createTeachingTask(db, a, { draftId: body.clientRequestId, kind: 'ask' }); assert.notEqual(task.course.id, first.id);
  while (teachingState(db, a).courses.length < 30) createTeachingCourse(db, a, { title: '另一个课程' });
  assert.equal(createTeachingCourse(db, a, body).id, first.id);
  fails(() => createTeachingCourse(db, a, { title: '超出容量', clientRequestId: 'new-create-at-capacity' }), 409);
  for (const key of ['short', 'https://foreign', 'x'.repeat(121)]) fails(() => createTeachingCourse(db, b, { title: '非法编号', clientRequestId: key }), 400);
  assert.doesNotMatch(JSON.stringify(publicTeachingCourse(first)), /clientCreateKey|createPayloadHash|course-create-original/);
});

test('published assignment grading edit is narrowly versioned and preserves student session and immutable submitted contracts', () => {
  const db = fixture(), course = createTeachingCourse(db, a, { title: '收件后设标准' });
  const { activity } = createTeachingActivity(db, a, course.id, { revision: course.revision, stage: 'after', kind: 'assignment', title: '原作业', instructions: '只需提交观察记录', status: 'published', rubric: [] });
  publishTeachingCourse(db, a, course.id, { revision: course.revision, confirmed: true });
  const joined = createTeachingSession(db, course.slug!, { participantName: '原学生', participantClass: '一班', consent: true });
  const { submission } = addTeachingSubmission(db, a, course, { activityId: activity.id, operationId: 'private-grading-submit', text: '我的观察' }, authTeachingSession(db, course.slug!, joined.token).session);
  const snapshot = structuredClone(submission.activitySnapshot), slug = course.slug!, sharedAt = course.updatedAt, revision = course.revision, activityRevision = activity.revision;
  const body = { revision, activityRevision, rubric: [{ id: 'observation', label: '观察', description: '有具体观察', maxScore: 10 }], referenceText: 'PRIVATE_REFERENCE_AFTER_COLLECTION', avatarPrompt: '按标准严格核对' };
  fails(() => updateTeachingGrading(db, b, course.id, activity.id, body), 404);
  fails(() => updateTeachingGrading(db, same, course.id, activity.id, body), 404);
  for (const extra of [{ title: 'changed' }, { instructions: 'changed' }, { questions: [] }, { scenes: [] }, { status: 'closed' }, { materialText: 'changed' }]) fails(() => updateTeachingGrading(db, a, course.id, activity.id, { ...body, ...extra }), 400);
  fails(() => updateTeachingGrading(db, a, course.id, activity.id, { ...body, activityRevision: undefined }), 409);
  fails(() => updateTeachingGrading(db, a, course.id, activity.id, { ...body, revision: revision - 1 }), 409);
  for (const foreign of [{ sourceAttachmentIds: ['foreign-file'] }, { knowledgeSources: [{ connectionId: 'missing', scope: 'connection', confirmed: true }] }]) {
    db.knowledgeConnections ??= [];
    assert.throws(() => updateTeachingGrading(db, a, course.id, activity.id, { ...body, ...foreign })); assert.equal(course.revision, revision); assert.equal(activity.revision, activityRevision);
  }
  updateTeachingGrading(db, a, course.id, activity.id, body);
  assert.equal(course.status, 'published'); assert.equal(course.slug, slug); assert.equal(course.updatedAt, sharedAt); assert.equal(course.revision, revision + 1); assert.equal(activity.revision, activityRevision + 1); assert.equal(activity.title, '原作业'); assert.equal(activity.instructions, '只需提交观察记录'); assert.equal(activity.status, 'published');
  assert.deepEqual(submission.activitySnapshot, snapshot); assert.equal(submission.gradingSnapshot, undefined); assert.equal(authTeachingSession(db, slug, joined.token).session.id, joined.sessionId);
  bindTeachingGradingBasis(db, a, course.id, submission.id, { confirmed: true, activityRevision: activity.revision, submissionActivityRevision: submission.activityRevision, expectedGradingRevision: 0 });
  reviewTeachingSubmission(db, a, course.id, submission.id, { gradingRevision: 1, criteria: [{ criterionId: 'observation', score: 8, comment: '已核对', evidence: '我的观察' }], feedback: '老师反馈' });
  const grade = structuredClone(submission.grade);
  updateTeachingGrading(db, a, course.id, activity.id, { ...body, revision: course.revision, activityRevision: activity.revision, rubric: [{ id: 'new', label: '新版', description: '', maxScore: 100 }] });
  assert.deepEqual(submission.grade, grade); assert.deepEqual(submission.activitySnapshot, snapshot);
  fails(() => bindTeachingGradingBasis(db, a, course.id, submission.id, { confirmed: true, activityRevision: activity.revision, submissionActivityRevision: submission.activityRevision, expectedGradingRevision: 1 }), 409);
  assert.equal(authTeachingSession(db, slug, joined.token).session.id, joined.sessionId);
  const publicData = JSON.stringify(publicTeachingCourse(course)); assert.doesNotMatch(publicData, /PRIVATE_REFERENCE_AFTER_COLLECTION|sourceAttachmentIds|knowledgeSources/);
});

test('independent grading route cannot edit a quiz or bypass a revoked teacher membership', () => {
  const { db, course, activity } = setup();
  fails(() => updateTeachingGrading(db, a, course.id, activity.id, { revision: course.revision, activityRevision: activity.revision, rubric: [] }), 400);
  db.workspaceMembers.find(member => member.workspaceId === a.workspaceId && member.userId === a.userId)!.status = 'disabled';
  fails(() => updateTeachingGrading(db, a, course.id, activity.id, { revision: course.revision, activityRevision: activity.revision, rubric: [] }), 403);
});


test('student public activities expose only inquiry and game roles, never assessment grading prompts', () => {
  const db = fixture(), course = createTeachingCourse(db, a, { title: '公开数据边界' });
  for (const kind of ['inquiry', 'game', 'scenario', 'assignment', 'quiz'] as const) createTeachingActivity(db, a, course.id, { revision: course.revision, stage: kind === 'inquiry' ? 'before' : 'after', kind, title: kind, instructions: '学生可见任务', status: 'published', avatarPrompt: `ROLE_${kind}`, referenceText: `PRIVATE_REF_${kind}` });
  const dto = publicTeachingCourse(course);
  for (const activity of dto.activities) assert.equal(activity.avatarPrompt, ['inquiry','game'].includes(activity.kind) ? `ROLE_${activity.kind}` : '');
  assert.doesNotMatch(JSON.stringify(dto), /ROLE_assignment|ROLE_quiz|ROLE_scenario|PRIVATE_REF/);
});
