// 植被几何与材质：草丛、蕨叶、巨蕨树冠、发光花朵、蘑菇、苔藓地毯
// 说明：实例化使用独立属性 uInstPos（每实例根位置），避免依赖 instanceMatrix 的编译期定义。
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clamp } from '../core/noise.js';

export const PLANT_VERT = /* glsl */ `
uniform float uTime, uWind;
uniform vec4 uShade[40];
attribute float aPhase;
attribute float aBend;
attribute vec3 uInstPos;
varying vec2 vUv;
varying float vH;
varying vec3 vWorldN, vWorldP;
varying float vShade;
void main() {
  vUv = uv;
  vH = uv.y;
  vec3 p = position;
  float ph = aPhase;
  float off = uInstPos.x * 0.13 + uInstPos.z * 0.17;
  float sway = sin(uTime * (1.1 + aBend * 0.6) + ph + off) * (0.05 + 0.10 * aBend);
  float gust = sin(uTime * 0.45 + uInstPos.x * 0.05 + uInstPos.z * 0.04) * 0.5 + 0.5;
  float k = vH * vH;
  p.x += sway * k * uWind * (0.6 + gust);
  p.z += sway * 0.6 * k * uWind * cos(ph + off);
  p.y -= abs(sway) * k * 0.1 * uWind;
  vec4 wp;
  #ifdef USE_INSTANCING
    wp = modelMatrix * instanceMatrix * vec4(p, 1.0);
    vWorldN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
  #else
    wp = modelMatrix * vec4(p, 1.0);
    vWorldN = normalize(mat3(modelMatrix) * normal);
  #endif
  vWorldP = wp.xyz;
  // 树荫 AO（植物自身也接受冠层阴影）
  float shade = 1.0;
  for (int i = 0; i < 40; i++) {
    vec4 sp = uShade[i];
    if (sp.w <= 0.0) continue;
    float d = length(wp.xz - sp.xz);
    shade *= mix(sp.z, 1.0, smoothstep(sp.w * 0.3, sp.w, d));
  }
  vShade = shade;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const PLANT_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uSunDir, uSunColor, uFogColor, uBaseCol, uTipCol;
uniform float uFogDensity, uTime, uGlow;
uniform vec3 uAmbient;
varying vec2 vUv;
varying float vH;
varying vec3 vWorldN, vWorldP;
varying float vShade;
void main() {
  vec3 col = mix(uBaseCol, uTipCol, smoothstep(0.05, 1.0, vH));
  vec3 N = normalize(vWorldN);
  float back = pow(max(dot(-N, uSunDir), 0.0), 2.0);
  float ndl = max(dot(N, uSunDir), 0.0);
  vec3 light = uSunColor * (ndl * 0.8 + back * 0.7) + uAmbient;
  float baseAO = 0.55 + 0.45 * smoothstep(0.0, 0.5, vH);
  vec3 lit = col * light * baseAO * mix(0.45, 1.0, vShade);
  lit += uTipCol * uGlow * (0.45 + 0.35 * smoothstep(0.3, 1.0, vH)) * (0.85 + 0.15 * sin(uTime * 2.0 + vWorldP.x * 0.3));
  vec3 v = normalize(cameraPosition - vWorldP);
  float rim = pow(1.0 - max(dot(N, v), 0.0), 3.0);
  lit += uSunColor * rim * 0.10 * vShade;
  float dist = length(cameraPosition - vWorldP);
  float fog = 1.0 - exp(-pow(dist * uFogDensity, 1.55));
  lit = mix(lit, uFogColor, clamp(fog, 0.0, 1.0));
  gl_FragColor = vec4(lit, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export function plantMaterial(palette, base, tip, glow = 0, shade = null) {
  return new THREE.ShaderMaterial({
    vertexShader: PLANT_VERT,
    fragmentShader: PLANT_FRAG,
    side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uWind: { value: palette.weather.wind },
      uSunDir: { value: new THREE.Vector3(...palette.sunDir).normalize() },
      uSunColor: { value: new THREE.Color().setRGB(...palette.sunColor).multiplyScalar(0.62) },
      uAmbient: { value: new THREE.Color().setRGB(...palette.ambientSky).multiplyScalar(0.5) },
      uFogColor: { value: new THREE.Color().setRGB(...palette.fogColor) },
      uFogDensity: { value: palette.fogDensity },
      uBaseCol: { value: new THREE.Color().setRGB(...base) },
      uTipCol: { value: new THREE.Color().setRGB(...tip) },
      uGlow: { value: glow },
      uShade: { value: shade || Array.from({ length: 40 }, () => new THREE.Vector4(0, 0, 0, 0)) },
    },
  });
}

// ------------------------------------------------------------------
// 几何构造
// ------------------------------------------------------------------
export function bladeGeometry(segments = 4, height = 1, width = 0.045, bend = 0.45, curl = 0.0) {
  const pos = [], nor = [], idx = [], uvs = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const y = t * height * (1 - curl * t * t * 0.5);
    const w = width * Math.pow(1 - t, 0.7) * (0.6 + 0.4 * Math.sin(t * 3.14));
    const xOff = bend * t * t * height;
    pos.push(-w + xOff, y, 0);
    pos.push(w + xOff, y, 0);
    nor.push(0, 0.35, 1);
    nor.push(0, 0.35, 1);
    uvs.push(0, t);
    uvs.push(1, t);
    if (i < segments) {
      const a = i * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  return g;
}

// 宽草片：顶端收成尖、中段最宽、整体向前弯
export function curvedBlade(width = 0.16, height = 1, droop = 0.35, segs = 6) {
  const pos = [], nor = [], idx = [], uvs = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const y = height * (t - droop * t * t * t);
    // 根部窄 → 中段宽 → 顶端尖锐
    const w = width * 0.5 * Math.pow(Math.sin(Math.min(1, t * 0.92 + 0.08) * Math.PI), 0.85);
    const z = t * t * 0.18 * height;
    pos.push(-w, y, z, w, y, z);
    nor.push(0, 0.5, 1, 0, 0.5, 1);
    uvs.push(0, t, 1, t);
    if (i < segs) {
      const a = i * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  return g;
}

// 雕刻草片：沿高度方向收窄、带镂空裂隙的草叶（程序化"草贴图"），避免大片平板感
export function carvedBlade(width = 0.5, height = 1, segs = 7) {
  const pos = [], nor = [], idx = [], uvs = [];
  const columns = 4;
  let vi = 0;
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const y = height * (t - 0.28 * t * t * t);
    // 沿高度收窄的轮廓
    const spread = Math.pow(Math.sin(Math.min(1, t * 0.9 + 0.1) * Math.PI), 0.8);
    const baseW = width * 0.5;
    for (let c = 0; c <= columns; c++) {
      const u = c / columns;
      let x = (u - 0.5) * 2 * baseW * spread;
      // 裂隙：中段某些列向内收，形成分叉
      const gap = Math.max(0, Math.sin(u * Math.PI * 3.0 + 0.9 + t * 1.2));
      const notch = (c === 1 || c === 2 || c === 3) ? gap * 0.42 : 0;
      x -= Math.sign(x) * notch * baseW * 2 * spread;
      // 叶片向前后弯
      const z = Math.sin(u * Math.PI) * 0.06 * height + t * t * 0.2 * height;
      pos.push(x, y, z);
      nor.push(0, 0.55, 1);
      uvs.push(u, t);
      if (i < segs && c < columns) {
        const a = vi;
        idx.push(a, a + 1, a + columns + 1, a, a + columns + 1, a + columns);
      }
      vi++;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  return g;
}

// 草浪簇：3 片雕刻草片交叉
export function clumpGeometry(blades = 3, width = 0.34) {
  const parts = [];
  for (let i = 0; i < blades; i++) {
    const a = (i / blades) * Math.PI * 2 + Math.random() * 0.5;
    const g = carvedBlade(width * (0.75 + Math.random() * 0.5), 1, 6);
    g.rotateY(a);
    g.rotateZ((Math.random() - 0.5) * 0.3);
    parts.push(g);
  }
  return mergeGeometries(parts);
}

// 草丛：一簇 5 片细长叶片，带自然弯曲
export function tuftGeometry(blades = 5) {
  const parts = [];
  for (let i = 0; i < blades; i++) {
    const a = (i / blades) * Math.PI * 2 + Math.random() * 0.6;
    const g = bladeGeometry(4, 1, 0.032 + Math.random() * 0.016, 0.35 + Math.random() * 0.4, Math.random() * 0.4);
    g.rotateY(a);
    g.rotateX((Math.random() - 0.5) * 0.25);
    g.translate(Math.cos(a) * 0.05, 0, Math.sin(a) * 0.05);
    parts.push(g);
  }
  return mergeGeometries(parts);
}

// 蕨叶：中轴 + 两侧渐小的羽叶（带一点弧度）
export function fernGeometry(len = 1.0, leafCount = 11, width = 0.5) {
  const parts = [];
  const stem = new THREE.CylinderGeometry(0.006, 0.014, len, 3, 1);
  stem.translate(0, len / 2, 0);
  parts.push(stem);
  for (let i = 1; i <= leafCount; i++) {
    const t = i / (leafCount + 1);
    const lw = width * 0.42 * (1 - t * 0.72);
    const ll = width * (1 - t * 0.55);
    for (const s of [-1, 1]) {
      const leaf = new THREE.PlaneGeometry(ll, lw * 1.6, 2, 1);
      const pa = leaf.attributes.position;
      for (let k = 0; k < pa.count; k++) {
        const x = pa.getX(k);
        pa.setZ(k, Math.abs(x) * 0.35);
      }
      leaf.computeVertexNormals();
      leaf.rotateX(-Math.PI / 2);
      leaf.rotateZ(s * (0.85 + t * 0.15));
      leaf.translate(s * (ll * 0.42), t * len - Math.pow(t, 2) * len * 0.18, 0);
      parts.push(leaf);
    }
  }
  return mergeGeometries(parts);
}

// 花朵
export function flowerGeometry(petals = 5, r = 0.05) {
  const parts = [];
  for (let i = 0; i < petals; i++) {
    const a = (i / petals) * Math.PI * 2;
    const g = new THREE.CircleGeometry(r, 5);
    g.rotateX(-Math.PI / 2);
    g.translate(r * 0.85, 0, 0);
    g.rotateY(a);
    g.rotateZ(0.22);
    parts.push(g);
  }
  const c = new THREE.CircleGeometry(r * 0.42, 6);
  c.rotateX(-Math.PI / 2);
  c.translate(0, 0.01, 0);
  parts.push(c);
  const merged = mergeGeometries(parts);
  merged.rotateX(-0.45);
  return merged;
}

// 树冠叶簇：每片叶子沿一条 3D 拱形脊线从中心向外伸展、向下垂落，
// 两侧的羽片垂直于脊线展开 —— 这样从任何角度看都是立体的"蕨树冠"而不是扁圆盘。
export function crownGeometry(fronds = 12, len = 1.0) {
  const parts = [];
  for (let i = 0; i < fronds; i++) {
    const a = (i / fronds) * Math.PI * 2 + (Math.random() - 0.5) * 0.35;
    const L = len * (0.78 + Math.random() * 0.42);
    const arch = 0.30 + Math.random() * 0.22;  // 起始上扬
    const drop = 0.85 + Math.random() * 0.55;  // 末端下垂
    parts.push(archFrond3D(L, a, arch, drop));
  }
  return mergeGeometries(parts);
}

// 单片 3D 羽状叶：脊线 r(t) 在竖直平面内弯曲，羽片沿脊线两侧铺开
function archFrond3D(L, yaw, arch, drop) {
  const parts = [];
  const SEG = 9;
  const cx = Math.cos(yaw), cz = Math.sin(yaw);       // 向外方向
  const px = -cz, pz = cx;                            // 侧向
  // 脊线采样：沿半径 r，高度 y
  const spine = [];
  for (let i = 0; i <= SEG; i++) {
    const t = i / SEG;
    const r = L * t;
    // 先上拱再下垂
    const y = L * (Math.sin(t * Math.PI * 0.55) * arch - t * t * drop * 0.62);
    spine.push(new THREE.Vector3(cx * r, y, cz * r));
  }
  // 脊线本身（细杆）
  for (let i = 0; i < SEG; i++) {
    const A = spine[i], B = spine[i + 1];
    const dir = B.clone().sub(A);
    const lenSeg = dir.length();
    if (lenSeg < 1e-5) continue;
    const stem = new THREE.CylinderGeometry(0.006, 0.010, lenSeg, 3, 1);
    stem.translate(0, lenSeg / 2, 0);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    stem.applyQuaternion(q);
    stem.translate(A.x, A.y, A.z);
    parts.push(stem);
  }
  // 羽片：每段脊线两侧各一片，长度向内递减，带自己的小上翘
  for (let i = 1; i <= SEG; i++) {
    const t = i / SEG;
    const P = spine[i];
    const half = L * 0.30 * (1 - t * 0.62) + 0.02;   // 羽片长度
    for (const s of [-1, 1]) {
      const leaf = new THREE.PlaneGeometry(half * 2.0, half * 0.85, 2, 1);
      // 叶面：先平放（XZ 平面），再让外侧略微下折
      leaf.rotateX(-Math.PI / 2);
      const pa = leaf.attributes.position;
      for (let k = 0; k < pa.count; k++) {
        const lx = pa.getX(k), lz = pa.getZ(k);
        pa.setY(k, -Math.abs(lx) * 0.28 - Math.abs(lz) * 0.12);
      }
      leaf.computeVertexNormals();
      // 平移到脊线两侧，并朝向侧向
      leaf.rotateY(yaw + s * 0.12);
      leaf.translate(P.x + px * s * half * 0.85, P.y + 0.01, P.z + pz * s * half * 0.85);
      parts.push(leaf);
    }
  }
  return mergeGeometries(parts);
}

// 苔藓地毯（顶部微隆的圆盘）
export function mossGeometry(r = 1) {
  const g = new THREE.CircleGeometry(r, 12, 0, Math.PI * 2);
  g.rotateX(-Math.PI / 2);
  const pa = g.attributes.position;
  for (let i = 0; i < pa.count; i++) {
    const x = pa.getX(i), z = pa.getZ(i);
    const d = Math.hypot(x, z) / r;
    pa.setY(i, (1 - d * d) * 0.12);
  }
  g.computeVertexNormals();
  return g;
}

// 蘑菇
export function mushroomGeometry() {
  const stem = new THREE.CylinderGeometry(0.035, 0.05, 0.32, 7);
  stem.translate(0, 0.16, 0);
  const cap = new THREE.SphereGeometry(0.16, 12, 6, 0, Math.PI * 2, 0, Math.PI * 0.55);
  cap.scale(1, 0.7, 1);
  cap.translate(0, 0.31, 0);
  return mergeGeometries([stem, cap]);
}

// 带花柄的花朵（实例化时整体放大，花头位于上方）
export function flowerWithStem(r = 0.055, stemH = 0.22) {
  const head = flowerGeometry(5, r);
  head.translate(0, stemH, 0);
  const stem = new THREE.CylinderGeometry(0.004, 0.006, stemH, 3);
  stem.translate(0, stemH / 2, 0);
  return mergeGeometries([head, stem]);
}
