import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Children, isValidElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { api as Api } from './oneApi';
import type { FeatureChoice } from './preview/FeatureShelf';
import { ComposerFeatureSuggestionList } from './ComposerFeatureSuggestionList';
import { COMPOSER_SUGGESTION_CATALOG_PAGES, composerFeatureSuggestionTerms, composerSuggestionCatalogEntry, composerSuggestionCatalogForScope, loadComposerFeatureSuggestionCatalog, matchComposerFeatureSuggestions } from './composerFeatureSuggestionMatch';

const feature = (id: string, name: string, description = ''): FeatureChoice => ({ id, name, description });
const features = [feature('plan', '活动方案', '明确目标和执行安排。'), feature('research', '资料研究', '收集资料，整理方案依据。'), feature('article', '写文章', '撰写文章与小报童专栏。'), feature('image', '绘图', '创建图片。')];
const ids = (text: string, cursor = text.length) => matchComposerFeatureSuggestions(features, text, cursor).items.map(item => item.feature.id);

test('only the current Chinese word tail matches, with titles ahead of descriptions', () => {
  assert.deepEqual(ids('帮我写个方案'), ['plan', 'research']);
  assert.deepEqual(ids('帮我写个文章'), ['article']);
  for (const text of ['帮我', '一个', '一下', '我想写方案，接下来', '方案 ', '方案。', '方案怎么样了', '@方案']) assert.deepEqual(ids(text), [], text);
  assert.deepEqual(composerFeatureSuggestionTerms('方'), []);
  assert.deepEqual(ids('方案继续', 2), []);
  assert.deepEqual(ids('方案，继续', 2), ['plan', 'research']);
  assert.deepEqual(composerFeatureSuggestionTerms('方案', -1), []);
});
test('English keywords are normalized full words, not substrings or one-letter triggers', () => {
  const rows = [feature('report', 'REPORT Writer'), feature('image', 'Image helper'), feature('write', 'Overwrite helper')];
  assert.deepEqual(matchComposerFeatureSuggestions(rows, 'Write a report').items.map(item => item.feature.id), ['report']);
  assert.deepEqual(matchComposerFeatureSuggestions(rows, 'image').items.map(item => item.feature.id), ['image']);
  assert.deepEqual(matchComposerFeatureSuggestions(rows, 'write').items, []);
  assert.deepEqual(composerFeatureSuggestionTerms('报告 plan'), ['plan']);
  assert.deepEqual(composerFeatureSuggestionTerms('ab'), []);
});
test('results are deterministic, deduplicated, at most three, and never include locked functions', () => {
  const rows = [feature('b', '方案乙'), feature('a', '方案甲'), feature('c', '方案丙'), feature('d', '方案丁'), feature('b', '方案重复'), { ...feature('locked', '方案'), access: 'locked' as const }];
  const result = matchComposerFeatureSuggestions(rows, '方案');
  assert.equal(result.items.length, 3);
  assert.equal(new Set(result.items.map(item => item.feature.id)).size, 3);
  assert.ok(result.items.every(item => item.feature.id !== 'locked'));
  assert.deepEqual(result, matchComposerFeatureSuggestions([...rows].reverse().filter(item => item.name !== '方案重复'), '方案'));
  assert.equal(matchComposerFeatureSuggestions(rows, '方案', 2, 100).items.length, 3);
  assert.equal(matchComposerFeatureSuggestions(rows, '方案', 2, 0).items.length, 0);
});
test('catalog entries retain only safe display/selection metadata', () => {
  const entry = composerSuggestionCatalogEntry({ ...features[0], releaseId: 'r1', credentials: ['private'], apiKey: 'secret', prompt: 'hidden', experience: { actions: [] }, author: 'ONE', usageMultiplier: .6 });
  assert.deepEqual(entry, { ...features[0], author: 'ONE', usageMultiplier: .6 });
  for (const invalid of [null, '', {}, { id: '', name: '方案', description: '' }, { ...features[0], access: 'locked' }]) assert.equal(composerSuggestionCatalogEntry(invalid), null);
});
test('catalog loads existing authorized pages once and does not make an execution request', async () => {
  const calls: string[] = [], rows = Array.from({ length: 12 }, (_, index) => feature(String(index), `方案 ${index}`));
  const api = (async (path: string, options: RequestInit) => {
    calls.push(path); assert.equal(options.method, undefined); assert.ok(options.signal);
    const page = Number(new URL(path, 'https://one.invalid').searchParams.get('page'));
    return { items: rows.slice((page - 1) * 10, page * 10), total: 12 };
  }) as typeof Api;
  const result = await loadComposerFeatureSuggestionCatalog(api, new AbortController().signal);
  assert.equal(result.length, 12); assert.equal(calls.length, 2);
  assert.ok(calls.every(path => /^\/api\/features\?scope=mine&category=all&q=&page=\d+$/.test(path)));
  matchComposerFeatureSuggestions(result, '方案'); matchComposerFeatureSuggestions(result, '方案呀'); assert.equal(calls.length, 2);
});
test('catalog rejects aborted late responses and has finite pagination even with a broken catalog', async () => {
  const aborted = new AbortController(); let calls = 0;
  const delayed = (async () => { calls++; aborted.abort(); return { items: features, total: 4 }; }) as typeof Api;
  await assert.rejects(loadComposerFeatureSuggestionCatalog(delayed, aborted.signal), { name: 'AbortError' }); assert.equal(calls, 1);
  const endless = (async () => ({ items: Array.from({ length: 10 }, () => feature(String(calls++), '方案')), total: Infinity })) as typeof Api;
  const result = await loadComposerFeatureSuggestionCatalog(endless, new AbortController().signal);
  assert.equal(result.length, COMPOSER_SUGGESTION_CATALOG_PAGES * 10);
  calls = 0;
  const repeated = (async () => { calls++; return { items: Array.from({ length: 10 }, (_, i) => feature(String(i), '方案')), total: 100000 }; }) as typeof Api;
  assert.equal((await loadComposerFeatureSuggestionCatalog(repeated, new AbortController().signal)).length, 10); assert.equal(calls, 2);
});
test('catalog rows cannot cross users, workspaces, API identity, or a disabled session', () => {
  const api = (async () => ({})) as typeof Api, otherApi = (async () => ({})) as typeof Api;
  const catalog = { api, scopeKey: 'user-a:workspace-a', items: features };
  assert.equal(composerSuggestionCatalogForScope(catalog, api, catalog.scopeKey, true), features);
  assert.deepEqual(composerSuggestionCatalogForScope(catalog, api, 'user-b:workspace-a', true), []);
  assert.deepEqual(composerSuggestionCatalogForScope(catalog, api, 'user-a:workspace-b', true), []);
  assert.deepEqual(composerSuggestionCatalogForScope(catalog, otherApi, catalog.scopeKey, true), []);
  assert.deepEqual(composerSuggestionCatalogForScope(catalog, api, catalog.scopeKey, false), []);
  assert.deepEqual(composerSuggestionCatalogForScope(null, api, catalog.scopeKey, true), []);
  assert.deepEqual(composerSuggestionCatalogForScope({ ...catalog, scopeKey: '' }, api, '', true), []);
});
test('catalog fails closed after a missing page rather than presenting a successful partial snapshot', async () => {
  let calls = 0;
  const api = (async () => { if (calls++) throw new Error('offline'); return { items: Array.from({ length: 10 }, (_, i) => feature(String(i), '方案')), total: 20 }; }) as typeof Api;
  await assert.rejects(loadComposerFeatureSuggestionCatalog(api, new AbortController().signal), /offline/);
  const aborted = new AbortController(); aborted.abort(); calls = 0;
  await assert.rejects(loadComposerFeatureSuggestionCatalog(api, aborted.signal), { name: 'AbortError' }); assert.equal(calls, 0);
});

function buttons(node: ReactElement): ReactElement<any>[] {
  const found: ReactElement<any>[] = [];
  const visit = (element: ReactElement<any>) => { if (element.type === 'button') found.push(element); Children.forEach(element.props.children, child => { if (isValidElement(child)) visit(child); }); };
  visit(node); return found;
}
test('passive recommendation buttons only add, preserve the draft focus, and never submit', () => {
  const choices: unknown[] = [], source = {} as HTMLElement; let ignored = 0, prevented = 0;
  const node = ComposerFeatureSuggestionList({ items: matchComposerFeatureSuggestions(features, '方案').items, selected: [], onChoose: (choice, element) => choices.push([choice, element]), onDismiss: () => ignored++ })!;
  const actions = buttons(node); assert.equal(actions.length, 3);
  for (const action of actions) { assert.equal(action.props.type, 'button'); assert.equal(action.props.onKeyDown, undefined); action.props.onMouseDown({ preventDefault: () => prevented++ }); }
  actions[1].props.onClick({ currentTarget: source }); assert.deepEqual(choices, [[features[0], source]]); assert.equal(prevented, 3);
  actions[0].props.onClick(); assert.equal(ignored, 1);
  const html = renderToStaticMarkup(node); assert.match(html, /可添加功能/); assert.match(html, /仅下一条消息使用/); assert.doesNotMatch(html, /combobox|listbox|aria-live|费用|倍率/);
});
test('already selected choices remain checked and cannot toggle off or exceed eight selections', () => {
  let calls = 0;
  const items = matchComposerFeatureSuggestions(features, '方案').items;
  const chosen = buttons(ComposerFeatureSuggestionList({ items, selected: ['plan'], onChoose: () => calls++, onDismiss: () => {} })!);
  assert.equal(chosen[1].props['aria-pressed'], true); assert.equal(chosen[1].props.disabled, true);
  chosen[1].props.onClick({ currentTarget: {} }); assert.equal(calls, 0);
  const full = buttons(ComposerFeatureSuggestionList({ items, selected: Array.from({ length: 8 }, (_, i) => String(i)), onChoose: () => calls++, onDismiss: () => {} })!);
  assert.equal(full[1].props.disabled, true); full[1].props.onClick({ currentTarget: {} }); assert.equal(calls, 0);
  assert.equal(ComposerFeatureSuggestionList({ items: [], selected: [], onChoose: () => {}, onDismiss: () => {} }), null);
});
test('component gates passive discovery and account changes without intercepting normal composer input', () => {
  const component = fs.readFileSync(new URL('./ComposerFeatureSuggestions.tsx', import.meta.url), 'utf8');
  assert.match(component, /composerSuggestionCatalogForScope\(catalog, api, scopeKey, enabled\)/);
  assert.match(component, /return \(\) => abort\.abort\(\)/);
  assert.match(component, /!focused \|\| composing \|\| pickerOpen \|\| ignored/);
  assert.match(component, /\[api, scopeKey, enabled\]/);
  assert.doesNotMatch(component, /localStorage|sessionStorage|onKeyDown=|setInterval|\/runs|POST/);
  const css = fs.readFileSync(new URL('./composer-feature-suggestions.css', import.meta.url), 'utf8');
  assert.match(css, /position: absolute/); assert.doesNotMatch(css, /animation:|transition:|#[0-9a-f]{3,8}/i);
});
