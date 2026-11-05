/** Synthetic fixtures only, explicitly enabled by the localhost QA server.
 * Production never imports this file. No account or password is a fallback. */
import type { Store } from '../server/db.js';
import type { TeachingScope } from '../server/teachingTypes.js';
import { createTeachingActivity, createTeachingCourse, teachingState, addTeachingSubmission } from '../server/teaching.js';
import { setTeachingActivityOpen } from '../server/teachingLifecycle.js';
import { createStudentClass, prepareStudentProvision, provisionStudents, studentPasswordHash, studentLogin, studentActivityAccess, saveStudentScript, submitStudentScript } from '../server/studentLearning.js';
export async function seedStudentQa(store: Store, scope: TeachingScope) {
    if (teachingState(await store.read(), scope).courses.some(c => c.clientCreateKey === 'qa-student-course-20261105'))
        return;
    const rows = [{ name: '体验学生', phone: '13800000105', studentNumber: '2026001' }, { name: '首次登录体验', phone: '13800000106', studentNumber: '2026002' }], prepared = await prepareStudentProvision(rows), hash = await studentPasswordHash('Synthetic-student-only-2026');
    await store.mutate(db => {
        const course = createTeachingCourse(db, scope, { title: '城市与生活 · 合成体验课', clientCreateKey: 'qa-student-course-20261105', budgetMicros: 5000000 });
        delete course.sourceMode;
        course.materialText = '杭州地处长江三角洲南翼，钱塘江流经杭州。此为合成测试资料。';
        const inquiry = createTeachingActivity(db, scope, course.id, { revision: course.revision, kind: 'inquiry', stage: 'before', title: '城市地理辅导', status: 'published' }).activity;
        const assignment = createTeachingActivity(db, scope, course.id, { revision: course.revision, kind: 'assignment', stage: 'after', title: '城市观察作业', instructions: '上传你拍摄的城市照片，记录一次观察。', status: 'published', rubric: [{ id: 'observe', label: '观察', description: '有具体观察', maxScore: 10 }] }).activity;
        const quiz = createTeachingActivity(db, scope, course.id, { revision: course.revision, kind: 'quiz', stage: 'after', title: '第一单元测验', instructions: '完成下面两道题。', status: 'published', questions: [{ id: 'q1', type: 'single', prompt: '杭州位于哪个省？', options: ['浙江省', '江苏省'], answer: '浙江省', points: 5 }, { id: 'q2', type: 'text', prompt: '写下你想了解的一条河流。', answer: '钱塘江', options: [], points: 5 }] }).activity;
        for (const a of [inquiry, assignment, quiz])
            setTeachingActivityOpen(db, scope, course.id, a.id, { revision: course.revision, activityRevision: a.revision, confirmed: true }, true);
        const c = createStudentClass(db, scope, { name: '人文通识一班', courseIds: [course.id], createKey: 'qa-student-class-20261105' });
        provisionStudents(db, scope, c.id, { rows, classRevision: 1, requestId: 'qa-student-import-20261105' }, prepared);
        const state = teachingState(db, scope), a = state.studentAccounts!.find(a => a.phone === rows[0].phone)!, first = state.studentAccounts!.find(a => a.phone === rows[1].phone)!;
        a.passwordHash = hash;
        a.mustChangePassword = false;
        first.passwordHash = hash;
        const login = studentLogin(db, a.id), membership = state.studentMemberships!.find(m => m.studentId === a.id)!;
        const grant = studentActivityAccess(db, login.token, { membershipId: membership.id, courseId: course.id, activityId: assignment.id });
        const session = state.sessions.find(s => s.studentAccountId === a.id)!, submission = addTeachingSubmission(db, scope, course, { activityId: assignment.id, operationId: 'qa-student-submit-0001', text: '合成体验：我观察了钱塘江两岸的生活。' }, session).submission;
        submission.grade = { total: 8, criteria: [{ criterionId: 'observe', score: 8, comment: '观察具体，可再补充地点。', evidence: '' }], feedback: '这份合成作业已收到，继续观察身边的城市。', status: 'published', source: 'teacher', needsReview: false };
        const d = saveStudentScript(db, login.token, { id: 'qa-student-private-0001', title: '运河边的一天', text: '我是一名生活在运河边的普通人。清晨，我来到码头观察往来的船只。', revision: 0 });
        submitStudentScript(db, login.token, { courseId: course.id, membershipId: membership.id, draftId: d.id, draftRevision: d.revision, requestId: 'qa-student-script-submit-001' });
        void grant;
    });
}
