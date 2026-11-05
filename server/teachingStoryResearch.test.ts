import test from 'node:test';
import assert from 'node:assert/strict';
import {teachingStoryResearchQuery} from './teachingStoryResearch.js';
test('filled event fields drive retrieval rather than the template title or broad course name',()=>{
 const manuscript='作品标题：一船淤泥\n小组名称：第一组\n一、历史锚点\n关联历史大事件（基本结果不可改写）：苏轼疏浚西湖并修筑苏堤\n角色：普通船工';
 assert.equal(teachingStoryResearchQuery(manuscript,'杭州通论'),'苏轼疏浚西湖并修筑苏堤');
 assert.equal(teachingStoryResearchQuery('- 历史事件：钱塘江海塘建设','杭州通论'),'钱塘江海塘建设');
 assert.ok(teachingStoryResearchQuery('叙述普通人的劳动。','杭州通论').includes('杭州通论'));
 assert.ok(teachingStoryResearchQuery('历史事件：'+'长'.repeat(800),'课').length<=180);
});
