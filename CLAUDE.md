## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them; don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it; don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

**Exception: eliminating duplication per "The architectural split" below always applies**, even when the code being consolidated isn't broken. "Don't refactor things that aren't broken" is about not gratuitously rewriting or reformatting code unrelated to the task at hand, not a block on consolidating a duplicate physics/search implementation into `room-physics.js` when that's what the task calls for.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

## 5. Prefer Settled Practice

Default to industry-standard approaches, algorithms, and libraries over inventing something novel. Only call it out if there's a real tradeoff worth surfacing (see "Think Before Coding" above), not as a standing report requirement.

# Working in this repo

Modal is a browser-based room acoustics simulator: `src/room-physics.js` (pure physics/math), `src/field-render.js` (CPU/GPU rendering), `src/modal.html` (UI/DOM), `src/modal.css` (its styles), `src/guide.js` (the setup guide's step panel, DOM only, driven through an API object from `modal.html`), `src/room-physics.test.js` (the only test suite). No build step, no framework beyond a hand-rolled test runner. See `README.md` for what the app does; this file is about how to work on it correctly.

## The architectural split (enforce this)

**`room-physics.js` owns every physics/math/search algorithm. `modal.html` owns DOM, canvas drawing, and orchestration only.** Concretely:

- If you're about to write a loop that scores candidate positions, sums a field, computes an average/weight, or searches/optimizes anything, that code belongs in `room-physics.js` as a plain, DOM-free function, not inline in `modal.html`. `modal.html` should only ever *call* `RoomPhysics.*` and wire the result into the page.
- **Before adding new logic to `modal.html`, check whether an equivalent function already exists in `room-physics.js` first.** Reuse it. If it's close but not quite right, extend or generalize the existing function (additively, so existing callers/tests keep working) rather than writing a second version next to it.
- If `modal.html` needs an async/chunked variant of something for UI responsiveness (yielding to `requestAnimationFrame` during a long search), that async wrapper still belongs in `room-physics.js`, built on a shared primitive with its sync twin (see `scanGridCandidates` driving both `optimizeSubPlacement` and `optimizeSubPlacementAsync`; see `polishSubPlacements`/`polishSubPlacementsAsync` as a standalone entry point extracted so a second caller could reuse the exact same refinement loop instead of a third hand-copied version). Never hand-duplicate a search/scoring loop between a sync and async version, or between two UI workflows, "just for now": it doesn't stay in sync.
- **Every exported `room-physics.js` function needs coverage in `room-physics.test.js`.** A physics/optimizer change with no new or updated test is incomplete.

## Workflow

- **Branch and PR, never commit directly to `main`.** Create a feature branch before any commit in this repo, push it, and hand off the PR link. This applies even for small changes.
- **Verify before calling something done:**
  1. `node src/room-physics.test.js` for any `room-physics.js` change; the full suite must stay green.
  2. Syntax-check `modal.html`'s inline `<script>` (extract it to a temp `.js` file, `node --check` it), since there's no separate JS file to lint.
  3. For UI-facing changes, an actual Playwright browser check: start a local static server (`npx --yes serve src -l <port>`, backgrounded), and drive it with a small script (chromium.launch, page.goto, assert on locators/console errors). Compiling and passing physics tests are necessary but not sufficient; real bugs here have repeatedly only shown up in actual canvas/drag/preset behavior.
  4. Verify claims about behavior or performance with real computed numbers (a direct `node -e` calculation, a measured timing, an actual before/after score), not qualitative reasoning about what should happen.
- **Any change to what `makeConfig()`/`loadConfig()` store in a saved preset** needs a backward-compatible migration path in `loadConfig` for presets saved under the old shape (check for `cfg.<oldField>` and convert), not a silent break. Verify the migration itself in-browser: inject an old-shape preset into `localStorage`, reload, load it, confirm it migrates correctly.
- **Prose style** (README, code comments, commit messages, PR descriptions): no em-dash and no double-hyphen used as sentence-interrupting punctuation (hyphenated compound words like "well-known" are fine); rephrase with a comma, semicolon, colon, "since"/"because", or two sentences instead.
