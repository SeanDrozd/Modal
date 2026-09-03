# Working in this repo

Modal is a browser-based room acoustics simulator: `src/room-physics.js` (pure physics/math), `src/field-render.js` (CPU/GPU rendering), `src/modal.html` (UI/DOM), `src/room-physics.test.js` (the only test suite). No build step, no framework beyond a hand-rolled test runner. See `README.md` for what the app does; this file is about how to work on it correctly.

## The architectural split (enforce this)

**`room-physics.js` owns every physics/math/search algorithm. `modal.html` owns DOM, canvas drawing, and orchestration only.** Concretely:

- If you're about to write a loop that scores candidate positions, sums a field, computes an average/weight, or searches/optimizes anything, that code belongs in `room-physics.js` as a plain, DOM-free function, not inline in `modal.html`. `modal.html` should only ever *call* `RoomPhysics.*` and wire the result into the page.
- **Before adding new logic to `modal.html`, check whether an equivalent function already exists in `room-physics.js` first.** Reuse it. If it's close but not quite right, extend or generalize the existing function (additively, so existing callers/tests keep working) rather than writing a second version next to it.
- If `modal.html` needs an async/chunked variant of something for UI responsiveness (yielding to `requestAnimationFrame` during a long search), that async wrapper still belongs in `room-physics.js`, built on a shared primitive with its sync twin (see `scanGridCandidates` driving both `optimizeSubPlacement` and `optimizeSubPlacementAsync`; see `polishSubPlacements`/`polishSubPlacementsAsync` as a standalone entry point extracted so a second caller could reuse the exact same refinement loop instead of a third hand-copied version). Never hand-duplicate a search/scoring loop between a sync and async version, or between two UI workflows, "just for now": it doesn't stay in sync.
- **Every exported `room-physics.js` function needs coverage in `room-physics.test.js`.** A physics/optimizer change with no new or updated test is incomplete.

**Why this matters, concretely:** `modal.html` once had its own hand-written copy of the optimizer's grid-search loop instead of calling `RoomPhysics.optimizeSubPlacement`. A real bug (the sub-placement exclusion zone not accounting for existing sources) got fixed in one copy and missed in the other, and only surfaced later via code review. The fix was a full consolidation PR deleting the duplicate. Don't recreate that problem: one implementation of any given algorithm, in `room-physics.js`, called from wherever it's needed.

## Workflow

- **Branch and PR, never commit directly to `main`.** Create a feature branch before any commit in this repo, push it, and hand off the PR link. This applies even for small changes.
- **Verify before calling something done:**
  1. `node src/room-physics.test.js` for any `room-physics.js` change; the full suite must stay green.
  2. Syntax-check `modal.html`'s inline `<script>` (extract it to a temp `.js` file, `node --check` it), since there's no separate JS file to lint.
  3. For UI-facing changes, an actual Playwright browser check: start a local static server (`npx --yes serve src -l <port>`, backgrounded), and drive it with a small script (chromium.launch, page.goto, assert on locators/console errors). Compiling and passing physics tests are necessary but not sufficient; real bugs here have repeatedly only shown up in actual canvas/drag/preset behavior.
  4. Verify claims about behavior or performance with real computed numbers (a direct `node -e` calculation, a measured timing, an actual before/after score), not qualitative reasoning about what should happen.
- **Any change to what `makeConfig()`/`loadConfig()` store in a saved preset** needs a backward-compatible migration path in `loadConfig` for presets saved under the old shape (check for `cfg.<oldField>` and convert), not a silent break. Verify the migration itself in-browser: inject an old-shape preset into `localStorage`, reload, load it, confirm it migrates correctly.
- **Prose style** (README, code comments, commit messages, PR descriptions): no em-dash and no double-hyphen used as sentence-interrupting punctuation (hyphenated compound words like "well-known" are fine); rephrase with a comma, semicolon, colon, "since"/"because", or two sentences instead. Write each paragraph as one continuous line, no manual word-wrapping.
