// HTML + client-side state machine for the Dynamic Island.
// The webview renders a VERTICAL STACK of rows — one per pi session
// connected to the companion socket. Each row is styled like the original
// single-row island and carries its own braille spinner, colors, and timer.
//
// Node → webview API (called via win.send from the companion):
//   window.island.upsertRow(id, data)   — create or update a row
//   window.island.removeRow(id)         — fade out + remove a row
//   window.island.setMode("normal"|"notch")
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
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body {
  width: 100%;
  height: 100%;
  background: transparent !important;
  overflow: hidden;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
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
  width: 460px;
  height: 34px;
  padding: 0 14px;
  /* The row uses a simple flex for left/right slots. The MIDDLE slot is
   * absolutely positioned at the row's geometric center (see .slot.mid)
   * so its text never shifts by a single pixel when the right-side label
   * changes width (Editing ↔ Writing ↔ Running ↔ Searching …). Grid's
   * 1fr track was almost stable but still produced sub-pixel jitter when
   * right-slot content reflowed. */
  position: relative;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  font-size: 11.5px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;

  /* Enter/exit: grow + fade so siblings shift smoothly. No translateY —
   * the visual effect is the stack extending downward. */
  opacity: 0;
  max-height: 0;
  transition:
    opacity    240ms cubic-bezier(0.32, 0.72, 0, 1),
    max-height 320ms cubic-bezier(0.32, 0.72, 0, 1);
}
.row.visible {
  opacity: 1;
  max-height: 34px;
}

/* Hairline between consecutive rows so they look stacked, not monolithic. */
.row.visible + .row.visible { border-top: 1px solid rgba(255,255,255,0.08); }

/* Only the LAST visible row rounds the bottom corners — produces the
 * continuous "capsule" look regardless of how many rows are stacked.
 * No drop-shadow: the capsule is pure black against whatever sits below
 * it, just like the real iPhone Dynamic Island. */
.row.visible:last-of-type { border-radius: 0 0 22px 22px; }

/* Notch mode: the FIRST row's middle is always empty (the notch lives
 * there). Subsequent rows (below the notch) behave like normal pills. */
body.notch-mode .row:first-child .slot.mid { visibility: hidden; }

.slot {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}
/* Left & right live in the flex row, shrinking naturally but keeping
 * their positions pinned to the row edges. */
.slot.left  { flex: 0 0 auto; }
.slot.right { flex: 0 0 auto; }
/* Middle is absolutely centered on the row. Because it's out of flow,
 * its position is defined ONLY by the row's width — independent of the
 * current left/right content. This makes the user's prompt rock-stable
 * pixel-for-pixel as status labels cycle. */
.slot.mid {
  position: absolute;
  left: 50%;
  top: 0;
  bottom: 0;
  transform: translateX(-50%);
  justify-content: center;
  overflow: hidden;
  /* Keep clear of left/right slots: row is 460px, padding 14*2=28,
   * left ≈ 130, right ≈ 170, plus a little breathing room. */
  max-width: 150px;
  pointer-events: none;
}

.braille {
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 13px;
  line-height: 1;
  width: 13px;
  text-align: center;
  flex-shrink: 0;
  display: inline-block;
}

.project {
  color: rgba(255,255,255,0.96);
  font-weight: 600;
  letter-spacing: -0.1px;
  flex-shrink: 0;
}
.sep    { color: rgba(255,255,255,0.28); flex-shrink: 0; }
.status { color: rgba(255,255,255,0.92); flex-shrink: 0; }
.detail {
  color: rgba(255,255,255,0.62);
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 10.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  max-width: 100%;
}
.prompt {
  color: rgba(255,255,255,0.82);
  font-style: italic;
  font-weight: 400;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  max-width: 100%;
}
.prompt::before { content: '\u201C'; opacity: 0.5; margin-right: 1px; }
.prompt::after  { content: '\u201D'; opacity: 0.5; margin-left: 1px; }

.meta {
  padding-left: 8px;
  border-left: 1px solid rgba(255,255,255,0.12);
  color: rgba(255,255,255,0.55);
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 10px;
  display: flex;
  gap: 6px;
  align-items: center;
  flex-shrink: 0;
}
.meta .mono { font-variant-numeric: tabular-nums; }
.ctx-warn { color: #F59E0B; }
.ctx-hot  { color: #EF4444; }
</style>
</head>
<body>
<div id="stack"></div>
<script>
(function () {
  var stack = document.getElementById('stack');

  // ---- Status table (state key → display color / label / spin flag) ----
  // The middle slot ALWAYS shows the user's original prompt — what pi is
  // working on. Braille color + right-side label reflect the current phase
  // (reading / editing / running / …). The task sentence is stable.
  var STATUS = {
    thinking:  { color: '#F59E0B', label: 'Working',    spin: true  },
    reading:   { color: '#3B82F6', label: 'Reading',    spin: true  },
    editing:   { color: '#FACC15', label: 'Editing',    spin: true  },
    writing:   { color: '#FACC15', label: 'Writing',    spin: true  },
    running:   { color: '#F97316', label: 'Running',    spin: true  },
    searching: { color: '#8B5CF6', label: 'Searching',  spin: true  },
    done:      { color: '#22C55E', label: 'Done',       spin: false },
    error:     { color: '#EF4444', label: 'Error',      spin: false },
  };

  var BRAILLE = ["\u280B","\u2819","\u2839","\u2838","\u283C","\u2834","\u2826","\u2827","\u2807","\u280F"];
  var brailleIdx = 0;

  var rows = {};      // id → { data, el, removing }
  var order = [];     // stable row order (first-seen first)
  var tickerB = null; // braille ticker
  var tickerT = null; // elapsed-time ticker

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function fmtElapsed(ms) {
    if (ms < 1000) return (ms / 1000).toFixed(1) + 's';
    var s = Math.floor(ms / 1000);
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60); s = s % 60;
    if (m < 60) return m + 'm ' + (s < 10 ? '0' : '') + s + 's';
    var h = Math.floor(m / 60); m = m % 60;
    return h + 'h ' + (m < 10 ? '0' : '') + m + 'm';
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

  function startTickers() {
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
            el.textContent = fmtElapsed(Date.now() - r.data.startedAt);
          }
        }
        if (!anyRunning()) { clearInterval(tickerT); tickerT = null; }
      }, 250);
    }
  }

  function renderRowContent(row) {
    var d = row.data;
    var s = STATUS[d.status] || STATUS.thinking;

    // Middle slot = the user's prompt, constant for the whole session.
    // Falls back to a tool detail only if no prompt exists (should be rare
    // — the extension always forwards currentPrompt).
    var task = d.prompt || d.detail || '';
    var taskCls = d.prompt ? 'prompt' : 'detail';

    // LEFT: braille + project
    var left = '<span class="braille" style="color:' + s.color + '">' +
               BRAILLE[brailleIdx] + '</span>';
    if (d.project) left += '<span class="project">' + esc(d.project) + '</span>';

    // MIDDLE: task (hidden via CSS when in notch-mode on first row)
    var mid = task ? '<span class="' + taskCls + '">' + esc(task) + '</span>' : '';

    // RIGHT: status label + meta
    var right = '';
    if (s.label) right += '<span class="status">' + esc(s.label) + '</span>';
    var hasMeta = d.startedAt || d.ctxPct != null;
    if (hasMeta) {
      right += '<div class="meta">';
      if (d.startedAt) {
        var t = d.frozenElapsed != null ? d.frozenElapsed : (Date.now() - d.startedAt);
        right += '<span class="mono t-elapsed">' + fmtElapsed(t) + '</span>';
      }
      if (d.ctxPct != null) {
        if (d.startedAt) right += '<span class="sep">\u00b7</span>';
        var cls = d.ctxPct >= 85 ? 'ctx-hot' : d.ctxPct >= 60 ? 'ctx-warn' : '';
        right += '<span class="mono ' + cls + '">' + Math.round(d.ctxPct) + '%</span>';
      }
      right += '</div>';
    }

    row.el.dataset.spin = s.spin ? 'true' : 'false';
    row.el.innerHTML =
      '<div class="slot left">'  + left  + '</div>' +
      '<div class="slot mid">'   + mid   + '</div>' +
      '<div class="slot right">' + right + '</div>';
  }

  function upsertRow(id, data) {
    var existing = rows[id];
    if (existing && !existing.removing) {
      existing.data = Object.assign({}, existing.data, data);
      renderRowContent(existing);
      startTickers();
      return;
    }

    var el = document.createElement('div');
    el.className = 'row';
    var row = { id: id, data: Object.assign({}, data), el: el, removing: false };
    if (!row.data.startedAt) row.data.startedAt = Date.now();

    rows[id] = row;
    order.push(id);
    stack.appendChild(el);
    renderRowContent(row);

    // Trigger enter animation on next frame
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { el.classList.add('visible'); });
    });

    startTickers();
  }

  function removeRow(id) {
    var row = rows[id];
    if (!row || row.removing) return;
    row.removing = true;
    // Removing .visible triggers the max-height + opacity transition, which
    // naturally shifts sibling rows up to fill the gap.
    row.el.classList.remove('visible');
    setTimeout(function () {
      if (row.el.parentNode) row.el.parentNode.removeChild(row.el);
      delete rows[id];
      var i = order.indexOf(id);
      if (i >= 0) order.splice(i, 1);
    }, 340);
  }

  function setMode(mode) {
    document.body.className = mode === 'notch' ? 'notch-mode' : '';
  }

  window.island = {
    upsertRow: upsertRow,
    removeRow: removeRow,
    setMode: setMode,
  };
})();
</script>
</body>
</html>`;
}
