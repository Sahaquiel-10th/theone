import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {FeatureRelease} from './FeatureRelease';

test('admin publication explains all-user access without account checklists',()=>{
  const html=renderToStaticMarkup(createElement(FeatureRelease,{api:async()=>({}) as any,record:{id:'test',revision:1,status:'approved',draft:{},current:{version:1},history:[],release:{version:1,userIds:['legacy-admin']}} as any,disabled:false,onChanged:async()=>{}}));
  assert.match(html,/所有用户/);assert.match(html,/之后的新用户/);assert.match(html,/分别授权/);
  assert.doesNotMatch(html,/checkbox|内测账号|搜索账号|所选账号/);
});

test('company-private definitions never offer an all-user publication button',()=>{
  const html=renderToStaticMarkup(createElement(FeatureRelease,{api:async()=>({}) as any,record:{id:'private',workspaceId:'company-a',revision:1,status:'approved',draft:{},current:{version:1},history:[]} as any,disabled:false,onChanged:async()=>{}}));
  assert.match(html,/公司私有功能/);assert.doesNotMatch(html,/所有用户|<button/);
});
