import test from 'node:test';
import assert from 'node:assert/strict';
import {executionExplicitlyUnfinished} from './executionResultState.js';

test('a completed in-place edit is not unfinished because no backup or temporary files were created',()=>{
 const answer='已原地修改 `ONE-QA-LOCAL-1101-D/template.xlsx`：“验收表”B6 从数值 `3000` 改为数值 `3200`。\n- 已实际回读核对 B6 为数值 3200。\n- 工作表 XML 仅 B6 数值发生变化；其他 ZIP 成员内容逐字节一致，其他单元格及格式保持不变。\n- 未创建备份或临时文件；未读取、修改 `receipt.txt`。\n- 未进行可视化测试。';
 assert.equal(executionExplicitlyUnfinished(answer),false);
 for(const value of ['已保存目标文件。没有创建备份文件或临时文件。','已修改目标文件，未创建任何临时文件或备份。'])assert.equal(executionExplicitlyUnfinished(value),false,value);
});

test('the ancillary exception cannot hide a missing target, a requested backup or a larger object list',()=>{
 for(const answer of ['未创建备份或临时文件。','没有创建目标文件。','已修改原文件。未创建目标备份文件。','已修改原文件。未创建要求的备份或临时文件。','已修改原文件。未创建备份或临时文件以及目标报告。','已修改原文件。未创建备份或临时文件中的目标报告。','已修改原文件。未创建备份或临时文件作为最终交付。','已修改原文件。未创建备份或临时文件，也没有创建目标文档。','已修改原文件。备份或临时文件是本次要求的最终交付。未创建备份或临时文件。','已修改原文件。未创建备份或临时文件；这是本次要求的最终交付。'])assert.equal(executionExplicitlyUnfinished(answer),true,answer);
});

test('other explicit non-completion survives a bounded ancillary-file statement',()=>{
 for(const ending of ['停止操作。','未完成回读。','未能写入目标文件。','无法确认目标内容。','尚未创建目标文件。'])assert.equal(executionExplicitlyUnfinished(`已修改目标文件。未创建备份或临时文件。${ending}`),true,ending);
 assert.equal(executionExplicitlyUnfinished('文档已创建并验证。没有创建其他文件，未创建或修改任何无关文件。'),false);
});
