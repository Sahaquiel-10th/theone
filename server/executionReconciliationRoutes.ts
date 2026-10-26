import type express from 'express';
import type {RequestHandler} from 'express';
import type {Store} from './db.js';
import {asyncRoute, requireRole} from './middleware.js';
import {ExecutionReconciliationError, reconcileStoppedExecution} from './executionReconciliation.js';
import {publicExecutionTask, taskEvents} from './executionService.js';

export const manualExecutionStopConfirmation = 'manually_checked_original_execution_stopped';

/** A deliberately narrow support action: a freshly proved Key, admin role,
 * same task owner and same computer are required. There is no cross-user
 * support read, SQL mutation, executable input or automatic retry path. */
export function installExecutionReconciliationRoutes(app: express.Express, keyAuth: readonly RequestHandler[], store: Store) {
  app.post('/api/executions/:id/reconcile-stop', ...keyAuth, requireRole('admin'), asyncRoute(async (req, res) => {
    const body = req.body as Record<string, unknown> | undefined;
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some(key => !['expectedRound','expectedUpdatedAt','reason','confirmation'].includes(key))
      || body.confirmation !== manualExecutionStopConfirmation
      || !Number.isSafeInteger(body.expectedRound) || (body.expectedRound as number) < 0
      || typeof body.expectedUpdatedAt !== 'string' || body.expectedUpdatedAt.length > 100 || !Number.isFinite(Date.parse(body.expectedUpdatedAt))
      || typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 2000)
      return res.status(400).json({error:'请完整确认原任务、当前轮次和人工核对原因。',code:'EXECUTION_RECONCILIATION_INVALID'});
    const scope = {workspaceId:req.workspaceId!,userId:req.user!.id,
      deviceId:req.oneKeyDeviceId!,installationId:req.oneKeyInstallationId};
    try {
      const result = await store.mutate(database => {
        // Recheck the administrative restriction at the point of mutation,
        // not only in middleware before another concurrent account change.
        if (!database.users.some(user => user.id === scope.userId && user.enabled && user.role === 'admin'))
          throw new ExecutionReconciliationError('当前账号不能人工结束本机操作。');
        const task = database.executionTasks.find(task => task.id === req.params.id && task.workspaceId === scope.workspaceId
          && task.userId === scope.userId && task.deviceId === scope.deviceId && task.installationId === scope.installationId);
        if (!task?.deliveryAttempt) throw new ExecutionReconciliationError('原任务或等待记录已变化，请重新核对。');
        const result = reconcileStoppedExecution(database, scope.userId, {...scope,taskId:task.id,
          attemptId:task.deliveryAttempt.id,round:body.expectedRound as number,
          expectedUpdatedAt:body.expectedUpdatedAt as string,reason:body.reason as string});
        return {...result,task:publicExecutionTask(task,scope),events:taskEvents(database,task)};
      });
      return res.json(result);
    } catch (error) {
      if (error instanceof ExecutionReconciliationError)
        return res.status(409).json({error:error.message,code:error.code});
      throw error;
    }
  }));
}
