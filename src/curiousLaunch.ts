import type {CuriousOnboardingInput,CuriousOnboardingView} from '../server/curiousOnboarding';

export type CuriousLaunchMode='continue'|'restart'|'review';

/** Explicit settings entry always uses the new conversation. A legacy journey
 * remains recoverable through its own task; it never redirects this entry. */
export function curiousLaunchInput(view:CuriousOnboardingView,mode:CuriousLaunchMode,requestId:string):CuriousOnboardingInput|undefined {
  if(mode==='review')return;
  const session=view.session;
  if(!session)return {action:'begin',requestId};
  if(mode==='restart')return {action:'restart',requestId,sessionId:session.id,revision:session.revision};
  if(session.status==='paused')return {action:'resume',requestId,sessionId:session.id,revision:session.revision};
}
