/** Flat-floor navigation against polygons already inflated for the player radius.
 * Coordinates are Three.js x,z. No dependency on Three.js or browser globals.
 * navigate.move(x,z,dx,dz) returns [nextX,nextZ]. Delta is in metres.
 */
export function createNavigation(data) {
  const regions = data.walkable.map(p => ({...p, bounds: boundsFor(p.outer)}));
  const segments = regions.flatMap(p => [p.outer, ...p.holes].flatMap(ring =>
    ring.slice(0, -1).map((a, i) => [a, ring[i + 1]])));
  const fallback = [data.spawn.position[0], data.spawn.position[2]];
  const substep = data.movement_max_substep || 0.035;
  function contains(x, z) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
    return regions.some(p => x >= p.bounds[0] && x <= p.bounds[2] &&
      z >= p.bounds[1] && z <= p.bounds[3] && inRing(x, z, p.outer) &&
      !p.holes.some(h => inRing(x, z, h)));
  }
  function move(x, z, dx, dz) {
    if (!contains(x,z)) [x,z] = fallback;
    if (!Number.isFinite(dx) || !Number.isFinite(dz)) return [x,z];
    let distance = Math.hypot(dx,dz);
    // A returning background tab cannot teleport through multiple metres.
    if (distance > 0.25) {
      dx *= 0.25 / distance; dz *= 0.25 / distance; distance = 0.25;
    }
    const steps = Math.max(1, Math.ceil(distance / substep));
    const sx = dx / steps, sz = dz / steps;
    for (let i=0;i<steps;i++) {
      const tx=x+sx, tz=z+sz;
      if (contains(tx,tz)) {x=tx;z=tz;continue;}
      let best=null, bestD=Infinity;
      for (const [a,b] of segments) {
        const q=closest(tx,tz,a,b), d=(q[0]-tx)**2+(q[1]-tz)**2;
        if(d<bestD){best=q;bestD=d;}
      }
      let candidates=[];
      if(best){
        const vx=x-best[0],vz=z-best[1],vl=Math.hypot(vx,vz)||1;
        candidates.push([best[0]+vx/vl*1e-5,best[1]+vz/vl*1e-5]);
      }
      candidates.push([tx,z],[x,tz]);
      // Choose the safe candidate nearest the requested endpoint. Boundary
      // projection provides sliding along oblique edges and rounded corners.
      let next=[x,z], score=(x-tx)**2+(z-tz)**2;
      for(const c of candidates){
        if(!contains(c[0],c[1]))continue;
        const travel=Math.hypot(c[0]-x,c[1]-z);
        if(travel>Math.hypot(sx,sz)+1e-4)continue;
        const value=(c[0]-tx)**2+(c[1]-tz)**2;
        if(value<score){next=c;score=value;}
      }
      [x,z]=next;
    }
    return [x,z];
  }
  return {contains, move, spawn: fallback.slice()};
}

function boundsFor(ring){
  return [Math.min(...ring.map(p=>p[0])),Math.min(...ring.map(p=>p[1])),
    Math.max(...ring.map(p=>p[0])),Math.max(...ring.map(p=>p[1]))];
}
function inRing(x,z,ring){
  let inside=false;
  for(let i=0,j=ring.length-1;i<ring.length;j=i++){
    const a=ring[i],b=ring[j];
    if((a[1]>z)!==(b[1]>z)&&x<(b[0]-a[0])*(z-a[1])/(b[1]-a[1])+a[0])inside=!inside;
  }
  return inside;
}
function closest(x,z,a,b){
  const vx=b[0]-a[0],vz=b[1]-a[1],len=vx*vx+vz*vz;
  if(!len)return a;
  const t=Math.max(0,Math.min(1,((x-a[0])*vx+(z-a[1])*vz)/len));
  return [a[0]+t*vx,a[1]+t*vz];
}
