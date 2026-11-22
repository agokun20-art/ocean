import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import GUI from 'lil-gui';
import { OceanSim } from './ocean/sim.js';
import { Water } from './ocean/water.js';
import { loadSky, createSkyMesh, buildEnvironment } from './sky.js';
import { Ship } from './ship.js';
import { Wake } from './wake.js';

const query = new URLSearchParams(location.search);
const QUALITY = {
  low: { N: 128, rings: 320, sectors: 256, dpr: 1, msaa: 0, shadow: 1024, half: 0.5 },
  medium: { N: 256, rings: 700, sectors: 512, dpr: 1.25, msaa: 4, shadow: 2048, half: 0.5 },
  high: { N: 512, rings: 1100, sectors: 800, dpr: 2, msaa: 4, shadow: 4096, half: 0.5 },
  ultra: { N: 512, rings: 1600, sectors: 1100, dpr: 2, msaa: 8, shadow: 4096, half: 1 },
};
const qualityName = QUALITY[query.get('q')] ? query.get('q') : 'high';
const Q = QUALITY[qualityName];

const SKIES = {
  'Golden hour': { file: 'qwantani_sunset_puresky_4k.hdr', exposure: 0.34, sunDisc: 1.0 },
  'Low sun, clear': { file: 'syferfontein_6d_clear_puresky_4k.hdr', exposure: 0.5, sunDisc: 1.0 },
  'Afternoon clouds': { file: 'sunflowers_puresky_4k.hdr', exposure: 0.5, sunDisc: 1.0 },
  'Midday': { file: 'kloofendal_48d_partly_cloudy_puresky_4k.hdr', exposure: 0.5, sunDisc: 1.0 },
    'Dusk': { file: 'industrial_sunset_02_puresky_4k.hdr', exposure: 0.42, sunDisc: 1.0 },
  'Overcast': { file: 'mud_road_puresky_4k.hdr', exposure: 0.6, sunDisc: 0.0 },
};

const params = {
  sky: SKIES[query.get('sky')] ? query.get('sky') : 'Golden hour',
  exposure: 0.34,
  sunAzimuth: 205, // degrees, direction the sun is in
  windSpeed: 7.5,
  windDir: 35,
  fetch: 180,
  swellHeight: 0.9,
  swellPeriod: 10,
  swellDir: 100,
  choppiness: 1.0,
  foam: 1.0,
  shipSpeed: 3.2,
  bloom: 0.12,
  quality: qualityName,
  paused: false,
};

const statusEl = document.getElementById('status');
const barEl = document.querySelector('#bar > div');
const setStatus = (text, frac) => { statusEl.textContent = text; if (frac != null) barEl.style.width = `${Math.round(frac * 100)}%`; };

async function init() {
  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', alpha: false });
  if (!renderer.capabilities.isWebGL2 || !renderer.extensions.has('EXT_color_buffer_float')) {
    throw new Error('This demo needs WebGL2 with float render targets (any recent Chrome, Safari or Firefox on a Mac).');
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, Q.dpr));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = params.exposure;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.setClearColor(0x000000, 0);
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.3, 45000);
  camera.position.set(-34, 9, 46);

  // ---- ocean ------------------------------------------------------------------------------------
  const sim = new OceanSim(renderer, { N: Q.N });
  const water = new Water(sim, { rings: Q.rings, sectors: Q.sectors, far: 40000 });
  scene.add(water.mesh);
  const rad = (d) => (d * Math.PI) / 180;
  const applySea = () => {
    sim.setSpectrum({
      windSpeed: params.windSpeed, windDir: rad(params.windDir), fetch: params.fetch,
      swellHeight: params.swellHeight, swellPeriod: params.swellPeriod, swellDir: rad(params.swellDir),
    });
    sim.lambda = params.choppiness;
    water.uniforms.uVarTex.value = sim.makeVarianceTexture();
  };
  applySea();

  // ---- ship -------------------------------------------------------------------------------------
  const ship = new Ship();
  ship.heading = rad(200);
  ship.speed = params.shipSpeed;
  scene.add(ship.group);
  const wake = new Wake(renderer);

  // ---- sky + lighting ---------------------------------------------------------------------------
  const sun = new THREE.DirectionalLight(0xffffff, 1);
  sun.castShadow = true;
  sun.shadow.mapSize.set(Q.shadow, Q.shadow);
  Object.assign(sun.shadow.camera, { left: -26, right: 26, top: 36, bottom: -10, near: 1, far: 220 });
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.04;
  scene.add(sun, sun.target);

  const skyUniforms = {
    uSky: { value: null }, uSkyRot: { value: 0 }, uHorizonColor: { value: new THREE.Vector3() },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunColor: { value: new THREE.Vector3() },
    uSunDisc: { value: 1 }, uInvViewProj: { value: new THREE.Matrix4() }, uCamPos: { value: new THREE.Vector3() },
  };
  const skyMesh = createSkyMesh(skyUniforms);
  scene.add(skyMesh);

  const skyCache = {};
  let sky = null, envRT = null;
  const sunDir = new THREE.Vector3();
  const applySky = () => {
    if (!sky) return;
    // rotate the panorama so the sun sits at the requested azimuth
    const texAz = Math.atan2(sky.sunDir.z, sky.sunDir.x);
    const rot = rad(params.sunAzimuth) - texAz;
    const el = Math.asin(sky.sunDir.y);
    sunDir.set(Math.cos(el) * Math.cos(rad(params.sunAzimuth)), Math.sin(el), Math.cos(el) * Math.sin(rad(params.sunAzimuth)));
    for (const u of [skyUniforms, water.uniforms]) {
      u.uSky.value = sky.texture;
      u.uSkyRot.value = rot;
      u.uHorizonColor.value.copy(sky.horizon);
      u.uSunDir.value.copy(sunDir);
      u.uSunColor.value.copy(sky.sunE);
    }
    skyUniforms.uSunDisc.value = SKIES[params.sky].sunDisc;
    water.uniforms.uSkyIrr.value.copy(sky.skyE);
    sun.color.setRGB(sky.sunE.x, sky.sunE.y, sky.sunE.z);
    ship.sunUniforms.uSunDirW.value.copy(sunDir);
    ship.sunUniforms.uSunCol.value.copy(sky.sunE);
    const sea = new THREE.Vector3().copy(sky.skyE).multiply(new THREE.Vector3(0.006, 0.028, 0.042)).multiplyScalar(1 / Math.PI);
    if (envRT) envRT.dispose();
    envRT = buildEnvironment(renderer, sky, rot, sea);
    scene.environment = envRT.texture;
  };
  const setSky = async (name) => {
    if (!skyCache[name]) skyCache[name] = await loadSky(`assets/sky/${SKIES[name].file}`);
    sky = skyCache[name];
    params.exposure = SKIES[name].exposure;
    renderer.toneMappingExposure = params.exposure;
    applySky();
  };

  setStatus('Loading sky', 0.1);
  await setSky(params.sky);
  setStatus('Loading ship', 0.35);
  await ship.load('assets/ship/ship_pinnace.gltf', renderer, (e) => {
    if (e.total) setStatus('Loading ship', 0.35 + 0.3 * (e.loaded / e.total));
  });
  setStatus('Preparing', 0.8);
  water.uniforms.uHullTex.value = ship.hullTex;
  water.uniforms.uHull.value.copy(ship.hull);
  water.uniforms.uShipInv.value = ship.inverse;

  // ---- render targets ---------------------------------------------------------------------------
  const size = new THREE.Vector2();
  const refrRT = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
  refrRT.depthTexture = new THREE.DepthTexture(4, 4, THREE.UnsignedIntType);
  const reflRT = new THREE.WebGLRenderTarget(4, 4, {
    type: THREE.HalfFloatType, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: true,
  });
  const mainRT = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: Q.msaa });
  const composer = new EffectComposer(renderer, mainRT);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(4, 4), params.bloom, 0.55, 3.0);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  const finish = new ShaderPass({
    uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uAspect: { value: 1 } },
    vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      uniform sampler2D tDiffuse; uniform float uTime, uAspect; varying vec2 vUv;
      float hash(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
      void main() {
        vec2 c = vUv - 0.5;
        // very slight lateral chromatic aberration, vignette and film grain, as a real lens / sensor would give
        float r2 = dot(c, c);
        vec2 off = c * r2 * 0.006;
        vec3 col = vec3(texture2D(tDiffuse, vUv + off).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - off).b);
        col *= 1.0 - 0.42 * smoothstep(0.12, 0.85, r2 * (0.6 + 0.4 * uAspect));
        float g = hash(gl_FragCoord.xy + fract(uTime) * 931.0) - 0.5;
        col += g * 0.022 * (1.0 - 0.6 * dot(col, vec3(0.333)));
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  composer.addPass(finish);

  const resize = () => {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, Q.dpr));
    renderer.setSize(w, h);
    composer.setPixelRatio(renderer.getPixelRatio());
    composer.setSize(w, h);
    renderer.getDrawingBufferSize(size);
    const hw = Math.max(2, Math.round(size.x * Q.half)), hh = Math.max(2, Math.round(size.y * Q.half));
    refrRT.setSize(hw, hh);
    reflRT.setSize(hw, hh);
    water.uniforms.uResolution.value.copy(size);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    finish.uniforms.uAspect.value = w / h;
  };
  window.addEventListener('resize', resize);
  resize();

  // ---- camera -----------------------------------------------------------------------------------
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.minDistance = 14;
  controls.maxDistance = 600;
  controls.maxPolarAngle = Math.PI * 0.6;
  controls.zoomSpeed = 0.7;
  controls.rotateSpeed = 0.55;
  controls.target.set(0, 8, 0);
  const views = {
    1: { off: [-36, 4.5, 47], tgt: 9 },
    2: { off: [52, 13, -30], tgt: 10 },
    3: { off: [-8, 3.2, 86], tgt: 12 },
    4: { off: [-80, 46, -70], tgt: 4 },
  };
  let viewAnim = null;
  const setView = (k, instant) => {
    const v = views[k];
    if (!v) return;
    const s = Math.sin(ship.heading), c = Math.cos(ship.heading);
    // offsets are in ship space (x = starboard, z = toward local +Z)
    const to = new THREE.Vector3(ship.position.x + v.off[0] * c + v.off[2] * s, v.off[1], ship.position.y - v.off[0] * s + v.off[2] * c);
    if (instant) { camera.position.copy(to); controls.target.set(ship.position.x, v.tgt, ship.position.y); return; }
    viewAnim = { from: camera.position.clone().sub(controls.target), rel: to.sub(new THREE.Vector3(ship.position.x, v.tgt, ship.position.y)), y0: controls.target.y, y1: v.tgt, t: 0 };
  };
  window.addEventListener('keydown', (e) => {
    if (views[e.key]) setView(e.key, false);
    if (e.key === 'h' || e.key === 'H') document.body.classList.toggle('hidden-ui');
    if (e.key === ' ') params.paused = !params.paused;
  });

  // ---- GUI --------------------------------------------------------------------------------------
  const gui = new GUI({ title: 'Ocean' });
  const fSea = gui.addFolder('Sea');
  fSea.add(params, 'windSpeed', 2, 22, 0.1).name('Wind speed (m/s)').onFinishChange(applySea);
  fSea.add(params, 'windDir', 0, 360, 1).name('Wind direction').onFinishChange(applySea);
  fSea.add(params, 'swellHeight', 0, 4, 0.05).name('Swell height (m)').onFinishChange(applySea);
  fSea.add(params, 'swellDir', 0, 360, 1).name('Swell direction').onFinishChange(applySea);
  fSea.add(params, 'choppiness', 0, 1.3, 0.01).name('Choppiness').onChange((v) => { sim.lambda = v; });
  fSea.add(params, 'foam', 0, 2, 0.01).name('Foam').onChange((v) => { water.uniforms.uFoamAmount.value = v; });
  const fSky = gui.addFolder('Sky');
  fSky.add(params, 'sky', Object.keys(SKIES)).name('Time of day').onChange(async (v) => { await setSky(v); gui.controllersRecursive().forEach((c) => c.updateDisplay()); });
  fSky.add(params, 'sunAzimuth', 0, 360, 1).name('Sun direction').onChange(applySky);
  fSky.add(params, 'exposure', 0.1, 2, 0.01).name('Exposure').onChange((v) => { renderer.toneMappingExposure = v; });
  fSky.add(params, 'bloom', 0, 0.6, 0.01).name('Glare').onChange((v) => { bloom.strength = v; });
  const fShip = gui.addFolder('Ship');
  fShip.add(params, 'shipSpeed', 0, 7, 0.1).name('Speed (m/s)').onChange((v) => { ship.speed = v; });
  gui.add(params, 'quality', Object.keys(QUALITY)).name('Quality').onChange((v) => { const u = new URL(location.href); u.searchParams.set('q', v); location.href = u.toString(); });
  gui.add(params, 'paused').name('Pause').listen();
  if (window.innerWidth < 900) gui.close();
  if (query.get('ui') === '0') document.body.classList.add('hidden-ui');

  // ---- frame loop -------------------------------------------------------------------------------
  const clock = new THREE.Clock();
  let time = query.has('t') ? parseFloat(query.get('t')) : 40;
  const fixedDt = query.has('dt') ? parseFloat(query.get('dt')) : 0;
  const mirror = new THREE.PerspectiveCamera();
  const reflPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const noPlanes = [];
  const refrPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
  const bias = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
  const tmp = new THREE.Vector3(), look = new THREE.Vector3(), up = new THREE.Vector3();
  const lastShip = new THREE.Vector2().copy(ship.position);
  const viewProj = new THREE.Matrix4();
  let frames = 0;

  // lay down the wake the ship would already have left behind it
  {
    const f = ship.forward, steps = 360, h = 0.12;
    ship.position.addScaledVector(f, -ship.speed * steps * h);
    for (let i = 0; i < steps; i++) {
      ship.position.addScaledVector(f, ship.speed * h);
      wake.update(ship, h, time - (steps - i) * h);
    }
    lastShip.copy(ship.position);
  }
  setView(query.get('view') || 1, true);
  if (query.has('cam')) {
    // debugging aid: cam=x,y,z,tx,ty,tz in ship space
    const c = query.get('cam').split(',').map(Number);
    const sn = Math.sin(ship.heading), cs = Math.cos(ship.heading);
    const w = (x, y, z) => new THREE.Vector3(ship.position.x + x * cs + z * sn, y, ship.position.y - x * sn + z * cs);
    camera.position.copy(w(c[0], c[1], c[2]));
    controls.target.copy(w(c[3] || 0, c[4] || 0, c[5] || 0));
  }
  if (!query.has('sun')) {
    // start with the sun ahead and to one side of the camera: glitter path on the water, rim-lit sails
    const az = (Math.atan2(controls.target.z - camera.position.z, controls.target.x - camera.position.x) * 180) / Math.PI;
    params.sunAzimuth = Math.round((az + 38 + 360) % 360);
  } else params.sunAzimuth = parseFloat(query.get('sun'));
  applySky();
  gui.controllersRecursive().forEach((c) => c.updateDisplay());

  const frame = () => {
    const rawDt = Math.min(clock.getDelta(), 0.1);
    const dt = params.paused ? 0 : fixedDt || rawDt;
    time += dt;

    // simulation
    ship.update(dt, sim);
    sim.probes[15].set(camera.position.x, camera.position.z);
    sim.update(time, dt);
    wake.update(ship, dt, time);

    // camera follows the ship
    const dx = ship.position.x - lastShip.x, dz = ship.position.y - lastShip.y;
    lastShip.copy(ship.position);
    camera.position.x += dx; camera.position.z += dz;
    controls.target.x += dx; controls.target.z += dz;
    if (viewAnim) {
      viewAnim.t = Math.min(1, viewAnim.t + rawDt / 2.2);
      const k = viewAnim.t * viewAnim.t * (3 - 2 * viewAnim.t);
      controls.target.y = THREE.MathUtils.lerp(viewAnim.y0, viewAnim.y1, k);
      const sph0 = new THREE.Spherical().setFromVector3(viewAnim.from), sph1 = new THREE.Spherical().setFromVector3(viewAnim.rel);
      let dth = sph1.theta - sph0.theta;
      dth = Math.atan2(Math.sin(dth), Math.cos(dth));
      const sph = new THREE.Spherical(THREE.MathUtils.lerp(sph0.radius, sph1.radius, k), THREE.MathUtils.lerp(sph0.phi, sph1.phi, k), sph0.theta + dth * k);
      camera.position.setFromSpherical(sph).add(controls.target);
      if (viewAnim.t >= 1) viewAnim = null;
    }
    controls.update();
    const minY = sim.probeHeight(15) + 1.0;
    if (camera.position.y < minY) camera.position.y = minY;
    camera.updateMatrixWorld();

    // sun follows the ship so the shadow map stays tight around it
    sun.target.position.set(ship.position.x, 8, ship.position.y);
    sun.position.copy(sun.target.position).addScaledVector(sunDir, 110);
    sun.target.updateMatrixWorld();
    renderer.shadowMap.needsUpdate = true;

    water.update(camera, time);
    const wu = water.uniforms;
    wu.uWake.value = wake.texture;
    wu.uWakeOrigin.value.copy(wake.origin);
    wu.uWakeSize.value = wake.size;

    viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    skyUniforms.uInvViewProj.value.copy(viewProj).invert();
    skyUniforms.uCamPos.value.copy(camera.position);
    finish.uniforms.uTime.value = time;

    // pass 1: ship only -> colour + depth, for refraction and shoreline-style contact effects
    water.mesh.visible = false;
    skyMesh.visible = false;
    const level = ship.heave - ship.draft;
    refrPlane.constant = level + 0.6; // keep only what is below the water
    renderer.clippingPlanes = [refrPlane];
    renderer.setRenderTarget(refrRT);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.shadowMap.needsUpdate = false;

    // pass 2: mirrored ship for the planar reflection
    mirror.fov = camera.fov; mirror.aspect = camera.aspect; mirror.near = camera.near; mirror.far = camera.far;
    mirror.position.set(camera.position.x, 2 * level - camera.position.y, camera.position.z);
    camera.getWorldDirection(look).add(camera.position);
    tmp.set(look.x, 2 * level - look.y, look.z);
    up.set(0, 1, 0).applyQuaternion(camera.quaternion); up.y = -up.y;
    mirror.up.copy(up);
    mirror.lookAt(tmp);
    mirror.updateMatrixWorld();
    mirror.projectionMatrix.copy(camera.projectionMatrix);
    wu.uReflMatrix.value.copy(bias).multiply(mirror.projectionMatrix).multiply(mirror.matrixWorldInverse);
    reflPlane.constant = -level + 0.25;
    renderer.clippingPlanes = [reflPlane];
    renderer.setRenderTarget(reflRT);
    renderer.clear();
    renderer.render(scene, mirror);
    renderer.clippingPlanes = noPlanes;
    renderer.setRenderTarget(null);

    // pass 3: everything
    water.mesh.visible = true;
    skyMesh.visible = true;
    wu.uRefr.value = refrRT.texture;
    wu.uRefrDepth.value = refrRT.depthTexture;
    wu.uRefl.value = reflRT.texture;
    wu.uReflOn.value = query.get('refl') === '0' ? 0 : 1;
    if (sun.shadow.map && query.get('shadow') !== '0') {
      wu.uShadowMap.value = sun.shadow.map.texture;
      wu.uShadowMatrix.value.copy(sun.shadow.matrix);
      wu.uShadowOn.value = 1;
    }
    composer.render();

    frames++;
    if (frames === 3) document.getElementById('loading').classList.add('done');
    window.__frames = frames;
  };
  renderer.setAnimationLoop(frame);
  window.__app = { renderer, scene, camera, sim, water, ship, wake, params, controls, sky: () => sky };
}

init().catch((err) => {
  console.error(err);
  document.getElementById('error').textContent = err.message || String(err);
  setStatus('Could not start');
});
