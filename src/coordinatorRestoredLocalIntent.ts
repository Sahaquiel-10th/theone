import type {CoordinatorSubmission} from './useCoordinator';
type Composer={text:string;outputDestination:'chat'|'local'|'notion';modelId?:string;boundTaskId?:string;attachmentIds:string[];featureIds:string[];webSearch:boolean};
/** Only an explicitly restored original request may retain its old execute
 * intent. Choosing a local destination never creates that intent by itself. */
export function coordinatorRestoredLocalIntent(original:CoordinatorSubmission|undefined|null,current:Composer){
 return original?.localExecution===true&&current.outputDestination==='local'&&current.text.trim()===original.text.trim()
  &&current.modelId===original.modelId&&current.boundTaskId===original.boundTaskId&&current.webSearch===Boolean(original.webSearch)
  &&JSON.stringify(current.attachmentIds)===JSON.stringify(original.attachmentIds??[])
  &&JSON.stringify(current.featureIds)===JSON.stringify(original.featureIds??[]);
}
