
import * as THREE from 'three';
const NOSE = new THREE.Vector3(0,1,0);
function dirFrom(yaw,pitch){const cp=Math.cos(pitch);return new THREE.Vector3(Math.sin(yaw)*cp,Math.sin(pitch),Math.cos(yaw)*cp);}
function quatFor(dir,roll){const q=new THREE.Quaternion().setFromUnitVectors(NOSE,dir);if(roll)q.premultiply(new THREE.Quaternion().setFromAxisAngle(dir,roll));return q;}
for (const [yaw,pitch,roll] of [[0.3,0.2,0],[1.1,-0.4,0.2],[2.4,0.55,-0.3]]) {
  const forward = dirFrom(yaw,pitch);
  const q = quatFor(forward, roll);
  const up = new THREE.Vector3(0,1,0).applyQuaternion(q);
  const side = new THREE.Vector3().crossVectors(forward, up).normalize();
  console.log(JSON.stringify({
    yaw, pitch,
    forward: forward.toArray().map(v=>+v.toFixed(4)),
    up: up.toArray().map(v=>+v.toFixed(4)),
    'up.dot(forward)': +up.dot(forward).toFixed(6),
    'side.length': +side.length().toFixed(6),
    side: side.toArray().map(v=>+v.toFixed(4)),
  }));
}
