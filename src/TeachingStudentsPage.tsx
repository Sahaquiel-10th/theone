import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Copy, Download, FileText, Plus, RefreshCw, Upload, Users, X } from 'lucide-react';
import { currentApiIdentity, type api as Api } from './oneApi';
import type { TeachingCourse } from '../server/teachingTypes';
import type { StudentClass, StudentMembership, StudentScriptSubmission } from '../server/studentLearningTypes';
import { parseStudentRoster, type StudentRosterRow } from './studentRosterImport';
import { teachingDownload } from './teachingDownload';
import './student-learning.css';
type Membership = StudentMembership & {
    canReissue?: boolean;
};
type Provision = {
    id: string;
    classId: string;
    requestId: string;
    newAccounts: number;
    linkedAccounts: number;
    expiresAt: string;
    createdAt: string;
};
type Story = {
    id: string;
    title: string;
    courseId: string;
    activityId: string;
};
type Data = {
    classes: StudentClass[];
    memberships: Membership[];
    portalPath: string;
    provisions: Provision[];
    stories: Story[];
};
type Pending = {
    classId: string;
    requestId: string;
    classRevision: number;
    rows: StudentRosterRow[];
};
const message = (e: unknown) => e instanceof Error ? e.message : '操作未完成，请重试。';
function localDownload(name: string, content: string) { const u = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' })); const a = document.createElement('a'); a.href = u; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(u), 1000); }
export function TeachingStudentsPage({ api, onBack }: {
    api: typeof Api;
    onBack: () => void;
}) {
    const owner = useRef(currentApiIdentity()).current, live = useRef(true), lock = useRef(false), dialog = useRef<HTMLDialogElement>(null), heading = useRef<HTMLHeadingElement>(null);
    const request = useCallback(async <T,>(path: string, options?: RequestInit) => {
        const current = currentApiIdentity();
        if (current.userId !== owner.userId || current.workspaceId !== owner.workspaceId || current.revision !== owner.revision)
            throw new Error('账号已切换，请重新打开班级管理');
        const result = await api<T>(path, options);
        const after = currentApiIdentity();
        if (!live.current || after.userId !== owner.userId || after.workspaceId !== owner.workspaceId || after.revision !== owner.revision)
            throw new Error('账号或页面已切换，原操作结果请重新核对');
        return result;
    }, [api, owner]);
    const storageKey = `one-student-provision:${owner.workspaceId}:${owner.userId}`;
    const [pending, setPending] = useState<Pending | undefined>(() => {
        try {
            const x = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
            if (x && typeof x.classId === 'string' && typeof x.requestId === 'string' && Number.isSafeInteger(x.classRevision) && Array.isArray(x.rows) && x.rows.length <= 200)
                return x;
        }
        catch { }
        return undefined;
    });
    const [data, setData] = useState<Data>({ classes: [], memberships: [], portalPath: '/learn', provisions: [], stories: [] }), [courses, setCourses] = useState<TeachingCourse[]>([]), [selected, setSelected] = useState(''), [archived, setArchived] = useState(false), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState(''), [notice, setNotice] = useState('');
    const createKey = useRef(crypto.randomUUID()), reissueKeys = useRef(new Map<string, string>());
    const [editing, setEditing] = useState<StudentClass | 'new'>(), [className, setClassName] = useState(''), [courseIds, setCourseIds] = useState<string[]>([]), [storyIds, setStoryIds] = useState<string[]>([]), [classActive, setClassActive] = useState(true);
    const [rows, setRows] = useState<(StudentRosterRow & {
        existingAccount: boolean;
    })[]>([]), [fileName, setFileName] = useState(''), [view, setView] = useState<'roster' | 'scripts'>('roster'), [scripts, setScripts] = useState<(StudentScriptSubmission & {
        studentName: string;
        className: string;
    })[]>([]), [script, setScript] = useState<StudentScriptSubmission>(), [initialPassword, setInitialPassword] = useState<{
        name: string;
        password: string;
    }>();
    const visibleClasses = data.classes.filter(c => Boolean(c.deletedAt) === archived);
    const classroom = visibleClasses.find(c => c.id === selected) ?? visibleClasses[0], members = data.memberships.filter(m => m.classId === classroom?.id), provisions = data.provisions.filter(p => p.classId === classroom?.id);
    async function load() {
        const [d, c] = await Promise.all([request<Data>('/api/teaching/student-classes'), request<{
                courses: TeachingCourse[];
            }>('/api/teaching/courses')]);
        setData(d);
        setCourses(c.courses);
        setSelected(s => d.classes.some(c => c.id === s) ? s : d.classes[0]?.id ?? '');
    }
    useEffect(() => { live.current = true; void load().catch(e => setError(message(e))).finally(() => setLoading(false)); heading.current?.focus(); return () => { live.current = false; }; }, [request]);
    useEffect(() => {
        if (editing) {
            dialog.current?.showModal();
            dialog.current?.querySelector('input')?.focus();
        }
        else {
            dialog.current?.close();
            heading.current?.focus();
        }
    }, [editing]);
    async function act(run: () => Promise<void>) {
        if (lock.current)
            return;
        lock.current = true;
        setBusy(true);
        setError('');
        try {
            await run();
        }
        catch (e) {
            if (live.current)
                setError(message(e));
        }
        finally {
            lock.current = false;
            if (live.current)
                setBusy(false);
        }
    }
    function edit(c: StudentClass | 'new') {
        setError('');
        if (c === 'new')
            createKey.current = crypto.randomUUID();
        setClassName(c === 'new' ? '' : c.name);
        setCourseIds(c === 'new' ? (courses.length === 1 ? [courses[0].id] : []) : c.courseIds);
        setStoryIds(c === 'new' ? [] : c.storyIds ?? []);
        setClassActive(c === 'new' || c.active !== false);
        setEditing(c);
    }
    async function saveClass() {
        if (!editing)
            return;
        await act(async () => {
            const body = { name: className, courseIds, storyIds, active: classActive, ...(editing === 'new' ? { createKey: createKey.current } : { revision: editing.revision }) };
            const r = await request<{
                classroom: StudentClass;
            }>(`/api/teaching/student-classes${editing === 'new' ? '' : '/' + editing.id}`, { method: editing === 'new' ? 'POST' : 'PATCH', body: JSON.stringify(body) });
            setEditing(undefined);
            setArchived(false);
            await load();
            setSelected(r.classroom.id);
            setNotice('班级已保存');
        });
    }
    async function importFile(file?: File) {
        if (!file || !classroom)
            return;
        await act(async () => {
            const parsed = await parseStudentRoster(file);
            const r = await request<{
                rows: (StudentRosterRow & {
                    existingAccount: boolean;
                })[];
            }>(`/api/teaching/student-classes/${classroom.id}/preview`, { method: 'POST', body: JSON.stringify({ rows: parsed }) });
            setRows(r.rows);
            setFileName(file.name);
        });
    }
    async function provision(attempt?: Pending) {
        if (!classroom && !attempt)
            return;
        await act(async () => {
            let p = attempt;
            if (!p) {
                p = { classId: classroom!.id, classRevision: classroom!.revision, rows: rows.map(({ name, phone, studentNumber }) => ({ name, phone, studentNumber })), requestId: crypto.randomUUID() };
                localStorage.setItem(storageKey, JSON.stringify(p));
                setPending(p);
            }
            const r = await request<{
                provision: Provision;
            }>(`/api/teaching/student-classes/${p.classId}/import`, { method: 'POST', body: JSON.stringify(p) }).catch(e => { if ([400, 404, 409, 422].includes(Number(e?.status))) {
                localStorage.removeItem(storageKey);
                setPending(undefined);
                setRows([]);
            } throw e; });
            localStorage.removeItem(storageKey);
            setPending(undefined);
            setRows([]);
            await load();
            setSelected(p.classId);
            setNotice(`已生成 ${r.provision.newAccounts} 个新账号，关联 ${r.provision.linkedAccounts} 个已有账号，可以下载发放表。`);
        });
    }
    async function toggle(m: Membership) { await act(async () => { await request(`/api/teaching/student-classes/${m.classId}/members/${m.id}`, { method: 'PATCH', body: JSON.stringify({ active: !m.active }) }); await load(); }); }
    async function showScripts() {
        setView('scripts');
        await act(async () => {
            const r = await request<{
                submissions: typeof scripts;
            }>('/api/teaching/student-script-submissions');
            setScripts(r.submissions);
        });
    }
    return <section className="teaching-ui teacher-students"><header className="teacher-students-heading"><div><button className="learning-text-button" type="button" onClick={onBack}><ArrowLeft size={16}/>课程工作台</button><h1 ref={heading} tabIndex={-1}>班级与学生</h1></div><div><button type="button" onClick={() => void navigator.clipboard.writeText(new URL(data.portalPath, location.origin).href).then(() => setNotice('学生登录链接已复制')).catch(() => setError('未能复制，请手动复制：' + new URL(data.portalPath, location.origin).href))}><Copy size={16}/>复制学生登录链接</button><button type="button" disabled={busy} aria-pressed={archived} onClick={() => { setArchived(!archived); setSelected(''); setRows([]); setScript(undefined); }}>{archived ? '返回班级' : '班级回收站'}</button><button type="button" className="teaching-primary" disabled={loading || busy || !courses.length} onClick={() => edit('new')}><Plus size={16}/>创建班级</button></div></header>
 {error ? <p role="alert" className="teaching-message teaching-error">{error}</p> : null}{notice ? <p role="status" className="teaching-message">{notice}</p> : null}{pending ? <div className="teaching-message"><span>有一批账号发放结果待核对。</span><button type="button" disabled={busy} onClick={() => void provision(pending)}>核对原导入结果</button></div> : null}
 {loading ? <p role="status">正在读取班级…</p> : !visibleClasses.length ? <section className="learning-empty"><Users size={32}/><h2>{archived ? '班级回收站为空' : courses.length ? '先建一个班级，再导入学生名单' : '先在课程工作台添加课程'}</h2>{courses.length ? <button type="button" className="teaching-primary" onClick={() => edit('new')}>创建第一个班级</button> : <button type="button" onClick={onBack}>返回课程工作台</button>}</section> : <div className="teacher-students-layout"><aside aria-label="班级列表">{visibleClasses.map(c => <button type="button" key={c.id} aria-pressed={c.id === classroom?.id} disabled={busy} onClick={() => { setSelected(c.id); setRows([]); setScript(undefined); setInitialPassword(undefined); }}><strong>{c.name}</strong><small>{data.memberships.filter(m => m.classId === c.id && m.active).length} 名学生{c.active === false ? ' · 已停用' : ''}</small></button>)}</aside><div className="teacher-students-detail"><header><div><h2>{classroom?.name}</h2><p>{classroom?.courseIds.map(id => courses.find(c => c.id === id)?.title ?? '已删除课程').join(' · ')}</p></div><div className="teacher-class-actions">{classroom?.deletedAt ? <button type="button" disabled={busy} onClick={() => void act(async () => { await request(`/api/teaching/student-classes/${classroom.id}/trash`, { method: 'PATCH', body: JSON.stringify({ revision: classroom.revision, restore: true }) }); await load(); setArchived(false); setSelected(classroom.id); setNotice('班级已恢复，学生入口保持停用。请在班级设置中启用。'); })}>恢复班级</button> : <><button type="button" disabled={busy} onClick={() => classroom && edit(classroom)}>班级设置</button><button type="button" disabled={busy} onClick={() => { if (!classroom || !window.confirm('将这个班级移入回收站？学生入口会关闭，名单和提交保留。'))
            return; void act(async () => { await request(`/api/teaching/student-classes/${classroom.id}/trash`, { method: 'PATCH', body: JSON.stringify({ revision: classroom.revision, restore: false }) }); setRows([]); setScript(undefined); await load(); setNotice('班级已移入回收站'); }); }}>删除班级</button></>}</div></header><nav className="learning-tabs" aria-label="班级内容"><button type="button" aria-pressed={view === 'roster'} onClick={() => setView('roster')}>学生名单</button><button type="button" aria-pressed={view === 'scripts'} onClick={() => void showScripts()}>剧本提交</button></nav>
 {view === 'roster' ? <><div className="teacher-roster-actions"><label className="learning-upload"><Upload size={16}/>导入名单<input type="file" accept=".xlsx,.xls,.csv" disabled={busy || !!pending || !!classroom?.deletedAt} onChange={e => { void importFile(e.target.files?.[0]); e.target.value = ''; }}/></label><button type="button" onClick={() => localDownload('学生名单模板.csv', '\uFEFF姓名,手机号,学号\r\n测试学生,13800000001,20260001\r\n')}><Download size={16}/>下载名单模板</button><button type="button" disabled={busy} aria-label="刷新名单" onClick={() => void act(load)}><RefreshCw size={16}/></button></div>
 {rows.length ? <section className="teacher-roster-preview"><h3>核对名单 · {fileName}</h3><div className="learning-table-scroll"><table><thead><tr><th>姓名</th><th>手机号</th><th>学号</th><th>账号</th></tr></thead><tbody>{rows.map(r => <tr key={r.phone}><td>{r.name}</td><td>{r.phone}</td><td>{r.studentNumber || '—'}</td><td>{r.existingAccount ? '使用原账号' : '新建账号'}</td></tr>)}</tbody></table></div><footer><span>{rows.length} 名学生 · {classroom?.name}</span><button type="button" disabled={busy || !!pending || !!classroom?.deletedAt} className="teaching-primary" onClick={() => void provision()}>确认导入并生成账号</button><button type="button" disabled={busy} onClick={() => setRows([])}>取消</button></footer></section> : null}
 {provisions.length ? <div className="teacher-provision-list">{provisions.slice().reverse().slice(0, 5).map(p => <button type="button" key={p.id} disabled={busy || p.expiresAt < new Date().toISOString()} onClick={() => void teachingDownload(`/api/teaching/student-classes/${classroom?.id}/provisions/${p.id}/export`, '学生账号发放表.csv').catch(e => setError(message(e)))}><Download size={16}/>下载账号发放表 <small>{new Date(p.createdAt).toLocaleString('zh-CN')}</small></button>)}</div> : null}
 {initialPassword ? <div className="teaching-message"><span>{initialPassword.name}的新初始密码：<code>{initialPassword.password}</code></span><button type="button" onClick={() => setInitialPassword(undefined)}>收起</button></div> : null}
 <div className="learning-table-scroll"><table><thead><tr><th>姓名</th><th>手机号</th><th>学号</th><th>状态</th><th>操作</th></tr></thead><tbody>{members.map(m => <tr key={m.id}><td>{m.name}</td><td>{m.phone}</td><td>{m.studentNumber || '—'}</td><td>{m.active ? '在班' : '已移出'}</td><td><button type="button" disabled={busy || !!classroom?.deletedAt} onClick={() => void toggle(m)}>{m.active ? '移出本班' : '恢复入班'}</button>{m.canReissue ? <button type="button" disabled={busy || !!classroom?.deletedAt} onClick={() => void act(async () => { const requestId = reissueKeys.current.get(m.id) ?? crypto.randomUUID(); reissueKeys.current.set(m.id, requestId); await request(`/api/teaching/student-classes/${m.classId}/members/${m.id}/reissue`, { method: 'POST', body: JSON.stringify({ requestId }) }); reissueKeys.current.delete(m.id); await load(); setNotice('已生成新的账号发放表，请下载后交给学生。原初始密码已失效。'); })}>重发初始密码</button> : null}</td></tr>)}</tbody></table>{!members.length ? <p className="learning-empty-small">导入名单后，学生会出现在这里。</p> : null}</div></> : <div className="teacher-script-submissions">{scripts.filter(s => data.memberships.some(m => m.id === s.membershipId && m.classId === classroom?.id)).map(s => <article key={s.id}><div><h3>{s.title}</h3><p>{s.studentName} · {s.className} · {new Date(s.createdAt).toLocaleString('zh-CN')}</p></div><button type="button" onClick={() => setScript(s)}><FileText size={16}/>查看提交</button></article>)}{!scripts.some(s => data.memberships.some(m => m.id === s.membershipId && m.classId === classroom?.id)) ? <p className="learning-empty-small">学生提交剧本后可在这里查看。</p> : null}{script ? <section className="teacher-script-text"><header><h3>{script.title}</h3><button type="button" onClick={() => setScript(undefined)}>收起</button></header><p>{script.text}</p><button type="button" onClick={() => localDownload(script.title + '.txt', script.text)}>下载剧本</button></section> : null}</div>}
 </div></div>}
 {editing ? <dialog ref={dialog} className="learning-dialog" aria-labelledby="class-edit-title" onCancel={e => {
                e.preventDefault();
                if (!busy)
                    setEditing(undefined);
            }}><header><h2 id="class-edit-title">{editing === 'new' ? '创建班级' : '班级设置'}</h2><button type="button" disabled={busy} aria-label="关闭班级设置" onClick={() => setEditing(undefined)}><X size={20}/></button></header>{error ? <p role="alert" className="teaching-message teaching-error">{error}</p> : null}<label>班级名称<input autoFocus value={className} maxLength={80} onChange={e => setClassName(e.target.value)} placeholder="例如：人文通识一班"/></label><fieldset><legend>分配课程</legend><p>选中的课程使用学生账号登录。</p>{courses.map(c => <label key={c.id} className="teaching-check"><input type="checkbox" checked={courseIds.includes(c.id)} onChange={e => { const next = e.target.checked ? [...courseIds, c.id] : courseIds.filter(id => id !== c.id); setCourseIds(next); setStoryIds(storyIds.filter(id => data.stories.some(s => s.id === id && next.includes(s.courseId)))); }}/>{c.title}</label>)}</fieldset>{data.stories.some(s => courseIds.includes(s.courseId)) ? <fieldset><legend>布置课堂游戏</legend>{data.stories.filter(s => courseIds.includes(s.courseId)).map(s => <label key={s.id} className="teaching-check"><input type="checkbox" checked={storyIds.includes(s.id)} onChange={e => setStoryIds(e.target.checked ? [...storyIds, s.id] : storyIds.filter(id => id !== s.id))}/>{s.title}</label>)}</fieldset> : null}{editing !== 'new' ? <label className="teaching-check"><input type="checkbox" checked={classActive} onChange={e => setClassActive(e.target.checked)}/>启用本班学习入口</label> : null}<footer><button type="button" disabled={busy} onClick={() => setEditing(undefined)}>取消</button><button type="button" className="teaching-primary" disabled={busy || !className.trim() || !courseIds.length} onClick={() => void saveClass()}>保存班级</button></footer></dialog> : null}
 </section>;
}
