// 一键到底的无缝飞行状态机：登船 → 驾驶舱 → 点火 → 穿云 → 太空 → 选择星球 → 再入 → 着陆 → 出舱
// 全程无黑屏：通过连续位置的相机运镜与外景/舱内视角切换实现。
import * as THREE from 'three';
import { clamp, damp, lerp, smoothstep } from '../core/noise.js';
import { PLANET_POS, PLANET_R, SUN_POS } from './space.js';
import { PALETTES } from '../world/themes.js';

const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const NOSE = new THREE.Vector3(0, 1, 0); // 火箭模型的机头朝局部 +Y
const PALETTES_NAME = (id) => (PALETTES[id] ? PALETTES[id].name : id);

// 由 偏航/俯仰 得到飞行方向（单位向量）
function dirFrom(yaw, pitch) {
  const cp = Math.cos(pitch);
  return new THREE.Vector3(Math.sin(yaw) * cp, Math.sin(pitch), Math.cos(yaw) * cp);
}
// 用偏航构造横轴，避免把机头方向当成相机上轴；俯仰接近竖直也不切换参考轴。
function cameraBasis(yaw, pitch) {
  const forward = dirFrom(yaw, pitch);
  const right = V3(Math.cos(yaw), 0, -Math.sin(yaw));
  return { forward, right, up: new THREE.Vector3().crossVectors(forward, right).normalize() };
}
// 让机头（局部 +Y）对准 dir，并绕机头滚转
function quatFor(dir, roll, out = new THREE.Quaternion()) {
  out.setFromUnitVectors(NOSE, dir);
  if (roll) out.premultiply(new THREE.Quaternion().setFromAxisAngle(dir, roll));
  return out;
}

export class FlightSystem {
  constructor(game) {
    this.game = game;
    this.phase = 'ground';
    this.t = 0;
    this.phaseT = 0;
    this.camPos = new THREE.Vector3();
    this.camLook = new THREE.Vector3();
    this.camUp = new THREE.Vector3(0, 1, 0);
    this.fov = 55;
    this.ship = game.rocket;
    this.shipPos = new THREE.Vector3();
    this.shipYaw = 0;
    this.shipQuat = new THREE.Quaternion();
    this.shipState = {
      pos: new THREE.Vector3(),
      yaw: 0,
      pitch: 0,
      roll: 0,
      throttle: 0,
      speed: 0,
      target: null,
      warp: 0,
      reentry: 0,
      atmospheric: 0,
      alt: 0,
    };
    this.targetPlanet = null;
    this.selectedPlanet = null;
    this.markers = [];
    this.buildMarkers();
    this.cloudLayer = null;
    this.blackCurtain = 1;
  }

  buildMarkers() {
    // 太空中的星球标签（DOM 投影，由 ui 负责显示）
    this.markers = ['verdant', 'emer', 'lumina'].map((id) => ({ id }));
  }

  // ---------------- 状态切换 ----------------
  setPhase(p) {
    this.phase = p;
    this.phaseT = 0;
    // BUG-45：飞行阶段切换时统一设置引擎层目标音量，
    // 只要不是太空/逼近/再入，引擎声一律淡出为 0。
    const engineOn = p === 'space' || p === 'approach' || p === 'reentry' || p === 'launch' || p === 'atmos' || p === 'landing';
    if (!engineOn) this.game.audio?.setEngine(0, 0);
    if (p === 'landing') this.landStartY = this.ship.group.position.y;
    if (p === 'exit') {
      this.exitCamStart = this.game.camera.position.clone();
      this.exitLookStart = this.game.cameraLookTarget.clone();
    }
    this.game.onFlightPhase?.(p);
  }

  // 平移随飞船立即跟进，仅平滑相对偏移，防止高速航行时镜头落后数百米。
  followCamera(desired, dt, speed, reset = false) {
    const camera = this.game.camera;
    const pos = this.ship.group.position;
    if (reset) camera.position.copy(desired);
    else {
      if (this.cameraShipPos) camera.position.add(pos.clone().sub(this.cameraShipPos));
      camera.position.lerp(desired, 1 - Math.exp(-speed * dt));
    }
    this.cameraShipPos = pos.clone();
  }

  beginBoard() {
    // 宇航员走向舱门并自动进入
    this.setPhase('board');
    const ship = this.ship.group;
    const doorWorld = ship.position.clone().add(new THREE.Vector3(0, 0, -1.2).applyAxisAngle(new THREE.Vector3(0, 1, 0), ship.rotation.y));
    this.boardStart = this.game.player.pos.clone();
    this.boardDoor = doorWorld;
    this.doorOpened = false;
    this.ship.openDoor(true);
    this.game.audio?.play('door');
    this.camStart = this.game.camera.position.clone();
    this.camStartLook = this.game.camera.getWorldDirection(V3()).multiplyScalar(5).add(this.camStart);
  }

  beginLaunch(destId) {
    this.selectedPlanet = destId;
    this.setPhase('launch');
    this.launchYaw = this.ship.group.rotation.y;
    this.originPos = this.ship.group.position.clone();
    this.cameraShipPos = this.originPos.clone();
    this.launchCamRotation = this.game.camera.quaternion.clone();
    this.game.audio?.play('thruster', { vol: 1.0 });
    this.smokeBurst = 0;
    this.ship.lampOn = true;
  }

  // 进入太空时初始化飞船状态
  enterSpace(fromId) {
    this.setPhase('space');
    const s = this.shipState;
    const from = PLANET_POS[fromId];
    const others = ['verdant', 'emer', 'lumina'].filter((id) => id !== fromId);
    const mid = PLANET_POS[others[0]].clone().add(PLANET_POS[others[1]]).multiplyScalar(0.5);
    // 出发点：从母星背向星系中心的一侧升起，保持合适的构图距离
    const dirOut = from.clone().sub(mid).normalize();
    s.pos.copy(from).addScaledVector(dirOut, PLANET_R[fromId] * 6.5);
    // 面向星系内侧（能看到母星与另两颗星球在同一侧）
    const aim = mid.clone().sub(s.pos).normalize();
    s.yaw = Math.atan2(aim.x, aim.z);
    s.pitch = clamp(Math.asin(clamp(aim.y, -1, 1)), -0.55, 0.55);
    s.roll = 0;
    s.throttle = 0.0;
    s.speed = 0;
    s.warp = 0;
    this.autoThrottle = undefined;
    this.hoverTarget = null;
    // 场景切换所在帧就同步网格和镜头，不能渲染一帧旧地表坐标。
    const { forward, right, up } = cameraBasis(s.yaw, s.pitch);
    this.ship.group.position.copy(s.pos);
    this.ship.group.quaternion.copy(quatFor(forward, 0));
    const desired = s.pos.clone().addScaledVector(forward, -13).addScaledVector(up, 4.2).addScaledVector(right, 17);
    this.followCamera(desired, 0, 5, true);
    this.game.cameraLookTarget.copy(s.pos).addScaledVector(forward, 9).addScaledVector(up, 1.6);
    this.game.camera.up.copy(up);
    this.game.camera.lookAt(this.game.cameraLookTarget);
    this.game.spaceSystem.follow(this.game.camera, this.t);
  }

  requestLanding(id) {
    if (this.phase !== 'space') return;
    this.targetPlanet = id;
    this.reentrySwapped = false;
    this.touchedDown = false;
    this.doorSnd = false;
    this.approachFrom = null;
    this.approachT = 0;
    this.setPhase('approach');
    this.approachT = 0;
  }

  // ---------------- 主更新 ----------------
  update(dt, input) {
    this.t += dt;
    this.phaseT += dt;
    switch (this.phase) {
      case 'board': this.updateBoard(dt); break;
      case 'launch': this.updateLaunch(dt); break;
      case 'space': this.updateSpace(dt, input); break;
      case 'approach': this.updateApproach(dt); break;
      case 'reentry': this.updateReentry(dt); break;
      case 'atmos': this.updateAtmos(dt); break;
      case 'landing': this.updateLanding(dt); break;
      case 'doors': this.updateDoors(dt); break;
      case 'exit': this.updateExit(dt); break;
      default: break;
    }
  }

  // ---- 1. 登船 ----
  updateBoard(dt) {
    const p = this.game.player;
    const t = this.phaseT;
    const dur = 2.2;
    // 前 1.6 秒走向舱门
    if (t < 1.8) {
      const k = smoothstep(0, 1.8, t);
      const dir = this.boardDoor.clone().sub(this.boardStart);
      const len = dir.length();
      if (len > 1.4) {
        const moveAmt = clamp(len * k / Math.max(len - 0.9, 0.01), 0, 1);
        p.pos.copy(this.boardStart).addScaledVector(dir, moveAmt);
        p.pos.y = this.game.terrain.height(p.pos.x, p.pos.z);
        p.yaw = Math.atan2(dir.x, dir.z);
        p.vel.set(0, 0, 0);
        p.astronaut.params.walk = damp(p.astronaut.params.walk, 0.8, 8, dt);
        p.astronaut.cycle += dt * 4;
      }
    } else {
      if (!this.doorOpened) {
        this.doorOpened = true;
        this.game.audio?.play('door');
      }
      const k = clamp((t - 1.9) / 0.5, 0, 1);
      p.pos.lerp(this.ship.group.position.clone().add(V3(0, 0.9, -0.1)), k);
      p.astronaut.root.visible = k < 0.6;
    }
    p.object.position.copy(p.pos);
    p.object.rotation.set(0, p.yaw, 0);
    p.astronaut.update(dt, { speed: t < 1.8 ? 1 : 0 });
    // 相机：推进到舷窗高度与方向
    const ship = this.ship.group;
    const camTarget = ship.position.clone().add(V3(0, 2.35, 0.85).applyAxisAngle(V3(0, 1, 0), ship.rotation.y));
    const lookTarget = ship.position.clone().add(V3(0, 2.1, 6.5).applyAxisAngle(V3(0, 1, 0), ship.rotation.y));
    const k = smoothstep(0.2, 2.2, t);
    // 绕船体外侧进入舷窗，避免从人物镜头直线穿过机身。
    const startOffset = this.camStart.clone().sub(ship.position);
    const startAngle = Math.atan2(startOffset.x, startOffset.z);
    const angleDelta = Math.atan2(Math.sin(ship.rotation.y - startAngle), Math.cos(ship.rotation.y - startAngle));
    const angle = startAngle + angleDelta * k;
    const radius = lerp(Math.max(0.85, Math.hypot(startOffset.x, startOffset.z)), 0.85, k);
    this.game.camera.position.set(ship.position.x + Math.sin(angle) * radius,
      lerp(this.camStart.y, camTarget.y, k), ship.position.z + Math.cos(angle) * radius);
    this.game.cameraLookTarget = this.camStartLook.clone().lerp(lookTarget, k);
    this.game.camera.up.set(0, 1, 0);
    this.game.camera.lookAt(this.game.cameraLookTarget);
    this.game.fovCurrent = lerp(55, 46, k);
    this.ship.openDoor(true);
    if (t > dur) {
      p.inRocket = true;
      p.astronaut.root.visible = false;
      this.game.enterCockpit();
      this.setPhase('cockpit');
    }
  }

  // ---- 2. 起飞 ----
  updateLaunch(dt) {
    const t = this.phaseT;
    this.ship.openDoor(false);
    const shipObj = this.ship.group;
    // 时间线：0-1.2 预燃（尘土），1.2-3.2 离地加速，3.2-6.5 穿过云层，6.5+ 冲出大气
    const groundY = shipObj.userData.groundY ?? this.game.terrain.height(shipObj.position.x, shipObj.position.z);
    let liftoff = clamp((t - 1.2) / 2.0, 0, 1);
    liftoff = liftoff * liftoff;
    let climb;
    if (t < 1.2) climb = 0;
    else if (t < 3.4) climb = Math.pow((t - 1.2) / 2.2, 2) * 45;
    else climb = 45 + Math.pow(t - 3.4, 1.6) * 22;
    shipObj.position.y = groundY + climb;
    shipObj.position.x = this.originPos.x + Math.sin(t * 0.7) * clamp((t - 1.2) * 0.2, 0, 3);
    shipObj.position.z = this.originPos.z;
    // 机身姿态：轻微稳定
    shipObj.rotation.z = Math.sin(t * 1.3) * 0.02 * clamp(t - 1, 0, 1);
    shipObj.rotation.x = Math.max(0, -0.08 + t * 0.01);
    this.ship.throttle = smoothstep(0.2, 1.6, t) * 1.0;
    this.ship.update(dt, this.t);
    this.ship.engineGlow.intensity = 30 * this.ship.throttle * (1 + Math.random() * 0.2);
    // 扬起尘土
    if (t < 3.0 && this.game.dustPlume) {
      this.smokeAcc = (this.smokeAcc || 0) + dt;
      if (this.smokeAcc > 0.05) {
        this.smokeAcc = 0;
        this.game.dustPlume.userData.emit(shipObj.position.clone().add(V3(0, 0.2, 0)), 2.4, 1.4);
      }
    }
    // 镜头：地面的抖动 → 拉远 → 仰视
    const shake = 0.14 + (t < 1.2 ? 0.25 : 0.1) + Math.min(t, 4) * 0.03;
    this.game.cameraShake = shake;
    const camBase = shipObj.position.clone().add(V3(5.5, 2.4, 7.5));
    camBase.y = Math.max(camBase.y, groundY + 1.2);
    const back = clamp(t / 6, 0, 1);
    const camTarget = shipObj.position.clone().add(V3(lerp(5.5, 14, back), lerp(2.2, -1.5, back), lerp(7.5, -16, back)));
    const lookAt = shipObj.position.clone().add(V3(0, lerp(1.4, 6, back), 0));
    this.followCamera(camTarget, dt, 3);
    this.game.cameraLookTarget = lookAt;
    this.game.camera.up.set(0, 1, 0);
    this.game.camera.lookAt(lookAt);
    this.game.camera.quaternion.slerpQuaternions(this.launchCamRotation, this.game.camera.quaternion.clone(), smoothstep(0, 0.8, t));
    this.game.fovCurrent = lerp(46, 64, smoothstep(0, 5, t));
    // 云层包裹感
    this.game.atmosOverlay = clamp(smoothstep(3.6, 5.2, t) * (1 - smoothstep(5.6, 7.2, t)), 0, 1);
    // 天空渐变为太空
    this.game.skyFade = smoothstep(4.5, 8.5, t);
    if (t > 9.2) {
      this.game.exitPlanetToSpace();
      this.enterSpace(this.game.currentPlanetId);
    }
  }

  // ---- 3. 太空飞行 ----
  updateSpace(dt, input) {
    const s = this.shipState;
    const game = this.game;
    // 输入（BUG-08：摇杆在统一输入层已折算进 forward/strafe，这里直接复用）
    const yawIn = -(input.mouseDX || 0) * 0.0022 - (input.strafe || 0) * dt * 0.6;
    const pitchIn = -(input.mouseDY || 0) * 0.0022 - (input.forward || 0) * dt * 0.35;
    s.yaw += yawIn;
    s.pitch = clamp(s.pitch + pitchIn, -1.2, 1.2);
    s.roll = damp(s.roll, -((input.strafe || 0)) * 0.35, 3, dt);
    // 油门（BUG-39）：只由明确的加速/减速命令改变，俯仰键不再偷偷加油门。
    // 键盘 E/C、触屏持续加减速按钮、滚轮都走同一条通道。
    const throttleIn = (input.throttle || 0) + (this.autoThrottle !== undefined ? 0 : 0);
    if (throttleIn) s.throttle = clamp(s.throttle + dt * 0.6 * throttleIn, 0, 1);
    if (input.wheel) s.throttle = clamp(s.throttle - input.wheel * 0.12, 0, 1);
    if (this.autoThrottle !== undefined) {
      s.throttle = damp(s.throttle, this.autoThrottle, 0.8, dt);
      if (Math.abs(s.throttle - this.autoThrottle) < 0.02) this.autoThrottle = undefined;
    }
    const targetSpeed = s.throttle * 900;
    s.speed = damp(s.speed, targetSpeed, 0.9, dt);
    // BUG-08：曲率用 held Shift 或触屏“曲”按钮
    const warp = input.warp || input.held.has('ShiftLeft') || input.sprint ? 1 : 0;
    s.warp = damp(s.warp, warp, 2, dt);
    const speed = s.speed * (1 + s.warp * 2.2);
    this.speedForHud = speed;
    // 朝向：机头朝着飞行方向
    const forward = dirFrom(s.yaw, s.pitch);
    const q = quatFor(forward, s.roll);
    // 星球引力辅助吸引
    const near = this.nearestPlanet(s.pos);
    const grav = new THREE.Vector3();
    if (near) {
      const to = near.pos.clone().sub(s.pos);
      const d = to.length();
      const influence = Math.max(0, 1 - (d - near.R) / (near.R * 5));
      grav.copy(to.normalize()).multiplyScalar(influence * 160);
    }
    s.pos.addScaledVector(forward, speed * dt);
    s.pos.addScaledVector(grav, dt);
    // 行星表面阻挡：一旦进入大气层范围就自动进入再入流程（不会穿模）
    const hit = this.planetUnderShip(s.pos);
    const autoLand = this.planetInside(s.pos);
    // 飞船网格
    const ship = this.ship.group;
    ship.position.copy(s.pos);
    ship.quaternion.copy(q);
    this.ship.throttle = 0.12 + s.throttle * 0.5 + s.warp * 0.25;
    this.ship.update(dt, this.t);
    if (this.ship.flameOuter) {
      this.ship.flameOuter.mat.uniforms.uLen.value = 1.6 + s.throttle * 2.2 + s.warp * 1.5;
    }
    this.ship.lampOn = false;
    // 所有太空阶段共用同一组正交基，自动接近和再入也保持地平线稳定。
    const back = forward.clone().negate();
    const { right, up } = cameraBasis(s.yaw, s.pitch);
    // 相机在船身侧后方（略微偏上），从侧后方看飞船与尾焰，避免尾焰正对镜头
    const desired = s.pos.clone()
      .addScaledVector(back, 13.0)
      .addScaledVector(up, 4.2)
      .addScaledVector(right, 17.0);
    this.followCamera(desired, dt, 5);
    // 取景：飞船略偏下，视线沿飞行方向但只领先少量距离
    const look = s.pos.clone().addScaledVector(forward, 9.0).addScaledVector(up, 1.6);
    game.cameraLookTarget = look;
    game.camera.up.copy(up);
    game.camera.lookAt(look);
    game.fovCurrent = lerp(58, 74, clamp(speed / 1400, 0, 1)) + s.warp * 6;
    this.game.speedFx = clamp(speed / 1600, 0, 1);
    this.game.spaceSystem.follow(game.camera, this.t);
    this.game.audio?.setEngine(0.5 + s.throttle * 0.5, s.throttle);
    // 靠近星球即提示着陆
    this.hoverTarget = hit;
    if (autoLand && autoLand !== game.currentPlanetId) {
      game.ui?.showPrompt('');
      this.requestLanding(autoLand);
      return;
    }
    if (autoLand && autoLand === game.currentPlanetId) {
      // 回到母星：直接降落
      game.ui?.showPrompt('');
      this.requestLanding(autoLand);
      return;
    }
    if (hit) {
      game.ui?.showPrompt('进入 ' + PALETTES_NAME(hit) + ' 大气层', 'F');
    } else {
      game.ui?.showPrompt('');
    }
    // BUG-38：降落用独立命令（F / 触屏降落键），不再复用通用的 interact，
    // 否则“按 E 加速”会同时被当成降落确认。
    if ((input.land || input.aim) && hit) {
      game.ui?.showPrompt('');
      this.requestLanding(hit);
    }
  }

  nearestPlanet(pos) {
    let best = null, bd = Infinity;
    for (const id of ['verdant', 'emer', 'lumina']) {
      const p = PLANET_POS[id];
      const d = pos.distanceTo(p);
      if (d < bd) { bd = d; best = { id, pos: p, R: PLANET_R[id], d }; }
    }
    return best;
  }

  planetUnderShip(pos) {
    for (const id of ['verdant', 'emer', 'lumina']) {
      const p = PLANET_POS[id];
      const d = pos.distanceTo(p);
      if (d < PLANET_R[id] * 1.9) return id;
    }
    return null;
  }

  // 已经进入大气（自动降落）
  planetInside(pos) {
    for (const id of ['verdant', 'emer', 'lumina']) {
      const p = PLANET_POS[id];
      const d = pos.distanceTo(p);
      if (d < PLANET_R[id] * 1.22) return id;
    }
    return null;
  }

  // ---- 4. 接近与再入 ----
  // 时间驱动的电影运镜：飞船从远处冲向行星，在进入大气前切到再入
  updateApproach(dt) {
    const game = this.game;
    const s = this.shipState;
    const id = this.targetPlanet;
    const target = PLANET_POS[id];
    const R = PLANET_R[id];
    this.approachT += dt;
    const t = this.approachT;
    // 起始状态：记录一次
    if (!this.approachFrom) {
      this.approachFrom = s.pos.clone();
      this.approachDist = this.approachFrom.distanceTo(target);
      // 保证至少有 3.5 倍半径的冲刺感
      this.approachDur = 5.2;
    }
    // 朝向行星
    const to = target.clone().sub(s.pos).normalize();
    const yawDelta = Math.atan2(Math.sin(Math.atan2(to.x, to.z) - s.yaw), Math.cos(Math.atan2(to.x, to.z) - s.yaw));
    s.yaw += yawDelta * (1 - Math.exp(-2.2 * dt));
    s.pitch = damp(s.pitch, Math.asin(clamp(to.y, -1, 1)), 2.2, dt);
    s.roll = damp(s.roll, 0, 2, dt);
    const forward = dirFrom(s.yaw, s.pitch);
    const q = quatFor(forward, s.roll);
    // 沿视线的平滑推进：从起点冲向行星外大气层（R*1.18）
    const k = smoothstep(0, this.approachDur, t);
    const ease = k * k * (3 - 2 * k);
    const stopDist = R * 2.05;
    const cur = s.pos.distanceTo(target);
    const want = lerp(this.approachDist, stopDist, ease);
    const step = Math.max(0, cur - want);
    if (step > 0.001) s.pos.addScaledVector(forward, Math.min(step, 2600 * dt));
    s.speed = Math.max(s.speed, 620);
    s.warp = damp(s.warp, 0, 0.5, dt);
    const ship = this.ship.group;
    ship.position.copy(s.pos);
    ship.quaternion.copy(q);
    this.ship.throttle = 0.8;
    this.ship.update(dt, this.t);
    const { up, right: side } = cameraBasis(s.yaw, s.pitch);
    const camOffset = s.pos.clone()
      .addScaledVector(forward, -12.5)
      .addScaledVector(up, 3.4)
      .addScaledVector(side, 4.8);
    this.followCamera(camOffset, dt, 4);
    const look = s.pos.clone().addScaledVector(forward, 22);
    game.cameraLookTarget = look;
    game.camera.up.copy(up);
    game.camera.lookAt(look);
    game.fovCurrent = lerp(58, 70, ease);
    this.game.speedFx = 0.55 * (1 - ease * 0.4);
    this.game.spaceSystem.follow(game.camera, this.t);
    // 距离提示
    const km = Math.max(0, Math.round((cur - R) / 10));
    game.ui?.planetMarker(true, PALETTES_NAME(id), km + ' km');
    if (t > this.approachDur * 0.94) {
      game.ui?.planetMarker(false);
      this.setPhase('reentry');
    }
  }

  updateReentry(dt) {
    // 穿过大气：火焰包覆机身 + 剧烈震动 + 镜头逐渐转为跟随外部
    const id = this.targetPlanet;
    const game = this.game;
    const s = this.shipState;
    const t = this.phaseT;
    const forward = dirFrom(s.yaw, s.pitch);
    const q = quatFor(forward, s.roll);
    const approachK = smoothstep(0, 2.6, t);
    s.pos.addScaledVector(forward, 520 * dt * (1 - approachK * 0.5));
    const ship = this.ship.group;
    ship.position.copy(s.pos);
    ship.quaternion.copy(q);
    this.ship.throttle = 0.9;
    this.ship.update(dt, this.t);
    game.cameraShake = 0.25 + approachK * 0.2;
    const { up, right: side } = cameraBasis(s.yaw, s.pitch);
    const camOffset = s.pos.clone()
      .addScaledVector(forward, -18)
      .addScaledVector(up, 6)
      .addScaledVector(side, 8);
    this.followCamera(camOffset, dt, 4);
    const look = s.pos.clone().addScaledVector(forward, 12);
    game.cameraLookTarget = look;
    game.camera.up.copy(up);
    game.camera.lookAt(look);
    game.fovCurrent = 62;
    this.game.reentryFx = smoothstep(0.2, 1.2, t) * (1 - smoothstep(2.6, 3.6, t));
    if (t > 0.4 && !this.reentrySwapped) {
      this.reentrySwapped = true;
      game.startLandingScene(id);
      this.setPhase('atmos');
      // 星系坐标和地表坐标不能互相插值，否则镜头会从数千米外飞进地表。
      this.updateAtmos(0);
      game.terrain.update?.(game.camera, game.time);
    }
  }

  // 大气层下降（与地表场景配合）
  updateAtmos(dt) {
    const game = this.game;
    const t = this.phaseT;
    const startY = game.landingStartY;
    const ship = this.ship.group;
    // 从入场高度连续下降到着陆段的起点。
    const k = smoothstep(0, 4.2, t);
    const groundY = game.player.terrain.height(ship.position.x, ship.position.z);
    ship.position.y = lerp(startY, groundY + 26, k);
    // 姿态：从俯冲逐步拉平到垂直（机头朝上），保留着陆朝向
    const tilt = lerp(0.75, 0, smoothstep(0, 3.2, t));
    ship.quaternion.setFromEuler(new THREE.Euler(tilt, this.landingYaw || 0, Math.sin(t * 0.9) * 0.05 * tilt, 'YXZ'));
    this.ship.throttle = 0.75;
    this.ship.update(dt, this.t);
    game.cloudPass = clamp(smoothstep(2.2, 3.4, t) * (1 - smoothstep(3.6, 4.6, t)), 0, 1);
    game.cameraShake = 0.22 * (1 - k) + 0.04;
    // 镜头：从云层上方跟随下降到地面附近的侧后视
    const look = ship.position.clone().add(V3(0, 1.0, 0));
    const camTarget = ship.position.clone().add(V3(11, 6, 15));
    this.followCamera(camTarget, dt, 2.6, this.phaseT === 0);
    game.cameraLookTarget = look;
    game.camera.up.set(0, 1, 0);
    game.camera.lookAt(look);
    game.fovCurrent = lerp(66, 58, k);
    this.game.atmosOverlay = game.cloudPass;
    if (t > 4.4) {
      this.setPhase('landing');
      this.landT = 0;
    }
  }

  // ---- 5. 着陆 ----
  updateLanding(dt) {
    const game = this.game;
    const ship = this.ship.group;
    const t = this.phaseT;
    const groundY = game.player.terrain.height(ship.position.x, ship.position.z);
    const startY = this.landStartY ?? ship.position.y;
    const k = smoothstep(0, 3.0, t);
    ship.position.y = lerp(startY, groundY, k * k);
    // 落到地面时姿态回到垂直（轻微摇摆）
    const settle = smoothstep(0, 2.2, t);
    ship.quaternion.setFromEuler(new THREE.Euler(
      Math.sin(t * 1.1) * 0.01 * (1 - settle), this.landingYaw || 0,
      Math.sin(t * 1.4) * 0.012 * (1 - settle), 'YXZ'
    ));
    this.ship.throttle = lerp(0.75, 0, smoothstep(2.4, 3.2, t));
    this.ship.update(dt, this.t);
    game.cameraShake = 0.06 + (1 - k) * 0.05;
    const camTarget = ship.position.clone().add(V3(6.5, 2.2, 8.5));
    this.followCamera(camTarget, dt, 2.2);
    game.cameraLookTarget = ship.position.clone().add(V3(0, 1, 0));
    game.camera.up.set(0, 1, 0);
    game.camera.lookAt(game.cameraLookTarget);
    game.fovCurrent = 56;
    if (t > 3.0 && !this.touchedDown) {
      this.touchedDown = true;
      ship.userData.groundY = groundY;
      game.audio?.play('heavyLand');
      game.cameraShake = 0.5;
      if (game.dustPlume) for (let i = 0; i < 6; i++) setTimeout(() => game.dustPlume.userData.emit(ship.position.clone().add(V3(0, 0.3, 0)), 3.2, 1.2), i * 90);
    }
    if (t > 3.8) {
      this.setPhase('doors');
    }
  }

  // ---- 6. 出舱 ----
  updateDoors(dt) {
    const t = this.phaseT;
    const game = this.game;
    this.ship.openDoor(true);
    if (t > 0.6 && !this.doorSnd) { this.doorSnd = true; game.audio?.play('door'); }
    const ship = this.ship.group;
    const yaw = this.landingYaw || 0;
    const camPos = ship.position.clone().add(V3(4.5, 1.8, -6.5).applyAxisAngle(V3(0, 1, 0), yaw));
    game.camera.position.lerp(camPos, 1 - Math.exp(-2 * dt));
    game.cameraLookTarget = ship.position.clone().add(V3(0, 1.0, -1).applyAxisAngle(V3(0, 1, 0), yaw));
    game.camera.up.set(0, 1, 0);
    game.camera.lookAt(game.cameraLookTarget);
    if (t > 2.0) {
      this.setPhase('exit');
    }
  }

  updateExit(dt) {
    const game = this.game;
    const t = this.phaseT;
    const ship = this.ship.group;
    const p = game.player;
    const yaw = this.landingYaw || 0;
    // 从舱门位置走下
    const doorWorld = ship.position.clone().add(V3(0, 0.15, -1.3).applyAxisAngle(V3(0, 1, 0), yaw));
    const k = smoothstep(0, 1.4, t);
    const outward = V3(0, 0, -1).applyAxisAngle(V3(0, 1, 0), yaw);
    const startPos = ship.position.clone().add(V3(0, 0.9, -0.2).applyAxisAngle(V3(0, 1, 0), yaw));
    p.pos.lerpVectors(startPos, doorWorld.clone().addScaledVector(outward, 7.0), k);
    p.pos.y = game.terrain.height(p.pos.x, p.pos.z);
    p.astronaut.root.visible = t > 0.15;
    p.yaw = Math.atan2(outward.x, outward.z);
    p.camYaw = p.yaw + Math.PI;
    p.object.position.copy(p.pos);
    p.object.rotation.set(0, p.yaw, 0);
    p.astronaut.update(dt, { speed: t > 0.2 && t < 1.5 ? 2.7 : 0 });
    p.vel.set(0, 0, 0);
    p.velY = 0;
    p.grounded = true;
    p.aiming = false;
    p.landImpact = 0;
    p.camPitch = 0.28;
    p.camCur = p.camDist;
    p.camTarget.copy(p.pos).add(V3(0, 0.5, 0));
    // 从舱门侧面绕到角色身后，视线始终跟随角色；沿用地表的距离与俯仰。
    const blend = smoothstep(0, 2.0, t);
    p.updateCamera(dt, game.camera, {}, true);
    game.camera.position.lerpVectors(this.exitCamStart, game.camera.position.clone(), blend);
    const fromShip = game.camera.position.clone().sub(ship.position);
    const outsideDoor = fromShip.dot(outward);
    if (outsideDoor < 2.5) game.camera.position.addScaledVector(outward, 2.5 - outsideDoor);
    game.camera.position.y = Math.max(game.camera.position.y, game.terrain.height(game.camera.position.x, game.camera.position.z) + 0.45);
    game.cameraLookTarget.lerpVectors(this.exitLookStart, game.cameraLookTarget.clone(), smoothstep(0, 0.4, t));
    game.camera.up.set(0, 1, 0);
    game.camera.lookAt(game.cameraLookTarget);
    game.fovCurrent = 55;
    this.ship.openDoor(false);
    if (t > 2.0) {
      p.inRocket = false;
      game.finishLanding();
      this.setPhase('ground');
      this.touchedDown = false;
      this.doorSnd = false;
      this.reentrySwapped = false;
    }
  }
}
