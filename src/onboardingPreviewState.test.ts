import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createOnboardingPreview,onboardingPreviewReducer as reduce,onboardingPreviewSteps} from './onboardingPreviewState';

test('the effect walkthrough advances and goes back while keeping local choices',()=>{
 let state=createOnboardingPreview('小马');state=reduce(state,{type:'name',value:'一起试试'});
 state=reduce(state,{type:'back'});assert.equal(state.step,0);
 state=reduce(state,{type:'next'});assert.equal(onboardingPreviewSteps[state.step].id,'knowledge');
 state=reduce(state,{type:'toggle-preview'});assert.equal(state.expanded,true);
 state=reduce(state,{type:'next'});assert.equal(state.step,2);assert.equal(state.expanded,false);
 state=reduce(state,{type:'back'});assert.equal(state.step,1);assert.equal(state.name,'一起试试');
 state=reduce(reduce(state,{type:'next'}),{type:'next'});
 state=reduce(state,{type:'purpose',id:'writing'});state=reduce(state,{type:'purpose',id:'files'});state=reduce(state,{type:'purpose',id:'work'});
 assert.deepEqual(state.purposes,['writing','files']);state=reduce(state,{type:'purpose',id:'writing'});state=reduce(state,{type:'purpose',id:'work'});assert.deepEqual(state.purposes,['files','work']);
 state=reduce(reduce(state,{type:'back'}),{type:'next'});assert.deepEqual(state.purposes,['files','work']);assert.equal(state.step,3);
 state=reduce(state,{type:'next'});assert.equal(state.step,3);
});
test('finish only occurs at the end, retracts the demo, and prevents duplicate completion actions',()=>{
 let state=createOnboardingPreview();assert.equal(reduce(state,{type:'finish'}),state);
 for(let index=0;index<3;index++)state=reduce(state,{type:'next'});
 state=reduce(state,{type:'toggle-preview'});state=reduce(state,{type:'complete-demo'});assert.equal(state.demoComplete,true);
 state=reduce(state,{type:'finish'});assert.equal(state.expanded,false);assert.equal(state.ending,true);
 assert.equal(reduce(state,{type:'finish'}),state);assert.equal(reduce(state,{type:'back'}),state);
});
test('the synthetic visual component has no API, profile-save, billing or model dependency',()=>{
 const source=fs.readFileSync(new URL('./StoryOnboardingPreview.tsx',import.meta.url),'utf8');
 assert.doesNotMatch(source,/\bfetch\s*\(|onAction\s*\(|onBegin\s*\(|confirmAction\s*\(|\.writeText\s*\(|window\.open\s*\(/);
 assert.match(source,/FluidSplitWorkspace/);assert.match(source,/type:'back'/);assert.match(source,/onSettled=/);assert.match(source,/不会连接服务或使用电力/);
 const css=fs.readFileSync(new URL('./one-onboarding.css',import.meta.url),'utf8');assert.match(css,/@media\(prefers-reduced-motion:reduce\)\{\.guide-preview/);
});
