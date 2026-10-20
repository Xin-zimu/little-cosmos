// 输入：键盘 / 鼠标（指针锁定）/ 触摸（虚拟摇杆与按钮）
export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.pressed = new Set();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
    this.locked = false;
    this.buttons = { fire: false, aim: false, jump: false, sprint: false, build: false, interact: false };
    this.justPressed = new Set();
    this.enabled = true;
    this.touch = { move: { x: 0, y: 0 }, look: { dx: 0, dy: 0 }, active: false, fire: false, sprint: false, jump: false, aim: false };
    this.isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    this._bind();
  }

  _bind() {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      const k = e.code;
      this.keys.add(k);
      this.justPressed.add(k);
      this.pressed.add(k);
      if (['Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Tab'].includes(k)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => { this.keys.clear(); this.buttons.fire = false; });
    this.canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0) this.buttons.fire = true;
      if (e.button === 2) this.buttons.aim = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.buttons.fire = false;
      if (e.button === 2) this.buttons.aim = false;
    });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX || 0;
      this.mouseDY += e.movementY || 0;
    });
    window.addEventListener('wheel', (e) => { this.wheel += Math.sign(e.deltaY); }, { passive: true });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
    });
    // ---- 触摸：画面右侧滑动 = 视角，左侧摇杆 = 移动 ----
    const el = document.getElementById('touch-layer');
    if (el) {
      let lookId = null, lookX = 0, lookY = 0;
      el.addEventListener('touchstart', (e) => {
        for (const t of e.changedTouches) {
          if (t.clientX > window.innerWidth * 0.42 && lookId === null) {
            lookId = t.identifier; lookX = t.clientX; lookY = t.clientY;
          }
        }
      }, { passive: true });
      el.addEventListener('touchmove', (e) => {
        for (const t of e.changedTouches) {
          if (t.identifier === lookId) {
            this.touch.look.dx += t.clientX - lookX;
            this.touch.look.dy += t.clientY - lookY;
            lookX = t.clientX; lookY = t.clientY;
          }
        }
        e.preventDefault();
      }, { passive: false });
      const end = (e) => {
        for (const t of e.changedTouches) if (t.identifier === lookId) lookId = null;
      };
      el.addEventListener('touchend', end);
      el.addEventListener('touchcancel', end);
    }
  }

  requestLock() {
    if (this.isTouch) return;
    try { this.canvas.requestPointerLock?.(); } catch {}
  }

  releaseLock() {
    try { if (document.pointerLockElement) document.exitPointerLock(); } catch {}
  }

  // 每帧读取一次
  consume() {
    const k = this.keys;
    const kd = (c) => (k.has(c) ? 1 : 0);
    const forward = kd('KeyW') + kd('ArrowUp') - kd('KeyS') - kd('ArrowDown');
    const strafe = kd('KeyD') + kd('ArrowRight') - kd('KeyA') - kd('ArrowLeft');
    const state = {
      forward,
      strafe,
      jump: this.justPressed.has('Space') || this.touch.jump,
      sprint: k.has('ShiftLeft') || k.has('ShiftRight') || this.touch.sprint,
      fire: this.buttons.fire || this.touch.fire,
      aim: this.buttons.aim || k.has('KeyF') || this.touch.aim,
      interact: this.justPressed.has('KeyE') || this.justPressed.has('Enter'),
      build: this.justPressed.has('KeyB'),
      reload: this.justPressed.has('KeyR'),
      mode: this.justPressed.has('KeyQ'),
      map: this.justPressed.has('KeyM') || this.justPressed.has('Tab'),
      scan: this.justPressed.has('KeyV'),
      pause: this.justPressed.has('Escape'),
      mouseDX: this.mouseDX + this.touch.look.dx * 1.6,
      mouseDY: this.mouseDY + this.touch.look.dy * 1.6,
      wheel: this.wheel,
      // 注意：必须拷贝一份，否则下方的 clear() 会把这一帧读到的按键清空
      keys: new Set(this.justPressed),
      held: this.keys,
    };
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
    this.justPressed.clear();
    this.touch.jump = false;
    this.touch.look.dx = this.touch.look.dy = 0;
    return state;
  }
}
