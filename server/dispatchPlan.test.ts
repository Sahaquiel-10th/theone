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
test('duplicate prose followed by its result envelope is unwrapped, not exposed as raw JSON',()=>{
 const body='文章已读到。\n\n正文和结尾都在。';
 const envelope=JSON.stringify({outcome:'completed',content:body,summary:'已只读核对'});
 assert.deepEqual(parseTaskOutcome(body+'\n\n'+envelope),{outcome:'completed',content:body,summary:'已只读核对'});
 assert.equal(parseTaskOutcome('这里讲一个 JSON 示例：\n'+envelope).outcome,'returned');
 assert.equal(parseTaskOutcome(body+'\n'+JSON.stringify({outcome:'failed',content:'不同内容',summary:'示例'})).outcome,'returned');
});
test('direct execution accepts only reviewed visual documents, not arbitrary tools, scripts or hidden scope',()=>{
  const scene={id:'first',title:'说明',situation:'使用场景',feature:'整理内容',advantage:'省去排版',benefit:'清楚说明',evidence:'查看结果',steps:['整理','查看'],prompt:'整理说明',capabilityIds:[]};
  const direct={tool:'oneHtml',document:{version:1,title:'说明',intro:'合成说明',scenes:[scene,{...scene,id:'second'}]}};
  assert.equal(validateDispatchPlan({tasks:[{...task,executorId:'direct',direct,requiredTools:['oneHtml']}]}).tasks[0].direct!.tool,'oneHtml');
  for(const changed of [{...direct,tool:'run_command'},{...direct,workspaceId:'foreign'},{...direct,document:{...direct.document,script:'malicious'}}])assert.throws(()=>validateDispatchPlan({tasks:[{...task,direct:changed}]}));
  assert.throws(()=>validateDispatchPlan({tasks:[{...task,direct,knowledge:'all'}]}));
  assert.throws(()=>validateDispatchPlan({tasks:[{...task,requiredTools:['oneHtml','oneHtml']}]}));
});
