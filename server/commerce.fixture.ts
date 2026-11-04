import type { Store } from './db.js';
import type { Attachment, Database, ModelConfig } from './types.js';
import { createIndustryUsageSession, IndustryStore, type IndustryActor } from './industryState.js';
import type { IndustryModelInput, IndustryModelRunner } from './industryModel.js';
import { COMMERCE_CONVERSATION_ID, CommerceService } from './commerce.js';
import { defaultCommerceBrief } from './commerceTypes.js';

export const commerceOwner: IndustryActor = { id:'commerce-owner',workspaceId:'commerce-workspace-a' };
export const commercePeer: IndustryActor = { id:'commerce-peer',workspaceId:commerceOwner.workspaceId };
export const commerceOther: IndustryActor = { id:commerceOwner.id,workspaceId:'commerce-workspace-b' };
export function commerceFixture() {
  const at=new Date().toISOString();
  const model:ModelConfig={id:'fixture-chat',name:'Fixture',provider:'synthetic',kind:'chat',protocol:'openai',baseUrl:'https://never-used.invalid',apiKey:'SYNTHETIC_NOT_SENT',model:'fixture',systemPrompt:'',enabled:true,isDefault:true,inputPowerPerMillion:1,outputPowerPerMillion:1,costInputPowerPerMillion:1,costOutputPowerPerMillion:1,createdAt:at};
  const image={...model,id:'fixture-image',kind:'image' as const,imagePowerPerCall:1,costImagePowerPerCall:0};
  const published={modelId:image.id,prompt:'',tools:[],maxSteps:1,version:1,publishedAt:at,publishedBy:commerceOwner.id};
  let db={users:[commerceOwner,commercePeer].map(u=>({id:u.id,username:u.id,passwordHash:'',enabled:true,role:'user',defaultWorkspaceId:u.workspaceId,createdAt:at})),workspaces:[commerceOwner.workspaceId,commerceOther.workspaceId].map(id=>({id,status:'active',name:id,slug:id,createdAt:at,updatedAt:at})),workspaceMembers:[commerceOwner,commercePeer,commerceOther].map((u,i)=>({id:`member-${i}`,workspaceId:u.workspaceId,userId:u.id,role:'owner',createdAt:at})),models:[model,image],agents:[],conversations:[],attachments:[],modelUsageRecords:[],settings:{safetyRules:'Only authorized data',rechargeCnyPerPower:7,aiTasks:{image_generation:{revision:1,draft:published,published,history:[]}}}} as unknown as Database;
  let tail:Promise<unknown>=Promise.resolve();
  const base:Store={read:async()=>db,mutate:<T>(fn:(db:Database)=>T)=>{const next=tail.then(()=>{const before=structuredClone(db);try{return fn(db);}catch(error){db=before;throw error;}});tail=next.catch(()=>undefined);return next;}};
  const store=new IndustryStore(base);
  const asset=(id:string,owner=commerceOwner):Attachment=>({id,workspaceId:owner.workspaceId,userId:owner.id,originalName:`${id}.png`,mimeType:'image/png',kind:'image',size:10,storagePath:'/unused',status:'ready',conversationId:COMMERCE_CONVERSATION_ID,extractedText:'',createdAt:at});
  db.attachments.push(...['product','ref-a','ref-b','detail','sku-a','sku-b','gift'].map(id=>asset(id)),asset('peer-image',commercePeer),asset('other-workspace-image',commerceOther));
  const mainSession=createIndustryUsageSession(db,commerceOwner,{confirmed:true,requestKey:'fixture-main-session-0001',tool:'product_creative',budgetMicros:100_000_000});
  const editSession=createIndustryUsageSession(db,commerceOwner,{confirmed:true,requestKey:'fixture-edit-session-0001',tool:'image_edit',budgetMicros:100_000_000});
  const calls:IndustryModelInput[]=[];
  const plan=JSON.stringify({summary:'比较两个方向',variants:Array.from({length:4},(_,i)=>({name:`方向${i+1}`,reason:'比较构图',headline:'保湿护理',subline:'',imagePrompt:`composition ${i}`,title:`品牌身体乳保湿${'甲乙丙丁'[i]}`,titleReason:'确认的商品关键词'}))});
  const runModel:IndustryModelRunner=async(scope,input)=>{
    input.verify(await store.read());
    if(scope.workspaceId!==commerceOwner.workspaceId||scope.userId!==commerceOwner.id)throw Error('unexpected scope');
    calls.push(structuredClone({...input,verify:undefined,beforeReserve:undefined}) as unknown as IndustryModelInput);
    if(input.kind==='image')return {content:'',imageUrl:'data:synthetic'};
    const prompt=input.messages[0].content;
    if(prompt.startsWith('根据商品资料'))return {content:plan};
    if(prompt.startsWith('检查最后'))return {content:'{"passed":true,"note":"synthetic inspection"}'};
    if(prompt.startsWith('只识别')||prompt.startsWith('你是电商商品资料'))return {content:'{"productName":"身体乳","brand":"品牌","specification":"250g","facts":["保湿"],"keywords":["身体乳"],"note":"请核对"}'};
    return {content:'synthetic analysis'};
  };
  const dependencies={runModel,readImages:async(items:Attachment[])=>items.map(a=>a.id),saveImage:async(_url:string,job:{id:string;taskType?:string},variant:{id:string;outputWidth?:number;outputHeight?:number})=>{variant.outputWidth=1440;variant.outputHeight=job.taskType==='portrait'?1920:1440;return asset(`result-${job.id}-${variant.id}-${calls.length}`);}};
  const brief={...defaultCommerceBrief(),productImageIds:['product'],referenceImageIds:['ref-a','ref-b'],brand:'品牌',productName:'身体乳',facts:['保湿'],keywords:['身体乳'],count:4};
  const current=async(id:string)=>(await store.read()).commerceJobs.find(j=>j.id===id)!;
  const idle=async(id:string)=>{for(let i=0;i<300;i++){const j=await current(id);if(!['planning','queued','generating'].includes(j.status)){await new Promise(r=>setTimeout(r,0));return j;}await new Promise(r=>setTimeout(r,5));}throw Error('synthetic commerce task did not finish');};
  return {get db(){return db;},base,store,asset,mainSession,editSession,calls,dependencies,brief,current,idle,service:new CommerceService(store,dependencies)};
}
