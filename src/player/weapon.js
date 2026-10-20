// 能量手枪：射线命中、能量弹道、命中迸发、后坐力与屏幕反馈
import * as THREE from 'three';
import { clamp } from '../core/noise.js';

const BEAM_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;
const BEAM_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform vec3 uColor;
uniform float uLife;
void main() {
  float edge = smoothstep(0.5, 0.0, abs(vUv.y - 0.5));
  float core = smoothstep(0.16, 0.0, abs(vUv.y - 0.5));
  vec3 c = uColor * (edge * 2.2 + core * 6.0) + vec3(1.0) * core * 2.0;
  gl_FragColor = vec4(c * uLife, 1.0);
}
`;

export class Weapon {
  constructor(game) {
    this.game = game;
    this.cooldown = 0;
    this.energy = 100;
    this.maxEnergy = 100;
    this.mode = 0; // 0 单发, 1 脉冲蓄能, 2 散射
    this.modes = ['单发', '脉冲', '散射'];
    this.heat = 0;
    this.damage = 18;
    this.range = 70;
    this.recoil = 0;
    this.beams = [];
    this.flashes = [];
    this.raycaster = new THREE.Raycaster();
    this.raycaster.far = this.range;
    this.burstTimer = 0;
    this.burstCount = 0;
    this.chargeT = 0;
    this.light = new THREE.PointLight(game.palette.accent, 0, 8, 2);
    this.buildTextures();
  }

  buildTextures() {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.25, 'rgba(255,255,255,0.55)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.12)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    this.flashTex = new THREE.CanvasTexture(c);
    this.flashTex.colorSpace = THREE.SRGBColorSpace;
  }

  switchMode() {
    this.mode = (this.mode + 1) % 3;
    this.game.ui?.toast(`射击模式：${this.modes[this.mode]}`, 'info');
    this.game.audio?.play('uiTick');
  }

  update(dt) {
    this.cooldown -= dt;
    this.recoil = Math.max(0, this.recoil - dt * 6);
    this.heat = Math.max(0, this.heat - dt * 0.35);
    this.energy = Math.min(this.maxEnergy, this.energy + dt * 14);
    // 蓄能脉冲计数
    if (this.mode === 1 && this.burstCount > 0) {
      this.burstTimer -= dt;
      if (this.burstTimer <= 0) {
        this.burstCount--;
        this.burstTimer = 0.075;
        this.fireOnce(1.0, true);
      }
    }
    // 弹道
    for (let i = this.beams.length - 1; i >= 0; i--) {
      const b = this.beams[i];
      b.life -= dt * 4.5;
      b.mesh.material.uniforms.uLife.value = Math.max(0, b.life);
      b.mesh.scale.x = 1 + (1 - b.life) * 0.5;
      if (b.life <= 0) {
        this.game.scene.remove(b.mesh);
        b.mesh.geometry.dispose();
        b.mesh.material.dispose();
        this.beams.splice(i, 1);
      }
    }
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.life -= dt * 3.5;
      f.sprite.material.opacity = Math.max(0, f.life);
      f.sprite.scale.setScalar(f.base * (1.6 - f.life * 0.6));
      if (f.life <= 0) {
        this.game.scene.remove(f.sprite);
        f.sprite.material.dispose();
        this.flashes.splice(i, 1);
      }
    }
    if (this.light.intensity > 0) this.light.intensity = Math.max(0, this.light.intensity - dt * 40);
  }

  tryFire(camera, fromPlayer) {
    if (!fromPlayer) return;
    if (this.cooldown > 0) return;
    if (this.energy < 8) {
      this.game.ui?.toast('能量不足', 'warn');
      this.game.audio?.play('uiError');
      return;
    }
    if (this.mode === 0) {
      this.cooldown = 0.22;
      this.energy -= 8;
      this.fireOnce(1.0);
    } else if (this.mode === 1) {
      this.cooldown = 0.9;
      this.energy -= 26;
      this.burstCount = 4;
      this.burstTimer = 0;
    } else {
      this.cooldown = 0.55;
      this.energy -= 16;
      for (let i = -2; i <= 2; i++) this.fireOnce(0.55, false, i * 0.032);
    }
  }

  fireOnce(mult = 1, small = false, spread = 0) {
    const game = this.game;
    const cam = game.camera;
    const dir = new THREE.Vector3();
    cam.getWorldDirection(dir);
    dir.x += spread;
    dir.y += spread * 0.4;
    dir.normalize();
    const origin = cam.position.clone();
    const muzzleWorld = new THREE.Vector3();
    const muzzle = game.player.astronaut.muzzle;
    muzzle.getWorldPosition(muzzleWorld);

    this.raycaster.set(origin, dir);
    this.raycaster.far = this.range;
    const targets = [];
    game.scene.traverse((o) => {
      if (o.isMesh && o.userData.hittable) targets.push(o);
    });
    const hits = this.raycaster.intersectObjects(targets, false);
    let end = origin.clone().addScaledVector(dir, this.range);
    let hitCreature = null;
    let hitObj = null;
    if (hits.length) {
      end = hits[0].point;
      hitObj = hits[0].object;
      const c = hitObj.userData.creature;
      if (c && !c.dead) {
        // 命中弱点判定：头部 / 背脊
        const local = hitObj.worldToLocal(hits[0].point.clone());
        const weak = hitObj.userData.weak && local.y > hitObj.userData.weakY;
        hitCreature = c;
        const killed = c.damage(this.damage * mult, hits[0].point, weak);
        game.onHitFeedback(hits[0].point, weak, killed);
      } else {
        game.onHitEnvironment(hits[0].point, hits[0].face?.normal);
      }
    }

    // 能量弹道（枪口 -> 命中点）
    const beamDir = end.clone().sub(muzzleWorld);
    const len = beamDir.length();
    const geo = new THREE.CylinderGeometry(0.012, 0.012, len, 6, 1, true);
    geo.translate(0, len / 2, 0);
    geo.rotateX(Math.PI / 2);
    const mat = new THREE.ShaderMaterial({
      vertexShader: BEAM_VERT,
      fragmentShader: BEAM_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uColor: { value: new THREE.Color(game.palette.accent) }, uLife: { value: 1 } },
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(muzzleWorld);
    mesh.lookAt(end);
    game.scene.add(mesh);
    this.beams.push({ mesh, life: 0.6 });

    // 枪口闪光
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.flashTex, color: new THREE.Color(game.palette.accent), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    sp.position.copy(muzzleWorld);
    sp.scale.setScalar(small ? 0.35 : 0.7);
    game.scene.add(sp);
    this.flashes.push({ sprite: sp, life: 1, base: small ? 0.35 : 0.7 });
    this.light.position.copy(muzzleWorld);
    this.light.color.set(game.palette.accent);
    this.light.intensity = 18;

    // 命中点光斑
    if (hitCreature || hitObj) {
      const flash = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.flashTex, color: new THREE.Color(game.palette.accent).lerp(new THREE.Color('#ffffff'), 0.4),
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      }));
      flash.position.copy(end);
      flash.scale.setScalar(1.1);
      game.scene.add(flash);
      this.flashes.push({ sprite: flash, life: 1, base: 1.1 });
    }

    game.audio?.play('laser', { pitch: 1 + Math.random() * 0.1 });
    game.cameraShake = Math.max(game.cameraShake || 0, 0.22);
    this.recoil = 1;
  }

  attachLight(scene, player) {
    scene.add(this.light);
    this.light.position.set(0, -100, 0);
    this.lightOwner = player;
  }
}
