import * as THREE from 'three';
const NOSE = new THREE.Vector3(0,1,0);
function dirFrom(yaw,pitch){const cp=Math.cos(pitch);return new THREE.Vector3(Math.sin(yaw)*cp,Math.sin(pitch),Math.cos(yaw)*cp);}
function quatFor(dir,roll){const q=new THREE.Quaternion().setFromUnitVectors(NOSE,dir);if(roll)q.premultiply(new THREE.Quaternion().setFromAxisAngle(dir,roll));return q;}
// 复刻 updateSpace 的相机计算
function camBasis(yaw,pitch,roll){
  const forward = dirFrom(yaw,pitch);
  const q = quatFor(forward, roll);
  const back = forward.clone().negate();
  const up = new THREE.Vector3(0,1,0).applyQuaternion(q);
  const side = new THREE.Vector3().crossVectors(forward, up).normalize();
  const pos = new THREE.Vector3(0,0,0)
    .addScaledVector(back, 13.0).addScaledVector(up, 4.2).addScaledVector(side, 17.0);
  const look = new THREE.Vector3(0,0,0).addScaledVector(forward, 9.0).addScaledVector(up, 1.6);
  return {forward, up, side, pos, look};
}
let prev = null;
const rows = [];
for (let i=0;i<=40;i++){
  const yaw = 0.4 + i*0.02, pitch = 0.1;
  const b = camBasis(yaw,pitch,0);
  const cam = new THREE.PerspectiveCamera(60,16/9,0.1,10000);
  cam.position.copy(b.pos); cam.up.copy(b.up); cam.lookAt(b.look); cam.updateMatrixWorld();
  const dirNow = new THREE.Vector3(0,0,-1).applyQuaternion(cam.quaternion);
  if (prev) {
    const ang = prev.angleTo(dirNow) * 180/Math.PI;
    rows.push({ i, viewTurnDeg:+ang.toFixed(3), yawStepDeg:+(0.02*180/Math.PI).toFixed(3) });
  }
  prev = dirNow;
}
const turns = rows.map(r=>r.viewTurnDeg);
console.log('输入每步 yaw 变化 / 视角实际转动（度）');
console.log('step yawChange viewTurn');
console.log('max viewTurn =', Math.max(...turns).toFixed(3));
console.log('min viewTurn =', Math.min(...turns).toFixed(3));
console.log('mean        =', (turns.reduce((a,b)=>a+b,0)/turns.length).toFixed(3));
console.log('expected    =', (0.02*180/Math.PI).toFixed(3));
console.log('ratio max/expected =', (Math.max(...turns)/(0.02*180/Math.PI)).toFixed(2));
console.log('sample:', rows.slice(0,6).map(r=>r.viewTurnDeg).join(', '), '...');
