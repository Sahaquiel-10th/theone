import type {Database} from './types.js';
import {uid} from './security.js';

/** Forward-only, idempotent rollout of already reviewed and published public
 * features. Keep release identities so running tasks and price approvals remain
 * valid. Never publish drafts, resume paused features or expose company skills. */
export function openPublishedOfficialFeatures(db:Database) {
  const opened:string[]=[];
  for(const feature of db.settings.officialFeatures??[]) {
    if(feature.workspaceId||feature.status!=='approved'||!feature.release||feature.release.audience==='all'
      ||!feature.history.some(version=>version.version===feature.release!.version))continue;
    feature.release.audience='all';
    feature.revision++;
    opened.push(feature.id);
  }
  if(opened.length)db.auditLogs.push({id:uid('aud'),action:'system.official_features.open_to_all',targetType:'official_feature',
    details:{featureIds:opened,count:opened.length,audience:'all'},createdAt:new Date().toISOString()});
  return {opened};
}
