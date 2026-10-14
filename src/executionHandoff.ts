export type ExecutionHandoffSettlement = {operationId:string; status:string; taskId?:string;taskIds?:string[]};

// A receipt for an older submission must never end the current takeover.
export function executionHandoffOutcome(operationId:string, settled:ExecutionHandoffSettlement|null) {
  if (!operationId || settled?.operationId !== operationId || settled.status === 'pending') return 'pending';
  return settled.status === 'completed' && (settled.taskId || settled.taskIds?.length) ? 'dispatched' : 'not_started';
}
