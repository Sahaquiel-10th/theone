import { randomBytes } from 'node:crypto';
import type { Database } from './types.js';
import type { TeachingActivity, TeachingCourse, TeachingScope } from './teachingTypes.js';
import { bindTeachingKnowledgeSources } from './teachingKnowledge.js';
import { ownedTeachingCourse, preserveTeachingAccess, teachingCourseView, teachingState, TeachingError, validateTeachingAttachments } from './teaching.js';

function bodyOf(value: unknown) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TeachingError('请检查操作内容'); return value as Record<string, unknown>; }
function exactCourse(db: Database, scope: TeachingScope, id: string) { const course = teachingState(db, scope).courses.find(row => row.id === id && row.workspaceId === scope.workspaceId && row.userId === scope.userId); if (!course) throw new TeachingError('课程不存在', 404, 'TEACHING_NOT_FOUND'); return course; }
export function ownedTeachingActivity(course: TeachingCourse, activityId: string) { const activity = course.activities.find(row => row.id === activityId && row.courseId === course.id && row.workspaceId === course.workspaceId && row.userId === course.userId && !row.deletedAt); if (!activity) throw new TeachingError('工具不存在', 404, 'TEACHING_NOT_FOUND'); return activity; }
function bump(course: TeachingCourse, at: string) { preserveTeachingAccess(course); course.revision++; course.updatedAt = at; }
export function setTeachingActivityOpen(db: Database, scope: TeachingScope, courseId: string, activityId: string, input: unknown, open: boolean) {
  const body = bodyOf(input), course = ownedTeachingCourse(db, scope, courseId), activity = ownedTeachingActivity(course, activityId);
  if (body.confirmed !== true) throw new TeachingError('请明确确认活动学生入口的开放状态');
  if (open) {
    if(course.sourceMode!=='knowledge')validateTeachingAttachments(db, scope, courseId, course.materialAttachmentIds); validateTeachingAttachments(db, scope, courseId, activity.sourceAttachmentIds ?? []);
    bindTeachingKnowledgeSources(db, scope, undefined, course.knowledgeSources); bindTeachingKnowledgeSources(db, scope, undefined, activity.knowledgeSources);
  }
  if (open && activity.isOpen === true && activity.status === 'published' && activity.slug || !open && activity.isOpen === false && activity.status === 'closed') return { course: teachingCourseView(course), activity };
  if (body.revision !== course.revision || body.activityRevision !== activity.revision) throw new TeachingError('课程或工具已更新，请刷新后再确认', 409, 'TEACHING_REVISION_CONFLICT');
  const at = new Date().toISOString(); bump(course, at);
  activity.publicRevision??=activity.revision; activity.status = open ? 'published' : 'closed'; activity.isOpen = open; activity.sessionsRevokedAt = at; activity.accessRevision=(activity.accessRevision??0)+1; activity.updatedAt = at; activity.revision++;
  if (open) activity.slug = randomBytes(24).toString('base64url');
  return { course: teachingCourseView(course), activity };
}
export function listTeachingTrash(db: Database, scope: TeachingScope) {
  const courses = teachingState(db, scope).courses.filter(course => course.workspaceId === scope.workspaceId && course.userId === scope.userId);
  return { courses: courses.filter(course => !!course.deletedAt), activities: courses.flatMap(course => course.activities.filter(activity => !!activity.deletedAt && activity.courseId === course.id && activity.workspaceId === scope.workspaceId && activity.userId === scope.userId).map(activity => ({ courseId: course.id, courseTitle: course.title, courseRevision: course.revision, courseDeleted: !!course.deletedAt, activity }))) };
}
/** Validate every exact item before changing any row. There is no hard deletion,
 * name matching, implicit test-data detection, file cleanup or ledger mutation. */
export function mutateTeachingTrash(db: Database, scope: TeachingScope, input: unknown, restore: boolean) {
  const body = bodyOf(input);
  if (body.confirmed !== true || !Array.isArray(body.items) || !body.items.length || body.items.length > 50) throw new TeachingError('请明确选中 1–50 个课程或工具，再确认操作');
  const seen = new Set<string>();
  const selected = body.items.map(raw => {
    const item = bodyOf(raw);
    if (Object.keys(item).some(key => !['courseId','activityId','revision','activityRevision'].includes(key)) || typeof item.courseId !== 'string' || item.activityId !== undefined && typeof item.activityId !== 'string') throw new TeachingError('请使用课程或工具的确切编号');
    const course = exactCourse(db, scope, item.courseId), activity = item.activityId === undefined ? undefined : course.activities.find(row => row.id === item.activityId && row.courseId === course.id && row.workspaceId === scope.workspaceId && row.userId === scope.userId);
    if (item.activityId !== undefined && !activity) throw new TeachingError('工具不存在', 404, 'TEACHING_NOT_FOUND');
    if (restore && activity && course.deletedAt) throw new TeachingError('请先恢复所属课程，再恢复这个工具', 409, 'TEACHING_PARENT_TRASHED');
    const key = `${course.id}:${activity?.id ?? ''}`;
    if (seen.has(key)) throw new TeachingError('同一个条目不能重复选择'); seen.add(key);
    const changed = restore ? !!(activity ?? course).deletedAt : !(activity ?? course).deletedAt;
    if (changed && (item.revision !== course.revision || activity && item.activityRevision !== activity.revision)) throw new TeachingError('所选条目已更新，请刷新后重新选择；本批次尚未修改', 409, 'TEACHING_REVISION_CONFLICT');
    return { course, activity, changed };
  });
  if (selected.some(row => row.activity && seen.has(`${row.course.id}:`))) throw new TeachingError('请分别操作课程及其内部工具，避免同时选择父子条目');
  const at = new Date().toISOString(), touched = new Set<TeachingCourse>();
  for (const { course, activity, changed } of selected) {
    if (!changed) continue;
    if (!touched.has(course)) { bump(course, at); touched.add(course); }
    const target = activity ?? course;
    target.lifecycleRevision=(target.lifecycleRevision??0)+1;
    if (restore) { delete target.deletedAt; delete target.deletedBy; } else { target.deletedAt = at; target.deletedBy = scope.userId; }
    target.status = 'closed';
    if (activity) { activity.publicRevision??=activity.revision; activity.isOpen = false; activity.sessionsRevokedAt = at; activity.accessRevision=(activity.accessRevision??0)+1; activity.updatedAt = at; activity.revision++; }
    else {
      course.sessionsRevokedAt = at;
      for (const child of course.activities) { child.isOpen = false; child.sessionsRevokedAt = at; child.accessRevision=(child.accessRevision??0)+1; }
    }
  }
  return { courses: selected.filter(row => !row.activity).map(row => teachingCourseView(row.course)), activities: selected.filter((row): row is typeof row & { activity: TeachingActivity } => !!row.activity).map(row => ({ courseId: row.course.id, courseRevision: row.course.revision, activity: row.activity })) };
}
