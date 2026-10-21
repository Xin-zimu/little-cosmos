// 第三人称角色控制器：不同重力、惯性位移、斜坡行走、碰撞、镜头环绕与碰撞退缩
import * as THREE from 'three';
import { clamp, damp } from '../core/noise.js';
import { Astronaut } from './astronaut.js';

// 角色碰撞半径（米）。与植被/建筑/资源/火箭共用同一套水平阻挡。
const PLAYER_R = 0.42;
// BUG-15：碰撞推进的最大迭代次数，用于反复推出穿透后再取最高地面
const MAX_SLIDE_ITER = 3;

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
    this.camPitch = 0.28;
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

  // BUG-20：瞬移必须同步镜头状态，否则死亡重生后镜头会横穿整个场景再追上来。
  teleport(x, z, yaw = 0, opts = {}) {
    const y = this.terrain.height(x, z);
    this.pos.set(x, y, z);
    this.vel.set(0, 0, 0);
    this.velY = 0;
    this.yaw = yaw;
    if (opts.keepCameraYaw !== true) this.camYaw = yaw;
    this.grounded = true;
    this.landImpact = 0;
    this.stepAccum = 0;
    // 跟随目标与当前镜头距离一起归位；相机位置由下一帧 snap 处理
    this.camTarget.copy(this.pos).add(new THREE.Vector3(0, 0.5, 0));
    this.camCur = this.aiming ? this.camDist - 1.75 : this.camDist;
    this.camSnapPending = true;
  }

  // 瞬移后让镜头立刻归位（供 respawn / 读档使用）
  snapCamera(camera) {
    this.camTarget.copy(this.pos).add(new THREE.Vector3(0, 0.5, 0));
    this.camCur = this.aiming ? this.camDist - 1.75 : this.camDist;
    this.updateCamera(0, camera, {}, true);
    this.camSnapPending = false;
  }

  // BUG-14：camPitch 是“相机绕角色抬起的角度”，鼠标向下应该让视线向下。
  // 相机位于角色背后上方，视线方向近似 -dir，因此 camPitch 增大=视线向下。
  // 统一约定：鼠标下移（dy>0）→ 视线下移 → camPitch 增大，与太空俯仰一致。
  look(dx, dy, sens = 0.0022) {
    this.camYaw -= dx * sens;
    this.camPitch = clamp(this.camPitch + dy * sens, -1.15, 0.85);
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

    // 水平移动 + 碰撞（BUG-15 / BUG-16 / BUG-17）
    // 顺序：逐轴推进并做切向滑动 → 边界约束 → 用最终位置重新查询地面高度。
    const stepX = this.vel.x * dt;
    const stepZ = this.vel.z * dt;
    this._moveAxis(stepX, 0);
    this._moveAxis(0, stepZ);
    // 滑块被完全挡住时仍有极小穿透风险，做一次显式推出
    this._depenetrate();
    // 边界
    const r = Math.hypot(this.pos.x, this.pos.z);
    if (r > 300) {
      this.pos.x *= 300 / r;
      this.pos.z *= 300 / r;
    }
    // BUG-16：碰撞与边界修正之后，地面高度必须按最终位置重新采样
    const groundH = t.height(this.pos.x, this.pos.z);

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

  updateCamera(dt, camera, input, snap = false) {
    const desiredTarget = this.pos.clone().add(new THREE.Vector3(0, 0.5, 0));
    // 相机跟随平滑
    this.camTarget.x = damp(this.camTarget.x, desiredTarget.x, 12, dt);
    this.camTarget.y = damp(this.camTarget.y, desiredTarget.y, 10, dt);
    this.camTarget.z = damp(this.camTarget.z, desiredTarget.z, 12, dt);
    if (snap || this.camTarget.lengthSq() === 0) this.camTarget.copy(desiredTarget);

    const aimZoom = this.aiming ? 1.75 : 0;
    const fitDist = this.camDist - aimZoom;
    this.camCur = damp(this.camCur, fitDist, 6, dt);
    if (snap) this.camCur = fitDist;

    const cp = Math.cos(this.camPitch);
    const dir = new THREE.Vector3(
      Math.sin(this.camYaw) * cp,
      Math.sin(this.camPitch),
      Math.cos(this.camYaw) * cp
    );
    // 相机遮挡（BUG-18 / BUG-19）：
    // 把相机当成半径 CAM_R 的球体，对地形、火箭船体、树干岩柱、基地建筑一起做采样，
    // 一旦入口距离小于当前距离就立刻收缩（允许小于 2.4 米，不再越过碰撞入口）。
    const origin = this.camTarget;
    let dist = this.camCur;
    const steps = 18;
    const clearance = 0.32;
    const distBefore = dist;
    for (let i = 1; i <= steps; i++) {
      const d = (i / steps) * this.camCur;
      const p = origin.clone().addScaledVector(dir, d);
      // 1) 地形：相机半径内的最高地面（含侧向），防止擦入斜坡
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
      // 2) 实体遮挡：船体 / 树干岩柱 / 基地建筑（同一套体积判定）
      if (this._cameraBlocked(p)) {
        // 回退到入口前的最后一个安全采样点，而不是强行保留 2.4 米
        dist = Math.min(dist, Math.max(0.55, d - 0.35));
        break;
      }
    }
    dist = Math.max(dist, 0.55);
    // 收缩要立刻生效，恢复可以慢一点，避免镜头抖动（入口收缩永远优先）
    this.camCur = Math.min(this.camCur, Math.max(dist, 0.55));
    if (dist < distBefore) this.camCur = Math.max(dist, 0.55);
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
    if (snap || this.camSnapPending) {
      camera.position.copy(desiredPos);
      this.camSnapPending = false;
    } else camera.position.lerp(desiredPos, 1 - Math.exp(-(this.aiming ? 22 : 14) * dt));
    // BUG-19：插值之后的最终位置必须再校验一次，
    // 否则镜头平滑追上来的过程仍会穿过船体/树干。
    for (let guard = 0; guard < 6 && this._cameraBlocked(camera.position); guard++) {
      const back = origin.clone().sub(camera.position);
      const len = back.length();
      if (len < 0.4) { camera.position.copy(origin).addScaledVector(dir, 0.5); break; }
      camera.position.addScaledVector(back.normalize(), Math.min(len * 0.5, 0.6));
    }
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
    camera.up.set(0, 1, 0);
    camera.lookAt(lookAt);
    this.game.cameraLookTarget.copy(lookAt);
  }

  // 面向镜头前方（采集 / 建造时）
  faceCameraForward() {
    const hs = Math.hypot(this.vel.x, this.vel.z);
    if (hs < 0.3) this.yaw = this.camYaw + Math.PI;
  }

  // ================= 统一水平碰撞 =================
  // BUG-17：把植被、基地建筑（实心）、资源节点、火箭船体统一成一个可行走碰撞集合，
  // 角色任何方向都走不进实体内部。
  _solidCircle(x, z) {
    // 返回该点是否落在实心体内（含角色半径）
    const g = this.game;
    const pad = PLAYER_R;
    // 植被（树干 / 岩柱 / 大石）
    if (g.vegetation?.blocked(x, z, pad)) return true;
    // 基地建筑
    if (g.building?.blockedAt && g.building.blockedAt(x, z, pad)) return true;
    // 资源节点（矿石 / 晶簇）
    if (g.resources?.blockedAt && g.resources.blockedAt(x, z, pad)) return true;
    // 火箭船体：舱门方向（局部 -Z）留出登船通道
    const rk = g.rocket?.group;
    if (rk) {
      const dx = rk.position.x - x, dz = rk.position.z - z;
      const dist = Math.hypot(dx, dz);
      if (dist < 2.2) {
        const yaw = rk.rotation.y;
        const doorDx = -Math.sin(yaw), doorDz = -Math.cos(yaw);
        const along = (x - rk.position.x) * doorDx + (z - rk.position.z) * doorDz;
        const allow = along > 0.2 ? 1.0 : 1.45;
        if (dist < allow + pad * 0.5) return true;
      }
    }
    return false;
  }

  // BUG-18 / BUG-19：相机体积遮挡。相机是半径 CAM_R 的球，
  // 命中船体、树干岩柱或基地建筑时返回 true。
  _cameraBlocked(p) {
    const g = this.game;
    const CAM_R = 0.35;
    // 火箭船体：圆柱（轴线垂直，半径约 0.75，舱底到机头约 3.6 米）
    const rk = g.rocket?.group;
    if (rk) {
      const rdx = p.x - rk.position.x, rdz = p.z - rk.position.z;
      const horiz = Math.hypot(rdx, rdz);
      const baseY = rk.position.y;
      if (horiz < 0.85 + CAM_R && p.y > baseY - 0.4 && p.y < baseY + 4.2) return true;
    }
    // 植被与基地建筑：统一用水平圆 + 高度区间
    const t = this.terrain;
    if (t) {
      const gh = t.height(p.x, p.z);
      if (g.vegetation?.blocked(p.x, p.z, CAM_R)) return true;
      if (g.building?.cameraBlockedAt && g.building.cameraBlockedAt(p.x, p.z, CAM_R, p.y - gh)) return true;
    }
    return false;
  }

  // 单轴推进：被挡住时只吞掉该轴位移，另一轴保留 → 自然产生切向滑动
  _moveAxis(dx, dz) {
    if (!dx && !dz) return;
    const nx = this.pos.x + dx;
    const nz = this.pos.z + dz;
    if (!this._solidCircle(nx, nz)) {
      this.pos.x = nx;
      this.pos.z = nz;
      return;
    }
    // 被挡住：清掉该方向的水平速度，避免持续挤压后逐帧抖动
    if (dx) this.vel.x = 0;
    if (dz) this.vel.z = 0;
  }

  // 显式推出：如果已经被卡进实体（例如传送、建筑落成、上岸），沿最近边界推开
  _depenetrate() {
    const g = this.game;
    if (!this._solidCircle(this.pos.x, this.pos.z)) return;
    for (let i = 0; i < MAX_SLIDE_ITER; i++) {
      let moved = false;
      const probes = [[0.35, 0], [-0.35, 0], [0, 0.35], [0, -0.35], [0.3, 0.3], [-0.3, 0.3], [0.3, -0.3], [-0.3, -0.3]];
      for (const [ox, oz] of probes) {
        const nx = this.pos.x + ox, nz = this.pos.z + oz;
        if (!this._solidCircle(nx, nz)) { this.pos.x = nx; this.pos.z = nz; moved = true; break; }
      }
      if (!moved) break;
      if (!this._solidCircle(this.pos.x, this.pos.z)) return;
    }
  }
}

