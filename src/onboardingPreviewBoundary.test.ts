import test from 'node:test';
import assert from 'node:assert/strict';
import {onboardingEffectPreview} from './onboardingPreviewBoundary';
const study={hostname:'127.0.0.1',pathname:'/output/playwright/focus-preview.html',search:'?designStudy=1'};
test('the guide effect is limited to the marked synthetic local study',()=>{
  assert.equal(onboardingEffectPreview(study,'synthetic'),true);
  for(const candidate of [{...study,hostname:'one.example.com'},{...study,pathname:'/'},{...study,search:'?designStudy=1&realService=1'},{...study,search:''}])assert.equal(onboardingEffectPreview(candidate,'synthetic'),false);
  assert.equal(onboardingEffectPreview(study,undefined),false);
  assert.equal(onboardingEffectPreview(study,'real'),false);
});
