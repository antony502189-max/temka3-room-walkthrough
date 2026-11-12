import test from 'node:test';
import assert from 'node:assert/strict';
import { WalkController } from '../src/WalkController.js';

function event(type, fields = {}) {
  const value = new Event(type, { cancelable: true });
  Object.assign(value, fields);
  return value;
}

function fixture(canOccupy = (x, z) => Math.abs(x) < 100 && Math.abs(z) < 100, extraOptions = {}) {
  const win = new EventTarget();
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  const doc = new EventTarget();
  doc.defaultView = win;
  doc.visibilityState = 'visible';
  doc.activeElement = null;
  doc.pointerLockElement = null;
  doc.exitPointerLock = () => {
    doc.pointerLockElement = null;
    doc.dispatchEvent(event('pointerlockchange'));
  };
  const canvas = new EventTarget();
  canvas.ownerDocument = doc;
  canvas.style = { touchAction: 'auto' };
  canvas.closest = () => null;
  canvas.focus = () => { doc.activeElement = canvas; };
  const captures = new Set();
  canvas.setPointerCapture = (id) => captures.add(id);
  canvas.hasPointerCapture = (id) => captures.has(id);
  canvas.releasePointerCapture = (id) => captures.delete(id);
  const camera = {
    position: { x: 0, y: 0, z: 0, set(x, y, z) { Object.assign(this, { x, y, z }); } },
    rotation: { x: 0, y: 0, z: 0, set(x, y, z, order) { Object.assign(this, { x, y, z, order }); } },
  };
  const states = [];
  const control = new WalkController(camera, canvas, {
    spawn: { x: 0, y: 1.62, z: 0, yaw: 0, pitch: 0 },
    canOccupy,
    onStateChange: (state) => states.push(state),
    ...extraOptions,
  });
  return { control, camera, canvas, doc, win, states };
}

function advance(control, seconds, dt = 1 / 60) {
  for (let i = 0; i < Math.round(seconds / dt); i += 1) control.update(dt);
}

test('diagonal movement has the same speed and eye height as forward movement', () => {
  const a = fixture();
  const b = fixture();
  for (const f of [a, b]) f.control.setEnabled(true);
  a.control.setMoveInput(0, 1);
  b.control.setMoveInput(1, 1);
  advance(a.control, 2);
  advance(b.control, 2);
  assert.ok(Math.abs(Math.hypot(a.control.position.x, a.control.position.z) -
                     Math.hypot(b.control.position.x, b.control.position.z)) < 1e-9);
  assert.equal(a.camera.position.y, 1.62);
  assert.equal(b.camera.position.y, 1.62);
  assert.ok(a.camera.position.z < -3);
  a.control.dispose();
  b.control.dispose();
});

test('solid wall stops motion; a real doorway remains traversable', () => {
  const canOccupy = (x, z) => {
    if (x <= -2 || x >= 2 || z <= -8 || z >= 2) return false;
    const inWallBand = z < -2.8 && z > -3.2;
    const doorway = x >= 0.7 && x <= 1.1;
    return !inWallBand || doorway;
  };
  const f = fixture(canOccupy);
  f.control.setEnabled(true);
  f.control.setMoveInput(0, 1);
  advance(f.control, 10);
  assert.ok(f.control.position.z >= -2.8);
  assert.ok(canOccupy(f.control.position.x, f.control.position.z));
  assert.equal(f.control.teleport({ x: 0.9, y: 1.62, z: -2.5 }), true);
  f.control.setMoveInput(0, 1);
  advance(f.control, 2);
  assert.ok(f.control.position.z < -4);
  assert.ok(canOccupy(f.control.position.x, f.control.position.z));
  f.control.dispose();
});

test('diagonal input slides along a wall and never tunnels on a long frame', () => {
  const f = fixture((x, z) => x < 1 && x > -2 && z > -20 && z < 2);
  f.control.setEnabled(true);
  f.control.setMoveInput(1, 1);
  advance(f.control, 5);
  assert.ok(f.control.position.x < 1);
  assert.ok(f.control.position.x > 0.95);
  assert.ok(f.control.position.z < -5);
  const before = f.control.position;
  f.control.update(30);
  assert.ok(Math.hypot(f.control.position.x - before.x, f.control.position.z - before.z) <= 0.081);
  f.control.dispose();
});

test('KeyboardEvent.code works with a Russian key label; blur clears held movement', () => {
  const f = fixture();
  f.control.setEnabled(true);
  const press = event('keydown', { code: 'KeyW', key: 'ц' });
  f.doc.dispatchEvent(press);
  assert.equal(press.defaultPrevented, true);
  advance(f.control, 1);
  assert.ok(f.control.position.z < -1);
  f.win.dispatchEvent(event('blur'));
  const before = f.control.position;
  advance(f.control, 1);
  assert.deepEqual(f.control.position, before);
  f.control.dispose();
});

test('editable fields and browser modifier shortcuts do not start movement', () => {
  const f = fixture();
  f.control.setEnabled(true);
  f.doc.activeElement = { isContentEditable: true };
  const editing = event('keydown', { code: 'KeyW' });
  f.doc.dispatchEvent(editing);
  advance(f.control, 1);
  assert.equal(editing.defaultPrevented, false);
  assert.equal(f.control.position.z, 0);
  f.doc.activeElement = null;
  const shortcut = event('keydown', { code: 'KeyW', metaKey: true });
  f.doc.dispatchEvent(shortcut);
  advance(f.control, 1);
  assert.equal(shortcut.defaultPrevented, false);
  assert.equal(f.control.position.z, 0);
  f.control.dispose();
});

test('orbit owns the camera when disabled; enabling restores the last safe walk pose', () => {
  const f = fixture();
  f.control.setEnabled(true);
  f.control.setMoveInput(0, 1);
  advance(f.control, 1);
  const lastWalk = f.control.position;
  f.control.setEnabled(false);
  f.camera.position.set(50, 100, 40);
  f.camera.rotation.set(0.5, 0.2, 0.1, 'XYZ');
  f.control.update(1);
  assert.equal(f.camera.position.y, 100);
  assert.equal(f.camera.rotation.order, 'XYZ');
  f.control.setEnabled(true);
  assert.deepEqual({ x: f.camera.position.x, y: f.camera.position.y, z: f.camera.position.z }, lastWalk);
  assert.equal(f.camera.rotation.order, 'YXZ');
  f.control.dispose();
});

test('invalid teleport is rejected and reset restores the configured home', () => {
  const f = fixture((x, z) => Math.abs(x) < 2 && Math.abs(z) < 2);
  assert.equal(f.control.teleport({ x: 20, y: 1.62, z: 0 }), false);
  assert.deepEqual(f.control.position, { x: 0, y: 1.62, z: 0 });
  assert.equal(f.control.teleport({ x: 1, y: 1.62, z: 1, yaw: 1 }), true);
  assert.equal(f.control.reset(), true);
  assert.deepEqual(f.control.position, { x: 0, y: 1.62, z: 0 });
  assert.equal(f.control.yaw, 0);
  f.control.dispose();
});

test('pointer-lock rejection retains mouse dragging and clamps vertical look', async () => {
  const f = fixture();
  f.canvas.requestPointerLock = () => Promise.reject(new Error('Denied for test'));
  f.control.setEnabled(true);
  assert.equal(await f.control.requestPointerLock(), false);
  assert.ok(f.states.some((state) => state.reason === 'pointerlockdenied'));
  f.canvas.dispatchEvent(event('pointerdown', { pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, clientX: 100, clientY: 100 }));
  f.doc.dispatchEvent(event('pointermove', { pointerId: 1, pointerType: 'mouse', buttons: 1, clientX: 200, clientY: -1000 }));
  assert.ok(f.control.yaw < 0);
  assert.ok(Math.abs(f.control.pitch - Math.PI * 80 / 180) < 1e-12);
  f.doc.dispatchEvent(event('pointerup', { pointerId: 1 }));
  assert.equal(f.control.dragging, false);
  f.control.dispose();
});

test('legacy non-Promise pointer lock resolves from events and releases on disable', async () => {
  const f = fixture();
  f.canvas.requestPointerLock = () => {
    setTimeout(() => {
      f.doc.pointerLockElement = f.canvas;
      f.doc.dispatchEvent(event('pointerlockchange'));
    }, 0);
  };
  f.control.setEnabled(true);
  assert.equal(await f.control.requestPointerLock(), true);
  assert.equal(f.control.hasPointerLock, true);
  f.doc.dispatchEvent(event('mousemove', { movementX: 25, movementY: 0 }));
  assert.ok(f.control.yaw < 0);
  f.control.setEnabled(false);
  assert.equal(f.control.hasPointerLock, false);
  f.control.dispose();
});

test('touch look keeps one pointer identity while a separate joystick moves', () => {
  const f = fixture();
  f.control.setEnabled(true);
  f.canvas.dispatchEvent(event('pointerdown', { pointerId: 7, pointerType: 'touch', clientX: 100, clientY: 100 }));
  f.control.setMoveInput(0, 1);
  f.doc.dispatchEvent(event('pointermove', { pointerId: 8, pointerType: 'touch', clientX: 500, clientY: 500 }));
  assert.equal(f.control.yaw, 0);
  f.doc.dispatchEvent(event('pointermove', { pointerId: 7, pointerType: 'touch', clientX: 150, clientY: 100 }));
  assert.ok(f.control.yaw < 0);
  advance(f.control, 1);
  assert.ok(Math.hypot(f.control.position.x, f.control.position.z) > 1);
  f.doc.dispatchEvent(event('pointercancel', { pointerId: 7 }));
  assert.equal(f.control.dragging, false);
  f.control.dispose();
});

test('external swept resolver controls sliding and invalid results are rejected', () => {
  let calls = 0;
  const f = fixture((x, z) => x < 0.5 && z > -20 && z < 2, {
    moveXZ: (x, z, dx, dz) => {
      calls += 1;
      return [Math.min(0.2, x + dx), z + dz];
    },
  });
  f.control.setEnabled(true);
  f.control.setMoveInput(1, 1);
  advance(f.control, 2);
  assert.ok(calls > 100);
  assert.equal(f.control.position.x, 0.2);
  assert.ok(f.control.position.z < -2);
  f.control.dispose();

  const bad = fixture((x, z) => Math.abs(x) < 2 && Math.abs(z) < 2, {
    moveXZ: () => [100, 100],
  });
  bad.control.setEnabled(true);
  bad.control.setMoveInput(0, 1);
  advance(bad.control, 1);
  assert.deepEqual(bad.control.position, { x: 0, y: 1.62, z: 0 });
  bad.control.dispose();
});
