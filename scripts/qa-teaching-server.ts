/** Local-only QA: isolated records and a synthetic model. Never imported by the app. */
import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installTeachingRoutes } from '../server/teachingRoutes.js';
import { installTeachingFileRoutes } from '../server/teachingFiles.js';
import { installTeachingAiRoutes } from '../server/teachingAiRoutes.js';
import { installTeachingKnowledgeRoutes } from '../server/teachingKnowledgeRoutes.js';
import { AttachmentService } from '../server/attachmentService.js';
import type { Store } from '../server/db.js';
import type { Database, ModelConfig } from '../server/types.js';
import { createTeachingCourse, createTeachingActivity, publishTeachingCourse } from '../server/teaching.js';

const now = new Date().toISOString(), directory = process.env.ONE_TEACHING_QA_DIR ?? await fs.mkdtemp(path.join(os.tmpdir(), 'one-teaching-qa-'));
const scope = { workspaceId: 'qa-workspace', userId: 'qa-teacher' };
const model: ModelConfig = { id: 'qa-model', name: '隔离模拟模型', provider: 'fixture', kind: 'chat', protocol: 'openai', baseUrl: 'http://127.0.0.1', apiKey: 'fixture-not-a-real-key', model: 'fixture', systemPrompt: '', enabled: true, isDefault: true, inputPowerPerMillion: 1, outputPowerPerMillion: 1, costInputPowerPerMillion: 1, costOutputPowerPerMillion: 1, createdAt: now };
let db = { users: [{ id: scope.userId, username: '教学体验老师', passwordHash: '', role: 'user', defaultWorkspaceId: scope.workspaceId, enabled: true, createdAt: now }], workspaces: [{ id: scope.workspaceId, name: '隔离教学体验', slug: 'qa', status: 'active', createdAt: now, updatedAt: now }], workspaceMembers: [{ id: 'qa-member', ...scope, role: 'owner', createdAt: now }], models: [model], attachments: [], modelUsageRecords: [], powerAccounts: [{ id: 'qa-power', ...scope, balanceMicros: 100_000_000, reservedMicros: 0, createdAt: now, updatedAt: now }], powerLedger: [], rechargeOrders: [], auditLogs: [], conversations: [], messages: [], chatOperations: [], settings: { safetyRules: '只处理隔离测试资料。', rechargeCnyPerPower: 7 }, publications: [], publicSessions: [], publicRuns: [], knowledgeConnections: [] } as unknown as Database;
try { db = JSON.parse(await fs.readFile(path.join(directory, 'qa-state.json'), 'utf8')); } catch { /* Fresh isolated fixture. */ }
const store: Store = { read: async () => db, mutate: async fn => { const before = structuredClone(db); try { const result = fn(db); await fs.writeFile(path.join(directory, 'qa-state.json'), JSON.stringify(db)); return result; } catch (e) { for (const key of Object.keys(db)) delete (db as any)[key]; Object.assign(db, before); throw e; } } };
if(process.env.ONE_TEACHING_QA_STORY==='1'&&!db.users[0].teaching?.courses.length){
 db.knowledgeConnections.push({id:'qa-notion',workspaceId:scope.workspaceId,provider:'notion',status:'connected',clientId:'qa-client',providerUserId:'qa-notion-owner',providerSpaceId:'qa-notion-space',encryptedAccessToken:'qa-fixture-not-a-credential',createdAt:now,updatedAt:now});
 const course=createTeachingCourse(db,scope,{title:'杭州通论 · 五轮历史情境验收',subject:'隔离测试',budgetMicros:10000000,knowledgeSources:[{connectionId:'qa-notion',scope:'page',pageId:'11111111111111111111111111111111'}]});
 createTeachingActivity(db,scope,course.id,{revision:course.revision,stage:'before',kind:'inquiry',title:'从学习到创作',instructions:'围绕杭州普通人的处境学习并创作五轮历史情境。',status:'published'});
 publishTeachingCourse(db,scope,course.id,{revision:course.revision,confirmed:true});
 await fs.writeFile(path.join(directory,'qa-state.json'),JSON.stringify(db));
 process.stdout.write('Story QA slug: '+course.slug+'\n');
}
if (process.env.ONE_TEACHING_QA_SEED === '1') {
const course = createTeachingCourse(db, scope, { title: '杭州通论 · 教学体验', subject: '人文通识', description: '隔离示例课程，用于体验备课、情境和课后反馈。', materialText: '苏轼任杭州知州期间组织疏浚西湖，并利用淤泥修筑长堤，后人称为苏堤。课程引导学生理解水利、交通与城市生活的关系。', budgetMicros: 1_000_000 });
createTeachingActivity(db, scope, course.id, { revision: course.revision, stage: 'before', kind: 'inquiry', title: '从一条堤认识杭州', instructions: '先阅读课程资料，提出你最想了解的问题。', status: 'published', questions: [{ id: 'interest', prompt: '你希望进一步了解哪一方面？', type: 'text', options: [], answer: '', points: 0 }] });
createTeachingActivity(db, scope, course.id, { revision: course.revision, stage: 'during', kind: 'scenario', title: '如果你参与修堤', instructions: '阅读情境，选择行动，再说说理由。', status: 'published', scenes: [{ id: 'scene1', title: '先了解问题', content: '西湖淤积影响城市生活，你会先做什么？', choices: ['了解居民和船户的困难', '立刻宣布开工'], reflection: '工程决策需要先理解不同人的实际需要。' }, { id: 'scene2', title: '处理淤泥', content: '疏浚产生大量淤泥，怎样将它转化为城市资源？', choices: ['结合水利与交通需求修堤', '仅把淤泥堆在岸边'], reflection: '结合教材，思考一项工程如何同时改变交通与生活。' }] });
createTeachingActivity(db, scope, course.id, { revision: course.revision, stage: 'after', kind: 'assignment', title: '一条堤与一座城', instructions: '结合材料，说明修建苏堤与杭州城市生活的关系，并提出自己的观察。', status: 'published', rubric: [{ id: 'facts', label: '材料理解', description: '准确使用课程材料中的事实。', maxScore: 40 }, { id: 'analysis', label: '分析与表达', description: '说明工程与城市生活的关系，表达个人观察。', maxScore: 60 }] });
createTeachingActivity(db, scope, course.id, { revision: course.revision, stage: 'after', kind: 'quiz', title: '课后小测验', instructions: '依据课程资料完成测试。', status: 'published', questions: [{ id: 'q1', prompt: '苏堤与哪位历史人物有关？', type: 'single', options: ['苏轼', '白居易'], answer: '苏轼', points: 100 }] });
}
const sampleMaterial = '苏轼任杭州知州期间组织疏浚西湖，并利用淤泥修筑长堤，后人称为苏堤。';
if(!db.knowledgeConnections.some(connection=>connection.id==='qa-notion'))db.knowledgeConnections.push({id:'qa-notion',workspaceId:scope.workspaceId,provider:'notion',status:'connected',clientId:'qa-client',providerUserId:'qa-notion-owner',providerSpaceId:'qa-notion-space',providerSpaceName:'体验用教学知识库',encryptedAccessToken:'qa-fixture-not-a-credential',createdAt:now,updatedAt:now});
const knowledge = {notion:{readDocument:async()=>({structuredContent:{title:'杭州城市文化讲义',text:sampleMaterial}})}};
const app = express(); app.use(express.json({ limit: '2mb' }));
const auth: express.RequestHandler = (req, res, next) => { if (req.headers['x-one-user'] !== scope.userId || req.headers['x-one-workspace'] !== scope.workspaceId) { res.status(401).json({ error: '仅用于隔离教学体验' }); return; } req.user = db.users[0]; req.workspaceId = scope.workspaceId; next(); };
app.get('/api/features',auth,(_req,res)=>res.json({items:[],total:0}));
app.get('/api/features/runs',auth,(_req,res)=>res.json({items:[],total:0}));
app.get('/api/teaching/qa-state',auth,(_req,res)=>res.json({courses:db.users[0].teaching?.courses.length??0,submissions:db.users[0].teaching?.submissions.length??0,operations:db.users[0].teaching?.operations.length??0}));
installTeachingRoutes(app, [auth], store);
installTeachingKnowledgeRoutes(app,[auth],store,{...knowledge,verifyKey:async()=>{}});
installTeachingFileRoutes(app, [auth], store, directory, new AttachmentService(store, directory));
installTeachingAiRoutes(app, [auth], store, { verifyKey: async () => {}, knowledge, modelCall: async (_model, messages) => {
  const instruction = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
  const data = JSON.parse(String(messages.find(m => m.role === 'user')?.content ?? '{}')).untrustedTeachingData ?? {};
  let result: unknown;
  if(instruction.includes('审核学生历史剧本'))result={approved:!data.script.includes('穿越'),title:'一船淤泥，一城春水',role:'参与疏浚的杭州船工',event:'苏轼疏浚西湖并筑堤',feedback:data.script.includes('穿越')?'请移除穿越设定，改为宋代普通船工，并提供史料依据。':'普通人身份与史实相符。建议保留农时与工程的冲突；船工姓名与遭遇为虚构。',annotations:data.script.includes('穿越')?[{excerpt:'穿越',comment:'不符合普通历史人物要求，请修改。'}]:[],citations:[{quote:'苏轼任杭州知州期间组织疏浚西湖'}]};
  else if(instruction.includes('编译为五轮'))result={directorPrompt:'宋代杭州船工，五轮生计与工程冲突，史实不可改写。'};
  else if(instruction.includes('五次关键决策'))result={answer:data.round===5?'【虚构结局】你和邻里分摊农活，把最后一船淤泥送到了堤岸。你的名字没有留在碑记里，家人却记住了这个春天。苏堤渐成，小人物的劳作汇入杭州的城市变迁。':`【虚构情境 · 第${data.round+1}幕】清晨的西湖边，船工把湿透的缆绳搭上肩头。家里的春耕还没忙完，疏浚的工期却不能等。你听见工头在催船，邻居又托人捎来求助。你需要作出选择。`,choices:data.round===5?[]:['先帮邻居安排农活，再赶回工地','按时赶到工地，托熟人照顾家里'],historyExplanation:data.round===5?'课程史料记载：苏轼组织疏浚西湖，并利用淤泥修筑长堤。船工的姓名、家庭和五次抉择是教学虚构；个人经历并未改写工程的真实基本走向。':'',reflection:data.round===5?'当公共工程与家庭生计冲突时，你的选择受哪些社会条件影响？':'',imagePrompt:data.round===5?'宋代杭州西湖清晨，一位普通船工站在新筑堤岸边，历史教学插画，无文字。':''};
  else if (instruction.includes('连续文字游戏')) result = {answer: data.history?.length?'村民回应了你上一轮的建议。你观察水位后，需要决定如何分配人力。':'你来到一处临水的村落。居民希望你先了解河道淤积带来的困难。你准备怎么做？',choices:['先听取居民意见','沿河观察水位']};
  else if (instruction.includes('criterionId 必须')) result = { criteria: data.criteria.map((r: any) => ({ criterionId: r.id, score: r.maxScore * .8, comment: '已结合材料，可进一步解释自己的观察。', evidence: String(data.work?.text || data.work?.attachmentText || '').slice(0, 12) })), feedback: '整体内容完整，建议补充具体观察。此为隔离模拟结果。' };
  else if (instruction.includes('群体关注主题')) result = { summary: '已提交记录关注城市工程与生活之间的联系。', topics: [{ label: '城市与生活', count: 1 }], suggestions: ['结合材料比较不同的城市需求。'] };
  else if (instruction.includes('locationCandidates')) result = { answer: '课程材料说明，苏轼疏浚西湖，并利用淤泥修筑长堤。可以继续思考它如何影响交通与城市生活。', materialInsufficient: false, needsLocationClarification: false, locationCandidates: [], citations: [{ source: 'material', quote: '苏轼任杭州知州期间组织疏浚西湖' }] };
  else if(instruction.includes('仅整理老师提供的试卷')) result={instructions:'根据老师提供的试卷作答。',questions:[{id:'q1',prompt:'苏堤与哪位历史人物有关？',type:'single',options:['苏轼','白居易'],answer:'苏轼',points:100,citation:{source:'attachment',quote:'苏堤与哪位历史人物有关'}}]};
  else result = { instructions: '先阅读材料，提出一个关于城市生活的问题。' };
  return { content: JSON.stringify(result), toolCalls: [], finishReason: 'stop', usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200, source: 'provider' } };
} });
app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(400).json({ error: error.message }));
app.listen(Number(process.env.ONE_TEACHING_QA_PORT??3141), '127.0.0.1', () => process.stdout.write(`Teaching QA API; isolated files ${directory}\n`));
