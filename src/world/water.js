// 水面：两层流动法线 + 菲涅尔反射 + 太阳高光 + 浅水透明
import * as THREE from 'three';

const WVERT = /* glsl */ `
varying vec3 vW;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const WFRAG = /* glsl */ `
precision highp float;
uniform vec3 uSunDir, uSunColor, uDeep, uShallow, uSky, uFogColor;
uniform float uTime, uFogDensity, uKind;
varying vec3 vW;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.1 + 3.1; a *= 0.5; } return s; }
void main() {
  vec2 p = vW.xz;
  float t = uTime;
  float h1 = fbm(p * 0.35 + vec2(t * 0.06, t * 0.04));
  float h2 = fbm(p * 0.9 - vec2(t * 0.09, -t * 0.05));
  float h3 = fbm(p * 2.6 + vec2(-t * 0.12, t * 0.1));
  float wave = h1 * 0.5 + h2 * 0.32 + h3 * 0.16;
  // 法线（差分）
  vec2 e = vec2(0.15, 0.0);
  float hx = fbm((p + e.xy) * 0.9 - vec2(t * 0.09, -t * 0.05)) - fbm((p - e.xy) * 0.9 - vec2(t * 0.09, -t * 0.05));
  float hz = fbm((p + e.yx) * 0.9 - vec2(t * 0.09, -t * 0.05)) - fbm((p - e.yx) * 0.9 - vec2(t * 0.09, -t * 0.05));
  vec3 N = normalize(vec3(-hx * 1.6, 1.0, -hz * 1.6));
  // 发光星球的水面微光
  if (uKind > 1.5) {
    float gl = smoothstep(0.72, 0.9, fbm(p * 0.22 + vec2(t * 0.02, -t * 0.03)));
    N = normalize(N);
    vec3 V0 = normalize(cameraPosition - vW);
    float fres0 = pow(1.0 - max(dot(N, V0), 0.0), 3.0);
    vec3 glow = uShallow * 3.5 * gl * fres0;
    vec3 V = normalize(cameraPosition - vW);
    vec3 H = normalize(V + uSunDir);
    float spec = pow(max(dot(N, H), 0.0), 900.0) * 30.0;
    float fres = fres0;
    vec3 col = mix(uDeep, uSky, fres * 0.65) + uSunColor * spec + glow;
    float dist = length(cameraPosition - vW);
    col = mix(col, uFogColor, 1.0 - exp(-pow(dist * uFogDensity, 1.6)));
    gl_FragColor = vec4(col, mix(0.82, 0.96, fres));
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    return;
  }
  vec3 V = normalize(cameraPosition - vW);
  vec3 H = normalize(V + uSunDir);
  float fres = pow(1.0 - max(dot(N, V), 0.0), 4.0);
  fres = mix(0.03, 1.0, fres);
  float spec = pow(max(dot(N, H), 0.0), 700.0) * 26.0;
  // 细碎波光
  float sparkle = step(0.985, fbm(p * 7.0 + t * 0.4));
  vec3 col = mix(uDeep, uShallow, wave * 0.45);
  col = mix(col, uSky, fres * 0.92);
  col += uSunColor * (spec + sparkle * 0.15 * fres);
  float dist = length(cameraPosition - vW);
  vec3 fogc = uFogColor;
  col = mix(col, fogc, 1.0 - exp(-pow(dist * uFogDensity, 1.6)));
  gl_FragColor = vec4(col, mix(0.86, 0.98, fres));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export function createWater(palette, level, kind) {
  const geo = new THREE.PlaneGeometry(1300, 1300, 1, 1);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.ShaderMaterial({
    vertexShader: WVERT,
    fragmentShader: WFRAG,
    transparent: true,
    depthWrite: false,
    uniforms: {
      uSunDir: { value: new THREE.Vector3(...palette.sunDir).normalize() },
      uSunColor: { value: new THREE.Color().setRGB(...palette.sunColor).multiplyScalar(0.8) },
      uDeep: { value: new THREE.Color().setRGB(...palette.waterColor) },
      uShallow: { value: new THREE.Color().setRGB(palette.waterColor[0] * 3 + 0.02, palette.waterColor[1] * 3 + 0.04, palette.waterColor[2] * 3 + 0.03) },
      uSky: { value: new THREE.Color().setRGB(...palette.skyHorizon).multiplyScalar(0.75) },
      uFogColor: { value: new THREE.Color().setRGB(...palette.fogColor) },
      uFogDensity: { value: palette.fogDensity },
      uTime: { value: 0 },
      uKind: { value: kind },
    },
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = level;
  mesh.renderOrder = 2;
  mesh.name = 'water';
  return mesh;
}
