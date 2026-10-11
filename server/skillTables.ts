import { parse } from 'csv-parse/sync';
import XLSX from 'xlsx';
import JSZip from 'jszip';

export type SkillTableResult={rows:(string|number|boolean|null)[][];inputRows:number;outputRows:number;duplicatesRemoved:number;file?:{id:string;name:string}};
export function csvParse(operation:string,data:Record<string,unknown>):SkillTableResult {
  if(typeof data.csv!=='string'||data.csv.length>120000)throw new Error('表格内容应为不超过 120000 字的 CSV');
  if(data.trim!==undefined&&typeof data.trim!=='boolean'||data.deduplicate!==undefined&&typeof data.deduplicate!=='boolean')throw new Error('清洗选项无效');
  const rows=parse(data.csv,{bom:true,skip_empty_lines:true,relax_column_count:false,max_record_size:12000}) as string[][];
  if(!rows.length||rows.length>2001||rows[0].length>40)throw new Error('表格最多 2000 行、40 列且需要表头');
  const header=rows[0].map(x=>x.trim());if(header.some(x=>!x)||new Set(header).size!==header.length)throw new Error('表头不能为空或重复');
  const keyColumns=data.keyColumns??[];
  if(!Array.isArray(keyColumns)||keyColumns.some(k=>typeof k!=='string'||!header.includes(k)))throw new Error('去重列必须来自表头');
  if(data.deduplicate===true&&!keyColumns.length)throw new Error('请选择去重依据列');
  const indexes=keyColumns.map(k=>header.indexOf(k)),seen=new Set<string>();let removed=0;
  let body=rows.slice(1).map(r=>r.map(x=>data.trim===false?x:x.trim()));
  if(data.deduplicate===true)body=body.filter(r=>{const values=indexes.map(i=>r[i]);if(values.some(x=>!x))return true;const key=JSON.stringify(values);if(seen.has(key)){removed++;return false;}seen.add(key);return true;});
  if(operation==='customers'){
    const i=header.indexOf('最近交易日期');if(i<0)throw new Error('客户分组需要“最近交易日期”列');
    const ref=isoDate(data.referenceDate),days=data.inactiveDays;if(typeof days!=='number'||!Number.isInteger(days)||days<1||days>3650)throw new Error('回访周期必须是 1–3650 天');
    header.push('距最近交易天数','回访分组');
    body=body.map(r=>{let elapsed:number;try{elapsed=Math.floor((ref-isoDate(r[i]))/86400000);}catch{return [...r,'','日期待核实'];}return [...r,String(elapsed),elapsed<0?'日期待核实':elapsed>=days?'可考虑回访':'正常周期内'];});
  }else if(operation!=='clean')throw new Error('表格操作无效');
  return {rows:[header,...body],inputRows:rows.length-1,outputRows:body.length,duplicatesRemoved:removed};
}
function isoDate(value:unknown){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))throw new Error('日期需要 YYYY-MM-DD 格式');
  const n=Date.parse(value+'T00:00:00Z');if(!Number.isFinite(n)||new Date(n).toISOString().slice(0,10)!==value)throw new Error('日期无效');return n;
}
export async function tableFileToCsv(bytes:Buffer,filename:string){
  if(bytes.length>2*1024*1024)throw new Error('首版表格处理支持不超过 2MB 的文件');
  if(/\.csv$/i.test(filename))return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  if(!/\.xlsx$/i.test(filename))throw new Error('请上传 CSV 或 XLSX 文件');
  // Bound every expanded XML member before the spreadsheet parser sees it.
  const zip=await JSZip.loadAsync(bytes);const entries=Object.values(zip.files).filter(f=>!f.dir);
  if(entries.length>100)throw new Error('表格结构过于复杂');let expanded=0;
  for(const entry of entries)await new Promise<void>((resolve,reject)=>{const stream=entry.nodeStream();stream.on('data',(chunk:Buffer)=>{expanded+=chunk.length;if(expanded>8*1024*1024){stream.pause();reject(new Error('表格解压内容过大'));}});stream.on('error',reject);stream.on('end',resolve);});
  const book=XLSX.read(bytes,{type:'buffer',sheetRows:2002,cellFormula:false,cellHTML:false});
  if(book.SheetNames.length!==1)throw new Error('请保留一个工作表后再处理，避免忽略其他工作表');
  const sheet=book.Sheets[book.SheetNames[0]],range=XLSX.utils.decode_range(sheet['!ref']??'A1');
  if(range.e.r>2000||range.e.c>39)throw new Error('首版表格最多 2000 行数据、40 列');
  return XLSX.utils.sheet_to_csv(sheet);
}
export function tableWorkbook(rows:(string|number|boolean|null)[][]){
  const book=XLSX.utils.book_new();
  // Strings remain string cells, including values beginning with =, +, @.
  XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet(rows),'结果');
  return XLSX.write(book,{type:'buffer',bookType:'xlsx'}) as Buffer;
}

export function stringifyTableCsv(rows:(string|number|boolean|null)[][]){return rows.map(r=>r.map(v=>{const s=String(v??'');return /[",\r\n]/.test(s)?'"'+s.replaceAll('"','""')+'"':s;}).join(',')).join('\n');}
