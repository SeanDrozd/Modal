# Modal

A browser-based bass simulator for home theaters and listening rooms. Enter your room, speakers, subs and seats, see where peaks and nulls form, and let the optimizer find better subwoofer positions.

**[Try it live](https://seandrozd.github.io/Modal/)**, or open `src/modal.html` in a browser. No build step, no install.

![Frequency sweep across a room with two symmetrically placed subs, showing a null forming at the listening position](docs/sweep-demo.webp)

Symmetric sub placement looks tidy but excites the room's modes symmetrically, often putting a null right at the center seat. The optimizer breaks that symmetry; the heat map and the averaged frequency response improve together:

![The optimizer moving the same two subs off the symmetric null](docs/optimizer-demo.webp)

## Screenshots

![The setup guide's optimize step: result card with verdict and before/after response, next to the pressure map](docs/guide.png)

| | |
|---|---|
| ![Main view: pressure field, sources and the stereo-triangle guide](docs/overview.png) | ![Optimizer score heatmap and suggested position](docs/optimizer.png) |
| Main view | Optimizer score heatmap |

![Per-wall and ceiling material configuration](docs/materials.png)

## Features

- **Setup guide.** Opens on first launch (skippable, reopen from the header). Seven steps: room, speaker layout (stereo through 9.x), subs you have or plan to buy, seat rows, furniture and no-go areas, optimize, and a printable setup sheet with each sub's distance from two walls and AVR distance advice. Non-rectangular or open rooms get a "results won't be reliable" warning. Less common terms have a "?" definition.
- **Optimizer.** Scores candidate sub positions across every seat, weighted by row rank and seat position. "Balanced" mode minimizes variation and penalizes deep nulls; "Null avoidance" is for rooms with room correction. Multiple subs are placed greedily, then refined with coordinate-descent passes. New subs keep clear of each other and of each speaker's footprint back to its wall. The result is graded as a major (6 dB or more), modest (2 dB or more), similar, or worse change in score.
- **Zones and furniture.** Off-limits, allowed-only and preferred zones, plus a furniture palette (couch, TV stand, bed, desk and more). Furniture only excludes sub positions; it is not part of the acoustic model.
- **Sources and seats.** Any number of mains and subs with level, delay, crossover range and slope, and height. Delays auto time-align to the main seat. Multiple ranked seat rows of 1 to 5 seats.
- **Room construction.** Per-wall, floor and ceiling materials, each with a frequency-dependent absorption curve.
- **Views.** Floor plan or pressure map, frequency sweep, frequency response chart with the spread across all seats and an optimizer preview overlay. GPU rendering with CPU fallback.
- **Quality of life.** Undo/redo, saved room presets, feet/meters, Auto/Light/Dark with four color themes, tablet support (768px and up, touch and pen).

## How it works

Modal computes a single-frequency, steady-state pressure field with an exact rectangular-room modal solution, summing every mode up to 300 Hz (including the pressure-zone term). It is meant for the bass range where room modes dominate, not as a substitute for measurement.

```
p(r, r_s, f) = Σ_n  A_n · ψ_n(r) · ψ_n(r_s) / (k_n² − k² − j·k·δ_n)
ψ_n(r) = cos(nx·π·x/Lx) · cos(ny·π·y/Ly) · cos(nz·π·z/Lz)
```

- **Damping** per mode comes from the surface absorption at that mode's frequency (Morse/Kuttruff), so axial modes decay more slowly than oblique ones. Drywall is modeled as a resonant absorber, masonry as flat, ceiling tile as a high-frequency ramp.
- **Frequency range** adapts to the room: it runs to the worst-case Schroeder frequency plus headroom, with T60 estimated from your materials by Eyring's formula.
- **Frequency response** is averaged like a moving mic: 20 deterministic points in a 2 ft sphere around each seat, averaged by power.

  ![The 20 sample points inside their 2 ft sphere](docs/sphere-sampling-demo.gif)

- **Seat weighting:** each row counts half as much as the one above it; within a row, center seats count fully and the ends count half. The worst null is always found, but its penalty is scaled by that seat's weight.
- **Delay** is true time delay, like an AVR's distance setting, not a sub's phase switch. The geometric figure ignores the sub's own processing latency, so trust room correction's measured distance over it.

**Not modeled:** furniture, openings and localized treatment (rugs, panels); only the six room surfaces. The heat map is exact-point, so it looks sharper than what you hear. Material values are typical construction, not measurements of your walls.

## Development

| Path | Role |
|---|---|
| `src/room-physics.js` | All physics and optimizer math, pure functions, no DOM |
| `src/room-physics.test.js` | Test suite: `node src/room-physics.test.js` |
| `src/field-render.js` | Field rendering, CPU (canvas2d) and GPU (WebGL) |
| `src/modal.html`, `src/modal.css` | UI, canvas drawing, presets |
| `src/guide.js` | Setup guide panel, driven through an API object from `modal.html` |
| `tools/` | Dev-only scripts that regenerate `docs/` media |

**Regenerating docs media:**

```sh
cd tools
npm install
npm run capture-docs-media            # screenshots and WebP animations (uses Edge; see the script to switch to Chromium)
npm install --no-save gifenc && npm run render-sphere-demo   # sphere-sampling GIF
```

**Deploying:** GitHub Pages serves the repo as-is (Settings → Pages → deploy from `main`, root). The root `index.html` redirects to `src/modal.html`, and `.nojekyll` skips Jekyll. A Pages site is public even from a private repo.

## Credits

Built with [Claude](https://claude.com/claude-code), from the project owner's direction and review.
