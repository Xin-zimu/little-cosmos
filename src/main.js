// 《微光星球》LITTLE COSMOS — 游戏总控与启动流程
import * as THREE from 'three';
import { Engine } from './core/engine.js';
import { Input } from './core/input.js';
import { AudioEngine } from './core/audio.js';
import { PALETTES, PLANET_ORDER, PLANET_INFO } from './world/themes.js';
import { createSky } from './world/sky.js';
import { Terrain } from './world/terrain.js';
import { Vegetation } from './world/props.js';
import { createWater } from './world/water.js';
import { createParticles, createDustPlume } from './world/particles.js';
import { Ecosystem, CREATURE_DEFS } from './world/creatures.js';
import { ResourceField, RESOURCE_DEFS } from './world/resources.js';
import { PlayerController } from './player/controller.js';
import { Weapon } from './player/weapon.js';
import { Rocket } from './ship/rocket.js';
import { SpaceSystem, PLANET_POS, PLANET_R } from './ship/space.js';
import { FlightSystem } from './ship/flight.js';
import { BuildingSystem, BUILDINGS, disposeObject } from './base/building.js';
import { UI } from './ui/ui.js';
import { clamp, damp, lerp } from './core/noise.js';

const SAVE_KEY = 'little-cosmos-save-v1';
const SAVE_VERSION = 3;
// BUG-02：每颗星球的固定种子与关卡参数，地形/资源/生物都从这里派生，保证可复现
const PLANET_SEEDS = { verdant: 11, emer: 23, lumina: 37 };
const PLANET_DEFS = {
  verdant: { waterLevel: -3.4, slopeRock: 0.36 },
  emer: { waterLevel: -12, slopeRock: 0.5 },
  lumina: { waterLevel: -3.0, slopeRock: 0.4 },
};
const VALID_PLANETS = ['verdant', 'emer', 'lumina'];
// BUG-10：环境扫描的有效半径、持续时间与冷却（秒）
const SCAN_RADIUS = 120;
const SCAN_DURATION = 20;
const SCAN_COOLDOWN = 8;
const EMPTY_INV = () => ({ ferrite: 0, silica: 0, bio: 0, lumen: 0, sample: 0 });
// 新开局的初始补给：刚好够理解资源与建造流程，但不足以跳过采集
const START_INV = () => ({ ferrite: 3, silica: 1, bio: 0, lumen: 0, sample: 0 });

export class Game {
  constructor(canvas) {
    this.canvas = canvas;
    this.paletteMap = PALETTES;
    this.palette = PALETTES.verdant;
    this.currentPlanetId = null;
    this.mode = 'menu';
    this.time = 0;
    this.inventory = EMPTY_INV();
    this.playerHealth = 100;
    this.playerMaxHealth = 100;
    this.playerShield = 100;
    this.playerMaxShield = 100;
    this.cameraShake = 0;
    this.speedFx = 0;
    this.atmosOverlay = 0;
    this.reentryFx = 0;
    this.cloudPass = 0;
    this.dialogueBusy = false;
    this.unlocked = { weapon: 1 };
    this.objectiveState = { step: 0, done: 0 };
    this.planetBases = {};
    this.planetInventories = {};
    this.audio = new AudioEngine();
    this.quality = 'high';
    this.paused = false;
    this.fovCurrent = 55;
    this.cameraLookTarget = new THREE.Vector3();
    this._tmpV = new THREE.Vector3();
  }

  // 昼夜状态：lumina 是永夜星球，其余为白昼。
  // 注意：原代码 creatures.js 读取 game.isNight 但从未赋值，导致夜间感知永远失效。
  get isNight() {
    return this.currentPlanetId === 'lumina';
  }

  async boot() {
    const loading = document.getElementById('loading');
    const tip = document.getElementById('ld-tip');
    const fill = document.getElementById('ld-fill');
    const step = async (p, text) => {
      fill.style.width = `${p * 100}%`;
      if (text) tip.textContent = text;
      await new Promise((r) => setTimeout(r, 30));
    };
    try {
      await step(0.06, '初始化渲染器与后期管线…');
      this.engine = new Engine(this.canvas, { quality: 'high' });
      this.scene = this.engine.scene;
      this.camera = this.engine.camera;
      this.renderer = this.engine.renderer;
      this.scene.matrixWorldAutoUpdate = true;
      this.scene.background = new THREE.Color(0x05090a);

      await step(0.16, '标定星际坐标…');
      this.spaceSystem = new SpaceSystem(this);
      this.spaceSystem.setVisible(false);
      this.spaceSystem.group.visible = false;

      await step(0.28, '装配宇航员与装备…');
      this.palette = PALETTES.verdant;
      this.player = new PlayerController(this);
      this.scene.add(this.player.object);
      this.weapon = new Weapon(this);
      this.weapon.attachLight(this.scene, this.player);
      this.input = new Input(this.canvas);
      this.ui = new UI(this);
      this.rocket = new Rocket(this);
      this.scene.add(this.rocket.group);
      this.flight = new FlightSystem(this);
      this.building = new BuildingSystem(this);
      this.scene.add(this.building.group);
      this.ecosystem = new Ecosystem(this);
      this.scene.add(this.ecosystem.group);
      this.dustPlume = createDustPlume();
      this.scene.add(this.dustPlume);
      this.chunk = new THREE.Group();
      this.scene.add(this.chunk);

      await step(0.45, '让苔原生长：生成地形与植被…');
      // 默认进入 verdant（preload），菜单背景也使用它
      this.loadPlanetSync('verdant');
      this.teleportPlayerTo('verdant');

      await step(1, '准备就绪');
      this.bindGlobalEvents();
      this.showMenu();
      const cont = document.getElementById('btn-continue');
      if (localStorage.getItem(SAVE_KEY)) cont.classList.remove('hidden');
      setTimeout(() => this.ui.hideLoading(), 400);
      this.lastT = performance.now();
      requestAnimationFrame((t) => this.loop(t));
    } catch (err) {
      console.error(err);
      const box = document.getElementById('error-box');
      box.classList.remove('hidden');
      box.textContent = '启动失败：' + (err && err.message) + '\n' + (err && err.stack || '');
      tip.textContent = '启动失败：' + (err && err.message);
    }
  }

  setQuality(q) {
    this.quality = q;
    this.engine.setQuality(q);
    this.renderer.shadowMap.enabled = true;
    // 阴影分辨率
    if (this.sun) {
      this.sun.shadow.mapSize.set(q === 'high' ? 4096 : 1024, q === 'high' ? 4096 : 1024);
      if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; }
    }
  }

  bindGlobalEvents() {
    window.addEventListener('keydown', (e) => {
      if (this.mode === 'menu') return;
      // BUG-11：长按 Escape 会由系统重复触发，必须过滤，否则暂停/恢复会来回抖动
      if (e.repeat) return;
      if (e.code === 'Escape') {
        e.preventDefault();
        if (this.paused) this.resume(); else this.pause();
      }
    });
    this.canvas.addEventListener('mousedown', () => {
      if (!this.paused && ((this.mode === 'surface' && !this.ui.building) || this.mode === 'space')) this.input.requestLock();
    });
    document.addEventListener('pointerlockchange', () => {
      if (!document.pointerLockElement && this.mode === 'surface' && !this.paused && !this.flight.launching) {
        // 指针锁定丢失（Esc）→ 暂停提示
      }
    });
    window.addEventListener('resize', () => this.ui && this.ui.buildMiniTerrain());
    // BUG-12：页面隐藏/失焦时统一复位输入，防止回来后持续开火或残留位移
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.input.reset();
    });
    window.addEventListener('blur', () => this.input.reset());
  }

  // ================= 星球加载 =================
  // BUG-02：离开星球前把该星球的动态状态写回 planetStates
  captureplanetState(id) {
    if (!id) return;
    const st = (this.planetStates[id] = this.planetStates[id] || {});
    if (this.resources) st.resources = this.resources.serialize();
    if (this.ecosystem) st.creatures = this.ecosystem.serialize();
    if (this.building && id === this.currentPlanetId) {
      st.bases = this.building.serialize();
      this.planetBases[id] = st.bases;
    }
  }

  // BUG-02：加载后按稳定 ID 恢复采集冷却、生物死亡与基地生产进度
  restoreplanetState(id) {
    const st = this.planetStates?.[id];
    if (!st) return;
    if (this.resources) this.resources.restore(st.resources);
    if (this.ecosystem) this.ecosystem.restore(st.creatures);
    if (this.building) this.building.applyProduction(st.bases);
  }

  // BUG-43：完整释放 GPU 资源（几何 / 材质 / 纹理 / 阴影目标）
  clearPlanet() {
    if (this.currentPlanetId) this.captureplanetState(this.currentPlanetId);
    const kill = (obj) => {
      if (!obj) return;
      this.scene.remove(obj);
      disposeObject(obj);
    };
    if (this.terrain) { kill(this.terrain.group); this.terrain = null; }
    if (this.skyMesh) { kill(this.skyMesh); this.skyMesh = null; }
    if (this.vegetation) { kill(this.vegetation.group); this.vegetation = null; }
    if (this.water) { kill(this.water); this.water = null; }
    if (this.motes) { kill(this.motes); this.motes = null; }
    if (this.ecosystem) this.ecosystem.clear();
    if (this.resources) { this.resources.dispose(); kill(this.resources.group); this.resources = null; }
    if (this.sun) {
      if (this.sun.shadow?.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; }
      this.scene.remove(this.sun);
      this.scene.remove(this.sun.target);
      this.sun = null;
    }
    if (this.hemi) { this.scene.remove(this.hemi); this.hemi = null; }
    if (this.building) this.building.clear();
    // BUG-33：离开地表时清掉残留的弹道与枪口闪光
    if (this.weapon) this.weapon.clearEffects();
    this.ui.mmTerrain = null;
    this.ui.mmHeights = null;
    this.ui.mmBase = null;
  }

  loadPlanetSync(id) {
    if (!PALETTES[id]) id = 'verdant';
    const prevMode = this.mode;
    this.clearPlanet();
    this.currentPlanetId = id;
    const pal = PALETTES[id];
    this.palette = pal;
    const pdef = PLANET_DEFS[id] || PLANET_DEFS.verdant;
    const def = { biome: pal.biome, seed: PLANET_SEEDS[id] ?? 11, extent: 300, waterLevel: pdef.waterLevel, slopeRock: pdef.slopeRock };
    // 天空
    this.skyMesh = createSky(pal);
    this.scene.add(this.skyMesh);
    this.skyMesh.material.uniforms.uSunDir.value.set(...pal.sunDir).normalize();
    // 光照
    const sunDir = new THREE.Vector3(...pal.sunDir).normalize();
    this.sun = new THREE.DirectionalLight(new THREE.Color().setRGB(...pal.sunColor), pal.sunIntensity);
    this.sun.position.copy(sunDir).multiplyScalar(120);
    this.sun.castShadow = true;
    const sm = this.quality === 'high' ? 4096 : 1024;
    this.sun.shadow.mapSize.set(sm, sm);
    this.sun.shadow.camera.left = -46;
    this.sun.shadow.camera.right = 46;
    this.sun.shadow.camera.top = 46;
    this.sun.shadow.camera.bottom = -46;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 260;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.045;
    this.sun.shadow.radius = 3;
    this.sun.target.position.set(0, 0, 0);
    this.scene.add(this.sun, this.sun.target);
    this.sunDirVec = sunDir;
    this.hemi = new THREE.HemisphereLight(new THREE.Color().setRGB(...pal.ambientSky), new THREE.Color().setRGB(...pal.ambientGround), pal.hemiIntensity);
    this.scene.add(this.hemi);
    this.scene.fog = null;
    this.engine.renderer.toneMappingExposure = pal.exposure;
    // 地形
    this.terrain = new Terrain(def, pal);
    this.scene.add(this.terrain.group);
    this.player.setPlanet(this.terrain, pal);
    // 植被
    this.vegetation = new Vegetation(this.terrain, pal, this.quality);
    this.vegetation.home = this.spawnPoints(id).player;
    {
      const h = this.vegetation.home;
      // 清除出生点周围过近的岩石与树木
      this.vegetation.colliders = this.vegetation.colliders.filter((c) => Math.hypot(c.x - h.x, c.z - h.z) > 6.5);
      this.vegetation.trees = this.vegetation.trees.filter((t) => {
        const near = Math.hypot(t.position.x - h.x, t.position.z - h.z) < 9;
        if (near) this.vegetation.group.remove(t);
        return !near;
      });
    }
    this.scene.add(this.vegetation.group);
    // 水
    if (id !== 'emer') {
      this.water = createWater(pal, def.waterLevel, id === 'lumina' ? 2 : 0);
      this.scene.add(this.water);
    }
    // 漂浮粒子
    this.motes = createParticles(pal, this.quality === 'high' ? 1600 : 700, {
      area: 90, height: 24, size: id === 'emer' ? 0.35 : 0.6, opacity: id === 'emer' ? 0.35 : id === 'lumina' ? 0.9 : 0.6,
      fall: id === 'emer' ? 0.1 : 0.3,
    });
    this.scene.add(this.motes);
    // 资源（BUG-02：用星球种子生成固定布局）
    this.resources = new ResourceField(this.terrain, pal, Math.random, { planetId: id, seed: PLANET_SEEDS[id] ?? 11 });
    this.scene.add(this.resources.group);
    // 生态（BUG-02：同样按星球种子生成稳定布局）
    this.ecosystem.clear();
    this.ecosystem.setSeed(PLANET_SEEDS[id] ?? 11);
    this.spawnCreatures(id);
    // 基地（若已有存档）
    const bases = this.planetBases[id];
    if (bases && bases.length) this.building.restore(bases);
    // BUG-02：恢复该星球的采集冷却、生物死亡与矿机进度
    this.restoreplanetState(id);
    // 火箭位置
    const spawn = this.spawnPoints(id);
    this.rocket.group.position.set(spawn.rocket.x, this.terrain.height(spawn.rocket.x, spawn.rocket.z), spawn.rocket.z);
    this.rocket.group.rotation.set(0, spawn.rocket.yaw, 0);
    this.rocket.group.userData.groundY = this.rocket.group.position.y;
    this.rocket.throttle = 0;
    this.player.teleport(spawn.player.x, spawn.player.z, spawn.player.yaw);
    this.astronautAccent(pal);
    this.ui.setPlanetTheme(id);
    this.audio.setPlanet(id);
    this.sun.shadow.camera.updateProjectionMatrix();
    this.mode = prevMode;
  }

  astronautAccent(pal) {
    // 宇航员装备高光随星球微调（保留统一设计语言）
    const a = new THREE.Color(pal.accent);
    this.player.astronaut.mats.accentGlow.color.copy(a);
    this.player.astronaut.mats.accentGlow.emissive.copy(a);
    this.player.astronaut.mats.accentMat.color.copy(a).lerp(new THREE.Color('#ffffff'), 0.35);
  }

  spawnPoints(id) {
    // 手工挑选的宜居点（避免陡坡/水）
    let best = null;
    const candidates = id === 'verdant' ? [[8, 14], [-12, 10], [20, -6]] : id === 'emer' ? [[6, 12], [-10, 8], [14, -4]] : [[10, 12], [-10, 14], [16, -8]];
    for (const [x, z] of candidates) {
      let px = x, pz = z;
      let guard = 0;
      while (this.terrain.slopeAt(px, pz) > 0.18 && guard++ < 40) { px *= 1.08; pz *= 1.08; }
      const y = this.terrain.height(px, pz);
      if (y < this.terrain.waterLevel + 0.8) continue;
      best = { x: px, z: pz };
      break;
    }
    if (!best) best = { x: 0, z: 0 };
    // 航线布置：火箭在出生点前方，舱门朝向玩家，形成天然的引导构图
    const D = 7.5;
    const ang = Math.atan2(-best.x, -best.z); // 朝向岛心
    const rx = best.x + Math.sin(ang) * D;
    const rz = best.z + Math.cos(ang) * D;
    // 火箭局部 -Z（舱门方向）朝向玩家
    const toPlayer = Math.atan2(best.x - rx, best.z - rz);
    return {
      player: { x: best.x, z: best.z, yaw: ang },
      rocket: { x: rx, z: rz, yaw: toPlayer + Math.PI },
    };
  }

  teleportPlayerTo(id) {
    const s = this.spawnPoints(id);
    this.player.teleport(s.player.x, s.player.z, s.player.yaw);
  }

  spawnCreatures(id) {
    const eco = this.ecosystem;
    const pts = [new THREE.Vector3(22, 0, -14), new THREE.Vector3(-26, 0, 20), new THREE.Vector3(40, 0, 30)];
    const ground = (v) => { v.y = this.terrain.height(v.x, v.z); return v; };
    if (id === 'verdant') {
      eco.spawn('gargantua', 2, ground(pts[0].clone()));
      eco.spawn('gargantua', 1, ground(pts[1].clone()));
      eco.spawn('thornling', 2, ground(pts[2].clone()));
      eco.spawn('thornling', 1, ground(new THREE.Vector3(-40, 0, -30)));
    } else if (id === 'emer') {
      eco.spawn('hopper', 4, ground(pts[0].clone()));
      eco.spawn('hopper', 3, ground(pts[1].clone()));
      eco.spawn('sandworm', 1, ground(pts[2].clone()));
      eco.spawn('sandworm', 1, ground(new THREE.Vector3(-45, 0, 26)));
    } else {
      eco.spawn('driftjelly', 4, ground(pts[0].clone()));
      eco.spawn('driftjelly', 3, ground(pts[1].clone()));
      eco.spawn('driftjelly', 2, ground(pts[2].clone()));
    }
  }

  // ================= 菜单 / 流程 =================
  showMenu() {
    this.mode = 'menu';
    document.getElementById('menu').classList.remove('hidden');
    document.getElementById('hud').classList.add('hidden');
    this.ui.setCockpit(false);
    this.ui.setSpaceHud(false);
    // 有存档时始终可以继续
    const cont = document.getElementById('btn-continue');
    if (cont) cont.classList.toggle('hidden', !localStorage.getItem(SAVE_KEY));
    document.body.classList.remove('cinematic');
    this.ui.fadeTo(0, 2000);
    this.menuTime = 0;
    this.camera.position.set(6, 3.2, 10);
    this.cameraLookTarget.set(0, 1.4, 0);
    this.player.object.visible = true;
    this.player.pos.set(0, this.terrain.height(0, 2), 2);
    this.player.yaw = -2.6;
    // 从太空/飞行状态返回菜单时，恢复地表场景与角色
    this.flight.setPhase('ground');
    this.player.inRocket = false;
    this.spaceSystem?.setVisible(false);
    this.planetSceneVisible(true);
    this.rocket.group.visible = true;
    this.rocket.throttle = 0;
    this.player.object.visible = true;
    this.ui.showPrompt('');
    this.ui.setBuildingMode(false);
    this.building.cancelPlacing();
    // BUG-41：返回菜单必须把火箭复位到当前星球的地表落点，
    // 否则它会停在星系坐标里，菜单背景里看不到飞船。
    if (this.rocket && this.terrain) {
      const sp = this.spawnPoints(this.currentPlanetId || 'verdant');
      const ry = this.terrain.height(sp.rocket.x, sp.rocket.z);
      this.rocket.group.position.set(sp.rocket.x, ry, sp.rocket.z);
      this.rocket.group.rotation.set(0, sp.rocket.yaw, 0);
      this.rocket.group.quaternion.setFromEuler(this.rocket.group.rotation);
      this.rocket.group.scale.setScalar(1);
      this.rocket.group.userData.groundY = ry;
      if (this.rocket.legs) this.rocket.legs.forEach((l) => { l.visible = true; });
    }
    // BUG-45：菜单不应残留引擎嗡鸣
    this.audio?.setEngine(0, 0);
    // BUG-33：清掉上一局残留的弹道/枪口闪光
    this.weapon?.clearEffects();
    this.tryBoard = false;
    document.getElementById('crosshair')?.classList.remove('hidden');
    document.getElementById('pause')?.classList.add('hidden');
    document.body.classList.remove('flying', 'aiming', 'cinematic');
  }

  // BUG-03：读档前先做版本与结构校验。只有全部通过才替换场景；
  // 失败时清理 starting 并回到菜单，绝不能留下半初始化状态卡死继续游戏。
  validateSave(data) {
    if (!data || typeof data !== 'object') return { ok: false, reason: '存档格式错误' };
    if (!Number.isFinite(data.version)) return { ok: false, reason: '存档缺少版本号' };
    if (data.version > SAVE_VERSION) return { ok: false, reason: '存档来自更新的版本' };
    if (data.planet !== undefined && !VALID_PLANETS.includes(data.planet)) {
      return { ok: false, reason: `未知星球 ${data.planet}` };
    }
    // 数值校验：避免 NaN 污染 HUD 与物理
    const inv = data.inventory;
    if (inv !== undefined) {
      if (typeof inv !== 'object' || inv === null) return { ok: false, reason: '资源字段损坏' };
      for (const k of Object.keys(inv)) {
        if (!Number.isFinite(inv[k]) || inv[k] < 0) return { ok: false, reason: `资源 ${k} 数值非法` };
      }
    }
    // bases：必须是以合法星球为键的数组，元素类型必须在 BUILDINGS 中
    if (data.bases !== undefined) {
      if (typeof data.bases !== 'object' || data.bases === null) return { ok: false, reason: '基地字段损坏' };
      for (const [pid, list] of Object.entries(data.bases)) {
        if (!VALID_PLANETS.includes(pid)) return { ok: false, reason: `基地星球非法: ${pid}` };
        if (!Array.isArray(list)) return { ok: false, reason: '基地列表损坏' };
        for (const b of list) {
          if (!b || !BUILDINGS[b.type]) return { ok: false, reason: `建筑类型非法: ${b && b.type}` };
          if (!Number.isFinite(b.x) || !Number.isFinite(b.z)) return { ok: false, reason: '建筑坐标非法' };
        }
      }
    }
    if (data.planetStates !== undefined && (typeof data.planetStates !== 'object' || data.planetStates === null)) {
      return { ok: false, reason: '星球状态损坏' };
    }
    const fl = data.flight;
    if (fl !== undefined && fl !== null) {
      if (typeof fl !== 'object') return { ok: false, reason: '飞行检查点损坏' };
      if (fl.kind && !['surface', 'space', 'landingCheckpoint'].includes(fl.kind)) {
        return { ok: false, reason: `飞行检查点类型非法: ${fl.kind}` };
      }
      if (fl.kind === 'space') {
        if (!Array.isArray(fl.pos) || fl.pos.length !== 3 || !fl.pos.every(Number.isFinite)) {
          return { ok: false, reason: '飞行坐标非法' };
        }
        if (!VALID_PLANETS.includes(fl.planet)) return { ok: false, reason: '飞行检查点星球非法' };
      }
    }
    const pl = data.player;
    if (pl !== undefined && pl !== null) {
      if (typeof pl !== 'object') return { ok: false, reason: '玩家字段损坏' };
      for (const k of ['x', 'z', 'yaw', 'camYaw', 'camPitch', 'health', 'shield']) {
        if (pl[k] !== undefined && !Number.isFinite(pl[k])) return { ok: false, reason: `玩家字段 ${k} 非法` };
      }
    }
    return { ok: true };
  }

  async startGame(continueSave) {
    if (this.starting) return;
    this.starting = true;
    try {
      await this.audio.init();
      const menu = document.getElementById('menu');
      menu.style.transition = 'opacity .9s cubic-bezier(.2,.8,.2,1)';
      menu.style.opacity = '0';
      setTimeout(() => { menu.classList.add('hidden'); menu.style.opacity = ''; }, 900);
      document.getElementById('hud').classList.remove('hidden');
      document.body.classList.add('cinematic');
      this.mode = 'intro';
      this.ui.fadeTo(1, 600);
      await new Promise((r) => setTimeout(r, 700));
      // 读取并校验存档（BUG-03）
      let restored = false;
      let savedPlayer = null;
      if (continueSave) {
        let data = null;
        try {
          const raw = localStorage.getItem(SAVE_KEY);
          if (raw) data = JSON.parse(raw);
        } catch (e) {
          console.warn('存档解析失败', e);
        }
        const check = data ? this.validateSave(data) : { ok: false, reason: '没有可用的存档' };
        if (check.ok) {
          // BUG-08：先彻底清空上一局的运行态，再套用存档，避免残留值混入
          this.resetRunState();
          Object.assign(this.inventory, data.inventory || {});
          this.planetBases = data.bases || {};
          this.planetStates = data.planetStates || {};
          this.objectiveState = data.objective || { step: 0, done: 0 };
          this.unlocked = Object.assign({ weapon: 1, shield: 0 }, data.unlocked || {});
          this.savedPlanet = data.planet || 'verdant';
          savedPlayer = data.player || null;
          this.pendingFlight = data.flight || null;
          restored = true;
        } else {
          // 校验失败：不要动当前场景，回到菜单并说明原因
          console.warn('存档校验失败：' + check.reason);
          this.ui.fadeTo(0, 400);
          this.showMenu();
          this.ui.toast('存档损坏或版本不兼容：' + check.reason + '，可开始新游戏', 'warn');
          this.starting = false;
          return;
        }
      }
      if (!restored) {
        this.resetRunState();
        Object.assign(this.inventory, START_INV());
      }
      const startPlanet = restored && VALID_PLANETS.includes(this.savedPlanet) ? this.savedPlanet : 'verdant';
      // 菜单到游戏：用淡入淡出遮罩切换（仅在开局一次）
      this.loadPlanetSync(startPlanet);
      if (restored && savedPlayer) {
        // BUG-12：从离开时的位置继续，而不是回到出生点
        this.applyPlayerState(savedPlayer);
      } else {
        this.teleportPlayerTo(startPlanet);
      }
      // BUG-04：读档后把解锁状态换算成实际数值（伤害 / 护盾上限 / HUD 标识）
      this.applyUnlocks();
      // BUG-04：飞行中保存的存档恢复到当时的太空检查点
      if (restored && this.restoreFlightState(this.pendingFlight)) {
        this.pendingFlight = null;
        this.starting = false;
        return;
      }
      this.pendingFlight = null;
      // BUG-05：只有没有存档镜头时才用默认的“角色身后”朝向
      if (!this.savedCamera) this.player.camYaw = this.player.yaw + Math.PI;
      this.camIntroStart = new THREE.Vector3(this.player.pos.x + 4, this.player.pos.y + 2.5, this.player.pos.z + 6);
      this.camera.position.copy(this.camIntroStart);
      this.mode = 'intro';
      this.ui.fadeTo(0, 1800);
      setTimeout(() => this.beginExplore(), 1200);
    } catch (e) {
      // BUG-03：任何异常都要解除 starting，避免“继续游戏”按钮永久失效
      console.error(e);
      this.starting = false;
      this.mode = 'menu';
      this.showMenu();
      this.ui.toast('加载失败：' + (e && e.message), 'warn');
      return;
    }
    this.starting = false;
  }

  beginExplore() {
    this.mode = 'surface';
    // BUG-05：读档时保留存档中的镜头朝向；仅新游戏使用默认“角色身后”视角
    if (this.savedCamera) {
      this.player.camYaw = this.savedCamera.camYaw;
      this.player.camPitch = this.savedCamera.camPitch;
      this.savedCamera = null;
    } else {
      this.player.camYaw = this.player.yaw + Math.PI;
      this.player.camPitch = 0.28;
    }
    this.player.camTarget.copy(this.player.pos).add(new THREE.Vector3(0, 0.5, 0));
    this.player.camSnapPending = true;
    this.player.updateCamera(0, this.camera, {}, true);
    this.player.object.visible = true;
    this.player.inRocket = false;
    this.setObjective();
    setTimeout(() => {
      this.ui.dialogue('航行日志 · DAY 1', `「${this.palette.name}」的大气很轻，光穿过巨蕨时会碎成一地斑点。先在这附近找一些铁素矿——我的小火箭需要它们。`, 9);
      document.body.classList.remove('cinematic');
    }, 600);
    this.ui.toast('按 E 采集 · B 建造 · V 扫描', 'info');
  }

  // BUG-11：暂停不再只限地表，驾驶舱/太空/降落阶段都应能暂停
  pause() {
    if (this.mode === 'menu' || this.mode === 'intro') return;
    if (this.paused) return;
    this.paused = true;
    document.getElementById('pause').classList.remove('hidden');
    this.input.releaseLock();
    // BUG-13：进入暂停时清空瞬时输入与持续按压，恢复后不会补执行暂停期间的按键
    this.input.enabled = false;
    this.input.reset();
    this.audio.setEngine(0, 0);
  }

  resume() {
    this.paused = false;
    document.getElementById('pause').classList.add('hidden');
    // BUG-13：恢复时重新采集持续键状态，并丢弃暂停期间的瞬时输入
    this.input.enabled = true;
    this.input.reset();
    this.input.requestLock();
    this.audio.updateMusic(0, this.mode === 'surface' ? 0.2 : 0.6);
  }

  // BUG-12：存档补全玩家动态状态（位置/生命/护盾/能量/射击模式）
  // BUG-01：返回 { ok, error } —— 只有真正写入成功才允许 UI 提示“已保存”
  // 组装完整存档对象（save 与 exportSave 共用）
  buildSaveData() {
    const bases = {};
    for (const id of PLANET_ORDER) {
      if (id === this.currentPlanetId) bases[id] = this.building.serialize();
      else if (this.planetBases[id]) bases[id] = this.planetBases[id];
    }
    // BUG-02：保存前先把当前星球动态状态写入 planetStates
    if (this.currentPlanetId) {
      const st = (this.planetStates[this.currentPlanetId] = this.planetStates[this.currentPlanetId] || {});
      if (this.resources) st.resources = this.resources.serialize();
      if (this.ecosystem) st.creatures = this.ecosystem.serialize();
      st.bases = bases[this.currentPlanetId] || [];
    }
    return {
      version: SAVE_VERSION,
      inventory: this.inventory,
      bases,
      objective: this.objectiveState,
      unlocked: this.unlocked,
      planet: this.currentPlanetId,
      // 动态状态
      player: this.capturePlayerState(),
      planetStates: this.planetStates || {},
      // BUG-04：飞行检查点（太空阶段可完整恢复；其余飞行阶段保存为落地检查点）
      flight: this.captureFlightState(),
      savedAt: Date.now(),
    };
  }

  // BUG-04：把飞行状态序列化。只有 'space' 能完整恢复，
  // 过渡阶段（起飞/再入/着陆/出舱）记录为“落地检查点”，读档后回到地表。
  captureFlightState() {
    const f = this.flight;
    if (!f || f.phase === 'ground' || this.mode === 'menu') return { kind: 'surface' };
    if (f.phase !== 'space') {
      return { kind: 'landingCheckpoint', planet: this.currentPlanetId, reason: f.phase };
    }
    const s = f.shipState;
    return {
      kind: 'space',
      planet: this.currentPlanetId,
      pos: [s.pos.x, s.pos.y, s.pos.z],
      yaw: s.yaw, pitch: s.pitch, roll: s.roll,
      throttle: s.throttle, speed: s.speed,
      target: f.targetPlanet || null,
    };
  }

  // BUG-04：恢复飞行检查点。返回 true 表示已进入太空，无需再走地表出生流程。
  restoreFlightState(cp) {
    if (!cp || cp.kind !== 'space') return false;
    const f = this.flight;
    if (!Array.isArray(cp.pos) || cp.pos.length !== 3 || !cp.pos.every(Number.isFinite)) return false;
    if (!VALID_PLANETS.includes(cp.planet)) return false;
    this.currentPlanetId = cp.planet;
    this.mode = 'space';
    this.player.inRocket = true;
    this.player.object.visible = false;
    this.exitPlanetToSpace();
    const s = f.shipState;
    s.pos.set(cp.pos[0], cp.pos[1], cp.pos[2]);
    s.yaw = Number.isFinite(cp.yaw) ? cp.yaw : 0;
    s.pitch = Number.isFinite(cp.pitch) ? cp.pitch : 0;
    s.roll = Number.isFinite(cp.roll) ? cp.roll : 0;
    s.throttle = clamp(Number.isFinite(cp.throttle) ? cp.throttle : 0, 0, 1);
    s.speed = Number.isFinite(cp.speed) ? cp.speed : 0;
    s.warp = 0;
    f.targetPlanet = VALID_PLANETS.includes(cp.target) ? cp.target : null;
    // 网格与镜头同步落位，避免读到旧地表坐标
    f.ship.group.position.copy(s.pos);
    f.setPhase('space');
    f.cameraShipPos = s.pos.clone();
    this.ui.fadeTo(0, 800);
    document.body.classList.remove('cinematic');
    this.ui.toast('已在太空检查点继续航行', 'ok');
    return true;
  }

  save() {
    const data = this.buildSaveData();
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(data));
    } catch (e) {
      // BUG-01：不再吞掉异常；保留当前运行状态，让玩家可以重试或导出
      console.warn('存档写入失败', e);
      return { ok: false, error: e, data };
    }
    this.planetBases = data.bases;
    return { ok: true };
  }

  // 导出存档文件（保存失败时的兜底出口）——导出的是“当前内存态”，不是旧存档
  exportSave(data) {
    try {
      const payload = data || this.buildSaveData();
      const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `little-cosmos-${Date.now()}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      return a.download;
    } catch (e) { return null; }
  }

  // 采集当前玩家的可持久化状态
  // BUG-05：保存真实的镜头朝向（camYaw / camPitch），而不是控制逻辑里不存在的 p.pitch
  capturePlayerState() {
    const p = this.player;
    return {
      health: this.playerHealth,
      maxHealth: this.playerMaxHealth,
      shield: this.playerShield,
      maxShield: this.playerMaxShield,
      x: p.pos.x,
      z: p.pos.z,
      y: p.pos.y,
      yaw: p.yaw,
      camYaw: p.camYaw,
      camPitch: p.camPitch,
      energy: this.weapon ? this.weapon.energy : 100,
      weaponMode: this.weapon ? this.weapon.mode : 0,
      unlocked: this.unlocked,
      inRocket: !!p.inRocket,
    };
  }

  // 把存档中的玩家状态写回实例（读档与新游戏都会走这里）
  applyPlayerState(ps) {
    if (!ps) return;
    const num = (v, d) => (Number.isFinite(v) ? v : d);
    this.playerMaxHealth = num(ps.maxHealth, 100);
    this.playerMaxShield = num(ps.maxShield, 100);
    this.playerHealth = clamp(num(ps.health, this.playerMaxHealth), 0, this.playerMaxHealth);
    this.playerShield = clamp(num(ps.shield, this.playerMaxShield), 0, this.playerMaxShield);
    if (this.weapon) {
      this.weapon.maxEnergy = 100;
      this.weapon.energy = clamp(num(ps.energy, 100), 0, 100);
      this.weapon.mode = [0, 1, 2].includes(ps.weaponMode) ? ps.weaponMode : 0;
      this.weapon.cooldown = 0;
      this.weapon.burstCount = 0;
    }
    this.player.inRocket = false;
    if (Number.isFinite(ps.x) && Number.isFinite(ps.z)) {
      // BUG-05：镜头朝向由存档恢复，不再被 beginExplore 覆盖
      this.player.teleport(ps.x, ps.z, num(ps.yaw, 0));
      if (Number.isFinite(ps.camYaw)) this.player.camYaw = ps.camYaw;
      if (Number.isFinite(ps.camPitch)) this.player.camPitch = clamp(ps.camPitch, -1.15, 0.85);
      this.savedCamera = { camYaw: this.player.camYaw, camPitch: this.player.camPitch };
    }
  }

  // 解锁状态 → 实际数值（BUG-04：读档后必须恢复伤害与 HUD 标识）
  applyUnlocks() {
    const u = this.unlocked || {};
    if (this.weapon) this.weapon.damage = (u.weapon || 1) >= 2 ? 26 : 18;
    const lv = document.querySelector('.wp-lv');
    if (lv) lv.textContent = (u.weapon || 1) >= 2 ? 'MK.II' : 'MK.I';
    this.playerMaxShield = (u.shield || 0) >= 1 ? 140 : 100;
    this.playerShield = Math.min(this.playerShield, this.playerMaxShield);
  }

  // BUG-08：开新档必须把上一局的运行态全部清空
  resetRunState() {
    this.inventory = EMPTY_INV();
    this.planetBases = {};
    this.planetStates = {};
    this.objectiveState = { step: 0, done: 0 };
    this.unlocked = { weapon: 1, shield: 0 };
    this.playerMaxHealth = 100;
    this.playerHealth = 100;
    this.playerMaxShield = 100;
    this.playerShield = 100;
    this.damageFlash = 0;
    this.cameraShake = 0;
    this.scanActiveT = 0;
    this.scanCooldown = 0;
    this.scanPulse = 0;
    if (this.weapon) {
      this.weapon.damage = 18;
      this.weapon.energy = 100;
      this.weapon.maxEnergy = 100;
      this.weapon.mode = 0;
      this.weapon.cooldown = 0;
      this.weapon.heat = 0;
      this.weapon.burstCount = 0;
      this.weapon.burstTimer = 0;
      this.weapon.recoil = 0;
    }
    if (this.building) {
      this.building.clear();
      this.building.cancelPlacing();
      this.building.power = 0;
      this.building.gen = 0;
      this.building.use = 0;
      this.building.produceTimer = 0;
    }
    // BUG-33 / BUG-45：新一局不能残留上一局的弹道、枪口闪光与引擎声
    if (this.weapon) this.weapon.clearEffects();
    this.audio?.setEngine(0, 0);
    this.input?.reset();
    this.landingOnPad = false;
    this.landingPadTop = 0;
    this.savedCamera = null;
    this.objectiveState.fromPlanet = null;
    document.body.classList.remove('flying');
    this.ui.setBuildingMode(false);
    this.ui.showPrompt('');
    this.ui.setObjective(null);
    this.applyUnlocks();
  }

  toMenu() {
    const res = this.save();
    document.getElementById('pause').classList.add('hidden');
    this.paused = false;
    if (!res.ok) this.ui.toast('离开前保存失败，本次进度可能丢失', 'warn');
    this.input.enabled = true;
    this.input.reset();
    this.input.releaseLock();
    this.showMenu();
  }

  // ================= 任务链 =================
  setObjective() {
    const st = this.objectiveState;
    const steps = [
      { key: 'ferrite', need: 5, text: '采集 铁素矿（◆）', inv: 'ferrite' },
      { key: 'build', need: 1, text: '建造 居住舱（按 B 进入建造模式）', }
    ];
    if (st.step === 0) {
      const have = Math.max(st.done, Math.min(this.inventory.ferrite, 5));
      this.ui.setObjective({ text: '采集 铁素矿（◆）', need: 5 });
      this.ui.updateObjectiveProgress(have, 5);
      if (this.inventory.ferrite >= 5) { st.step = 1; st.done = 0; }
    }
    if (st.step === 1) {
      this.ui.setObjective({ text: '建造一座 居住舱（B 键进入建造模式）', need: 1 });
      const hasHabitat = this.building.items.some((i) => i.type === 'habitat');
      this.ui.updateObjectiveProgress(hasHabitat ? 1 : 0, 1);
      if (hasHabitat) {
        st.step = 2;
        this.ui.dialogue('航行日志', '基地的第一块地板已经铺下。接下来，我想去看看这片蕨海之外的地方——登上火箭，去另一颗星球。', 8);
      }
    }
    if (st.step === 2) {
      const dest = st.fromPlanet || this.currentPlanetId;
      const others = PLANET_ORDER.filter((x) => x !== dest).map((x) => PALETTES[x].name).join(' / ');
      this.ui.setObjective({ text: `登上火箭（靠近舱门按 E），飞往 ${others}`, need: 1 });
      this.ui.updateObjectiveProgress(0, 1);
    }
    if (st.step >= 3) this.ui.setObjective(null);
  }

  advanceObjective(evt) {
    const st = this.objectiveState;
    if (evt === 'collect' && st.step === 0) {
      const have = Math.min(this.inventory.ferrite, 5);
      this.ui.updateObjectiveProgress(have, 5);
      if (have >= 5) {
        st.step = 1;
        this.ui.toast('目标更新：建造一座居住舱', 'ok');
        setTimeout(() => this.setObjective(), 400);
      }
    }
  }

  // ================= 事件回调 =================
  onFootstep(pos, run) {
    this.audio.play('step', { vol: run ? 1.15 : 0.85 });
    if (this.grounded !== false && this.vegetation) {
      // 在脚下产生轻微尘土（使用喷尘系统的小规模发射）
      if (this.dustPlume && run) this.dustPlume.userData.emit(pos.clone().add(new THREE.Vector3(0, 0.05, 0)), 0.25, 0.4);
    }
  }

  onLand(pos, impact) {
    this.audio.play('land');
    this.cameraShake = Math.max(this.cameraShake || 0, impact * 0.5);
  }

  onHitFeedback(point, weak, killed) {
    this.audio.play('hit', { crit: weak });
    if (weak) this.ui.toast('弱点命中！', 'ok');
    this.hitMarkerT = 0.3;
    this.cameraShake = Math.max(this.cameraShake || 0, 0.1);
  }

  onHitEnvironment(point, normal) {
    this.audio.play('hit', { vol: 0.5 });
  }

  // BUG-03：击杀生物掉落样本/生物质，让科研站与护盾升级可以真正达成
  onCreatureKilled(c) {
    const def = c.def || {};
    const hostile = !!def.hostile;
    const sample = hostile ? 1 : 2;
    const bio = hostile ? 1 : 1;
    this.inventory.sample = (this.inventory.sample || 0) + sample;
    this.inventory.bio = (this.inventory.bio || 0) + bio;
    this.ui?.toast(`+${sample} 样本 · +${bio} 生物质 · ${def.name || '生物'}`, 'ok');
    this.audio.play('pickup');
    // 战利品自死亡位置向上飘散，给出可见反馈
    this.spawnPickupFx(c.pos ? c.pos.clone().add(new THREE.Vector3(0, 0.6, 0)) : new THREE.Vector3());
  }

  onCreatureAttack(creature, dmg) {
    this.damagePlayer(dmg);
    this.audio.play('hurt');
    this.cameraShake = Math.max(this.cameraShake || 0, 0.5);
  }

  damagePlayer(dmg) {
    if (this.playerShield > 0) {
      const absorbed = Math.min(this.playerShield, dmg);
      this.playerShield -= absorbed;
      dmg -= absorbed;
    }
    if (dmg > 0) {
      this.playerHealth -= dmg;
      this.player.astronaut.params.hurt = 1;
    }
    this.damageFlash = 0.8;
    this.ui.setDamage?.(1);
    if (this.playerHealth <= 0) this.respawn();
  }

  respawn() {
    this.playerHealth = this.playerMaxHealth;
    this.playerShield = this.playerMaxShield;
    // BUG-49：优先在已建成的居住舱旁重生；没有居住舱才回到登陆点
    const hab = this.building?.respawnHabitat(this.player.pos);
    let spawn;
    if (hab) {
      // 在居住舱外侧找一个不被阻挡的落点
      let best = null;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const r = (hab.def.colliderR || 1.4) + 1.0;
        const x = hab.pos.x + Math.cos(a) * r;
        const z = hab.pos.z + Math.sin(a) * r;
        if (!this.player._solidCircle(x, z)) { best = { x, z, yaw: a }; break; }
      }
      spawn = best || (() => {
        const s = this.spawnPoints(this.currentPlanetId).player;
        return { x: s.x, z: s.z, yaw: s.yaw };
      })();
    } else {
      spawn = this.spawnPoints(this.currentPlanetId).player;
    }
    this.player.teleport(spawn.x, spawn.z, spawn.yaw);
    // BUG-20：瞬移后镜头同步归位，不再从旧位置横穿场景追过来
    this.player.snapCamera(this.camera);
    this.ui.fadeTo(1, 400);
    setTimeout(() => this.ui.fadeTo(0, 1200), 500);
    this.ui.dialogue('紧急复苏协议', hab
      ? '生命维持系统已重启。你在最近的居住舱旁醒来。'
      : '生命维持系统已重启。你在登陆点附近醒来。', 5);
  }

  onBuild(item) {
    if (item.type === 'habitat') this.setObjective();
    this.planetBases[this.currentPlanetId] = this.building.serialize();
  }

  // ================= 飞行回调 =================
  onFlightPhase(p) {
    const ui = this.ui;
    // 任何飞行阶段都不应残留地面交互提示 / 建造条 / 建造预览
    ui.showPrompt('');
    ui.setBuildingMode(false);
    document.body.classList.toggle('flying', p !== 'ground');
    if (p === 'board' || p === 'cockpit' || p === 'launch') {
      document.getElementById('crosshair').classList.add('hidden');
    }
    if (p === 'launch') {
      ui.setCockpit(false);
      document.body.classList.add('cinematic');
    }
    if (p === 'space') {
      ui.setCockpit(false);
      ui.setSpaceHud(true);
      document.getElementById('crosshair').classList.add('hidden');
      ui.crosshairSpace(true);
      ui.dialogue('航行日志', '我们离开了「' + PALETTES[this.currentPlanetId].name + '」的引力。远处的另两颗微光星球正在缓慢地互相绕转。', 8);
    }
    if (p === 'approach') {
      ui.setSpaceHud(false);
      ui.crosshairSpace(false);
      ui.toast('进入 ' + PLANET_INFO[this.flight.targetPlanet].subtitle + ' 引力井，开始再入', 'info');
      this.audio.play('warp');
    }
    if (p === 'landing') {
      document.body.classList.add('cinematic');
      ui.setCockpit(false);
    }
    if (p === 'doors') {
      this.audio.play('heavyLand', { vol: 0.5 });
    }
    if (p === 'ground') {
      document.body.classList.remove('flying');
      document.getElementById('crosshair').classList.remove('hidden');
      ui.crosshairSpace(false);
    }
  }

  enterCockpit() {
    this.mode = 'cockpit';
    this.ui.setCockpit(true);
    this.ui.setSpaceHud(false);
    document.getElementById('cp-target').textContent = PLANET_ORDER.filter((x) => x !== this.currentPlanetId).map((x) => PALETTES[x].name).join(' / ');
    this.input.releaseLock();
    // 驾驶舱视角：机头前方的外景
    this.cockpitT = 0;
  }

  exitPlanetToSpace() {
    // 隐藏地表，显示太空
    this.mode = 'space';
    document.getElementById('hud').classList.remove('hidden');
    this.ui.setSpaceHud(true);
    this.planetSceneVisible(false);
    this.spaceSystem.setVisible(true);
    this.player.object.visible = false;
    this.ui.planetMarker(false);
  }

  // 场景可见性切换（对尚未初始化的子系统保持容错）
  planetSceneVisible(v) {
    if (this.terrain) this.terrain.group.visible = v;
    if (this.skyMesh) this.skyMesh.visible = v;
    if (this.vegetation) this.vegetation.group.visible = v;
    if (this.water) this.water.visible = v;
    if (this.motes) this.motes.visible = v;
    if (this.resources) this.resources.group.visible = v;
    if (this.ecosystem) this.ecosystem.group.visible = v;
    if (this.building) this.building.group.visible = v;
    if (this.dustPlume) this.dustPlume.visible = v && this.dustPlume.visible;
  }

  // BUG-40 / BUG-51：在恢复基地之后挑选落点——
  // 优先合法停机坪；否则搜索一块既满足飞船占地、又不压住基地建筑/植被的平坦地面；
  // 全部失败时回退到默认宜居点并给出提示（而不是直接砸进居住舱）。
  findLandingSpot(id) {
    const t = this.terrain;
    const sp = this.spawnPoints(id);
    const ROCKET_R = 2.6;      // 飞船占地半径
    const SAFE_R = 4.2;        // 出舱安全区
    const pad = this.building?.landingPadNear(sp.player.x, sp.player.z, 60);
    if (pad) {
      return { x: pad.pos.x, z: pad.pos.z, y: t.height(pad.pos.x, pad.pos.z), pad: true };
    }
    const clearAt = (x, z) => {
      // 与已有建筑的飞船占地 + 安全区都要空出来
      for (const it of this.building.items) {
        const def = it.def || BUILDINGS[it.type] || {};
        const r = (def.colliderR || def.size[0] * 0.5) + ROCKET_R;
        if (Math.hypot(it.pos.x - x, it.pos.z - z) < r) return false;
      }
      // 植被与树木
      if (this.vegetation?.blocked(x, z, ROCKET_R)) return false;
      if (this.vegetation?.blocked(x, z, SAFE_R * 0.5)) return false;
      // 地形条件
      if (t.slopeAt(x, z) > 0.16) return false;
      if (t.height(x, z) < t.waterLevel + 1.6) return false;
      return true;
    };
    // 从宜居点向外按同心环搜索
    let best = null;
    if (clearAt(sp.player.x, sp.player.z)) best = { x: sp.player.x, z: sp.player.z };
    const baseAng = Math.atan2(sp.player.x, sp.player.z);
    for (let ring = 1; ring <= 8 && !best; ring++) {
      const rad = ring * 7;
      for (let i = 0; i < 16 && !best; i++) {
        const ang = baseAng + (i / 16) * Math.PI * 2;
        const x = sp.player.x + Math.cos(ang) * rad;
        const z = sp.player.z + Math.sin(ang) * rad;
        if (Math.hypot(x, z) > 250) continue;
        if (clearAt(x, z)) best = { x, z };
      }
    }
    if (!best) {
      // 回退：沿用原来的坡度/水位搜索，但至少保证不与建筑同心
      let px = sp.player.x, pz = sp.player.z, guard = 0;
      while ((t.slopeAt(px, pz) > 0.16 || t.height(px, pz) < t.waterLevel + 1.6 ||
        this.building.items.some((it) => Math.hypot(it.pos.x - px, it.pos.z - pz) < 5)) && guard++ < 80) {
        px *= 1.06; pz *= 1.06;
      }
      best = { x: px, z: pz };
    }
    best.y = t.height(best.x, best.z);
    return best;
  }

  startLandingScene(id) {
    // 切换地表星球为 id（重建），飞船在半空
    this.mode = 'landing';
    this.planetSceneVisible(false);
    this.spaceSystem.setVisible(false);
    this.loadPlanetSync(id);
    // BUG-40：基地此时已恢复，落点搜索必须避开它们
    const t = this.terrain;
    const spot = this.findLandingSpot(id);
    const px = spot.x, pz = spot.z;
    const gy = spot.y;
    const s = this.rocket.group;
    s.position.set(px, gy + 40, pz);
    s.quaternion.identity();
    this.landingStartY = gy + 40;
    this.flight.landingYaw = Math.atan2(px, pz) + 0.4;
    this.flight.shipPos.copy(s.position);
    this.rocket.throttle = 0.8;
    this.player.pos.set(px, t.height(px, pz), pz);
    this.player.inRocket = true;
    this.player.object.visible = false;
    this.planetSceneVisible(true);
    this.spaceSystem.setVisible(false);
    this.rocket.group.visible = true;
    document.getElementById('hud').classList.remove('hidden');
    this.ui.setSpaceHud(false);
    this.audio.play('heavyLand', { vol: 0.4 });
    // BUG-51：停机坪着陆时船体高度抬到平台面，并播放补给反馈
    this.landingOnPad = !!spot.pad;
    if (spot.pad) {
      const padItem = this.building.landingPadNear(px, pz, 60);
      this.landingPadTop = padItem ? padItem.def.size[1] : 0.5;
      this.rocket.group.position.y = gy + 40 + this.landingPadTop;
      this.landingStartY = gy + 40 + this.landingPadTop;
      this.ui.toast('已锁定停机坪航线', 'ok');
    } else {
      this.landingPadTop = 0;
    }
  }

  finishLanding() {
    this.mode = 'surface';
    this.player.inRocket = false;
    this.player.object.position.copy(this.player.pos);
    document.body.classList.remove('cinematic');
    // BUG-45：着陆完成后引擎声必须归零（此时阶段已回到 ground）
    this.audio.setEngine(0, 0);
    if (this.landingOnPad) {
      // BUG-51：停机坪补给
      this.playerHealth = this.playerMaxHealth;
      this.playerShield = this.playerMaxShield;
      if (this.weapon) this.weapon.energy = this.weapon.maxEnergy;
      this.ui.toast('停机坪补给完成：生命 / 护盾 / 能量已充满', 'ok');
      this.audio.play('chime');
    }
    // 出舱最后一帧已使用地表控制器，保留镜头与跟随状态，避免交接时二次跳位。
    this.player.object.visible = true;
    this.cameraShake = 0;
    this.fovCurrent = 55;
    this.setObjective();
    const info = PLANET_INFO[this.currentPlanetId];
    this.ui.dialogue('航行日志', `${info.desc}`, 9);
    this.audio.setPlanet(this.currentPlanetId);
    this.planetBases[this.currentPlanetId] = this.planetBases[this.currentPlanetId] || [];
    // BUG-42：任务只应在“抵达另一颗星球”时完成，飞回原星球不算
    const from = this.objectiveState.fromPlanet;
    const arrivedOther = !from || from !== this.currentPlanetId;
    if (this.objectiveState.step === 2 && arrivedOther) {
      this.objectiveState.step = 3;
      setTimeout(() => this.setObjective(), 600);
    } else if (this.objectiveState.step === 2) {
      this.objectiveState.fromPlanet = this.currentPlanetId;
      setTimeout(() => this.setObjective(), 600);
    }
    this.ui.toast('抵达 · ' + this.palette.name, 'ok');
    this.input.requestLock();
  }

  // ================= 主循环 =================
  loop(now) {
    requestAnimationFrame((t) => this.loop(t));
    const rawDt = (now - this.lastT) / 1000;
    this.lastT = now;
    let dt = Math.min(Math.max(rawDt, 0.0001), 0.05);
    if (this.paused) { this.renderOnly(); return; }
    this.time += dt;
    try {
      this.update(dt);
    } catch (e) {
      console.error(e);
    }
    this.renderOnly(dt);
  }

  renderOnly(dt = 0.016) {
    if (!this.engine) return;
    // 调试用：debugPasses 可逐 pass 关闭后期链（定位渲染问题）
    if (this.debugPasses) {
      const eng = this.engine;
      eng.composer.passes.forEach((p, i) => { p.enabled = !this.debugSkip.includes(i); });
      eng.render(dt);
      return;
    }
    this.engine.render(dt);
  }

  update(dt) {
    const t = this.time;
    // 暂停中不会走到这里（loop 提前返回），所以 input.pause 只用于“进入暂停”方向，
    // 避免与 bindGlobalEvents 的 Escape 处理重复触发形成来回抖动。
    const input = this.input.consume();
    if (input.pause && !this.paused && this.mode !== 'menu' && this.mode !== 'intro') {
      this.pause();
      return;
    }
    this.updateScan(dt);
    this.updateSkyAndLights(dt);

    // BUG-33：短生命周期特效与武器状态在任何阶段都推进，
    // 飞行/太空中弹道不会再冻结在原地等回到地面才消失。
    if (this.weapon && this.mode !== 'menu') this.weapon.update(dt);
    if (this.mode === 'menu') {
      this.updateMenuScene(dt, t);
    } else if (this.mode === 'surface') {
      this.updateSurface(dt, input, t);
    } else if (this.mode === 'intro') {
      this.updateIntro(dt);
    } else if (this.mode === 'cockpit') {
      this.updateCockpit(dt, input, t);
    } else if (this.mode === 'space') {
      this.mode = 'space';
      this.flight.update(dt, input);
      this.rocket.group.visible = true;
      this.updateFade();
    } else if (this.mode === 'landing') {
      this.flight.update(dt, input);
    } else if (this.mode === 'board' || this.mode === 'launch') {
      this.flight.update(dt, input);
    }
    // 通用：镜头震动衰减、宇航员与武器的可视化
    this.cameraShake = damp(this.cameraShake || 0, 0, 6, dt);
    this.damageFlash = damp(this.damageFlash || 0, 0, 3, dt);
    this.engine.grade.uniforms.uDamage.value = clamp(this.damageFlash + (this.playerHealth < 30 ? 0.25 + Math.sin(t * 4) * 0.08 : 0), 0, 1);
    this.engine.grade.uniforms.uSpeed.value = this.mode === 'space' ? this.speedFx || 0 : 0;
    this.engine.grade.uniforms.uVignette.value = this.mode === 'space' ? 1.3 : 1.0;
    document.getElementById('atmos-overlay').style.opacity = String(clamp(this.atmosOverlay || 0, 0, 1));
    // 宇航员可见性（驾驶/太空时隐藏）
    if (this.mode === 'space') this.player.object.visible = false;
    this.updateCameraFov(dt);
    this.ui.frame(dt);
    this.audio.updateAmbient(dt, t);
    this.audio.updateMusic(dt, this.mode === 'surface' ? 0.2 : 0.6);
    this.audio.setListener(this.camera);
  }

  updateCameraFov(dt) {
    const target = this.fovCurrent || 55;
    if (Math.abs(this.camera.fov - target) > 0.01) {
      this.camera.fov = damp(this.camera.fov, target, 4, dt);
      this.camera.updateProjectionMatrix();
    }
  }

  updateSkyAndLights(dt) {
    const t = this.time;
    if (this.skyMesh) {
      this.skyMesh.position.set(0, 0, 0);
      const u = this.skyMesh.material.uniforms;
      u.uTime.value = t;
      u.uStorm.value = this.mode === 'surface' && this.currentPlanetId === 'emer' ? 0.35 + Math.sin(t * 0.05) * 0.3 : 0;
      this.skyFade = 0;
    }
    if (this.sun) {
      // 阴影相机跟随玩家
      const p = this.player.pos;
      this.sun.target.position.set(p.x, p.y, p.z);
      this.sun.position.copy(this.sunDirVec).multiplyScalar(120).add(new THREE.Vector3(p.x, p.y, p.z));
    }
    if (this.terrain) this.terrain.update(this.camera, t);
    if (this.vegetation) this.vegetation.update(t);
    if (this.water) this.water.material.uniforms.uTime.value = t;
    if (this.motes) this.motes.userData.update(this.camera, t);
    if (this.dustPlume) this.dustPlume.userData.step(dt);
  }

  updateMenuScene(dt, t) {
    // 主菜单：缓慢环绕宇航员与微缩景观
    this.menuTime = (this.menuTime || 0) + dt;
    const a = this.menuTime * 0.08 - 2.4;
    const p = this.player.pos;
    this.camera.position.set(p.x + Math.cos(a) * 7.5, p.y + 2.6 + Math.sin(this.menuTime * 0.2) * 0.3, p.z + Math.sin(a) * 7.5);
    this.camera.lookAt(p.x, p.y + 1.1, p.z);
    this.camera.up.set(0, 1, 0);
    this.fovCurrent = 42;
    this.player.object.visible = true;
    this.player.object.position.copy(p);
    this.player.yaw = Math.sin(t * 0.3) * 0.6 + 0.6;
    this.player.object.rotation.set(0, this.player.yaw, 0);
    this.player.astronaut.update(dt, { speed: 0, aiming: false, airborne: false, gathering: false, building: false, crouching: false, pitch: 0 });
    this.rocket.update(dt, t);
    this.ecosystem.update(dt, this.player);
    // 菜单时让生物缓慢游荡
    this.player.inRocket = true; // 防止生物攻击
  }

  updateIntro(dt) {
    const p = this.player.pos;
    const k = clamp(this.modeT = (this.modeT || 0) + dt, 0, 2);
    const target = new THREE.Vector3(p.x + Math.sin(this.player.camYaw) * 5, p.y + 2.2, p.z + Math.cos(this.player.camYaw) * 5);
    this.camera.position.lerp(target, 1 - Math.exp(-1.2 * dt));
    this.camera.lookAt(p.x, p.y + 0.55, p.z);
    this.fovCurrent = 50;
    this.modeT = 0;
    this.player.astronaut.update(dt, { speed: 0, aiming: false, airborne: false, gathering: false, building: false, crouching: false, pitch: 0 });
    this.ecosystem.update(dt, this.player);
    this.rocket.update(dt, this.time);
    if (!this.player.inRocket) this.player.inRocket = false;
  }

  updateCockpit(dt, input, t) {
    // 舱内视角：坐在驾驶座上，视线穿过舱盖朝机头方向看
    const ship = this.rocket.group;
    const yaw = ship.rotation.y;
    // 舷窗外缘前方：机身是不透明闭合网格，眼点留在机身内部会看到被近裁面切开的腰环。
    const eyeOff = new THREE.Vector3(0, 2.35, 0.85).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const eye = ship.position.clone().add(eyeOff);
    // 看向船头前方（局部 -Z 为舱门，+Z 为机头方向）
    const lookOff = new THREE.Vector3(0, 2.1, 6.5).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const look = ship.position.clone().add(lookOff);
    this.camera.position.lerp(eye, 1 - Math.exp(-4 * dt));
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(look);
    this.fovCurrent = 70;
    this.rocket.update(dt, t);
    this.ecosystem.update(dt, this.player);
    document.getElementById('cp-thrust').textContent = '待机 · 确认发射';
    // BUG-38：发射同样使用独立确认（E/Enter 保持为“交互”，F 为“降落/出发”）
    if (input.interact || input.keys.has('Enter')) {
      // 选择下一颗星球
      const others = PLANET_ORDER.filter((x) => x !== this.currentPlanetId);
      if (this.objectiveState.step === 2 && !this.objectiveState.fromPlanet) {
        this.objectiveState.fromPlanet = this.currentPlanetId;
      }
      this.flight.beginLaunch(others[0]);
      this.mode = 'launch';
      this.ui.setCockpit(false);
      this.input.requestLock();
    }
  }

  updateSurface(dt, input, t) {
    const P = this.player;
    const cam = this.camera;
    // 镜头旋转
    if (input.mouseDX || input.mouseDY) P.look(input.mouseDX, input.mouseDY);
    // BUG-08：摇杆已在统一输入层折算进 forward/strafe（地面与太空共用），这里只补冲刺
    if (input.touchActive && Math.abs(this.input.touch.move.y) > 0.85) input.sprint = true;
    this.weaponJitter = 0;
    if (input.mode) this.weapon.switchMode();

    // 建造模式
    if (input.build) {
      if (this.ui.building) {
        if (this.building.ghostType) { this.ui.setBuildingMode(false); this.building.cancelPlacing(); }
        else { this.ui.setBuildingMode(false); }
      } else {
        this.ui.setBuildingMode(true, null);
      }
    }
    // 建造中数字键选择
    if (this.ui.building) {
      const keys = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6'];
      keys.forEach((k, i) => {
        if (input.keys.has(k)) {
          const type = ['habitat', 'solar', 'miner', 'storage', 'lab', 'pad'][i];
          this.building.startPlacing(type);
          this.ui.setBuildingMode(true, type);
        }
      });
      // BUG-09：R 键与触屏“旋”按钮都能旋转预览
      if (input.reload) this.building.rotate(1);
      if (input.mouseDX) this.building.rotate(0);
    }

    // 射击 / 瞄准
    P.aiming = input.aim;
    document.body.classList.toggle('aiming', P.aiming);
    if (input.fire) this.weapon.tryFire(cam, true);
    // 跳跃
    if (input.jump && P.grounded && !this.ui.building) {
      P.jump();
      this.audio.play('jump');
    }

    // 交互检测
    const interact = this.findInteraction();
    this.updatePrompt(interact);

    if (input.interact) {
      if (this.ui.building && this.building.ghostType) {
        this.building.confirm();
        // 保持建造模式，方便连续放置；按 B 才退出
        this.ui.setBuildingMode(true, this.building.ghostType || null);
      } else if (interact) {
        interact.action();
      }
    }
    // 采集动画
    if (this.gatherTimer > 0) {
      this.gatherTimer -= dt;
      P.gathering = true;
      P.faceCameraForward();
      if (this.gatherTimer <= 0) P.gathering = false;
    } else P.gathering = false;
    P.building = !!this.building.ghostType;

    // 扫描
    if (input.scan) this.scan();

    // 玩家更新
    if (P.inRocket) {
      // 登船流程中由 FlightSystem 控制
    } else if (this.flight.phase === 'ground') {
      P.update(dt, input, cam);
      this.playerHealth = Math.min(this.playerMaxHealth, this.playerHealth + dt * 0.6);
      P.object.visible = true;
    }

    // 登船判定
    if (this.flight.phase === 'ground' && !P.inRocket) {
      const rp = this.rocket.group.position;
      const d = Math.hypot(rp.x - P.pos.x, rp.z - P.pos.z);
      if (d < 3.6) {
        const toDoor = new THREE.Vector3(0, 0, -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.rocket.group.rotation.y);
        // 门方向与玩家朝向一致性不再强制
        this.tryBoard = true;
      } else this.tryBoard = false;
    }

    // 子对象更新（weapon.update 已移到通用循环，见 update()）
    this.rocket.update(dt, t);
    this.ecosystem.update(dt, P);
    this.resources.update(dt);
    this.building.update(dt, P);
    this.building.updateGhost(cam, P, dt);
    if (this.ui.building) this.ui.setBuildingMode(true, this.building.ghostType);

    // 粒子跟随
    if (this.motes) this.motes.userData.update(cam, t);
    // 进入太空的失败保护
    this.updateFade();
  }

  findInteraction() {
    const P = this.player;
    const list = [];
    // 1. 火箭（优先级最高：靠近舱门即可登船）
    const rp = this.rocket.group.position;
    const dRocket = Math.hypot(rp.x - P.pos.x, rp.z - P.pos.z);
    if (dRocket < 5.2 && this.flight.phase === 'ground' && !P.inRocket) {
      list.push({
        d: dRocket - 10, label: '登上火箭 · 前往太空', key: 'E',
        action: () => {
          // BUG-42：记录任务出发星球，用于判断“是否真的抵达了另一颗星球”
          if (this.objectiveState.step === 2 && !this.objectiveState.fromPlanet) {
            this.objectiveState.fromPlanet = this.currentPlanetId;
          }
          P.inRocket = true;
          this.mode = 'board';
          this.flight.beginBoard();
        },
      });
    }
    // 2. 采集资源
    const node = this.resources.nearest(P.pos, null, 2.8);
    if (node) {
      const def = RESOURCE_DEFS[node.type];
      list.push({ d: Math.hypot(node.pos.x - P.pos.x, node.pos.z - P.pos.z), label: `采集 ${def.name}`, key: 'E', action: () => this.harvest(node) });
    }
    // 3. 建筑（BUG-25：交互入口先检查建成与供电状态）
    const b = this.building.nearest(P.pos);
    if (b) {
      const def = BUILDINGS[b.type];
      const operational = this.building.isOperational(b);
      let label;
      let act;
      if (!operational && b.built < 1) {
        label = def.name + ' · 建造中…';
        act = () => this.ui.toast('还在建造中，请稍候', 'info');
      } else if (!operational) {
        label = def.name + ' · 电力不足';
        act = () => this.ui.toast('电力不足：先建造太阳能阵列', 'warn');
      } else if (b.type === 'lab') {
        label = '科研站 · 分析样本';
        act = () => this.research();
      } else if (b.type === 'habitat') {
        label = def.name + ' · ' + def.desc;
        act = () => {
          this.playerHealth = this.playerMaxHealth;
          this.playerShield = this.playerMaxShield;
          this.ui.toast('在居住舱内完成整备：生命与护盾已恢复', 'ok');
          this.audio.play('chime');
        };
      } else if (b.type === 'storage') {
        label = def.name + ` · 容量 ${this.building.totalCapacity()}`;
        act = () => this.ui.toast(`存储容量 ${this.building.totalCapacity()} · 资源已自动入库`, 'info');
      } else if (b.type === 'pad') {
        label = def.name + ' · 补给与起降';
        act = () => {
          this.playerHealth = this.playerMaxHealth;
          this.playerShield = this.playerMaxShield;
          this.weapon.energy = this.weapon.maxEnergy;
          this.ui.toast('停机坪补给完成：生命 / 护盾 / 能量已充满', 'ok');
          this.audio.play('chime');
        };
      } else {
        label = def.name + ' · ' + def.desc;
        act = () => this.ui.toast(def.desc, 'info');
      }
      list.push({ d: b.pos.distanceTo(P.pos), label, key: 'E', action: act });
    }
    list.sort((a, b2) => a.d - b2.d);
    return list[0] || null;
  }

  updatePrompt(interact) {
    if (this.ui.building && this.building.ghostType) {
      const label = this.building.valid ? '确认建造' : (this.building.blockReason || '无法在此建造');
      this.ui.showPrompt(label, 'E');
      return;
    }
    if (this.ui.building) {
      this.ui.showPrompt('选择建筑 · 数字键 1-6 · R 旋转 · B 退出', 'B');
      return;
    }
    this.ui.showPrompt(interact ? interact.label : '');
  }

  harvest(node) {
    // BUG-37：执行采集时再校验一次三维距离/遮挡，避免“隔墙采集”
    const res = this.resources.harvest(node, this.player.pos);
    if (!res) {
      this.ui.toast('目标不可达', 'warn');
      return;
    }
    this.inventory[res.type] = (this.inventory[res.type] || 0) + res.amount;
    const def = RESOURCE_DEFS[res.type];
    this.audio.play('pickup');
    this.ui.toast(`+${res.amount} ${def.name}`, 'ok');
    this.gatherTimer = 0.55;
    this.advanceObjective('collect');
    this.planetBases[this.currentPlanetId] = this.building.serialize();
    // 采集物飞入宇航员（视觉反馈）
    this.spawnPickupFx(node.pos);
  }

  spawnPickupFx(pos) {
    const geo = new THREE.IcosahedronGeometry(0.12, 0);
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(this.palette.accent) });
    const m = new THREE.Mesh(geo, mat);
    m.position.copy(pos).add(new THREE.Vector3(0, 0.4, 0));
    this.scene.add(m);
    const start = m.position.clone();
    let life = 0.6;
    const tick = () => {
      life -= 0.016;
      const k = 1 - Math.max(0, life) / 0.6;
      const target = this.player.pos.clone().add(new THREE.Vector3(0, 0.4, 0));
      m.position.lerpVectors(start, target, k);
      m.position.y += Math.sin(k * Math.PI) * 0.6;
      m.scale.setScalar(1 - k * 0.7);
      if (life > 0) requestAnimationFrame(tick);
      else { this.scene.remove(m); geo.dispose(); mat.dispose(); }
    };
    requestAnimationFrame(tick);
  }

  // BUG-07：武器与护盾是两条独立升级线，互不阻塞、不可重复消耗
  research() {
    // BUG-25：科研交互必须确认科研站已建成且供电，而不是只看耗电账面
    const lab = this.building.items.find((it) => it.type === 'lab' &&
      Math.hypot(it.pos.x - this.player.pos.x, it.pos.z - this.player.pos.z) <= 4.5);
    if (lab) {
      if (lab.built < 1) { this.ui.toast('科研站还在建造中', 'info'); return; }
      if (!this.building.isOperational(lab)) { this.ui.toast('科研站电力不足，无法分析样本', 'warn'); this.audio.play('uiError'); return; }
    }
    const weaponDone = (this.unlocked.weapon || 1) >= 2;
    const shieldDone = (this.unlocked.shield || 0) >= 1;
    const canWeapon = !weaponDone && (this.inventory.sample || 0) >= 2;
    const canShield = !shieldDone && (this.inventory.bio || 0) >= 3;
    if (canWeapon) {
      this.inventory.sample -= 2;
      this.applyWeaponUpgrade();
      this.audio.play('chime');
      return;
    }
    if (canShield) {
      this.inventory.bio -= 3;
      this.applyShieldUpgrade();
      this.audio.play('chime');
      return;
    }
    if (weaponDone && shieldDone) {
      this.ui.toast('当前已有全部已解锁模块', 'info');
      return;
    }
    // 仍有可升级项但材料不足：给出明确指引
    const need = [];
    if (!weaponDone) need.push(`样本 2（现有 ${this.inventory.sample || 0}）`);
    if (!shieldDone) need.push(`生物质 3（现有 ${this.inventory.bio || 0}）`);
    this.ui.toast(`材料不足：还需 ${need.join(' 或 ')}`, 'warn');
    this.audio.play('uiError');
  }

  // 武器 MK.II：实例伤害与 HUD 标识一起改，供读档复用（BUG-04 配套）
  applyWeaponUpgrade() {
    this.unlocked.weapon = 2;
    if (this.weapon) this.weapon.damage = 26;
    const lv = document.querySelector('.wp-lv');
    if (lv) lv.textContent = 'MK.II';
    this.ui.toast('武器升级：MK.II · 伤害 18 → 26', 'ok');
  }

  // 护盾扩容：上限与当前值同步，且只生效一次
  applyShieldUpgrade() {
    this.unlocked.shield = 1;
    this.playerMaxShield = 140;
    this.playerShield = 140;
    this.ui.toast('护盾扩容完成 · 护盾上限 +40', 'ok');
  }

  // BUG-10：扫描不再是纯提示音，而是限时/限半径的真实探测
  scan() {
    if ((this.scanCooldown || 0) > 0) {
      this.ui.toast(`扫描仪冷却中 ${Math.ceil(this.scanCooldown)}s`, 'warn');
      return;
    }
    this.audio.play('scan');
    this.scanPulse = 1;
    this.scanActiveT = SCAN_DURATION;
    this.scanCooldown = SCAN_COOLDOWN;
    this.scanRadius = SCAN_RADIUS;
    this.scanOrigin = this.player.pos.clone();
    const n = this.resources.nodes.filter((nd) => !nd.harvested &&
      Math.hypot(nd.pos.x - this.scanOrigin.x, nd.pos.z - this.scanOrigin.z) <= SCAN_RADIUS).length;
    const c = this.ecosystem.list.filter((cr) => !cr.dead &&
      Math.hypot(cr.pos.x - this.scanOrigin.x, cr.pos.z - this.scanOrigin.z) <= SCAN_RADIUS).length;
    this.ui.toast(`环境扫描完成 · 标记 ${n} 处资源 / ${c} 个生物（${SCAN_DURATION}s）`, 'ok');
  }

  updateScan(dt) {
    if (this.scanActiveT > 0) this.scanActiveT = Math.max(0, this.scanActiveT - dt);
    if (this.scanCooldown > 0) this.scanCooldown = Math.max(0, this.scanCooldown - dt);
    if (this.scanPulse > 0) this.scanPulse = Math.max(0, this.scanPulse - dt * 0.8);
  }

  updateFade() {
    // 飞行中屏幕淡入的遮罩由 UI 控制
  }
}

// ================= 启动 =================
if (typeof window !== 'undefined') {
  window.addEventListener('error', (e) => {
    const box = document.getElementById('error-box');
    if (!box) return;
    box.classList.remove('hidden');
    box.textContent = '错误：' + e.message + '\n' + (e.error && e.error.stack || '');
  });
}

// 浏览器环境才自动启动；Node 下可安全 import 本模块做单元验证。
if (typeof document !== 'undefined' && typeof HTMLCanvasElement !== 'undefined') {
  const canvas = document.getElementById('scene');
  if (canvas && canvas.getContext) {
    const game = new Game(canvas);
    window.__LC__ = game;
    game.boot();
  }
}
