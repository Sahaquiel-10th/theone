import { Store } from "../db.js";
import { decryptCredential } from "./credentialCipher.js";
import { getNoteProvider } from "./getnoteProvider.js";

export class KnowledgeService {
  constructor(private store: Store) {}

  async recall(workspaceId: string, query: string, topK = 5) {
    const db = await this.store.read();
    const connection = db.knowledgeConnections.find((item) => item.workspaceId === workspaceId && item.provider === "getnote" && item.status === "connected");
    if (!connection?.encryptedApiKey) return [];
    return getNoteProvider.search({ clientId: connection.clientId, apiKey: decryptCredential(connection.encryptedApiKey) }, query, topK);
  }
}
