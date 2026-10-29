/** Teaching records stay with their owning account; public DTOs are explicit projections. */
export type TeachingStage = 'before' | 'during' | 'after';
export type TeachingKind = 'inquiry' | 'scenario' | 'quiz' | 'assignment';
export type TeachingScope = { workspaceId: string; userId: string };
export type TeachingCriterion = { id: string; label: string; description: string; maxScore: number };
export type TeachingQuestion = { id: string; prompt: string; type: 'single' | 'text'; options: string[]; answer: string; points: number };
export type TeachingScene = { id: string; title: string; content: string; choices: string[]; reflection: string };
export type TeachingActivity = TeachingScope & {
  id: string; courseId: string; revision: number; stage: TeachingStage; kind: TeachingKind;
  title: string; instructions: string; status: 'draft' | 'published' | 'closed';
  /** Teacher-only exam originals and grading references, excluded from student DTOs. */
  referenceText?: string; sourceAttachmentIds?: string[];
  questions: TeachingQuestion[]; scenes: TeachingScene[]; rubric: TeachingCriterion[];
  createdAt: string; updatedAt: string;
};
export type TeachingCourse = TeachingScope & {
  id: string; revision: number; title: string; subject: string; description: string;
  materialText: string; materialAttachmentIds: string[]; budgetMicros: number;
  status: 'draft' | 'published' | 'closed'; slug?: string; activities: TeachingActivity[];
  createdAt: string; updatedAt: string;
};
export type TeachingSession = TeachingScope & {
  id: string; courseId: string; tokenHash: string; participantName: string; participantRef: string;
  consentedAt: string; createdAt: string; expiresAt: string;
};
export type TeachingGrade = {
  criteria: { criterionId: string; score: number; comment: string; evidence: string }[];
  total: number; feedback: string; source: 'rules' | 'ai' | 'teacher';
  status: 'suggested' | 'published'; needsReview: boolean; reviewedAt?: string; publishedAt?: string;
};
export type TeachingSubmission = TeachingScope & {
  id: string; courseId: string; activityId: string; activityRevision: number; sessionId?: string;
  participantName: string; participantRef: string; operationId: string; payloadHash: string;
  text: string; answers: Record<string, string>; attachmentIds: string[];
  activitySnapshot: TeachingActivity; grade?: TeachingGrade; createdAt: string;
};
export type TeachingOperation = TeachingScope & {
  id: string; courseId: string; activityId?: string; submissionId?: string; sessionId?: string;
  operationId: string; payloadHash: string; kind: 'prepare' | 'answer' | 'grade' | 'insights';
  courseRevision?: number; question?: string; attachmentIds?: string[];
  status: 'running' | 'completed' | 'uncertain' | 'failed'; result?: unknown; error?: string;
  createdAt: string; completedAt?: string;
};
export type TeachingState = {
  courses: TeachingCourse[]; sessions: TeachingSession[]; submissions: TeachingSubmission[]; operations: TeachingOperation[];
};
export type TeachingPublicActivity = Omit<TeachingActivity, 'workspaceId' | 'userId' | 'questions' | 'referenceText' | 'sourceAttachmentIds'> & {
  questions: Omit<TeachingQuestion, 'answer'>[];
};
export type TeachingPublicCourse = Pick<TeachingCourse, 'id' | 'revision' | 'title' | 'subject' | 'description'> & {
  activities: TeachingPublicActivity[];
};
