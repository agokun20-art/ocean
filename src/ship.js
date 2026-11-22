// The ship: CC0 scanned-quality pinnace from Poly Haven, floating on the simulated waves.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const HULL_LUT = 64;
const PROBE_X = [-3.2, 0, 3.2];
const PROBE_Z = [-13, -6.5, 0, 6.5, 13];

export class Ship {
  constructor() {
    this.group = new THREE.Group();
    this.group.rotation.order = 'YXZ';
    this.position = new THREE.Vector2(0, 0);
    this.heading = 0;
    this.speed = 3.2;
    this.draft = -0.45;
    this.heel = 0.045;
    this.heave = 0; this.pitch = 0; this.roll = 0;
    this.vHeave = 0; this.vPitch = 0; this.vRoll = 0;
    this.forwardSign = 1;
    this.hull = new THREE.Vector4(-15, 15, HULL_LUT, 0);
    this.hullTex = null;
    this.inverse = new THREE.Matrix4();
    this.initialised = false;
    this.sunUniforms = { uSunDirW: { value: new THREE.Vector3(0, 1, 0) }, uSunCol: { value: new THREE.Vector3() } };
  }

  async load(url, renderer, onProgress) {
    const gltf = await new GLTFLoader().loadAsync(url, onProgress);
    const model = gltf.scene;
    const aniso = Math.min(16, renderer.capabilities.getMaxAnisotropy());
    model.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.receiveShadow = true;
      const m = o.material;
      for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'alphaMap']) {
        if (m[key]) m[key].anisotropy = aniso;
      }
      if (/sails/.test(m.name)) {
        m.side = THREE.DoubleSide;
        m.alphaTest = 0.5;
        m.transparent = false;
        m.shadowSide = THREE.DoubleSide;
        // canvas is translucent: sunlight hitting the far side glows through
        m.onBeforeCompile = (shader) => {
          Object.assign(shader.uniforms, this.sunUniforms);
          shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', '#include <common>\nuniform vec3 uSunDirW, uSunCol;')
            .replace('#include <aomap_fragment>', `{
              vec3 Lv = normalize((viewMatrix * vec4(uSunDirW, 0.0)).xyz);
              float back = max(dot(-normal, Lv), 0.0);
              reflectedLight.directDiffuse += uSunCol * diffuseColor.rgb * RECIPROCAL_PI * back * 0.55;
            }
            #include <aomap_fragment>`);
        };
      }
      m.envMapIntensity = 1.25;
    });
    this.model = model;
    this.group.add(model);
    this._buildHullOutline();
    return this;
  }

  /** Half-width of the hull along its length at the waterline, from the actual mesh. */
  _buildHullOutline() {
    const zs = [], xs = [];
    const v = new THREE.Vector3();
    this.model.updateMatrixWorld(true);
    this.model.traverse((o) => {
      if (!o.isMesh || !/hull/.test(o.material.name)) return;
      const p = o.geometry.attributes.position;
      for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld);
        if (v.y > -0.7 && v.y < 0.5) { zs.push(v.z); xs.push(Math.abs(v.x)); }
      }
    });
    if (!zs.length) return;
    let z0 = Infinity, z1 = -Infinity;
    for (const z of zs) { z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    const lut = new Float32Array(HULL_LUT).fill(-1);
    for (let i = 0; i < zs.length; i++) {
      const b = Math.min(HULL_LUT - 1, Math.floor(((zs[i] - z0) / (z1 - z0)) * HULL_LUT));
      lut[b] = Math.max(lut[b], xs[i]);
    }
    for (let i = 0; i < HULL_LUT; i++) {
      if (lut[i] >= 0) continue;
      let a = i - 1, b = i + 1;
      while (b < HULL_LUT && lut[b] < 0) b++;
      const va = a >= 0 ? lut[a] : 0, vb = b < HULL_LUT ? lut[b] : 0;
      lut[i] = va + ((vb - va) * (i - a)) / (b - a);
    }
    const data = new Float32Array(HULL_LUT * 4);
    for (let i = 0; i < HULL_LUT; i++) {
      const s = (lut[Math.max(i - 1, 0)] + 2 * lut[i] + lut[Math.min(i + 1, HULL_LUT - 1)]) / 4;
      data[i * 4] = s;
    }
    this.hullLut = lut;
    this.hullTex = new THREE.DataTexture(data, HULL_LUT, 1, THREE.RGBAFormat, THREE.FloatType);
    this.hullTex.needsUpdate = true;
    this.hull.set(z0, z1, HULL_LUT, 1);
  }

  get forward() {
    return new THREE.Vector2(Math.sin(this.heading), Math.cos(this.heading)).multiplyScalar(this.forwardSign);
  }

  /** Write the hull sample points into the simulation's probe list (indices 0..14). */
  writeProbes(probes) {
    const s = Math.sin(this.heading), c = Math.cos(this.heading);
    let i = 0;
    for (const lz of PROBE_Z) for (const lx of PROBE_X) {
      probes[i++].set(this.position.x + lx * c + lz * s, this.position.y - lx * s + lz * c);
    }
    return i;
  }

  update(dt, sim) {
    const f = this.forward;
    this.position.addScaledVector(f, this.speed * dt);

    // least-squares plane through the water heights under the hull
    let a = 0, bx = 0, bz = 0, sxx = 0, szz = 0, i = 0;
    for (const lz of PROBE_Z) for (const lx of PROBE_X) {
      const h = sim.probeHeight(i++);
      a += h; bx += h * lx; bz += h * lz; sxx += lx * lx; szz += lz * lz;
    }
    a /= i; bx /= sxx; bz /= szz;
    const tHeave = a + this.draft;
    const tRoll = Math.atan(bx) * 0.85 + this.heel;
    const tPitch = -Math.atan(bz) * 0.9;
    if (!this.initialised) {
      this.heave = tHeave; this.roll = tRoll; this.pitch = tPitch;
      this.initialised = sim.frame > 2;
    }
    const steps = Math.max(1, Math.ceil(dt / 0.01));
    const h = dt / steps;
    for (let s = 0; s < steps; s++) {
      this.vHeave += (2.2 * 2.2 * (tHeave - this.heave) - 2 * 0.6 * 2.2 * this.vHeave) * h;
      this.vPitch += (1.9 * 1.9 * (tPitch - this.pitch) - 2 * 0.55 * 1.9 * this.vPitch) * h;
      this.vRoll += (1.25 * 1.25 * (tRoll - this.roll) - 2 * 0.32 * 1.25 * this.vRoll) * h;
      this.heave += this.vHeave * h; this.pitch += this.vPitch * h; this.roll += this.vRoll * h;
    }

    const g = this.group;
    g.position.set(this.position.x, this.heave, this.position.y);
    g.rotation.set(this.pitch, this.heading, this.roll);
    g.updateMatrixWorld(true);
    this.inverse.copy(g.matrixWorld).invert();
    this.writeProbes(sim.probes);
  }
}
