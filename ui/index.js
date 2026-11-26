/* ============================================================
   ojee-home — module UI (ojee-ui v3, 2026-11 redesign)

   One page. The air conditioner once — power, setpoint, mode, fan —
   beside its temperatures and their history. Everything else (every
   other control, scenes, automations, the activity log) sits under
   Details on the same page.

   State comes from /api/state and the SSE stream; the chart from
   /api/history, which the hub keeps on disk so a redeploy does not
   wipe it. Nothing here is a paragraph: a state is a word or a tag,
   the explanation is in a title attribute for whoever hovers.

   "Unavailable" is the hub's `down` (several failed reads spanning
   minutes). One missed poll shows the last reading with a quiet
   "Retrying" — it is not an outage and is not drawn as one.
   ============================================================ */

let ctx = null;
let root = null;
let stream = null;
let ui3 = null;            // ojee-ui3.js helpers (placeSegs, spark …)
let histTimer = null;

const state = {
  snapshot: null,
  history: {},             // device id -> {points, on_since, hours}
  hours: 6,
  tab: 'scenes',
  sheet: null,             // device id whose Advanced sheet is open
  zoneDraft: null,         // the zone being added / edited
  recent: null,            // the phone's recent location reports
  connected: null,
  editor: null,
  pendingSet: {},          // device id -> {value, timer}
  confirm: null,           // `${device}|${action}` for the inline confirm strip
};

const TABS = [
  { id: 'scenes', label: 'Scenes' },
  { id: 'automations', label: 'Automations' },
  { id: 'places', label: 'Places' },
  { id: 'devices', label: 'Devices' },
  { id: 'activity', label: 'Activity' },
];
/** Old view ids still deep-link: they land on the page with the right Manage tab. */
const VIEW_TAB = { devices: 'devices', controls: 'devices', scenes: 'scenes', automations: 'automations', activity: 'activity', places: 'places', zones: 'places', details: 'scenes' };

const TRIGGER_ATTRS = [
  { value: 'indoor_temperature', label: 'Indoor temperature' },
  { value: 'outdoor_temperature', label: 'Outdoor coil temperature' },
  { value: 'target_temperature', label: 'Setpoint' },
];

/* ---------- helpers ---------- */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ic = (name, cls = '') => `<svg class="i${cls ? ` ${cls}` : ''}" aria-hidden="true"><use href="#${name}"/></svg>`;
const col = (s) => (s === 'err' ? 'var(--err)' : s === 'warn' ? 'var(--warn)' : s === 'ok' ? 'var(--ok)' : 'var(--fg-3)');
const tag = (t, s, title = '') => `<span class="tag${s ? ` ${s}` : ''}"${title ? ` title="${esc(title)}"` : ''}>${esc(t)}</span>`;
const num = (v, dp = 1) => (v === null || v === undefined || Number.isNaN(Number(v)) ? '—' : Number(v).toFixed(dp));
const hm = (sec) => new Date(sec * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
const day = (sec) => new Date(sec * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const uid = (p) => `${p}-${Math.random().toString(36).slice(2, 8)}`;
const devices = () => (state.snapshot ? state.snapshot.devices : []);
const deviceById = (id) => devices().find((d) => d.id === id);
const capOf = (d, key) => (d.capabilities || []).find((c) => c.key === key);
const labelFor = (d, key, value) => {
  const opt = ((capOf(d, key) || {}).options || []).find((o) => o.value === value);
  return opt ? opt.label : (value ?? '—');
};
const api = (path, options = {}) => ctx.api(path, options);
const toast = (kind, title, detail = '') => ctx.toast?.(kind, title, detail);
const mins = (s) => Math.max(1, Math.round(s / 60));

/* ---------- device status: one word, a tag at most ---------- */
function status(d) {
  if (d.parked && !d.available) {
    return { s: null, text: `Off at the wall${d.parked_at ? ` since ${day(d.parked_at)}` : ''}`,
      title: 'Switched off at its fuse or plug: not answering is expected. The hub looks for it every ten minutes and picks it up when it answers.' };
  }
  if (d.down) {
    const why = d.status === 'key_rotated' ? 'Key rotated' : d.status === 'unconfigured' ? 'Needs key' : 'Not answering';
    return { s: 'warn', text: `${why} · ${mins(Date.now() / 1000 - (d.fail_since || Date.now() / 1000))} min`,
      title: d.status_detail || d.last_error || '' };
  }
  if (!d.available && d.status === 'unknown') return { s: null, text: 'Checking…', title: 'No read since the hub started' };
  if (!d.available) {
    return { s: null, text: `Retrying${d.last_seen ? ` · last read ${hm(d.last_seen)}` : ''}`,
      title: `Missed ${d.fail_streak || 1} read${(d.fail_streak || 1) > 1 ? 's' : ''}; only called unavailable after a few minutes.` };
  }
  const st = d.state;
  if (!st.power) return { s: null, text: 'Off' };
  const since = state.history[d.id]?.on_since;
  return { s: 'ok', text: `${labelFor(d, 'mode', st.mode)}${since ? ` · on since ${hm(since)}` : ''}` };
}

/* ---------- the AC ---------- */
function seg(d, key, disabled) {
  const cap = capOf(d, key);
  if (!cap || cap.kind !== 'enum') return '';
  return `<div class="seg" data-seg="${esc(`${d.id}-${key}`)}" role="group" aria-label="${esc(cap.label)}">
    <span class="ind"></span>
    ${cap.options.map((o) => `<button type="button" data-set="${esc(key)}" data-value="${esc(o.value)}" aria-pressed="${d.state[key] === o.value}" ${disabled ? 'disabled' : ''}>${esc(o.label)}</button>`).join('')}
  </div>`;
}

function acPanel(d) {
  const st = d.state;
  const live = d.available;
  const s = status(d);
  const cap = capOf(d, 'target_temperature') || { min: 16, max: 30, step: 1 };
  const pend = state.pendingSet[d.id];
  const target = pend ? pend.value : Number(st.target_temperature ?? cap.min);
  const ctl = live && st.power;
  const fault = live && st.error_code ? st.error_code : 0;
  const hist = state.history[d.id] || {};
  const pts = hist.points || [];
  const since = hist.on_since;
  let delta = null;
  if (since && live && st.power) {
    const first = pts.find((p) => p[0] >= since && p[1] != null);
    if (first && st.indoor_temperature != null) delta = Number(st.indoor_temperature) - first[1];
  }
  const hum = st.humidity ?? st.indoor_humidity;
  const stale = !live ? ' ho-stale' : '';

  const extra = [
    fault ? tag(`Fault E${fault}`, 'err', 'Error code reported by the unit itself') : '',
    d.simulated ? tag(d.status_detail === 'mirrored' ? 'Mirror' : 'Simulated', null, d.status_detail === 'mirrored' ? 'Read-only copy of another hub' : 'No local key: controls do not reach a real unit') : '',
  ].join('');

  const parkBtn = d.parked && !live
    ? `<button class="btn sm" data-park="0" data-id="${esc(d.id)}">It's back on</button>`
    : d.down ? `<button class="btn sm" data-park="1" data-id="${esc(d.id)}" title="Stop flagging it; it is picked up again by itself">Off at the wall</button>` : '';

  return `
  <section class="panel ho-ac" data-device="${esc(d.id)}">
    <div class="ho-ctl">
      <div class="ho-head">
        <span class="sic">${ic('i-snow')}</span>
        <div class="ho-who">
          <div class="sname">${esc(d.name)}${extra}</div>
          <span class="st" title="${esc(s.title || '')}"><span class="dot" style="--c:${col(s.s)}"></span><span>${esc(s.text)}</span></span>
          ${parkBtn}
        </div>
        <button class="sw" role="switch" aria-checked="${!!st.power && live}" aria-label="Power" data-toggle="power" ${live ? '' : 'disabled'}></button>
      </div>
      <div class="ho-setp${ctl ? '' : ' off'}">
        <button class="ho-stp" type="button" data-step="-1" aria-label="Lower setpoint" ${!ctl || target <= cap.min ? 'disabled' : ''}>${ic('i-minus', 'l')}</button>
        <div class="ho-v m" aria-live="polite">${!live && !d.last_seen ? '<span>—</span>' : `<span>${esc(num(target, 0))}</span><small>°C</small>`}</div>
        <button class="ho-stp" type="button" data-step="1" aria-label="Raise setpoint" ${!ctl || target >= cap.max ? 'disabled' : ''}>${ic('i-plus', 'l')}</button>
        <span class="ho-range m">${esc(cap.min)}–${esc(cap.max)}°</span>
      </div>
      <div class="ho-row"><span class="ho-lbl">Mode</span>${seg(d, 'mode', !ctl)}</div>
      <div class="ho-row"><span class="ho-lbl">Fan</span>${seg(d, 'fan', !ctl)}</div>
      <div class="ho-adv"><button class="btn sm" data-advanced="${esc(d.id)}" aria-haspopup="dialog">${ic('i-sliders', 's')}Advanced</button><span class="cap">${esc(advancedHint(d))}</span></div>
    </div>
    <div class="ho-temps">
      <div class="ho-reads${stale}">
        <div class="metric"><div class="ml">Indoor</div><div class="mv">${esc(num(st.indoor_temperature))}${st.indoor_temperature != null ? '<span class="u">°C</span>' : ''}</div></div>
        <div class="metric" title="Thermistor on the outdoor unit's coil, not outside air: it reads well above ambient while the compressor runs"><div class="ml">Outdoor coil</div><div class="mv">${esc(num(st.outdoor_temperature, 0))}${st.outdoor_temperature != null ? '<span class="u">°C</span>' : ''}</div></div>
        ${hum != null ? `<div class="metric"><div class="ml">Humidity</div><div class="mv">${esc(num(hum, 0))}<span class="u">%</span></div></div>` : ''}
        ${delta != null ? `<div class="metric"><div class="ml">Since on</div><div class="mv"${delta <= -0.2 ? ' style="--c:var(--ok)"' : ''}>${delta > 0 ? '+' : delta < 0 ? '−' : ''}${esc(Math.abs(delta).toFixed(1))}<span class="u">°</span></div></div>` : ''}
        <div class="seg sm ho-hours" data-seg="ho-hours" role="group" aria-label="Chart range"><span class="ind"></span>
          ${[6, 24, 48].map((h) => `<button type="button" data-hours="${h}" aria-pressed="${state.hours === h}">${h}h</button>`).join('')}
        </div>
      </div>
      ${chart(d, pts)}
    </div>
  </section>`;
}

/* ---------- temperature chart ----------
   Indoor °C as a line over the chosen window, the setpoint as a dashed step
   line while the unit was on, gaps where the hub had no read. The outdoor coil
   is not drawn: it runs 15–25° above the room and would flatten the line that
   matters; it is in the hover readout instead. */
const CW = 1000; const CH = 200;
function chart(d, pts) {
  const hours = state.hours;
  const now = Date.now() / 1000;
  const t0 = now - hours * 3600;
  const rows = pts.filter((p) => p[0] >= t0);
  const vals = rows.flatMap((p) => [p[1], p[4] ? p[3] : null]).filter((v) => v != null);
  if (rows.filter((p) => p[1] != null).length < 2) {
    return `<div class="ho-chart ho-chart--empty"><div class="empty">${ic('i-chart')}<span>No history for this window yet · one reading a minute while the AC answers</span></div></div>`;
  }
  let lo = Math.floor(Math.min(...vals) - 0.5); let hi = Math.ceil(Math.max(...vals) + 0.5);
  if (hi - lo < 3) { const mid = (hi + lo) / 2; lo = Math.floor(mid - 1.5); hi = Math.ceil(mid + 1.5); }
  const x = (t) => ((t - t0) / (now - t0)) * CW;
  const y = (v) => CH - ((v - lo) / (hi - lo)) * CH;
  const gap = 5 * 60;
  let line = ''; let area = ''; let setp = '';
  let run = [];
  const flush = () => {
    if (run.length > 1) {
      const dd = `M${run.map((p) => `${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join('L')}`;
      line += dd;
      area += `${dd}L${x(run.at(-1)[0]).toFixed(1)},${CH}L${x(run[0][0]).toFixed(1)},${CH}Z`;
    }
    run = [];
  };
  let prev = null;
  for (const p of rows) {
    if (prev && p[0] - prev[0] > gap) flush();
    if (p[1] != null) run.push(p);
    prev = p;
  }
  flush();
  // Setpoint: a step line, only while the unit was on.
  let on = null;
  for (const p of rows) {
    if (p[4] && p[3] != null) {
      const X = x(p[0]).toFixed(1); const Y = y(p[3]).toFixed(1);
      setp += on && p[0] - on[0] <= gap ? `H${X}V${Y}` : `M${X},${Y}`;
      on = p;
    } else on = null;
  }
  const ticks = [hi, (hi + lo) / 2, lo];
  const xl = [0, 1, 2, 3].map((i) => t0 + (i / 3) * (now - t0));
  const last = rows.filter((p) => p[1] != null).at(-1);
  const end = last ? `<span class="ho-end" style="left:${(x(last[0]) / CW * 100).toFixed(2)}%;top:${(y(last[1]) / CH * 100).toFixed(2)}%"></span>` : '';
  return `<div class="ho-chart" data-chart="${esc(d.id)}" role="img" aria-label="Indoor temperature, last ${hours} hours, ${num(Math.min(...rows.map((p) => p[1]).filter((v) => v != null)))} to ${num(Math.max(...rows.map((p) => p[1]).filter((v) => v != null)))} °C">
    <div class="ho-plot">
      <svg viewBox="0 0 ${CW} ${CH}" preserveAspectRatio="none" aria-hidden="true">
        ${ticks.map((v) => `<line class="g" x1="0" x2="${CW}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>`).join('')}
        <path class="a" d="${area}"/><path class="l" d="${line}"/>
        ${setp ? `<path class="s" d="${setp}"/>` : ''}
      </svg>
      ${end}
      <div class="ho-cross" hidden><i></i><div class="ho-tip m"></div></div>
    </div>
    ${ticks.map((v) => `<span class="ho-yl m" style="top:calc((100% - var(--ho-xh)) * ${(y(v) / CH).toFixed(4)})">${Math.round(v * 10) / 10}°</span>`).join('')}
    <div class="ho-xl m">${xl.map((t, i) => `<span>${i === 3 ? 'now' : hm(t)}</span>`).join('')}</div>
  </div>
  <div class="cap ho-leg"><span><i class="ho-key"></i>Indoor</span>${setp ? '<span><i class="ho-key s"></i>Setpoint while on</span>' : ''}<span class="ho-legr">Hover for the coil reading</span></div>`;
}

function bindChart(el) {
  const id = el.dataset.chart;
  const plot = el.querySelector('.ho-plot');
  const cross = el.querySelector('.ho-cross');
  const tip = el.querySelector('.ho-tip');
  const move = (e) => {
    const r = plot.getBoundingClientRect();
    const fx = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const now = Date.now() / 1000; const t0 = now - state.hours * 3600;
    const t = t0 + fx * (now - t0);
    const pts = (state.history[id]?.points || []).filter((p) => p[0] >= t0 && p[1] != null);
    if (!pts.length) return;
    let best = pts[0];
    for (const p of pts) if (Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p;
    cross.hidden = false;
    const px = ((best[0] - t0) / (now - t0)) * 100;
    cross.style.left = `${px}%`;
    cross.classList.toggle('flip', px > 70);
    tip.textContent = `${hm(best[0])} · ${num(best[1])}°${best[2] != null ? ` · coil ${num(best[2], 0)}°` : ''}${best[4] ? ` · set ${num(best[3], 0)}°` : ' · off'}`;
  };
  plot.addEventListener('pointermove', move);
  plot.addEventListener('pointerdown', move);
  plot.addEventListener('pointerleave', () => { cross.hidden = true; });
}

/* ---------- details ---------- */
function vaneGlyph(axis, token, label) {
  const open = `<svg class="ho-glyph vane" viewBox="0 0 32 32" role="img" aria-label="${esc(label)}">`;
  const unit = axis === 'v' ? '<rect class="unit" x="3" y="6" width="4" height="20"/>' : '<rect class="unit" x="6" y="3" width="20" height="4"/>';
  const pivot = axis === 'v' ? '9 16' : '16 9';
  const arrow = axis === 'v' ? 'M9 16h17M22.5 12L26 16l-3.5 4' : 'M16 9v17M12 22.5L16 26l4-3.5';
  if (token === 'fixed') {
    const shaft = axis === 'v' ? 'M9 16h13M18.5 12.5L22 16l-3.5 3.5' : 'M16 9v13M12.5 18.5L16 22l3.5-3.5';
    const stop = axis === 'v' ? 'M25 10v12' : 'M10 25h12';
    return `${open}${unit}<path d="${shaft}"/><path d="${stop}"/></svg>`;
  }
  if (token === 'auto') {
    const ext = axis === 'v' ? 38 : 45;
    const arc = axis === 'v' ? 'M22 8.5A15 15 0 0 1 22 23.5' : 'M8.5 22A15 15 0 0 0 23.5 22';
    return `${open}${unit}<g transform="rotate(${-ext} ${pivot})"><path d="${arrow}"/></g><g transform="rotate(${ext} ${pivot})"><path d="${arrow}"/></g><path class="sweep" d="${arc}"/></svg>`;
  }
  // Horizontal codes 1 and 2 are both centre; 3–6 run far-left to far-right (confirmed on the unit).
  if (axis === 'h') {
    const bearing = { p3: 45, p4: 22, p1: 0, p2: 0, p5: -22, p6: -45 }[token] ?? 0;
    return `${open}${unit}<g transform="rotate(${bearing} ${pivot})"><path d="${arrow}"/></g></svg>`;
  }
  const index = Number(String(token).slice(1));
  const angle = -38 + (76 * (index - 1)) / 4;
  return `${open}${unit}<g transform="rotate(${angle.toFixed(1)} ${pivot})"><path d="${arrow}"/></g></svg>`;
}
function ecoGlyph(token, label) {
  const level = token === 'off' ? 0 : Number(String(token).slice(-1));
  const bars = [0, 1, 2].map((i) => `<rect x="${6 + i * 7}" y="${20 - i * 5}" width="4" height="${5 + i * 5}" class="ecobar${i < level ? ' on' : ''}"/>`).join('');
  return `<svg class="ho-glyph" viewBox="0 0 28 28" role="img" aria-label="${esc(label)}">${bars}${level === 0 ? '<path class="ecoslash" d="M5 5L24 24"/>' : ''}</svg>`;
}
const GLYPHS = { swing_vertical: (t, l) => vaneGlyph('v', t, l), swing_horizontal: (t, l) => vaneGlyph('h', t, l), eco: ecoGlyph };
const GLYPH_TITLES = {
  swing_vertical: { fixed: 'Fixed: louvre parked', auto: 'Auto: sweeps the full range', p1: 'Angle 1, highest', p2: 'Angle 2', p3: 'Angle 3, straight out', p4: 'Angle 4', p5: 'Angle 5, lowest' },
  swing_horizontal: { fixed: 'Fixed: vane parked', auto: 'Auto: sweeps the full range', p3: 'Far left', p4: 'Left', p1: 'Centre', p2: 'Centre', p5: 'Right', p6: 'Far right' },
  eco: { off: 'Eco off: full power', level1: 'Eco 1: light power cap', level2: 'Eco 2: medium cap', level3: 'Eco 3: hardest cap, slowest cooling' },
};

/** "Swing, eco, turbo, quiet…": what the Advanced sheet holds, from the capability list. */
function advancedHint(d) {
  const keys = (d.capabilities || []).filter((c) => !['power', 'mode', 'fan', 'target_temperature'].includes(c.key) && c.kind !== 'readout');
  const words = keys.map((c) => c.label.replace(/ swing$/i, '').toLowerCase());
  const uniq = [...new Set(words.map((w) => (w === 'vertical' || w === 'horizontal' ? 'swing' : w)))];
  return uniq.slice(0, 5).join(', ') + (uniq.length > 5 ? '…' : '');
}

function capControl(d, c, live, on) {
  const dis = !live || (c.needs_power && !on);
  if (c.kind === 'enum') {
    const glyph = GLYPHS[c.key]; const titles = GLYPH_TITLES[c.key] || {};
    return `<div class="seg${glyph ? ' ho-gseg' : ''}" data-seg="${esc(`sh-${d.id}-${c.key}`)}" role="group" aria-label="${esc(c.label)}"><span class="ind"></span>
      ${c.options.filter((o) => !(c.key === 'swing_horizontal' && o.value === 'p2')).map((o) => {
        const title = titles[o.value] || o.label;
        return `<button type="button" data-set="${esc(c.key)}" data-value="${esc(o.value)}" aria-pressed="${d.state[c.key] === o.value}" ${glyph ? `aria-label="${esc(title)}" title="${esc(title)}"` : ''} ${dis ? 'disabled' : ''}>${glyph ? `${glyph(o.value, title)}` : esc(o.label)}</button>`;
      }).join('')}</div>`;
  }
  if (c.kind === 'switch') {
    return `<button class="sw" role="switch" aria-checked="${!!d.state[c.key] && (c.key !== 'power' || live)}" aria-label="${esc(c.label)}" data-toggle="${esc(c.key)}" ${c.key === 'power' ? (live ? '' : 'disabled') : (dis ? 'disabled' : '')}></button>`;
  }
  if (c.kind === 'range') {
    const pend = state.pendingSet[d.id];
    const v = c.key === 'target_temperature' && pend ? pend.value : Number(d.state[c.key] ?? c.min);
    return `<div class="ho-mini"><button class="ho-stp sm" type="button" data-step="-1" data-key="${esc(c.key)}" aria-label="Lower ${esc(c.label)}" ${dis || v <= c.min ? 'disabled' : ''}>${ic('i-minus', 's')}</button><span class="m">${esc(num(v, 0))}${esc(c.unit || '')}</span><button class="ho-stp sm" type="button" data-step="1" data-key="${esc(c.key)}" aria-label="Raise ${esc(c.label)}" ${dis || v >= c.max ? 'disabled' : ''}>${ic('i-plus', 's')}</button></div>`;
  }
  if (c.kind === 'action') {
    return `<button class="btn sm" data-ask="${esc(c.key)}" ${live ? '' : 'disabled'}>Run</button>`;
  }
  return '';
}

/* Everything the driver exposes, in its own order, drawn from the capability list —
   a new capability shows up here with no change to this file. Then every reading,
   including state keys no capability names (fault code, who changed it last). */
const STATE_LABELS = { error_code: 'Fault code', last_changed_by: 'Changed by', self_cleaning: 'Self-cleaning' };
function advancedPanel(d, { bare = false } = {}) {
  const live = d.available;
  const on = live && d.state.power;
  const caps = d.capabilities || [];
  const controls = caps.filter((c) => c.kind !== 'readout');
  const reads = caps.filter((c) => c.kind === 'readout');
  const named = new Set(caps.map((c) => c.key).concat(['self_clean']));
  const extraState = Object.keys(d.state).filter((k) => !named.has(k));
  const t = d.transport || {};
  const s = status(d);
  const fmtState = (k, v) => (k === 'error_code' ? (v ? `E${v}` : 'none') : v === true ? 'yes' : v === false ? 'no' : v ?? '—');
  return `<div class="ho-sh${bare ? ' bare' : ''}" data-device="${esc(d.id)}">
    ${bare ? '' : `<header class="ho-sh-head"><span class="sic">${ic('i-snow')}</span><div class="grow"><h2 id="ho-sheet-t">${esc(d.name)}</h2>
      <span class="st"><span class="dot" style="--c:${col(s.s)}"></span><span>${esc(s.text)}</span></span></div>
      <button class="ib" data-sheet-close aria-label="Close">${ic('i-x')}</button></header>`}
    <div class="ho-sh-scroll"><div class="ho-sh-list">
    ${controls.map((c) => (c.kind === 'action' && state.confirm === `${d.id}|${c.key}`
    ? `<div class="confirm"><p><b>${esc(c.label)}?</b> ${esc(c.hint || 'Runs to completion on the unit.')}</p><div class="acts"><button class="btn sm" data-cancel>Cancel</button><button class="btn sm pri" data-run="${esc(c.key)}">Start</button></div></div>`
    : `<div class="ho-cap ${c.kind === 'enum' ? 'col' : ''}"><div class="ho-cap-t"><div class="t">${esc(c.label)}</div>${c.hint ? `<div class="d">${esc(c.hint)}</div>` : ''}</div><div class="ho-cap-c">${capControl(d, c, live, on)}</div></div>`)).join('')}
    </div>
    <div class="ho-sh-sec"><div class="ml">Readings${live ? '' : ' · last known'}</div><dl class="ho-dl">
      ${reads.map((c) => `<div><dt>${esc(c.label)}</dt><dd class="m">${esc(num(d.state[c.key], c.key === 'outdoor_temperature' ? 0 : 1))}${d.state[c.key] != null ? esc(c.unit || '') : ''}</dd></div>`).join('')}
      ${extraState.map((k) => `<div><dt>${esc(STATE_LABELS[k] || k.replace(/_/g, ' '))}</dt><dd class="m${k === 'error_code' && d.state[k] ? ' ho-err' : ''}">${esc(fmtState(k, d.state[k]))}</dd></div>`).join('')}
    </dl></div>
    <div class="ho-sh-sec"><div class="ml">Unit</div><dl class="ho-dl">
      <div><dt>Room</dt><dd>${esc(d.room || '—')}</dd></div>
      <div><dt>Model</dt><dd class="m">${esc(t.type_id || '—')}</dd></div>
      <div><dt>Wi-Fi id</dt><dd class="m">${esc(t.device_id || '—')}</dd></div>
      <div><dt>Link</dt><dd class="m">${esc(t.host ? `${t.host}:${t.port}` : (d.simulated ? 'simulated' : '—'))}</dd></div>
      <div><dt>Key</dt><dd class="m">${t.localkey_version != null ? `v${esc(t.localkey_version)}` : '—'}</dd></div>
      <div><dt>Last read</dt><dd class="m">${d.last_seen ? `${esc(day(d.last_seen))} ${esc(hm(d.last_seen))}` : '—'}</dd></div>
      ${d.last_error ? `<div class="wide"><dt>Last error</dt><dd>${esc(d.last_error)}</dd></div>` : ''}
    </dl></div>
    <div class="ho-cap"><div class="ho-cap-t"><div class="t">Switched off at the wall</div><div class="d">No alerts while off; picked up again when it answers</div></div>
      <div class="ho-cap-c"><button class="sw" role="switch" aria-checked="${!!d.parked}" aria-label="Switched off at the wall" data-park="${d.parked ? 0 : 1}" data-id="${esc(d.id)}"></button></div></div>
    <div class="ho-sh-foot"><button class="btn sm" data-refresh="${esc(d.id)}">${ic('i-refresh', 's')}Read now</button><button class="btn sm ghost" data-rename="${esc(d.id)}">${ic('i-edit', 's')}Rename</button></div>
  </div></div>`;
}

/* ---------- home: scene shortcuts + automation summary ---------- */
function lastRuns(prefix) {
  const out = {};
  for (const e of state.snapshot.activity || []) {
    const m = (e.message || '').match(new RegExp(`^${prefix} '(.+)' (ran|activated|failed)`));
    if (!m) continue;
    const prev = out[m[1]];
    // The hub logs "failed" and then "ran" for a run whose action failed: same run, failed.
    if (!prev) out[m[1]] = { ts: e.ts, ok: m[2] !== 'failed' };
    else if (m[2] === 'failed' && Math.abs(prev.ts - e.ts) < 5) prev.ok = false;
  }
  return out;
}

function sceneShortcuts() {
  const list = state.snapshot.scenes || [];
  const runs = lastRuns('Scene');
  return `<section class="sec"><div class="sh"><h2>Scenes</h2><span class="note">one tap</span>
      <div class="r"><button class="btn sm ghost" data-tab-go="scenes">Manage${ic('i-chev', 's')}</button></div></div>
    ${list.length ? `<div class="ho-scenes">${list.map((sc) => `<button class="panel ho-scene" data-scene="${esc(sc.id)}">
      <span class="ho-scene-n">${esc(sc.name)}</span>
      <span class="ho-scene-d">${esc(sc.description || (sc.actions || []).map((a) => summarise(a.command)).join(' / '))}</span>
      <span class="ho-scene-m m">${runs[sc.name] ? `ran ${esc(hm(runs[sc.name].ts))}` : esc(sc.code || '')}</span>
    </button>`).join('')}</div>`
    : `<div class="panel"><div class="empty">${ic('i-scene')}<b>No scenes</b><button class="btn sm" data-new-scene>${ic('i-plus', 's')}New scene</button></div></div>`}
  </section>`;
}

function automationSummary() {
  const list = state.snapshot.automations || [];
  const runs = lastRuns('Automation');
  const p = state.snapshot.presence || {};
  const phone = p.zone_name && p.zone_name !== 'unknown' ? p.zone_name : p.last_fix ? 'away' : null;
  return `<section class="sec"><div class="sh"><h2>Automations</h2><span class="note">${list.filter((a) => a.enabled).length} of ${list.length} on${phone ? ` · phone ${esc(phone)}` : ''}</span>
      <div class="r"><button class="btn sm ghost" data-tab-go="automations">Manage${ic('i-chev', 's')}</button></div></div>
    <div class="panel">${list.length ? `<div class="rows">${list.map((a) => {
      const r = runs[a.name];
      return `<div class="row"><button class="sw" role="switch" aria-checked="${!!a.enabled}" aria-label="Enable ${esc(a.name)}" data-automation="${esc(a.id)}"></button>
        <div class="grow"><div class="t">${esc(a.name)}</div><div class="d">${esc(describeTrigger(a.trigger))}</div></div>
        <span class="ho-run m${r && !r.ok ? ' bad' : ''}">${r ? `${r.ok ? 'ran' : 'failed'} ${esc(day(r.ts))} ${esc(hm(r.ts))}` : 'not run yet'}</span></div>`;
    }).join('')}</div>` : `<div class="empty">${ic('i-auto')}<b>No automations</b><button class="btn sm" data-new-auto>${ic('i-plus', 's')}New automation</button></div>`}</div>
  </section>`;
}

/* ---------- manage: places (zones + the phone) ---------- */
function placesTab() {
  const p = state.snapshot.presence || {};
  const zones = p.zones || [];
  const fix = p.last_fix;
  const z = state.zoneDraft;
  const zoneForm = z ? `<div class="ho-zform" data-zone-form>
      <div class="field"><label for="z-name">Name</label><input class="input" id="z-name" data-zfield="name" value="${esc(z.name || '')}" maxlength="40"></div>
      <div class="field"><label for="z-lat">Latitude</label><input class="input m" id="z-lat" inputmode="decimal" data-zfield="lat" value="${esc(z.lat ?? '')}"></div>
      <div class="field"><label for="z-lon">Longitude</label><input class="input m" id="z-lon" inputmode="decimal" data-zfield="lon" value="${esc(z.lon ?? '')}"></div>
      <div class="field"><label for="z-r">Radius m</label><input class="input num" id="z-r" type="number" inputmode="numeric" min="50" max="5000" step="10" data-zfield="radius" value="${esc(z.radius ?? 150)}"></div>
      <div class="btns">${fix ? '<button class="btn sm ghost" data-zone-fix>Use phone\'s last fix</button>' : ''}<button class="btn sm" data-zone-cancel>Cancel</button><button class="btn sm pri" data-zone-save>Save place</button></div>
    </div>` : '';
  const rec = state.recent;
  return `<div class="panel">
    <div class="ho-presence">
      <div class="metric"><div class="ml">Phone is</div><div class="mv">${esc(p.zone_name && p.zone_name !== 'unknown' ? p.zone_name : fix ? 'Away' : 'Unknown')}</div></div>
      <div class="metric"><div class="ml">Last fix</div><div class="mv m">${fix ? `${esc(day(fix.ts))} ${esc(hm(fix.ts))}` : '—'}</div></div>
      <div class="metric"><div class="ml">Accuracy</div><div class="mv">${fix?.acc != null ? `${esc(Math.round(fix.acc))}<span class="u">m</span>` : '—'}</div></div>
      <div class="metric"><div class="ml">Battery</div><div class="mv">${fix?.battery != null ? `${esc(fix.battery)}<span class="u">%</span>` : '—'}</div></div>
      ${fix && !p.fresh ? tag('Stale fix', 'warn', 'Older than an hour: presence keeps the last place but does not trust it') : fix ? tag('Reporting', 'ok') : tag('No reports', null, 'Point OwnTracks at /api/location')}
    </div>
    <div class="rows ho-zones">${zones.map((zn) => `<div class="row"><span class="sic">${ic('i-house')}</span>
      <div class="grow"><div class="t">${esc(zn.name)}${p.zone === zn.id ? ` ${tag('phone here', 'ok')}` : ''}</div><div class="d m">${esc(Number(zn.lat).toFixed(5))}, ${esc(Number(zn.lon).toFixed(5))} · ${esc(Math.round(zn.radius))} m</div></div>
      <button class="ib" data-zone-edit="${esc(zn.id)}" aria-label="Edit ${esc(zn.name)}">${ic('i-edit')}</button>
      <button class="ib" data-zone-del="${esc(zn.id)}" aria-label="Delete ${esc(zn.name)}">${ic('i-trash')}</button></div>`).join('') || `<div class="empty">${ic('i-house')}<b>No places</b><span>A place is what an arrive / leave automation watches.</span></div>`}</div>
    ${zoneForm}
    <div class="ho-foot"><button class="btn sm ghost" data-recent>${rec ? 'Hide' : 'Recent'} reports</button>${z ? '' : `<button class="btn sm" data-zone-new>${ic('i-plus', 's')}New place</button>`}</div>
    ${rec ? `<div class="ho-recent"><table class="t"><thead><tr><th>Time</th><th>Type</th><th>Trigger</th><th>Region</th><th class="num">±m</th></tr></thead><tbody>
      ${rec.length ? rec.map((r) => `<tr><td class="m">${esc(day(r.ts))} ${esc(hm(r.ts))}</td><td>${esc(r.type || '—')}</td><td>${esc(r.trigger || r.event || '—')}</td><td>${esc(r.region || '—')}</td><td class="num m">${esc(r.acc ?? '—')}</td></tr>`).join('') : '<tr><td colspan="5" class="muted">Nothing received yet</td></tr>'}
    </tbody></table></div>` : ''}
  </div>`;
}

/* ---------- manage: devices ---------- */
function devicesTab() {
  const list = devices();
  return `<div class="panel">${list.length ? `<div class="rows">${list.map((d) => {
    const s = status(d); const t = d.transport || {};
    return `<div class="row"><span class="sic">${ic('i-ac')}</span>
      <div class="grow"><div class="t">${esc(d.name)} ${d.simulated ? tag('Simulated') : ''}</div><div class="d"><span class="st"><span class="dot" style="--c:${col(s.s)}"></span><span>${esc(s.text)}</span></span> · ${esc(d.room || 'no room')} · <span class="m">${esc(t.type_id || d.kind)}</span></div></div>
      <button class="btn sm" data-advanced="${esc(d.id)}">Advanced</button>
      <button class="ib" data-refresh="${esc(d.id)}" aria-label="Read ${esc(d.name)} now">${ic('i-refresh')}</button>
      <button class="ib" data-rename="${esc(d.id)}" aria-label="Rename ${esc(d.name)}">${ic('i-edit')}</button></div>`;
  }).join('')}</div>` : `<div class="empty">${ic('i-ac')}<b>No devices</b><span>Set AC_HOST, AC_DEVICE_ID and AC_LOCAL_KEY.</span></div>`}</div>`;
}

const WORDS = { target_temperature: 'setpoint', swing_vertical: 'vertical swing', swing_horizontal: 'horizontal swing', self_clean: 'self-clean' };
/** A command as a person says it: "on · cool · setpoint 24°" (same wording as the hub's log). */
const summarise = (command) => Object.entries(command || {}).map(([k, v]) => {
  if (k === 'power') return v ? 'on' : 'off';
  if (k === 'mode') return String(v);
  if (k === 'target_temperature') return `setpoint ${v}°`;
  const w = WORDS[k] || k.replace(/_/g, ' ');
  return `${w} ${v === true ? 'on' : v === false ? 'off' : v}`;
}).join(' · ') || 'nothing';

function scenesTab() {
  const list = state.snapshot.scenes || [];
  return `<div class="panel">
    ${list.length ? `<div class="rows">${list.map((sc) => `<div class="row">
      <span class="sic">${ic('i-scene')}</span>
      <div class="grow"><div class="t">${esc(sc.name)}</div><div class="d">${esc((sc.actions || []).map((a) => summarise(a.command)).join(' / '))}</div></div>
      <button class="btn sm" data-scene="${esc(sc.id)}">Run</button>
      <button class="ib" data-edit-scene="${esc(sc.id)}" aria-label="Edit ${esc(sc.name)}">${ic('i-edit')}</button>
      <button class="ib" data-del-scene="${esc(sc.id)}" aria-label="Delete ${esc(sc.name)}">${ic('i-trash')}</button>
    </div>`).join('')}</div>` : `<div class="empty">${ic('i-scene')}<b>No scenes</b><span>A scene sets several things in one write.</span></div>`}
    <div class="ho-foot"><button class="btn sm" data-new-scene>${ic('i-plus', 's')}New scene</button></div>
  </div>`;
}

function describeTrigger(t) {
  if (!t) return '';
  if (t.type === 'time') return `Daily at ${t.at}`;
  if (t.type === 'presence') {
    const zone = ((state.snapshot.presence || {}).zones || []).find((z) => z.id === t.zone);
    return `When I ${t.event === 'leave' ? 'leave' : 'arrive at'} ${zone ? zone.name : (t.zone || 'home')}`;
  }
  if (t.type === 'state') {
    const attr = (TRIGGER_ATTRS.find((a) => a.value === t.attribute) || {}).label || String(t.attribute || '').replace(/_/g, ' ');
    return `${attr} ${t.above != null ? `above ${t.above}°` : `below ${t.below}°`}`;
  }
  return t.type;
}

function automationsTab() {
  const list = state.snapshot.automations || [];
  return `<div class="panel">
    ${list.length ? `<div class="rows">${list.map((a) => `<div class="row">
      <button class="sw" role="switch" aria-checked="${!!a.enabled}" aria-label="Enable ${esc(a.name)}" data-automation="${esc(a.id)}"></button>
      <div class="grow"><div class="t">${esc(a.name)}</div><div class="d">${esc(describeTrigger(a.trigger))} → ${esc((a.actions || []).map((x) => summarise(x.command)).join(' / '))}</div></div>
      <button class="ib" data-edit-auto="${esc(a.id)}" aria-label="Edit ${esc(a.name)}">${ic('i-edit')}</button>
      <button class="ib" data-del-auto="${esc(a.id)}" aria-label="Delete ${esc(a.name)}">${ic('i-trash')}</button>
    </div>`).join('')}</div>` : `<div class="empty">${ic('i-auto')}<b>No automations</b><span>Run on a time, a reading, or arriving home.</span></div>`}
    <div class="ho-foot"><span class="cap m">${esc(state.snapshot.hub?.timezone || '')}</span><button class="btn sm" data-new-auto>${ic('i-plus', 's')}New automation</button></div>
  </div>`;
}

const KIND_COL = { error: 'err', command: 'acc', scene: 'acc', automation: 'acc', presence: null, park: null, key: 'warn' };
function activityTab() {
  const log = state.snapshot.activity || [];
  if (!log.length) return `<div class="panel"><div class="empty">${ic('i-log')}<b>Nothing logged</b><span>Commands, scenes and automation runs land here.</span></div></div>`;
  let lastDay = '';
  return `<div class="panel"><div class="feed">${log.map((e) => {
    const dd = day(e.ts); const head = dd !== lastDay ? `<div class="ho-day">${esc(dd)}</div>` : ''; lastDay = dd;
    const c = KIND_COL[e.kind];
    return `${head}<div class="ev"><span class="tm m">${esc(hm(e.ts))}</span><span class="rail"><span class="dot" style="--c:${c === 'acc' ? 'var(--fg-2)' : col(c)}"></span></span><span class="tx">${esc(e.message)}${e.detail ? ` <span class="muted">· ${esc(e.detail)}</span>` : ''}</span></div>`;
  }).join('')}</div>
  <div class="ho-foot"><span class="cap m">${log.length} ${log.length === 1 ? 'entry' : 'entries'}</span><button class="btn sm ghost danger" data-clear-activity>Clear</button></div></div>`;
}

/* ---------- page ---------- */
function render() {
  if (!root) return;
  if (!state.snapshot) {
    root.innerHTML = `<div class="page homem"><div class="ph"><div><h1>Home</h1></div></div>
      <div class="panel ho-skel"><div class="skeleton" style="height:240px"></div></div></div>`;
    return;
  }
  const s = state.snapshot;
  const lead = s.devices[0];
  const sub = lead ? [lead.room || null, lead.transport?.host ? 'local LAN' : null].filter(Boolean).join(' · ') : '';
  const tabs = { scenes: scenesTab, automations: automationsTab, places: placesTab, devices: devicesTab, activity: activityTab };
  const keep = root.querySelector('.ho-det-body')?.scrollTop;
  const acts = `${state.connected === false ? tag('Reconnecting', 'warn') : ''}${s.hub?.demo ? tag('Demo') : ''}`;
  // Inside the redesigned console the shell draws the page and its header (title +
  // headline); this module only fills its right-hand side. Standalone it draws both.
  const shell = !!ctx.ui3;
  if (shell) {
    const a = ctx.header?.actions;
    if (a && a.dataset.home !== acts) { a.innerHTML = acts; a.dataset.home = acts; }
  }
  root.innerHTML = `<div class="${shell ? '' : 'page '}homem">
    ${shell ? '' : `<div class="ph"><div><h1>Home</h1>${sub ? `<p>${esc(sub)}</p>` : ''}</div><div class="acts">${acts}</div></div>`}
    ${s.devices.length ? s.devices.map(acPanel).join('') : `<div class="panel"><div class="empty">${ic('i-ac')}<b>No devices</b><span>Set AC_HOST, AC_DEVICE_ID and AC_LOCAL_KEY.</span></div></div>`}
    <div class="ho-two">${sceneShortcuts()}${automationSummary()}</div>
    <section class="sec ho-details" id="ho-details">
      <div class="sh"><h2>Manage</h2>
        <div class="r"><div class="seg" data-seg="ho-tabs" role="tablist" aria-label="Manage"><span class="ind"></span>
          ${TABS.map((t) => `<button type="button" role="tab" id="ho-tab-${t.id}" aria-controls="ho-panel" data-tab="${t.id}" aria-selected="${state.tab === t.id}" tabindex="${state.tab === t.id ? 0 : -1}">${t.label}</button>`).join('')}
        </div></div></div>
      <div class="ho-det-body" id="ho-panel" role="tabpanel" aria-labelledby="ho-tab-${state.tab}">${(tabs[state.tab] || scenesTab)()}</div>
    </section>
  </div>`;
  if (keep) root.querySelector('.ho-det-body').scrollTop = keep;
  ui3?.placeSegs(root);
  root.querySelectorAll('[data-chart]').forEach(bindChart);
  renderSheet();
}

/* ---------- the Advanced sheet ----------
   A side sheet on a wide screen, a bottom sheet on a phone (by viewport, since the
   sheet lives on <body>, outside the console's container). It slides with the
   drawer curve on transform only, keeps its content live while open (SSE updates
   re-render the body, never replay the entrance), and on a phone the handle drags
   it down: a flick or a third of its height closes it. */
let sheetOpener = null;
const phoneSheet = () => matchMedia('(max-width: 699px)').matches;

function sheetHost() {
  let h = document.getElementById('ho-sheet');
  if (h) return h;
  h = document.createElement('div');
  h.id = 'ho-sheet';
  h.className = 'homem ho-sheet-host';
  h.innerHTML = `<div class="ho-scrim" data-sheet-close></div>
    <aside class="ho-sheet" role="dialog" aria-modal="true" aria-labelledby="ho-sheet-t" tabindex="-1">
      <div class="ho-grab" data-grab aria-hidden="true"><i></i></div>
      <div class="ho-sheet-body"></div>
    </aside>`;
  document.body.appendChild(h);
  bindDrag(h.querySelector('.ho-sheet'), h.querySelector('[data-grab]'));
  return h;
}

let shared = null;          // the console's sheet ({ el, body, close, done }) when it offers one

function openSheet(id, opener) {
  if (state.sheet) closeSheet();             // one sheet at a time
  if (ctx.sheet) {
    const d = deviceById(id);
    state.sheet = id; state.confirm = null;
    shared = ctx.sheet({ title: d?.name || 'Air conditioner', sub: d ? status(d).text : '', width: 480,
      flush: true, body: '<div id="ho-sheet-shared" class="homem"></div>' });
    shared.done?.then(() => { if (shared) { shared = null; state.sheet = null; state.confirm = null; } });
    renderSheet();
    return;
  }
  sheetOpener = opener || null;
  state.sheet = id;
  state.confirm = null;
  const h = sheetHost();
  h.hidden = false;
  renderSheet();
  requestAnimationFrame(() => requestAnimationFrame(() => {
    h.classList.add('open');
    h.querySelector('.ho-sheet').focus({ preventScroll: true });
  }));
}

function closeSheet() {
  if (shared) { const s0 = shared; shared = null; state.sheet = null; state.confirm = null; s0.close(); return; }
  const h = document.getElementById('ho-sheet');
  state.sheet = null;
  state.confirm = null;
  if (!h) return;
  const panel = h.querySelector('.ho-sheet');
  panel.style.transform = '';
  h.classList.remove('open');
  const done = () => { if (!state.sheet) { h.hidden = true; h.querySelector('.ho-sheet-body').innerHTML = ''; } };
  panel.addEventListener('transitionend', done, { once: true });
  setTimeout(done, 400);
  sheetOpener?.focus?.();
}

function renderSheet() {
  if (!state.sheet) return;
  const d = deviceById(state.sheet);
  if (shared) {
    const box = document.getElementById('ho-sheet-shared');
    if (!d || !box) return;
    const sc = box.closest('.sheet-b');
    const top = sc?.scrollTop || 0;
    box.innerHTML = advancedPanel(d, { bare: true });
    if (sc) sc.scrollTop = top;
    const sub = shared.el?.querySelector('.sheet-h .sub');
    if (sub) sub.textContent = status(d).text;
    ui3?.placeSegs(box);
    return;
  }
  const h = document.getElementById('ho-sheet');
  if (!d || !h) return;
  const body = h.querySelector('.ho-sheet-body');
  const top = body.querySelector('.ho-sh-scroll')?.scrollTop || 0;
  body.innerHTML = advancedPanel(d);
  body.querySelector('.ho-sh-scroll').scrollTop = top;
  ui3?.placeSegs(body);
}

function bindDrag(panel, handle) {
  let start = null;
  handle.addEventListener('pointerdown', (e) => {
    if (!phoneSheet() || start) return;          // one finger; desktop sheets do not drag
    start = { y: e.clientY, t: performance.now(), dy: 0 };
    handle.setPointerCapture(e.pointerId);
    panel.style.transition = 'none';
  });
  handle.addEventListener('pointermove', (e) => {
    if (!start) return;
    const dy = e.clientY - start.y;
    // Upward drag gets friction instead of a wall; downward follows the finger.
    start.dy = dy < 0 ? -Math.sqrt(-dy) * 2 : dy;
    panel.style.transform = `translateY(${start.dy}px)`;
  });
  const end = () => {
    if (!start) return;
    const v = start.dy / Math.max(1, performance.now() - start.t);
    const far = start.dy > panel.offsetHeight / 3;
    panel.style.transition = '';
    if (far || v > 0.5) closeSheet();
    else panel.style.transform = '';
    start = null;
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

/* ---------- editor (scenes, automations, rename) ---------- */
function valueControl(d, cap, current) {
  const path = `${d.id}|${cap.key}`;
  if (cap.kind === 'switch' || cap.kind === 'action') {
    return `<div class="seg sm"><button type="button" data-ev="${esc(path)}" data-v="true" aria-pressed="${current === true}">On</button><button type="button" data-ev="${esc(path)}" data-v="false" aria-pressed="${current === false}">Off</button></div>`;
  }
  if (cap.kind === 'enum') {
    return `<div class="seg sm">${cap.options.map((o) => `<button type="button" data-ev="${esc(path)}" data-v="${esc(o.value)}" aria-pressed="${current === o.value}">${esc(o.label)}</button>`).join('')}</div>`;
  }
  if (cap.kind === 'range') {
    return `<input class="input num" type="number" inputmode="decimal" data-ev="${esc(path)}" min="${cap.min}" max="${cap.max}" step="${cap.step || 1}" value="${current ?? cap.min}"> <span class="unit">${cap.min}–${cap.max}${esc(cap.unit || '')}</span>`;
  }
  return '';
}

function actionBuilder(draft) {
  const by = {};
  (draft.actions || []).forEach((a) => { by[a.device] = { ...(a.command || {}) }; });
  return devices().map((d) => {
    const cmd = by[d.id] || {};
    const settable = (d.capabilities || []).filter((c) => ['switch', 'enum', 'range', 'action'].includes(c.kind));
    return `<div class="ho-eb"><div class="ml">${esc(d.name)}</div>${settable.map((c) => {
      const inc = Object.prototype.hasOwnProperty.call(cmd, c.key);
      return `<div class="ho-erow${inc ? ' on' : ''}"><label><input type="checkbox" data-einc="${esc(d.id)}|${esc(c.key)}" ${inc ? 'checked' : ''}><span>${esc(c.label)}</span></label><div class="ho-eval">${inc ? valueControl(d, c, cmd[c.key]) : ''}</div></div>`;
    }).join('')}</div>`;
  }).join('');
}

function triggerEditor(draft) {
  const t = draft.trigger || { type: 'time', at: '08:00' };
  const zones = (state.snapshot.presence || {}).zones || [{ id: 'home', name: 'Home' }];
  return `<div class="field"><span class="lbl">Trigger</span><div class="seg sm">
      <button type="button" data-ttype="time" aria-pressed="${t.type === 'time'}">Time</button>
      <button type="button" data-ttype="state" aria-pressed="${t.type === 'state'}">Reading</button>
      <button type="button" data-ttype="presence" aria-pressed="${t.type === 'presence'}">Arrive / leave</button></div></div>
    ${t.type === 'time' ? `<div class="field"><label for="t-at">At</label><input class="input" id="t-at" type="time" value="${esc(t.at || '08:00')}" data-tfield="at"></div>` : ''}
    ${t.type === 'presence' ? `<div class="field"><span class="lbl">When</span><div class="seg sm"><button type="button" data-pevent="enter" aria-pressed="${t.event !== 'leave'}">I arrive</button><button type="button" data-pevent="leave" aria-pressed="${t.event === 'leave'}">I leave</button></div></div>
      <div class="field"><label for="t-zone">Place</label><select class="select" id="t-zone" data-tfield="zone">${zones.map((z) => `<option value="${esc(z.id)}" ${t.zone === z.id ? 'selected' : ''}>${esc(z.name)}</option>`).join('')}</select></div>` : ''}
    ${t.type === 'state' ? `<div class="field"><label for="t-dev">Device</label><select class="select" id="t-dev" data-tfield="device">${devices().map((d) => `<option value="${esc(d.id)}" ${t.device === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select></div>
      <div class="field"><label for="t-attr">Reading</label><select class="select" id="t-attr" data-tfield="attribute">${TRIGGER_ATTRS.map((a) => `<option value="${esc(a.value)}" ${t.attribute === a.value ? 'selected' : ''}>${esc(a.label)}</option>`).join('')}</select></div>
      <div class="field"><span class="lbl">Goes</span><div class="seg sm"><button type="button" data-tdir="above" aria-pressed="${t.above != null}">Above</button><button type="button" data-tdir="below" aria-pressed="${t.below != null}">Below</button></div></div>
      <div class="field"><label for="t-val">Threshold °C</label><input class="input num" id="t-val" type="number" inputmode="decimal" step="0.5" data-tfield="threshold" value="${t.above ?? t.below ?? 30}"></div>` : ''}`;
}

function editorHost() {
  let h = document.getElementById('ho-modal');
  if (!h) { h = document.createElement('div'); h.id = 'ho-modal'; h.className = 'homem'; document.body.appendChild(h); }
  return h;
}

function renderEditor() {
  const h = editorHost();
  const ed = state.editor;
  if (!ed) { h.innerHTML = ''; return; }
  const d = ed.draft;
  const title = ed.kind === 'device' ? 'Rename' : `${ed.isNew ? 'New' : 'Edit'} ${ed.kind === 'scene' ? 'scene' : 'automation'}`;
  const body = ed.kind === 'device'
    ? `<div class="field"><label for="e-name">Name</label><input class="input" id="e-name" value="${esc(d.name || '')}" data-efield="name" maxlength="40"></div>
       <div class="field"><label for="e-room">Room</label><input class="input" id="e-room" value="${esc(d.room || '')}" data-efield="room" maxlength="40"></div>`
    : `<div class="ho-erow2"><div class="field"><label for="e-name">Name</label><input class="input" id="e-name" value="${esc(d.name || '')}" data-efield="name" maxlength="40" placeholder="${ed.kind === 'scene' ? 'Sleep' : 'Night step-up'}"></div>
       ${ed.kind === 'scene' ? `<div class="field ho-code"><label for="e-code">Code</label><input class="input m" id="e-code" value="${esc(d.code || '')}" data-efield="code" maxlength="8" placeholder="SC-04"></div>` : ''}</div>
       <div class="field"><label for="e-desc">Description</label><input class="input" id="e-desc" value="${esc(d.description || '')}" data-efield="description" maxlength="120" placeholder="What it does"></div>
       ${ed.kind === 'automation' ? triggerEditor(d) : ''}
       <div class="field"><span class="lbl">Sets</span>${actionBuilder(d)}</div>`;
  h.innerHTML = `<div class="modal-backdrop" data-backdrop><div class="modal ho-modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="modal-head">${esc(title)}</div>
    <div class="modal-body ho-form">${body}</div>
    <div class="modal-foot"><button class="btn" data-close>Cancel</button><button class="btn pri" data-save>Save</button></div></div></div>`;
  const n = h.querySelector('#e-name');
  if (n && (ed.isNew || ed.kind === 'device') && !h.dataset.focused) { n.focus(); h.dataset.focused = '1'; }
}

function confirmDialog(title, message, label = 'Delete') {
  return new Promise((resolve) => {
    const h = document.createElement('div');
    h.className = 'homem';
    h.innerHTML = `<div class="modal-backdrop"><div class="modal" role="alertdialog" aria-modal="true" aria-label="${esc(title)}"><div class="modal-head">${esc(title)}</div><div class="modal-body">${esc(message)}</div><div class="modal-foot"><button class="btn" data-no>Cancel</button><button class="btn danger solid" data-yes>${esc(label)}</button></div></div></div>`;
    const done = (v) => { h.remove(); document.removeEventListener('keydown', key, true); resolve(v); };
    const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(false); } };
    h.addEventListener('click', (e) => {
      if (e.target.closest('[data-yes]')) done(true);
      else if (e.target.closest('[data-no]') || e.target.classList.contains('modal-backdrop')) done(false);
    });
    document.addEventListener('keydown', key, true);
    document.body.appendChild(h);
    h.querySelector('[data-no]').focus();
  });
}

function openEditor(kind, item) {
  const draft = item ? JSON.parse(JSON.stringify(item))
    : kind === 'scene' ? { id: uid('scene'), name: '', code: '', description: '', actions: [] }
      : { id: uid('auto'), name: '', description: '', enabled: false, trigger: { type: 'time', at: '08:00' }, actions: [] };
  editorHost().dataset.focused = '';
  state.editor = { kind, draft, isNew: !item };
  renderEditor();
}
function closeEditor() { state.editor = null; renderEditor(); }

function mutateAction(deviceId, key, fn) {
  const d = state.editor.draft;
  const map = {};
  (d.actions || []).forEach((a) => { map[a.device] = { ...(a.command || {}) }; });
  map[deviceId] = map[deviceId] || {};
  fn(map[deviceId]);
  if (!Object.keys(map[deviceId]).length) delete map[deviceId];
  d.actions = Object.entries(map).map(([device, command]) => ({ device, command }));
}

async function saveEditor() {
  const ed = state.editor; const d = ed.draft;
  if (!d.name || !d.name.trim()) { toast('warn', 'Name required'); return; }
  if (ed.kind === 'device') {
    try {
      const u = await api(`/devices/${d.id}`, { method: 'PATCH', body: JSON.stringify({ name: d.name, room: d.room || '' }) });
      replaceDevice(u); closeEditor(); render();
    } catch (err) { toast('err', 'Rename failed', err.message); }
    return;
  }
  if (!d.actions?.length) { toast('warn', 'Pick at least one setting'); return; }
  const key = ed.kind === 'scene' ? 'scenes' : 'automations';
  const list = JSON.parse(JSON.stringify(state.snapshot[key] || []));
  const i = list.findIndex((x) => x.id === d.id);
  if (i >= 0) list[i] = d; else list.push(d);
  try {
    state.snapshot[key] = await api(`/${key}`, { method: 'PUT', body: JSON.stringify(list) });
    closeEditor(); render();
  } catch (err) { toast('err', 'Save failed', err.message); }
}

async function removeItem(kind, id) {
  const key = kind === 'scene' ? 'scenes' : 'automations';
  try {
    state.snapshot[key] = await api(`/${key}`, { method: 'PUT', body: JSON.stringify((state.snapshot[key] || []).filter((x) => x.id !== id)) });
    render();
  } catch (err) { toast('err', 'Delete failed', err.message); }
}

/* ---------- commands ---------- */
function replaceDevice(u) {
  const i = state.snapshot.devices.findIndex((x) => x.id === u.id);
  if (i >= 0) state.snapshot.devices[i] = u;
}
const deviceOf = (node) => deviceById(node.closest('[data-device]')?.dataset.device) || devices()[0];

async function send(d, command, { optimistic = true } = {}) {
  if (!d) return;
  const before = { ...d.state };
  if (optimistic) { Object.assign(d.state, command); render(); }
  try {
    replaceDevice(await api(`/devices/${d.id}/command`, { method: 'POST', body: JSON.stringify(command) }));
  } catch (err) {
    d.state = before;
    toast('err', 'The AC did not take it', err.message);
  }
  render();
  loadHistory();
}

/** − / + coalesce: each press shows at once; one write goes out when the presses stop. */
function stepSetpoint(d, dir) {
  const cap = capOf(d, 'target_temperature') || { min: 16, max: 30, step: 1 };
  const cur = state.pendingSet[d.id]?.value ?? Number(d.state.target_temperature);
  const next = Math.min(cap.max, Math.max(cap.min, cur + dir * (cap.step || 1)));
  if (next === cur) return;
  clearTimeout(state.pendingSet[d.id]?.timer);
  state.pendingSet[d.id] = {
    value: next,
    timer: setTimeout(async () => {
      delete state.pendingSet[d.id];
      if (next !== Number(d.state.target_temperature)) await send(d, { target_temperature: next });
      else render();
    }, 700),
  };
  render();
}

const onClick = async (ev) => {
  const t = ev.target;
  if (!root) return;

  // editor (lives outside root)
  if (state.editor && t.closest('#ho-modal')) {
    if (t.closest('[data-close]') || t.matches('[data-backdrop]')) { closeEditor(); return; }
    if (t.closest('[data-save]')) { await saveEditor(); return; }
    const tt = t.closest('[data-ttype]');
    if (tt) {
      const k = tt.dataset.ttype;
      state.editor.draft.trigger = k === 'time' ? { type: 'time', at: '08:00' }
        : k === 'presence' ? { type: 'presence', event: 'enter', zone: (((state.snapshot.presence || {}).zones || [])[0] || {}).id || 'home' }
          : { type: 'state', device: devices()[0]?.id, attribute: 'indoor_temperature', above: 30 };
      renderEditor(); return;
    }
    const pe = t.closest('[data-pevent]');
    if (pe) { state.editor.draft.trigger.event = pe.dataset.pevent; renderEditor(); return; }
    const td = t.closest('[data-tdir]');
    if (td) {
      const tr = state.editor.draft.trigger; const v = tr.above ?? tr.below ?? 30;
      delete tr.above; delete tr.below; tr[td.dataset.tdir] = v; renderEditor(); return;
    }
    const evb = t.closest('button[data-ev]');
    if (evb) {
      const [dev, key] = evb.dataset.ev.split('|'); const raw = evb.dataset.v;
      mutateAction(dev, key, (c) => { c[key] = raw === 'true' ? true : raw === 'false' ? false : raw; });
      renderEditor();
    }
    return;
  }
  const inSheet = t.closest('#ho-sheet, #ho-sheet-shared');
  if (inSheet && t.closest('[data-sheet-close]')) { closeSheet(); return; }
  if (!root.contains(t) && !inSheet) return;

  const adv = t.closest('[data-advanced]');
  if (adv) { openSheet(adv.dataset.advanced, adv); return; }
  const go = t.closest('[data-tab-go]');
  if (go) {
    state.tab = go.dataset.tabGo; try { localStorage.setItem('home.tab', state.tab); } catch { /* private mode */ }
    render(); root.querySelector('#ho-details')?.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    return;
  }
  // places
  if (t.closest('[data-recent]')) {
    if (state.recent) { state.recent = null; render(); return; }
    try { state.recent = await api('/location/recent'); } catch (err) { toast('err', 'Could not read reports', err.message); state.recent = []; }
    render(); return;
  }
  if (t.closest('[data-zone-new]')) { state.zoneDraft = { id: null, name: '', lat: '', lon: '', radius: 150 }; render(); root.querySelector('#z-name')?.focus(); return; }
  const ze = t.closest('[data-zone-edit]');
  if (ze) { state.zoneDraft = { ...((state.snapshot.presence?.zones || []).find((z) => z.id === ze.dataset.zoneEdit) || {}) }; render(); root.querySelector('#z-name')?.focus(); return; }
  if (t.closest('[data-zone-cancel]')) { state.zoneDraft = null; render(); return; }
  if (t.closest('[data-zone-fix]')) {
    const fix = state.snapshot.presence?.last_fix;
    if (fix) { Object.assign(state.zoneDraft, { lat: fix.lat, lon: fix.lon }); render(); }
    return;
  }
  if (t.closest('[data-zone-save]')) { await saveZone(); return; }
  const zd = t.closest('[data-zone-del]');
  if (zd) {
    const zones = state.snapshot.presence?.zones || [];
    const z = zones.find((x) => x.id === zd.dataset.zoneDel);
    const used = (state.snapshot.automations || []).filter((a) => a.trigger?.type === 'presence' && a.trigger.zone === z?.id);
    if (!await confirmDialog('Delete place?', `"${z?.name}" will be removed.${used.length ? ` ${used.length} automation${used.length > 1 ? 's' : ''} watch it and will stop firing.` : ''}`)) return;
    await putZones(zones.filter((x) => x.id !== z.id));
    return;
  }

  const h = t.closest('[data-hours]');
  if (h) { state.hours = Number(h.dataset.hours); render(); loadHistory(); return; }
  const tab = t.closest('[data-tab]');
  if (tab) { state.tab = tab.dataset.tab; state.confirm = null; try { localStorage.setItem('home.tab', state.tab); } catch { /* private mode */ } render(); return; }

  if (t.closest('[data-new-scene]')) { openEditor('scene', null); return; }
  if (t.closest('[data-new-auto]')) { openEditor('automation', null); return; }
  const es = t.closest('[data-edit-scene]');
  if (es) { openEditor('scene', state.snapshot.scenes.find((x) => x.id === es.dataset.editScene)); return; }
  const ea = t.closest('[data-edit-auto]');
  if (ea) { openEditor('automation', state.snapshot.automations.find((x) => x.id === ea.dataset.editAuto)); return; }
  const ds = t.closest('[data-del-scene]');
  if (ds) { const sc = state.snapshot.scenes.find((x) => x.id === ds.dataset.delScene); if (await confirmDialog('Delete scene?', `"${sc?.name}" will be removed.`)) await removeItem('scene', ds.dataset.delScene); return; }
  const da = t.closest('[data-del-auto]');
  if (da) { const a = state.snapshot.automations.find((x) => x.id === da.dataset.delAuto); if (await confirmDialog('Delete automation?', `"${a?.name}" will be removed.`)) await removeItem('automation', da.dataset.delAuto); return; }
  if (t.closest('[data-clear-activity]')) {
    if (!await confirmDialog('Clear activity?', 'Every logged command and run is deleted.', 'Clear')) return;
    try { await api('/activity', { method: 'DELETE' }); await refreshSnapshot(); } catch (err) { toast('err', 'Clear failed', err.message); }
    return;
  }
  const sc = t.closest('[data-scene]');
  if (sc) {
    sc.setAttribute('aria-busy', 'true');
    try {
      const out = await api(`/scenes/${sc.dataset.scene}/activate`, { method: 'POST' });
      if (out.errors?.length) toast('warn', 'Scene partly applied', out.errors.join('; '));
      else toast('ok', 'Scene applied');
      await refreshSnapshot();
    } catch (err) { toast('err', 'Scene failed', err.message); sc.removeAttribute('aria-busy'); }
    return;
  }
  const at = t.closest('[data-automation]');
  if (at) {
    at.setAttribute('aria-checked', String(at.getAttribute('aria-checked') !== 'true'));
    try { await api(`/automations/${at.dataset.automation}/toggle`, { method: 'POST' }); await refreshSnapshot(); } catch (err) { toast('err', 'Toggle failed', err.message); render(); }
    return;
  }
  const rn = t.closest('[data-rename]');
  if (rn) { const d = deviceById(rn.dataset.rename); editorHost().dataset.focused = ''; state.editor = { kind: 'device', draft: { id: d.id, name: d.name, room: d.room } }; renderEditor(); return; }
  const pk = t.closest('[data-park]');
  if (pk) {
    const on = pk.dataset.park === '1';
    try {
      replaceDevice(await api(`/devices/${pk.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ parked: on }) }));
      render();
      if (!on) api(`/devices/${pk.dataset.id}/refresh`, { method: 'POST' }).then(refreshSnapshot).catch(() => {});
    } catch (err) { toast('err', 'Did not change', err.message); }
    return;
  }
  const rf = t.closest('[data-refresh]');
  if (rf) {
    rf.setAttribute('aria-busy', 'true');
    try { replaceDevice(await api(`/devices/${rf.dataset.refresh}/refresh`, { method: 'POST' })); } catch (err) { toast('err', 'Read failed', err.message); }
    render(); return;
  }
  if (t.closest('[data-cancel]')) { state.confirm = null; render(); return; }
  const ask = t.closest('[data-ask]');
  if (ask) { state.confirm = `${deviceOf(ask).id}|${ask.dataset.ask}`; render(); return; }
  const run = t.closest('[data-run]');
  if (run) { state.confirm = null; await send(deviceOf(run), { [run.dataset.run]: true }, { optimistic: false }); return; }
  const step = t.closest('[data-step]');
  if (step && !step.disabled) {
    const d = deviceOf(step); const key = step.dataset.key || 'target_temperature';
    if (key === 'target_temperature') stepSetpoint(d, Number(step.dataset.step));
    else { const c = capOf(d, key); await send(d, { [key]: Math.min(c.max, Math.max(c.min, Number(d.state[key] ?? c.min) + Number(step.dataset.step) * (c.step || 1))) }); }
    return;
  }
  const setter = t.closest('[data-set][data-value]');
  if (setter && !setter.disabled && setter.getAttribute('aria-pressed') !== 'true') {
    await send(deviceOf(setter), { [setter.dataset.set]: setter.dataset.value }); return;
  }
  const tg = t.closest('[data-toggle]');
  if (tg && !tg.disabled) { const d = deviceOf(tg); await send(d, { [tg.dataset.toggle]: !d.state[tg.dataset.toggle] }); }
};

const onKeydown = (ev) => {
  if (state.sheet && !state.editor && !shared) {
    if (ev.key === 'Escape') { closeSheet(); return; }
    if (ev.key === 'Tab') {
      const f = [...document.querySelectorAll('#ho-sheet .ho-sheet button:not(:disabled)')];
      if (!f.length) return;
      if (ev.shiftKey && document.activeElement === f[0]) { ev.preventDefault(); f.at(-1).focus(); }
      else if (!ev.shiftKey && document.activeElement === f.at(-1)) { ev.preventDefault(); f[0].focus(); }
    }
    return;
  }
  if (state.editor) {
    if (ev.key === 'Escape') { closeEditor(); return; }
    if (ev.key === 'Tab') {             // keep focus inside the dialog
      const f = [...document.querySelectorAll('#ho-modal button, #ho-modal input, #ho-modal select')].filter((n) => !n.disabled);
      if (!f.length) return;
      if (ev.shiftKey && document.activeElement === f[0]) { ev.preventDefault(); f.at(-1).focus(); }
      else if (!ev.shiftKey && document.activeElement === f.at(-1)) { ev.preventDefault(); f[0].focus(); }
    }
    return;
  }
  // Details tabs: arrow keys move between tabs (roving tabindex).
  const tab = ev.target.closest?.('[data-tab]');
  if (tab && (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft')) {
    const i = TABS.findIndex((x) => x.id === tab.dataset.tab);
    state.tab = TABS[(i + (ev.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length].id;
    render();
    root?.querySelector(`[data-tab="${state.tab}"]`)?.focus();
  }
};

const onChange = (ev) => {
  if (!state.editor) return;
  const inc = ev.target.closest('[data-einc]');
  if (inc) {
    const [dev, key] = inc.dataset.einc.split('|');
    const d = deviceById(dev); const cap = capOf(d, key);
    mutateAction(dev, key, (c) => {
      if (inc.checked) c[key] = cap.kind === 'range' ? (d.state[key] ?? cap.min) : cap.kind === 'enum' ? cap.options[0]?.value : true;
      else delete c[key];
    });
    renderEditor(); return;
  }
  const ef = ev.target.closest('[data-efield]');
  if (ef) { state.editor.draft[ef.dataset.efield] = ef.value; return; }
  const tf = ev.target.closest('[data-tfield]');
  if (tf) {
    const tr = state.editor.draft.trigger;
    if (tf.dataset.tfield === 'threshold') { const v = Number(tf.value); if (tr.above != null) tr.above = v; else tr.below = v; } else tr[tf.dataset.tfield] = tf.value;
    return;
  }
  const n = ev.target.closest('input[data-ev]');
  if (n) {
    const [dev, key] = n.dataset.ev.split('|'); const cap = capOf(deviceById(dev), key);
    let v = Number(n.value);
    if (cap?.min != null && cap?.max != null) { v = Math.min(cap.max, Math.max(cap.min, Number.isFinite(v) ? v : cap.min)); n.value = v; }
    mutateAction(dev, key, (c) => { c[key] = v; });
  }
};
async function putZones(zones) {
  try {
    const saved = await api('/zones', { method: 'PUT', body: JSON.stringify(zones) });
    state.snapshot.presence = { ...(state.snapshot.presence || {}), zones: saved };
    state.zoneDraft = null;
    render();
  } catch (err) { toast('err', 'Could not save places', err.message); }
}

async function saveZone() {
  const z = state.zoneDraft;
  const lat = Number(z.lat); const lon = Number(z.lon); const radius = Number(z.radius) || 150;
  if (!String(z.name || '').trim()) { toast('warn', 'Name the place'); return; }
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) { toast('warn', 'Latitude and longitude are needed', 'Or use the phone\'s last fix'); return; }
  const zones = (state.snapshot.presence?.zones || []).filter((x) => x.id !== z.id);
  const id = z.id || String(z.name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || uid('place');
  zones.push({ id, name: String(z.name).trim(), lat, lon, radius: Math.max(50, Math.min(5000, radius)) });
  await putZones(zones);
}

const onInput = (ev) => {
  const zf = ev.target.closest('[data-zfield]');
  if (zf && state.zoneDraft) { state.zoneDraft[zf.dataset.zfield] = zf.value; return; } const ef = ev.target.closest('#ho-modal [data-efield]'); if (ef && state.editor) state.editor.draft[ef.dataset.efield] = ef.value; };

/* ---------- data ---------- */
async function refreshSnapshot() {
  try { state.snapshot = await api('/state'); render(); } catch (err) { toast('err', 'Cannot reach the hub', err.message); }
}

async function loadHistory() {
  const ids = devices().map((d) => d.id);
  await Promise.all(ids.map(async (id) => {
    try { state.history[id] = await api(`/history?hours=${state.hours}&device=${encodeURIComponent(id)}`); } catch { /* keep the last one */ }
  }));
  render();
}

function connectStream() {
  stream = ctx.sse('/events', {
    onOpen: () => { if (state.connected === false) refreshSnapshot(); state.connected = true; },
    onError: () => { if (state.connected) { state.connected = false; render(); } },
    onMessage: (m) => {
      if (m.event === 'snapshot') { state.snapshot = m.data; render(); return; }
      if (!state.snapshot) return;
      if (m.event === 'device') {
        replaceDevice(m.data);
        // A write that is still being coalesced must not be overwritten by a poll.
        if (!state.pendingSet[m.data.id]) render();
        else renderSheet();
        if (m.data.available) loadHistory();
      } else if (m.event === 'activity') {
        state.snapshot.activity = [...m.data, ...(state.snapshot.activity || [])].slice(0, 60);
        if (state.tab === 'activity') render();
      } else if (m.event === 'presence') {
        state.snapshot.presence = m.data;
        if (state.tab === 'places' && !state.zoneDraft) render();
      } else if (m.event === 'scenes' || m.event === 'automations') {
        state.snapshot[m.event] = m.data;
        if (state.tab === m.event) render();
      }
    },
  });
}

/** Icons this page uses that a shell's sprite might lack: taken from the vendored icons3.svg. */
const NEEDED = ['i-sliders', 'i-x', 'i-chev', 'i-house', 'i-snow', 'i-plus', 'i-minus', 'i-chart', 'i-scene', 'i-auto', 'i-log', 'i-edit', 'i-trash', 'i-refresh', 'i-ac'];
async function ensureIcons(base) {
  const missing = NEEDED.filter((id) => !document.getElementById(id));
  if (!missing.length) return;
  try {
    const txt = await (await fetch(`${base}/icons3.svg`)).text();
    const box = document.createElement('div');
    box.innerHTML = txt;
    let sprite = document.getElementById('ho-sprite');
    if (!sprite) {
      sprite = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      sprite.id = 'ho-sprite'; sprite.setAttribute('aria-hidden', 'true');
      sprite.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
      document.body.prepend(sprite);
    }
    box.querySelectorAll('symbol').forEach((s) => { if (!document.getElementById(s.id)) sprite.appendChild(s); });
  } catch { /* icons are decoration; labels carry the meaning */ }
}

export default {
  async mount(el, context) {
    root = el; ctx = context;
    try { state.tab = localStorage.getItem('home.tab') || 'controls'; } catch { /* private mode */ }
    if (VIEW_TAB[context.view]) state.tab = VIEW_TAB[context.view];
    if (!document.getElementById('home-css')) {
      const link = document.createElement('link');
      link.id = 'home-css'; link.rel = 'stylesheet'; link.href = `${ctx.base}/ui/home.css`;
      document.head.appendChild(link);
    }
    const [mod] = await Promise.all([
      import(`${ctx.base}/ojee-ui3.js`).catch(() => null),
      ensureIcons(ctx.base),
    ]);
    ui3 = mod;
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKeydown);
    document.addEventListener('change', onChange);
    document.addEventListener('input', onInput);
    render();
    await refreshSnapshot();
    await loadHistory();
    connectStream();
    histTimer = setInterval(loadHistory, 120_000);
    if (VIEW_TAB[context.view]) root.querySelector('#ho-details')?.scrollIntoView({ block: 'start' });
  },

  async setView(view) {
    if (VIEW_TAB[view]) {
      state.tab = VIEW_TAB[view]; render();
      root?.querySelector('#ho-details')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    } else render();
  },

  async unmount() {
    document.removeEventListener('click', onClick);
    document.removeEventListener('keydown', onKeydown);
    document.removeEventListener('change', onChange);
    document.removeEventListener('input', onInput);
    clearInterval(histTimer);
    for (const p of Object.values(state.pendingSet)) clearTimeout(p.timer);
    state.pendingSet = {};
    stream?.stop(); stream = null;
    state.editor = null; document.getElementById('ho-modal')?.remove();
    if (shared) { shared.close(); shared = null; }
    state.sheet = null; document.getElementById('ho-sheet')?.remove();
    state.snapshot = null; state.history = {};
    root = null; ctx = null;
  },
};
