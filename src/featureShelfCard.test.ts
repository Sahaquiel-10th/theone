import test from 'node:test';
import assert from 'node:assert/strict';
import {Children,isValidElement,type ReactElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {FeatureShelfCard} from './preview/FeatureShelfCard';
import type {FeatureChoice} from './preview/FeatureShelf';

const feature:FeatureChoice={id:'office',name:'办公助手',description:'整理信息，写邮件、清单和计划。',author:'ONE',access:'purchased',purchaseLabel:'已购买',usageMultiplier:.6};
function buttons(node:ReactElement):ReactElement<any>[] {
 const found:ReactElement<any>[]=[];
 const visit=(element:ReactElement<any>)=>{if(element.type==='button')found.push(element);Children.forEach(element.props.children,child=>{if(isValidElement(child))visit(child);});};
 visit(node);return found;
}
test('compact card keeps inspection separate from selection and hands over the actual source control',()=>{
 let inspected=0;const choices:Array<{feature:FeatureChoice;source:HTMLElement}>=[],source={} as HTMLElement;
 const node=FeatureShelfCard({feature,selected:false,inspecting:false,onInspect:()=>inspected++,onChoose:(choice,element)=>choices.push({feature:choice,source:element})});
 const actions=buttons(node);assert.equal(actions.length,2);actions[0].props.onClick();assert.equal(inspected,1);assert.equal(choices.length,0);
 actions[1].props.onClick({currentTarget:source});assert.deepEqual(choices,[{feature,source}]);assert.equal(actions[1].props['aria-pressed'],false);
 const html=renderToStaticMarkup(node);assert.match(html,/办公助手/);assert.match(html,/feature-official-badge/);assert.match(html,/官方/);assert.match(html,/查看详情/);assert.doesNotMatch(html,/已购买|0\.6 倍|按实际用量扣除|可使用/);
});
test('a locked card only opens access details and can never select or launch the function',()=>{
 let inspected=0,selected=0;const node=FeatureShelfCard({feature:{...feature,access:'locked',purchaseLabel:'开通方式待发布'},selected:false,inspecting:false,onInspect:()=>inspected++,onChoose:()=>selected++});
 const action=buttons(node)[1];assert.equal(action.props['aria-pressed'],undefined);action.props.onClick({currentTarget:{}});assert.equal(inspected,1);assert.equal(selected,0);
 assert.match(renderToStaticMarkup(node),/未开通/);assert.match(renderToStaticMarkup(node),/了解开通/);assert.doesNotMatch(renderToStaticMarkup(node),/开通方式待发布/);
});
test('community authors never acquire the official badge through a fallback label',()=>{
 const html=renderToStaticMarkup(FeatureShelfCard({feature:{...feature,author:'合作作者'},selected:false,inspecting:false,onInspect:()=>{},onChoose:()=>{}}));
 assert.doesNotMatch(html,/feature-official-badge|>官方</);
});
test('selected and inspected states retain distinct accessible feedback and cancellation',()=>{
 let cancelled=0;const node=FeatureShelfCard({feature,selected:true,inspecting:true,onInspect:()=>{},onChoose:()=>cancelled++}),actions=buttons(node);
 assert.equal(actions[0].props['aria-expanded'],true);assert.equal(actions[1].props['aria-pressed'],true);assert.match(actions[1].props['aria-label'],/取消选择/);
 actions[1].props.onClick({currentTarget:{}});assert.equal(cancelled,1);assert.match(renderToStaticMarkup(node),/is-selected is-inspecting/);
});
