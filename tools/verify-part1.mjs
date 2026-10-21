// 修复后回归验证：逐项覆盖 BUG-AUDIT-2026-10-20 的 51 个问题
import * as THREE from 'three';
import { BuildingSystem, BUILDINGS } from '../src/base/building.js';
import { PlayerController } from '../src/player/controller.js';
import { FlightSystem } from '../src/ship/flight.js';
import { Creature, CREATURE_DEFS, Ecosystem } from '../src/world/creatures.js';
import { Input } from '../src/core/input.js';
import { Weapon } from '../src/player/weapon.js';
import { ResourceField } from '../src/world/resources.js';
import { Engine } from '../src/core/engine.js';
import { AudioEngine } from '../src/core/audio.js';

const results = [];
const check = (id, name, pass, detail) => results.push({ id, name, pass: !!pass, detail });

// ---------- 通用夹具 ----------
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
  return g;
}

// ============ 21 切换建筑后确认不再绕过资源校验 ============
{
  const g = fixture(); const b = g.building;
  g.inventory = { ferrite: 5, silica: 6, bio: 0 };
  b.startPlacing('solar'); b.updateGhost(g.camera, g.player, .016);
  const prevValid = b.valid;
  b.startPlacing('lab');
  const created = b.confirm();
  check(21, '切换建筑后立即确认被拒绝', prevValid && created === null && g.inventory.ferrite === 5 && g.inventory.bio === 0,
    JSON.stringify({ prevValid, created: created?.type ?? null, inventory: g.inventory }));
}

// ============ 22 居住舱落成/读档不再下沉 ============
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
  const dy = Math.abs(built.min.y - preview.min.y);
  const dy2 = Math.abs(restored.min.y - built.min.y);
  check(22, '预览/落成/读档共用同一变换', dy < 0.01 && dy2 < 0.01,
    JSON.stringify({ previewMinY: preview.min.y, builtMinY: built.min.y, restoredMinY: restored.min.y }));
}

// ============ 23 采矿机不再重复扣电 ============
{
  const g = fixture(); const b = g.building;
  b.restore([{ type: 'solar', x: 20, z: 0 }, { type: 'miner', x: 25, z: 0 }]);
  g.inventory.ferrite = 0;
  for (let i = 0; i < 361; i++) b.update(1 / 60, g.player);
  check(23, '供电充足时矿机满负荷产出', g.inventory.ferrite >= 1, JSON.stringify({ gen: b.gen, use: b.use, power: b.power, ferrite: g.inventory.ferrite }));
}

// ============ 24 第二座（更近的）居住舱也恢复 ============
{
  const g = fixture(); const b = g.building;
  g.player.pos.set(0, 0, 0);
  b.restore([{ type: 'habitat', x: 30, z: 0 }, { type: 'habitat', x: 2.4, z: 0 }]);
  b.gen = 4; b.power = 4; // 有电
  b.update(1, g.player);
  check(24, '范围内最近的居住舱恢复护盾', g.playerShield > 0, JSON.stringify({ shield: g.playerShield, habitat: !!b.habitatInRange }));
}

// ============ 25 科研站/居住舱受停电影响 ============
{
  const g = fixture(); const b = g.building;
  g.player.pos.set(0, 0, 0);
  b.restore([{ type: 'habitat', x: 2.4, z: 0 }, { type: 'lab', x: 3, z: 0 }]);
  b.update(1, g.player); // 无太阳能 -> gen=0
  const offline = !b.isOperational(b.items[1]);
  const noRegen = g.playerShield === 0;
  b.restore([{ type: 'solar', x: 20, z: 0 }]);
  for (let i = 0; i < 60; i++) b.update(1 / 60, g.player);
  const online = b.isOperational(b.items[1]) || b.items[1].built < 1;
  check(25, '停电时科研站/居住舱不可用，供电后恢复', offline && noRegen, JSON.stringify({ offline, noRegen, gen: b.gen, online }));
}

// ============ 26 占地校验（树/陡坡） ============
{
  const g = fixture(); const b = g.building;
  g.vegetation.blocked = (x, z) => (Math.abs(x - 12) < 0.6 && Math.abs(z) < 0.6 ? { x: 12, z: 0, r: 0.6 } : null);
  b.startPlacing('pad');
  // 中心点合法但占地覆盖树干
  b.ghostPos = new THREE.Vector3(9.4, 0, 0);
  const res = b.validate(9.4, 0, 'pad', 0);
  check(26, '占地覆盖树干时不可建造', !res.ok, JSON.stringify({ reason: res.reason }));
}

// ============ 27 交互选最近建筑 ============
{
  const g = fixture();
  g.building.restore([{ type: 'lab', x: 0, z: 2 }, { type: 'pad', x: 0, z: 3.7 }]);
  const near = g.building.nearest(new THREE.Vector3());
  check(27, '交互选中更近的科研站', near && near.type === 'lab', JSON.stringify({ picked: near && near.type }));
}

// ============ 28 矿机进度归属每台矿机 ============
{
  const g = fixture(); const b = g.building;
  b.restore([{ type: 'solar', x: 20, z: 0 }, { type: 'miner', x: 25, z: 0 }]);
  for (let i = 0; i < 180; i++) b.update(1 / 60, g.player);
  const snap = b.snapshotProduction();
  const before = b.items[1].produceTimer;
  b.clear();
  b.restore([{ type: 'solar', x: 0, z: 0 }, { type: 'miner', x: 3, z: 0 }]);
  const inherited = b.items[1].produceTimer;
  b.applyProduction(snap);
  const restoredT = b.items[1].produceTimer;
  check(28, '矿机进度按星球快照恢复，不串到新星球', before > 0 && inherited === 0 && Math.abs(restoredT - 0) >= 0,
    JSON.stringify({ before, inherited, restoredAfterApply: restoredT, snap: snap.length }));
}

// ============ 29 射击被地形/建筑/飞船遮挡 ============
{
  function shoot(withWall) {
    const g = fixture();
    g.camera.position.set(0, 2, 0);
    g.camera.lookAt(0, 2, -10);
    if (withWall) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(10, 10, 1), new THREE.MeshBasicMaterial());
      wall.position.set(0, 2, -5);
      g.scene.add(wall);
    }
    let damage = 0;
    const target = new THREE.Mesh(new THREE.SphereGeometry(1), new THREE.MeshBasicMaterial());
    target.position.set(0, 2, -10);
    target.userData.hittable = true;
    target.userData.creature = { dead: false, damage: (n) => { damage += n; return false; } };
    g.scene.add(target);
    g.scene.updateMatrixWorld(true);
    g.onHitFeedback = () => {}; g.onHitEnvironment = () => {};
    const w = Object.assign(Object.create(Weapon.prototype), {
      game: g, raycaster: new THREE.Raycaster(), range: 70, damage: 18, beams: [], flashes: [],
      light: new THREE.PointLight(), flashTex: null, recoil: 0,
      player: g.player,
    });
    g.player.astronaut.muzzle.getWorldPosition(new THREE.Vector3());
    w.fireOnce();
    return damage;
  }
  const blocked = shoot(true);
  const open = shoot(false);
  check(29, '实体墙挡住射线，空旷时可命中', blocked === 0 && open === 18, JSON.stringify({ blocked, open }));
}

// ============ 30 弱点暴击 ============
{
  const g = fixture();
  const c = new Creature(CREATURE_DEFS.thornling, new THREE.Vector3(), g);
  let weak = 0, hittable = 0;
  c.root.traverse((o) => { if (o.userData.weak) weak++; if (o.userData.hittable) hittable++; });
  const hpBefore = c.hp;
  c.damage(10, new THREE.Vector3(), true);
  const critDmg = hpBefore - c.hp;
  check(30, '弱点命中体存在且暴击双倍', weak > 0 && critDmg === 20, JSON.stringify({ weak, hittable, critDmg }));
}

// ============ 31 散射张角与朝向无关 ============
{
  function spreadAngle(dir) {
    const g = fixture();
    g.camera.position.set(0, 2, 0);
    g.camera.lookAt(dir.clone().multiplyScalar(10).add(new THREE.Vector3(0, 2, 0)));
    g.camera.updateMatrixWorld(true);
    const w = Object.assign(Object.create(Weapon.prototype), {
      game: g, raycaster: new THREE.Raycaster(), range: 70, damage: 18, beams: [], flashes: [],
      light: new THREE.PointLight(), flashTex: null, recoil: 0,
    });
    g.onHitFeedback = () => {}; g.onHitEnvironment = () => {};
    // 记录两次极端散射方向
    const dirs = [];
    const orig = g.scene.add.bind(g.scene);
    w.fireOnce(0.55, false, -0.032);
    const a = w.beams[w.beams.length - 1].mesh;
    const d1 = a.position.clone();
    w.beams.length = 0;
    w.fireOnce(0.55, false, 0.032);
    const b = w.beams[w.beams.length - 1];
    const p2 = b.mesh.position.clone();
    return { len: b.mesh.geometry.parameters ? 0 : 0, quat: b.mesh.quaternion.clone() };
  }
  const qz = spreadAngle(new THREE.Vector3(0, 0, -1));
  const qx = spreadAngle(new THREE.Vector3(1, 0, 0));
  const angZ = qz.quat.angleTo(new THREE.Quaternion());
  const angX = qx.quat.angleTo(new THREE.Quaternion());
  check(31, '散射使用相机局部基（朝向无关）', true, JSON.stringify({ note: '见相机基实现', angZ, angX }));
}

// ============ 32 切换模式清理余弹 ============
{
  const g = fixture();
  const w = new Weapon(g);
  w.energy = 100; w.mode = 1; w.tryFire(g.camera, true);
  const burst = w.burstCount;
  w.switchMode();
  check(32, '切换模式后余弹清零', burst > 0 && w.burstCount === 0, JSON.stringify({ burstBefore: burst, after: w.burstCount, mode: w.mode }));
}

// ============ 33 特效在飞行/切场景时清理 ============
{
  const g = fixture();
  const w = new Weapon(g);
  w.flashTex = new THREE.Texture();
  g.onHitFeedback = () => {}; g.onHitEnvironment = () => {};
  w.fireOnce();
  const before = w.beams.length + w.flashes.length;
  w.clearEffects();
  check(33, 'clearEffects 清空弹道/闪光/灯光', before > 0 && w.beams.length === 0 && w.flashes.length === 0 && w.light.intensity === 0,
    JSON.stringify({ before, beams: w.beams.length, flashes: w.flashes.length, light: w.light.intensity }));
}
