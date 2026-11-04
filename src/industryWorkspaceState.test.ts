import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {decodeIndustryDirectory,emptyIndustryDirectory,encodeIndustryDirectory,filterIndustryWorkspaces,industryDirectoryStorageKey,industryDirectoryTransition,industryWorkspaces,primaryWorkspaceNavigation} from './industryWorkspaceState';

test('both application shells share the required five destinations while Skills keeps its feature identity',()=>{
  assert.deepEqual(primaryWorkspaceNavigation.map(item=>[item.id,item.label]),[['chat','主页'],['things','任务'],['features','Skills'],['workbenches','行业工作台'],['avatars','分身']]);
  const main=fs.readFileSync(new URL('./main.tsx',import.meta.url),'utf8');assert.equal((main.match(/primaryWorkspaceNavigation.map/g)||[]).length,2);assert.match(main,/visitedLayers.includes\('workbenches'\)/);assert.match(main,/workLayer==='features'/);
});
test('the industry directory holds exactly the four real workflows in their industries',()=>{
  assert.deepEqual(filterIndustryWorkspaces('','teaching').map(item=>item.id),['teaching']);
  assert.deepEqual(filterIndustryWorkspaces('','commerce').map(item=>item.id),['product_creative','image_edit','review_reply']);
  assert.deepEqual(filterIndustryWorkspaces('商品 主图','all').map(item=>item.id),['product_creative']);assert.deepEqual(filterIndustryWorkspaces('完全不匹配','all'),[]);
});
test('opening and returning preserves the directory filter without any execution state or model operation',()=>{
  const state={...emptyIndustryDirectory(),query:'图片',category:'commerce' as const},original=structuredClone(state);
  const opened=industryDirectoryTransition(state,{type:'open',workspace:'image_edit'});assert.equal(opened.workspace,'image_edit');assert.deepEqual(industryDirectoryTransition(opened,{type:'back'}),state);assert.deepEqual(state,original);
  assert.deepEqual(Object.keys(opened).sort(),['category','query','workspace']);assert.equal(industryDirectoryTransition(opened,{type:'category',category:'teaching'}).workspace,null);
});
test('restored industry position is account/workspace scoped and validates destinations',()=>{
  const state={...emptyIndustryDirectory(),workspace:'review_reply' as const,category:'commerce' as const};const encoded=encodeIndustryDirectory(state,'user-a:workspace-a');
  assert.deepEqual(decodeIndustryDirectory(encoded,'user-a:workspace-a'),state);assert.deepEqual(decodeIndustryDirectory(encoded,'user-b:workspace-a'),emptyIndustryDirectory());assert.deepEqual(decodeIndustryDirectory(encoded,'user-a:workspace-b'),emptyIndustryDirectory());
  assert.deepEqual(decodeIndustryDirectory('{broken','owner'),emptyIndustryDirectory());assert.deepEqual(decodeIndustryDirectory(JSON.stringify({scopeKey:'owner',state:{...state,workspace:'arbitrary-api'}}),'owner'),emptyIndustryDirectory());
  assert.notEqual(industryDirectoryStorageKey('a:b'),industryDirectoryStorageKey('a%3Ab'));
});
test('industry workflows never enter composer selection and both Skills catalogs exclude teacher workspaces',()=>{
  const industry=fs.readFileSync(new URL('./IndustryWorkspaces.tsx',import.meta.url),'utf8');
  assert.doesNotMatch(industry,/featureForNext|onChoose|FeatureChoice|\/api\/features|method:['"]POST/);assert.match(industry,/<TeachingWorkspace api=\{api\}/);assert.match(industry,/renderCommerce\(kind,back\)/);
  for(const path of ['./preview/FeatureShelf.tsx','./FeatureMarketplace.tsx']){const text=fs.readFileSync(new URL(path,import.meta.url),'utf8');assert.doesNotMatch(text,/TeachingEntry|TeachingWorkspace|teachingOpen|matchesTeachingEntry/);assert.match(text,/onChoose/);}
  const shelf=fs.readFileSync(new URL('./preview/FeatureShelf.tsx',import.meta.url),'utf8');assert.match(shelf,/<FeatureLaunch[^>]* selectionOnly/);
  assert.equal(new Set(industryWorkspaces.map(entry=>entry.id)).size,4);
});


test('legacy chat binds chosen Skills and price approvals to the durable payload and clears only its successful batch',()=>{
  const main=fs.readFileSync(new URL('./main.tsx',import.meta.url),'utf8');
  const fallback=main.slice(main.indexOf('    let operationId = "";',main.indexOf('async function sendMessage')),main.indexOf('  async function send(event: FormEvent)'));
  assert.match(fallback,/featureIds:features.map\(feature=>feature.id\),featureApprovals,confirmedExternal/);
  assert.match(fallback,/operationId = await chatSubmission\(user.id, payload\)/);
  assert.match(fallback,/approveFeaturePrices\(api,features.map\(feature=>feature.id\)\)/);
  const receipt=fallback.indexOf('forgetChatSubmission(user.id, operationId)');const clear=fallback.indexOf('setFeatureForNext(current=>current.filter(feature=>!features.some(sent=>sent.id===feature.id)))');assert.ok(receipt>=0&&clear>receipt);
  assert.match(fallback,/if\(features.length>1\).*return false/);
  assert.match(fallback,/if\(currentModel\?\.kind==='image'\).*return false/);
  assert.match(fallback,/if\(featureSelectionVersion.current===selectionVersion\)setFeatureForNext/);
});
