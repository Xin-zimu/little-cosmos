// UI 控制器：HUD 更新、小地图、建造条、飞行阶段提示、任务与对话
import * as THREE from 'three';
import { BUILDINGS, BUILD_ORDER } from '../base/building.js';
import { PLANET_INFO } from '../world/themes.js';

const $ = (id) => document.getElementById(id);

// BUG-10：未扫描时仍然显示的小地图标记半径（米）
const SCAN_NEAR_RADIUS = 28;

export class UI {
  constructor(game) {
    this.game = game;
    this.el = {
      hud: $('hud'), menu: $('menu'), pause: $('pause'), loading: $('loading'),
      pcCode: $('pc-code'), pcName: $('pc-name'), pcLatin: $('pc-latin'), pcSub: $('pc-sub'),
      objText: $('obj-text'), objBar: $('obj-bar'), objCount: $('obj-count'),
      hpBar: $('hp-bar'), shBar: $('sh-bar'), enBar: $('en-bar'),
      hpVal: $('hp-val'), shVal: $('sh-val'), enVal: $('en-val'),
      wpMode: $('wp-mode'), wpFill: $('wp-fill'),
      prompt: $('prompt'), promptText: $('prompt-text'), toasts: $('toasts'),
      dialogue: $('dialogue'), dlgSpeaker: $('dlg-speaker'), dlgText: $('dlg-text'),
      buildBar: $('build-bar'), cockpit: $('cockpit'), cpTarget: $('cp-target'), cpThrust: $('cp-thrust'),
      spaceHud: $('space-hud'), srSpeed: $('sr-speed'), srThr: $('sr-thr'), srFuel: $('sr-fuel'), srHull: $('sr-hull'),
      navList: $('nav-list'), cpTargetX: null,
      planetMarker: $('planet-marker'), crosshairSpace: $('crosshair-space'),
      fade: $('fade-overlay'), atmos: $('atmos-overlay'), loadingFill: $('ld-fill'), loadingTip: $('ld-tip'),
      mm: $('minimap'), mmLabel: $('mm-label'),
      controls: $('controls-modal'), touchUi: $('touch-ui'),
      marker: $('planet-marker'),
    };
    this.mmCtx = this.el.mm.getContext('2d');
    this.building = false;
    this.buildType = null;
    this.lastPrompt = '';
    this.dialogueTimer = 0;
    this.objective = null;
    this.buildMiniTerrain();
    this.bindButtons();
  }

  bindButtons() {
    const g = this.game;
    $('btn-start').onclick = () => g.startGame(false);
    $('btn-continue').onclick = () => g.startGame(true);
    $('btn-controls').onclick = () => this.el.controls.classList.remove('hidden');
    $('btn-close-controls').onclick = () => this.el.controls.classList.add('hidden');
    $('btn-resume').onclick = () => g.resume();
    // BUG-01：只有真正写入成功才提示已保存；失败时保留当前状态并给出重试指引
    // BUG-01：失败时提供重试与导出出口，且绝不谎报成功
    $('btn-save').onclick = () => {
      const res = g.save();
      if (res && res.ok) { this.toast('进度已保存', 'ok'); return; }
      this.toast('保存失败：浏览器存储不可用或已满', 'warn');
      this.game.audio?.play('uiError');
      // 本次进度仍保留在内存中，可以直接导出为文件
      const name = g.exportSave ? g.exportSave(res && res.data) : null;
      if (name) this.toast('已导出存档文件：' + name, 'info');
      else this.toast('导出也失败，请清理浏览器存储后重试', 'warn');
    };
    $('btn-menu').onclick = () => g.toMenu();
    $('set-quality').onchange = (e) => g.setQuality(e.target.value);
    const m1 = $('set-music'), s1 = $('set-sfx'), m2 = $('set-music2'), s2 = $('set-sfx2');
    const setVol = (k, v) => {
      if (k === 'music') g.audio.setMusicVolume(v); else g.audio.setSfxVolume(v);
      m1.value = m2.value = k === 'music' ? v : m1.value;
      s1.value = s2.value = k === 'sfx' ? v : s1.value;
    };
    m1.oninput = m2.oninput = (e) => setVol('music', +e.target.value);
    s1.oninput = s2.oninput = (e) => setVol('sfx', +e.target.value);
    // 移动端按钮
    // BUG-11：统一处理 end / cancel / 失焦，任何中断都要释放持续按压状态；
    // 同时使用 Pointer Events 并用 pointer capture 兜住滑出按钮的情形。
    const touch = g.input.touch;
    const bindHold = (id, onStart, onEnd) => {
      const el = $(id);
      if (!el) return;
      let active = false;
      const start = (e) => {
        e.preventDefault();
        if (active) return;
        active = true;
        el.classList.add('pressed');
        onStart && onStart();
      };
      const end = (e) => {
        if (e) e.preventDefault();
        if (!active) return;
        active = false;
        el.classList.remove('pressed');
        onEnd && onEnd();
      };
      el.addEventListener('touchstart', start, { passive: false });
      el.addEventListener('touchend', end, { passive: false });
      el.addEventListener('touchcancel', end, { passive: false });
      el.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse') { e.preventDefault(); start(e); } });
      el.addEventListener('pointerup', (e) => { if (e.pointerType === 'mouse') end(e); });
      el.addEventListener('pointercancel', end);
      el.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && e.buttons === 0) end(null); });
      // 统一的复位钩子：失焦/暂停/模式切换时清掉按压视觉
      g.input.resetHooks.push(() => { active = false; el.classList.remove('pressed'); });
    };
    const bindTap = (id, fn) => bindHold(id, fn, null);
    bindTap('t-jump', () => { touch.jump = true; });
    bindHold('t-fire', () => { touch.fire = true; }, () => { touch.fire = false; });
    bindTap('t-interact', () => { g.input.justPressed.add('KeyE'); });
    bindTap('t-build', () => { g.input.justPressed.add('KeyB'); });
    // BUG-09：补齐扫描、切枪、旋转预览与暂停入口
    bindTap('t-scan', () => { g.input.justPressed.add('KeyV'); });
    bindTap('t-mode', () => { g.input.justPressed.add('KeyQ'); });
    bindTap('t-rotate', () => { g.input.justPressed.add('KeyR'); });
    // BUG-09：暂停按钮直接切换（暂停中游戏循环不消费输入，不能只写 justPressed）
    bindTap('t-pause', () => {
      if (g.paused) g.resume();
      else if (g.mode !== 'menu' && g.mode !== 'intro') g.pause();
    });
    bindHold('t-thrust', () => { touch.throttle = 1; }, () => { if (touch.throttle > 0) touch.throttle = 0; });
    bindHold('t-brake', () => { touch.throttle = -1; }, () => { if (touch.throttle < 0) touch.throttle = 0; });
    bindHold('t-warp', () => { touch.warp = true; }, () => { touch.warp = false; });
    bindTap('t-land', () => { touch.land = true; });
    // 摇杆（BUG-08：摇杆值写进统一输入层，地面/太空/驾驶舱都读同一份）
    const base = $('joy-base'), knob = $('joy-knob');
    let jid = null;
    const rect = () => base.getBoundingClientRect();
    const setStick = (cx, cy) => {
      const r = rect();
      let dx = (cx - (r.left + r.width / 2)) / (r.width / 2);
      let dy = (cy - (r.top + r.height / 2)) / (r.height / 2);
      const len = Math.hypot(dx, dy);
      if (len > 1) { dx /= len; dy /= len; }
      touch.move.x = dx; touch.move.y = dy;
      knob.style.transform = `translate(${dx * 36}px, ${dy * 36}px)`;
    };
    const releaseStick = () => {
      jid = null; touch.move.x = touch.move.y = 0; knob.style.transform = '';
    };
    base.addEventListener('touchstart', (e) => {
      e.preventDefault();
      const t = e.changedTouches[0];
      jid = t.identifier;
      setStick(t.clientX, t.clientY);
    }, { passive: false });
    window.addEventListener('touchmove', (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier !== jid) continue;
        setStick(t.clientX, t.clientY);
      }
    }, { passive: true });
    // BUG-11：触摸中断同样要松杆
    const endJoy = (e) => {
      for (const t of e.changedTouches) if (t.identifier === jid) releaseStick();
      if (e.type === 'touchcancel') releaseStick();
    };
    window.addEventListener('touchend', endJoy);
    window.addEventListener('touchcancel', endJoy);
    g.input.resetHooks.push(() => { releaseStick(); });
    // 触屏设备：显示虚拟摇杆与按钮（必须在绑定之后切换，否则拿不到元素）
    const enableTouchUI = () => {
      const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
      const small = Math.min(window.innerWidth, window.innerHeight) < 820;
      const hasTouch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
      // BUG-10：与输入层一致——用实际指针类型判断，不再把“有触屏”当成“只用触屏”
      const on = hasTouch && (coarse || small);
      this.el.touchUi.classList.toggle('hidden', !on);
      document.body.classList.toggle('is-touch', on);
      this.touchEnabled = on;
      return on;
    };
    this.touchEnabled = enableTouchUI();
    window.addEventListener('resize', () => { this.touchEnabled = enableTouchUI(); });
  }

  // 小地图底图：预采样地形高度
  buildMiniTerrain() {
    this.mmSize = 128;
    this.mmHeights = null;
  }

  sampleMini(terrain) {
    if (this.mmHeights && this.mmTerrain === terrain) return;
    const N = this.mmSize;
    const arr = new Float32Array(N * N);
    const ext = 260;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const x = (i / (N - 1) - 0.5) * 2 * ext;
        const z = (j / (N - 1) - 0.5) * 2 * ext;
        arr[j * N + i] = terrain.height(x, z);
      }
    }
    this.mmHeights = arr;
    this.mmTerrain = terrain;
    const c = document.createElement('canvas');
    c.width = c.height = N;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(N, N);
    const acc = this.game.palette.accent;
    const col = new THREE.Color(acc);
    for (let k = 0; k < N * N; k++) {
      const h = arr[k];
      const shade = Math.max(0, Math.min(1, (h + 10) / 30));
      img.data[k * 4] = col.r * 255 * (0.25 + shade * 0.75);
      img.data[k * 4 + 1] = col.g * 255 * (0.25 + shade * 0.75);
      img.data[k * 4 + 2] = col.b * 255 * (0.25 + shade * 0.75);
      img.data[k * 4 + 3] = 255 * (0.35 + shade * 0.5);
    }
    ctx.putImageData(img, 0, 0);
    this.mmBase = c;
    this.mmExt = ext;
  }

  setPlanetTheme(id) {
    document.body.classList.remove('theme-verdant', 'theme-emer', 'theme-lumina', 'in-space');
    document.body.classList.add('theme-' + id);
    const p = this.game.palette;
    const info = PLANET_INFO[id];
    this.el.pcCode.textContent = p.code;
    this.el.pcName.textContent = p.name;
    this.el.pcLatin.textContent = p.latin;
    this.el.pcSub.textContent = `重力 ${p.gravity.toFixed(1)} · ${id === 'lumina' ? '微光夜' : id === 'emer' ? '黄昏' : '白昼'}`;
    document.documentElement.style.setProperty('--accent', p.accent);
    document.documentElement.style.setProperty('--accent2', p.accent2);
  }

  toast(text, type = 'info') {
    const d = document.createElement('div');
    d.className = 'toast ' + type;
    d.textContent = text;
    this.el.toasts.appendChild(d);
    setTimeout(() => d.remove(), 3200);
    while (this.el.toasts.children.length > 4) this.el.toasts.firstChild.remove();
  }

  dialogue(speaker, text, dur = 5) {
    this.el.dlgSpeaker.textContent = speaker;
    this.el.dlgText.textContent = text;
    this.el.dialogue.classList.remove('hidden');
    this.dialogueTimer = dur;
    this.game.dialogueBusy = true;
  }

  // BUG-48：无目标时清空/隐藏进度区；设新目标时统一初始化文本与进度
  setObjective(obj) {
    this.objective = obj;
    const prog = this.el.objBar?.parentElement?.parentElement;
    if (!obj) {
      this.el.objText.textContent = '自由探索';
      this.level = null;
      if (this.el.objBar) this.el.objBar.style.width = '0%';
      if (this.el.objCount) this.el.objCount.textContent = '';
      if (prog) prog.style.display = 'none';
      return;
    }
    this.el.objText.textContent = obj.text;
    this.level = { done: 0, need: obj.need };
    if (prog) prog.style.display = '';
    if (this.el.objBar) this.el.objBar.style.width = '0%';
    if (this.el.objCount) this.el.objCount.textContent = `0 / ${obj.need}`;
  }

  updateObjectiveProgress(done, need) {
    if (!this.objective) return;
    const p = Math.min(1, done / Math.max(1, need));
    this.el.objBar.style.width = `${p * 100}%`;
    this.el.objCount.textContent = `${done} / ${need}`;
  }

  setBuildingMode(on, type) {
    this.building = on;
    this.buildType = type;
    if (on) {
      this.el.buildBar.classList.remove('hidden');
      if (!this.el.buildBar.dataset.built) {
        this.el.buildBar.dataset.built = '1';
        this.el.buildBar.innerHTML = BUILD_ORDER.map((k, i) => {
          const b = BUILDINGS[k];
          const cost = Object.entries(b.cost).map(([r, v]) => `${r === 'ferrite' ? '◆' : r === 'silica' ? '◈' : r === 'bio' ? '❋' : '✦'}${v}`).join(' ');
          return `<div class="bb-item" data-type="${k}"><span class="bb-key">${i + 1}</span><div class="bb-icon">${b.icon}</div><div class="bb-name">${b.name}</div><div class="bb-cost">${cost}</div></div>`;
        }).join('');
        this.el.buildBar.querySelectorAll('.bb-item').forEach((n) => {
          n.onclick = () => this.game.building.startPlacing(n.dataset.type);
        });
      }
      this.el.buildBar.querySelectorAll('.bb-item').forEach((n) => {
        n.classList.toggle('active', n.dataset.type === type);
        n.classList.toggle('disabled', !this.game.building.canAfford(n.dataset.type));
      });
      // BUG-07：建造模式下选中项自动滚入可视区
      const active = this.el.buildBar.querySelector('.bb-item.active');
      if (active && active.scrollIntoView) {
        try { active.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch {}
      }
    } else {
      this.el.buildBar.classList.add('hidden');
    }
  }

  showPrompt(text, key = 'E') {
    if (this.lastPrompt === text) return;
    this.lastPrompt = text;
    if (!text) { this.el.prompt.classList.add('hidden'); return; }
    this.el.prompt.querySelector('.key').textContent = key;
    this.el.promptText.textContent = text;
    this.el.prompt.classList.remove('hidden');
  }

  setCockpit(on) {
    this.el.cockpit.classList.toggle('hidden', !on);
  }

  setSpaceHud(on) {
    this.el.spaceHud.classList.toggle('hidden', !on);
    document.body.classList.toggle('in-space', on);
    // BUG-08 / BUG-09：太空与地表的触屏按钮互斥显示
    document.querySelectorAll('#touch-ui .space-only').forEach((n) => n.classList.toggle('hidden', !on));
    ['t-jump', 't-fire', 't-interact', 't-build', 't-scan', 't-mode', 't-rotate'].forEach((id) => {
      const n = $(id); if (n) n.classList.toggle('hidden', !!on);
    });
    if (on) {
      this.el.navList.classList.remove('hidden');
      this.el.navList.innerHTML = ['verdant', 'emer', 'lumina'].map((id) => {
        const p = this.game.paletteMap[id];
        return `<div class="nav-item" data-id="${id}"><span class="nav-dot" style="color:${p.accent}"></span><span class="nav-name">${p.name}</span><span class="nav-dist" data-dist="${id}">—</span></div>`;
      }).join('');
      this.el.navList.querySelectorAll('.nav-item').forEach((n) => {
        n.onclick = () => this.game.flight.requestLanding(n.dataset.id);
      });
    } else {
      this.el.navList.classList.add('hidden');
    }
  }

  crosshairSpace(on) {
    this.el.crosshairSpace.classList.toggle('hidden', !on);
  }

  frame(dt) {
    const game = this.game;
    const el = this.el;
    // 对话超时
    if (this.dialogueTimer > 0) {
      this.dialogueTimer -= dt;
      if (this.dialogueTimer <= 0) {
        el.dialogue.classList.add('hidden');
        game.dialogueBusy = false;
      }
    }
    // 生命值
    const hp = Math.max(0, game.playerHealth);
    el.hpBar.style.transform = `scaleX(${hp / game.playerMaxHealth})`;
    el.shBar.style.transform = `scaleX(${Math.max(0, game.playerShield) / game.playerMaxShield})`;
    const en = game.weapon.energy;
    el.enBar.style.transform = `scaleX(${en / game.weapon.maxEnergy})`;
    el.hpVal.textContent = Math.ceil(hp);
    el.shVal.textContent = Math.ceil(Math.max(0, game.playerShield));
    el.enVal.textContent = Math.ceil(en);
    el.wpMode.textContent = (game.weapon.mode === 0 ? '●' : game.weapon.mode === 1 ? '◍' : '⋰') + ' ' + game.weapon.modes[game.weapon.mode];
    // 资源
    for (const k of ['ferrite', 'silica', 'bio', 'lumen']) {
      const n = el['res-' + k] || document.getElementById('res-' + k);
      if (n) n.textContent = game.inventory[k] || 0;
    }
    // 小地图
    if (game.mode === 'surface' || game.mode === 'landing') this.drawMinimap();
    // 太空 HUD
    if (game.flight.phase === 'space' || game.flight.phase === 'approach') {
      const s = game.flight.shipState;
      el.srSpeed.textContent = Math.round((s.speed || 0) * (1 + s.warp * 2.2));
      el.srThr.textContent = Math.round(s.throttle * 100) + '%';
      el.srFuel.textContent = '100%';
      el.srHull.textContent = '100%';
      const pos = s.pos;
      el.navList.querySelectorAll('[data-dist]').forEach((n) => {
        const id = n.dataset.dist;
        const d = game.flight.shipState?.pos;
        if (d && game.spaceSystem.planets[id]) {
          const p = game.spaceSystem.planets[id].mesh.position;
          n.textContent = Math.round(d.distanceTo(p) / 10) + ' km';
        }
      });
    }
  }

  drawMinimap() {
    const game = this.game;
    const ctx = this.mmCtx;
    const N = 220;
    if (this.el.mm.width !== N) { this.el.mm.width = N; this.el.mm.height = N; }
    this.sampleMini(game.terrain);
    ctx.clearRect(0, 0, N, N);
    ctx.save();
    // 圆形裁剪
    ctx.beginPath();
    ctx.arc(N / 2, N / 2, N / 2 - 2, 0, Math.PI * 2);
    ctx.clip();
    const scale = (N / 2) / 110; // 显示半径 110m
    const px = game.player.pos.x, pz = game.player.pos.z;
    const ox = this.mmExt;
    // BUG-06：mmBase 是 128px 画布，覆盖 ±ox 米。sx 是"米 → 画布像素"的换算，
    // 只能用于源矩形；目标矩形必须用世界尺度（米 × scale），否则底图会缩成
    // 128 * (128/520) ≈ 31.5px，而正确尺寸是 2*ox*scale = 520px。
    const yaw = game.player.camYaw;
    ctx.translate(N / 2, N / 2);
    ctx.rotate(yaw);
    ctx.drawImage(this.mmBase, -(px + ox) * scale, -(pz + ox) * scale, 2 * ox * scale, 2 * ox * scale);
    // BUG-10：扫描（V）真正控制标记可见性。
    // 扫描前只显示近距离资源；扫描后在限定时间/半径内显示全部节点与生物。
    const scanT = game.scanActiveT || 0;
    const scanning = scanT > 0 && game.scanOrigin;
    const insideScan = (x, z) => scanning && Math.hypot(x - game.scanOrigin.x, z - game.scanOrigin.z) <= (game.scanRadius || 0);
    // 资源点
    for (const nd of game.resources.nodes) {
      if (nd.harvested) continue;
      const rx = (nd.pos.x - px) * scale, rz = (nd.pos.z - pz) * scale;
      if (Math.hypot(rx, rz) > N / 2 - 6) continue;
      const dist = Math.hypot(nd.pos.x - px, nd.pos.z - pz);
      if (!insideScan(nd.pos.x, nd.pos.z) && dist > SCAN_NEAR_RADIUS) continue;
      ctx.fillStyle = nd.type === 'ferrite' ? '#ffb27a' : nd.type === 'silica' ? '#f2e08a' : nd.type === 'lumen' ? '#8fe6ff' : '#9dffcc';
      ctx.globalAlpha = insideScan(nd.pos.x, nd.pos.z) ? 0.95 : 0.5;
      ctx.beginPath(); ctx.arc(rx, rz, 1.8, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    // 基地
    for (const it of game.building.items) {
      const rx = (it.pos.x - px) * scale, rz = (it.pos.z - pz) * scale;
      ctx.strokeStyle = game.palette.accent;
      ctx.lineWidth = 1.2;
      ctx.strokeRect(rx - 3, rz - 3, 6, 6);
    }
    // 火箭
    const rp = game.rocket.group.position;
    const rx = (rp.x - px) * scale, rz = (rp.z - pz) * scale;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.moveTo(rx, rz - 5); ctx.lineTo(rx + 3.5, rz + 3); ctx.lineTo(rx, rz + 1.5); ctx.lineTo(rx - 3.5, rz + 3); ctx.closePath(); ctx.fill();
    // 生物（同样受扫描范围限制）
    for (const c of game.ecosystem.list) {
      if (c.dead) continue;
      const inScan = insideScan(c.pos.x, c.pos.z);
      const dist = Math.hypot(c.pos.x - px, c.pos.z - pz);
      if (!inScan && dist > SCAN_NEAR_RADIUS) continue;
      const cx = (c.pos.x - px) * scale, cz = (c.pos.z - pz) * scale;
      ctx.fillStyle = c.def.hostile ? 'rgba(255,110,90,0.9)' : 'rgba(200,255,240,0.55)';
      ctx.beginPath(); ctx.arc(cx, cz, c.def.hostile ? 2.2 : 1.4, 0, Math.PI * 2); ctx.fill();
    }
    // 扫描波纹
    if (scanning) {
      const r = (game.scanRadius || 0) * scale;
      ctx.strokeStyle = game.palette.accent;
      ctx.globalAlpha = 0.25 + 0.35 * Math.min(1, scanT / 4);
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc((game.scanOrigin.x - px) * scale, (game.scanOrigin.z - pz) * scale, r, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.restore();
    // 玩家箭头
    ctx.save();
    ctx.translate(N / 2, N / 2);
    ctx.fillStyle = '#fff';
    ctx.shadowColor = game.palette.accent; ctx.shadowBlur = 8;
    ctx.beginPath(); ctx.moveTo(0, -6); ctx.lineTo(4, 5); ctx.lineTo(0, 2.5); ctx.lineTo(-4, 5); ctx.closePath(); ctx.fill();
    ctx.restore();
    this.el.mmLabel.textContent = `${Math.round(px)} , ${Math.round(pz)}`;
  }

  planetMarker(show, name = '', dist = '') {
    const m = this.el.marker;
    if (!show) { m.classList.add('hidden'); return; }
    m.classList.remove('hidden');
    m.querySelector('.pm-name').textContent = name;
    m.querySelector('.pm-dist').textContent = dist;
  }

  fadeTo(v, ms = 1400) {
    this.el.fade.style.transition = `opacity ${ms}ms cubic-bezier(.2,.8,.2,1)`;
    this.el.fade.style.opacity = String(v);
  }

  setLoading(p, tip) {
    if (this.el.loadingFill) this.el.loadingFill.style.width = `${p * 100}%`;
    if (tip) this.el.loadingTip.textContent = tip;
  }

  hideLoading() {
    this.el.loading.style.opacity = '0';
    setTimeout(() => this.el.loading.classList.add('hidden'), 1000);
  }
}
