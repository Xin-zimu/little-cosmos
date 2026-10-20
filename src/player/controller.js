// 第三人称角色控制器：不同重力、惯性位移、斜坡行走、碰撞、镜头环绕与碰撞退缩
import * as THREE from 'three';
import { clamp, damp } from '../core/noise.js';
import { Astronaut } from './astronaut.js';

export class PlayerController {
  constructor(game) {
    this.game = game;
    this.astronaut = new Astronaut(game.palette.accent);
    this.object = this.astronaut.root;
    this.pos = new THREE.Vector3(0, 0, 6);
    this.vel = new THREE.Vector3();
    this.velY = 0;
    this.grounded = true;
    this.gravity = 7.4;
    this.yaw = 0; // 角色朝向
    this.camYaw = 0;
    this.camPitch = -0.1;
    this.camDist = 5.4;
    this.camCur = 5.2;
    this.camTarget = new THREE.Vector3();
    this.camPos = new THREE.Vector3();
    this.walkPhase = 0;
    this.stepAccum = 0;
    this.aiming = false;
    this.gathering = false;
    this.building = false;
    this.crouching = false;
    this.lastJump = 0;
    this.landImpact = 0;
    this.inertia = 10;
    this.moveSpeedWalk = 2.7;
    this.moveSpeedRun = 6.0;
    this.shake = 0;
    this.stepEvent = null;
    this.height = 0.6;
  }

  setPlanet(terrain, palette) {
    this.terrain = terrain;
    this.gravity = palette.gravity;
    this.inertia = 9 + (1 - palette.gravity / 10) * 6;
  }

  teleport(x, z, yaw = 0) {
    const y = this.terrain.height(x, z);
    this.pos.set(x, y, z);
    this.vel.set(0, 0, 0);
    this.velY = 0;
    this.yaw = yaw;
    this.camYaw = yaw;
    this.grounded = true;
  }

  look(dx, dy, sens = 0.0022) {
    this.camYaw -= dx * sens;
    this.camPitch = clamp(this.camPitch - dy * sens, -1.15, 0.85);
  }

  jump() {
    if (this.grounded) {
      this.velY = Math.sqrt(2 * this.gravity * 1.15);
      this.grounded = false;
      return true;
    }
    return false;
  }

  update(dt, input, camera) {
    const t = this.terrain;
    const fwd = new THREE.Vector3(-Math.sin(this.camYaw), 0, -Math.cos(this.camYaw));
    const right = new THREE.Vector3(Math.cos(this.camYaw), 0, -Math.sin(this.camYaw));
    const wish = new THREE.Vector3();
    wish.addScaledVector(fwd, input.forward || 0);
    wish.addScaledVector(right, input.strafe || 0);
    if (wish.lengthSq() > 1) wish.normalize();

    const sprinting = input.sprint && !this.aiming;
    let maxSpeed = sprinting ? this.moveSpeedRun : this.moveSpeedWalk;
    if (this.crouching) maxSpeed *= 0.45;
    if (this.aiming) maxSpeed *= 0.55;
    if (this.gathering || this.building) maxSpeed *= 0.15;
    const target = wish.multiplyScalar(maxSpeed);
    const accel = this.grounded ? this.inertia : this.inertia * 0.25;
    this.vel.x = damp(this.vel.x, target.x, accel, dt);
    this.vel.z = damp(this.vel.z, target.z, accel, dt);

    // 水平移动 + 碰撞
    const nx = this.pos.x + this.vel.x * dt;
    const nz = this.pos.z + this.vel.z * dt;
    const groundH = t.height(nx, nz);
    const col = this.game.vegetation?.blocked(nx, nz, 0.35);
    // 火箭船体：不让玩家钻进起落架/机身（舱门侧留出登船通道）
    let rocketBlock = null;
    const rk = this.game.rocket?.group;
    if (rk) {
      const dx = rk.position.x - nx, dz = rk.position.z - nz;
      const dist = Math.hypot(dx, dz);
      if (dist < 1.5) {
        // 舱门方向（局部 -Z）允许靠近到 1.0m
        const yaw = rk.rotation.y;
        const doorDx = -Math.sin(yaw), doorDz = -Math.cos(yaw);
        const along = (nx - rk.position.x) * doorDx + (nz - rk.position.z) * doorDz;
        const allow = along > 0.2 ? 1.0 : 1.45;
        if (dist < allow) rocketBlock = true;
      }
    }
    if (!col && !rocketBlock) {
      this.pos.x = nx;
      this.pos.z = nz;
    } else {
      // 沿山坡滑移
      this.pos.x += this.vel.x * dt * 0.2;
      this.pos.z += this.vel.z * dt * 0.2;
      this.vel.multiplyScalar(0.5);
    }
    // 边界
    const r = Math.hypot(this.pos.x, this.pos.z);
    if (r > 300) {
      this.pos.x *= 300 / r;
      this.pos.z *= 300 / r;
    }

    // 垂直：贴地 / 重力
    if (!this.grounded) {
      this.velY -= this.gravity * dt;
      this.pos.y += this.velY * dt;
      if (this.pos.y <= groundH) {
        const impactV = -this.velY;
        this.pos.y = groundH;
        if (impactV > 2.2) {
          this.landImpact = clamp(impactV / 8, 0, 1);
          this.astronaut.params.hurt = 0.0;
          this.game.onLand && this.game.onLand(this.pos, this.landImpact);
        }
        this.velY = 0;
        this.grounded = true;
      }
    } else {
      // 贴地行走（上坡/下坡）
      if (groundH < this.pos.y - 0.35 && this.vel.lengthSq() > 1.0) {
        this.grounded = false; // 走下悬崖
        this.velY = 0;
      } else {
        this.pos.y = damp(this.pos.y, groundH, 18, dt);
      }
    }
    if (this.grounded && Math.abs(groundH - this.pos.y) > 1.2) {
      this.pos.y = groundH;
    }

    // 角色朝向：移动方向，静止时朝镜头前方
    const hs = Math.hypot(this.vel.x, this.vel.z);
    let targetYaw = this.yaw;
    if (hs > 0.3) targetYaw = Math.atan2(this.vel.x, this.vel.z);
    else if (this.aiming) targetYaw = this.camYaw + Math.PI;
    else targetYaw = this.yaw;
    let dy = targetYaw - this.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    this.yaw += dy * (1 - Math.exp(-(hs > 0.3 ? 12 : 8) * dt));

    // 角色姿态
    this.object.position.copy(this.pos);
    // 站在斜坡上的轻微倾斜
    const e = 0.4;
    const hx = t.height(this.pos.x + e, this.pos.z) - t.height(this.pos.x - e, this.pos.z);
    const hz = t.height(this.pos.x, this.pos.z + e) - t.height(this.pos.x, this.pos.z - e);
    const slopeX = Math.atan2(-hx / (2 * e), 1) * 0.6;
    const slopeZ = Math.atan2(-hz / (2 * e), 1) * 0.6;
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(slopeZ * Math.cos(this.yaw) - slopeX * Math.sin(this.yaw) * 0, 0, 0));
    this.object.rotation.set(0, this.yaw, 0);
    // 使用局部倾斜：围绕角色朝向
    const tilt = new THREE.Quaternion().setFromEuler(new THREE.Euler(slopeZ, 0, -slopeX));
    const yawQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, this.yaw, 0));
    this.object.quaternion.copy(tilt).multiply(yawQ);
    this.object.rotation.setFromQuaternion(this.object.quaternion);

    // 动画输入
    this.astronaut.update(dt, {
      speed: hs,
      aiming: this.aiming,
      airborne: !this.grounded,
      gathering: this.gathering,
      building: this.building,
      crouching: this.crouching,
      pitch: this.camPitch,
    });

    // 步频事件（脚步尘土、音效）
    this.stepAccum += hs * dt;
    if (this.grounded && this.stepAccum > (sprinting ? 1.15 : 0.95)) {
      this.stepAccum = 0;
      this.stepEvent = { pos: this.pos.clone(), run: sprinting };
      this.game.onFootstep && this.game.onFootstep(this.pos, sprinting);
    }

    // 相机
    this.updateCamera(dt, camera, input);
    this.landImpact = damp(this.landImpact, 0, 6, dt);
  }

  updateCamera(dt, camera, input) {
    const desiredTarget = this.pos.clone().add(new THREE.Vector3(0, 0.5, 0));
    // 相机跟随平滑
    this.camTarget.x = damp(this.camTarget.x, desiredTarget.x, 12, dt);
    this.camTarget.y = damp(this.camTarget.y, desiredTarget.y, 10, dt);
    this.camTarget.z = damp(this.camTarget.z, desiredTarget.z, 12, dt);
    if (this.camTarget.lengthSq() === 0) this.camTarget.copy(desiredTarget);

    const aimZoom = this.aiming ? 1.75 : 0;
    const fitDist = this.camDist - aimZoom;
    this.camCur = damp(this.camCur, fitDist, 6, dt);

    const cp = Math.cos(this.camPitch);
    const dir = new THREE.Vector3(
      Math.sin(this.camYaw) * cp,
      Math.sin(this.camPitch),
      Math.cos(this.camYaw) * cp
    );
    // 相机遮挡：沿视线采样 + 侧向环形采样，逼近相机局部地形高度
    let dist = this.camCur;
    const origin = this.camTarget;
    const steps = 14;
    const clearance = 0.32;
    for (let i = 1; i <= steps; i++) {
      const d = (i / steps) * this.camCur;
      const p = origin.clone().addScaledVector(dir, d);
      // 相机半径内的最高地面（含侧向），防止擦入斜坡
      let gh = this.terrain.height(p.x, p.z);
      const r = 0.35 + d * 0.05;
      const cand = [
        this.terrain.height(p.x + r, p.z), this.terrain.height(p.x - r, p.z),
        this.terrain.height(p.x, p.z + r), this.terrain.height(p.x, p.z - r),
      ];
      gh = Math.max(gh, ...cand);
      if (p.y < gh + clearance) {
        dist = Math.min(dist, d * 0.9);
        break;
      }
      // 火箭船体遮挡：相机不要钻进机身
      const rk = this.game.rocket?.group;
      if (rk) {
        const rdx = p.x - rk.position.x, rdz = p.z - rk.position.z;
        if (rdx * rdx + rdz * rdz < 1.75 * 1.75 && p.y < rk.position.y + 3.6) {
          dist = Math.min(dist, Math.max(2.4, d - 0.8));
          break;
        }
      }
    }
    dist = Math.max(dist, 0.9);
    const shake = this.game.cameraShake || 0;
    const desiredPos = origin.clone().addScaledVector(dir, dist);
    const cgh = this.terrain.height(desiredPos.x, desiredPos.z) + 0.45;
    if (desiredPos.y < cgh) desiredPos.y = cgh;
    if (shake > 0.001) {
      desiredPos.x += (Math.random() - 0.5) * shake * 0.25;
      desiredPos.y += (Math.random() - 0.5) * shake * 0.25;
      desiredPos.z += (Math.random() - 0.5) * shake * 0.25;
    }
    // 瞄准时右肩偏移
    const shoulder = this.aiming ? this.camCur * 0.18 : 0;
    desiredPos.addScaledVector(new THREE.Vector3(Math.cos(this.camYaw), 0, -Math.sin(this.camYaw)), shoulder);
    camera.position.lerp(desiredPos, 1 - Math.exp(-(this.aiming ? 22 : 14) * dt));
    const lookAt = origin.clone().addScaledVector(dir, -2.0);
    if (this.aiming) {
      lookAt.copy(origin).addScaledVector(dir, -4).add(new THREE.Vector3(0, 0.06, 0));
    }
    // 落地冲击
    if (this.landImpact > 0.01) {
      camera.position.y -= this.landImpact * 0.08;
    }
    // 轻微呼吸
    const tt = performance.now() * 0.001;
    const breath = this.grounded && !this.aiming ? 0.006 : 0.012;
    camera.position.x += Math.sin(tt * 0.9) * breath;
    camera.position.y += Math.sin(tt * 1.3) * breath;
    camera.lookAt(lookAt);
  }

  // 面向镜头前方（采集 / 建造时）
  faceCameraForward() {
    const hs = Math.hypot(this.vel.x, this.vel.z);
    if (hs < 0.3) this.yaw = this.camYaw + Math.PI;
  }
}

