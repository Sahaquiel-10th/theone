import type { api as Api } from './oneApi';
import type { FeatureChoice } from './preview/FeatureShelf';

export const COMPOSER_SUGGESTION_LIMIT = 3;
export const COMPOSER_SUGGESTION_CATALOG_PAGES = 50;
const CATALOG_PAGE_SIZE = 10;
const genericTerms = new Set(['一个', '一些', '一下', '帮我', '帮忙', '可以', '需要', '想要', '我要', '怎么', '什么', '这个', '那个', '这些', '那些', '内容', '功能', '任务', '使用', '进行', '相关', '一下子', '然后', '今天', '明天', '昨天']);

export type ComposerFeatureSuggestion = { feature: FeatureChoice; keyword: string; score: number };
export type ComposerFeatureSuggestionMatch = { key: string; items: ComposerFeatureSuggestion[] };
export type ComposerSuggestionCatalog = { api: typeof Api; scopeKey: string; items: FeatureChoice[] };

/** Scope identity is checked during render, not only by eventual effect cleanup. */
export function composerSuggestionCatalogForScope(catalog: ComposerSuggestionCatalog | null, api: typeof Api, scopeKey: string, enabled: boolean): readonly FeatureChoice[] {
  return enabled && scopeKey && catalog?.api === api && catalog.scopeKey === scopeKey ? catalog.items : [];
}

function normalize(value: string) { return value.normalize('NFKC').toLocaleLowerCase(); }
function wordMatch(value: string, word: string) {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`, 'u').test(value);
}

/** Only the word being typed is relevant. An earlier mention of a feature does
 * not keep suggestions pinned above the composer through the rest of a draft. */
export function composerFeatureSuggestionTerms(text: string, cursor = text.length): string[] {
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > text.length) return [];
  const before = normalize(text.slice(0, cursor));
  if (/(?:^|\s)@[^\s@]*$/u.test(before)) return [];
  // Do not treat moving the caret into the middle of an existing word as typing.
  if (/[\p{L}\p{N}_]/u.test(text.charAt(cursor))) return [];
  const token = before.match(/[\p{L}\p{N}_-]+$/u)?.[0] ?? '';
  if (!token) return [];
  if (/^[a-z][a-z0-9_-]*$/u.test(token)) return token.length >= 3 && token.length <= 40 ? [token] : [];
  const han = token.match(/\p{Script=Han}+$/u)?.[0] ?? '';
  const terms: string[] = [];
  for (let length = Math.min(12, han.length); length >= 2; length--) {
    const term = han.slice(-length);
    if (!genericTerms.has(term)) terms.push(term);
  }
  return terms;
}

export function matchComposerFeatureSuggestions(features: readonly FeatureChoice[], text: string, cursor = text.length, limit = COMPOSER_SUGGESTION_LIMIT): ComposerFeatureSuggestionMatch {
  const terms = composerFeatureSuggestionTerms(text, cursor);
  const items: ComposerFeatureSuggestion[] = [];
  const seen = new Set<string>();
  for (const feature of features) {
    if (!feature.id || seen.has(feature.id) || feature.access === 'locked') continue;
    seen.add(feature.id);
    const name = normalize(feature.name), description = normalize(feature.description);
    let best: ComposerFeatureSuggestion | undefined;
    for (const term of terms) {
      const english = /^[a-z]/u.test(term);
      const titleMatch = english ? wordMatch(name, term) : name.includes(term);
      const descriptionMatch = english ? wordMatch(description, term) : description.includes(term);
      if (!titleMatch && !descriptionMatch) continue;
      const score = (titleMatch ? 200 : 50) + term.length * 2 + (name === term ? 40 : 0);
      if (!best || score > best.score) best = { feature, keyword: term, score };
    }
    if (best) items.push(best);
  }
  items.sort((a, b) => b.score - a.score || a.feature.name.localeCompare(b.feature.name, 'zh-CN') || a.feature.id.localeCompare(b.feature.id));
  const count = Number.isFinite(limit) ? Math.max(0, Math.min(COMPOSER_SUGGESTION_LIMIT, Math.floor(limit))) : COMPOSER_SUGGESTION_LIMIT;
  return { key: `${cursor}:${text.slice(0, cursor)}`, items: items.slice(0, count) };
}

/** Copy only display/selection metadata, never tool definitions, credentials,
 * model configuration, or other fields returned by the broader catalog API. */
export function composerSuggestionCatalogEntry(value: unknown): FeatureChoice | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || !row.id.trim() || typeof row.name !== 'string' || !row.name.trim() || typeof row.description !== 'string' || row.access === 'locked') return null;
  const entry: FeatureChoice = { id: row.id, name: row.name, description: row.description };
  for (const field of ['knowledgeMode', 'category', 'author'] as const) if (typeof row[field] === 'string') entry[field] = row[field];
  if (row.access === 'purchased' || row.access === 'free' || row.access === 'enterprise') entry.access = row.access;
  if (typeof row.usageMultiplier === 'number' && Number.isFinite(row.usageMultiplier)) entry.usageMultiplier = row.usageMultiplier;
  return entry;
}

/** The server supplies the currently authorized releases. Paging is bounded,
 * metadata stays in this component's memory, and typing never performs a call. */
export async function loadComposerFeatureSuggestionCatalog(api: typeof Api, signal: AbortSignal): Promise<FeatureChoice[]> {
  const result = new Map<string, FeatureChoice>();
  for (let page = 1; page <= COMPOSER_SUGGESTION_CATALOG_PAGES; page++) {
    signal.throwIfAborted();
    const response = await api<{ items: unknown[]; total: number }>(`/api/features?scope=mine&category=all&q=&page=${page}`, { signal });
    signal.throwIfAborted();
    if (!Array.isArray(response.items)) throw new Error('功能目录格式无效');
    const sizeBefore = result.size;
    for (const row of response.items.slice(0, CATALOG_PAGE_SIZE)) {
      const entry = composerSuggestionCatalogEntry(row);
      if (entry && !result.has(entry.id)) result.set(entry.id, entry);
    }
    if (response.items.length < CATALOG_PAGE_SIZE || result.size === sizeBefore || (Number.isFinite(response.total) && page * CATALOG_PAGE_SIZE >= response.total)) break;
  }
  return [...result.values()];
}
