import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import layout from '../assets/design-layout.json';

/** Physical area emitters above modeled cove shelves, directed onto the ceiling. */
export function createLighting(scene, model, {software=false}={}) {
  if(!software) RectAreaLightUniformsLib.init();
  const lights=[], leds=[];
  function orient(light,right,normal){
    const back=normal.clone().normalize().negate();
    const up=new THREE.Vector3().crossVectors(back,right).normalize();
    light.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right,up,back));
  }
  model.traverse(o=>{
    if(!o.isMesh || !o.name.startsWith('LED_'))return;
    o.material=o.material.clone();
    leds.push({material:o.material,base:o.material.emissiveIntensity||1});
  });
  for(const [x0,z0,x1,z1] of layout.segments){
    const x=(x0+x1)/2,z=(z0+z1)/2,length=Math.hypot(x1-x0,z1-z0);
    if(software)continue;
    const light=new THREE.RectAreaLight(0xffddb0,5.5,length-.06,.065);
    light.position.set(x,layout.light_height,z);
    orient(light,new THREE.Vector3(x1-x0,0,z1-z0).normalize(),new THREE.Vector3(0,1,0));
    scene.add(light);lights.push(light);
  }
  // The narrow upper coves also illuminate the adjacent wall, with broad sources
  // positioned behind the visible lip. No screen-space halos show through walls.
  for(const [x,z,width,sign] of [[3.05,3.0,4.8,-1],[3.07,11.7,4.1,-1],[8.74,11.5,4.1,1]]){
    if(software)continue;
    const light=new THREE.RectAreaLight(0xffe3be,1.3,width,.12);
    light.position.set(x,1.99,z);orient(light,new THREE.Vector3(0,0,1),new THREE.Vector3(sign,.25,0).normalize());
    scene.add(light);lights.push(light);
  }
  const base=lights.map(l=>l.intensity);
  let enabled=true,level=.75;
  function apply(){
    const strength=enabled?level:0;
    lights.forEach((l,i)=>{l.intensity=base[i]*strength;});
    leds.forEach(({material,base})=>{material.emissiveIntensity=base*strength;material.color.set(enabled?'#fff0cc':'#c8c2b3');});
  }
  apply();
  return {
    setEnabled(v){enabled=Boolean(v);apply();},
    setLevel(v){level=THREE.MathUtils.clamp(Number(v)||0,0,1);apply();},
    getState(){return {enabled,level,areaLights:lights.length,emitters:leds.length,temperatureKelvin:3000};}
  };
}
