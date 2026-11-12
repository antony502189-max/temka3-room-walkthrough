/**
 * Focused CPU renderer tests. Run from the viewer project:
 *   node --test tests/SoftwareRenderer.test.mjs
 *
 * Uses real Three.js geometry/cameras and an in-memory Canvas2D test double.
 * This validates raster mathematics, not browser Canvas/ImageBitmap support.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const projectRoot = process.env.ROOM_VIEWER_ROOT || process.cwd();
const projectRequire = createRequire(path.join(projectRoot, 'package.json'));
const threeEntry = projectRequire.resolve('three');
const THREE = await import(pathToFileURL(path.join(path.dirname(threeEntry), 'three.module.js')));
const projectRenderer = path.join(projectRoot, 'src/SoftwareRenderer.js');
const rendererUrl = fs.existsSync(projectRenderer) ? pathToFileURL(projectRenderer) : new URL('./SoftwareRenderer.js', import.meta.url);
const { SoftwareRenderer } = await import(rendererUrl);

function setup() {
  const context = {
    image: null,
    createImageData: (width, height) => ({ data: new Uint8ClampedArray(width * height * 4), width, height }),
    putImageData(image) { this.image = image; },
  };
  const canvas = { width: 128, height: 128, clientWidth: 128, clientHeight: 128,
    style: {}, getContext: () => context };
  const renderer = new SoftwareRenderer({ canvas });
  const camera = new THREE.PerspectiveCamera(90, 1, 0.1, 100);
  const pixel = (x, y) => [...context.image.data.slice((y * renderer.width + x) * 4, (y * renderer.width + x) * 4 + 4)];
  return { context, canvas, renderer, camera, pixel };
}

function triangle(depth, color, reverse = false) {
  const geometry = new THREE.BufferGeometry();
  const scale = Math.abs(depth) * 0.5;
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    -scale, -scale, depth, scale, -scale, depth, 0, scale, depth,
  ], 3));
  geometry.setIndex(reverse ? [0, 2, 1] : [0, 1, 2]);
  return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color }));
}

test('depth buffer keeps the nearer surface at overlapping pixels', async () => {
  const { renderer, camera, pixel } = setup();
  const scene = new THREE.Scene();
  scene.add(triangle(-4, 0x00ff00), triangle(-2, 0xff0000));
  await renderer.prepare(scene);
  renderer.render(scene, camera);
  assert(pixel(64, 64)[0] > 150);
  assert(pixel(64, 64)[1] < 5);
  renderer.dispose();
});

test('camera cache skips duplicate frames and parent visibility invalidates it', async () => {
  const { renderer, camera, pixel } = setup();
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#111111');
  const parent = new THREE.Group();
  parent.add(triangle(-2, 0xff0000));
  scene.add(parent);
  await renderer.prepare(scene);
  renderer.render(scene, camera);
  const frame = renderer.info.render.frame;
  renderer.render(scene, camera);
  assert.equal(renderer.info.render.frame, frame);
  assert.equal(renderer.stats.cached, true);
  parent.visible = false;
  renderer.render(scene, camera);
  assert.equal(renderer.info.render.frame, frame + 1);
  assert.equal(renderer.stats.cached, false);
  assert.deepEqual(pixel(64, 64), [17, 17, 17, 255]);
  renderer.dispose();
});

test('negative world determinant keeps intended front faces visible', async () => {
  const { renderer, camera, pixel } = setup();
  const scene = new THREE.Scene();
  const mesh = triangle(-2, 0xff0000);
  mesh.scale.x = -1;
  scene.add(mesh);
  await renderer.prepare(scene);
  renderer.render(scene, camera);
  assert(pixel(64, 64)[0] > 150);
  renderer.dispose();
});

test('near-plane crossing is clipped instead of dropping the whole triangle', async () => {
  const { renderer, camera, context } = setup();
  const scene = new THREE.Scene();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    -0.5, -0.5, -1, 0.5, -0.5, -1, 0, 0.5, 0.2,
  ], 3));
  geometry.setIndex([0, 1, 2]);
  scene.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: 0x0000ff, side: THREE.DoubleSide })));
  await renderer.prepare(scene);
  renderer.render(scene, camera);
  assert(renderer.info.render.triangles > 0);
  assert(context.image.data.some((value, index) => index % 4 === 2 && value > 200));
  renderer.dispose();
});

test('FrontSide culls reversed winding while DoubleSide renders it', async () => {
  const { renderer, camera } = setup();
  const scene = new THREE.Scene();
  const mesh = triangle(-2, 0xff0000, true);
  scene.add(mesh);
  await renderer.prepare(scene);
  renderer.render(scene, camera);
  assert.equal(renderer.info.render.triangles, 0);
  mesh.material.side = THREE.DoubleSide;
  await renderer.prepare(scene);
  renderer.render(scene, camera);
  assert(renderer.info.render.triangles > 0);
  renderer.dispose();
});

test('textured triangles use perspective-correct UV, not affine UV', async () => {
  const originalCanvas = globalThis.OffscreenCanvas;
  globalThis.OffscreenCanvas = class {
    constructor(width, height) { this.width = width; this.height = height; }
    getContext() {
      let source;
      return { drawImage(image) { source = image; }, getImageData() { return { data: source.data }; } };
    }
  };
  const { renderer, camera, pixel } = setup();
  try {
    const texels = new Uint8ClampedArray(16 * 16 * 4);
    for (let y = 0; y < 16; y += 1) for (let x = 0; x < 16; x += 1) {
      const index = (y * 16 + x) * 4;
      texels[index] = x * 17; texels[index + 1] = y * 17; texels[index + 3] = 255;
    }
    const map = new THREE.Texture({ width: 16, height: 16, data: texels });
    map.flipY = false;
    map.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.MeshBasicMaterial({ map, color: 0xffffff, side: THREE.DoubleSide });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, -2, 1, -1, -5, 0, 1, -3], 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0.5, 1], 2));
    geometry.setIndex([0, 1, 2]);
    const scene = new THREE.Scene(); scene.add(new THREE.Mesh(geometry, material));
    await renderer.prepare(scene); renderer.render(scene, camera);
    assert.equal(renderer.warnings.length, 0);
    const batch = renderer._batches[0], screen = batch.shared.screen;
    const px = 60.5, py = 70.5;
    const area = (screen[3] - screen[0]) * (screen[7] - screen[1]) - (screen[4] - screen[1]) * (screen[6] - screen[0]);
    const w0 = ((screen[3] - px) * (screen[7] - py) - (screen[4] - py) * (screen[6] - px)) / area;
    const w1 = ((screen[6] - px) * (screen[1] - py) - (screen[7] - py) * (screen[0] - px)) / area;
    const w2 = 1 - w0 - w1;
    assert(w0 > 0 && w1 > 0 && w2 > 0);
    const q = w0 * screen[2] + w1 * screen[5] + w2 * screen[8];
    const u = (w1 * screen[5] + w2 * 0.5 * screen[8]) / q;
    const v = w2 * screen[8] / q;
    const tx = Math.floor(u * 16), ty = Math.floor(v * 16);
    const affineX = Math.floor((w1 + w2 * 0.5) * 16), affineY = Math.floor(w2 * 16);
    assert(tx !== affineX || ty !== affineY, 'The sample must distinguish perspective from affine interpolation');
    const palette = renderer._palette(batch.material, batch.shades[0]);
    assert.deepEqual(pixel(60, 70), [palette.red[tx * 17], palette.green[ty * 17], 0, 255]);
  } finally {
    renderer.dispose();
    if (originalCanvas === undefined) delete globalThis.OffscreenCanvas;
    else globalThis.OffscreenCanvas = originalCanvas;
  }
});
