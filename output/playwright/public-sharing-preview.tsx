import {createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {PublicSharingPage} from '../../src/PublicSharing';
import '../../src/styles.css';
import '../../src/one-settings.css';
import '../../src/one-product.css';

// This dedicated entry renders the real visitor component against an isolated
// synthetic contract. Every fetch is denied unless explicitly handled here.
const slug='fixture-ux-public',base=`/api/sharing/${slug}`,runs:any[]=[];
const stamp=new Date().toISOString();
const reply=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json','X-ONE-Preview':'synthetic'}});
window.fetch=async(input,options={})=>{
 const url=new URL(typeof input==='string'?input:input instanceof Request?input.url:input.toString(),location.origin);
 if(url.origin!==location.origin)return reply({error:'合成预览不会连接外部服务。'},403);
 const method=(options.method||(input instanceof Request?input.method:'GET')).toUpperCase();let body:any={};
 if(typeof options.body==='string'){try{body=JSON.parse(options.body);}catch{return reply({error:'合成请求格式无效。'},400);}}
 if(url.pathname===base&&method==='GET')return reply({name:'项目整理助手',authorName:'本地合成作者',description:'把散乱想法整理成清楚的工作步骤。此页仅供界面验收。',service:{mode:'knowledge',welcome:'你好，先说说你现在想整理的一件事。',starterQuestions:['帮我梳理一个项目的步骤','如何整理会议后的待办？']},attachments:false,version:1,visitorPercent:0,requireLogin:false,paymentEnabled:false});
 if(url.pathname===base+'/sessions'&&method==='POST')return reply({token:'DEMO_ONLY_UX_PUBLIC_SESSION'});
 if(url.pathname===base+'/session'&&method==='GET')return reply({items:[...runs].reverse(),total:runs.length});
 if(url.pathname===base+'/service'&&method==='GET')return reply({access:'open',paymentMode:'disabled',plans:[],intakeFields:[]});
 if(url.pathname===base+'/questions'&&method==='POST'){
  if(typeof body.content!=='string'||!body.content.trim())return reply({error:'请填写演示问题。'},400);
  let run=runs.find(item=>item.operationId===body.operationId);
  if(!run){run={id:`fixture-public-run-${runs.length+1}`,operationId:body.operationId,content:body.content,status:'completed',response:'## 可以从这三步开始\n\n1. **明确目标**：写下你要解决的具体问题。\n2. **整理输入**：把已确认的信息放在一起。\n3. **核对下一步**：按优先级拆成可以执行的小任务。\n\n这是本地合成回答，没有调用模型或读取资料。',createdAt:stamp,chargedMicros:0,heldMicros:0,artifacts:[]};runs.push(run);}
  return reply({id:run.id,run});
 }
 if(url.pathname==='/api/visitors/me')return reply({error:'本地合成访客页没有登录真实账号。'},401);
 return reply({error:'本地预览未启用此操作，不会发送到真实服务。'},409);
};
document.documentElement.dataset.onePreviewMode='synthetic';
createRoot(document.getElementById('root')!).render(createElement(PublicSharingPage,{slug}));
