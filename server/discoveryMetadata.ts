/** Official routing hints, not grants or executable instructions. */
export type DiscoveryMetadata = {
  industries?: string[];
  scenarios?: string[];
  aliases?: string[];
  avoidWhen?: string;
};

export function validateDiscoveryMetadata(raw: unknown): DiscoveryMetadata | undefined {
  if (raw === undefined) return;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('能力发现信息无效');
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some(key => !['industries', 'scenarios', 'aliases', 'avoidWhen'].includes(key))) throw new Error('能力发现只支持行业、场景、别名和不适用说明');
  const result: DiscoveryMetadata = {};
  for (const key of ['industries', 'scenarios', 'aliases'] as const) {
    const list = value[key];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.length > 12 || list.some(item => typeof item !== 'string' || !item.trim() || item.length > 60)) throw new Error('每组最多填写 12 个关键词，每项不超过 60 字');
    result[key] = [...new Set(list.map(item => item.trim()))];
  }
  if (value.avoidWhen !== undefined) {
    if (typeof value.avoidWhen !== 'string' || value.avoidWhen.length > 500) throw new Error('不适用说明最多 500 字');
    result.avoidWhen = value.avoidWhen.trim();
  }
  return result;
}
