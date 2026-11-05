export type StudentRequest = <T>(path: string, options?: RequestInit) => Promise<T>;
export const studentLearningApi: StudentRequest = async <T,>(path: string, options: RequestInit = {}) => {
    const headers = new Headers(options.headers);
    headers.set('Content-Type', 'application/json');
    headers.set('X-Student-Request', '1');
    const response = await fetch('/api/learning' + path, { ...options, headers, credentials: 'same-origin' }), body = await response.json().catch(() => ({}));
    if (!response.ok)
        throw Object.assign(new Error(body.error ?? '暂时无法完成，请重试'), { status: response.status });
    return body as T;
};
export type LearningCourse = {
    id: string;
    title: string;
    membershipId: string;
    classId: string;
    className: string;
    studentName: string;
    studentNumber: string;
    teacherName: string;
    teacherPortal?: string;
    activities: {
        id: string;
        title: string;
        kind: string;
        stage: string;
    }[];
    stories: {
        id: string;
        title: string;
        activityId: string;
    }[];
};
export type LearningStudent = {
    id: string;
    phone: string;
    mustChangePassword: boolean;
};
export const learningFailure = (e: unknown) => e instanceof Error ? e.message : '暂时无法完成，请重试';
export function learningDownload(name: string, text: string) { const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' })), a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
