import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {coordinatorInputFeedback} from './coordinatorInput.js';

function functionIn(file:string,name:string){
 const source=readFileSync(new URL(file,import.meta.url),'utf8'),ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let found:ts.FunctionDeclaration|undefined;
 const visit=(node:ts.Node)=>{if(ts.isFunctionDeclaration(node)&&node.name?.text===name)found=node;ts.forEachChild(node,visit);};visit(ast);
 assert.ok(found);const code=ts.transpileModule(found.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
 return new Function('context',`with(context){${code};return ${name};}`);
}
test('the actual main composer refuses oversize text before removing draft, attachments or features',async()=>{
 const text='首'+'中'.repeat(32000)+'尾',files=[{id:'owned-template'}],features=[{id:'selected-feature'}];let error='',mutations=0;
 const context={coordinatorInputFeedback,featurePicker:{close:()=>{}},demo:{enabled:false},coordinator:{enabled:true},currentModel:{kind:'chat'},composeNew:false,draftAgentId:'',setError:(value:string)=>{error=value;},currentDraftRef:{current:{content:text,attachments:files}},pendingAttachments:files,featureForNext:features,setContent:()=>{mutations++;},setPendingAttachments:()=>{mutations++;},setFeatureForNext:()=>{mutations++;}};
 const send=functionIn('./main.tsx','sendMessage')(context);
 assert.equal(await send(text),false);assert.match(error,/32,000.*附件/);assert.equal(mutations,0);assert.equal(context.currentDraftRef.current.content,text);assert.deepEqual(files,[{id:'owned-template'}]);assert.deepEqual(features,[{id:'selected-feature'}]);
});
test('the actual task form retains its draft and does not call onSend when text exceeds the shared limit',async()=>{
 const source=readFileSync(new URL('./ThingsPanel.tsx',import.meta.url),'utf8'),ast=ts.createSourceFile('ThingsPanel.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let handler:ts.Expression|undefined;
 const visit=(node:ts.Node)=>{
  if(ts.isJsxOpeningElement(node)&&node.tagName.getText(ast)==='form'&&node.attributes.properties.some(p=>ts.isJsxAttribute(p)&&p.name.getText(ast)==='className'&&p.initializer&&ts.isStringLiteral(p.initializer)&&p.initializer.text==='things-compose')){
   const attribute=node.attributes.properties.find(p=>ts.isJsxAttribute(p)&&p.name.getText(ast)==='onSubmit');
   if(attribute&&ts.isJsxAttribute(attribute)&&attribute.initializer&&ts.isJsxExpression(attribute.initializer))handler=attribute.initializer.expression;
  }ts.forEachChild(node,visit);
 };visit(ast);assert.ok(handler);
 const code=ts.transpileModule(`const handle=${handler.getText(ast)};`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
 const draft='🐈'.repeat(16001);let error='',sends=0,clears=0;
 const context={draft,selected:{id:'owned-task',messagesLoaded:true},inFlight:{current:new Set<string>()},coordinatorInputFeedback,setErrors:(fn:(value:Record<string,string>)=>Record<string,string>)=>{error=fn({})['owned-task'];},setSending:()=>{},onSend:async()=>{sends++;},onDraftChange:()=>{clears++;}};
 await new Function('context',`with(context){${code};return handle;}`)(context)({preventDefault:()=>{}});
 assert.match(error,/32,000/);assert.equal(sends,0);assert.equal(clears,0);assert.equal(context.draft,draft);assert.equal(context.inFlight.current.size,0);
});
