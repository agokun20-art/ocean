// HDRI sky: loads an equirectangular HDR, extracts the sun (direction + irradiance), removes it from the
// texture (it is re-added analytically as a light / specular highlight) and builds image based lighting.
import * as THREE from 'three';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';

export const SKY_GLSL = /* glsl */ `
uniform sampler2D uSky;
uniform float uSkyRot;
uniform vec3 uHorizonColor;
vec2 skyUV(vec3 d) {
  float phi = atan(d.z, d.x) - uSkyRot;
  return vec2(phi * 0.15915494309 + 0.5, asin(clamp(d.y, -1.0, 1.0)) * 0.31830988618 + 0.5);
}
vec3 sampleSky(vec3 d, float lod) {
  vec2 uv = skyUV(d);
  // keep blurred lookups from bleeding across the poles / below the horizon
  float texel = exp2(lod) / 1024.0;
  uv.y = clamp(uv.y, 0.5 + texel * 0.5, 1.0 - texel * 0.5);
  return textureLod(uSky, uv, lod).rgb;
}
`;

const halfLUT = (() => {
  const lut = new Float32Array(65536);
  for (let i = 0; i < 65536; i++) lut[i] = THREE.DataUtils.fromHalfFloat(i);
  return lut;
})();

const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function analyse(data, W, H) {
  // 1. brightest region -> sun centre
  let maxL = 0, mi = 0, mj = 0;
  for (let j = 0; j < H / 2; j++) {
    for (let i = 0; i < W; i++) {
      const o = (j * W + i) * 4;
      const l = lum(halfLUT[data[o]], halfLUT[data[o + 1]], halfLUT[data[o + 2]]);
      if (l > maxL) { maxL = l; mi = i; mj = j; }
    }
  }
  const dirOf = (i, j) => {
    const phi = ((i + 0.5) / W - 0.5) * 2 * Math.PI;
    const el = (0.5 - (j + 0.5) / H) * Math.PI;
    return new THREE.Vector3(Math.cos(el) * Math.cos(phi), Math.sin(el), Math.cos(el) * Math.sin(phi));
  };
  // 2. sky statistics (cosine weighted irradiance of the upper hemisphere, average horizon colour)
  const dPhi = (2 * Math.PI) / W, dEl = Math.PI / H;
  const sunCenter = dirOf(mi, mj);
  const step = 4;
  let skyLumSum = 0, skyW = 0;
  for (let j = 0; j < H / 2; j += step) {
    const el = (0.5 - (j + 0.5) / H) * Math.PI;
    const dw = Math.cos(el);
    for (let i = 0; i < W; i += step) {
      const o = (j * W + i) * 4;
      const l = lum(halfLUT[data[o]], halfLUT[data[o + 1]], halfLUT[data[o + 2]]);
      skyLumSum += Math.min(l, 50) * dw; skyW += dw;
    }
  }
  const meanSky = skyLumSum / skyW;
  // 3. sun: everything brighter than the clamp level within ~6 degrees of the centre
  const clampL = Math.max(meanSky * 24, Math.min(maxL * 0.02, 400));
  const rad = Math.ceil((6 / 180) * H);
  const sun = new THREE.Vector3();
  const sunE = new THREE.Vector3();
  const clampHalf = (v, s) => THREE.DataUtils.toHalfFloat(v * s);
  for (let j = Math.max(0, mj - rad); j < Math.min(H, mj + rad); j++) {
    const el = (0.5 - (j + 0.5) / H) * Math.PI;
    const dw = Math.cos(el) * dPhi * dEl;
    const span = Math.ceil(rad / Math.max(Math.cos(el), 0.05));
    for (let ii = mi - span; ii < mi + span; ii++) {
      const i = ((ii % W) + W) % W;
      const o = (j * W + i) * 4;
      const r = halfLUT[data[o]], g = halfLUT[data[o + 1]], b = halfLUT[data[o + 2]];
      const l = lum(r, g, b);
      if (l <= clampL) continue;
      const s = clampL / l;
      const ex = 1 - s;
      sunE.x += r * ex * dw; sunE.y += g * ex * dw; sunE.z += b * ex * dw;
      sun.addScaledVector(dirOf(i, j), l * ex * dw);
      data[o] = clampHalf(r, s); data[o + 1] = clampHalf(g, s); data[o + 2] = clampHalf(b, s);
    }
  }
  if (sun.lengthSq() > 0) sun.normalize(); else sun.copy(sunCenter);
  // The sun disc is clipped by the file format (half floats top out at 65504): restore a plausible
  // direct / diffuse ratio so that shadows and glitter have real-world contrast.
  if (maxL > 40000) {
    const el = Math.asin(sun.y);
    const k = Math.min(Math.max((el - 0.05) / 0.45, 0), 1);
    const target = 1.5 + 4.0 * k * k * (3 - 2 * k);
    const ratio = lum(sunE.x, sunE.y, sunE.z) / Math.max(meanSky * Math.PI, 1e-6);
    if (ratio < target) sunE.multiplyScalar(target / ratio);
  }
  // clamp stray hot pixels elsewhere too
  // 4. irradiance of the (sun-less) sky and horizon colour
  const skyE = new THREE.Vector3();
  const horizon = new THREE.Vector3();
  let hw = 0;
  for (let j = 0; j < H / 2; j += step) {
    const el = (0.5 - (j + 0.5) / H) * Math.PI;
    const dw = Math.cos(el) * dPhi * dEl * step * step;
    const cosW = Math.sin(el);
    const isHorizon = el < 0.035;
    for (let i = 0; i < W; i += step) {
      const o = (j * W + i) * 4;
      const r = halfLUT[data[o]], g = halfLUT[data[o + 1]], b = halfLUT[data[o + 2]];
      skyE.x += r * dw * cosW; skyE.y += g * dw * cosW; skyE.z += b * dw * cosW;
      if (isHorizon) { horizon.x += r; horizon.y += g; horizon.z += b; hw++; }
    }
  }
  horizon.multiplyScalar(1 / Math.max(hw, 1));
  return { sunDir: sun, sunE, skyE, horizon, maxL, clampL, meanSky };
}

export async function loadSky(url) {
  const tex = await new RGBELoader().setDataType(THREE.HalfFloatType).loadAsync(url);
  const { data, width, height } = tex.image;
  const info = analyse(data, width, height);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return { texture: tex, ...info };
}

const SKY_VERT = /* glsl */ `
out vec3 vDir;
uniform mat4 uInvViewProj;
uniform vec3 uCamPos;
void main() {
  gl_Position = vec4(position.xy, 1.0, 1.0);
  vec4 wp = uInvViewProj * vec4(position.xy, 1.0, 1.0);
  vDir = wp.xyz / wp.w - uCamPos;
}
`;

const SKY_FRAG = /* glsl */ `
in vec3 vDir;
out vec4 fragColor;
uniform vec3 uSunDir, uSunColor;
uniform float uSunDisc;
${SKY_GLSL}
void main() {
  vec3 d = normalize(vDir);
  vec3 col = sampleSky(vec3(d.x, max(d.y, 0.0), d.z), 0.0);
  // analytic sun disc + a tight aureole, replacing the energy removed from the texture
  float mu = dot(d, uSunDir);
  float ang = acos(clamp(mu, -1.0, 1.0));
  float disc = smoothstep(0.0062, 0.0042, ang);
  col += uSunColor * uSunDisc * (disc * 9000.0 + 40.0 * exp(-ang * 160.0) + 1.5 * exp(-ang * 28.0));
  // haze band at / below the horizon
  float h = smoothstep(0.0, -0.012, d.y);
  col = mix(col, uHorizonColor, h);
  fragColor = vec4(col, 1.0);
}
`;

/** Full-screen background triangle that draws the sky. */
export function createSkyMesh(uniforms) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  const mat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, uniforms,
    depthTest: false, depthWrite: false, toneMapped: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -100;
  return mesh;
}

/** Image based lighting for the ship: the sky above, the sea colour below. */
export function buildEnvironment(renderer, sky, skyRot, seaColor) {
  const scene = new THREE.Scene();
  const mat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    side: THREE.BackSide, depthTest: false, depthWrite: false,
    uniforms: {
      uSky: { value: sky.texture }, uSkyRot: { value: skyRot },
      uHorizonColor: { value: sky.horizon }, uSea: { value: seaColor },
    },
    vertexShader: /* glsl */ `out vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      in vec3 vDir; out vec4 fragColor; uniform vec3 uSea;
      ${SKY_GLSL}
      void main() {
        vec3 d = normalize(vDir);
        vec3 col = sampleSky(vec3(d.x, max(d.y, 0.0), d.z), 2.0);
        // below the horizon: sea surface = Fresnel-weighted sky reflection + water body colour
        vec3 r = normalize(vec3(d.x, abs(d.y) + 0.08, d.z));
        float f = 0.02 + 0.98 * pow(1.0 - clamp(-d.y, 0.0, 1.0), 5.0);
        vec3 sea = mix(uSea, sampleSky(r, 5.0), f * 0.6);
        col = mix(col, sea, smoothstep(0.0, -0.03, d.y));
        fragColor = vec4(col, 1.0);
      }`,
  });
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 48, 24), mat));
  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromScene(scene, 0, 0.1, 100);
  pmrem.dispose();
  mat.dispose();
  return rt;
}
