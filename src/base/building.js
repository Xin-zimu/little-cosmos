// 基地建设：全息预览、吸附、旋转、确认建造动画；功能模块（居住舱/能源站/采矿机/存储/科研/停机坪）
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { clamp, damp } from '../core/noise.js';

// 每个建筑都声明：
//   size      占地 [宽, 高, 深]
//   solid     是否阻挡角色（可进入的居住舱留出登舱通道）
//   colliderR 角色/镜头阻挡半径（米）
//   topY      相对地面的遮挡高度，供镜头体积判定使用
export const BUILDINGS = {
  habitat: {
    name: '居住舱', en: 'HABITAT', desc: '可进入的小型生活舱，恢复护盾并作为重生点。',
    cost: { ferrite: 9, silica: 3 }, power: 0, produce: { energyUse: 2 }, size: [3.2, 2.4, 3.2], icon: '⌂',
    solid: true, colliderR: 1.45, topY: 2.7, respawn: true,
  },
  solar: {
    name: '太阳能阵列', en: 'SOLAR ARRAY', desc: '白天持续供电，夜晚依靠储能。',
    cost: { ferrite: 5, silica: 6 }, power: 6, size: [4.2, 2.2, 4.2], icon: '☀',
    solid: true, colliderR: 1.5, topY: 2.4,
  },
  miner: {
    name: '采矿无人机', en: 'MINER DRONE', desc: '缓慢自动开采附近的矿脉。',
    cost: { ferrite: 8, silica: 2 }, power: 0, produce: { ferrite: 1 }, energyUse: 3, size: [2.6, 2.2, 2.6], icon: '⛏',
    solid: true, colliderR: 0.9, topY: 1.8,
  },
  storage: {
    name: '资源存储', en: 'STORAGE', desc: '提升资源上限并自动整理入库。',
    cost: { ferrite: 8 }, power: 0, size: [2.4, 1.8, 2.4], icon: '▤',
    solid: true, colliderR: 1.0, topY: 1.7, capacity: 60,
  },
  lab: {
    name: '科研站', en: 'RESEARCH NODE', desc: '分析生物样本，解锁装备升级。',
    cost: { ferrite: 10, silica: 10, bio: 6 }, power: 0, energyUse: 4, size: [3.0, 3.6, 3.0], icon: '◉',
    solid: true, colliderR: 1.1, topY: 3.4,
  },
  pad: {
    name: '停机坪', en: 'LANDING PAD', desc: '为飞船提供起降平台与补给。',
    cost: { ferrite: 16, silica: 6 }, power: 0, size: [5.0, 0.5, 5.0], icon: '◎',
    solid: false, colliderR: 0, topY: 0.3, landing: true,
  },
};
export const BUILD_ORDER = ['habitat', 'solar', 'miner', 'storage', 'lab', 'pad'];

function holoMaterial(color) {
  return new THREE.ShaderMaterial({
    vertexShader: /* glsl */ `
      varying vec3 vW; varying vec3 vN;
      void main(){ vec4 wp = modelMatrix*vec4(position,1.0); vW = wp.xyz; vN = normalize(mat3(modelMatrix)*normal); gl_Position = projectionMatrix*viewMatrix*wp; }`,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec3 vW; varying vec3 vN;
      uniform vec3 uColor; uniform float uTime, uOk;
      void main(){
        vec3 V = normalize(cameraPosition - vW);
        float fres = pow(1.0 - abs(dot(normalize(vN), V)), 2.0);
        float scan = smoothstep(0.48, 0.5, fract(vW.y * 5.0 - uTime * 1.2)) * 0.6;
        float grid = step(0.92, fract(vW.x * 2.0)) + step(0.92, fract(vW.z * 2.0));
        vec3 col = mix(vec3(1.0,0.35,0.25), uColor, uOk);
        float a = 0.16 + fres * 0.5 + scan * 0.3 + grid * 0.15;
        gl_FragColor = vec4(col * (1.2 + fres), a);
      }`,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    uniforms: { uColor: { value: new THREE.Color(color) }, uTime: { value: 0 }, uOk: { value: 1 } },
  });
}

export class BuildingSystem {
  constructor(game) {
    this.game = game;
    this.group = new THREE.Group();
    this.group.name = 'base';
    this.items = [];
    this.ghost = null;
    this.ghostType = null;
    this.rot = 0;
    this.valid = false;
    this.holoMat = holoMaterial(game.palette.accent);
    this.ringGhost = this.makeRing();
    this.buildHologram();
    this.power = 0;
    this.capacity = 0;
    // 供电基线（非矿机负载），供 isOperational 在首帧 update 之前查询
    this.gen = 0;
    this.baseUse = 0;
    this.use = 0;
  }

  makeRing() {
    const g = new THREE.RingGeometry(1.15, 1.3, 48);
    g.rotateX(-Math.PI / 2);
    const m = new THREE.MeshBasicMaterial({ color: new THREE.Color(this.game.palette.accent), transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false });
    const mesh = new THREE.Mesh(g, m);
    mesh.visible = false;
    return mesh;
  }

  buildHologram() {
    this.holo = new THREE.Group();
    for (const type of BUILD_ORDER) {
      const h = this.makeGeometryFor(type, true);
      h.visible = false;
      h.userData.type = type;
      this.holo.add(h);
    }
    this.game.scene.add(this.holo);
    this.game.scene.add(this.ringGhost);
  }

  // 建筑外观（也用于真实建筑，shared function）
  makeGeometryFor(type, ghost = false) {
    const g = new THREE.Group();
    const pal = this.game.palette;
    const add = (geo, mat) => {
      const m = new THREE.Mesh(geo, ghost ? this.holoMat : mat);
      m.castShadow = !ghost; m.receiveShadow = !ghost;
      g.add(m);
      return m;
    };
    const M = () => ({
      hull: new THREE.MeshStandardMaterial({ color: new THREE.Color('#e7e4dc'), roughness: 0.42, metalness: 0.15 }),
      dark: new THREE.MeshStandardMaterial({ color: new THREE.Color('#343a40'), roughness: 0.5, metalness: 0.4 }),
      glow: new THREE.MeshStandardMaterial({ color: new THREE.Color(pal.accent), emissive: new THREE.Color(pal.accent), emissiveIntensity: 2.2, roughness: 0.3 }),
      metal: new THREE.MeshStandardMaterial({ color: new THREE.Color('#a8b0b8'), roughness: 0.3, metalness: 0.9 }),
      panel: new THREE.MeshStandardMaterial({ color: new THREE.Color('#2b3a4a'), roughness: 0.18, metalness: 0.6, emissive: new THREE.Color(pal.accent).multiplyScalar(0.08) }),
    });
    const mats = ghost ? null : M();
    switch (type) {
      case 'habitat': {
        // 圆顶居住舱：底座环 + 主舱体 + 结构肋 + 舷窗带 + 顶部气闸
        const base = add(new THREE.CylinderGeometry(1.42, 1.52, 0.22, 22), mats?.dark);
        base.position.y = -1.06;
        const skirt = add(new THREE.CylinderGeometry(1.34, 1.46, 0.16, 22), mats?.metal);
        skirt.position.y = -0.9;
        const body = add(new THREE.CylinderGeometry(1.28, 1.32, 0.86, 22, 1), mats?.hull);
        body.position.y = -0.44;
        const dome = add(new THREE.SphereGeometry(1.28, 24, 14, 0, Math.PI * 2, 0, Math.PI / 2), mats?.hull);
        dome.position.y = 0.0;
        // 结构肋（沿穹顶经线的弧形筋）
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2;
          const rib = add(new THREE.TorusGeometry(1.29, 0.026, 5, 22, Math.PI / 2), mats?.metal);
          // 半圆环默认位于 XY 平面：绕 Y 旋转到经线方向
          rib.rotation.set(0, a, -Math.PI / 2);
          rib.position.y = 0.0;
        }
        const ringA = add(new THREE.TorusGeometry(1.3, 0.035, 6, 30), mats?.metal);
        ringA.rotation.x = Math.PI / 2; ringA.position.y = 0.02;
        const ringB = add(new THREE.TorusGeometry(1.14, 0.026, 6, 30), mats?.metal);
        ringB.rotation.x = Math.PI / 2; ringB.position.y = 0.6;
        // 舷窗带（发光胶囊窗，贴在舱体侧面）
        for (let i = 0; i < 5; i++) {
          const a = (i / 5) * Math.PI * 2 + 0.3;
          const wx = Math.cos(a) * 1.27, wz = Math.sin(a) * 1.27;
          const wf = add(new RoundedBoxGeometry(0.44, 0.36, 0.07, 2, 0.03), mats?.dark);
          wf.position.set(wx, -0.44, wz);
          wf.rotation.y = -a + Math.PI / 2;
          const win = add(new RoundedBoxGeometry(0.34, 0.26, 0.05, 2, 0.03), mats?.glow);
          win.position.set(Math.cos(a) * 1.31, -0.44, Math.sin(a) * 1.31);
          win.rotation.y = -a + Math.PI / 2;
        }
        // 顶部气闸 + 天线
        const hatchBase = add(new THREE.CylinderGeometry(0.42, 0.46, 0.14, 16), mats?.dark);
        hatchBase.position.y = 1.24;
        const hatchDome = add(new THREE.SphereGeometry(0.36, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), mats?.hull);
        hatchDome.position.y = 1.31;
        const halo = add(new THREE.TorusGeometry(0.4, 0.022, 6, 26), mats?.glow);
        halo.rotation.x = Math.PI / 2; halo.position.y = 1.33;
        const mast = add(new THREE.CylinderGeometry(0.022, 0.03, 0.7, 6), mats?.metal);
        mast.position.set(0.55, 1.5, 0);
        const beacon = add(new THREE.SphereGeometry(0.07, 10, 8), mats?.glow);
        beacon.position.set(0.55, 1.88, 0);
        // 侧面设备箱
        const box = add(new RoundedBoxGeometry(0.5, 0.34, 0.3, 2, 0.04), mats?.dark);
        box.position.set(-1.05, -0.6, 0.55); box.rotation.y = 0.7;
        // 底部支撑脚
        for (let i = 0; i < 4; i++) {
          const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
          const foot = add(new THREE.CylinderGeometry(0.11, 0.15, 0.2, 8), mats?.metal);
          foot.position.set(Math.cos(a) * 1.3, -1.14, Math.sin(a) * 1.3);
        }
        // BUG-22：原点修正放进独立子节点 pivot，而不是整个组的 position.y。
        // 这样 confirm/restore 覆盖根位置时不会把模型整体沉进地面。
        // （由 makeGeometryFor 末尾统一处理，这里只记录偏移）
        g.userData.groundOffset = 1.24;
        // 入户光带（交互点）
        const entry = add(new THREE.TorusGeometry(0.62, 0.026, 6, 28), mats?.glow);
        entry.rotation.x = Math.PI / 2; entry.position.y = -0.96; entry.position.z = 1.15;
        break;
      }
      case 'solar': {
        for (const s of [-1, 1]) {
          const pole = add(new THREE.CylinderGeometry(0.05, 0.05, 1.3, 8), mats?.metal);
          pole.position.set(s * 1.2, 0.65, 0);
          const pivot = new THREE.Group();
          pivot.position.set(s * 1.2, 1.3, 0);
          pivot.rotation.x = -0.5;
          g.add(pivot);
          for (let k = 0; k < 3; k++) {
            const panel = add(new THREE.BoxGeometry(0.95, 0.03, 0.75 * 1.0), mats?.panel);
            panel.position.set(s * (k - 1) * 0.98, 0, 0);
            pivot.add(panel);
          }
          const frame = add(new THREE.BoxGeometry(3.0, 0.05, 0.82), mats?.metal);
          frame.position.set(s * 1.2, 1.28, 0); frame.rotation.x = -0.5;
          g.add(frame);
        }
        const base = add(new THREE.CylinderGeometry(0.5, 0.65, 0.25, 12), mats?.dark);
        base.position.y = 0.12;
        break;
      }
      case 'miner': {
        const base = add(new THREE.CylinderGeometry(0.65, 0.8, 0.35, 12), mats?.dark);
        base.position.y = 0.17;
        const arm1 = add(new RoundedBoxGeometry(0.18, 1.1, 0.18, 2, 0.04), mats?.hull);
        arm1.position.set(0.3, 0.85, 0); arm1.rotation.z = -0.35;
        const arm2 = add(new RoundedBoxGeometry(0.14, 0.9, 0.14, 2, 0.04), mats?.metal);
        arm2.position.set(0.95, 1.35, 0); arm2.rotation.z = 0.75;
        const drill = add(new THREE.ConeGeometry(0.12, 0.5, 8), mats?.glow);
        drill.position.set(1.35, 0.8, 0); drill.rotation.z = Math.PI;
        const head = add(new THREE.SphereGeometry(0.16, 10, 8), mats?.glow);
        head.position.set(0.05, 1.42, 0);
        break;
      }
      case 'storage': {
        const c1 = add(new RoundedBoxGeometry(1.6, 0.7, 1.1, 3, 0.08), mats?.hull);
        c1.position.y = 0.4;
        const c2 = add(new RoundedBoxGeometry(1.6, 0.7, 1.1, 3, 0.08), mats?.dark);
        c2.position.y = 1.1;
        const glow = add(new THREE.BoxGeometry(1.3, 0.06, 0.02), mats?.glow);
        glow.position.set(0, 0.75, 0.56);
        break;
      }
      case 'lab': {
        const base = add(new THREE.CylinderGeometry(0.9, 1.1, 0.3, 16), mats?.dark);
        base.position.y = 0.15;
        const tube = add(new THREE.CylinderGeometry(0.32, 0.32, 2.4, 16, 1, true), mats?.panel);
        tube.position.y = 1.5;
        const core = add(new THREE.CylinderGeometry(0.14, 0.14, 2.6, 12), mats?.glow);
        core.position.y = 1.5;
        const ring = add(new THREE.TorusGeometry(0.55, 0.05, 6, 24), mats?.metal);
        ring.rotation.x = Math.PI / 2; ring.position.y = 2.0;
        const cap = add(new THREE.SphereGeometry(0.36, 16, 10), mats?.hull);
        cap.position.y = 2.8;
        const dish = add(new THREE.SphereGeometry(0.4, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2.6), mats?.metal);
        dish.position.y = 3.1; dish.rotation.x = 0.6;
        g.userData.spinner = ring;
        break;
      }
      case 'pad': {
        const plate = add(new THREE.CylinderGeometry(2.4, 2.5, 0.22, 32), mats?.dark);
        plate.position.y = 0.11;
        const ring = add(new THREE.TorusGeometry(2.0, 0.06, 6, 48), mats?.glow);
        ring.rotation.x = Math.PI / 2; ring.position.y = 0.24;
        for (let i = 0; i < 4; i++) {
          const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
          const light = add(new THREE.SphereGeometry(0.09, 8, 6), mats?.glow);
          light.position.set(Math.cos(a) * 2.25, 0.25, Math.sin(a) * 2.25);
        }
        break;
      }
    }
    if (ghost) {
      g.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; o.userData.noBlock = true; } });
    } else {
      // BUG-29：实心建筑是弹道遮挡体（停机坪是地面平台，不挡枪线）
      if (BUILDINGS[type]?.solid !== false) {
        g.traverse((o) => { if (o.isMesh) o.userData.occluder = true; });
      }
    }
    // BUG-22：把模型原点修正封进子节点。根节点的位置始终等于“地面坐标”，
    // 预览、落成、读档三条路径因此共用同一套变换。
    const offset = g.userData.groundOffset || 0;
    if (offset) {
      const pivot = new THREE.Group();
      pivot.name = 'pivot';
      pivot.position.y = offset;
      while (g.children.length) pivot.add(g.children[0]);
      g.add(pivot);
    }
    return g;
  }

  startPlacing(type) {
    if (this.ghostType === type) { this.cancelPlacing(); return; }
    this.ghostType = type;
    this.rot = 0;
    // BUG-21：切换类型立即失效上一次的预览结果，
    // 避免“先预览可负担的建筑、再切类型、抢在重算前确认”绕过校验。
    this.valid = false;
    this.blockReason = '正在校验…';
    this.ghostPos = null;
    this.validatedType = null;
    this.holo.children.forEach((h) => { h.visible = h.userData.type === type; });
    this.ringGhost.visible = true;
    this.game.audio?.play('uiTick');
  }

  cancelPlacing() {
    this.ghostType = null;
    this.valid = false;
    this.ghostPos = null;
    this.validatedType = null;
    this.holo && this.holo.children.forEach((h) => (h.visible = false));
    this.ringGhost.visible = false;
  }

  rotate(dir) {
    if (!this.ghostType) return;
    this.rot += dir * Math.PI / 4;
    this.game.audio?.play('uiTick');
  }

  canAfford(type) {
    const cost = BUILDINGS[type].cost;
    for (const k in cost) if ((this.game.inventory[k] || 0) < cost[k]) return false;
    return true;
  }

  // BUG-26：统一的放置校验。预览与确认共用同一函数，且按旋转后的占地轮廓采样：
  // 地形高差、水位、植被碰撞体、已有建筑、火箭都要在整块占地内检查，而不是只看中心点。
  // 返回值: { ok, reason, y }
  validate(x, z, type, rot) {
    const t = this.game.terrain;
    const def = BUILDINGS[type];
    if (!def) return { ok: false, reason: '未知建筑' };
    const y = t.height(x, z);
    if (t.slopeAt(x, z) >= 0.45) return { ok: false, reason: '地面太陡', y };
    if (t.waterLevel !== undefined && y < t.waterLevel + 0.6) return { ok: false, reason: '不能建在水面上', y };
    const rk = this.game.rocket.group.position;
    if (Math.hypot(rk.x - x, rk.z - z) < 3.2) return { ok: false, reason: '离火箭太近', y };
    // 占地轮廓采样：旋转后的矩形
    const halfW = def.size[0] * 0.5, halfD = def.size[2] * 0.5;
    const cos = Math.cos(rot || 0), sin = Math.sin(rot || 0);
    const samplePts = [];
    const N = 3;
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const lx = (i / (N - 1) - 0.5) * 2 * halfW;
        const lz = (j / (N - 1) - 0.5) * 2 * halfD;
        samplePts.push({ x: x + lx * cos + lz * sin, z: z - lx * sin + lz * cos });
      }
    }
    // 采样点上的坡度与水位（大型建筑跨过陡坡/水面时不应显示可建）
    for (const p of samplePts) {
      const py = t.height(p.x, p.z);
      if (Math.abs(py - y) > Math.max(0.9, def.size[1] * 0.5)) return { ok: false, reason: '地面起伏太大', y };
      if (t.slopeAt(p.x, p.z) >= 0.55) return { ok: false, reason: '地面太陡', y };
      if (t.waterLevel !== undefined && py < t.waterLevel + 0.35) return { ok: false, reason: '不能建在水面上', y };
      const veg = this.game.vegetation?.blocked(p.x, p.z, 0);
      if (veg) return { ok: false, reason: '有树木或岩石阻挡', y };
    }
    // 停机坪不阻挡角色，其余建筑按圆形占地判定重叠
    for (const it of this.items) {
      const otherDef = it.def || BUILDINGS[it.type];
      const rSelf = (def.colliderR || def.size[0] * 0.5) + 0.35;
      const rOther = (otherDef.colliderR || otherDef.size[0] * 0.5) + 0.35;
      if (Math.hypot(it.pos.x - x, it.pos.z - z) < Math.max(rSelf + rOther, (otherDef.size[0] + def.size[0]) * 0.5)) {
        return { ok: false, reason: '与已有建筑重叠', y };
      }
    }
    return { ok: true, reason: '', y };
  }

  _spotOk(x, z, def) {
    const type = this.ghostType || Object.keys(BUILDINGS).find((k) => BUILDINGS[k] === def);
    if (!type) return false;
    return this.validate(x, z, type, this.rot).ok;
  }

  updateGhost(camera, player, dt) {
    if (!this.ghostType) return;
    const def = BUILDINGS[this.ghostType];
    // 理想位置：角色前方 5.5m
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    dir.y = 0;
    if (dir.lengthSq() < 1e-4) dir.set(Math.sin(player.yaw), 0, Math.cos(player.yaw));
    dir.normalize();
    let px = player.pos.x + dir.x * 5.5;
    let pz = player.pos.z + dir.z * 5.5;
    // 若理想位置不可用，按逐渐扩大的同心环寻找最近的可用点
    if (!this._spotOk(px, pz, def)) {
      let found = false;
      const baseAng = Math.atan2(dir.z, dir.x);
      for (let ring = 0; ring < 4 && !found; ring++) {
        const rad = 5.5 + ring * 2.6;
        for (let i = 1; i <= 12 && !found; i++) {
          const order = [i, -i];
          for (const sgn of order) {
            const ang = baseAng + sgn * (i * 0.26);
            const nx = player.pos.x + Math.cos(ang) * rad;
            const nz = player.pos.z + Math.sin(ang) * rad;
            if (this._spotOk(nx, nz, def)) { px = nx; pz = nz; found = true; break; }
          }
        }
      }
    }
    // 吸附：靠近已有建筑则对齐网格
    const snap = 2.4;
    const nearExisting = this.items.some((it) => Math.hypot(it.pos.x - px, it.pos.z - pz) < 4.0);
    if (nearExisting) { px = Math.round(px / snap) * snap; pz = Math.round(pz / snap) * snap; }
    const y = this.game.terrain.height(px, pz);
    this.holo.position.set(px, y, pz);
    this.holo.rotation.y = this.rot;
    this.ringGhost.position.set(px, y + 0.05, pz);
    this.ringGhost.material.color.set(this.game.palette.accent);
    // BUG-21 / BUG-26：预览与确认共用同一个校验函数
    const spot = this.validate(px, pz, this.ghostType, this.rot);
    const affordable = this.canAfford(this.ghostType);
    this.blockReason = !affordable ? '资源不足' : (spot.ok ? '' : spot.reason);
    this.valid = !this.blockReason;
    this.validatedType = this.ghostType;
    this.validatedRot = this.rot;
    this.validatedPos = new THREE.Vector3(px, y, pz);
    this.holoMat.uniforms.uOk.value = this.valid ? 1 : 0;
    this.holoMat.uniforms.uTime.value += dt;
    this.holoMat.uniforms.uColor.value.set(this.game.palette.accent);
    this.ghostPos = new THREE.Vector3(px, y, pz);
  }

  // BUG-21：确认时用“当前类型 + 当前位置 + 当前资源”重新做原子校验，
  // 全部通过后才扣费建造。缓存的预览结果不再被信任。
  confirm() {
    if (!this.ghostType) return null;
    const type = this.ghostType;
    const def = BUILDINGS[type];
    const pos = this.ghostPos;
    if (!pos) {
      this.game.ui?.toast('请先选择放置位置', 'warn');
      this.game.audio?.play('uiError');
      return null;
    }
    // 原子校验：类型、旋转、位置、资源全部按当前值重算
    const spot = this.validate(pos.x, pos.z, type, this.rot);
    if (!spot.ok) {
      this.valid = false;
      this.blockReason = spot.reason;
      this.game.ui?.toast(spot.reason || '此处无法建造', 'warn');
      this.game.audio?.play('uiError');
      return null;
    }
    if (!this.canAfford(type)) {
      this.valid = false;
      this.blockReason = '资源不足';
      this.game.ui?.toast('资源不足', 'warn');
      this.game.audio?.play('uiError');
      return null;
    }
    const y = this.game.terrain.height(pos.x, pos.z);
    for (const k in def.cost) this.game.inventory[k] -= def.cost[k];
    const mesh = this.makeGeometryFor(type, false);
    mesh.position.set(pos.x, y, pos.z);
    mesh.rotation.y = this.rot;
    this.group.add(mesh);
    // 建造动画：从下方升起 + 透明度
    mesh.scale.set(1, 0.01, 1);
    const item = { type, def, mesh, pos: new THREE.Vector3(pos.x, y, pos.z), rot: this.rot, built: 0, power: 0, active: false, produceTimer: 0 };
    this.items.push(item);
    this.game.audio?.play('build');
    this.game.ui?.toast(`${def.name} 建造完成`, 'ok');
    this.game.onBuild?.(item);
    // 建造后保持建造模式（可连续放置），按 B 退出
    this.cancelPlacing();
    return item;
  }

  removeAt(pos) {
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      if (it.pos.distanceTo(pos) < it.def.size[0] * 0.6) {
        for (const k in it.def.cost) this.game.inventory[k] = (this.game.inventory[k] || 0) + Math.floor(it.def.cost[k] * 0.6);
        this.group.remove(it.mesh);
        this.items.splice(i, 1);
        this.game.audio?.play('uiConfirm');
        return it;
      }
    }
    return null;
  }

  nearest(pos) {
    let best = null, bd = 3.4;
    for (const it of this.items) {
      const d = it.pos.distanceTo(pos);
      if (d < Math.max(bd, it.def.size[0] * 0.75)) { bd = d; best = it; }
    }
    return best;
  }

  // 太阳能朝向系数：由太阳方向与面板法线的夹角决定，夜间降至微光底值
  solarEfficiency() {
    const pal = this.game.palette;
    const sd = this.game.sunDirVec || (pal && pal.sunDir ? new THREE.Vector3(...pal.sunDir).normalize() : new THREE.Vector3(0.5, 0.5, 0));
    const elev = clamp(sd.y, 0, 1);
    const base = 0.35 + clamp(sd.y, -1, 1) * 0.45 + elev * 0.2;
    const night = this.game.isNight ? 0.25 : 1;
    return clamp(base * night, 0, 1);
  }

  update(dt, player) {
    // 建造升起动画
    for (const it of this.items) {
      if (it.built < 1) {
        it.built = Math.min(1, it.built + dt * 2.2);
        const k = 1 - Math.pow(1 - it.built, 3);
        it.mesh.scale.set(1, Math.max(0.01, k), 1);
      }
      if (it.mesh.userData.spinner) it.mesh.userData.spinner.rotation.z += dt * 1.5;
    }
    // ---- 电力（BUG-23）：先算总发电与非矿机用电，再把剩下的配额分给矿机 ----
    const solarFacing = this.solarEfficiency();
    let gen = 0, baseUse = 0;
    for (const it of this.items) {
      const def = it.def || BUILDINGS[it.type] || {};
      if (it.type === 'solar') {
        // 面板在建造动画期间逐步并网
        gen += 4 * (0.4 + solarFacing * 0.6) * clamp(it.built, 0, 1);
      } else if (it.type !== 'miner') {
        baseUse += def.energyUse ?? def.produce?.energyUse ?? 0;
      }
    }
    if (!Number.isFinite(gen)) gen = 0;
    if (!Number.isFinite(baseUse)) baseUse = 0;
    this.gen = gen;
    this.miners = this.items.filter((it) => it.type === 'miner' && it.built >= 1);
    const minerUnit = BUILDINGS.miner.energyUse || 3;
    const minersDemand = this.miners.length * minerUnit;
    // 矿机可用配额 = 发电 - 其他用电，不再重复扣一次矿机需求
    const powerForMiners = Math.max(0, gen - baseUse);
    const minersActive = minersDemand > 0 ? clamp(powerForMiners / minersDemand, 0, 1) : 0;
    this.baseUse = baseUse;
    this.use = baseUse + minersDemand * minersActive;
    this.power = clamp(gen - this.use, -20, 60);
    // BUG-25：每个建筑的运行状态（建成 / 供电）统一在这里维护，交互入口直接查询。
    // 供电优先级：先用发电满足非矿机负载，剩下的才分给矿机（与上面配额分配一致）。
    const baseSupplied = gen + 1e-6 >= baseUse;
    for (const it of this.items) {
      const def = it.def || BUILDINGS[it.type] || {};
      const need = def.energyUse ?? def.produce?.energyUse ?? 0;
      it.ready = it.built >= 1;
      if (need <= 0) it.powered = it.ready;
      else if (it.type === 'miner') it.powered = it.ready && minersActive > 0;
      else it.powered = it.ready && baseSupplied;
      it.active = it.ready && it.powered;
    }
    // BUG-28：生产进度归属到每台矿机，而不是一个全局计时器
    if (minersActive > 0) {
      for (const it of this.miners) {
        it.produceTimer = (it.produceTimer || 0) + dt * minersActive;
        if (it.produceTimer > 6) {
          it.produceTimer = 0;
          const amount = it.def.produce?.ferrite ?? 1;
          this.game.inventory.ferrite = (this.game.inventory.ferrite || 0) + amount;
          this.game.ui?.toast(`+${amount} 铁素矿 · 无人机自动开采`, 'ok');
        }
      }
    }
    // 兼容旧字段：总进度仅供 HUD/调试参考，不再参与结算
    this.produceTimer = this.miners.reduce((m, it) => Math.max(m, it.produceTimer || 0), 0);
    // ---- 居住舱（BUG-24 / BUG-25 / BUG-49）：范围内最近的、已建成的、有电的居住舱 ----
    this.habitatInRange = null;
    if (player && player.inRocket === false) {
      let best = null, bd = Infinity;
      for (const it of this.items) {
        if (it.type !== 'habitat' || it.built < 1 || !it.active) continue;
        const d = Math.hypot(it.pos.x - player.pos.x, it.pos.z - player.pos.z);
        if (d < 3.6 + (it.def.colliderR || 1.4) && d < bd) { bd = d; best = it; }
      }
      this.habitatInRange = best;
      if (best) {
        this.game.playerShield = Math.min(this.game.playerMaxShield, this.game.playerShield + dt * 9);
        this.game.playerHealth = Math.min(this.game.playerMaxHealth, this.game.playerHealth + dt * 3);
      }
    }
  }

  // BUG-25：交互入口统一查询建筑是否可用
  isOperational(item) {
    if (!item) return false;
    if (item.built < 1) return false;
    const def = item.def || BUILDINGS[item.type] || {};
    const need = def.energyUse ?? def.produce?.energyUse ?? 0;
    if (need <= 0) return true;
    // 与 update() 中的供电判定保持一致
    return item.powered !== false && this.gen + 1e-6 >= this.baseUse;
  }

  // BUG-49：可作为重生点的居住舱（已建成），优先最近玩家的一座。
  // 居住舱不做供电硬门槛：否则断电时玩家没有可用的重生点。
  respawnHabitat(pos) {
    let best = null, bd = Infinity;
    for (const it of this.items) {
      if (it.type !== 'habitat' || !(it.built >= 1)) continue;
      const d = pos ? Math.hypot(it.pos.x - pos.x, it.pos.z - pos.z) : 0;
      if (d < bd) { bd = d; best = it; }
    }
    return best;
  }

  // BUG-50：存储容量总和
  totalCapacity() {
    let cap = 0;
    for (const it of this.items) {
      const def = it.def || BUILDINGS[it.type] || {};
      if (it.type === 'storage' && it.built >= 1 && this.isOperational(it)) cap += def.capacity || 0;
    }
    return cap;
  }

  // BUG-51：可作为着陆平台的停机坪
  landingPadNear(x, z, maxDist = 40) {
    let best = null, bd = maxDist;
    for (const it of this.items) {
      if (it.type !== 'pad' || it.built < 1 || !this.isOperational(it)) continue;
      const d = Math.hypot(it.pos.x - x, it.pos.z - z);
      if (d < bd) { bd = d; best = it; }
    }
    return best;
  }

  // BUG-17：角色的水平阻挡（圆形碰撞体）
  blockedAt(x, z, pad = 0) {
    for (const it of this.items) {
      const def = it.def || BUILDINGS[it.type] || {};
      if (def.solid === false) continue;
      const r = def.colliderR || def.size[0] * 0.5;
      const dx = it.pos.x - x, dz = it.pos.z - z;
      if (dx * dx + dz * dz < (r + pad) * (r + pad)) return it;
    }
    return null;
  }

  // BUG-18：镜头体积遮挡（heightAboveGround 为相机相对地面高度）
  cameraBlockedAt(x, z, pad = 0, heightAboveGround = 0) {
    for (const it of this.items) {
      const def = it.def || BUILDINGS[it.type] || {};
      if (def.solid === false) continue;
      const top = def.topY || def.size[1] || 2;
      if (heightAboveGround > top + 0.3) continue;
      const r = (def.colliderR || def.size[0] * 0.5) * 0.9;
      const dx = it.pos.x - x, dz = it.pos.z - z;
      if (dx * dx + dz * dz < (r + pad) * (r + pad)) return it;
    }
    return null;
  }

  // BUG-27：先按各自交互半径筛选，再独立比较距离选最近项
  nearest(pos) {
    let best = null, bd = Infinity;
    for (const it of this.items) {
      const def = it.def || BUILDINGS[it.type] || {};
      const reach = 3.4 + Math.max(0, (def.colliderR || def.size[0] * 0.5) - 1.0);
      const d = it.pos.distanceTo(pos);
      if (d <= reach && d < bd) { bd = d; best = it; }
    }
    return best;
  }

  serialize() {
    return this.items.map((it) => ({
      type: it.type, x: it.pos.x, z: it.pos.z, rot: it.mesh.rotation.y,
      built: it.built, produceTimer: it.produceTimer || 0,
    }));
  }

  restore(list) {
    for (const b of list) {
      if (!b || !BUILDINGS[b.type]) continue;
      const y = this.game.terrain.height(b.x, b.z);
      const mesh = this.makeGeometryFor(b.type, false);
      // BUG-22：根节点始终等于地面坐标，模型原点修正已在 pivot 子节点里
      mesh.position.set(b.x, y, b.z);
      mesh.rotation.y = b.rot || 0;
      this.group.add(mesh);
      this.items.push({
        type: b.type, def: BUILDINGS[b.type], mesh, pos: new THREE.Vector3(b.x, y, b.z),
        rot: b.rot || 0, built: b.built ?? 1, power: 0, active: true,
        produceTimer: b.produceTimer || 0,
      });
    }
  }

  // BUG-28：切星球时保存并恢复每座矿机的生产进度（由 game 记录 planetStates）
  snapshotProduction() {
    const out = [];
    for (const it of this.items) out.push({ type: it.type, x: it.pos.x, z: it.pos.z, produceTimer: it.produceTimer || 0 });
    return out;
  }

  applyProduction(snapshot) {
    if (!Array.isArray(snapshot)) return;
    for (const s of snapshot) {
      for (const it of this.items) {
        if (it.pos.x === s.x && it.pos.z === s.z) { it.produceTimer = s.produceTimer || 0; break; }
      }
    }
  }

  // BUG-43：完整释放几何、材质与纹理
  clear() {
    for (const it of this.items) {
      this.group.remove(it.mesh);
      disposeObject(it.mesh);
    }
    this.items = [];
    this.miners = [];
    this.habitatInRange = null;
    this.gen = 0; this.use = 0; this.power = 0;
    this.miningTimer = 0;
  }
}

// BUG-43：按所有权释放几何 / 材质 / 纹理（共享材质通过 Set 去重）
export function disposeObject(root) {
  const mats = new Set();
  root.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      if (Array.isArray(o.material)) o.material.forEach((m) => mats.add(m));
      else mats.add(o.material);
    }
  });
  for (const m of mats) {
    for (const key of Object.keys(m)) {
      const v = m[key];
      if (v && v.isTexture) v.dispose();
    }
    m.dispose();
  }
}
