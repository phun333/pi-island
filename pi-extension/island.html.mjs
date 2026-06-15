// HTML + client-side state machine for the Dynamic Island.
// The webview renders a VERTICAL STACK of rows — one per pi session
// connected to the companion socket. Each row is styled like the original
// single-row island and carries its own braille spinner, colors, and timer.
//
// Node → webview API (called via win.send from the companion):
//   window.island.upsertRow(id, data)   — create or update a row
//   window.island.removeRow(id)         — fade out + remove a row
//   window.island.setMode("normal"|"notch")
//   window.island.setPromptHover(true|false)
//   window.island.hoverAt(x, y)         — synthetic hover for click-through windows
//
// `data` shape:
//   { project, status, detail, prompt, ctxPct, startedAt, frozenElapsed }
//
// All rows share a single 80ms braille ticker and a single 250ms elapsed
// ticker — they stay in sync and cost almost nothing.

export function buildIslandHTML() {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
/* ---------- Global scale ----------
 * One CSS custom property drives font-size, row-height, padding, gap and
 * meta sizing. window.island.setScale(name) flips it at runtime.
 * Row width and slot geometry (130/150/auto) stay FIXED so the absolute-
 * centered middle detail slot keeps its pixel-stable position regardless
 * of user-picked scale. Text inside scaled slots ellipsises naturally
 * when it runs out of room. */
:root { --scale: 1; --status-shimmer-x: 150%; }

* { box-sizing: border-box; margin: 0; padding: 0; }
html, body {
  width: 100%;
  height: 100%;
  background: transparent !important;
  overflow: hidden;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
  font-weight: 500;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
  user-select: none;
  -webkit-user-select: none;
}

/* The stack container sits flush with the top edge of the screen and grows
 * downward as rows are added. Rows are visually FUSED into one continuous
 * black shape: no gap between them, only the last row has rounded bottom
 * corners, consecutive rows share a hairline divider. */
#stack {
  position: absolute;
  top: 0; left: 0; right: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0;
  padding: 0;
  /* No shadow on the container — drop-shadow on the whole stack bleeds
   * upward into the screen edge area and shows as a soft black corner.
   * We put shadow only on the last row's bottom edge instead. */
}

/* ---------- One row = one pi session ---------- */
.row {
  background: #000;
  color: #fff;
  /* Default: square corners. First / last get rounded below. */
  border-radius: 0;
  /* Width scales together with font-size so the left/middle/right slot
   * proportions stay balanced. At scale 1.18 (large) the row is 543px
   * wide, which still fits inside the 640px host window. */
  width: calc(460px * var(--scale));
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  font-size: calc(11.5px * var(--scale));
  font-weight: 500;
  overflow: hidden;

  /* Enter/exit: grow + fade so siblings shift smoothly. No translateY —
   * the visual effect is the stack extending downward. */
  opacity: 0;
  max-height: 0;
  transition:
    opacity    240ms cubic-bezier(0.32, 0.72, 0, 1),
    max-height 320ms cubic-bezier(0.32, 0.72, 0, 1);
}

.row-line {
  height: calc(34px * var(--scale));
  padding: 0 calc(14px * var(--scale));
  /* The visible row uses a simple flex for left/right slots. The MIDDLE
   * slot is absolutely positioned at the row's geometric center (see
   * .slot.mid) so its text never shifts by a single pixel when the
   * right-side label changes width. */
  position: relative;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: calc(10px * var(--scale));
  white-space: nowrap;
  flex-shrink: 0;
}
.row.visible {
  opacity: 1;
  max-height: calc(34px * var(--scale));
}
.row[data-status="done"].removing {
  transition:
    opacity    100ms ease,
    max-height 160ms cubic-bezier(0.32, 0.72, 0, 1);
}
body.prompt-hover-enabled .row.visible.has-prompt:not([data-status="done"]).hovered,
body.prompt-hover-enabled .row.visible.has-prompt:not([data-status="done"]):hover {
  max-height: calc(340px * var(--scale));
}

/* Hairline between consecutive rows so they look stacked, not monolithic. */
.row.visible + .row.visible { border-top: 1px solid rgba(255,255,255,0.08); }

/* Only the LAST visible row rounds the bottom corners — produces the
 * continuous "capsule" look regardless of how many rows are stacked.
 * No drop-shadow: the capsule is pure black against whatever sits below
 * it, just like the real iPhone Dynamic Island. */
.row.visible:last-of-type {
  border-radius: 0 0 calc(22px * var(--scale)) calc(22px * var(--scale));
}

/* Notch mode: the FIRST row's middle is always empty (the notch lives
 * there). Subsequent rows (below the notch) behave like normal pills. */
body.notch-mode .row:first-child .slot.mid { visibility: hidden; }

/* Notch mode, first row only: abbreviate the elapsed timer by hiding
 * its "sub" part (the seconds after "Xm" or the minutes after "Xh").
 * The right slot grows leftward as the timer widens and on a notched
 * MacBook the right slot's left edge would otherwise slide behind the
 * notch (~225–430px in from the left). With abbreviation the timer
 * plateaus at 3–4 chars ("16m", "1h", "12h") instead of climbing to 7+
 * chars ("16m 52s", "12h 34m"), which is enough headroom for the
 * status label + ctx% to clear the notch cleanly. Rows BELOW the notch
 * (second + onwards) keep the full readout — they sit under the menu
 * bar and have no clipping issue. */
body.notch-mode .row:first-child .t-sub { display: none; }

.slot {
  display: flex;
  align-items: center;
  gap: calc(7px * var(--scale));
  min-width: 0;
}
/* Left & right live in the flex row. Left gets a hard max-width so a
 * long project name (e.g. a deeply-nested repo folder) can't visually
 * crash into the absolutely-centered middle slot. The project <span>
 * inside gets text-overflow: ellipsis so the truncation is graceful. */
.slot.left  {
  flex: 0 1 auto;
  max-width: calc(130px * var(--scale));
  min-width: 0;
  overflow: hidden;
}
.slot.right { flex: 0 0 auto; }
/* Middle is absolutely centered on the row. Because it's out of flow,
 * its position is defined ONLY by the row's width — independent of the
 * current left/right content. This keeps transient tool detail stable
 * pixel-for-pixel as status labels cycle. */
.slot.mid {
  position: absolute;
  left: 50%;
  top: 0;
  bottom: 0;
  transform: translateX(-50%);
  justify-content: center;
  overflow: hidden;
  /* Keep clear of left/right slots: at scale 1.0 row is 460px, padding
   * 14*2=28, left ≤ 130, right ≈ 170, plus a little breathing room. All
   * proportions scale together via var(--scale) so the middle slot grows
   * the detail area at large sizes instead of clipping aggressively. */
  max-width: calc(150px * var(--scale));
  pointer-events: none;
}
.row[data-status="done"] {
  pointer-events: none;
}
.row[data-status="done"] .slot.left,
.row[data-status="done"] .slot.mid {
  opacity: 0;
  transform: translateY(calc(-2px * var(--scale))) scale(0.98);
}
.row[data-status="done"] .slot.right {
  position: absolute;
  left: 50%;
  top: 0;
  bottom: 0;
  transform: translateX(-50%);
  justify-content: center;
  animation: doneStatusToCenter 260ms cubic-bezier(0.16, 1, 0.3, 1) both;
}
.row[data-status="done"] .meta,
.row[data-status="done"] .prompt-reveal {
  display: none;
}
@keyframes doneStatusToCenter {
  0% {
    opacity: 0;
    transform: translate3d(calc(-50% + 72px * var(--scale)), 0, 0) scale(0.98);
  }
  100% {
    opacity: 1;
    transform: translate3d(-50%, 0, 0) scale(1);
  }
}

.braille {
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: calc(13px * var(--scale));
  line-height: 1;
  width: calc(13px * var(--scale));
  text-align: center;
  flex-shrink: 0;
  display: inline-block;
}

.project {
  color: rgba(255,255,255,0.96);
  font-weight: 500;
  letter-spacing: -0.1px;
  /* Truncate long project names with an ellipsis instead of letting the
   * left slot overflow into the middle slot. min-width: 0 is required
   * on flex items for text-overflow: ellipsis to actually kick in. */
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sep    { color: rgba(255,255,255,0.28); flex-shrink: 0; }
.status {
  --status-fg: rgba(255,255,255,0.92);
  color: var(--status-fg);
  background: transparent;
  border: 0;
  border-radius: 0;
  min-height: calc(18px * var(--scale));
  padding: 0;
  line-height: 1;
  font-size: calc(10.5px * var(--scale));
  font-weight: 500;
  letter-spacing: -0.1px;
  text-align: center;
  vertical-align: middle;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  position: relative;
  overflow: hidden;
  transition: color 180ms ease;
}
.row[data-spin="true"] .status::after {
  content: attr(data-label);
  position: absolute;
  inset: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: transparent;
  -webkit-text-fill-color: transparent;
  background: linear-gradient(
    90deg,
    rgba(255,255,255,0) 0%,
    rgba(255,255,255,0) 34%,
    rgba(255,255,255,0.95) 50%,
    rgba(255,255,255,0) 66%,
    rgba(255,255,255,0) 100%
  );
  background-size: 220% 100%;
  background-position: var(--status-shimmer-x) 0;
  background-repeat: no-repeat;
  -webkit-background-clip: text;
  background-clip: text;
  pointer-events: none;
  white-space: nowrap;
  will-change: background-position;
}
.row[data-status="done"] .status {
  gap: calc(5px * var(--scale));
  overflow: visible;
}
.row[data-status="done"] .status::before {
  content: '✓';
  width: calc(12px * var(--scale));
  height: calc(12px * var(--scale));
  border: 1px solid currentColor;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  font-size: calc(8px * var(--scale));
  font-weight: 700;
  line-height: 1;
  opacity: 0;
  transform: scale(0.45) rotate(-18deg);
  transform-origin: center;
  animation: doneCheckPop 240ms cubic-bezier(0.16, 1, 0.3, 1) 70ms both;
}
@keyframes doneCheckPop {
  0%   { opacity: 0; transform: scale(0.45) rotate(-18deg); }
  70%  { opacity: 1; transform: scale(1.12) rotate(0deg); }
  100% { opacity: 1; transform: scale(1) rotate(0deg); }
}
.status.blur-in {
  animation: statusFadeIn 220ms cubic-bezier(0.16, 1, 0.3, 1) both;
}
@keyframes statusFadeIn {
  0% {
    opacity: 0;
    transform: translate3d(0, 1px, 0) scale(0.98);
  }
  100% {
    opacity: 1;
    transform: translate3d(0, 0, 0) scale(1);
  }
}
.detail {
  color: rgba(255,255,255,0.62);
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: calc(10.5px * var(--scale));
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  max-width: 100%;
}
.prompt-reveal {
  max-height: 0;
  opacity: 0;
  overflow: hidden;
  padding: 0 calc(14px * var(--scale));
  transition:
    max-height 220ms cubic-bezier(0.32, 0.72, 0, 1),
    opacity    160ms ease,
    padding    220ms cubic-bezier(0.32, 0.72, 0, 1);
}
body.prompt-hover-enabled .row.has-prompt:not([data-status="done"]).hovered .prompt-reveal,
body.prompt-hover-enabled .row.has-prompt:not([data-status="done"]):hover .prompt-reveal {
  max-height: calc(306px * var(--scale));
  opacity: 1;
  padding: calc(2px * var(--scale)) calc(14px * var(--scale)) calc(10px * var(--scale));
}
.prompt-full {
  color: rgba(255,255,255,0.82);
  font-style: italic;
  font-weight: 500;
  font-size: calc(10.5px * var(--scale));
  line-height: 1.28;
  white-space: normal;
  overflow: visible;
  overflow-wrap: anywhere;
}
.prompt-full::before { content: '\u201C'; opacity: 0.5; margin-right: 1px; }
.prompt-full::after  { content: '\u201D'; opacity: 0.5; margin-left: 1px; }

.meta {
  padding-left: calc(8px * var(--scale));
  border-left: 1px solid rgba(255,255,255,0.12);
  color: rgba(255,255,255,0.55);
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: calc(10px * var(--scale));
  display: flex;
  gap: calc(6px * var(--scale));
  align-items: center;
  flex-shrink: 0;
}
.meta .mono { font-variant-numeric: tabular-nums; }
.ctx-ring {
  --ctx-color: #22C55E;
  width: calc(19px * var(--scale));
  height: calc(19px * var(--scale));
  border-radius: 999px;
  position: relative;
  display: inline-block;
  flex-shrink: 0;
  box-shadow:
    inset 0 0 0 1px rgba(255,255,255,0.13),
    0 0 8px rgba(255,255,255,0.06);
  transition: transform 140ms ease, filter 140ms ease;
}
.ctx-ring.hovered,
.ctx-ring:hover {
  transform: scale(1.08);
  filter: drop-shadow(0 0 5px rgba(255,255,255,0.12));
}
.ctx-svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
}
.ctx-track,
.ctx-progress {
  fill: none;
  stroke-width: 2.5;
}
.ctx-track { stroke: rgba(255,255,255,0.14); }
.ctx-progress {
  stroke: var(--ctx-color);
  stroke-linecap: round;
  transition: stroke-dasharray 180ms ease, stroke 180ms ease;
}
#ctx-tooltip {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 20;
  pointer-events: none;
  padding: 3px 7px;
  border-radius: 999px;
  border: 1px solid rgba(255,255,255,0.14);
  background: rgba(12,12,12,0.96);
  color: rgba(255,255,255,0.92);
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 10px;
  font-weight: 500;
  line-height: 1.1;
  white-space: nowrap;
  box-shadow: 0 8px 18px rgba(0,0,0,0.28);
  opacity: 0;
  transform: translate(-50%, 4px) scale(0.96);
  transform-origin: top center;
  transition: opacity 120ms ease, transform 120ms ease;
}
#ctx-tooltip.visible {
  opacity: 1;
  transform: translate(-50%, 0) scale(1);
}
</style>
</head>
<body class="prompt-hover-enabled">
<div id="stack"></div>
<div id="ctx-tooltip" role="tooltip" aria-hidden="true"></div>
<script>
(function () {
  var stack = document.getElementById('stack');
  var ctxTooltip = document.getElementById('ctx-tooltip');

  // ---- Status table (state key → display color / label / spin flag) ----
  // The compact row keeps the user's original prompt out of the inline
  // layout; hover a row to reveal that prompt beneath it. Braille color +
  // right-side label reflect the current phase (reading / editing / …).
  var STATUS = {
    thinking:  { color: '#F59E0B', label: 'Working',   spin: true,  fg: '#F59E0B' },
    reading:   { color: '#3B82F6', label: 'Reading',   spin: true,  fg: '#3B82F6' },
    editing:   { color: '#FACC15', label: 'Editing',   spin: true,  fg: '#EAB308' },
    writing:   { color: '#FACC15', label: 'Writing',   spin: true,  fg: '#EAB308' },
    running:   { color: '#F97316', label: 'Running',   spin: true,  fg: '#F97316' },
    searching: { color: '#8B5CF6', label: 'Searching', spin: true,  fg: '#8B5CF6' },
    done:      { color: '#22C55E', label: 'Done',      spin: false, fg: '#22C55E' },
    error:     { color: '#EF4444', label: 'Error',     spin: false, fg: '#EF4444' },
  };

  var BRAILLE = ["\u280B","\u2819","\u2839","\u2838","\u283C","\u2834","\u2826","\u2827","\u2807","\u280F"];
  var STATUS_TEXT_ANIM_MS = 1600;
  var brailleIdx = 0;

  var rows = {};      // id → { data, el, removing }
  var order = [];     // stable row order (first-seen first)
  var tickerB = null; // braille ticker
  var tickerT = null; // elapsed-time ticker
  var shimmerRaf = null; // status-text shimmer ticker
  var hoverX = null;  // last synthetic cursor x from native host
  var hoverY = null;  // last synthetic cursor y from native host
  var hoveredEl = null;
  var hoveredRing = null;
  var promptHoverEnabled = true;

  // Size presets — applied by flipping the --scale custom property on
  // <html>. Everything in the CSS that uses calc(... * var(--scale))
  // picks it up instantly; no respawn of the companion needed.
  //
  // xlarge's 1.35 is the practical ceiling: at that factor the row is
  // 460*1.35 = 621px wide, leaving ~19px of clickThrough breathing room
  // inside the 640px host window. Bumping it higher would require
  // widening WIN_W in companion.mjs too.
  var SCALES = { small: 0.88, medium: 1.0, large: 1.18, xlarge: 1.35 };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Split the elapsed readout into a "main" unit and a "sub" unit so the
  // notch CSS above can hide only the sub part without JS awareness of
  // notch state. main is always visible ("16m", "1h", "42s"); sub is the
  // next-finer unit with a leading space (" 52s", " 23m") and gets
  // display:none inside the notched first row.
  //
  // Sub-second resolution is deliberately NOT shown — the readout jumps
  // straight from 0s → 1s → 2s. Tenths-of-a-second jitter feels twitchy
  // on a status capsule, and the braille spinner already signals "alive".
  function fmtElapsedParts(ms) {
    var s = Math.floor(ms / 1000);
    if (s < 60) return { main: s + 's', sub: '' };
    var m = Math.floor(s / 60); s = s % 60;
    if (m < 60) return { main: m + 'm', sub: ' ' + (s < 10 ? '0' : '') + s + 's' };
    var h = Math.floor(m / 60); m = m % 60;
    return { main: h + 'h', sub: ' ' + (m < 10 ? '0' : '') + m + 'm' };
  }

  function fmtElapsedHTML(ms) {
    var f = fmtElapsedParts(ms);
    return '<span class="t-main">' + f.main + '</span>' +
           '<span class="t-sub">'  + f.sub  + '</span>';
  }

  function ctxColor(pct) {
    if (pct >= 85) return '#EF4444'; // hot red
    if (pct >= 70) return '#F97316'; // orange
    if (pct >= 50) return '#F59E0B'; // amber
    return '#22C55E';                // green
  }

  function anySpinning() {
    for (var id in rows) {
      var r = rows[id];
      if (r && !r.removing) {
        var s = STATUS[r.data.status];
        if (s && s.spin) return true;
      }
    }
    return false;
  }
  function anyRunning() {
    for (var id in rows) if (rows[id] && !rows[id].removing) return true;
    return false;
  }

  function startStatusShimmer() {
    if (shimmerRaf) return;
    var tick = function (now) {
      var phase = (now % STATUS_TEXT_ANIM_MS) / STATUS_TEXT_ANIM_MS;
      var x = 150 - phase * 300;
      document.documentElement.style.setProperty('--status-shimmer-x', x.toFixed(1) + '%');
      if (anySpinning()) shimmerRaf = requestAnimationFrame(tick);
      else shimmerRaf = null;
    };
    shimmerRaf = requestAnimationFrame(tick);
  }

  function startTickers() {
    if (anySpinning()) startStatusShimmer();
    if (!tickerB && anySpinning()) {
      tickerB = setInterval(function () {
        brailleIdx = (brailleIdx + 1) % BRAILLE.length;
        var nodes = document.querySelectorAll('.braille');
        for (var i = 0; i < nodes.length; i++) {
          // Don't tick braille for frozen (done/error) rows.
          var rowEl = nodes[i].closest('.row');
          if (rowEl && rowEl.dataset.spin === 'true') {
            nodes[i].textContent = BRAILLE[brailleIdx];
          }
        }
        if (!anySpinning()) { clearInterval(tickerB); tickerB = null; }
      }, 80);
    }
    if (!tickerT && anyRunning()) {
      tickerT = setInterval(function () {
        for (var id in rows) {
          var r = rows[id];
          if (!r || r.removing) continue;
          if (r.data.frozenElapsed != null) continue;
          var el = r.el.querySelector('.t-elapsed');
          if (el && r.data.startedAt) {
            // innerHTML (not textContent) because the timer is now two
            // nested spans — .t-main + .t-sub — so notch CSS can hide the
            // sub part independently.
            el.innerHTML = fmtElapsedHTML(Date.now() - r.data.startedAt);
          }
        }
        if (!anyRunning()) { clearInterval(tickerT); tickerT = null; }
      }, 250);
    }
  }

  function nearestWithClass(node, className) {
    while (node && node !== document) {
      if (node.classList && node.classList.contains(className)) return node;
      node = node.parentNode;
    }
    return null;
  }

  function setHoveredEl(next) {
    if (next && (!next.classList.contains('row') || next.dataset.status === 'done')) next = null;
    if (hoveredEl === next) return;
    if (hoveredEl) hoveredEl.classList.remove('hovered');
    hoveredEl = next;
    if (hoveredEl) hoveredEl.classList.add('hovered');
  }

  function hideCtxTooltip() {
    if (!ctxTooltip) return;
    ctxTooltip.classList.remove('visible');
    ctxTooltip.setAttribute('aria-hidden', 'true');
  }

  function positionCtxTooltip() {
    if (!ctxTooltip || !hoveredRing) return;
    var text = hoveredRing.getAttribute('data-tooltip') || hoveredRing.getAttribute('aria-label') || '';
    if (!text) { hideCtxTooltip(); return; }

    ctxTooltip.textContent = text;
    ctxTooltip.classList.add('visible');
    ctxTooltip.setAttribute('aria-hidden', 'false');

    var rect = hoveredRing.getBoundingClientRect();
    var left = rect.left + rect.width / 2;
    var top = rect.bottom + 6;
    var tooltipW = ctxTooltip.offsetWidth;
    var tooltipH = ctxTooltip.offsetHeight;

    left = Math.max(tooltipW / 2 + 4, Math.min(window.innerWidth - tooltipW / 2 - 4, left));
    if (top + tooltipH + 4 > window.innerHeight) {
      top = Math.max(4, rect.top - tooltipH - 6);
    }

    ctxTooltip.style.left = left + 'px';
    ctxTooltip.style.top = top + 'px';
  }

  function setHoveredRing(next) {
    if (next && !next.classList.contains('ctx-ring')) next = null;
    if (hoveredRing === next) {
      if (hoveredRing) positionCtxTooltip();
      return;
    }
    if (hoveredRing) hoveredRing.classList.remove('hovered');
    hoveredRing = next;
    if (hoveredRing) {
      hoveredRing.classList.add('hovered');
      positionCtxTooltip();
    } else {
      hideCtxTooltip();
    }
  }

  function applySyntheticHover() {
    if (hoverX == null || hoverY == null || hoverX < 0 || hoverY < 0 ||
        hoverX > window.innerWidth || hoverY > window.innerHeight) {
      setHoveredEl(null);
      setHoveredRing(null);
      return;
    }
    var node = document.elementFromPoint(hoverX, hoverY);
    setHoveredEl(nearestWithClass(node, 'row'));
    setHoveredRing(nearestWithClass(node, 'ctx-ring'));
  }

  function setPromptHover(enabled) {
    promptHoverEnabled = enabled !== false;
    document.body.classList.toggle('prompt-hover-enabled', promptHoverEnabled);
    applySyntheticHover();
  }

  // Native hosts keep the window click-through, so CSS :hover is not enough:
  // the OS never delivers mouse events to the WebView. Instead, the host
  // forwards global cursor coordinates in WebView-local CSS pixels.
  function hoverAt(x, y) {
    hoverX = Number(x);
    hoverY = Number(y);
    applySyntheticHover();
  }

  document.addEventListener('mousemove', function (evt) {
    hoverX = evt.clientX;
    hoverY = evt.clientY;
    applySyntheticHover();
  });
  document.addEventListener('mouseleave', function () {
    hoverX = null;
    hoverY = null;
    applySyntheticHover();
  });

  function renderRowContent(row) {
    var d = row.data;
    var statusKey = STATUS[d.status] ? d.status : 'thinking';
    var s = STATUS[statusKey];
    var statusChanged = row.renderedStatus !== statusKey;
    var isDone = statusKey === 'done';

    // Prompt is deliberately not rendered inline anymore. Keep the compact
    // row focused on project + live status; reveal only text underneath on hover.
    var prompt = d.prompt || '';
    row.el.classList.toggle('has-prompt', !isDone && !!prompt);

    // LEFT: braille + project. Done rows hide the stopped spinner + project
    // so the completion state can collapse into a centered confirmation.
    var left = isDone ? '' : '<span class="braille" style="color:' + s.color + '">' +
               BRAILLE[brailleIdx] + '</span>';
    if (!isDone && d.project) left += '<span class="project">' + esc(d.project) + '</span>';

    // MIDDLE: transient tool detail only. Image attachment previews were
    // removed, so an idle thinking row leaves the center slot empty.
    var mid = '';
    if (!isDone && d.detail) {
      mid = '<span class="detail">' + esc(d.detail) + '</span>';
    }

    // RIGHT: status text + meta
    var right = '';
    if (s.label) {
      right += '<span class="status' + (statusChanged ? ' blur-in' : '') + '" style="--status-fg:' + s.fg + ';" data-label="' + esc(s.label) + '">' + esc(s.label) + '</span>';
    }
    var hasMeta = !isDone && (d.startedAt || d.ctxPct != null);
    if (hasMeta) {
      right += '<div class="meta">';
      if (d.startedAt) {
        var t = d.frozenElapsed != null ? d.frozenElapsed : (Date.now() - d.startedAt);
        right += '<span class="mono t-elapsed">' + fmtElapsedHTML(t) + '</span>';
      }
      if (d.ctxPct != null) {
        if (d.startedAt) right += '<span class="sep">·</span>';
        var pct = Math.max(0, Math.min(100, Math.round(d.ctxPct)));
        var color = ctxColor(pct);
        right += '<span class="ctx-ring" style="--ctx-color:' + color + '" data-tooltip="Context ' + pct + '%" aria-label="Context ' + pct + '%">' +
                 '<svg class="ctx-svg" viewBox="0 0 20 20" aria-hidden="true" focusable="false">' +
                   '<g transform="rotate(-90 10 10)">' +
                     '<circle class="ctx-track" cx="10" cy="10" r="8.4"></circle>' +
                     '<circle class="ctx-progress" cx="10" cy="10" r="8.4" pathLength="100" style="stroke-dasharray:' + pct + ' 100;opacity:' + (pct > 0 ? '1' : '0') + '"></circle>' +
                   '</g>' +
                 '</svg>' +
                 '</span>';
      }
      right += '</div>';
    }

    var promptReveal = '';
    if (!isDone && prompt) {
      promptReveal = '<div class="prompt-reveal"><div class="prompt-full">' + esc(prompt) + '</div></div>';
    }

    row.el.dataset.spin = s.spin ? 'true' : 'false';
    row.el.dataset.status = statusKey;
    row.renderedStatus = statusKey;
    row.el.innerHTML =
      '<div class="row-line">' +
        '<div class="slot left">'  + left  + '</div>' +
        '<div class="slot mid">'   + mid   + '</div>' +
        '<div class="slot right">' + right + '</div>' +
      '</div>' +
      promptReveal;
    requestAnimationFrame(applySyntheticHover);
  }

  // Optional per-row scale override. Primarily used by the "sizes" demo
  // to stack one row of each preset for promo screenshots. Sets --scale
  // inline on the row element so it wins over the :root global scale
  // via the normal CSS cascade (everything in .row uses calc() on
  // var(--scale), which picks up whichever --scale is closest on an
  // ancestor — inline style on the row itself is the closest). Leaving
  // it undefined keeps the row on the global scale.
  function applyRowScale(el, data) {
    if (typeof data.rowScale === 'string' && SCALES[data.rowScale] != null) {
      el.style.setProperty('--scale', String(SCALES[data.rowScale]));
    }
  }

  // message_update frames can arrive rapidly while the agent streams.
  // Avoid replacing row.innerHTML when rendered fields are unchanged so
  // the status text animation keeps a continuous phase instead of restarting.
  function sameRenderedData(a, b) {
    return a.project === b.project &&
      a.status === b.status &&
      a.detail === b.detail &&
      a.prompt === b.prompt &&
      a.startedAt === b.startedAt &&
      a.frozenElapsed === b.frozenElapsed &&
      a.ctxPct === b.ctxPct &&
      a.rowScale === b.rowScale;
  }

  function upsertRow(id, data) {
    var existing = rows[id];
    if (existing && !existing.removing) {
      var nextData = Object.assign({}, existing.data, data);
      var needsRender = !sameRenderedData(existing.data, nextData);
      existing.data = nextData;
      applyRowScale(existing.el, data);
      if (needsRender) renderRowContent(existing);
      startTickers();
      return;
    }

    var el = document.createElement('div');
    el.className = 'row';
    el.dataset.id = id;
    var row = { id: id, data: Object.assign({}, data), el: el, removing: false };
    if (!row.data.startedAt) row.data.startedAt = Date.now();

    rows[id] = row;
    order.push(id);
    stack.appendChild(el);
    applyRowScale(el, data);
    renderRowContent(row);

    // Trigger enter animation on next frame
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        el.classList.add('visible');
        applySyntheticHover();
      });
    });

    startTickers();
  }

  function removeRow(id) {
    var row = rows[id];
    if (!row || row.removing) return;
    row.removing = true;
    if (hoveredEl === row.el) setHoveredEl(null);
    if (hoveredRing && row.el.contains(hoveredRing)) setHoveredRing(null);
    // Removing .visible triggers the max-height + opacity transition, which
    // naturally shifts sibling rows up to fill the gap. Done rows exit faster
    // because their centered confirmation only lingers for a beat.
    var wasDone = row.el.dataset.status === 'done';
    row.el.classList.add('removing');
    row.el.classList.remove('visible');
    setTimeout(function () {
      if (row.el.parentNode) row.el.parentNode.removeChild(row.el);
      delete rows[id];
      var i = order.indexOf(id);
      if (i >= 0) order.splice(i, 1);
    }, wasDone ? 180 : 340);
  }

  function setMode(mode) {
    document.body.classList.toggle('notch-mode', mode === 'notch');
  }

  function setScale(scale) {
    var factor = SCALES[scale];
    if (factor == null) factor = SCALES.medium;
    document.documentElement.style.setProperty('--scale', String(factor));
  }

  window.island = {
    upsertRow: upsertRow,
    removeRow: removeRow,
    setMode: setMode,
    setScale: setScale,
    setPromptHover: setPromptHover,
    hoverAt: hoverAt,
  };
})();
</script>
</body>
</html>`;
}
