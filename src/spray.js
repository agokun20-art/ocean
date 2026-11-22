// Spray thrown up where the bow meets the waves: a small pool of soft, lit point sprites.
import * as THREE from 'three';

const COUNT = 1400;

export class Spray {
  constructor() {
    this.pos = new Float32Array(COUNT * 3);
    this.vel = new Float32Array(COUNT * 3);
    this.life = new Float32Array(COUNT * 2); // age, lifetime
    this.info = new Float32Array(COUNT * 2); // size, opacity
    for (let i = 0; i < COUNT; i++) { this.pos[i * 3 + 1] = -1000; this.life[i * 2] = 1; this.life[i * 2 + 1] = 1; }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aInfo', new THREE.BufferAttribute(this.info, 2).setUsage(THREE.DynamicDrawUsage));
    this.uniforms = { uColor: { value: new THREE.Vector3(1, 1, 1) }, uScale: { value: 800 } };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, transparent: true, depthWrite: false, toneMapped: false,
      vertexShader: `
        attribute vec2 aInfo; uniform float uScale; varying float vA;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vA = aInfo.y;
          gl_PointSize = min(aInfo.x * uScale / max(-mv.z, 0.5), 96.0);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform vec3 uColor; varying float vA;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float a = smoothstep(0.5, 0.05, length(c)) * vA;
          if (a < 0.003) discard;
          gl_FragColor = vec4(uColor, a);
        }`,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 20;
    this.next = 0;
    this.carry = 0;
    this.m = new THREE.Vector3();
  }

  setLight(sunE, sunDir, skyE) {
    const s = Math.max(sunDir.y, 0) * 0.6;
    this.uniforms.uColor.value.set(
      (0.8 * (sunE.x * s + skyE.x)) / Math.PI, (0.8 * (sunE.y * s + skyE.y)) / Math.PI, (0.8 * (sunE.z * s + skyE.z)) / Math.PI);
  }

  update(ship, dt, wind) {
    if (dt <= 0) return;
    const sp = ship.speed;
    // more spray the faster she goes and the harder the bow is working
    const work = Math.min(Math.abs(ship.vPitch) * 14 + Math.abs(ship.vHeave) * 0.8, 3);
    const rate = sp > 0.8 ? 26 * sp * sp * (0.25 + work) : 0;
    this.carry += rate * dt;
    const n = Math.min(Math.floor(this.carry), 80);
    this.carry -= Math.floor(this.carry);
    const f = ship.forward;
    const rx = Math.cos(ship.heading), rz = -Math.sin(ship.heading); // ship-space +x in the world
    const level = ship.heave - ship.draft;
    for (let k = 0; k < n; k++) {
      const i = this.next; this.next = (this.next + 1) % COUNT;
      const side = Math.random() < 0.5 ? -1 : 1;
      const back = Math.random() * Math.random() * 6;
      this.m.set(side * (0.25 + back * 0.33), 0, ship.hull.y - 0.6 - back);
      this.m.applyMatrix4(ship.group.matrixWorld);
      this.pos[i * 3] = this.m.x; this.pos[i * 3 + 1] = level + Math.random() * 0.4; this.pos[i * 3 + 2] = this.m.z;
      const out = side * (1.2 + Math.random() * 2.6) * (0.5 + 0.2 * sp);
      const fwd = sp * (0.55 + Math.random() * 0.4);
      this.vel[i * 3] = rx * out + f.x * fwd;
      this.vel[i * 3 + 1] = (0.8 + Math.random() * 2.2) * (0.6 + 0.5 * work) + 0.2 * sp;
      this.vel[i * 3 + 2] = rz * out + f.y * fwd;
      this.life[i * 2] = 0;
      this.life[i * 2 + 1] = 0.55 + Math.random() * 0.9;
      this.info[i * 2] = 0.1 + Math.random() * 0.3;
    }
    const drag = Math.exp(-1.6 * dt);
    for (let i = 0; i < COUNT; i++) {
      const age = (this.life[i * 2] += dt), life = this.life[i * 2 + 1];
      if (age >= life) { this.info[i * 2 + 1] = 0; continue; }
      this.vel[i * 3] = this.vel[i * 3] * drag + wind.x * 0.35 * dt;
      this.vel[i * 3 + 2] = this.vel[i * 3 + 2] * drag + wind.y * 0.35 * dt;
      this.vel[i * 3 + 1] -= 9.81 * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      const t = age / life;
      this.info[i * 2] += 0.5 * dt; // droplets spread into mist
      this.info[i * 2 + 1] = 0.3 * Math.min(t * 8, 1) * (1 - t) * (1 - t);
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.aInfo.needsUpdate = true;
  }
}
