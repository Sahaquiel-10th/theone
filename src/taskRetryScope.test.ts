import test from 'node:test';
import assert from 'node:assert/strict';
import {taskRetryScope} from './taskRetryScope';

test('retry confirmation uses only the latest child requirement from a multi-goal original',()=>{
 const original='画一张图，核算战力表，再把文章写到 Notion。';
 assert.equal(taskRetryScope([{instruction:'画一张图。'},{instruction:'只核算战力表，保存到当前授权文件夹。'}],original),'只核算战力表，保存到当前授权文件夹。');
 assert.equal(original,'画一张图，核算战力表，再把文章写到 Notion。');
});
test('legacy jobs without instructions fall back to the latest original, never an older child scope',()=>{
 assert.equal(taskRetryScope([{instruction:'较早的任务范围。'},{}],'最新补充内容。'),'最新补充内容。');
 assert.equal(taskRetryScope([],'  原始要求。  '),'原始要求。');
 assert.equal(taskRetryScope([],undefined),'查看原要求');
});
