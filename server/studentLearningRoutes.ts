import type { Express, Request, RequestHandler, Response } from 'express';
import type { Store } from './db.js';
import { TeachingError, teachingState, teachingMember } from './teaching.js';
import { allStudentAccounts, authenticatedStudent, createStudentClass, ownedStudentClass, updateStudentClass, rosterRows, prepareStudentProvision, provisionStudents, provisionCsv, publicProvision, studentLogin, studentPassword, studentPasswordHash, studentPasswordMatches, studentPhone, studentProfile, studentHash, studentCourses, studentActivityAccess, saveStudentScript, submitStudentScript, studentObject, allStudentMemberships, teacherClassStories, reissueStudentCredential } from './studentLearning.js';
import { randomBytes } from 'node:crypto';
const cookieName = 'one_student_session';
const cookieToken = (req: Request) => { const value = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith(cookieName + '='))?.slice(cookieName.length + 1); return value ?? ''; };
const setCookie = (res: Response, token: string) => res.setHeader('Set-Cookie', `${cookieName}=${token}; Path=/api/learning; HttpOnly; SameSite=Strict; Max-Age=${token ? 30 * 86400 : 0}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
const owner = (req: Request) => {
    if (!req.user?.id || !req.workspaceId)
        throw new TeachingError('请登录教师账号', 401);
    return { userId: req.user.id, workspaceId: req.workspaceId };
};
const route = (run: (req: Request, res: Response) => Promise<unknown>): RequestHandler => (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    Promise.resolve().then(() => run(req, res)).catch(e => {
        if (e instanceof TeachingError)
            res.status(e.status).json({ error: e.message, code: e.code });
        else
            next(e);
    });
};
export function installStudentLearningRoutes(app: Express, teacherAuth: readonly RequestHandler[], store: Store, deps: {
    verifyKey: (req: Request) => Promise<void>;
}) {
    const rates = new Map<string, {
        at: number;
        count: number;
    }>();
    const limit = (key: string, max: number, ms: number) => {
        const now = Date.now();
        if (rates.size > 10000)
            for (const [k, v] of rates)
                if (now - v.at > ms)
                    rates.delete(k);
        if (rates.size >= 15000 && !rates.has(key))
            throw new TeachingError('访问较集中，请稍后重试', 429);
        let r = rates.get(key);
        if (!r || now - r.at > ms) {
            r = { at: now, count: 0 };
            rates.set(key, r);
        }
        if (++r.count > max)
            throw new TeachingError('尝试过于频繁，请稍后再试', 429);
    };
    const write: RequestHandler = (req, res, next) => {
        if (req.get('X-Student-Request') !== '1' || req.get('Sec-Fetch-Site') === 'cross-site') {
            res.status(403).json({ error: '请从学习空间提交操作' });
            return;
        }
        next();
    };
    const base = '/api/teaching/student-classes';
    app.get(base, ...teacherAuth, route(async (req, res) => { const scope = owner(req), db = await store.read(), s = teachingState(db, scope); res.json({ classes: (s.studentClasses ?? []).filter(c => c.userId === scope.userId && c.workspaceId === scope.workspaceId), memberships: (s.studentMemberships ?? []).filter(m => m.userId === scope.userId && m.workspaceId === scope.workspaceId).map(m => ({ ...m, canReissue: allStudentAccounts(db).some(a => a.id === m.studentId && a.mustChangePassword && a.userId === scope.userId && a.workspaceId === scope.workspaceId && !allStudentMemberships(db).some(x => x.studentId === a.id && (x.userId !== scope.userId || x.workspaceId !== scope.workspaceId))) })), portalPath: s.studentPortalSlug ? `/learn?teacher=${s.studentPortalSlug}` : '/learn', stories: teacherClassStories(db, scope), provisions: (s.studentProvisions ?? []).filter(p => p.userId === scope.userId && p.workspaceId === scope.workspaceId).map(publicProvision) }); }));
    app.post(base, ...teacherAuth, route(async (req, res) => { await deps.verifyKey(req); res.status(201).json({ classroom: await store.mutate(db => createStudentClass(db, owner(req), req.body)) }); }));
    app.patch(base + '/:id', ...teacherAuth, route(async (req, res) => { await deps.verifyKey(req); res.json({ classroom: await store.mutate(db => updateStudentClass(db, owner(req), String(req.params.id), req.body)) }); }));
    app.patch(base + '/:id/trash', ...teacherAuth, route(async (req, res) => { await deps.verifyKey(req); const scope = owner(req); return res.json(await store.mutate(db => { const c = ownedStudentClass(db, scope, String(req.params.id)); if (c.revision !== req.body?.revision || typeof req.body?.restore !== 'boolean')
        throw new TeachingError('班级已变化，请刷新后重试', 409); if (req.body.restore)
        delete c.deletedAt;
    else
        c.deletedAt = new Date().toISOString(); c.active = false; c.revision++; return { classroom: c }; })); }));
    app.post(base + '/:id/preview', ...teacherAuth, route(async (req, res) => { const db = await store.read(), scope = owner(req); ownedStudentClass(db, scope, String(req.params.id)); const rows = rosterRows(req.body?.rows); res.json({ rows: rows.map(row => ({ ...row, existingAccount: allStudentAccounts(db).some(a => a.phone === row.phone) })) }); }));
    app.post(base + '/:id/import', ...teacherAuth, route(async (req, res) => {
        await deps.verifyKey(req);
        const scope = owner(req), classId = String(req.params.id), input = structuredClone(req.body);
        ownedStudentClass(await store.read(), scope, classId);
        const rows = rosterRows(input?.rows);
        const previous = teachingState(await store.read(), scope).studentProvisions?.some(p => p.requestId === input.requestId && p.userId === scope.userId && p.workspaceId === scope.workspaceId);
        if (previous) {
            const p = await store.mutate(db => provisionStudents(db, scope, classId, input, []));
            res.json({ provision: publicProvision(p) });
            return;
        }
        limit(`import:${scope.workspaceId}:${scope.userId}`, 10, 60000);
        const prepared = await prepareStudentProvision(rows);
        await deps.verifyKey(req);
        const p = await store.mutate(db => provisionStudents(db, scope, classId, input, prepared));
        res.json({ provision: publicProvision(p) });
    }));
    app.get(base + '/:id/provisions/:pid/export', ...teacherAuth, route(async (req, res) => {
        await deps.verifyKey(req);
        const db = await store.read(), scope = owner(req);
        ownedStudentClass(db, scope, String(req.params.id));
        const p = teachingState(db, scope).studentProvisions?.find(p => p.id === req.params.pid && p.classId === req.params.id);
        if (!p)
            throw new TeachingError('发放表不存在', 404);
        res.type('text/csv').setHeader('Content-Disposition', 'attachment; filename="student-accounts.csv"');
        res.send(provisionCsv(db, scope, p.id));
    }));
    app.patch(base + '/:id/members/:mid', ...teacherAuth, route(async (req, res) => {
        await deps.verifyKey(req);
        const scope = owner(req);
        res.json(await store.mutate(db => {
            ownedStudentClass(db, scope, String(req.params.id));
            const m = teachingState(db, scope).studentMemberships?.find(m => m.id === req.params.mid && m.classId === req.params.id && m.userId === scope.userId && m.workspaceId === scope.workspaceId);
            if (!m)
                throw new TeachingError('学生不在本班', 404);
            if (typeof req.body?.active !== 'boolean')
                throw new TeachingError('请明确学生是否在班');
            m.active = req.body.active;
            return { membership: m };
        }));
    }));
    // Reissuing an unactivated credential never gives a teacher the password a
    // student has chosen, or access to another teacher's existing account.
    app.post(base + '/:id/members/:mid/reissue', ...teacherAuth, route(async (req, res) => {
        await deps.verifyKey(req);
        const scope = owner(req), db = await store.read(), classId = String(req.params.id), mid = String(req.params.mid), requestId = String(req.body?.requestId ?? '');
        ownedStudentClass(db, scope, classId);
        const m = teachingState(db, scope).studentMemberships?.find(m => m.id === mid && m.classId === classId && m.userId === scope.userId && m.workspaceId === scope.workspaceId);
        if (!m)
            throw new TeachingError('学生不在本班', 404);
        const prior = teachingState(db, scope).studentProvisions?.some(p => p.requestId === requestId && p.userId === scope.userId && p.workspaceId === scope.workspaceId);
        const prepared = prior ? [] : await prepareStudentProvision([{ name: m.name, phone: m.phone, studentNumber: m.studentNumber }]);
        await deps.verifyKey(req);
        const p = await store.mutate(fresh => reissueStudentCredential(fresh, scope, classId, mid, requestId, prepared));
        res.json({ provision: publicProvision(p) });
    }));
    app.get('/api/teaching/student-script-submissions', ...teacherAuth, route(async (req, res) => { const scope = owner(req), db = await store.read(), s = teachingState(db, scope); const records = (s.studentScriptSubmissions ?? []).filter(r => r.workspaceId === scope.workspaceId && r.userId === scope.userId).map(r => ({ ...r, studentName: s.studentMemberships?.find(m => m.id === r.membershipId)?.name ?? '', className: s.studentClasses?.find(c => s.studentMemberships?.some(m => m.id === r.membershipId && m.classId === c.id))?.name ?? '' })); res.json({ submissions: records }); }));
    app.get('/api/learning/portal/:slug', route(async (req, res) => {
        const db = await store.read(), user = db.users.find(u => u.enabled && u.teaching?.studentPortalSlug === req.params.slug);
        if (!user)
            throw new TeachingError('学习入口不存在', 404);
        res.json({ teacherName: user.profile?.displayName || user.username });
    }));
    app.post('/api/learning/login', write, route(async (req, res) => {
        limit(`login-ip:${req.ip}`, 300, 60000);
        const b = studentObject(req.body), phone = studentPhone(b.phone);
        limit(`login:${phone}`, 12, 15 * 60000);
        const password = typeof b.password === 'string' && b.password.length <= 128 ? b.password : '';
        const a = allStudentAccounts(await store.read()).find(a => a.phone === phone);
        const hashSnapshot = a?.passwordHash, versionSnapshot = a?.authVersion;
        const valid = await studentPasswordMatches(password, hashSnapshot ?? 'scrypt:00000000000000000000000000000000:' + '00'.repeat(64));
        if (!a || !valid)
            throw new TeachingError('账号或密码不正确', 401);
        const result = await store.mutate(db => {
            const fresh = allStudentAccounts(db).find(x => x.id === a.id);
            if (!fresh || fresh.passwordHash !== hashSnapshot || fresh.authVersion !== versionSnapshot)
                throw new TeachingError('账号状态已变化，请重新登录', 401);
            return studentLogin(db, fresh.id);
        });
        setCookie(res, result.token);
        res.json({ student: studentProfile(result.account) });
    }));
    app.get('/api/learning/me', route(async (req, res) => { const { account } = authenticatedStudent(await store.read(), cookieToken(req), true); res.json({ student: studentProfile(account) }); }));
    app.post('/api/learning/logout', write, route(async (req, res) => {
        await store.mutate(db => {
            try {
                authenticatedStudent(db, cookieToken(req), true).login.revokedAt = new Date().toISOString();
            }
            catch { }
        });
        setCookie(res, '');
        res.json({ ok: true });
    }));
    app.post('/api/learning/password', write, route(async (req, res) => {
        const token = cookieToken(req), b = studentObject(req.body), { account } = authenticatedStudent(await store.read(), token, true), oldHash = account.passwordHash, newPassword = studentPassword(b.newPassword);
        if (newPassword === b.currentPassword)
            throw new TeachingError('请设置一个与初始或当前密码不同的新密码');
        limit(`password:${account.id}`, 10, 15 * 60000);
        if (!await studentPasswordMatches(String(b.currentPassword ?? ''), oldHash))
            throw new TeachingError('当前密码不正确', 401);
        const passwordHash = await studentPasswordHash(newPassword), recoveryCode = randomBytes(18).toString('base64url');
        const result = await store.mutate(db => {
            const { account: a } = authenticatedStudent(db, token, true);
            if (a.passwordHash !== oldHash)
                throw new TeachingError('密码已变化，请重新登录', 409);
            a.passwordHash = passwordHash;
            a.recoveryHash = studentHash(recoveryCode);
            a.mustChangePassword = false;
            a.authVersion++;
            a.logins = [];
            return studentLogin(db, a.id);
        });
        setCookie(res, result.token);
        res.json({ student: studentProfile(result.account), recoveryCode });
    }));
    app.post('/api/learning/recover', write, route(async (req, res) => {
        limit(`recover-ip:${req.ip}`, 30, 60000);
        const b = studentObject(req.body), phone = studentPhone(b.phone);
        limit(`recover:${phone}`, 8, 15 * 60000);
        const password = studentPassword(b.newPassword), a = allStudentAccounts(await store.read()).find(a => a.phone === phone);
        const recovery = studentHash(String(b.recoveryCode ?? ''));
        if (!a?.recoveryHash || a.recoveryHash !== recovery)
            throw new TeachingError('账号或恢复码不正确', 401);
        const passwordHash = await studentPasswordHash(password), recoveryCode = randomBytes(18).toString('base64url');
        const result = await store.mutate(db => {
            const fresh = allStudentAccounts(db).find(x => x.id === a.id && x.recoveryHash === recovery);
            if (!fresh)
                throw new TeachingError('恢复码已失效', 401);
            fresh.passwordHash = passwordHash;
            fresh.recoveryHash = studentHash(recoveryCode);
            fresh.authVersion++;
            fresh.mustChangePassword = false;
            fresh.logins = [];
            return studentLogin(db, fresh.id);
        });
        setCookie(res, result.token);
        res.json({ student: studentProfile(result.account), recoveryCode });
    }));
    app.get('/api/learning/courses', route(async (req, res) => { const db = await store.read(), { account } = authenticatedStudent(db, cookieToken(req)); res.json({ courses: studentCourses(db, account.id) }); }));
    app.post('/api/learning/access', write, route(async (req, res) => res.json(await store.mutate(db => studentActivityAccess(db, cookieToken(req), req.body)))));
    app.get('/api/learning/scripts', route(async (req, res) => { const db = await store.read(), { account } = authenticatedStudent(db, cookieToken(req)); const submitted = db.users.flatMap(u => u.teaching?.studentScriptSubmissions ?? []).filter(r => r.studentId === account.id).map(({ id, title, courseId, createdAt, draftId, draftRevision }) => ({ id, title, courseId, createdAt, draftId, draftRevision })); res.json({ drafts: account.drafts.map(({ id, title, text, revision, updatedAt, deletedAt }) => ({ id, title, text, revision, updatedAt, deletedAt })), submissions: submitted }); }));
    app.post('/api/learning/scripts', write, route(async (req, res) => { const d = await store.mutate(db => saveStudentScript(db, cookieToken(req), req.body)); return res.json({ draft: { id: d.id, title: d.title, text: d.text, revision: d.revision, updatedAt: d.updatedAt } }); }));
    app.post('/api/learning/scripts/submit', write, route(async (req, res) => { const r = await store.mutate(db => submitStudentScript(db, cookieToken(req), req.body)); return res.json({ submission: { id: r.id, courseId: r.courseId, draftId: r.draftId, draftRevision: r.draftRevision, createdAt: r.createdAt } }); }));
    app.get('/api/learning/submissions', route(async (req, res) => { const db = await store.read(), { account } = authenticatedStudent(db, cookieToken(req)); const { rosterClassForStudent } = await import('./studentLearning.js'); const { publicTeachingSubmission } = await import('./teaching.js'); const { membership: m } = rosterClassForStudent(db, account.id, String(req.query.membershipId ?? ''), String(req.query.courseId ?? '')); const s = teachingState(db, m), ids = new Set(s.sessions.filter(s => s.studentAccountId === account.id && s.studentMembershipId === m.id && s.courseId === req.query.courseId).map(s => s.id)); res.json({ submissions: s.submissions.filter(r => r.workspaceId === m.workspaceId && r.userId === m.userId && r.courseId === req.query.courseId && ids.has(r.sessionId ?? '')).map(publicTeachingSubmission) }); }));
    app.patch('/api/learning/scripts/:id/trash', write, route(async (req, res) => res.json(await store.mutate(db => {
        const { account } = authenticatedStudent(db, cookieToken(req));
        const d = account.drafts.find(d => d.id === req.params.id);
        if (!d)
            throw new TeachingError('剧本不存在', 404);
        if (d.revision !== req.body?.revision || typeof req.body?.restore !== 'boolean')
            throw new TeachingError('剧本已变化，请刷新后核对', 409);
        if (req.body.restore)
            delete d.deletedAt;
        else
            d.deletedAt = new Date().toISOString();
        d.revision++;
        return { ok: true };
    }))));
}
