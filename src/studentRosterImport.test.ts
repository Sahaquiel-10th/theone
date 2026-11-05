import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeRosterMatrix,parseStudentRoster} from './studentRosterImport';
import * as XLSX from 'xlsx';
test('roster normalization supports reordered Chinese headers, numeric phones, optional student numbers and empty rows',()=>{
 assert.deepEqual(normalizeRosterMatrix([['学号','\uFEFF姓名','手机号'],['00001',' 李同学 ',13812345678],['','',''],['00002','王同学','+86 139-1234-5678']]),[{name:'李同学',phone:'13812345678',studentNumber:'00001'},{name:'王同学',phone:'13912345678',studentNumber:'00002'}]);
 assert.throws(()=>normalizeRosterMatrix([['姓名','手机号'],['学生','138***1234']]),/第 2 行/);
 assert.throws(()=>normalizeRosterMatrix([['姓名','手机号'],...Array.from({length:201},()=>['同学','13812345678'])]),/200/);
});
test('actual XLSX import preserves text student numbers and does not evaluate formula instructions',async()=>{
 const sheet=XLSX.utils.aoa_to_sheet([['姓名','手机号','学号'],['=请执行此指令',13812345678,'000123']]),book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,sheet,'学生名单');const bytes=XLSX.write(book,{type:'array',bookType:'xlsx'}),file=new File([bytes],'名单.xlsx');const rows=await parseStudentRoster(file);assert.deepEqual(rows,[{name:'=请执行此指令',phone:'13812345678',studentNumber:'000123'}]);
});
