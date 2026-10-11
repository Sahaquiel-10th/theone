import type { Database, PowerAccount, RechargeOrder } from './types.js';
import { companyWorkspace } from './enterprisePolicy.js';
import { uid } from './security.js';

export type MembershipTier = 'standard' | 'premium';
export type MembershipProduct = { id: string; label: string; kind: 'membership' | 'key'; tier: MembershipTier; months: number; amountFen: number; monthlyMicros: number; version: number };
export type MembershipCatalog = { enabled: boolean; version: number; standardMonthlyFen: number; premiumMonthlyFen: number; standardMonthlyMicros: number; premiumMonthlyMicros: number; annualDiscountBps: number; standardKeyFen: number; premiumKeyFen: number; includedMonths: number };
export type MembershipPeriod = { id: string; orderId: string; tier: MembershipTier; startsAt: string; endsAt: string; grantedMicros: number; remainingMicros: number; version: number };
export type PowerHold = { id: string; walletMicros: number; periods: { id: string; amountMicros: number }[] };
export const trialCatalog: MembershipCatalog = { enabled: false, version: 1, standardMonthlyFen: 9900, premiumMonthlyFen: 29900, standardMonthlyMicros: 20e6, premiumMonthlyMicros: 70e6, annualDiscountBps: 2000, standardKeyFen: 99900, premiumKeyFen: 129900, includedMonths: 3 };
export function catalog(db: Database): MembershipCatalog { return db.settings.membershipBilling ?? { ...trialCatalog }; }
export function products(config: MembershipCatalog): MembershipProduct[] {
  return (['standard', 'premium'] as const).flatMap(tier => {
    const label = tier === 'standard' ? '普通会员' : '高级会员';
    const amountFen = tier === 'standard' ? config.standardMonthlyFen : config.premiumMonthlyFen;
    const monthlyMicros = tier === 'standard' ? config.standardMonthlyMicros : config.premiumMonthlyMicros;
    return [
      { id: `${tier}-monthly`, label: `${label} · 月付`, kind: 'membership' as const, tier, months: 1, amountFen, monthlyMicros, version: config.version },
      { id: `${tier}-annual`, label: `${label} · 年付`, kind: 'membership' as const, tier, months: 12, amountFen: Math.round(amountFen * 12 * (10000-config.annualDiscountBps)/10000), monthlyMicros, version: config.version },
      { id: `${tier}-key`, label: `ONE Key + ${config.includedMonths} 个月${label}`, kind: 'key' as const, tier, months: config.includedMonths, amountFen: tier === 'standard' ? config.standardKeyFen : config.premiumKeyFen, monthlyMicros, version: config.version }
    ];
  });
}
export function publishCatalog(db: Database, actorUserId: string, input: unknown) {
  if (!db.users.some(u=>u.id===actorUserId && u.role==='admin' && u.enabled)) throw new Error('需要管理员权限');
  const next = { ...catalog(db), ...(input as Partial<MembershipCatalog>), version: catalog(db).version+1 };
  if (typeof next.enabled !== 'boolean') throw new Error('启用状态无效');
  for (const key of ['standardMonthlyFen','premiumMonthlyFen','standardKeyFen','premiumKeyFen','standardMonthlyMicros','premiumMonthlyMicros'] as const) {
    if (!Number.isSafeInteger(next[key]) || next[key]<=0 || next[key]>1e10) throw new Error('价格和额度必须是有效正整数');
  }
  if (!Number.isSafeInteger(next.annualDiscountBps)||next.annualDiscountBps<0||next.annualDiscountBps>5000||!Number.isSafeInteger(next.includedMonths)||next.includedMonths<1||next.includedMonths>3) throw new Error('折扣或赠送时长无效');
  if(next.premiumMonthlyFen<next.standardMonthlyFen||next.premiumMonthlyMicros<next.standardMonthlyMicros||products(next).some(p=>p.amountFen>1000000))throw new Error('套餐等级或支付金额超出范围');
  // Whitelist fields: no unreviewed configuration may enter persisted settings.
  const config: MembershipCatalog = Object.fromEntries(Object.keys(trialCatalog).map(k=>[k,next[k as keyof MembershipCatalog]])) as MembershipCatalog;
  db.settings.membershipBilling=config;
  if(config.enabled)db.settings.rechargeCnyPerPower=7;
  db.auditLogs.push({ id:uid('aud'), actorUserId, action:'membership.catalog.published', targetType:'settings', details:{ config }, createdAt:new Date().toISOString() });
  return config;
}
export function membershipAccount(db: Database, scope: {workspaceId:string;userId:string}) {
  if(companyWorkspace(db,scope.workspaceId)) throw new Error('企业账户不使用个人会员');
  if(!db.users.some(u=>u.id===scope.userId&&u.enabled)||!db.workspaceMembers.some(m=>m.workspaceId===scope.workspaceId&&m.userId===scope.userId&&m.status!=='disabled')||!db.workspaces.some(w=>w.id===scope.workspaceId&&w.status==='active')) throw new Error('账号或空间不可用');
  const account=db.powerAccounts.find(a=>a.workspaceId===scope.workspaceId&&a.userId===scope.userId);
  if(!account)throw new Error('账户不存在');return account;
}
export function activePeriod(account: PowerAccount, at=Date.now()) {
  return account.membershipPeriods?.find(p=>Date.parse(p.startsAt)<=at&&Date.parse(p.endsAt)>at);
}
/** Calendar anniversaries use the original anchor, including Jan 31 -> Feb 28 -> Mar 31. */
export function monthAnniversary(anchor: number, months: number) {
  const offset=8*3600000; // Business calendar: Asia/Shanghai.
  const date=new Date(anchor+offset), day=date.getUTCDate();date.setUTCDate(1);date.setUTCMonth(date.getUTCMonth()+months);
  const last=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,0)).getUTCDate();date.setUTCDate(Math.min(day,last));return date.getTime()-offset;
}
export function grantMembership(db: Database, order: RechargeOrder, at=Date.now()) {
  const product=order.product;if(!product)throw new Error('订单不包含会员');
  const account=membershipAccount(db,order);
  if(account.membershipPeriods?.some(p=>p.orderId===order.id))return;
  const periods=account.membershipPeriods??=[];
  // Renewals queue behind the same tier; lower tiers queue behind already purchased premium.
  const starts=Math.max(at,...periods.filter(p=>product.tier==='standard'||p.tier==='premium').map(p=>Date.parse(p.endsAt)));
  const duration=monthAnniversary(starts,product.months)-starts;
  if(product.tier==='premium') {
    for(const p of periods.filter(p=>p.tier==='standard'&&Date.parse(p.endsAt)>starts)) {
      const start=Date.parse(p.startsAt), end=Date.parse(p.endsAt);
      p.startsAt=new Date(Math.max(start,starts)+duration).toISOString();
      p.endsAt=new Date(end+duration).toISOString();
    }
  }
  for(let i=0;i<product.months;i++) periods.push({id:`${order.id}:${i}`,orderId:order.id,tier:product.tier,startsAt:new Date(monthAnniversary(starts,i)).toISOString(),endsAt:new Date(monthAnniversary(starts,i+1)).toISOString(),grantedMicros:product.monthlyMicros,remainingMicros:product.monthlyMicros,version:product.version});
  account.updatedAt=new Date(at).toISOString();order.membershipActivatedAt=account.updatedAt;
  db.auditLogs.push({id:uid('aud'),workspaceId:order.workspaceId,action:'membership.activated',targetType:'recharge_order',targetId:order.id,details:{productId:product.id,startsAt:new Date(starts).toISOString(),months:product.months},createdAt:account.updatedAt});
}
export function activateKeyMembership(db:Database, scope:{workspaceId:string;userId:string}, orderId:string, at=Date.now()) {
  const order=db.rechargeOrders.find(o=>o.id===orderId&&o.workspaceId===scope.workspaceId&&o.userId===scope.userId);
  if(!order||order.status!=='paid'||order.product?.kind!=='key'||!order.fulfilledDeviceId) throw new Error('启动器套餐尚未交付');
  if(!db.oneKeyDevices.some(d=>d.id===order.fulfilledDeviceId&&d.workspaceId===scope.workspaceId&&d.userId===scope.userId&&d.status==='active'))throw new Error('启动器未绑定当前账号');
  grantMembership(db,order,at);return order;
}
export function membershipSummary(db:Database, scope:{workspaceId:string;userId:string}, at=Date.now()) {
  const account=membershipAccount(db,scope),current=activePeriod(account,at);
  const reserved=current ? (account.powerHolds??[]).flatMap(h=>h.periods).filter(p=>p.id===current.id).reduce((n,p)=>n+p.amountMicros,0):0;
  const remaining=current?Math.max(0,current.remainingMicros-reserved):0;
  const config=catalog(db);
  return {enabled:config.enabled,products:config.enabled?products(config):[],annualDiscountPercent:config.annualDiscountBps/100,active:current?{tier:current.tier,remainingPercent:Math.round(remaining/current.grantedMicros*1000)/10,resetsAt:current.endsAt}:null,
    purchasedBalanceCny:Math.floor(account.balanceMicros*7/1e4)/100,
    scheduled:account.membershipPeriods?.filter(p=>Date.parse(p.startsAt)>at).map(p=>({tier:p.tier,startsAt:p.startsAt,endsAt:p.endsAt}))??[],
    pendingKeys:db.rechargeOrders.filter(o=>o.workspaceId===scope.workspaceId&&o.userId===scope.userId&&o.product?.kind==='key'&&o.status==='paid'&&!o.membershipActivatedAt).map(o=>({id:o.id,label:o.product!.label,ready:!!o.fulfilledDeviceId}))};
}

/** Offline Key sales use the existing manual provisioning workflow, never a synthetic WeChat callback. */
export function recordKeySale(db:Database, actorUserId:string, input:{operationId:string;userId:string;workspaceId:string;productId:string;paymentReference:string}) {
  if(!db.users.some(u=>u.id===actorUserId&&u.role==='admin'&&u.enabled))throw new Error('需要管理员权限');
  membershipAccount(db,input);
  if(!/^[a-zA-Z0-9-]{16,80}$/.test(input.operationId)||typeof input.paymentReference!=='string'||input.paymentReference.trim().length<6||input.paymentReference.length>120)throw new Error('请填写已核验的收款凭据');
  const id=`KEY${input.operationId}`,existing=db.rechargeOrders.find(o=>o.id===id);
  if(existing){if(existing.userId!==input.userId||existing.workspaceId!==input.workspaceId||existing.product?.id!==input.productId||existing.externalPaymentReference!==input.paymentReference.trim())throw new Error('订单重试不一致');return existing;}
  const product=products(catalog(db)).find(p=>p.id===input.productId&&p.kind==='key');
  if(!catalog(db).enabled||!product)throw new Error('套餐尚未开放');
  if(db.rechargeOrders.some(o=>o.externalPaymentReference===input.paymentReference.trim()))throw new Error('收款凭据已入账');
  const timestamp=new Date().toISOString();
  const order:RechargeOrder={id,userId:input.userId,workspaceId:input.workspaceId,product:structuredClone(product),requestedMicros:0,amountCny:product.amountFen/100,cnyPerPowerSnapshot:7,status:'paid',createdAt:timestamp,paidAt:timestamp,externalPaymentReference:input.paymentReference.trim()};
  db.rechargeOrders.push(order);
  db.auditLogs.push({id:uid('aud'),workspaceId:input.workspaceId,actorUserId,action:'membership.key.offline_sale',targetType:'recharge_order',targetId:id,details:{productId:product.id,amountFen:product.amountFen,paymentReference:order.externalPaymentReference},createdAt:timestamp});return order;
}
