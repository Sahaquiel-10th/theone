import test from 'node:test';
import assert from 'node:assert/strict';
import {entryPocketMetrics,entryPocketPath,sidebarEntryGeometry} from './fluid/entry';
import {opticalMaskLayers} from './fluid/surfaceOptics';

function points(path:string){
  const tokens=path.match(/[MCLZ]|-?\d+(?:\.\d+)?/g)!;
  const out:{x:number;y:number}[]=[];let i=0,x=0,y=0;
  const number=()=>Number(tokens[i++]);
  while(i<tokens.length){
    const command=tokens[i++];
    if(command==='M'||command==='L'){x=number();y=number();out.push({x,y});}
    else if(command==='C'){
      const x0=x,y0=y,a=number(),b=number(),c=number(),d=number();x=number();y=number();
      for(let j=1;j<=80;j++){const t=j/80,u=1-t;out.push({x:u*u*u*x0+3*u*u*t*a+3*u*t*t*c+t*t*t*x,y:u*u*u*y0+3*u*u*t*b+3*u*t*t*d+t*t*t*y});}
    }
  }
  return out;
}

test('eye departure lowers a solid circular frame cap without changing its circle radius',()=>{
  const active=entryPocketMetrics(0,200,1),quiet=entryPocketMetrics(0,200,0);
  assert.equal(active.radius,quiet.radius);
  assert.equal(active.depth-quiet.depth,36);
  assert.equal(quiet.depth,11);
  assert.ok(quiet.dy<active.dy);
  for(const phase of [0,.2,.5,.8,1]){
    const metric=entryPocketMetrics(0,200,phase),outline=points(entryPocketPath(0,200,phase));
    assert.ok(Math.abs(Math.max(...outline.map(p=>p.x))-metric.depth)<.02);
    // A single solid boundary, open to the outer frame; no inner circular island.
    assert.equal((entryPocketPath(0,200,phase).match(/M /g)||[]).length,1);
    assert.ok(outline.every(p=>p.x>=-.001&&p.y>=200-metric.dy-.01&&p.y<=200+metric.dy+.01));
  }
});

test('all entry orientations have mirrored, tangent shoulders and legal intermediate geometry',()=>{
  for(let phase=0;phase<=1;phase+=.05){
    const left=points(entryPocketPath(0,200,phase)),right=points(entryPocketPath(800,200,phase,-1));
    assert.equal(left.length,right.length);
    for(let i=0;i<left.length;i++){
      assert.ok(Math.abs(left[i].x+right[i].x-800)<.003);
      assert.ok(Math.abs(left[i].y-right[i].y)<.003);
    }
    assert.ok(left[1].y>left[0].y&&left[1].x-left[0].x<.01);
  }
});

test('sidebar lobe and mother clearance remain parallel with a genuine background channel',()=>{
  for(const edge of [-12,48,108,164])for(const phase of [0,.2,.5,.8,1]){
    const entry=sidebarEntryGeometry(edge,320,phase),support=points(entry.supportPath),clearance=points(entry.clearancePath);
    assert.equal(support.length,clearance.length);
    assert.equal(entry.clearance.edge,edge+12.5,'The clearance must join the actual mother edge');
    assert.equal(entry.clearance.centre,entry.support.centre);
    assert.equal(entry.clearance.dy,entry.support.dy);
    for(let i=0;i<support.length;i++){
      const distance=Math.hypot(clearance[i].x-support[i].x,clearance[i].y-support[i].y);
      assert.ok(Math.abs(distance-12.5)<.003,'The two surfaces must never touch or leave a separate pedestal');
    }
    assert.ok(support[1].y>support[0].y&&support[1].x-support[0].x<.01);
    assert.ok(clearance[1].y>clearance[0].y&&clearance[1].x-clearance[0].x<.01);
  }
  const quiet=sidebarEntryGeometry(0,320,0),active=sidebarEntryGeometry(0,320,1);
  assert.equal(quiet.support.radius,active.support.radius,'The quiet entry retreats without changing its circular curvature');
  assert.equal(quiet.support.depth,8);
  assert.equal(active.support.depth,32);
});

test('the stable brand circle stays partly seated inside the rail as the sidebar expands',()=>{
  const radius=22;
  for(const edge of [-12,0,48,108,164]){
    const entry=sidebarEntryGeometry(edge,320,1),overlap=edge-(entry.eye.x-radius);
    assert.ok(overlap/(radius*2)>=1/3&&overlap/(radius*2)<=1/2);
    assert.ok(Math.hypot(entry.eye.x-entry.support.centre,entry.eye.y-entry.support.cy)+radius<entry.support.radius,
      'The rail lobe must physically support the whole logo disk');
    assert.equal(entry.eye.x-edge,4,'Rail and eye must move as one volume');
  }
});

test('optical raster cuts preserve the rail lobe while leaving background between rail and mother',()=>{
  const contains=(polygon:{x:number;y:number}[],x:number,y:number)=>{
    let inside=false;
    for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){
      const a=polygon[i],b=polygon[j];
      if((a.y>y)!==(b.y>y)&&x<(b.x-a.x)*(y-a.y)/(b.y-a.y)+a.x)inside=!inside;
    }
    return inside;
  };
  for(const phase of [0,.25,.5,.75,1]){
    const entry=sidebarEntryGeometry(0,100,phase),layers=opticalMaskLayers({
      fills:[{path:'M 12.5 0 L 200 0 L 200 200 L 12.5 200 Z'}],
      cuts:[{path:entry.clearancePath}],foreground:[{path:entry.supportPath}],eye:{path:''},
    }).map(layer=>({...layer,polygons:layer.paths.filter(item=>item.path).map(item=>points(item.path))}));
    const raster=(x:number,y:number)=>{
      let value=false;
      for(const layer of layers)for(const polygon of layer.polygons)if(contains(polygon,x,y))value=layer.color==='#fff';
      return value;
    };
    assert.equal(raster(entry.support.depth-1,100),true,'The mother cut erased the sidebar lobe');
    assert.equal(raster(entry.support.depth+6,100),false,'The shared background channel was filled');
    assert.equal(raster(entry.support.depth+14,100),true,'The mother did not resume after the channel');
  }
});
