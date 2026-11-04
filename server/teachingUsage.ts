import type {Database} from './types.js';
import type {TeachingScope} from './teachingTypes.js';
import {ownedTeachingCourse,teachingConversationId} from './teaching.js';

export type TeachingCourseUsage={spentMicros:number;reservedMicros:number;budgetMicros:number;remainingMicros:number};
/** Display the same lifetime course charges/reservations used by billing, with
 * exact workspace and payer authorization. No prompt or provider data leaves. */
export function teachingCourseUsage(db:Database,scope:TeachingScope,courseId:string):TeachingCourseUsage{
  const course=ownedTeachingCourse(db,scope,courseId);
  const rows=db.modelUsageRecords.filter(row=>row.workspaceId===scope.workspaceId&&row.userId===scope.userId&&row.conversationId===teachingConversationId(course.id));
  const spentMicros=rows.reduce((sum,row)=>sum+(row.chargedMicros??0),0),reservedMicros=rows.reduce((sum,row)=>sum+(row.reservedMicros??0),0);
  return {spentMicros,reservedMicros,budgetMicros:course.budgetMicros,remainingMicros:Math.max(0,course.budgetMicros-spentMicros-reservedMicros)};
}
