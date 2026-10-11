import type { Express, RequestHandler } from 'express';
import type { Store } from './db.js';
import { activateKeyMembership, catalog, membershipSummary, products, publishCatalog, recordKeySale } from './memberships.js';
import { uid } from './security.js';
import { publicPayment } from './payments.js';

export function installMembershipRoutes(app:Express, auth:readonly RequestHandler[], admin:readonly RequestHandler[], store:Store) {
  app.get('/api/me/membership',...auth,async(req,res)=>{
    try {res.json(membershipSummary(await store.read(),{workspaceId:req.workspaceId!,userId:req.user!.id}));}
    catch {res.status(400).json({error:'当前账户不使用个人会员'});}
  });
  app.post('/api/me/membership/activate',...auth,async(req,res)=>{
    try {const order=await store.mutate(db=>activateKeyMembership(db,{workspaceId:req.workspaceId!,userId:req.user!.id},String(req.body.orderId??'')));res.json({order:publicPayment(order)});}
    catch {res.status(400).json({error:'套餐未交付，或启动器未绑定当前账号'});}
  });
  app.get('/api/admin/membership',...admin,async(_req,res)=>{
    const db=await store.read();res.json({accounts:db.powerAccounts.filter(a=>a.membershipPeriods?.length).flatMap(a=>{try{const summary=membershipSummary(db,a);return [{userId:a.userId,workspaceId:a.workspaceId,username:db.users.find(u=>u.id===a.userId)?.username??a.userId,active:summary.active,scheduled:summary.scheduled}];}catch{return [];}}),config:catalog(db),products:products(catalog(db)),orders:db.rechargeOrders.filter(o=>o.product).slice(-100).reverse().map(o=>({...publicPayment(o),workspaceId:o.workspaceId,userId:o.userId,fulfilledDeviceId:o.fulfilledDeviceId}))});
  });
  app.post('/api/admin/membership/key-sales',...admin,async(req,res)=>{
    try {const order=await store.mutate(db=>recordKeySale(db,req.user!.id,req.body));res.json({order:publicPayment(order)});}
    catch {res.status(400).json({error:'请核对账号、空间、套餐及已到账的收款凭据'});}
  });
  app.put('/api/admin/membership' ,...admin,async(req,res)=>{
    try {const config=await store.mutate(db=>publishCatalog(db,req.user!.id,req.body));res.json({config,products:products(config)});}
    catch {res.status(400).json({error:'会员配置无效，请核对价格、额度、折扣和赠送时长'});}
  });
  app.post('/api/admin/membership/orders/:id/fulfill',...admin,async(req,res)=>{
    try {
      const result=await store.mutate(db=>{
        const order=db.rechargeOrders.find(o=>o.id===req.params.id&&o.status==='paid'&&o.product?.kind==='key');
        const device=db.oneKeyDevices.find(d=>d.id===req.body.deviceId&&d.status==='active');
        if(!order||!device||device.workspaceId!==order.workspaceId||device.userId!==order.userId)throw new Error('账号不匹配');
        if(order.fulfilledDeviceId){if(order.fulfilledDeviceId!==device.id)throw new Error('已交付');return order;}
        if(db.rechargeOrders.some(o=>o.id!==order.id&&o.fulfilledDeviceId===device.id))throw new Error('设备已用于交付');
        order.fulfilledDeviceId=device.id;
        db.auditLogs.push({id:uid('aud'),workspaceId:order.workspaceId,actorUserId:req.user!.id,action:'membership.key.fulfilled',targetType:'recharge_order',targetId:order.id,details:{deviceId:device.id},createdAt:new Date().toISOString()});return order;
      });res.json({order:publicPayment(result)});
    } catch {res.status(400).json({error:'只能交付给订单所属账号的有效启动器'});}
  });
}
