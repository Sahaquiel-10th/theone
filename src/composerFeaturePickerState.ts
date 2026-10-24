import {withoutFeatureMention,type featureMention} from './noviceUx';
export type ComposerFeaturePickerState={query:string;mention:ReturnType<typeof featureMention>};

/** Consuming one @ mention starts a selection session; it does not close it.
 * The existing mention guard protects a draft edited after the menu opened. */
export function continueFeaturePicker(picker:ComposerFeaturePickerState,text:string){
 return{picker:{query:picker.query,mention:null} satisfies ComposerFeaturePickerState,text:withoutFeatureMention(text,picker.mention)};
}
export function featurePickerKeyAction({open,key,shiftKey=false,composing=false}:{open:boolean;key:string;shiftKey?:boolean;composing?:boolean}) {
 if(!open||composing)return null;
 if(key==='Escape')return 'close';
 if(key==='ArrowDown')return 'next';
 if(key==='ArrowUp')return 'previous';
 if(key==='Enter'&&!shiftKey)return 'choose';
 return null;
}
