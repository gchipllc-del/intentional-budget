/* ============================================================
   Intentional — 50/30/20 budgeting PWA
   No frameworks, no network. All data in localStorage.
   ============================================================ */
(function () {
  'use strict';

  // ---------- constants ----------
  const KINDS = ['needs', 'wants', 'savings'];
  const ALL_KINDS = ['income', 'needs', 'wants', 'savings'];
  const KIND_META = {
    income:  { label: 'Income',  icon: '💰', cls: 'i' },
    needs:   { label: 'Needs',   icon: '🏠', cls: 'n' },
    wants:   { label: 'Wants',   icon: '🛍️', cls: 'w' },
    savings: { label: 'Savings', icon: '🌱', cls: 's' },
  };
  const DEFAULT_TEMPLATE = {
    income:  ['Salary'],
    needs:   ['Rent / Mortgage', 'Groceries', 'Utilities', 'Insurance', 'Transport', 'Phone', 'Internet', 'Minimum debt payments'],
    wants:   ['Eating out', 'Subscriptions', 'Shopping', 'Entertainment', 'Personal care', 'Coffee'],
    savings: ['Emergency fund', 'Investments', 'Retirement', 'Extra debt payments'],
  };
  const STORE_KEY = 'intentional.v1';

  // ---------- tiny helpers ----------
  const q = (s, r) => (r || document).querySelector(s);
  const qa = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));
  const uid = () => 'e' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function money(n) {
    const v = Math.round((+n || 0) * 100) / 100;
    const neg = v < 0, a = Math.abs(v);
    const s = a % 1 === 0
      ? a.toLocaleString('en-US')
      : a.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (neg ? '-' : '') + state.settings.currency + s;
  }
  const pad2 = (n) => String(n).padStart(2, '0');
  const thisMonthKey = () => { const d = new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1); };
  function addMonths(key, delta) {
    const [y, m] = key.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1);
  }
  function keyToLabel(key) {
    const [y, m] = key.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
  }
  function keyToShort(key) {
    const [y, m] = key.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleString('en-US', { month: 'short' });
  }

  // ---------- state ----------
  let state = load();
  let tab = 'budget';
  const openCards = new Set();           // which kind cards are expanded
  let draftKey = null, draftMonth = null; // transient (unsaved) month
  let pendingFocus = null;

  function defaultState() {
    return {
      v: 1,
      settings: { currency: '$', targets: { needs: 0.5, wants: 0.3, savings: 0.2 }, theme: 'system', lastKind: 'needs',
        bank: { apiBase: '', token: '' } },
      current: thisMonthKey(),
      months: {},
    };
  }
  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) return migrate(JSON.parse(raw));
    } catch (e) { /* ignore */ }
    return defaultState();
  }
  function migrate(s) {
    const d = defaultState();
    s = s || {};
    s.settings = Object.assign({}, d.settings, s.settings || {});
    s.settings.targets = Object.assign({}, d.settings.targets, (s.settings && s.settings.targets) || {});
    s.settings.bank = Object.assign({}, d.settings.bank, s.settings.bank || {});
    s.months = s.months || {};
    s.current = s.current || thisMonthKey();
    s.v = 1;
    return s;
  }
  let saveTimer;
  function save() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 120); }
  function saveNow() { try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* quota */ } }

  // ---------- month data ----------
  function templateEntries(key) {
    const prior = Object.keys(state.months).filter((k) => k < key).sort().pop();
    if (prior) {
      return state.months[prior].entries.map((e) => ({ id: uid(), kind: e.kind, name: e.name, amount: e.amount, ts: Date.now() }));
    }
    const out = [];
    ALL_KINDS.forEach((k) => DEFAULT_TEMPLATE[k].forEach((name) => out.push({ id: uid(), kind: k, name, amount: 0, ts: Date.now() })));
    return out;
  }
  // returns persisted month, or a stable transient draft for the current key
  function monthView(key) {
    if (state.months[key]) return state.months[key];
    if (draftKey !== key) { draftKey = key; draftMonth = { entries: templateEntries(key), _draft: true }; }
    return draftMonth;
  }
  // commit the draft (if needed) and return the mutable persisted month
  function activeMonth() {
    const k = state.current;
    if (!state.months[k]) {
      const d = monthView(k);
      delete d._draft;
      state.months[k] = d;
    }
    return state.months[k];
  }

  function compute(entries, targets) {
    const sum = (k) => entries.filter((e) => e.kind === k).reduce((a, e) => a + (+e.amount || 0), 0);
    const income = sum('income');
    const res = { income, byKind: {}, allocated: 0, count: {} };
    KINDS.forEach((k) => {
      const spent = sum(k);
      const ideal = income * targets[k];
      res.byKind[k] = { spent, ideal, target: targets[k], pct: income > 0 ? spent / income : 0, remaining: ideal - spent };
      res.allocated += spent;
    });
    ALL_KINDS.forEach((k) => { res.count[k] = entries.filter((e) => e.kind === k).length; });
    res.surplus = income - res.allocated;
    res.savingsRate = income > 0 ? res.byKind.savings.spent / income : 0;
    return res;
  }

  // ============================================================
  //  RENDER
  // ============================================================
  function render() {
    q('#monthLabel').textContent = keyToLabel(state.current);
    applyTheme();
    qa('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.tab === tab));
    const view = q('#view');
    if (tab === 'budget') { view.innerHTML = budgetHTML(); wireBudget(); }
    else { view.innerHTML = trendsHTML(); wireTrends(); }
    window.scrollTo(0, 0);
    if (pendingFocus) {
      const el = q('[data-id="' + pendingFocus + '"] .item-name-input');
      if (el) { el.focus(); }
      pendingFocus = null;
    }
  }

  // ---------- budget view ----------
  function budgetHTML() {
    const m = monthView(state.current);
    const c = compute(m.entries, state.settings.targets);

    const status = statusInfo(c);
    const segs = KINDS.map((k) => {
      const w = c.income > 0 ? clamp(c.byKind[k].pct * 100, 0, 100) : 0;
      return `<i class="alloc-seg ${KIND_META[k].cls}" data-seg="${k}" style="width:${w}%"></i>`;
    }).join('');
    const leftW = c.income > 0 ? clamp((c.surplus / c.income) * 100, 0, 100) : 0;

    const legend = KINDS.map((k) =>
      `<span class="legend-item"><span class="dot ${KIND_META[k].cls}"></span>${KIND_META[k].label} <b data-legpct="${k}">${pctText(c.byKind[k].pct)}</b></span>`
    ).join('');

    const hero = `
      <div class="hero">
        <div class="hero-top">
          <div>
            <div class="hero-label">Monthly income</div>
            <div class="hero-income" id="heroIncome">${money(c.income)}</div>
          </div>
          <div class="hero-status ${status.cls}" id="heroStatus">${status.text}</div>
        </div>
        <div class="alloc-bar">${segs}<i class="alloc-seg" data-seg="left" style="width:${leftW}%;background:var(--line)"></i></div>
        <div class="alloc-legend">${legend}</div>
      </div>`;

    const incomeCard = cardHTML('income', c, m.entries);
    const cards = KINDS.map((k) => cardHTML(k, c, m.entries)).join('');

    const hint = c.income === 0
      ? `<p class="hint">Tap a card to add your figures, or hit&nbsp;<b>+</b> to log spending fast.<br>Everything is saved on this device only.</p>`
      : `<p class="hint">Tap any category to edit line items · hit&nbsp;<b>+</b> to log a purchase fast.</p>`;

    return hero + `<div style="height:18px"></div>` + incomeCard + cards + hint;
  }

  function statusInfo(c) {
    if (c.income === 0) return { cls: 'warn', text: 'Add income' };
    if (Math.abs(c.surplus) < 0.005) return { cls: 'good', text: 'All allocated' };
    if (c.surplus > 0) return { cls: 'good', text: money(c.surplus) + ' left' };
    return { cls: 'over', text: money(-c.surplus) + ' over' };
  }
  function pctText(p) { return Math.round(p * 100) + '%'; }

  function catSub(kind, info, income) {
    if (income === 0) return 'Set income to see target';
    if (kind === 'savings') {
      return info.remaining > 0.005
        ? money(info.remaining) + ' to reach goal'
        : 'Goal met · +' + money(-info.remaining);
    }
    return info.remaining >= -0.005
      ? money(Math.max(0, info.remaining)) + ' left of ' + money(info.ideal)
      : money(-info.remaining) + ' over budget';
  }
  function progressInfo(kind, info, income) {
    if (income === 0 || info.ideal === 0) return { w: 0, color: 'var(--' + kind + ')' };
    const ratio = info.spent / info.ideal;
    const over = info.spent > info.ideal + 0.005;
    const color = (kind !== 'savings' && over) ? 'var(--danger)' : 'var(--' + kind + ')';
    return { w: clamp(ratio * 100, 0, 100), color };
  }

  function cardHTML(kind, c, entries) {
    const meta = KIND_META[kind];
    const isIncome = kind === 'income';
    const info = isIncome ? null : c.byKind[kind];
    const total = isIncome ? c.income : info.spent;
    const items = entries.filter((e) => e.kind === kind);
    const open = openCards.has(kind);

    const name = isIncome ? 'Income' : (meta.label + ' · ' + Math.round(info.target * 100) + '%');
    const sub = isIncome
      ? (c.count.income + ' source' + (c.count.income === 1 ? '' : 's'))
      : catSub(kind, info, c.income);
    const rightPct = isIncome ? '' : `<div class="pct" data-pct="${kind}">${pctText(info.pct)} of income</div>`;

    const prog = isIncome ? '' : (() => {
      const p = progressInfo(kind, info, c.income);
      return `<div class="cat-progress"><i data-prog="${kind}" style="width:${p.w}%;background:${p.color}"></i></div>`;
    })();

    const rows = items.map((e) => `
      <div class="item-row" data-id="${e.id}">
        <span class="item-name"><input class="item-name-input" type="text" value="${esc(e.name)}" placeholder="Name" /></span>
        <input class="item-amt-input" type="text" inputmode="decimal" value="${e.amount ? esc(e.amount) : ''}" placeholder="0" />
        <button class="item-del" aria-label="Delete">×</button>
      </div>`).join('');

    return `
      <div class="cat-card ${open ? 'open' : ''}" data-kind="${kind}">
        <button class="cat-head" data-toggle="${kind}">
          <span class="cat-icon ${meta.cls}">${meta.icon}</span>
          <span class="cat-meta">
            <span class="cat-name">${name}</span>
            <span class="cat-sub" data-sub="${kind}">${sub}</span>
          </span>
          <span class="cat-amt">
            <span class="big" data-total="${kind}">${money(total)}</span>
            ${rightPct}
          </span>
          <span class="cat-chevron">›</span>
        </button>
        ${prog}
        <div class="items">
          ${rows || '<div class="item-row" style="color:var(--text-3);font-size:13px">No items yet</div>'}
          <button class="add-item" data-add="${kind}">＋ Add ${isIncome ? 'income source' : meta.label.toLowerCase()}</button>
        </div>
      </div>`;
  }

  // update only computed text/widths (keeps inputs & focus intact)
  function refreshComputed() {
    const m = monthView(state.current);
    const c = compute(m.entries, state.settings.targets);
    q('#heroIncome').textContent = money(c.income);
    const st = statusInfo(c), stEl = q('#heroStatus');
    stEl.textContent = st.text; stEl.className = 'hero-status ' + st.cls;
    KINDS.forEach((k) => {
      const w = c.income > 0 ? clamp(c.byKind[k].pct * 100, 0, 100) : 0;
      const seg = q('[data-seg="' + k + '"]'); if (seg) seg.style.width = w + '%';
      const lp = q('[data-legpct="' + k + '"]'); if (lp) lp.textContent = pctText(c.byKind[k].pct);
    });
    const leftSeg = q('[data-seg="left"]');
    if (leftSeg) leftSeg.style.width = (c.income > 0 ? clamp((c.surplus / c.income) * 100, 0, 100) : 0) + '%';

    ALL_KINDS.forEach((k) => {
      const totalEl = q('[data-total="' + k + '"]');
      if (totalEl) totalEl.textContent = money(k === 'income' ? c.income : c.byKind[k].spent);
      if (k !== 'income') {
        const subEl = q('[data-sub="' + k + '"]'); if (subEl) subEl.textContent = catSub(k, c.byKind[k], c.income);
        const pctEl = q('[data-pct="' + k + '"]'); if (pctEl) pctEl.textContent = pctText(c.byKind[k].pct) + ' of income';
        const prog = q('[data-prog="' + k + '"]');
        if (prog) { const p = progressInfo(k, c.byKind[k], c.income); prog.style.width = p.w + '%'; prog.style.background = p.color; }
      } else {
        const subEl = q('[data-sub="income"]'); if (subEl) subEl.textContent = c.count.income + ' source' + (c.count.income === 1 ? '' : 's');
      }
    });
  }

  function wireBudget() {
    qa('[data-toggle]').forEach((b) => b.addEventListener('click', () => {
      const k = b.dataset.toggle;
      if (openCards.has(k)) openCards.delete(k); else openCards.add(k);
      q('.cat-card[data-kind="' + k + '"]').classList.toggle('open');
    }));
    qa('.item-row[data-id]').forEach((row) => {
      const id = row.dataset.id;
      const nameI = q('.item-name-input', row);
      const amtI = q('.item-amt-input', row);
      if (nameI) nameI.addEventListener('input', () => { setEntry(id, { name: nameI.value }); save(); });
      if (amtI) amtI.addEventListener('input', () => {
        const v = parseFloat(amtI.value.replace(/[^0-9.]/g, '')) || 0;
        setEntry(id, { amount: v }); refreshComputed(); save();
      });
      const del = q('.item-del', row);
      if (del) del.addEventListener('click', () => { delEntry(id); render(); });
    });
    qa('[data-add]').forEach((b) => b.addEventListener('click', () => {
      const kind = b.dataset.add;
      const mm = activeMonth();
      const e = { id: uid(), kind, name: '', amount: 0, ts: Date.now() };
      mm.entries.push(e);
      openCards.add(kind);
      pendingFocus = e.id;
      saveNow(); render();
    }));
  }

  function setEntry(id, patch) {
    const mm = activeMonth();
    const e = mm.entries.find((x) => x.id === id);
    if (e) Object.assign(e, patch);
  }
  function delEntry(id) {
    const mm = activeMonth();
    mm.entries = mm.entries.filter((x) => x.id !== id);
  }

  // ---------- trends view ----------
  function persistedKeys() { return Object.keys(state.months).filter((k) => compute(state.months[k].entries, state.settings.targets).income > 0).sort(); }

  function trendsHTML() {
    const keys = persistedKeys();
    if (keys.length === 0) {
      return `<div class="empty"><div class="big">📈</div>
        <p>No history yet.<br>Add your income & spending on the <b>Budget</b> tab and your months will appear here with a savings-rate trend.</p></div>`;
    }
    const rows = keys.map((k) => ({ key: k, c: compute(state.months[k].entries, state.settings.targets) }));
    const rates = rows.map((r) => r.c.savingsRate);
    const avg = rates.reduce((a, b) => a + b, 0) / rates.length;
    const best = Math.max.apply(null, rates);
    const totalSaved = rows.reduce((a, r) => a + r.c.byKind.savings.spent, 0);

    const stats = `
      <div class="stat-grid">
        <div class="stat-card"><div class="v" style="color:var(--savings)">${pctText(avg)}</div><div class="k">Avg savings rate</div></div>
        <div class="stat-card"><div class="v">${pctText(best)}</div><div class="k">Best month</div></div>
        <div class="stat-card"><div class="v">${money(totalSaved)}</div><div class="k">Total saved</div></div>
      </div>`;

    const recent = rows.slice(-6);
    const bars = `
      <div class="chart-card">
        <h3>Where your money goes</h3>
        <p class="csub">Each bar = a month's income, split by category</p>
        <div class="bars">
          ${recent.map((r) => {
            const inc = r.c.income || 1;
            const h = (k) => clamp((r.c.byKind[k].spent / inc) * 100, 0, 100);
            return `<div class="bar-col">
              <div class="bar-stack">
                <i class="n" style="height:${h('needs')}%"></i>
                <i class="w" style="height:${h('wants')}%"></i>
                <i class="s" style="height:${h('savings')}%"></i>
              </div>
              <div class="bar-lbl">${keyToShort(r.key)}</div>
            </div>`;
          }).join('')}
        </div>
        <div class="alloc-legend" style="margin-top:14px;justify-content:center">
          <span class="legend-item"><span class="dot n"></span>Needs</span>
          <span class="legend-item"><span class="dot w"></span>Wants</span>
          <span class="legend-item"><span class="dot s"></span>Savings</span>
        </div>
      </div>`;

    const spark = `
      <div class="chart-card">
        <h3>Savings rate over time</h3>
        <p class="csub">Dashed line = your ${Math.round(state.settings.targets.savings * 100)}% goal</p>
        <div class="spark-wrap">${sparkSVG(rows)}</div>
      </div>`;

    const history = `
      <div class="section-title">All months</div>
      <div class="month-history">
        ${rows.slice().reverse().map((r) => `
          <button class="mh-row" data-go="${r.key}" style="width:100%;text-align:left">
            <span class="mh-when"><div class="m">${keyToLabel(r.key)}</div>
              <div class="s">${money(r.c.income)} income · ${money(r.c.allocated)} spent</div></span>
            <span class="mh-rate"><div class="r">${pctText(r.c.savingsRate)}</div><div class="l">saved</div></span>
          </button>`).join('')}
      </div>`;

    return stats + bars + spark + history;
  }

  function sparkSVG(rows) {
    const W = 320, H = 90, P = 8;
    const target = state.settings.targets.savings;
    const rates = rows.map((r) => r.c.savingsRate);
    const maxR = Math.max(0.35, target * 1.2, Math.max.apply(null, rates) * 1.1);
    const x = (i) => rows.length <= 1 ? W / 2 : P + (i * (W - 2 * P)) / (rows.length - 1);
    const y = (v) => H - P - (v / maxR) * (H - 2 * P);
    const pts = rows.map((r, i) => `${x(i).toFixed(1)},${y(r.c.savingsRate).toFixed(1)}`);
    const area = rows.length > 1
      ? `M${x(0)},${H - P} L${pts.join(' L')} L${x(rows.length - 1)},${H - P} Z`
      : '';
    const line = rows.length > 1 ? `M${pts.join(' L')}` : '';
    const dots = rows.map((r, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(r.c.savingsRate).toFixed(1)}" r="3.2" fill="var(--savings)"/>`).join('');
    const ty = y(target).toFixed(1);
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="none" style="display:block">
      <defs><linearGradient id="sg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="var(--savings)" stop-opacity="0.28"/>
        <stop offset="1" stop-color="var(--savings)" stop-opacity="0"/></linearGradient></defs>
      <line x1="${P}" y1="${ty}" x2="${W - P}" y2="${ty}" stroke="var(--text-3)" stroke-width="1" stroke-dasharray="4 4" opacity="0.7"/>
      ${area ? `<path d="${area}" fill="url(#sg)"/>` : ''}
      ${line ? `<path d="${line}" fill="none" stroke="var(--savings)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>` : ''}
      ${dots}
    </svg>`;
  }

  function wireTrends() {
    qa('[data-go]').forEach((b) => b.addEventListener('click', () => {
      state.current = b.dataset.go; tab = 'budget'; saveNow(); render();
    }));
  }

  // ============================================================
  //  SHEETS (modals)
  // ============================================================
  function openSheet(html) {
    const root = q('#sheetRoot');
    root.innerHTML = `<div class="scrim" data-close></div><div class="sheet" role="dialog" aria-modal="true"><div class="sheet-grip"></div>${html}</div>`;
    qa('[data-close]', root).forEach((el) => el.addEventListener('click', closeSheet));
    return root;
  }
  function closeSheet() { q('#sheetRoot').innerHTML = ''; }

  function addSheet() {
    const last = state.settings.lastKind || 'needs';
    const segs = ALL_KINDS.map((k) =>
      `<button data-k="${k}" class="${k === last ? 'on' : ''}"><span class="seg-dot" style="background:var(--${k === 'income' ? 'text-3' : k})"></span>${KIND_META[k].label}</button>`
    ).join('');
    openSheet(`
      <h2>Add entry</h2>
      <p class="sub">Logs straight into ${keyToLabel(state.current)}.</p>
      <div class="amount-field"><span class="cur">${esc(state.settings.currency)}</span>
        <input id="addAmt" type="text" inputmode="decimal" placeholder="0" /></div>
      <div class="field"><label>What was it?</label>
        <input id="addName" type="text" placeholder="e.g. Groceries, Rent, Coffee" /></div>
      <div class="field"><label>Category</label>
        <div class="segmented" id="addSeg">${segs}</div></div>
      <button class="btn-primary" id="addSave">Add entry</button>
      <button class="btn-ghost" data-close>Cancel</button>
    `);
    let kind = last;
    qa('#addSeg button').forEach((b) => b.addEventListener('click', () => {
      kind = b.dataset.k;
      qa('#addSeg button').forEach((x) => x.classList.toggle('on', x === b));
    }));
    const amt = q('#addAmt'); setTimeout(() => amt.focus(), 120);
    const submit = () => {
      const v = parseFloat((amt.value || '').replace(/[^0-9.]/g, '')) || 0;
      if (v <= 0) { amt.focus(); toast('Enter an amount'); return; }
      const name = (q('#addName').value || '').trim() || KIND_META[kind].label;
      const mm = activeMonth();
      mm.entries.push({ id: uid(), kind, name, amount: v, ts: Date.now() });
      state.settings.lastKind = kind;
      openCards.add(kind);
      saveNow(); closeSheet(); render(); toast('Added ' + money(v) + ' to ' + KIND_META[kind].label);
    };
    q('#addSave').addEventListener('click', submit);
    q('#addAmt').addEventListener('keydown', (e) => { if (e.key === 'Enter') q('#addName').focus(); });
    q('#addName').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  }

  function monthSheet() {
    const keys = Object.keys(state.months).sort().reverse();
    const cur = state.current;
    const list = keys.length
      ? keys.map((k) => {
          const c = compute(state.months[k].entries, state.settings.targets);
          return `<button class="rl-item" data-go="${k}" style="width:100%;text-align:left">
            <span class="rl-ico" style="background:var(--savings-soft)">📅</span>
            <span class="rl-main"><div class="rl-name">${keyToLabel(k)}${k === cur ? ' · current' : ''}</div>
              <div class="rl-sub">${money(c.income)} income · ${pctText(c.savingsRate)} saved</div></span>
          </button>`;
        }).join('')
      : '<p class="sub">No saved months yet.</p>';
    openSheet(`
      <h2>Jump to month</h2>
      <p class="sub">Use ‹ › on the top bar to move one month at a time.</p>
      <button class="btn-primary" id="goThis">Go to ${keyToLabel(thisMonthKey())}</button>
      <div class="row-list">${list}</div>
      <button class="btn-ghost" data-close>Close</button>
    `);
    q('#goThis').addEventListener('click', () => { state.current = thisMonthKey(); saveNow(); closeSheet(); render(); });
    qa('[data-go]').forEach((b) => b.addEventListener('click', () => { state.current = b.dataset.go; saveNow(); closeSheet(); render(); }));
  }

  function settingsSheet() {
    const t = state.settings.targets;
    const themes = ['system', 'light', 'dark'];
    openSheet(`
      <h2>Settings</h2>
      <div class="field" style="margin-top:8px"><label>Currency symbol</label>
        <input id="setCur" type="text" maxlength="3" value="${esc(state.settings.currency)}" /></div>

      <div class="field"><label>Target split</label>
        <div class="target-grid">
          <div class="tg n"><label>Needs</label><input id="tN" type="text" inputmode="numeric" value="${Math.round(t.needs * 100)}"></div>
          <div class="tg w"><label>Wants</label><input id="tW" type="text" inputmode="numeric" value="${Math.round(t.wants * 100)}"></div>
          <div class="tg s"><label>Savings</label><input id="tS" type="text" inputmode="numeric" value="${Math.round(t.savings * 100)}"></div>
        </div>
        <div class="target-sum" id="tSum"></div>
      </div>

      <div class="set-row"><span class="lbl">Appearance</span>
        <div class="theme-toggle" id="themeTog">
          ${themes.map((x) => `<button data-theme="${x}" class="${state.settings.theme === x ? 'on' : ''}">${x[0].toUpperCase() + x.slice(1)}</button>`).join('')}
        </div></div>

      <div class="section-title" style="margin-left:0">Bank sync (beta)</div>
      <p class="hint" style="text-align:left;margin:0 0 12px">Optional, read-only. Connects to <b>your own</b> backend (see <code>worker/README</code>) — never to me. It can read transactions but can never move money.</p>
      <div class="field"><label>API URL</label>
        <input id="bankApi" type="text" placeholder="https://intentional-budget-api.&lt;you&gt;.workers.dev" value="${esc((state.settings.bank || {}).apiBase || '')}" /></div>
      <div class="field"><label>Access key</label>
        <input id="bankKey" type="password" placeholder="your APP_SECRET" value="${esc((state.settings.bank || {}).token || '')}" /></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">
        <button class="btn-ghost" id="bankTest" style="width:auto;padding:11px 16px;background:var(--card-2);border-radius:12px">Test</button>
        <button class="btn-ghost" id="bankConnect" style="width:auto;padding:11px 16px;background:var(--card-2);border-radius:12px">Connect bank</button>
        <button class="btn-ghost" id="bankSync" style="width:auto;padding:11px 16px;background:var(--card-2);border-radius:12px">Sync now</button>
        <button class="btn-ghost btn-danger" id="bankDisconnect" style="width:auto;padding:11px 16px;background:var(--card-2);border-radius:12px">Disconnect</button>
      </div>
      <div class="hint" id="bankStatus" style="text-align:left;margin:0 0 4px">Not connected.</div>

      <div class="section-title" style="margin-left:0">Data</div>
      <div class="set-row"><span class="lbl">Export backup<small>Download all your data as a file</small></span>
        <button class="btn-ghost" id="expBtn" style="width:auto;padding:10px 16px;background:var(--card-2);border-radius:12px">Export</button></div>
      <div class="set-row"><span class="lbl">Import backup<small>Restore from an exported file</small></span>
        <button class="btn-ghost" id="impBtn" style="width:auto;padding:10px 16px;background:var(--card-2);border-radius:12px">Import</button></div>
      <input id="impFile" type="file" accept="application/json" style="display:none" />

      <button class="btn-ghost btn-danger" id="resetMonth" style="margin-top:10px">Clear ${keyToLabel(state.current)}</button>
      <button class="btn-ghost btn-danger" id="eraseAll">Erase everything</button>
      <p class="hint">Intentional keeps all data on this device. Nothing is uploaded. Export regularly to keep a backup.</p>
      <button class="btn-ghost" data-close>Done</button>
    `);

    const cur = q('#setCur');
    cur.addEventListener('input', () => { state.settings.currency = cur.value.trim() || '$'; save(); });

    const tN = q('#tN'), tW = q('#tW'), tS = q('#tS'), tSum = q('#tSum');
    const refreshSum = () => {
      const n = +tN.value || 0, w = +tW.value || 0, s = +tS.value || 0, sum = n + w + s;
      tSum.textContent = 'Total: ' + sum + '%' + (sum === 100 ? ' ✓' : ' (should be 100%)');
      tSum.className = 'target-sum' + (sum === 100 ? '' : ' bad');
    };
    [tN, tW, tS].forEach((el) => el.addEventListener('input', () => {
      state.settings.targets = { needs: (+tN.value || 0) / 100, wants: (+tW.value || 0) / 100, savings: (+tS.value || 0) / 100 };
      refreshSum(); save();
    }));
    refreshSum();

    qa('#themeTog button').forEach((b) => b.addEventListener('click', () => {
      state.settings.theme = b.dataset.theme;
      qa('#themeTog button').forEach((x) => x.classList.toggle('on', x === b));
      applyTheme(); saveNow();
    }));

    // --- Bank sync (beta) ---
    const bankApi = q('#bankApi'), bankKey = q('#bankKey'), bankStatus = q('#bankStatus');
    const saveBank = () => {
      state.settings.bank = state.settings.bank || {};
      state.settings.bank.apiBase = bankApi.value.trim();
      state.settings.bank.token = bankKey.value.trim();
      save();
    };
    bankApi.addEventListener('input', saveBank);
    bankKey.addEventListener('input', saveBank);
    const setBankStatus = (msg) => { bankStatus.textContent = msg; };
    q('#bankTest').addEventListener('click', () => runBank('test', setBankStatus));
    q('#bankConnect').addEventListener('click', () => runBank('connect', setBankStatus));
    q('#bankSync').addEventListener('click', () => runBank('sync', setBankStatus));
    q('#bankDisconnect').addEventListener('click', () => runBank('disconnect', setBankStatus));

    q('#expBtn').addEventListener('click', exportData);
    q('#impBtn').addEventListener('click', () => q('#impFile').click());
    q('#impFile').addEventListener('change', importData);
    q('#resetMonth').addEventListener('click', () => {
      if (confirm('Clear all entries for ' + keyToLabel(state.current) + '?')) {
        delete state.months[state.current]; draftKey = null;
        saveNow(); closeSheet(); render(); toast('Month cleared');
      }
    });
    q('#eraseAll').addEventListener('click', () => {
      if (confirm('Erase ALL data on this device? This cannot be undone.')) {
        state = defaultState(); draftKey = null; saveNow(); closeSheet(); render(); toast('All data erased');
      }
    });
  }

  function exportData() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'intentional-backup-' + thisMonthKey() + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Backup downloaded');
  }
  function importData(ev) {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const parsed = JSON.parse(r.result);
        if (!parsed || typeof parsed !== 'object' || !parsed.months) throw new Error('bad');
        state = migrate(parsed); draftKey = null; saveNow(); closeSheet(); render(); toast('Backup restored');
      } catch (e) { toast('Could not read that file'); }
    };
    r.readAsText(file);
  }

  // ---------- bank sync (beta) ----------
  async function bankFetch(path, opts) {
    const c = state.settings.bank || {};
    if (!c.apiBase || !c.token) throw new Error('Enter the API URL and access key first');
    const res = await fetch(c.apiBase.replace(/\/+$/, '') + path, Object.assign({}, opts, {
      headers: Object.assign({ Authorization: 'Bearer ' + c.token, 'Content-Type': 'application/json' }, (opts && opts.headers) || {}),
    }));
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data.error || ('HTTP ' + res.status)) + (data.code ? ' (' + data.code + ')' : ''));
    return data;
  }
  function loadPlaid() {
    return new Promise((resolve, reject) => {
      if (window.Plaid) return resolve();
      const s = document.createElement('script');
      s.src = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
      s.onload = resolve;
      s.onerror = () => reject(new Error('Could not load Plaid Link'));
      document.head.appendChild(s);
    });
  }
  // Replace this month's bank-sourced entries with freshly synced category totals.
  function importBankSummary(summary) {
    const m = activeMonth();
    m.entries = m.entries.filter((e) => e.src !== 'bank');
    const add = (kind, amt) => {
      const v = Math.round((+amt || 0) * 100) / 100;
      if (v > 0) m.entries.push({ id: uid(), kind, name: 'Synced from bank', amount: v, ts: Date.now(), src: 'bank' });
    };
    add('income', summary.income); add('needs', summary.needs);
    add('wants', summary.wants); add('savings', summary.savings);
    saveNow();
  }
  async function runBank(action, setStatus) {
    try {
      if (action === 'test') {
        setStatus('Testing…');
        const s = await bankFetch('/status', { method: 'GET' });
        setStatus(`Connected (${s.env}). ${s.items.length} bank(s), ${s.transactions} transactions.${s.killed ? ' KILL SWITCH ON.' : ''}`);
        toast('Connection OK');
      } else if (action === 'connect') {
        setStatus('Opening your bank…');
        const t = await bankFetch('/link/token', { method: 'POST' });
        await loadPlaid();
        const handler = window.Plaid.create({
          token: t.link_token,
          onSuccess: async (public_token) => {
            try {
              const r = await bankFetch('/link/exchange', { method: 'POST', body: JSON.stringify({ public_token }) });
              setStatus('Linked ' + (r.institution || 'bank') + '. Tap “Sync now”.');
              toast('Bank connected');
            } catch (e) { setStatus('Link failed: ' + e.message); }
          },
          onExit: () => setStatus('Link closed.'),
        });
        handler.open();
      } else if (action === 'sync') {
        setStatus('Syncing…');
        const r = await bankFetch('/sync', { method: 'POST' });
        const s = await bankFetch('/summary?month=' + encodeURIComponent(state.current), { method: 'GET' });
        importBankSummary(s.summary);
        closeSheet(); render();
        toast(`Synced ${state.current} (+${r.added})`);
      } else if (action === 'disconnect') {
        if (!confirm('Disconnect all banks and purge synced data from your server?')) return;
        setStatus('Disconnecting…');
        await bankFetch('/disconnect', { method: 'POST' });
        const m = activeMonth();
        m.entries = m.entries.filter((e) => e.src !== 'bank');
        saveNow();
        setStatus('Disconnected. Synced data purged.');
        toast('Disconnected');
      }
    } catch (e) {
      setStatus('Error: ' + e.message);
      toast(e.message);
    }
  }

  // ---------- theme ----------
  function applyTheme() {
    const t = state.settings.theme;
    if (t === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
  }

  // ---------- toast ----------
  let toastTimer;
  function toast(msg) {
    const root = q('#toastRoot');
    root.innerHTML = '<div class="toast">' + esc(msg) + '</div>';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { root.innerHTML = ''; }, 1900);
  }

  // ============================================================
  //  BOOT
  // ============================================================
  function boot() {
    q('#prevMonth').addEventListener('click', () => { state.current = addMonths(state.current, -1); saveNow(); render(); });
    q('#nextMonth').addEventListener('click', () => { state.current = addMonths(state.current, 1); saveNow(); render(); });
    q('#monthPill').addEventListener('click', monthSheet);
    q('#settingsBtn').addEventListener('click', settingsSheet);
    q('#fab').addEventListener('click', addSheet);
    qa('.tab').forEach((b) => b.addEventListener('click', () => { tab = b.dataset.tab; render(); }));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });
    render();

    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
    }
  }
  boot();
})();
