// 地形：高度场（解析函数）+ 三重网格 LOD（环形）+ 程序化地表着色器
import * as THREE from 'three';
import { createNoise } from '../core/noise.js';

const VERT = /* glsl */ `
uniform vec3 uTerrainCenter;
uniform float uAmp;
varying vec3 vWorld;      // 相对格网中心的世界坐标
varying float vDist;
varying vec3 vN;
uniform float uEdgeR;
uniform float uSkirt;
void main() {
  vec3 p = position;
  // 外侧裙边：网格边界顶点向下垂 40m，作为"悬崖"遮住所有接缝，背景永远不会漏出
  if (uSkirt > 0.5) {
    float onEdge = step(uEdgeR - 0.6, max(abs(p.x), abs(p.z)));
    p.y -= onEdge * 40.0;
  }
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWorld = p;
  vDist = length(uTerrainCenter - position);
  vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FRAG = /* glsl */ `
precision highp float;
varying vec3 vWorld;
varying float vDist;
varying vec3 vN;
uniform vec3 uSunDir, uSunColor;
uniform vec3 uGroundA, uGroundB, uGroundC, uRockA, uRockB;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uTime;
uniform float uWet;        // 水面高度（低于则为水/湿）
uniform float uWaterLevel;
uniform float uSnowLine;
uniform float uSlopeRock;
uniform float uKind;
uniform vec3 uAccent;
uniform vec3 uSkyTint;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.07 + 7.3; a *= 0.5; }
  return s;
}
float tri(vec2 p) { return abs(fract(p.x) - 0.5) + abs(fract(p.y) - 0.5); }

// 反照率细节（供光照使用）
vec3 albedoAt(vec2 xz, vec3 N, float h, float distFade, out float rough, out float glow) {
  float slope = 1.0 - clamp(N.y, 0.0, 1.0);
  float macro = fbm(xz * 0.045);
  float meso = fbm(xz * 0.21);
  float fine = fbm(xz * 0.9);
  float micro = fbm(xz * 3.3);
  float grain = hash(floor(xz * 42.0));
  float clump = smoothstep(0.45, 0.72, fine + meso * 0.3);
  rough = 0.92;
  glow = 0.0;

  vec3 col = mix(uGroundA, uGroundB, smoothstep(0.32, 0.70, macro + meso * 0.30));
  col = mix(col, uGroundC * 0.75, clump * 0.55);
  // 干枯/湿润斑块
  col *= 0.86 + 0.28 * fine;
  col = mix(col, col * vec3(0.78, 0.82, 0.72), smoothstep(0.55, 0.8, macro) * 0.35);

  // 岩石：陡坡 + 宏观斑块
  float rockMask = smoothstep(uSlopeRock - 0.16, uSlopeRock + 0.10, slope + (micro - 0.5) * 0.12);
  vec3 rock = mix(uRockA, uRockB, smoothstep(0.25, 0.8, micro * 0.7 + macro * 0.3));
  float strata = smoothstep(0.42, 0.48, tri(vec2(h * 1.4, (xz.x + xz.y) * 0.03)));
  rock *= 0.80 + 0.34 * strata;
  rock *= 0.85 + 0.3 * grain;
  col = mix(col, rock, rockMask);
  // 岩石边缘苔藓
  col = mix(col, uGroundB * 0.8, smoothstep(0.1, 0.0, abs(slope - uSlopeRock + 0.05)) * 0.25);

  if (uKind < 0.5) {
    // 苔原：草叶碎片细节（用连续噪声而非 floor 网格，避免方块状"纸屑"感）
    col *= 0.90 + 0.20 * grain;
    float tuft = smoothstep(0.62, 0.86, vnoise(xz * 6.5) * 0.6 + vnoise(xz * 15.0) * 0.4);
    col = mix(col, uGroundC * 1.06, tuft * 0.30);
    // 细小花点：用平滑噪声取峰，避免硬方块
    float flowerDots = smoothstep(0.86, 0.94, vnoise(xz * 22.0) * 0.5 + vnoise(xz * 47.0) * 0.5) * distFade;
    col = mix(col, vec3(0.78, 0.96, 0.74), flowerDots * 0.35);
  } else if (uKind < 1.5) {
    // 沙漠：风纹 + 砂砾
    float dune = sin(xz.x * 1.9 + xz.y * 0.6 + meso * 10.0) * 0.5 + 0.5;
    col *= 0.90 + 0.18 * dune;
    col *= 0.93 + 0.12 * grain;
    // 砾石：柔和斑块
    float gravel = smoothstep(0.70, 0.90, vnoise(xz * 5.5) * 0.55 + vnoise(xz * 13.0) * 0.45);
    col = mix(col, uRockB * 0.92, gravel * 0.45);
    // 风纹细线
    float ripple = 0.5 + 0.5 * sin(xz.y * 9.0 + fbm(xz * 0.6) * 6.0);
    col *= 0.95 + 0.09 * ripple * distFade;
  } else {
    // 荧光湿地：脉络 + 苔光
    float vein = smoothstep(0.78, 0.84, fbm(xz * 0.35 + vec2(uTime * 0.02, 0.0)));
    float vein2 = smoothstep(0.86, 0.9, fbm(xz * 0.12 - vec2(0.0, uTime * 0.015)));
    glow = (vein * 0.6 + vein2 * 0.8) * (1.0 - rockMask);
    float moss = smoothstep(0.5, 0.75, fine);
    col = mix(col, uGroundC * 0.9, moss * 0.4);
    col *= 0.85 + 0.3 * grain;
  }

  // 水线：湿沙 / 水下
  float waterMask = smoothstep(uWaterLevel + 0.45, uWaterLevel - 0.25, h);
  col = mix(col, col * 0.45 + vec3(0.015, 0.03, 0.025), waterMask * 0.75);
  rough = mix(rough, 0.25, waterMask);
  return col;
}

void main() {
  vec2 xz = vWorld.xz;
  vec3 N = normalize(vN);
  float h = vWorld.y;
  float dist = vDist;
  // 细节随距离淡出（抗噪点闪烁）
  float nearFade = 1.0 - smoothstep(18.0, 70.0, dist);
  float midFade = 1.0 - smoothstep(60.0, 220.0, dist);

  float rough, glow;
  vec3 col = albedoAt(xz, N, h, nearFade, rough, glow);
  // 近处再叠一层高频细节（模拟苔藓颗粒与砾石）
  if (nearFade > 0.01) {
    float d = vnoise(xz * 11.0) * 0.6 + vnoise(xz * 27.0) * 0.4;
    col *= 1.0 + (d - 0.5) * 0.34 * nearFade;
  }

  // ---- 光照：方向光 + 天光半球 + 轮廓 ----
  float ndl = max(dot(N, uSunDir), 0.0);
  // 软化的明暗过渡
  float wrap = dot(N, uSunDir) * 0.5 + 0.5;
  vec3 sun = uSunColor * (pow(ndl, 1.15) + wrap * wrap * 0.06);
  float skyAmt = N.y * 0.5 + 0.5;
  vec3 sky = mix(vec3(0.06, 0.08, 0.07), uSkyTint, skyAmt * skyAmt);
  // 地面反弹光
  vec3 bounce = uGroundA * uSunColor * 0.12 * max(N.y, 0.0);
  vec3 lit = col * (sun + sky * 1.05 + bounce + 0.015);
  lit += uAccent * glow * 2.2;

  // 距离雾（与天空地平线颜色一致，融入远景）
  float fog = 1.0 - exp(-pow(dist * uFogDensity * 1.35, 1.5));
  lit = mix(lit, uFogColor, clamp(fog, 0.0, 1.0));

  gl_FragColor = vec4(lit, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class Terrain {
  constructor(def, palette) {
    this.def = def;
    this.palette = palette;
    this.noise = createNoise(def.seed || 7);
    this.group = new THREE.Group();
    this.group.name = 'terrain';
    this.extent = def.extent || 315;
    this.amps = [def.localAmp || 6.5, 4.2, 6.0];
    this.materials = [];
    this.meshes = [];
    const kinds = { verdant: 0, emer: 1, lumina: 2 };
    this.kind = kinds[palette.id] || 0;
    this._build();
  }

  // ---- 解析高度函数 ----
  height(x, z) {
    const n = this.noise;
    const d = this.def;
    let h;
    if (d.biome === 'ferngrass') {
      h = n.fbm2(x * 0.0068, z * 0.0068, 4) * 7.0;
      h += n.fbm2(x * 0.026 + 40, z * 0.026, 3) * 2.2;
      h += n.fbm2(x * 0.13, z * 0.13, 2) * 0.45;
      // 中央浅丘
      h += 2.6 * Math.exp(-(x * x + z * z) / (2 * 95 * 95));
      // 北部大丘
      h += 9.0 * Math.exp(-((x + 60) * (x + 60) + (z + 120) * (z + 120)) / (2 * 110 * 110));
      // 水潭
      const pond = Math.exp(-((x - 120) ** 2 + (z - 55) ** 2) / (2 * 34 * 34));
      h -= pond * 4.2;
    } else if (d.biome === 'desert') {
      const warp = n.fbm2(x * 0.012, z * 0.012, 2) * 26;
      h = Math.sin((x + warp) * 0.045 + Math.sin(z * 0.011) * 2.0) * 1.9;
      h += Math.sin((z * 0.62 + x * 0.33) * 0.075) * 0.9;
      h += n.fbm2(x * 0.01, z * 0.01, 4) * 5.0;
      h += n.fbm2(x * 0.06, z * 0.06, 2) * 0.7;
      // 干裂河谷（峡谷切槽）
      const canyon = Math.exp(-(((x + z * 0.55 + n.fbm2(z * 0.01, 7) * 40) / 26) ** 2));
      h -= canyon * (7.5 + n.fbm2(x * 0.05, z * 0.05, 2) * 2);
      // 中央营地平地
      h += 1.2 * Math.exp(-(x * x + z * z) / (2 * 70 * 70));
    } else {
      h = n.fbm2(x * 0.008, z * 0.008, 4) * 5.5;
      h += n.fbm2(x * 0.03, z * 0.03, 3) * 1.8;
      h += n.fbm2(x * 0.15, z * 0.15, 2) * 0.35;
      // 起伏不大的荧光苔原 + 下沉水洼
      const basin = Math.exp(-((x + 40) ** 2 + (z - 80) ** 2) / (2 * 46 * 46));
      h -= basin * 5.5;
      const basin2 = Math.exp(-((x - 140) ** 2 + (z + 30) ** 2) / (2 * 30 * 30));
      h -= basin2 * 3.5;
      h += 4.0 * Math.exp(-((x - 60) * (x - 60) + (z + 140) * (z + 140)) / (2 * 90 * 90));
    }
    // 边缘隆起成山脊，把可玩区域围起来
    const r = Math.sqrt(x * x + z * z);
    const edge = Math.min(1, Math.max(0, (r - 245) / 90));
    const ridge = n.ridged2(x * 0.011, z * 0.011, 4) * 34 + n.fbm2(x * 0.02, z * 0.02, 2) * 10;
    h += edge * edge * (ridge + 14);
    return h;
  }

  slopeAt(x, z) {
    const e = 1.2;
    const hx = this.height(x + e, z) - this.height(x - e, z);
    const hz = this.height(x, z + e) - this.height(x, z - e);
    return Math.sqrt(hx * hx + hz * hz) / (2 * e);
  }

  _makeMaterial(amp) {
    const p = this.palette;
    const pl = p.plant;
    const d = this.def;
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      fog: false,
      uniforms: {
        uTerrainCenter: { value: new THREE.Vector3() },
        uAmp: { value: amp },
        uEdgeR: { value: this.extent },
        uSkirt: { value: this.kind === 0 ? 0 : 0 },
        uSunDir: { value: new THREE.Vector3(...p.sunDir).normalize() },
        uSunColor: { value: new THREE.Color().setRGB(...p.sunColor).multiplyScalar(0.62) },
        uGroundA: { value: new THREE.Color().setRGB(...(d.groundA || pl.ground)) },
        uGroundB: { value: new THREE.Color().setRGB(...(d.groundB || pl.grassA)) },
        uGroundC: { value: new THREE.Color().setRGB(...(d.groundC || pl.grassTip)) },
        uRockA: { value: new THREE.Color().setRGB(...(d.rockA || pl.rock)) },
        uRockB: { value: new THREE.Color().setRGB(...(d.rockB || pl.rock).map((c) => c * 1.6)) },
        uFogColor: { value: new THREE.Color().setRGB(...p.fogColor) },
        uFogDensity: { value: p.fogDensity },
        uTime: { value: 0 },
        uWet: { value: 0 },
        uWaterLevel: { value: d.waterLevel ?? -3.2 },
        uSnowLine: { value: 999 },
        uSlopeRock: { value: d.slopeRock ?? 0.32 },
        uKind: { value: this.kind },
        uAccent: { value: new THREE.Color(p.accent).multiplyScalar(0.18) },
        uSkyTint: { value: new THREE.Color().setRGB(...p.ambientSky).multiplyScalar(0.85) },
      },
    });
    this.materials.push(mat);
    return mat;
  }

  _grid(L, extent, ampMul) {
    const n = L + 1;
    const pos = new Float32Array(n * n * 3);
    const nor = new Float32Array(n * n * 3);
    const step = (extent * 2) / L;
    this._lastExtent = extent;
    const hArr = new Float32Array(n * n);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = -extent + i * step;
        const z = -extent + j * step;
        const h = this.height(x, z);
        const k = j * n + i;
        hArr[k] = h;
        pos[k * 3] = x;
        pos[k * 3 + 1] = h;
        pos[k * 3 + 2] = z;
      }
    }
    // 法线由高度差计算
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const il = Math.max(0, i - 1), ir = Math.min(L, i + 1);
        const jd = Math.max(0, j - 1), ju = Math.min(L, j + 1);
        const hl = hArr[j * n + il], hr = hArr[j * n + ir];
        const hd = hArr[jd * n + i], hu = hArr[ju * n + i];
        const dx = (hr - hl) / ((ir - il) * step);
        const dz = (hu - hd) / ((ju - jd) * step);
        const len = Math.hypot(dx, 1, dz);
        const k = (j * n + i) * 3;
        nor[k] = -dx / len;
        nor[k + 1] = 1 / len;
        nor[k + 2] = -dz / len;
      }
    }
    const idx = new Uint32Array(L * L * 6);
    let o = 0;
    for (let j = 0; j < L; j++) {
      for (let i = 0; i < L; i++) {
        const a = j * n + i, b = a + 1, c = a + n, dd = c + 1;
        // 从上方观察时为逆时针（与 computeVertexNormals 的 +Y 法线一致）
        idx[o++] = a; idx[o++] = c; idx[o++] = b;
        idx[o++] = b; idx[o++] = c; idx[o++] = dd;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    return g;
  }

  _build() {
    // 0: 近处细格 (LOD0)
    const geoNear = this._grid(512, this.extent, 1.0);
    const matNear = this._makeMaterial(1.0);
    const near = new THREE.Mesh(geoNear, matNear);
    near.frustumCulled = false;
    near.name = 'terrain-near';
    // BUG-29：地形是弹道遮挡体（不可伤害，但会挡住射线）
    near.userData.occluder = true;
    this.group.add(near);
    this.meshes.push(near);
    this.near = near;

    // 1: 远处地形：多层同心环形网格。每层的外边界都"盖住"下一层的内边界，
    //    并让内圈半径留出足够重叠，使不同分辨率造成的边缘错位被重叠区遮住。
    this.rings = [];
    const rings = [
      { L: 160, outer: 470, hole: 250, amp: 2.2 },
      { L: 120, outer: 900, hole: 400, amp: 4.0 },
      { L: 80, outer: 1800, hole: 830, amp: 6.0 },
    ];
    rings.forEach((r, ri) => {
      const geo = this._grid(r.L, r.outer, r.amp);
      const idx = geo.index.array;
      const posA = geo.attributes.position.array;
      const keep = [];
      // 圆形挖洞：三角形重心落在内圆内则丢弃（圆形边界比方形更不容易露缝）
      const hr = r.hole * r.hole;
      for (let t = 0; t < idx.length; t += 3) {
        let inside = 0;
        let cx = 0, cz = 0;
        for (let q = 0; q < 3; q++) {
          const vi = idx[t + q];
          cx += posA[vi * 3];
          cz += posA[vi * 3 + 2];
        }
        cx /= 3; cz /= 3;
        if (cx * cx + cz * cz < hr) inside = 1;
        if (!inside) keep.push(idx[t], idx[t + 1], idx[t + 2]);
      }
      geo.setIndex(keep.length ? new THREE.BufferAttribute(new Uint32Array(keep), 1) : new THREE.Uint32BufferAttribute([], 1));
      geo.computeBoundingSphere();
      const mat = this._makeMaterial(r.amp);
      mat.uniforms.uSkirt.value = 0;
      mat.uniforms.uEdgeR.value = r.outer;
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.name = 'terrain-ring' + ri;
      mesh.userData.occluder = true;
      this.group.add(mesh);
      this.meshes.push(mesh);
      this.rings.push({ mesh, L: r.L, outer: r.outer });
    });
  }

  update(camera, time) {
    // 所有地形网格的顶点都使用绝对世界坐标（见 _grid，x/z 覆盖 ±extent），
    // 因此网格必须固定在原点。原先按相机吸附值平移近景网格，会让渲染地形
    // 与 terrain.height() 的碰撞/摆放高度错开最多半个格距（≈0.6m），
    // 表现为角色下沉/悬浮，并在近远景衔接处露缝。
    // 世界尺度的细节层次由 shader 里的 uTerrainCenter 负责，不需要移动网格。
    this.materials.forEach((m) => {
      m.uniforms.uTime.value = time;
      m.uniforms.uTerrainCenter.value.copy(camera.position);
    });
  }

  get waterLevel() {
    return this.def.waterLevel ?? -3.2;
  }
}


