import {ApiError} from './oneApi';

export const COORDINATOR_READ_TIMEOUT_MS = 12_000;
export const COORDINATOR_ACK_TIMEOUT_MS = 30_000;
type Request = <T>(path: string, options?: RequestInit) => Promise<T>;
export const coordinatorPendingKey = (user:string,workspaceId='') => `one-coordinator-operation:${user}${workspaceId?':'+encodeURIComponent(workspaceId):''}`;

/** A deadline only ends this browser's wait, never authorizes replaying a submission. */
export async function coordinatorRequest<T>(api: Request, path: string, options: RequestInit = {}, timeoutMs = options.method && options.method !== 'GET' ? COORDINATOR_ACK_TIMEOUT_MS : COORDINATOR_READ_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener('abort', abort, {once: true});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      api<T>(path, {...options, signal: controller.signal}),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new ApiError('进度暂时没连上，正在重新查看；不用重发。', undefined, undefined, 'COORDINATOR_READ_TIMEOUT', false));
          controller.abort();
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}

/** Keep one readback in flight, but never lose the refresh requested after a POST. */
export function createCoordinatorRefreshQueue(run: (page: number) => Promise<void>) {
  type Job = {page:number;promise:Promise<void>;resolve:()=>void;reject:(reason:unknown)=>void};
  let queued: Job | undefined;
  let running = false;
  let disposed = false;
  async function drain() {
    while(queued&&!disposed){
      const job=queued;queued=undefined;
      try{await run(job.page);job.resolve();}catch(e){job.reject(e);}
    }
    running=false;
  }
  return {
    request(page = 1): Promise<void> {
      if (disposed) return Promise.resolve();
      if(queued)queued.page=Math.max(queued.page,page);
      else{
        let resolve!:()=>void,reject!:(reason:unknown)=>void;
        const promise=new Promise<void>((ok,fail)=>{resolve=ok;reject=fail;});
        queued={page,promise,resolve,reject};
      }
      const result=queued.promise;
      if(!running){running=true;void Promise.resolve().then(drain);}
      return result;
    },
    activate() { disposed = false; },
    dispose() { disposed = true;queued?.resolve();queued=undefined; },
  };
}

/** A second window may already have saved its next request under the same key. */
export function forgetStoredCoordinatorOperation(storage: Pick<Storage, 'getItem' | 'removeItem'>, key: string, operation: string) {
  try { if (storage.getItem(key) === operation) storage.removeItem(key); } catch { /* Storage is optional. */ }
}
