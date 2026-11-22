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
import { Spray } from './spray.js';
import { Ambience } from './audio.js';
import { Panel, Hud } from './ui.js';

const query = new URLSearchParams(location.search);
const QUALITY = {
  low: { N: 128, rings: 320, sectors: 256, dpr: 1, msaa: 0, shadow: 1024, half: 0.5 },
  medium: { N: 256, rings: 700, sectors: 512, dpr: 1.25, msaa: 4, shadow: 2048, half: 0.5 },
  high: { N: 512, rings: 1100, sectors: 800, dpr: 2, msaa: 4, shadow: 4096, half: 0.5 },
  ultra: { N: 512, rings: 1600, sectors: 1100, dpr: 2, msaa: 8, shadow: 4096, half: 1 },
};
// Phones and tablets start on the light preset; desktops on high. `?q=` overrides both.
const defaultQuality = window.matchMedia('(pointer: coarse)').matches ? 'low' : 'high';
const qualityName = QUALITY[query.get('q')] ? query.get('q') : defaultQuality;
const Q = QUALITY[qualityName];

const SKIES = {
  'Golden hour': { label: 'Golden hour', file: 'qwantani_sunset_puresky_4k.hdr', exposure: 0.34, sunDisc: 1.0, lamps: 0.35 },
  'Low sun, clear': { label: 'Clear', file: 'syferfontein_6d_clear_puresky_4k.hdr', exposure: 0.5, sunDisc: 1.0, lamps: 0 },
  'Afternoon clouds': { label: 'Clouds', file: 'sunflowers_puresky_4k.hdr', exposure: 0.5, sunDisc: 1.0, lamps: 0 },
  'Midday': { label: 'Midday', file: 'kloofendal_48d_partly_cloudy_puresky_4k.hdr', exposure: 0.5, sunDisc: 1.0, lamps: 0 },
  'Dusk': { label: 'Dusk', file: 'industrial_sunset_02_puresky_4k.hdr', exposure: 0.42, sunDisc: 1.0, lamps: 1 },
  'Overcast': { label: 'Overcast', file: 'mud_road_puresky_4k.hdr', exposure: 0.6, sunDisc: 0.0, lamps: 0.5 },
};

// one-click sea states (wind in m/s, swell height in m)
const SEAS = {
  Calm: { windSpeed: 3, swellHeight: 0.3, choppiness: 0.8, foam: 0.7, title: 'Light air, long gentle swell' },
  Breeze: { windSpeed: 7.5, swellHeight: 0.9, choppiness: 1.0, foam: 1.0, title: 'Moderate breeze, small waves' },
  Fresh: { windSpeed: 11, swellHeight: 1.6, choppiness: 1.05, foam: 1.1, title: 'Fresh wind, whitecaps' },
  Rough: { windSpeed: 15, swellHeight: 2.6, choppiness: 1.1, foam: 1.2, title: 'Near gale, heavy sea' },
  Storm: { windSpeed: 20, swellHeight: 3.6, choppiness: 1.15, foam: 1.35, title: 'Gale, rain and a dark sky' },
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
  sea: SEAS[query.get('sea')] ? query.get('sea') : 'Breeze',
  rain: query.get('rain') === '1' ? 1 : 0,
  haze: 1,
  sound: false,
  follow: true,
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
  const rad = (d) => (d * Math.PI) / 180;
  const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.3, 45000);
  camera.position.set(-34, 9, 46);

  // ---- ship -------------------------------------------------------------------------------------
  const ship = new Ship();
  ship.heading = rad(200);
  if (query.has('throttle')) ship.throttle = parseFloat(query.get('throttle'));
  if (query.has('rudder')) ship.rudderInput = parseFloat(query.get('rudder'));
  scene.add(ship.group);
  const wake = new Wake(renderer);
  const spray = new Spray();
  scene.add(spray.points);
  const ambience = new Ambience();
  const windVec = new THREE.Vector2();

  // ---- ocean ------------------------------------------------------------------------------------
  const sim = new OceanSim(renderer, { N: Q.N });
  const water = new Water(sim, { rings: Q.rings, sectors: Q.sectors, far: 40000 });
  scene.add(water.mesh);
  const applySea = () => {
    sim.setSpectrum({
      windSpeed: params.windSpeed, windDir: rad(params.windDir), fetch: params.fetch,
      swellHeight: params.swellHeight, swellPeriod: params.swellPeriod, swellDir: rad(params.swellDir),
    });
    sim.lambda = params.choppiness;
    water.uniforms.uVarTex.value = sim.makeVarianceTexture();
    water.uniforms.uFoamAmount.value = params.foam;
    ship.maxSpeed = THREE.MathUtils.clamp(1.2 + 0.5 * params.windSpeed, 2, 7);
    windVec.set(Math.cos(rad(params.windDir)), Math.sin(rad(params.windDir))).multiplyScalar(params.windSpeed);
    ambience.update({ wind: params.windSpeed });
  };
  Object.assign(params, SEAS[params.sea], { title: undefined });
  if (params.sea === 'Storm') { params.rain = 1; if (!query.has('sky')) params.sky = 'Overcast'; }
  applySea();

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
    spray.setLight(sky.sunE, sunDir, sky.skyE);
    ship.setLamps(Math.max(SKIES[params.sky].lamps, 0.8 * params.rain), params.exposure);
    const sea = new THREE.Vector3().copy(sky.skyE).multiply(new THREE.Vector3(0.006, 0.028, 0.042)).multiplyScalar(1 / Math.PI);
    if (envRT) envRT.dispose();
    envRT = buildEnvironment(renderer, sky, rot, sea);
    scene.environment = envRT.texture;
  };
  let skyRequest = 0;
  const setSky = async (name) => {
    const request = ++skyRequest;
    if (!skyCache[name]) {
      const loaded = await loadSky(`assets/sky/${SKIES[name].file}`);
      skyCache[name] ??= loaded;
    }
    if (request !== skyRequest) return;
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
    uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uAspect: { value: 1 }, uRain: { value: 0 } },
    vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      uniform sampler2D tDiffuse; uniform float uTime, uAspect, uRain; varying vec2 vUv;
      float hash(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
      float rainLayer(vec2 uv, float scale, float speed, float seed) {
        uv.x += uv.y * 0.14;
        vec2 p = vec2(uv.x * scale * uAspect, uv.y * scale * 0.05 + uTime * speed);
        vec2 id = floor(p), f = fract(p);
        float h = hash(id + seed);
        float x = abs(f.x - 0.5 - (h - 0.5) * 0.7);
        float streak = smoothstep(0.03, 0.0, x) * smoothstep(0.0, 0.25, f.y) * smoothstep(1.0, 0.45, f.y);
        return streak * step(0.5, hash(id * 1.7 + seed + 3.1));
      }
      void main() {
        vec2 c = vUv - 0.5;
        // very slight lateral chromatic aberration, vignette and film grain, as a real lens / sensor would give
        float r2 = dot(c, c);
        vec2 off = c * r2 * 0.006;
        vec3 col = vec3(texture2D(tDiffuse, vUv + off).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - off).b);
        col *= 1.0 - 0.42 * smoothstep(0.12, 0.85, r2 * (0.6 + 0.4 * uAspect));
        if (uRain > 0.0) {
          // rain between the lens and the scene: grey veil plus three depths of streaks
          col = mix(col, vec3(dot(col, vec3(0.3, 0.5, 0.2))) * 0.96 + 0.02, 0.22 * uRain);
          col += uRain * (0.06 * rainLayer(vUv, 31.0, 2.9, 0.0) + 0.045 * rainLayer(vUv * 1.03 + 0.37, 67.0, 2.2, 7.0) + 0.03 * rainLayer(vUv * 0.97 + 0.71, 123.0, 1.8, 13.0));
        }
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
    spray.uniforms.uScale.value = size.y / (2 * Math.tan(rad(camera.fov) / 2));
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
    5: { off: [0, 15, -56], tgt: 10 },
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
  const applyWeather = () => {
    const r = params.rain;
    water.uniforms.uRain.value = r;
    water.uniforms.uFogDensity.value = params.haze / 30000 + r / 2600;
    finish.uniforms.uRain.value = r;
    renderer.toneMappingExposure = params.exposure * (1 - 0.2 * r);
    ship.setLamps(Math.max(SKIES[params.sky].lamps, 0.8 * r), params.exposure);
    ambience.update({ rain: r });
  };

  // ---- controls ---------------------------------------------------------------------------------
  const gui = new GUI({ title: 'Fine tuning' });
  const refreshGui = () => gui.controllersRecursive().forEach((c) => c.updateDisplay());
  const panel = new Panel();
  const hud = new Hud();
  let toggles = null;
  panel.choices('sky', 'Sky', Object.entries(SKIES).map(([id, v]) => ({ id, label: v.label })), params.sky, async (id) => {
    params.sky = id;
    await setSky(id);
    applyWeather();
    refreshGui();
  });
  panel.choices('sea', 'Sea', Object.entries(SEAS).map(([id, v]) => ({ id, label: id, title: v.title })), params.sea, async (id) => {
    params.sea = id;
    Object.assign(params, SEAS[id], { title: undefined });
    applySea();
    if (id === 'Storm') {
      params.rain = 1; toggles.rain(true);
      if (params.sky !== 'Overcast') { params.sky = 'Overcast'; panel.select('sky', 'Overcast'); await setSky('Overcast'); }
    }
    applyWeather();
    refreshGui();
  });
  panel.choices('view', 'View', [
    { id: 5, label: 'Helm', title: 'Behind the ship, best for steering (5)' }, { id: 1, label: 'Bow', title: '1' },
    { id: 2, label: 'Stern', title: '2' }, { id: 3, label: 'Ahead', title: '3' }, { id: 4, label: 'Aerial', title: '4' },
  ], query.get('view') || 1, (id) => setView(id, false));
  const setSunSlider = panel.slider('Sun', 0, 360, params.sunAzimuth, (v) => { params.sunAzimuth = v; applySky(); refreshGui(); });
  toggles = panel.toggles('More', [
    { id: 'rain', label: 'Rain', value: params.rain > 0, onChange: (v) => { params.rain = v ? 1 : 0; applyWeather(); } },
    { id: 'sound', label: 'Sound', title: 'Sea, wind and rain ambience', value: false, onChange: (v) => { params.sound = v; ambience.setEnabled(v); } },
    { id: 'follow', label: 'Camera turns with ship', value: params.follow, onChange: (v) => { params.follow = v; } },
    { id: 'gui', label: 'Fine tuning', title: 'Wind, swell, foam, exposure, quality', value: false, onChange: (v) => { if (v) { gui.show(); gui.open(); } else gui.hide(); placeGui(); } },
  ]);
  // On narrow screens the fine-tuning panel goes under the main panel instead of on top of it.
  const placeGui = () => {
    const st = gui.domElement.style;
    if (window.innerWidth < 820) {
      const top = panel.root.getBoundingClientRect().bottom + 8;
      const room = window.innerHeight - top - hud.root.getBoundingClientRect().height - 28;
      st.setProperty('top', `${room >= 110 ? top : 14}px`, 'important');
      st.maxHeight = `${room >= 110 ? room : window.innerHeight - 28}px`;
    } else {
      st.removeProperty('top');
      st.maxHeight = '';
    }
  };
  window.addEventListener('resize', placeGui);

  const typing = (e) => e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') && e.target.type !== 'range';
  const held = { left: false, right: false };
  const steer = () => { ship.rudderInput = (held.right ? 1 : 0) - (held.left ? 1 : 0); };
  window.addEventListener('keydown', (e) => {
    if (typing(e) || e.metaKey || e.ctrlKey) return;
    const k = e.key.toLowerCase();
    if (views[e.key]) { setView(e.key, false); panel.select('view', e.key); }
    else if (k === 'h') document.body.classList.toggle('hidden-ui');
    else if (k === ' ') { params.paused = !params.paused; e.preventDefault(); }
    else if (k === 'w' || k === 'arrowup') { ship.throttle = Math.min(1, Math.round((ship.throttle + 0.1) * 10) / 10); e.preventDefault(); }
    else if (k === 's' || k === 'arrowdown') { ship.throttle = Math.max(0, Math.round((ship.throttle - 0.1) * 10) / 10); e.preventDefault(); }
    else if (k === 'a' || k === 'arrowleft') { held.left = true; steer(); e.preventDefault(); }
    else if (k === 'd' || k === 'arrowright') { held.right = true; steer(); e.preventDefault(); }
  });
  window.addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'a' || k === 'arrowleft') held.left = false;
    if (k === 'd' || k === 'arrowright') held.right = false;
    if ('ad'.includes(k) || k.startsWith('arrow')) steer();
  });
  window.addEventListener('blur', () => { held.left = held.right = false; steer(); });

  const fSea = gui.addFolder('Sea');
  fSea.add(params, 'windSpeed', 2, 22, 0.1).name('Wind speed (m/s)').onFinishChange(applySea);
  fSea.add(params, 'windDir', 0, 360, 1).name('Wind direction').onFinishChange(applySea);
  fSea.add(params, 'swellHeight', 0, 4, 0.05).name('Swell height (m)').onFinishChange(applySea);
  fSea.add(params, 'swellDir', 0, 360, 1).name('Swell direction').onFinishChange(applySea);
  fSea.add(params, 'choppiness', 0, 1.3, 0.01).name('Choppiness').onChange((v) => { sim.lambda = v; });
  fSea.add(params, 'foam', 0, 2, 0.01).name('Foam').onChange((v) => { water.uniforms.uFoamAmount.value = v; });
  const fSky = gui.addFolder('Light and air');
  fSky.add(params, 'sunAzimuth', 0, 360, 1).name('Sun direction').onChange((v) => { applySky(); setSunSlider(v); });
  fSky.add(params, 'exposure', 0.1, 2, 0.01).name('Exposure').onChange(applyWeather);
  fSky.add(params, 'bloom', 0, 0.6, 0.01).name('Glare').onChange((v) => { bloom.strength = v; });
  fSky.add(params, 'haze', 0, 12, 0.1).name('Haze').onChange(applyWeather);
  gui.add(params, 'quality', Object.keys(QUALITY)).name('Quality').onChange((v) => { const u = new URL(location.href); u.searchParams.set('q', v); location.href = u.toString(); });
  gui.add(params, 'paused').name('Pause').listen();
  gui.hide();
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
    ship.speed = ship.throttle * ship.maxSpeed;
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
  applyWeather();
  setSunSlider(params.sunAzimuth);
  refreshGui();
  let lastHeading = ship.heading, slow = 0;

  const frame = () => {
    const rawDt = Math.min(clock.getDelta(), 0.1);
    const dt = params.paused ? 0 : fixedDt || rawDt;
    time += dt;

    // simulation
    ship.update(dt, sim);
    sim.probes[15].set(camera.position.x, camera.position.z);
    sim.update(time, dt);
    wake.update(ship, dt, time);
    spray.update(ship, dt, windVec);
    water.uniforms.uShipSpeed.value = ship.speed;
    if ((slow += rawDt) > 0.1) { slow = 0; hud.update(ship); ambience.update({ speed: ship.speed }); }

    // camera follows the ship
    const dx = ship.position.x - lastShip.x, dz = ship.position.y - lastShip.y;
    lastShip.copy(ship.position);
    camera.position.x += dx; camera.position.z += dz;
    controls.target.x += dx; controls.target.z += dz;
    const dh = ship.heading - lastHeading;
    lastHeading = ship.heading;
    if (params.follow && dh !== 0 && !viewAnim) {
      // swing the camera round the ship as she turns
      const ox = camera.position.x - controls.target.x, oz = camera.position.z - controls.target.z;
      const cs = Math.cos(dh), sn = Math.sin(dh);
      camera.position.x = controls.target.x + ox * cs + oz * sn;
      camera.position.z = controls.target.z - ox * sn + oz * cs;
    }
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
    ship.faceLamps(camera);

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
    spray.points.visible = false;
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
    spray.points.visible = true;
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
  window.__app = { renderer, scene, camera, sim, water, ship, wake, spray, params, controls, sky: () => sky };
}

init().catch((err) => {
  console.error(err);
  document.getElementById('error').textContent = err.message || String(err);
  setStatus('Could not start');
});
