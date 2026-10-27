import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import test from 'node:test';
import { FeatureInformation } from './FeatureInformation';

test('inspection separates feature use from fee and permission facts without rendering a task submit', () => {
  const html = renderToStaticMarkup(createElement(FeatureInformation, { feature: {
    description: '对比三份资料的观点', limitations: '无法保证来源内容完整', knowledgeMode: 'required', destinations: ['https://read.example.test'], usageMultiplier: .6,
    experience: { promptPlaceholder: '你要研究哪个问题？', actions: [{ id: 'compare', label: '比较观点' }] },
  }, accessLabel: '企业已开通' }));
  assert.match(html, /feature-information-main/);
  assert.match(html, /用途<\/h4><p>对比三份资料的观点/);
  assert.match(html, /可以完成<\/h4><ul><li>比较观点/);
  assert.match(html, /使用说明<\/h4><p>你要研究哪个问题？/);
  assert.match(html, /限制与注意<\/h4><p>无法保证来源内容完整/);
  assert.match(html, /<aside[^>]*aria-label="费用与使用范围"/);
  assert.match(html, /feature-access-status/);
  assert.ok(html.indexOf('feature-access-status') < html.indexOf('feature-information-main'));
  assert.match(html, />企业已开通<\/div>/);
  assert.doesNotMatch(html, /<dt>开通状态<\/dt>/);
  assert.match(html, /0.6 倍/);
  assert.match(html, /需要选择知识来源/);
  assert.match(html, /1 个外部只读接口/);
  assert.doesNotMatch(html, /<button|type="submit"|我确认/);
});

test('access status keeps the full entitlement label once in visible content without claiming free usage', () => {
  const feature = { description: '整理要求', limitations: '', knowledgeMode: 'none', destinations: [], usageMultiplier: .6 };
  for (const accessLabel of ['企业已开通', '免费开放']) {
    const html = renderToStaticMarkup(createElement(FeatureInformation, { feature, accessLabel }));
    const visibleText = html.replace(/<[^>]*>/g, '');
    assert.equal(visibleText.split(accessLabel).length - 1, 1);
    assert.match(visibleText, /费用用量倍率0.6 倍按实际用量扣除/);
    assert.doesNotMatch(visibleText, /免费使用|不扣费/);
  }
});

test('optional and absent knowledge scopes remain distinct and empty limitation groups are omitted', () => {
  const feature = { description: '整理要求', limitations: '  ', knowledgeMode: 'optional', destinations: [] };
  const optional = renderToStaticMarkup(createElement(FeatureInformation, { feature }));
  assert.match(optional, /可选择知识来源/);
  assert.match(optional, /不使用外部数据接口/);
  assert.doesNotMatch(optional, /限制与注意/);
  const none = renderToStaticMarkup(createElement(FeatureInformation, { feature: { ...feature, knowledgeMode: 'none' } }));
  assert.match(none, /无需个人知识来源/);
  assert.doesNotMatch(none, /本次任务选择的已授权连接/);
});
