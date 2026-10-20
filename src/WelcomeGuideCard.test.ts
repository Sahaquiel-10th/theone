import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {WelcomeShareButton} from './WelcomeGuideCard';

test('unsupported private visual files never render a share control that CSS could reveal',()=>{
 const props={available:false,busy:false,shared:false,onClick:()=>{}};
 assert.equal(renderToStaticMarkup(createElement(WelcomeShareButton,props)),'');
 assert.match(renderToStaticMarkup(createElement(WelcomeShareButton,{...props,available:true})),/分享/);
 const busy=renderToStaticMarkup(createElement(WelcomeShareButton,{...props,available:true,busy:true,shared:true}));
 assert.match(busy,/disabled/);assert.match(busy,/创建新分享/);
});
