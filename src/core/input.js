// 输入：键盘 / 鼠标（指针锁定）/ 触摸（虚拟摇杆与按钮）
// 统一输入层：所有设备最终折算成同一份 state，地面与太空共用同一套映射。
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
    this.touch = {
      move: { x: 0, y: 0 },
      look: { dx: 0, dy: 0 },
      active: false,
      fire: false,
      aim: false,
      sprint: false,
      jump: false,
      throttle: 0, // 太空：持续加减速 -1 / 0 / +1
      warp: false, // 太空：曲率引擎
      land: false, // 太空：请求降落
    };
    this.hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    // BUG-10：按“最近一次真实使用的指针类型”决定是否锁定，
    // 而不是“设备具备触摸能力”就全局禁用鼠标视角。
    this.pointer = this.hasTouch ? 'touch' : 'mouse';
    this.resetHooks = [];
    this._bind();
  }

  _bind() {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      const k = e.code;
      // BUG-13：暂停/菜单期间不再累积瞬时按键，避免恢复时补执行
      if (this.enabled) {
        this.justPressed.add(k);
        this.pressed.add(k);
      }
      this.keys.add(k);
      if (['Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Tab'].includes(k)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    // BUG-12：失焦必须清理全部输入状态（鼠标位移、瞬时按键、持续按钮）
    window.addEventListener('blur', () => this.reset());
    this.canvas.addEventListener('mousedown', (e) => {
      this.pointer = 'mouse';
      if (e.button === 0) this.buttons.fire = true;
      if (e.button === 2) this.buttons.aim = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.buttons.fire = false;
      if (e.button === 2) this.buttons.aim = false;
    });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mousemove', (e) => {
      if (e.movementX || e.movementY) this.pointer = 'mouse';
      if (!this.locked) return;
      this.mouseDX += e.movementX || 0;
      this.mouseDY += e.movementY || 0;
    });
    window.addEventListener('wheel', (e) => { this.wheel += Math.sign(e.deltaY); }, { passive: true });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      // BUG-12：失锁时同样清掉鼠标位移与持续按钮，防止切回后突然转头或持续开火
      if (!this.locked) {
        this.mouseDX = this.mouseDY = 0;
        this.buttons.fire = false;
        this.buttons.aim = false;
      }
    });
    // ---- 触摸：画面右侧滑动 = 视角，左侧摇杆 = 移动 ----
    // BUG-06：观察手势直接挂在 canvas 上，虚拟层不再铺满屏幕拦截 HUD 控件。
    const el = this.canvas;
    if (el) {
      let lookId = null, lookX = 0, lookY = 0;
      el.addEventListener('touchstart', (e) => {
        this.pointer = 'touch';
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
      // BUG-11：touchcancel 与 touchend 一视同仁，系统手势打断时也要松开
      el.addEventListener('touchend', end);
      el.addEventListener('touchcancel', end);
    }
  }

  // 统一复位：失焦、失锁、暂停、模式切换、触摸中断都走这里
  reset() {
    this.keys.clear();
    this.justPressed.clear();
    this.pressed.clear();
    this.mouseDX = this.mouseDY = 0;
    this.wheel = 0;
    for (const k of Object.keys(this.buttons)) this.buttons[k] = false;
    this.touch.fire = false;
    this.touch.aim = false;
    this.touch.sprint = false;
    this.touch.jump = false;
    this.touch.throttle = 0;
    this.touch.warp = false;
    this.touch.land = false;
    this.touch.look.dx = this.touch.look.dy = 0;
    this.touch.move.x = this.touch.move.y = 0;
    this.touch.active = false;
    for (const fn of this.resetHooks) { try { fn(); } catch {} }
  }

  requestLock() {
    // BUG-10：仅当最近一次交互来自触摸时才跳过锁定；
    // 带触屏的电脑用鼠标点击时仍可获得指针锁定。
    if (this.pointer === 'touch') return;
    // 浏览器可能拒绝没有用户手势的自动锁定（例如出舱），也可能异步返回拒绝。
    // 保持游戏可用，下一次点击画面时由正常输入流程重试。
    try { this.canvas.requestPointerLock?.()?.catch?.(() => {}); } catch {}
  }

  releaseLock() {
    try { if (document.pointerLockElement) document.exitPointerLock(); } catch {}
  }

  // 每帧读取一次
  consume() {
    const k = this.keys;
    const kd = (c) => (k.has(c) ? 1 : 0);
    const tm = this.touch.move;
    let forward = kd('KeyW') + kd('ArrowUp') - kd('KeyS') - kd('ArrowDown');
    let strafe = kd('KeyD') + kd('ArrowRight') - kd('KeyA') - kd('ArrowLeft');
    // BUG-08：摇杆在统一输入层换算成 forward/strafe，
    // 地面与太空都读同一份结果，不再是只有地表会看 touch.move。
    const touchActive = Math.abs(tm.x) > 0.08 || Math.abs(tm.y) > 0.08;
    if (touchActive) {
      forward = -tm.y;
      strafe = tm.x;
    }
    this.touch.active = touchActive;
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
      // BUG-38：降落使用独立命令（F / 触屏降落键），不再复用通用 interact
      land: this.justPressed.has('KeyF') || this.touch.land,
      // 太空油门与曲率（键盘持续键 + 触屏持续按钮）
      throttle: (k.has('KeyE') ? 1 : 0) - (k.has('KeyC') ? 1 : 0) + (this.touch.throttle || 0),
      warp: k.has('ShiftLeft') || k.has('ShiftRight') || this.touch.warp,
      touchActive,
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
    this.touch.land = false;
    this.touch.look.dx = this.touch.look.dy = 0;
    return state;
  }
}
