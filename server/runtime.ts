import { store } from "./db.js";
import { OneKeyPresence } from "./oneKeyPresence.js";

export const oneKeyPresence = new OneKeyPresence(store);
