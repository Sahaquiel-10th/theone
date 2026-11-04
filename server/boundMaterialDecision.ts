import type {WorkRun} from './coordinatorTypes.js';
import {parseTaskInputSourceReference} from './taskInputSource.js';

type MaterialRun=Pick<WorkRun,'kind'|'executionMode'|'localExecution'|'onboardingPractice'|'materialScope'|'materialSource'|'inputSource'>;
/** This only requests the existing semantic router. Size/structure never
 * determines current vs conversation, nor grants new source permissions. */
export function needsBoundMaterialDecision(input:{text:string;attachmentIds?:readonly string[];workspaceId:string;userId:string;taskId:string;run?:MaterialRun}):boolean{
 const run=input.run;
 if(!run||run.kind==='image'||run.executionMode==='local'||run.localExecution||run.onboardingPractice||run.materialScope!=='current')return false;
 const source=parseTaskInputSourceReference(run.materialSource??run.inputSource);
 if(!source||source.workspaceId!==input.workspaceId||source.userId!==input.userId||source.taskId!==input.taskId)return false;
 const structured=/(?:正文|原文|材料|素材|内容)(?:如下|内容|是|为)?\s*[:：]\s*\S/u.test(input.text)
  ||/(?:以下|下面)(?:这(?:份|段|版))?(?:是|为)?[^\n:：]{0,20}[:：]\s*\S/u.test(input.text)
  ||/(?:改用|换用|替换|重新(?:贴|粘贴)|缩短后的|新版本)[^\n:：]{0,32}(?:[:：]|\n)\s*\S/u.test(input.text)
  ||/(?:^|\n)\s*(?:```|~~~)[^\n]*\n\S/u.test(input.text);
 return Boolean(input.attachmentIds?.length||structured||input.text.length>800);
}
