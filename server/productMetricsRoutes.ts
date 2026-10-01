import type {Express,RequestHandler} from 'express';
import type {Store} from './db.js';
import {asyncRoute} from './middleware.js';
import {productMetrics} from './productMetrics.js';
import {uid} from './security.js';
export function installProductMetricsRoutes(app:Express,admin:readonly RequestHandler[],store:Store){
  app.get('/api/admin/product-metrics',...admin,asyncRoute(async(req,res)=>{
    const metrics=productMetrics(await store.read()),page=Math.max(1,Math.min(100000,Math.floor(Number(req.query.page)||1))),q=String(req.query.q??'').slice(0,100).toLowerCase(),filter=String(req.query.filter??'all');
    const rows=metrics.users.filter(u=>u.username.toLowerCase().includes(q)&&(filter==='all'||filter==='low-balance'&&u.lowBalance||filter==='paid'&&u.rechargeCount>0||u.state===filter));
    res.setHeader('Cache-Control','no-store');res.json({...metrics,users:{items:rows.slice((page-1)*20,page*20),total:rows.length,page,pageSize:20}});
  }));
  app.get('/api/admin/product-metrics/export',...admin,asyncRoute(async(_req,res)=>{
    const m=productMetrics(await store.read());
    const rows=[['日期（北京时间）','有效活跃账号','新账号','自主注册','微信到账充值金额（非收入）','充值人数'],...m.daily.map(d=>[d.date,d.activeUsers,d.newAccounts,d.newSelfRegistered,d.rechargeCny,d.payingUsers])];
    res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','text/csv; charset=utf-8');res.setHeader('Content-Disposition','attachment; filename="one-product-metrics.csv"');res.send('\uFEFF'+rows.map(r=>r.join(',')).join('\r\n'));
  }));
  app.post('/api/admin/product-metrics/exclusions',...admin,asyncRoute(async(req,res)=>{
    const {userId,excluded}=req.body??{};if(typeof userId!=='string'||typeof excluded!=='boolean'){res.status(400).json({error:'请选择账号及统计范围'});return;}
    const saved=await store.mutate(db=>{const user=db.users.find(u=>u.id===userId);if(!user)return false;user.analyticsExcluded=excluded;db.auditLogs.push({id:uid('aud'),workspaceId:user.defaultWorkspaceId,actorUserId:req.user!.id,action:'admin.metrics.exclusion.changed',targetType:'user',targetId:user.id,details:{excluded},createdAt:new Date().toISOString()});return true;});res.status(saved?200:404).json(saved?{ok:true}:{error:'账号不存在'});
  }));
}
