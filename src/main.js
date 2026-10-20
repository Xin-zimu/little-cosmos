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
import { BuildingSystem, BUILDINGS } from './base/building.js';
import { UI } from './ui/ui.js';
import { clamp, damp, lerp } from './core/noise.js';

const SAVE_KEY = 'little-cosmos-save-v1';
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
      if (e.code === 'Escape') {
        if (this.paused) this.resume(); else this.pause();
      }
    });
    this.canvas.addEventListener('mousedown', () => {
      if (this.mode === 'surface' && !this.ui.building) this.input.requestLock();
    });
    document.addEventListener('pointerlockchange', () => {
      if (!document.pointerLockElement && this.mode === 'surface' && !this.paused && !this.flight.launching) {
        // 指针锁定丢失（Esc）→ 暂停提示
      }
    });
    window.addEventListener('resize', () => this.ui && this.ui.buildMiniTerrain());
  }

  // ================= 星球加载 =================
  clearPlanet() {
    if (this.terrain) {
      this.scene.remove(this.terrain.group);
      this.terrain.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
      this.terrain = null;
    }
    if (this.skyMesh) { this.scene.remove(this.skyMesh); this.skyMesh = null; }
    if (this.vegetation) {
      this.scene.remove(this.vegetation.group);
      this.vegetation.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
      this.vegetation = null;
    }
    if (this.water) { this.scene.remove(this.water); this.water = null; }
    if (this.motes) { this.scene.remove(this.motes); this.motes = null; }
    if (this.ecosystem) this.ecosystem.clear();
    if (this.resources) { this.scene.remove(this.resources.group); this.resources = null; }
    if (this.sun) { this.scene.remove(this.sun); this.scene.remove(this.sun.target); this.sun = null; }
    if (this.hemi) { this.scene.remove(this.hemi); this.hemi = null; }
    if (this.building) this.building.clear();
    this.ui.mmTerrain = null;
    this.ui.mmHeights = null;
  }

  loadPlanetSync(id) {
    const prevMode = this.mode;
    this.clearPlanet();
    this.currentPlanetId = id;
    const pal = PALETTES[id];
    this.palette = pal;
    const def = { biome: pal.biome, seed: { verdant: 11, emer: 23, lumina: 37 }[id], extent: 300, waterLevel: { verdant: -3.4, emer: -12, lumina: -3.0 }[id], slopeRock: { verdant: 0.36, emer: 0.5, lumina: 0.4 }[id] };
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
    // 资源
    this.resources = new ResourceField(this.terrain, pal);
    this.scene.add(this.resources.group);
    // 生态
    this.ecosystem.clear();
    this.spawnCreatures(id);
    // 基地（若已有存档）
    const bases = this.planetBases[id];
    if (bases && bases.length) this.building.restore(bases);
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
    document.getElementById('crosshair')?.classList.remove('hidden');
    document.getElementById('pause')?.classList.add('hidden');
  }

  async startGame(continueSave) {
    if (this.starting) return;
    this.starting = true;
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
    // 读取存档
    let restored = false;
    if (continueSave) {
      try {
        const raw = localStorage.getItem(SAVE_KEY);
        if (raw) {
          const data = JSON.parse(raw);
          Object.assign(this.inventory, data.inventory || {});
          this.planetBases = data.bases || {};
          this.objectiveState = data.objective || { step: 0, done: 0 };
          this.unlocked = data.unlocked || { weapon: 1 };
          this.savedPlanet = data.planet || 'verdant';
          restored = true;
        }
      } catch (e) { console.warn('存档读取失败', e); }
    }
    if (!restored) {
      Object.assign(this.inventory, START_INV());
      this.planetBases = {};
      this.objectiveState = { step: 0, done: 0 };
    }
    const startPlanet = restored ? this.savedPlanet : 'verdant';
    // 菜单到游戏：用淡入淡出遮罩切换（仅在开局一次）
    this.loadPlanetSync(startPlanet);
    this.teleportPlayerTo(startPlanet);
    this.player.camYaw = this.player.yaw + Math.PI;
    this.camIntroStart = new THREE.Vector3(this.player.pos.x + 4, this.player.pos.y + 2.5, this.player.pos.z + 6);
    this.camera.position.copy(this.camIntroStart);
    this.mode = 'intro';
    this.ui.fadeTo(0, 1800);
    setTimeout(() => this.beginExplore(), 1200);
    this.starting = false;
  }

  beginExplore() {
    this.mode = 'surface';
    this.player.camYaw = this.player.yaw + Math.PI;
    this.player.camPitch = -0.1;
    this.player.camTarget.copy(this.player.pos).add(new THREE.Vector3(0, 0.5, 0));
    const cd = 4.6;
    this.camera.position.copy(this.player.camTarget).add(new THREE.Vector3(Math.sin(this.player.camYaw) * Math.cos(0.1) * cd, Math.sin(0.1) * cd, Math.cos(this.player.camYaw) * Math.cos(0.1) * cd));
    this.camera.lookAt(this.player.camTarget);
    this.player.object.visible = true;
    this.player.inRocket = false;
    this.setObjective();
    setTimeout(() => {
      this.ui.dialogue('航行日志 · DAY 1', `「${this.palette.name}」的大气很轻，光穿过巨蕨时会碎成一地斑点。先在这附近找一些铁素矿——我的小火箭需要它们。`, 9);
      document.body.classList.remove('cinematic');
    }, 600);
    this.ui.toast('按 E 采集 · B 建造 · V 扫描', 'info');
  }

  pause() {
    if (this.mode !== 'surface') return;
    this.paused = true;
    document.getElementById('pause').classList.remove('hidden');
    this.input.releaseLock();
  }

  resume() {
    this.paused = false;
    document.getElementById('pause').classList.add('hidden');
    this.input.requestLock();
  }

  save() {
    const bases = {};
    if (this.planetBases[this.currentPlanetId]) bases[this.currentPlanetId] = this.building.serialize();
    else bases[this.currentPlanetId] = this.building.serialize();
    for (const id of PLANET_ORDER) {
      if (id !== this.currentPlanetId && this.planetBases[id]) bases[id] = this.planetBases[id];
    }
    const data = {
      inventory: this.inventory,
      bases,
      objective: this.objectiveState,
      unlocked: this.unlocked,
      planet: this.currentPlanetId,
    };
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(data)); } catch (e) {}
    this.planetBases = bases;
  }

  toMenu() {
    this.save();
    document.getElementById('pause').classList.add('hidden');
    this.paused = false;
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
      this.ui.setObjective({ text: '登上火箭（靠近舱门按 E），飞往另一颗星球', need: 1 });
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
    const spawn = this.spawnPoints(this.currentPlanetId).player;
    this.player.teleport(spawn.x, spawn.z, spawn.yaw);
    this.ui.fadeTo(1, 400);
    setTimeout(() => this.ui.fadeTo(0, 1200), 500);
    this.ui.dialogue('紧急复苏协议', '生命维持系统已重启。你在登陆点附近醒来。', 5);
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

  planetSceneVisible(v) {
    this.terrain.group.visible = v;
    this.skyMesh.visible = v;
    if (this.vegetation) this.vegetation.group.visible = v;
    if (this.water) this.water.visible = v;
    if (this.motes) this.motes.visible = v;
    if (this.resources) this.resources.group.visible = v;
    this.ecosystem.group.visible = v;
    this.building.group.visible = v;
    this.dustPlume.visible = v && this.dustPlume.visible;
  }

  startLandingScene(id) {
    // 切换地表星球为 id（重建），飞船在半空
    this.mode = 'landing';
    this.planetSceneVisible(false);
    this.spaceSystem.setVisible(false);
    this.loadPlanetSync(id);
    // 降落在该星球的宜居点前方，确保在水面之上、坡度平缓
    const t = this.terrain;
    const sp = this.spawnPoints(id);
    let px = sp.player.x, pz = sp.player.z;
    let guard = 0;
    while ((t.slopeAt(px, pz) > 0.16 || t.height(px, pz) < t.waterLevel + 1.6) && guard++ < 60) {
      px *= 1.06; pz *= 1.06;
    }
    const gy = t.height(px, pz);
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
  }

  finishLanding() {
    this.mode = 'surface';
    this.player.inRocket = false;
    this.player.object.position.copy(this.player.pos);
    document.body.classList.remove('cinematic');
    // 落地后镜头位于角色身后，朝向开阔方向
    this.player.camYaw = this.player.yaw + Math.PI;
    this.player.camPitch = -0.12;
    this.player.camTarget.copy(this.player.pos).add(new THREE.Vector3(0, 0.5, 0));
    const cd = 4.8;
    this.camera.position.copy(this.player.camTarget).add(new THREE.Vector3(
      Math.sin(this.player.camYaw) * Math.cos(0.12) * cd,
      Math.sin(0.12) * cd,
      Math.cos(this.player.camYaw) * Math.cos(0.12) * cd
    ));
    this.camera.lookAt(this.player.camTarget);
    this.fovCurrent = 55;
    this.flight.setPhase('ground');
    this.setObjective();
    const info = PLANET_INFO[this.currentPlanetId];
    this.ui.dialogue('航行日志', `${info.desc}`, 9);
    this.audio.setPlanet(this.currentPlanetId);
    this.planetBases[this.currentPlanetId] = this.planetBases[this.currentPlanetId] || [];
    if (this.objectiveState.step === 2) {
      this.objectiveState.step = 3;
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
    const input = this.input.consume();
    this.updateSkyAndLights(dt);

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
    const eyeOff = new THREE.Vector3(0, 2.35, -0.12).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
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
    if (input.interact || input.keys.has('Enter')) {
      // 选择下一颗星球
      const others = PLANET_ORDER.filter((x) => x !== this.currentPlanetId);
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
    // 移动端摇杆
    if (this.input.touch.move.x || this.input.touch.move.y) {
      input.forward = -this.input.touch.move.y;
      input.strafe = this.input.touch.move.x;
      input.sprint = Math.abs(this.input.touch.move.y) > 0.85;
    }
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

    // 子对象更新
    this.weapon.update(dt);
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
      list.push({ d: dRocket - 10, label: '登上火箭 · 前往太空', key: 'E', action: () => { P.inRocket = true; this.mode = 'board'; this.flight.beginBoard(); } });
    }
    // 2. 采集资源
    const node = this.resources.nearest(P.pos, null, 2.8);
    if (node) {
      const def = RESOURCE_DEFS[node.type];
      list.push({ d: Math.hypot(node.pos.x - P.pos.x, node.pos.z - P.pos.z), label: `采集 ${def.name}`, key: 'E', action: () => this.harvest(node) });
    }
    // 3. 建筑
    const b = this.building.nearest(P.pos);
    if (b) {
      const act = b.type === 'lab'
        ? () => this.research()
        : () => this.ui.toast(BUILDINGS[b.type].desc, 'info');
      list.push({ d: b.pos.distanceTo(P.pos), label: b.type === 'lab' ? '科研站 · 分析样本' : BUILDINGS[b.type].name + ' · ' + BUILDINGS[b.type].desc, key: 'E', action: act });
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
    const res = this.resources.harvest(node);
    if (!res) return;
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

  research() {
    if (this.unlocked.weapon >= 2) { this.ui.toast('当前已有全部已解锁模块', 'info'); return; }
    if (this.inventory.sample >= 2) {
      this.inventory.sample -= 2;
      this.unlocked.weapon = 2;
      this.weapon.damage = 26;
      document.querySelector('.wp-lv').textContent = 'MK.II';
      this.ui.toast('武器升级：MK.II · 脉冲模式伤害提升', 'ok');
      this.audio.play('chime');
    } else if ((this.inventory.bio || 0) >= 3) {
      this.inventory.bio -= 3;
      this.unlocked.shield = 1;
      this.playerMaxShield = 140;
      this.playerShield = 140;
      this.ui.toast('护盾扩容完成 · 护盾上限 +40', 'ok');
      this.audio.play('chime');
    } else {
      this.ui.toast('样本不足：击杀掠食者获得样本，或采集生物质', 'warn');
      this.audio.play('uiError');
    }
  }

  scan() {
    this.audio.play('scan');
    this.scanPulse = 1;
    this.ui.toast('环境扫描完成 · 资源与生物已标记在小地图', 'info');
  }

  updateFade() {
    // 飞行中屏幕淡入的遮罩由 UI 控制
  }
}

// ================= 启动 =================
window.addEventListener('error', (e) => {
  const box = document.getElementById('error-box');
  if (!box) return;
  box.classList.remove('hidden');
  box.textContent = '错误：' + e.message + '\n' + (e.error && e.error.stack || '');
});

const canvas = document.getElementById('scene');
const game = new Game(canvas);
window.__LC__ = game;
game.boot();
