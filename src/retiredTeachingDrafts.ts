import {teacherDraftStorageKey,type TeacherIdentity} from './teacherTaskState';

/** The retired preparation workflow contains the test drafts explicitly discarded
 * by the product owner. Never touch course drafts, uploads or another identity. */
export function clearRetiredTeachingDrafts(storage:Pick<Storage,'getItem'|'removeItem'>,owner:Pick<TeacherIdentity,'userId'|'workspaceId'>){
  if(!owner.userId||!owner.workspaceId)return 0;
  const key=teacherDraftStorageKey(owner);
  try{const raw=storage.getItem(key);if(!raw)return 0;const value=JSON.parse(raw);if(value?.version!==1||value.userId!==owner.userId||value.workspaceId!==owner.workspaceId||!Array.isArray(value.drafts))return 0;storage.removeItem(key);return value.drafts.length;}catch{return 0;}
}
