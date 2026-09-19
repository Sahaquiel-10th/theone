export function CacheUsageDetails({ row }: { row: { cacheUsage?: { read: number; write: number; write5m: number; write1h: number }; cachePricesSnapshot?: { read: number; write: number; write1h: number } } }) {
  const c = row.cacheUsage, p = row.cachePricesSnapshot;
  if (!c) return null;
  return <div className="cache-usage-details"><p>缓存读取 {c.read} · 缓存写入 {c.write} Token</p><p>写入明细：5 分钟 {c.write5m} · 1 小时 {c.write1h} · 未分时长 {c.write - c.write5m - c.write1h}</p>{p ? <p>缓存单价：读取 {p.read} / 基础写入 {p.write} / 1 小时写入 {p.write1h} 电力 / 百万 Token</p> : <p>此调用未配置缓存价格</p>}</div>;
}
