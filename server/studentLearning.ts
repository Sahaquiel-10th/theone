import crypto from 'node:crypto';
import { promisify } from 'node:util';
import type { Database } from './types.js';
import type { TeachingScope, TeachingSession } from './teachingTypes.js';
import type { StudentAccount, StudentClass, StudentMembership, StudentScriptDraft, StudentProvision } from './studentLearningTypes.js';
import { TeachingError, teachingMember, teachingState, ownedTeachingCourse, activeTeachingAccess, createTeachingSession } from './teaching.js';
import { encryptCredential, decryptCredential } from './knowledge/credentialCipher.js';
import { uid } from './security.js';
const scrypt = promisify(crypto.scrypt), now = () => new Date().toISOString();
export const studentHash = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const same = (a: TeachingScope, b: TeachingScope) => a.userId === b.userId && a.workspaceId === b.workspaceId;
const fail = (message: string, status = 400): never => { throw new TeachingError(message, status, 'STUDENT_LEARNING_ERROR'); };
export function studentObject(value: unknown) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return fail('请检查提交内容');
    return value as Record<string, any>;
}
function text(value: unknown, label: string, max: number, required = true) {
    if (typeof value !== 'string' || value.length > max || value.includes('\0') || required && !value.trim())
        return fail(`请填写${label}（最多 ${max} 字）`);
    return value.trim();
}
export function studentPhone(value: unknown) {
    const phone = text(value, '手机号', 30).replace(/^\+86/, '').replace(/[ -]/g, '');
    if (!/^1[3-9]\d{9}$/.test(phone))
        return fail('请输入有效的 11 位手机号');
    return phone;
}
export async function studentPasswordHash(password: string) { const salt = crypto.randomBytes(16).toString('hex'), key = await scrypt(password, salt, 64) as Buffer; return `scrypt:${salt}:${key.toString('hex')}`; }
export async function studentPasswordMatches(password: string, stored: string) {
    const [kind, salt, key] = stored.split(':');
    if (kind !== 'scrypt' || !salt || !/^[a-f0-9]{128}$/.test(key))
        return false;
    const actual = await scrypt(password, salt, 64) as Buffer;
    return crypto.timingSafeEqual(actual, Buffer.from(key, 'hex'));
}
export function studentPassword(value: unknown) {
    if (typeof value !== 'string' || value.length < 10 || value.length > 128 || value.includes('\0'))
        return fail('密码请使用 10–128 个字符');
    return value;
}
export const allStudentAccounts = (db: Database) => db.users.flatMap(user => user.teaching?.studentAccounts ?? []);
export const allStudentMemberships = (db: Database) => db.users.flatMap(user => user.teaching?.studentMemberships ?? []);
export function studentAccount(db: Database, id: string) {
    const a = allStudentAccounts(db).find(a => a.id === id);
    if (!a)
        return fail('学生账号不可用', 401);
    return a;
}
export function authenticatedStudent(db: Database, token: string, allowInitial = false) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token))
        return fail('请使用老师发放的账号登录', 401);
    const h = studentHash(token);
    for (const account of allStudentAccounts(db)) {
        const login = account.logins.find(l => l.tokenHash === h && !l.revokedAt && l.authVersion === account.authVersion && l.expiresAt > now());
        if (login) {
            if (account.mustChangePassword && !allowInitial)
                return fail('请先修改初始密码', 403);
            return { account, login };
        }
    }
    return fail('登录已过期，请重新登录', 401);
}
export function studentLogin(db: Database, id: string) { const account = studentAccount(db, id), token = crypto.randomBytes(32).toString('base64url'), createdAt = now(); const login = { workspaceId: account.workspaceId, userId: account.userId, id: uid('slogin'), tokenHash: studentHash(token), authVersion: account.authVersion, createdAt, expiresAt: new Date(Date.now() + 30 * 86400000).toISOString() }; account.logins = account.logins.filter(l => !l.revokedAt && l.expiresAt > createdAt).slice(-19); account.logins.push(login); return { token, account, login }; }
export function studentProfile(account: StudentAccount) { return { id: account.id, phone: account.phone, mustChangePassword: account.mustChangePassword }; }
function classInput(db: Database, scope: TeachingScope, b: Record<string, any>) {
    if (!Array.isArray(b.courseIds) || !b.courseIds.length || b.courseIds.length > 30)
        return fail('请为班级选择课程');
    const ids = [...new Set(b.courseIds.map((id: unknown) => text(id, '课程编号', 120)))], courses = ids.map(id => ownedTeachingCourse(db, scope, id));
    const name = text(b.name, '班级名称', 80);
    if (b.active !== undefined && typeof b.active !== 'boolean')
        return fail('请明确班级状态');
    if (b.storyIds !== undefined && (!Array.isArray(b.storyIds) || b.storyIds.length > 100))
        return fail('课堂作品选择无效');
    const stories = teacherClassStories(db, scope), storyIds = [...new Set(b.storyIds ?? [])] as string[];
    if (storyIds.some(id => !stories.some(story => story.id === id && ids.includes(story.courseId))))
        return fail('只能布置本班课程中老师审核通过的作品');
    return { name, courseIds: ids, storyIds, active: b.active ?? true, courses };
}
export function createStudentClass(db: Database, scope: TeachingScope, input: unknown) {
    const b = studentObject(input), s = teachingState(db, scope, { create: true }), value = classInput(db, scope, b), key = text(b.createKey, '创建编号', 100);
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(key))
        return fail('创建编号无效');
    const hash = studentHash(JSON.stringify([value.name, value.courseIds, value.storyIds]));
    const old = s.studentClasses?.find(c => same(c, scope) && c.createKey === key);
    if (old) {
        if (old.createHash !== hash)
            return fail('原创建编号对应另一份班级资料', 409);
        return old;
    }
    if ((s.studentClasses?.length ?? 0) >= 100)
        return fail('班级数量已达上限');
    const c: StudentClass = { ...scope, id: uid('sclass'), name: value.name, courseIds: value.courseIds, storyIds: value.storyIds, createKey: key, createHash: hash, revision: 1, createdAt: now() };
    value.courses.forEach(course => course.studentAccountsOnly = true);
    (s.studentClasses ??= []).push(c);
    s.studentPortalSlug ??= crypto.randomBytes(24).toString('base64url');
    return c;
}
export function ownedStudentClass(db: Database, scope: TeachingScope, id: string) {
    const s = teachingState(db, scope), c = s.studentClasses?.find(c => c.id === id && same(c, scope));
    if (!c)
        return fail('班级不存在', 404);
    return c;
}
export function updateStudentClass(db: Database, scope: TeachingScope, id: string, input: unknown) {
    const c = ownedStudentClass(db, scope, id), b = studentObject(input);
    if (c.deletedAt)
        return fail('班级已在回收站，请先恢复', 409);
    if (b.revision !== c.revision)
        return fail('班级已更新，请刷新后重试', 409);
    const v = classInput(db, scope, b);
    v.courses.forEach(course => course.studentAccountsOnly = true);
    c.active = v.active;
    c.name = v.name;
    c.courseIds = v.courseIds;
    c.storyIds = v.storyIds;
    c.revision++;
    return c;
}
export type RosterRow = {
    name: string;
    phone: string;
    studentNumber: string;
};
export function rosterRows(value: unknown): RosterRow[] {
    if (!Array.isArray(value) || !value.length || value.length > 200)
        return fail('每批请导入 1–200 名学生');
    const phones = new Set<string>();
    return value.map(value => {
        const b = studentObject(value), phone = studentPhone(b.phone);
        if (phones.has(phone))
            return fail(`手机号 ${phone} 在本批名单中重复`);
        phones.add(phone);
        return { name: text(b.name, '姓名', 80), phone, studentNumber: b.studentNumber === undefined ? '' : text(b.studentNumber, '学号', 100, false) };
    });
}
const provisionContext = (scope: TeachingScope, id: string) => `student-provision:${scope.workspaceId}:${scope.userId}:${id}`;
export async function prepareStudentProvision(rows: RosterRow[]) {
    const result = [];
    for (let i = 0; i < rows.length; i += 4) {
        result.push(...await Promise.all(rows.slice(i, i + 4).map(async (row) => { const password = crypto.randomBytes(12).toString('base64url'); return { ...row, password, passwordHash: await studentPasswordHash(password) }; })));
    }
    return result;
}
export function provisionStudents(db: Database, scope: TeachingScope, classId: string, input: unknown, prepared: Awaited<ReturnType<typeof prepareStudentProvision>>) {
    const c = ownedStudentClass(db, scope, classId), b = studentObject(input), rows = rosterRows(b.rows), s = teachingState(db, scope, { create: true }), requestId = text(b.requestId, '请求编号', 100);
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(requestId))
        return fail('请求编号无效');
    const payloadHash = studentHash(JSON.stringify({ classId, classRevision: b.classRevision, rows }));
    const prior = s.studentProvisions?.find(p => same(p, scope) && p.requestId === requestId);
    if (prior) {
        if (prior.payloadHash !== payloadHash)
            return fail('该请求已用于另一批名单', 409);
        return prior;
    }
    if (c.deletedAt)
        return fail('班级已在回收站，请先恢复', 409);
    if (b.classRevision !== c.revision)
        return fail('班级课程已更新，请重新预览名单', 409);
    if ((s.studentMemberships?.length ?? 0) + rows.length > 5000)
        return fail('学生名单数量已达上限');
    if (prepared.length !== rows.length || prepared.some((r, i) => r.phone !== rows[i].phone || r.name !== rows[i].name || r.studentNumber !== rows[i].studentNumber))
        return fail('名单已变化，请重新导入', 409);
    const credentials: Record<string, string>[] = [], createdAt = now();
    let newAccounts = 0, linkedAccounts = 0;
    for (const [i, row] of rows.entries()) {
        let account = allStudentAccounts(db).find(a => a.phone === row.phone), password = '';
        if (!account) {
            const p = prepared[i];
            account = { ...scope, id: uid('student'), phone: row.phone, passwordHash: p.passwordHash, authVersion: 0, mustChangePassword: true, createdAt, logins: [], drafts: [] };
            (s.studentAccounts ??= []).push(account);
            password = p.password;
            newAccounts++;
        }
        else
            linkedAccounts++;
        let m = s.studentMemberships?.find(m => same(m, scope) && m.classId === c.id && m.studentId === account!.id);
        if (m) {
            m.name = row.name;
            m.studentNumber = row.studentNumber;
            m.active = true;
        }
        else {
            m = { ...scope, id: uid('enroll'), classId: c.id, studentId: account.id, name: row.name, phone: row.phone, studentNumber: row.studentNumber, active: true, createdAt };
            (s.studentMemberships ??= []).push(m);
        }
        credentials.push({ 姓名: row.name, 手机号: row.phone, 学号: row.studentNumber, 班级: c.name, 初始密码: password, 说明: password ? '首次登录请修改密码' : '已有账号，使用原密码' });
    }
    const id = uid('provision'), receipt: StudentProvision = { ...scope, id, requestId, payloadHash, classId, encryptedCredentials: encryptCredential(JSON.stringify(credentials), provisionContext(scope, id)), createdAt, expiresAt: new Date(Date.now() + 86400000).toISOString(), newAccounts, linkedAccounts };
    (s.studentProvisions ??= []).push(receipt);
    return receipt;
}
export function provisionCsv(db: Database, scope: TeachingScope, id: string) {
    teachingMember(db, scope);
    const p = teachingState(db, scope).studentProvisions?.find(p => same(p, scope) && p.id === id);
    if (!p)
        return fail('发放记录不存在', 404);
    if (p.expiresAt < now())
        return fail('初始密码发放表已过期，请使用账号重置功能', 410);
    const rows = JSON.parse(decryptCredential(p.encryptedCredentials, provisionContext(scope, id))) as Record<string, string>[];
    const columns = ['姓名', '手机号', '学号', '班级', '初始密码', '说明'];
    const csv = (v: string) => '"' + (/^[=+@\-\t\r]/.test(v) ? "'" + v : v).replaceAll('"', '""') + '"';
    return '\uFEFF' + [columns, ...rows.map(row => columns.map(k => row[k]))].map(row => row.map(csv).join(',')).join('\r\n');
}
export function publicProvision(p: StudentProvision) { return { id: p.id, classId: p.classId, requestId: p.requestId, newAccounts: p.newAccounts, linkedAccounts: p.linkedAccounts, createdAt: p.createdAt, expiresAt: p.expiresAt }; }
export function rosterClassForStudent(db: Database, studentId: string, membershipId: string, courseId: string) {
    const m = allStudentMemberships(db).find(m => m.id === membershipId && m.studentId === studentId && m.active);
    if (!m)
        return fail('你未加入这个班级', 403);
    const c = ownedStudentClass(db, m, m.classId);
    if (c.deletedAt || c.active === false)
        return fail('班级已停用', 403);
    if (!c.courseIds.includes(courseId))
        return fail('这门课程未分配给本班', 403);
    const course = ownedTeachingCourse(db, m, courseId);
    return { membership: m, classroom: c, course };
}
export function accountRequiredForCourse(db: Database, scope: TeachingScope, courseId: string) { return ownedTeachingCourse(db, scope, courseId).studentAccountsOnly === true || (teachingState(db, scope).studentClasses?.some(c => same(c, scope) && c.courseIds.includes(courseId)) ?? false); }
export function validBoundStudentSession(db: Database, s: TeachingSession, hash: string) {
    if (!s.studentAccountId)
        return s.tokenHash === hash;
    try {
        const a = studentAccount(db, s.studentAccountId);
        if (a.mustChangePassword)
            return false;
        const grant = rosterClassForStudent(db, a.id, s.studentMembershipId ?? '', s.courseId);
        if (!same(grant.membership, s))
            return false;
        return s.studentAccessTokens?.some(t => t.tokenHash === hash && t.expiresAt > now() && t.authVersion === a.authVersion && a.logins.some(l => l.id === t.loginId && !l.revokedAt && l.authVersion === a.authVersion && l.expiresAt > now())) ?? false;
    }
    catch {
        return false;
    }
}
export function studentActivityAccess(db: Database, token: string, input: unknown) {
    const { account, login } = authenticatedStudent(db, token), b = studentObject(input), { membership: m, course } = rosterClassForStudent(db, account.id, text(b.membershipId, '选课编号', 120), text(b.courseId, '课程编号', 120));
    const activity = course.activities.find(a => a.id === b.activityId && !a.deletedAt && a.status === 'published');
    if (!activity)
        return fail('该活动尚未开放', 404);
    const slug = activity.isOpen === true ? activity.slug : course.status === 'published' && activity.isOpen !== false ? course.slug : undefined;
    if (!slug)
        return fail('老师尚未开放这项学习内容', 403);
    if (b.storyId !== undefined) {
        const classroom = ownedStudentClass(db, m, m.classId);
        if (!classroom.storyIds?.includes(b.storyId))
            return fail('这份作品未布置给本班', 403);
        const story = teacherClassStories(db, m).find(story => story.id === b.storyId && story.courseId === course.id && story.activityId === activity.id);
        if (!story)
            return fail('课堂作品不可用', 404);
    }
    activeTeachingAccess(db, slug);
    const s = teachingState(db, m, { create: true });
    let session = s.sessions.find(s => same(s, m) && s.courseId === course.id && s.activityId === (activity.slug === slug ? activity.id : undefined) && s.studentAccountId === account.id && s.studentMembershipId === m.id);
    if (!session) {
        const result = createTeachingSession(db, slug, { participantName: m.name, participantRef: m.studentNumber, participantClass: ownedStudentClass(db, m, m.classId).name, consent: true }, { studentAccountId: account.id, studentMembershipId: m.id });
        session = s.sessions.find(s => s.id === result.sessionId)!;
    }
    const access = crypto.randomBytes(32).toString('base64url');
    session.participantName = m.name;
    session.participantRef = m.studentNumber;
    session.participantClass = ownedStudentClass(db, m, m.classId).name;
    session.createdAt = now();
    session.expiresAt = session.expiresAt > login.expiresAt ? session.expiresAt : login.expiresAt;
    session.activityAccessRevisions = Object.fromEntries(course.activities.filter(a => a.status === 'published' && !a.deletedAt && a.isOpen !== false).map(a => [a.id, a.accessRevision ?? 0]));
    session.studentAccessTokens = (session.studentAccessTokens ?? []).filter(t => t.expiresAt > now() && t.authVersion === account.authVersion).slice(-19);
    session.studentAccessTokens.push({ tokenHash: studentHash(`${slug}:${access}`), loginId: login.id, authVersion: account.authVersion, expiresAt: login.expiresAt });
    return { slug, token: access, activityId: activity.id, ...(b.storyId ? { storyId: b.storyId } : {}) };
}
export function studentCourses(db: Database, studentId: string) {
    const result = [];
    for (const m of allStudentMemberships(db).filter(m => m.studentId === studentId && m.active)) {
        try {
            const c = ownedStudentClass(db, m, m.classId);
            if (c.deletedAt || c.active === false)
                continue;
            const teacher = db.users.find(u => u.id === m.userId)!;
            for (const id of c.courseIds) {
                try {
                    const course = ownedTeachingCourse(db, m, id);
                    result.push({ membershipId: m.id, classId: c.id, className: c.name, studentName: m.name, studentNumber: m.studentNumber, teacherName: teacher.profile?.displayName || teacher.username, teacherPortal: teacher.teaching?.studentPortalSlug, id: course.id, title: course.title, stories: teacherClassStories(db, m).filter(story => story.courseId === course.id && c.storyIds?.includes(story.id) && course.activities.some(a => a.id === story.activityId && !a.deletedAt && a.status === 'published' && (a.isOpen === true || course.status === 'published' && a.isOpen !== false))), activities: course.activities.filter(a => !a.deletedAt && a.status === 'published' && (a.isOpen === true || course.status === 'published' && a.isOpen !== false)).map(a => ({ id: a.id, title: a.title, kind: a.kind, stage: a.stage })) });
                }
                catch { /* Deleted courses grant no access. */ }
            }
        }
        catch { /* Inactive teacher/workspace grants no course access. */ }
    }
    return result;
}
export function saveStudentScript(db: Database, token: string, input: unknown) {
    const { account: a } = authenticatedStudent(db, token), b = studentObject(input), id = text(b.id, '剧本编号', 120);
    if (!/^[A-Za-z0-9_-]{8,120}$/.test(id) || !Number.isSafeInteger(b.revision) || b.revision < 0)
        return fail('请检查剧本版本');
    const title = text(b.title, '剧本名称', 160), body = text(b.text, '剧本正文', 60000);
    let d = a.drafts.find(d => d.id === id && d.studentId === a.id);
    if (d?.deletedAt)
        return fail('剧本已在回收站，请先恢复', 409);
    if (d && d.revision !== b.revision) {
        if (d.revision === b.revision + 1 && d.title === title && d.text === body)
            return d;
        return fail('剧本已更新，请刷新后核对', 409);
    }
    if (!d) {
        if (b.revision !== 0)
            return fail('剧本不存在', 404);
        if (a.drafts.length >= 50)
            return fail('请先整理已有剧本');
        d = { workspaceId: a.workspaceId, userId: a.userId, id, studentId: a.id, title: '', text: '', revision: 0, updatedAt: now() };
        a.drafts.push(d);
    }
    d.title = title;
    d.text = body;
    d.revision++;
    d.updatedAt = now();
    return d;
}
export function submitStudentScript(db: Database, token: string, input: unknown) {
    const { account: a } = authenticatedStudent(db, token), b = studentObject(input), { membership: m, course } = rosterClassForStudent(db, a.id, text(b.membershipId, '选课编号', 120), text(b.courseId, '课程编号', 120));
    const s = teachingState(db, m, { create: true }), requestId = text(b.requestId, '请求编号', 100);
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(requestId))
        return fail('请求编号无效');
    const payloadHash = studentHash(JSON.stringify([course.id, m.id, b.draftId, b.draftRevision]));
    const old = s.studentScriptSubmissions?.find(r => same(r, m) && r.studentId === a.id && r.requestId === requestId);
    if (old) {
        if (old.payloadHash !== payloadHash)
            return fail('原请求对应另一份提交', 409);
        return old;
    }
    const d = a.drafts.find(d => d.id === b.draftId && d.studentId === a.id);
    if (!d || d.deletedAt)
        return fail('请先保存自己的剧本', 404);
    if (b.draftRevision !== d.revision)
        return fail('剧本版本已变化，请核对后提交', 409);
    if ((s.studentScriptSubmissions?.length ?? 0) >= 10000)
        return fail('提交数量已达上限，请联系老师');
    const record = { workspaceId: m.workspaceId, userId: m.userId, id: uid('ssubmit'), studentId: a.id, membershipId: m.id, courseId: course.id, title: d.title, text: d.text, draftId: d.id, draftRevision: d.revision, requestId, payloadHash, createdAt: now() };
    (s.studentScriptSubmissions ??= []).push(record);
    return record;
}
export function reissueStudentCredential(db: Database, scope: TeachingScope, classId: string, memberId: string, requestId: string, prepared: Awaited<ReturnType<typeof prepareStudentProvision>>) {
    const c = ownedStudentClass(db, scope, classId), s = teachingState(db, scope), m = s.studentMemberships?.find(m => same(m, scope) && m.id === memberId && m.classId === c.id);
    if (!m)
        return fail('学生不在本班', 404);
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(requestId))
        return fail('请求编号无效');
    const hash = studentHash(JSON.stringify(['reissue', classId, memberId]));
    const prior = s.studentProvisions?.find(p => same(p, scope) && p.requestId === requestId);
    if (prior) {
        if (prior.payloadHash !== hash)
            return fail('原请求对应另一项发放', 409);
        return prior;
    }
    if (c.deletedAt)
        return fail('班级已在回收站，请先恢复', 409);
    const a = studentAccount(db, m.studentId);
    if (!same(a, scope))
        return fail('不能重发其他老师发放的账号', 403);
    if (!a.mustChangePassword)
        return fail('学生已设置个人密码，请由学生自行修改或使用恢复码找回', 409);
    if (allStudentMemberships(db).some(x => x.studentId === a.id && !same(x, scope)))
        return fail('该账号已关联其他老师，请使用原发放表', 409);
    if (prepared.length !== 1 || prepared[0].phone !== a.phone)
        return fail('账号资料已变化，请刷新', 409);
    const id = uid('provision'), createdAt = now(), p = prepared[0];
    const receipt: StudentProvision = { ...scope, id, requestId, payloadHash: hash, classId, encryptedCredentials: encryptCredential(JSON.stringify([{ 姓名: m.name, 手机号: m.phone, 学号: m.studentNumber, 班级: c.name, 初始密码: p.password, 说明: '重新发放，原初始密码已失效' }]), provisionContext(scope, id)), createdAt, expiresAt: new Date(Date.now() + 86400000).toISOString(), newAccounts: 0, linkedAccounts: 1 };
    a.passwordHash = p.passwordHash;
    a.authVersion++;
    a.logins = [];
    (s.studentProvisions ??= []).push(receipt);
    return receipt;
}
export function teacherClassStories(db: Database, scope: TeachingScope) { const s = teachingState(db, scope); return s.operations.filter(o => o.workspaceId === scope.workspaceId && o.userId === scope.userId && !o.sessionId && o.kind === 'script' && o.status === 'completed' && (o.result as any)?.approved && (o.result as any)?.directorPrompt && s.courses.some(c => c.id === o.courseId && !c.deletedAt && c.activities.some(a => a.id === o.activityId && !a.deletedAt))).map(o => ({ id: o.id, title: String((o.result as any).title ?? '课堂作品'), courseId: o.courseId, activityId: o.activityId! })); }
export function assertStudentStoryPermission(db: Database, session: TeachingSession, kind: string, storyId: unknown) {
    if (!session.studentAccountId)
        return;
    if (kind === 'answer' && teachingState(db, session).courses.some(c => c.id === session.courseId && c.activities.some(a => a.id === session.activityId && a.kind === 'game')))
        return fail('请使用老师布置的课堂游戏，个人 AI 试玩暂未开放', 403);
    if (kind === 'script')
        return fail('个人剧本的 AI 创作暂未开放，可以先保存并提交给老师', 403);
    if (kind === 'story_turn' || kind === 'story_image' || kind === 'read_story') {
        const { classroom, course } = rosterClassForStudent(db, session.studentAccountId, session.studentMembershipId ?? '', session.courseId);
        if (typeof storyId !== 'string' || !classroom.storyIds?.includes(storyId) || !teacherClassStories(db, session).some(story => story.id === storyId && story.courseId === course.id && (!session.activityId || story.activityId === session.activityId)))
            return fail('这份课堂作品未布置给本班', 403);
    }
}
