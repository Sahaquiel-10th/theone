import { calculateFinance } from '../skills-library/one/shared/scripts/finance.mjs';
import { stringifyTableCsv, csvParse } from './skillTables.js';
import type { OrchestrationTool } from './taskOrchestrator.js';

export const localSkillPresets = [
  {id:'oneFinance',name:'金额与收益测算',description:'依据用户确认的数据计算收益或报价。operation=profit、promotion、quote；dataJson 是 JSON 对象。金额字段为元，税率／渠道费率为 0–1 小数。不猜测缺失价格与成本。'},
  {id:'oneTable',name:'表格整理与导出',description:'清洗用户的 CSV 或本次选中的表格附件。operation=clean 或 customers；dataJson 包含 csv、keyColumns、trim、deduplicate，customers 另含 referenceDate、inactiveDays。attachmentId 仅限本次选中附件；未授权时不能读取。'}
];
export type SkillLocalContext = {
  quoteCurrency?:string;
  readTable?: (id:string)=>Promise<string>;
  saveTable?: (rows:(string|number|boolean|null)[][],name:string)=>Promise<{id:string;name:string}>;
};
export function localSkillTool(id:string, description:string, verify:()=>Promise<void>, context:SkillLocalContext={}):OrchestrationTool {
  return {name:id,description,run:async()=>{throw new Error('需要结构化参数');},structured:{
    schema:{type:'object',additionalProperties:false,properties:{operation:{type:'string',enum:id==='oneFinance'?['profit','promotion','quote']:['clean','customers','merge']},dataJson:{type:'string',maxLength:120000}},required:['operation','dataJson']},
    validate:raw=>{
      if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('工具输入无效');
      const r=raw as Record<string,unknown>;
      if(Object.keys(r).some(k=>!['operation','dataJson'].includes(k))||typeof r.operation!=='string'||typeof r.dataJson!=='string'||r.dataJson.length>120000)throw new Error('工具输入无效');
      if(!(id==='oneFinance'?['profit','promotion','quote']:['clean','customers','merge']).includes(r.operation))throw new Error('工具操作无效');
      JSON.parse(r.dataJson);return {operation:r.operation,dataJson:r.dataJson};
    },
    run:async raw=>{
      await verify();const r=raw as {operation:string;dataJson:string};const data=JSON.parse(r.dataJson);
      if(id==='oneFinance'){
        if(r.operation==='quote'&&context.quoteCurrency){if(data.currency!==undefined&&data.currency!==context.quoteCurrency)throw new Error('报价币种与用户选择不一致');data.currency=context.quoteCurrency;}
        const result=calculateFinance(r.operation,data);await verify();
        if(r.operation==='quote'&&context.saveTable){const quote=result as {currency:string;subtotal:number;shipping:number;addedTax:number;pricesIncludeTax:boolean;rows:{name:string;unit:string;quantity:number;unitPrice:number;amount:number}[];total:number};result.file=await context.saveTable([['商品','单位','数量',`单价（${quote.currency}）`,`金额（${quote.currency}）`],...quote.rows.map(row=>[row.name,row.unit,row.quantity,row.unitPrice,row.amount]),['商品小计','','','',quote.subtotal],['运费','','','',quote.shipping],['另加税额','','','',quote.addedTax],['总计','','','',quote.total],['含税口径',quote.pricesIncludeTax?'商品单价已含税':'商品单价未含税；税额另列']],'报价单.xlsx');}
        return result;
      }
      if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).some(k=>!['csv','attachmentId','attachmentIds','keyColumns','trim','deduplicate','referenceDate','inactiveDays'].includes(k)))throw new Error('表格选项无效');
      if(r.operation==='merge'){
        if(data.attachmentId!==undefined||data.csv!==undefined||!Array.isArray(data.attachmentIds)||data.attachmentIds.length<2||data.attachmentIds.length>5||data.attachmentIds.some((id:unknown)=>typeof id!=='string')||new Set(data.attachmentIds).size!==data.attachmentIds.length||!context.readTable)throw new Error('合并需要2–5个本次选中的附件');
        let rows:(string|number|boolean|null)[][]=[];
        for(const id of data.attachmentIds){await verify();const current=csvParse('clean',{csv:await context.readTable(id),trim:data.trim}).rows;if(!rows.length)rows=current;else{if(JSON.stringify(rows[0])!==JSON.stringify(current[0]))throw new Error('合并表头需一致；请先调整列名与顺序');rows.push(...current.slice(1));}if(rows.length>2001)throw new Error('合并结果超过2000行，请分批处理');}
        data.csv=stringifyTableCsv(rows);
      }
      if(data.attachmentId!==undefined){if(typeof data.attachmentId!=='string'||!context.readTable)throw new Error('附件不可用');if(data.csv!==undefined)throw new Error('请选择附件或 CSV 其中一种');data.csv=await context.readTable(data.attachmentId);}
      const result=csvParse(r.operation==='merge'?'clean':r.operation,data);await verify();
      if(context.saveTable)result.file=await context.saveTable(result.rows,r.operation==='customers'?'客户分组.xlsx':'整理后的表格.xlsx');
      // Large tables remain in the private file; do not overflow model context.
      return {...result,rows:result.rows.slice(0,31),previewOnly:result.rows.length>31};
    }
  }};
}
