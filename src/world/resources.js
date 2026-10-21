// 可采集资源节点：矿石、晶体、发光苔草
import * as THREE from 'three';
import { createNoise, mulberry32 } from '../core/noise.js';

export const RESOURCE_DEFS = {
  ferrite: { name: '铁素矿', en: 'FERRITE', color: '#b8724a', icon: '⛏' },
  silica: { name: '硅晶', en: 'SILICA', color: '#f2c46b', icon: '◈' },
  bio: { name: '生物质', en: 'BIOMASS', color: '#7fe0a4', icon: '❋' },
  lumen: { name: '荧光素', en: 'LUMEN', color: '#8fe6ff', icon: '✦' },
  sample: { name: '样本', en: 'SAMPLE', color: '#c49bff', icon: '◉' },
};

function oreGeo() {
  const base = new THREE.IcosahedronGeometry(0.55, 0);
  const pos = base.attributes.position;
  const nz = createNoise(9);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const k = 1 + nz.noise3(x * 2, y * 2, z * 2) * 0.35;
    pos.setXYZ(i, x * k, y * k, z * k);
  }
  base.computeVertexNormals();
  return base;
}

function crystalGeo(rnd = Math.random) {
  const parts = [];
  for (let i = 0; i < 4; i++) {
    const g = new THREE.ConeGeometry(0.12, 0.8 + i * 0.16, 6);
    g.translate(0, (0.8 + i * 0.16) / 2, 0);
    g.rotateZ((rnd() - 0.5) * 0.7);
    g.rotateY(i * 1.4);
    g.translate((rnd() - 0.5) * 0.3, 0, (rnd() - 0.5) * 0.3);
    parts.push(g);
  }
  return parts;
}

export class ResourceField {
  // BUG-02：用星球种子生成固定布局，节点带稳定 ID，
  // 读档/重返星球时可以按 ID 恢复采集冷却，而不是重新随机。
  constructor(terrain, palette, rng = Math.random, opts = {}) {
    this.terrain = terrain;
    this.palette = palette;
    this.group = new THREE.Group();
    this.group.name = 'resources';
    this.nodes = [];
    this.planetId = opts.planetId || null;
    this.seed = Number.isFinite(opts.seed) ? opts.seed : 1;
    this.rng = mulberry32(this.seed * 7919 + 13);
    this.build(rng);
  }

  build(rng) {
    const biome = this.terrain.def.biome;
    const oreMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color('#8a5a40'),
      roughness: 0.55,
      metalness: 0.65,
      emissive: new THREE.Color('#2a1206'),
      emissiveIntensity: 0.6,
    });
    const crystalMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(biome === 'glowfen' ? '#7fd8ff' : biome === 'desert' ? '#ffd27a' : '#a8ffd9'),
      emissive: new THREE.Color(biome === 'glowfen' ? '#2d8cc4' : biome === 'desert' ? '#a86a20' : '#3f9c78'),
      emissiveIntensity: 1.4,
      roughness: 0.08,
      metalness: 0.1,
      transparent: true,
      opacity: 0.92,
    });
    const podMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(biome === 'lumina' ? '#7ce8ff' : '#b4e8a0'),
      emissive: new THREE.Color(biome === 'lumina' ? '#2f9fd8' : '#4f8a45'),
      emissiveIntensity: 2.0,
      roughness: 0.35,
    });
    // BUG-03：生物质荚材质（半透明浆果，带自发光便于夜间辨识）
    const bioMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color('#7fe0a4'),
      emissive: new THREE.Color('#2f7a4a'),
      emissiveIntensity: 1.1,
      roughness: 0.45,
      metalness: 0.05,
      transparent: true,
      opacity: 0.9,
    });
    this.oreMat = oreMat;
    this.crystalMat = crystalMat;
    this.bioMat = bioMat;

    // BUG-02：所有随机量都来自星球种子，同一星球每次生成的布局完全一致
    const rnd = this.rng;
    const mk = (type, count, radius) => {
      for (let i = 0; i < count; i++) {
        const a = rnd() * Math.PI * 2;
        const r = 12 + Math.sqrt(rnd()) * radius;
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        if (Math.hypot(x, z) < 6) continue;
        const y = this.terrain.height(x, z);
        if (this.terrain.slopeAt(x, z) > 0.7) continue;
        const root = new THREE.Group();
        root.position.set(x, y, z);
        let mesh;
        if (type === 'ferrite') {
          mesh = new THREE.Mesh(oreGeo(), oreMat);
          mesh.scale.setScalar(0.7 + rnd() * 0.6);
          mesh.position.y = 0.25;
          mesh.rotation.set(rnd(), rnd() * 6, rnd());
        } else if (type === 'silica') {
          for (const g of crystalGeo(rnd)) {
            const m = new THREE.Mesh(g, crystalMat);
            root.add(m);
          }
        } else if (type === 'lumen') {
          mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(0.16, 1), podMat);
          mesh.scale.set(1, 2.6, 1);
          mesh.position.y = 0.3;
          root.add(mesh);
          // 三根细发光茎
          for (let k = 0; k < 3; k++) {
            const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.4, 4), podMat);
            stem.position.set(Math.cos(k * 2.1) * 0.07, 0.06, Math.sin(k * 2.1) * 0.07);
            root.add(stem);
          }
        } else if (type === 'bio') {
          // 生物质荚：地表一簇半透明浆果荚，采集后转为生物质
          const cluster = new THREE.Group();
          for (let k = 0; k < 3; k++) {
            const pod = new THREE.Mesh(new THREE.SphereGeometry(0.19 - k * 0.03, 10, 8), bioMat);
            pod.scale.set(1, 1.35, 1);
            const a = k * 2.1;
            pod.position.set(Math.cos(a) * 0.17, 0.2 + k * 0.06, Math.sin(a) * 0.17);
            cluster.add(pod);
          }
          const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.05, 0.34, 6), bioMat);
          stalk.position.y = 0.17;
          cluster.add(stalk);
          root.add(cluster);
        }
        if (mesh) { mesh.castShadow = true; root.add(mesh); }
        root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.userData.hittable = true; } });
        // BUG-02：稳定 ID = 类型 + 序号，读档时按 ID 恢复采集状态
        const id = `${type}-${this.nodes.filter((n) => n.type === type).length}`;
        const node = {
          id,
          type,
          root,
          pos: new THREE.Vector3(x, y, z),
          amount: 2 + Math.floor(rnd() * 3),
          harvested: false,
          respawnT: 0,
          colliderR: 0.55,
        };
        root.traverse((o) => { if (o.isMesh) o.userData.resource = node; });
        this.group.add(root);
        this.nodes.push(node);
      }
    };
    // BUG-03：生物质必须有可采集来源，否则科研站（需 bio 6）永久无法建造
    if (biome === 'desert') {
      mk('ferrite', 22, 230);
      mk('silica', 24, 230);
      mk('bio', 10, 200);
    } else if (biome === 'glowfen') {
      mk('lumen', 34, 230);
      mk('ferrite', 12, 230);
      mk('bio', 14, 200);
    } else {
      mk('ferrite', 22, 230);
      mk('silica', 14, 230);
      mk('bio', 12, 200);
    }
  }

  // BUG-37：用实际三维距离筛选，并检查可达性（高度差 + 视线遮挡）
  nearest(pos, type, radius = 3.2) {
    let best = null, bd = radius;
    for (const n of this.nodes) {
      if (n.harvested) continue;
      if (type && n.type !== type) continue;
      const dx = n.pos.x - pos.x, dz = n.pos.z - pos.z;
      const horiz = Math.hypot(dx, dz);
      if (horiz >= bd) continue;
      // 高度差太大（头顶/脚下）不算可交互
      if (Math.abs(n.pos.y - pos.y) > 2.0) continue;
      // 中间有实心障碍时不算可达
      if (this._occluded(pos, n.pos)) continue;
      bd = horiz; best = n;
    }
    return best;
  }

  _occluded(from, to) {
    const g = this.game;
    if (!g) return false;
    const steps = 5;
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const x = from.x + (to.x - from.x) * t;
      const z = from.z + (to.z - from.z) * t;
      if (g.vegetation?.blocked(x, z, 0)) return true;
      if (g.building?.blockedAt && g.building.blockedAt(x, z, 0)) return true;
    }
    return false;
  }

  // BUG-17：资源实体的水平阻挡（矿石/晶簇本身是实心的）
  blockedAt(x, z, pad = 0) {
    for (const n of this.nodes) {
      if (n.harvested) continue;
      const r = (n.colliderR || 0.5) * 0.7;
      const dx = n.pos.x - x, dz = n.pos.z - z;
      if (dx * dx + dz * dz < (r + pad) * (r + pad)) return n;
    }
    return null;
  }

  // BUG-37：执行采集时再校验一次距离与遮挡
  harvest(node, playerPos) {
    if (!node || node.harvested) return null;
    if (playerPos) {
      const d = Math.hypot(node.pos.x - playerPos.x, node.pos.z - playerPos.z);
      if (d > 2.8 || Math.abs(node.pos.y - playerPos.y) > 2.0) return null;
      if (this._occluded(playerPos, node.pos)) return null;
    }
    node.harvested = true;
    node.respawnT = 90;
    node.root.visible = false;
    return { type: node.type, amount: node.amount, id: node.id };
  }

  update(dt) {
    for (const n of this.nodes) {
      if (!n.harvested) continue;
      n.respawnT -= dt;
      if (n.respawnT <= 0) {
        n.harvested = false;
        n.root.visible = true;
      }
    }
  }

  // BUG-02：把采集状态序列化成可存档的稳定结构
  serialize() {
    const out = {};
    for (const n of this.nodes) {
      if (n.harvested) out[n.id] = Math.max(1, Math.round(n.respawnT));
    }
    return out;
  }

  restore(state) {
    if (!state || typeof state !== 'object') return;
    for (const n of this.nodes) {
      const t = state[n.id];
      if (Number.isFinite(t)) {
        n.harvested = true;
        n.respawnT = Math.max(0.1, t);
        n.root.visible = false;
      } else {
        n.harvested = false;
        n.respawnT = 0;
        n.root.visible = true;
      }
    }
  }

  // BUG-43：释放几何与材质
  dispose() {
    const mats = new Set();
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        if (Array.isArray(o.material)) o.material.forEach((m) => mats.add(m));
        else mats.add(o.material);
      }
    });
    for (const m of mats) m.dispose();
  }
}
