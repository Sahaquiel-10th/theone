import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { emptyAvatarBusiness, emptyAvatarService } from './AvatarService';
import { AvatarBusinessFields, AvatarMethodFields, AvatarWelcomeFields } from './AvatarConfiguration';
import { appendAvatarMethod, avatarFeatureSuggestions, avatarWithFeature, avatarWithMode } from './avatarConfigurationState';

test('changing avatar purpose preserves authored content and selected feature instructions', () => {
    const value = { ...emptyAvatarService(), method: '原有方法', welcome: '自写开场', starterQuestions: ['自写问题'], features: [{ featureId: 'safe', releaseId: 'v1', when: '条件', workflow: '流程' }] };
    const changed = avatarWithMode(value, 'knowledge');
    assert.deepEqual(changed, { ...value, mode: 'knowledge' });
    assert.equal(changed.features, value.features);
    assert.equal(value.mode, 'consultation');
});
test('method document imports append, reject empty or aggregate overflow without mutating existing text', () => {
    assert.equal(appendAvatarMethod('已有资料', '\uFEFF新增资料\n'), '已有资料\n\n新增资料');
    assert.equal(appendAvatarMethod('', '新资料'), '新资料');
    assert.throws(() => appendAvatarMethod('原资料', ' \n'), /没有可导入/);
    const full = '原'.repeat(12000);
    assert.throws(() => appendAvatarMethod(full, '新资料'), /原内容没有改动/);
    assert.equal(full.length, 12000);
});
test('feature choices are unique per release, capped at four and preserve remaining workflow fields', () => {
    let value = emptyAvatarService();
    const features = Array.from({ length: 6 }, (_, i) => ({ id: `f${i}`, releaseId: 'v1', name: `功能${i}`, description: '安全功能' }));
    for (const feature of features) value = avatarWithFeature(value, feature, true);
    assert.equal(value.features.length, 4);
    assert.equal(avatarWithFeature(value, features[0], true), value);
    const first = value.features[0];
    value = avatarWithFeature(value, features[1], false);
    assert.equal(value.features[0], first);
    value = avatarWithFeature(value, features[4], true);
    assert.equal(value.features.length, 4);
    assert.ok(value.features.some(f => f.featureId === 'f4'));
    assert.deepEqual(features[0], { id: 'f0', releaseId: 'v1', name: '功能0', description: '安全功能' });
});
test('catalog recommendations are bounded and purpose-specific without selecting tools', () => {
    const features = [{ id: 'report', releaseId: 'v1', name: '研究报告', description: '知识交付' }, { id: 'intake', releaseId: 'v1', name: '需求评估', description: '售前咨询' }, ...Array.from({ length: 40 }, (_, i) => ({ id: `f${i}`, releaseId: 'v1', name: `无关功能${i}`, description: '可用功能' }))];
    assert.equal(avatarFeatureSuggestions(features, 'consultation')[0].id, 'intake');
    assert.equal(avatarFeatureSuggestions(features, 'knowledge')[0].id, 'report');
    const html = renderToStaticMarkup(createElement(AvatarMethodFields, { value: emptyAvatarService(), features, onChange: () => {} }));
    assert.ok(html.indexOf('导入文档') < html.indexOf('方法资料'));
    assert.ok(html.includes('不覆盖已有内容'));
    assert.ok(html.includes('选择功能'));
    assert.ok(!html.includes('无关功能39'));
    assert.equal((html.match(/avatar-feature-option avatar-selected-feature/g) ?? []).length, 0);
});
test('section contracts keep purpose, visitor greeting, pricing and contact separate', () => {
    const renderWelcome = (section: 'purpose' | 'welcome', knowledge = false) => renderToStaticMarkup(createElement(AvatarWelcomeFields, { value: { ...emptyAvatarService(), mode: knowledge ? 'knowledge' : 'consultation' }, section, onChange: () => {} }));
    assert.ok(renderWelcome('purpose').includes('先帮你接待潜在客户'));
    assert.ok(renderWelcome('purpose', true).includes('把你的知识变成可使用的服务'));
    assert.ok(!renderWelcome('purpose').includes('开场问题 1'));
    assert.ok(!renderWelcome('welcome').includes('主要用途'));
    const renderBusiness = (section: 'pricing' | 'contact') => renderToStaticMarkup(createElement(AvatarBusinessFields, { value: emptyAvatarBusiness(), section, onChange: () => {} }));
    assert.ok(renderBusiness('pricing').includes('收费方案'));
    assert.ok(!renderBusiness('pricing').includes('收集客户信息'));
    assert.ok(renderBusiness('contact').includes('收集客户信息'));
    assert.ok(!renderBusiness('contact').includes('谁可以使用'));
    assert.ok(renderBusiness('pricing').includes('不会自动扣款或续费'));
});
