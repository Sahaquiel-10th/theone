import type { KnowledgeChunk } from './provider.js';

/** Server-owned calendar dates, anchored to the original request, not a retry. */
export type KnowledgeDateRange = {
  from: string;
  to: string;
  timeZone: string;
  anchorAt: string;
  basis: 'event' | 'created' | 'updated';
};
export type KnowledgeSearchOptions = { dateRange?: KnowledgeDateRange };
export type KnowledgeDateSearch = {
  method: 'native_date_filter' | 'semantic_date_hint';
  field?: 'created' | 'updated';
  filterApplied: boolean;
  filterDropped?: boolean;
  partial?: true;
  secondaryFailure?: 'timeout' | 'rate_limited' | 'unavailable';
  /** Recall and MCP result limits never establish an exhaustive date inventory. */
  complete: false;
};
export type KnowledgeSearchResult = { chunks: KnowledgeChunk[]; dateSearch?: KnowledgeDateSearch };

export function validCalendarDay(value: unknown): value is string {
  return typeof value === 'string' && /^20\d{2}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export function validKnowledgeDateRange(value: unknown): value is KnowledgeDateRange {
  if (!value || typeof value !== 'object') return false;
  const range = value as KnowledgeDateRange;
  if (!validCalendarDay(range.from) || !validCalendarDay(range.to) || range.from > range.to
    || !['event', 'created', 'updated'].includes(range.basis) || !Number.isFinite(Date.parse(range.anchorAt))) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: range.timeZone }).format(); return true; } catch { return false; }
}
export function dateSearchQuery(query: string, range: KnowledgeDateRange) {
  const prefix=`${range.from}${range.to!==range.from?` 至 ${range.to}`:''}`;
  let topic = query.replace(/\n所查事件日期：[\s\S]*$/, '').replace(/(?:昨天|昨日|前天|今天|今日)/g, '').trim();
  while(topic.startsWith(prefix))topic=topic.slice(prefix.length).trim();
  return `${prefix} ${topic}`.trim().slice(0, 1_200);
}

function metadataDay(value: string | undefined, timeZone: string) {
  if (!value) return undefined;
  // Some providers return wall-clock timestamps without an offset. Their date
  // is only a provider-calendar candidate; never parse it in the host timezone.
  if (/^20\d{2}-\d{2}-\d{2}(?:$|[ T]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)$/.test(value)) return value.slice(0, 10);
  if (!/[zZ]$|[+-]\d{2}:?\d{2}$/.test(value) || !Number.isFinite(Date.parse(value))) return undefined;
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value));
  return ['year', 'month', 'day'].map(key => parts.find(part => part.type === key)!.value).join('-');
}
function contentDates(chunk: KnowledgeChunk) {
  const dates = new Set<string>();
  const text = `${chunk.title}\n${chunk.content}`;
  for (const match of text.matchAll(/(?<!\d)(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:日)?(?!\d)/g)) {
    const day = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
    if (validCalendarDay(day)) dates.add(day);
  }
  return [...dates];
}

/** Date evidence is explicit. A newly-created note is not proof of a yesterday meeting. */
export function datedKnowledgeChunks(chunks: KnowledgeChunk[], range: KnowledgeDateRange) {
  let outsideRange = 0, unverified = 0, confirmed = 0, candidates = 0;
  const retained: KnowledgeChunk[] = [];
  const within = (day: string | undefined) => Boolean(day && day >= range.from && day <= range.to);
  for (const chunk of chunks) {
    const created = metadataDay(chunk.createdAt, range.timeZone), updated = metadataDay(chunk.updatedAt, range.timeZone);
    const dates = contentDates(chunk), event = dates.find(within);
    const metadata = range.basis === 'updated' ? updated : created;
    if (range.basis === 'event' && event) {
      confirmed++; retained.push({ ...chunk, dateEvidence: { basis: 'event', date: event, status: 'requires_content_verification' } });
    } else if (within(metadata)) {
      candidates++; retained.push({ ...chunk, dateEvidence: { basis: range.basis === 'updated' ? 'updated' : 'created', date: metadata!, status: range.basis === 'event' ? 'metadata_candidate_only' : 'metadata_match' } });
    } else if (metadata || dates.length) outsideRange++;
    else unverified++;
  }
  return { chunks: retained, confirmed, candidates, outsideRange, unverified };
}
