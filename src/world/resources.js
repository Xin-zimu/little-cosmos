// 可采集资源节点：矿石、晶体、发光苔草
import * as THREE from 'three';
import { createNoise } from '../core/noise.js';

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

function crystalGeo() {
  const parts = [];
  for (let i = 0; i < 4; i++) {
    const g = new THREE.ConeGeometry(0.12, 0.8 + i * 0.16, 6);
    g.translate(0, (0.8 + i * 0.16) / 2, 0);
    g.rotateZ((Math.random() - 0.5) * 0.7);
    g.rotateY(i * 1.4);
    g.translate((Math.random() - 0.5) * 0.3, 0, (Math.random() - 0.5) * 0.3);
    parts.push(g);
  }
  return parts;
}

export class ResourceField {
  constructor(terrain, palette, rng = Math.random) {
    this.terrain = terrain;
    this.palette = palette;
    this.group = new THREE.Group();
    this.group.name = 'resources';
    this.nodes = [];
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
    this.oreMat = oreMat;
    this.crystalMat = crystalMat;

    const mk = (type, count, radius) => {
      for (let i = 0; i < count; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = 12 + Math.sqrt(Math.random()) * radius;
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        if (Math.hypot(x, z) < 6) continue;
        const y = this.terrain.height(x, z);
        if (this.terrain.slopeAt(x, z) > 0.7) continue;
        const root = new THREE.Group();
        root.position.set(x, y, z);
        let mesh;
        if (type === 'ferrite') {
          mesh = new THREE.Mesh(oreGeo(), oreMat);
          mesh.scale.setScalar(0.7 + Math.random() * 0.6);
          mesh.position.y = 0.25;
          mesh.rotation.set(Math.random(), Math.random() * 6, Math.random());
        } else if (type === 'silica') {
          for (const g of crystalGeo()) {
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
        }
        if (mesh) { mesh.castShadow = true; root.add(mesh); }
        root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.userData.hittable = true; } });
        const node = {
          type,
          root,
          pos: new THREE.Vector3(x, y, z),
          amount: 2 + Math.floor(Math.random() * 3),
          harvested: false,
          respawnT: 0,
          colliderR: 0.5,
        };
        root.traverse((o) => { if (o.isMesh) o.userData.resource = node; });
        this.group.add(root);
        this.nodes.push(node);
      }
    };
    if (biome === 'desert') {
      mk('ferrite', 22, 230);
      mk('silica', 24, 230);
    } else if (biome === 'glowfen') {
      mk('lumen', 34, 230);
      mk('ferrite', 12, 230);
    } else {
      mk('ferrite', 22, 230);
      mk('silica', 14, 230);
    }
  }

  nearest(pos, type, radius = 3.2) {
    let best = null, bd = radius;
    for (const n of this.nodes) {
      if (n.harvested) continue;
      if (type && n.type !== type) continue;
      const d = Math.hypot(n.pos.x - pos.x, n.pos.z - pos.z);
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  }

  harvest(node) {
    if (!node || node.harvested) return null;
    node.harvested = true;
    node.respawnT = 90;
    node.root.visible = false;
    const out = { type: node.type, amount: node.amount };
    return out;
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
}
