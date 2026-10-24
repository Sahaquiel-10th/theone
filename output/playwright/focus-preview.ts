// Local visual fixture only. All API calls are intercepted; no keys, models or production data.
const stamp=new Date().toISOString();
const profile:any={workspaceId:'preview',displayName:'小马',onboarding:{completedAt:stamp,knowledgeChoice:'skipped'},updatedAt:stamp};
const profileStorageKey='one-focus-preview-profile:v1:preview:preview';
try{const saved=JSON.parse(localStorage.getItem(profileStorageKey)||'null');if(saved?.appearance?.scene==='silver'||saved?.appearance?.scene==='graphite')profile.appearance={scene:saved.appearance.scene};if(typeof saved?.displayName==='string'&&saved.displayName.trim())profile.displayName=saved.displayName.trim().slice(0,40);}catch{/* Private browser storage is optional. */}
const user={id:'preview',username:'preview',role:'user',enabled:true,defaultWorkspaceId:'preview',createdAt:stamp,profile};
const conversations:any[]=[],operations=new Map<string,any>();
// Opt-in density regression dataset; never allow this mode to reach a real API.
const densityQA = new URLSearchParams(location.search).get('densityQA') === '1';
const workflowPreview = densityQA || new URLSearchParams(location.search).has('workflowPreview');
const transferPreview = new URLSearchParams(location.search).has('transferPreview')||workflowPreview;
const designStudy = densityQA || new URLSearchParams(location.search).has('designStudy');
const richPreview = densityQA || new URLSearchParams(location.search).has('richPreview');
const realService = !densityQA && new URLSearchParams(location.search).get('realService')==='1';
const transferDelay = Math.min(60000, Math.max(4500, Number(new URLSearchParams(location.search).get('taskDelay')) || 4500));
const localRuns:any[]=[], transferNotices:any[]=[], coordinatorMessages:any[]=[];
if(new URLSearchParams(location.search).has('historyPreview'))coordinatorMessages.push({id:'prior-user',role:'user',content:'之前的核心对话',createdAt:stamp},{id:'prior-reply',role:'assistant',content:'之前的核心回答',createdAt:stamp});
// A rich, deterministic reading fixture to inspect local contour wrapping.
if(new URLSearchParams(location.search).has('flowPreview')){
 coordinatorMessages.length=0;
 coordinatorMessages.push({id:'flow-user',role:'user',content:'帮我把这份项目想法整理一下。任务可以同时推进，我想继续在这里讨论。',createdAt:stamp});
 const paragraphs=[
  '可以。我们先把最重要的目标留在主对话里：让第一次使用 AI 的人，也能清楚地知道自己可以做什么、现在发生了什么，以及接下来如何继续。右侧的任务只占用它当下需要的位置，其他空间仍然属于这段对话。',
  '比如，资料整理交出去以后，你仍然可以在这里补充想法。上方任务展开时，只让出上方的一部分；下方没有本机执行，阅读和输入就继续使用下方的完整宽度。',
  '当本机开始执行，输入框会随着下方边界收短，上方的对话仍然展开。任务完成并收回以后，刚才让出的空间自然回到主页面。这样，任务的出现与离开，都像是同一个工作空间在呼吸。',
  '主对话始终保留上下文。你可以继续写下一句话，也可以稍后再查看结果。我们会把需要你处理的事项保留在任务列表里，让你按自己的节奏继续。',
 ];
 coordinatorMessages.push({id:'flow-reply',role:'assistant',content:(new URLSearchParams(location.search).has('longFlow')?Array.from({length:8},()=>paragraphs).flat():paragraphs).join('\n\n'),createdAt:stamp});
}
if(designStudy){
 coordinatorMessages.length=0;
 if(!new URLSearchParams(location.search).has('emptyPreview'))coordinatorMessages.push(
  {id:'study-user-1',role:'user',content:'我们继续整理 ONE 的改版方向吧。主对话保持在这里，任务交出去以后，我还想接着聊。',createdAt:stamp},
  {id:'study-reply-1',role:'assistant',content:'## 先把这段对话留在这里\n\n主对话是你一直在使用的工作区。任务需要注意时，从这里分出去；看完以后再融回来。\n\n- **主对话**：继续讨论、补充想法，保留上下文。\n- **任务与成果**：有进展再出现，需要时展开细看。\n- **这台电脑**：开始本机操作时，画面从操作位置进入执行态。\n\n你的原话会保留在右侧气泡里，便于回头找到。',createdAt:stamp},
  {id:'study-user-2',role:'user',content:'对，就是这个感觉。\n另外，方案里的 **这一段原话** 请保留，不要和回复混在一起。代码和对照表也想看看。',createdAt:stamp},
  {id:'study-reply-2',role:'assistant',content:'### 这次先看阅读和层次\n\n**你的消息独立呈现，ONE 的回答按内容展开。** 标题、清单和正文有各自的节奏，打开任务时，阅读区仍然沿着主泡泡的轮廓使用空间。\n\n| 内容 | 呈现方式 |\n| --- | --- |\n| 你的原话 | 右侧对话气泡，保留换行 |\n| ONE 的回复 | 标题、列表与清晰的正文 |\n| 代码或配置 | 独立代码块，可以复制 |\n\n需要复制配置时，会单独呈现：\n\n```json\n{\n  "主对话": "一直保留",\n  "任务动态": "需要时展开",\n  "本机执行": "从操作位置进入执行态"\n}\n```\n\n> 你可以继续在这里聊。任务的变化会出现在旁边。',createdAt:stamp}
 );
}
const fixtureFiles=new Map<string,any>();
if(richPreview){
 const ready={id:'fixture-plan',originalName:'ONE 改版计划.md',kind:'text',mimeType:'text/markdown',size:1824,status:'ready'};
 const failed={id:'fixture-unread',originalName:'扫描资料.pdf',kind:'document',mimeType:'application/pdf',size:4096,status:'failed',parseError:'合成演示：扫描文件未获得可读文字，请换一份有文字层的文件。'};
 fixtureFiles.set(ready.id,{...ready,content:'# ONE 改版计划\n\n这是本地合成下载，没有读取或写入真实文件。\n\n- 保留主对话\n- 任务从主泡泡分裂\n- 使用石墨框景作为默认外观\n'});fixtureFiles.set(failed.id,failed);
 coordinatorMessages.push({id:'rich-user',role:'user',content:'请根据项目资料整理接入重点，并告诉我哪些附件还没读到。',attachments:[ready,failed],createdAt:stamp},{id:'rich-answer',role:'assistant',content:'## 接入重点\n\n主对话保持当前位置，任务详情在宽面板内展开。配置和成果沿用现有权限，再统一外观与返回路径。\n\n1. **先连接真实状态**：任务、成果和本机执行分别保留自己的身份。\n2. **再核对功能完整性**：快捷选择、独立运行、分身配置和工具连接都可找回。\n3. **保留边界提示**：这一份扫描资料没有读到文字，不能把它当作已经参考。\n\n```ts\nconst workspace = { mainConversation: "stable", scene: "graphite" };\n```',sources:[{title:'ONE 项目说明（合成来源）',url:'https://example.com/one/project',snippet:'主对话保持连续；任务与成果按需展开。此链接与内容均为本地演示。'},{title:'工作台交互约定（合成来源）',url:'https://example.com/one/workspace',snippet:'关闭显示不等于停止任务，待处理状态保留在任务中心。'}],knowledgeDiagnostics:{status:'partial',failures:[{provider:'notion',code:'TIMEOUT',message:'合成演示：一个知识来源暂时未能读取，当前回答仅参考已返回的资料。',retryable:true}]},attachmentWarning:'扫描资料.pdf 尚未获得可读文字；这次没有把它作为回答依据。',attachments:[ready],requestId:'fixture-rich-answer',createdAt:stamp});
}
window.EventSource=class {
 onmessage:any=null; onerror:any=null; timer:any;
 constructor(url:string){this.timer=setInterval(()=>{const task=localRuns.find(t=>t.id===url.split('/')[3]);if(task)this.onmessage?.({data:JSON.stringify({task,events:[]})});},250);}
 close(){clearInterval(this.timer);}
} as any;
if(new URLSearchParams(location.search).has('thingsPreview'))for(const id of ['one','two'])conversations.push({id:'thing-'+id,userId:user.id,modelId:'preview-model',title:'测试事情 '+id,archived:false,createdAt:stamp,updatedAt:stamp,messages:[{id:'question-'+id,role:'user',content:'旧的提问 '+id,createdAt:stamp},{id:'answer-'+id,role:'assistant',content:('这是一段用于检查输入框位置的历史回答。\n\n').repeat(80),createdAt:stamp}]});
const features=[['research','资料研究','research','围绕一个问题，整理资料、对比观点。'],['writing','周报整理','writing','把本周的工作和资料整理成一份周报。'],['office','办公助手','office','整理散乱信息，写邮件、清单和计划。'],['knowledge','个人资料问答','knowledge','结合你已连接的资料，回答具体问题。']].map(([id,name,category,description])=>({id,name,category,author:'ONE',description,releaseId:'preview',version:1,limitations:'仅本地演示',knowledgeMode:'optional',destinations:[],sources:[]}));
const catalog=features.map((feature,index)=>({...feature,access:index===1?'purchased':index===2?'enterprise':'free',purchaseLabel:index===1?'已购买':index===2?'企业已开通':'免费开放',usageLabel:'执行另按实际用量消耗电力'}));
for(let index=0;index<28;index++){const base=features[index%features.length];catalog.push({...base,id:`sample-${index}`,name:`${['邮件润色','会议纪要','资料对比','方案整理','提案写作','项目复盘','阅读助手'][index%7]} ${Math.floor(index/7)+1}`,access:index%3===0?'locked':'purchased',purchaseLabel:index%3===0?'开通价格 · 待发布':'已购买',usageLabel:'执行另按实际用量消耗电力'});}
const fixtureFeatureRuns=new Map<string,any>(),fixturePublications:any[]=[],fixturePublicationConfigs=new Map<string,any>(),fixturePublicationHistory=new Map<string,any[]>(),fixtureApiKeys=new Map<string,any[]>(),fixtureSponsorships=new Map<string,any[]>(),fixtureFeedback:any[]=[];
const fixtureCredentials:{endpoint:string;auth:string}[]=[];
let fixtureBudgetThreshold=2;
let fixtureFailShareRefresh=false;
const fixtureSources=[{id:'fixture-notion',provider:'notion',name:'ONE 项目资料（合成）'}];
// Owner-list density only: both private drafts and explicitly active synthetic
// rows use the same owner/config contract as the interactive fixture below.
if(densityQA){
 const names=['项目资料助手','每周工作复盘','知识库问答','会议纪要整理','超长名称验收：这是一个覆盖团队资料检索、项目规划与交付核对的知识分身，用来检查名称省略、卡片边界和滚动时的排版稳定性','邮件与提案助手','产品使用说明','个人阅读伙伴'];
 for(let index=0;index<names.length;index++){
  const id=`fixture-publication-density-${index+1}`,slug=`fixture-one-density-${index+1}`,status=index%3===0?'draft':'active',days=14;
  const service={mode:index%2===0?'knowledge':'consultation',welcome:'你好，这是本地合成分身，用于检查界面布局。',starterQuestions:['你能帮我做什么？','如何开始整理资料？'],method:'先明确目标，再给出结构清楚的回答。',features:[]};
  const description=index===4?'这是较长的合成介绍，用来检查介绍文字换行后是否挤压操作按钮、用量状态以及其他分身的可视范围。这里没有真实资料、用户信息或正在运行的服务。':`${['整理项目资料并回答具体问题。','按目标梳理工作成果与下一步。','只在已授权的演示资料范围里回答。','把会议讨论整理成可行动的清单。'][index%4]}仅用于本地密度验收。`;
  const config={name:names[index],description,prompt:'只用于本地合成验收；不调用模型或真实知识服务。',modelId:'preview-model',sourceIds:['fixture-notion'],attachments:index%2===0,budget:10+index,perRun:1,days,visitorPercent:0,requireLogin:false,allowedUsernames:[],service,serviceBusiness:{access:'open',plans:[],intakeFields:[]},status,version:1,legacyPrompt:false};
  const row={id,slug,version:1,name:names[index],description,status,...(status==='draft'?{draftDays:days}:{}),expiresAt:new Date(Date.parse(stamp)+days*86400000).toISOString(),budgetMicros:(10+index)*1e6,perRunMicros:1e6,spent:status==='draft'?0:index*125000,held:0,attachments:config.attachments,sources:['ONE 项目资料（合成）'],authorName:'本地合成作者',service:{mode:service.mode,featureCount:0},createdAt:stamp,updatedAt:stamp};
  fixturePublications.push(row);fixturePublicationConfigs.set(id,config);fixturePublicationHistory.set(id,[]);
 }
}
let fixtureGuideBeginFailed=false;
const fixtureWelcome=()=>({profile,welcomeContext:{platforms:[],features:features.map(({id,name,description})=>({id,name,description}))},handbookOffer:{available:false},handbookNotice:'本地引导演示，不会生成说明或使用电力。'});
/** Mirror the forward-only journey contract, without authorization, model or device side effects. */
function fixtureJourney(body:any):{status?:number;error?:string} {
 if(body.createGuide===true)return{status:400,error:'本地引导不制作说明或调用模型，请选择只保存设置。'};
 const now=new Date().toISOString(),journey=profile.onboarding.journey;
 if(body.action==='begin'){
  if(typeof body.launchId!=='string'||!/^[A-Za-z0-9_-]{16,100}$/.test(body.launchId))return{status:400,error:'请重新发起这次引导。'};
  if(!fixtureGuideBeginFailed&&new URLSearchParams(location.search).has('guideFailBegin')){fixtureGuideBeginFailed=true;return{status:503,error:'合成演示：引导暂时没有打开，可以重新试一次。'};}
  if(journey&&(journey.stage!=='complete'||journey.launchId===body.launchId))return{};
  if(journey)profile.onboarding.journeyHistory=[...(profile.onboarding.journeyHistory||[]),journey];
  profile.onboarding.journey={id:'fixture-journey-'+crypto.randomUUID(),launchId:body.launchId,version:2,stage:'name',startedAt:now,featureIds:[],purposeIds:[],experience:body.experience===4?4:3,events:[]};
 }else{
  if(!journey||body.journeyId!==journey.id)return{status:409,error:'这次引导已经变化，请重新打开。'};
  if(body.action==='finish'){
   if(journey.stage==='complete')return{};
   if(journey.stage!=='ready')return{status:409,error:'请先完成当前步骤。'};
   if(body.choice!=='without_image'&&body.createGuide!==false)return{status:400,error:'本地引导只支持保存设置，不会制作说明。'};
   journey.stage='complete';journey.completedAt=now;profile.onboarding.completedAt=now;
   profile.onboarding.handbook={status:'skipped',maxPower:0,funding:'customer',createdAt:now,updatedAt:now};
   journey.events.push({step:'complete',choice:'without_image',at:now});
  }else if(body.action==='step'){
   if(body.step!==journey.stage){const last=journey.events.at(-1);if(last?.step===body.step&&last.choice===body.choice)return{};return{status:409,error:'请按顺序完成当前步骤。'};}
   if(body.step==='name'){
    if(body.choice==='provided'){const name=typeof body.displayName==='string'?body.displayName.normalize('NFC').trim():'';if(!name||name.length>40||/[\u0000-\u001f\u007f]/.test(name))return{status:400,error:'称呼请填写 1–40 个可见字符。'};profile.displayName=name;profile.onboarding.nameSetAt=now;}
    else if(body.choice!=='skipped')return{status:400,error:'请选择称呼或跳过。'};
    journey.nameChoice=body.choice;journey.stage='knowledge';
   }else if(body.step==='knowledge'){
    if(body.choice==='connected')return{status:409,error:'本地演示没有连接真实资料，可以先跳过。'};
    if(body.choice!=='skipped')return{status:400,error:'请选择有效的资料连接状态。'};
    journey.knowledgeChoice='skipped';profile.onboarding.knowledgeChoice='skipped';journey.stage='device';
   }else if(body.step==='device'){
    if(!['checked','skipped'].includes(body.choice))return{status:400,error:'请选择有效的本机状态。'};
    journey.localChoice=body.choice;if(body.choice==='checked')journey.local={connected:false,folderSelected:false,executorReady:false,checkedAt:now};journey.stage='features';
   }else if(body.step==='features'){
    const purposeIds=body.purposeIds,featureIds=body.featureIds||[];
    if(purposeIds!==undefined&&(!Array.isArray(purposeIds)||purposeIds.length>2||new Set(purposeIds).size!==purposeIds.length||purposeIds.some((id:any)=>!['writing','work','learning','files','life','explore'].includes(id))))return{status:400,error:'最多选择两个有效方向。'};
    if(!Array.isArray(featureIds)||featureIds.length>3||featureIds.some((id:any)=>!features.some(feature=>feature.id===id)))return{status:403,error:'只能选择当前演示可用的功能。'};
    journey.purposeIds=purposeIds||[];journey.featureIds=featureIds;journey.stage='ready';
   }else return{status:400,error:'没有这个引导步骤。'};
   journey.events.push({step:body.step,choice:String(body.choice),at:now});
  }else return{status:400,error:'本地演示不支持这个引导操作。'};
 }
 profile.updatedAt=now;return{};
}
const workflowJobs=new Map<string,any[]>(),workflowOperations=new Map<string,{taskId:string;jobId:string}>();
if(workflowPreview){
 for(const [suffix,title,state,request,response] of [
  ['research','整理项目资料','running','请整理 ONE 的任务、成果与本机执行如何衔接。',''],
  ['outline','改版接入清单','completed','请列出工作台正式接入的核对清单。','## 接入清单\n\n- 主对话与草稿持续保留。\n- 功能选择和独立运行分别接入。\n- 分身分享链接可以找回。\n\n这是合成结果，没有调用模型或读取真实资料。'],
  ['ended','旧版方案核对','cancelled','先看看之前的方案，这件事暂时停下。','这件事已停止，已有原话和结果保留。继续时可以在这里提出新的要求。'],
 ]){
  const id=`workflow-${suffix}`,inputId=`${id}-user`,resultId=`${id}-answer`,jobId=`${id}-job`;
  const messages:any[]=[{id:inputId,role:'user',content:request,createdAt:stamp}];if(response)messages.push({id:resultId,role:'assistant',content:response,createdAt:stamp});
  conversations.push({id,workspaceId:'preview',userId:user.id,modelId:'preview-model',executorProfileId:'fixture-worker',title,archived:false,createdAt:stamp,updatedAt:stamp,messages});
  workflowJobs.set(id,[{id:jobId,operationId:`${id}-operation`,state,inputMessageId:inputId,resultMessageId:response?resultId:undefined,instruction:request,kind:'chat',features:[],charges:[],progress:state==='running'?{completed:['已保存原话'],pending:['整理接入重点']}:undefined}]);
  if(state!=='running')transferNotices.push({id:`${id}-receipt`,sourceId:jobId,taskId:id,title,state:state==='completed'?'completed':'cancelled',outcome:state==='completed'?'completed':'cancelled',reported:state==='cancelled',read:state==='cancelled',updatedAt:stamp,resultMessageId:resultId});
 }
}
// A denser but entirely invented dataset: 16 active, 12 reviewable, 4 ended,
// and 4 ordinary history conversations, in addition to the legacy fixture. The
// first active task has earlier results while a new round is running, matching
// the real task-and-result pane without copying any customer content.
if (densityQA) {
 const titles = ['ONE 使用说明与入门流程', '项目资料整理', '本周工作复盘', '会议纪要与待办核对', '连接资料与权限边界', '知识问答结果检查', '前端页面可读性检查', '账户设置操作说明'];
 const updated = (index:number) => new Date(Date.parse(stamp) + 1000 - index * 60000).toISOString();
 for (let index=0; index<36; index++) {
  const group=index<16?'active':index<28?'review':index<32?'ended':'history';
  const number=String(index+1).padStart(2,'0'),id=`density-${group}-${number}`,when=updated(index);
  const title=index===17?'图文成果：紧凑阅读验收':index%7===3?`${titles[index%titles.length]}：检查长标题在任务列表和详情工具栏同时出现时，能否保留清楚的层级和足够阅读空间`:`${titles[index%titles.length]} · ${number}`;
  const messages:any[]=[];
  const rounds=index===0?8:index===17?1:4;
  for (let round=0;round<rounds;round++) {
   const messageTime=new Date(Date.parse(when)-(rounds-round)*120000).toISOString();
   messages.push({id:`${id}-user-${round}`,role:'user',content:round===0?'请把这项任务整理成可以直接使用的清单。':'接着检查上一轮结果，保留已经确认的内容，补充遗漏的步骤。',createdAt:messageTime});
   const guide={id:`${id}-guide-${round}`,originalName:`${title} · 图文成果.html`,kind:'document',mimeType:'text/html',size:8420,status:'ready',visualDocument:true};
   const file={id:`${id}-file-${round}`,originalName:`第 ${round+1} 轮核对清单.md`,kind:'text',mimeType:'text/markdown',size:1280,status:'ready'};
   fixtureFiles.set(guide.id,{...guide,content:`<!doctype html><meta charset="utf-8"><title>本地合成成果</title><h1>${title}</h1><p>这是用于检查阅读空间的本地合成成果，不含用户数据。</p>`});
   fixtureFiles.set(file.id,{...file,content:'# 核对清单\n\n- 保留原话\n- 检查步骤\n- 核对成果\n'});
   messages.push({id:`${id}-answer-${round}`,role:'assistant',content:index===17?'':round===rounds-1?'## 本轮已经整理好\n\n- **已完成**：保留前面确认的内容，更新核对清单。\n- **需要你看**：检查图文成果的步骤是否清楚。\n- **下一步**：你可以直接在此任务里补充要求。\n\n这是本地合成内容，没有调用模型、访问资料或产生费用。':'### 第 '+(round+1)+' 轮结果\n\n已经整理这项任务的目标和处理步骤。请先核对核心内容，再决定是否展开附件。\n\n1. 明确这次工作的输入。\n2. 把已确认的步骤保留在任务里。\n3. 在同一对话中继续补充。',attachments:round===rounds-1?[guide,file]:round%2===0?[file]:undefined,createdAt:messageTime});
  }
  const jobs:any[]=[];
  for(let round=0;round<rounds;round++)jobs.push({id:`${id}-job-${round}`,operationId:`${id}-operation-${round}`,state:'completed',inputMessageId:`${id}-user-${round}`,resultMessageId:`${id}-answer-${round}`,instruction:messages[round*2].content,kind:'chat',features:[],charges:[]});
  const conversation:any={id,workspaceId:'preview',userId:user.id,modelId:'preview-model',title,archived:false,createdAt:when,updatedAt:when,messages};
  if(group!=='history')conversation.executorProfileId='fixture-worker';
  if(group==='active'){
   const inputId=`${id}-pending-input`;
   messages.push({id:inputId,role:'user',content:'前面的结果很好，请继续检查可读性和遗漏的步骤。',createdAt:when});
   jobs.push({id:`${id}-running-job`,operationId:`${id}-running-operation`,state:'running',inputMessageId:inputId,instruction:'继续检查可读性和遗漏的步骤。',kind:'chat',features:[],charges:[],progress:{completed:['已保存这次补充','前面成果仍然可查看'],pending:['整理本轮核对结果']}});
  }
  if(group==='review'||group==='ended') {
   const job=jobs.at(-1);
   if(group==='review'&&index%3===0)conversation.workPaused=true;
   transferNotices.push({id:`${id}-receipt`,sourceId:job.id,taskId:id,title,state:'completed',outcome:'completed',reported:group==='ended',read:group==='ended',updatedAt:when,resultMessageId:job.resultMessageId});
  }
  conversations.push(conversation);workflowJobs.set(id,jobs);
 }
 conversations.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
}
function workflowMeta(conversation:any){const jobs=workflowJobs.get(conversation.id)||[],running=jobs.some(job=>job.state==='running'),queued=jobs.filter(job=>job.state==='queued').length;return{id:conversation.id,title:conversation.title,updatedAt:conversation.updatedAt,executorId:conversation.executorProfileId,running,queued,paused:Boolean(conversation.workPaused),state:running?'running':conversation.workPaused?'paused':queued?'queued':'idle',phase:running?'合成任务处理中；没有调用模型或本机设备。':undefined};}
function workflowNotice(conversation:any,job:any,state='completed'){
 const id=`${job.id}-receipt`;if(transferNotices.some(notice=>notice.id===id))return;
 transferNotices.push({id,sourceId:job.id,taskId:conversation.id,title:conversation.title,state,outcome:state,reported:false,read:false,updatedAt:conversation.updatedAt,resultMessageId:job.resultMessageId});
}
function workflowFollowup(conversation:any,operationId:string,text:string){
 const old=workflowOperations.get(operationId);if(old)return old;
 const inputId='workflow-input-'+crypto.randomUUID(),job={id:'workflow-job-'+crypto.randomUUID(),operationId,state:'running',inputMessageId:inputId,instruction:text,kind:'chat',features:[],charges:[]};
 const jobs=workflowJobs.get(conversation.id)||[];for(const previous of jobs.filter(item=>item.state==='running')){previous.state='completed';previous.resultMessageId='workflow-answer-'+crypto.randomUUID();conversation.messages.push({id:previous.resultMessageId,role:'assistant',content:'前一轮合成整理已完成。新的补充会在本任务内继续处理。',createdAt:new Date().toISOString()});}
 conversation.messages.push({id:inputId,role:'user',content:text,createdAt:new Date().toISOString()});jobs.push(job);workflowJobs.set(conversation.id,jobs);conversation.workPaused=false;conversation.updatedAt=new Date().toISOString();const receipt={taskId:conversation.id,jobId:job.id};workflowOperations.set(operationId,receipt);
 setTimeout(()=>{if(job.state!=='running')return;job.state='completed';const resultMessageId='workflow-answer-'+crypto.randomUUID();Object.assign(job,{resultMessageId});conversation.updatedAt=new Date().toISOString();conversation.messages.push({id:resultMessageId,role:'assistant',content:`## 已接住本任务的补充\n\n> ${text.replace(/\n/g,'\n> ')}\n\n补充只保存在“${conversation.title}”里，主对话和其他任务没有新增消息。这是本地合成结果，不调用模型，也不操作文件。`,createdAt:conversation.updatedAt});workflowNotice(conversation,job);},1100);
 return receipt;
}
function featureRun(feature:any,operationId:string,prompt:string){
 const existing=fixtureFeatureRuns.get(operationId);if(existing)return existing;
 const run={operationId,featureId:feature.id,name:feature.name,version:1,status:'pending',createdAt:new Date().toISOString(),power:0,prompt,usageMultiplier:.6,content:'',charges:[],trace:[]};fixtureFeatureRuns.set(operationId,run);
 setTimeout(()=>{Object.assign(run,{status:'completed',content:`## ${feature.name} · 演示成果\n\n已接住你的要求：\n\n> ${prompt.replace(/\n/g,'\n> ')}\n\n- 主对话与任务状态分别保留。\n- 成果可复制、下载并继续修改。\n- 本次没有调用模型、访问知识或产生费用。`,files:richPreview?[{id:'fixture-plan',name:'ONE 改版计划.md',mimeType:'text/markdown'}]:[]});},1100);return run;
}
const previewApiLog:any[]=[];
const previewLog=document.createElement('output');previewLog.id='fixture-api-log';previewLog.hidden=true;document.body.append(previewLog);
document.documentElement.dataset.onePreviewMode=realService?'explicit-real-service':'synthetic';
const logRequest=(method:string,path:string,scope='synthetic')=>{const row={method,path,scope,status:200,at:new Date().toISOString()};previewApiLog.push(row);if(previewApiLog.length>400)previewApiLog.shift();previewLog.textContent=JSON.stringify(previewApiLog);return row;};
const json=(result:any,status=200)=>new Response(JSON.stringify(result),{status,headers:{'Content-Type':'application/json','X-ONE-Preview':'synthetic'}});
const nativeFetch=window.fetch.bind(window);
let runtimePolls=0;
window.fetch=async(input,options={})=>{
 const url=new URL(typeof input==='string'?input:input instanceof Request?input.url:input.toString(),location.origin);
 if(url.origin!==location.origin)return new Response('{}',{status:403});
 if(!url.pathname.startsWith('/api/'))return nativeFetch(input,options);
 const path=url.pathname,method=(options.method||(input instanceof Request?input.method:'GET')).toUpperCase();let body:any={};if(typeof options.body==='string'){try{body=JSON.parse(options.body);}catch{return json({error:'本地预览只接受 JSON 请求体'},400);}}
 if(realService && (path.startsWith('/api/coordinator')||path.startsWith('/api/conversations')||path.startsWith('/api/attachments')||path.startsWith('/api/features'))){logRequest(method,path,'explicit-real-service');return nativeFetch('http://127.0.0.1:4291'+url.pathname+url.search,{...options,credentials:'include'});}
 const requestRecord=logRequest(method,path);
 const reply=(value:any,status=200)=>{requestRecord.status=status;previewLog.textContent=JSON.stringify(previewApiLog);return json(value,status);};
 let result:any={};
 if(path==='/api/me/profile'){
  if(method==='PATCH'){
   if(body.appearance!==undefined){if(body.appearance?.scene!=='silver'&&body.appearance?.scene!=='graphite')return reply({error:'请选择有效的演示外观'},400);profile.appearance={scene:body.appearance.scene};}
   if(typeof body.displayName==='string')profile.displayName=body.displayName.trim().slice(0,40)||profile.displayName;
   profile.updatedAt=new Date().toISOString();try{localStorage.setItem(profileStorageKey,JSON.stringify({workspaceId:'preview',displayName:profile.displayName,appearance:profile.appearance}));}catch{}
  }result=fixtureWelcome();
 }
 else if(path==='/api/me/profile/onboarding'){
  if(method!=='POST')return reply({error:'请通过引导按钮发起演示'},405);
  const update=fixtureJourney(body);if(update.error)return reply({error:update.error},update.status||400);
  result=fixtureWelcome();
 }
 else if(path==='/api/me/feedback'){
  if(method==='POST'){const feedback={id:'fixture-feedback-'+crypto.randomUUID(),workspaceId:'preview',userId:'preview',messageId:body.messageId,rating:body.rating,comment:body.shareComment?body.comment:undefined,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};fixtureFeedback.push(feedback);result={feedback};}else result={items:fixtureFeedback};
 }
 else if(path==='/api/me/welcome-guides')result={guides:[]};
 else if(path==='/api/features/budget-policy'){
  if(method==='POST')fixtureBudgetThreshold=Math.max(.001,Math.min(100,Number(body.approvalThreshold)||2));result={approvalThreshold:fixtureBudgetThreshold};
 }
 else if(path==='/api/features/quote')result={approvalThreshold:fixtureBudgetThreshold,features:(body.featureIds||[]).map((id:string)=>{const feature=catalog.find(f=>f.id===id)||features[0];return{id:feature.id,name:feature.name,releaseId:feature.releaseId,version:feature.version,multiplier:.6};})};
 else if(path==='/api/features/runs'){
  const page=Math.max(1,Number(url.searchParams.get('page'))||1),items=[...fixtureFeatureRuns.values()].reverse();result={items:items.slice((page-1)*10,page*10),total:items.length};
 }
 else if(/^\/api\/features\/runs\/[^/]+(?:\/(?:continue|retry))?$/.test(path)){
  const id=decodeURIComponent(path.split('/')[4]),run=fixtureFeatureRuns.get(id);if(!run)return reply({error:'没有这份演示运行记录'},404);
  if(path.endsWith('/continue')||path.endsWith('/retry')){
   if(method!=='POST'||!body.confirmed)return reply({error:'请先确认本轮演示范围'},400);
   const feature=catalog.find(f=>f.id===run.featureId)||features[0],nextId=body.operationId||`${id}-retry`;
   result=featureRun(feature,nextId,body.prompt||run.prompt);
  }else result=run;
 }
 else if(/^\/api\/features\/[^/]+\/runs$/.test(path)&&method==='POST'){
  const feature=catalog.find(f=>f.id===decodeURIComponent(path.split('/')[3]));if(!feature)return reply({error:'演示功能不存在'},404);
  if(!body.confirmed||!body.prompt?.trim()||!body.operationId)return reply({error:'请填写演示任务并确认使用范围'},400);
  result=featureRun(feature,body.operationId,body.prompt);
 }
 else if(path==='/api/feature-credentials'){
  if(method==='POST'||method==='DELETE'){const index=fixtureCredentials.findIndex(c=>c.endpoint===body.endpoint&&c.auth===body.auth);if(index>=0)fixtureCredentials.splice(index,1);if(method==='POST')fixtureCredentials.push({endpoint:String(body.endpoint),auth:String(body.auth)});}
  result={items:fixtureCredentials};
 }
 else if(path==='/api/sharing/manage'){
  if(method==='POST'){
   if(body.intent!==undefined&&body.intent!=='draft')return reply({error:'演示分身的保存方式无效'},400);
   if(!body.confirmed||!body.name?.trim()||body.modelId!=='preview-model')return reply({error:'请填写分身名称、模型并确认演示范围'},400);
   if((body.sourceIds||[]).some((id:string)=>!fixtureSources.some(source=>source.id===id)))return reply({error:'演示知识范围无效'},403);
   const id=`fixture-publication-${fixturePublications.length+1}`,slug=`fixture-one-${fixturePublications.length+1}`,status=body.intent==='draft'?'draft':'active',days=Math.max(1,Number(body.days)||7);
   const {intent:_intent,confirmed:_confirmed,...values}=body,config={...values,status,days,version:1,legacyPrompt:false};
   const row={id,slug,version:1,name:String(body.name).trim(),description:String(body.description||'').trim(),status,...(status==='draft'?{draftDays:days}:{}),expiresAt:new Date(Date.now()+days*86400000).toISOString(),budgetMicros:Math.round((Number(body.budget)||10)*1e6),perRunMicros:Math.round((Number(body.perRun)||1)*1e6),spent:0,held:0,attachments:Boolean(body.attachments),sources:(body.sourceIds||[]).map((id:string)=>fixtureSources.find(source=>source.id===id)?.name||id)};
   fixturePublications.unshift(row);fixturePublicationConfigs.set(id,config);fixturePublicationHistory.set(id,[]);fixtureFailShareRefresh=new URLSearchParams(location.search).has('shareRefreshFailure');result=status==='draft'?{id,status,version:1}:{id,slug,status,version:1};
  }else{if(fixtureFailShareRefresh){fixtureFailShareRefresh=false;return reply({error:'合成演示：保存已确认，列表刷新暂时失败'},503);}const page=Math.max(1,Number(url.searchParams.get('page'))||1),query=(url.searchParams.get('q')||'').toLowerCase(),items=fixturePublications.filter(row=>(row.name+' '+row.description).toLowerCase().includes(query));result={ready:true,visitorPaymentsEnabled:false,items:items.slice((page-1)*10,page*10).map(row=>{const {slug,draftDays,...visible}=row;return row.status==='draft'?visible:{...visible,slug};}),total:items.length,sources:fixtureSources};}
 }
 else if(/^\/api\/sharing\/manage\/[^/]+\/(?:config|update|publish|close|usage)$/.test(path)){
  const id=path.split('/')[4],row=fixturePublications.find(item=>item.id===id),config=fixturePublicationConfigs.get(id);if(!row||!config)return reply({error:'演示分身不存在'},404);
  if(path.endsWith('/config')){const history=fixturePublicationHistory.get(id)||[],page=Math.max(1,Number(url.searchParams.get('page'))||1);result={...config,status:row.status,days:row.status==='draft'?(row.draftDays??config.days??7):config.days,total:history.length,history:history.slice((page-1)*5,page*5)};}
  else if(path.endsWith('/update')){
   if(method!=='POST'||!body.confirmed||body.version!==row.version)return reply({error:'演示版本已变化，请重新打开配置'},409);
   if(row.status==='closed')return reply({error:'已关闭的演示分享不能重新开启'},409);
   if(body.intent!==undefined&&body.intent!=='draft')return reply({error:'请从演示开放分享入口操作'},400);
   if(row.status==='active'&&body.intent==='draft')return reply({error:'已开放的演示分享不能通过保存变成私有'},409);
   if((body.sourceIds||[]).some((sourceId:string)=>!fixtureSources.some(source=>source.id===sourceId)))return reply({error:'演示知识范围无效'},403);
   const history=fixturePublicationHistory.get(id)||[];history.unshift({...config,status:row.status,updatedAt:row.updatedAt||stamp});fixturePublicationHistory.set(id,history.slice(0,20));
   const {intent:_intent,confirmed:_confirmed,...values}=body,next={...values,status:row.status,version:row.version+1,legacyPrompt:false};fixturePublicationConfigs.set(id,next);Object.assign(row,{version:next.version,name:body.name,description:body.description,attachments:Boolean(body.attachments),budgetMicros:Math.round(Number(body.budget)*1e6),perRunMicros:Math.round(Number(body.perRun)*1e6),...(row.status==='draft'?{draftDays:Number(body.days)}:{}),expiresAt:new Date(Date.now()+Number(body.days)*86400000).toISOString(),sources:(body.sourceIds||[]).map((sourceId:string)=>fixtureSources.find(source=>source.id===sourceId)?.name||sourceId),updatedAt:new Date().toISOString()});fixtureFailShareRefresh=new URLSearchParams(location.search).has('shareRefreshFailure');result=row.status==='draft'?{id,status:'draft',version:row.version}:{id,status:'active',slug:row.slug,version:row.version};
  }else if(path.endsWith('/publish')){
   if(method!=='POST'||body.confirmed!==true)return reply({error:'请先确认演示分享的知识范围与费用规则'},400);
   const history=fixturePublicationHistory.get(id)||[],previous=history[0],sameActivation=row.status==='active'&&previous?.status==='draft'&&body.version===previous.version&&row.version===previous.version+1;
   if(row.status==='active'&&(body.version===row.version||sameActivation)){
    if(Date.parse(row.expiresAt)<=Date.now())return reply({error:'演示分享已到期，请更新配置'},410);
    result={id,status:'active',slug:row.slug,version:row.version,expiresAt:row.expiresAt};
   }else{
    if(row.status!=='draft')return reply({error:'已关闭或变更的演示分享不能直接开放'},409);
    if(body.version!==row.version)return reply({error:'演示分身配置已变化，请重新核对'},409);
    if(config.modelId!=='preview-model'||(config.sourceIds||[]).some((sourceId:string)=>!fixtureSources.some(source=>source.id===sourceId)))return reply({error:'演示分身模型或知识范围已变化，请重新配置'},409);
    history.unshift({...config,status:'draft',version:row.version,updatedAt:row.updatedAt||stamp});fixturePublicationHistory.set(id,history.slice(0,20));
    const days=row.draftDays??config.days??7;Object.assign(row,{status:'active',version:row.version+1,expiresAt:new Date(Date.now()+days*86400000).toISOString(),updatedAt:new Date().toISOString()});fixturePublicationConfigs.set(id,{...config,status:'active',version:row.version,days});fixtureFailShareRefresh=new URLSearchParams(location.search).has('shareRefreshFailure');result={id,status:'active',slug:row.slug,version:row.version,expiresAt:row.expiresAt};
   }
  }else if(path.endsWith('/close')){row.status='closed';config.status='closed';result={ok:true};}
  else result={total:row.status==='draft'?0:1,items:row.status==='draft'?[]:[{id:'fixture-usage-1',status:'completed',createdAt:stamp,spent:0,held:0,calls:[{model:'演示模型（不计费）',activity:'本地 UI 记录',spent:0,status:'success'}]}]};
 }
 else if(/^\/api\/sharing\/[^/]+(?:\/sessions)?$/.test(path)){
  const slug=path.split('/')[3],row=fixturePublications.find(item=>item.slug===slug);if(!row)return reply({error:'演示分享不存在'},404);
  if(row.status!=='active'||Date.parse(row.expiresAt)<=Date.now())return reply({error:'演示分享尚未开放、已关闭或到期'},410);
  const config=fixturePublicationConfigs.get(row.id);if(path.endsWith('/sessions')&&method==='POST')result={token:'DEMO_ONLY_GUEST_'+row.id};else if(method==='GET')result={name:row.name,description:row.description,attachments:row.attachments,expiresAt:row.expiresAt,version:row.version,requireLogin:config?.requireLogin??false,visitorPercent:config?.visitorPercent??0,paymentEnabled:false};else return reply({error:'演示分享操作未启用'},404);
 }
 else if(/^\/api\/sharing-api\/manage\/[^/]+\/keys(?:\/[^/]+\/revoke)?$/.test(path)){
  const id=path.split('/')[4];if(!fixturePublications.some(p=>p.id===id))return reply({error:'演示分身不存在'},404);const keys=fixtureApiKeys.get(id)||[];fixtureApiKeys.set(id,keys);
  if(path.endsWith('/revoke')){const key=keys.find(k=>k.id===path.split('/')[6]);if(key)key.status='revoked';result={ok:true};}
  else if(method==='POST'){if(fixturePublications.find(p=>p.id===id)?.status!=='active')return reply({error:'演示分身尚未开放分享'},410);if(!body.confirmed)return reply({error:'请先确认演示授权'},400);keys.unshift({id:'fixture-api-'+crypto.randomUUID(),name:body.name,version:body.version,status:'active',budgetMicros:Math.round(Number(body.budget)*1e6),spent:0,expiresAt:new Date(Date.now()+Number(body.days)*86400000).toISOString()});result={token:'DEMO_ONLY_NOT_A_REAL_API_KEY_'+keys[0].id};}
  else{const page=Math.max(1,Number(url.searchParams.get('page'))||1);result={items:keys.slice((page-1)*5,page*5),total:keys.length};}
 }
 else if(/^\/api\/sharing-commerce\/manage\/[^/]+\/(?:sponsorships(?:\/[^/]+\/revoke)?|earnings)$/.test(path)){
  const id=path.split('/')[4];if(!fixturePublications.some(p=>p.id===id))return reply({error:'演示分身不存在'},404);
  if(path.endsWith('/earnings'))result={total:0,pendingRevenueMicros:0,items:[]};
  else{const grants=fixtureSponsorships.get(id)||[];fixtureSponsorships.set(id,grants);if(path.endsWith('/revoke')){const grant=grants.find(g=>g.id===path.split('/')[6]);if(grant)grant.status='revoked';result={ok:true};}else if(method==='POST'){if(!body.confirmed)return reply({error:'请先确认演示赠送'},400);grants.unshift({id:'fixture-grant-'+crypto.randomUUID(),name:body.username,status:'active',budgetMicros:Math.round(Number(body.budget)*1e6),usedMicros:0});result={ok:true};}else{const page=Math.max(1,Number(url.searchParams.get('page'))||1);result={items:grants.slice((page-1)*5,page*5),total:grants.length};}}
 }
 else if(/^\/api\/attachments\/[^/]+(?:\/content)?$/.test(path)){
  const file=fixtureFiles.get(decodeURIComponent(path.split('/')[3]));if(!file)return reply({error:'没有这份演示附件'},404);
  if(path.endsWith('/content')){if(file.status!=='ready')return reply({error:'演示附件尚未就绪'},409);return new Response(file.content||'本地演示文件',{headers:{'Content-Type':file.mimeType||'text/plain','X-ONE-Preview':'synthetic','Content-Security-Policy':"default-src 'none'; sandbox"}});}const {content,...attachment}=file;result={attachment};
 }
 else if(transferPreview && path==='/api/coordinator'){const items=workflowPreview?conversations.filter(c=>!c.archived&&(!densityQA||!c.id.startsWith('density-history-'))):conversations;result={enabled:true,conversation:{id:'main',messages:coordinatorMessages},tasks:items.map(c=>workflowPreview?workflowMeta(c):({id:c.id,title:c.title,updatedAt:c.updatedAt,running:false,queued:0})),total:items.length,notices:workflowPreview?transferNotices.filter(n=>items.some(c=>c.id===n.taskId)):transferNotices,links:coordinatorMessages.filter(m=>m.taskId).map(m=>({messageId:m.id,taskId:m.taskId}))};}
 else if(workflowPreview&&(path==='/api/coordinator/notices/read'||path==='/api/coordinator/read'||path==='/api/coordinator/notices/read-all')){
  const ids=path.endsWith('/read-all')?transferNotices.filter(notice=>!notice.read).map(notice=>notice.id):Array.isArray(body.ids)?body.ids:[];for(const notice of transferNotices)if(ids.includes(notice.id))notice.read=true;result={ids,count:ids.length};
 }
 else if(workflowPreview&&/^\/api\/coordinator\/tasks\/[^/]+(?:\/(?:messages|stop|restore|retry))?$/.test(path)){
  const id=decodeURIComponent(path.split('/')[4]),conversation=conversations.find(c=>c.id===id);if(!conversation)return reply({error:'合成任务不存在'},404);const action=path.split('/')[5],jobs=workflowJobs.get(id)||[];
  if(action==='messages'&&method==='POST'){
   if(typeof body.operationId!=='string'||typeof body.text!=='string'||!body.text.trim())return reply({error:'请填写任务补充和操作编号'},400);
   const previous=workflowOperations.get(body.operationId);if(previous&&previous.taskId!==id)return reply({error:'该演示操作编号已属于另一件任务'},409);
   result={status:'completed',...workflowFollowup(conversation,body.operationId,body.text.trim())};
  }else if(action==='stop'||method==='DELETE'){
   for(const job of jobs)if(job.state==='running'||job.state==='queued'){job.state='cancelled';conversation.updatedAt=new Date().toISOString();workflowNotice(conversation,job,'cancelled');}
   if(method==='DELETE')conversation.archived=true;result={ok:true};
  }else if(action==='restore'){conversation.archived=false;result={ok:true};}
  else if(action==='retry'){const latest=jobs.at(-1);if(!body.confirmed||!latest)return reply({error:'请先确认最新任务要求'},400);result={status:'completed',...workflowFollowup(conversation,`retry:${latest.operationId}`,latest.instruction||'继续这件事')};}
  else result={conversation,jobs,recovery:{kind:'none',message:jobs.some(job=>job.state==='running')?'本轮合成任务仍在处理中。':'已有内容保留；可以在这件事里继续补充要求。'}};
 }
 else if(transferPreview && path==='/api/coordinator/messages'){
  if(new URLSearchParams(location.search).has('sendFailure')){
   await new Promise(resolve=>setTimeout(resolve,1500));
   return reply({error:'合成提交失败，未开始执行'},503);
  }
  if(new URLSearchParams(location.search).has('clarifyPreview')){
   coordinatorMessages.push({id:crypto.randomUUID(),role:'user',content:body.text,createdAt:stamp},{id:crypto.randomUUID(),role:'assistant',content:'你指的是哪个任务？',createdAt:stamp});operations.set(body.operationId,{});
   return reply({status:'completed'});
  }
  const cid=body.boundTaskId||`fixture-${crypto.randomUUID()}`,mid=crypto.randomUUID();
  const c=conversations.find(c=>c.id===cid)||{id:cid,userId:user.id,modelId:'preview-model',title:body.text.slice(0,16),messages:[],createdAt:stamp,updatedAt:stamp};
  if(!conversations.includes(c))conversations.push(c);c.messages.push({id:mid,role:'user',content:body.text,createdAt:stamp});
  coordinatorMessages.push({id:crypto.randomUUID(),role:'user',content:body.text,createdAt:stamp},{id:crypto.randomUUID(),role:'assistant',content:'这件事接住了，交接和原话已经保存。',createdAt:stamp,taskId:cid});
  const task={id:crypto.randomUUID(),conversationId:cid,status:'running',provider:'codex',createdAt:stamp,updatedAt:stamp};localRuns.push(task);
  setTimeout(()=>{task.status='completed';task.updatedAt=new Date().toISOString();transferNotices.push({id:task.id,taskId:cid,title:c.title,state:'completed'});c.messages.push({id:crypto.randomUUID(),role:'assistant',content:'合成测试结果：目标、交接和用户补充均已保留。没有操作真实文件。',createdAt:task.updatedAt});},transferDelay);
  result={status:'completed',taskId:cid};operations.set(body.operationId,{taskId:cid});
 }
 else if(transferPreview && path.startsWith('/api/coordinator/messages/'))result={status:'completed',taskId:operations.get(path.split('/').at(-1)!)?.taskId};
 else if(transferPreview && path.startsWith('/api/coordinator/tasks/'))result={conversation:conversations.find(c=>c.id===path.split('/')[4]),jobs:[]};
 else if(transferPreview && path==='/api/coordinator/reports'){
  for(const id of body.ids){const index=transferNotices.findIndex(n=>n.id===id);if(index>=0){const n=transferNotices[index];if(n.reported)continue;coordinatorMessages.push({id:`report-${id}`,role:'assistant',taskId:n.taskId,content:`${n.title}：合成结果已返回，可打开事情核对完整过程。`,createdAt:new Date().toISOString()});if(workflowPreview)n.reported=true;else transferNotices.splice(index,1);}}
  result={ok:true};
 }
 else if(transferPreview && path==='/api/coordinator/resume')result={ok:true};
 else if(path==='/api/executions/from-input'||path==='/api/executions/from-message'){
  await new Promise(resolve=>setTimeout(resolve,1800));
  if(new URLSearchParams(location.search).has('executeFailure'))return reply({error:'合成失败：本机暂不可用'},503);
  const c=conversations.find(c=>c.id===body.conversationId),mid=body.sourceMessageId||crypto.randomUUID();
  if(path.endsWith('/from-input'))c.messages.push({id:mid,role:'user',content:body.content,createdAt:stamp});
  const task={id:crypto.randomUUID(),workspaceId:'preview',userId:'preview',deviceId:'fixture',conversationId:c.id,sourceMessageId:mid,instruction:body.content||c.messages.find(m=>m.id===mid)?.content,status:'running',provider:'codex',createdAt:stamp,updatedAt:stamp};localRuns.push(task);
  setTimeout(()=>{task.status='completed';(task as any).finalResponse=('合成结果：执行已完成，用户原话保留。\n\n').repeat(70);task.updatedAt=new Date().toISOString();},6000);
  result={task,events:[]};
 }
 else if(path.endsWith('/trace')&&path.startsWith('/api/executions/'))result={instruction:('合成交接：完整原话与上下文。\n').repeat(100)};
 else if(path==='/api/executions'&&(transferPreview||new URLSearchParams(location.search).has('thingsPreview')))result={tasks:localRuns};
 else if(new URLSearchParams(location.search).has('thingsPreview')&&path.startsWith('/api/executions/'))result={task:localRuns.find(t=>t.id===path.split('/')[3]),events:[]};
 else if(transferPreview && path.startsWith('/api/executions/'))result={task:localRuns.find(t=>t.id===path.split('/')[3]),events:[]};
 else if(path==='/api/runtime/update'&&new URLSearchParams(location.search).has('runtimePreview')){
  const mode=new URLSearchParams(location.search).get('runtimePreview');
  const success=mode==='success'||(mode==='auto'&&++runtimePolls>2);
  result={configured:true,supported:true,available:!success,connectionState:'connected',current:{platform:'windows',architecture:'amd64',version:success?'0.3.13':'0.3.10',updateProtocol:1},latestVersion:success?undefined:'0.3.13',progress:success?undefined:{requestId:'fixture-'+mode,status:'completed',version:'0.3.13',updatedAt:new Date().toISOString(),recoveryRequired:true},confirmation:success?{requestId:'fixture-'+mode,version:'0.3.13'}:undefined};
 }
 else if(path==='/api/coordinator'&&new URLSearchParams(location.search).has('runtimePreview'))result={enabled:true,conversation:null,tasks:[],total:0,notices:[]};
 else if(path==='/api/coordinator'&&new URLSearchParams(location.search).has('thingsPreview'))result={enabled:false,conversation:null,tasks:[],total:0,notices:[]};
 else if(path==='/api/me')result={user};
 else if(path==='/api/models')result={models:[{id:'preview-model',name:'演示模型（不计费）',kind:'chat',enabled:true,isDefault:true}],defaultModelId:'preview-model'};
 else if(path==='/api/conversations'){
  if(method==='POST'){const conversation={id:'fixture-'+crypto.randomUUID(),userId:user.id,modelId:'preview-model',title:body.title||'新的事情',archived:false,createdAt:stamp,updatedAt:stamp,messages:[]};conversations.unshift(conversation);result={conversation};}
  else if(densityQA){const page=Math.max(1,Number(url.searchParams.get('page'))||1),pageSize=Math.max(1,Math.min(100,Number(url.searchParams.get('pageSize'))||30)),items=conversations.filter(c=>c.archived===(url.searchParams.get('archived')==='true'));result={conversations:items.slice((page-1)*pageSize,page*pageSize),pagination:{page,hasMore:page*pageSize<items.length}};}
  else result={conversations,pagination:{page:1,hasMore:false}};
 }
 else if(path==='/api/folders')result={folders:[]};else if(path==='/api/agents')result={agents:[]};else if(path==='/api/executions')result={tasks:[]};
 else if(path==='/api/capabilities')result={attachments:{enabled:new URLSearchParams(location.search).get('realService')==='1',maxFiles:5,maxBytes:500000000,extensions:['txt','md']},webSearch:{enabled:false},knowledge:{providers:['getnote','notion']}};
 else if(path.startsWith('/api/knowledge/connections/'))result={connection:{provider:path.split('/').at(-1),status:'disconnected'},configured:true};
 else if(path==='/api/me/billing')result={balanceMicros:0,ledger:[],orders:[],usage:[],rechargeCnyPerPower:7};
 else if(path==='/api/connectors')result={connectors:[]};
 else if(path==='/api/chat'){
  const old=conversations.find(c=>c.id===body.conversationId),id=old?.id??'preview-'+crypto.randomUUID();
  const conversation={id,userId:user.id,modelId:'preview-model',title:old?.title??body.content.slice(0,20),archived:false,createdAt:stamp,updatedAt:stamp,messages:[...(old?.messages??[]),{id:crypto.randomUUID(),role:'user',content:body.content,createdAt:stamp},{id:crypto.randomUUID(),role:'assistant',content:'这是本地演示回答。\n\n你刚才把需求交给右边的 ONE，等待和回答都出现在这张事情便利贴里。\n\n这里不调用真实模型，也不会扣电力。可以新开一件事，再切回这件事，检查等待是否跟对了任务。',createdAt:stamp}]};
  operations.set(body.operationId,conversation);await new Promise(resolve=>setTimeout(resolve,8500));const index=conversations.findIndex(c=>c.id===id);if(index>=0)conversations[index]=conversation;else conversations.unshift(conversation);result={conversation};
 }else if(path.startsWith('/api/chat/operations/'))result={conversation:operations.get(path.split('/').at(-1)!)};
 else if(path.startsWith('/api/conversations/')){const conversation=conversations.find(c=>c.id===path.split('/')[3]);if(method==='PATCH'&&conversation){if(typeof body.title==='string')conversation.title=body.title;if(typeof body.archived==='boolean')conversation.archived=body.archived;conversation.updatedAt=new Date().toISOString();}if(method==='DELETE'&&conversation)conversations.splice(conversations.indexOf(conversation),1);result={conversation};}
 else if(path==='/api/features'){const cat=url.searchParams.get('category'),q=(url.searchParams.get('q')??'').toLowerCase(),scope=url.searchParams.get('scope'),page=Math.max(1,Number(url.searchParams.get('page'))||1);const items=catalog.filter(f=>(scope!=='mine'||f.access!=='locked')&&(!cat||cat==='all'||f.category===cat)&&(f.name+' '+f.description).toLowerCase().includes(q));result={items:items.slice((page-1)*10,page*10),total:items.length};}
 else if(path.startsWith('/api/features/')){const feature=catalog.find(f=>f.id===decodeURIComponent(path.split('/')[3]));if(!feature)return reply({error:'演示功能不存在'},404);result={...feature,usageMultiplier:.6,sources:fixtureSources.map(source=>({id:source.id,name:source.name}))};}
 else if(path==='/api/attention')result={timeZone:'Asia/Shanghai',settings:null,sources:[],notices:[]};
 else if(path==='/api/me/context-preferences')result={saved:null,current:{timeZone:'Asia/Shanghai'}};
 else return reply({error:'本地预览未启用此接口'},404);
 return reply(result);
};
// Native links do not go through window.fetch. Keep synthetic file/public-link
// clicks inside this fixture too, so a download cannot reach the Vite API proxy.
if(!realService){
 // Density QA includes visual result cards for layout only. Catch their opener
 // before React creates its authenticated URL iframe; synthetic QA must never
 // fall through to the development server's API proxy.
 if(densityQA)document.addEventListener('click',event=>{
  const button=event.target instanceof Element?event.target.closest('button'):null;
  if(!button?.closest('.welcome-guide-card'))return;
  event.preventDefault();event.stopImmediatePropagation();
  logRequest('OPEN','/fixture/density-result-card');
  const note=document.getElementById('fixture-density-result-notice')||document.createElement('output');note.id='fixture-density-result-notice';note.textContent='这是本地合成成果卡，仅用于检查阅读空间；没有打开真实成果或访问服务器。';note.setAttribute('role','status');note.style.cssText='position:fixed;z-index:10001;bottom:20px;left:50%;transform:translateX(-50%);max-width:80vw;padding:12px 20px;border-radius:18px;background:#263743;color:#fff;font:13px system-ui';document.body.append(note);setTimeout(()=>note.remove(),4000);
 },true);
 const fixtureLink=(event:MouseEvent)=>{
  const link=event.target instanceof Element?event.target.closest<HTMLAnchorElement>('a[href]'):null;if(!link)return;
  const target=new URL(link.href,location.href);if(target.origin!==location.origin||(!target.pathname.startsWith('/api/')&&!target.pathname.startsWith('/s/fixture-one-')))return;
  event.preventDefault();event.stopImmediatePropagation();
  if(target.pathname.startsWith('/s/fixture-one-')){logRequest('OPEN',target.pathname);const note=document.getElementById('fixture-link-notice')||document.createElement('output');note.id='fixture-link-notice';note.textContent='本地演示分享链接已打开；没有发布到外网，也不会调用模型。';note.setAttribute('role','status');note.style.cssText='position:fixed;z-index:10001;bottom:20px;left:50%;transform:translateX(-50%);padding:12px 20px;border-radius:18px;background:#263743;color:#fff;font:13px system-ui';document.body.append(note);setTimeout(()=>note.remove(),4000);return;}
  void window.fetch(target.pathname+target.search).then(async response=>{if(!response.ok)return;const blob=await response.blob(),href=URL.createObjectURL(blob),download=document.createElement('a');download.href=href;download.download=link.download||'ONE 本地演示文件.txt';download.click();setTimeout(()=>URL.revokeObjectURL(href),1000);});
 };
 document.addEventListener('click',fixtureLink,true);document.addEventListener('auxclick',fixtureLink,true);
}
if(designStudy&&!realService){
 const guideButton=document.createElement('button');guideButton.id='fixture-onboarding-preview';guideButton.type='button';guideButton.textContent='新人引导';guideButton.setAttribute('aria-label','打开 ONE 新人引导效果预览');
 guideButton.style.cssText='position:fixed;top:8px;right:18px;z-index:10000;min-height:30px;padding:5px 13px;border:1px solid #25344524;border-radius:20px;background:#273743;color:#f4f6f8;font:12px system-ui;cursor:pointer';
 guideButton.onclick=()=>window.dispatchEvent(new Event('one-onboarding-preview'));document.body.append(guideButton);
}
await import('/src/main.tsx');
const badge=document.createElement('div');badge.textContent='本地预览 · 演示数据 · 不计费';badge.style.cssText='position:fixed;bottom:8px;left:14px;z-index:9999;font:10px sans-serif;color:#88907e;pointer-events:none';document.body.append(badge);

// Opt-in local QA only. Observe animation updates; never call external services.
if (new URLSearchParams(location.search).has('motionMetrics')) {
 const stamp=document.createElement('output');stamp.id='motion-metrics';stamp.hidden=true;document.body.append(stamp);
 let frames=0,last=0,intervals:number[]=[];
 const setup=()=>{
  const surface=document.querySelector('[data-one-fluid-surface]');if(!surface)return;
  const observer=new MutationObserver(()=>{
   const now=performance.now();if(last&&now-last<80)intervals.push(now-last);last=now;frames++;
   if(intervals.length>2000)intervals=intervals.slice(-2000);
   const sorted=[...intervals].sort((a,b)=>a-b);
   stamp.textContent=JSON.stringify({frames,samples:intervals.length,medianMs:sorted[Math.floor(sorted.length*.5)]||0,p95Ms:sorted[Math.floor(sorted.length*.95)]||0});
  });observer.observe(surface,{attributes:true,subtree:true});
  return observer;
 };
 const mounts=new MutationObserver(()=>{if(setup())mounts.disconnect();});mounts.observe(document.getElementById('root')!,{childList:true,subtree:true});
 if(setup())mounts.disconnect();
}

// Local review controls only; this is not an account/theme preference UI.
const materialTools=document.createElement('label');materialTools.className='material-preview-tools';materialTools.textContent='材质对比';
const materialSelect=document.createElement('select');materialSelect.setAttribute('aria-label','预览材质');
for(const [value,label] of [['optical','轻透玻璃（本次）'],['metal','液银宽边'],['glass','昼光玻璃'],['mist','明雾玻璃'],['titanium','暖钛'],['smoke','烟银玻璃']]){
 const option=document.createElement('option');option.value=value;option.textContent=label;materialSelect.append(option);
}
const initialMaterial=new URLSearchParams(location.search).get('material');materialSelect.value=['metal','glass','titanium','mist','smoke'].includes(initialMaterial||'')?initialMaterial!:'optical';
materialSelect.addEventListener('change',()=>{
 const next=new URL(location.href);next.searchParams.set('material',materialSelect.value);history.replaceState(null,'',next);
 document.querySelector('main.one-fluid-workspace')?.setAttribute('data-fluid-material',materialSelect.value);
});
materialTools.append(materialSelect);document.body.append(materialTools);
const accentSelect=document.createElement('select');accentSelect.setAttribute('aria-label','预览副色');
for(const [value,label] of [['solar','日光黄'],['iris','鸢尾紫'],['jade','玉青']]){const option=document.createElement('option');option.value=value;option.textContent=label;accentSelect.append(option);}
const initialAccent=new URLSearchParams(location.search).get('accent');accentSelect.value=initialAccent==='iris'||initialAccent==='jade'?initialAccent:'solar';
accentSelect.addEventListener('change',()=>{const next=new URL(location.href);next.searchParams.set('accent',accentSelect.value);history.replaceState(null,'',next);window.dispatchEvent(new Event('one-fluid-accent-preview'));});
materialTools.append(accentSelect);
if(densityQA){document.body.classList.add('one-density-qa');badge.hidden=false;}
if(designStudy){
 materialTools.classList.add('design-study-tools');
 // A comparison bar lives outside the product's reading surface. Changing the
 // scene updates the existing app; drafts, scroll, and open panels stay mounted.
 const studyBar=document.createElement('nav');studyBar.className='one-design-study-bar';studyBar.setAttribute('aria-label','整页风格对照');
 const title=document.createElement('span');title.textContent='ONE · 整页视觉对照';studyBar.append(title);
 const scenes=[['silver','浅银光场'],['graphite','石墨框景']];
 for(const [value,label] of scenes){
  const button=document.createElement('button');button.type='button';button.textContent=label;button.dataset.scene=value;button.setAttribute('aria-pressed',String((new URLSearchParams(location.search).get('scene')||profile.appearance?.scene||'graphite')===value));
  button.onclick=()=>{const next=new URL(location.href);next.searchParams.set('scene',value);history.replaceState(null,'',next);window.dispatchEvent(new Event('one-fluid-scene-preview'));for(const b of studyBar.querySelectorAll<HTMLButtonElement>('[data-scene]'))b.setAttribute('aria-pressed',String(b.dataset.scene===value));};
  studyBar.append(button);
 }
 const syncScene=()=>{const value=document.querySelector('main.one-fluid-workspace')?.getAttribute('data-fluid-scene');if(value)for(const button of studyBar.querySelectorAll<HTMLButtonElement>('[data-scene]'))button.setAttribute('aria-pressed',String(button.dataset.scene===value));};
 new MutationObserver(syncScene).observe(document.getElementById('root')!,{subtree:true,attributes:true,attributeFilter:['data-fluid-scene']});
 const pair=document.createElement('button');pair.type='button';pair.textContent='展开任务与本机';pair.onclick=()=>{for(const kind of ['activity','local']){const button=document.querySelector<HTMLButtonElement>(`[data-fluid-trigger="${kind}"]`);if(button?.getAttribute('aria-expanded')==='false')button.click();}};studyBar.append(pair);
 const local=document.createElement('button');local.type='button';local.textContent='演示执行态';
 local.onclick=()=>{
  const old=localRuns.find(t=>t.id==='study-local');
  if(old?.status==='running'){old.status='completed';old.updatedAt=new Date().toISOString();old.finalResponse='本地视觉演示结束，没有操作任何设备或文件。';local.textContent='演示执行态';return;}
  const now=new Date().toISOString(),cid='study-device';
  if(!conversations.some(c=>c.id===cid))conversations.push({id:cid,userId:user.id,modelId:'preview-model',title:'本机执行 · 视觉演示',archived:false,createdAt:now,updatedAt:now,messages:[]});
  if(old)Object.assign(old,{status:'running',updatedAt:now});
  else localRuns.push({id:'study-local',workspaceId:'preview',userId:'preview',deviceId:'fixture',conversationId:cid,sourceMessageId:'study-user-2',instruction:'仅检查执行态的材质和对比，不操作设备。',status:'running',provider:'codex',createdAt:now,updatedAt:now});
  local.textContent='结束执行演示';
 };
 studyBar.append(local);
 const note=document.createElement('small');note.textContent='本地演示 · 不操作设备 · 不计费';studyBar.append(note);
 document.body.classList.add('one-design-study');document.body.append(studyBar);badge.hidden=true;
}
const reviewStyle=document.createElement('style');reviewStyle.textContent=`
.material-preview-tools{position:fixed;z-index:9999;top:18px;right:24px;display:flex;align-items:center;gap:8px;width:max-content;white-space:nowrap;min-height:28px;padding:2px 8px 2px 12px;border:1px solid #ffffff24;border-radius:20px;background:#1b232ef2;color:#e7edf3;font:11px system-ui;box-shadow:0 2px 8px #00000012}
.material-preview-tools select{width:104px;flex:none;min-height:28px;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;cursor:pointer}
.material-preview-tools > button{flex:none;min-height:26px;padding:2px 8px;border:1px solid #ffffff24;border-radius:12px;background:#ffffff0b;color:#f2d252;font:inherit;cursor:pointer}
.material-preview-tools option{background:#f1f5f8;color:#17232e}
.material-preview-tools select:focus-visible{outline:2px solid #f0cf48;outline-offset:1px}
.one-design-study .design-study-tools{display:none}
.one-design-study #root > main.one-fluid-workspace{height:calc(100dvh - 46px);margin-top:46px}
.one-design-study #root main.one-fluid-workspace[data-fluid-desktop="true"] .studio-layout.fluid-canvas{height:calc(100dvh - 70px)}
.one-design-study-bar{position:fixed;inset:0 0 auto;z-index:9999;display:flex;align-items:center;gap:6px;height:46px;padding:0 18px;background:#d8dfe6;color:#263441;border-bottom:1px solid #25344516;font:12px system-ui}
.one-design-study-bar > span{font-weight:600;margin-right:12px}
.one-design-study-bar button{width:auto;min-height:30px;padding:5px 12px;border:1px solid transparent;border-radius:20px;background:transparent;color:inherit;font:inherit;cursor:pointer;white-space:nowrap}
.one-design-study-bar button[data-scene][aria-pressed="true"]{background:#273743;color:#f3f6f8;box-shadow:0 1px 3px #00000015}
.one-design-study-bar button:not([aria-pressed="true"]):hover{background:#ffffff60}
.one-design-study-bar button:focus-visible{outline:2px solid #6d570e;outline-offset:1px}
.one-design-study-bar small{margin-left:auto;font-size:10px;color:#536574;white-space:nowrap}
/* Match production's real viewport budget; comparison tooling must not create
   a fake 46px loss when measuring the density regression. */
.one-density-qa .one-design-study-bar,.one-density-qa #fixture-onboarding-preview{display:none}
.one-density-qa #root > main.one-fluid-workspace{height:100dvh;margin-top:0}
.one-density-qa #root main.one-fluid-workspace[data-fluid-desktop="true"] .studio-layout.fluid-canvas{height:calc(100dvh - 24px)}
@media(max-width:1099px){.material-preview-tools{top:auto;bottom:8px;right:12px}}
`;document.head.append(reviewStyle);

if(new URLSearchParams(location.search).has('flowPreview')){
 const pair=document.createElement('button');pair.textContent='同时分裂';pair.className='flow-pair-preview';pair.type='button';pair.setAttribute('aria-label','演示两个泡泡同时出现');
 pair.onclick=()=>{for(const kind of ['activity','local']){const target=document.querySelector<HTMLButtonElement>(`[data-fluid-trigger="${kind}"]`);if(target?.getAttribute('aria-expanded')==='false')target.click();}};
 materialTools.prepend(pair);
 const metrics=document.createElement('output');metrics.id='flow-metrics';metrics.hidden=true;document.body.append(metrics);
 let origin=0,samples:any[]=[];
 const track=new MutationObserver(()=>{
  const surface=document.querySelector<HTMLElement>('[data-one-fluid-surface]');if(!surface)return;
  const activity=Number(surface.dataset.activityProgress||0),local=Number(surface.dataset.localProgress||0);
  if(!origin&&(activity>0||local>0))origin=performance.now();
  if(origin&&samples.length<300)samples.push({ms:Math.round(performance.now()-origin),activity,local});
  metrics.textContent=JSON.stringify(samples);
 });track.observe(document.getElementById('root')!,{subtree:true,attributes:true,attributeFilter:['data-activity-progress','data-local-progress']});
}

if(new URLSearchParams(location.search).has('flowPreview')){
 const count=document.createElement('output');count.id='flow-layout-metrics';count.hidden=true;document.body.append(count);let writes=0;
 const start=new MutationObserver(()=>{const log=document.querySelector('.studio-assistant');if(!log)return;start.disconnect();const observer=new MutationObserver(records=>{writes+=records.length;count.textContent=String(writes);});observer.observe(log,{attributes:true,subtree:true,attributeFilter:['style']});});start.observe(document.getElementById('root')!,{childList:true,subtree:true});
}

if(new URLSearchParams(location.search).has('layoutQA')){
 const proof=document.createElement('output');proof.id='flow-line-proof';proof.hidden=true;document.body.append(proof);
 const check=document.createElement('button');check.type='button';check.textContent='检查排布';check.setAttribute('aria-label','检查文字排布');materialTools.prepend(check);
 check.onclick=()=>{
  const clip=document.querySelector('.coordinator-messages')?.getBoundingClientRect();
  const panels=[...document.querySelectorAll('.fluid-activity-panel[data-open="true"],.fluid-local-panel[data-open="true"]')].map(el=>el.getBoundingClientRect());
  const lines:any[]=[],overlap:any[]=[];
  for(const p of document.querySelectorAll('.coordinator-message p')){
   const tree=document.createTreeWalker(p,NodeFilter.SHOW_TEXT),rows=new Map<number,any>();let t:Node|null;
   while(t=tree.nextNode())for(let i=0;i<(t.textContent||'').length;i++){
    const r=document.createRange();r.setStart(t,i);r.setEnd(t,i+1);const b=r.getBoundingClientRect();
    if(!clip||b.bottom<clip.top||b.top>clip.bottom)continue;
    const key=Math.round(b.top),row=rows.get(key)||{top:b.top,left:b.left,right:b.right,bottom:b.bottom};row.right=Math.max(row.right,b.right);row.left=Math.min(row.left,b.left);rows.set(key,row);
    if(panels.some(box=>b.right>box.left&&b.left<box.right&&b.bottom>box.top&&b.top<box.bottom))overlap.push({text:t.textContent![i],box:b.toJSON()});
   }
   lines.push([...rows.values()]);
  }
  proof.textContent=JSON.stringify({lines,overlap});
 };
}
