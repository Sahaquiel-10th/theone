import type {Database} from './types.js';
/** Private, authenticated routes only. Callers must first resolve an owned file. */
export function artifactResultLinks(id: string, visual = false, office = false) {
  const fileId = encodeURIComponent(id);
  return {
    openUrl: office ? `/api/office-files/${fileId}/view` : visual ? `/api/welcome-pages/${fileId}/view` : `/api/attachments/${fileId}/content`,
    downloadUrl: `/api/attachments/${fileId}/content`,
  };
}

export function ownedArtifactResults(db:Database,scope:{workspaceId:string;userId:string},conversationId:string,ids:string[]) {
  const wanted=new Set(ids);
  return db.attachments.filter(file=>file.workspaceId===scope.workspaceId&&file.userId===scope.userId
    &&(file.conversationId===conversationId||file.sharedConversationIds?.includes(conversationId))
    &&file.status==='ready'&&wanted.has(file.id))
    .map(file=>({name:file.originalName,kind:file.kind,...artifactResultLinks(file.id,Boolean(file.visualDocument||file.welcomeGuide),file.officeArtifact==='slides')}));
}
