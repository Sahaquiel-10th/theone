import express,{type Express,type RequestHandler} from 'express';
import type {Store} from './db.js';
import {asyncRoute} from './middleware.js';
import {signToken,verifyToken,hashPassword,verifyPassword,uid} from './security.js';
import {loginVisitor,registerVisitor,visitorUser,type VisitorIdentity} from './visitorAccounts.js';
import {availablePowerMicros,powerAccount} from './powerBilling.js';
import {SharingError} from './publicSharing.js';
import {installPaymentRoutes} from './paymentRoutes.js';
declare global{namespace Express{interface Request{visitor?:VisitorIdentity;}}}
export function visitorIdentity(db:Awaited<ReturnType<Store['read']>>,req:express.Request,secret:string):VisitorIdentity|undefined{
  const raw=req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith('one_visitor='))?.slice('one_visitor='.length);
  if(!raw)return;
  try{const payload=verifyToken(decodeURIComponent(raw),secret) as ReturnType<typeof verifyToken>&{version?:number};if(!payload||payload.scope!=='visitor'||!payload.workspaceId)return;
    const s={userId:payload.sub,workspaceId:payload.workspaceId},u=visitorUser(db,s);if((u.visitorAuthVersion??0)!==payload.version)return;return s;
  }catch{return;}
}
export function installVisitorRoutes(app:Express,store:Store,secret:string){
  const cookie=(res:express.Response,u?:ReturnType<typeof loginVisitor>)=>{const token=u?signToken({sub:u.id,scope:'visitor',workspaceId:u.defaultWorkspaceId,version:u.visitorAuthVersion??0},secret):'';res.setHeader('Set-Cookie',`one_visitor=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=${u?43200:0}${process.env.NODE_ENV==='production'?'; Secure':''}`);};
  const requireVisitor:RequestHandler=(req,res,next)=>{void store.read().then(db=>{const s=visitorIdentity(db,req,secret);if(!s){res.status(401).json({error:'请登录访客账号'});return;}if(req.headers['x-one-visitor']&&req.headers['x-one-visitor']!==s.userId){res.status(409).json({error:'账号已切换，请刷新后重新确认'});return;}req.visitor=s;req.user=visitorUser(db,s);req.workspaceId=s.workspaceId;next();}).catch(next);};
  const router=express.Router();
  const attempts=new Map<string,{count:number;registrations:number;until:number}>();let total=0,windowAt=Date.now();
  const limit:RequestHandler=(req,res,next)=>{const now=Date.now();if(now-windowAt>3600000){attempts.clear();total=0;windowAt=now;}const id=req.ip??'unknown',row=attempts.get(id)??{count:0,registrations:0,until:now+900000};if(row.until<now){row.count=0;row.until=now+900000;}if(row.count>=8||total>=500||(req.path==='/register'&&row.registrations>=4)||attempts.size>=2000&&!attempts.has(id)){res.status(429).json({error:'尝试较多，请稍后再试'});return;}row.count++;if(req.path==='/register')row.registrations++;total++;attempts.set(id,row);next();};
  router.post('/register',limit,asyncRoute(async(req,res)=>{const u=await store.mutate(db=>registerVisitor(db,req.body));cookie(res,u);res.json({user:{id:u.id,username:u.username}});}));
  router.post('/login',limit,asyncRoute(async(req,res)=>{const u=loginVisitor(await store.read(),req.body);cookie(res,u);res.json({user:{id:u.id,username:u.username}});}));
  router.post('/logout',(_req,res)=>{cookie(res);res.json({ok:true});});
  router.post('/password',requireVisitor,limit,asyncRoute(async(req,res)=>{
    const u=await store.mutate(db=>{
      const u=visitorUser(db,req.visitor!),{currentPassword,newPassword}=req.body??{};
      if(typeof currentPassword!=='string'||currentPassword.length>128||typeof newPassword!=='string'||newPassword.length<10||newPassword.length>128||!verifyPassword(currentPassword,u.passwordHash))throw new SharingError('当前密码错误，或新密码不符合 10–128 位要求',400);
      u.passwordHash=hashPassword(newPassword);u.visitorAuthVersion=(u.visitorAuthVersion??0)+1;
      db.auditLogs.push({id:uid('aud'),workspaceId:req.visitor!.workspaceId,actorUserId:u.id,action:'visitor.password.changed',targetType:'user',targetId:u.id,createdAt:new Date().toISOString()});return u;
    });cookie(res,u);res.json({ok:true});
  }));
  router.get('/me',requireVisitor,asyncRoute(async(req,res)=>{
    const db=await store.read(),s=req.visitor!,account=powerAccount(db,s.workspaceId,s.userId);res.json({user:{id:req.user!.id,username:req.user!.username},balanceMicros:account?.balanceMicros??0,availableMicros:availablePowerMicros(db,s.workspaceId,s.userId),paidBalanceMicros:account?.paidBalanceMicros??0,rechargeCnyPerPower:db.settings.rechargeCnyPerPower});
  }));
  router.use((e:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>res.status(e instanceof SharingError?e.status:400).json({error:e instanceof SharingError?e.message:'未能完成账号操作'}));app.use('/api/visitors',router);
  installPaymentRoutes(app,[requireVisitor],store,'/api/visitors');
  return requireVisitor;
}
