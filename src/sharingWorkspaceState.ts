import type {AvatarAvailableFeature,AvatarServiceConfig,AvatarBusinessConfig} from './AvatarService';
export type PublicationRow={authorName?:string;service?:{mode:'consultation'|'knowledge';featureCount:number};id:string;version:number;slug?:string;name:string;description:string;status:string;expiresAt:string;budgetMicros:number;perRunMicros:number;spent:number;held:number;attachments:boolean;sources:string[];syncPending?:boolean};
export type PublicationList={authorName?:string;availableFeatures?:AvatarAvailableFeature[];ready:boolean;visitorPaymentsEnabled?:boolean;items:PublicationRow[];total:number;sources:{id:string;provider:string;name:string}[]};
export type PublicationDraft={service?:AvatarServiceConfig;serviceBusiness?:AvatarBusinessConfig;name:string;description:string;prompt:string;modelId:string;sourceIds:string[];attachments:boolean;budget:number;perRun:number;days:number;confirmed:boolean;visitorPercent:number;requireLogin:boolean;allowedUsernames:string[]};
export type PublicationReceipt={id:string;slug?:string;version?:number;expiresAt?:string;status?:'draft'|'active'};
export type SharingPane={kind:'create'}|{kind:'edit'|'usage'|'services'|'publish'|'close';owner:PublicationRow};
export type SharingWorkspaceState={pane:SharingPane|null;linkOwnerId:string|null;queuedLinkOwnerId:string|null};
export const initialSharingWorkspace:SharingWorkspaceState={pane:null,linkOwnerId:null,queuedLinkOwnerId:null};
export type SharingWorkspaceAction={type:'open-pane';pane:SharingPane}|{type:'open-link';ownerId:string}|{type:'close-pane'}|{type:'saved'}|{type:'main-merged'}|{type:'close-link'};
export type SharingOwnerRequest={ownerId:string;generation:number};
/** Reading one owner's config must never reopen it after navigation to another owner. */
export function createSharingOwnerRequestGate(){
 let generation=0;
 return {
  begin(ownerId:string):SharingOwnerRequest{return {ownerId,generation:++generation};},
  invalidate(){generation++;},
  isCurrent(request:SharingOwnerRequest){return request.generation===generation;}
 };
}
/** The editor belongs to the list; a link belongs to exactly one existing row. */
export function sharingWorkspaceTransition(state:SharingWorkspaceState,action:SharingWorkspaceAction):SharingWorkspaceState {
 switch(action.type){
  case 'open-pane':return {pane:action.pane,linkOwnerId:null,queuedLinkOwnerId:null};
  case 'open-link':return state.pane?{pane:null,linkOwnerId:null,queuedLinkOwnerId:action.ownerId}:{pane:null,linkOwnerId:action.ownerId,queuedLinkOwnerId:null};
  case 'close-pane':return {...state,pane:null};
  case 'saved':return {...initialSharingWorkspace};
  case 'main-merged':return state.pane?state:{pane:null,linkOwnerId:state.queuedLinkOwnerId??state.linkOwnerId,queuedLinkOwnerId:null};
  case 'close-link':return {...state,linkOwnerId:null,queuedLinkOwnerId:null};
 }
}
/** Only server-confirmed status and identity can enter the owner list. */
export function confirmedPublicationRow(receipt:PublicationReceipt,draft:PublicationDraft,sources:PublicationList['sources'],previous?:PublicationRow,now=Date.now()):PublicationRow {
 if(!receipt.id||receipt.status!=='draft'&&!receipt.slug)throw new Error('发布已返回，但分身身份信息不完整。请先刷新列表核对，勿重复发布。');
 if(previous&&receipt.id!==previous.id)throw new Error('返回的分身身份与当前编辑项不一致，请刷新列表核对。');
 return {authorName:previous?.authorName,service:draft.service?{mode:draft.service.mode,featureCount:draft.service.features.length}:previous?.service,id:receipt.id,slug:receipt.slug,version:receipt.version??(previous?(previous.version??1)+1:1),name:draft.name.trim(),description:draft.description.trim(),status:receipt.status??'active',expiresAt:new Date(now+draft.days*86400000).toISOString(),budgetMicros:Math.round(draft.budget*1e6),perRunMicros:Math.round(draft.perRun*1e6),spent:previous?.spent??0,held:previous?.held??0,attachments:draft.attachments,sources:draft.sourceIds.map(id=>sources.find(source=>source.id===id)?.name??'已授权来源'),syncPending:true};
}
export function upsertConfirmedPublication(list:PublicationList,row:PublicationRow):PublicationList {
 const exists=list.items.some(item=>item.id===row.id);
 return {...list,items:[row,...list.items.filter(item=>item.id!==row.id)],total:list.total+(exists?0:1)};
}
/** An old list response cannot erase a confirmed new row or roll back its version. */
export function reconcilePublicationList(server:PublicationList,pending:ReadonlyMap<string,PublicationRow>,includeMissing=true) {
 const remaining=new Map(pending),items=server.items.map(row=>{const local=remaining.get(row.id);if(!local)return row;if(row.version>=local.version){remaining.delete(row.id);return row;}return local;});
 if(includeMissing)for(const row of remaining.values())if(!items.some(item=>item.id===row.id))items.unshift(row);
 return {list:{...server,items,total:Math.max(server.total,items.length)},pending:remaining};
}
/** Transport failures can hide a successful create; an automatic retry could duplicate it. */
export function publicationSubmitIsUncertain(error:unknown) {
 const status=error&&typeof error==='object'&&'status' in error?Number(error.status):0;
 return !Number.isFinite(status)||status===0||status>=500||status===408;
}
