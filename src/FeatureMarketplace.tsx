import type {api as Api} from './oneApi';
import {FeatureShelf,type FeatureChoice} from './preview/FeatureShelf';
/** Both application shells use the same selection-only Skills catalog. */
export function FeatureMarketplace({api,models,onAsk,selected,onChoose,initialOperationId,initialOpenRequest}:{api:typeof Api;models:{id:string;name:string;kind:string}[];onAsk:()=>void;selected:string[];onChoose:(feature:FeatureChoice,source?:HTMLElement)=>void;initialOperationId?:string;initialOpenRequest?:number}){
  return <FeatureShelf maxSelected={1} api={api} models={models} selected={selected} onChoose={onChoose} onDone={onAsk} initialOperationId={initialOperationId} initialOpenRequest={initialOpenRequest}/>;
}
