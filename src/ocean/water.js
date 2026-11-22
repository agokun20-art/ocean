// Ocean surface: camera-centred polar grid displaced by the FFT cascades, shaded with a physically
// based water model (Fresnel sky reflection, sun glitter, subsurface scattering, foam, refraction).
import * as THREE from 'three';
import { SKY_GLSL } from '../sky.js';

const COMMON = /* glsl */ `
uniform sampler2D uD0, uD1, uD2, uD3;
uniform sampler2D uS0, uS1, uS2, uS3;
uniform vec4 uInvL;
uniform float uN;
`;

const VERT = /* glsl */ `
${COMMON}
uniform vec2 uCenter;
uniform float uA, uB, uRings, uSectors;
out vec2 vXZ;
out vec3 vWorld;
out float vViewZ;
void main() {
  float t = position.x;
  float ang = position.y * 6.28318530718;
  float r = uA * (exp(uB * t) - 1.0);
  vec2 xz = uCenter + r * vec2(cos(ang), sin(ang));
  // sample each cascade at a mip level matching the local vertex spacing (band-limited, no swimming)
  float spacing = max((r + uA) * uB / uRings, r * 6.28318530718 / uSectors);
  vec4 lod = max(log2(spacing * uN * uInvL) + 0.5, 0.0);
  vec3 d = textureLod(uD0, xz * uInvL.x, lod.x).xyz + textureLod(uD1, xz * uInvL.y, lod.y).xyz
         + textureLod(uD2, xz * uInvL.z, lod.z).xyz + textureLod(uD3, xz * uInvL.w, lod.w).xyz;
  vec3 wp = vec3(xz.x, 0.0, xz.y) + d;
  vXZ = xz;
  vWorld = wp;
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  vViewZ = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
${COMMON}
#include <packing>
in vec2 vXZ;
in vec3 vWorld;
in float vViewZ;
out vec4 fragColor;

uniform sampler2D uVarTex;
uniform sampler2D uRefr, uRefrDepth, uRefl, uShadowMap, uWake, uFoamTex, uHullTex;
uniform mat4 uReflMatrix, uShadowMatrix, uShipInv;
uniform vec2 uResolution, uWakeOrigin;
uniform vec4 uHull; // zStern, zBow, lut size, enabled
uniform float uWakeSize, uNear, uFar, uTime, uHs, uShadowOn;
uniform vec3 uSunDir, uSunColor, uSkyIrr;
uniform vec3 uScatter, uSSSColor, uAbsorb, uBubbleColor;
uniform float uFogDensity, uFoamAmount, uSSS, uSpecClamp, uReflOn, uRoughBoost;
${SKY_GLSL}

const float PI = 3.14159265359;

float lostVariance(float footprint) {
  vec4 lod = clamp(log2(max(footprint, 1e-6) * uN * uInvL), 0.0, log2(uN));
  float v = 0.0;
  for (int i = 0; i < 4; i++) {
    float l = lod[i];
    int l0 = int(floor(l));
    float a = texelFetch(uVarTex, ivec2(l0, i), 0).r;
    float b = texelFetch(uVarTex, ivec2(min(l0 + 1, int(log2(uN))), i), 0).r;
    v += mix(a, b, fract(l));
  }
  return v;
}

float meanFresnel(float cosV, float sigma) {
  return pow(1.0 - cosV, 5.0 * exp(-2.69 * sigma)) / (1.0 + 22.7 * pow(sigma, 1.5));
}

float smithLambda(float cosT, float sigma2) {
  float a = cosT / sqrt(max((1.0 - cosT * cosT) * 2.0 * sigma2, 1e-9));
  return a < 1.6 ? (1.0 - 1.259 * a + 0.396 * a * a) / (3.535 * a + 2.181 * a * a) : 0.0;
}

float linearDepth(float d) {
  float z = d * 2.0 - 1.0;
  return 2.0 * uNear * uFar / (uFar + uNear - z * (uFar - uNear));
}

float hullHalfWidth(float z) {
  float t = clamp((z - uHull.x) / (uHull.y - uHull.x), 0.0, 1.0) * (uHull.z - 1.0);
  int i = int(floor(t));
  float a = texelFetch(uHullTex, ivec2(i, 0), 0).r;
  float b = texelFetch(uHullTex, ivec2(min(i + 1, int(uHull.z) - 1), 0), 0).r;
  return mix(a, b, fract(t));
}

// approximate signed distance (m) to the hull's waterline outline, in ship space
float hullDistance(vec2 p) {
  float w = hullHalfWidth(p.y);
  float dSide = abs(p.x) - w;
  float dEnd = max(uHull.x - p.y, p.y - uHull.y);
  return dEnd > 0.0 ? length(vec2(max(dSide, 0.0), dEnd)) : dSide;
}

float sunShadow(vec3 wp) {
  if (uShadowOn < 0.5) return 1.0;
  vec4 sc = uShadowMatrix * vec4(wp, 1.0);
  sc.xyz /= sc.w;
  if (sc.x < 0.0 || sc.x > 1.0 || sc.y < 0.0 || sc.y > 1.0 || sc.z > 1.0) return 1.0;
  float s = 0.0;
  const float r = 2.2 / 4096.0;
  for (int i = -1; i <= 1; i++) for (int j = -1; j <= 1; j++) {
    float d = unpackRGBAToDepth(texture(uShadowMap, sc.xy + vec2(float(i), float(j)) * r));
    s += step(sc.z - 0.0015, d);
  }
  return s / 9.0;
}

void main() {
  vec3 toCam = cameraPosition - vWorld;
  float dist = length(toCam);
  vec3 V = toCam / dist;
  vec3 L = uSunDir;

  // --- surface detail -----------------------------------------------------------------------------
  vec2 dxz = dFdx(vXZ), dyz = dFdy(vXZ);
  float pmax = max(dot(dxz, dxz), dot(dyz, dyz));
  float pmin = min(dot(dxz, dxz), dot(dyz, dyz));
  float footprint = sqrt(max(pmin, pmax / 256.0));

  vec2 uv0 = vXZ * uInvL.x, uv1 = vXZ * uInvL.y, uv2 = vXZ * uInvL.z, uv3 = vXZ * uInvL.w;
  vec4 s0 = texture(uS0, uv0), s1 = texture(uS1, uv1), s2 = texture(uS2, uv2), s3 = texture(uS3, uv3);
  vec4 a0 = texture(uD0, uv0), a1 = texture(uD1, uv1), a2 = texture(uD2, uv2);
  float height = a0.y + a1.y + a2.y;

  // ship wake: foam trail + calmed small ripples
  vec2 wuv = (vWorld.xz - uWakeOrigin) / uWakeSize;
  vec4 wake = vec4(0.0);
  if (wuv.x > 0.0 && wuv.x < 1.0 && wuv.y > 0.0 && wuv.y < 1.0) {
    vec2 e = smoothstep(vec2(0.0), vec2(0.04), wuv) * smoothstep(vec2(1.0), vec2(0.96), wuv);
    wake = texture(uWake, wuv) * e.x * e.y;
  }
  float calm = clamp(wake.g, 0.0, 1.0);
  vec4 deriv = s0 + s1 + s2 * (1.0 - 0.55 * calm) + s3 * (1.0 - 0.85 * calm);
  vec2 slope = deriv.xy / max(1.0 + deriv.zw, vec2(0.25));
  vec3 N = normalize(vec3(-slope.x, 1.0, -slope.y));

  float sigma2 = lostVariance(footprint) * uRoughBoost + 2.0e-5;
  float sigma = sqrt(sigma2);
  float NdotV = clamp(dot(N, V), 0.0, 1.0);

  float shadow = sunShadow(vWorld);

  // --- reflection ---------------------------------------------------------------------------------
  float fres = 0.02 + 0.98 * meanFresnel(NdotV, sigma);
  vec3 R = reflect(-V, N);
  R.y = abs(R.y);
  // unresolved waves tilt the visible facets toward the viewer: the mean reflection looks higher in the sky
  R = normalize(R + vec3(0.0, 1.8 * sigma * (1.0 - R.y), 0.0));
  float skyLod = clamp(log2(1304.0 * sigma + 1.0), 0.0, 8.0);
  vec3 refl = sampleSky(R, skyLod);

  // planar reflection of the ship
  if (uReflOn > 0.5) {
    float k = 3.0;
    vec4 rc = uReflMatrix * vec4(vWorld.x + N.x * k, 0.0, vWorld.z + N.z * k, 1.0);
    vec2 ruv = rc.xy / rc.w;
    if (rc.w > 0.0 && ruv.x > 0.0 && ruv.x < 1.0 && ruv.y > 0.0 && ruv.y < 1.0) {
      vec4 sr = textureLod(uRefl, ruv, clamp(log2(400.0 * sigma + 1.0), 1.0, 5.0));
      refl = refl * (1.0 - sr.a) + sr.rgb;
    }
  }

  // sun glitter (Beckmann slope distribution of the unresolved waves)
  vec3 H = normalize(L + V);
  float zH = max(dot(H, N), 1e-3);
  float zH2 = zH * zH;
  float tan2 = (1.0 - zH2) / zH2;
  float specSigma2 = sigma2 + 6.0e-5;
  float p = exp(-tan2 / (2.0 * specSigma2)) / (2.0 * PI * specSigma2);
  float zL = max(dot(L, N), 0.01), zV = max(dot(V, N), 0.01);
  float fSun = 0.02 + 0.98 * pow(1.0 - max(dot(V, H), 0.0), 5.0);
  float spec = fSun * p / (4.0 * zH2 * zH2 * zV * (1.0 + smithLambda(zL, specSigma2) + smithLambda(zV, specSigma2)));
  vec3 sun = uSunColor * min(spec, uSpecClamp) * shadow * step(0.0, L.y);

  // --- water body ---------------------------------------------------------------------------------
  vec3 Edown = uSunColor * max(L.y, 0.0) * mix(0.35, 1.0, shadow) + uSkyIrr;
  vec3 body = uScatter * Edown / PI;
  // light transmitted through wave crests when looking toward the sun, plus a little forward scatter
  float crest = clamp(height / max(uHs, 0.2) + 0.35, 0.0, 2.0);
  float sss1 = pow(max(dot(L, -V), 0.0) * 0.5 + 0.5, 4.0) * pow(0.5 - 0.5 * dot(L, N), 2.0) * crest;
  float sss2 = pow(NdotV, 2.0) * max(L.y, 0.0);
  body += uSSSColor * uSunColor / PI * mix(0.4, 1.0, shadow) * uSSS * (1.6 * sss1 + 0.12 * sss2);

  // refraction: submerged geometry seen through the surface, attenuated with depth
  vec2 suv = gl_FragCoord.xy / uResolution;
  vec2 ruv2 = suv + N.xz * 0.04 / (1.0 + dist * 0.03);
  float sceneZ = linearDepth(texture(uRefrDepth, ruv2).r);
  if (sceneZ < vViewZ) { ruv2 = suv; sceneZ = linearDepth(texture(uRefrDepth, suv).r); }
  float thickness = max(sceneZ - vViewZ, 0.0);
  float hasScene = step(sceneZ, uFar * 0.5);
  vec3 trans = exp(-uAbsorb * thickness) * hasScene;
  body = mix(body, texture(uRefr, ruv2).rgb * 0.7, trans);

  // --- foam ---------------------------------------------------------------------------------------
  float J = (1.0 + deriv.z) * (1.0 + deriv.w);
  float cover = a0.a * 0.9 + a1.a * 0.75 + a2.a * 0.3;
  cover += smoothstep(0.55, 0.05, J) * 0.8;
  cover *= uFoamAmount;
  cover += wake.r;
  // contact foam where the surface meets the hull
  float lap = texture(uFoamTex, vWorld.xz * 0.37 + vec2(uTime * 0.05, -uTime * 0.03)).g;
  cover += hasScene * smoothstep(0.35, 0.0, thickness) * (0.25 + 0.5 * lap);
  if (uHull.w > 0.5) {
    vec3 lp = (uShipInv * vec4(vWorld, 1.0)).xyz;
    float hd = hullDistance(lp.xz);
    if (hd < -0.45 && abs(lp.y) < 3.0) discard;
    cover += smoothstep(0.8, 0.0, hd) * (0.1 + 0.45 * lap * lap);
  }
  cover = clamp(cover, 0.0, 1.0);
  vec2 fuv = vWorld.xz;
  float n1 = texture(uFoamTex, fuv * 0.085 + vec2(uTime * 0.004, 0.0)).r;
  float n2 = texture(uFoamTex, fuv * 0.23 + vec2(0.0, uTime * 0.007)).r;
  float n3 = texture(uFoamTex, fuv * 0.021).g;
  float pattern = clamp(n1 * 0.6 + n2 * 0.4 + (n3 - 0.5) * 0.5, 0.0, 1.0);
  float foam = smoothstep(1.0 - cover, 1.0 - cover + 0.42, pattern + cover * 0.35);
  foam *= smoothstep(0.0, 0.06, cover);
  // aerated water just under / around the foam
  body = mix(body, uBubbleColor * Edown / PI, clamp(cover * 1.3, 0.0, 1.0) * 0.3);
  vec3 foamCol = 0.82 * (uSunColor * max(dot(normalize(N + vec3(0.0, 1.5, 0.0)), L), 0.0) * shadow + uSkyIrr) / PI;
  // far away the foam pattern is sub-pixel: fade to its average coverage
  float foamFar = cover * cover * 0.6;
  foam = mix(foam, foamFar, smoothstep(0.15, 1.2, footprint));

  vec3 col = mix(body, refl, fres) + sun;
  col = mix(col, foamCol, foam);

  // --- aerial perspective -------------------------------------------------------------------------
  float fog = 1.0 - exp(-dist * uFogDensity);
  vec3 fogCol = min(sampleSky(normalize(vec3(-V.x, 0.05, -V.z)), 6.5), uHorizonColor * 3.0);
  col = mix(col, fogCol, fog);

  fragColor = vec4(col, 1.0);
}
`;

function buildGrid(rings, sectors) {
  const pos = new Float32Array((rings + 1) * (sectors + 1) * 3);
  let o = 0;
  for (let r = 0; r <= rings; r++) {
    for (let s = 0; s <= sectors; s++) {
      pos[o++] = r / rings;
      pos[o++] = s / sectors;
      pos[o++] = 0;
    }
  }
  const idx = new Uint32Array(rings * sectors * 6);
  o = 0;
  const w = sectors + 1;
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < sectors; s++) {
      const a = r * w + s, b = a + 1, c = a + w, d = c + 1;
      idx[o++] = a; idx[o++] = c; idx[o++] = b;
      idx[o++] = b; idx[o++] = c; idx[o++] = d;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  return geo;
}

/** Tileable foam texture: R = bubbly cell network, G = large-scale break-up noise. */
function makeFoamTexture(size = 512) {
  let seed = 12345;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const worley = (cells) => {
    const pts = new Float32Array(cells * cells * 2);
    for (let i = 0; i < pts.length; i++) pts[i] = rnd();
    const out = new Float32Array(size * size * 2);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const px = (x / size) * cells, py = (y / size) * cells;
        const cx = Math.floor(px), cy = Math.floor(py);
        let f1 = 9, f2 = 9;
        for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
          const gx = cx + i, gy = cy + j;
          const k = (((gy % cells) + cells) % cells) * cells + (((gx % cells) + cells) % cells);
          const dx = gx + pts[k * 2] - px, dy = gy + pts[k * 2 + 1] - py;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
        }
        out[(y * size + x) * 2] = f1;
        out[(y * size + x) * 2 + 1] = f2;
      }
    }
    return out;
  };
  const w1 = worley(9), w2 = worley(23), w3 = worley(53), w4 = worley(4), w5 = worley(11);
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const edge = (w, s) => Math.max(0, 1 - (w[i * 2 + 1] - w[i * 2]) * s);
    const net = Math.pow(edge(w1, 2.2), 2.5) * 0.55 + Math.pow(edge(w2, 2.6), 2.2) * 0.45 + Math.pow(edge(w3, 3.0), 2.0) * 0.3;
    const blobs = 1 - Math.min(1, w4[i * 2] * 1.25) * 0.6 - Math.min(1, w5[i * 2] * 1.4) * 0.4;
    data[i * 4] = Math.min(255, Math.max(0, net * 0.8 + w1[i * 2] * 0.35) * 255);
    data[i * 4 + 1] = Math.min(255, Math.max(0, blobs) * 255);
    data[i * 4 + 2] = 0;
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

const black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
black.needsUpdate = true;

export class Water {
  constructor(sim, { rings = 1024, sectors = 768, far = 40000 } = {}) {
    this.sim = sim;
    this.far = far;
    this.uniforms = {
      uD0: { value: null }, uD1: { value: null }, uD2: { value: null }, uD3: { value: null },
      uS0: { value: null }, uS1: { value: null }, uS2: { value: null }, uS3: { value: null },
      uInvL: { value: new THREE.Vector4(...sim.lengths.map((l) => 1 / l)) },
      uN: { value: sim.N },
      uCenter: { value: new THREE.Vector2() },
      uA: { value: 4 }, uB: { value: 9 }, uRings: { value: rings }, uSectors: { value: sectors },
      uVarTex: { value: null },
      uSky: { value: null }, uSkyRot: { value: 0 }, uHorizonColor: { value: new THREE.Vector3() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunColor: { value: new THREE.Vector3(1, 1, 1) },
      uSkyIrr: { value: new THREE.Vector3(1, 1, 1) },
      uRefr: { value: black }, uRefrDepth: { value: black }, uRefl: { value: black },
      uShadowMap: { value: black }, uWake: { value: black }, uFoamTex: { value: makeFoamTexture() },
      uHullTex: { value: black },
      uReflMatrix: { value: new THREE.Matrix4() }, uShadowMatrix: { value: new THREE.Matrix4() },
      uShipInv: { value: new THREE.Matrix4() },
      uResolution: { value: new THREE.Vector2(1, 1) }, uWakeOrigin: { value: new THREE.Vector2() },
      uHull: { value: new THREE.Vector4(-1, 1, 2, 0) },
      uWakeSize: { value: 256 }, uNear: { value: 0.3 }, uFar: { value: far }, uTime: { value: 0 },
      uHs: { value: 1 }, uShadowOn: { value: 0 }, uReflOn: { value: 0 },
      uScatter: { value: new THREE.Color(0.0045, 0.026, 0.044) },
      uSSSColor: { value: new THREE.Color(0.012, 0.17, 0.15) },
      uBubbleColor: { value: new THREE.Color(0.06, 0.24, 0.26) },
      uAbsorb: { value: new THREE.Vector3(0.9, 0.32, 0.26) },
      uFogDensity: { value: 1 / 30000 }, uFoamAmount: { value: 1 }, uSSS: { value: 1 },
      uSpecClamp: { value: 120 }, uRoughBoost: { value: 1 },
    };
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: FRAG, uniforms: this.uniforms,
      toneMapped: false, side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(buildGrid(rings, sectors), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
  }

  update(camera, time) {
    const u = this.uniforms;
    const c = this.sim.cascades;
    u.uD0.value = c[0].disp; u.uD1.value = c[1].disp; u.uD2.value = c[2].disp; u.uD3.value = c[3].disp;
    u.uS0.value = c[0].deriv; u.uS1.value = c[1].deriv; u.uS2.value = c[2].deriv; u.uS3.value = c[3].deriv;
    u.uCenter.value.set(camera.position.x, camera.position.z);
    const a = THREE.MathUtils.clamp(camera.position.y * 0.5, 1.5, 60);
    u.uA.value = a;
    u.uB.value = Math.log(this.far / a + 1);
    u.uNear.value = camera.near;
    u.uFar.value = camera.far;
    u.uTime.value = time;
    u.uHs.value = this.sim.significantHeight;
  }
}
