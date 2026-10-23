import { useEffect, useRef, useState } from 'react';
import { SettingsDialog } from './SettingsControls';
import { avatarArtifactKind, avatarFileSize } from './AvatarService';
export type AvatarArtifact = {
    id: string;
    name: string;
    mimeType: string;
    size: number;
};
const previewPolicy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'";
export function protectedAvatarHtml(html: string): string {
    const guard = `<meta http-equiv="Content-Security-Policy" content="${previewPolicy}">`;
    // Install the guard before any artifact bytes, even malformed markup with a
    // script preceding its <head>. The browser creates the document head here.
    return `<!doctype html><meta charset="utf-8">${guard}${html.replace(/<!doctype\s+html[^>]*>/i, '')}`;
}
// Intent: guests get actual private files, not just prose. The file name leads;
// preview stays in a modal on paper, with the existing 4 px rhythm and ink action.
export function AvatarArtifacts({ artifacts, runId, base, token }: {
    artifacts: AvatarArtifact[];
    runId: string;
    base: string;
    token: string;
}) {
    const [preview, setPreview] = useState<{
        file: AvatarArtifact;
        url?: string;
        html?: string;
    }>(), [busy, setBusy] = useState(''), [error, setError] = useState('');
    const live = useRef(true);
    useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
    useEffect(() => () => { if (preview?.url)
        URL.revokeObjectURL(preview.url); }, [preview]);
    async function fetchFile(file: AvatarArtifact, download: boolean) {
        setBusy(file.id);
        setError('');
        try {
            const response = await fetch(`${base}/questions/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(file.id)}`, { headers: { Authorization: `Bearer ${token}` }, credentials: 'same-origin' });
            if (!response.ok) {
                const body = await response.json().catch(() => ({}));
                throw new Error(body.error || '暂时打不开成果，请稍后重试。');
            }
            const blob = await response.blob();
            if (!live.current)
                return;
            if (download) {
                const url = URL.createObjectURL(blob), a = document.createElement('a');
                a.href = url;
                a.download = file.name;
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 10000);
            }
            else if (avatarArtifactKind(file.mimeType) === 'html') {
                const html = await blob.text();
                if (live.current)
                    setPreview({ file, html: protectedAvatarHtml(html) });
            }
            else
                setPreview({ file, url: URL.createObjectURL(blob) });
        }
        catch (e) {
            if (live.current)
                setError(e instanceof Error ? e.message : '暂时打不开成果，请稍后重试。');
        }
        finally {
            if (live.current)
                setBusy('');
        }
    }
    return <div className="avatar-artifacts" aria-label="本次成果">{artifacts.map(file => <div className="avatar-artifact" key={file.id}><div><strong>{file.name}</strong><small>{avatarFileSize(file.size)}</small></div><div>{avatarArtifactKind(file.mimeType) !== 'download' ? <button type="button" disabled={!!busy} onClick={() => void fetchFile(file, false)}>{busy === file.id ? '正在打开…' : '打开看看'}</button> : null}<button type="button" disabled={!!busy} onClick={() => void fetchFile(file, true)}>保存文件</button></div></div>)}{error ? <p role="alert">{error}</p> : null}{preview ? <SettingsDialog title={preview.file.name} className="avatar-artifact-dialog" onClose={() => setPreview(undefined)}>{preview.html ? <iframe title={preview.file.name} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={preview.html}/> : <img alt={preview.file.name} src={preview.url}/>}<footer><button type="button" disabled={!!busy} onClick={() => void fetchFile(preview.file, true)}>保存文件</button></footer></SettingsDialog> : null}</div>;
}
