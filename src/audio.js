// Procedural ambience (no audio files): surf, wind, water along the hull and rain, all shaped noise.
export class Ambience {
  constructor() {
    this.ctx = null;
    this.on = false;
    this.state = { wind: 7, speed: 3, rain: 0 };
  }

  _build() {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const len = ctx.sampleRate * 6;
    const white = ctx.createBuffer(1, len, ctx.sampleRate);
    const brown = ctx.createBuffer(1, len, ctx.sampleRate);
    const w = white.getChannelData(0), b = brown.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      w[i] = Math.random() * 2 - 1;
      last = (last + 0.02 * w[i]) / 1.02;
      b[i] = last * 3.5;
    }
    const source = (buffer) => {
      const s = ctx.createBufferSource();
      s.buffer = buffer; s.loop = true; s.start(0, Math.random() * 5);
      return s;
    };
    const chain = (buffer, type, freq, q) => {
      const f = ctx.createBiquadFilter();
      f.type = type; f.frequency.value = freq; f.Q.value = q;
      const g = ctx.createGain();
      g.gain.value = 0;
      source(buffer).connect(f).connect(g).connect(this.master);
      return { f, g };
    };
    const lfo = (rate, depth, param) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = rate; g.gain.value = depth;
      o.connect(g).connect(param); o.start();
    };
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(ctx.destination);
    this.sea = chain(brown, 'lowpass', 500, 0.3);
    this.surf = chain(white, 'bandpass', 900, 0.4);
    this.wind = chain(white, 'bandpass', 420, 1.1);
    this.hull = chain(white, 'bandpass', 1700, 0.5);
    this.rain = chain(white, 'highpass', 3200, 0.3);
    // waves come in sets, wind gusts wander
    lfo(0.09, 0.25, this.sea.g.gain);
    lfo(0.143, 0.05, this.surf.g.gain);
    lfo(0.061, 140, this.wind.f.frequency);
    lfo(0.17, 0.03, this.wind.g.gain);
    lfo(0.31, 0.02, this.hull.g.gain);
    this.ctx = ctx;
  }

  setEnabled(on) {
    this.on = on;
    if (on && !this.ctx) this._build();
    if (!this.ctx) return;
    if (on) this.ctx.resume();
    this.master.gain.setTargetAtTime(on ? 0.6 : 0, this.ctx.currentTime, 0.4);
    this.update(this.state);
  }

  /** wind in m/s, speed of the ship in m/s, rain 0..1 */
  update(state) {
    Object.assign(this.state, state);
    if (!this.ctx || !this.on) return;
    const { wind, speed, rain } = this.state;
    const t = this.ctx.currentTime;
    const k = Math.min(wind / 20, 1);
    this.sea.g.gain.setTargetAtTime(0.45 + 0.5 * k, t, 1);
    this.surf.g.gain.setTargetAtTime(0.03 + 0.14 * k * k, t, 1);
    this.wind.g.gain.setTargetAtTime(0.015 + 0.3 * k * k, t, 1);
    this.wind.f.frequency.setTargetAtTime(320 + 500 * k, t, 1);
    this.hull.g.gain.setTargetAtTime(0.012 * speed * speed, t, 0.5);
    this.rain.g.gain.setTargetAtTime(0.16 * rain, t, 0.8);
  }
}
