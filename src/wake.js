// Ship wake: a scrolling world-space map around the ship. R = foam left behind by the hull, G = "calmed"
// water (the turbulent wake smooths small ripples for a long time after the foam is gone).
import * as THREE from 'three';

const FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uPrev, uHullTex;
uniform vec2 uShift, uOrigin, uShipPos, uRight, uAxisZ;
uniform vec4 uHull;
uniform float uSize, uRes, uDt, uSpeed, uFwd, uTime;
out vec4 o;

float hullHalfWidth(float z) {
  float t = clamp((z - uHull.x) / (uHull.y - uHull.x), 0.0, 1.0) * (uHull.z - 1.0);
  int i = int(floor(t));
  float a = texelFetch(uHullTex, ivec2(i, 0), 0).r;
  float b = texelFetch(uHullTex, ivec2(min(i + 1, int(uHull.z) - 1), 0), 0).r;
  return mix(a, b, fract(t));
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 wp = uOrigin + uv * uSize;
  vec2 rel = wp - uShipPos;
  vec2 lp = vec2(dot(rel, uRight), dot(rel, uAxisZ));
  float along = (lp.y - uHull.x) / (uHull.y - uHull.x); // 0..1 along the hull
  float bowT = uFwd > 0.0 ? along : 1.0 - along;      // 1 at the bow
  float behind = (uFwd > 0.0 ? uHull.x - lp.y : lp.y - uHull.y); // metres behind the stern

  // the wake spreads sideways as it ages
  float spread = 0.55 * smoothstep(30.0, 3.0, abs(lp.x)) * step(bowT, 1.05);
  vec2 vel = uRight * sign(lp.x) * spread;
  vec2 src = uv + uShift - vel * uDt / uSize;
  float px = 1.0 / uRes;
  vec4 prev = texture(uPrev, src) * 0.72 + 0.07 * (texture(uPrev, src + vec2(px, 0.0)) + texture(uPrev, src - vec2(px, 0.0))
            + texture(uPrev, src + vec2(0.0, px)) + texture(uPrev, src - vec2(0.0, px)));
  if (src.x < 0.0 || src.x > 1.0 || src.y < 0.0 || src.y > 1.0) prev = vec4(0.0);
  float foam = max(prev.r * exp(-uDt / 20.0) - uDt * 0.007, 0.0);
  float calm = prev.g * exp(-uDt / 45.0);

  float w = hullHalfWidth(lp.y);
  float dSide = abs(lp.x) - w;
  float inside = step(0.0, along) * step(along, 1.0);
  float sp = clamp(uSpeed / 4.0, 0.0, 1.5);
  float n = noise(wp * 0.9 + uTime * 1.3) * 0.6 + noise(wp * 2.7 - uTime * 2.1) * 0.4;
  // bow wave + turbulence along the sides
  float side = 0.7 * inside * smoothstep(1.1, 0.0, dSide) * step(-1.0, dSide) * (0.35 + 0.65 * smoothstep(0.35, 1.0, bowT));
  // churned water directly behind the stern
  float stern = smoothstep(7.0, 0.0, behind) * step(0.0, behind) * smoothstep(w + 2.2, w * 0.3, abs(lp.x));
  float inject = max(side, stern * 0.9) * sp * (0.55 + 0.75 * n);
  foam = max(foam, inject);
  calm = max(calm, max(inside * smoothstep(2.5, 0.0, dSide), stern) * min(sp * 2.0, 1.0));
  o = vec4(foam, calm, 0.0, 1.0);
}
`;

export class Wake {
  constructor(renderer, { size = 256, res = 1024 } = {}) {
    this.renderer = renderer;
    this.size = size;
    this.res = res;
    this.texel = size / res;
    const make = () => new THREE.WebGLRenderTarget(res, res, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    });
    this.targets = [make(), make()];
    this.cur = 0;
    this.origin = new THREE.Vector2();
    this.first = true;
    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: `in vec3 position; void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: FRAG,
      depthTest: false, depthWrite: false,
      uniforms: {
        uPrev: { value: null }, uHullTex: { value: null }, uShift: { value: new THREE.Vector2() },
        uOrigin: { value: new THREE.Vector2() }, uShipPos: { value: new THREE.Vector2() },
        uRight: { value: new THREE.Vector2() }, uAxisZ: { value: new THREE.Vector2() },
        uHull: { value: new THREE.Vector4() }, uSize: { value: size }, uRes: { value: res },
        uDt: { value: 0 }, uSpeed: { value: 0 }, uFwd: { value: 1 }, uTime: { value: 0 },
      },
    });
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.quad = new THREE.Mesh(tri, this.material);
    this.quad.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.quad);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  get texture() { return this.targets[this.cur].texture; }

  update(ship, dt, time) {
    if (!ship.hullTex) return;
    const u = this.material.uniforms;
    const t = this.texel;
    // keep the ship slightly ahead of centre so more of the trail fits in the map
    const f = ship.forward;
    const cx = ship.position.x - f.x * this.size * 0.3, cz = ship.position.y - f.y * this.size * 0.3;
    const ox = Math.floor((cx - this.size / 2) / t) * t, oz = Math.floor((cz - this.size / 2) / t) * t;
    if (this.first) { this.origin.set(ox, oz); }
    u.uShift.value.set((ox - this.origin.x) / this.size, (oz - this.origin.y) / this.size);
    this.origin.set(ox, oz);
    u.uOrigin.value.copy(this.origin);
    u.uShipPos.value.copy(ship.position);
    const s = Math.sin(ship.heading), c = Math.cos(ship.heading);
    u.uRight.value.set(c, -s);
    u.uAxisZ.value.set(s, c);
    u.uHull.value.copy(ship.hull);
    u.uHullTex.value = ship.hullTex;
    u.uDt.value = this.first ? 0 : dt;
    u.uSpeed.value = ship.speed;
    u.uFwd.value = ship.forwardSign;
    u.uTime.value = time;
    u.uPrev.value = this.targets[this.cur].texture;
    const r = this.renderer;
    const prevRT = r.getRenderTarget();
    r.setRenderTarget(this.targets[1 - this.cur]);
    r.render(this.scene, this.camera);
    r.setRenderTarget(prevRT);
    this.cur = 1 - this.cur;
    this.first = false;
  }
}
