// 植被与岩石：实例化草丛 / 蕨类 / 发光花 / 巨蕨树 / 岩柱 / 水晶
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createNoise } from '../core/noise.js';
import {
  plantMaterial, tuftGeometry, clumpGeometry, fernGeometry, flowerGeometry, crownGeometry, mossGeometry, mushroomGeometry, bladeGeometry,
} from './flora.js';

// 简化版草材质：用于阴影深度（保证阴影 pass 中也有 uInstPos 属性）
function customDepthMaterial() {
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      '#include <common>\nattribute vec3 uInstPos;\nuniform float uWind;'
    );
  };
  return m;
}

function scatterInstances(geo, material, placements, castShadow = false) {
  const mesh = new THREE.InstancedMesh(geo, material, placements.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const e = new THREE.Euler();
  placements.forEach((pl, i) => {
    p.set(pl.x, pl.y, pl.z);
    e.set(pl.tiltX || 0, pl.rot || 0, pl.tiltZ || 0);
    q.setFromEuler(e);
    const sc = pl.scale || 1;
    s.set(sc * (pl.sx || 1), sc * (pl.sy || 1), sc * (pl.sz || 1));
    m.compose(p, q, s);
    mesh.setMatrixAt(i, m);
  });
  mesh.instanceMatrix.needsUpdate = true;
  const phase = new Float32Array(placements.length);
  const bend = new Float32Array(placements.length);
  placements.forEach((pl, i) => { phase[i] = Math.random() * 6.283; bend[i] = pl.bend ?? 0.5; });
  geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1));
  geo.setAttribute('aBend', new THREE.InstancedBufferAttribute(bend, 1));
  // 阴影深度 pass 需声明 uInstPos（否则属性缺失会整批丢弃）
  const depthMat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide });
  depthMat.customProgramCacheKey = () => 'plant-depth';
  depthMat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nattribute vec3 uInstPos;');
  };
  mesh.customDepthMaterial = depthMat;
  const ip = new Float32Array(placements.length * 3);
  placements.forEach((pl, i) => { ip[i * 3] = pl.x; ip[i * 3 + 1] = pl.y; ip[i * 3 + 2] = pl.z; });
  geo.setAttribute('uInstPos', new THREE.InstancedBufferAttribute(ip, 3));
  mesh.castShadow = castShadow;
  mesh.receiveShadow = false;
  mesh.frustumCulled = true;
  return mesh;
}

export class Vegetation {
  constructor(terrain, palette, quality) {
    this.terrain = terrain;
    this.palette = palette;
    this.quality = quality;
    this.group = new THREE.Group();
    this.group.name = 'vegetation';
    this.materials = [];
    this.rng = createNoise((terrain.def.seed || 7) * 3 + 5).rnd;
    this.colliders = [];
    this.shade = Array.from({ length: 40 }, () => new THREE.Vector4(0, 0, 0, 0));
    this.build();
  }

  _sample(count, radius, minR = 0, filter) {
    const out = [];
    let tries = 0;
    while (out.length < count && tries < count * 12) {
      tries++;
      const a = this.rng() * Math.PI * 2;
      const r = minR + Math.sqrt(this.rng()) * (radius - minR);
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const y = this.terrain.height(x, z);
      if (filter && !filter(x, z, y)) continue;
      out.push({ x, y, z, rot: this.rng() * Math.PI * 2, scale: 1, r });
    }
    return out;
  }

  get biome() {
    return this.terrain.def.biome;
  }

  build() {
    const { terrain, palette, quality, biome } = this;
    const pl = palette.plant;
    const isNight = palette.id === 'lumina';
    const isDesert = biome === 'desert';
    const hq = quality === 'high';

    // 先种树，树荫影响到其它植物
    this.buildTrees();

    // ---------------- 草簇 ----------------
    const tuft = clumpGeometry(3, isDesert ? 0.16 : 0.2);
    const grassMat = plantMaterial(palette, pl.grassA, pl.grassTip, isNight ? 0.5 : 0.0, this.shade);
    this.materials.push(grassMat);
    const grassCount = Math.floor((isDesert ? 5000 : 52000) * (hq ? 1 : 0.5));
    const grass = this._sample(grassCount + 40, 235, 0, (x, z) => terrain.slopeAt(x, z) < 0.5)
      .map((p) => {
        const near = p.r < 95; // 近处更高更密
        const home = this.home || { x: 0, z: 0 };
        const dh = Math.hypot(p.x - home.x, p.z - home.z);
        if (dh < 2.5) return null; // 出生点脚下留出空地
        const nearK = Math.max(0, 1 - dh / 40); // 出生点附近更矮、更细碎，保证视野
        if (p.r === undefined) return null;
        return { ...p, scale: (isDesert ? 0.3 : 0.3) + this.rng() * (near ? 0.34 : 0.26), sy: ((near ? 0.7 : 0.5) + this.rng() * 0.7) * (1 - nearK * 0.45), bend: 0.9, tiltX: (this.rng() - 0.5) * 0.25, tiltZ: (this.rng() - 0.5) * 0.25 };
      });
    const grassOk = grass.filter(Boolean);
    this.grass = scatterInstances(tuft, grassMat, grassOk);
    this.group.add(this.grass);
    // 近景密集草层：只在玩家周围 ~58m 内，让小范围视野真正"茂密"
    {
      const nearCount = Math.floor((isDesert ? 6000 : 26000) * (hq ? 1 : 0.5));
      const home = this.home || { x: 0, z: 0 };
      const nearGrass = this._sample(nearCount, 58, 2.5, (x, z) => terrain.slopeAt(x, z) < 0.5)
        .map((p) => {
          const dh = Math.hypot(p.x - home.x, p.z - home.z);
          if (dh < 2.2) return null;
          return {
            ...p,
            scale: 0.20 + this.rng() * 0.20,
            sy: 0.34 + this.rng() * 0.38,
            bend: 0.9,
            tiltX: (this.rng() - 0.5) * 0.3,
            tiltZ: (this.rng() - 0.5) * 0.3,
          };
        })
        .filter(Boolean);
      const nearMesh = scatterInstances(tuft, grassMat, nearGrass);
      nearMesh.castShadow = false;
      this.group.add(nearMesh);
    }
    // 细草穗（近景层次）
    const spikeGeo = tuftGeometry(5);
    const spikes = this._sample(Math.floor(8000 * (hq ? 1 : 0.5)), 140, 1, (x, z) => terrain.slopeAt(x, z) < 0.5)
      .map((p) => ({ ...p, scale: 0.35 + this.rng() * 0.4, sy: 0.7 + this.rng() * 0.6, bend: 1.0 }));
    this.spikes = scatterInstances(spikeGeo, grassMat, spikes);
    this.group.add(this.spikes);

    // ---------------- 蕨类 ----------------
    const fernMat = plantMaterial(palette, pl.fern, isDesert ? pl.grassTip : [pl.fern[0] * 1.6, pl.fern[1] * 1.5, pl.fern[2] * 1.4], isNight ? 0.7 : 0.0, this.shade);
    this.materials.push(fernMat);
    const fernGeo = fernGeometry(1.0, 13, 0.62);
    const fernCount = Math.floor((isDesert ? 400 : 7000) * (hq ? 1 : 0.5));
    const home = this.home || { x: 0, z: 0 };
    const ferns = this._sample(fernCount, 232, 3, (x, z) => terrain.slopeAt(x, z) < 0.55 && Math.hypot(x - home.x, z - home.z) > 5)
      .map((p) => ({ ...p, scale: 0.32 + this.rng() * 0.5, sy: 0.55 + this.rng() * 0.55, bend: 0.35, tiltZ: 0.1 }));
    this.ferns = scatterInstances(fernGeo, fernMat, ferns);
    this.group.add(this.ferns);

    // ---------------- 发光花 ----------------
    const flowerGeo = flowerGeometry(isDesert ? 6 : 5, 0.055);
    const flowerMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setRGB(...pl.flower),
      emissive: new THREE.Color().setRGB(...pl.flowerGlow),
      emissiveIntensity: isNight ? 2.2 : isDesert ? 1.2 : 0.7,
      roughness: 0.6,
      side: THREE.DoubleSide,
    });
    const flowers = this._sample(4200, 230, 2, (x, z) => terrain.slopeAt(x, z) < 0.45);
    const fm = new THREE.InstancedMesh(flowerGeo, flowerMat, flowers.length);
    const dummy = new THREE.Object3D();
    flowers.forEach((f, i) => {
      dummy.position.set(f.x, f.y + 0.03 + this.rng() * 0.08, f.z);
      dummy.scale.setScalar(0.4 + this.rng() * 0.8);
      dummy.rotation.set((this.rng() - 0.5) * 0.4, this.rng() * 6.28, (this.rng() - 0.5) * 0.4);
      dummy.updateMatrix();
      fm.setMatrixAt(i, dummy.matrix);
    });
    fm.name = 'flowers';
    this.group.add(fm);

    // ---------------- 苔藓地毯（近地面层次） ----------------
    if (!isDesert) {
      const mossMat = plantMaterial(palette, [pl.grassA[0] * 1.15, pl.grassA[1] * 1.2, pl.grassA[2] * 1.05], pl.grassB, isNight ? 0.15 : 0, this.shade);
      this.materials.push(mossMat);
      // 苔藓地毯：贴合地面、扁平小块（半径不宜超过 ~0.5m，否则会像漂浮的绿盘）
      const moss = this._sample(2600, 225, 4, (x, z) => terrain.slopeAt(x, z) < 0.5)
        .map((p) => ({ ...p, scale: 0.28 + this.rng() * 0.36, sy: 1 }));
      const mossMesh = scatterInstances(mossGeometry(1), mossMat, moss);
      mossMesh.renderOrder = 1;
      this.group.add(mossMesh);
    }

    // ---------------- 发光蘑菇（幽蓝之心的近景点缀） ----------------
    if (biome === 'glowfen') {
      const mushMat = new THREE.MeshStandardMaterial({
        color: new THREE.Color('#8fd8ff'),
        emissive: new THREE.Color().setRGB(0.3, 0.7, 1.4),
        emissiveIntensity: 2.2,
        roughness: 0.5,
      });
      const mg = mushroomGeometry();
      const spots = this._sample(420, 200, 4);
      const im = new THREE.InstancedMesh(mg, mushMat, spots.length);
      spots.forEach((s, i) => {
        dummy.position.set(s.x, s.y, s.z);
        dummy.scale.setScalar(0.6 + this.rng() * 1.8);
        dummy.rotation.y = this.rng() * 6.28;
        dummy.updateMatrix();
        im.setMatrixAt(i, dummy.matrix);
      });
      this.group.add(im);
      this.mushrooms = im;
    }

    // ---------------- 岩石 ----------------
    this.buildRocks();
    if (biome === 'desert') this.buildSpires();
    if (biome === 'glowfen') this.buildCrystals();
  }

  // ---------------- 巨蕨树 ----------------
  buildTrees() {
    const { terrain, palette, biome } = this;
    const pl = palette.plant;
    this.trees = [];
    const treeCount = biome === 'glowfen' ? 52 : biome === 'desert' ? 0 : 46;
    const spots = [];
    let guard = 0;
    const minDist = biome === 'glowfen' ? 11 : 13;
    while (spots.length < treeCount && guard < 6000) {
      guard++;
      const a = this.rng() * Math.PI * 2;
      const r = 20 + Math.sqrt(this.rng()) * 215;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (Math.hypot(x, z) < 16) continue;
      if (terrain.slopeAt(x, z) > 0.3) continue;
      if (spots.some((t) => Math.hypot(t.x - x, t.z - z) < minDist)) continue;
      spots.push({ x, z, y: terrain.height(x, z) });
    }
    // 树荫数据
    spots.forEach((s, i) => {
      if (i < 40) this.shade[i].set(s.x, s.z, 0.48, 5.5 + this.rng() * 2.5);
    });
    const trunkMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setRGB(...pl.trunk),
      roughness: 0.8,
      metalness: 0.05,
    });
    trunkMat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vTP;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvTP = (modelMatrix * vec4(transformed,1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vTP;\nfloat hsh(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}\nfloat vn(vec2 p){vec2 i=floor(p),f=fract(p);vec2 u=f*f*(3.0-2.0*f);return mix(mix(hsh(i),hsh(i+vec2(1,0)),u.x),mix(hsh(i+vec2(0,1)),hsh(i+vec2(1,1)),u.x),u.y);}')
        .replace('#include <color_fragment>', '#include <color_fragment>\n float barkN = vn(vec2((vTP.x+vTP.z)*7.0, vTP.y*2.4));\n float ring = vn(vec2((vTP.x+vTP.z)*1.5, vTP.y*22.0));\n diffuseColor.rgb *= (0.62+0.62*barkN)*(0.86+0.26*ring);');
    };
    const crownMat = plantMaterial(palette, pl.fern, biome === 'glowfen' ? pl.grassTip : [pl.grassTip[0] * 0.75, pl.grassTip[1] * 0.9, pl.grassTip[2] * 0.6], biome === 'glowfen' ? 0.75 : 0.0, this.shade);
    this.materials.push(crownMat);
    const crownGeo = crownGeometry(12, 2.2);
    const glowFlowerGeo = flowerGeometry(6, 0.11);
    const glowMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setRGB(...pl.flower),
      emissive: new THREE.Color().setRGB(...pl.flowerGlow),
      emissiveIntensity: biome === 'glowfen' ? 2.4 : 0.7,
      roughness: 0.55,
      side: THREE.DoubleSide,
    });
    for (const spot of spots) {
      const tree = new THREE.Group();
      const h = biome === 'glowfen' ? 8 + this.rng() * 7 : 10 + this.rng() * 8;
      const trunkR = 0.36 + this.rng() * 0.22;
      const segs = 6;
      let parent = new THREE.Group();
      tree.add(parent);
      let y = 0;
      let ang = this.rng() * 6.28;
      const leanX = (this.rng() - 0.5) * 0.05, leanZ = (this.rng() - 0.5) * 0.05;
      for (let s = 0; s < segs; s++) {
        const t = s / segs;
        const r0 = trunkR * (1 - t * 0.6);
        const r1 = trunkR * (1 - (t + 1 / segs) * 0.6);
        const len = h / segs;
        const g = new THREE.CylinderGeometry(r1, r0 * 1.08, len, 8, 1);
        g.translate(0, len / 2, 0);
        // 树干弯曲轮廓
        const pa = g.attributes.position;
        for (let k = 0; k < pa.count; k++) {
          const px = pa.getX(k), pz = pa.getZ(k);
          const a = Math.atan2(pz, px);
          const k2 = 1 + Math.sin(a * 5 + s) * 0.06;
          pa.setX(k, px * k2); pa.setZ(k, pz * k2);
        }
        g.computeVertexNormals();
        const m = new THREE.Mesh(g, trunkMat);
        // 每段都挂在同一个竖直父级下，位置做轻微蛇形偏移 —— 避免旋转累积造成"折线"
        const lean = (s / segs);
        m.position.set(leanX * lean * 2.2, y, leanZ * lean * 2.2);
        m.rotation.z = leanX * 0.6;
        m.rotation.x = leanZ * 0.6;
        m.castShadow = true;
        m.receiveShadow = true;
        parent.add(m);
        y += len;
      }
      // 树冠：多层级叠生的蕨叶，形成厚实的巨蕨冠层
      const crownPivot = new THREE.Group();
      crownPivot.position.set(leanX * 2.2, y, leanZ * 2.2);
      crownPivot.rotation.y = this.rng() * 6.28;
      tree.add(crownPivot);
      const crownScale = (biome === 'glowfen' ? 1.35 : 1.15) * (0.9 + this.rng() * 0.35);
      const layers = [
        { y: 0.0, s: 1.0, tilt: 0.0 },
        { y: -0.75, s: 0.78, tilt: 0.22 },
        { y: -1.5, s: 0.56, tilt: 0.4 },
      ];
      for (let li = 0; li < layers.length; li++) {
        const L = layers[li];
        const crown = new THREE.Mesh(crownGeo, crownMat);
        crown.position.y = L.y;
        crown.rotation.y = this.rng() * 6.28;
        crown.rotation.x = (this.rng() - 0.5) * 0.16;
        crown.scale.setScalar(crownScale * L.s);
        crown.userData.baseY = L.y;
        crown.userData.phase = this.rng() * 6.28;
        crown.userData.sway = 0.04 + li * 0.015;
        crownPivot.add(crown);
        // 记录给 update 做摇曳
        if (!this.crowns) this.crowns = [];
        this.crowns.push(crown);
      }
      // 树冠中心的一簇短叶（填补空隙，避免看到"空洞"）
      const top = new THREE.Mesh(crownGeo, crownMat);
      top.position.y = 0.55;
      top.scale.setScalar(crownScale * 0.5);
      top.rotation.y = this.rng() * 6.28;
      top.userData.baseY = 0.55;
      top.userData.phase = this.rng() * 6.28;
      top.userData.sway = 0.05;
      crownPivot.add(top);
      if (!this.crowns) this.crowns = [];
      this.crowns.push(top);
      // 冠层下的发光花
      for (let i = 0; i < 18; i++) {
        const a = this.rng() * Math.PI * 2;
        const rr = 0.7 + this.rng() * 2.2;
        const fm = new THREE.Mesh(glowFlowerGeo, glowMat);
        fm.position.set(Math.cos(a) * rr, -0.7 - this.rng() * 2.4, Math.sin(a) * rr);
        fm.rotation.set((this.rng() - 0.5) * 1.2, this.rng() * 6.28, 0);
        fm.scale.setScalar(0.7 + this.rng() * 1.0);
        crownPivot.add(fm);
      }
      tree.position.set(spot.x, spot.y - 0.3, spot.z);
      tree.userData.isTree = true;
      this.group.add(tree);
      this.trees.push(tree);
      this.colliders.push({ x: spot.x, z: spot.z, r: trunkR * 1.5 });
    }
  }

  // ---------------- 岩石 ----------------
  buildRocks() {
    const pl = this.palette.plant;
    const rockMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setRGB(pl.rock[0] * 0.62, pl.rock[1] * 0.6, pl.rock[2] * 0.55),
      roughness: 0.88,
      metalness: 0.0,
    });
    rockMat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWP;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWP = (modelMatrix * vec4(transformed,1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWP;\nfloat hsh(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}\nfloat vn(vec2 p){vec2 i=floor(p),f=fract(p);vec2 u=f*f*(3.0-2.0*f);return mix(mix(hsh(i),hsh(i+vec2(1,0)),u.x),mix(hsh(i+vec2(0,1)),hsh(i+vec2(1,1)),u.x),u.y);}')
        .replace('#include <color_fragment>', '#include <color_fragment>\n  float n1 = vn(vWP.xz*1.7+vWP.y*0.9);\n  float n2 = vn(vWP.xz*7.0-vWP.y*3.0);\n  float strata = smoothstep(0.35,0.5,fract(vWP.y*0.55+n1*0.35));\n  diffuseColor.rgb *= (0.70 + 0.54*n1) * (0.9 + 0.15*n2);\n  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb*1.45, strata*0.5);');
    };
    const variants = [];
    for (let v = 0; v < 4; v++) {
      const g = new THREE.IcosahedronGeometry(1, 2);
      const pa = g.attributes.position;
      const nz = createNoise(v * 17 + 3);
      for (let i = 0; i < pa.count; i++) {
        const x = pa.getX(i), y = pa.getY(i), z = pa.getZ(i);
        const k = 1 + nz.noise3(x * 1.4, y * 1.4, z * 1.4) * 0.24 + nz.noise3(x * 4, y * 4, z * 4) * 0.06;
        pa.setXYZ(i, x * k, y * k * 0.72, z * k);
      }
      g.computeVertexNormals();
      variants.push(g);
    }
    const rocks = this._sample(560, 258, 6, (x, z) => this.terrain.slopeAt(x, z) < 0.8)
      .map((p) => {
        const home = this.home || { x: 0, z: 0 };
        const dh = Math.hypot(p.x - home.x, p.z - home.z);
        const sc = 0.4 + Math.pow(this.rng(), 2.2) * 3.0;
        return { ...p, scale: dh < 14 ? sc * 0.45 : sc, sink: dh < 14 ? 0.55 : 0.3 };
      });
    const d = new THREE.Object3D();
    for (let v = 0; v < 4; v++) {
      const grp = rocks.filter((_, i) => i % 4 === v);
      const im = new THREE.InstancedMesh(variants[v], rockMat, grp.length);
      grp.forEach((r, i) => {
        d.position.set(r.x, r.y - r.scale * (r.sink ?? 0.3), r.z);
        d.rotation.set(this.rng() * 0.3, this.rng() * 6.28, this.rng() * 0.3);
        d.scale.set(r.scale * (0.85 + this.rng() * 0.4), r.scale * (0.6 + this.rng() * 0.7), r.scale * (0.85 + this.rng() * 0.4));
        d.updateMatrix();
        im.setMatrixAt(i, d.matrix);
        if (r.scale > 1.0 && Math.hypot(r.x, r.z) < 245) this.colliders.push({ x: r.x, z: r.z, r: r.scale * 0.8 });
      });
      im.castShadow = true;
      im.receiveShadow = true;
      this.group.add(im);
    }
  }

  buildSpires() {
    const pl = this.palette.plant;
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setRGB(...pl.rock).multiplyScalar(1.2),
      roughness: 0.9,
      metalness: 0.0,
    });
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vSP;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvSP = (modelMatrix * vec4(transformed,1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vSP;\nfloat hsh(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}\nfloat vn(vec2 p){vec2 i=floor(p),f=fract(p);vec2 u=f*f*(3.0-2.0*f);return mix(mix(hsh(i),hsh(i+vec2(1,0)),u.x),mix(hsh(i+vec2(0,1)),hsh(i+vec2(1,1)),u.x),u.y);}')
        .replace('#include <color_fragment>', '#include <color_fragment>\n float band = vn(vec2(vSP.y*1.6, (vSP.x+vSP.z)*0.15));\n float band2 = smoothstep(0.3,0.5,fract(vSP.y*0.7+band*0.4));\n diffuseColor.rgb *= (0.72+0.5*band);\n diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb*vec3(1.28,1.0,0.8), band2*0.7);');
    };
    const spires = this._sample(40, 252, 30, (x, z) => Math.hypot(x, z) > 45);
    for (const s of spires) {
      const count = 1 + Math.floor(this.rng() * 3);
      for (let c = 0; c < count; c++) {
        const x = s.x + (this.rng() - 0.5) * 12, z = s.z + (this.rng() - 0.5) * 12;
        const base = this.terrain.height(x, z);
        const hh = 8 + this.rng() * 26;
        const rr = 1.2 + this.rng() * 2.2;
        const g = new THREE.CylinderGeometry(rr * 0.5, rr, hh, 11, 8);
        const pa = g.attributes.position;
        const nz = createNoise(c * 3 + 11);
        for (let i = 0; i < pa.count; i++) {
          const px = pa.getX(i), py = pa.getY(i), pz = pa.getZ(i);
          const t = (py + hh / 2) / hh;
          const k = 1 + nz.noise3(px * 0.5, py * 0.22, pz * 0.5) * 0.28 * (0.4 + t);
          pa.setXYZ(i, px * k, py + nz.noise3(px, py * 0.1, pz) * 0.25, pz * k);
        }
        g.computeVertexNormals();
        const m = new THREE.Mesh(g, mat);
        m.position.set(x, base + hh / 2 - 1.8, z);
        m.rotation.y = this.rng() * 6.28;
        m.rotation.z = (this.rng() - 0.5) * 0.06;
        m.castShadow = true;
        m.receiveShadow = true;
        this.group.add(m);
        this.colliders.push({ x, z, r: rr * 1.0 });
      }
    }
  }

  buildCrystals() {
    const crystalMat = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color('#79d8ff'),
      emissive: new THREE.Color(0.15, 0.5, 0.9),
      emissiveIntensity: 1.4,
      roughness: 0.05,
      metalness: 0.0,
      transmission: 0.5,
      thickness: 0.4,
      ior: 1.6,
      transparent: true,
      opacity: 0.95,
    });
    this.crystalMat = crystalMat;
    const geo = new THREE.OctahedronGeometry(1, 0);
    geo.scale(0.32, 1.7, 0.32);
    const spots = this._sample(150, 240, 8, (x, z) => Math.hypot(x, z) > 14);
    const im = new THREE.InstancedMesh(geo, crystalMat, spots.length);
    const d = new THREE.Object3D();
    spots.forEach((s, i) => {
      d.position.set(s.x, s.y + 0.6, s.z);
      d.rotation.set((this.rng() - 0.5) * 0.6, this.rng() * 6.28, (this.rng() - 0.5) * 0.6);
      d.scale.setScalar(0.55 + Math.pow(this.rng(), 1.6) * 2.0);
      d.updateMatrix();
      im.setMatrixAt(i, d.matrix);
    });
    this.group.add(im);
    this.crystalMesh = im;
  }

  update(time) {
    for (const m of this.materials) if (m.uniforms && m.uniforms.uTime) m.uniforms.uTime.value = time;
    // 巨蕨冠层随风轻摆（每层相位不同，形成层次感）
    if (this.crowns) {
      for (const cr of this.crowns) {
        const ph = cr.userData.phase || 0;
        const amp = cr.userData.sway || 0.03;
        const s = Math.sin(time * 0.55 + ph);
        cr.rotation.z = s * amp;
        cr.rotation.x = Math.cos(time * 0.43 + ph) * amp * 0.7;
        if (cr.userData.baseY !== undefined) {
          cr.position.y = cr.userData.baseY + Math.sin(time * 0.7 + ph * 1.3) * 0.035;
        }
      }
    }
  }

  blocked(x, z, pad = 0) {
    for (const c of this.colliders) {
      const dx = c.x - x, dz = c.z - z;
      if (dx * dx + dz * dz < (c.r + pad) * (c.r + pad)) return c;
    }
    return null;
  }
}
