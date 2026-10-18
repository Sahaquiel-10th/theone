import {readFileSync} from 'node:fs';
const cache=new Map<string,string>();
/** Reviewed brand illustrations only. No user data or remote asset requests. */
export function newspaperArt(name:'avatar'|'dispatch'|'delivery'){
  if(!cache.has(name))cache.set(name,'data:image/jpeg;base64,'+readFileSync(new URL(`./assets/newspaper/${name}.jpg`,import.meta.url)).toString('base64'));
  return cache.get(name)!;
}
