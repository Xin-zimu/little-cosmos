// 渲染引擎：WebGL2 渲染器 + 电影级后期（ACES 色调映射 / 泛光 / 调色 / 暗角 / 胶片颗粒 / 色散）
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

const VignetteGradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uVignette: { value: 1.0 },
    uGrain: { value: 0.035 },
    uAberration: { value: 0.0012 },
    uLift: { value: new THREE.Color(0.0, 0.0, 0.0) },
    uGain: { value: new THREE.Color(1.0, 1.0, 1.0) },
    uSaturation: { value: 1.05 },
    uContrast: { value: 1.04 },
    uDamage: { value: 0 },
    uSpeed: { value: 0 },
    uFade: { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform float uTime, uVignette, uGrain, uAberration, uSaturation, uContrast, uDamage, uSpeed, uFade;
    uniform vec3 uLift, uGain;
    uniform vec2 uResolution;
    varying vec2 vUv;
    float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
    void main(){
      vec2 uv = vUv;
      vec2 d = uv - 0.5;
      float r2 = dot(d,d);
      // 运动速度感：径向色散 + 轻微拉伸模糊
      float ab = uAberration * (1.0 + uSpeed * 2.6);
      vec3 col;
      col.r = texture2D(tDiffuse, uv + d * ab * 0.6).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - d * ab * 0.6).b;
      if (uSpeed > 0.01) {
        vec3 blur = col * 0.6;
        for (int i = 1; i <= 4; i++) {
          float k = float(i) * 0.004 * uSpeed;
          blur += texture2D(tDiffuse, uv - d * k).rgb * 0.1;
          blur += texture2D(tDiffuse, uv + d * k * 0.5).rgb * 0.05;
        }
        col = mix(col, blur, clamp(uSpeed * 0.55, 0.0, 0.7));
      }
      // 分级：lift / gain / 对比 / 饱和
      col = col * uGain + uLift;
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(l), col, uSaturation);
      col = (col - 0.5) * uContrast + 0.5;
      // 暗角
      float vig = smoothstep(0.95, 0.25, length(d * vec2(1.02, 1.0)));
      col *= mix(1.0, vig, 0.55 * uVignette);
      // 受伤：边缘血色
      if (uDamage > 0.001) {
        float edge = smoothstep(0.25, 0.75, length(d));
        col = mix(col, vec3(0.55, 0.03, 0.02), edge * uDamage * 0.55);
      }
      // 胶片颗粒
      float g = hash12(uv * uResolution + fract(uTime) * 100.0);
      col += (g - 0.5) * uGrain;
      // 淡入淡出
      col = mix(col, vec3(0.0), uFade);
      gl_FragColor = vec4(col, 1.0);
    }`,
};

export class Engine {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.quality = opts.quality || 'high';
    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: 'high-performance',
      alpha: false,
      stencil: false,
    });
    // 抗锯齿策略：不用 MSAA 的 HDR 目标（驱动上会让泛光读取到损坏数据），
    // 改为超采样：绘制缓冲放大 1.4 倍，最后由浏览器线性下采样。
    this.renderer = renderer;
    this.ssaa = opts.ssaa || 1.4;
    this.applyPixelRatio();

    renderer.setSize(window.innerWidth, window.innerHeight, false);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.95;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.info.autoReset = true;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.35, 30000);
    this.camera.position.set(0, 3, 8);

    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      samples: 0,
      depthBuffer: true,
    });
    this.composer = new EffectComposer(renderer, target);
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);
    // 泛光阈值放在 HDR 线性空间里：只让真正的高光（引擎焰、发光植物、太阳）溢出，
    // 行星与天空这类大面积中高亮度不能触发，否则整屏会被泛光洗白。
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.55, 0.55, 1.15);
    this.composer.addPass(this.bloom);
    this.outputPass = new OutputPass();
    this.composer.addPass(this.outputPass);
    this.grade = new ShaderPass(VignetteGradeShader);
    this.grade.uniforms.uResolution.value.set(size.x, size.y);
    this.composer.addPass(this.grade);

    this.onResize = () => this.resize();
    window.addEventListener('resize', this.onResize);
    this.time = 0;
    this.frameTimes = [];
    this.fps = 60;
    this.autoQualityTimer = 0;
  }

  applyPixelRatio() {
    const dpr = Math.max(window.devicePixelRatio || 1, 1);
    if (this.quality === 'low') this.renderer.setPixelRatio(Math.min(dpr, 1.0));
    else this.renderer.setPixelRatio(Math.min(dpr * this.ssaa, 1.5));
  }

  setQuality(q) {
    this.quality = q;
    this.applyPixelRatio();
    if (q === 'low') {
      this.bloom.strength = 0.45;
    } else {
      this.bloom.strength = 0.55;
    }
    this.resize();
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.applyPixelRatio();
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.grade.uniforms.uResolution.value.set(size.x, size.y);
    this.bloom.setSize(size.x, size.y);
  }

  render(dt) {
    this.time += dt;
    this.grade.uniforms.uTime.value = this.time;
    this.composer.render(dt);
    // FPS
    this.frameTimes.push(dt);
    if (this.frameTimes.length > 60) this.frameTimes.shift();
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    this.fps = 1 / avg;
  }
}
