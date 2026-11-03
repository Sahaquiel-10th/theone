import type {api as Api} from './oneApi';
import {parseNotionPageLink} from './notionPageLink';

export type NotionPageRecoverySelection={sourceJobId:string;expectedUpdatedAt:string;pageUrl:string;selectionId:string};
/** This submits one user-selected page to the existing read-only verifier. It
 * cannot choose another task, create a page or grant Notion access. */
export async function verifySelectedNotionPage(api:typeof Api,taskId:string,selection:NotionPageRecoverySelection){
 const parsed=parseNotionPageLink(selection.pageUrl);
 if(parsed.error||!parsed.pageId)throw Error(parsed.error||'请粘贴这次已保存原页的链接。');
 if(!taskId||!selection.sourceJobId||!selection.selectionId||!Number.isFinite(Date.parse(selection.expectedUpdatedAt)))throw Error('原保存记录尚未加载完整，请先刷新这件任务。');
 return api<{state?:string}>(`/api/coordinator/tasks/${encodeURIComponent(taskId)}/notion/verify`,{method:'POST',body:JSON.stringify({...selection,pageUrl:`https://www.notion.so/${parsed.pageId}`})});
}
