import 'dotenv/config';
import mysql from 'mysql2/promise';
import {decryptCredential} from '../server/knowledge/credentialCipher.js';
import {callModelWithTools} from '../server/modelGateway.js';
import {compileOneContext} from '../server/oneContext.js';
import {effectiveModel} from '../server/modelPricing.js';
import {calculateModelPower} from '../server/powerBilling.js';
import type {ModelConfig} from '../server/types.js';

/** Explicit diagnostic: two synthetic public-text calls, no account/knowledge
 * reads, no production ledger writes, and no automatic retry or raw errors. */
async function main(){
 if(!process.argv.includes('--run-two-public-calls')||process.env.DB_PROVIDER!=='mysql')throw Error('explicit mysql probe required');
 const db=await mysql.createConnection({host:process.env.MYSQL_HOST,port:Number(process.env.MYSQL_PORT??3306),user:process.env.MYSQL_USER,password:process.env.MYSQL_PASSWORD,database:process.env.MYSQL_DATABASE,charset:'utf8mb4'});
 let model:ModelConfig;
 try{
  const [settings]=await db.query<mysql.RowDataPacket[]>("SELECT JSON_UNQUOTE(JSON_EXTRACT(record_json,'$.aiTasks.coordinator.published.modelId')) AS modelId FROM system_settings WHERE id='main' LIMIT 1");
  const id=settings[0]?.modelId;if(typeof id!=='string'||!id)throw Error('no configured coordinator');
  const [rows]=await db.execute<mysql.RowDataPacket[]>('SELECT record_json FROM models WHERE id=? LIMIT 1',[id]);
  const data=rows[0]?.record_json;model=typeof data==='string'?JSON.parse(data):data;
  if(!model?.enabled||model.protocol!=='anthropic'||model.kind!=='chat')throw Error('no native anthropic coordinator');
  model={...effectiveModel(model),systemPrompt:'',apiKey:model.encryptedApiKey?decryptCredential(model.encryptedApiKey):model.apiKey};
 }finally{await db.end();}
 const prefix='Public synthetic caching fixture. This is test data, not personal information. Reply ONE_CACHE_OK only.\n'+Array.from({length:480},(_,i)=>`Public sample ${i}: A small team prepares an agenda, checks arithmetic, and reviews the finished document. No private sources are involved.`).join('\n');
 const results=[];
 for(let i=0;i<2;i++){
  const result=await callModelWithTools(model,compileOneContext([{role:'system',cacheScope:'stable',content:prefix},{role:'system',content:`Synthetic reference day: 2026-10-${22+i}`},{role:'user',content:'Reply ONE_CACHE_OK only.'}]),[],'public-context-cache-probe',{maxOutputTokens:64,timeoutMs:60000});
  const usage=result.usage;if(!usage)throw Error('missing usage');
  results.push({call:i+1,marker:result.content.trim()==='ONE_CACHE_OK',finishReason:result.finishReason,inputTokens:usage.inputTokens,outputTokens:usage.outputTokens,cache:usage.cacheUsage,retailEquivalentMicros:calculateModelPower(model,usage.inputTokens,usage.outputTokens,usage.cacheUsage).chargedMicros});
 }
 const passed=results.every(r=>r.marker&&r.finishReason==='stop')&&(results[1].cache?.read??0)>0;
 console.log(JSON.stringify({probe:'stable-prefix-two-public-calls',passed,results,accountCharged:false}));if(!passed)process.exitCode=1;
}
main().catch(()=>{console.error('Public context-cache probe did not pass. No automatic retry, account changes, credential or provider-body output.');process.exitCode=1;});
