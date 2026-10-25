/** Read-only metadata for one explicitly supplied support task. Never loads or migrates Store. */
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

dotenv.config({path:process.env.ONE_SUPPORT_ENV||'/srv/theone/shared/.env',quiet:true});
const taskId=process.argv[2];
if(!/^cnv_[a-zA-Z0-9_-]{8,90}$/.test(taskId||''))throw Error('Supply one exact task id.');
const connection=await mysql.createConnection({host:process.env.MYSQL_HOST,port:Number(process.env.MYSQL_PORT||3306),user:process.env.MYSQL_USER,password:process.env.MYSQL_PASSWORD,database:process.env.MYSQL_DATABASE,connectTimeout:5000});
const decode=value=>typeof value==='string'?JSON.parse(value):value;
try{
 await connection.query('START TRANSACTION READ ONLY');
 const [records]=await connection.execute('SELECT record_json FROM conversations WHERE id=? LIMIT 1',[taskId]);
 if(!records.length)throw Error('Task not found.');
 const task=decode(records[0].record_json);
 const [rows]=await connection.execute('SELECT record_json FROM chat_operations WHERE workspace_id=? AND user_id=? AND parent_id=? ORDER BY created_at',[task.workspaceId,task.userId,taskId]);
 const jobs=rows.map(row=>decode(row.record_json)).filter(operation=>operation.workRun);
 console.log('TASK',JSON.stringify({taskId,paused:task.workPaused,pauseReason:task.workPauseReason,pageId:task.notionDocument?.pageId,jobs:jobs.length}));
 for(const operation of jobs.slice(-6))console.log('JOB',JSON.stringify({id:operation.id,createdAt:operation.createdAt,updatedAt:operation.updatedAt,status:operation.status,state:operation.workRun.state,outcome:operation.workRun.resultOutcome,failureCode:operation.workRun.failureCode,requiredTools:operation.workRun.contract?.requiredTools,notion:operation.workRun.notionReceipt?{state:operation.workRun.notionReceipt.state,delivery:operation.workRun.notionReceipt.delivery,pageId:operation.workRun.notionReceipt.pageId}:undefined,steps:(operation.workRun.steps||[]).map(step=>({namespace:step.namespace,tool:step.tool,effect:step.effect,state:step.state,updatedAt:step.updatedAt,status:step.output?.status}))}));
 const [traces]=await connection.execute('SELECT record_json FROM context_traces WHERE workspace_id=? AND user_id=? AND parent_id=? ORDER BY created_at DESC LIMIT 6',[task.workspaceId,task.userId,taskId]);
 for(const row of traces){const trace=decode(row.record_json);console.log('TRACE',JSON.stringify({createdAt:trace.createdAt,steps:(trace.executionSteps||[]).map(step=>({tool:step.tool,status:step.status,failureCode:step.failureCode,durationMs:step.durationMs}))}));}
 await connection.rollback();
}finally{await connection.end();}
