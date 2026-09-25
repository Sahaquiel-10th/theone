import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const exec=promisify(execFile);
test("public records survive a real JSON-store restart and incomplete tasks are not retried",async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),"one-sharing-recovery-"));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const env={...process.env,DB_PROVIDER:"json",ONE_DATA_DIR:directory,ADMIN_INITIAL_PASSWORD:"isolated-fixture-password",YYLX_API_KEY:"",NODE_ENV:"test"};
  const run=async(code:string)=>(await exec(process.execPath,["--import","tsx","--input-type=module","-e",code],{env})).stdout;
  await run(`const {store}=await import('./server/db.ts');await store.mutate(db=>{db.publications.push({id:'pub',workspaceId:db.workspaces[0].id,userId:db.users[0].id,status:'active'});db.publicSessions.push({id:'guest',workspaceId:db.workspaces[0].id,userId:'guest',publicationId:'pub',tokenHash:'not-a-token'});db.publicRuns.push({id:'run',workspaceId:db.workspaces[0].id,userId:'guest',sessionId:'guest',publicationId:'pub',status:'running',content:'PRIVATE_QUESTION',attachmentIds:[]});});`);
  const result=JSON.parse(await run(`const {store}=await import('./server/db.ts');const d=await store.read();console.log(JSON.stringify({publications:d.publications.length,sessions:d.publicSessions.length,run:d.publicRuns[0],calls:d.modelUsageRecords.length}));`));
  assert.equal(result.publications,1);assert.equal(result.sessions,1);assert.equal(result.run.status,"interrupted");assert.equal(result.calls,0);assert.equal(result.run.content,"PRIVATE_QUESTION");assert.ok(result.run.completedAt);
});
