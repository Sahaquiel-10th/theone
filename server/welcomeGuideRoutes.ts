import fs from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import type {Express,RequestHandler} from 'express';
import type {Store} from './db.js';
import type {Attachment,Database} from './types.js';
import {accountInScope,BetaInputError,type AccountScope} from './betaProfile.js';
import {ownedAttachment} from './attachmentService.js';
import {asyncRoute} from './middleware.js';
import {renderWelcomeGuide,renderWelcomePoster} from './welcomeGuide.js';
import {visualPageCsp,renderVisualPage,renderVisualDiagram,visualDiagramHeight} from './visualDocument.js';

const digest=(token:string)=>createHash('sha256').update(token).digest('hex');
function fileInScope(db:Database,s:AccountScope,id:string){
  accountInScope(db,s);const f=ownedAttachment(db.attachments,s,id);
  const standalone=!!f.visualDocument&&db.chatOperations?.some(o=>o.workspaceId===s.workspaceId&&o.userId===s.userId&&o.conversationId===f.conversationId&&o.featureRun&&o.status==='completed');
  if((!f.welcomeGuide&&!f.visualDocument)||f.welcomeGuide&&f.kind!=='image'||f.visualDocument&&f.mimeType!=='text/html'||f.status!=='ready'||!db.conversations.some(c=>c.id===f.conversationId&&c.workspaceId===s.workspaceId&&c.userId===s.userId&&(!c.archived||standalone)))throw new BetaInputError('这份说明暂时不可用',404);
  return f;
}
async function dataImage(file:Attachment){
  if(!/^image\/(png|jpeg|webp)$/.test(file.mimeType)||file.size>25*1024*1024)throw new BetaInputError('说明图片格式不可用',422);
  const bytes=await fs.readFile(file.storagePath).catch(()=>{throw new BetaInputError('说明图片暂时没打开，稍后再试。',404);});if(bytes.length!==file.size)throw new BetaInputError('说明图片尚未就绪',404);
  return `data:${file.mimeType};base64,${bytes.toString('base64')}`;
}
function sharable(db:Database,s:AccountScope){
  const w=db.workspaces.find(w=>w.id===s.workspaceId)!;
  if(w.kind==='company'&&!w.company?.allowPublicSharing)throw new BetaInputError('公司暂未开放对外分享',403);
}
/** A narrow artifact surface: only server-created welcome facts, no arbitrary
 * HTML upload, prompt, knowledge body, file path or execution capability. */
export function installWelcomeGuideRoutes(app:Express,keyAuth:readonly RequestHandler[],store:Store){
  app.get('/api/welcome-pages/:id/view',...keyAuth,asyncRoute(async(req,res)=>{
    const f=fileInScope(await store.read(),{userId:req.user!.id,workspaceId:req.workspaceId!},String(req.params.id));
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Frame-Options','SAMEORIGIN');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',visualPageCsp("'self'"));
    res.type('html').send(f.visualDocument?renderVisualPage(f.visualDocument):renderWelcomeGuide(f.welcomeGuide!,await dataImage(f)));
  }));
  app.get('/api/welcome-pages/:id',...keyAuth,asyncRoute(async(req,res)=>{
    const s={userId:req.user!.id,workspaceId:req.workspaceId!},f=fileInScope(await store.read(),s,String(req.params.id));
    res.setHeader('Cache-Control','no-store');
    if(f.visualDocument){const doc=f.visualDocument;
      if(req.query.format==='poster')res.json({svg:renderVisualDiagram(doc),name:doc.title+'.svg',width:1920,height:visualDiagramHeight(doc)});
      else res.json({html:renderVisualPage(doc),name:doc.title+'.html',shared:false,shareable:false});return;
    }
    const image=await dataImage(f);
    if(req.query.format==='poster')res.json({svg:renderWelcomePoster(f.welcomeGuide!,image),name:`${f.welcomeGuide!.nickname}的 ONE 使用说明.svg`,width:1920,height:Number(/height="(\d+)"/.exec(renderWelcomePoster(f.welcomeGuide!,image))![1])});
    else res.json({html:renderWelcomeGuide(f.welcomeGuide!,image),name:`${f.welcomeGuide!.nickname}的 ONE 使用说明.html`,shared:!!f.welcomeShare&&Date.parse(f.welcomeShare.expiresAt)>Date.now()});
  }));
  app.post('/api/welcome-pages/:id/share',...keyAuth,asyncRoute(async(req,res)=>{
    if(req.body?.confirm!==true)throw new BetaInputError('请先确认分享称呼、说明图片和已连接平台名称。');
    const s={userId:req.user!.id,workspaceId:req.workspaceId!},token=randomBytes(24).toString('hex'),expiresAt=new Date(Date.now()+7*86400000).toISOString();
    await store.mutate(db=>{const f=fileInScope(db,s,String(req.params.id));if(!f.welcomeGuide)throw new BetaInputError('这份文件暂不支持公开分享',403);sharable(db,s);f.welcomeShare={hash:digest(token),expiresAt};});
    res.setHeader('Cache-Control','no-store');res.json({url:`/welcome/${token}`,expiresAt});
  }));
  app.delete('/api/welcome-pages/:id/share',...keyAuth,asyncRoute(async(req,res)=>{
    const s={userId:req.user!.id,workspaceId:req.workspaceId!};
    await store.mutate(db=>{fileInScope(db,s,String(req.params.id)).welcomeShare=undefined;});res.json({ok:true});
  }));
  const publicFile=async(token:string)=>{
    if(!/^[a-f0-9]{48}$/.test(token))throw new BetaInputError('分享不存在或已关闭',404);
    const db=await store.read(),f=db.attachments.find(f=>f.welcomeShare?.hash===digest(token)&&Date.parse(f.welcomeShare.expiresAt)>Date.now());
    if(!f)throw new BetaInputError('分享不存在或已关闭',404);
    try{fileInScope(db,f,f.id);sharable(db,f);}catch{throw new BetaInputError('分享不存在或已关闭',404);}
    return f;
  };
  app.get('/welcome/:token/poster.svg',asyncRoute(async(req,res)=>{
    const f=await publicFile(String(req.params.token));res.setHeader('Cache-Control','no-store');res.setHeader('Content-Security-Policy',"sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'");res.setHeader('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(f.welcomeGuide!.nickname+'的 ONE 使用说明.svg')}`);res.type('image/svg+xml').send(renderWelcomePoster(f.welcomeGuide!,await dataImage(f)));
  }));
  app.get('/welcome/:token',asyncRoute(async(req,res)=>{
    const token=String(req.params.token),f=await publicFile(token);
    res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Robots-Tag','noindex, nofollow');
    res.setHeader('Content-Security-Policy',visualPageCsp());
    res.type('html').send(renderWelcomeGuide(f.welcomeGuide!,await dataImage(f),`/welcome/${token}/poster.svg`));
  }));
}
