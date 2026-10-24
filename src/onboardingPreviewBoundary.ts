/** A visual study must never replace the account's real onboarding workflow. */
export function onboardingEffectPreview(location:Pick<Location,'hostname'|'pathname'|'search'>,mode:string|undefined){
  const params=new URLSearchParams(location.search);
  return ['localhost','127.0.0.1','[::1]'].includes(location.hostname)
    &&location.pathname==='/output/playwright/focus-preview.html'
    &&params.has('designStudy')&&params.get('realService')!=='1'&&mode==='synthetic';
}
