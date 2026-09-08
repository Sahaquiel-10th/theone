import { store } from "./db.js";
import { OneKeyPresence } from "./oneKeyPresence.js";
import { LocalAgentService } from "./localAgentService.js";

export const oneKeyPresence = new OneKeyPresence(store);
export const localAgentService = new LocalAgentService(store, oneKeyPresence);
