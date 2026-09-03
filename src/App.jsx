import { useEffect, useRef, useState } from 'react';
import { T, CATEGORIES, UNITS, DEFAULT_SITES, STORE, MONTHS, plural, fmt, monthKey, stockAt } from './constants';
import { Toast, EmptyState, OutlineButton, FilledButton, SegmentedTabs, FieldLabel, inputStyle, ErrorText } from './components/Primitives';
import { Header, Banner, TabBar } from './components/Chrome';
import { Sheet } from './components/Sheet';
import { supabase } from './supabaseClient';

// Supabase's products table uses snake_case columns; the rest of the app
// (still working from in-memory prototype shape) uses camelCase and keeps
// stock nested locally, since stock_levels isn't wired up yet (Step 6).
function productFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    unit: row.unit,
    owner: row.owner,
    barcode: row.barcode,
    parLevel: row.par_level,
    stock: {},
  };
}

export default function App() {
  // ---- core state (mirrors the prototype's this.state) ----
  // ---- login & role (Step 5: real accounts replace the old PIN) ----
  const [session, setSession] = useState(null);
  const [authChecking, setAuthChecking] = useState(true);
  const [profile, setProfile] = useState(null);
  const [profileChecking, setProfileChecking] = useState(false);
  const [previewStaff, setPreviewStaff] = useState(false);
  const [authError, setAuthError] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [view, setView] = useState('stock');
  const [products, setProducts] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [recounts, setRecounts] = useState([]);
  const [deliveries, setDeliveries] = useState([]);
  const [sites, setSites] = useState(DEFAULT_SITES.slice());
  const [transfers, setTransfers] = useState([]);
  const [transferFilter, setTransferFilter] = useState('all');
  const [openTransfers, setOpenTransfers] = useState({});
  const [summaryOn, setSummaryOn] = useState(true);
  const [recipients, setRecipients] = useState([]);
  const [stockVenue, setStockVenue] = useState('lc');
  const [productOwner, setProductOwner] = useState('house');
  const [count, setCount] = useState(null);
  const [recount, setRecount] = useState({ venue: 'lc' });
  const [draft, setDraft] = useState(null);
  const [sheet, setSheet] = useState(null);
  const [sheetError, setSheetError] = useState('');
  const [toastMsg, setToastMsg] = useState('');
  const [banner, setBanner] = useState('');
  const [search, setSearch] = useState('');
  const [openHistory, setOpenHistory] = useState({});
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [scan, setScan] = useState(null);
  const [scanStatus, setScanStatus] = useState('Point the camera at a barcode');
  const [editingId, setEditingId] = useState(null);
  const [confirmId, setConfirmId] = useState(null);
  const [confirmKind, setConfirmKind] = useState('session');
  const [detailId, setDetailId] = useState(null);
  const [photoTaken, setPhotoTaken] = useState(false);
  const [productsLoading, setProductsLoading] = useState(true);
  const [productsError, setProductsError] = useState('');

  // Step 3: products load from and save to Supabase. Everything else
  // (sites, sessions, deliveries, transfers, recounts, stock levels) is
  // still local-only, wired up in later steps. Only fetch once logged in,
  // since reading products now requires authentication (RLS policy).
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    async function load() {
      setProductsLoading(true);
      const { data, error } = await supabase.from('products').select('*').order('name');
      if (cancelled) return;
      if (error) {
        setProductsError(error.message);
        setProductsLoading(false);
        return;
      }
      setProducts((data || []).map(productFromRow));
      setProductsError('');
      setProductsLoading(false);
    }
    load();
    return () => { cancelled = true; };
  }, [session]);

  // Pick up whatever session already exists (e.g. returning visit) and keep
  // listening for sign-in / sign-out from anywhere in the app.
  useEffect(() => {
    let cancelled = false;
    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      setSession(data.session);
      setAuthChecking(false);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
      if (!newSession) setProfile(null);
    });
    return () => { cancelled = true; listener.subscription.unsubscribe(); };
  }, []);

  // Once logged in, look up this person's role (manager or staff) from
  // the profiles table \u2014 that's what decides what they can see and do.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    async function loadProfile() {
      setProfileChecking(true);
      const { data, error } = await supabase.from('profiles').select('*').eq('id', session.user.id).single();
      if (cancelled) return;
      if (error) { setProfile(null); setProfileChecking(false); return; }
      setProfile(data);
      setProfileChecking(false);
    }
    loadProfile();
    return () => { cancelled = true; };
  }, [session]);

  async function onSignIn(email, password) {
    setAuthError(''); setAuthBusy(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setAuthBusy(false);
    if (error) setAuthError(error.message);
  }
  async function onSignOut() {
    await supabase.auth.signOut();
    setPreviewStaff(false); setView('stock'); setSheet(null); setCount(null);
  }

  const nameRef = useRef(null);
  const catRef = useRef(null);
  const unitRef = useRef(null);
  const barcodeRef = useRef(null);
  const parRef = useRef(null);
  const codeRef = useRef(null);
  const siteRef = useRef(null);
  const emailRef = useRef(null);
  const recountInput = useRef({});
  const toastTimer = useRef(null);
  const scanTimer = useRef(null);
  const filledFlag = useRef(false);

  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); if (scanTimer.current) clearInterval(scanTimer.current); }, []);

  function toast(msg) {
    setToastMsg(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(''), 1900);
  }
  function venueName(id) { const v = sites.find(v => v.id === id); return v ? v.name : 'Unknown'; }
  function go(v) { setView(v); setSheet(null); setCount(null); }
  function openSheet(kind, extra) {
    setSheet(kind); setSheetError('');
    if (extra) {
      if ('draft' in extra) setDraft(extra.draft);
      if ('editing' in extra) setEditingId(extra.editing);
      if ('confirmId' in extra) setConfirmId(extra.confirmId);
      if ('confirmKind' in extra) setConfirmKind(extra.confirmKind);
      if ('detailId' in extra) setDetailId(extra.detailId);
      if ('photoTaken' in extra) setPhotoTaken(extra.photoTaken);
      if ('productOwner' in extra) setProductOwner(extra.productOwner);
    }
    filledFlag.current = false;
  }
  function closeSheet() { setSheet(null); setSheetError(''); setPhotoTaken(false); }

  // ---- scanner ----
  function startScan(mode) {
    setScan({ mode }); setScanStatus('Point the camera at a barcode');
    scanTimer.current = setInterval(simulateHit, 2300);
  }
  function stopScan() { if (scanTimer.current) clearInterval(scanTimer.current); scanTimer.current = null; }
  function closeScan() { stopScan(); setScan(null); }
  function simulateHit() {
    setProducts(curProducts => {
      setScan(curScan => {
        if (!curScan) return curScan;
        const pool = curProducts.filter(p => p.barcode);
        if (!pool.length) { setScanStatus('No barcodes on file yet — add them under Range'); return curScan; }
        const p = pool[Math.floor(Math.random() * pool.length)];
        if (curScan.mode === 'field') {
          if (barcodeRef.current) barcodeRef.current.value = p.barcode;
          setScanStatus('Read ' + p.barcode);
          stopScan();
          setTimeout(() => setScan(null), 500);
          return curScan;
        }
        bump(p.id, 1);
        setScanStatus('\u2713 ' + p.name + '  +1');
        return curScan;
      });
      return curProducts;
    });
  }
  function onManualCode() {
    const val = codeRef.current ? codeRef.current.value.trim() : '';
    if (!val) return;
    if (scan && scan.mode === 'field') {
      if (barcodeRef.current) barcodeRef.current.value = val;
      closeScan();
      return;
    }
    const p = products.find(x => x.barcode === val);
    if (p) { bump(p.id, 1); setScanStatus('\u2713 ' + p.name + '  +1'); }
    else setScanStatus('No product carries ' + val);
    if (codeRef.current) codeRef.current.value = '';
  }

  // ---- counting ----
  function bump(pid, delta) {
    setCount(c => {
      if (!c) return c;
      const counts = { ...c.counts };
      counts[pid] = Math.max(0, (counts[pid] || 0) + delta);
      return { ...c, counts };
    });
  }
  function openCount(mode, sessionId) {
    if (mode === 'delivery') {
      setCount({ mode, counts: { ...((draft && draft.items) || {}) }, review: (draft && draft.review) || [], added: (draft && draft.added) || [] });
      setSheet(null); setView('count');
      return;
    }
    if (mode === 'transfer') {
      setCount({ mode, counts: {}, review: [], added: [] });
      setSheet(null); setView('count');
      return;
    }
    const ses = sessions.find(x => x.id === sessionId);
    setCount({ mode, sessionId, counts: { ...(mode === 'out' ? ses.out : ses.back) }, review: [], added: [] });
    setSheet(null); setView('count');
  }
  function finishCount() {
    const c = count;
    if (!c) return;
    if (c.review && c.review.length) { toast('Resolve the review item first'); return; }
    const nextProducts = products.map(p => ({ ...p, stock: { ...p.stock } }));
    const apply = (venue, sign) => nextProducts.forEach(p => {
      const q = c.counts[p.id] || 0;
      if (q) p.stock[venue] = Math.max(0, (p.stock[venue] || 0) + sign * q);
    });

    if (c.mode === 'transfer') {
      const d = draft || {};
      const lines = Object.keys(c.counts).filter(k => c.counts[k] > 0);
      if (!lines.length) { toast('Nothing counted yet'); return; }
      apply(STORE, -1);
      const rec = { id: 't' + Date.now(), date: new Date().toISOString().slice(0, 10), site: d.site, note: d.note || '', items: { ...c.counts } };
      setProducts(nextProducts);
      setTransfers(t => [rec, ...t]);
      setCount(null); setDraft(null); setView('transfers');
      setOpenTransfers(o => ({ ...o, [rec.id]: true }));
      toast('Transferred to ' + venueName(d.site));
      return;
    }

    if (c.mode === 'delivery') {
      const d = draft || { supplier: 'Delivery', venue: 'lc', date: new Date().toISOString().slice(0, 10) };
      apply(d.venue, 1);
      const rec = { id: 'd' + Date.now(), supplier: d.supplier, reference: d.reference || '', date: d.date, venue: d.venue, hasPhoto: !!d.hasPhoto, items: { ...c.counts } };
      setProducts(nextProducts);
      setDeliveries(ds => [rec, ...ds]);
      setCount(null); setDraft(null); setView('deliveries');
      toast('Delivery saved — stock updated');
      return;
    }

    const nextSessions = sessions.map(x => ({ ...x }));
    const ses = nextSessions.find(x => x.id === c.sessionId);
    if (c.mode === 'out') {
      ses.out = { ...c.counts };
      ses.status = 'out';
      apply(ses.venue, -1);
      setProducts(nextProducts); setSessions(nextSessions); setCount(null);
      setView('sessionDetail'); setActiveSessionId(ses.id);
      toast('Container is out');
    } else {
      ses.back = { ...c.counts };
      ses.status = 'complete';
      ses.completedAt = new Date().toISOString();
      apply(ses.venue, 1);
      setProducts(nextProducts); setSessions(nextSessions); setCount(null); setActiveSessionId(null);
      setView(role === 'admin' ? 'history' : 'sessions');
      setOpenHistory(o => ({ ...o, [ses.id]: true }));
      toast('Session complete');
    }
  }

  // ---- invoice auto-read (the one bit of "real logic") ----
  function autoRead(lines) {
    if (!lines || !lines.length) {
      setDraft(d => ({ ...d, hasPhoto: true, items: {}, review: [], added: [] }));
      setSheet(null); setView('count'); setPhotoTaken(true);
      setCount({ mode: 'delivery', counts: {}, review: [], added: [] });
      toast('Nothing read — count by hand');
      return;
    }
    const norm = n => n.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const tokens = n => norm(n).split(' ').filter(Boolean);
    const items = {}; const review = []; const added = [];
    let nextProducts = products.slice(); let matched = 0;

    lines.forEach(line => {
      const n = norm(line.name);
      const confident = nextProducts.find(p => norm(p.name).includes(n) || n.includes(norm(p.name)));
      if (confident) { items[confident.id] = (items[confident.id] || 0) + line.quantity; matched++; return; }
      const ta = new Set(tokens(line.name));
      let best = null, bestScore = 0;
      nextProducts.forEach(p => {
        const tb = new Set(tokens(p.name));
        let shared = 0; ta.forEach(t => { if (tb.has(t)) shared++; });
        const score = shared / Math.min(ta.size, tb.size);
        if (score > bestScore) { bestScore = score; best = p; }
      });
      if (best && bestScore >= 0.34) {
        review.push({ id: 'rv' + review.length, name: line.name, quantity: line.quantity, candidateId: best.id, candidateName: best.name });
        return;
      }
      const np = { id: 'new' + nextProducts.length, name: line.name, category: 'Other', unit: 'Case', stock: {}, parLevel: null, barcode: null };
      nextProducts = nextProducts.concat([np]);
      added.push(line.name);
      items[np.id] = line.quantity;
    });

    setProducts(nextProducts);
    setDraft(d => ({ ...d, hasPhoto: true, items, review, added }));
    setSheet(null); setView('count'); setPhotoTaken(true);
    setCount({ mode: 'delivery', counts: items, review, added });
    const parts = ['Matched ' + matched];
    if (added.length) parts.push(added.length + ' new');
    if (review.length) parts.push(review.length + ' to review');
    toast(parts.join(' \u00b7 '));
  }

  function resolveReview(id, asNew) {
    setCount(c => {
      if (!c) return c;
      const item = (c.review || []).find(r => r.id === id);
      if (!item) return c;
      const counts = { ...c.counts };
      let added = (c.added || []).slice();
      if (asNew) {
        const np = { id: 'new' + Date.now(), name: item.name, category: 'Other', unit: 'Bottle', stock: {}, parLevel: null, barcode: null };
        setProducts(ps => ps.concat([np]));
        counts[np.id] = (counts[np.id] || 0) + item.quantity;
        added = added.concat([item.name]);
      } else {
        counts[item.candidateId] = (counts[item.candidateId] || 0) + item.quantity;
      }
      return { ...c, counts, added, review: c.review.filter(r => r.id !== id) };
    });
    toast(asNew ? 'Added as a new product' : 'Merged into the existing product');
  }

  function saveRecount() {
    const venue = recount.venue;
    const changes = [];
    const nextProducts = products.map(p => {
      const raw = recountInput.current[p.id];
      if (raw === undefined || raw === '') return p;
      const after = Number(raw) || 0;
      const before = stockAt(p, venue);
      if (after !== before) changes.push({ name: p.name, before, after, variance: after - before });
      return { ...p, stock: { ...p.stock, [venue]: after } };
    });
    if (!changes.length) { toast('No changes to save'); setView('stock'); return; }
    const rec = { id: 'r' + Date.now(), date: new Date().toISOString().slice(0, 10), venue, changes };
    recountInput.current = {};
    setProducts(nextProducts);
    setRecounts(rs => [rec, ...rs]);
    setView('history');
    setOpenHistory(o => ({ ...o, [rec.id]: true }));
    toast(changes.length + ' line' + (changes.length === 1 ? '' : 's') + ' adjusted at ' + venueName(venue));
  }

  // ================= derived values (mirrors renderVals()) =================
  const isManager = !!profile && profile.role === 'manager';
  const role = isManager && !previewStaff ? 'admin' : 'employee';
  const isAdmin = role === 'admin';
  const effectiveView = isAdmin ? view : (['sessions', 'sessionDetail', 'count'].includes(view) ? view : 'sessions');
  const openSessions = sessions.filter(x => x.status !== 'complete');
  const active = openSessions[0];
  const sv = stockVenue;

  const groupsFor = (list) => {
    const byCat = {};
    list.forEach(p => { (byCat[p.category] = byCat[p.category] || []).push(p); });
    return CATEGORIES.filter(c => byCat[c]).map(cat => ({
      cat,
      items: byCat[cat].slice().sort((a, b) => a.name.localeCompare(b.name)).map(p => {
        const qty = stockAt(p, sv);
        const low = p.parLevel && qty < p.parLevel;
        return {
          id: p.id, name: p.name, qty,
          meta: p.unit + (p.parLevel ? ' \u00b7 par ' + p.parLevel : ''),
          isFcg: p.owner === 'fcg',
          tone: low ? T.warn : T.text,
          edge: low ? 'rgba(216,162,79,.55)' : 'rgba(233,233,237,.09)',
        };
      }),
    }));
  };
  const houseProducts = products.filter(p => p.owner !== 'fcg');
  const fcgProducts = products.filter(p => p.owner === 'fcg');
  const split = fcgProducts.length > 0;
  const ownerSections = split
    ? [
        { label: 'Our stock', note: plural(houseProducts.length, 'product'), showHeader: true, groups: groupsFor(houseProducts) },
        { label: 'Fizzy Cherry (FCG)', note: 'invoiced separately when transferred', showHeader: true, groups: groupsFor(fcgProducts) },
      ].filter(x => x.groups.length)
    : [{ label: '', note: '', showHeader: false, groups: groupsFor(products) }];
  let statLow = 0;
  products.forEach(p => { if (p.parLevel && stockAt(p, sv) < p.parLevel) statLow++; });

  const c = count;
  const ses = c && c.sessionId ? sessions.find(x => x.id === c.sessionId) : null;
  const countTiles = !c ? [] : products.map(p => {
    const qty = (c.counts && c.counts[p.id]) || 0;
    let meta = p.unit;
    if (c.mode === 'out' && ses) meta = p.unit + ' \u00b7 available ' + stockAt(p, ses.venue);
    if (c.mode === 'back' && ses) meta = 'went out: ' + (ses.out[p.id] || 0);
    if (c.mode === 'transfer') meta = p.unit + ' \u00b7 in container ' + stockAt(p, STORE);
    return { id: p.id, name: p.name, meta, qty, isFcg: p.owner === 'fcg' };
  });
  const countTitle = c ? (c.mode === 'out' ? 'Loading out' : c.mode === 'back' ? 'Logging return' : c.mode === 'transfer' ? 'Transfer out' : 'Count delivery') : '';
  const countSub = !c ? '' : c.mode === 'transfer'
    ? 'Container \u2192 ' + venueName((draft && draft.site) || '') + ' \u00b7 tap a row to add one, or scan'
    : c.mode === 'delivery'
    ? ((draft && draft.supplier) || 'Delivery') + ' \u00b7 ' + venueName((draft && draft.venue) || 'lc') + ' \u00b7 tap a row to add one, or scan'
    : (ses ? ses.name + ' \u00b7 ' + venueName(ses.venue) + ' \u00b7 tap a row to add one, or scan' : '');

  const historyItems = [];
  sessions.filter(x => x.status === 'complete').sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || '')).forEach(x => {
    const rows = products.map(p => {
      const out = x.out[p.id] || 0, back = x.back[p.id] || 0;
      if (!out && !back) return null;
      const flag = back > out;
      return { name: p.name, a: out, b: back, c: out - back, tone: flag ? T.danger : T.text };
    }).filter(Boolean);
    historyItems.push({
      id: x.id, title: x.name, meta: fmt(x.date) + ' \u00b7 ' + venueName(x.venue) + ' \u00b7 session',
      flagged: rows.some(r => r.tone === T.danger), open: !!openHistory[x.id],
      col1: 'Out', col2: 'Back', col3: 'Used', rows,
    });
  });
  recounts.forEach(r => {
    historyItems.push({
      id: r.id, title: 'Recount \u2014 ' + venueName(r.venue), meta: fmt(r.date) + ' \u00b7 ' + r.changes.length + ' lines checked',
      flagged: r.changes.some(x => x.variance !== 0), open: !!openHistory[r.id],
      col1: 'Was', col2: 'Now', col3: 'Var',
      rows: r.changes.map(x => ({ name: x.name, a: x.before, b: x.after, c: (x.variance > 0 ? '+' : '') + x.variance, tone: x.variance ? T.warn : T.textSecondary })),
    });
  });

  const now = new Date();
  const thisMonth = now.toISOString().slice(0, 7);
  const isFcgId = pid => { const p = products.find(x => x.id === pid); return !!(p && p.owner === 'fcg'); };
  const unitsIn = t => Object.keys(t.items).reduce((n, k) => n + (t.items[k] || 0), 0);
  const fcgUnitsIn = t => Object.keys(t.items).reduce((n, k) => n + (isFcgId(k) ? (t.items[k] || 0) : 0), 0);
  const receivingSites = sites.filter(v => v.id !== STORE);
  const transferSummaries = receivingSites.map(v => {
    const mine = transfers.filter(t => t.site === v.id);
    const month = mine.filter(t => monthKey(t.date) === thisMonth);
    const fcgUnits = month.reduce((n, t) => n + fcgUnitsIn(t), 0);
    const total = month.reduce((n, t) => n + unitsIn(t), 0);
    return {
      id: v.id, name: v.name, units: total, hasFcg: fcgUnits > 0,
      fcgLabel: 'of which ' + fcgUnits + ' FCG',
      meta: plural(month.length, 'transfer') + ' \u00b7 ' + plural(month.reduce((n, t) => n + Object.keys(t.items).length, 0), 'line')
        + ' \u00b7 last ' + (mine.length ? fmt(mine[0].date) : 'none yet'),
      edge: transferFilter === v.id ? 'rgba(145,132,217,.5)' : 'rgba(233,233,237,.09)',
    };
  });
  const filterChips = [{ id: 'all', name: 'All sites' }].concat(receivingSites);
  const transferList = transfers
    .filter(t => transferFilter === 'all' || t.site === transferFilter)
    .map(t => ({
      id: t.id, site: venueName(t.site),
      meta: fmt(t.date) + ' \u00b7 ' + plural(Object.keys(t.items).length, 'line') + ' \u00b7 ' + plural(unitsIn(t), 'unit'),
      hasFcg: fcgUnitsIn(t) > 0, fcgTag: fcgUnitsIn(t) + ' FCG',
      open: !!openTransfers[t.id],
      rows: Object.keys(t.items).map(pid => {
        const p = products.find(x => x.id === pid);
        return { name: p ? p.name : 'Removed product', qty: t.items[pid], isFcg: isFcgId(pid) };
      }),
    }));

  const q = search.trim().toLowerCase();
  const productList = products.filter(p => !q || p.name.toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name));

  const detail = sheet === 'deliveryDetail' ? deliveries.find(d => d.id === detailId) : null;
  const editingProduct = sheet === 'product' && editingId ? products.find(p => p.id === editingId) : null;

  useEffect(() => {
    if (editingProduct && nameRef.current && !filledFlag.current) {
      nameRef.current.value = editingProduct.name;
      filledFlag.current = true;
      setProductOwner(editingProduct.owner === 'fcg' ? 'fcg' : 'house');
      if (catRef.current) catRef.current.value = editingProduct.category;
      if (unitRef.current) unitRef.current.value = editingProduct.unit;
      if (barcodeRef.current) barcodeRef.current.value = editingProduct.barcode || '';
      if (parRef.current) parRef.current.value = editingProduct.parLevel || '';
    }
  }, [editingProduct]);

  const detailSession = view === 'sessionDetail' ? (sessions.find(x => x.id === activeSessionId) || active) : null;

  const tabs = [
    ['stock', 'Stock', 'ph-stack'], ['sessions', 'Sessions', 'ph-clipboard-text'],
    ['transfers', 'Transfers', 'ph-arrows-left-right'], ['deliveries', 'Goods in', 'ph-truck'],
    ['history', 'History', 'ph-clock-counter-clockwise'], ['more', 'More', 'ph-dots-three-circle'],
  ].map(([key, label, icon]) => {
    const on = effectiveView === key
      || (key === 'sessions' && effectiveView === 'sessionDetail')
      || (key === 'stock' && effectiveView === 'recount')
      || (key === 'more' && effectiveView === 'products')
      || (effectiveView === 'count' && ((key === 'transfers' && c && c.mode === 'transfer') || (key === 'deliveries' && c && c.mode === 'delivery') || (key === 'sessions' && c && (c.mode === 'out' || c.mode === 'back'))));
    return { label, icon, tone: on ? T.accent : T.textMuted, go: () => go(key) };
  });

  // ================= handlers referenced by JSX =================
  // A manager can preview the staff view (harmless, since they still have
  // full access underneath) \u2014 a real staff account can't switch back,
  // since their role comes from their own login, not a toggle.
  function onRoleToggle() {
    if (!isManager) return;
    setPreviewStaff(p => !p);
    setView(previewStaff ? 'stock' : 'sessions');
    setCount(null); setSheet(null);
    toast(previewStaff ? 'Manager view' : 'Previewing staff view');
  }

  async function deleteProduct(id) {
    const { error } = await supabase.from('products').delete().eq('id', id);
    if (error) { toast("Couldn't delete: " + error.message); return; }
    setProducts(ps => ps.filter(p => p.id !== id));
    setSheet(null);
    toast('Product deleted');
  }

  async function onSaveProduct() {
    const name = nameRef.current ? nameRef.current.value.trim() : '';
    if (!name) { setSheetError('Give the product a name.'); return; }
    const cat = catRef.current ? catRef.current.value : 'Other';
    const unit = unitRef.current ? unitRef.current.value : 'Bottle';
    const barcode = barcodeRef.current ? barcodeRef.current.value.trim() : '';
    const parRaw = parRef.current ? parRef.current.value.trim() : '';
    const par = parRaw ? Number(parRaw) : null;
    const clash = products.find(p => barcode && p.barcode === barcode && (!editingProduct || p.id !== editingProduct.id));
    if (clash) { setSheetError('\u201c' + clash.name + '\u201d already uses that barcode.'); return; }
    const owner = productOwner === 'fcg' ? 'fcg' : 'house';
    const row = { name, category: cat, unit, owner, barcode: barcode || null, par_level: par };

    if (editingProduct) {
      const { data, error } = await supabase.from('products').update(row).eq('id', editingProduct.id).select().single();
      if (error) { setSheetError('Could not save: ' + error.message); return; }
      // keep this session's in-memory stock numbers — stock_levels isn't wired up yet
      setProducts(products.map(p => p.id === editingProduct.id ? { ...productFromRow(data), stock: p.stock } : p));
    } else {
      const { data, error } = await supabase.from('products').insert(row).select().single();
      if (error) { setSheetError('Could not save: ' + error.message); return; }
      const created = productFromRow(data);
      setProducts(products.concat([created]));
    }
    setSheet(null); setEditingId(null); setSheetError('');
    toast(editingProduct ? 'Product updated' : 'Product added');
  }
  function onCreateSession() {
    const name = nameRef.current ? nameRef.current.value.trim() : '';
    if (!name) { setSheetError('Name the event so it is findable later.'); return; }
    const id = 'ses' + Date.now();
    const venue = (draft && draft.venue) || 'lc';
    const ses = { id, name, venue, date: new Date().toISOString().slice(0, 10), status: 'loading', out: {}, back: {} };
    setSessions(s => [ses, ...s]); setSheet(null); setActiveSessionId(id);
    setCount({ mode: 'out', sessionId: id, counts: {}, review: [], added: [] }); setView('count');
  }
  function onAutoRead() {
    const name = nameRef.current ? nameRef.current.value.trim() : '';
    if (!name) { setSheetError('Add the supplier first.'); return; }
    const nextDraft = { ...draft, supplier: name, date: new Date().toISOString().slice(0, 10) };
    setDraft(nextDraft);
    // simulated invoice read: a couple of plausible lines drawn from existing products, or none.
    const sampleLines = products.length
      ? products.slice(0, Math.min(3, products.length)).map(p => ({ name: p.name, quantity: 1 + Math.floor(Math.random() * 4) }))
      : [];
    autoRead(sampleLines);
  }
  function onCountDelivery() {
    const name = nameRef.current ? nameRef.current.value.trim() : '';
    if (!name) { setSheetError('Add the supplier first.'); return; }
    setDraft(d => ({ ...d, supplier: name, date: new Date().toISOString().slice(0, 10), items: {}, review: [], added: [] }));
    openCount('delivery');
  }
  function onAddSite() {
    const name = siteRef.current ? siteRef.current.value.trim() : '';
    if (!name) return;
    setSites(s => s.concat([{ id: 'v' + Date.now(), name }]));
    if (siteRef.current) siteRef.current.value = '';
    toast(name + ' added');
  }
  function onAddRecipient() {
    const v = emailRef.current ? emailRef.current.value.trim() : '';
    if (!v || v.indexOf('@') < 1) { toast('That does not look like an email'); return; }
    if (recipients.includes(v)) { toast('Already on the list'); return; }
    setRecipients(r => r.concat([v]));
    if (emailRef.current) emailRef.current.value = '';
  }
  function onNewTransfer() {
    if (!receivingSites.length) { toast('Add a site under More first'); return; }
    openSheet('transfer', { draft: { site: receivingSites[0].id } });
  }
  function onStartTransfer() {
    if (!products.length) { setSheetError('Add products to your range first.'); return; }
    openCount('transfer');
  }
  function pickVenue(id) {
    if (sheet === 'session' || sheet === 'delivery') setDraft(d => ({ ...d, venue: id }));
    else setRecount(r => ({ ...r, venue: id }));
  }
  const currentVenue = (sheet === 'session' || sheet === 'delivery') ? ((draft && draft.venue) || 'lc') : recount.venue;

  // ================= render =================
  if (authChecking) {
    return <FullScreenMessage text="Loading\u2026" />;
  }
  if (!session) {
    return <LoginScreen onSignIn={onSignIn} busy={authBusy} error={authError} />;
  }
  if (profileChecking || !profile) {
    return <FullScreenMessage text={profileChecking ? 'Loading your account\u2026' : "Couldn't find your account \u2014 ask a manager to set you up."} showSignOut onSignOut={onSignOut} />;
  }

  return (
    <div style={{
      height: '100dvh', display: 'flex', flexDirection: 'column', background: T.ground,
      position: 'relative', overflow: 'hidden', fontFamily: 'Inter, system-ui, sans-serif',
      color: T.text, fontVariantNumeric: 'tabular-nums',
    }}>
      <Header
        roleLabel={isAdmin ? 'Manager' : 'Staff'}
        isAdmin={isAdmin}
        canTogglePreview={isManager}
        hasActive={!!active}
        activeLabel={active ? active.name + ' \u00b7 ' + (active.status === 'loading' ? 'Loading' : 'Out') : ''}
        onActivePill={() => { setView('sessionDetail'); setActiveSessionId(active ? active.id : null); setCount(null); }}
        onRoleToggle={onRoleToggle}
        onSignOut={onSignOut}
      />
      <Banner text={isAdmin ? banner : ''} onDismiss={() => setBanner('')} />

      <div className="ws-scroll" style={{ flex: 1, overflow: 'auto', padding: '18px 16px 36px' }}>
        {effectiveView === 'stock' && (
          <StockScreen
            sites={sites} sv={sv} stockVenue={stockVenue} setStockVenue={setStockVenue}
            statProducts={products.length} statLow={statLow} statOpen={openSessions.length}
            ownerSections={ownerSections} noProducts={products.length === 0}
            onOpenRecount={() => setView('recount')}
            onGoProducts={() => go('products')}
            stockVenueName={venueName(sv)}
          />
        )}
        {effectiveView === 'sessions' && (
          <SessionsScreen
            isAdmin={isAdmin} openSessions={openSessions} venueName={venueName} fmt={fmt}
            onOpen={(id) => { setView('sessionDetail'); setActiveSessionId(id); }}
            onNewSession={() => openSheet('session', { draft: { venue: 'lc' } })}
          />
        )}
        {effectiveView === 'sessionDetail' && detailSession && (
          <SessionDetailScreen
            session={detailSession} venueName={venueName} fmt={fmt}
            onBack={() => setView('sessions')}
            onPrimary={() => openCount(detailSession.status === 'loading' ? 'out' : 'back', detailSession.id)}
            onCancel={() => openSheet('confirm', { confirmId: detailSession.id, confirmKind: 'session' })}
          />
        )}
        {effectiveView === 'count' && c && (
          <CountScreen
            title={countTitle} sub={countSub} tiles={countTiles}
            finishLabel={c.mode === 'out' ? 'Finish \u2014 container is out' : c.mode === 'back' ? 'Finish return' : c.mode === 'transfer' ? 'Record transfer' : 'Save delivery'}
            onFinish={finishCount}
            onBack={() => { setCount(null); setView(c.mode === 'delivery' ? 'deliveries' : c.mode === 'transfer' ? 'transfers' : 'sessionDetail'); }}
            reviewItems={(c.review || []).map(r => ({ ...r, merge: () => resolveReview(r.id, false), asNew: () => resolveReview(r.id, true) }))}
            autoAdded={c.added || []}
            onOpenScan={() => startScan('count')}
            onInc={(pid) => bump(pid, 1)} onDec={(pid) => bump(pid, -1)}
            onTapRow={(pid) => bump(pid, 1)}
          />
        )}
        {effectiveView === 'recount' && (
          <RecountScreen
            sites={sites} recount={recount} pickVenue={(id) => setRecount(r => ({ ...r, venue: id }))}
            rows={products.map(p => ({ id: p.id, name: p.name, current: stockAt(p, recount.venue) }))}
            recountInput={recountInput} onSave={saveRecount} onBack={() => setView('stock')}
          />
        )}
        {effectiveView === 'deliveries' && (
          <DeliveriesScreen
            deliveries={deliveries} venueName={venueName} fmt={fmt}
            noDeliveries={deliveries.length === 0}
            onNewDelivery={() => openSheet('delivery', { draft: { venue: 'lc' }, photoTaken: false })}
            onOpen={(id) => openSheet('deliveryDetail', { detailId: id })}
          />
        )}
        {effectiveView === 'history' && <HistoryScreen items={historyItems} onToggle={(id) => setOpenHistory(o => ({ ...o, [id]: !o[id] }))} />}
        {effectiveView === 'products' && (
          <ProductsScreen
            search={search} onSearch={setSearch} productList={productList}
            onNewProduct={() => openSheet('product', { editing: null, productOwner: 'house' })}
            onEdit={(id) => openSheet('product', { editing: id })}
            onDelete={(id) => openSheet('confirm', { confirmId: id, confirmKind: 'product' })}
            loading={productsLoading} error={productsError}
          />
        )}
        {effectiveView === 'transfers' && (
          <TransfersScreen
            transferMonth={MONTHS[now.getMonth()] + ' ' + now.getFullYear()}
            transferSummaries={transferSummaries}
            onSummaryClick={(id) => setTransferFilter(f => f === id ? 'all' : id)}
            filterChips={filterChips} transferFilter={transferFilter} setTransferFilter={setTransferFilter}
            transferList={transferList} noTransfers={transferList.length === 0}
            onToggle={(id) => setOpenTransfers(o => ({ ...o, [id]: !o[id] }))}
            onNewTransfer={onNewTransfer}
          />
        )}
        {effectiveView === 'more' && (
          <MoreScreen
            productCountLabel={plural(products.length, 'product')}
            onGoProducts={() => go('products')}
            sites={sites} STORE={STORE}
            onRemoveSite={(id) => setSites(s => s.filter(x => x.id !== id))}
            siteRef={siteRef} onAddSite={onAddSite}
            summaryOn={summaryOn} onToggleSummary={() => setSummaryOn(v => !v)}
            recipients={recipients} onRemoveRecipient={(email) => setRecipients(r => r.filter(x => x !== email))}
            emailRef={emailRef} onAddRecipient={onAddRecipient}
          />
        )}
      </div>

      {isAdmin && <TabBar tabs={tabs} />}
      <Toast message={toastMsg} />

      {sheet === 'session' && (
        <Sheet title="New session" onClose={closeSheet} onBackdrop={closeSheet}>
          <FieldLabel>Event name</FieldLabel>
          <input ref={nameRef} placeholder="Wedding \u2014 The Barn" style={{ ...inputStyle, marginBottom: 14 }} autoFocus />
          <FieldLabel>Loading site</FieldLabel>
          <SegmentedTabs options={sites.map(v => ({
            name: v.name, pick: () => pickVenue(v.id),
            edge: currentVenue === v.id ? T.accent : 'transparent',
            bg: currentVenue === v.id ? 'rgba(145,132,217,.12)' : 'transparent',
            tone: currentVenue === v.id ? T.accentLight : T.textSecondary,
          }))} />
          <ErrorText>{sheetError}</ErrorText>
          <FilledButton onClick={onCreateSession}>Start loading out</FilledButton>
        </Sheet>
      )}

      {sheet === 'delivery' && (
        <Sheet title="Log delivery" onClose={closeSheet} onBackdrop={closeSheet}>
          <FieldLabel>Supplier</FieldLabel>
          <input ref={nameRef} placeholder="Supplier name" style={{ ...inputStyle, marginBottom: 14 }} autoFocus />
          <FieldLabel>Destination site</FieldLabel>
          <div style={{ marginBottom: 14 }}>
            <SegmentedTabs options={sites.map(v => ({
              name: v.name, pick: () => pickVenue(v.id),
              edge: currentVenue === v.id ? T.accent : 'transparent',
              bg: currentVenue === v.id ? 'rgba(145,132,217,.12)' : 'transparent',
              tone: currentVenue === v.id ? T.accentLight : T.textSecondary,
            }))} />
          </div>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: 13, borderRadius: 8,
            border: '1px dashed rgba(233,233,237,.16)', marginBottom: 8,
          }}>
            <i className="ph ph-camera" style={{ fontSize: 20, color: T.textSecondary }} />
            <div style={{ fontSize: 13.5 }}>{photoTaken ? 'Photo attached' : 'No photo yet'}</div>
          </div>
          <div style={{ fontSize: 12, color: T.textMuted, lineHeight: 1.5, marginBottom: 16 }}>
            Auto-read pulls line items and quantities, then asks you to confirm anything uncertain.
          </div>
          <ErrorText>{sheetError}</ErrorText>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <OutlineButton icon="ph-camera" onClick={onAutoRead}>Photograph and auto-read</OutlineButton>
            <OutlineButton icon="ph-list-checks" onClick={onCountDelivery}>Count items by hand</OutlineButton>
          </div>
        </Sheet>
      )}

      {sheet === 'deliveryDetail' && detail && (
        <Sheet title={detail.supplier} onClose={closeSheet} onBackdrop={closeSheet}>
          <div style={{
            height: 90, borderRadius: 8, marginBottom: 14,
            background: 'repeating-linear-gradient(135deg, rgba(233,233,237,.06), rgba(233,233,237,.06) 8px, transparent 8px, transparent 16px)',
            border: '1px solid rgba(233,233,237,.09)',
          }} />
          <div style={{ fontSize: 12.5, color: T.textSecondary, marginBottom: 14 }}>
            {fmt(detail.date)} \u00b7 {venueName(detail.venue)}{detail.reference ? ' \u00b7 ' + detail.reference : ''}
          </div>
          {Object.keys(detail.items).map(pid => {
            const p = products.find(x => x.id === pid);
            return (
              <div key={pid} style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid rgba(233,233,237,.08)', fontSize: 14 }}>
                <span>{p ? p.name : 'Removed product'}</span>
                <span style={{ color: T.accentLight, fontWeight: 500 }}>{detail.items[pid]}</span>
              </div>
            );
          })}
        </Sheet>
      )}

      {sheet === 'transfer' && (
        <Sheet title="Transfer to a site" onClose={closeSheet} onBackdrop={closeSheet}>
          <div style={{ fontSize: 12.5, color: T.textSecondary, lineHeight: 1.5, marginBottom: 16 }}>
            Stock comes out of Louis Container. The site keeps it \u2014 you invoice them for it at month end.
          </div>
          <FieldLabel>Destination site</FieldLabel>
          <SegmentedTabs options={receivingSites.map(v => ({
            name: v.name,
            pick: () => setDraft(d => ({ ...d, site: v.id })),
            edge: (draft && draft.site) === v.id ? T.accent : 'transparent',
            bg: (draft && draft.site) === v.id ? 'rgba(145,132,217,.12)' : 'transparent',
            tone: (draft && draft.site) === v.id ? T.accentLight : T.textSecondary,
          }))} />
          <ErrorText>{sheetError}</ErrorText>
          <FilledButton onClick={onStartTransfer}>Count what's going</FilledButton>
        </Sheet>
      )}

      {sheet === 'product' && (
        <Sheet title={editingProduct ? 'Edit product' : 'Add product'} onClose={closeSheet} onBackdrop={closeSheet}>
          <FieldLabel>Name</FieldLabel>
          <input ref={nameRef} placeholder="Product name" style={{ ...inputStyle, marginBottom: 14 }} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
            <div>
              <FieldLabel>Category</FieldLabel>
              <select ref={catRef} defaultValue="Other" style={inputStyle}>
                {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <FieldLabel>Unit</FieldLabel>
              <select ref={unitRef} defaultValue="Bottle" style={inputStyle}>
                {UNITS.map(u => <option key={u} value={u}>{u}</option>)}
              </select>
            </div>
          </div>
          <FieldLabel>Belongs to</FieldLabel>
          <SegmentedTabs options={[
            { id: 'house', name: 'Ours' }, { id: 'fcg', name: 'Fizzy Cherry' },
          ].map(o => ({
            name: o.name, pick: () => setProductOwner(o.id),
            edge: productOwner === o.id ? T.accent : 'transparent',
            bg: productOwner === o.id ? 'rgba(145,132,217,.12)' : 'transparent',
            tone: productOwner === o.id ? T.accentLight : T.textSecondary,
          }))} />
          <div style={{ fontSize: 12, color: T.textMuted, marginTop: -10, marginBottom: 16, lineHeight: 1.5 }}>
            Fizzy Cherry stock sits in the container but is invoiced separately when it moves to a site.
          </div>
          <FieldLabel>Barcode</FieldLabel>
          <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
            <input ref={barcodeRef} placeholder="Optional" style={{ ...inputStyle, flex: 1 }} />
            <button onClick={() => startScan('field')} style={{
              width: 48, borderRadius: 8, border: '1px solid rgba(233,233,237,.16)', background: T.card,
              color: T.textSecondary, cursor: 'pointer', fontSize: 18,
            }}><i className="ph ph-barcode" /></button>
          </div>
          <FieldLabel>Par level</FieldLabel>
          <input ref={parRef} type="number" placeholder="Optional" style={{ ...inputStyle, marginBottom: 16 }} />
          <ErrorText>{sheetError}</ErrorText>
          <FilledButton onClick={onSaveProduct}>{editingProduct ? 'Save changes' : 'Add product'}</FilledButton>
        </Sheet>
      )}

      {sheet === 'confirm' && (
        <Sheet title="Please confirm" onClose={closeSheet} onBackdrop={closeSheet}>
          {confirmKind === 'product' ? (
            <>
              <div style={{ fontSize: 14, lineHeight: 1.55, color: T.textSecondary, marginBottom: 18 }}>
                Delete "{(products.find(p => p.id === confirmId) || {}).name || 'this product'}"? This removes it from your range entirely \u2014 it can't be undone.
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={closeSheet} style={{ flex: 1, padding: 14, borderRadius: 8, border: '1px solid rgba(233,233,237,.16)', background: 'transparent', color: T.text, cursor: 'pointer' }}>Back</button>
                <button
                  onClick={() => deleteProduct(confirmId)}
                  style={{ flex: 1, padding: 14, borderRadius: 8, border: 'none', background: T.danger, color: '#fff', fontWeight: 500, cursor: 'pointer' }}
                >Delete product</button>
              </div>
            </>
          ) : (
            <>
              <div style={{ fontSize: 14, lineHeight: 1.55, color: T.textSecondary, marginBottom: 18 }}>
                Cancel this session? Anything logged so far is discarded and stock goes back as it was.
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={closeSheet} style={{ flex: 1, padding: 14, borderRadius: 8, border: '1px solid rgba(233,233,237,.16)', background: 'transparent', color: T.text, cursor: 'pointer' }}>Back</button>
                <button
                  onClick={() => { setSessions(s => s.filter(x => x.id !== confirmId)); setSheet(null); setView('sessions'); toast('Session cancelled'); }}
                  style={{ flex: 1, padding: 14, borderRadius: 8, border: 'none', background: T.danger, color: '#fff', fontWeight: 500, cursor: 'pointer' }}
                >Cancel session</button>
              </div>
            </>
          )}
        </Sheet>
      )}

      {scan && (
        <div style={{ position: 'fixed', inset: 0, background: 'radial-gradient(circle at 50% 40%, #23263a, #0e0f18)', zIndex: 60, display: 'flex', flexDirection: 'column' }}>
          <div style={{ flex: 1, position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{
              width: '76%', aspectRatio: '5 / 3', border: `1px solid ${T.accent}`, borderRadius: 12,
              boxShadow: '0 0 0 2000px rgba(10,11,18,.82)', position: 'relative', overflow: 'hidden',
            }}>
              <div className="ws-sweep" style={{ position: 'absolute', left: 0, right: 0, height: 2, background: T.accent, boxShadow: `0 0 10px ${T.accent}` }} />
            </div>
            <div style={{ position: 'absolute', bottom: 24, left: 0, right: 0, textAlign: 'center', fontSize: 13.5, color: T.textSecondary, padding: '0 20px' }}>{scanStatus}</div>
          </div>
          <div style={{ padding: '16px 16px calc(env(safe-area-inset-bottom) + 16px)', background: T.chrome }}>
            <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
              <input ref={codeRef} placeholder="Enter code manually" style={{ ...inputStyle, flex: 1 }} onKeyDown={(e) => { if (e.key === 'Enter') onManualCode(); }} />
              <button onClick={onManualCode} style={{ padding: '0 18px', borderRadius: 8, border: 'none', background: 'rgba(145,132,217,.2)', color: T.accentLight, fontWeight: 500, cursor: 'pointer' }}>Add</button>
            </div>
            <button onClick={closeScan} style={{ width: '100%', padding: 13, borderRadius: 8, border: '1px solid rgba(233,233,237,.16)', background: 'transparent', color: T.textSecondary, cursor: 'pointer' }}>Close scanner</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================= Screens =============================

function FullScreenMessage({ text, showSignOut, onSignOut }) {
  return (
    <div style={{
      height: '100dvh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      gap: 16, background: T.ground, color: T.textSecondary, fontFamily: 'Inter, system-ui, sans-serif',
      fontSize: 14, textAlign: 'center', padding: '0 30px',
    }}>
      <div>{text}</div>
      {showSignOut && (
        <button onClick={onSignOut} style={{ padding: '10px 18px', borderRadius: 8, border: `1px solid ${T.accent}`, background: 'transparent', color: T.accent, cursor: 'pointer', fontSize: 13 }}>
          Sign out
        </button>
      )}
    </div>
  );
}

function LoginScreen({ onSignIn, busy, error }) {
  const emailRef = useRef(null);
  const pwRef = useRef(null);
  function submit() {
    const email = emailRef.current ? emailRef.current.value.trim() : '';
    const password = pwRef.current ? pwRef.current.value : '';
    if (!email || !password) return;
    onSignIn(email, password);
  }
  return (
    <div style={{
      height: '100dvh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      background: T.ground, fontFamily: 'Inter, system-ui, sans-serif', color: T.text, padding: '0 24px',
    }}>
      <div style={{ width: '100%', maxWidth: 320 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 28, justifyContent: 'center' }}>
          <span style={{ width: 7, height: 7, borderRadius: 2, background: T.accent, boxShadow: '0 0 10px rgba(145,132,217,.8)' }} />
          <span style={{ fontSize: 17, fontWeight: 500 }}>Wetstock</span>
        </div>
        <FieldLabel>Email</FieldLabel>
        <input ref={emailRef} type="email" autoCapitalize="none" placeholder="you@site.com" style={{ ...inputStyle, marginBottom: 14 }} onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
        <FieldLabel>Password</FieldLabel>
        <input ref={pwRef} type="password" placeholder="\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022" style={{ ...inputStyle, marginBottom: 14 }} onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
        <ErrorText>{error}</ErrorText>
        <FilledButton onClick={submit} disabled={busy}>{busy ? 'Signing in\u2026' : 'Sign in'}</FilledButton>
        <div style={{ fontSize: 12, color: T.textMuted, textAlign: 'center', marginTop: 16, lineHeight: 1.5 }}>
          Accounts are set up by a manager \u2014 ask them if you don't have one yet.
        </div>
      </div>
    </div>
  );
}


function StockScreen({ sites, sv, setStockVenue, statProducts, statLow, statOpen, ownerSections, noProducts, onOpenRecount, onGoProducts, stockVenueName }) {
  return (
    <div>
      <div style={{ fontSize: 26, fontWeight: 500, letterSpacing: '-.02em', marginBottom: 4 }}>Cellar stock</div>
      <div style={{ fontSize: 14, lineHeight: 1.5, color: T.textSecondary, marginBottom: 14 }}>Live levels at {stockVenueName}. Updated from deliveries, sessions and recounts.</div>
      <SegmentedTabs options={sites.map(v => ({
        name: v.name, pick: () => setStockVenue(v.id),
        edge: sv === v.id ? T.accent : 'transparent',
        bg: sv === v.id ? 'rgba(145,132,217,.12)' : 'transparent',
        tone: sv === v.id ? T.accentLight : T.textSecondary,
      }))} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8, marginBottom: 16 }}>
        <StatCard value={statProducts} label="Products" color={T.accentLight} />
        <StatCard value={statLow} label="Below par" color={T.warn} />
        <StatCard value={statOpen} label="Open" color={T.text} />
      </div>
      <OutlineButton icon="ph-clipboard-text" onClick={onOpenRecount}>Recount stock</OutlineButton>
      {noProducts && (
        <div style={{ marginTop: 16 }}>
          <EmptyState
            title="No products yet"
            body="Add what you carry, then stock levels build up from deliveries and sessions."
            action={<OutlineButton icon="ph-plus" onClick={onGoProducts} style={{ width: 'auto', display: 'inline-flex', padding: '13px 20px', fontSize: 14 }}>Add your first product</OutlineButton>}
          />
        </div>
      )}
      {ownerSections.map((o, i) => (
        <div key={i}>
          {o.showHeader && (
            <div style={{ margin: '26px 2px 4px', paddingBottom: 10, borderBottom: '1px solid rgba(233,233,237,.14)' }}>
              <div style={{ fontSize: 16, fontWeight: 500, letterSpacing: '-.01em' }}>{o.label}</div>
              <div style={{ fontSize: 12, color: T.textMuted, marginTop: 3 }}>{o.note}</div>
            </div>
          )}
          {o.groups.map((g, gi) => (
            <div key={gi}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '18px 2px 10px' }}>
                <span style={{ fontSize: 10, fontWeight: 500, letterSpacing: '.1em', textTransform: 'uppercase', color: T.textMuted }}>{g.cat}</span>
                <span style={{ flex: 1, height: 1, background: 'linear-gradient(to right,rgba(233,233,237,.13),transparent)' }} />
              </div>
              {g.items.map(p => (
                <div key={p.id} style={{ background: T.card, border: `1px solid ${p.edge}`, borderRadius: 8, padding: 13, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                      <span style={{ fontSize: 15, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                      {p.isFcg && <FcgChip />}
                    </div>
                    <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2 }}>{p.meta}</div>
                  </div>
                  <div style={{ fontSize: 22, fontWeight: 500, color: p.tone }}>{p.qty}</div>
                </div>
              ))}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function StatCard({ value, label, color }) {
  return (
    <div style={{ background: T.surface, border: '1px solid rgba(233,233,237,.09)', borderRadius: 8, padding: 12 }}>
      <div style={{ fontSize: 26, fontWeight: 500, color, letterSpacing: '-.02em' }}>{value}</div>
      <div style={{ fontSize: 10, fontWeight: 500, letterSpacing: '.06em', textTransform: 'uppercase', color: T.textMuted, marginTop: 2 }}>{label}</div>
    </div>
  );
}

function FcgChip() {
  return (
    <span style={{ fontSize: 9.5, fontWeight: 500, letterSpacing: '.04em', color: T.accentLight, background: 'rgba(145,132,217,.14)', border: '1px solid rgba(145,132,217,.3)', borderRadius: 4, padding: '2px 5px', flex: 'none' }}>FCG</span>
  );
}

function SessionsScreen({ isAdmin, openSessions, venueName, fmt, onOpen, onNewSession }) {
  return (
    <div>
      <div style={{ fontSize: 26, fontWeight: 500, letterSpacing: '-.02em', marginBottom: 4 }}>{isAdmin ? 'Sessions' : 'Your session'}</div>
      <div style={{ fontSize: 14, color: T.textSecondary, marginBottom: 16 }}>{isAdmin ? 'Containers out at events, per venue.' : 'What is going out, and what comes back.'}</div>
      <div style={{ marginBottom: 14 }}>
        <OutlineButton icon="ph-plus" onClick={onNewSession}>Start new session</OutlineButton>
      </div>
      {openSessions.length === 0 && <EmptyState title="No open sessions" body="Start one when a container heads out to an event." />}
      {openSessions.map(x => (
        <div key={x.id} onClick={() => onOpen(x.id)} style={{
          background: T.card, border: `1px solid ${T.accent}`, borderRadius: 8, padding: 14, marginBottom: 8,
          display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer',
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 500 }}>{x.name}</div>
            <div style={{ fontSize: 12, color: T.textMuted, marginTop: 3 }}>{venueName(x.venue)} \u00b7 {fmt(x.date)}</div>
          </div>
          <span style={{ fontSize: 11, fontWeight: 500, color: T.accentLight, background: 'rgba(145,132,217,.14)', borderRadius: 20, padding: '5px 10px' }}>
            {x.status === 'loading' ? 'Loading' : 'Out'}
          </span>
          <i className="ph ph-caret-right" style={{ color: T.textMuted }} />
        </div>
      ))}
    </div>
  );
}

function SessionDetailScreen({ session, venueName, fmt, onBack, onPrimary, onCancel }) {
  return (
    <div>
      <button onClick={onBack} style={{ background: 'none', border: 'none', color: T.textSecondary, fontSize: 13.5, display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', marginBottom: 14, padding: 0 }}>
        <i className="ph ph-arrow-left" /> Sessions
      </button>
      <div style={{ background: 'linear-gradient(160deg,#2b2741,#1e2130)', border: `1px solid ${T.accent}`, borderRadius: 10, padding: 18 }}>
        <div style={{ fontSize: 19, fontWeight: 500 }}>{session.name}</div>
        <div style={{ fontSize: 12.5, color: T.textMuted, marginTop: 4 }}>{venueName(session.venue)} \u00b7 {fmt(session.date)}</div>
        <div style={{ borderTop: '1px solid rgba(233,233,237,.12)', margin: '14px 0', paddingTop: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: T.accent }} />
          <span style={{ fontSize: 13.5, color: T.textSecondary }}>
            {session.status === 'loading' ? 'Loading out \u2014 nothing logged yet' : 'Out at the event \u2014 awaiting return'}
          </span>
        </div>
        <FilledButton onClick={onPrimary} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
          <i className={`ph ${session.status === 'loading' ? 'ph-arrow-up-right' : 'ph-arrow-down-left'}`} />
          {session.status === 'loading' ? 'Log items going out' : 'Log items coming back'}
        </FilledButton>
      </div>
      <button onClick={onCancel} style={{ background: 'none', border: 'none', color: T.textMuted, fontSize: 13, cursor: 'pointer', marginTop: 16, padding: 0 }}>
        Cancel session
      </button>
    </div>
  );
}

function CountScreen({ title, sub, tiles, finishLabel, onFinish, onBack, reviewItems, autoAdded, onOpenScan, onInc, onDec, onTapRow }) {
  return (
    <div>
      <button onClick={onBack} style={{ background: 'none', border: 'none', color: T.textSecondary, fontSize: 13.5, display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', marginBottom: 10, padding: 0 }}>
        <i className="ph ph-arrow-left" /> Back
      </button>
      <div style={{ fontSize: 21, fontWeight: 500, letterSpacing: '-.01em', marginBottom: 3 }}>{title}</div>
      <div style={{ fontSize: 13, color: T.textSecondary, marginBottom: 14 }}>{sub}</div>

      <div style={{ marginBottom: 12 }}>
        <OutlineButton icon="ph-barcode" onClick={onOpenScan}>Scan barcode</OutlineButton>
      </div>

      {reviewItems.map(r => (
        <div key={r.id} style={{ background: 'rgba(216,162,79,.08)', border: '1px solid rgba(216,162,79,.4)', borderRadius: 8, padding: 13, marginBottom: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 500, color: T.warn, marginBottom: 5 }}>Needs review \u2014 possible duplicate</div>
          <div style={{ fontSize: 14, marginBottom: 4 }}>{r.name} \u00d7 {r.quantity}</div>
          <div style={{ fontSize: 12, color: T.textSecondary, lineHeight: 1.5, marginBottom: 10 }}>
            Similar to \u201c{r.candidateName}\u201d, already on the system. Not confident enough to merge on its own.
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={r.merge} style={{ flex: 1, padding: 10, borderRadius: 8, border: '1px solid rgba(233,233,237,.16)', background: 'transparent', color: T.text, cursor: 'pointer', fontSize: 13 }}>Same product</button>
            <button onClick={r.asNew} style={{ flex: 1, padding: 10, borderRadius: 8, border: '1px solid rgba(233,233,237,.16)', background: 'transparent', color: T.text, cursor: 'pointer', fontSize: 13 }}>It's new</button>
          </div>
        </div>
      ))}

      {autoAdded.length > 0 && (
        <div style={{ background: T.surface, border: '1px solid rgba(233,233,237,.09)', borderRadius: 8, padding: 13, marginBottom: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 4 }}>Added automatically</div>
          <div style={{ fontSize: 13, color: T.textSecondary }}>{autoAdded.join(', ')}</div>
          <div style={{ fontSize: 11.5, color: T.textMuted, marginTop: 6 }}>Check their category, unit and barcode under Range when you get a moment.</div>
        </div>
      )}

      {tiles.map(p => {
        const on = p.qty > 0;
        return (
          <div
            key={p.id}
            onClick={() => onTapRow(p.id)}
            style={{
              background: on ? 'rgba(145,132,217,.08)' : T.card,
              border: `1px solid ${on ? 'rgba(145,132,217,.4)' : 'rgba(233,233,237,.09)'}`,
              borderRadius: 8, padding: 13, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 10,
              cursor: 'pointer', transition: 'background 140ms, border-color 140ms',
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <span style={{ fontSize: 15, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                {p.isFcg && <FcgChip />}
              </div>
              <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2 }}>{p.meta}</div>
            </div>
            <button onClick={(e) => { e.stopPropagation(); onDec(p.id); }} style={{
              width: 44, height: 44, borderRadius: 8, border: '1px solid rgba(233,233,237,.16)', background: 'transparent',
              color: T.textSecondary, fontSize: 18, cursor: 'pointer', flex: 'none',
            }}>\u2212</button>
            <div style={{ width: 30, textAlign: 'center', fontSize: 21, fontWeight: 500, color: on ? T.accentLight : T.placeholder }}>{p.qty}</div>
            <button onClick={(e) => { e.stopPropagation(); onInc(p.id); }} style={{
              width: 44, height: 44, borderRadius: 8, border: `1px solid ${T.accent}`, background: 'rgba(145,132,217,.12)',
              color: T.accentLight, fontSize: 18, cursor: 'pointer', flex: 'none',
            }}>+</button>
          </div>
        );
      })}

      <div style={{ height: 8 }} />
      <FilledButton onClick={onFinish}>{finishLabel}</FilledButton>
    </div>
  );
}

function RecountScreen({ sites, recount, pickVenue, rows, recountInput, onSave, onBack }) {
  return (
    <div>
      <button onClick={onBack} style={{ background: 'none', border: 'none', color: T.textSecondary, fontSize: 13.5, display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', marginBottom: 10, padding: 0 }}>
        <i className="ph ph-arrow-left" /> Stock
      </button>
      <div style={{ fontSize: 21, fontWeight: 500, marginBottom: 12 }}>Recount</div>
      <SegmentedTabs options={sites.map(v => ({
        name: v.name, pick: () => pickVenue(v.id),
        edge: recount.venue === v.id ? T.accent : 'transparent',
        bg: recount.venue === v.id ? 'rgba(145,132,217,.12)' : 'transparent',
        tone: recount.venue === v.id ? T.accentLight : T.textSecondary,
      }))} />
      {rows.map(r => (
        <div key={r.id} style={{ background: T.card, border: '1px solid rgba(233,233,237,.09)', borderRadius: 8, padding: 13, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14.5, fontWeight: 500 }}>{r.name}</div>
            <div style={{ fontSize: 11, color: T.textMuted, marginTop: 2 }}>on system: {r.current}</div>
          </div>
          <input
            data-pid={r.id}
            defaultValue=""
            placeholder={String(r.current)}
            inputMode="numeric"
            onChange={(e) => { recountInput.current[r.id] = e.target.value; }}
            style={{ width: 82, textAlign: 'right', padding: '10px 10px', borderRadius: 8, border: '1px solid rgba(233,233,237,.16)', background: T.ground, color: T.text, fontSize: 16 }}
          />
        </div>
      ))}
      <div style={{ height: 8 }} />
      <FilledButton onClick={onSave}>Save recount</FilledButton>
    </div>
  );
}

function DeliveriesScreen({ deliveries, venueName, fmt, noDeliveries, onNewDelivery, onOpen }) {
  return (
    <div>
      <div style={{ fontSize: 26, fontWeight: 500, letterSpacing: '-.02em', marginBottom: 14 }}>Back of house</div>
      <div style={{ marginBottom: 14 }}>
        <OutlineButton icon="ph-plus" onClick={onNewDelivery}>Log delivery</OutlineButton>
      </div>
      {noDeliveries && <EmptyState title="No deliveries yet" body="Log one when stock arrives from a supplier." />}
      {deliveries.map(d => (
        <div key={d.id} onClick={() => onOpen(d.id)} style={{
          background: T.card, border: '1px solid rgba(233,233,237,.09)', borderRadius: 8, padding: 13, marginBottom: 8,
          display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer',
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 500 }}>{d.supplier}</div>
            <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2 }}>
              {fmt(d.date)} \u00b7 {venueName(d.venue)}{d.reference ? ' \u00b7 ' + d.reference : ''} \u00b7 {Object.keys(d.items).length} lines
            </div>
          </div>
          {d.hasPhoto && <i className="ph ph-paperclip" style={{ color: T.textMuted }} />}
          <i className="ph ph-caret-right" style={{ color: T.textMuted }} />
        </div>
      ))}
    </div>
  );
}

function HistoryScreen({ items, onToggle }) {
  return (
    <div>
      <div style={{ fontSize: 26, fontWeight: 500, letterSpacing: '-.02em', marginBottom: 14 }}>History</div>
      {items.length === 0 && <EmptyState title="Nothing here yet" body="Completed sessions and recounts will show up here." />}
      {items.map(it => (
        <div key={it.id} style={{ background: T.card, border: '1px solid rgba(233,233,237,.09)', borderRadius: 8, marginBottom: 8, overflow: 'hidden' }}>
          <div onClick={() => onToggle(it.id)} style={{ padding: 13, display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 500 }}>{it.title}</div>
              <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2 }}>{it.meta}</div>
            </div>
            {it.flagged && <span style={{ fontSize: 10.5, fontWeight: 500, color: T.warn, border: `1px solid ${T.warn}`, borderRadius: 20, padding: '4px 9px' }}>Variance</span>}
            <i className={`ph ${it.open ? 'ph-caret-up' : 'ph-caret-down'}`} style={{ color: T.textMuted }} />
          </div>
          {it.open && (
            <div style={{ padding: '0 13px 13px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 52px 52px 52px', gap: 4, fontSize: 10, fontWeight: 500, textTransform: 'uppercase', color: T.textMuted, marginBottom: 6 }}>
                <span>Product</span><span style={{ textAlign: 'right' }}>{it.col1}</span><span style={{ textAlign: 'right' }}>{it.col2}</span><span style={{ textAlign: 'right' }}>{it.col3}</span>
              </div>
              {it.rows.map((r, i) => (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 52px 52px 52px', gap: 4, fontSize: 13, padding: '5px 0', color: r.tone }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: T.text }}>{r.name}</span>
                  <span style={{ textAlign: 'right' }}>{r.a}</span><span style={{ textAlign: 'right' }}>{r.b}</span><span style={{ textAlign: 'right' }}>{r.c}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function ProductsScreen({ search, onSearch, productList, onNewProduct, onEdit, onDelete, loading, error }) {
  return (
    <div>
      <div style={{ fontSize: 26, fontWeight: 500, letterSpacing: '-.02em', marginBottom: 14 }}>Range</div>
      {error && (
        <div style={{ background: 'rgba(224,117,102,.1)', border: `1px solid ${T.danger}`, borderRadius: 8, padding: 12, marginBottom: 14, fontSize: 13, color: T.danger }}>
          Couldn't reach the database: {error}
        </div>
      )}
      <input value={search} onChange={(e) => onSearch(e.target.value)} placeholder="Search products" style={{ ...inputStyle, marginBottom: 10 }} />
      <div style={{ marginBottom: 14 }}>
        <OutlineButton icon="ph-plus" onClick={onNewProduct}>Add product</OutlineButton>
      </div>
      {loading && <div style={{ fontSize: 13, color: T.textMuted, padding: '8px 0' }}>Loading products\u2026</div>}
      {!loading && !error && productList.length === 0 && <EmptyState title="No products found" body="Try a different search, or add a new product." />}
      {productList.map(p => (
        <div key={p.id} onClick={() => onEdit(p.id)} style={{
          background: T.card, border: '1px solid rgba(233,233,237,.09)', borderRadius: 8, padding: 13, marginBottom: 8,
          display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer',
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 500 }}>{p.name}</div>
            <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2 }}>
              {(p.owner === 'fcg' ? 'FCG \u00b7 ' : '') + p.category + ' \u00b7 ' + p.unit + (p.barcode ? ' \u00b7 ' + p.barcode : ' \u00b7 no barcode')}
            </div>
          </div>
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(p.id); }}
            style={{
              width: 40, height: 40, borderRadius: 8, border: 'none', background: 'transparent',
              color: T.textMuted, cursor: 'pointer', fontSize: 17, flex: 'none',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          ><i className="ph ph-trash" /></button>
          <i className="ph ph-pencil-simple" style={{ color: T.textMuted }} />
        </div>
      ))}
    </div>
  );
}

function TransfersScreen({ transferMonth, transferSummaries, onSummaryClick, filterChips, transferFilter, setTransferFilter, transferList, noTransfers, onToggle, onNewTransfer }) {
  return (
    <div>
      <div style={{ fontSize: 26, fontWeight: 500, letterSpacing: '-.02em', marginBottom: 4 }}>Transfers</div>
      <div style={{ marginBottom: 14 }}>
        <OutlineButton icon="ph-plus" onClick={onNewTransfer}>New transfer</OutlineButton>
      </div>

      <div style={{ fontSize: 11, fontWeight: 500, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 8 }}>{transferMonth} \u2014 to invoice</div>
      {transferSummaries.map((s, i) => (
        <div key={i} onClick={() => onSummaryClick(s.id)} style={{
          background: T.card, border: `1px solid ${s.edge}`, borderRadius: 8, padding: 13, marginBottom: 8,
          display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer',
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 500 }}>{s.name}</div>
            <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2 }}>{s.meta}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 22, fontWeight: 500, color: T.accentLight }}>{s.units}</div>
            <div style={{ fontSize: 9.5, fontWeight: 500, textTransform: 'uppercase', color: T.textMuted }}>units</div>
            {s.hasFcg && <div style={{ fontSize: 11, color: T.textDim, marginTop: 2 }}>{s.fcgLabel}</div>}
          </div>
        </div>
      ))}

      <div style={{ display: 'flex', gap: 8, overflowX: 'auto', margin: '18px 0 12px' }}>
        {filterChips.map(v => (
          <button key={v.id} onClick={() => setTransferFilter(v.id)} style={{
            flex: 'none', padding: '10px 14px', borderRadius: 20, minHeight: 44,
            border: `1px solid ${transferFilter === v.id ? T.accent : 'rgba(233,233,237,.16)'}`,
            background: transferFilter === v.id ? 'rgba(145,132,217,.12)' : 'transparent',
            color: transferFilter === v.id ? T.accentLight : T.textSecondary, fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap',
          }}>{v.name}</button>
        ))}
      </div>

      {noTransfers && <EmptyState title="No transfers" body="Nothing recorded for this filter yet." />}
      {transferList.map(t => (
        <div key={t.id} style={{ background: T.card, border: '1px solid rgba(233,233,237,.09)', borderRadius: 8, marginBottom: 8, overflow: 'hidden' }}>
          <div onClick={() => onToggle(t.id)} style={{ padding: 13, display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
            <i className="ph ph-arrow-right" style={{ color: T.accent }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 500 }}>{t.site}</div>
              <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2 }}>{t.meta}</div>
            </div>
            {t.hasFcg && <span style={{ fontSize: 10.5, fontWeight: 500, color: T.accentLight, background: 'rgba(145,132,217,.14)', borderRadius: 20, padding: '4px 9px' }}>{t.fcgTag}</span>}
            <i className={`ph ${t.open ? 'ph-caret-up' : 'ph-caret-down'}`} style={{ color: T.textMuted }} />
          </div>
          {t.open && (
            <div style={{ padding: '0 13px 13px' }}>
              {t.rows.map((r, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', fontSize: 13.5 }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>{r.name}{r.isFcg && <FcgChip />}</span>
                  <span style={{ color: T.accentLight }}>{r.qty}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function MoreScreen({ productCountLabel, onGoProducts, sites, STORE, onRemoveSite, siteRef, onAddSite, summaryOn, onToggleSummary, recipients, onRemoveRecipient, emailRef, onAddRecipient }) {
  return (
    <div>
      <div style={{ fontSize: 26, fontWeight: 500, letterSpacing: '-.02em', marginBottom: 16 }}>More</div>

      <div onClick={onGoProducts} style={{
        background: T.card, border: '1px solid rgba(233,233,237,.09)', borderRadius: 8, padding: 14, marginBottom: 20,
        display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer',
      }}>
        <i className="ph ph-package" style={{ fontSize: 20, color: T.accent }} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 500 }}>Product range</div>
          <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2 }}>{productCountLabel}</div>
        </div>
        <i className="ph ph-caret-right" style={{ color: T.textMuted }} />
      </div>

      <div style={{ fontSize: 12, fontWeight: 500, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 8 }}>Sites</div>
      {sites.map(v => (
        <div key={v.id} style={{ background: T.card, border: '1px solid rgba(233,233,237,.09)', borderRadius: 8, padding: 13, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14.5, fontWeight: 500 }}>{v.name}</div>
            <div style={{ fontSize: 11.5, color: T.textMuted, marginTop: 2 }}>{v.id === STORE ? 'Store \u2014 stock is held here' : 'Site \u2014 receives transfers'}</div>
          </div>
          {v.id !== STORE && (
            <button onClick={() => onRemoveSite(v.id)} style={{ background: 'none', border: 'none', color: T.textMuted, cursor: 'pointer', fontSize: 17 }}>
              <i className="ph ph-trash" />
            </button>
          )}
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
        <input ref={siteRef} placeholder="New site name" style={{ ...inputStyle, flex: 1 }} onKeyDown={(e) => { if (e.key === 'Enter') onAddSite(); }} />
        <button onClick={onAddSite} style={{ padding: '0 16px', borderRadius: 8, border: '1px solid rgba(233,233,237,.16)', background: 'transparent', color: T.text, cursor: 'pointer' }}>Add</button>
      </div>

      <div style={{ fontSize: 12, fontWeight: 500, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 8 }}>Monthly transfer summary</div>
      <div style={{ background: T.card, border: '1px solid rgba(233,233,237,.09)', borderRadius: 8, padding: 13 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <div style={{ flex: 1, fontSize: 14, fontWeight: 500 }}>Send on the 1st</div>
          <button onClick={onToggleSummary} style={{
            padding: '6px 14px', borderRadius: 20,
            border: `1px solid ${summaryOn ? T.accent : 'rgba(233,233,237,.16)'}`,
            background: summaryOn ? 'rgba(145,132,217,.12)' : 'transparent',
            color: summaryOn ? T.accentLight : T.textSecondary, fontSize: 12.5, cursor: 'pointer',
          }}>{summaryOn ? 'On' : 'Off'}</button>
        </div>
        <div style={{ fontSize: 12, color: T.textMuted, lineHeight: 1.5, marginBottom: summaryOn ? 12 : 0 }}>
          A per-site breakdown of the previous month's transfers, split into your stock and Fizzy Cherry's, for invoicing.
        </div>
        {summaryOn && (
          <>
            {recipients.length === 0 && <div style={{ fontSize: 12.5, color: T.textMuted, marginBottom: 10 }}>No recipients yet.</div>}
            {recipients.map(r => (
              <div key={r} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0' }}>
                <span style={{ flex: 1, fontSize: 13.5 }}>{r}</span>
                <button onClick={() => onRemoveRecipient(r)} style={{ background: 'none', border: 'none', color: T.textMuted, cursor: 'pointer' }}><i className="ph ph-x" /></button>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <input ref={emailRef} placeholder="name@site.com" style={{ ...inputStyle, flex: 1 }} onKeyDown={(e) => { if (e.key === 'Enter') onAddRecipient(); }} />
              <button onClick={onAddRecipient} style={{ padding: '0 16px', borderRadius: 8, border: '1px solid rgba(233,233,237,.16)', background: 'transparent', color: T.text, cursor: 'pointer' }}>Add</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
