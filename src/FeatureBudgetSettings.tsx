import type {api as Api} from './oneApi';
import type {FeatureApproval} from '../server/featurePricing';
export async function approveFeaturePrices(_api:typeof Api,_featureIds:string[],_taskId?:string):Promise<FeatureApproval[]>{return [];}
export function FeatureBudgetSettings(_props:{api:typeof Api}){return null;}
