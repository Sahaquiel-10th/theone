import { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpen, Check, ChevronDown, ClipboardCheck, Copy, FileText, Gamepad2, KeyRound, LogOut, MessageSquareText, RefreshCw } from 'lucide-react';
import { TeachingPublicPage } from './TeachingPublicPage';
import { StudentPrivateScripts } from './StudentPrivateScripts';
import { learningDownload, learningFailure, studentLearningApi, type LearningCourse, type LearningStudent, type StudentRequest } from './studentLearningApi';
import type { TeachingSubmission } from '../server/teachingTypes';
import './teaching.css';
import './student-learning.css';
import './student-desktop.css';
type Tab = 'inquiry' | 'assignment' | 'quiz' | 'game' | 'feedback';
type Grant = {
    slug: string;
    token: string;
    activityId: string;
    storyId?: string;
};
const tabs: {
    id: Tab;
    name: string;
    description: string;
    Icon: typeof BookOpen;
}[] = [{ id: 'inquiry', name: '对话学习', description: '带着问题，探索课程知识', Icon: MessageSquareText }, { id: 'game', name: '历史入局', description: '走进故事，用选择推动剧情', Icon: Gamepad2 }, { id: 'assignment', name: '上传作业', description: '提交文件、照片与学习成果', Icon: FileText }, { id: 'quiz', name: '考试测验', description: '完成老师发布的在线试题', Icon: ClipboardCheck }, { id: 'feedback', name: '提交与反馈', description: '回看提交，查看老师评语', Icon: Check }];
const keyOf = (c: LearningCourse) => `${c.membershipId}:${c.id}`;
export default function StudentLearningSpace() {
    const [student, setStudent] = useState<LearningStudent>(), [booting, setBooting] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [teacherName, setTeacherName] = useState('');
    const [phone, setPhone] = useState(''), [password, setPassword] = useState(''), [newPassword, setNewPassword] = useState(''), [confirmPassword, setConfirmPassword] = useState(''), [recoveryInput, setRecoveryInput] = useState(''), [recoveryCode, setRecoveryCode] = useState(''), [authMode, setAuthMode] = useState<'login' | 'recover' | 'change'>('login');
    const [courses, setCourses] = useState<LearningCourse[]>([]), [coursesLoading, setCoursesLoading] = useState(false), [selected, setSelected] = useState(''), [tab, setTab] = useState<Tab>('inquiry'), [scripts, setScripts] = useState(false), [grant, setGrant] = useState<Grant>(), [opening, setOpening] = useState(false), [feedback, setFeedback] = useState<TeachingSubmission[]>([]), [coursePicker, setCoursePicker] = useState(false), [refreshVersion, setRefreshVersion] = useState(0);
    const dirty = useRef(false), onDirty = useCallback((value: boolean) => { dirty.current = value; }, []), live = useRef(true), generation = useRef(0), studentRef = useRef(student), lock = useRef(false), heading = useRef<HTMLHeadingElement>(null);
    studentRef.current = student;
    const entryParams = new URLSearchParams(location.search), teacherSlug = entryParams.get('teacher'), entryCourse = entryParams.get('course'), entryActivity = entryParams.get('activity'), entryStory = entryParams.get('story'), entryUsed = useRef(false);
    const request = useCallback<StudentRequest>(async <T,>(path: string, options?: RequestInit) => {
        const v = generation.current;
        try {
            const r = await studentLearningApi<T>(path, options);
            if (!live.current || v !== generation.current)
                throw new Error('学习身份已切换，请重新打开');
            return r;
        }
        catch (e) {
            if (live.current && v === generation.current && (e as any).status === 401 && !['/login', '/password', '/recover'].includes(path)) {
                generation.current++;
                dirty.current = false;
                setGrant(undefined);
                setCourses([]);
                setStudent(undefined);
                setAuthMode('login');
                setError('登录已过期，请重新登录');
            }
            throw e;
        }
    }, []);
    useEffect(() => { const previous = document.title; document.title = 'ONE · 学习空间'; return () => { document.title = previous; }; }, []);
    useEffect(() => {
        live.current = true;
        void studentLearningApi<{
            student: LearningStudent;
        }>('/me').then(r => {
            if (live.current)
                setStudent(r.student);
        }).catch(() => { }).finally(() => {
            if (live.current)
                setBooting(false);
        });
        if (teacherSlug && /^[A-Za-z0-9_-]{20,100}$/.test(teacherSlug))
            void studentLearningApi<{
                teacherName: string;
            }>(`/portal/${teacherSlug}`).then(r => {
                if (live.current)
                    setTeacherName(r.teacherName);
            }).catch(() => { });
        return () => { live.current = false; generation.current++; };
    }, []);
    async function loadCourses() {
        setCoursesLoading(true);
        try {
            const r = await request<{
                courses: LearningCourse[];
            }>('/courses');
            setCourses(r.courses);
            const preferred = r.courses.find(c => c.id === entryCourse) ?? r.courses.find(c => c.teacherPortal === teacherSlug) ?? r.courses[0];
            setSelected(current => r.courses.some(c => keyOf(c) === current) ? current : preferred ? keyOf(preferred) : '');
            if (!selected && preferred) {
                const activity = preferred.activities.find(a => a.id === entryActivity);
                if (entryStory && preferred.stories.some(s => s.id === entryStory))
                    setTab('game');
                else if (activity && ['inquiry', 'assignment', 'quiz', 'game'].includes(activity.kind))
                    setTab(activity.kind as Tab);
            }
        }
        finally {
            setCoursesLoading(false);
        }
    }
    useEffect(() => {
        if (student && !student.mustChangePassword && !recoveryCode)
            void loadCourses().catch(e => setError(learningFailure(e)));
    }, [student?.id, student?.mustChangePassword, recoveryCode]);
    const course = courses.find(c => keyOf(c) === selected), activities = course?.activities.filter(a => a.kind === tab) ?? [], activityStamp = activities.map(a => a.id).join(':');
    async function enter(activityId: string, storyId?: string) {
        if (!course)
            return;
        setOpening(true);
        setError('');
        setGrant(undefined);
        const v = generation.current;
        try {
            const r = await request<Grant>('/access', { method: 'POST', body: JSON.stringify({ membershipId: course.membershipId, courseId: course.id, activityId, ...(storyId ? { storyId } : {}) }) });
            if (v === generation.current)
                setGrant(r);
        }
        catch (e) {
            setError(learningFailure(e));
        }
        finally {
            if (v === generation.current)
                setOpening(false);
        }
    }
    useEffect(() => {
        dirty.current = false;
        setGrant(undefined);
        setFeedback([]);
        setError('');
        if (!student || student.mustChangePassword || recoveryCode || scripts || authMode === 'change' || !course)
            return;
        if (tab === 'feedback') {
            setOpening(true);
            void request<{
                submissions: TeachingSubmission[];
            }>(`/submissions?courseId=${encodeURIComponent(course.id)}&membershipId=${encodeURIComponent(course.membershipId)}`).then(r => setFeedback(r.submissions)).catch(e => setError(learningFailure(e))).finally(() => setOpening(false));
        }
        else if (tab === 'game' && entryStory && !entryUsed.current) {
            entryUsed.current = true;
            const story = course.stories.find(s => s.id === entryStory);
            if (story)
                void enter(story.activityId, story.id);
        }
        else if (tab !== 'game' && activities[0])
            void enter(activities.find(a => !entryUsed.current && a.id === entryActivity)?.id ?? activities[0].id);
    }, [selected, tab, scripts, student?.id, student?.mustChangePassword, recoveryCode, activityStamp, refreshVersion, authMode]);
    function mayLeave() { return !dirty.current || window.confirm('有未完成或未保存的内容，仍要离开？'); }
    function navigate(fn: () => void) {
        if (busy || opening || !mayLeave())
            return;
        generation.current++;
        dirty.current = false;
        setGrant(undefined);
        setError('');
        setNotice('');
        fn();
        setRefreshVersion(v => v + 1);
        heading.current?.focus();
    }
    async function act(fn: () => Promise<void>) {
        if (lock.current)
            return;
        lock.current = true;
        setBusy(true);
        setError('');
        setNotice('');
        try {
            await fn();
        }
        catch (e) {
            setError(learningFailure(e));
        }
        finally {
            lock.current = false;
            setBusy(false);
        }
    }
    async function signIn() {
        await act(async () => {
            const r = await request<{
                student: LearningStudent;
            }>('/login', { method: 'POST', body: JSON.stringify({ phone, password }) });
            generation.current++;
            setStudent(r.student);
            setPassword('');
            setAuthMode('login');
            setScripts(false);
            setTab('inquiry');
        });
    }
    async function changePassword() {
        await act(async () => {
            if (newPassword !== confirmPassword)
                throw new Error('两次输入的新密码不一致');
            const recovering = authMode === 'recover';
            const r = await request<{
                student: LearningStudent;
                recoveryCode: string;
            }>(recovering ? '/recover' : '/password', { method: 'POST', body: JSON.stringify(recovering ? { phone, recoveryCode: recoveryInput, newPassword } : { currentPassword: password, newPassword }) });
            generation.current++;
            setStudent(r.student);
            setRecoveryCode(r.recoveryCode);
            setPassword('');
            setNewPassword('');
            setConfirmPassword('');
            setRecoveryInput('');
            setGrant(undefined);
            setScripts(false);
            setTab('inquiry');
            setAuthMode('login');
        });
    }
    async function logout() {
        if (!mayLeave())
            return;
        await act(async () => { await request('/logout', { method: 'POST', body: '{}' }); generation.current++; setStudent(undefined); setCourses([]); setGrant(undefined); setRecoveryCode(''); setPassword(''); setAuthMode('login'); dirty.current = false; });
    }
    const initial = student?.mustChangePassword, authPage = !student || initial || authMode === 'change' || !!recoveryCode;
    return <main className={`learning-space teaching-ui${authPage ? ' learning-auth-page' : ''} learning-module-${scripts ? 'scripts' : tab}`} ><header className="learning-topbar"><a className="learning-brand" href="/learn" onClick={e => {
            e.preventDefault();
            if (student && !initial && !recoveryCode)
                navigate(() => { setScripts(false); setTab('inquiry'); });
        }}><img className="learning-one-mark" src="/one-mark.svg" alt=""/><strong>ONE</strong><span>学习空间</span></a>{student ? <div className="learning-account"><span>{course?.studentName ?? student.phone}</span>{!initial && !recoveryCode && authMode !== 'change' ? <button type="button" disabled={busy || opening} onClick={() => navigate(() => { setAuthMode('change'); setPassword(''); })}><KeyRound size={15}/>修改密码</button> : null}<button type="button" disabled={busy || opening} onClick={() => void logout()}><LogOut size={15}/>退出</button></div> : null}</header>
 {booting ? <div className="learning-empty" role="status">正在打开学习空间…</div> : authPage ? <div className="learning-auth-layout"><section className="learning-welcome"><span className="learning-kicker">学习 · 探索 · 创作</span><h2>带着好奇而来，<br/>让知识成为你的故事。</h2><p>与课程助教对话，在历史情境中做出选择，<br/>记录学习成果，完成每一次挑战。</p><div className="learning-welcome-caption">杭州 · 西湖意境 <span>AI 教学想象插画</span></div></section><section className="learning-auth-card">
 {recoveryCode ? <><span className="learning-kicker">密码已更新</span><h1>收好你的恢复码</h1><p>忘记密码时，用手机号和恢复码找回。请保存到自己的安全位置。</p><code className="learning-recovery-code">{recoveryCode}</code><div className="learning-auth-actions"><button type="button" onClick={() => void navigator.clipboard.writeText(recoveryCode).then(() => setNotice('恢复码已复制')).catch(() => setError('复制失败，请手动保存'))}><Copy size={16}/>复制</button><button type="button" onClick={() => learningDownload('ONE-学生账号恢复码.txt', `登录账号：${student?.phone}\n恢复码：${recoveryCode}\n请妥善保管，不要交给他人。`)}>下载恢复码</button></div><button type="button" className="teaching-primary" onClick={() => { setRecoveryCode(''); setNotice(''); }}>已保存，进入学习空间</button></> : <><span className="learning-kicker">{teacherName ? `${teacherName}的学习空间` : 'ONE · 学生入口'}</span><h1>{initial ? '先设置自己的密码' : authMode === 'recover' ? '找回账号' : authMode === 'change' ? '修改密码' : '欢迎回来'}</h1>{!student && authMode === 'login' ? <p>使用老师发放的手机号账号和密码登录。</p> : null}<form onSubmit={e => { e.preventDefault(); void (!student && authMode === 'login' ? signIn() : changePassword()); }}>
 {!student ? <label>手机号<input type="tel" inputMode="tel" autoComplete="username" required value={phone} maxLength={30} onChange={e => setPhone(e.target.value)} placeholder="老师导入名单中的手机号"/></label> : null}
 {authMode !== 'recover' ? <label>{initial ? '初始密码' : authMode === 'change' ? '当前密码' : '密码'}<input type="password" autoComplete="current-password" required value={password} maxLength={128} onChange={e => setPassword(e.target.value)}/></label> : <label>恢复码<input autoComplete="off" required value={recoveryInput} maxLength={100} onChange={e => setRecoveryInput(e.target.value.trim())}/></label>}
 {student || authMode === 'recover' ? <><label>新密码<input type="password" autoComplete="new-password" minLength={10} maxLength={128} required value={newPassword} onChange={e => setNewPassword(e.target.value)} placeholder="至少 10 个字符"/></label><label>确认新密码<input type="password" autoComplete="new-password" minLength={10} maxLength={128} required value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)}/></label></> : null}
 {error ? <p role="alert" className="teaching-message teaching-error">{error}</p> : null}<button type="submit" disabled={busy} className="teaching-primary">{busy ? '正在处理…' : !student && authMode === 'login' ? '登录' : initial ? '设置密码并继续' : '保存新密码'}</button>
 </form>{!student ? <button type="button" className="learning-text-button" disabled={busy} onClick={() => { setAuthMode(authMode === 'recover' ? 'login' : 'recover'); setPassword(''); setError(''); }}>{authMode === 'recover' ? '返回登录' : '忘记密码，使用恢复码'}</button> : authMode === 'change' ? <button type="button" className="learning-text-button" disabled={busy} onClick={() => { setAuthMode('login'); setPassword(''); setNewPassword(''); setConfirmPassword(''); setError(''); }}>取消修改</button> : null}</>}{notice ? <p role="status">{notice}</p> : null}{recoveryCode && error ? <p className="teaching-error" role="alert">{error}</p> : null}
 </section></div> : <div className="learning-layout"><aside className={`learning-sidebar${coursePicker ? ' is-open' : ''}`}><div className="learning-course-label"><h2>我的课程</h2><button type="button" disabled={busy || opening || coursesLoading} aria-label="刷新课程" onClick={() => {
                if (!mayLeave())
                    return;
                generation.current++;
                dirty.current = false;
                setGrant(undefined);
                void act(async () => { await loadCourses(); setRefreshVersion(v => v + 1); });
            }}><RefreshCw size={15}/></button></div>{coursesLoading && !courses.length ? <p role="status">正在读取课程…</p> : courses.map(c => <button className="learning-course-card" type="button" key={keyOf(c)} aria-pressed={!scripts && selected === keyOf(c)} disabled={busy || opening} onClick={() => navigate(() => { setSelected(keyOf(c)); setScripts(false); setTab('inquiry'); setCoursePicker(false); })}><BookOpen size={18}/><span><strong>{c.title}</strong><small>{c.teacherName} · {c.className}</small></span></button>)}{!coursesLoading && !courses.length ? <p className="learning-empty-small">暂无课程，请联系老师分配班级和课程。</p> : null}<button type="button" className="learning-my-scripts" aria-pressed={scripts} disabled={busy || opening} onClick={() => { if (!scripts)
            navigate(() => { setScripts(true); setCoursePicker(false); }); }}><FileText size={18}/>我的剧本</button></aside><section className="learning-content"><button className="learning-mobile-courses" type="button" aria-expanded={coursePicker} onClick={() => setCoursePicker(!coursePicker)}>{scripts ? '我的剧本' : course?.title ?? '选择课程'}<ChevronDown size={16}/></button>
 {scripts ? <StudentPrivateScripts key={student.id} studentId={student.id} courses={courses} request={request} onDirty={onDirty}/> : <><header className="learning-course-heading"><div><span className="learning-kicker">{course ? `${course.teacherName} · ${course.className}` : '我的学习'}</span><h1 ref={heading} tabIndex={-1}>{course?.title ?? '课程还在准备中'}</h1><p className="learning-course-subtitle">{tabs.find(item => item.id === tab)?.description} · 按老师的课程安排，开启今天的学习。</p></div>{course ? <span className="learning-roster-name">{course.studentName}{course.studentNumber ? ` · ${course.studentNumber}` : ''}</span> : null}</header>{course ? <><nav className="learning-tools" aria-label="课程工具">{tabs.map(({ id, name, description, Icon }) => <button type="button" key={id} aria-pressed={tab === id} disabled={busy || opening} onClick={() => { if (id !== tab)
                    navigate(() => setTab(id)); }}><Icon size={20}/><span><strong>{name}</strong><small>{description}</small></span>{id !== 'feedback' && course.activities.filter(a => a.kind === id).length > 1 ? <small>{course.activities.filter(a => a.kind === id).length}</small> : null}</button>)}</nav>
 {error ? <p className="teaching-message teaching-error" role="alert">{error}</p> : null}{opening ? <div className="learning-empty" role="status">正在打开学习内容…</div> : tab === 'feedback' ? <section className="learning-feedback"><header className="learning-section-heading"><h2>我的提交与反馈</h2><button type="button" onClick={() => void act(async () => {
                            const r = await request<{
                                submissions: TeachingSubmission[];
                            }>(`/submissions?courseId=${encodeURIComponent(course.id)}&membershipId=${encodeURIComponent(course.membershipId)}`);
                            setFeedback(r.submissions);
                        })}><RefreshCw size={16}/>刷新</button></header>{feedback.length ? feedback.slice().reverse().map(s => <article className="learning-feedback-card" key={s.id}><header><h3>{course.activities.find(a => a.id === s.activityId)?.title ?? '已提交的活动'}</h3><span>{s.grade?.status === 'published' ? '反馈已发布' : '等待老师反馈'}</span></header><small>{new Date(s.createdAt).toLocaleString('zh-CN')}</small>{s.text ? <p>{s.text}</p> : null}<p>{s.attachmentIds.length ? `${s.attachmentIds.length} 个附件` : '在线作答'} · 提交已保存</p>{s.grade?.status === 'published' ? <section><strong>{s.grade.total} 分</strong><p>{s.grade.feedback}</p>{s.grade.criteria.map((c, i) => <p key={c.criterionId}>评分项 {i + 1} · {c.score} 分 · {c.comment}</p>)}</section> : null}</article>) : <div className="learning-empty"><ClipboardCheck size={28}/><h3>还没有提交</h3><p>完成作业或测验后，可在这里查看老师发布的反馈。</p></div>}</section> : <>
 {tab === 'game' ? <section className="learning-game-list">{course.stories.length ? course.stories.map(s => <button type="button" key={s.id} aria-pressed={grant?.storyId === s.id} disabled={busy} onClick={() => {
                                    if (mayLeave()) {
                                        generation.current++;
                                        dirty.current = false;
                                        void enter(s.activityId, s.id);
                                    }
                                }}><Gamepad2 size={22}/><span><strong>{s.title}</strong><small>老师布置的课堂游戏</small></span></button>) : <div className="learning-empty"><Gamepad2 size={28}/><h3>老师还没有布置课堂游戏</h3><p>自己的剧本可以先保存在“我的剧本”。</p></div>}</section> : activities.length > 1 ? <nav className="learning-activity-list" aria-label="选择学习内容">{activities.map(a => <button type="button" key={a.id} aria-pressed={grant?.activityId === a.id} disabled={busy} onClick={() => {
                                    if (mayLeave()) {
                                        generation.current++;
                                        dirty.current = false;
                                        void enter(a.id);
                                    }
                                }}>{a.title}</button>)}</nav> : null}
 {grant ? <TeachingPublicPage key={`${selected}:${grant.slug}:${grant.activityId}:${grant.storyId ?? ''}:${grant.token}`} slug={grant.slug} initialToken={grant.token} initialActivityId={grant.activityId} initialStoryId={grant.storyId} embedded onDirty={onDirty}/> : tab !== 'game' ? <div className="learning-empty"><BookOpen size={28}/><h3>{tab === 'inquiry' ? '老师还未开放课程辅导' : tab === 'assignment' ? '暂时没有要交的作业' : '暂时没有开放的测验'}</h3></div> : null}</>}
 </> : <div className="learning-empty"><BookOpen size={30}/><p>老师分配课程后会显示在这里。</p></div>}</>}{scripts && error ? <p role="alert" className="teaching-message teaching-error">{error}</p> : null}</section></div>}
 </main>;
}
