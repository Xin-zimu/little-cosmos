// 程序化天空穹顶：高空渐变 + 太阳盘 + 云带 + 星球特有元素（极光 / 巨大行星 / 沙暴）
import * as THREE from 'three';

export const skyVert = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  // 天空穹顶绑定在相机位置，半径为 1，直接输出 NDC 方向 —— 不依赖相机远平面
  vec4 mv = viewMatrix * vec4(cameraPosition + position * 5000.0, 1.0);
  gl_Position = projectionMatrix * mv;
}
`;

export const skyFrag = /* glsl */ `
precision highp float;
varying vec3 vDir;
uniform vec3 uZenith, uHorizon, uGlow, uGround, uSunDir, uSunColor;
uniform float uTime, uKind;      // kind: 0 verdant, 1 emer, 2 lumina
uniform float uStorm;            // 0..1 沙尘暴强度
uniform vec3 uAuroraColor, uAuroraColor2;
uniform vec3 uPlanetDir, uPlanetColor;
uniform float uCloudCover;

// ---- 噪声 ----
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + 11.7; a *= 0.5; }
  return s;
}

void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  float sunDot = max(dot(d, uSunDir), 0.0);

  // 基础渐变
  float t = smoothstep(-0.05, 0.55, h);
  vec3 col = mix(uHorizon, uZenith, pow(t, 0.75));
  // 地平线暖光
  float band = exp(-abs(h) * 7.0);
  col += uGlow * band * 0.10;
  // 太阳方向散射
  col += uSunColor * pow(sunDot, 6.0) * 0.10;
  col += uSunColor * pow(sunDot, 64.0) * 0.55;
  // 太阳盘
  float disc = smoothstep(0.99955, 0.99985, sunDot);
  col += uSunColor * disc * 14.0;
  // 地平线以下（远处的雾海）
  col = mix(col, uGround, smoothstep(0.0, -0.22, h));

  // 星空（高空，黄昏星球弱一些）
  float starMask = smoothstep(0.12, 0.65, h) * (uKind > 1.5 ? 1.6 : 0.35) ;
  vec2 sp = d.xz / max(abs(d.y) + 0.35, 0.2) * 60.0;
  float st = hash(floor(sp * 3.0));
  float tw = 0.6 + 0.4 * sin(uTime * 2.0 + st * 40.0);
  if (st > 0.995) col += vec3(0.85, 0.9, 1.0) * starMask * tw * 1.2;

  // 云带
  if (h > -0.02) {
    vec2 cp = d.xz / (h + 0.25) * 1.3 + vec2(uTime * 0.006, uTime * 0.003);
    float cl = fbm(cp * 1.6);
    cl = smoothstep(0.52, 0.95, cl + (1.0 - uCloudCover) * 0.5);
    cl *= smoothstep(-0.02, 0.25, h);
    vec3 cloudCol = mix(uHorizon * 1.25, uGlow * 1.1, 0.4) + uSunColor * pow(sunDot, 3.0) * 0.35;
    col = mix(col, cloudCol, cl * 0.55);
  }

  // 星球特有：
  if (uKind > 0.5 && uKind < 1.5) {
    // EMER：沙尘层与热浪
    float dust = fbm(d.xz / (h + 0.3) * 2.0 + vec2(uTime * 0.02, 0.0));
    float dustBand = exp(-abs(h - 0.02) * 5.5);
    col = mix(col, vec3(0.85, 0.46, 0.24) * 0.9, dust * dustBand * (0.25 + uStorm * 0.7));
  }
  if (uKind > 1.5) {
    // LUMINA：极光 + 巨大行星投影
    // 极光：竖直帘幕状，带流动的波纹
    float ang = atan(d.z, d.x);
    float curtain = fbm(vec2(ang * 3.2 + uTime * 0.012, d.y * 2.6 - uTime * 0.02));
    float curtain2 = fbm(vec2(ang * 7.5 - uTime * 0.02, d.y * 5.0));
    float aurBand = smoothstep(0.0, 0.30, h) * smoothstep(0.92, 0.42, h);
    float aurora = pow(smoothstep(0.42, 0.92, curtain * 0.7 + curtain2 * 0.45), 1.7) * aurBand;
    float wave = sin(ang * 9.0 + uTime * 0.28 + curtain * 7.0) * 0.5 + 0.5;
    vec3 aurCol = mix(uAuroraColor, uAuroraColor2, wave);
    col += aurCol * aurora * (0.30 + 0.55 * wave) * 1.15;

    // 巨大行星：屏幕方向的球体投影
    float pd = dot(d, uPlanetDir);
    float pr = 0.34;
    float ca = acos(clamp(pd, -1.0, 1.0));
    if (ca < pr) {
      // 局部平面坐标用于条纹
      vec3 right = normalize(cross(uPlanetDir, vec3(0, 1, 0)));
      vec3 upv = cross(right, uPlanetDir);
      vec2 lp = vec2(dot(d, right), dot(d, upv)) / pr;
      float rr = length(lp);
      float band2 = fbm(vec2(lp.y * 4.5, lp.x * 1.2) + 3.0);
      float band3 = fbm(vec2(lp.y * 11.0, lp.x * 2.0));
      vec3 pc = mix(uPlanetColor * 0.42, uPlanetColor * 0.95, smoothstep(0.3, 0.75, band2));
      pc = mix(pc, uPlanetColor * 1.25, smoothstep(0.55, 0.8, band3) * 0.35);
      // 球面明暗（左上方受光）
      vec2 sunp = normalize(vec2(-0.62, 0.58));
      float sph = sqrt(max(0.0, 1.0 - rr * rr));
      float lit = smoothstep(-0.15, 0.9, dot(normalize(lp + vec2(0.0001)), sunp) * 0.55 + sph * 0.8);
      pc *= 0.10 + 1.05 * lit;
      // 边缘大气辉光
      float rim = smoothstep(0.72, 1.0, rr);
      pc += uPlanetColor * rim * 0.55 * (0.4 + lit * 0.6);
      float mask = smoothstep(1.0, 0.94, rr);
      col = mix(col, pc, mask * 0.96);
    }
    col += uPlanetColor * pow(max(pd, 0.0), 40.0) * 0.10;
  }

  gl_FragColor = vec4(col, 1.0);
}
`;

export function createSkyMaterial(palette) {
  const kind = palette.id === 'verdant' ? 0 : palette.id === 'emer' ? 1 : 2;
  const mat = new THREE.ShaderMaterial({
    vertexShader: skyVert,
    fragmentShader: skyFrag,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    uniforms: {
      uZenith: { value: new THREE.Color().setRGB(...palette.skyZenith) },
      uHorizon: { value: new THREE.Color().setRGB(...palette.skyHorizon) },
      uGlow: { value: new THREE.Color().setRGB(...palette.skyGlow) },
      uGround: { value: new THREE.Color().setRGB(...palette.skyGround) },
      uSunDir: { value: new THREE.Vector3(...palette.sunDir).normalize() },
      uSunColor: { value: new THREE.Color().setRGB(...palette.sunColor) },
      uTime: { value: 0 },
      uKind: { value: kind },
      uStorm: { value: 0 },
      uAuroraColor: { value: new THREE.Color().setRGB(0.22, 0.85, 0.75) },
      uAuroraColor2: { value: new THREE.Color().setRGB(0.45, 0.42, 1.05) },
      // 朝向 LUMINA 出生点默认视线方向，让巨大行星一进入游戏就能看见（悬在地平线上方）
      uPlanetDir: { value: new THREE.Vector3(0.549, 0.331, -0.767).normalize() },
      uPlanetColor: { value: new THREE.Color().setRGB(0.52, 0.40, 0.78) },
      uCloudCover: { value: kind === 1 ? 0.15 : kind === 2 ? 0.5 : 0.6 },
    },
  });
  mat.userData.kind = kind;
  return mat;
}

export function createSky(palette) {
  const geo = new THREE.SphereGeometry(1, 32, 20);
  const mat = createSkyMaterial(palette);
  const mesh = new THREE.Mesh(geo, mat);
  // BUG-29：天空穹顶是纯视觉层，不阻挡弹道
  mesh.userData.noBlock = true;
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  mesh.scale.setScalar(1000);
  mesh.name = 'sky';
  return mesh;
}
