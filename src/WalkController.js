/**
 * Flat-floor first-person controller for a THREE.PerspectiveCamera.
 * No browser globals are touched until construction; no third-party dependency.
 *
 * new WalkController(camera, canvas, {
 *   canOccupy: (x, z) => boolean, // already includes the player's body radius
 *   moveXZ?: (x, z, dx, dz) => [nextX, nextZ], // optional swept/sliding solver
 *   spawn: { x, y, z, yaw?: 0, pitch?: 0 }, // Three.js world coordinates, radians
 *   onStateChange?: ({ reason, active, hasPointerLock, dragging,
 *                      pointerLockError? }) => void,
 *   speed?: 1.6, pointerSensitivity?: 0.0024, dragSensitivity?: 0.0043
 * })
 *
 * Starts disabled, but puts the camera at spawn. yaw=0 faces -Z; positive pitch
 * looks up. A disabled controller never writes the camera during update, so
 * OrbitControls can own it. Enabling restores the last valid walking position.
 *
 * Methods: update(dt), setEnabled(bool), setMoveInput(x,y), setLook(yaw,pitch),
 *          setSpawn(spawn, reset=true), teleport(spawn), reset(),
 *          requestPointerLock(): Promise<boolean>, clearInput(), dispose().
 * x>0 in setMoveInput means right, y>0 means forward. Inputs are normalized.
 * teleport/setSpawn return false when the requested position is not walkable.
 * Getters: yaw, pitch, position (read-only {x,y,z} snapshot), active,
 *          hasPointerLock, dragging. speed is a configurable public number.
 *
 * Pointer lock is requested ONLY through requestPointerLock(), never implicitly.
 * Dragging on the canvas works without pointer lock, including one-finger touch.
 * Overlay buttons and a separately implemented joystick are not intercepted.
 * An optional moveXZ must handle swept motion/substeps itself. The controller
 * validates its final point and rejects movement longer than the requested step.
 */

const MOVE_CODES = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD',
  'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight',
]);
const PITCH_LIMIT = Math.PI * 80 / 180;
const MAX_DELTA = 0.05;
const MAX_SUBSTEP = 0.035;
const VELOCITY_RESPONSE = 14;
const VELOCITY_EPSILON = 0.00001;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const wrapAngle = (angle) => Math.atan2(Math.sin(angle), Math.cos(angle));

function normalizeSpawn(value) {
  if (!value || !['x', 'y', 'z'].every((key) => Number.isFinite(value[key]))) {
    throw new TypeError('A spawn with finite x, y and z is required.');
  }
  const yaw = value.yaw ?? 0;
  const pitch = value.pitch ?? 0;
  if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) {
    throw new TypeError('Spawn yaw and pitch must be finite radians.');
  }
  return {
    x: value.x, y: value.y, z: value.z,
    yaw: wrapAngle(yaw), pitch: clamp(pitch, -PITCH_LIMIT, PITCH_LIMIT),
  };
}

function elementFromTarget(target) {
  return target?.nodeType === 3 ? target.parentElement : target;
}

function isEditable(target) {
  const element = elementFromTarget(target);
  if (!element) return false;
  if (element.isContentEditable) return true;
  return Boolean(element.closest?.(
    'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]',
  ));
}

function isUiTarget(target) {
  const element = elementFromTarget(target);
  return isEditable(element) || Boolean(element?.closest?.(
    'button, a, [role="button"], [data-walk-ignore], [data-joystick]',
  ));
}

export class WalkController {
  constructor(camera, domElement, options = {}) {
    if (!camera?.position || !camera?.rotation || !domElement?.addEventListener) {
      throw new TypeError('WalkController needs a Three.js camera and a canvas element.');
    }
    if (typeof options.canOccupy !== 'function') {
      throw new TypeError('WalkController requires canOccupy(x, z).');
    }

    this.camera = camera;
    this.domElement = domElement;
    this.document = domElement.ownerDocument;
    this.window = this.document?.defaultView;
    if (!this.document?.addEventListener || !this.window?.addEventListener) {
      throw new TypeError('The canvas must belong to a browser document.');
    }

    this.speed = options.speed ?? 1.6;
    this.pointerSensitivity = options.pointerSensitivity ?? 0.0024;
    this.dragSensitivity = options.dragSensitivity ?? 0.0043;
    this._canOccupy = options.canOccupy;
    if (options.moveXZ !== undefined && typeof options.moveXZ !== 'function') {
      throw new TypeError('moveXZ must be a function when supplied.');
    }
    this._moveXZ = options.moveXZ ?? null;
    this._onStateChange = options.onStateChange;
    this._active = false;
    this._disposed = false;
    this._keys = new Set();
    this._moveInput = { x: 0, y: 0 };
    this._velocity = { x: 0, z: 0 };
    this._drag = null;
    this._pendingPointerLock = null;
    this._originalTouchAction = domElement.style?.touchAction ?? '';
    this._spawn = normalizeSpawn(options.spawn);
    this._position = { x: this._spawn.x, y: this._spawn.y, z: this._spawn.z };
    this._yaw = this._spawn.yaw;
    this._pitch = this._spawn.pitch;
    this._collisionErrorReported = false;
    this._moveErrorReported = false;

    if (!this._allowed(this._position.x, this._position.z)) {
      throw new RangeError('The supplied walking spawn is outside the navigable floor.');
    }
    this._applyCamera();

    this._onKeyDown = (event) => {
      if (!this._active || this._disposed || !MOVE_CODES.has(event.code)) return;
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      if (isEditable(event.target) || isEditable(this.document.activeElement)) return;
      this._keys.add(event.code);
      event.preventDefault();
    };
    this._onKeyUp = (event) => {
      // Always clear releases: a modifier/focus change must not leave a key stuck.
      this._keys.delete(event.code);
      if (this._active && MOVE_CODES.has(event.code) &&
          !event.ctrlKey && !event.altKey && !event.metaKey &&
          !isEditable(event.target) && !isEditable(this.document.activeElement)) {
        event.preventDefault();
      }
    };
    this._onBlur = () => {
      if (this._disposed) return;
      this.clearInput();
      this._endDrag();
      this._emit('blur');
    };
    this._onVisibilityChange = () => {
      if (this.document.visibilityState === 'hidden') this._onBlur();
    };

    this._onPointerDown = (event) => {
      if (!this._active || this._disposed || this.hasPointerLock || this._drag) return;
      if (isUiTarget(event.target)) return;
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
      this._drag = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        pointerType: event.pointerType,
      };
      try { this.domElement.setPointerCapture?.(event.pointerId); } catch (_) { /* Optional API. */ }
      try { this.domElement.focus?.({ preventScroll: true }); } catch (_) { /* Older WebKit. */ }
      event.preventDefault();
      this._emit('dragstart');
    };
    this._onPointerMove = (event) => {
      if (!this._active || this._disposed || this.hasPointerLock || !this._drag) return;
      if (event.pointerId !== this._drag.id) return;
      if (this._drag.pointerType === 'mouse' && event.buttons === 0) {
        this._endDrag();
        return;
      }
      if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
      const dx = event.clientX - this._drag.x;
      const dy = event.clientY - this._drag.y;
      this._drag.x = event.clientX;
      this._drag.y = event.clientY;
      this._rotateByPixels(dx, dy, this.dragSensitivity);
      event.preventDefault();
    };
    this._onPointerUp = (event) => {
      if (this._drag?.id === event.pointerId) this._endDrag();
    };
    this._onLostPointerCapture = (event) => {
      if (this._drag?.id === event.pointerId) this._endDrag(false);
    };
    this._onMouseMove = (event) => {
      if (!this._active || this._disposed || !this.hasPointerLock) return;
      if (this.document.visibilityState === 'hidden') return;
      this._rotateByPixels(event.movementX ?? 0, event.movementY ?? 0, this.pointerSensitivity);
    };
    this._onPointerLockChange = () => {
      if (this._disposed) return;
      this._endDrag();
      this.clearInput();
      // A pending request may resolve after the user has switched to orbit.
      if (this.hasPointerLock && !this._active) {
        this._exitOwnPointerLock();
        return;
      }
      this._emit(this.hasPointerLock ? 'pointerlock' : 'pointerunlock');
    };
    this._onPointerLockError = () => {
      if (!this._disposed) this._emit('pointerlockerror', 'Захват указателя недоступен. Можно поворачивать вид перетаскиванием.');
    };

    this.document.addEventListener('keydown', this._onKeyDown);
    this.document.addEventListener('keyup', this._onKeyUp);
    this.window.addEventListener('blur', this._onBlur);
    this.document.addEventListener('visibilitychange', this._onVisibilityChange);
    this.domElement.addEventListener('pointerdown', this._onPointerDown, { passive: false });
    this.document.addEventListener('pointermove', this._onPointerMove, { passive: false });
    this.document.addEventListener('pointerup', this._onPointerUp);
    this.document.addEventListener('pointercancel', this._onPointerUp);
    this.domElement.addEventListener('lostpointercapture', this._onLostPointerCapture);
    this.document.addEventListener('mousemove', this._onMouseMove);
    this.document.addEventListener('pointerlockchange', this._onPointerLockChange);
    this.document.addEventListener('pointerlockerror', this._onPointerLockError);
  }

  get active() { return this._active; }
  get yaw() { return this._yaw; }
  get pitch() { return this._pitch; }
  get position() { return { ...this._position }; }
  get hasPointerLock() { return this.document.pointerLockElement === this.domElement; }
  get dragging() { return this._drag !== null; }

  _emit(reason, pointerLockError) {
    this._onStateChange?.({
      reason, active: this._active, hasPointerLock: this.hasPointerLock,
      dragging: this.dragging,
      ...(pointerLockError ? { pointerLockError } : {}),
    });
  }

  _allowed(x, z) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
    try {
      // Async callbacks are not accepted: a Promise must never permit movement.
      return this._canOccupy(x, z) === true;
    } catch (error) {
      if (!this._collisionErrorReported) {
        this._collisionErrorReported = true;
        console.error('Walk navigation callback failed; movement is blocked.', error);
      }
      return false;
    }
  }

  _applyCamera() {
    const { x, y, z } = this._position;
    this.camera.position.set(x, y, z);
    this.camera.rotation.set(this._pitch, this._yaw, 0, 'YXZ');
  }

  _rotateByPixels(dx, dy, sensitivity) {
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(sensitivity)) return;
    this.setLook(this._yaw - dx * sensitivity, this._pitch - dy * sensitivity);
  }

  _endDrag(releaseCapture = true) {
    if (!this._drag) return;
    const id = this._drag.id;
    this._drag = null;
    if (releaseCapture) {
      try {
        if (this.domElement.hasPointerCapture?.(id)) this.domElement.releasePointerCapture(id);
      } catch (_) { /* The browser may already have released the pointer. */ }
    }
    this._emit('dragend');
  }

  _exitOwnPointerLock() {
    if (!this.hasPointerLock) return;
    try {
      const result = this.document.exitPointerLock?.();
      result?.catch?.(() => {});
    } catch (_) { /* Browser errors must not prevent switching to orbit. */ }
  }

  clearInput() {
    this._keys.clear();
    this._moveInput.x = this._moveInput.y = 0;
    this._velocity.x = this._velocity.z = 0;
  }

  setEnabled(enabled) {
    if (this._disposed) return;
    const next = Boolean(enabled);
    if (next === this._active) return;
    this.clearInput();
    this._endDrag();
    this._active = next;
    if (this.domElement.style) {
      this.domElement.style.touchAction = next ? 'none' : this._originalTouchAction;
    }
    if (next) {
      // Orbit may have changed the camera; restore the last safe walk state.
      if (!this._allowed(this._position.x, this._position.z)) this.reset();
      this._applyCamera();
    } else {
      this._pendingPointerLock?.cancel();
      this._exitOwnPointerLock();
    }
    this._emit(next ? 'enabled' : 'disabled');
  }

  setMoveInput(x, y) {
    if (!this._active || this._disposed) {
      this._moveInput.x = this._moveInput.y = 0;
      return;
    }
    x = Number.isFinite(x) ? clamp(x, -1, 1) : 0;
    y = Number.isFinite(y) ? clamp(y, -1, 1) : 0;
    const length = Math.hypot(x, y);
    this._moveInput.x = length > 1 ? x / length : x;
    this._moveInput.y = length > 1 ? y / length : y;
  }

  setLook(yaw, pitch = this._pitch) {
    if (this._disposed || !Number.isFinite(yaw) || !Number.isFinite(pitch)) return;
    this._yaw = wrapAngle(yaw);
    this._pitch = clamp(pitch, -PITCH_LIMIT, PITCH_LIMIT);
    this.camera.rotation.set(this._pitch, this._yaw, 0, 'YXZ');
  }

  teleport(spawn) {
    if (this._disposed) return false;
    const next = normalizeSpawn(spawn);
    if (!this._allowed(next.x, next.z)) {
      this._emit('teleportblocked');
      return false;
    }
    this.clearInput();
    this._endDrag();
    this._position = { x: next.x, y: next.y, z: next.z };
    this._yaw = next.yaw;
    this._pitch = next.pitch;
    this._applyCamera();
    this._emit('teleport');
    return true;
  }

  setSpawn(spawn, reset = true) {
    const next = normalizeSpawn(spawn);
    if (!this._allowed(next.x, next.z) || this._disposed) return false;
    this._spawn = next;
    return reset ? this.teleport(next) : true;
  }

  reset() {
    return this.teleport(this._spawn);
  }

  async requestPointerLock() {
    if (this._disposed || !this._active) return false;
    if (this.hasPointerLock) return true;
    if (this._pendingPointerLock) return this._pendingPointerLock.promise;
    if (typeof this.domElement.requestPointerLock !== 'function') {
      this._emit('pointerlockunavailable', 'Можно поворачивать вид перетаскиванием.');
      return false;
    }

    this._endDrag();
    let finish;
    const promise = new Promise((resolve) => {
      let settled = false;
      let timer;
      const changed = () => finish(this.hasPointerLock && this._active);
      const failed = () => finish(false);
      finish = (value) => {
        if (settled) return;
        settled = true;
        this.document.removeEventListener('pointerlockchange', changed);
        this.document.removeEventListener('pointerlockerror', failed);
        if (timer !== undefined) this.window.clearTimeout(timer);
        this._pendingPointerLock = null;
        resolve(Boolean(value));
      };
      this.document.addEventListener('pointerlockchange', changed);
      this.document.addEventListener('pointerlockerror', failed);
      timer = this.window.setTimeout(() => {
        const acquired = this.hasPointerLock && this._active;
        if (!acquired && !this._disposed) this._emit('pointerlocktimeout', 'Захват указателя не включён. Можно перетаскивать вид.');
        finish(acquired);
      }, 2000);
    });
    this._pendingPointerLock = { promise, cancel: () => finish(false) };
    try {
      // Deliberately no unadjustedMovement: it unnecessarily excludes browsers.
      const result = this.domElement.requestPointerLock();
      if (result?.then) {
        result.then(() => {
          if (this.hasPointerLock) finish(this._active);
        }, (error) => {
          if (!this._disposed) this._emit('pointerlockdenied', error?.message || 'Захват указателя отклонён. Можно перетаскивать вид.');
          finish(false);
        });
      } else if (this.hasPointerLock) {
        finish(true);
      }
    } catch (error) {
      this._emit('pointerlockdenied', error?.message || 'Захват указателя недоступен. Можно перетаскивать вид.');
      finish(false);
    }
    return promise;
  }

  update(deltaTime) {
    if (!this._active || this._disposed) return;
    if (this.document.visibilityState === 'hidden') {
      this.clearInput();
      return;
    }
    if (!Number.isFinite(deltaTime) || deltaTime <= 0) return;
    const dt = Math.min(deltaTime, MAX_DELTA);
    const key = (primary, secondary) => this._keys.has(primary) || this._keys.has(secondary) ? 1 : 0;
    let right = key('KeyD', 'ArrowRight') - key('KeyA', 'ArrowLeft') + this._moveInput.x;
    let forward = key('KeyW', 'ArrowUp') - key('KeyS', 'ArrowDown') + this._moveInput.y;
    const inputLength = Math.hypot(right, forward);
    if (inputLength > 1) {
      right /= inputLength;
      forward /= inputLength;
    }
    const speed = Number.isFinite(this.speed) ? clamp(this.speed, 0.1, 5) : 1.6;
    const sin = Math.sin(this._yaw);
    const cos = Math.cos(this._yaw);
    const targetX = (right * cos - forward * sin) * speed;
    const targetZ = (-right * sin - forward * cos) * speed;
    const blend = 1 - Math.exp(-VELOCITY_RESPONSE * dt);
    this._velocity.x += (targetX - this._velocity.x) * blend;
    this._velocity.z += (targetZ - this._velocity.z) * blend;
    if (Math.abs(this._velocity.x) < VELOCITY_EPSILON) this._velocity.x = 0;
    if (Math.abs(this._velocity.z) < VELOCITY_EPSILON) this._velocity.z = 0;

    const dx = this._velocity.x * dt;
    const dz = this._velocity.z * dt;
    if (this._moveXZ) {
      const { x, z } = this._position;
      let next = null;
      try {
        if (dx || dz) next = this._moveXZ(x, z, dx, dz);
      } catch (error) {
        if (!this._moveErrorReported) {
          this._moveErrorReported = true;
          console.error('Walk motion resolver failed; movement is blocked.', error);
        }
      }
      if (next && Number.isFinite(next[0]) && Number.isFinite(next[1]) &&
          this._allowed(next[0], next[1]) &&
          Math.hypot(next[0] - x, next[1] - z) <= Math.hypot(dx, dz) + 0.000001) {
        this._position.x = next[0];
        this._position.z = next[1];
        // Keep the tangential component that actually moved, not velocity into a wall.
        this._velocity.x = (next[0] - x) / dt;
        this._velocity.z = (next[1] - z) / dt;
      } else if (dx || dz) {
        this._velocity.x = this._velocity.z = 0;
      }
      this._applyCamera();
      return;
    }
    const count = Math.max(1, Math.ceil(Math.hypot(dx, dz) / MAX_SUBSTEP));
    const stepX = dx / count;
    const stepZ = dz / count;
    for (let index = 0; index < count; index += 1) {
      const { x, z } = this._position;
      if (this._allowed(x + stepX, z + stepZ)) {
        this._position.x += stepX;
        this._position.z += stepZ;
        continue;
      }

      // Component-wise sliding keeps diagonal input moving along a solid wall.
      // Test each move from the newly reached position, never from a stale one.
      const axes = Math.abs(stepX) >= Math.abs(stepZ) ? ['x', 'z'] : ['z', 'x'];
      for (const axis of axes) {
        const step = axis === 'x' ? stepX : stepZ;
        if (!step) continue;
        const nextX = this._position.x + (axis === 'x' ? step : 0);
        const nextZ = this._position.z + (axis === 'z' ? step : 0);
        if (this._allowed(nextX, nextZ)) {
          this._position[axis] += step;
        } else {
          this._velocity[axis] = 0;
        }
      }
    }
    this._applyCamera();
  }

  dispose() {
    if (this._disposed) return;
    this.setEnabled(false);
    this._pendingPointerLock?.cancel();
    this._disposed = true;
    this.document.removeEventListener('keydown', this._onKeyDown);
    this.document.removeEventListener('keyup', this._onKeyUp);
    this.window.removeEventListener('blur', this._onBlur);
    this.document.removeEventListener('visibilitychange', this._onVisibilityChange);
    this.domElement.removeEventListener('pointerdown', this._onPointerDown);
    this.document.removeEventListener('pointermove', this._onPointerMove);
    this.document.removeEventListener('pointerup', this._onPointerUp);
    this.document.removeEventListener('pointercancel', this._onPointerUp);
    this.domElement.removeEventListener('lostpointercapture', this._onLostPointerCapture);
    this.document.removeEventListener('mousemove', this._onMouseMove);
    this.document.removeEventListener('pointerlockchange', this._onPointerLockChange);
    this.document.removeEventListener('pointerlockerror', this._onPointerLockError);
    if (this.domElement.style) this.domElement.style.touchAction = this._originalTouchAction;
  }
}

export default WalkController;
