/** A circle smoothly united with the outside frame, never a hollow crescent.
 * A broad circular arc lowers into the same background, without an outlined rim.
 */
export function entryPocketMetrics(edge:number,cy:number,amount:number,direction:1|-1=1,bridge=0){
  const active=Math.max(0,Math.min(1,amount)),radius=44,fillet=22;
  const offset=-33+36*active+bridge,centre=edge+direction*offset;
  const dy=Math.sqrt((radius+fillet)**2-(fillet-offset)**2);
  return {edge,cy,direction,radius,fillet,offset,centre,dy,depth:radius+offset};
}

/** Cubics trace true circular arcs, with a tangent circular fillet at the edge. */
export function entryPocketPath(edge:number,cy:number,amount:number,direction:1|-1=1,bridge=0){
  return circularPocketPath(entryPocketMetrics(edge,cy,amount,direction,bridge));
}

function circularPocketPath(m:ReturnType<typeof entryPocketMetrics>){
  const {edge,cy,direction}=m,r=m.radius,f=m.fillet;
  const pt=(x:number,y:number)=>`${(edge+direction*x).toFixed(3)} ${(cy+y).toFixed(3)}`;
  const commands=[`M ${pt(0,-m.dy)}`];
  function arc(cx:number,cy:number,radius:number,from:number,to:number){
    const steps=Math.ceil(Math.abs(to-from)/(Math.PI/2));
    for(let i=0;i<steps;i++){
      const a=from+(to-from)*i/steps,b=from+(to-from)*(i+1)/steps,k=4/3*Math.tan((b-a)/4);
      commands.push(`C ${pt(cx+radius*(Math.cos(a)-k*Math.sin(a)),cy+radius*(Math.sin(a)+k*Math.cos(a)))} ${pt(cx+radius*(Math.cos(b)+k*Math.sin(b)),cy+radius*(Math.sin(b)-k*Math.cos(b)))} ${pt(cx+radius*Math.cos(b),cy+radius*Math.sin(b))}`);
    }
  }
  const contactX=m.offset+(f-m.offset)*r/(r+f),contactY=-m.dy*r/(r+f);
  const filletAngle=Math.atan2(contactY+m.dy,contactX-f),circleAngle=Math.atan2(contactY,contactX-m.offset);
  arc(f,-m.dy,f,Math.PI,filletAngle);
  arc(m.offset,0,r,circleAngle,-circleAngle);
  arc(f,m.dy,f,-filletAngle,-Math.PI);
  commands.push(`L ${pt(0,-m.dy)}`,'Z');
  return commands.join(' ');
}

/** The rail owns the lobe; the mother yields around a parallel clearance curve.
 * Expanding the convex radius and reducing the shoulder fillet by the same
 * amount keeps a real background channel, including through the tangent joins.
 */
export function sidebarEntryGeometry(edge:number,cy:number,amount:number,gap=12.5){
  const active=Math.max(0,Math.min(1,amount)),radius=42,fillet=26,offset=-34+24*active;
  const dy=Math.sqrt((radius+fillet)**2-(fillet-offset)**2);
  const support={edge,cy,direction:1 as const,radius,fillet,offset,centre:edge+offset,dy,depth:radius+offset};
  const clearance={...support,edge:edge+gap,radius:radius+gap,fillet:fillet-gap,offset:offset-gap};
  return {support,clearance,supportPath:circularPocketPath(support),clearancePath:circularPocketPath(clearance),eye:{x:edge+4,y:cy}};
}
