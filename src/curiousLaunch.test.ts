import test from 'node:test';
import assert from 'node:assert/strict';
import {curiousLaunchInput} from './curiousLaunch';
import type {CuriousOnboardingView} from '../server/curiousOnboarding';

const view=(status?:'active'|'paused'|'completed')=>({profile:{onboarding:{journey:{stage:'practice',experience:5}}},...(status?{session:{id:'own-session',revision:8,status}}:{})}) as unknown as CuriousOnboardingView;
test('explicit settings entry begins the new experience even with an unfinished legacy journey',()=>{
  assert.deepEqual(curiousLaunchInput(view(),'continue','request-1'),{action:'begin',requestId:'request-1'});
  assert.deepEqual(curiousLaunchInput(view(),'restart','request-1'),{action:'begin',requestId:'request-1'});
});
test('continue resumes paused collection without replacing an active or completed session',()=>{
  assert.deepEqual(curiousLaunchInput(view('paused'),'continue','request-1'),{action:'resume',sessionId:'own-session',revision:8,requestId:'request-1'});
  assert.equal(curiousLaunchInput(view('active'),'continue','request-1'),undefined);
  assert.equal(curiousLaunchInput(view('completed'),'review','request-1'),undefined);
});
test('restarting every status binds the request to exactly the session the user saw',()=>{
  for(const status of ['active','paused','completed'] as const)assert.deepEqual(curiousLaunchInput(view(status),'restart','request-1'),{action:'restart',sessionId:'own-session',revision:8,requestId:'request-1'});
});
