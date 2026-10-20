// 太空：星系坐标、三颗程序化行星（含大气辉光、云层、环）、星空、恒星、星云
import * as THREE from 'three';
import { PALETTES, PLANET_ORDER } from '../world/themes.js';
import { createNoise, smoothstep } from '../core/noise.js';

export const PLANET_R = { verdant: 300, emer: 260, lumina: 280 };
export const PLANET_POS = {
  verdant: new THREE.Vector3(0, 0, 0),
  emer: new THREE.Vector3(1900, 320, -1100),
  lumina: new THREE.Vector3(-1500, -260, 1300),
};
export const SUN_POS = new THREE.Vector3(15500, 3600, 6200);

const PLANET_VERT = /* glsl */ `
varying vec3 vN, vP, vW;
void main() {
  // 世界空间法线：uSunDir 也是世界空间，两者必须同空间才能得到正确的明暗终止线
  vN = normalize(mat3(modelMatrix) * normal);
  vP = position;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
const PLANET_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uSunDir, uBaseA, uBaseB, uBaseC, uAtmo, uSunColor, uLandA, uLandB;
uniform float uTime, uKind, uSea, uNearFade;
varying vec3 vN, vP, vW;

float hash(vec3 p){ p = fract(p*0.3183099+.1); p *= 17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
float vn3(vec3 x){ vec3 i=floor(x), f=fract(x); f=f*f*(3.0-2.0*f);
  return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z); }
float fbm3(vec3 p){ float s=0.0,a=0.5; for(int i=0;i<5;i++){ s+=a*vn3(p); p=p*2.03+vec3(1.7,9.2,3.1); a*=0.5; } return s; }

void main() {
  vec3 n = normalize(vP);
  vec3 N = normalize(vN);
  vec3 V = normalize(cameraPosition - vW);
  float ndl = dot(N, uSunDir);
  float lit = smoothstep(-0.18, 0.45, ndl);

  if (uKind < 0.5) {
    // VERDANT：大陆 + 海洋 + 云
    float land = fbm3(n * 2.2 + 3.0);
    float detail = fbm3(n * 9.0);
    float isLand = smoothstep(0.44, 0.50, land + detail * 0.06);
    // 海：深青绿；陆：暖橄榄到浅草色
    vec3 seaCol = mix(uBaseA * 0.30, uBaseA * 0.70, smoothstep(0.25, 0.60, detail));
    vec3 landCol = mix(uLandA * 0.85, uLandB, smoothstep(0.42, 0.70, detail));
    landCol = mix(landCol, uBaseC * 0.72, smoothstep(0.60, 0.80, land) * 0.5);
    vec3 surf = mix(seaCol, landCol, isLand);
    // 海岸线更亮（浅滩）
    float coast = smoothstep(0.40, 0.46, land) * (1.0 - smoothstep(0.46, 0.52, land));
    surf += uBaseC * coast * 0.12;
    // 云：只留稀疏云带
    float cloud = smoothstep(0.66, 0.88, fbm3(n * 3.4 + vec3(uTime * 0.004, 0.0, 0.0)));
    cloud *= 0.6;
    surf = mix(surf, vec3(0.72, 0.78, 0.80), cloud * 0.55);
    surf *= 0.72 + 0.46 * detail;
    vec3 col = surf * (uSunColor * (max(ndl, 0.0) * 0.85 + 0.10) + vec3(0.05, 0.07, 0.09));
    float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0);
    col += uAtmo * rim * (0.35 + lit) * 1.05;
    gl_FragColor = vec4(col, 1.0);
  } else if (uKind < 1.5) {
    // EMER：沙海 + 岩带
    float b1 = fbm3(vec3(n.x * 3.0, n.y * 9.0, n.z * 3.0));
    float b2 = fbm3(n * 6.0);
    vec3 surf = mix(uLandA, uLandB, smoothstep(0.3, 0.7, b1));
    surf = mix(surf, uLandA * 0.6, smoothstep(0.62, 0.75, b2));
    float ice = smoothstep(0.86, 0.95, abs(n.y));
    surf = mix(surf, vec3(0.85, 0.82, 0.75), ice * 0.6);
    vec3 col = surf * (uSunColor * max(ndl, 0.0) * 0.58 + vec3(0.06, 0.04, 0.03));
    float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0);
    col += uAtmo * rim * (0.5 + lit) * 1.2;
    gl_FragColor = vec4(col, 1.0);
  } else {
    // LUMINA：深蓝海洋 + 发光脉络 + 极光带
    float sea = fbm3(n * 2.6 + 8.0);
    float deep = fbm3(n * 5.5 + 1.3);
    vec3 surf = mix(uBaseA * 0.55, uBaseB * 1.15, smoothstep(0.30, 0.78, sea));
    // 陆块：更亮的荧光大陆
    float landM = smoothstep(0.54, 0.61, sea);
    surf = mix(surf, uBaseC * 0.55 + uAtmo * 0.35, landM * 0.7);
    // 发光脉络
    float veinN = fbm3(n * 7.5 + vec3(sin(uTime * 0.1) * 0.3));
    float vein = smoothstep(0.585, 0.625, veinN);
    surf += uAtmo * vein * 0.9 * (0.35 + 0.65 * landM);
    // 极冠
    float pole = smoothstep(0.74, 0.96, abs(n.y));
    surf += uAtmo * pole * 0.30 * (0.6 + 0.4 * sin(n.x * 18.0 + uTime * 0.5));
    vec3 col = surf * (uSunColor * max(ndl, 0.0) * 0.85 + vec3(0.05, 0.08, 0.15));
    float rim = pow(1.0 - max(dot(N, V), 0.0), 2.6);
    col += uAtmo * rim * (0.5 + lit) * 1.35;
    gl_FragColor = vec4(col, 1.0);
  }
  // 贴近行星表面时，表面细节被大气吞没（避免过曝与穿帮）
  float nearK = 1.0 - uNearFade;
  vec3 atmoHaze = uAtmo * 0.9 + uSunColor * 0.10;
  gl_FragColor.rgb = mix(gl_FragColor.rgb, atmoHaze, clamp(nearK * 1.15, 0.0, 1.0));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const ATMO_VERT = /* glsl */ `
varying vec3 vN, vW, vP;
void main() {
  vN = normalize(mat3(modelMatrix) * normal);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xyz; vP = position;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
const ATMO_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uColor, uSunDir;
uniform float uAlt, uR;
varying vec3 vN, vW, vP;
void main() {
  vec3 N = normalize(vN);
  vec3 V = normalize(cameraPosition - vW);
  float rim = pow(1.0 - abs(dot(N, V)), 2.6);
  float ndl = dot(normalize(vP), uSunDir);
  float lit = smoothstep(-0.35, 0.5, ndl);
  // 前向散射：太阳在背后时更亮
  float fwd = pow(max(dot(-V, -uSunDir), 0.0), 4.0);
  float a = rim * (0.25 + lit * 0.8 + fwd * 0.9);
  // 相机贴近行星时淡出，避免整屏泛白
  float near = smoothstep(0.01, 0.42, uAlt / uR);
  a *= near;
  gl_FragColor = vec4(uColor * a * 1.5, a * 0.85);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const NEBULA_FRAG = /* glsl */ `
precision highp float;
varying vec3 vDir;
uniform float uTime;
uniform vec3 uColorA, uColorB, uColorC;
float hash(vec3 p){ p = fract(p*0.3183099+.1); p *= 17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
float vn3(vec3 x){ vec3 i=floor(x), f=fract(x); f=f*f*(3.0-2.0*f);
  return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z); }
float fbm3(vec3 p){ float s=0.0,a=0.5; for(int i=0;i<6;i++){ s+=a*vn3(p); p=p*2.07+vec3(3.1,1.7,5.3); a*=0.5; } return s; }
void main() {
  vec3 d = normalize(vDir);
  float band = exp(-pow((d.y * 1.6 + d.x * 0.5), 2.0) * 1.2);
  float n1 = fbm3(d * 3.2 + vec3(0.0, 0.0, uTime * 0.002));
  float n2 = fbm3(d * 6.5 + vec3(4.0, 2.0, 0.0));
  float clouds = smoothstep(0.38, 0.85, n1) * band;
  vec3 col = mix(uColorA, uColorB, smoothstep(0.3, 0.9, n2)) * clouds * 0.5;
  col += uColorC * smoothstep(0.55, 1.0, n2) * band * 0.25;
  // 颗粒星云中的亮核
  col += uColorB * pow(smoothstep(0.7, 1.0, n1), 3.0) * 0.4;
  gl_FragColor = vec4(col, 1.0);
}
`;

function makeStarfield(count = 9000) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const size = new Float32Array(count);
  const nz = createNoise(77);
  for (let i = 0; i < count; i++) {
    // 球面均匀分布
    const u = Math.random() * 2 - 1;
    const th = Math.random() * Math.PI * 2;
    const r = Math.sqrt(1 - u * u);
    const R = 9000 + Math.random() * 2000;
    pos[i * 3] = Math.cos(th) * r * R;
    pos[i * 3 + 1] = u * R;
    pos[i * 3 + 2] = Math.sin(th) * r * R;
    // 恒星颜色：偏蓝白 / 暖黄
    const c = Math.random();
    const tint = c < 0.2 ? [0.72, 0.82, 1.0] : c < 0.75 ? [1.0, 0.98, 0.94] : [1.0, 0.82, 0.62];
    const b = 0.4 + Math.pow(Math.random(), 3) * 1.6;
    col[i * 3] = tint[0] * b; col[i * 3 + 1] = tint[1] * b; col[i * 3 + 2] = tint[2] * b;
    size[i] = 1.2 + Math.pow(Math.random(), 6) * 6;
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  const mat = new THREE.ShaderMaterial({
    vertexShader: /* glsl */ `
      attribute vec3 aColor; attribute float aSize; varying vec3 vC;
      void main(){ vC = aColor; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_PointSize = aSize; gl_Position = projectionMatrix * mv; }`,
    fragmentShader: /* glsl */ `
      precision highp float; varying vec3 vC;
      void main(){ vec2 uv = gl_PointCoord - 0.5; float d = length(uv); float a = smoothstep(0.5, 0.0, d); gl_FragColor = vec4(vC * a, a); }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  return pts;
}

export class SpaceSystem {
  constructor(game) {
    this.game = game;
    this.group = new THREE.Group();
    this.group.name = 'space';
    this.build();
  }

  build() {
    const scene = this.game.scene;
    // 星空（始终挂在场景上，地面时隐藏在天空之下）
    this.stars = makeStarfield(9000);
    this.sceneAdd(this.stars);

    // 星云
    const nebGeo = new THREE.SphereGeometry(14000, 48, 32);
    const nebMat = new THREE.ShaderMaterial({
      vertexShader: /* glsl */ `varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: NEBULA_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uColorA: { value: new THREE.Color(0.08, 0.05, 0.22) },
        uColorB: { value: new THREE.Color(0.20, 0.35, 0.72) },
        uColorC: { value: new THREE.Color(0.55, 0.22, 0.45) },
      },
    });
    this.nebula = new THREE.Mesh(nebGeo, nebMat);
    this.nebula.frustumCulled = false;
    this.sceneAdd(this.nebula);

    // 恒星（太阳）——放得很远，只作为天空中的一个亮盘
    this.sun = new THREE.Mesh(
      new THREE.SphereGeometry(620, 32, 24),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.88, 0.68).multiplyScalar(2.6) })
    );
    this.sun.position.copy(SUN_POS);
    this.sceneAdd(this.sun);
    // 日冕
    const coronaMat = new THREE.ShaderMaterial({
      vertexShader: ATMO_VERT,
      fragmentShader: /* glsl */ `
        precision highp float; varying vec3 vN, vW, vP;
        void main(){ vec3 N = normalize(vN); vec3 V = normalize(cameraPosition - vW); float r = pow(1.0 - abs(dot(N,V)), 3.0); gl_FragColor = vec4(vec3(1.0,0.8,0.5) * r * 1.2, r * 0.75); }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const corona = new THREE.Mesh(new THREE.SphereGeometry(1250, 32, 24), coronaMat);
    corona.position.copy(SUN_POS);
    this.sceneAdd(corona);

    // 行星
    this.planets = {};
    const nz = createNoise(31);
    for (const id of PLANET_ORDER) {
      const pal = PALETTES[id];
      const R = PLANET_R[id];
      const geo = new THREE.SphereGeometry(R, 96, 64);
      // 轻微位移造形
      const pa = geo.attributes.position;
      for (let i = 0; i < pa.count; i++) {
        const x = pa.getX(i), y = pa.getY(i), z = pa.getZ(i);
        const n = nz.noise3(x * 0.01, y * 0.01, z * 0.01);
        const k = 1 + n * 0.004;
        pa.setXYZ(i, x * k, y * k, z * k);
      }
      geo.computeVertexNormals();
      const isVerdant = id === 'verdant';
      const isEmer = id === 'emer';
      const mat = new THREE.ShaderMaterial({
        vertexShader: PLANET_VERT,
        fragmentShader: PLANET_FRAG,
        uniforms: {
          uSunDir: { value: new THREE.Vector3() },
          uSunColor: { value: new THREE.Color(1.0, 0.95, 0.86) },
          uBaseA: { value: new THREE.Color().setRGB(...pal.plant.grassA).multiplyScalar(isVerdant ? 0.55 : 1) },
          uBaseB: { value: new THREE.Color().setRGB(...pal.plant.grassB) },
          uBaseC: { value: new THREE.Color().setRGB(...pal.plant.grassTip) },
          uLandA: { value: new THREE.Color().setRGB(isVerdant ? 0.20 : 0.62, isVerdant ? 0.30 : 0.30, isVerdant ? 0.10 : 0.14) },
          uLandB: { value: new THREE.Color().setRGB(isVerdant ? 0.40 : 0.78, isVerdant ? 0.38 : 0.48, isVerdant ? 0.16 : 0.26) },
          uAtmo: { value: new THREE.Color().setRGB(...pal.fogColor) },
          uTime: { value: 0 },
          uKind: { value: isVerdant ? 0 : isEmer ? 1 : 2 },
          uSea: { value: isVerdant ? 0.2 : 0 },
          uNearFade: { value: 1 },
        },
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(PLANET_POS[id]);
      mesh.rotation.z = Math.random() * 0.4;
      this.sceneAdd(mesh);
      // 大气辉光
      const atmoMat = new THREE.ShaderMaterial({
        vertexShader: ATMO_VERT,
        fragmentShader: ATMO_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.BackSide,
        uniforms: {
          uColor: { value: new THREE.Color().setRGB(...pal.fogColor).multiplyScalar(1.4) },
          uSunDir: { value: new THREE.Vector3(0.6, 0.3, 0.2).normalize() },
          uAlt: { value: 1000 },
          uR: { value: R },
        },
      });
      const atmo = new THREE.Mesh(new THREE.SphereGeometry(R * 1.09, 64, 48), atmoMat);
      atmo.position.copy(mesh.position);
      this.sceneAdd(atmo);
      // 环（LUMINA）
      let ring = null;
      if (id === 'lumina') {
        const rg = new THREE.RingGeometry(R * 1.32, R * 1.62, 128, 1);
        const rm = new THREE.ShaderMaterial({
          vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);} `,
          fragmentShader: /* glsl */ `
            precision highp float; varying vec2 vUv;
            float hash21(vec2 p){ return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
            void main(){
              float x = vUv.x;
              float a = smoothstep(0.0, 0.10, x) * smoothstep(1.0, 0.86, x);
              // 多条细环带 + 不均匀亮度
              float bands = 0.35 + 0.65 * pow(0.5 + 0.5 * sin(x * 210.0), 1.5);
              bands *= 0.55 + 0.45 * (0.5 + 0.5 * sin(x * 37.0 + 1.7));
              bands *= 0.7 + 0.3 * hash21(vec2(floor(x * 90.0), 1.0));
              gl_FragColor = vec4(vec3(0.46, 0.58, 0.80) * (0.6 + bands * 0.8), a * bands * 0.34);
            }`,
          transparent: true, depthWrite: false, side: THREE.DoubleSide,
        });
        ring = new THREE.Mesh(rg, rm);
        ring.position.copy(mesh.position);
        ring.rotation.x = Math.PI / 2.25;
        this.sceneAdd(ring);
      }
      this.planets[id] = { mesh, atmo, ring, mat, atmoMat, R };
    }
    // 小卫星（VERDANT 可见）
    this.moon = new THREE.Mesh(
      new THREE.SphereGeometry(40, 32, 24),
      new THREE.MeshStandardMaterial({ color: new THREE.Color('#9a958c'), roughness: 1.0 })
    );
    this.moon.position.set(1400, 500, 900);
    this.sceneAdd(this.moon);
    this.sunLight = new THREE.DirectionalLight(new THREE.Color(1.0, 0.95, 0.86), 2.6);
    this.sunLight.position.copy(SUN_POS).normalize().multiplyScalar(1000);
    this.sunLight.target.position.set(0, 0, 0);
    this.sceneAdd(this.sunLight);
    this.sunLight.castShadow = false;
    this.sceneAdd(this.sunLight.target);
    this.ambient = new THREE.AmbientLight(new THREE.Color(0.12, 0.14, 0.22), 0.6);
    this.sceneAdd(this.ambient);
    this.origin = new THREE.Vector3();
  }

  sceneAdd(obj) {
    this.group.add(obj);
    this.game.scene.add(this.group);
  }

  setVisible(v) {
    this.group.visible = v;
    this.stars.visible = v;
    this.nebula.visible = v;
  }

  // 相机在太空中时：星空与星云跟随相机
  follow(camera, time) {
    this.stars.position.copy(camera.position);
    this.nebula.position.copy(camera.position);
    this.nebula.material.uniforms.uTime.value = time;
    for (const id of PLANET_ORDER) {
      const p = this.planets[id];
      p.mat.uniforms.uTime.value = time;
      p.mat.uniforms.uSunDir.value.copy(SUN_POS).sub(p.mesh.position).normalize();
      p.atmoMat.uniforms.uSunDir.value.copy(SUN_POS).sub(p.mesh.position).normalize();
      // 相机贴近时淡出大气辉光与行星本体
      const d = camera.position.distanceTo(p.mesh.position);
      const alt = Math.max(0, d - p.R);
      p.atmoMat.uniforms.uAlt.value = alt;
      p.mat.uniforms.uNearFade.value = smoothstep(p.R * 0.98, p.R * 1.4, d);
      if (p.atmo) p.atmo.visible = alt > p.R * 0.02;
      if (p.ring) p.ring.rotation.z = time * 0.01;
    }
    this.moon.position.set(1400 + Math.cos(time * 0.02) * 200, 520, 900 + Math.sin(time * 0.02) * 200);
  }
}
