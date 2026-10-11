import fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
const root=path.resolve('skills-library/one'),out=path.resolve('output/one-skills');await fs.mkdir(out,{recursive:true});
const manifest=JSON.parse(await fs.readFile(path.join(root,'manifest.json'),'utf8')),bundle=new JSZip();
for(const skill of manifest){const zip=new JSZip();for(const file of ['SKILL.md','config.json','references/examples.md']){const bytes=await fs.readFile(path.join(root,skill.id,file));zip.file(file,bytes);bundle.file(`本地技能/${skill.id}/${file}`,bytes);}const bytes=await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});await fs.writeFile(path.join(out,skill.id+'.zip'),bytes);bundle.file(`后台单项导入包/${skill.id}.zip`,bytes);}
bundle.file('本地技能/README.md',await fs.readFile(path.join(root,'README.md')));bundle.file('本地技能/manifest.json',await fs.readFile(path.join(root,'manifest.json')));
for(const file of ['profit.json','promotion.json','quote.json'])bundle.file('本地技能/shared/examples/'+file,await fs.readFile(path.join(root,'shared/examples',file)));
for(const file of ['finance.mjs','finance.d.mts'])bundle.file('本地技能/shared/scripts/'+file,await fs.readFile(path.join(root,'shared/scripts',file)));
bundle.file('使用说明.txt','24项ONE独立编写的第一版技能。后台：官方智能体→ONE内置功能，可批量添加；也可逐个上传“后台单项导入包”中的ZIP。每项独立配置模型、提示词、选项和按钮，认定后选择接收账号上架。脚本是ONE自有内置能力，上传包中的任意脚本不会自动运行。图片功能需要图片模型；宠物医院医学内容需要医院审核。');
await fs.writeFile(path.join(out,'ONE-24项技能首版.zip'),await bundle.generateAsync({type:'nodebuffer',compression:'DEFLATE'}));console.log(`已保存24个导入包与合集：${out}`);
