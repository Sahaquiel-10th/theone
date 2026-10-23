import {CoordinatorService} from '../server/coordinatorService.js';
import {inputProfile} from '../server/oneContext.js';
import {dispatchFixture,evalScope,evalAnswer} from './eval/dispatchFixture.js';
const f=dispatchFixture();let captured:unknown;
const mode=process.argv.includes('--adaptive')?'adaptive':'legacy';
const service=new CoordinatorService(f.store,{recallWithDiagnostics:async()=>{throw Error('must not read knowledge');}},{contextMode:mode,modelCall:async(_m,messages,tools)=>{
 captured={profile:inputProfile({messages,tools},evalScope.workspaceId),toolNames:tools.map(t=>t.function.name),unrelatedTasks:(JSON.stringify(messages).match(/UNRELATED_TASK_/g)??[]).length};
 return evalAnswer('这里只是输入基线采样，不声称已搜索或交付。');
}});
await service.dispatch(evalScope,{operationId:'baseline_synthetic_20261023',text:'杭州今天天气怎么样？只回答，不要创建任务。'},async()=>{});
console.log(JSON.stringify({baselineCommit:'51ad5ee',mode,scenario:'weather-with-30-unrelated-tasks',providerCalls:0,accountCharged:false,...captured as object}));
