import type {ChatOperation} from './chatOperations.js';

/** Only an explicitly selected old failed save may cross the delayed
 * readback/finalization boundary. Canonical upgrades never change the original
 * expected digest; a new write/target/version invalidates this selection. */
export function selectedNotionVerification(operation:Pick<ChatOperation,'id'|'status'|'workRun'>){
 const run=operation.workRun,selection=run?.notionVerificationSelection,receipt=run?.notionReceipt,target=run?.notionTarget;
 return Boolean(['failed','completed'].includes(operation.status)&&run?.state==='failed'&&selection&&receipt&&target
  &&selection.operationId===operation.id&&selection.expectedDigest===receipt.expectedDigest
  &&selection.checkpointKey===receipt.checkpointKey
  &&(selection.pageId?selection.pageId===receipt.pageId:selection.asyncTaskId&&selection.asyncTaskId===receipt.asyncTaskId)
  &&selection.asyncTaskId===receipt.asyncTaskId
  &&(!receipt.verification||selection.version===receipt.verification.version)
  &&selection.connectionId===target.connectionId&&selection.grantId===target.grantId&&selection.parentId===target.parentId);
}
