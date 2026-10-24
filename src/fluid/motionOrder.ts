import type {BubbleKind,EyeOwner} from './types';

/** Stage the material, never the actual work. A direct local action goes first. */
export function fissionOrder(open:Record<BubbleKind,boolean>,moving:Record<BubbleKind,number>,preferred:EyeOwner):BubbleKind[]{
  const pending=(['activity','local'] as const).filter(kind=>open[kind]&&moving[kind]<.01);
  return pending.sort((a,b)=>a===preferred?-1:b===preferred?1:0);
}
