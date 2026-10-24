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
  sidebarTravel: number;
  paired?: boolean;
  activityBounds: FluidBounds;
  localBounds: FluidBounds;
  /** Minimum rectangular fallback. Desktop paragraphs use the live local contour. */
  mainContentBounds: FluidBounds;
}

export interface FluidSizing {
  activityHeight?: number;
  localHeight?: number;
  paired?: boolean;
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
  activityHeight: number;
  localHeight: number;
  localTop: number;
}
