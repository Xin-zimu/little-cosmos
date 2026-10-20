// 粒子系统：漂浮孢子 / 种子 / 沙尘 / 光尘（GPU 端随时间流动，CPU 开销极低）
import * as THREE from 'three';

const PVERT = /* glsl */ `
attribute float aSeed;
attribute float aSize;
uniform vec3 uCam;
uniform float uTime, uArea, uHeight, uFall, uKind, uWind;
varying float vAlpha;
varying float vSeed;
void main() {
  vec3 p = position;
  float s = aSeed * 6.2831;
  // 环绕相机的体积内环绕流动
  vec3 rel = p + vec3(
    sin(uTime * 0.21 + s) * 3.0 + uTime * uWind * 1.2,
    sin(uTime * 0.33 + s * 1.7) * 1.5 - uTime * uFall,
    cos(uTime * 0.17 + s * 2.3) * 3.0 + uTime * uWind * 0.6
  );
  float hh = uArea * 0.5;
  rel.x = mod(rel.x + hh, uArea) - hh;
  rel.z = mod(rel.z + hh, uArea) - hh;
  rel.y = mod(rel.y + uHeight * 0.25, uHeight) - uHeight * 0.1;
  vec3 wp = uCam + rel;
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  float dist = -mv.z;
  vAlpha = smoothstep(uArea * 0.5, uArea * 0.18, length(rel.xz)) * smoothstep(2.0, 12.0, dist);
  vSeed = aSeed;
  gl_PointSize = clamp(aSize * (90.0 / max(dist, 0.5)), 0.6, 7.0) * (uKind > 1.5 ? 1.3 : 1.0);
  gl_Position = projectionMatrix * mv;
}
`;

const PFRAG = /* glsl */ `
precision highp float;
uniform vec3 uColor, uColor2;
uniform float uTime, uOpacity, uFogDensity;
varying float vAlpha;
varying float vSeed;
void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float d = length(uv);
  if (d > 0.5) discard;
  float a = smoothstep(0.5, 0.0, d);
  a *= a;
  float tw = 0.65 + 0.35 * sin(uTime * (1.5 + vSeed * 3.0) + vSeed * 40.0);
  vec3 col = mix(uColor, uColor2, vSeed);
  float fog = 1.0 - exp(-pow(14.0 * uFogDensity, 1.6));
  gl_FragColor = vec4(col * (0.7 + 0.6 * tw), a * vAlpha * uOpacity * (1.0 - fog * 0.7));
}
`;

export function createParticles(palette, count = 1400, opts = {}) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3);
  const seed = new Float32Array(count);
  const size = new Float32Array(count);
  const area = opts.area || 90;
  const height = opts.height || 26;
  for (let i = 0; i < count; i++) {
    pos[i * 3] = (Math.random() - 0.5) * area;
    pos[i * 3 + 1] = Math.random() * height - 2;
    pos[i * 3 + 2] = (Math.random() - 0.5) * area;
    seed[i] = Math.random();
    size[i] = (opts.size || 0.6) * (0.25 + Math.random() * 1.0);
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

  const isNight = palette.id === 'lumina';
  const mat = new THREE.ShaderMaterial({
    vertexShader: PVERT,
    fragmentShader: PFRAG,
    transparent: true,
    depthWrite: false,
    blending: opts.additive || isNight ? THREE.AdditiveBlending : THREE.NormalBlending,
    uniforms: {
      uCam: { value: new THREE.Vector3() },
      uTime: { value: 0 },
      uArea: { value: area },
      uHeight: { value: height },
      uFall: { value: opts.fall ?? 0.25 },
      uKind: { value: palette.id === 'lumina' ? 2 : palette.id === 'emer' ? 1 : 0 },
      uWind: { value: palette.weather.wind },
      uColor: { value: new THREE.Color(opts.color || palette.accent) },
      uColor2: { value: new THREE.Color(opts.color2 || palette.accent2) },
      uOpacity: { value: opts.opacity ?? 0.5 },
      uFogDensity: { value: palette.fogDensity },
    },
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = 5;
  points.userData.update = (camera, time) => {
    mat.uniforms.uTime.value = time;
    mat.uniforms.uCam.value.copy(camera.position);
  };
  return points;
}

export function createDustPlume() {
  // 起飞扬尘：在世界坐标发射的粒子（由 CPU 更新）
  const count = 600;
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3);
  const life = new Float32Array(count).fill(1);
  const vel = new Float32Array(count * 3);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aLife', new THREE.BufferAttribute(life, 1));
  const mat = new THREE.ShaderMaterial({
    vertexShader: /* glsl */ `
      attribute float aLife; varying float vL; uniform float uSize;
      void main() {
        vL = aLife;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = uSize * (1.0 + (1.0 - aLife) * 2.6) * (260.0 / max(-mv.z, 0.5));
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      precision highp float; varying float vL; uniform vec3 uColor;
      void main() {
        vec2 uv = gl_PointCoord - 0.5; float d = length(uv); if (d > 0.5) discard;
        float a = smoothstep(0.5, 0.05, d) * vL * 0.55;
        gl_FragColor = vec4(uColor, a);
      }`,
    transparent: true,
    depthWrite: false,
    uniforms: { uColor: { value: new THREE.Color('#c9bfae') }, uSize: { value: 1.6 } },
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.userData.emit = (center, radius, upward) => {
    for (let i = 0; i < count; i++) {
      if (life[i] > 0.0) continue;
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * radius;
      pos[i * 3] = center.x + Math.cos(a) * r;
      pos[i * 3 + 1] = center.y + Math.random() * 1.5;
      pos[i * 3 + 2] = center.z + Math.sin(a) * r;
      vel[i * 3] = Math.cos(a) * (2 + Math.random() * 5);
      vel[i * 3 + 1] = upward * (1 + Math.random() * 3);
      vel[i * 3 + 2] = Math.sin(a) * (2 + Math.random() * 5);
      life[i] = 1;
    }
    points.visible = true;
  };
  points.userData.step = (dt) => {
    let any = false;
    for (let i = 0; i < count; i++) {
      if (life[i] <= 0) continue;
      any = true;
      life[i] -= dt * 0.35;
      pos[i * 3] += vel[i * 3] * dt;
      pos[i * 3 + 1] += vel[i * 3 + 1] * dt;
      pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
      vel[i * 3] *= 1 - dt * 0.9; vel[i * 3 + 1] *= 1 - dt * 0.6; vel[i * 3 + 2] *= 1 - dt * 0.9;
      if (life[i] <= 0) life[i] = 0;
    }
    if (!any) points.visible = false;
    geo.attributes.position.needsUpdate = true;
    geo.attributes.aLife.needsUpdate = true;
  };
  return points;
}

