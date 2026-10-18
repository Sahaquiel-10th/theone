import fs from 'node:fs/promises';
import path from 'node:path';
import {slideFiles,type SlideDeck} from '../server/officeSlides.js';
import {createWorkbook,fillWorkbook,reconcileWorkbook,analyzeWorkbook} from '../server/officeWorkbook.js';
import {createWord} from '../server/officeDocument.js';
const directory=path.resolve('output/one-office-kit');await fs.mkdir(directory,{recursive:true});
const deck:SlideDeck={title:'项目交付与经营复盘',theme:'paper',slides:[
 {title:'项目交付与经营复盘',layout:'cover',subtitle:'先看事实，再决定下一步',notes:'本演示所有数字和项目均为虚构。'},
 {title:'本周需要确认的事项',layout:'bullets',bullets:['客户基础图尚未收到，需确认提供时间','安装排期等待现场条件确认','付款资料还缺培训签收记录'],source:'虚构演示资料，不代表任何企业实际情况'},
 {title:'两种交付方式',layout:'split',columns:[{title:'分阶段交付',items:['优先确认第一阶段范围','按阶段记录完成证据','及时处理接口变化']},{title:'集中交付',items:['先核对全部前置条件','统一安排现场资源','集中整理验收资料']}]},
 {title:'季度记录对照',layout:'chart',chart:{labels:['第一季度','第二季度','第三季度'],values:[32,45,54],unit:'记录数 · 虚构演示数据'}},
 {title:'需要跟进的交接事项',layout:'table',table:[['事项','负责人','状态'],['图纸确认','待指定','等待客户'],['安装安排','项目经理','日期待定'],['培训记录','服务团队','待整理']]},
 {title:'下一步安排',layout:'bullets',bullets:['先补齐影响方案和报价的关键资料','逐项确认供货、安装和客户配合的边界','明确每一项待办的承接人和完成依据'],notes:'建议安排尚未获得客户批准，不能作为合同交期承诺。'}
]};
for(const file of await slideFiles(deck))await fs.writeFile(path.join(directory,file.name),file.bytes);
const template=await createWorkbook({title:'项目费用模板',sheets:[{name:'费用',headers:['项目','数量','单价','金额','状态'],rows:[['设备',2,12000,null,'待确认'],['安装',1,3000,null,'待确认'],['合计',null,null,null,'']],formulas:[{cell:'D2',formula:'B2*C2'},{cell:'D3',formula:'B3*C3'},{cell:'D4',formula:'SUM(D2:D3)'}],dropdowns:[{column:'状态',options:['待确认','已确认']}]}]});
await fs.writeFile(path.join(directory,template.name),template.bytes);
const filled=await fillWorkbook(template.bytes,{title:'已填写费用表',updates:[{sheet:'费用',cell:'B2',value:3}]});await fs.writeFile(path.join(directory,filled.name),filled.bytes);
const reconciliation=await reconcileWorkbook('订单号,应收\n001,24000\n002,3000\n002,500\n003,1000','订单号,实收\n001,24000\n002,3500\n003,900\n004,800',{title:'订单收款对账',leftKeys:['订单号'],rightKeys:['订单号'],leftAmount:'应收',rightAmount:'实收',tolerance:0,trim:false});await fs.writeFile(path.join(directory,reconciliation.file.name),reconciliation.file.bytes);
const analysis=await analyzeWorkbook('月份,费用\n一月,12000\n二月,14000\n二月,2000\n三月,未知',{title:'月度费用图表',groupBy:'月份',valueColumn:'费用',aggregation:'sum',chartType:'bar'});await fs.writeFile(path.join(directory,analysis.file.name),analysis.file.bytes);
const word=await createWord({title:'项目交付工作报告',subtitle:'虚构演示资料 · 用于检查排版与下载',style:'business',sections:[{heading:'本轮目标',paragraphs:['确认项目交付的范围、前置条件和需要负责人决定的事项。所有示例内容均为虚构，不构成实际交付承诺。']},{heading:'目前进展',paragraphs:['设备清单已完成内部评审。客户基础图尚未收到，安装排期需要在现场条件确认后安排。'],table:[['事项','进展','下一步'],['客户图纸','待收到','确认提供日期'],['安装排期','待确认','核对场地条件']]},{heading:'待确认事项',paragraphs:['报价的供货、安装和运输范围需要与合同附件逐项核对。培训签收记录补齐后，再根据合同付款触发条件检查回款资料。'],source:'本地虚构演示记录'}]});await fs.writeFile(path.join(directory,word.name),word.bytes);
await fs.writeFile(path.join(directory,'office-deck.json'),JSON.stringify(deck,null,2));console.log('已生成6项功能的离线演示成果：'+directory);
