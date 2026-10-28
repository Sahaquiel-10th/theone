export type WorkspaceStartupMode='loading'|'retry'|'workspace'|'legacy';
type StartupInputs={demoEnabled:boolean;coordinatorReady:boolean;coordinatorEnabled:boolean;hasSnapshot:boolean;error?:string;destinationPending?:boolean};

/** A missing first snapshot is unknown, never an instruction to render legacy UI.
 * The backend's explicit disabled flag remains authoritative; failed refreshes
 * after a known snapshot do not change the user's established workspace mode. */
export function workspaceStartupMode(input:StartupInputs):WorkspaceStartupMode {
 if(input.demoEnabled)return input.destinationPending?'loading':'workspace';
 if(!input.coordinatorReady||!input.hasSnapshot)return input.error?'retry':'loading';
 if(!input.coordinatorEnabled)return 'legacy';
 return input.destinationPending?'loading':'workspace';
}

/** These existing pages are adopted into the modern workspace's work layers. */
export function workspaceDestinationPending(enabled:boolean,view:string) {
 return enabled&&['account','things','features','avatars','admin','company'].includes(view);
}
