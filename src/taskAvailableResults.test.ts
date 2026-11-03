import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {TaskAvailableResults,type TaskAvailableResult} from './TaskAvailableResults';

const render=(results?:TaskAvailableResult[])=>renderToStaticMarkup(createElement(TaskAvailableResults,{results}));

test('an available completed manuscript is immediately readable before final delivery, rather than a new continue control',()=>{
 const html=render([{stepId:'draft',title:'专栏正文',content:'# 已写好的文章\n\n全文在这里，保存核对仍在后台进行。\n\n|步骤|结果|\n|---|---|\n|写作|完成|\n\n`literal()`'}]);
 assert.match(html,/aria-label="已有成果"/);assert.match(html,/<h1>已写好的文章<\/h1>/);assert.match(html,/全文在这里/);assert.match(html,/<table>/);assert.match(html,/<code>literal\(\)<\/code>/);
 assert.doesNotMatch(html,/<details|hidden|<button|重试|继续|\/api\//);
});

test('absent or unusable outputs add no invented result, and extra private record fields are not projected',()=>{
 assert.equal(render(), '');assert.equal(render([]), '');
 assert.equal(render([{stepId:'draft',title:'空内容',content:'  '}]),'');
 const html=render([{stepId:'private-step',title:'已生成内容',content:'保留这份正文',tool:'private-tool',provider:'private-provider',input:'private-input'} as TaskAvailableResult]);
 assert.match(html,/保留这份正文/);assert.doesNotMatch(html,/private-|provider|\/api\//);
});

test('manuscript rendering uses the existing safe Markdown boundary for remote images, raw HTML and script URLs',()=>{
 const html=render([{stepId:'draft',title:'正文',content:'![remote](https://example.test/private-tracker.png)\n\n<script>not-trusted()</script>\n\n[bad](javascript:alert(1))'}]);
 assert.doesNotMatch(html,/<img|<script>|href="javascript:/);assert.match(html,/&lt;script&gt;/);
});
