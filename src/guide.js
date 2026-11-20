// Setup guide: walks someone through describing their room one step at a
// time, in a panel that takes the sidebar's place while the map stays in
// view. This file owns the steps, their copy and their DOM. It reads and
// changes the app only through the `app` object modal.html passes to
// ModalGuide.create (see "Setup guide API" there), and keeps its own
// progress in localStorage under STORE_KEY, separate from room presets.
(function(global){
  const STORE_KEY = 'modal-guide-v1';

  const ROOM_SHAPES = [
    { id: 'closed', label: 'Closed rectangle', detail: 'Doors closed, or only doorway-sized openings.' },
    { id: 'open', label: 'Rectangle with a large opening', detail: 'Open to a kitchen, hallway or another room.' },
    { id: 'irregular', label: 'L-shaped or irregular', detail: 'Any plan that is not a single rectangle.' }
  ];
  const SHAPE_WARNING = "Modal's model assumes a closed rectangular room. In rooms with large openings or an L shape, the lowest bass modes are set by the combined space, so predicted peak and null locations won't be reliable. Results are shown for reference only.";

  // `count` is how many of the app's standard channels the layout uses, in
  // its own order (FL, FR, C, then surrounds, backs and wides).
  const SPEAKER_LAYOUTS = [
    { count: 2, label: 'Stereo', detail: 'Left and right' },
    { count: 3, label: '3.0', detail: 'Adds a center' },
    { count: 5, label: '5.x', detail: 'Adds side surrounds' },
    { count: 7, label: '7.x', detail: 'Adds surround backs' },
    { count: 9, label: '9.x', detail: 'Adds front wides' },
    { count: 0, label: 'Sub only', detail: 'No main speakers' }
  ];

  function create(app){
    const panel = document.getElementById('guidePanel');
    const rail = document.getElementById('guideRail');
    const guideBtn = document.getElementById('guideBtn');
    const coach = document.createElement('div');
    coach.id = 'coachMark';
    coach.setAttribute('role', 'status');
    coach.setAttribute('aria-live', 'polite');
    coach.hidden = true;
    document.body.appendChild(coach);

    // step: index into STEPS. roomShape: a ROOM_SHAPES id. viewBefore: the
    // map view to put back when the guide closes. seenWelcome: the welcome
    // step is shown once, not on every later visit to the guide.
    let state = { active: false, step: 0, roomShape: 'closed', viewBefore: null, seenWelcome: false };
    try { Object.assign(state, JSON.parse(localStorage.getItem(STORE_KEY))); } catch(e){ /* start from the defaults above */ }
    function save(){
      try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch(e){ /* progress just won't survive a reload */ }
    }

    // What the current step needs done after each redraw of the map (after
    // any change to the room, from the guide, the map or Undo). Set by the
    // step's render function, cleared when the step changes.
    let refreshStep = null;
    // Speaker the coach mark points at, and where it was when selected: the
    // mark goes away once that speaker has been moved.
    let coachTarget = null;
    // Where the last chosen layout put each speaker, by name, for the
    // "still at its default position" note.
    let layoutDefaults = {};

    const esc = (text) => String(text).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const choiceCards = (items, attr, pressedId) => items.map(it =>
      `<button class="guide-card" ${attr}="${it.id ?? it.count}" aria-pressed="${(it.id ?? it.count) === pressedId}"><strong>${esc(it.label)}</strong><span>${esc(it.detail)}</span>${it.extra || ''}</button>`
    ).join('');

    // ---- Step 0: welcome ----
    function renderWelcome(body){
      body.innerHTML = `
        <h2 tabindex="-1">Find the best subwoofer placement for your room</h2>
        <p>Below about 200 Hz, room modes create peaks and nulls that vary seat to seat by 10 to 20 dB, and sub position is the biggest lever you have.</p>
        <p>Enter your room, speakers and seating, and Modal will model the response and recommend where your sub(s) should go. A tape measure helps; estimates within a few inches are fine.</p>
        <div class="guide-field">
          <label>Units</label>
          <div class="segmented" id="guideUnits" role="group" aria-label="Units">
            <button data-unit="ft">Feet &amp; inches</button>
            <button data-unit="m">Meters</button>
          </div>
        </div>`;
      const sync = () => body.querySelectorAll('#guideUnits button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.unit === app.getLengthUnit())));
      body.querySelector('#guideUnits').addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if(btn) app.setLengthUnit(btn.dataset.unit);
      });
      sync();
      return sync;
    }

    // ---- Step 1: room ----
    function renderRoom(body){
      const lim = app.roomLimits;
      const DIMS = [
        { dim: 'w', label: 'Width', detail: 'Along the front wall', max: lim.maxWidthDepthFt, tooBig: 'rooms' },
        { dim: 'd', label: 'Length', detail: 'Front wall to back wall', max: lim.maxWidthDepthFt, tooBig: 'rooms' },
        { dim: 'h', label: 'Ceiling height', detail: 'Floor to ceiling', max: lim.maxHeightFt, tooBig: 'ceilings' }
      ];
      body.innerHTML = `
        <h2 tabindex="-1">Your room</h2>
        <h3>Room shape</h3>
        <div class="guide-cards one-col" id="guideShapes">${choiceCards(ROOM_SHAPES, 'data-shape', state.roomShape)}</div>
        <p class="guide-warning" id="guideShapeWarning" hidden>${esc(SHAPE_WARNING)}</p>
        <h3>Room dimensions</h3>
        <p>Measure wall to wall at floor level. The front wall is the one your screen and front speakers are on; it is the top of the map.</p>
        ${DIMS.map(f => `
          <div class="guide-field">
            <label>${f.label}<span>${f.detail}</span></label>
            <span data-dim="${f.dim}"></span>
          </div>
          <p class="guide-warning" data-dim-msg="${f.dim}" hidden></p>`).join('')}`;

      const warning = body.querySelector('#guideShapeWarning');
      const syncShape = () => {
        body.querySelectorAll('#guideShapes button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.shape === state.roomShape)));
        warning.hidden = state.roomShape === 'closed';
      };
      body.querySelector('#guideShapes').addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if(!btn) return;
        state.roomShape = btn.dataset.shape;
        save();
        syncShape();
      });
      syncShape();

      const room = app.getRoom();
      const writers = {};
      for(const f of DIMS){
        const holder = body.querySelector(`[data-dim="${f.dim}"]`);
        const msg = body.querySelector(`[data-dim-msg="${f.dim}"]`);
        writers[f.dim] = app.lengthField(holder, room[f.dim], (ft) => {
          // The app clamps to its supported range; say so when it did.
          const stored = app.setRoomDim(f.dim, ft);
          msg.hidden = Math.abs(stored - ft) < 0.005;
          msg.textContent = ft < stored
            ? `Under ${app.formatLength(lim.minFt)}. Check the measurement. Using ${app.formatLength(stored)}.`
            : `Modal supports ${f.tooBig} up to ${app.formatLength(f.max)}. Larger spaces behave less like a closed room and the model loses accuracy. Using ${app.formatLength(stored)}.`;
          writers[f.dim](stored);
        });
      }
      return () => {
        const now = app.getRoom();
        for(const f of DIMS){
          if(!body.querySelector(`[data-dim="${f.dim}"]`).contains(document.activeElement)) writers[f.dim](now[f.dim]);
        }
      };
    }

    // ---- Step 2: speakers ----
    // A small plan of where a layout's speakers go, for its card: the same
    // RoomPhysics.standardSpeakerPositions the app places them with, in a
    // nominal 18 x 13.5 ft room.
    function layoutDiagram(count){
      const dots = RoomPhysics.standardSpeakerPositions({ w: 18, d: 13.5 }, { x: 9, y: 8.5 }, app.mainChannelNames.slice(0, count))
        .map(p => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="1"/>`).join('');
      return `<svg viewBox="-1 -1 20 15.5" aria-hidden="true"><rect x="0" y="0" width="18" height="13.5" rx="0.8"/>${dots}<path d="M7.6 9.3h2.8"/></svg>`;
    }
    function renderSpeakers(body){
      body.innerHTML = `
        <h2 tabindex="-1">Your speakers</h2>
        <h3>Speaker layout</h3>
        <p>Pick the layout you have. Choosing one places its speakers at their usual angles from the seat. Subwoofers are not affected.</p>
        <div class="guide-cards" id="guideLayouts">${choiceCards(SPEAKER_LAYOUTS.map(l => ({ ...l, extra: layoutDiagram(l.count) })), 'data-count', -1)}</div>
        <h3>Positions</h3>
        <p id="guideSpeakersIntro"></p>
        <div id="guideSpeakerList"></div>
        <p class="guide-note" id="guideDefaultsNote" hidden></p>`;
      const list = body.querySelector('#guideSpeakerList');
      const note = body.querySelector('#guideDefaultsNote');
      let rows = []; // { id, writeX, writeY, el }

      body.querySelector('#guideLayouts').addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if(!btn) return;
        layoutDefaults = Object.fromEntries(app.setMainLayout(Number(btn.dataset.count)).map(p => [p.name, p]));
        const first = app.getMains()[0];
        coachTarget = first ? { ...first } : null;
        refresh();
      });
      const select = (id) => {
        const s = app.getMains().find(m => m.id === id);
        coachTarget = s ? { ...s } : null;
        refresh();
      };
      function buildList(mains){
        list.innerHTML = mains.map(s => `
          <div class="guide-speaker" data-id="${s.id}">
            <button class="small guide-speaker-name" title="Show ${esc(s.name)} on the map">${esc(s.name)}</button>
            <div class="guide-field"><label>From left wall</label><span data-axis="x"></span></div>
            <div class="guide-field"><label>From front wall</label><span data-axis="y"></span></div>
          </div>`).join('');
        rows = mains.map(s => {
          const el = list.querySelector(`[data-id="${s.id}"]`);
          const current = () => app.getMains().find(m => m.id === s.id);
          el.querySelector('.guide-speaker-name').addEventListener('click', () => select(s.id));
          el.addEventListener('focusin', () => { if(!coachTarget || coachTarget.id !== s.id) select(s.id); });
          return {
            id: s.id, el,
            writeX: app.lengthField(el.querySelector('[data-axis="x"]'), s.x, (ft) => app.moveSource(s.id, ft, current().y)),
            writeY: app.lengthField(el.querySelector('[data-axis="y"]'), s.y, (ft) => app.moveSource(s.id, current().x, ft))
          };
        });
      }
      function refresh(){
        const mains = app.getMains();
        if(mains.length !== rows.length || mains.some((s, i) => s.id !== rows[i].id)) buildList(mains);
        body.querySelectorAll('#guideLayouts button').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.count) === mains.length)));
        body.querySelector('#guideSpeakersIntro').textContent = mains.length
          ? 'Drag each speaker on the map to where it really is, or enter its distance from two walls.'
          : 'No main speakers to place.';
        mains.forEach((s, i) => {
          const row = rows[i];
          row.el.classList.toggle('selected', !!coachTarget && coachTarget.id === s.id);
          if(!row.el.contains(document.activeElement)){ row.writeX(s.x); row.writeY(s.y); }
        });
        const untouched = mains.filter(s => layoutDefaults[s.name] && Math.abs(layoutDefaults[s.name].x - s.x) < 0.01 && Math.abs(layoutDefaults[s.name].y - s.y) < 0.01);
        note.hidden = untouched.length === 0;
        note.textContent = `Still at ${untouched.length === 1 ? 'its default position' : 'their default positions'}: ${untouched.map(s => s.name).join(', ')}.`;
        positionCoach(mains);
      }
      if(!coachTarget){
        const first = app.getMains()[0];
        if(first) coachTarget = { ...first };
      }
      refresh();
      return refresh;
    }

    // The coach mark points at one speaker until that speaker moves.
    function positionCoach(mains){
      const s = coachTarget && mains.find(m => m.id === coachTarget.id);
      if(s && (Math.abs(s.x - coachTarget.x) > 0.01 || Math.abs(s.y - coachTarget.y) > 0.01)) coachTarget = null;
      if(!s || !coachTarget){ coach.hidden = true; return; }
      const at = app.roomToClient(s.x, s.y);
      coach.textContent = `Drag ${s.name} to its real position, or enter its distance from two walls.`;
      coach.hidden = false;
      // Below the speaker unless that would leave the viewport.
      const below = at.y + 34 + coach.offsetHeight < window.innerHeight;
      coach.classList.toggle('above', !below);
      coach.style.left = Math.max(8, Math.min(window.innerWidth - coach.offsetWidth - 8, at.x - coach.offsetWidth / 2)) + 'px';
      coach.style.top = (below ? at.y + 34 : at.y - 34 - coach.offsetHeight) + 'px';
    }

    // `title` puts a step on the rail; the welcome step has none.
    const STEPS = [
      { render: renderWelcome, next: 'Start setup' },
      { title: 'Room', render: renderRoom },
      { title: 'Speakers', render: renderSpeakers }
    ];

    function renderRail(){
      rail.innerHTML = STEPS.map((st, i) => st.title
        ? `<li><button data-step="${i}" ${i === state.step ? 'aria-current="step"' : ''}><span class="guide-rail-num">${i}</span><span class="guide-rail-title">${st.title}</span></button></li>`
        : '').join('');
    }
    rail.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if(btn) goTo(Number(btn.dataset.step));
    });

    function goTo(step){
      state.step = Math.max(0, Math.min(STEPS.length - 1, step));
      if(state.step > 0) state.seenWelcome = true;
      save();
      refreshStep = null;
      coachTarget = null;
      coach.hidden = true;
      const last = state.step === STEPS.length - 1;
      panel.innerHTML = `
        <div class="guide-body"></div>
        <div class="guide-footer">
          <div class="guide-nav">
            <button id="guideBackBtn" ${state.step === 0 ? 'hidden' : ''}>Back</button>
            <button id="guideNextBtn" class="primary">${STEPS[state.step].next || (last ? 'Finish' : 'Next')}</button>
          </div>
          <button class="guide-skip" id="guideSkipBtn">${state.step === 0 ? 'Skip to the full tool' : 'Exit the guide'}</button>
        </div>`;
      panel.querySelector('#guideBackBtn').addEventListener('click', () => goTo(state.step - 1));
      panel.querySelector('#guideNextBtn').addEventListener('click', () => last ? close(true) : goTo(state.step + 1));
      panel.querySelector('#guideSkipBtn').addEventListener('click', () => close(false));
      refreshStep = STEPS[state.step].render(panel.querySelector('.guide-body'));
      renderRail();
      panel.querySelector('h2').focus({ preventScroll: true });
      panel.parentElement.scrollTop = 0;
    }

    function setActive(active){
      state.active = active;
      document.body.classList.toggle('guide-active', active);
      rail.hidden = !active;
      guideBtn.textContent = active ? 'Exit guide' : 'Setup guide';
      guideBtn.setAttribute('aria-pressed', String(active));
    }
    function open(){
      // The placement steps read better on the plain floor plan; the view in
      // use before is put back on the way out.
      state.viewBefore = app.getMapView();
      setActive(true);
      app.setMapView('plan');
      goTo(state.seenWelcome ? Math.max(1, state.step) : 0);
    }
    // Leaves the guide for the full tool. The step is kept, so reopening
    // the guide carries on from it; finishing starts it over from the room.
    function close(finished){
      setActive(false);
      refreshStep = null;
      coach.hidden = true;
      panel.innerHTML = '';
      if(finished) state.step = 1;
      save();
      if(state.viewBefore) app.setMapView(state.viewBefore);
    }

    const refreshActiveStep = () => { if(state.active && refreshStep) refreshStep(); };
    app.onDraw(refreshActiveStep);
    window.addEventListener('resize', refreshActiveStep); // the coach mark follows the map when the window or tablet orientation changes

    return {
      toggle(){ if(state.active) close(false); else open(); },
      // Called once the app has loaded: picks the guide back up at the step
      // it was on if the page was closed or reloaded partway through.
      resume(){
        if(!state.active) return;
        setActive(true);
        goTo(state.step);
      }
    };
  }

  global.ModalGuide = { create };
})(window);
