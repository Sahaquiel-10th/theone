import {FileImage,FileSpreadsheet,FileText,Presentation} from 'lucide-react';
import {AttachmentActions} from './AttachmentActions';
import {ImagePreview} from './MessageMarkdown';
import {WelcomeGuideCard} from './WelcomeGuideCard';
import type {MessageAttachment} from './preview/dispatchPreviewState';

export function attachmentStatusLabel(file: MessageAttachment): string {
  if (file.status === 'uploading') {
    const percent = file.size && Number.isFinite(file.size) && file.uploadedBytes !== undefined && Number.isFinite(file.uploadedBytes)
      ? Math.max(0, Math.min(100, Math.floor(file.uploadedBytes / file.size * 100))) : undefined;
    return percent === undefined ? '正在上传' : `上传 ${percent}%`;
  }
  if (file.status === 'queued') return '等待解析';
  if (file.status === 'parsing') return '正在解析';
  if (file.status === 'failed') return '解析未完成';
  if (!file.size || !Number.isFinite(file.size)) return '文件已就绪';
  return file.size < 1024 * 1024 ? `${Math.max(1, Math.round(file.size / 1024))} KB` : `${(file.size / 1024 / 1024).toFixed(1)} MB`;
}

function AttachmentMark({kind}: {kind: MessageAttachment['kind']}) {
  if (kind === 'image') return <FileImage size={20}/>;
  if (kind === 'spreadsheet') return <FileSpreadsheet size={20}/>;
  if (kind === 'presentation') return <Presentation size={20}/>;
  return <FileText size={20}/>;
}

/** Private file access stays on the same authenticated actions as the old view. */
export function MessageAttachments({files}: {files?: MessageAttachment[]}) {
  if (!files?.length) return null;
  return <div className="coordinator-attachments" aria-label="这条消息的附件">
    {files.map(file => {
      const ready = !file.status || file.status === 'ready';
      if (ready && (file.welcomeGuide || file.visualDocument)) return <WelcomeGuideCard key={file.id} id={file.id} title={file.originalName}/>;
      return <section key={file.id} className="coordinator-attachment" data-attachment-state={file.status || 'ready'}>
        {ready && file.kind === 'image' ? <div className="coordinator-attachment-thumbnail"><ImagePreview src={`/api/attachments/${encodeURIComponent(file.id)}/content`} alt={file.originalName}/></div> : <span className="coordinator-attachment-icon"><AttachmentMark kind={file.kind}/></span>}
        <div className="coordinator-attachment-meta">
          <strong title={file.originalName}>{file.originalName}</strong>
          <small>{attachmentStatusLabel(file)}</small>
          <AttachmentActions file={file}/>
          {file.status === 'failed' && file.parseError ? <details className="coordinator-attachment-error"><summary>查看原因</summary><p>{file.parseError}</p></details> : null}
        </div>
      </section>;
    })}
  </div>;
}
