import React from 'react';

export type ActionAttachment={id:string;originalName:string;officeArtifact?:'slides'|'file';status?:string};
/** URLs stay on the authenticated, owner-scoped routes; never use a storage path. */
export function AttachmentActions({file,showName=false}:{file:ActionAttachment;showName?:boolean}){
  if(file.status&&file.status!=='ready')return null;
  const id=encodeURIComponent(file.id);
  return <span className="attachment-actions">
    {file.officeArtifact==='slides'?<a href={`/api/office-files/${id}/view`} target="_blank" rel="noopener noreferrer" aria-label={`打开演示稿：${file.originalName}`}>打开演示稿 ↗</a>:null}
    <a href={`/api/attachments/${id}/content`} download={file.originalName} aria-label={`下载：${file.originalName}`}>{showName?file.originalName:'下载文件'} ↓</a>
  </span>;
}
