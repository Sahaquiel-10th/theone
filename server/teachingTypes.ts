/** Teaching records stay with their owning account; public DTOs are explicit projections. */
export type TeachingStage = 'before' | 'during' | 'after';
export type TeachingKind = 'inquiry' | 'scenario' | 'quiz' | 'assignment' | 'game';
export type TeachingTaskKind = 'grade' | 'ask' | 'quiz' | 'game';
export type TeachingScope = { workspaceId: string; userId: string };
export type TeachingTrashMetadata = { deletedAt?: string; deletedBy?: string; lifecycleRevision?: number };
export type TeachingKnowledgeSource = {
  provider: import('./types.js').KnowledgeProviderId; connectionId: string; binding: string;
  scope: 'page' | 'connection'; pageId?: string; label: string;
};
export type TeachingCriterion = { id: string; label: string; description: string; maxScore: number };
export type TeachingQuestion = { id: string; prompt: string; type: 'single' | 'text'; options: string[]; answer: string; points: number };
export type TeachingScene = { id: string; title: string; content: string; choices: string[]; reflection: string };
export type TeachingActivity = TeachingScope & TeachingTrashMetadata & {
  id: string; courseId: string; revision: number; stage: TeachingStage; kind: TeachingKind;
  title: string; instructions: string; status: 'draft' | 'published' | 'closed';
  /** Teacher-only exam originals and grading references, excluded from student DTOs. */
  referenceText?: string; sourceAttachmentIds?: string[];
  /** Teacher-authored teaching behavior; student edits never change this record. */
  avatarPrompt?: string; allowStudentPrompt?: boolean; knowledgeSources?: TeachingKnowledgeSource[];
  questions: TeachingQuestion[]; scenes: TeachingScene[]; rubric: TeachingCriterion[];
  createdAt: string; updatedAt: string;
  slug?: string; isOpen?: boolean; sessionsRevokedAt?: string; accessRevision?: number;
  publicRevision?: number;
  clientCreateKey?: string; createPayloadHash?: string;
};
export type TeachingCourse = TeachingScope & TeachingTrashMetadata & {
  id: string; revision: number; title: string; subject: string; description: string;
  materialText: string; materialAttachmentIds: string[]; budgetMicros: number;
  /** New course learning context is retrieved only from explicitly bound libraries.
   * Missing mode identifies historical courses; their original fields are retained. */
  sourceMode?: 'knowledge';
  /** Guided tasks use one private course container, created only on an explicit save/upload. */
  clientDraftId?: string; taskKind?: TeachingTaskKind; knowledgeSources?: TeachingKnowledgeSource[];
  /** Course-centre creation receipt, distinct from legacy task drafts. */
  clientCreateKey?: string; createPayloadHash?: string;
  status: 'draft' | 'published' | 'closed'; slug?: string; activities: TeachingActivity[];
  createdAt: string; updatedAt: string;
  sessionsRevokedAt?: string; materialRevision?: number;
};
export type TeachingSession = TeachingScope & {
  id: string; courseId: string; tokenHash: string; participantName: string; participantRef: string;
  participantClass?: string;
  activityId?: string;
  activityAccessRevisions?: Record<string, number>;
  consentedAt: string; createdAt: string; expiresAt: string;
  gameConfigs?: TeachingGameConfig[];
};
export type TeachingGameConfig = TeachingScope & {
  courseId: string; sessionId: string; activityId: string; revision: number;
  roleName: string; prompt: string; conversationId: string; updatedAt: string;
};
export type TeachingGrade = {
  criteria: { criterionId: string; score: number; comment: string; evidence: string }[];
  total: number; feedback: string; source: 'rules' | 'ai' | 'teacher';
  status: 'suggested' | 'published'; needsReview: boolean; reviewedAt?: string; publishedAt?: string;
  gradingRevision?: number;
};
export type TeachingSubmission = TeachingScope & {
  id: string; courseId: string; activityId: string; activityRevision: number; sessionId?: string;
  participantName: string; participantRef: string; operationId: string; payloadHash: string;
  participantClass?: string;
  text: string; answers: Record<string, string>; attachmentIds: string[];
  activitySnapshot: TeachingActivity; grade?: TeachingGrade; createdAt: string;
  gradingSnapshot?: TeachingActivity; gradingRevision?: number; gradingBoundAt?: string;
};
export type TeachingOperation = TeachingScope & {
  id: string; courseId: string; activityId?: string; submissionId?: string; sessionId?: string;
  operationId: string; payloadHash: string; kind: 'prepare' | 'answer' | 'grade' | 'insights';
  courseRevision?: number; question?: string; attachmentIds?: string[];
  materialRevision?: number; activityRevision?: number; preview?: boolean;
  courseLifecycleRevision?: number; activityLifecycleRevision?: number;
  submissionGradingRevision?: number;
  conversationId?: string; gameRevision?: number; gamePromptSnapshot?: { roleName: string; prompt: string };
  status: 'running' | 'completed' | 'uncertain' | 'failed'; result?: unknown; error?: string;
  createdAt: string; completedAt?: string;
};
export type TeachingState = {
  courses: TeachingCourse[]; sessions: TeachingSession[]; submissions: TeachingSubmission[]; operations: TeachingOperation[];
  /** Private deletion receipts and unfinished file cleanup; never a public DTO. */
  purges?: TeachingPurgeReceipt[];
};
export type TeachingPurgeImpact = { courses:number;activities:number;sessions:number;updatedSessions:number;submissions:number;operations:number;files:number;retainedFiles:number;fileBytes:number };
export type TeachingPurgeFile = { id:string;workspaceId:string;userId:string;courseId:string;storagePath:string };
export type TeachingPurgeReceipt = TeachingScope & { id:string;requestId:string;requestHash:string;impactHash:string;impact:TeachingPurgeImpact;status:'completed'|'files_pending';pendingFiles:TeachingPurgeFile[];createdAt:string;completedAt?:string };
export type TeachingPublicActivity = Omit<TeachingActivity, 'workspaceId' | 'userId' | 'questions' | 'referenceText' | 'sourceAttachmentIds' | 'knowledgeSources'> & {
  questions: Omit<TeachingQuestion, 'answer'>[];
};
export type TeachingPublicCourse = Pick<TeachingCourse, 'id' | 'revision' | 'title' | 'subject' | 'description'> & {
  activities: TeachingPublicActivity[];
};
