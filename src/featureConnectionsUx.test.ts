import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import test from 'node:test';
import { MyToolCredentials, ToolCredentialEditor, toolCredentialName } from './FeatureConnections';
import type { api as Api } from './oneApi';

test('inline tool connections start with a loading state and no second same-name disclosure or false empty result', () => {
  let requests = 0;
  const api = (async () => { requests++; return { items: [] }; }) as typeof Api;
  const html = renderToStaticMarkup(createElement(MyToolCredentials, { api, inline: true }));
  assert.match(html, /aria-label="工具连接列表"/);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /正在读取工具连接/);
  assert.doesNotMatch(html, /<summary>工具连接<\/summary>|暂无已保存/);
  assert.equal(requests, 0, 'Rendering does not submit, revoke, or read on the server');
});

test('ordinary credential disclosures retain opt-in opening rather than becoming another permanent panel', () => {
  const api = (async () => { throw new Error('must not run while rendering'); }) as typeof Api;
  const html = renderToStaticMarkup(createElement(MyToolCredentials, { api }));
  assert.match(html, /<details class="quiet-details"><summary>工具连接<\/summary>/);
  assert.doesNotMatch(html, /暂无已保存的工具凭证/);
});

test('credential rows identify the actual service and distinguish unread status from a missing credential', () => {
  const api = (async () => ({ items: [] })) as typeof Api;
  const props = { api, endpoint: 'https://api.example.test/v2/read', auth: 'bearer' as const };
  const reading = renderToStaticMarkup(createElement(ToolCredentialEditor, props));
  assert.match(reading, /api.example.test\/v2\/read/);
  assert.match(reading, /读取中/);
  assert.doesNotMatch(reading, /未配置/);
  const known = renderToStaticMarkup(createElement(ToolCredentialEditor, { ...props, initialConfigured: true }));
  assert.match(known, /已配置/);
  assert.doesNotMatch(known, /读取中|未配置/);
  assert.match(known, /type="password"/);
});

test('service names keep useful paths but exclude URL credentials, search strings and fragments', () => {
  assert.equal(toolCredentialName('https://user:password@api.example.test:8443/v2/read?api_key=secret#private'), 'api.example.test:8443/v2/read');
  assert.equal(toolCredentialName('https://api.example.test/'), 'api.example.test');
  assert.equal(toolCredentialName('malformed-private-input'), '工具连接');
});
