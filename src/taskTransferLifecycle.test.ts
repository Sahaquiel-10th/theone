import test from 'node:test';
import assert from 'node:assert/strict';
import {reportedCardTransitions,departingCardTransitions,applyReviewedReceipts} from './taskTransferLifecycle';
import {noteFlightFrames} from './taskTransferMotion';
import type {Transfer} from './TaskTransferRail';
const card:Transfer={id:'round-1',taskId:'ui',title:'界面',state:'returned',read:false,reported:false};

test('finished notes wait through idle updates; only a dispatcher receipt sends them back',()=>{
 const previous=new Map([[card.id,card]]);
 assert.deepEqual(reportedCardTransitions(previous,[card]),[]);
 assert.deepEqual(reportedCardTransitions(previous,[]),[]);
 assert.deepEqual(reportedCardTransitions(previous,[{...card,reported:true}]),[card]);
 assert.deepEqual(reportedCardTransitions(previous,[],['other-round']),[]);
 assert.deepEqual(reportedCardTransitions(previous,[],[card.id]),[card]);
 assert.deepEqual(reportedCardTransitions(null,[{...card,reported:true}],[card.id]),[]);
});
test('new rounds remain independent from the old result flight and restored tasks do not depart again',()=>{
 const running={...card,id:'round-2',state:'running',reportable:false};
 const previous=new Map([[card.id,card]]);
 assert.deepEqual(departingCardTransitions(null,[running]),[]);
 assert.deepEqual(departingCardTransitions(previous,[running]),[running]);
 assert.deepEqual(departingCardTransitions(new Map([[running.id,running]]),[running]),[]);
 assert.deepEqual(reportedCardTransitions(previous,[running],[card.id]),[card]);
});
test('read-all updates only the captured receipts and cannot mark them reported or swallow future work',()=>{
 const next={...card,id:'round-2'};
 const changed=applyReviewedReceipts([card,next],[card.id]);
 assert.deepEqual(changed,[{...card,read:true},next]);
 assert.equal(changed[0].reported,false);
 assert.equal(card.read,false);
 assert.deepEqual(applyReviewedReceipts([{...card,reported:true},next],[card.id]),[next]);
});
test('paper flights use measured conversation and note centres in both directions',()=>{
 const conversation={left:10,top:20,width:100,height:50},note={left:760,top:150,width:180,height:90};
 const depart=noteFlightFrames(conversation,note,note,'depart');
 assert.match(depart[0].transform,/-790px, -150px/);
 assert.match(depart.at(-1)!.transform,/0px, 0px/);
 const answer={left:200,top:100,width:700,height:120};
 const returned=noteFlightFrames(note,answer,note,'return');
 assert.match(returned.at(-1)!.transform,/-300px, -35px/);
 assert.equal(returned.at(-1)!.opacity,0);
});
