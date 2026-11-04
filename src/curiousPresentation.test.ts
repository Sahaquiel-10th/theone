import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {CuriousOption} from '../server/curiousOnboarding';
import {CuriousInlineText,CuriousText,curiousOptionPresentation,curiousTextRuns} from './curiousPresentation';

const render=(text:string,extra:Record<string,unknown>={})=>renderToStaticMarkup(createElement(CuriousText,{text,...extra}));
test('paired short bold markers produce semantic emphasis and blank lines produce paragraphs',()=>{
  assert.equal(render('先给你**简短框架**。\n\n然后一起聊。'),'<p>先给你<strong>简短框架</strong>。</p><p>然后一起聊。</p>');
  assert.equal(render('一段\r\n\r\n二段\n \n\n三段'),'<p>一段</p><p>二段</p><p>三段</p>');
  assert.equal(renderToStaticMarkup(createElement(CuriousInlineText,{text:'也可以**边聊边改**。'})),'也可以<strong>边聊边改</strong>。');
});

test('markup, links and URL schemes remain escaped text even inside valid emphasis',()=>{
  const html=render('**<img src=x onerror=alert(1)>**\n\n<script>alert(1)</script> [点我](javascript:alert(1)) ![图](https://example.com/a.png) <a href="https://example.com">链接</a>');
  assert.match(html,/<strong>&lt;img/);assert.match(html,/&lt;script/);assert.match(html,/javascript:alert/);
  assert.doesNotMatch(html,/<img\b|<script\b|<a\b/);
});

test('unclosed, empty, nested and oversized markers stay literal without losing text',()=>{
  for(const text of ['**没有闭合','一个**未闭合的做方案','四个****星号','***三重标记***','**跨\n行**',`**${'长'.repeat(49)}**`]){
    const runs=curiousTextRuns(text);assert.equal(runs.map(run=>run.text).join(''),text);assert.ok(runs.every(run=>!run.strong));
  }
  assert.equal(render('**先说这句**，后面**还没说完'),'<p><strong>先说这句</strong>，后面**还没说完</p>');
});

test('fallback emphasis only selects visible short phrases and never turns a paragraph into a heading',()=>{
  for(const text of ['我可以先给你一个简短框架，再边聊边改。','可以先做方案，再看看手头的材料。','先看一个小例子，再决定怎么继续。']){
    const runs=curiousTextRuns(text),strong=runs.filter(run=>run.strong);
    assert.equal(runs.map(run=>run.text).join(''),text);assert.ok(strong.length>=1&&strong.length<=2);
    assert.ok(strong.every(run=>text.includes(run.text)&&run.text.length<=6));
    assert.ok(runs.some(run=>!run.strong&&run.text.trim()));
  }
  for(const text of ['边聊边改','简短框架。','完全没有这些关键词'])assert.ok(curiousTextRuns(text).every(run=>!run.strong));
  assert.equal(render('我可以先给你一个简短框架。',{fallbackEmphasis:false}),'<p>我可以先给你一个简短框架。</p>');
});

test('explicit literal emphasis is not a regex and cannot add text that is absent',()=>{
  const text='先给我几个方向，我来选。';
  assert.equal(renderToStaticMarkup(createElement(CuriousInlineText,{text,emphasis:'几个方向'})),'先给我<strong>几个方向</strong>，我来选。');
  assert.equal(curiousTextRuns(text,{emphasis:'.*'}).map(run=>run.text).join(''),text);
  assert.ok(curiousTextRuns(text,{emphasis:'.*'}).every(run=>!run.strong));
});

test('all connected sources share the primary group and no source gains a recommendation or default',()=>{
  const options:CuriousOption[]=[{id:'connection:ima-own',label:'用已连接的 腾讯 ima',reply:'以后需要时用 腾讯 ima'},{id:'connection:notion-own',label:'用已连接的 Notion',reply:'以后需要时用 Notion'},{id:'connect',label:'再连接一个来源',action:'connect'},{id:'later',label:'以后再接，先认识到这'}];
  const before=structuredClone(options),shown=options.map(option=>curiousOptionPresentation(option,'knowledge'));
  assert.deepEqual(shown.slice(0,2),[{title:'腾讯 ima',support:'已连接 · 按需查找',intent:'primary',kind:'source'},{title:'Notion',support:'已连接 · 按需查找',intent:'primary',kind:'source'}]);
  assert.equal(shown[2].intent,'secondary');assert.equal(shown[3].intent,'tertiary');assert.deepEqual(options,before);
  assert.doesNotMatch(JSON.stringify(shown),/推荐|默认|recommended|selected|default/);
});

test('a model reply mentioning a connected source cannot promote itself to a connection action',()=>{
  const reply={id:'reply_0',label:'用已连接的 Notion'};
  assert.deepEqual(curiousOptionPresentation(reply,'context'),{title:reply.label,intent:'reply',kind:'reply'});
  assert.equal(curiousOptionPresentation(reply,'knowledge').intent,'reply');
});

test('ordinary replies keep their wording and highlight only an existing useful phrase',()=>{
  for(const label of ['先给我一个简短框架','边聊边改，不用一次问全','给我几个方向，我来选','先看一个小例子再决定','做方案、推进项目','写东西、做内容']){
    const shown=curiousOptionPresentation({id:'same-server-id',label},'activity');
    assert.equal(shown.title,label);assert.equal(shown.intent,'reply');assert.ok(shown.emphasis&&label.includes(shown.emphasis));
  }
});
