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

- Drag to orbit, scroll to zoom
- `1`-`4` camera views, `H` hide the panel, `Space` pause
- Panel: wind, swell, foam, time of day, sun direction, exposure, ship speed, quality

Quality can also be set in the URL: `?q=low|medium|high|ultra` (default `high`).

## How it works

- **Waves**: JONSWAP wind sea plus swell, four FFT cascades (1171 m to 6 m) computed on the GPU each frame,
  with horizontal (choppy) displacement and Jacobian-based whitecaps.
- **Water shading**: Fresnel reflection of the HDR sky, sun glitter from the slope statistics of the
  waves that are too small to resolve, subsurface scattering, depth-based absorption, refraction of the
  hull, planar reflection of the ship, shadows, foam and aerial perspective.
- **Ship**: floats on the simulated surface (heave, pitch and roll fitted to the water under the hull)
  and leaves a foam and calmed-water wake.

## Credits

Ship (`ship_pinnace`) and sky HDRIs from [Poly Haven](https://polyhaven.com), CC0.
