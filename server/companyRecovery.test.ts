import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
test('company metadata, permissions and bank credit survive real JSON-store restart without minting employee balances',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'one-company-recovery-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const env={...process.env,DB_PROVIDER:'json',ONE_DATA_DIR:directory,ADMIN_INITIAL_PASSWORD:'isolated-company-fixture',YYLX_API_KEY:'',NODE_ENV:'test'};
  const run=async(code:string)=>(await exec(process.execPath,['--import','tsx','--input-type=module','-e',code],{env,timeout:120000})).stdout;
  await run(`const {store}=await import('./server/db.ts');const {createCompany,addCompanyMember,recordBankTransfer}=await import('./server/companyService.ts');await store.mutate(db=>{const actor=db.users[0].id;const {company,owner}=createCompany(db,actor,{name:'Recovery Co',agreementRef:'contract',ownerUsername:'owner'});addCompanyMember(db,{workspaceId:company.id,userId:owner.id},{username:'employee'});recordBankTransfer(db,{workspaceId:company.id,userId:actor},{bankReference:'bank-recovery',amountFen:100,amountMicros:123456,confirmed:true});});`);
  const result=JSON.parse(await run(`const {store}=await import('./server/db.ts');const db=await store.read();const company=db.workspaces.find(w=>w.kind==='company');console.log(JSON.stringify({company,members:db.workspaceMembers.filter(m=>m.workspaceId===company.id),accounts:db.powerAccounts.filter(a=>a.workspaceId===company.id),ledger:db.powerLedger.filter(r=>r.workspaceId===company.id),payments:db.rechargeOrders.filter(r=>r.workspaceId===company.id)}));`));
  assert.equal(result.company.company.agreementRef,'contract');assert.equal(result.members.length,2);assert.deepEqual(result.members[1].permissions,{knowledgeConnectionIds:[],featureIds:[]});
  assert.equal(result.accounts.length,1);assert.equal(result.accounts[0].userId,`company:${result.company.id}`);assert.equal(result.accounts[0].balanceMicros,123456);
  assert.equal(result.ledger.length,1);assert.equal(result.payments[0].corporatePayment.bankReference,'bank-recovery');
});
