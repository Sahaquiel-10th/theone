import test from 'node:test';
import assert from 'node:assert/strict';
import {opticalResolution} from './fluid/surfaceOptics';

test('material allocation remains bounded on Retina, 4K and very wide screens without changing CSS layout',()=>{
  for(const [width,height] of [[1280,720],[1920,1080],[3840,2160],[6016,3384],[12000,1800]])for(const dpr of [1,2,3])for(const maxTexture of [2048,4096,16384]){
    const result=opticalResolution(width,height,dpr,maxTexture);
    assert.ok(result.width*result.height<=2_400_000);
    assert.ok(result.width<=maxTexture&&result.height<=maxTexture);
    assert.ok(result.ratio<=1.5&&result.ratio<=dpr);
    assert.ok(Math.abs(result.width/result.ratio-width)<1/result.ratio);
    assert.ok(Math.abs(result.height/result.ratio-height)<1/result.ratio);
  }
});
