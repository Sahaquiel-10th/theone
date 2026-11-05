import { useEffect, useRef, useState } from 'react';
import { Download, FileText, Plus, Save, Send, Trash2, Upload, Undo2 } from 'lucide-react';
import { learningDownload, learningFailure, type LearningCourse, type StudentRequest } from './studentLearningApi';
type Draft = {
    id: string;
    title: string;
    text: string;
    revision: number;
    updatedAt: string;
    deletedAt?: string;
};
type Submission = {
    id: string;
    title: string;
    courseId: string;
    draftId: string;
    draftRevision: number;
    createdAt: string;
};
type Pending = {
    requestId: string;
    membershipId: string;
    courseId: string;
    draftId: string;
    draftRevision: number;
};
export function StudentPrivateScripts({ studentId, courses, request, onDirty }: {
    studentId: string;
    courses: LearningCourse[];
    request: StudentRequest;
    onDirty: (dirty: boolean) => void;
}) {
    const [drafts, setDrafts] = useState<Draft[]>([]), [submissions, setSubmissions] = useState<Submission[]>([]), [editing, setEditing] = useState<Draft>(), [trash, setTrash] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [target, setTarget] = useState(''), [confirm, setConfirm] = useState(false), [loading, setLoading] = useState(true);
    const pendingKey = `one-student-script-submit:${studentId}`;
    const [pending, setPending] = useState<Pending | undefined>(() => {
        try {
            const p = JSON.parse(localStorage.getItem(pendingKey) ?? 'null');
            if (p && typeof p.requestId === 'string' && typeof p.membershipId === 'string' && typeof p.courseId === 'string' && typeof p.draftId === 'string' && Number.isSafeInteger(p.draftRevision))
                return p;
        }
        catch { }
        return undefined;
    });
    const dialog = useRef<HTMLDialogElement>(null), lock = useRef(false), live = useRef(true), heading = useRef<HTMLHeadingElement>(null), saveAttempt = useRef<Draft | undefined>(undefined);
    const source = drafts.find(d => d.id === editing?.id), dirty = Boolean(editing && (editing.title !== source?.title || editing.text !== source?.text));
    useEffect(() => { onDirty(dirty || busy || !!pending); }, [dirty, busy, pending, onDirty]);
    useEffect(() => { live.current = true; void load().catch(e => setError(learningFailure(e))).finally(() => setLoading(false)); return () => { live.current = false; }; }, [request]);
    useEffect(() => {
        if (confirm)
            dialog.current?.showModal();
        else {
            dialog.current?.close();
        }
    }, [confirm]);
    useEffect(() => {
        if (!dirty)
            return;
        const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
        window.addEventListener('beforeunload', warn);
        return () => window.removeEventListener('beforeunload', warn);
    }, [dirty]);
    async function load() {
        const r = await request<{
            drafts: Draft[];
            submissions: Submission[];
        }>('/scripts');
        if (live.current) {
            setDrafts(r.drafts);
            setSubmissions(r.submissions);
        }
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
            if (live.current)
                setError(learningFailure(e));
        }
        finally {
            lock.current = false;
            if (live.current)
                setBusy(false);
        }
    }
    function choose(d?: Draft) {
        if (dirty && !window.confirm('当前修改尚未保存，放弃修改并切换？'))
            return false;
        saveAttempt.current = undefined;
        setEditing(d);
        setConfirm(false);
        setNotice('');
        return true;
    }
    async function save() {
        if (!editing)
            return;
        await act(async () => {
            const attempt = saveAttempt.current ?? { ...editing };
            saveAttempt.current = attempt;
            const r = await request<{
                draft: Draft;
            }>('/scripts', { method: 'POST', body: JSON.stringify(attempt) });
            saveAttempt.current = undefined;
            await load();
            setEditing(r.draft);
            setNotice('已保存到我的剧本');
        });
    }
    async function upload(file?: File) {
        if (!file)
            return;
        await act(async () => {
            if (file.size > 240000)
                throw new Error('剧本文件请控制在 240 KB 以内');
            if (!/\.(txt|md|json)$/i.test(file.name))
                throw new Error('请选择 TXT、Markdown 或 JSON 剧本');
            const text = await file.text();
            if (!text.trim() || text.length > 60000 || text.includes('\0'))
                throw new Error('剧本须为文字，最多 60,000 字');
            if (dirty && !window.confirm('用上传的文件替换当前未保存内容？'))
                return;
            saveAttempt.current = undefined;
            setEditing({ id: crypto.randomUUID(), title: file.name.replace(/\.[^.]+$/, '').slice(0, 160), text, revision: 0, updatedAt: '' });
            setTrash(false);
        });
    }
    async function submit(attempt?: Pending) {
        const course = courses.find(c => c.membershipId + ':' + c.id === target);
        if (!attempt && (!editing || !course))
            return;
        await act(async () => {
            const p = attempt ?? { requestId: crypto.randomUUID(), membershipId: course!.membershipId, courseId: course!.id, draftId: editing!.id, draftRevision: editing!.revision };
            if (!attempt) {
                localStorage.setItem(pendingKey, JSON.stringify(p));
                setPending(p);
            }
            const r = await request<{
                submission: {
                    id: string;
                    draftId: string;
                    draftRevision: number;
                };
            }>('/scripts/submit', { method: 'POST', body: JSON.stringify(p) }).catch(e => { if ([400, 404, 409, 422].includes(Number(e?.status))) {
                localStorage.removeItem(pendingKey);
                setPending(undefined);
            } throw e; });
            if (r.submission.draftId !== p.draftId || r.submission.draftRevision !== p.draftRevision)
                throw new Error('提交回执不一致，请保留原请求并核对');
            localStorage.removeItem(pendingKey);
            setPending(undefined);
            setConfirm(false);
            await load();
            setNotice('已交给老师。继续修改个人剧本不会改动这次提交。');
        });
    }
    async function move(d: Draft, restore = false) {
        await act(async () => {
            await request(`/scripts/${d.id}/trash`, { method: 'PATCH', body: JSON.stringify({ revision: d.revision, restore }) });
            if (editing?.id === d.id)
                setEditing(undefined);
            await load();
        });
    }
    return <section className="learning-scripts"><header className="learning-section-heading"><div><h2 ref={heading} tabIndex={-1}>我的剧本</h2><p>保存的内容仅自己可见，点击“交给老师”后才会提交。</p></div><div><label className="learning-upload"><Upload size={16}/>上传剧本<input type="file" accept=".txt,.md,.json" disabled={busy || !!pending} onChange={e => { void upload(e.target.files?.[0]); e.target.value = ''; }}/></label><button type="button" disabled={busy || !!pending} onClick={() => {
            if (choose({ id: crypto.randomUUID(), title: '', text: '', revision: 0, updatedAt: '' }))
                setTrash(false);
        }}><Plus size={16}/>新建剧本</button></div></header>
 {error ? <p className="teaching-message teaching-error" role="alert">{error}</p> : null}{notice ? <p className="teaching-message" role="status">{notice}</p> : null}{pending ? <div className="teaching-message"><span>上次提交回执待核对。</span><button type="button" disabled={busy} onClick={() => void submit(pending)}>核对原提交</button></div> : null}
 <nav className="learning-tabs" aria-label="剧本位置"><button type="button" aria-pressed={!trash} disabled={busy} onClick={() => {
            if (choose(undefined))
                setTrash(false);
        }}>剧本</button><button type="button" aria-pressed={trash} disabled={busy} onClick={() => {
            if (choose(undefined))
                setTrash(true);
        }}>回收站</button></nav>
 <div className="learning-script-layout"><aside aria-label="我的剧本列表">{loading ? <p role="status">正在读取剧本…</p> : drafts.filter(d => Boolean(d.deletedAt) === trash).map(d => <article key={d.id}><button type="button" disabled={busy} aria-pressed={editing?.id === d.id} onClick={() => choose(d)}><FileText size={18}/><span><strong>{d.title}</strong><small>{new Date(d.updatedAt).toLocaleDateString('zh-CN')}{submissions.some(s => s.draftId === d.id) ? ' · 已有提交' : ''}</small></span></button><button type="button" disabled={busy} aria-label={trash ? `恢复 ${d.title}` : `移到回收站 ${d.title}`} onClick={() => {
                if (dirty && editing?.id === d.id && !window.confirm('当前修改尚未保存，仍要移入回收站？'))
                    return;
                void move(d, trash);
            }}>{trash ? <Undo2 size={16}/> : <Trash2 size={16}/>}</button></article>)}{!loading && !drafts.some(d => Boolean(d.deletedAt) === trash) ? <p className="learning-empty-small">{trash ? '回收站为空' : '还没有剧本，可以上传或新建。'}</p> : null}</aside>
 {editing ? <section className="learning-script-editor"><label>剧本名称<input value={editing.title} maxLength={160} disabled={busy || !!pending || !!editing.deletedAt || !!saveAttempt.current} onChange={e => setEditing({ ...editing, title: e.target.value })}/></label><label>剧本正文<textarea rows={18} value={editing.text} maxLength={60000} disabled={busy || !!pending || !!editing.deletedAt || !!saveAttempt.current} onChange={e => setEditing({ ...editing, text: e.target.value })} placeholder="粘贴或上传自己的游戏剧本"/></label><footer><span>{editing.text.length.toLocaleString()} / 60,000 字</span><div><button type="button" disabled={!editing.text} onClick={() => learningDownload((editing.title || '我的剧本') + '.txt', editing.text)}><Download size={16}/>下载</button>{!editing.deletedAt ? <><button type="button" disabled={busy || !!pending || !editing.title.trim() || !editing.text.trim() || !dirty} className="teaching-primary" onClick={() => void save()}><Save size={16}/>{saveAttempt.current ? '核对原保存' : '保存'}</button><button type="button" disabled={busy || !!pending || dirty || !editing.revision || !courses.length} onClick={() => { setTarget(courses[0].membershipId + ':' + courses[0].id); setConfirm(true); }}><Send size={16}/>交给老师</button></> : null}</div></footer>{submissions.filter(s => s.draftId === editing.id).map(s => <p key={s.id} className="learning-script-receipt">已提交 · {courses.find(c => c.id === s.courseId)?.title ?? '原课程'} · 第 {s.draftRevision} 版 · {new Date(s.createdAt).toLocaleString('zh-CN')}</p>)}</section> : <section className="learning-empty"><FileText size={30}/><h3>{trash ? '选一个剧本查看或恢复' : '从左侧打开剧本，或上传自己的文件'}</h3><p>支持 TXT、Markdown 和 JSON 文字文件。</p></section>}
 </div>{confirm && editing ? <dialog ref={dialog} className="learning-dialog" aria-labelledby="script-submit-title" onCancel={e => {
                e.preventDefault();
                if (!busy)
                    setConfirm(false);
            }}><header><h2 id="script-submit-title">交给哪门课的老师？</h2></header>{error ? <p role="alert" className="teaching-message teaching-error">{error}</p> : null}<label>选择课程<select autoFocus value={target} disabled={busy || !!pending} onChange={e => setTarget(e.target.value)}>{courses.map(c => <option key={c.membershipId + ':' + c.id} value={c.membershipId + ':' + c.id}>{c.title} · {c.teacherName} · {c.className}</option>)}</select></label><p>提交《{editing.title}》的第 {editing.revision} 版，老师会收到这一版的副本。</p><footer><button type="button" disabled={busy} onClick={() => setConfirm(false)}>取消</button><button type="button" className="teaching-primary" disabled={busy || !target} onClick={() => void submit(pending)}>确认提交</button></footer></dialog> : null}
 </section>;
}
