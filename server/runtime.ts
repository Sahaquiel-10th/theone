import { store } from "./db.js";
import { OneKeyPresence } from "./oneKeyPresence.js";
import { LocalAgentService } from "./localAgentService.js";
import { ConnectorRegistry } from "./connectors/registry.js";
import { getnoteConnector } from "./connectors/getnote.js";
import { executionConnectors } from "./connectors/execution.js";
import { ConnectorService } from "./connectorService.js";

export const oneKeyPresence = new OneKeyPresence(store);
export const localAgentService = new LocalAgentService(store, oneKeyPresence);
export const connectorRegistry = new ConnectorRegistry(
  [getnoteConnector, ...executionConnectors(oneKeyPresence, localAgentService)],
  (process.env.ONE_DISABLED_CONNECTORS || "").split(",").map(value => value.trim()).filter(Boolean)
);
export const connectorService = new ConnectorService(store, connectorRegistry);
