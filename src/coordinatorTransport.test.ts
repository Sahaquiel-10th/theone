import test from 'node:test';
import assert from 'node:assert/strict';
import {coordinatorPendingKey,coordinatorRequest,createCoordinatorRefreshQueue,forgetStoredCoordinatorOperation} from './coordinatorTransport';
import {ApiError} from './oneApi';

function deferred<T>(){let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;const promise=new Promise<T>((ok,fail)=>{resolve=ok;reject=fail;});return{promise,resolve,reject};}
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));

test('a permanently stalled GET is aborted and releases the refresh queue without replaying a write',async()=>{
  const calls:{path:string;options?:RequestInit}[]=[];
  const api=async<T>(path:string,options?:RequestInit):Promise<T>=>{calls.push({path,options});return new Promise<T>(()=>{});};
  const queue=createCoordinatorRefreshQueue(async()=>{
    await assert.rejects(coordinatorRequest(api,'/api/coordinator?page=1',{},5),error=>error instanceof ApiError&&error.retryable===false&&error.code==='COORDINATOR_READ_TIMEOUT');
  });
  await queue.request();await queue.request();
  assert.equal(calls.length,2);
  assert.ok(calls.every(call=>call.options?.signal?.aborted));
  assert.ok(calls.every(call=>!call.options?.method));
});

test('the deadline also covers a stalled JSON body rather than only receiving HTTP headers',async()=>{
  let signal:AbortSignal|null|undefined;
  const body=deferred<unknown>();
  const api=async<T>(_path:string,options?:RequestInit):Promise<T>=>{signal=options?.signal;await body.promise;return{status:'completed'} as T;};
  await assert.rejects(coordinatorRequest(api,'/api/coordinator/messages/original',{},5),error=>error instanceof ApiError&&error.retryable===false);
  assert.equal(signal?.aborted,true);
  body.resolve({});await tick();
});

test('a lost submission acknowledgement times out as ambiguous, without posting a second time',async()=>{
  let writes=0;
  const api=async<T>(_path:string,options?:RequestInit):Promise<T>=>{if(options?.method==='POST')writes++;return new Promise<T>(()=>{});};
  await assert.rejects(coordinatorRequest(api,'/api/coordinator/messages',{method:'POST',body:'{"operationId":"stable-original-id"}'},5),error=>error instanceof ApiError&&error.retryable===false);
  assert.equal(writes,1);
});

test('POST completion during an older refresh requests a fresh read instead of being silently dropped',async()=>{
  const first=deferred<void>(),second=deferred<void>();const pages:number[]=[];
  const queue=createCoordinatorRefreshQueue(async page=>{pages.push(page);await(pages.length===1?first.promise:second.promise);});
  const beforePost=queue.request();await tick();
  const afterPost=queue.request(),loadMore=queue.request(3);
  assert.notEqual(beforePost,afterPost);assert.equal(afterPost,loadMore);
  first.resolve();await beforePost;await tick();
  assert.deepEqual(pages,[1,3]);
  let refreshed=false;void afterPost.then(()=>{refreshed=true;});await tick();assert.equal(refreshed,false);
  second.resolve();await afterPost;assert.equal(refreshed,true);
});

test('continuous polling does not hold an earlier caller hostage until all later refreshes drain',async()=>{
  const reads=[deferred<void>(),deferred<void>(),deferred<void>()];let calls=0;
  const queue=createCoordinatorRefreshQueue(async()=>{await reads[calls++].promise;});
  const first=queue.request();await tick();
  const second=queue.request();reads[0].resolve();await first;await tick();
  const third=queue.request();reads[1].resolve();await second;
  assert.equal(calls,3);reads[2].resolve();await third;
});

test('a rejected read does not discard the queued recovery and a disposed scope cannot schedule more work',async()=>{
  const first=deferred<void>();let calls=0;
  const queue=createCoordinatorRefreshQueue(async()=>{if(++calls===1)await first.promise;});
  const failed=queue.request();const assertion=assert.rejects(failed,/offline/);await tick();
  const next=queue.request();first.reject(new Error('offline'));await assertion;await next;assert.equal(calls,2);
  queue.dispose();await queue.request();assert.equal(calls,2);
  queue.activate();await queue.request();assert.equal(calls,3,'React StrictMode can reactivate its effect without losing polling');
});

test('settling an older tab request cannot erase another tab next operation',()=>{
  const values=new Map([['pending','new-operation']]);
  const storage={getItem:(key:string)=>values.get(key)??null,removeItem:(key:string)=>{values.delete(key);}};
  forgetStoredCoordinatorOperation(storage,'pending','old-operation');assert.equal(values.get('pending'),'new-operation');
  forgetStoredCoordinatorOperation(storage,'pending','new-operation');assert.equal(values.size,0);
  assert.doesNotThrow(()=>forgetStoredCoordinatorOperation({getItem(){throw Error('disabled');},removeItem(){}},'pending','old'));
});

test('same-user workspace switches never look up a different workspace persisted operation',()=>{
 const values=new Map([[coordinatorPendingKey('same-user','old-workspace'),'old-private-operation']]);
 assert.equal(values.get(coordinatorPendingKey('same-user','new-workspace')),undefined);
 assert.notEqual(coordinatorPendingKey('same-user','old-workspace'),coordinatorPendingKey('same-user'));
 assert.notEqual(coordinatorPendingKey('one:two','three'),coordinatorPendingKey('one','two:three'));
});
