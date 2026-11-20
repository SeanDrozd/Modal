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
  // `mode` is the optimizer mode each answer selects.
  const ROOM_CORRECTION = [
    { id: 'yes', label: 'Yes', mode: 'nullAvoidance' },
    { id: 'no', label: 'No', mode: 'balanced' },
    { id: 'unsure', label: 'Not sure', mode: 'balanced' }
  ];

  // The definitions behind the "?" buttons (see term() below): the terms the
  // guide uses that an AVR owner may know by name without knowing exactly
  // what they mean here. Everyday ones (Hz, dB, crossover) are not listed.
  const GLOSSARY = {
    mode: { term: 'Room mode', text: "A frequency at which bass reflecting between the room's surfaces reinforces itself into a standing wave. At that frequency some parts of the room are loud and others nearly silent." },
    null: { term: 'Null', text: 'A frequency at which reflections cancel the direct sound at one spot, so the level drops sharply there. More power or EQ does not fill a null; moving the sub or the seat does.' },
    roomCorrection: { term: 'Room correction', text: "The AVR's automatic setup: it plays test tones through a supplied microphone, then sets speaker distances, levels and EQ. Audyssey, YPAO, Dirac Live, MCACC, AccuEQ and ARC are common names for it." },
    score: { term: 'Optimizer score', text: 'What the search maximizes. Without room correction: average level minus response variation, with a further penalty for a null more than 20 dB deep. With room correction: the level of the deepest dip, since EQ can pull peaks down but cannot fill a null.' },
    variation: { term: 'Response variation', text: 'The standard deviation of level across the frequency range, at the seat where it is largest. Lower is more even.' },
    seatToSeat: { term: 'Seat-to-seat variation', text: 'Half the gap between the loudest and the quietest seat at each frequency, averaged over the range. Lower means every seat gets closer to the same bass.' },
    spatialAverage: { term: 'Spatial averaging', text: 'The response is averaged over 20 points within 2 ft (0.6 m) of the seat, not read at one exact point, much like moving a measurement mic around the listening position.' }
  };

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

    // The one definition popover, shown under whichever "?" was pressed.
    const termNote = document.createElement('div');
    termNote.id = 'termNote';
    termNote.setAttribute('role', 'status');
    termNote.hidden = true;
    document.body.appendChild(termNote);
    let termBtn = null;
    function closeTerm(){
      if(termBtn) termBtn.setAttribute('aria-expanded', 'false');
      termBtn = null;
      termNote.hidden = true;
    }
    // Any click closes an open definition; a click on a different "?" opens that one.
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.guide-term');
      const open = btn && btn !== termBtn;
      closeTerm();
      if(!open) return;
      const entry = GLOSSARY[btn.dataset.term];
      termNote.innerHTML = `<strong>${entry.term}.</strong> ${esc(entry.text)}`;
      termNote.hidden = false;
      const at = btn.getBoundingClientRect();
      const below = at.bottom + 8 + termNote.offsetHeight < window.innerHeight;
      termNote.style.left = Math.max(8, Math.min(window.innerWidth - termNote.offsetWidth - 8, at.left - 12)) + 'px';
      termNote.style.top = (below ? at.bottom + 8 : at.top - 8 - termNote.offsetHeight) + 'px';
      termBtn = btn;
      btn.setAttribute('aria-expanded', 'true');
    });
    document.addEventListener('keydown', (e) => { if(e.key === 'Escape') closeTerm(); });
    panel.parentElement.addEventListener('scroll', closeTerm);

    // step: index into STEPS. roomShape: a ROOM_SHAPES id. plannedSubs: how
    // many subs to recommend positions for when there are none yet.
    // roomCorrection: a ROOM_CORRECTION id, or null until answered.
    // seatingMarked: the obstacles step has marked the rows' seating once.
    // viewBefore: the map view to put back when the guide closes.
    // seenWelcome: the welcome step is shown once, not on every later visit.
    // launchDone: the guide has been finished or left once, so the app no
    // longer opens in it.
    let state = { active: false, step: 0, roomShape: 'closed', plannedSubs: 1, roomCorrection: null, seatingMarked: false, viewBefore: null, seenWelcome: false, launchDone: false };
    try { Object.assign(state, JSON.parse(localStorage.getItem(STORE_KEY))); } catch(e){ /* start from the defaults above */ }
    function save(){
      try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch(e){ /* progress just won't survive a reload */ }
    }

    // What the current step needs done after each redraw of the map (after
    // any change to the room, from the guide, the map or Undo). Set by the
    // step's render function, cleared when the step changes.
    let refreshStep = null;
    // The marker the coach mark points at ({ id, x, y } as it was when
    // picked: the mark goes away once that marker has been moved), and the
    // current step's wording for it, (item, index) => text.
    let coachTarget = null;
    let coachText = null;
    function pointAt(item){
      coachTarget = item ? { id: item.id, x: item.x, y: item.y } : null;
    }

    const esc = (text) => String(text).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const term = (id) => `<button class="guide-term" data-term="${id}" aria-label="Definition: ${GLOSSARY[id].term}" aria-expanded="false">?</button>`;
    const choiceCards = (items, attr, pressedId) => items.map(it =>
      `<button class="guide-card" ${attr}="${it.id ?? it.count}" aria-pressed="${(it.id ?? it.count) === pressedId}"><strong>${esc(it.label)}</strong><span>${esc(it.detail)}</span>${it.extra || ''}</button>`
    ).join('');
    const countButtons = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => `<button data-count="${from + i}">${from + i}</button>`).join('');
    const pressOnly = (group, isPressed) => group.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(isPressed(b))));

    // A list of things on the map (speakers, subs or seat rows): one card
    // each, with its distance from the left and front walls as editable
    // fields that stay in step with the map. `extra.html(item)` adds a
    // card's own controls, `extra.wire(card, el)` wires them (card.item is
    // always the latest data for that card) and `extra.sync(item, el, items)`
    // keeps them current. Returns a function that brings the list in line
    // with `items`.
    function positionList(list, extra = {}){
      let cards = [];
      function build(items){
        list.innerHTML = items.map(it => `
          <div class="guide-speaker" data-id="${it.id}">
            <button class="small guide-speaker-name" title="Show ${esc(it.name)} on the map">${esc(it.name)}</button>
            <div class="guide-field"><label>From left wall</label><span data-axis="x" role="group" aria-label="${esc(it.name)}, from left wall"></span></div>
            <div class="guide-field"><label>From front wall</label><span data-axis="y" role="group" aria-label="${esc(it.name)}, from front wall"></span></div>
            ${extra.html ? extra.html(it) : ''}
          </div>`).join('');
        cards = items.map(it => {
          const el = list.querySelector(`[data-id="${it.id}"]`);
          const card = { id: it.id, el, item: it, xField: el.querySelector('[data-axis="x"]'), yField: el.querySelector('[data-axis="y"]') };
          const select = () => { pointAt(card.item); refreshStep(); };
          el.querySelector('.guide-speaker-name').addEventListener('click', select);
          // Moving focus into a card from elsewhere points at its marker; moving between the card's own fields does not bring a dismissed mark back.
          el.addEventListener('focusin', (e) => { if(!el.contains(e.relatedTarget) && (!coachTarget || coachTarget.id !== it.id)) select(); });
          card.writeX = app.lengthField(card.xField, it.x, (ft) => app.moveSource(it.id, ft, card.item.y));
          card.writeY = app.lengthField(card.yField, it.y, (ft) => app.moveSource(it.id, card.item.x, ft));
          if(extra.wire) extra.wire(card, el);
          return card;
        });
      }
      return (items) => {
        if(items.length !== cards.length || items.some((it, i) => it.id !== cards[i].id)) build(items);
        items.forEach((it, i) => {
          const card = cards[i];
          card.item = it;
          card.el.classList.toggle('selected', !!coachTarget && coachTarget.id === it.id);
          // A field being typed in is left alone until focus moves on.
          if(!card.xField.contains(document.activeElement)) card.writeX(it.x);
          if(!card.yField.contains(document.activeElement)) card.writeY(it.y);
          if(extra.sync) extra.sync(it, card.el, items);
        });
      };
    }

    // The coach mark points at one marker until that marker moves.
    function positionCoach(items){
      const index = coachTarget ? items.findIndex(it => it.id === coachTarget.id) : -1;
      const item = items[index];
      if(item && (Math.abs(item.x - coachTarget.x) > 0.01 || Math.abs(item.y - coachTarget.y) > 0.01)) coachTarget = null;
      if(!item || !coachTarget){ coach.hidden = true; return; }
      const at = app.roomToClient(item.x, item.y);
      coach.textContent = coachText(item, index);
      coach.hidden = false;
      // Below the marker unless that would leave the viewport.
      const below = at.y + 34 + coach.offsetHeight < window.innerHeight;
      coach.classList.toggle('above', !below);
      coach.style.left = Math.max(8, Math.min(window.innerWidth - coach.offsetWidth - 8, at.x - coach.offsetWidth / 2)) + 'px';
      coach.style.top = (below ? at.y + 34 : at.y - 34 - coach.offsetHeight) + 'px';
    }

    // ---- Step 0: welcome ----
    function renderWelcome(body){
      body.innerHTML = `
        <h2 tabindex="-1">Find the best subwoofer placement for your room</h2>
        <p>Below about 200 Hz, room modes${term('mode')} create peaks and nulls${term('null')} that vary seat to seat by 10 to 20 dB, and sub position is the biggest lever you have.</p>
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
            <span data-dim="${f.dim}" role="group" aria-label="${f.label}"></span>
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
      const note = body.querySelector('#guideDefaultsNote');
      const syncList = positionList(body.querySelector('#guideSpeakerList'));
      coachText = (s) => `Drag ${s.name} to its real position, or enter its distance from two walls.`;

      body.querySelector('#guideLayouts').addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if(!btn) return;
        app.setMainLayout(Number(btn.dataset.count));
        pointAt(app.getMains()[0]);
        refresh();
      });
      function refresh(){
        const mains = app.getMains();
        syncList(mains);
        pressOnly(body.querySelector('#guideLayouts'), b => Number(b.dataset.count) === mains.length);
        body.querySelector('#guideSpeakersIntro').textContent = mains.length
          ? 'Drag each speaker on the map to where it really is, or enter its distance from two walls.'
          : 'No main speakers to place.';
        const untouched = mains.filter(s => s.atDefault);
        note.hidden = untouched.length === 0;
        note.textContent = `Still at ${untouched.length === 1 ? 'its default position' : 'their default positions'}: ${untouched.map(s => s.name).join(', ')}.`;
        positionCoach(mains);
      }
      pointAt(app.getMains()[0]);
      refresh();
      return refresh;
    }

    // ---- Step 3: subwoofers ----
    function renderSubs(body){
      body.innerHTML = `
        <h2 tabindex="-1">Your subwoofers</h2>
        <h3>How many you have</h3>
        <div class="segmented guide-counts" id="guideSubCount" role="group" aria-label="Number of subwoofers"><button data-count="0">None yet</button>${countButtons(1, 4)}</div>
        <div id="guideSubsPlanned" hidden>
          <p>Modal will recommend positions for new subs. How many are you considering?</p>
          <div class="segmented guide-counts" id="guidePlannedCount" role="group" aria-label="Number of subwoofers to plan for">${countButtons(1, 4)}</div>
        </div>
        <div id="guideSubsPlaced" hidden>
          <h3>Positions</h3>
          <p>Place each sub where it is now: drag it on the map, or enter its distance from two walls. Modal uses the current position as the baseline for comparison.</p>
          <div id="guideSubList"></div>
        </div>`;
      const syncList = positionList(body.querySelector('#guideSubList'));
      coachText = (s) => `Drag ${s.name} to where it is now.`;

      body.querySelector('#guideSubCount').addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if(!btn) return;
        app.setSubCount(Number(btn.dataset.count));
        pointAt(app.getSubs()[0]);
        refresh();
      });
      body.querySelector('#guidePlannedCount').addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if(!btn) return;
        state.plannedSubs = Number(btn.dataset.count);
        save();
        refresh();
      });
      function refresh(){
        const subs = app.getSubs();
        syncList(subs);
        pressOnly(body.querySelector('#guideSubCount'), b => Number(b.dataset.count) === subs.length);
        pressOnly(body.querySelector('#guidePlannedCount'), b => Number(b.dataset.count) === state.plannedSubs);
        body.querySelector('#guideSubsPlanned').hidden = subs.length > 0;
        body.querySelector('#guideSubsPlaced').hidden = subs.length === 0;
        positionCoach(subs);
      }
      pointAt(app.getSubs()[0]);
      refresh();
      return refresh;
    }

    // ---- Step 4: seats ----
    function renderSeats(body){
      const lim = app.rowLimits;
      body.innerHTML = `
        <h2 tabindex="-1">Where you sit</h2>
        <p>Drag the marker to your main seat, or enter its distance from two walls, and set how many seats are in the row. Modal weights the center seat most heavily.</p>
        <div id="guideRowList"></div>
        <button id="guideAddRowBtn">Add a row</button>
        <p class="guide-hint">For a second couch or a row of recliners. Each additional row is weighted at half the priority of the row above it.</p>`;
      const syncList = positionList(body.querySelector('#guideRowList'), {
        html: () => `
          <div class="guide-field"><label>Seats</label>
            <div class="guide-stepper"><button data-seats="-1" aria-label="Fewer seats">&minus;</button><output></output><button data-seats="1" aria-label="More seats">+</button></div>
          </div>
          <details class="guide-more"><summary>This row faces a different way</summary>
            <div class="guide-field"><label>Facing<span>0&deg; is the front wall, 90&deg; the right wall</span></label>
              <span class="guide-facing"><input type="range" min="0" max="355" step="5" aria-label="Facing in degrees"><output></output></span>
            </div>
          </details>
          <button class="guide-skip" data-remove>Remove this row</button>`,
        wire(card, el){
          el.querySelector('.guide-stepper').addEventListener('click', (e) => {
            const btn = e.target.closest('button');
            if(btn) app.setRowSeats(card.id, card.item.seats + Number(btn.dataset.seats));
          });
          el.querySelector('input[type="range"]').addEventListener('input', function(){ app.setRowFacing(card.id, Number(this.value)); });
          el.querySelector('[data-remove]').addEventListener('click', () => {
            app.removeRow(card.id);
            body.querySelector('#guideAddRowBtn').focus(); // the button just pressed is gone
          });
        },
        sync(row, el, rows){
          el.querySelector('.guide-stepper output').textContent = row.seats;
          el.querySelector('[data-seats="-1"]').disabled = row.seats <= 1;
          el.querySelector('[data-seats="1"]').disabled = row.seats >= lim.maxSeats;
          const slider = el.querySelector('input[type="range"]');
          if(document.activeElement !== slider) slider.value = row.facing;
          el.querySelector('.guide-facing output').textContent = `${Math.round(row.facing)}°`;
          el.querySelector('[data-remove]').hidden = rows.length <= 1;
        }
      });
      coachText = (row, index) => index === 0 ? `Drag ${row.name} to your main seat.` : `Drag ${row.name} to where that row sits.`;

      const addBtn = body.querySelector('#guideAddRowBtn');
      addBtn.addEventListener('click', () => {
        if(!app.addRow()) return;
        pointAt(app.getRows().at(-1));
        refresh();
      });
      function refresh(){
        const rows = app.getRows();
        syncList(rows);
        addBtn.disabled = rows.length >= lim.maxRows;
        positionCoach(rows);
      }
      pointAt(app.getRows()[0]);
      refresh();
      return refresh;
    }

    // ---- Step 5: furniture and no-go areas ----
    const ZONE_KIND_LABELS = { offlimit: 'No-go area', preferred: 'Preferred area', allowed: 'Allowed area' };
    function renderObstacles(body){
      body.innerHTML = `
        <h2 tabindex="-1">Furniture and no-go areas</h2>
        <p>Mark furniture, doorways and walkways where a sub physically can't go. The optimizer searches everything else. Wall and corner positions usually perform best, but the whole floor is searched.</p>
        <p class="guide-note">Furniture is not included in the acoustic calculation. It only excludes sub positions.</p>
        <div id="guideSeatingOffers"></div>
        <h3>Add an obstacle</h3>
        <div class="guide-palette" id="guidePalette">
          ${app.furnitureTypes.map(f => `<button class="small" data-furniture="${f.type}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${f.icon}"/></svg>${esc(f.label)}</button>`).join('')}
        </div>
        <p class="guide-hint">A piece drops into the middle of the room. Drag it into place and drag a corner to resize it.</p>
        <button data-draw="offlimit">Draw another no-go area</button>
        <p class="guide-hint" id="guideDrawHint" hidden>Drag on the map to draw the area.</p>
        <div id="guideZoneList"></div>
        <p class="guide-warning" id="guideCoverageWarning" hidden></p>
        <details class="guide-more"><summary>More options</summary>
          <div class="guide-field"><label>Preferred area<span>A soft bias. A clearly better spot elsewhere still wins.</span></label><button class="small" data-draw="preferred">Draw</button></div>
          <div class="guide-field"><label>Allowed area only<span>A hard limit. Subs are only placed inside it.</span></label><button class="small" data-draw="allowed">Draw</button></div>
        </details>`;
      // The first time through, each row's seating is marked as an obstacle,
      // since a sub can't stand where people sit. After that it is only
      // offered, so removing one sticks.
      if(!state.seatingMarked){
        state.seatingMarked = true;
        save();
        for(const row of app.getRows()){
          if(!row.hasObstacle) app.addFurniture('couch', { name: `${row.name} seating`, ...row.footprint });
        }
      }
      const offers = body.querySelector('#guideSeatingOffers');
      const zoneList = body.querySelector('#guideZoneList');
      const warning = body.querySelector('#guideCoverageWarning');

      body.querySelector('#guidePalette').addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if(btn) app.addFurniture(btn.dataset.furniture);
      });
      body.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-draw]');
        if(!btn) return;
        app.toggleZoneDraw(btn.dataset.draw);
        refresh();
      });
      offers.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        const row = btn && app.getRows().find(r => r.id === Number(btn.dataset.row));
        if(row) app.addFurniture('couch', { name: `${row.name} seating`, ...row.footprint });
      });
      zoneList.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if(!btn) return;
        app.removeZone(btn.dataset.kind, Number(btn.dataset.id));
        refresh();
        (zoneList.querySelector('button') || body.querySelector('#guidePalette button')).focus(); // the button just pressed is gone
      });

      // Rebuilt only when their content changes, so a button is never
      // replaced partway through a click.
      const setHtml = (el, html) => { if(el.dataset.html !== html){ el.dataset.html = html; el.innerHTML = html; } };
      function refresh(){
        setHtml(offers, app.getRows().filter(r => !r.hasObstacle).map(r =>
          `<p class="guide-note guide-offer"><span>${esc(r.name)}'s seating is not marked as an obstacle.</span><button class="small" data-row="${r.id}">Add it</button></p>`).join(''));
        setHtml(zoneList, app.getZones().map(z =>
          `<div class="guide-zone"><span>${esc(z.isFurniture ? z.name : ZONE_KIND_LABELS[z.kind])} <span class="dim">${esc(app.formatLength(z.width))} &times; ${esc(app.formatLength(z.height))}</span></span><button class="icon-btn" data-kind="${z.kind}" data-id="${z.id}" title="Remove" aria-label="Remove ${esc(z.isFurniture ? z.name : ZONE_KIND_LABELS[z.kind])}">&times;</button></div>`).join(''));
        const drawing = app.getZoneDrawMode();
        body.querySelectorAll('[data-draw]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.draw === drawing)));
        body.querySelector('#guideDrawHint').hidden = !drawing;
        const text = app.floorCoverageWarning();
        warning.hidden = !text;
        warning.textContent = text || '';
      }
      refresh();
      return refresh;
    }

    // ---- Step 6: optimize ----
    const fmtDb = (db) => `${db < 0 ? '−' : ''}${Math.abs(db).toFixed(0)} dB`;
    const fmtSwing = (db) => `±${db.toFixed(0)} dB`;
    const signedDb = (db, digits) => { const shown = Number(db.toFixed(digits)); return `${shown >= 0 ? '+' : '−'}${Math.abs(shown).toFixed(digits)} dB`; }; // rounds first so a tiny negative reads +0.0
    const wallsText = (walls) => `${app.formatLength(walls.side.distFt)} from the ${walls.side.wall} wall, ${app.formatLength(walls.end.distFt)} from the ${walls.end.wall} wall`;
    const NOT_RELIABLE = 'Not reliable for this room shape';
    // Current and suggested response at the main seat, as two lines on a
    // log frequency axis.
    function responseChart(o){
      const W = 280, H = 90, lo = Math.log10(o.freqs[0]), hi = Math.log10(o.freqs.at(-1));
      const all = (o.before ? o.before.db : []).concat(o.after.db);
      const min = Math.min(...all) - 2, max = Math.max(...all) + 2;
      const line = (db) => db.map((v, i) => `${((Math.log10(o.freqs[i]) - lo) / (hi - lo) * W).toFixed(1)},${(H - (v - min) / (max - min) * H).toFixed(1)}`).join(' ');
      return `<svg class="guide-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Response at the main seat, ${o.freqs[0].toFixed(0)} to ${o.freqs.at(-1).toFixed(0)} Hz">
          ${o.before ? `<polyline class="before" points="${line(o.before.db)}"/>` : ''}<polyline class="after" points="${line(o.after.db)}"/>
        </svg>
        <div class="guide-chart-key">${o.before ? '<span class="before">Current</span>' : ''}<span class="after">Suggested</span><span>${o.freqs[0].toFixed(0)} to ${o.freqs.at(-1).toFixed(0)} Hz at the main seat${term('spatialAverage')}</span></div>`;
    }
    const VERDICTS = {
      major: 'Major improvement.',
      modest: 'Modest improvement.',
      similar: 'Little to gain. The current placement is already close to the best one found.',
      worse: 'No improvement found. The current placement measures better than the best one the search found, so leave it as it is.'
    };
    function resultCard(o){
      const change = (label, before, after) => `<div class="guide-stat"><span>${label}</span><strong>${before != null ? `${before} → ` : ''}${after}</strong></div>`;
      const b = o.before, a = o.after;
      const nullText = (m) => `${fmtDb(m.stats.worstMinDb - m.stats.avgMean)} at ${o.freqs[m.stats.worstMinIndex].toFixed(0)} Hz`;
      return `
        ${state.roomShape !== 'closed' ? `<p class="guide-warning">${NOT_RELIABLE}. ${esc(SHAPE_WARNING)}</p>` : ''}
        ${o.comparison ? `<p class="guide-verdict">${VERDICTS[o.comparison.verdict]}</p>` : ''}
        ${b ? change('Optimizer score' + term('score'), null, signedDb(o.comparison.gainDb, 1)) : ''}
        ${change('Response variation' + term('variation'), b && fmtSwing(b.stats.worstStdDev), fmtSwing(a.stats.worstStdDev))}
        ${change('Deepest null' + term('null'), b && nullText(b), nullText(a))}
        ${b ? change('Average level', null, signedDb(o.comparison.levelGainDb, 0)) : ''}
        ${o.seats > 1 ? change('Seat-to-seat variation' + term('seatToSeat'), b && fmtSwing(b.seatToSeatDb), fmtSwing(a.seatToSeatDb)) : ''}
        ${o.seats > 1 ? '<p class="guide-hint">Variation and the deepest null are for the seat where each is worst.</p>' : ''}
        ${responseChart(o)}
        <ul class="guide-moves">${o.subs.map(sub => {
          const to = wallsText(app.wallDistances(sub));
          const stays = sub.from && sub.from.x === sub.x && sub.from.y === sub.y;
          return `<li><strong>${esc(sub.name)}</strong>: ${stays ? 'leave it where it is' : `${sub.from ? 'move it to' : 'place it'} ${to}`}.</li>`;
        }).join('')}</ul>
        <div class="guide-actions">
          <button class="primary" id="guideApplyBtn">Apply</button>
          <button id="guideAlternativesBtn" aria-pressed="${app.getScoreHeatmap()}">Show alternatives</button>
          <button id="guideCantUseBtn">Can't use that spot</button>
        </div>
        <p class="guide-hint" id="guideAlternativesHint" ${app.getScoreHeatmap() ? '' : 'hidden'}>Green areas scored best and red worst. The star marks the suggestion.</p>`;
    }
    function renderOptimize(body){
      const subs = app.getSubs(), settings = app.getOptimizerSettings();
      body.innerHTML = `
        <h2 tabindex="-1">Find the best spot</h2>
        <p>The map now shows sound pressure level across the room at the selected frequency. The goal is a response at your seats that stays even across the ${settings.freqLow} to ${settings.freqHigh} Hz range, without deep nulls.</p>
        <h3>Room correction</h3>
        <p>Do you run room correction (Audyssey, Dirac, YPAO, ARC)?${term('roomCorrection')}</p>
        <div class="segmented guide-counts" id="guideRoomCorrection" role="group" aria-label="Room correction">${ROOM_CORRECTION.map(c => `<button data-rc="${c.id}">${c.label}</button>`).join('')}</div>
        <p class="guide-hint">Room correction can cut peaks but can't fill nulls, so with it, Modal prioritizes avoiding nulls.</p>
        <details class="guide-more"><summary>Settings</summary>
          <div class="guide-stat"><span>Frequency range</span><strong>${settings.freqLow} to ${settings.freqHigh} Hz</strong></div>
          <div class="guide-stat"><span>Subs</span><strong>${subs.length ? `${subs.length} (yours, refined in place)` : `${state.plannedSubs} new`}</strong></div>
          <div class="guide-stat"><span>Grid step</span><strong>${esc(app.formatLength(settings.gridStepFt))}</strong></div>
          ${subs.length ? '' : `<div class="guide-stat"><span>Sub height</span><strong>${esc(app.formatLength(settings.subHeightFt))}</strong></div>`}
          <p class="guide-hint">These can be changed under Optimizer and Expert in the full tool.</p>
        </details>
        <button class="primary guide-run" id="guideOptimizeBtn">Optimize sub placement</button>
        <p class="guide-hint" id="guideOptimizeStatus" role="status" aria-live="polite"></p>
        <div id="guideResult"></div>`;
      const runBtn = body.querySelector('#guideOptimizeBtn');
      const status = body.querySelector('#guideOptimizeStatus');
      const result = body.querySelector('#guideResult');
      // What the last search led to: null (nothing yet), 'none' (no valid
      // position), 'applied', or the outcome object while a suggestion is pending.
      let outcome = app.optimizerOutcome();

      body.querySelector('#guideRoomCorrection').addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if(!btn) return;
        state.roomCorrection = btn.dataset.rc;
        save();
        app.setOptimizerMode(ROOM_CORRECTION.find(c => c.id === btn.dataset.rc).mode);
        refresh();
      });
      async function run(){
        runBtn.disabled = true;
        result.innerHTML = '';
        const scope = `${settings.positions} positions across ${settings.seats} ${settings.seats === 1 ? 'seat' : 'seats'}`;
        await app.runOptimizer(state.plannedSubs, (fraction, subIndex, numSubs, phase) => {
          status.textContent = `${phase === 'polish' ? 'Refining' : 'Evaluating'} ${scope}${numSubs > 1 ? `, sub ${subIndex + 1} of ${numSubs}` : ''}... ${Math.round(fraction * 100)}%`;
        });
        if(!body.isConnected) return; // the step was left while the search ran
        runBtn.disabled = false;
        if(document.activeElement === document.body) runBtn.focus({ preventScroll: true }); // disabling the button dropped focus
        outcome = app.optimizerOutcome() || 'none';
        if(outcome === 'none') app.clearOptimizerResult();
        app.setScoreHeatmap(false);
        refresh();
        // Bring the card up clear of the sticky footer, but never push its first line off the top.
        const scroller = panel.parentElement, card = result.getBoundingClientRect();
        const hidden = card.bottom - panel.querySelector('.guide-footer').getBoundingClientRect().top;
        if(hidden > 0) scroller.scrollBy(0, Math.min(hidden, card.top - scroller.getBoundingClientRect().top));
      }
      runBtn.addEventListener('click', run);
      result.addEventListener('click', (e) => {
        const id = e.target.closest('button') && e.target.closest('button').id;
        if(id === 'guideApplyBtn'){
          outcome = 'applied';
          app.applyOptimizerResult();
          app.autofitColorRange();
          refresh();
          panel.querySelector('#guideNextBtn').focus(); // Apply went away with the card
        } else if(id === 'guideAlternativesBtn'){
          app.setScoreHeatmap(!app.getScoreHeatmap());
          shown = null;
          refresh();
        } else if(id === 'guideCantUseBtn' || id === 'guideObstaclesLink'){
          app.clearOptimizerResult();
          goTo(STEPS.findIndex(st => st.render === renderObstacles));
        }
      });

      let shown; // what `result` currently shows, so it is rebuilt only on a change
      function refresh(){
        pressOnly(body.querySelector('#guideRoomCorrection'), b => b.dataset.rc === state.roomCorrection);
        // A pending suggestion that was cleared elsewhere (Undo, the full tool) is gone here too.
        if(outcome && typeof outcome === 'object' && !app.optimizerOutcomePending()) outcome = null;
        if(shown === outcome) return;
        shown = outcome;
        runBtn.textContent = outcome ? 'Optimize again' : 'Optimize sub placement';
        if(!outcome) status.textContent = '';
        else if(outcome === 'none') status.textContent = '';
        else if(outcome === 'applied') status.textContent = 'Applied. The map and the next step show the new positions.';
        else status.textContent = `Evaluated ${settings.positions} positions across ${settings.seats} ${settings.seats === 1 ? 'seat' : 'seats'}.`;
        result.innerHTML = outcome === 'none'
          ? `<p class="guide-warning">No valid positions. Obstacles cover the searchable area; remove or shrink one. <button class="guide-link" id="guideObstaclesLink">Back to obstacles</button></p>`
          : outcome && outcome !== 'applied' ? `<div class="guide-result">${resultCard(outcome)}</div>` : '';
      }
      refresh();
      if(app.optimizerRunning()) run(); // the step was left and re-entered mid-search: rejoin it instead of offering a second one
      return refresh;
    }

    // ---- Step 7: your plan ----
    function renderPlan(body){
      body.innerHTML = `
        <h2 tabindex="-1">Your plan</h2>
        <div id="guideSheet"></div>
        <div class="guide-no-print">
          <h3>Keep it</h3>
          <div class="guide-field"><label for="guidePresetName">Name</label><input type="text" id="guidePresetName" value="My room" maxlength="60"></div>
          <div class="guide-actions">
            <button id="guideSaveBtn">Save this room</button>
            <button id="guidePrintBtn">Print / save as PDF</button>
          </div>
          <p class="guide-hint" id="guideSaveStatus" role="status" aria-live="polite"></p>
        </div>`;
      const sheet = body.querySelector('#guideSheet');
      body.querySelector('#guideSaveBtn').addEventListener('click', async () => {
        const name = body.querySelector('#guidePresetName').value.trim();
        const out = body.querySelector('#guideSaveStatus');
        if(!name){ out.textContent = 'Enter a name first.'; return; }
        out.textContent = await app.savePreset(name) ? `Saved as "${name}". It is under Saved rooms in the full tool.` : 'Save failed.';
      });
      body.querySelector('#guidePrintBtn').addEventListener('click', () => window.print());

      // The sheet follows the room: a sub moved on the map changes it.
      function refresh(){
        const plan = app.getSubPlan();
        const rc = state.roomCorrection;
        const html = `
          ${state.roomShape !== 'closed' ? `<p class="guide-warning">${NOT_RELIABLE}. ${esc(SHAPE_WARNING)}</p>` : ''}
          ${plan.length === 0 ? `<p class="guide-warning">No subwoofer is placed yet. Go back to Optimize, run it, and apply the suggestion.</p>` : `
          <ol class="guide-plan">
            <li><strong>Position.</strong>
              <ul>${plan.map(p => `<li>Put ${esc(p.name)} <strong>${esc(wallsText(p.walls))}</strong>.</li>`).join('')}</ul>
            </li>
            <li><strong>Sub distance.</strong>
              ${rc === 'yes'
                ? `<p>Re-run room correction after moving the sub and keep the sub distance it sets. These systems measure when the sound actually arrives at the mic, so the distance they set includes the sub's own processing delay (amp and DSP, and more for wireless subs). It will usually read longer than the tape-measured distance. That is expected; don't "correct" it.</p>`
                : `<p>${rc === 'no' ? 'Without room correction' : 'If you have no room correction'}, start with the geometric distance below. It doesn't include the sub's processing delay, so verify with a measurement mic (REW, for example) if you can.</p>
                   <p>If your AVR has room correction (Audyssey, YPAO, Dirac Live, MCACC, AccuEQ, ARC and the like), run it after moving the sub and keep the sub distance it sets. That figure includes the sub's processing delay and will usually read longer than the tape-measured distance. That is expected; don't "correct" it.</p>`}
              <ul>${plan.map(p => `<li>${esc(p.name)}: <strong>${esc(app.formatLength(p.seatDistanceFt))}</strong> to the main seat. Geometric distance (tape-measure equivalent).</li>`).join('')}</ul>
            </li>
          </ol>`}`;
        if(sheet.dataset.html !== html){ sheet.dataset.html = html; sheet.innerHTML = html; }
      }
      refresh();
      return refresh;
    }

    // `title` puts a step on the rail; the welcome step has none. `field`
    // steps show the pressure map and its frequency controls, the others
    // the plain floor plan. `next` words the step's forward button.
    const STEPS = [
      { render: renderWelcome, next: 'Start setup' },
      { title: 'Room', render: renderRoom },
      { title: 'Speakers', render: renderSpeakers },
      { title: 'Subs', render: renderSubs },
      { title: 'Seats', render: renderSeats },
      { title: 'Obstacles', render: renderObstacles },
      { title: 'Optimize', render: renderOptimize, field: true },
      { title: 'Your plan', render: renderPlan, next: 'Explore in the full tool' }
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

    function leaveStep(){
      refreshStep = null;
      coachTarget = null;
      coach.hidden = true;
      closeTerm();
      if(app.getZoneDrawMode()) app.toggleZoneDraw(app.getZoneDrawMode()); // an armed drawing tool does not carry over
    }
    function goTo(step){
      state.step = Math.max(0, Math.min(STEPS.length - 1, step));
      if(state.step > 0){
        state.seenWelcome = true;
        app.removeDefaultZone(); // an assumption nobody made; the guide's steps start without it
      }
      save();
      leaveStep();
      const field = !!STEPS[state.step].field;
      document.body.classList.toggle('guide-shows-field', field);
      app.setMapView(field ? 'pressure' : 'plan');
      if(field) app.autofitColorRange();
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
      // Each step picks its own map view (see STEPS); the one in use before
      // is put back on the way out.
      state.viewBefore = app.getMapView();
      setActive(true);
      goTo(state.seenWelcome ? Math.max(1, state.step) : 0);
    }
    // Leaves the guide for the full tool. The step is kept, so reopening
    // the guide carries on from it; finishing starts it over from the room.
    function close(finished){
      setActive(false);
      leaveStep();
      document.body.classList.remove('guide-shows-field');
      panel.innerHTML = '';
      state.launchDone = true;
      if(finished) state.step = 1;
      save();
      if(state.viewBefore) app.setMapView(state.viewBefore);
      guideBtn.focus();
    }

    const refreshActiveStep = () => { if(state.active && refreshStep) refreshStep(); };
    app.onDraw(refreshActiveStep);
    window.addEventListener('resize', refreshActiveStep); // the coach mark follows the map when the window or tablet orientation changes
    window.addEventListener('resize', closeTerm);
    // The setup sheet prints in the light palette whatever is on screen.
    window.addEventListener('beforeprint', () => { if(state.active) app.setPrintAppearance(true); });
    window.addEventListener('afterprint', () => { if(state.active) app.setPrintAppearance(false); });

    return {
      toggle(){ if(state.active) close(false); else open(); },
      // Called once the app has loaded. Picks the guide back up at the step
      // it was on if the page was closed or reloaded partway through, and
      // opens it for anyone who has not yet finished or left it once.
      resume(){
        if(state.active){
          setActive(true);
          goTo(state.step);
        } else if(!state.launchDone){
          open();
        }
      }
    };
  }

  global.ModalGuide = { create };
})(window);
