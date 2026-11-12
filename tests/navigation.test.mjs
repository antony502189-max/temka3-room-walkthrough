import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createNavigation} from '../src/navigation_region.mjs';
const data=JSON.parse(fs.readFileSync(new URL('../assets/navigation.json',import.meta.url),'utf8'));
const region=createNavigation(data);
test('all real-scene viewpoints are free standing positions',()=>{
  for(const view of data.viewpoints)assert.ok(region.contains(view.position[0],view.position[2]),view.id);
});
test('the real room can be traversed from end to end',()=>{
  let [x,,z]=data.spawn.position;
  for(let i=0;i<420;i++){
    [x,z]=region.move(x,z,0,-.03);
    assert.ok(region.contains(x,z));
  }
  assert.ok(z<1.8&&z>.2,`end z=${z}`);
});
test('the closed side door stops the player repeatedly',()=>{
  let x=6,z=7.5;
  for(let i=0;i<1000;i++)[x,z]=region.move(x,z,.03,0);
  assert.ok(x<7.5&&x>7.1,`door stop x=${x}`);assert.ok(region.contains(x,z));
});
test('invalid start and background-tab movement recover safely',()=>{
  const p=region.move(500,500,100,100);
  assert.ok(region.contains(...p));
  assert.ok(Math.hypot(p[0]-data.spawn.position[0],p[1]-data.spawn.position[2])<=.251);
});
