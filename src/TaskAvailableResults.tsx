import {MessageMarkdown} from './MessageMarkdown';

export type TaskAvailableResult={stepId:string;title:string;content:string};

/** This is a read-only projection of completed, authorized checkpoints. It is
 * not another message, saved draft, or command to finish the remaining work. */
export function TaskAvailableResults({results}:{results?:TaskAvailableResult[]}){
 const available=Array.isArray(results)?results.filter(result=>result&&typeof result.stepId==='string'&&typeof result.title==='string'&&typeof result.content==='string'&&result.content.trim()):[];
 if(!available.length)return null;
 return <section className="task-available-results" aria-label="已有成果">
  <p className="task-available-label">已有成果</p>
  {available.map(result=><article className="assistant" key={result.stepId}>
   <h3 className="task-available-title">{result.title}</h3>
   <div className="markdown-body things-assistant-markdown"><MessageMarkdown privateImagesOnly codeTools>{result.content}</MessageMarkdown></div>
  </article>)}
 </section>;
}
