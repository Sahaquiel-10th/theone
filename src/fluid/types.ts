export type BubbleKind = 'activity' | 'local';
export type EyeOwner = 'main' | BubbleKind;

export interface FluidBounds {
  left: number;
  top: number;
  width: number;
  height: number;
  stableBody?: boolean;
  stageWidth?: number;
}

export interface FluidLayout {
  width: number;
  height: number;
  safeRight: number;
  compact: boolean;
  activityBounds: FluidBounds;
  localBounds: FluidBounds;
  /** Keep chat inside this fixed area; its text never follows bubble motion. */
  mainContentBounds: FluidBounds;
}

export interface FluidPhases {
  activity?: number;
  local?: number;
  sidebar?: number;
  mainEye?: number;
  activityEye?: number;
  localEye?: number;
}

export interface FluidFrame {
  activity: number;
  local: number;
  sidebar: number;
  activityRecoil: number;
  localRecoil: number;
  eyeOwner: EyeOwner;
}
