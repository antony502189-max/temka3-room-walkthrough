import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { WalkController } from './WalkController.js';
import { createNavigation } from './navigation_region.mjs';
import { SoftwareRenderer } from './SoftwareRenderer.js';
import { createLighting } from './lighting.js';
import references from '../assets/references.json';

const $ = (id) => document.getElementById(id);
const canvas = $('scene');
const data = JSON.parse($('room-navigation').textContent);
const navigation = createNavigation(data);
const spawnFor = (point) => ({x:point.position[0],y:point.position[1],z:point.position[2],yaw:point.yaw,pitch:point.pitch||0});
const touchDevice = matchMedia('(pointer: coarse)').matches;
const camera = new THREE.PerspectiveCamera(65, innerWidth/innerHeight, .045, 100);
const scene = new THREE.Scene();
scene.background = new THREE.Color('#e7e4db');
let renderer, model, ceiling, orbit, walk, loaded=false, started=false, mode='walk';
let lighting,lightEnabled=true;
let toastTimer, lastFrame=0, frameCount=0, sampleFrames=[], lastProof=0, lastRenderMs=0;
let selectedView=data.spawn.id, showingHelp=false, savedWalk=null;
const clockStart=performance.now();

function notify(message, duration=4200) {
  clearTimeout(toastTimer); $('toast').textContent=message; $('toast').hidden=false;
  toastTimer=setTimeout(()=>$('toast').hidden=true,duration);
}
function fatal(error) {
  console.error(error);
  if(walk)walk.setEnabled(false);
  $('fatal-error').hidden=false;
  $('error-message').textContent=error?.message?.includes('WebGL')
    ? 'Браузер не смог включить 3D-графику. Откройте файл в актуальном Chrome или Safari с включённым аппаратным ускорением.'
    : 'Не удалось подготовить модель. Попробуйте открыть файл непосредственно в Chrome или Safari, а не во встроенном просмотрщике мессенджера.';
  $('verification-state').textContent=JSON.stringify({loaded:false,error:String(error?.message||error)});
}
function progress(value,label){$('load-progress').style.width=value+'%';$('load-text').textContent=label;}
function markView(id){
  selectedView=id;
  for(const button of $('viewpoints').children)button.classList.toggle('active',button.dataset.view===id);
}
function setMode(next, resetOrbit=true) {
  if(!loaded)return;
  if(next==='walk'&&mode==='walk'&&walk.active)return;
  if(mode==='walk'&&next!=='walk')savedWalk={x:camera.position.x,y:camera.position.y,z:camera.position.z,yaw:walk.yaw,pitch:walk.pitch};
  mode=next;
  walk.setEnabled(started&&mode==='walk'&&!showingHelp);
  orbit.enabled=started&&mode==='orbit'&&!showingHelp;
  if(ceiling)ceiling.visible=mode!=='orbit';
  $('walk-mode').classList.toggle('selected',mode==='walk');
  $('orbit-mode').classList.toggle('selected',mode==='orbit');
  $('walk-mode').setAttribute('aria-pressed',String(mode==='walk'));
  $('orbit-mode').setAttribute('aria-pressed',String(mode==='orbit'));
  $('mode-label').textContent=(mode==='walk'?'Прогулка внутри':'Осмотр целиком')+(renderer?.isSoftwareRenderer?' · совместимый режим':'');
  $('walk-hint').hidden=mode!=='walk';
  $('capture-mouse').hidden=mode!=='walk'||touchDevice;
  $('crosshair').hidden=!started||mode!=='walk';
  $('touch-controls').hidden=!started||mode!=='walk'||!touchDevice;
  $('viewpoints-panel').classList.toggle('touch-active',touchDevice&&mode==='walk');
  $('minimap').classList.toggle('orbit',mode==='orbit');
  if(mode==='orbit'&&resetOrbit){
    camera.position.set(13.9,12.65,17.9); orbit.target.set(5.95,.6,7.2);
    orbit.update(); markView('');
  }else if(mode==='walk'){
    const p=savedWalk&&navigation.contains(savedWalk.x,savedWalk.z)?savedWalk:spawnFor(data.spawn);
    walk.teleport(p); savedWalk=null;
  }
  canvas.focus({preventScroll:true});
}
function selectView(view) {
  if(!loaded)return;
  const next=spawnFor(view);
  if(mode==='walk')walk.teleport(next);
  else{
    camera.position.set(next.x,next.y,next.z);
    camera.rotation.set(next.pitch,next.yaw,0,'YXZ');
    const direction=new THREE.Vector3(); camera.getWorldDirection(direction);
    orbit.target.copy(camera.position).addScaledVector(direction,3.0); orbit.update();
  }
  markView(view.id); canvas.focus({preventScroll:true});
}
function reset(){
  if(mode==='orbit')setMode('orbit');
  else {walk.reset();markView(data.spawn.id);}
  notify(mode==='walk'?'Вы вернулись в начало комнаты.':'Общий ракурс восстановлен.',2400);
}

const mapBounds={minX:2.5,maxX:9.25,minZ:-.5,maxZ:14.7};
const mapScale=Math.min(142/(mapBounds.maxX-mapBounds.minX),264/(mapBounds.maxZ-mapBounds.minZ));
const toMap=(x,z)=>[80+(x-5.875)*mapScale,140+(z-7.1)*mapScale];
function polygonPath(polygons){
  return polygons.flatMap(p=>[p.outer,...p.holes]).map(r=>r.map((p,i)=>{
    const [x,z]=toMap(p[0],p[1]);return`${i?'L':'M'}${x.toFixed(2)},${z.toFixed(2)}`;
  }).join(' ')+'Z').join(' ');
}
$('map-floor').setAttribute('d',polygonPath(data.floor));
$('map-safe').setAttribute('d',polygonPath(data.walkable));
$('map-floor').setAttribute('fill-rule','evenodd');
$('map-safe').setAttribute('fill-rule','evenodd');
function showMap(value){$('minimap').hidden=!value;$('map-toggle').setAttribute('aria-expanded',String(value));}

for(const [index,view]of data.viewpoints.entries()){
  const button=document.createElement('button');button.type='button';button.className='viewpoint';button.dataset.view=view.id;
  const n=document.createElement('span');n.className='number';n.textContent=String(index+1).padStart(2,'0');
  const label=document.createElement('span');label.textContent=view.label;button.append(n,label);
  button.addEventListener('click',()=>selectView(view));$('viewpoints').appendChild(button);
}
markView(data.spawn.id);
$('walk-mode').addEventListener('click',()=>setMode('walk'));
$('orbit-mode').addEventListener('click',()=>setMode('orbit'));
$('reset').addEventListener('click',reset);
$('retry').addEventListener('click',()=>location.reload());
$('map-toggle').addEventListener('click',()=>showMap($('minimap').hidden));
$('map-close').addEventListener('click',()=>showMap(false));
$('light-toggle').addEventListener('click',()=>{
  lightEnabled=!lightEnabled;lighting?.setEnabled(lightEnabled);
  $('light-toggle').setAttribute('aria-pressed',String(lightEnabled));
  $('light-toggle').textContent=lightEnabled?'Подсветка включена':'Подсветка выключена';
  $('light-level').disabled=!lightEnabled;
});
$('light-level').addEventListener('input',e=>{
  lighting?.setLevel(Number(e.target.value)/100);$('light-value').textContent=e.target.value+'%';
});
if(innerWidth<681)$('light-details').open=false;
for(const [i,ref] of references.entries()){
  const figure=document.createElement('figure'),img=document.createElement('img'),caption=document.createElement('figcaption');
  img.src=ref.data;img.alt=ref.title;img.loading='lazy';caption.textContent=String(i+1).padStart(2,'0')+' / '+ref.title;
  figure.append(img,caption);$('reference-grid').append(figure);
}
$('references-open').addEventListener('click',()=>{
  showingHelp=true;walk?.setEnabled(false);if(orbit)orbit.enabled=false;$('references-dialog').showModal();
});
function closeReferences(){
  $('references-dialog').close();showingHelp=false;
  walk?.setEnabled(started&&mode==='walk');if(orbit)orbit.enabled=started&&mode==='orbit';canvas.focus({preventScroll:true});
}
$('references-close').addEventListener('click',closeReferences);
$('references-dialog').addEventListener('cancel',e=>{e.preventDefault();closeReferences();});
$('capture-mouse').addEventListener('click',()=>walk?.requestPointerLock());
$('fullscreen').addEventListener('click',async()=>{
  try{
    if(document.fullscreenElement)await document.exitFullscreen();
    else if($('app').requestFullscreen)await $('app').requestFullscreen();
    else notify('Можно пользоваться комнатой в обычном окне браузера.');
  }catch{notify('Просмотр доступен в обычном окне браузера.');}
});
$('help').addEventListener('click',()=>{
  showingHelp=true;walk?.setEnabled(false);if(orbit)orbit.enabled=false;
  if(typeof $('help-dialog').showModal==='function')$('help-dialog').showModal();
  else $('help-dialog').setAttribute('open','');
});
function closeHelp(){
  if(typeof $('help-dialog').close==='function')$('help-dialog').close();
  else $('help-dialog').removeAttribute('open');
  showingHelp=false;
  if(walk)walk.setEnabled(started&&mode==='walk');if(orbit)orbit.enabled=started&&mode==='orbit';
  canvas.focus({preventScroll:true});
}
$('close-help').addEventListener('click',closeHelp);$('help-done').addEventListener('click',closeHelp);
$('help-dialog').addEventListener('cancel',(e)=>{e.preventDefault();closeHelp();});
$('start').addEventListener('click',()=>{
  if(!loaded)return;
  started=true; $('welcome').hidden=true;$('viewpoints-panel').hidden=false;$('bottom-bar').hidden=false;$('design-panel').hidden=false;
  setMode('walk');
  if(!touchDevice)walk.requestPointerLock();
});

let joystickPointer=null;
function joystickInput(e){
  const bounds=$('joystick').getBoundingClientRect();
  let x=e.clientX-bounds.left-bounds.width/2,z=e.clientY-bounds.top-bounds.height/2;
  const radius=33, length=Math.hypot(x,z);
  if(length>radius){x*=radius/length;z*=radius/length;}
  if(length<4){x=0;z=0;}
  $('joystick-thumb').style.transform=`translate(${x}px,${z}px)`;walk?.setMoveInput(x/radius,-z/radius);
}
$('joystick').addEventListener('pointerdown',(e)=>{
  if(joystickPointer!==null)return;joystickPointer=e.pointerId;
  $('joystick').setPointerCapture(e.pointerId);joystickInput(e);e.preventDefault();
});
$('joystick').addEventListener('pointermove',(e)=>{if(e.pointerId===joystickPointer){joystickInput(e);e.preventDefault();}});
function endJoystick(e){if(e&&e.pointerId!==joystickPointer)return;joystickPointer=null;$('joystick-thumb').style.transform='';walk?.setMoveInput(0,0);}
for(const event of ['pointerup','pointercancel','lostpointercapture'])$('joystick').addEventListener(event,endJoystick);
window.addEventListener('blur',()=>endJoystick());

async function init(){
  try{
    const context=canvas.getContext('webgl2',{antialias:true,alpha:false,powerPreference:'high-performance'});
    renderer=context?new THREE.WebGLRenderer({canvas,context,antialias:true,alpha:false,powerPreference:'high-performance'}):new SoftwareRenderer({canvas});
    renderer.setPixelRatio(Math.min(devicePixelRatio,touchDevice?1.6:2));
    renderer.setSize(innerWidth,innerHeight,false);
    renderer.outputColorSpace=THREE.SRGBColorSpace;
    renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.05;
    renderer.setClearColor('#e7e4db');
    if(!renderer.isSoftwareRenderer){
      const pmrem=new THREE.PMREMGenerator(renderer);
      const roomEnv=new RoomEnvironment();
      const environment=pmrem.fromScene(roomEnv,.04);
      scene.environment=environment.texture;scene.environmentIntensity=.4;
      roomEnv.dispose();pmrem.dispose();
    }
    scene.add(new THREE.AmbientLight(0xffffff,.48));
    scene.add(new THREE.HemisphereLight(0xfff9ee,0xa6ada5,.85));
    const daylight=new THREE.DirectionalLight(0xfff9ee,1.25);daylight.position.set(5,6,-4);scene.add(daylight);
    for(const z of [1.6,5.5,9.6,13]){
      const light=new THREE.PointLight(0xfff4e5,3.5,6,2);light.position.set(5.9,2.05,z);scene.add(light);
    }
    orbit=new OrbitControls(camera,canvas);orbit.enabled=false;orbit.enableDamping=true;orbit.dampingFactor=.09;
    orbit.minDistance=1.4;orbit.maxDistance=34;orbit.minPolarAngle=.08;orbit.maxPolarAngle=Math.PI/2-.03;
    orbit.screenSpacePanning=false;orbit.rotateSpeed=.55;orbit.zoomSpeed=.8;
    walk=new WalkController(camera,canvas,{
      canOccupy:navigation.contains,moveXZ:navigation.move,spawn:spawnFor(data.spawn),
      onStateChange:(state)=>{
        $('capture-mouse').textContent=state.hasPointerLock?'Esc — отпустить мышь':'Управлять мышью';
        if(state.pointerLockError&&started)notify('Осматривайтесь, удерживая кнопку мыши и перетаскивая изображение.');
      }
    });
    progress(22,'Подготавливаем материалы…');
    await new Promise(requestAnimationFrame);
    const b64=$('room-model').textContent.trim();const raw=atob(b64);const bytes=new Uint8Array(raw.length);
    for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);
    progress(54,'Собираем пространство…');
    const gltf=await new GLTFLoader().parseAsync(bytes.buffer,'');model=gltf.scene;
    scene.add(model);model.updateMatrixWorld(true);
    ceiling=model.getObjectByName('Plane');
    if(ceiling){
      ceiling.traverse(o=>{if(o.isMesh){o.material=o.material.clone();o.material.side=THREE.DoubleSide;o.material.color.set('#e5e2d8');o.material.roughness=.92;}});
    }
    lighting=createLighting(scene,model,{software:renderer.isSoftwareRenderer});
    if(renderer.prepare)await renderer.prepare(scene);
    progress(85,'Готовим первый ракурс…');
    renderer.render(scene,camera);
    if(renderer.compileAsync)await renderer.compileAsync(scene,camera);
    progress(100,'Комната готова к прогулке');
    loaded=true; $('start').disabled=false;
    for(const id of ['walk-mode','orbit-mode','reset'])$(id).disabled=false;
    const renderTime=performance.now()-clockStart;
    $('verification-state').dataset.readyMs=renderTime.toFixed(0);
    requestAnimationFrame(frame);
  }catch(e){fatal(e);}
}

function frame(now){
  const rawDt=lastFrame?(now-lastFrame)/1000:0;
  const dt=Math.min(rawDt,.05);lastFrame=now;
  if(!document.hidden){
    if(mode==='walk')walk.update(dt);
    else if(orbit.enabled){
      orbit.target.x=THREE.MathUtils.clamp(orbit.target.x,2.8,9.1);
      orbit.target.y=THREE.MathUtils.clamp(orbit.target.y,.2,2.5);
      orbit.target.z=THREE.MathUtils.clamp(orbit.target.z,.1,14.2);
      orbit.update();
    }
    const renderStart=performance.now();
    renderer.render(scene,camera);lastRenderMs=performance.now()-renderStart;frameCount++;
    if(rawDt>0){sampleFrames.push(rawDt*1000);if(sampleFrames.length>120)sampleFrames.shift();}
    const [x,z]=toMap(camera.position.x,camera.position.z);
    $('map-player').setAttribute('transform',`translate(${x.toFixed(2)} ${z.toFixed(2)}) rotate(${(-walk.yaw*180/Math.PI).toFixed(1)})`);
    if(now-lastProof>500){
      lastProof=now;
      const sorted=sampleFrames.slice().sort((a,b)=>a-b);
      $('verification-state').textContent=JSON.stringify({
        loaded,started,mode,renderer:renderer.isSoftwareRenderer?'canvas2d':'webgl2',position:camera.position.toArray().map(v=>+v.toFixed(5)),yaw:+walk.yaw.toFixed(5),pitch:+walk.pitch.toFixed(5),
        collisionSafe:mode!=='walk'||navigation.contains(camera.position.x,camera.position.z),
        pointerLocked:document.pointerLockElement===canvas,frames:frameCount,
        triangles:renderer.info.render.triangles,drawCalls:renderer.info.render.calls,
        medianFrameMs:sorted.length?+sorted[Math.floor(sorted.length/2)].toFixed(1):null,lastRenderMs:+lastRenderMs.toFixed(1),
        resources:performance.getEntriesByType('resource').map(v=>v.name),
        inputResetOnBlur:true,lighting:lighting?.getState(),murals:['Mural_Flax','Mural_Landscape','Mural_Memories'].map(name=>({name,present:Boolean(model.getObjectByName(name))}))
      });
    }
  }
  requestAnimationFrame(frame);
}
window.addEventListener('resize',()=>{
  if(!renderer)return;
  camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight,false);
});
document.addEventListener('visibilitychange',()=>{lastFrame=0;if(document.hidden)endJoystick();});
canvas.addEventListener('webglcontextlost',(e)=>{e.preventDefault();walk?.setEnabled(false);notify('3D-просмотр был приостановлен. Перезагрузите страницу, чтобы продолжить.',15000);});
init();
