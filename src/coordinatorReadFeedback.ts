import {ApiError} from './oneApi';

export type CoordinatorReadSource = 'snapshot' | `receipt:${string}` | `detail:${string}`;
export type CoordinatorReadIssue = {connection:boolean;message:string};
export type CoordinatorReadIssues = Partial<Record<CoordinatorReadSource,CoordinatorReadIssue>>;

/** Read connectivity does not establish whether a submitted task succeeded. */
export function coordinatorReadIssue(source:CoordinatorReadSource,error:unknown):CoordinatorReadIssue {
  const connection=error instanceof TypeError
    ||error instanceof DOMException&&['AbortError','TimeoutError'].includes(error.name)
    ||error instanceof ApiError&&(
      ['COORDINATOR_READ_TIMEOUT','INVALID_RESPONSE','INVALID_COORDINATOR_RECEIPT'].includes(error.code??'')
      ||[408,429].includes(error.status??0)||(error.status??0)>=500
    );
  const message=connection
    ? source.startsWith('detail:')?'这件事的详细进度暂时没连上，正在重新查看。'
      :source.startsWith('receipt:')?'这条消息的接收状态暂时没连上，正在重新查看。'
        :'任务进度暂时没连上，正在恢复连接。'
    :error instanceof Error?error.message:'任务进度暂时无法读取，请查看连接状态。';
  return {connection,message};
}

export function coordinatorReadFeedback(issues:CoordinatorReadIssues) {
  const values=Object.values(issues).filter((issue):issue is CoordinatorReadIssue=>Boolean(issue));
  return {
    error:values.filter(issue=>!issue.connection).at(-1)?.message??'',
    notice:values.filter(issue=>issue.connection).at(-1)?.message??'',
  };
}
