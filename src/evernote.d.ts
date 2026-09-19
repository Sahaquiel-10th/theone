declare module "evernote" {
  export class Client {
    constructor(options: { consumerKey?: string; consumerSecret?: string; sandbox?: boolean; china?: boolean; token?: string });
    getRequestToken(callbackUrl: string, callback: (error: unknown, token?: string, secret?: string) => void): void;
    getAuthorizeUrl(token: string): string;
    getAccessToken(token: string, secret: string, verifier: string, callback: (error: unknown, accessToken?: string, accessSecret?: string, results?: Record<string, unknown>) => void): void;
    getUserStore(): { getUser(): Promise<{ id?: number; username?: string; name?: string }>; getUserUrls(): Promise<{ noteStoreUrl?: string }> };
    getNoteStore(noteStoreUrl?: string): {
      findNotesMetadata(filter: Record<string, unknown>, offset: number, maxNotes: number, resultSpec: Record<string, unknown>): Promise<{ notes?: Array<{ guid?: string; title?: string }> }>;
      getNote(guid: string, withContent: boolean, withResourcesData: boolean, withResourcesRecognition: boolean, withResourcesAlternateData: boolean): Promise<{ guid?: string; title?: string; content?: string }>;
    };
  }
}
