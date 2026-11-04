import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {once} from 'node:events';
import express from 'express';
import ts from 'typescript';
import type {Database,Attachment} from './types.js';
import {asyncRoute} from './middleware.js';
import {ownedAttachment} from './attachmentService.js';
import {publicAttachmentSummary} from './conversationAttachments.js';
import {industryAttachmentReferenced} from './industryState.js';

const source=nodeFs.readFileSync(new URL('./index.ts',import.meta.url),'utf8');
const parsed=ts.createSourceFile('index.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
const routes:{method:string;route:string;node:ts.CallExpression}[]=[];let generalGuard:ts.Expression|undefined;
function inspect(node:ts.Node){
  if(ts.isVariableDeclaration(node)&&node.name.getText(parsed)==='requireGeneralAttachment')generalGuard=node.initializer;
  if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&node.expression.expression.getText(parsed)==='app'&&ts.isStringLiteral(node.arguments[0]))routes.push({method:node.expression.name.text,route:node.arguments[0].text,node});
  ts.forEachChild(node,inspect);
}
inspect(parsed);
function callback(expression:ts.Expression|undefined){assert.ok(expression&&ts.isCallExpression(expression)&&expression.expression.getText(parsed)==='asyncRoute');const handler=expression.arguments[0];assert.ok(ts.isArrowFunction(handler));return handler;}
function compile(handler:ts.Expression,context:Record<string,unknown>):express.RequestHandler{
  const code=ts.transpileModule(`(${handler.getText(parsed)})`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
  return vm.runInNewContext(code,context) as express.RequestHandler;
}

async function fixture(t:TestContext,trashed=false){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'one-general-teaching-audit-')),privatePath=path.join(directory,'private-original.txt'),normalPath=path.join(directory,'normal.txt');
  await fs.writeFile(privatePath,'PRIVATE_TEACHING_ORIGINAL');await fs.writeFile(normalPath,'ORDINARY_CHAT_UPLOAD');
  const scope={workspaceId:'audit-workspace',userId:'audit-teacher'},stamp='2026-11-04T00:00:00Z';
  const file:Attachment={...scope,id:'teaching-original',conversationId:'teaching:course-a',originalName:'private-original.txt',mimeType:'text/plain',kind:'text',size:25,status:'ready',extractedText:'PRIVATE_TEACHING_ORIGINAL',storagePath:privatePath,createdAt:stamp};
  const normal:Attachment={...file,id:'ordinary-upload',conversationId:undefined,originalName:'normal.txt',extractedText:'ORDINARY_CHAT_UPLOAD',storagePath:normalPath};
  const course={...scope,id:'course-a',title:'Synthetic private course',revision:1,materialAttachmentIds:[file.id],activities:[{...scope,id:'assignment-a',courseId:'course-a',sourceAttachmentIds:[file.id]}],...(trashed?{deletedAt:stamp}:{}),status:trashed?'closed':'published'};
  const db={users:[{id:scope.userId,teaching:{courses:[course],submissions:[{...scope,id:'submission-a',courseId:'course-a',activityId:'assignment-a',attachmentIds:[file.id],activitySnapshot:course.activities[0]}],sessions:[],operations:[]}}],attachments:[file,normal]} as unknown as Database;
  const counters={chunk:0,complete:0,retry:0,removed:[] as string[]};
  const store={read:async()=>db,mutate:async<T,>(change:(data:Database)=>T)=>change(db)};
  const context={store,ownedAttachment,industryAttachmentReferenced,attachmentSummary:publicAttachmentSummary,removeAttachmentFiles:async(value:string)=>{counters.removed.push(value);},fs:nodeFs,Buffer,attachmentService:{chunk:async()=>{counters.chunk++;return 25;},complete:async()=>{counters.complete++;},retry:async()=>{counters.retry++;}}};
  assert.ok(generalGuard,'Missing the actual general attachment guard');
  const guard=compile(generalGuard,{...context,asyncRoute}),app=express();
  const auth:express.RequestHandler=(req,_res,next)=>{req.user={id:scope.userId} as any;req.workspaceId=scope.workspaceId;next();};
  const specs=[['get','/api/attachments/:id'],['get','/api/attachments/:id/content'],['delete','/api/attachments/:id'],['put','/api/attachments/:id/chunks'],['post','/api/attachments/:id/complete'],['post','/api/attachments/:id/retry']] as const;
  for(const [method,url]of specs){
    const route=routes.find(item=>item.method===method&&item.route===url);assert.ok(route,`Missing actual ${method} ${url}`);
    const authIndex=route.node.arguments.findIndex(argument=>ts.isSpreadElement(argument)&&argument.expression.getText(parsed)==='keyAuth'),guardIndex=route.node.arguments.findIndex(argument=>ts.isIdentifier(argument)&&argument.text==='requireGeneralAttachment');
    assert.ok(authIndex>=0&&guardIndex>authIndex,`${method} ${url} must run the namespace guard after Key authorization`);
    const handler=compile(callback(route.node.arguments.at(-1)),context);
    const parser=method==='put'?express.raw({type:'application/octet-stream'}):express.json();
    app[method](url,auth,guard,parser,asyncRoute(handler as any));
  }
  app.use((error:Error,_req:express.Request,res:express.Response,_next:express.NextFunction)=>res.status(403).json({error:error.message}));
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.closeAllConnections();server.close();await fs.rm(directory,{recursive:true,force:true});});
  return {base:`http://127.0.0.1:${(server.address() as {port:number}).port}`,db,counters,privatePath};
}

for(const trashed of [false,true])test(`actual generic attachment routes cannot read, mutate, retry or delete a teaching original in a ${trashed?'trashed':'live'} course`,async t=>{
  const f=await fixture(t,trashed),specs=[['GET',''],['GET','/content'],['DELETE',''],['PUT','/chunks?offset=0'],['POST','/complete'],['POST','/retry']] as const;
  for(const [method,suffix]of specs){const response=await fetch(`${f.base}/api/attachments/teaching-original${suffix}`,{method,...(method==='PUT'?{headers:{'Content-Type':'application/octet-stream'},body:Buffer.from('OVERWRITE')}:{}),...(method==='POST'?{headers:{'Content-Type':'application/json'},body:'{}'}:{})});assert.ok([403,404,409].includes(response.status),`${method} ${suffix} unexpectedly returned ${response.status}: ${await response.text()}`);assert.equal(response.headers.get('cache-control'),'no-store');}
  assert.equal(f.counters.chunk,0);assert.equal(f.counters.complete,0);assert.equal(f.counters.retry,0);assert.deepEqual(f.counters.removed,[]);assert.equal(f.db.attachments.length,2);assert.equal(await fs.readFile(f.privatePath,'utf8'),'PRIVATE_TEACHING_ORIGINAL');
});

test('the actual general attachment guard preserves ordinary chat upload reads and lifecycle',async t=>{
  const f=await fixture(t);const meta=await fetch(`${f.base}/api/attachments/ordinary-upload`);assert.equal(meta.status,200,await meta.clone().text());assert.equal((await meta.json() as any).attachment.id,'ordinary-upload');
  const content=await fetch(`${f.base}/api/attachments/ordinary-upload/content`);assert.equal(content.status,200);assert.equal(await content.text(),'ORDINARY_CHAT_UPLOAD');
  for(const suffix of ['complete','retry'])assert.equal((await fetch(`${f.base}/api/attachments/ordinary-upload/${suffix}`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,200);
  assert.equal((await fetch(`${f.base}/api/attachments/ordinary-upload/chunks?offset=0`,{method:'PUT',headers:{'Content-Type':'application/octet-stream'},body:Buffer.from('fixture')})).status,200);
  assert.equal((await fetch(`${f.base}/api/attachments/ordinary-upload`,{method:'DELETE'})).status,200);
  assert.equal(f.counters.chunk,1);assert.equal(f.counters.complete,1);assert.equal(f.counters.retry,1);assert.equal(f.counters.removed.length,1);assert.equal(f.db.attachments.length,1);
});
