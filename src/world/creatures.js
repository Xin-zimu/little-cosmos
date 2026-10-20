// 外星生物：程序化造型 + 骨骼式步态 + 分层 AI（游荡/进食/好奇/警戒/追击/攻击/受击/死亡）
import * as THREE from 'three';
import { createNoise, clamp, damp } from '../core/noise.js';

const TENTACLE_VERT = /* glsl */ `
uniform float uTime, uLen;
attribute float aY;
varying float vY;
void main() {
  vec3 p = position;
  float t = aY / uLen;
  float sw = sin(uTime * 1.7 + t * 5.0) * t * t * 0.35;
  p.x += sw;
  p.z += cos(uTime * 1.3 + t * 4.0) * t * t * 0.3;
  vY = t;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;
const TENTACLE_FRAG = /* glsl */ `
precision highp float;
varying float vY;
uniform vec3 uColor, uTipColor;
uniform float uTime;
void main() {
  vec3 c = mix(uColor, uTipColor, smoothstep(0.1, 1.0, vY));
  float pulse = 0.75 + 0.25 * sin(uTime * 3.0 - vY * 8.0);
  gl_FragColor = vec4(c * pulse, 0.9);
}
`;

export const CREATURE_DEFS = {
  gargantua: {
    name: '苔原温和巨兽',
    latin: 'LUMEN GARGANTUA',
    kind: 'terbivora',
    planet: 'verdant',
    hostile: false,
    hp: 120,
    scale: 1.0,
    body: [0.62, 0.52, 1.2],
    head: [0.34, 0.32, 0.42],
    neck: 0.5,
    legLen: 0.75,
    color: [0.42, 0.44, 0.30],
    belly: [0.62, 0.60, 0.44],
    accent: [1.0, 0.82, 0.42],
    spots: [0.24, 0.30, 0.18],
    speed: 1.1,
    home: 'verdant',
    samples: '苔原孢囊',
    note: '温和的巨兽，以蕨叶与苔藓为食。靠近时会好奇地抬头，轻鸣一声。',
  },
  thornling: {
    name: '森林掠食者',
    latin: 'SPINOSA THORNLING',
    kind: 'carnivora',
    planet: 'verdant',
    hostile: true,
    hp: 70,
    scale: 0.78,
    body: [0.30, 0.26, 0.68],
    head: [0.20, 0.17, 0.30],
    neck: 0.30,
    legLen: 0.46,
    color: [0.20, 0.17, 0.12],
    belly: [0.36, 0.28, 0.16],
    accent: [1.0, 0.36, 0.10],
    spots: [0.30, 0.26, 0.10],
    speed: 4.6,
    chaseSpeed: 6.4,
    attackRange: 1.25,
    damage: 12,
    aggroRange: 20,
    sample: '晶体矿',
    note: '森林中的掠食者。背部棘刺发红光时表示它已锁定你。弱点：背脊棘刺。',
  },
  sandworm: {
    name: '流沙潜伏者',
    latin: 'ARENICOLA EMER',
    kind: 'carnivora',
    planet: 'emer',
    hostile: true,
    hp: 90,
    scale: 1.0,
    body: [0.34, 0.30, 0.8],
    head: [0.24, 0.20, 0.34],
    neck: 0.34,
    legLen: 0.5,
    color: [0.36, 0.20, 0.12],
    belly: [0.52, 0.34, 0.20],
    accent: [1.0, 0.55, 0.25],
    spots: [0.22, 0.12, 0.08],
    speed: 1.8,
    chaseSpeed: 5.0,
    attackRange: 1.3,
    damage: 14,
    aggroRange: 26,
    sand: true,
    sample: '沙晶',
    note: '游弋在沙下的猎手，只有脊鳍会露出沙面。留意沙面上的波纹。弱点：头部鳃裂。',
  },
  hopper: {
    name: '沙跃蜥',
    latin: 'SALIENS HOPPER',
    kind: 'terbivora',
    planet: 'emer',
    hostile: false,
    hp: 30,
    scale: 0.55,
    body: [0.22, 0.20, 0.36],
    head: [0.16, 0.14, 0.2],
    neck: 0.16,
    legLen: 0.3,
    color: [0.66, 0.50, 0.30],
    belly: [0.80, 0.66, 0.44],
    accent: [0.55, 1.0, 0.85],
    spots: [0.80, 0.42, 0.22],
    speed: 2.2,
    hop: 1.0,
    nightOnly: true,
    sample: '沙晶',
    note: '夜行性的沙漠小蜥，白天躲在岩柱阴影里，夜里成群出来晒太阳的余温。',
  },
  driftjelly: {
    name: '浮光水母',
    latin: 'MEDUSA LUMINA',
    kind: 'terbivora',
    planet: 'lumina',
    hostile: false,
    hp: 40,
    jelly: true,
    scale: 1.0,
    color: [0.30, 0.70, 1.0],
    accent: [0.75, 0.55, 1.0],
    glow: [0.40, 1.30, 2.60],
    speed: 0.7,
    sample: '荧光苔',
    note: '漂浮在雾林间的发光水母，光脉像心跳一样搏动。靠近时会把光洒向你。',
  },
};

// ------------------------------------------------------------------
// 生物造型
// ------------------------------------------------------------------
function creatureMaterial(color, emissive, emissiveIntensity = 0) {
  const m = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setRGB(...color),
    roughness: 0.62,
    metalness: 0.08,
    emissive: new THREE.Color().setRGB(...emissive),
    emissiveIntensity,
  });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCP;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvCP = (modelMatrix*vec4(transformed,1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCP;\nfloat hsh(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}\nfloat vn(vec2 p){vec2 i=floor(p),f=fract(p);vec2 u=f*f*(3.0-2.0*f);return mix(mix(hsh(i),hsh(i+vec2(1,0)),u.x),mix(hsh(i+vec2(0,1)),hsh(i+vec2(1,1)),u.x),u.y);}')
      .replace('#include <color_fragment>', '#include <color_fragment>\n float sc = vn(vCP.xz*14.0+vCP.y*8.0);\n float st = smoothstep(0.62,0.72,vn(vec2(vCP.x*22.0+vCP.z*4.0, vCP.y*9.0)));\n diffuseColor.rgb *= 0.86+0.28*sc;\n diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb*0.6, st*0.6);');
  };
  return m;
}

function buildQuadruped(def) {
  const g = new THREE.Group();
  const s = def.scale;
  const mat = creatureMaterial(def.color, def.accent, 0.0);
  const bellyMat = creatureMaterial(def.belly, def.accent, 0.0);
  const accentMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setRGB(...def.accent),
    emissive: new THREE.Color().setRGB(...def.accent),
    emissiveIntensity: 1.6,
    roughness: 0.35,
  });
  const eyeMat = new THREE.MeshStandardMaterial({ color: new THREE.Color('#0a0a0a'), emissive: new THREE.Color().setRGB(...def.accent), emissiveIntensity: 2.2, roughness: 0.1 });

  const body = new THREE.Group();
  g.add(body);
  const bodyY = def.legLen + def.body[1] * 0.55;
  body.position.y = bodyY;
  const torsoGeo = new THREE.SphereGeometry(1, 18, 14);
  const torso = new THREE.Mesh(torsoGeo, mat);
  torso.scale.set(def.body[0], def.body[1], def.body[2]);
  torso.castShadow = true;
  torso.receiveShadow = true;
  body.add(torso);
  const belly = new THREE.Mesh(torsoGeo, bellyMat);
  belly.scale.set(def.body[0] * 0.78, def.body[1] * 0.7, def.body[2] * 0.88);
  belly.position.y = -def.body[1] * 0.28;
  belly.castShadow = false;
  body.add(belly);

  // 背脊棘刺 / 发光脊
  const spikeCount = 7;
  for (let i = 0; i < spikeCount; i++) {
    const t = i / (spikeCount - 1);
    const sp = new THREE.Mesh(new THREE.ConeGeometry(0.035 * def.body[0] + 0.012, 0.16 * (1 - Math.abs(t - 0.5)), 5), accentMat);
    sp.position.set(0, def.body[1] * (0.85 + Math.sin(t * Math.PI) * 0.15), (t - 0.5) * def.body[2] * 1.55);
    body.add(sp);
  }

  // 颈与头
  const neck = new THREE.Group();
  neck.position.set(0, def.body[1] * 0.25, def.body[2] * 0.82);
  body.add(neck);
  const neckMesh = new THREE.Mesh(new THREE.CylinderGeometry(def.head[0] * 0.75, def.head[0] * 0.95, def.neck, 10), mat);
  neckMesh.rotation.x = Math.PI / 2.15;
  neckMesh.position.z = def.neck * 0.4;
  neckMesh.castShadow = true;
  neck.add(neckMesh);
  const head = new THREE.Group();
  head.position.set(0, def.neck * 0.32, def.neck * 0.85);
  neck.add(head);
  const skull = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), mat);
  skull.scale.set(def.head[0], def.head[1], def.head[2]);
  skull.castShadow = true;
  head.add(skull);
  // 眼睛（大而亮）
  for (const sgn of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(def.head[0] * 0.19, 10, 8), eyeMat);
    eye.position.set(sgn * def.head[0] * 0.62, def.head[1] * 0.35, def.head[2] * 0.60);
    head.add(eye);
  }
  // 吻部
  const snout = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 10), bellyMat);
  snout.scale.set(def.head[0] * 0.55, def.head[1] * 0.45, def.head[2] * 0.5);
  snout.position.z = def.head[2] * 0.82;
  snout.position.y = -def.head[1] * 0.2;
  head.add(snout);
  // 角/耳
  for (const sgn of [-1, 1]) {
    const horn = new THREE.Mesh(new THREE.ConeGeometry(def.head[0] * 0.14, def.head[1] * 0.9, 6), accentMat);
    horn.position.set(sgn * def.head[0] * 0.55, def.head[1] * 1.05, -def.head[2] * 0.2);
    horn.rotation.z = -sgn * 0.4;
    horn.rotation.x = -0.5;
    head.add(horn);
  }
  // 尾巴
  const tail = new THREE.Group();
  tail.position.set(0, def.body[1] * 0.1, -def.body[2] * 0.9);
  body.add(tail);
  const tailMesh = new THREE.Mesh(new THREE.ConeGeometry(def.body[0] * 0.28, def.body[2] * 0.8, 8), mat);
  tailMesh.rotation.x = -Math.PI / 2;
  tailMesh.position.z = -def.body[2] * 0.4;
  tailMesh.castShadow = true;
  tail.add(tailMesh);
  const tailTip = new THREE.Mesh(new THREE.SphereGeometry(def.body[0] * 0.22, 8, 8), accentMat);
  tailTip.position.z = -def.body[2] * 0.8;
  tail.add(tailTip);

  // 四条腿
  const legs = [];
  for (const [sx, sz] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) {
    const hip = new THREE.Group();
    hip.position.set(sx * def.body[0] * 0.68, -def.body[1] * 0.15, sz * def.body[2] * 0.55);
    body.add(hip);
    const upper = new THREE.Mesh(new THREE.CylinderGeometry(def.legLen * 0.11, def.legLen * 0.09, def.legLen * 0.55, 7), mat);
    upper.position.y = -def.legLen * 0.275;
    upper.castShadow = true;
    hip.add(upper);
    const knee = new THREE.Group();
    knee.position.y = -def.legLen * 0.55;
    hip.add(knee);
    const lower = new THREE.Mesh(new THREE.CylinderGeometry(def.legLen * 0.08, def.legLen * 0.06, def.legLen * 0.5, 7), mat);
    lower.position.y = -def.legLen * 0.25;
    lower.castShadow = true;
    knee.add(lower);
    const foot = new THREE.Mesh(new THREE.SphereGeometry(def.legLen * 0.1, 8, 6), bellyMat);
    foot.scale.set(1, 0.6, 1.3);
    foot.position.y = -def.legLen * 0.5;
    knee.add(foot);
    legs.push({ hip, knee, sx, sz });
  }

  g.userData.rig = { body, neck, head, tail, legs, bodyY, accentMat, eyeMat, mat };
  return g;
}

function buildJelly(def) {
  const g = new THREE.Group();
  const mat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color().setRGB(...def.color),
    emissive: new THREE.Color().setRGB(...def.glow),
    emissiveIntensity: 1.4,
    roughness: 0.12,
    transparent: true,
    opacity: 0.72,
    clearcoat: 1,
    transmission: 0.25,
    thickness: 0.5,
  });
  const bell = new THREE.Mesh(new THREE.SphereGeometry(0.55, 28, 18, 0, Math.PI * 2, 0, Math.PI * 0.62), mat);
  bell.castShadow = false;
  g.add(bell);
  const inner = new THREE.Mesh(new THREE.SphereGeometry(0.34, 16, 12), new THREE.MeshStandardMaterial({
    color: new THREE.Color().setRGB(...def.accent),
    emissive: new THREE.Color().setRGB(...def.glow),
    emissiveIntensity: 3.2,
    roughness: 0.2,
  }));
  inner.position.y = -0.08;
  g.add(inner);
  // 触须（着色器摆动）
  const tentacles = [];
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    const len = 1.2 + Math.random() * 1.1;
    const geo = new THREE.CylinderGeometry(0.018, 0.006, len, 5, 14, true);
    geo.translate(0, -len / 2, 0);
    const pos = geo.attributes.position;
    const ay = new Float32Array(pos.count);
    for (let k = 0; k < pos.count; k++) ay[k] = -pos.getY(k);
    geo.setAttribute('aY', new THREE.BufferAttribute(ay, 1));
    const tm = new THREE.ShaderMaterial({
      vertexShader: TENTACLE_VERT,
      fragmentShader: TENTACLE_FRAG,
      transparent: true,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uLen: { value: len },
        uColor: { value: new THREE.Color().setRGB(...def.accent) },
        uTipColor: { value: new THREE.Color().setRGB(...def.glow) },
      },
    });
    const t = new THREE.Mesh(geo, tm);
    t.position.set(Math.cos(a) * 0.32, -0.02, Math.sin(a) * 0.32);
    g.add(t);
    tentacles.push(t);
  }
  g.userData.rig = { bell, inner, tentacles, mat, bodyY: 2.4 };
  return g;
}

// ------------------------------------------------------------------
// 生物实体
// ------------------------------------------------------------------
export class Creature {
  constructor(def, position, game) {
    this.def = def;
    this.game = game;
    this.root = def.jelly ? buildJelly(def) : buildQuadruped(def);
    this.rig = this.root.userData.rig;
    // 命中检测：射线只收集带 hittable 的网格，并回指到生物实例
    this.root.traverse((o) => {
      if (o.isMesh) {
        o.userData.hittable = true;
        o.userData.creature = this;
        o.castShadow = true;
      }
    });
    this.pos = position.clone();
    this.vel = new THREE.Vector3();
    this.yaw = Math.random() * Math.PI * 2;
    this.state = 'wander';
    this.stateT = Math.random() * 4;
    this.wanderTarget = position.clone();
    this.hp = def.hp;
    this.maxHp = def.hp;
    this.hurtT = 0;
    this.dead = false;
    this.deathT = 0;
    this.phase = Math.random() * 10;
    this.attackCd = 0;
    this.alertT = 0;
    this.speedMul = 1;
    this.name = def.name;
    this.target = null;
    this.homePos = position.clone();
    this.circleR = 12 + Math.random() * 20;
    this.circleA = Math.random() * 6.28;
    this.travelDir = Math.random() * 6.28;
    this.bob = Math.random() * 6.28;
    this.interactCd = 0;
    this._hitFlash = 0;
    this.refreshLabel = true;
  }

  get position() {
    return this.pos;
  }

  pickWander() {
    const a = Math.random() * Math.PI * 2;
    const r = 4 + Math.random() * 14;
    this.wanderTarget = this.homePos.clone().add(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r));
  }

  damage(amount, hitPoint, crit = false) {
    if (this.dead) return false;
    this.hp -= amount * (crit ? 2 : 1);
    this.hurtT = 0.35;
    this._hitFlash = 1;
    if (this.hp <= 0) {
      this.dead = true;
      this.deathT = 0;
      this.game.audio?.play('creatureDie', { pos: this.pos });
      return true;
    }
    if (this.def.hostile) {
      this.state = 'chase';
      this.alertT = 6;
    } else {
      this.state = 'flee';
      this.stateT = 3.5;
    }
    this.game.audio?.play('creatureHit', { pos: this.pos });
    return false;
  }

  update(dt, player) {
    const t = this.game.time;
    this.stateT -= dt;
    this.attackCd -= dt;
    this.hurtT = Math.max(0, this.hurtT - dt);
    this.interactCd -= dt;
    this._hitFlash = damp(this._hitFlash, 0, 8, dt);
    if (this.dead) {
      this.deathT += dt;
      const k = clamp(this.deathT / 1.6, 0, 1);
      this.root.rotation.z = k * 1.4;
      this.root.position.y = this.pos.y - k * 0.15;
      this.root.scale.setScalar(1 - k * 0.15);
      this.rig.mat.emissiveIntensity = this._hitFlash * 2;
      if (this.deathT > 2.2) this.root.visible = false;
      return;
    }

    const playerDist = this.pos.distanceTo(player.pos);
    const night = this.game.isNight;

    // ---------- 决策 ----------
    if (this.def.hostile) {
      const detect = this.def.aggroRange * (night ? 1.2 : 1.0);
      if (playerDist < detect && !player.inRocket) {
        // 只在"刚发现玩家"时进入 alert，之后由计时结束转入 chase/attack
        if (this.state !== 'chase' && this.state !== 'attack' && this.state !== 'alert') {
          this.state = 'alert';
          this.stateT = 0.75;
          this.game.audio?.play('creatureAlert', { pos: this.pos });
        } else if (this.state === 'alert' && this.stateT <= 0) {
          this.state = playerDist < this.def.attackRange ? 'attack' : 'chase';
        } else if (this.state === 'chase' && playerDist < this.def.attackRange * 1.15) {
          // 追到身边就进入攻击循环
          this.state = 'attack';
        } else if (this.state === 'attack' && playerDist > this.def.attackRange * 2.2) {
          this.state = 'chase';
        }
      } else if (this.state === 'chase' || this.state === 'attack' || this.state === 'alert') {
        this.state = 'wander';
        this.pickWander();
      }
    } else {
      if (this.state === 'flee') {
        if (this.stateT <= 0) { this.state = 'wander'; this.pickWander(); }
      } else if (this.state === 'curious') {
        if (this.stateT <= 0) { this.state = 'wander'; this.pickWander(); }
      } else if (playerDist < 7 && this.interactCd <= 0) {
        this.state = 'curious';
        this.stateT = 4 + Math.random() * 3;
        this.interactCd = 12;
        this.game.audio?.play('creatureCurious', { pos: this.pos });
        this.game.ui?.toast(`${this.def.name} 对你感到好奇`, 'info');
      } else if (this.stateT <= 0) {
        this.state = Math.random() < 0.25 ? 'graze' : 'wander';
        this.stateT = 4 + Math.random() * 6;
        this.pickWander();
      }
    }

    // ---------- 运动 ----------
    let desired = new THREE.Vector3();
    let speed = 0;
    const toPlayer = player.pos.clone().sub(this.pos);
    toPlayer.y = 0;
    const dp = toPlayer.length();
    if (this.def.jelly) {
      // 水母：漂浮环绕
      this.bob += dt;
      const target = this.wanderTarget;
      const dir = target.clone().sub(this.pos); dir.y = 0;
      if (dir.length() < 2) this.pickWander();
      speed = this.def.speed;
      desired.copy(dir.normalize());
      const newPos = this.pos.clone().addScaledVector(desired, speed * dt);
      newPos.x += Math.sin(t * 0.4 + this.phase) * 0.3 * dt;
      newPos.z += Math.cos(t * 0.33 + this.phase) * 0.3 * dt;
      const gh = this.game.terrain.height(newPos.x, newPos.z);
      newPos.y = damp(this.pos.y, Math.max(gh + 2.2 + Math.sin(this.bob * 0.9) * 0.5, gh + 1.6), 2, dt);
      this.pos.copy(newPos);
      if (dp < 9) { this.state = 'curious'; }
    } else {
      if (this.state === 'wander' || this.state === 'graze' || this.state === 'curious') {
        const target = this.state === 'curious' ? player.pos : this.wanderTarget;
        const dir = target.clone().sub(this.pos); dir.y = 0;
        const d = dir.length();
        if (this.state === 'graze' || (this.state === 'curious' && d < 3.5)) {
          speed = 0;
        } else if (d > 0.8) {
          desired.copy(dir.normalize());
          speed = this.def.speed * (this.state === 'curious' ? 0.7 : 1);
        }
      } else if (this.state === 'flee') {
        desired.copy(toPlayer).normalize().negate();
        speed = this.def.speed * 2.6;
      } else if (this.state === 'alert') {
        desired.copy(toPlayer).normalize();
        speed = 0;
        this.yaw = Math.atan2(toPlayer.x, toPlayer.z);
      } else if (this.state === 'chase') {
        desired.copy(toPlayer).normalize();
        speed = this.def.chaseSpeed;
      } else if (this.state === 'attack') {
        desired.copy(toPlayer).normalize();
        speed = 0;
        this.yaw = Math.atan2(toPlayer.x, toPlayer.z);
        if (this.attackCd <= 0) {
          this.attackCd = 1.5;
          this.attackLunge = 1;
          if (dp < this.def.attackRange + 0.4) {
            this.game.onCreatureAttack(this, this.def.damage);
          }
        }
      }
      if (speed > 0) {
        const tx = this.pos.x + desired.x * speed * dt;
        const tz = this.pos.z + desired.z * speed * dt;
        const gh = this.game.terrain.height(tx, tz);
        this.pos.x = tx;
        this.pos.z = tz;
        const targetY = gh;
        if (this.def.sand) {
          // 沙下潜行：一部分身体埋入沙里
          this.pos.y = damp(this.pos.y, targetY - 0.32, 8, dt);
        } else {
          this.pos.y = damp(this.pos.y, targetY, 14, dt);
        }
        const targetYaw = Math.atan2(desired.x, desired.z);
        let dy = targetYaw - this.yaw;
        while (dy > Math.PI) dy -= Math.PI * 2;
        while (dy < -Math.PI) dy += Math.PI * 2;
        this.yaw += dy * (1 - Math.exp(-6 * dt));
      }
      // 边界
      const r = Math.hypot(this.pos.x, this.pos.z);
      if (r > 280) { this.pos.x *= 280 / r; this.pos.z *= 280 / r; }
    }

    // ---------- 动画 ----------
    this.animate(dt, t, speed, dp);
    this.root.position.copy(this.pos);
    this.root.rotation.y = this.yaw;
    this.root.rotation.z = 0;
  }

  animate(dt, t, speed, dp) {
    const rig = this.rig;
    if (this.def.jelly) {
      rig.tentacles.forEach((tc) => { tc.material.uniforms.uTime.value = t; });
      const pulse = 1 + Math.sin(t * 1.6 + this.phase) * 0.06;
      rig.bell.scale.set(pulse, 1 / pulse, pulse);
      rig.inner.material.emissiveIntensity = 2.4 + Math.sin(t * 2.2 + this.phase) * 1.2 + this._hitFlash * 4;
      rig.mat.emissiveIntensity = 1.2 + Math.sin(t * 1.4 + this.phase) * 0.5 + this._hitFlash * 2;
      this.root.rotation.z = Math.sin(t * 0.6 + this.phase) * 0.08;
      return;
    }
    const { body, neck, head, tail, legs } = rig;
    const moveAmt = clamp(speed / Math.max(this.def.speed, 0.1), 0, 1);
    const stride = speed > 4.5 ? 2.6 : 1.6;
    this.phase += dt * speed * stride;
    const isPredator = this.def.hostile;
    const attack = this.attackLunge || 0;
    this.attackLunge = Math.max(0, (this.attackLunge || 0) - dt * 3);

    // 躯干起伏
    body.position.y = rig.bodyY + Math.sin(this.phase * 2) * 0.03 * moveAmt + Math.sin(t * 1.3 + this.phase) * 0.01;
    body.rotation.x = Math.sin(this.phase) * 0.04 * moveAmt;
    body.rotation.z = Math.sin(this.phase) * 0.05 * moveAmt;
    if (this.hurtT > 0) body.rotation.x -= this.hurtT * 0.4;
    if (attack > 0) body.rotation.x -= attack * 0.35;

    // 头部：游荡时低头进食，好奇时抬头，追击时压低
    let headX = Math.sin(t * 0.7 + this.phase) * 0.08;
    if (this.state === 'graze') headX = 0.55 + Math.sin(t * 4) * 0.1;
    if (this.state === 'curious') headX = -0.3 - Math.sin(t * 2) * 0.06;
    if (this.state === 'alert' || this.state === 'chase' || this.state === 'attack') headX = -0.18 - attack * 0.3;
    if (this.state === 'flee') headX = -0.1;
    neck.rotation.x = damp(neck.rotation.x, headX, 5, dt);
    head.rotation.x = damp(head.rotation.x, -headX * 0.4 + Math.sin(t * 0.9) * 0.04, 5, dt);
    head.rotation.y = Math.sin(t * 0.53 + this.phase) * 0.25 * (this.state === 'wander' || this.state === 'graze' ? 1 : 0);

    // 腿：对角步态
    legs.forEach((lg, i) => {
      const off = (lg.sx * lg.sz > 0 ? 0 : Math.PI);
      const ph = this.phase + off;
      let swing = Math.sin(ph) * 0.55 * moveAmt;
      let knee = Math.max(0, Math.sin(ph + Math.PI / 2)) * 0.5 * moveAmt;
      if (this.state === 'graze') { swing *= 0.2; }
      lg.hip.rotation.x = swing;
      lg.knee.rotation.x = knee;
    });

    // 尾巴
    tail.rotation.y = Math.sin(t * 1.7 + this.phase * 0.3) * 0.35 + (this.state === 'chase' ? Math.sin(t * 9) * 0.2 : 0);
    tail.rotation.x = -0.15 + Math.sin(t * 1.1) * 0.08;

    // 发光反馈：攻击型锁定玩家时棘刺变亮
    const alert = this.state === 'alert' || this.state === 'chase' || this.state === 'attack';
    const targetGlow = (isPredator ? (alert ? 5.0 : 1.4) : 1.2) + this._hitFlash * 6;
    rig.accentMat.emissiveIntensity = damp(rig.accentMat.emissiveIntensity, targetGlow, 6, dt);
    rig.mat.emissiveIntensity = this._hitFlash * 1.5;
    rig.eyeMat.emissiveIntensity = alert ? 4 : 2;
  }
}

// ------------------------------------------------------------------
// 生态管理器
// ------------------------------------------------------------------
export class Ecosystem {
  constructor(game) {
    this.game = game;
    this.list = [];
    this.group = new THREE.Group();
    this.group.name = 'creatures';
  }

  spawn(key, count, pos) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 6 + Math.random() * 22;
      const p = pos.clone();
      p.x += Math.cos(a) * r;
      p.z += Math.sin(a) * r;
      p.y = this.game.terrain.height(p.x, p.z);
      this.add(new Creature(CREATURE_DEFS[key], p, this.game));
    }
  }

  add(c) {
    this.list.push(c);
    this.group.add(c.root);
    c.root.position.copy(c.pos);
  }

  clear() {
    for (const c of this.list) {
      this.group.remove(c.root);
      c.root.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
    }
    this.list = [];
  }

  update(dt, player) {
    for (const c of this.list) c.update(dt, player);
  }

  // 射线拾取
  pick(raycaster) {
    const meshes = [];
    for (const c of this.list) if (!c.dead) c.root.traverse((o) => { if (o.isMesh) { o.userData.creature = c; meshes.push(o); } });
    const hits = raycaster.intersectObjects(meshes, false);
    if (hits.length) return { creature: hits[0].object.userData.creature, point: hits[0].point, object: hits[0].object };
    return null;
  }
}
