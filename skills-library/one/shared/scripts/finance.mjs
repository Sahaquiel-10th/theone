import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
// Round the decimal inputs, rather than binary floating point near half cents.
function decimal(n){const [mantissa,exponent='0']=String(n).split('e');const [whole,fraction='']=mantissa.split('.');return {digits:BigInt(whole+fraction),scale:fraction.length-Number(exponent)};}
function roundedProduct(a,b){const x=decimal(a),y=decimal(b),scale=x.scale+y.scale;let n=x.digits*y.digits;if(scale>0){const divisor=10n**BigInt(scale),remainder=n%divisor;n=n/divisor+(remainder*2n>=divisor?1n:0n);}else n*=10n**BigInt(-scale);if(n>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('金额超出精确计算范围');return Number(n);}
const cents = n => roundedProduct(n,100);
const money = n => {if(!Number.isSafeInteger(n))throw new Error('金额超出精确计算范围');return n/100;};
function number(v, name, max = 1e9) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > max) throw new Error(`${name}必须是 0–${max} 的数值`);
  return v;
}
function record(v, allowed) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !allowed.includes(k))) throw new Error('计算字段无效');
  return v;
}
export function calculateFinance(operation, input) {
  if (operation === 'profit') {
    const v = record(input,['revenue','variableCost','fixedCost','quantity']);
    const revenue = cents(number(v.revenue,'收入')), variable = cents(number(v.variableCost,'直接／变动成本')), fixed = cents(number(v.fixedCost,'固定费用'));
    const quantity = number(v.quantity,'业务量',1e7); if (!Number.isInteger(quantity) || quantity === 0) throw new Error('业务量必须是正整数');
    const contribution = revenue - variable, profit = contribution - fixed;
    return { revenue:money(revenue), variableCost:money(variable), fixedCost:money(fixed), contribution:money(contribution), operatingProfit:money(profit),
      contributionRate: revenue ? contribution / revenue : null, operatingProfitRate:revenue ? profit/revenue : null,
      contributionPerUnit:money(contribution)/quantity, breakEvenQuantity:contribution > 0 ? Math.ceil(fixed * quantity / contribution) : null,
      note:contribution > 0 ? '保本业务量假设项目组合、单次收入与变动成本不变；收入不等于利润。' : '单次贡献不为正，增加业务量无法按当前条件保本。' };
  }
  if (operation === 'promotion') {
    const v = record(input,['price','discount','variableCost','giftCost','channelRate','fixedCampaignCost','participants']);
    const price = cents(number(v.price,'原价')), discount = cents(number(v.discount,'优惠金额')), cost = cents(number(v.variableCost,'履约成本')), gift = cents(number(v.giftCost,'赠品成本'));
    const channelRate = number(v.channelRate,'渠道费率',1), fixed = cents(number(v.fixedCampaignCost,'活动固定投入')), count = number(v.participants,'预计参加人数',1e7);
    if (discount > price || !Number.isInteger(count)) throw new Error('优惠不能超过原价，参加人数必须是整数');
    const paid = price - discount, fee = roundedProduct(paid,channelRate), contribution = paid - cost - gift - fee;
    return { paidPrice:money(paid), channelFee:money(fee), contributionPerOrder:money(contribution), totalContribution:money(contribution*count),
      campaignProfit:money(contribution*count-fixed), breakEvenParticipants:contribution > 0 ? Math.ceil(fixed/contribution) : null,
      note:'这是给定成本与参加人数下的情景测算，不是获客量预测；不含未录入的税费与成本。' };
  }
  if (operation === 'quote') {
    const v = record(input,['items','shipping','taxRate','pricesIncludeTax','currency']);
    if (!Array.isArray(v.items) || !v.items.length || v.items.length > 200 || typeof v.pricesIncludeTax !== 'boolean') throw new Error('报价需要 1–200 行商品，并明确含税口径');
    const currency=v.currency??'人民币';if(!['人民币','美元','欧元'].includes(currency))throw new Error('报价币种无效');
    const rows = v.items.map((raw,i) => {
      const r = record(raw,['name','unit','quantity','unitPrice']);
      if (typeof r.name !== 'string' || !r.name.trim() || r.name.length>200 || typeof r.unit !== 'string' || !r.unit.trim() || r.unit.length>30) throw new Error(`第 ${i+1} 行名称或单位无效`);
      const quantity = number(r.quantity,'数量',1e6), unitPrice = cents(number(r.unitPrice,'单价',1e7));
      return {name:r.name.trim(),unit:r.unit.trim(),quantity,unitPrice:money(unitPrice),amount:money(roundedProduct(quantity,unitPrice))};
    });
    const subtotal = rows.reduce((n,r) => n+cents(r.amount),0), shipping=cents(number(v.shipping,'运费')), rate=number(v.taxRate,'税率',1), tax=v.pricesIncludeTax?0:roundedProduct(subtotal,rate);
    if (!Number.isSafeInteger(subtotal+shipping+tax)) throw new Error('报价金额超出计算范围');
    return {currency,taxRate:rate,rows,subtotal:money(subtotal),shipping:money(shipping),addedTax:money(tax),total:money(subtotal+shipping+tax),pricesIncludeTax:v.pricesIncludeTax,note:v.pricesIncludeTax?'商品单价已含税，未重复加税；运费按录入金额计。':'税额按商品小计计算，运费按录入金额计；需要其他税运口径时先调整输入。'};
  }
  throw new Error('不支持的计算类型');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(calculateFinance(process.argv[2],JSON.parse(readFileSync(process.argv[3],'utf8'))),null,2)); }
  catch (e) { console.error(e.message); process.exitCode=1; }
}
