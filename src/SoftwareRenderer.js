/**
 * Canvas2D CPU fallback for this static Three.js interior.
 *
 * It renders the same BufferGeometry meshes loaded by GLTFLoader. The normal
 * WebGL renderer remains the preferred path. This fallback uses a real depth
 * buffer, clips triangles against near/far planes, and interpolates texture UVs
 * perspective-correctly. Lighting is deliberately neutral and approximate;
 * environment maps, cast shadows, PBR reflections and skinned meshes are omitted.
 *
 * await renderer.prepare(scene) AFTER model transforms/materials are finalized.
 * Parent visibility is read every render, so hiding the ceiling works without
 * rebuilding. Call prepare(scene) again after changing geometry/transforms/maps.
 * No network request, WebGL call or dependency is used by this module.
 */

const FRONT = 0;
const BACK = 1;
const DOUBLE = 2;
const REPEAT = 1000;
const MIRROR = 1002;
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([0x11223344]).buffer)[0] === 0x44;
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const srgbToLinear = (value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
const linearToByte = (value) => {
  const v = clamp(value, 0, 1);
  return Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055));
};
const pack = LITTLE_ENDIAN
  ? (r, g, b) => (r | (g << 8) | (b << 16) | 0xff000000) >>> 0
  : (r, g, b) => ((r << 24) | (g << 16) | (b << 8) | 255) >>> 0;

function visibleInHierarchy(object) {
  for (let item = object; item; item = item.parent) if (item.visible === false) return false;
  return true;
}

function determinant3(elements) {
  return elements[0] * (elements[5] * elements[10] - elements[6] * elements[9])
    - elements[4] * (elements[1] * elements[10] - elements[2] * elements[9])
    + elements[8] * (elements[1] * elements[6] - elements[2] * elements[5]);
}

function vertexComponent(attribute, index, axis) {
  if (axis === 0 && attribute.getX) return attribute.getX(index);
  if (axis === 1 && attribute.getY) return attribute.getY(index);
  if (axis === 2 && attribute.getZ) return attribute.getZ(index);
  return attribute.array[index * attribute.itemSize + axis];
}

function clipDepth(vertices, distance, keepGreater) {
  const result = [];
  let previous = vertices[vertices.length - 1];
  let previousInside = keepGreater ? previous[2] >= distance : previous[2] <= distance;
  for (const current of vertices) {
    const currentInside = keepGreater ? current[2] >= distance : current[2] <= distance;
    if (currentInside !== previousInside) {
      const fraction = (distance - previous[2]) / (current[2] - previous[2]);
      result.push([
        previous[0] + (current[0] - previous[0]) * fraction,
        previous[1] + (current[1] - previous[1]) * fraction,
        distance,
        previous[3] + (current[3] - previous[3]) * fraction,
        previous[4] + (current[4] - previous[4]) * fraction,
      ]);
    }
    if (currentInside) result.push(current);
    previous = current;
    previousInside = currentInside;
  }
  return result;
}

function wrap(value, mode) {
  if (mode === REPEAT) return value - Math.floor(value);
  if (mode === MIRROR) {
    const period = Math.floor(value);
    const fraction = value - period;
    return Math.abs(period % 2) === 1 ? 1 - fraction : fraction;
  }
  return clamp(value, 0, 1);
}

export class SoftwareRenderer {
  constructor({ canvas, maxWidth = 640, maxHeight = 480, maxPixels = 220000 } = {}) {
    if (!canvas) throw new Error('SoftwareRenderer requires a canvas');
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Canvas2D is unavailable');
    this.domElement = canvas;
    this.context = context;
    this.isSoftwareRenderer = true;
    this.shadowMap = { enabled: false };
    this.info = { render: { triangles: 0, calls: 0, frame: 0 } };
    this.maxWidth = maxWidth;
    this.maxHeight = maxHeight;
    this.maxPixels = maxPixels;
    this.warnings = [];
    this.stats = { cached: false, renderMs: 0, totalTriangles: 0, width: 0, height: 0 };
    this._batches = [];
    this._textures = new Map();
    this._materials = new Map();
    this._clearColor = [231, 228, 219];
    this._signature = null;
    this._preparedScene = null;
    this._disposed = false;
    this.setSize(canvas.clientWidth || canvas.width || 640, canvas.clientHeight || canvas.height || 360, false);
  }

  setPixelRatio() { /* Internal resolution is bounded for CPU rendering. */ }
  getPixelRatio() { return 1; }

  setSize(width, height, updateStyle = true) {
    const cssWidth = Math.max(1, Number(width));
    const cssHeight = Math.max(1, Number(height));
    const scale = Math.min(1, this.maxWidth / cssWidth, this.maxHeight / cssHeight,
      Math.sqrt(this.maxPixels / (cssWidth * cssHeight)));
    const w = Math.max(1, Math.round(cssWidth * scale));
    const h = Math.max(1, Math.round(cssHeight * scale));
    if (updateStyle !== false && this.domElement.style) {
      this.domElement.style.width = `${cssWidth}px`;
      this.domElement.style.height = `${cssHeight}px`;
    }
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.domElement.width = w;
    this.domElement.height = h;
    this._image = this.context.createImageData(w, h);
    this._pixels = new Uint32Array(this._image.data.buffer);
    this._depth = new Float32Array(w * h);
    this._signature = null;
    this.stats.width = w;
    this.stats.height = h;
  }

  setClearColor(value) {
    if (value?.isColor) {
      this._clearColor = [linearToByte(value.r), linearToByte(value.g), linearToByte(value.b)];
    } else if (typeof value === 'number') {
      this._clearColor = [(value >>> 16) & 255, (value >>> 8) & 255, value & 255];
    } else if (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)) {
      const number = Number.parseInt(value.slice(1), 16);
      this._clearColor = [(number >>> 16) & 255, (number >>> 8) & 255, number & 255];
    } else if (typeof value === 'string' && /^#[0-9a-f]{3}$/i.test(value)) {
      this.setClearColor(`#${[...value.slice(1)].map((digit) => digit + digit).join('')}`);
      return;
    }
    this._signature = null;
  }

  async _captureTexture(texture) {
    if (this._textures.has(texture)) return this._textures.get(texture);
    const image = texture.image ?? texture.source?.data;
    if (!image) { this._textures.set(texture, null); return null; }
    try {
      if (typeof image.decode === 'function' && image.complete === false) await image.decode();
      const originalWidth = image.width || image.naturalWidth;
      const originalHeight = image.height || image.naturalHeight;
      if (!(originalWidth > 0 && originalHeight > 0)) throw new Error('empty image');
      const scale = Math.min(1, 1024 / Math.max(originalWidth, originalHeight));
      const width = Math.max(1, Math.round(originalWidth * scale));
      const height = Math.max(1, Math.round(originalHeight * scale));
      const surface = typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(width, height) : document.createElement('canvas');
      surface.width = width; surface.height = height;
      const context = surface.getContext('2d', { willReadFrequently: true });
      context.drawImage(image, 0, 0, width, height);
      const result = { width, height, data: context.getImageData(0, 0, width, height).data,
        wrapS: texture.wrapS, wrapT: texture.wrapT, flipY: texture.flipY === true,
        srgb: texture.colorSpace !== 'srgb-linear' };
      this._textures.set(texture, result);
      return result;
    } catch (error) {
      this.warnings.push(`Texture ${texture.name || '(unnamed)'}: ${error.message}`);
      this._textures.set(texture, null);
      return null;
    }
  }

  async _describeMaterial(material) {
    if (this._materials.has(material)) return this._materials.get(material);
    const color = material?.color ?? { r: 0.78, g: 0.78, b: 0.78 };
    const texture = material?.map ? await this._captureTexture(material.map) : null;
    if (material?.map?.matrixAutoUpdate) material.map.updateMatrix();
    const description = {
      source: material,
      color: [color.r, color.g, color.b],
      emissive: [material?.emissive?.r ?? 0, material?.emissive?.g ?? 0, material?.emissive?.b ?? 0]
        .map((value) => value * (material?.emissiveIntensity ?? 1)),
      opacity: clamp(material?.opacity ?? 1, 0, 1),
      transparent: material?.transparent === true,
      alphaTest: material?.alphaTest ?? 0,
      side: material?.side ?? FRONT,
      depthWrite: material?.depthWrite !== false,
      texture,
      textureMatrix: material?.map?.matrix?.elements ? [...material.map.matrix.elements] : [1, 0, 0, 0, 1, 0, 0, 0, 1],
      uvChannel: material?.map?.channel ?? 0,
      palettes: new Map(),
    };
    this._materials.set(material, description);
    return description;
  }

  _palette(material, shade) {
    if (material.palettes.has(shade)) return material.palettes.get(shade);
    const brightness = shade / 32;
    const multipliers = material.color.map((value) => value * brightness);
    const rgb = multipliers.map((value, channel) => linearToByte(value + material.emissive[channel]));
    const result = { solid: pack(...rgb), red: null, green: null, blue: null };
    if (material.texture) {
      const channels = [new Uint8Array(256), new Uint8Array(256), new Uint8Array(256)];
      for (let value = 0; value < 256; value += 1) {
        const linear = material.texture.srgb ? srgbToLinear(value / 255) : value / 255;
        for (let channel = 0; channel < 3; channel += 1) {
          channels[channel][value] = linearToByte(linear * multipliers[channel] + material.emissive[channel]);
        }
      }
      [result.red, result.green, result.blue] = channels;
    }
    material.palettes.set(shade, result);
    return result;
  }

  async prepare(scene) {
    if (this._disposed) throw new Error('SoftwareRenderer is disposed');
    scene.updateMatrixWorld?.(true);
    this._batches = [];
    this._textures.clear();
    this._materials.clear();
    this.warnings.length = 0;
    const meshes = [];
    scene.traverse((object) => { if (object.isMesh && object.geometry?.attributes?.position) meshes.push(object); });
    for (const mesh of meshes) {
      if (mesh.isSkinnedMesh || mesh.isInstancedMesh) {
        this.warnings.push(`Unsupported dynamic mesh in software path: ${mesh.name}`);
        continue;
      }
      const geometry = mesh.geometry;
      const position = geometry.attributes.position;
      const count = position.count;
      const matrix = mesh.matrixWorld.elements;
      const world = new Float32Array(count * 3);
      const minimum = [Infinity, Infinity, Infinity];
      const maximum = [-Infinity, -Infinity, -Infinity];
      for (let index = 0; index < count; index += 1) {
        const x = vertexComponent(position, index, 0);
        const y = vertexComponent(position, index, 1);
        const z = vertexComponent(position, index, 2);
        const values = [matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
          matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
          matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]];
        for (let axis = 0; axis < 3; axis += 1) {
          world[index * 3 + axis] = values[axis];
          minimum[axis] = Math.min(minimum[axis], values[axis]);
          maximum[axis] = Math.max(maximum[axis], values[axis]);
        }
      }
      const center = minimum.map((value, axis) => (value + maximum[axis]) * 0.5);
      const radius = Math.hypot(...maximum.map((value, axis) => (value - minimum[axis]) * 0.5));
      const indices = geometry.index?.array ?? Uint32Array.from({ length: count }, (_, index) => index);
      const materialList = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const groups = geometry.groups?.length ? geometry.groups : [{ start: 0, count: indices.length, materialIndex: 0 }];
      const flip = determinant3(matrix) < 0 ? -1 : 1;
      const shared = { world, count, center, radius, view: new Float32Array(count * 3),
        screen: new Float32Array(count * 3), codes: new Uint8Array(count), transformedFrame: -1 };
      const drawStart = geometry.drawRange?.start ?? 0;
      const drawEnd = Math.min(indices.length, drawStart + (geometry.drawRange?.count ?? Infinity));
      for (const group of groups) {
        const material = await this._describeMaterial(materialList[group.materialIndex] ?? materialList[0]);
        const start = Math.max(group.start, drawStart);
        const end = Math.min(group.start + group.count, drawEnd, indices.length);
        const faceCount = Math.floor((end - start) / 3);
        if (faceCount <= 0) continue;
        const uvAttribute = geometry.attributes[material.uvChannel === 0 ? 'uv' : `uv${material.uvChannel}`];
        const uv = new Float32Array(count * 2);
        const transform = material.textureMatrix;
        if (uvAttribute) {
          for (let vertex = 0; vertex < count; vertex += 1) {
            const u = vertexComponent(uvAttribute, vertex, 0);
            const v = vertexComponent(uvAttribute, vertex, 1);
            uv[vertex * 2] = transform[0] * u + transform[3] * v + transform[6];
            uv[vertex * 2 + 1] = transform[1] * u + transform[4] * v + transform[7];
          }
        }
        const shades = new Uint8Array(faceCount);
        for (let face = 0; face < faceCount; face += 1) {
          const a = indices[start + face * 3] * 3;
          const b = indices[start + face * 3 + 1] * 3;
          const c = indices[start + face * 3 + 2] * 3;
          const bx = world[b] - world[a], by = world[b + 1] - world[a + 1], bz = world[b + 2] - world[a + 2];
          const cx = world[c] - world[a], cy = world[c + 1] - world[a + 1], cz = world[c + 2] - world[a + 2];
          let nx = (by * cz - bz * cy) * flip;
          let ny = (bz * cx - bx * cz) * flip;
          let nz = (bx * cy - by * cx) * flip;
          const length = Math.hypot(nx, ny, nz) || 1;
          nx /= length; ny /= length; nz /= length;
          const diffuse = Math.max(0, nx * 0.36 + ny * 0.84 + nz * 0.41);
          shades[face] = Math.round((0.78 + 0.12 * Math.abs(ny) + 0.16 * diffuse) * 32);
        }
        this._batches.push({ object: mesh, shared, indices, start, faceCount, uv, material, shades, flip });
      }
    }
    this.stats.totalTriangles = this._batches.reduce((total, batch) => total + batch.faceCount, 0);
    this._preparedScene = scene;
    this._signature = null;
    return this;
  }

  _transform(shared, view, projection, near, far, frame) {
    if (shared.transformedFrame === frame) return;
    shared.transformedFrame = frame;
    const world = shared.world;
    const camera = shared.view;
    const screen = shared.screen;
    const codes = shared.codes;
    const halfWidth = this.width * 0.5, halfHeight = this.height * 0.5;
    for (let vertex = 0; vertex < shared.count; vertex += 1) {
      const offset = vertex * 3;
      const x = world[offset], y = world[offset + 1], z = world[offset + 2];
      const vx = view[0] * x + view[4] * y + view[8] * z + view[12];
      const vy = view[1] * x + view[5] * y + view[9] * z + view[13];
      const depth = -(view[2] * x + view[6] * y + view[10] * z + view[14]);
      camera[offset] = vx; camera[offset + 1] = vy; camera[offset + 2] = depth;
      const clipX = projection[0] * vx - projection[8] * depth;
      const clipY = projection[5] * vy - projection[9] * depth;
      let code = 0;
      if (clipX < -depth) code |= 1;
      if (clipX > depth) code |= 2;
      if (clipY < -depth) code |= 4;
      if (clipY > depth) code |= 8;
      if (depth < near) code |= 16;
      if (depth > far) code |= 32;
      codes[vertex] = code;
      const reciprocal = 1 / depth;
      screen[offset] = (clipX * reciprocal + 1) * halfWidth;
      screen[offset + 1] = (1 - clipY * reciprocal) * halfHeight;
      screen[offset + 2] = reciprocal;
    }
  }

  _raster(ax, ay, aq, au, av, bx, by, bq, bu, bv, cx, cy, cq, cu, cv, material, shade, flip) {
    let area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (!Number.isFinite(area) || Math.abs(area) < 0.00001) return;
    const facing = area * flip;
    if ((material.side === FRONT && facing >= 0) || (material.side === BACK && facing <= 0)) return;
    if (material.opacity <= 0 || material.source?.visible === false) return;
    if (area < 0) {
      [bx, cx] = [cx, bx]; [by, cy] = [cy, by]; [bq, cq] = [cq, bq];
      [bu, cu] = [cu, bu]; [bv, cv] = [cv, bv];
      area = -area;
    }
    const minX = Math.max(0, Math.ceil(Math.min(ax, bx, cx) - 0.5));
    const maxX = Math.min(this.width - 1, Math.floor(Math.max(ax, bx, cx) - 0.5));
    const minY = Math.max(0, Math.ceil(Math.min(ay, by, cy) - 0.5));
    const maxY = Math.min(this.height - 1, Math.floor(Math.max(ay, by, cy) - 0.5));
    if (minX > maxX || minY > maxY) return;
    this.info.render.triangles += 1;
    const inverseArea = 1 / area;
    const a0 = by - cy, b0 = cx - bx, c0 = bx * cy - by * cx;
    const a1 = cy - ay, b1 = ax - cx, c1 = cx * ay - cy * ax;
    const a2 = ay - by, b2 = bx - ax, c2 = ax * by - ay * bx;
    const x0 = minX + 0.5, y0 = minY + 0.5;
    let rowE0 = a0 * x0 + b0 * y0 + c0;
    let rowE1 = a1 * x0 + b1 * y0 + c1;
    let rowE2 = a2 * x0 + b2 * y0 + c2;
    const qX = (a0 * aq + a1 * bq + a2 * cq) * inverseArea;
    const qY = (b0 * aq + b1 * bq + b2 * cq) * inverseArea;
    let rowQ = (rowE0 * aq + rowE1 * bq + rowE2 * cq) * inverseArea;
    const palette = this._palette(material, shade);
    const texture = material.texture;
    const depthBuffer = this._depth;
    const pixels = this._pixels;
    const imageBytes = this._image.data;
    const width = this.width;
    const opacity = material.opacity;
    if (!texture) {
      const solid = palette.solid;
      for (let y = minY; y <= maxY; y += 1) {
        let e0 = rowE0, e1 = rowE1, e2 = rowE2, q = rowQ;
        let pixel = y * width + minX;
        for (let x = minX; x <= maxX; x += 1, pixel += 1) {
          if (e0 >= -0.00001 && e1 >= -0.00001 && e2 >= -0.00001 && q > depthBuffer[pixel]) {
            if (opacity >= 0.999) pixels[pixel] = solid;
            else {
              const byte = pixel * 4;
              const r = LITTLE_ENDIAN ? solid & 255 : solid >>> 24;
              const g = LITTLE_ENDIAN ? (solid >>> 8) & 255 : (solid >>> 16) & 255;
              const b = LITTLE_ENDIAN ? (solid >>> 16) & 255 : (solid >>> 8) & 255;
              imageBytes[byte] = r * opacity + imageBytes[byte] * (1 - opacity);
              imageBytes[byte + 1] = g * opacity + imageBytes[byte + 1] * (1 - opacity);
              imageBytes[byte + 2] = b * opacity + imageBytes[byte + 2] * (1 - opacity);
            }
            if (material.depthWrite) depthBuffer[pixel] = q;
          }
          e0 += a0; e1 += a1; e2 += a2; q += qX;
        }
        rowE0 += b0; rowE1 += b1; rowE2 += b2; rowQ += qY;
      }
      return;
    }
    const uX = (a0 * au * aq + a1 * bu * bq + a2 * cu * cq) * inverseArea;
    const uY = (b0 * au * aq + b1 * bu * bq + b2 * cu * cq) * inverseArea;
    const vX = (a0 * av * aq + a1 * bv * bq + a2 * cv * cq) * inverseArea;
    const vY = (b0 * av * aq + b1 * bv * bq + b2 * cv * cq) * inverseArea;
    let rowU = (rowE0 * au * aq + rowE1 * bu * bq + rowE2 * cu * cq) * inverseArea;
    let rowV = (rowE0 * av * aq + rowE1 * bv * bq + rowE2 * cv * cq) * inverseArea;
    const texels = texture.data;
    const tw = texture.width, th = texture.height;
    const lutR = palette.red, lutG = palette.green, lutB = palette.blue;
    for (let y = minY; y <= maxY; y += 1) {
      let e0 = rowE0, e1 = rowE1, e2 = rowE2, q = rowQ, uq = rowU, vq = rowV;
      let pixel = y * width + minX;
      for (let x = minX; x <= maxX; x += 1, pixel += 1) {
        if (e0 >= -0.00001 && e1 >= -0.00001 && e2 >= -0.00001 && q > depthBuffer[pixel]) {
          const u = wrap(uq / q, texture.wrapS);
          let v = wrap(vq / q, texture.wrapT);
          if (texture.flipY) v = 1 - v;
          const tx = Math.min(tw - 1, Math.max(0, Math.floor(u * tw)));
          const ty = Math.min(th - 1, Math.max(0, Math.floor(v * th)));
          const texel = (ty * tw + tx) * 4;
          const alpha = (texels[texel + 3] / 255) * opacity;
          if (alpha > 0 && alpha >= material.alphaTest) {
            const red = lutR[texels[texel]], green = lutG[texels[texel + 1]], blue = lutB[texels[texel + 2]];
            if (alpha >= 0.999) pixels[pixel] = pack(red, green, blue);
            else {
              const byte = pixel * 4;
              imageBytes[byte] = red * alpha + imageBytes[byte] * (1 - alpha);
              imageBytes[byte + 1] = green * alpha + imageBytes[byte + 1] * (1 - alpha);
              imageBytes[byte + 2] = blue * alpha + imageBytes[byte + 2] * (1 - alpha);
            }
            if (material.depthWrite) depthBuffer[pixel] = q;
          }
        }
        e0 += a0; e1 += a1; e2 += a2; q += qX; uq += uX; vq += vX;
      }
      rowE0 += b0; rowE1 += b1; rowE2 += b2; rowQ += qY; rowU += uY; rowV += vY;
    }
  }

  render(scene, camera) {
    if (this._disposed) return;
    if (scene !== this._preparedScene) {
      this._pixels.fill(pack(...this._clearColor));
      this.context.putImageData(this._image, 0, 0);
      return;
    }
    camera.updateMatrixWorld?.(true);
    const view = camera.matrixWorldInverse.elements;
    const projection = camera.projectionMatrix.elements;
    const visible = this._batches.map((batch) => visibleInHierarchy(batch.object));
    const signature = [...view, ...projection, ...visible.map(Number)];
    if (this._signature && signature.every((value, index) => Math.abs(value - this._signature[index]) < 0.00000001)) {
      this.stats.cached = true;
      return;
    }
    this.stats.cached = false;
    this._signature = signature;
    const started = performance.now();
    const background = scene.background?.isColor
      ? [linearToByte(scene.background.r), linearToByte(scene.background.g), linearToByte(scene.background.b)]
      : this._clearColor;
    this._pixels.fill(pack(...background));
    this._depth.fill(0);
    this.info.render.triangles = 0;
    this.info.render.calls = 0;
    this.info.render.frame += 1;
    const frame = this.info.render.frame;
    const near = Math.max(0.001, camera.near ?? 0.05);
    const far = camera.far ?? 1000;
    const halfWidth = this.width * 0.5, halfHeight = this.height * 0.5;
    const active = [];
    for (let index = 0; index < this._batches.length; index += 1) {
      if (!visible[index]) continue;
      const batch = this._batches[index];
      const { center, radius } = batch.shared;
      const [x, y, z] = center;
      const vx = view[0] * x + view[4] * y + view[8] * z + view[12];
      const vy = view[1] * x + view[5] * y + view[9] * z + view[13];
      const vd = -(view[2] * x + view[6] * y + view[10] * z + view[14]);
      if (vd + radius < near || vd - radius > far) continue;
      const tx = 1 / projection[0], ty = 1 / projection[5];
      if (Math.abs(vx - projection[8] * vd / projection[0]) > vd * tx + radius * Math.sqrt(1 + tx * tx)) continue;
      if (Math.abs(vy - projection[9] * vd / projection[5]) > vd * ty + radius * Math.sqrt(1 + ty * ty)) continue;
      active.push({ batch, distance: vd });
    }
    // Opaque objects front-to-back improve depth rejection. Basic transparent
    // materials follow back-to-front; this is not order-independent transparency.
    active.sort((a, b) => {
      const ta = a.batch.material.transparent || a.batch.material.opacity < 1;
      const tb = b.batch.material.transparent || b.batch.material.opacity < 1;
      if (ta !== tb) return ta ? 1 : -1;
      return ta ? b.distance - a.distance : a.distance - b.distance;
    });
    for (const { batch } of active) {
      this.info.render.calls += 1;
      this._transform(batch.shared, view, projection, near, far, frame);
      const { indices, uv, material, shades, flip, start, faceCount } = batch;
      const screen = batch.shared.screen;
      const codes = batch.shared.codes;
      const positions = batch.shared.view;
      for (let face = 0; face < faceCount; face += 1) {
        const offset = start + face * 3;
        const a = indices[offset], b = indices[offset + 1], c = indices[offset + 2];
        if (codes[a] & codes[b] & codes[c]) continue;
        const ai = a * 3, bi = b * 3, ci = c * 3;
        if (((codes[a] | codes[b] | codes[c]) & 48) === 0) {
          this._raster(screen[ai], screen[ai + 1], screen[ai + 2], uv[a * 2], uv[a * 2 + 1],
            screen[bi], screen[bi + 1], screen[bi + 2], uv[b * 2], uv[b * 2 + 1],
            screen[ci], screen[ci + 1], screen[ci + 2], uv[c * 2], uv[c * 2 + 1], material, shades[face], flip);
          continue;
        }
        let polygon = [a, b, c].map((vertex) => [positions[vertex * 3], positions[vertex * 3 + 1], positions[vertex * 3 + 2], uv[vertex * 2], uv[vertex * 2 + 1]]);
        polygon = clipDepth(polygon, near, true);
        if (polygon.length < 3) continue;
        polygon = clipDepth(polygon, far, false);
        if (polygon.length < 3) continue;
        const projected = polygon.map(([x, y, d, u, v]) => [
          (projection[0] * x / d - projection[8] + 1) * halfWidth,
          (1 - projection[5] * y / d + projection[9]) * halfHeight, 1 / d, u, v,
        ]);
        for (let triangle = 1; triangle < projected.length - 1; triangle += 1) {
          this._raster(...projected[0], ...projected[triangle], ...projected[triangle + 1], material, shades[face], flip);
        }
      }
    }
    this.context.putImageData(this._image, 0, 0);
    this.stats.renderMs = performance.now() - started;
  }

  dispose() {
    this._disposed = true;
    this._batches.length = 0;
    this._textures.clear();
    this._materials.clear();
    this._image = null;
    this._pixels = null;
    this._depth = null;
    this._preparedScene = null;
  }
}

export default SoftwareRenderer;
