import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import express from 'express';
import { once } from 'node:events';
import { importSkill } from './skillImport.js';
import { installOfficialFeatureRoutes } from './officialFeatureRoutes.js';
import { featureValues, updateOfficialFeature } from './officialFeatures.js';
import type { SystemSettings } from './types.js';
import type { Store } from './db.js';

const skill = '---\nname: weekly-report\ndescription: >\n  汇总本周进展\n  并列出下周计划\n---\n# 周报\n根据用户提供的资料整理，不编造进度。';
async function pack(files: Record<string,string>) { const zip = new JSZip(); for(const [p,s] of Object.entries(files))zip.file(p,s);return zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'}); }
test('Markdown and ZIP preserve instructions, references and attribution without granting tools',async()=>{
  const md = await importSkill(Buffer.from(skill),'SKILL.md');
  assert.equal(md.description,'汇总本周进展 并列出下周计划');
  const result = await importSkill(await pack({'weekly/SKILL.md':skill,'weekly/references/template.md':'先列结论，再列行动','LICENSE.txt':'Test license'}),'weekly.zip');
  assert.match(result.instructions,/先列结论，再列行动/);assert.match(result.skillAttribution,/Test license/);
  assert.deepEqual(result.files,['weekly/SKILL.md','weekly/references/template.md','LICENSE.txt']);
});
test('imported attribution survives configuration validation and version storage',async()=>{
  const {name,description,instructions,skillAttribution}=await importSkill(await pack({'SKILL.md':skill,'LICENSE':'Test copyright and license'}),'skill.zip');
  const values=featureValues({name,description,instructions,skillAttribution,author:'Test',limitations:'仅本人提供的资料',integration:'question_answer'});
  assert.match(values.skillAttribution!,/Test copyright/);assert.equal(values.tools,undefined);
  const settings:SystemSettings={safetyRules:'safe',rechargeCnyPerPower:7};
  updateOfficialFeature(settings,'weekly-report',{revision:0,action:'save',values},'admin','t1');
  updateOfficialFeature(settings,'weekly-report',{revision:1,action:'approve',confirmed:true,evidence:'完成测试并核对公开许可，仅认定测试版本，尚未上架。'},'admin','t2');
  updateOfficialFeature(settings,'weekly-report',{revision:2,action:'save',values:{...values,skillAttribution:'new attribution'}},'admin','t3');
  assert.match(settings.officialFeatures![0].current!.values.skillAttribution!,/Test copyright/);
});
test('unsafe paths, scripts, multiple skills, invalid UTF-8 and decompression bombs fail explicitly',async()=>{
  const bad:Record<string,string>[]=[{'../SKILL.md':skill},{'SKILL.md':skill,'scripts/run.py':'print(1)'},{'a/SKILL.md':skill,'b/SKILL.md':skill},{'SKILL.md':skill,'references/huge.md':'x'.repeat(129*1024)}];
  for(const files of bad)await assert.rejects(importSkill(await pack(files),'skill.zip'));
  await assert.rejects(importSkill(Buffer.from([0xff]),'skill.md'));
  await assert.rejects(importSkill(Buffer.from('# a\n'+'x'.repeat(12001)),'skill.md'),/12000/);
  await assert.rejects(importSkill(Buffer.from(skill),'skill.tar'));
});
test('HTTP import is admin and Key protected, request-local and never persists or publishes',async t=>{
  let writes=0;
  const store={mutate:async()=>{writes++;throw new Error('must not persist');}} as unknown as Store;
  const app=express();installOfficialFeatureRoutes(app,[(req,res,next)=>{if(req.headers['x-key']!=='present'){res.sendStatus(428);return;}if(req.headers['x-role']!=='admin'){res.sendStatus(403);return;}next();}],store);
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
  const url=`http://127.0.0.1:${(server.address() as any).port}/api/admin/official-features/import`;
  const body=()=>{const f=new FormData();f.append('file',new Blob([skill]),'SKILL.md');return f;};
  assert.equal((await fetch(url,{method:'POST',body:body()})).status,428);
  assert.equal((await fetch(url,{method:'POST',headers:{'x-key':'present','x-role':'user','x-workspace':'other'},body:body()})).status,403);
  const response=await fetch(url,{method:'POST',headers:{'x-key':'present','x-role':'admin'},body:body()});assert.equal(response.status,200);assert.equal((await response.json()).name,'weekly-report');
  const oversized=new FormData();oversized.append('file',new Blob([Buffer.alloc(2*1024*1024+1)]),'large.md');
  assert.equal((await fetch(url,{method:'POST',headers:{'x-key':'present','x-role':'admin'},body:oversized})).status,400);
  assert.equal(writes,0);
});
