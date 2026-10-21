import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { FlightSystem } from '../src/ship/flight.js';
import { PlayerController } from '../src/player/controller.js';
import { Input } from '../src/core/input.js';

const idle = () => ({ held: new Set(), keys: new Set() });
function fixture() {
  const game = {
    palette: { accent: '#86ccbb' },
    camera: new THREE.PerspectiveCamera(55, 16 / 9, 0.35, 30000),
    cameraLookTarget: new THREE.Vector3(),
    terrain: { height: () => 0 },
    rocket: { group: new THREE.Group(), update() {}, openDoor() {}, engineGlow: {} },
    spaceSystem: { follow() {} },
    ui: { showPrompt() {}, planetMarker() {} },
    currentPlanetId: 'verdant',
    exitPlanetToSpace() {},
    enterCockpit() {},
    finishLanding() {},
  };
  game.player = new PlayerController(game);
  game.player.terrain = game.terrain;
  game.flight = new FlightSystem(game);
  return game;
}

for (const phase of ['approach', 'reentry']) {
  test(`${phase}: stable camera basis and short turn across +/- PI`, () => {
    const g = fixture(), f = g.flight, s = f.shipState;
    f.targetPlanet = 'verdant';
    s.pos.set(-1, 40, 1200);
    s.yaw = Math.PI - 0.002;
    s.pitch = 0.1;
    f.setPhase(phase);
    f.update(1 / 60, idle());
    const forward = new THREE.Vector3(0, 1, 0).applyQuaternion(g.rocket.group.quaternion);
    assert.ok(Math.abs(g.camera.up.dot(forward)) < 1e-6, 'camera up must be perpendicular to ship forward');
    assert.ok(Math.abs(s.yaw - (Math.PI - 0.002)) < 0.01, 'autopilot must take the short turn');
    assert.ok(g.camera.quaternion.toArray().every(Number.isFinite));
  });
}

test('launch -> space initializes ship and camera in the same frame', () => {
  const g = fixture(), f = g.flight;
  g.camera.position.set(6, 3, 8);
  f.beginLaunch('emer');
  f.phaseT = 9.2;
  f.update(1 / 60, idle());
  assert.equal(f.phase, 'space');
  assert.ok(g.rocket.group.position.distanceTo(f.shipState.pos) < 1e-6);
  assert.ok(g.camera.position.distanceTo(f.shipState.pos) < 30);
});

test('boarding camera stays outside hull and ends facing out of the cockpit', () => {
  const g = fixture(), f = g.flight;
  const yaw = 1.1;
  g.rocket.group.rotation.y = yaw;
  g.camera.position.set(-4, 3, -4);
  g.camera.lookAt(g.rocket.group.position);
  f.beginBoard();
  for (let i = 0; i < 150 && f.phase === 'board'; i++) {
    f.update(1 / 60, idle());
    assert.ok(Math.hypot(g.camera.position.x, g.camera.position.z) >= 0.85 - 1e-6);
  }
  const forward = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
  assert.ok(g.camera.getWorldDirection(new THREE.Vector3()).dot(forward) > 0.99);
});

test('launch first frame does not snap position or reverse cockpit orientation', () => {
  const g = fixture(), f = g.flight;
  g.camera.position.set(0, 2.35, 0.85);
  g.camera.lookAt(0, 2.1, 6.5);
  const pos = g.camera.position.clone(), q = g.camera.quaternion.clone();
  f.beginLaunch('emer');
  f.update(1 / 60, idle());
  assert.ok(g.camera.position.distanceTo(pos) < 0.5);
  assert.ok(g.camera.quaternion.angleTo(q) < 0.01);
});

test('automatic pointer lock rejection after landing is handled', async () => {
  Input.prototype.requestLock.call({ isTouch: false, canvas: {
    requestPointerLock: () => Promise.reject(new Error('No user gesture')),
  } });
  await new Promise(resolve => setImmediate(resolve));
});

for (const fps of [30, 60, 144]) {
  test(`space camera keeps ship in frame at warp speed (${fps} fps)`, () => {
    const g = fixture(), f = g.flight, s = f.shipState;
    f.enterSpace('verdant');
    s.pos.set(10000, 10000, 10000);
    s.throttle = 1;
    s.speed = 900;
    s.warp = 1;
    for (let i = 0; i < fps * 2; i++) f.updateSpace(1 / fps, { ...idle(), sprint: true });
    assert.ok(g.camera.position.distanceTo(s.pos) < 30, 'camera must follow ship translation without hundreds of metres of lag');
  });
}

test('atmos -> landing preserves altitude and landing heading', () => {
  const g = fixture(), f = g.flight;
  g.landingStartY = 40;
  f.landingYaw = 1.3;
  g.rocket.group.position.set(0, 40, 0);
  f.setPhase('atmos');
  for (let i = 0; i < 400 && f.phase === 'atmos'; i++) f.update(1 / 60, idle());
  const pos = g.rocket.group.position.clone();
  const q = g.rocket.group.quaternion.clone();
  f.update(1 / 60, idle());
  assert.ok(g.rocket.group.position.distanceTo(pos) < 0.1, 'no altitude snap at landing handoff');
  assert.ok(g.rocket.group.quaternion.angleTo(q) < 0.02, 'door heading must not reset to zero');
});

test('exit animates the visible astronaut and hands camera to surface without a jump', () => {
  const g = fixture(), f = g.flight, p = g.player;
  f.landingYaw = 0.8;
  g.rocket.group.rotation.y = f.landingYaw;
  g.camera.position.set(5, 3, -6);
  f.setPhase('exit');
  for (let i = 0; i < 130 && f.phase === 'exit'; i++) {
    f.update(1 / 60, idle());
    assert.ok(p.object.position.distanceTo(p.pos) < 1e-6, 'rendered astronaut must move with exit path');
  }
  const pos = g.camera.position.clone(), q = g.camera.quaternion.clone();
  p.updateCamera(1 / 60, g.camera, idle());
  assert.ok(g.camera.position.distanceTo(pos) < 0.06, 'first surface frame must preserve exit camera');
  assert.ok(g.camera.quaternion.angleTo(q) < 0.02);
});
