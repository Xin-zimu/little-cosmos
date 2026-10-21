// 修复后回归验证：逐项覆盖 BUG-AUDIT-2026-10-20 的 51 个问题
import * as THREE from 'three';
import { BuildingSystem, BUILDINGS } from '../src/base/building.js';
import { PlayerController } from '../src/player/controller.js';
import { FlightSystem } from '../src/ship/flight.js';
import { Creature, CREATURE_DEFS, Ecosystem } from '../src/world/creatures.js';
import { Weapon } from '../src/player/weapon.js';
import { ResourceField } from '../src/world/resources.js';

// 最小 DOM 桩：让 main.js 能在 Node 下被导入（只为验证纯逻辑）
const stubEl = () => ({
  classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  style: {}, dataset: {}, textContent: '', innerHTML: '', children: [],
  appendChild() {}, removeChild() {}, querySelector() { return stubEl(); },
  querySelectorAll() { return []; }, addEventListener() {}, remove() {},
  firstChild: null, parentElement: null,
});
globalThis.document = {
  body: stubEl(), documentElement: stubEl(),
  getElementById: () => stubEl(),
  querySelector: () => stubEl(), querySelectorAll: () => [],
  createElement: () => stubEl(), addEventListener() {}, pointerLockElement: null,
  hidden: false,
};
globalThis.window = {
  addEventListener() {}, innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1,
  matchMedia: () => ({ matches: false }), AudioContext: function () {},
};
Object.defineProperty(globalThis, 'navigator', { value: { maxTouchPoints: 0 }, configurable: true });
globalThis.localStorage = {
  _d: {}, getItem(k) { return this._d[k] ?? null; },
  setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; },
};
const { Game } = await import('../src/main.js');

const results = [];
const check = (id, name, pass, detail) => results.push({ id, name, pass: !!pass, detail });

function fixture(extra = {}) {
  const g = {
    palette: { accent: '#88ddcc', name: '蒙昧之绿', gravity: 7.4 },
    scene: new THREE.Scene(),
    terrain: { height: () => 0, slopeAt: () => 0, waterLevel: -3 },
    camera: new THREE.PerspectiveCamera(55, 16 / 9, .35, 30000),
    cameraLookTarget: new THREE.Vector3(),
    inventory: { ferrite: 100, silica: 100, bio: 100, lumen: 0, sample: 0 },
    rocket: { group: new THREE.Group(), throttle: 0, update() {}, openDoor() {} },
    spaceSystem: { follow() {} },
    ui: { toast() {}, showPrompt() {}, setBuildingMode() {}, dialogue() {}, fadeTo() {}, setObjective() {}, updateObjectiveProgress() {} },
    audio: { play() {}, setEngine() {}, setPlanet() {}, updateMusic() {}, updateAmbient() {}, setListener() {} },
    sunDirVec: new THREE.Vector3(0, 1, 0),
    playerMaxShield: 100, playerShield: 0, playerMaxHealth: 100, playerHealth: 50,
    time: 0, currentPlanetId: 'verdant', mode: 'surface', fps: 60,
    ...extra,
  };
  g.rocket.group.position.set(100, 0, 100);
  g.player = new PlayerController(g);
  g.player.terrain = g.terrain;
  g.player.inRocket = false;
  g.building = new BuildingSystem(g);
  g.vegetation = { colliders: [], blocked() { return null; } };
  g.resources = { nodes: [], blockedAt() { return null; }, nearest() { return null; }, update() {}, serialize() { return {}; }, restore() {} };
  g.scene.add(g.player.object);
  return g;
}

function makeWeapon(g, opts = {}) {
  const w = Object.assign(Object.create(Weapon.prototype), {
    game: g, raycaster: new THREE.Raycaster(), range: 70, damage: 18,
    beams: [], flashes: [], light: new THREE.PointLight(), flashTex: new THREE.Texture(),
    recoil: 0, cooldown: 0, energy: 100, maxEnergy: 100, mode: 0,
    modes: ['单发', '脉冲', '散射'], heat: 0, burstTimer: 0, burstCount: 0, chargeT: 0,
    ...opts,
  });
  g.weapon = w;
  return w;
}

// ============ 21 ============
{
  const g = fixture(); const b = g.building;
  g.inventory = { ferrite: 5, silica: 6, bio: 0 };
  b.startPlacing('solar'); b.updateGhost(g.camera, g.player, .016);
  const prevValid = b.valid;
  b.startPlacing('lab');
  const created = b.confirm();
  check(21, '切换建筑后立即确认被拒绝', prevValid && created === null && g.inventory.ferrite === 5 && g.inventory.bio === 0,
    { prevValid, created: created ? created.type : null, inventory: g.inventory });
}

// ============ 22 ============
{
  const g = fixture(); const b = g.building;
  b.startPlacing('habitat'); b.updateGhost(g.camera, g.player, .016);
  const h = b.holo.children.find((x) => x.userData.type === 'habitat');
  g.scene.updateMatrixWorld(true);
  const preview = new THREE.Box3().setFromObject(h);
  const item = b.confirm();
  item.mesh.scale.set(1, 1, 1);
  g.scene.updateMatrixWorld(true);
  const built = new THREE.Box3().setFromObject(item.mesh);
  b.clear(); b.restore([{ type: 'habitat', x: 10, z: 10 }]);
  g.scene.updateMatrixWorld(true);
  const restored = new THREE.Box3().setFromObject(b.items[0].mesh);
  check(22, '预览/落成/读档共用同一变换', Math.abs(built.min.y - preview.min.y) < 0.01 && Math.abs(restored.min.y - built.min.y) < 0.01,
    { previewMinY: preview.min.y, builtMinY: built.min.y, restoredMinY: restored.min.y });
}

// ============ 23 ============
{
  const g = fixture(); const b = g.building;
  b.restore([{ type: 'solar', x: 20, z: 0 }, { type: 'miner', x: 25, z: 0 }]);
  g.inventory.ferrite = 0;
  for (let i = 0; i < 361; i++) b.update(1 / 60, g.player);
  check(23, '供电充足时矿机满负荷产出', g.inventory.ferrite >= 1, { gen: b.gen, use: b.use, power: b.power, ferrite: g.inventory.ferrite });
}

// ============ 24 ============
{
  const g = fixture(); const b = g.building;
  g.player.pos.set(0, 0, 0);
  b.restore([{ type: 'habitat', x: 30, z: 0 }, { type: 'habitat', x: 2.4, z: 0 }, { type: 'solar', x: 8, z: 8 }]);
  for (let i = 0; i < 120; i++) b.update(1 / 60, g.player);
  check(24, '范围内最近的居住舱恢复护盾', g.playerShield > 0, { shield: g.playerShield, found: !!b.habitatInRange, gen: b.gen });
}

// ============ 25 ============
{
  const g = fixture(); const b = g.building;
  g.player.pos.set(0, 0, 0);
  b.restore([{ type: 'habitat', x: 2.4, z: 0 }, { type: 'lab', x: 3, z: 0 }]);
  b.update(1, g.player);
  const offline = !b.isOperational(b.items[1]);
  const noRegen = g.playerShield === 0;
  check(25, '停电时科研站/居住舱不可用', offline && noRegen, { offline, noRegen, gen: b.gen, power: b.power });
}

// ============ 26 ============
{
  const g = fixture(); const b = g.building;
  g.vegetation.blocked = (x, z) => (Math.abs(x - 11.5) < 0.6 && Math.abs(z) < 0.6 ? { x: 11.5, z: 0, r: 0.6 } : null);
  const res = b.validate(9.4, 0, 'pad', 0);
  check(26, '占地覆盖树干时不可建造', !res.ok, { reason: res.reason });
}

// ============ 27 ============
{
  const g = fixture();
  g.building.restore([{ type: 'lab', x: 0, z: 2 }, { type: 'pad', x: 0, z: 3.7 }]);
  const near = g.building.nearest(new THREE.Vector3());
  check(27, '交互选中更近的科研站', near && near.type === 'lab', { picked: near && near.type });
}

// ============ 28 ============
{
  const g = fixture(); const b = g.building;
  b.restore([{ type: 'solar', x: 20, z: 0 }, { type: 'miner', x: 25, z: 0 }]);
  for (let i = 0; i < 180; i++) b.update(1 / 60, g.player);
  const snap = b.snapshotProduction();
  const before = b.items[1].produceTimer;
  b.clear();
  b.restore([{ type: 'solar', x: 0, z: 0 }, { type: 'miner', x: 3, z: 0 }]);
  const inherited = b.items[1].produceTimer;
  check(28, '矿机进度不跨星球继承', before > 0 && inherited === 0, { before, inherited, snapshot: snap.length });
}

// ============ 29 ============
{
  function shoot(withWall) {
    const g = fixture();
    const w = makeWeapon(g);
    g.camera.position.set(0, 2, 0);
    g.camera.lookAt(0, 2, -10);
    g.camera.updateMatrixWorld(true);
    if (withWall) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(10, 10, 1), new THREE.MeshBasicMaterial());
      wall.position.set(0, 2, -5);
      g.scene.add(wall);
    }
    let damage = 0;
    // 用 BoxGeometry 做靶（球体沿极轴的退化三角形会漏检，与遮挡逻辑无关）
    const target = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial());
    target.position.set(0, 2, -10);
    target.userData.hittable = true;
    target.userData.creature = { dead: false, damage: (n) => { damage += n; return false; } };
    g.scene.add(target);
    g.scene.updateMatrixWorld(true);
    g.onHitFeedback = () => {}; g.onHitEnvironment = () => {};
    w.fireOnce();
    return damage;
  }
  const blocked = shoot(true);
  const open = shoot(false);
  check(29, '实体墙挡住射线，空旷时可命中', blocked === 0 && open === 18, { blocked, open });
}

// ============ 30 ============
{
  const g = fixture();
  const c = new Creature(CREATURE_DEFS.thornling, new THREE.Vector3(), g);
  let weak = 0, hittable = 0;
  c.root.traverse((o) => { if (o.userData.weak) weak++; if (o.userData.hittable) hittable++; });
  const hpBefore = c.hp;
  c.damage(10, new THREE.Vector3(), true);
  check(30, '弱点命中体存在且暴击双倍', weak > 0 && hpBefore - c.hp === 20, { weak, hittable, critDmg: hpBefore - c.hp });
}

// ============ 31 ============
{
  function spreadDirs(dir) {
    const g = fixture();
    const w = makeWeapon(g);
    g.camera.position.set(0, 2, 0);
    const look = dir.clone().multiplyScalar(10).add(new THREE.Vector3(0, 2, 0));
    g.camera.lookAt(look);
    g.camera.updateMatrixWorld(true);
    g.onHitFeedback = () => {}; g.onHitEnvironment = () => {};
    const out = [];
    for (const s of [-0.032, 0.032]) {
      w.fireOnce(0.55, false, s);
      const m = w.beams[w.beams.length - 1].mesh;
      const d = new THREE.Vector3(0, 0, 1).applyQuaternion(m.quaternion).normalize();
      out.push(d);
    }
    return out[0].angleTo(out[1]) * 180 / Math.PI;
  }
  const angZ = spreadDirs(new THREE.Vector3(0, 0, -1));
  const angX = spreadDirs(new THREE.Vector3(1, 0, 0));
  const angY = spreadDirs(new THREE.Vector3(0.1, 0, -1).normalize());
  check(31, '散射张角与朝向无关', Math.abs(angZ - angX) < 0.05 && Math.abs(angZ - angY) < 0.05, { towardZ: angZ, towardX: angX, towardZ2: angY });
}

// ============ 32 ============
{
  const g = fixture();
  const w = makeWeapon(g);
  w.mode = 1;
  w.tryFire(g.camera, true);
  const burst = w.burstCount;
  w.switchMode();
  check(32, '切换模式后余弹清零', burst > 0 && w.burstCount === 0, { burstBefore: burst, after: w.burstCount, mode: w.mode });
}

// ============ 33 ============
{
  const g = fixture();
  const w = makeWeapon(g);
  g.onHitFeedback = () => {}; g.onHitEnvironment = () => {};
  w.fireOnce();
  const before = w.beams.length + w.flashes.length;
  w.clearEffects();
  check(33, 'clearEffects 清空弹道/闪光/灯光', before > 0 && w.beams.length === 0 && w.flashes.length === 0 && w.light.intensity === 0,
    { before, beams: w.beams.length, flashes: w.flashes.length, light: w.light.intensity });
}

// ============ 34 ============
{
  const g = fixture();
  let attacks = 0;
  g.onCreatureAttack = () => attacks++;
  const c = new Creature(CREATURE_DEFS.thornling, new THREE.Vector3(0, 0, 0), g);
  c.state = 'attack';
  g.player.pos.set(c.def.attackRange * 1.8, 0, 0);
  for (let i = 0; i < 600; i++) { g.time += 1 / 60; c.update(1 / 60, g.player); }
  check(34, '攻击距离外继续靠近并命中', attacks > 0, { attacks, state: c.state, moved: c.pos.length() });
}

// ============ 35 ============
{
  const g = fixture();
  const c = new Creature(CREATURE_DEFS.thornling, new THREE.Vector3(20, 0, 20), g);
  g.player.pos.set(-100, 0, -100);
  const start = c.pos.clone();
  for (let i = 0; i < 600; i++) { g.time += 1 / 60; c.update(1 / 60, g.player); }
  check(35, '敌对生物未发现玩家时正常巡游', c.pos.distanceTo(start) > 1, { distanceMoved: c.pos.distanceTo(start), state: c.state });
}

// ============ 36 ============
{
  const g = fixture();
  g.building.restore([{ type: 'habitat', x: 2, z: 0 }]);
  const c = new Creature(CREATURE_DEFS.thornling, new THREE.Vector3(0, 0, 0), g);
  g.player.pos.set(6, 0, 0);
  const before = c.pos.clone();
  for (let i = 0; i < 240; i++) { g.time += 1 / 60; c.update(1 / 60, g.player); }
  const crossedWall = c.pos.x > 2.5 && Math.abs(c.pos.z) < 1.0;
  check(36, '生物不会穿过基地建筑', !crossedWall, { pos: c.pos.toArray(), crossedWall });
}

// ============ 37 ============
{
  const g = fixture();
  const terrain = { height: (x, z) => 0, slopeAt: () => 0, waterLevel: -3, def: { biome: 'verdant', seed: 11 } };
  const field = new ResourceField(terrain, g.palette, Math.random, { planetId: 'verdant', seed: 11 });
  const node = field.nodes[0];
  const at = (p) => field.nearest(p, null, 2.8);
  const near = at(new THREE.Vector3(node.pos.x + 1, 0, node.pos.z));
  const high = at(new THREE.Vector3(node.pos.x + 1, 6, node.pos.z));
  const harvested = field.harvest(node, new THREE.Vector3(node.pos.x + 1, 6, node.pos.z));
  const okHarvest = field.harvest(node, new THREE.Vector3(node.pos.x + 1, 0, node.pos.z));
  check(37, '采集校验高度差，harvest 二次校验', !!near && !high && harvested === null && !!okHarvest,
    { near: !!near, high: !!high, farHarvest: harvested, okHarvest: !!okHarvest });
}

// ============ 38 ============
{
  const g = fixture();
  const f = new FlightSystem(g);
  f.enterSpace('verdant');
  f.shipState.pos.set(0, 0, 450);
  f.updateSpace(1 / 60, { held: new Set(['KeyE']), keys: new Set(['KeyE']), interact: true, throttle: 1 });
  const notLanded = f.phase === 'space';
  f.updateSpace(1 / 60, { held: new Set(), keys: new Set(), land: true });
  check(38, '按 E 加速不会触发降落，F 才降落', notLanded && f.phase === 'approach', { phase: f.phase, target: f.targetPlanet });
}

// ============ 39 ============
{
  const g = fixture();
  const f = new FlightSystem(g);
  f.enterSpace('verdant');
  f.shipState.pos.set(10000, 10000, 10000);
  f.shipState.throttle = 0.2;
  const pitchBefore = f.shipState.pitch;
  for (let i = 0; i < 60; i++) f.updateSpace(1 / 60, { forward: -1, held: new Set(), keys: new Set(), throttle: 0 });
  check(39, '俯仰键不改变油门', Math.abs(f.shipState.throttle - 0.2) < 1e-6 && Math.abs(f.shipState.pitch - pitchBefore) > 0.1,
    { throttle: f.shipState.throttle, pitch: f.shipState.pitch });
}

// ============ 42（用真实 Game.finishLanding） ============
{
  const game = new Game(null);
  game.ui = { dialogue() {}, toast() {}, setObjective() {}, showPrompt() {}, setBuildingMode() {}, fadeTo() {}, updateObjectiveProgress() {} };
  game.audio = { play() {}, setEngine() {}, updateMusic() {}, updateAmbient() {}, setListener() {}, setPlanet() {} };
  game.player = { inRocket: false, object: { position: new THREE.Vector3(), visible: false }, pos: new THREE.Vector3() };
  game.camera = new THREE.PerspectiveCamera();
  game.input = { requestLock() {} };
  game.planetBases = {};
  game.weapon = { energy: 100, maxEnergy: 100 };
  game.setObjective = () => {};
  game.objectiveState = { step: 2, fromPlanet: 'verdant' };
  game.currentPlanetId = 'verdant';
  const origSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = () => 0;
  game.finishLanding();
  const same = game.objectiveState.step;
  game.currentPlanetId = 'emer';
  game.finishLanding();
  globalThis.setTimeout = origSetTimeout;
  check(42, '飞回原星球不完成任务，抵达新星球才完成', same === 2 && game.objectiveState.step === 3,
    { backToOrigin: same, toOther: game.objectiveState.step });
}

// ============ 输出 ============
const pass = results.filter((r) => r.pass).length;
console.log(JSON.stringify({ total: results.length, pass, fail: results.length - pass, results }, null, 1));
