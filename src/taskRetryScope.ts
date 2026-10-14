/** Confirm the actual latest child-job scope, while keeping the user's full original message as history. */
export function taskRetryScope(jobs:{instruction?:string}[],original?:string):string {
  return jobs.at(-1)?.instruction?.trim()||original?.trim()||'查看原要求';
}
