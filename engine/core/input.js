// Keyboard + mouse input. Mouse look uses pointer lock (click the canvas).
export class Input {
  constructor(element) {
    this.element = element;
    this.keys = new Set();
    this.pressed = new Set();
    this.mouseDelta = [0, 0];
    this.wheel = 0;
    const key = (e) => e.code;
    this.handlers = {
      keydown: (e) => { if (!this.keys.has(key(e))) this.pressed.add(key(e)); this.keys.add(key(e)); if (e.code === 'Space') e.preventDefault(); },
      keyup: (e) => this.keys.delete(key(e)),
      blur: () => this.keys.clear(),
      mousemove: (e) => {
        if (document.pointerLockElement !== element && !(e.buttons & 1)) return;
        this.mouseDelta[0] += e.movementX; this.mouseDelta[1] += e.movementY;
      },
      wheel: (e) => { this.wheel += Math.sign(e.deltaY); },
      click: () => element.requestPointerLock?.()?.catch?.(() => {}),
    };
    addEventListener('keydown', this.handlers.keydown);
    addEventListener('keyup', this.handlers.keyup);
    addEventListener('blur', this.handlers.blur);
    addEventListener('mousemove', this.handlers.mousemove);
    element.addEventListener('wheel', this.handlers.wheel, { passive: true });
    element.addEventListener('click', this.handlers.click);
  }

  down(code) { return this.keys.has(code); }
  /** True only on the frame the key went down. */
  justPressed(code) { return this.pressed.has(code); }

  /** WASD / arrow axes: x = strafe right, y = forward. */
  moveAxis() {
    const k = (a, b) => (this.down(a) || this.down(b) ? 1 : 0);
    return [k('KeyD', 'ArrowRight') - k('KeyA', 'ArrowLeft'), k('KeyW', 'ArrowUp') - k('KeyS', 'ArrowDown')];
  }

  /** Call at the end of every rendered frame. */
  endFrame() { this.pressed.clear(); this.mouseDelta = [0, 0]; this.wheel = 0; }
}
