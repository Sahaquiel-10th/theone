import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {continueFeaturePicker,featurePickerKeyAction} from './composerFeaturePickerState';
import {featureMention} from './noviceUx';

test('a selection consumes only the mention and keeps the session and filter open for more choices',()=>{
 const text='请用 @周报 整理本周工作',picker={query:'周报',mention:featureMention(text,6)};
 const first=continueFeaturePicker(picker,text);assert.equal(first.text,'请用  整理本周工作');assert.deepEqual(first.picker,{query:'周报',mention:null});
 const second=continueFeaturePicker(first.picker,first.text);assert.equal(second.text,first.text);assert.deepEqual(second.picker,first.picker);
});
test('newer drafts and an ordinary search session cannot be overwritten when selecting',()=>{
 const mention=featureMention('请用 @周报 整理本周工作',6),newer='后来改成了另一条要求';
 assert.equal(continueFeaturePicker({query:'周报',mention},newer).text,newer);
 assert.equal(continueFeaturePicker({query:'办公',mention:null},'正文还在').text,'正文还在');
});
test('IME and Shift Enter retain ordinary typing, while a visible picker consumes selection keys',()=>{
 for(const key of ['Enter','ArrowDown','ArrowUp','Escape'])assert.equal(featurePickerKeyAction({open:true,key,composing:true}),null);
 assert.equal(featurePickerKeyAction({open:false,key:'Enter'}),null);assert.equal(featurePickerKeyAction({open:true,key:'Enter',shiftKey:true}),null);
 assert.equal(featurePickerKeyAction({open:true,key:'Enter'}),'choose');assert.equal(featurePickerKeyAction({open:true,key:'Escape'}),'close');assert.equal(featurePickerKeyAction({open:true,key:'ArrowDown'}),'next');assert.equal(featurePickerKeyAction({open:true,key:'ArrowUp'}),'previous');
});
test('the persistent armed rim pauses when hidden and becomes static with reduced motion',()=>{
 const css=fs.readFileSync(new URL('./feature-handoff.css',import.meta.url),'utf8'),component=fs.readFileSync(new URL('./FeatureHandoff.tsx',import.meta.url),'utf8');
 assert.match(css,/data-feature-armed="true"/);assert.match(css,/data-page-visible="false"[^}]*feature-rim-flow\{animation-play-state:paused/);
 assert.match(css,/@media\(prefers-reduced-motion:reduce\)/);assert.match(css,/feature-rim-flow\{display:none;animation:none/);
 assert.doesNotMatch(component.slice(component.indexOf('export function FeatureArmedRim')),/requestAnimationFrame|setInterval|setTimeout/);
});
