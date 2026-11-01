import type {Database} from './types.js';
import type {LocalDeviceReadiness} from '../src/localDeviceReadiness.js';
import {CoordinatorLocalError,localReadinessCanStart,localReadinessFailure} from './coordinatorLocalPolicy.js';
import type {CoordinatorFailure} from '../src/coordinatorRecovery.js';

/** Only the real execution entry may issue this after proving no local row was
 * created and no concurrent pending execution claim can still launch. */
export class LocalExecutionNotStartedError extends Error{
 constructor(readonly failure:CoordinatorFailure){super(failure.code);}
}

export type LocalAdmissionScope={workspaceId:string;userId:string;deviceId:string;installationId?:string;conversationId:string;sourceMessageId:string};
export function preparedLocalAdmission(db:Pick<Database,'chatOperations'>,scope:LocalAdmissionScope){
 return db.chatOperations?.find(o=>o.workspaceId===scope.workspaceId&&o.userId===scope.userId&&o.conversationId===scope.conversationId&&o.workRun?.inputMessageId===scope.sourceMessageId)?.workRun;
}
/** All actual entry points use this same fact snapshot, before compilation.
 * The final insert still rechecks the original immutable admission revision. */
export function assertLocalAdmission(db:Pick<Database,'chatOperations'>,scope:LocalAdmissionScope,readiness:LocalDeviceReadiness){
 if(!localReadinessCanStart(readiness))throw new CoordinatorLocalError(localReadinessFailure(readiness));
 const prepared=preparedLocalAdmission(db,scope);
 if(!prepared)return;
 const binding=prepared.localExecution;
 if(prepared.executionMode!=='local'||!binding||binding.deviceId!==scope.deviceId||binding.installationId!==scope.installationId
   ||binding.targetName&&binding.targetName!==readiness.folder.targetName)throw new CoordinatorLocalError('local_binding_changed',409);
}
export function assertLocalAdmissionRevision(db:Pick<Database,'chatOperations'>,scope:LocalAdmissionScope,expected?:number){
 const current=preparedLocalAdmission(db,scope);
 if(current?.localExecution?.admissionRevision!==expected)throw new CoordinatorLocalError('local_binding_changed',409);
}
export function assertLocalDirectoryUnchanged(initial:LocalDeviceReadiness,current:LocalDeviceReadiness){
 if(initial.folder.state!==current.folder.state||initial.folder.targetName!==current.folder.targetName)throw new CoordinatorLocalError('local_binding_changed',409);
}
