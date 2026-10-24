/** Optical material over the EXACT animated SVG silhouette.
 * A two-pass local Gaussian field estimates boundary distance for the approved
 * convex lens shading. It never changes the contour, text, or motion clock.
 * One mask for the whole union means joins have no internal highlight/stroke.
 */
export interface OpticalPath { path:string; opacity?:number }
export interface OpticalFrame {
  origin:{x:number;y:number}; fills:OpticalPath[]; cuts:OpticalPath[];
  /** Independent volumes sit in their own clearance, above the mother's cuts. */
  foreground?:OpticalPath[];
  eye:OpticalPath; night:boolean;
  accent?:'solar'|'iris'|'jade';
  scene?:'silver'|'graphite';
  seams:readonly [{x:number;y:number;tension:number},{x:number;y:number;tension:number}];
}

/** Keep SVG masking and the optical silhouette's surface ownership consistent. */
export function opticalMaskLayers(frame:Pick<OpticalFrame,'fills'|'cuts'|'foreground'|'eye'>,encodeMaterials=false){
  return [
    {color:'#fff',paths:frame.fills},
    {color:'#000',paths:frame.cuts},
    // Red always remains the silhouette. Green identifies the independent rail
    // in the same texture, so its light cannot paint over the background cut.
    {color:encodeMaterials?'#f00':'#fff',paths:frame.foreground??[]},
    {color:'#fff',paths:[frame.eye]},
  ];
}
const vertex=`attribute vec2 position;varying vec2 uv;void main(){uv=position*.5+.5;gl_Position=vec4(position,0.,1.);}`;
const blurFragment=`precision highp float;varying vec2 uv;uniform sampler2D source;uniform vec2 stepSize;
void main(){float v=0.;float weight=0.;for(int i=-8;i<=8;i++){
 float x=float(i),w=exp(-x*x/18.);v+=texture2D(source,uv+stepSize*x).r*w;weight+=w;}
 gl_FragColor=vec4(vec3(v/weight),1.);}`;
const fragment=`precision highp float;
uniform sampler2D silhouette;uniform sampler2D field;uniform vec2 viewport;uniform float pixelRatio;uniform float night;
uniform vec2 seamA;uniform vec2 seamB;uniform vec2 tension;
uniform vec3 sceneAccent;uniform float sceneKind;
float ease(float a,float b,float v){return smoothstep(a,b,v);}
vec2 uvAt(vec2 p){return vec2(p.x/viewport.x,1.-p.y/viewport.y);}
float distanceAt(vec2 p){float c=clamp(texture2D(field,uvAt(p)).r,.0005,.9995);return log((1.-c)/c)*3.53;}
// Broad directional light, not a flat white fill. The reading centre remains
// quiet; colour is exposed through the frame and the optical material's edge.
vec3 environment(vec2 p,float dark){
 vec2 q=p/viewport;
 vec2 diagonal=mat2(.93,-.37,.37,.93)*(q-vec2(.88,-.02));
 vec2 qc=diagonal/vec2(.75,.35),qw=(q-vec2(-.14,.82))/vec2(.65,.72);
 float cool=exp(-dot(qc,qc)),warm=exp(-dot(qw,qw));
 float sweep=exp(-pow((q.x+.42*q.y-.75)/.66,2.));
 vec3 silver=vec3(.605,.649,.690)+cool*vec3(.030,.035,.055)+warm*vec3(.065,.045,.008)+sweep*.035;
 vec3 graphite=vec3(.085,.104,.124)+cool*vec3(.028,.034,.046)+warm*vec3(.016,.012,.005)+sweep*.012;
 vec3 day=mix(silver,graphite,sceneKind);
 vec2 localLight=(q-vec2(.94,.84))/vec2(.38,.43);
 float localGlow=exp(-dot(localLight,localLight));
 vec3 nightScene=vec3(.028,.043,.057)+cool*vec3(.012,.018,.025)+localGlow*sceneAccent*.13;
 return mix(day,nightScene,dark);
}
void main(){
 vec2 screen=vec2(gl_FragCoord.x/pixelRatio,viewport.y-gl_FragCoord.y/pixelRatio);
 vec2 p=screen;
 float dark=night,d=distanceAt(p);
 vec3 bg=environment(p,dark);
 float shadowD=distanceAt(p-vec2(0.,5.));
 float influence=smoothstep(0.,.035,texture2D(field,uvAt(p-vec2(0.,5.))).r);
 float shadow=exp(-max(shadowD,0.)/8.)*(1.-smoothstep(-1.,1.,-d))*influence;
 bg*=1.-shadow*mix(mix(.035,.055,sceneKind),.09,dark);
 // The same near-edge strain drives a local highlight, never a whole-screen glow.
 vec2 da=(p-seamA)/vec2(58.,90.),db=(p-seamB)/vec2(58.,90.);
 float strain=clamp(exp(-dot(da,da))*tension.x+exp(-dot(db,db))*tension.y,0.,1.);
 float depth=max(-d,0.),bezel=mix(3.1,5.7,strain);
 float h=clamp(depth/bezel,.002,1.);
 float slope=(1.-h)/sqrt(max(.025,1.-pow(1.-h,2.)));
 float dx=distanceAt(p+vec2(.8,0.))-distanceAt(p-vec2(.8,0.));
 float dy=distanceAt(p+vec2(0.,.8))-distanceAt(p-vec2(0.,.8));
 vec2 direction=normalize(vec2(dx,dy)+vec2(.00001));
 vec3 normal=normalize(vec3(direction*slope*.34,1.));
 vec2 offset=normal.xy*(2.+4.*(1.-normal.z));
 vec3 transmitted=environment(p-offset,dark);
 vec3 dayTint=mix(vec3(.952,.963,.964),vec3(.914,.935,.946),sceneKind);
 vec3 tint=mix(dayTint,vec3(.175,.218,.245),dark);
 float centre=ease(0.,9.,depth);
 // A stable reading veil has its own optical weight. It still transmits the
 // common directional scene; the rail has a denser, distinct material role.
 float dayVeil=mix(mix(.50,.73,sceneKind),mix(.77,.90,sceneKind),centre);
 vec3 glass=mix(transmitted,tint,mix(dayVeil,mix(.48,.75,centre),dark));
 vec2 ownership=texture2D(silhouette,uvAt(p)).rg;
 float rail=max(ownership.r-ownership.g,0.);
 vec3 dayRail=mix(vec3(.690,.735,.765),vec3(.145,.179,.206),sceneKind);
 vec3 railTint=mix(dayRail,vec3(.105,.145,.172),dark);
 vec3 railGlass=mix(transmitted,railTint,.89);
 glass=mix(glass,railGlass,rail);
 vec3 halfDirection=normalize(normalize(vec3(-.5,-.7,1.))+vec3(0.,0.,1.));
 float spec=pow(max(dot(normal,halfDirection),0.),82.);
 float rounded=1.-ease(bezel,bezel+2.,depth);
 float reflected=max(dot(direction,normalize(vec2(-.7,-1.))),0.);
 float facing=pow(reflected,3.);
 glass+=spec*rounded*(mix(.095,.14,dark)+.065*strain);
 glass+=pow(1.-normal.z,3.)*(.006+.036*facing)*rounded;
 float shade=pow(max(dot(normal,normalize(vec3(.55,.65,.1))),0.),2.)*rounded;
 glass*=1.-shade*mix(.045,.07,dark);
 // A directional hairline, with a softer opposite edge; no bright closed ring.
 float hair=exp(-pow((depth-.65)/.82,2.));
 glass+=hair*(.005+facing*(mix(.105,.22,dark)+.065*strain));
 float alpha=texture2D(silhouette,uvAt(p)).r;
 gl_FragColor=vec4(mix(bg,glass,alpha),1.);
}`;

/** Bound material pixels separately from DOM/text resolution on large displays. */
export function opticalResolution(width:number,height:number,deviceRatio:number,maxTextureSize:number){
  const ratio=Math.min(Math.max(.1,deviceRatio||1),1.5,Math.sqrt(2_400_000/(Math.max(1,width)*Math.max(1,height))),maxTextureSize/Math.max(1,width,height));
  return {ratio,width:Math.max(1,Math.floor(width*ratio)),height:Math.max(1,Math.floor(height*ratio))};
}

/** No animation loop here: caller paints only changing/invalidated frames. */
export function createSurfaceOptics(canvas:HTMLCanvasElement,onUnavailable:()=>void){
  const gl=canvas.getContext('webgl',{alpha:false,antialias:false,powerPreference:'low-power',preserveDrawingBuffer:false});
  if(!gl)return null;
  delete canvas.dataset.opticalError;
  const mask=document.createElement('canvas'),ctx=mask.getContext('2d',{alpha:false});
  if(!ctx)return null;
  const shaders:WebGLShader[]=[],programs:WebGLProgram[]=[],textures:WebGLTexture[]=[],buffers:WebGLBuffer[]=[],targets:WebGLFramebuffer[]=[];
  const compile=(kind:number,code:string)=>{const s=gl.createShader(kind);if(!s)throw Error('shader');shaders.push(s);gl.shaderSource(s,code);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s)||'shader');return s;};
  const makeProgram=(code:string)=>{const p=gl.createProgram();if(!p)throw Error('program');programs.push(p);gl.attachShader(p,compile(gl.VERTEX_SHADER,vertex));gl.attachShader(p,compile(gl.FRAGMENT_SHADER,code));gl.linkProgram(p);if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(p)||'program');return p;};
  let dead=false,width=0,height=0;
  const dispose=()=>{dead=true;canvas.removeEventListener('webglcontextlost',lost);for(const b of buffers)gl.deleteBuffer(b);for(const f of targets)gl.deleteFramebuffer(f);for(const t of textures)gl.deleteTexture(t);for(const p of programs)gl.deleteProgram(p);for(const s of shaders)gl.deleteShader(s);};
  function lost(e:Event){e.preventDefault();dead=true;onUnavailable();}
  canvas.addEventListener('webglcontextlost',lost);
  try{
    const blur=makeProgram(blurFragment),optics=makeProgram(fragment);
    const buffer=gl.createBuffer()!;buffers.push(buffer);gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);
    function texture(){const t=gl!.createTexture()!;textures.push(t);gl!.bindTexture(gl!.TEXTURE_2D,t);for(const name of [gl!.TEXTURE_WRAP_S,gl!.TEXTURE_WRAP_T])gl!.texParameteri(gl!.TEXTURE_2D,name,gl!.CLAMP_TO_EDGE);for(const name of [gl!.TEXTURE_MIN_FILTER,gl!.TEXTURE_MAG_FILTER])gl!.texParameteri(gl!.TEXTURE_2D,name,gl!.LINEAR);return t;}
    const raw=texture(),horizontal=texture(),field=texture();
    function target(t:WebGLTexture){const f=gl!.createFramebuffer()!;targets.push(f);gl!.bindFramebuffer(gl!.FRAMEBUFFER,f);gl!.framebufferTexture2D(gl!.FRAMEBUFFER,gl!.COLOR_ATTACHMENT0,gl!.TEXTURE_2D,t,0);return f;}
    const horizontalTarget=target(horizontal),fieldTarget=target(field);
    const maxTextureSize=gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    const locations=new Map<WebGLProgram,Map<string,WebGLUniformLocation|null>>();
    function uniform(p:WebGLProgram,name:string,v:number|number[],integer=false){let cache=locations.get(p);if(!cache){cache=new Map();locations.set(p,cache);}let l=cache.get(name);if(l===undefined){l=gl!.getUniformLocation(p,name);cache.set(name,l);}if(Array.isArray(v)){if(v.length===3)gl!.uniform3f(l,v[0],v[1],v[2]);else gl!.uniform2f(l,v[0],v[1]);}else if(integer)gl!.uniform1i(l,v);else gl!.uniform1f(l,v);}
    function use(p:WebGLProgram){gl!.useProgram(p);gl!.bindBuffer(gl!.ARRAY_BUFFER,buffer);const a=gl!.getAttribLocation(p,'position');gl!.enableVertexAttribArray(a);gl!.vertexAttribPointer(a,2,gl!.FLOAT,false,0,0);}
    function bind(t:WebGLTexture,unit=0){gl!.activeTexture(gl!.TEXTURE0+unit);gl!.bindTexture(gl!.TEXTURE_2D,t);}
    function fill(item:OpticalPath){if(!item.path||(item.opacity??1)<=0)return;ctx!.globalAlpha=item.opacity??1;ctx!.fill(new Path2D(item.path),'nonzero');}
    return {draw(frame:OpticalFrame){
      if(dead)return;
      const resolution=opticalResolution(innerWidth,innerHeight,devicePixelRatio,maxTextureSize),dpr=resolution.ratio,w=resolution.width,h=resolution.height;
      if(w!==width||h!==height){width=w;height=h;canvas.width=w;canvas.height=h;mask.width=w;mask.height=h;for(const t of [horizontal,field]){bind(t);gl!.texImage2D(gl!.TEXTURE_2D,0,gl!.RGBA,w,h,0,gl!.RGBA,gl!.UNSIGNED_BYTE,null);}}
      ctx!.setTransform(1,0,0,1,0,0);ctx!.globalAlpha=1;ctx!.fillStyle='#000';ctx!.fillRect(0,0,w,h);
      ctx!.setTransform(dpr,0,0,dpr,frame.origin.x*dpr,frame.origin.y*dpr);
      for(const layer of opticalMaskLayers(frame,true)){ctx!.fillStyle=layer.color;layer.paths.forEach(fill);}
      bind(raw);gl!.pixelStorei(gl!.UNPACK_FLIP_Y_WEBGL,true);gl!.texImage2D(gl!.TEXTURE_2D,0,gl!.RGBA,gl!.RGBA,gl!.UNSIGNED_BYTE,mask);
      gl!.viewport(0,0,w,h);use(blur);uniform(blur,'source',0,true);uniform(blur,'stepSize',[2*dpr/w,0]);gl!.bindFramebuffer(gl!.FRAMEBUFFER,horizontalTarget);gl!.drawArrays(gl!.TRIANGLES,0,6);
      bind(horizontal);uniform(blur,'stepSize',[0,2*dpr/h]);gl!.bindFramebuffer(gl!.FRAMEBUFFER,fieldTarget);gl!.drawArrays(gl!.TRIANGLES,0,6);
      gl!.bindFramebuffer(gl!.FRAMEBUFFER,null);use(optics);bind(raw,0);bind(field,1);uniform(optics,'silhouette',0,true);uniform(optics,'field',1,true);uniform(optics,'viewport',[innerWidth,innerHeight]);uniform(optics,'pixelRatio',dpr);uniform(optics,'night',Number(frame.night));uniform(optics,'sceneKind',Number(frame.scene==='graphite'));uniform(optics,'sceneAccent',frame.accent==='iris'?[.56,.32,1.]:frame.accent==='jade'?[.06,.70,.57]:[1.,.82,.083]);uniform(optics,'seamA',[frame.seams[0].x+frame.origin.x,frame.seams[0].y+frame.origin.y]);uniform(optics,'seamB',[frame.seams[1].x+frame.origin.x,frame.seams[1].y+frame.origin.y]);uniform(optics,'tension',[frame.seams[0].tension,frame.seams[1].tension]);gl!.drawArrays(gl!.TRIANGLES,0,6);
    },dispose};
  }catch(error){canvas.dataset.opticalError=error instanceof Error?error.message:String(error);dispose();return null;}
}
