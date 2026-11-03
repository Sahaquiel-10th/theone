import test from 'node:test';
import assert from 'node:assert/strict';
import type {TeachingActivity,TeachingCourse,TeachingKnowledgeSource,TeachingOperation} from '../server/teachingTypes';
import {decodeTeacherDrafts,draftFromTeachingCourse,encodeTeacherDrafts,newTeacherTask,restoredTeacherOperation,sameTeacherIdentity,snapshotTeacherFiles,teacherDraftStorageKey,teacherSavePayloads,teacherTaskHasInsights,teacherTaskStudentPrivacy,teacherPreparationAction,teacherStepProblem,teacherStudentPreview,teacherTasks} from './teacherTaskState';

const owner={userId:'teacher-a',workspaceId:'workspace-a',revision:4};
const source={provider:'notion',connectionId:'connection',binding:'authorized-binding',scope:'page',pageId:'lesson',label:'课程页'} as TeachingKnowledgeSource;
test('choosing one of four tasks creates a local, resumable draft without a course or operation',()=>{
  assert.deepEqual(teacherTasks.map(t=>t.kind),['grade','ask','quiz','game']);
  for(const kind of ['grade','ask','quiz','game'] as const){const d=newTeacherTask(kind,'stable-draft','now');assert.equal(d.id,'stable-draft');assert.equal(d.step,0);assert.equal(d.remote,undefined);assert.equal(d.operationId,undefined);assert.equal(d.pending,undefined);assert.equal(d.intake.text,'');}
  assert.equal(newTeacherTask('game','game').activity.kind,'game');assert.equal(newTeacherTask('game','game').activity.allowStudentPrompt,true);assert.equal(newTeacherTask('grade','grade').activity.kind,'assignment');
});
test('draft storage remains separate across owners, workspaces and ambiguous key characters',()=>{
  const d=newTeacherTask('grade','draft');d.step=2;d.intake.text='真实作业';d.pending={type:'ai',operationId:'the-original-request',payload:'{"kind":"grade"}'};
  const encoded=encodeTeacherDrafts([d],owner);assert.deepEqual(decodeTeacherDrafts(encoded,owner),[d]);
  assert.deepEqual(decodeTeacherDrafts(encoded,{...owner,userId:'teacher-b'}),[]);assert.deepEqual(decodeTeacherDrafts(encoded,{...owner,workspaceId:'workspace-b'}),[]);
  assert.notEqual(teacherDraftStorageKey({userId:'a:b',workspaceId:'c'}),teacherDraftStorageKey({userId:'a',workspaceId:'b:c'}));
  assert.deepEqual(decodeTeacherDrafts('{broken',owner),[]);assert.deepEqual(decodeTeacherDrafts(encoded,{userId:'',workspaceId:''}),[]);
});
test('even the same account cannot continue a write after its session generation changes',()=>{
  assert.equal(sameTeacherIdentity(owner,{...owner}),true);assert.equal(sameTeacherIdentity(owner,{...owner,revision:5}),false);assert.equal(sameTeacherIdentity(owner,{...owner,workspaceId:'other'}),false);
});
test('grading and quiz reference material never enter public course learning sources',()=>{
  for(const kind of ['grade','quiz'] as const){const d=newTeacherTask(kind,'private');d.materialText='不可公开';d.materialFiles=[{id:'private-file',originalName:'参考'}];d.referenceText='答案与评分参考';d.referenceFiles=[{id:'reference-file',originalName:'答案'}];d.knowledgeSources=[source];
    const saved=teacherSavePayloads(d);assert.equal(saved.course.materialText,'');assert.deepEqual(saved.course.materialAttachmentIds,[]);assert.deepEqual(saved.course.knowledgeSources,[]);assert.equal(saved.activity.referenceText,'答案与评分参考');assert.deepEqual(saved.activity.sourceAttachmentIds,['reference-file']);assert.deepEqual(saved.activity.knowledgeSources,[source]);
  }
});
test('learning references stay references and do not copy knowledge preview text into course material',()=>{
  const d=newTeacherTask('ask','ask');d.materialText='老师自己粘贴的讲义';d.knowledgeSources=[source];const saved=teacherSavePayloads(d);
  assert.equal(saved.course.materialText,'老师自己粘贴的讲义');assert.deepEqual(saved.course.knowledgeSources,[source]);assert.deepEqual(saved.activity.knowledgeSources,[]);assert.equal(saved.activity.referenceText,'');
});
test('student preview projects only visible questions, never private answers or teacher references',()=>{
  const d=newTeacherTask('quiz','quiz');d.referenceText='秘密答案';d.knowledgeSources=[source];d.activity.avatarPrompt='教师内部提示';d.activity.questions=[{id:'q1',prompt:'公开题干',type:'single',options:['甲','乙'],answer:'乙',points:10}];
  const preview=teacherStudentPreview(d),serialized=JSON.stringify(preview);assert.equal(preview.questions[0].prompt,'公开题干');assert.ok(!serialized.includes('answer'));assert.ok(!serialized.includes('秘密答案'));assert.ok(!serialized.includes('binding'));assert.ok(!serialized.includes('教师内部提示'));
});
test('step validation follows the teacher task: work is needed for grading, game materials are optional, quiz allows manual entry',()=>{
  const grade=newTeacherTask('grade','grade');assert.ok(teacherStepProblem(grade));grade.intake.text='学生真实作业';assert.equal(teacherStepProblem(grade),'');
  assert.equal(teacherStepProblem(newTeacherTask('game','game')),'');assert.equal(teacherStepProblem(newTeacherTask('quiz','quiz')),'');assert.ok(teacherStepProblem(newTeacherTask('ask','ask')));
  const quiz=newTeacherTask('quiz','quiz');quiz.step=1;quiz.title='真实试卷';assert.ok(teacherStepProblem(quiz));quiz.activity.questions=[{id:'q',prompt:'题干',type:'single',options:['A','B'],answer:'不存在',points:10}];assert.ok(teacherStepProblem(quiz));quiz.activity.questions[0].answer='A';assert.equal(teacherStepProblem(quiz),'');
});
test('recovery reads the same operation or the latest current activity, without choosing another activity',()=>{
  const ops=[{id:'other',operationId:'client-other',activityId:'other-activity'},{id:'current',operationId:'client-current',activityId:'current-activity'}] as TeachingOperation[];
  assert.equal(restoredTeacherOperation(ops,'current-activity')?.id,'current');assert.equal(restoredTeacherOperation(ops,'current-activity','client-current')?.id,'current');assert.equal(restoredTeacherOperation(ops,'current-activity','older-persisted-id'),undefined);assert.equal(restoredTeacherOperation(ops,'missing'),undefined);
});
test('opening a saved task restores its private sources and enters its existing preview without creating another container',()=>{
  const activity={id:'activity',kind:'assignment',title:'已有作业',stage:'after',instructions:'真实要求',questions:[],scenes:[],rubric:[],knowledgeSources:[source],referenceText:'教师参考',sourceAttachmentIds:['ref']} as unknown as TeachingActivity;
  const course={id:'course',revision:4,title:'旧任务',taskKind:'grade',clientDraftId:'stable-draft',materialText:'',materialAttachmentIds:[],knowledgeSources:[],budgetMicros:5e6,updatedAt:'now'} as unknown as TeachingCourse;
  const d=draftFromTeachingCourse(course,activity);assert.equal(d.id,'stable-draft');assert.equal(d.step,2);assert.deepEqual(d.remote,{courseId:'course',activityId:'activity'});assert.deepEqual(d.knowledgeSources,[source]);assert.equal(d.referenceText,'教师参考');
});


test('upload captures the live FileList before an asynchronous container save and input reset',async()=>{
  for(const target of ['work','materials','reference']){
    const first={name:`${target}-first.docx`},second={name:`${target}-second.pdf`};
    let liveFiles=[first,second];
    const liveFileList={get length(){return liveFiles.length;},get 0(){return liveFiles[0];},get 1(){return liveFiles[1];}};
    let releaseContainer!:()=>void;
    const containerReady=new Promise<void>(resolve=>{releaseContainer=resolve;});
    const uploaded:typeof first[]=[];
    const upload=async()=>{const selectedFiles=snapshotTeacherFiles(liveFileList);await containerReady;for(const file of selectedFiles)uploaded.push(file);};
    const pending=upload();liveFiles=[];releaseContainer();await pending;
    assert.equal(liveFileList.length,0);assert.deepEqual(uploaded,[first,second],`${target} retains both original File objects`);
  }
  assert.deepEqual(snapshotTeacherFiles(null),[]);
});


test('private classroom game dialogue is not presented as teacher learning analytics',()=>{
  assert.equal(teacherTaskHasInsights('game'),false);assert.equal(teacherTaskHasInsights('ask'),true);assert.equal(teacherTaskHasInsights('quiz'),false);
  assert.equal(teacherTaskStudentPrivacy('game'),'学生各自的角色设定与游戏对话不会自动交给老师。课后可另发作业收取学习反思。');assert.ok(!teacherTaskStudentPrivacy('game').includes('汇总'));
  assert.ok(teacherTaskStudentPrivacy('ask').includes('去身份的学情汇总'));assert.ok(teacherTaskStudentPrivacy('quiz').includes('参考答案保持私有'));
});


test('applying preparation asks before replacing local edits even when the saved course revision still matches',()=>{
  const draft=newTeacherTask('quiz','quiz');draft.activity.instructions='已保存说明';draft.activity.questions=[{id:'q',prompt:'已保存题目',type:'text',options:[],answer:'参考答案',points:10}];
  const activity={...structuredClone(draft.activity),id:'activity'} as TeachingActivity;
  const course={revision:4,activities:[activity]} as TeachingCourse;
  const operation={id:'prepare-operation',kind:'prepare',status:'completed',courseRevision:4,activityId:'activity'} as TeachingOperation;
  assert.equal(teacherPreparationAction(draft,operation,course),'apply');
  draft.activity.referenceText='新私有参考';assert.equal(teacherPreparationAction(draft,operation,course),'apply');
  draft.activity.questions[0].prompt='老师未保存的新题目';assert.equal(teacherPreparationAction(draft,operation,course),'confirm');
  draft.appliedPreparationId=operation.id;assert.equal(teacherPreparationAction(draft,operation,course),'applied');
  draft.appliedPreparationId=undefined;assert.equal(teacherPreparationAction(draft,operation,{...course,revision:5}),'stale');
  draft.activity={...structuredClone(activity),referenceText:activity.referenceText??'',sourceAttachmentIds:activity.sourceAttachmentIds??[]};draft.activity.instructions='老师未保存的新说明';assert.equal(teacherPreparationAction(draft,operation,course),'confirm');
});
