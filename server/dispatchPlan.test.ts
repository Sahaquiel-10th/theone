import test from 'node:test';
import assert from 'node:assert/strict';
import {validateDispatchPlan,parseTaskOutcome,isImageInstruction} from './dispatchPlan.js';
const task={taskId:null,title:'方案',instruction:'做方案',executorId:'logic',outputKind:'text',featureIds:[],dependsOn:[]};
test('batch plans preserve independent tasks and reject cyclic or duplicate-task instructions',()=>{
  assert.equal(validateDispatchPlan({tasks:[task,{...task,title:'配图',outputKind:'image',dependsOn:[0]}]}).tasks.length,2);
  assert.throws(()=>validateDispatchPlan({tasks:[{...task,dependsOn:[0]}]}));
  assert.throws(()=>validateDispatchPlan({tasks:[{...task,taskId:'same'},{...task,taskId:'same'}]}));
  assert.throws(()=>validateDispatchPlan({tasks:Array(5).fill(task)}));
});
test('legacy refusal is a returned answer, never a fabricated successful deliverable',()=>{
  assert.equal(parseTaskOutcome('当前没有绘图工具，无法生成图片').outcome,'returned');
  assert.equal(parseTaskOutcome(JSON.stringify({outcome:'needs_input',content:'请补充目标',summary:'缺少目标'})).outcome,'needs_input');
  assert.equal(isImageInstruction('绘制奥特曼大战孙悟空'),true);assert.equal(isImageInstruction('绘制表格'),false);
});
