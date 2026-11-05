/** Read a student's explicit event field before searching the authorized course
 * library. These are search terms, never instructions or a grant of access. */
export function teachingStoryResearchQuery(script:string,courseTitle:string):string{
 const lines=script.split(/\r?\n/).map(x=>x.replace(/^\s*(?:[-*#]+|\d+[.、])\s*/,'').trim()).filter(Boolean);
 const event=/^(?:关联历史大事件[^:：]*|历史锚点[^:：]*|历史事件[^:：]*|关联事件[^:：]*|事件[^:：]*|历史背景[^:：]*|故事背景[^:：]*)[:：]\s*(.+)$/u;
 const selected=lines.map(line=>event.exec(line)?.[1]?.trim()).find(Boolean);
 return (selected||[courseTitle,lines.slice(0,5).join(' ')].filter(Boolean).join(' ')).slice(0,180);
}
