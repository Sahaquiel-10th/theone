import test from 'node:test';
import assert from 'node:assert/strict';
import {createEyeMotion} from './interruptibleEye';

test('eye transitions update immediately and redirect from the current decorative position',()=>{
 const oldDocument=globalThis.document,oldWindow=globalThis.window;
 const frames:Keyframe[][]=[],removed:number[]=[];let position=0,cloneNumber=0;
 const box=(left:number)=>({left,top:20,width:50,height:50});
 const style=()=>({removeProperty:()=>{}});
 const node:any={style:style(),getBoundingClientRect:()=>box(position),animate:()=>{},closest:()=>({append:()=>{}}),cloneNode:()=>{
  const number=++cloneNumber;
  return {style:style(),removeAttribute:()=>{},querySelectorAll:()=>[],setAttribute:()=>{},getBoundingClientRect:()=>box(37),remove:()=>removed.push(number),animate:(value:Keyframe[])=>{frames.push(value);return{cancel:()=>{},finished:new Promise(()=>{})};}};
 }};
 globalThis.document={querySelectorAll:()=>[node]} as any;
 globalThis.window={matchMedia:()=>({matches:false}),innerWidth:1200} as any;
 try{
  const motion=createEyeMotion();
  motion.move(()=>{position=200;},'direct',420);
  assert.equal(position,200,'navigation is synchronous');
  motion.move(()=>{position=600;},'direct',420);
  assert.equal(position,600);assert.match(String(frames[1][0].transform),/translate\(37px/);
  assert.deepEqual(removed,[1]);motion.clear();assert.deepEqual(removed,[1,2]);
 }finally{globalThis.document=oldDocument;globalThis.window=oldWindow;}
});
