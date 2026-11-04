import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {readFileSync} from 'node:fs';
import type {AccountProfile} from './Onboarding';
import {CompanionSettings} from './CompanionSettings';
import {companionChoices,companionIntensityChoices,companionSample} from './companionPersonas';

const profile=():AccountProfile=>({workspaceId:'synthetic-companion-workspace',displayName:'小林',companion:{persona:'robot',intensity:'normal'},onboarding:{knowledgeChoice:'pending'},updatedAt:'2026-11-04T00:00:00Z'});
const render=(value=profile())=>renderToStaticMarkup(createElement(CompanionSettings,{profile:value,onSave:async()=>{throw Error('render must not save a profile');}}));

test('settings identifies the saved voice and presents eight compact choices with one preview',()=>{
  const html=render();
  assert.match(html,/当前：赛博机器人/);
  assert.equal((html.match(/class="companion-choice"/g)??[]).length,8);
  assert.equal((html.match(/class="companion-preview"/g)??[]).length,1);
  assert.equal((html.match(/type="radio"/g)??[]).length,11);
  assert.doesNotMatch(html,/<q>|companion-choice-heading/);
  for(const choice of companionChoices)assert.ok(html.includes(choice.name));
  for(const choice of companionIntensityChoices)assert.ok(html.includes(choice.name));
});

test('only the selected persona and intensity example is rendered',()=>{
  for(const choice of companionChoices){
    const value=profile();value.companion={persona:choice.id,intensity:'wild'};
    const html=render(value);
    assert.ok(html.includes(companionSample(choice.id,'wild',value.displayName)));
    for(const other of companionChoices)if(other.id!==choice.id)assert.ok(!html.includes(companionSample(other.id,'wild',value.displayName)));
  }
});

test('custom preferences remain available in a collapsed disclosure with clear preview boundaries',()=>{
  const value=profile();value.companion!.custom='回复短一点';
  const html=render(value);
  assert.match(html,/<details class="companion-custom">/);assert.doesNotMatch(html,/<details[^>]*open/);
  assert.match(html,/补充聊天偏好/);assert.match(html,/已填写/);assert.match(html,/value="回复短一点"/);
  assert.match(html,/上面是预设口气示例/);assert.match(html,/最多 120 个字/);
});

test('the production CSP can keep blocking inline styles while settings use the bundled stylesheet',()=>{
  assert.doesNotMatch(render(),/<style\b|\sstyle=/i);
  const main=readFileSync(new URL('./main.tsx',import.meta.url),'utf8');
  assert.match(main,/import\s+['"]\.\/companion-settings\.css['"]/);
});

test('untrusted profile names and custom preferences are text and do not create executable markup',()=>{
  const value=profile();value.displayName='<img src=x onerror=alert(1)>';value.companion!.custom='"><script>alert(1)</script>';
  const html=render(value);assert.match(html,/&lt;img/);assert.match(html,/&lt;script/);assert.doesNotMatch(html,/<img\b|<script\b/);
});

test('an unchanged profile has no write action, while invalid custom text cannot be saved',()=>{
  assert.match(render(),/<button[^>]*type="submit"[^>]*disabled=""/);
  const value=profile();value.companion!.custom='x'.repeat(121);
  const html=render(value);assert.match(html,/aria-invalid="true"/);assert.match(html,/请缩短到 120 个字以内/);
  assert.match(html,/<button[^>]*type="submit"[^>]*disabled=""/);
});
