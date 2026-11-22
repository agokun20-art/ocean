// The on-screen controls: one-click sky / sea / view choices, a few toggles, and the helm read-out.
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

export class Panel {
  constructor() {
    this.root = el('div', 'panel');
    this.root.id = 'panel';
    document.body.appendChild(this.root);
    this.groups = {};
  }

  /** A row of mutually exclusive choices. `options` is [{ id, label, title }]. */
  choices(key, label, options, current, onPick) {
    const row = el('div', 'row');
    row.appendChild(el('div', 'label', label));
    const pills = el('div', 'pills');
    const buttons = {};
    for (const o of options) {
      const b = el('button', 'pill', o.label);
      if (o.title) b.title = o.title;
      b.addEventListener('click', () => { this.select(key, o.id); onPick(o.id); b.blur(); });
      pills.appendChild(b);
      buttons[o.id] = b;
    }
    row.appendChild(pills);
    this.root.appendChild(row);
    this.groups[key] = buttons;
    this.select(key, current);
  }

  select(key, id) {
    for (const [k, b] of Object.entries(this.groups[key])) b.classList.toggle('on', k === String(id));
  }

  /** A row of independent on/off switches. `items` is [{ id, label, title, value, onChange }]. */
  toggles(label, items) {
    const row = el('div', 'row');
    row.appendChild(el('div', 'label', label));
    const pills = el('div', 'pills');
    const out = {};
    for (const it of items) {
      const b = el('button', 'pill', it.label);
      if (it.title) b.title = it.title;
      const set = (v) => { b.classList.toggle('on', v); b.setAttribute('aria-pressed', v); };
      set(!!it.value);
      b.addEventListener('click', () => { const v = !b.classList.contains('on'); set(v); it.onChange(v); b.blur(); });
      pills.appendChild(b);
      out[it.id] = set;
    }
    row.appendChild(pills);
    this.root.appendChild(row);
    return out;
  }

  slider(label, min, max, value, onInput) {
    const row = el('div', 'row');
    row.appendChild(el('div', 'label', label));
    const input = el('input');
    Object.assign(input, { type: 'range', min, max, step: 1, value });
    input.addEventListener('input', () => onInput(parseFloat(input.value)));
    row.appendChild(input);
    this.root.appendChild(row);
    return (v) => { input.value = v; };
  }
}

const POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/** Helm read-out at the bottom of the screen: speed, heading, sail set and rudder angle. */
export class Hud {
  constructor() {
    this.root = el('div', 'hud');
    this.root.id = 'hud';
    const cell = (name) => {
      const c = el('div', 'cell');
      const v = el('div', 'value');
      c.append(v, el('div', 'name', name));
      this.root.appendChild(c);
      return v;
    };
    this.speed = cell('knots');
    this.heading = cell('heading');
    const sails = cell('sails  W / S');
    this.sailBar = el('div', 'bar');
    this.sailFill = el('div');
    this.sailBar.appendChild(this.sailFill);
    sails.appendChild(this.sailBar);
    const rudder = cell('rudder  A / D');
    this.rudderBar = el('div', 'bar rudder');
    this.rudderDot = el('div');
    this.rudderBar.appendChild(this.rudderDot);
    rudder.appendChild(this.rudderBar);
    document.body.appendChild(this.root);
  }

  update(ship) {
    this.speed.textContent = (ship.speed * 1.944).toFixed(1);
    const f = ship.forward;
    const deg = ((Math.atan2(f.x, -f.y) * 180) / Math.PI + 360) % 360; // north is -z
    this.heading.textContent = `${String(Math.round(deg) % 360).padStart(3, '0')}° ${POINTS[Math.round(deg / 45) % 8]}`;
    this.sailFill.style.width = `${Math.round(ship.throttle * 100)}%`;
    this.rudderDot.style.left = `${50 + ship.rudder * 46}%`;
  }
}
