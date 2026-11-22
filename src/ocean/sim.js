// GPU FFT ocean simulation: several cascades (tiles of different world size), each producing
// displacement, slope and foam maps every frame.
import * as THREE from 'three';
import { buildButterfly, buildCascade, makeWaveSystems } from './spectrum.js';

const VERT = /* glsl */ `
in vec3 position;
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const SPECTRUM_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uH0;
uniform float uTime, uN, uL, uW0;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
void main() {
  vec2 idx = floor(gl_FragCoord.xy);
  vec2 n = mix(idx, idx - uN, step(uN * 0.5, idx));
  vec2 k = n * (6.28318530718 / uL);
  float kl = length(k);
  // quantise the dispersion so the animation loops exactly and time can be wrapped
  float w = floor(sqrt(9.81 * kl) / uW0 + 0.5) * uW0;
  vec4 h0 = texelFetch(uH0, ivec2(idx), 0);
  float ph = w * uTime;
  float c = cos(ph), s = sin(ph);
  vec2 h = vec2(h0.x * c + h0.y * s, h0.y * c - h0.x * s) + vec2(h0.z * c - h0.w * s, h0.w * c + h0.z * s);
  vec2 ih = vec2(-h.y, h.x);
  float ik = kl > 1e-6 ? 1.0 / kl : 0.0;
  vec2 dx = ih * (k.x * ik);
  vec2 dz = ih * (k.y * ik);
  vec2 dxdz = -h * (k.x * k.y * ik);
  vec2 sx = ih * k.x;
  vec2 sz = ih * k.y;
  vec2 dxdx = -h * (k.x * k.x * ik);
  vec2 dzdz = -h * (k.y * k.y * ik);
  // two real-valued fields are packed into each complex number (A + iB)
  o0 = vec4(dx.x - h.y, dx.y + h.x, dz.x - dxdz.y, dz.y + dxdz.x);
  o1 = vec4(sx.x - sz.y, sx.y + sz.x, dxdx.x - dzdz.y, dxdx.y + dzdz.x);
}
`;

const FFT_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uIn0, uIn1, uButterfly;
uniform int uStage, uDir;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
vec4 cmul(vec2 w, vec4 v) {
  return vec4(w.x * v.x - w.y * v.y, w.x * v.y + w.y * v.x, w.x * v.z - w.y * v.w, w.x * v.w + w.y * v.z);
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int i = uDir == 0 ? p.x : p.y;
  vec4 b = texelFetch(uButterfly, ivec2(uStage, i), 0);
  ivec2 pa = uDir == 0 ? ivec2(int(b.z), p.y) : ivec2(p.x, int(b.z));
  ivec2 pb = uDir == 0 ? ivec2(int(b.w), p.y) : ivec2(p.x, int(b.w));
  o0 = texelFetch(uIn0, pa, 0) + cmul(b.xy, texelFetch(uIn0, pb, 0));
  o1 = texelFetch(uIn1, pa, 0) + cmul(b.xy, texelFetch(uIn1, pb, 0));
}
`;

const MERGE_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uA, uB, uPrev;
uniform float uLambda, uDt, uFoamBias, uFoamDecay, uFoamGain;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 a = texelFetch(uA, p, 0); // Dx, Dy, Dz, dDx/dz
  vec4 b = texelFetch(uB, p, 0); // dDy/dx, dDy/dz, dDx/dx, dDz/dz
  float jxx = 1.0 + uLambda * b.z;
  float jzz = 1.0 + uLambda * b.w;
  float jxz = uLambda * a.w;
  float J = jxx * jzz - jxz * jxz;
  float foam = texelFetch(uPrev, p, 0).a * exp(-uDt * uFoamDecay);
  foam = max(foam, clamp((uFoamBias - J) * uFoamGain, 0.0, 1.0));
  o0 = vec4(uLambda * a.x, a.y, uLambda * a.z, foam);
  o1 = vec4(b.x, b.y, uLambda * b.z, uLambda * b.w);
}
`;

const PROBE_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uD0, uD1, uD2, uD3;
uniform vec4 uInvL;
uniform vec2 uProbes[PROBE_COUNT];
out vec4 o;
vec3 disp(vec2 q) {
  return textureLod(uD0, q * uInvL.x, 0.0).xyz + textureLod(uD1, q * uInvL.y, 0.0).xyz
       + textureLod(uD2, q * uInvL.z, 1.0).xyz;
}
void main() {
  vec2 xz = uProbes[int(gl_FragCoord.x)];
  vec2 q = xz;
  vec3 d = vec3(0.0);
  for (int i = 0; i < 4; i++) { d = disp(q); q = xz - d.xz; }
  d = disp(q);
  o = vec4(d.y, d.x, d.z, 1.0);
}
`;

export const PROBE_COUNT = 24;
const LOOP_PERIOD = 1200; // seconds

export class OceanSim {
  constructor(renderer, { N = 512, lengths = [1171, 211, 37, 6.1] } = {}) {
    this.renderer = renderer;
    this.N = N;
    this.lengths = lengths;
    this.lambda = 1.0;
    this.foamBias = 0.72;
    this.foamDecay = 0.35;
    this.time = 0;
    this.frame = 0;

    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.quad = new THREE.Mesh(tri);
    this.quad.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.quad);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    const raw = (frag, uniforms, defines) =>
      new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: frag, uniforms, defines,
        depthTest: false, depthWrite: false,
      });

    const bf = buildButterfly(N);
    this.stages = bf.stages;
    this.butterfly = new THREE.DataTexture(bf.data, bf.stages, N, THREE.RGBAFormat, THREE.FloatType);
    this.butterfly.needsUpdate = true;

    const fftRT = () =>
      new THREE.WebGLRenderTarget(N, N, {
        count: 2, type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: false,
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      });
    this.ping = fftRT();
    this.pong = fftRT();

    const maxAniso = renderer.capabilities.getMaxAnisotropy();
    const outRT = () => {
      const rt = new THREE.WebGLRenderTarget(N, N, {
        count: 2, type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false,
        minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
        wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, generateMipmaps: true,
      });
      for (const t of rt.textures) t.anisotropy = maxAniso;
      return rt;
    };

    this.cascades = lengths.map((L, i) => ({
      L, index: i, h0: null, out: [outRT(), outRT()], cur: 0, stats: null,
      get disp() { return this.out[this.cur].textures[0]; },
      get deriv() { return this.out[this.cur].textures[1]; },
    }));

    this.spectrumMat = raw(SPECTRUM_FRAG, {
      uH0: { value: null }, uTime: { value: 0 }, uN: { value: N }, uL: { value: 1 },
      uW0: { value: (2 * Math.PI) / LOOP_PERIOD },
    });
    this.fftMat = raw(FFT_FRAG, {
      uIn0: { value: null }, uIn1: { value: null }, uButterfly: { value: this.butterfly },
      uStage: { value: 0 }, uDir: { value: 0 },
    });
    this.mergeMat = raw(MERGE_FRAG, {
      uA: { value: null }, uB: { value: null }, uPrev: { value: null }, uLambda: { value: 1 }, uDt: { value: 0 },
      uFoamBias: { value: 0.7 }, uFoamDecay: { value: 0.3 }, uFoamGain: { value: 2.5 },
    });

    this.probes = Array.from({ length: PROBE_COUNT }, () => new THREE.Vector2());
    this.probeResult = new Float32Array(PROBE_COUNT * 4);
    this.probeBuffer = new Float32Array(PROBE_COUNT * 4);
    this.probeRT = new THREE.WebGLRenderTarget(PROBE_COUNT, 1, {
      type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: false,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    });
    this.probeMat = raw(PROBE_FRAG, {
      uD0: { value: null }, uD1: { value: null }, uD2: { value: null }, uD3: { value: null },
      uInvL: { value: new THREE.Vector4(...lengths.map((l) => 1 / l)) }, uProbes: { value: this.probes },
    }, { PROBE_COUNT });
    this.probePending = false;
    this.probeSync = false;
  }

  /** (Re)generate the initial spectra for all cascades. */
  setSpectrum(params) {
    const { N, lengths } = this;
    const systems = makeWaveSystems(params);
    const bounds = lengths.map((L, i) => (i === 0 ? 0 : (6 * 2 * Math.PI) / L));
    bounds.push(((Math.PI * N) / lengths[lengths.length - 1]) * 0.8);
    let heightVar = 0;
    this.cascades.forEach((c, i) => {
      const r = buildCascade(N, c.L, bounds[i], bounds[i + 1], systems, 1337 + i * 7919, {
        smallWaveFade: params.smallWaveFade ?? 0,
      });
      if (c.h0) c.h0.dispose();
      c.h0 = new THREE.DataTexture(r.data, N, N, THREE.RGBAFormat, THREE.FloatType);
      c.h0.needsUpdate = true;
      c.stats = r;
      heightVar += r.heightVar;
    });
    this.significantHeight = 4 * Math.sqrt(heightVar);
  }

  /** Lookup of per-axis slope variance lost per mip level: width = mips, height = cascades. */
  makeVarianceTexture() {
    const mips = Math.log2(this.N) + 1;
    const n = this.cascades.length;
    if (!this.varTex) {
      this.varData = new Float32Array(mips * n * 4);
      this.varTex = new THREE.DataTexture(this.varData, mips, n, THREE.RGBAFormat, THREE.FloatType);
      this.varTex.minFilter = this.varTex.magFilter = THREE.NearestFilter;
    }
    this.cascades.forEach((c, j) => {
      for (let l = 0; l < mips; l++) this.varData[(j * mips + l) * 4] = c.stats.slopeVarLost[l];
    });
    this.varTex.needsUpdate = true;
    return this.varTex;
  }

  _pass(material, target) {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.camera);
  }

  update(time, dt) {
    const r = this.renderer;
    const prevAuto = r.autoClear;
    const prevRT = r.getRenderTarget();
    r.autoClear = false;
    this.time = time;
    const t = time % LOOP_PERIOD;
    for (const c of this.cascades) {
      const su = this.spectrumMat.uniforms;
      su.uH0.value = c.h0;
      su.uTime.value = t;
      su.uL.value = c.L;
      this._pass(this.spectrumMat, this.ping);
      let src = this.ping, dst = this.pong;
      const fu = this.fftMat.uniforms;
      for (let dir = 0; dir < 2; dir++) {
        fu.uDir.value = dir;
        for (let s = 0; s < this.stages; s++) {
          fu.uStage.value = s;
          fu.uIn0.value = src.textures[0];
          fu.uIn1.value = src.textures[1];
          this._pass(this.fftMat, dst);
          const tmp = src; src = dst; dst = tmp;
        }
      }
      const mu = this.mergeMat.uniforms;
      const prev = c.out[c.cur];
      const next = c.out[1 - c.cur];
      mu.uA.value = src.textures[0];
      mu.uB.value = src.textures[1];
      mu.uPrev.value = prev.textures[0];
      mu.uLambda.value = this.lambda;
      mu.uDt.value = this.frame === 0 ? 0 : dt;
      mu.uFoamBias.value = this.foamBias;
      mu.uFoamDecay.value = this.foamDecay;
      this._pass(this.mergeMat, next);
      c.cur = 1 - c.cur;
    }
    this._probe();
    this.frame++;
    r.setRenderTarget(prevRT);
    r.autoClear = prevAuto;
  }

  _probe() {
    if (this.probePending) return;
    const pu = this.probeMat.uniforms;
    pu.uD0.value = this.cascades[0].disp;
    pu.uD1.value = this.cascades[1].disp;
    pu.uD2.value = this.cascades[2].disp;
    pu.uD3.value = this.cascades[3].disp;
    this._pass(this.probeMat, this.probeRT);
    if (this.probeSync) {
      this.renderer.readRenderTargetPixels(this.probeRT, 0, 0, PROBE_COUNT, 1, this.probeResult);
      return;
    }
    this.probePending = true;
    this.renderer
      .readRenderTargetPixelsAsync(this.probeRT, 0, 0, PROBE_COUNT, 1, this.probeBuffer)
      .then(() => { this.probeResult.set(this.probeBuffer); })
      .catch(() => { this.probeSync = true; })
      .finally(() => { this.probePending = false; });
  }

  /** Water height (y) at probe i, as of the last completed readback. */
  probeHeight(i) { return this.probeResult[i * 4]; }
}
