// Ocean wave spectrum generation (JONSWAP + directional spreading + swell), evaluated on the CPU.
export const G = 9.81;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LANCZOS = [
  676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];
function lgamma(x) {
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lgamma(1 - x);
  x -= 1;
  let a = 0.99999999999980993;
  const t = x + 7.5;
  for (let i = 0; i < 8; i++) a += LANCZOS[i] / (x + i + 1);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

function jonswap(omega, wp, alpha, gamma) {
  const sigma = omega <= wp ? 0.07 : 0.09;
  const r = Math.exp(-((omega - wp) * (omega - wp)) / (2 * sigma * sigma * wp * wp));
  return ((alpha * G * G) / Math.pow(omega, 5)) * Math.exp(-1.25 * Math.pow(wp / omega, 4)) * Math.pow(gamma, r);
}

// cos^2s(theta/2) spreading, normalised over the full circle.
function spread(theta, s) {
  const norm = Math.exp(lgamma(s + 1) - lgamma(s + 0.5)) / (2 * Math.sqrt(Math.PI));
  return norm * Math.pow(Math.abs(Math.cos(theta * 0.5)), 2 * s);
}

export function makeWaveSystems(p) {
  const U = Math.max(p.windSpeed, 0.5);
  const F = p.fetch * 1000;
  const wind = {
    // fetch-limited JONSWAP, capped at the fully developed (Pierson-Moskowitz) sea for this wind
    wp: Math.max(22 * Math.pow((G * G) / (U * F), 1 / 3), (0.855 * G) / U),
    alpha: Math.max(0.076 * Math.pow((U * U) / (F * G), 0.22), 0.0081),
    gamma: 3.3,
    dir: p.windDir,
    scale: 1,
    sFixed: 0,
    U,
  };
  const systems = [wind];
  if (p.swellHeight > 0.01) {
    const wp = (2 * Math.PI) / p.swellPeriod;
    // Empirical: Hs of this JONSWAP shape is about 2.77 * sqrt(alpha) * g / wp^2; solve alpha from the target Hs.
    const hsUnit = (2.77 * G) / (wp * wp);
    const alpha = Math.pow(p.swellHeight / hsUnit, 2);
    systems.push({ wp, alpha, gamma: 6, dir: p.swellDir, scale: 1, sFixed: 26, U });
  }
  return systems;
}

function spectrumAt(kx, kz, k, systems, smallWaveFade) {
  const omega = Math.sqrt(G * k);
  const dwdk = G / (2 * omega);
  const theta = Math.atan2(kz, kx);
  let S = 0;
  for (const sys of systems) {
    let s;
    if (sys.sFixed) s = sys.sFixed;
    else {
      const sp = 11.5 * Math.pow((sys.wp * sys.U) / G, -2.5);
      const x = omega / sys.wp;
      s = x <= 1 ? sp * Math.pow(x, 5) : sp * Math.pow(x, -2.5);
      s = Math.min(Math.max(s, 1.2), 60);
    }
    let d = theta - sys.dir;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    S += sys.scale * jonswap(omega, sys.wp, sys.alpha, sys.gamma) * spread(d, s);
  }
  return ((S * dwdk) / k) * Math.exp(-k * k * smallWaveFade * smallWaveFade);
}

/**
 * Build the initial spectrum for one cascade.
 * Returns { data: Float32Array(N*N*4) [h0.re, h0.im, conj(h0(-k)).re, conj(h0(-k)).im],
 *           heightVar, slopeVarLostPerMip: Float32Array }.
 */
export function buildCascade(N, L, kLo, kHi, systems, seed, opts = {}) {
  const rand = mulberry32(seed);
  const dk = (2 * Math.PI) / L;
  const h0 = new Float32Array(N * N * 2);
  const amp2 = new Float32Array(N * N);
  const fade = opts.smallWaveFade ?? 0.0;
  for (let m = 0; m < N; m++) {
    const kz = dk * (m < N / 2 ? m : m - N);
    for (let n = 0; n < N; n++) {
      const kx = dk * (n < N / 2 ? n : n - N);
      const k = Math.hypot(kx, kz);
      // Box-Muller gaussian pair (always consumed so that seeds are stable between settings)
      const u1 = Math.max(rand(), 1e-9);
      const u2 = rand();
      const mag = Math.sqrt(-2 * Math.log(u1));
      const gr = mag * Math.cos(2 * Math.PI * u2);
      const gi = mag * Math.sin(2 * Math.PI * u2);
      if (k < kLo || k >= kHi || k < 1e-6) continue;
      const S = spectrumAt(kx, kz, k, systems, fade);
      const a = Math.sqrt(S * dk * dk * 0.5) * Math.SQRT1_2;
      const i = m * N + n;
      h0[i * 2] = gr * a;
      h0[i * 2 + 1] = gi * a;
      amp2[i] = (gr * gr + gi * gi) * a * a;
    }
  }
  const data = new Float32Array(N * N * 4);
  let heightVar = 0;
  const mips = Math.log2(N) + 1;
  const slopeKept = new Float64Array(mips);
  for (let m = 0; m < N; m++) {
    const mm = (N - m) % N;
    const im = m < N / 2 ? m : m - N;
    for (let n = 0; n < N; n++) {
      const nn = (N - n) % N;
      const i = m * N + n;
      const j = mm * N + nn;
      data[i * 4] = h0[i * 2];
      data[i * 4 + 1] = h0[i * 2 + 1];
      data[i * 4 + 2] = h0[j * 2];
      data[i * 4 + 3] = -h0[j * 2 + 1];
      if (amp2[i] > 0) {
        const inn = n < N / 2 ? n : n - N;
        const k2 = dk * dk * (inn * inn + im * im);
        heightVar += 2 * amp2[i];
        const sv = 2 * k2 * amp2[i];
        const idx = Math.max(Math.abs(inn), Math.abs(im));
        for (let l = 0; l < mips; l++) {
          if (idx < N / Math.pow(2, l + 1)) slopeKept[l] += sv;
          else break;
        }
      }
    }
  }
  const slopeVarLost = new Float32Array(mips);
  // per-axis variance lost at each mip level
  for (let l = 0; l < mips; l++) slopeVarLost[l] = Math.max(0, slopeKept[0] - slopeKept[l]) * 0.5;
  return { data, heightVar, slopeVar: slopeKept[0] * 0.5, slopeVarLost };
}

/** Butterfly lookup for a radix-2 inverse FFT: width log2(N), height N, RGBA = (w.re, w.im, idxA, idxB). */
export function buildButterfly(N) {
  const stages = Math.log2(N);
  const data = new Float32Array(stages * N * 4);
  const bitrev = (x) => {
    let r = 0;
    for (let b = 0; b < stages; b++) r |= ((x >> b) & 1) << (stages - 1 - b);
    return r;
  };
  for (let s = 0; s < stages; s++) {
    const span = 1 << s;
    for (let i = 0; i < N; i++) {
      const k = (i * (N >> (s + 1))) % N;
      const ang = (2 * Math.PI * k) / N;
      const top = i % (span * 2) < span;
      let a, b;
      if (s === 0) {
        a = top ? bitrev(i) : bitrev(i - 1);
        b = top ? bitrev(i + 1) : bitrev(i);
      } else {
        a = top ? i : i - span;
        b = top ? i + span : i;
      }
      const o = (i * stages + s) * 4;
      data[o] = Math.cos(ang);
      data[o + 1] = Math.sin(ang);
      data[o + 2] = a;
      data[o + 3] = b;
    }
  }
  return { data, stages };
}
