import { usagePower, usageDiscount, powerText, type PowerUsage } from "./usagePower";
export function CacheUsageDetails({ row }: { row: PowerUsage }) {
  const value = usagePower(row);
  const discount = usageDiscount(row);
  if (!value) return <p>{row.source === "fixed" || row.imagePowerPerCallSnapshot !== undefined ? "按次计费" : row.status === "waived" || row.status === "failed" ? "本次未扣费" : row.status === "pending" || row.status === "needs_review" || row.source === "unknown" ? "等待结算，暂不展示分项消耗" : "历史分项不可用，以实扣电力为准"}</p>;
  return <div className="cache-usage-details">
    {discount ? <p className="usage-discount"><span>官方参考 <s>{powerText(discount.reference)} 电力</s></span><strong>优惠期 ×{discount.multiplier} = {powerText(discount.discounted)} 电力</strong></p> : null}
    <p>输入 {powerText(value.input)} 电力 · 输出 {powerText(value.output)} 电力</p>
    {row.cacheUsage && row.cacheUsage.read + row.cacheUsage.write > 0 ? <details><summary>输入明细（含缓存）</summary><p>普通输入 {powerText(value.ordinary)} 电力</p><p>缓存读取 {powerText(value.read)} 电力</p><p>缓存写入 {powerText(value.write + value.write1h)} 电力</p></details> : null}
    {value.adjustment !== 0 ? <p>{value.adjustment < 0 ? "结算减免" : "结算调整"} {powerText(Math.abs(value.adjustment))} 电力</p> : null}
    <small>已按本次实际费率计算</small></div>;
}
