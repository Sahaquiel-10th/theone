import test from 'node:test';
import assert from 'node:assert/strict';
import {assertLocalAdmission,assertLocalAdmissionRevision,assertLocalDirectoryUnchanged} from './localExecutionAdmission.js';
const scope={workspaceId:'w',userId:'u',deviceId:'device',installationId:'installation',conversationId:'task',sourceMessageId:'source'};
const ready:any={connected:true,ready:true,folder:{state:'ready',targetName:'/owned/a'},executor:{state:'ready'},reason:'ready'};
test('every real entry checks exact device/installation/original folder before compilation',()=>{
 const db:any={chatOperations:[{...scope,workRun:{executionMode:'local',inputMessageId:'source',localExecution:{deviceId:'device',installationId:'installation',targetName:'/owned/a',admissionRevision:1}}}]};
 assert.doesNotThrow(()=>assertLocalAdmission(db,scope,ready));
 for(const changed of [{deviceId:'other'},{installationId:'other'}])assert.throws(()=>assertLocalAdmission(db,{...scope,...changed},ready),/local_binding_changed/);
 assert.throws(()=>assertLocalAdmission(db,scope,{...ready,folder:{state:'ready',targetName:'/owned/b'}}),/local_binding_changed/);
 assert.throws(()=>assertLocalAdmission(db,scope,{...ready,connected:false}),/local_device_offline/);
 assert.doesNotThrow(()=>assertLocalAdmission(db,{...scope,userId:'foreign'},ready),'foreign prepared record is not consumed; owner route still authorizes task');
});
test('late old compiler cannot pass the fence after retry reopens original prepared source',()=>{
 const binding={admissionRevision:1};const db:any={chatOperations:[{...scope,workRun:{executionMode:'local',inputMessageId:'source',localExecution:binding}}]};
 assert.doesNotThrow(()=>assertLocalAdmissionRevision(db,scope,1));
 binding.admissionRevision=2;
 assert.throws(()=>assertLocalAdmissionRevision(db,scope,1),/local_binding_changed/);
 assert.doesNotThrow(()=>assertLocalAdmissionRevision(db,scope,2));
 assert.throws(()=>assertLocalAdmissionRevision(db,scope,undefined),/local_binding_changed/);
});
test('historical and direct inputs also retain the initial directory through a slow compile',async()=>{
 const originalRevision=1;const binding={admissionRevision:originalRevision};const db:any={chatOperations:[{...scope,workRun:{inputMessageId:'source',localExecution:binding}}]};
 let finish!:()=>void;
 const old=(async()=>{const captured=binding.admissionRevision;await new Promise<void>(resolve=>{finish=resolve;});assertLocalAdmissionRevision(db,scope,captured);})();
 binding.admissionRevision=2;finish();await assert.rejects(old,/local_binding_changed/);
 assert.throws(()=>assertLocalDirectoryUnchanged(ready,{...ready,folder:{state:'ready',targetName:'/owned/b'}}),/local_binding_changed/);
 assert.doesNotThrow(()=>assertLocalDirectoryUnchanged(ready,ready));
});
