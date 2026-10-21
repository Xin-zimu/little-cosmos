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

// BUG-05：每种射击模式的能量消耗（与 tryFire 中的校验共用同一份数据）
const ENERGY_COST = [8, 26, 16];

// 射线只应命中"看得见"的物体。Raycaster 自身不检查 visible，而采集后的资源节点
// 与死亡后淡出的生物只是把 visible 置 false，若不在这里过滤，射线会打在隐形物体上：
// 伤害被吸收且没有命中反馈，玩家会以为武器失灵。
function isVisibleInScene(obj) {
  for (let o = obj; o; o = o.parent) {
    if (!o.visible) return false;
  }
  return true;
}

// BUG-29：区分“可伤害”（hittable）与“可阻挡”（occluder）。
// 判定采用“默认阻挡 + 显式放行”：
//  - 任何可见的实体网格（含 InstancedMesh）都会挡住弹道，因此地形、建筑、
//    飞船、植被、资源无需逐个打标记也不会被穿透；
//  - 纯视觉元素（天空、水面、粒子、弹道自身、全息预览）显式标记 noBlock 放行。
// 这样新增场景物件不会悄悄破坏“射击被遮挡”的规则。
function isOccluder(obj) {
  if (!obj.isMesh && !obj.isInstancedMesh) return false;
  if (obj.userData.noBlock) return false;
  if (obj.userData.hittable || obj.userData.occluder) return true;
  return true;
}

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

  // BUG-32：切换模式丢弃尚未发射的余弹，避免切回来后“不按开火也会继续射击”
  switchMode() {
    if (this.burstCount > 0) {
      this.burstCount = 0;
      this.burstTimer = 0;
    }
    this.cooldown = Math.max(this.cooldown, 0);
    this.mode = (this.mode + 1) % 3;
    this.game.ui?.toast(`射击模式：${this.modes[this.mode]}`, 'info');
    this.game.audio?.play('uiTick');
  }

  // BUG-33：离开地表 / 重开游戏时显式销毁所有短生命周期特效
  clearEffects() {
    for (const b of this.beams) {
      this.game.scene.remove(b.mesh);
      b.mesh.geometry.dispose();
      b.mesh.material.dispose();
    }
    this.beams.length = 0;
    for (const f of this.flashes) {
      this.game.scene.remove(f.sprite);
      f.sprite.material.dispose();
    }
    this.flashes.length = 0;
    this.light.intensity = 0;
    this.burstCount = 0;
    this.burstTimer = 0;
    this.recoil = 0;
  }

  // BUG-33：短生命周期特效的更新放进通用循环，飞行/太空/菜单期间也会自然消失
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
    // BUG-05：三种模式消耗不同，必须按当前模式校验能量，并保证扣费后不为负
    const cost = ENERGY_COST[this.mode] ?? ENERGY_COST[0];
    if (this.energy < cost) {
      this.game.ui?.toast(`能量不足（需要 ${Math.ceil(cost)}）`, 'warn');
      this.game.audio?.play('uiError');
      return;
    }
    this.energy = Math.max(0, this.energy - cost);
    if (this.mode === 0) {
      this.cooldown = 0.22;
      this.fireOnce(1.0);
    } else if (this.mode === 1) {
      this.cooldown = 0.9;
      this.burstCount = 4;
      this.burstTimer = 0;
    } else {
      this.cooldown = 0.55;
      for (let i = -2; i <= 2; i++) this.fireOnce(0.55, false, i * 0.032);
    }
  }

  fireOnce(mult = 1, small = false, spread = 0) {
    const game = this.game;
    const cam = game.camera;
    // BUG-31：散射在相机局部正交基上施加，不再直接叠加世界坐标 x/y，
    // 因此朝任何方向射击的扇形张角都一致。
    const baseDir = new THREE.Vector3();
    cam.getWorldDirection(baseDir);
    const dir = baseDir.clone();
    if (spread) {
      const right = new THREE.Vector3();
      const up = new THREE.Vector3();
      // 由视线构造稳定的正交基（视线接近竖直时退回到世界轴）
      up.set(0, 1, 0);
      if (Math.abs(baseDir.dot(up)) > 0.98) up.set(0, 0, 1);
      right.crossVectors(baseDir, up).normalize();
      up.crossVectors(right, baseDir).normalize();
      // spread 是归一化后的横向偏移量，围绕射线旋转成固定角度
      const ang = Math.atan(spread);
      dir.addScaledVector(right, Math.tan(ang)).addScaledVector(up, Math.tan(ang) * 0.4).normalize();
    }
    // 便于验证与调试：记录本次实际使用的射线方向
    this.lastDir = dir.clone();
    this.lastOrigin = cam.position.clone();
    const origin = cam.position.clone();
    const muzzleWorld = new THREE.Vector3();
    const muzzle = game.player.astronaut.muzzle;
    muzzle.getWorldPosition(muzzleWorld);

    // BUG-29：射线集合 = 全部“可伤害 + 可阻挡”的实体，先取最近命中再判定伤害。
    // 玩家自身的模型必须排除：枪口就在模型上，否则“枪口到相机的遮挡检查”会命中自己。
    const targets = [];
    const ownRoot = game.player?.object;
    const isOwn = (o) => {
      for (let n = o; n; n = n.parent) if (n === ownRoot) return true;
      return false;
    };
    game.scene.traverse((o) => {
      if (o.isMesh && isOccluder(o) && isVisibleInScene(o) && !isOwn(o)) targets.push(o);
    });
    this.raycaster.set(origin, dir);
    this.raycaster.far = this.range;
    let hits = this.raycaster.intersectObjects(targets, false);
    // BUG-29 补充：弹道是从枪口画到命中点的，枪口到目标之间也必须没有遮挡。
    // 判定放在确定命中点之后进行（见下方 muzzleBlocked 计算）。
    this.lastHitCount = hits.length;
    let end = origin.clone().addScaledVector(dir, this.range);
    let hitCreature = null;
    let hitObj = null;
    if (hits.length) {
      end = hits[0].point;
      hitObj = hits[0].object;
      const c = hitObj.userData.creature;
      // BUG-29：枪口到命中点的遮挡检查。
      // 只在枪口处于合理位置时启用：如果宇航员变换尚未更新，枪口坐标会远离相机，
      // 此时线段没有意义，不能据此判定“整枪被挡住”。
      let muzzleBlocked = false;
      const camToMuzzle = muzzleWorld.distanceTo(origin);
      const targetDist = hits[0].distance;
      if (camToMuzzle > 0.15 && camToMuzzle < targetDist) {
        const seg = end.clone().sub(muzzleWorld);
        const segLen = seg.length();
        if (segLen > 0.2) {
          this.raycaster.set(muzzleWorld, seg.normalize());
          this.raycaster.far = segLen - 0.08;
          const mHits = this.raycaster.intersectObjects(targets, false);
          // 起手就贴在枪口上的面（同一个物体）不算遮挡
          muzzleBlocked = mHits.some((h) => h.object !== hitObj && h.distance > 0.05);
          this.raycaster.far = this.range;
          this.raycaster.near = 0;
        }
      }
      this.lastMuzzleBlocked = muzzleBlocked;
      if (c && !c.dead && !muzzleBlocked) {
        // BUG-30：弱点由模型显式标记（userData.weak），命中点局部坐标落在弱点体内即为暴击
        const weak = !!hitObj.userData.weak;
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
    // BUG-29：弹道自身不是遮挡体
    mesh.userData.noBlock = true;
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
