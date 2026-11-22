# Ocean

Real-time ocean with a sailing ship, rendered in the browser with WebGL2 (three.js).

## Run (macOS)

Needs [Node.js](https://nodejs.org) 18 or newer.

```sh
npm install
npm start
```

`npm start` downloads the ship model and sky panoramas on first run (about 170 MB) and opens the scene
in your default browser. Chrome gives the best frame rate; Safari and Firefox also work.

## Controls

Sailing:

- `W` / `S` (or up / down arrows): set more or less sail
- `A` / `D` (or left / right arrows): hold to put the rudder over
- The read-out at the bottom shows speed in knots, compass heading, sail set and rudder angle

Looking around:

- Drag to orbit, scroll to zoom
- `1`-`5` or the View buttons: Bow, Stern, Ahead, Aerial, Helm (behind the ship, best for steering)
- `Space` pause, `H` hide all controls

Panel (top left):

- **Sky**: Golden hour, Clear, Clouds, Midday, Dusk, Overcast
- **Sea**: Calm, Breeze, Fresh, Rough, Storm (Storm also brings rain and an overcast sky)
- **Sun**: drag to move the sun around the horizon
- **More**: Rain, Sound (sea, wind and rain ambience), camera turning with the ship, and Fine tuning
  (wind, swell, foam, exposure, haze, quality)

Quality can also be set in the URL: `?q=low|medium|high|ultra` (default `high`).

## How it works

- **Waves**: JONSWAP wind sea plus swell, four FFT cascades (1171 m to 6 m) computed on the GPU each frame,
  with horizontal (choppy) displacement and Jacobian-based whitecaps.
- **Water shading**: Fresnel reflection of the HDR sky, sun glitter from the slope statistics of the
  waves that are too small to resolve, subsurface scattering, depth-based absorption, refraction of the
  hull, planar reflection of the ship, shadows, foam and aerial perspective.
- **Ship**: floats on the simulated surface (heave, pitch and roll fitted to the water under the hull),
  heels in turns, makes its own bow wave and Kelvin wake, throws spray at the bow and leaves a foam and
  calmed-water trail. Sails ripple, and the stern lanterns light up when the sky is dim.
- **Weather**: rain streaks, reduced visibility and a rain-pocked surface; ambience is synthesised in the
  browser, no audio files.

## Credits

Ship (`ship_pinnace`) and sky HDRIs from [Poly Haven](https://polyhaven.com), CC0.
