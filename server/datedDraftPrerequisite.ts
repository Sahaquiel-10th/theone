import {requestedDateRange, type RuntimeContext} from './runtimeContext.js';
import type {OrchestrationTool} from './taskOrchestrator.js';

/** A narrow content prerequisite, not a semantic document-quality classifier.
 * It only gates a new draft whose server contract requires dated retrieval and
 * has no other supplied material. Existing documents/attachments are untouched. */
export function datedDraftPrerequisite(input: {newDraft: boolean; requiredKnowledge: boolean; hasMaterials: boolean; instruction: string; originalRequest: string; time: RuntimeContext}) {
  const range=requestedDateRange(input.instruction,input.time);
  const clauses=input.originalRequest.split(/[。；;\n]/).filter(clause=>!/(?:不|不要|无需|不用)(?:自行|自动|先)?(?:保存|写入|新建|创建)/.test(clause));
  const explicitExplanation=clauses.some(clause=>/(?:缺少?|没有|没找到|找不到|不足|待补|待素材).{0,30}(?:保存|写入|新建|创建).{0,12}(?:说明|记录|便笺)|(?:保存|写入|新建|创建).{0,12}(?:缺(?:失|少|资料)|未找到|待素材|待补).{0,12}(?:说明|记录|便笺)/.test(clause));
  if(!input.newDraft||!input.requiredKnowledge||input.hasMaterials||!range||explicitExplanation)return;
  let state:'awaiting'|'missing'|'ready'='awaiting',unavailable=false;
  const label=range.from===range.to?range.from:`${range.from} 至 ${range.to}`;
  const message=()=>state==='awaiting'?'先查找并核对所需日期的素材；资料还没拿到时不要新建待素材说明。'
    : unavailable?`资料来源这次没查成，还没拿到能核对为 ${label} 的素材。正文先不写，也没有新建占位文档。你可以先检查知识连接，或把那天的几句原话发来再接着写。`
    : `这次检索还没找到能核对为 ${label} 的素材，正文还没写成，也没有新建占位文档。把那天的几句原话或相关记录发来，就能接着写。`;
  const gate={
    get blocked(){return state!=='ready';},
    get missing(){return state==='missing';},
    message,
    observe(result:unknown){
      const value=result as {status?:string;chunks?:unknown[]}|null;
      if(!value||!Array.isArray(value.chunks))return;
      state=value.chunks.length?'ready':'missing';
      unavailable=!value.chunks.length&&['failed','partial','not_connected'].includes(value.status??'');
    },
    result:()=>JSON.stringify({outcome:'needs_input',content:message(),summary:message()}),
    wrap(tool:OrchestrationTool):OrchestrationTool {
      if(!tool.structured)return tool;
      const structured=tool.structured;
      return {...tool,structured:{...structured,
        // A refused placeholder is a read-only decision, never an uncertain write.
        effect:value=>gate.blocked?'read':structured.effect?.(value)??tool.effect??'external_write',
        run:async value=>gate.blocked?{status:'needs_input',message:message(),saved:false}:structured.run(value),
      }};
    },
  };
  return gate;
}
