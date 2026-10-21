// 火箭飞船：微缩模型造型 + 驾驶舱 + 引擎尾焰 + 起落架 + 外部航行姿态
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { clamp, damp, lerp } from '../core/noise.js';

const FLAME_VERT = /* glsl */ `
uniform float uTime, uLen, uIntensity;
varying vec2 vUv;
varying float vT;
void main() {
  vUv = uv;
  float t = 1.0 - uv.y;     // 0 顶部，1 尾部
  vec3 p = position;
  float wob = sin(uTime * 30.0 + uv.y * 18.0) * 0.03 * t;
  p.x += wob * uIntensity;
  p.z += cos(uTime * 24.0 + uv.y * 14.0) * 0.03 * t * uIntensity;
  p.y *= uLen * (1.0 + 0.12 * sin(uTime * 41.0 + uv.y * 9.0));
  vT = t;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;
const FLAME_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uColor, uCore;
uniform float uTime, uIntensity;
varying vec2 vUv;
varying float vT;
void main() {
  float a = pow(1.0 - vT, 1.9) * smoothstep(0.0, 0.28, vT) * uIntensity;
  vec3 c = mix(uCore, uColor, pow(vT, 0.7));
  c += vec3(1.0, 0.95, 0.85) * pow(1.0 - vT, 7.0) * uIntensity * 0.7;
  gl_FragColor = vec4(c * 1.9, a * 0.9);
}
`;

export class Rocket {
  constructor(game) {
    this.game = game;
    this.group = new THREE.Group();
    this.group.name = 'rocket';
    this.time = 0;
    this.occupied = false;
    this.parts = {};
    this.build();
  }

  build() {
    const accent = this.game.palette.accent;
    const hull = new THREE.MeshStandardMaterial({ color: new THREE.Color('#e9ebe6'), roughness: 0.32, metalness: 0.18 });
    const hullDark = new THREE.MeshStandardMaterial({ color: new THREE.Color('#3a3f45'), roughness: 0.42, metalness: 0.35 });
    const accentMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(accent), roughness: 0.3, metalness: 0.6 });
    const glowMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(accent), emissive: new THREE.Color(accent), emissiveIntensity: 2.4, roughness: 0.3 });
    const metal = new THREE.MeshStandardMaterial({ color: new THREE.Color('#9aa3ab'), roughness: 0.25, metalness: 0.95 });
    const glass = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color('#a9d8ff'), roughness: 0.02, metalness: 0.0, transparent: true, opacity: 0.22,
      clearcoat: 1.0, side: THREE.DoubleSide, depthWrite: false,
    });
    this.mats = { hull, hullDark, accentMat, glowMat, metal, glass };

    const g = new THREE.Group();
    g.position.y = 0.55;
    this.group.add(g);
    this.body = g;
    // 船体归一化：整体缩放到约 2.9m 高，并让机身底部贴合地面
    const SHIP_SCALE = 0.95;
    g.scale.setScalar(SHIP_SCALE);
    g.position.y = 0.55 * SHIP_SCALE;

    // 主体：流线型机身（分段圆柱 + 收口）
    const bodyH = 2.4;
    const bodyR = 0.46;
    const bodyGeo = new THREE.CylinderGeometry(bodyR * 0.92, bodyR, bodyH, 28, 1);
    const body = new THREE.Mesh(bodyGeo, hull);
    body.position.y = bodyH / 2;
    body.castShadow = true; body.receiveShadow = true;
    g.add(body);
    // 面板线（腰环）
    for (const yy of [0.32, 1.25, 2.05]) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(bodyR * (yy > 1.5 ? 0.95 : 1.0), 0.012, 6, 32), hullDark);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = yy;
      g.add(ring);
    }
    // 机头（尖锥 + 圆润过渡）
    const noseGeo = new THREE.CylinderGeometry(0.02, bodyR * 0.92, 0.85, 28, 4);
    const nose = new THREE.Mesh(noseGeo, hull);
    nose.position.y = bodyH + 0.42;
    nose.castShadow = true;
    g.add(nose);
    const noseTip = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), glowMat);
    noseTip.position.y = bodyH + 0.86;
    g.add(noseTip);
    // 驾驶舱（前部）
    const cockpit = new THREE.Group();
    cockpit.position.set(0, 1.85, 0.30);
    g.add(cockpit);
    const cGlass = new THREE.Mesh(new THREE.SphereGeometry(0.26, 20, 16, -Math.PI * 0.55, Math.PI * 1.1, 0, Math.PI * 0.62), glass);
    cGlass.rotation.x = -Math.PI * 0.08;
    cGlass.scale.set(1.1, 1.15, 0.85);
    cockpit.add(cGlass);
    const cFrame = new THREE.Mesh(new THREE.TorusGeometry(0.26, 0.018, 6, 24, Math.PI), accentMat);
    cFrame.rotation.x = Math.PI / 2;
    cFrame.rotation.z = 0;
    cFrame.position.set(0, -0.05, 0.06);
    cockpit.add(cFrame);

    // 侧翼鳍（4 片）
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const finShape = new THREE.Shape();
      finShape.moveTo(0, 0);
      finShape.lineTo(0.42, -0.18);
      finShape.lineTo(0.40, -0.62);
      finShape.lineTo(0, -0.78);
      finShape.lineTo(0, 0);
      const finGeo = new THREE.ExtrudeGeometry(finShape, { depth: 0.025, bevelEnabled: true, bevelSize: 0.008, bevelThickness: 0.008, bevelSegments: 1 });
      const fin = new THREE.Mesh(finGeo, hullDark);
      const pivot = new THREE.Group();
      pivot.rotation.y = a;
      fin.position.set(0.42, 0.78, -0.012);
      fin.rotation.y = Math.PI / 2;
      fin.castShadow = true;
      pivot.add(fin);
      // 翼灯
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.022, 8, 6), glowMat);
      lamp.position.set(0.42, 0.1, 0);
      pivot.add(lamp);
      g.add(pivot);
    }
    // 侧推进器（两个小舱）
    for (const s of [-1, 1]) {
      const pod = new THREE.Mesh(new RoundedBoxGeometry(0.16, 0.62, 0.2, 3, 0.05), hullDark);
      pod.position.set(s * 0.5, 0.7, -0.05);
      pod.castShadow = true;
      g.add(pod);
      const podLight = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.3, 0.01), glowMat);
      podLight.position.set(s * 0.585, 0.72, 0.02);
      g.add(podLight);
    }
    // 引擎喷口（主）
    const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.26, 0.3, 24, 1, true), metal);
    nozzle.position.y = -0.12;
    nozzle.castShadow = true;
    g.add(nozzle);
    const nozzleInner = new THREE.Mesh(new THREE.CircleGeometry(0.25, 24), glowMat);
    nozzleInner.rotation.x = Math.PI / 2;
    nozzleInner.position.y = -0.26;
    g.add(nozzleInner);
    // 引擎辉光
    this.engineGlow = new THREE.PointLight(new THREE.Color('#ffb066'), 0, 7, 2);
    this.engineGlow.position.y = -0.6;
    g.add(this.engineGlow);
    this.engineGlowMain = this.engineGlow;

    // 尾焰（两层锥体）
    const mkFlame = (color, core, radius, baseLen) => {
      const geo = new THREE.ConeGeometry(radius, 1, 18, 12, true);
      geo.translate(0, 0.5, 0);
      geo.rotateX(Math.PI);
      const mat = new THREE.ShaderMaterial({
        vertexShader: FLAME_VERT,
        fragmentShader: FLAME_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        uniforms: {
          uTime: { value: 0 },
          uLen: { value: baseLen },
          uIntensity: { value: 0 },
          uColor: { value: new THREE.Color(color) },
          uCore: { value: new THREE.Color(core) },
        },
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.y = -0.3;
      mesh.renderOrder = 10;
      g.add(mesh);
      return { mesh, mat, baseLen };
    };
    this.flameOuter = mkFlame('#ff7a2a', '#ffd9a0', 0.32, 2.4);
    this.flameInner = mkFlame('#8fe6ff', '#ffffff', 0.18, 1.5);

    // 起落架：3 条腿 + 液压支杆
    this.legs = [];
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + Math.PI / 6;
      const leg = new THREE.Group();
      leg.position.set(Math.cos(a) * 0.36, 0.35, Math.sin(a) * 0.36);
      leg.rotation.y = -a + Math.PI / 2;
      const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.7, 8), metal);
      strut.position.y = -0.35;
      leg.add(strut);
      const knee = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 6), hullDark);
      knee.position.y = -0.7;
      leg.add(knee);
      const lower = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.024, 0.55, 8), metal);
      lower.position.set(0, -0.98, 0.1);
      lower.rotation.x = 0.25;
      leg.add(lower);
      const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.13, 0.05, 12), hullDark);
      pad.position.set(0, -1.27, 0.2);
      leg.add(pad);
      leg.traverse((o) => { if (o.isMesh) o.castShadow = true; });
      g.add(leg);
      this.legs.push(leg);
    }

    // 舱门（后侧）
    this.door = new THREE.Group();
    this.door.position.set(0, 0.95, -0.455);
    const doorMesh = new THREE.Mesh(new RoundedBoxGeometry(0.34, 0.55, 0.03, 2, 0.02), accentMat);
    this.door.add(doorMesh);
    const doorGlow = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.04, 0.01), glowMat);
    doorGlow.position.set(0, 0.16, -0.02);
    this.door.add(doorGlow);
    this.doorClosedZ = -0.455;
    g.add(this.door);
    // 舱门台阶
    const step = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.05, 0.22), hullDark);
    step.position.set(0, 0.42, -0.56);
    g.add(step);

    // 飞船上的灯（夜间）
    this.lamp = new THREE.PointLight(new THREE.Color(accent), 0, 9, 1.6);
    this.lamp.position.set(0, 1.0, -0.9);
    this.group.add(this.lamp);
    this.lampOn = false;

    this.group.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = o.castShadow !== false;
        // BUG-29：飞船船体是弹道遮挡体
        o.userData.occluder = true;
      }
    });
    this.group.position.set(0, 0, 0);
    this.root = this.group;
  }

  setTransform(pos, yaw) {
    this.group.position.copy(pos);
    this.group.rotation.y = yaw;
  }

  openDoor(open) {
    this.doorTarget = open ? 1 : 0;
  }

  update(dt, t) {
    this.time = t;
    const glow = this.throttle || 0;
    this.flameOuter.mat.uniforms.uTime.value = t;
    this.flameInner.mat.uniforms.uTime.value = t;
    this.flameOuter.mat.uniforms.uIntensity.value = glow;
    this.flameInner.mat.uniforms.uIntensity.value = glow * 1.2;
    this.engineGlow.intensity = glow * 11;
    this.legs.forEach((l) => { l.visible = true; });
    // 舱门滑动开合
    if (this.doorTarget !== undefined) {
      this._door = damp(this._door ?? 0, this.doorTarget, 4, dt);
      this.door.position.z = this.doorClosedZ - this._door * 0.42;
      this.door.rotation.y = -this._door * 0.9;
      this.door.position.x = this._door * 0.32;
    }
    this.lamp.intensity = this.lampOn ? 6 + Math.sin(t * 2) * 1 : 0;
  }
}
