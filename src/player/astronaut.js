// 微缩宇航员：程序化建模 + 程序化骨骼动画（待机/行走/奔跑/跳跃/采集/射击/建造/登船）
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { clamp, lerp, damp } from '../core/noise.js';

function makeMaterials(accent) {
  const suit = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#e6e4df'),
    roughness: 0.52,
    metalness: 0.05,
  });
  // 织物细节
  suit.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vS;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvS = (modelMatrix*vec4(transformed,1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vS;\nfloat hsh(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}\nfloat vn(vec2 p){vec2 i=floor(p),f=fract(p);vec2 u=f*f*(3.0-2.0*f);return mix(mix(hsh(i),hsh(i+vec2(1,0)),u.x),mix(hsh(i+vec2(0,1)),hsh(i+vec2(1,1)),u.x),u.y);}')
      .replace('#include <color_fragment>', '#include <color_fragment>\n float fab = vn(vS.xz*90.0);\n diffuseColor.rgb *= 0.96+0.06*fab;\n float dirt = smoothstep(0.55,1.0,vn(vS.xz*6.0+vS.y*4.0));\n diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb*vec3(0.93,0.9,0.86), dirt*0.35);');
  };
  const accentMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(accent), roughness: 0.35, metalness: 0.55 });
  const accentGlow = new THREE.MeshStandardMaterial({
    color: new THREE.Color(accent),
    emissive: new THREE.Color(accent),
    emissiveIntensity: 2.2,
    roughness: 0.3,
  });
  const dark = new THREE.MeshStandardMaterial({ color: new THREE.Color('#2a2d31'), roughness: 0.45, metalness: 0.35 });
  const metal = new THREE.MeshStandardMaterial({ color: new THREE.Color('#b9bec4'), roughness: 0.22, metalness: 0.95 });
  const gold = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#f0c27a'),
    roughness: 0.12,
    metalness: 1.0,
    emissive: new THREE.Color('#5a3a10'),
    emissiveIntensity: 0.5,
    envMapIntensity: 1.4,
  });
  const glass = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color('#8fd8ff'),
    roughness: 0.02,
    metalness: 0.05,
    transmission: 0.0,
    transparent: true,
    opacity: 0.32,
    clearcoat: 1.0,
    clearcoatRoughness: 0.03,
    envMapIntensity: 1.6,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const packMat = new THREE.MeshStandardMaterial({ color: new THREE.Color('#cfd3d6'), roughness: 0.5, metalness: 0.2 });
  return { suit, accentMat, accentGlow, dark, metal, gold, glass, packMat };
}

export class Astronaut {
  constructor(accent = '#7ff0c8') {
    this.mats = makeMaterials(accent);
    this.root = new THREE.Group();
    this.root.name = 'astronaut';
    this.build();
    this.time = 0;
    this.state = 'idle';
    this.params = { walk: 0, run: 0, aim: 0, crouch: 0, gather: 0, build: 0, airborne: 0, hurt: 0, wave: 0, sit: 0 };
    this.speedSmooth = 0;
    this.cycle = 0;
    this.velocityY = 0;
    this.lookYaw = 0;
    this.lookPitch = 0;
  }

  build() {
    const M = this.mats;
    const m = (geo, mat, x = 0, y = 0, z = 0, parent = this.root) => {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      parent.add(mesh);
      return mesh;
    };

    // ---------------- 臀部 / 躯干 ----------------
    this.pelvis = new THREE.Group();
    this.pelvis.position.y = 0.34;
    this.root.add(this.pelvis);
    m(new RoundedBoxGeometry(0.075, 0.05, 0.05, 3, 0.02), M.suit, 0, 0, 0, this.pelvis);

    this.spine = new THREE.Group();
    this.spine.position.y = 0.025;
    this.pelvis.add(this.spine);
    // 胸甲
    const torso = m(new RoundedBoxGeometry(0.09, 0.1, 0.062, 4, 0.026), M.suit, 0, 0.05, 0, this.spine);
    torso.scale.set(1, 1, 1);
    // 胸口控制面板
    m(new RoundedBoxGeometry(0.048, 0.032, 0.012, 2, 0.005), M.dark, 0, 0.06, 0.033, this.spine);
    const led1 = m(new THREE.BoxGeometry(0.008, 0.008, 0.004), M.accentGlow, -0.012, 0.065, 0.04, this.spine);
    const led2 = m(new THREE.BoxGeometry(0.008, 0.008, 0.004), M.accentGlow, 0.0, 0.065, 0.04, this.spine);
    led2.material = M.accentGlow;
    this.leds = [led1, led2];
    // 腰部软质
    m(new THREE.CylinderGeometry(0.036, 0.038, 0.03, 14), M.dark, 0, 0.0, 0, this.spine);

    // 生命维持背包
    const pack = m(new RoundedBoxGeometry(0.085, 0.1, 0.04, 3, 0.016), M.packMat, 0, 0.055, -0.052, this.spine);
    pack.scale.set(1, 1, 1);
    m(new THREE.CylinderGeometry(0.008, 0.008, 0.09, 8), M.metal, -0.03, 0.055, -0.058, this.spine).rotation.z = 0.0;
    m(new THREE.CylinderGeometry(0.008, 0.008, 0.09, 8), M.metal, 0.03, 0.055, -0.058, this.spine);
    // 背包散热格栅发光
    const vent = m(new THREE.BoxGeometry(0.05, 0.006, 0.003), M.accentGlow, 0, 0.03, -0.073, this.spine);
    vent.castShadow = false;

    // 肩环
    m(new THREE.TorusGeometry(0.02, 0.007, 8, 16), M.metal, -0.05, 0.085, 0, this.spine).rotation.y = Math.PI / 2;
    m(new THREE.TorusGeometry(0.02, 0.007, 8, 16), M.metal, 0.05, 0.085, 0, this.spine).rotation.y = Math.PI / 2;

    // ---------------- 头部 ----------------
    this.neck = new THREE.Group();
    this.neck.position.y = 0.112;
    this.spine.add(this.neck);
    m(new THREE.CylinderGeometry(0.02, 0.024, 0.02, 12), M.dark, 0, 0.004, 0, this.neck);
    this.head = new THREE.Group();
    this.head.position.y = 0.045;
    this.neck.add(this.head);
    // 头盔外壳
    const helmet = m(new THREE.SphereGeometry(0.058, 32, 24), M.suit, 0, 0.0, 0, this.head);
    helmet.scale.set(1, 1.02, 1.04);
    // 面窗：大而透明的金色玻璃
    const visorGeo = new THREE.SphereGeometry(0.06, 32, 24, -Math.PI * 0.62, Math.PI * 1.24, Math.PI * 0.18, Math.PI * 0.55);
    this.visor = m(visorGeo, M.gold, 0, -0.004, 0.004, this.head);
    this.visor.rotation.x = -0.06;
    this.visor.castShadow = false;
    // 头盔外玻璃罩
    const shell = m(new THREE.SphereGeometry(0.0615, 32, 24), M.glass, 0, 0, 0, this.head);
    shell.castShadow = false;
    // 头盔天线 + 侧灯
    const ant = m(new THREE.CylinderGeometry(0.0018, 0.0018, 0.05, 6), M.metal, 0.048, 0.045, -0.02, this.head);
    ant.rotation.z = -0.35;
    const antTip = m(new THREE.SphereGeometry(0.005, 8, 8), M.accentGlow, 0.056, 0.068, -0.02, this.head);
    antTip.castShadow = false;
    const lamp = m(new THREE.CylinderGeometry(0.012, 0.012, 0.02, 12), M.metal, 0, 0.02, 0.058, this.head);
    lamp.rotation.x = Math.PI / 2;
    const lens = m(new THREE.CircleGeometry(0.0095, 16), M.accentGlow, 0, 0.02, 0.069, this.head);
    lens.castShadow = false;
    // 头盔环
    m(new THREE.TorusGeometry(0.045, 0.006, 8, 24), M.accentMat, 0, -0.045, 0, this.head).rotation.x = Math.PI / 2;

    // ---------------- 手臂 ----------------
    const arm = (side) => {
      const shoulder = new THREE.Group();
      shoulder.position.set(side * 0.055, 0.085, 0);
      this.spine.add(shoulder);
      m(new RoundedBoxGeometry(0.03, 0.055, 0.03, 3, 0.012), M.suit, 0, -0.028, 0, shoulder);
      const elbow = new THREE.Group();
      elbow.position.y = -0.058;
      shoulder.add(elbow);
      m(new RoundedBoxGeometry(0.027, 0.052, 0.027, 3, 0.011), M.suit, 0, -0.026, 0, elbow);
      m(new THREE.TorusGeometry(0.016, 0.005, 8, 16), M.accentMat, 0, -0.05, 0, elbow).rotation.x = Math.PI / 2;
      const hand = new THREE.Group();
      hand.position.y = -0.062;
      elbow.add(hand);
      m(new RoundedBoxGeometry(0.026, 0.03, 0.026, 3, 0.011), M.dark, 0, -0.012, 0, hand);
      return { shoulder, elbow, hand };
    };
    this.armL = arm(-1);
    this.armR = arm(1);

    // ---------------- 腿 ----------------
    const leg = (side) => {
      const hip = new THREE.Group();
      hip.position.set(side * 0.026, -0.015, 0);
      this.pelvis.add(hip);
      m(new RoundedBoxGeometry(0.036, 0.06, 0.038, 3, 0.015), M.suit, 0, -0.03, 0, hip);
      const knee = new THREE.Group();
      knee.position.y = -0.062;
      hip.add(knee);
      m(new RoundedBoxGeometry(0.032, 0.058, 0.034, 3, 0.013), M.suit, 0, -0.03, 0, knee);
      m(new THREE.TorusGeometry(0.017, 0.0055, 8, 16), M.accentMat, 0, -0.058, 0, knee).rotation.x = Math.PI / 2;
      const foot = new THREE.Group();
      foot.position.y = -0.062;
      knee.add(foot);
      const boot = m(new RoundedBoxGeometry(0.038, 0.028, 0.062, 3, 0.012), M.dark, 0, -0.012, 0.012, foot);
      return { hip, knee, foot, boot };
    };
    this.legL = leg(-1);
    this.legR = leg(1);

    // ---------------- 武器：能量手枪 ----------------
    this.weapon = this.makePistol();
    this.weapon.position.set(0, -0.02, 0.012);
    this.weapon.rotation.x = Math.PI / 2.1;
    this.armR.hand.add(this.weapon);
    this.weapon.visible = true;

    // ---------------- 装备吸附点（采集物） ----------------
    this.backSlot = new THREE.Group();
    this.backSlot.position.set(0, 0.08, -0.085);
    this.spine.add(this.backSlot);

    this.root.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = o.castShadow !== false;
      }
    });
  }

  makePistol() {
    const M = this.mats;
    const g = new THREE.Group();
    const body = new THREE.Mesh(new RoundedBoxGeometry(0.022, 0.05, 0.028, 3, 0.008), M.dark);
    g.add(body);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.011, 0.045, 12), M.metal);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.006, 0.03);
    g.add(barrel);
    const core = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, 0.05, 8), M.accentGlow);
    core.rotation.x = Math.PI / 2;
    core.position.set(0, 0.006, 0.032);
    g.add(core);
    this.muzzle = new THREE.Object3D();
    this.muzzle.position.set(0, 0.006, 0.058);
    g.add(this.muzzle);
    const grip = new THREE.Mesh(new RoundedBoxGeometry(0.018, 0.04, 0.022, 2, 0.006), M.accentMat);
    grip.position.set(0, -0.035, -0.008);
    grip.rotation.x = -0.25;
    g.add(grip);
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.012, 0.02), M.metal);
    fin.position.set(0, 0.024, -0.006);
    g.add(fin);
    g.traverse((o) => { if (o.isMesh) { o.castShadow = true; } });
    return g;
  }

  // ---------------- 动画 ----------------
  update(dt, input) {
    this.time += dt;
    const t = this.time;
    const P = this.params;
    const speed = input.speed || 0;
    const targetWalk = clamp(speed / 2.6, 0, 1);
    const targetRun = clamp((speed - 2.6) / 3.4, 0, 1);
    P.walk = damp(P.walk, targetWalk, 10, dt);
    P.run = damp(P.run, targetRun, 8, dt);
    P.aim = damp(P.aim, input.aiming ? 1 : 0, 14, dt);
    P.airborne = damp(P.airborne, input.airborne ? 1 : 0, 14, dt);
    P.gather = damp(P.gather, input.gathering ? 1 : 0, 10, dt);
    P.build = damp(P.build, input.building ? 1 : 0, 10, dt);
    P.hurt = damp(P.hurt, 0, 3, dt);
    P.crouch = damp(P.crouch, input.crouching ? 1 : 0, 10, dt);

    const stride = 2.0 + P.run * 1.6;
    this.cycle += dt * speed * stride;
    const c = this.cycle;
    const walkAmt = Math.max(P.walk, P.run);
    const breathe = Math.sin(t * 1.7) * 0.008;

    // 髋部起伏 & 侧摆
    const bob = Math.abs(Math.sin(c)) * 0.018 * walkAmt;
    this.pelvis.position.y = 0.34 - P.crouch * 0.06 + bob + breathe;
    this.pelvis.rotation.z = Math.sin(c) * 0.05 * walkAmt;
    this.pelvis.rotation.y = Math.sin(c) * 0.06 * walkAmt;
    this.pelvis.rotation.x = P.crouch * 0.18 + P.run * 0.08;

    // 脊柱：奔跑前倾，待机微微呼吸
    this.spine.rotation.x = -0.04 * walkAmt - P.run * 0.16 + Math.sin(t * 1.7) * 0.012 - P.crouch * 0.1;
    this.spine.rotation.y = -Math.sin(c) * 0.08 * walkAmt;
    this.spine.rotation.z = Math.sin(c) * 0.03 * walkAmt;

    // 头部：看向瞄准方向/环顾
    const lookTarget = input.aiming ? (input.pitch || 0) * 0.8 : Math.sin(t * 0.37) * 0.12;
    this.lookPitch = damp(this.lookPitch, lookTarget, 6, dt);
    this.head.rotation.x = clamp(-this.lookPitch * 0.6, -0.5, 0.4) + Math.sin(t * 0.9) * 0.015;
    this.head.rotation.y = damp(this.head.rotation.y, Math.sin(t * 0.31) * 0.22 * (1 - walkAmt), 4, dt);

    // 手臂摆动
    const swing = Math.sin(c) * (0.45 + P.run * 0.55) * walkAmt;
    if (P.aim > 0.5) {
      // 双手举枪（朝向摄像机的右前方）
      this.armR.shoulder.rotation.x = lerp(this.armR.shoulder.rotation.x, -Math.PI * 0.47, 0.3);
      this.armR.shoulder.rotation.z = lerp(this.armR.shoulder.rotation.z, -0.08, 0.3);
      this.armR.elbow.rotation.x = lerp(this.armR.elbow.rotation.x, -0.12, 0.3);
      this.armL.shoulder.rotation.x = lerp(this.armL.shoulder.rotation.x, -Math.PI * 0.42, 0.25);
      this.armL.shoulder.rotation.z = -0.55;
      this.armL.elbow.rotation.x = -0.85;
    } else if (P.gather > 0.3) {
      // 采集：下蹲单手取样
      const g = Math.sin(t * 6.0) * 0.15;
      this.armR.shoulder.rotation.x = lerp(this.armR.shoulder.rotation.x, -1.5 + g, 0.25);
      this.armR.elbow.rotation.x = lerp(this.armR.elbow.rotation.x, -0.6, 0.25);
      this.armL.shoulder.rotation.x = lerp(this.armL.shoulder.rotation.x, -0.5 - g, 0.2);
      this.armL.elbow.rotation.x = lerp(this.armL.elbow.rotation.x, -0.9, 0.2);
    } else if (P.build > 0.3) {
      this.armR.shoulder.rotation.x = lerp(this.armR.shoulder.rotation.x, -1.9 + Math.sin(t * 3) * 0.2, 0.2);
      this.armR.elbow.rotation.x = -0.4;
      this.armL.shoulder.rotation.x = lerp(this.armL.shoulder.rotation.x, -1.6 + Math.sin(t * 3 + 1) * 0.2, 0.2);
      this.armL.elbow.rotation.x = -0.4;
    } else if (P.airborne > 0.5) {
      const fl = Math.sin(t * 9) * 0.08;
      this.armR.shoulder.rotation.x = lerp(this.armR.shoulder.rotation.x, -0.9 + fl, 0.2);
      this.armL.shoulder.rotation.x = lerp(this.armL.shoulder.rotation.x, -0.9 - fl, 0.2);
      this.armR.shoulder.rotation.z = lerp(this.armR.shoulder.rotation.z, -0.35, 0.2);
      this.armL.shoulder.rotation.z = lerp(this.armL.shoulder.rotation.z, 0.35, 0.2);
      this.armR.elbow.rotation.x = lerp(this.armR.elbow.rotation.x, -0.5, 0.2);
      this.armL.elbow.rotation.x = lerp(this.armL.elbow.rotation.x, -0.5, 0.2);
    } else {
      this.armR.shoulder.rotation.x = swing * 0.9 + Math.sin(t * 1.7) * 0.03;
      this.armL.shoulder.rotation.x = -swing * 0.9 - Math.sin(t * 1.7) * 0.03;
      this.armR.shoulder.rotation.z = -0.12 - P.run * 0.08;
      this.armL.shoulder.rotation.z = 0.12 + P.run * 0.08;
      this.armR.elbow.rotation.x = -0.18 - P.run * 0.55 - Math.max(0, -swing) * 0.4;
      this.armL.elbow.rotation.x = -0.18 - P.run * 0.55 - Math.max(0, swing) * 0.4;
    }

    // 腿部
    const legSwing = Math.sin(c) * (0.55 + P.run * 0.55) * walkAmt;
    if (P.airborne > 0.5) {
      this.legL.hip.rotation.x = lerp(this.legL.hip.rotation.x, -0.55, 0.2);
      this.legR.hip.rotation.x = lerp(this.legR.hip.rotation.x, 0.25, 0.2);
      this.legL.knee.rotation.x = lerp(this.legL.knee.rotation.x, 0.8, 0.2);
      this.legR.knee.rotation.x = lerp(this.legR.knee.rotation.x, 0.55, 0.2);
      this.legL.foot.rotation.x = 0.3;
      this.legR.foot.rotation.x = -0.1;
    } else {
      this.legL.hip.rotation.x = legSwing;
      this.legR.hip.rotation.x = -legSwing;
      this.legL.knee.rotation.x = Math.max(0, -Math.sin(c)) * (0.9 + P.run * 0.5) * walkAmt + P.crouch * 0.9;
      this.legR.knee.rotation.x = Math.max(0, Math.sin(c)) * (0.9 + P.run * 0.5) * walkAmt + P.crouch * 0.9;
      this.legL.foot.rotation.x = -this.legL.hip.rotation.x * 0.45;
      this.legR.foot.rotation.x = -this.legR.hip.rotation.x * 0.45;
      this.legL.hip.rotation.z = -0.04 * walkAmt;
      this.legR.hip.rotation.z = 0.04 * walkAmt;
    }

    // 受击后仰
    if (P.hurt > 0.01) {
      this.spine.rotation.x -= P.hurt * 0.25;
      this.neck.rotation.x = P.hurt * 0.2;
    } else {
      this.neck.rotation.x = 0;
    }

    // 胸口灯闪烁
    const blink = 0.6 + 0.4 * Math.sin(t * 3.1);
    this.mats.accentGlow.emissiveIntensity = 1.6 + blink * 0.9;
    this.mats.glass.opacity = 0.28 + Math.sin(t * 0.7) * 0.04;

    // 武器朝向
    this.weapon.rotation.x = Math.PI / 2.1 - P.aim * 0.12;
    this.weapon.position.z = 0.012 + P.aim * 0.01;
  }
}
