import type { TeachingScope } from './teachingTypes.js';
export type StudentLogin = TeachingScope & {
    id: string;
    tokenHash: string;
    authVersion: number;
    expiresAt: string;
    revokedAt?: string;
    createdAt: string;
};
/** Accounts are issued by a teacher, but are not ONE workspace members. Private
 * records live in the issuer's teaching state; only dedicated student auth reads them. */
export type StudentAccount = TeachingScope & {
    id: string;
    phone: string;
    passwordHash: string;
    authVersion: number;
    mustChangePassword: boolean;
    recoveryHash?: string;
    createdAt: string;
    logins: StudentLogin[];
    drafts: StudentScriptDraft[];
};
export type StudentClass = TeachingScope & {
    id: string;
    name: string;
    createKey?: string;
    createHash?: string;
    deletedAt?: string;
    courseIds: string[];
    storyIds?: string[];
    active?: boolean;
    revision: number;
    createdAt: string;
};
export type StudentMembership = TeachingScope & {
    id: string;
    classId: string;
    studentId: string;
    name: string;
    phone: string;
    studentNumber: string;
    active: boolean;
    createdAt: string;
};
export type StudentProvision = TeachingScope & {
    id: string;
    requestId: string;
    payloadHash: string;
    classId: string;
    encryptedCredentials: string;
    expiresAt: string;
    createdAt: string;
    newAccounts: number;
    linkedAccounts: number;
};
export type StudentScriptDraft = TeachingScope & {
    id: string;
    studentId: string;
    title: string;
    text: string;
    revision: number;
    updatedAt: string;
    deletedAt?: string;
};
export type StudentScriptSubmission = TeachingScope & {
    id: string;
    studentId: string;
    membershipId: string;
    courseId: string;
    title: string;
    text: string;
    draftId: string;
    draftRevision: number;
    requestId: string;
    payloadHash: string;
    createdAt: string;
};
