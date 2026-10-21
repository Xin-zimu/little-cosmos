import * as THREE from 'three';
function probe(origin, label) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(1), new THREE.MeshBasicMaterial());
  m.position.set(0,2,-10); m.updateMatrixWorld(true);
  const dir = new THREE.Vector3(0,2,-10).sub(origin).normalize();
  const rc = new THREE.Raycaster(origin, dir, 0, 70);
  console.log(label, 'hits', rc.intersectObject(m,false).length);
}
probe(new THREE.Vector3(0,2,0), 'exact axis (pole/seam)');
probe(new THREE.Vector3(0.05,2.02,0), 'slightly off-axis');
probe(new THREE.Vector3(0,2.05,0), 'slightly above');
// box for comparison
const b = new THREE.Mesh(new THREE.BoxGeometry(2,2,2), new THREE.MeshBasicMaterial());
b.position.set(0,2,-10); b.updateMatrixWorld(true);
console.log('box exact', new THREE.Raycaster(new THREE.Vector3(0,2,0), new THREE.Vector3(0,0,-1),0,70).intersectObject(b,false).length);
