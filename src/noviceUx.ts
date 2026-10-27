import type { MembershipProduct } from '../server/memberships';

export const allowanceRules = '先使用本期会员额度，用完后使用永久电力。未使用的本期额度不累计，永久电力长期保留。充值与赠送电力不可提现，可提现收益单独标明。';
export function purchaseAction(product: MembershipProduct, currentTier?: string) {
  if (product.kind === 'key') return '购买启动器套餐';
  if (!currentTier) return '开通会员';
  if (currentTier === product.tier) return '续费';
  return product.tier === 'premium' ? '升级高级会员' : '预约普通会员';
}
export function purchaseTiming(product: MembershipProduct, currentTier?: string) {
  if (product.kind === 'key') return '启动器交付并绑定账号后，激活附赠会员。';
  if (!currentTier) return '支付成功后开通，会员额度按月更新。';
  if (product.tier === 'premium' && currentTier === 'standard') return '优先使用高级会员；普通会员剩余时间顺延保留。';
  return '新套餐接在已有会员之后生效，不会丢失剩余会员时间。';
}
export function monthlyAllowanceComparison(product: MembershipProduct, products: MembershipProduct[]) {
  const base = products.find(p => p.kind === 'membership' && p.tier === 'standard' && p.months === 1)?.monthlyMicros;
  if (!base || product.tier === 'standard') return '标准月额度';
  const ratio = product.monthlyMicros / base;
  return `${Number(ratio.toFixed(2))} 倍普通会员月额度`;
}
export function featureMention(text: string, cursor = text.length) {
  const match = text.slice(0, cursor).match(/(?:^|\s)@([^\s@]{0,50})$/u);
  return match ? { start: cursor - match[1].length - 1, end: cursor, query: match[1] } : null;
}
export function withoutFeatureMention(text: string, mention: ReturnType<typeof featureMention>) {
  // Never remove an unrelated or newer draft when an async picker returns.
  if (!mention || featureMention(text, mention.end)?.start !== mention.start || text.slice(mention.start + 1, mention.end) !== mention.query) return text;
  return text.slice(0, mention.start) + text.slice(mention.end);
}
export function transferStateLabel(state: string) {
  return ({ paused: '已暂停', queued: '排队中', selecting_target: '请选择工作文件夹', completed: '已完成', returned: '有新结果', needs_input: '需要你处理', partial: '部分完成', failed: '未完成', interrupted: '结果待核对', cancelled: '已停止' } as Record<string,string>)[state] || '正在处理';
}
