import { useEffect, useRef, useState } from 'react';
import { createWorker } from 'tesseract.js';
import { T, CATEGORIES, UNITS, CASE_SIZES, DEFAULT_SITES, STORE, MONTHS, plural, fmt, monthKey, stockAt } from './constants';
import { Toast, EmptyState, OutlineButton, FilledButton, SegmentedTabs, FieldLabel, inputStyle, ErrorText } from './components/Primitives';
import { Header, Banner, TabBar } from './components/Chrome';
import { Sheet } from './components/Sheet';
import { supabase } from './supabaseClient';

// Supabase's products table uses snake_case columns; the rest of the app
// (still working from in-memory prototype shape) uses camelCase.
function productFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    unit: row.unit,
    owner: row.owner,
    barcode: row.barcode,
    parLevel: row.par_level,
    caseSize: row.case_size || null,
    stock: row.stock || {},
    unsplitStock: row.unsplit_stock || {},
  };
}

// Free, on-device invoice reading: Tesseract gives us raw text, then this
// picks out "quantity + product name" from each line by trying a few common
// invoice layouts. It's a heuristic, not a guarantee — the review/edit step
// further down the delivery flow is what catches what this gets wrong.
const INVOICE_NOISE = /total|subtotal|vat|tax\b|invoice|delivery note|order no|account|balance|page \d/i;

// A cheap plausibility check for a "product name" pulled off a noisy OCR
// line - real names are made of actual words; garbled OCR tends to produce
// currency figures, vowel-less letter fragments, or mostly-punctuation junk.
function looksLikeNoise(name) {
  if (/[£$€¢¥]/.test(name)) return true;
  if (/\d+\.\d{1,2}(?!\d)/.test(name)) return true;
  const letters = (name.match(/[a-zA-Z]/g) || []).length;
  const nonSpace = name.replace(/\s+/g, '').length;
  if (!nonSpace || letters / nonSpace < 0.6 || letters < 4) return true;
  // Split on whitespace/punctuation only (not digits) - "330ml" should stay
  // one token, since digit-bearing tokens (sizes/units) are almost always
  // legitimate even without a vowel, unlike bare letter fragments like "Tr".
  const words = name.split(/[\s(),.:;!?[\]{}'"-]+/).filter(w => w.length >= 2);
  if (!words.length) return true;
  const noVowelWords = words.filter(w => !/[aeiou]/i.test(w) && !/\d/.test(w));
  return noVowelWords.length / words.length >= 0.4;
}

function parseInvoiceLines(text) {
  const out = [];
  text.split('\n').map(l => l.trim()).filter(Boolean).forEach(line => {
    if (INVOICE_NOISE.test(line)) return;
    let m;
    if ((m = line.match(/^(\d{1,4})\s*[x×]\s*(.{2,})$/i))
      || (m = line.match(/^(.{2,}?)\s*[x×]\s*(\d{1,4})$/i))) {
      const [, a, b] = m;
      const qtyFirst = /^\d+$/.test(a);
      out.push({ name: (qtyFirst ? b : a).trim(), quantity: Number(qtyFirst ? a : b) });
      return;
    }
    if ((m = line.match(/^(\d{1,4})\s+([a-zA-Z].{1,})$/))
      || (m = line.match(/^([a-zA-Z].{1,}?)\s+(\d{1,4})$/))) {
      const [, a, b] = m;
      const qtyFirst = /^\d+$/.test(a);
      out.push({ name: (qtyFirst ? b : a).trim(), quantity: Number(qtyFirst ? a : b) });
    }
  });
  return out.filter(l => l.name.length > 1 && l.quantity > 0 && l.quantity < 10000 && !looksLikeNoise(l.name));
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
  const [dismissedLowKey, setDismissedLowKey] = useState('');
  const [invoiceReading, setInvoiceReading] = useState(false);
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
  const [activityLog, setActivityLog] = useState([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState('');

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

  // Total stock across every site, compared against each product's par
  // level — this is the "time to reorder" signal, so it's checked
  // business-wide rather than per-venue. Re-shows the banner whenever the
  // set of low products changes, but stays dismissed otherwise.
  const belowPar = products.filter(p => p.parLevel
    && sites.reduce((sum, v) => sum + stockAt(p, v.id), 0) < p.parLevel);
  const belowParKey = belowPar.map(p => p.id).sort().join(',');
  const lowStockBanner = belowPar.length && belowParKey !== dismissedLowKey
    ? (belowPar.length <= 3
      ? 'Time to order: ' + belowPar.map(p => p.name).join(', ')
      : belowPar.length + ' products need ordering — check Products for details')
    : '';

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

  // Managers only — fetches when the Activity screen is opened.
  useEffect(() => {
    if (view !== 'activity' || !session || !profile || profile.role !== 'manager') return;
    let cancelled = false;
    async function load() {
      setActivityLoading(true);
      const { data, error } = await supabase.from('activity_log').select('*').order('created_at', { ascending: false }).limit(100);
      if (cancelled) return;
      if (error) { setActivityError(error.message); setActivityLoading(false); return; }
      setActivityLog(data || []);
      setActivityError('');
      setActivityLoading(false);
    }
    load();
    return () => { cancelled = true; };
  }, [view, session, profile]);

  const nameRef = useRef(null);
  const catRef = useRef(null);
  const unitRef = useRef(null);
  const amountRef = useRef(null);
  const caseAmountRef = useRef(null);
  const caseSizeRef = useRef(null);
  const parRef = useRef(null);
  const codeRef = useRef(null);
  const siteRef = useRef(null);
  const emailRef = useRef(null);
  const cancelReasonRef = useRef(null);
  const invoicePhotoRef = useRef(null);
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
  function startScan() {
    setScan({}); setScanStatus('Point the camera at a barcode');
    scanTimer.current = setInterval(simulateHit, 2300);
  }
  function stopScan() { if (scanTimer.current) clearInterval(scanTimer.current); scanTimer.current = null; }
  function closeScan() { stopScan(); setScan(null); }
  function simulateHit() {
    setProducts(curProducts => {
      setScan(curScan => {
        if (!curScan) return curScan;
        const pool = curProducts.filter(p => p.barcode);
        if (!pool.length) { setScanStatus('No barcodes on file yet'); return curScan; }
        const p = pool[Math.floor(Math.random() * pool.length)];
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
    const p = products.find(x => x.barcode === val);
    if (p) { bump(p.id, 1); setScanStatus('\u2713 ' + p.name + '  +1'); }
    else setScanStatus('No product carries ' + val);
    if (codeRef.current) codeRef.current.value = '';
  }

  // ---- counting ----
  function takeCap(c, pid, kind) {
    // Loading a session out or transferring stock takes it away from a
    // venue/the container, so those can't count more than is actually there.
    // Deliveries and returning a session bring stock in, so no cap applies.
    if (c.mode !== 'out' && c.mode !== 'transfer') return Infinity;
    const p = products.find(x => x.id === pid);
    if (!p) return Infinity;
    const venue = c.mode === 'out' ? (sessions.find(x => x.id === c.sessionId) || {}).venue : STORE;
    if (!venue) return Infinity;
    return kind === 'case' ? ((p.unsplitStock && p.unsplitStock[venue]) || 0) : stockAt(p, venue);
  }
  function bump(pid, delta, kind) {
    setCount(c => {
      if (!c) return c;
      const cap = delta > 0 ? takeCap(c, pid, kind) : Infinity;
      if (kind === 'case') {
        const caseCounts = { ...(c.caseCounts || {}) };
        const next = Math.max(0, (caseCounts[pid] || 0) + delta);
        if (next > cap) { toast("That's all the cases there are"); return c; }
        caseCounts[pid] = next;
        return { ...c, caseCounts };
      }
      const counts = { ...c.counts };
      const next = Math.max(0, (counts[pid] || 0) + delta);
      if (next > cap) { toast("That's all the stock there is"); return c; }
      counts[pid] = next;
      return { ...c, counts };
    });
  }
  function openCount(mode, sessionId) {
    if (mode === 'delivery') {
      setCount({ mode, counts: { ...((draft && draft.items) || {}) }, caseCounts: { ...((draft && draft.caseItems) || {}) }, review: (draft && draft.review) || [], added: (draft && draft.added) || [] });
      setSheet(null); setView('count');
      return;
    }
    if (mode === 'transfer') {
      setCount({ mode, counts: {}, caseCounts: {}, review: [], added: [] });
      setSheet(null); setView('count');
      return;
    }
    const ses = sessions.find(x => x.id === sessionId);
    setCount({
      mode, sessionId,
      counts: { ...(mode === 'out' ? ses.out : ses.back) },
      caseCounts: { ...(mode === 'out' ? (ses.outCases || {}) : (ses.backCases || {})) },
      review: [], added: [],
    });
    setSheet(null); setView('count');
  }
  function finishCount() {
    const c = count;
    if (!c) return;
    if (c.review && c.review.length) { toast('Resolve the review item first'); return; }
    const nextProducts = products.map(p => ({ ...p, stock: { ...p.stock }, unsplitStock: { ...p.unsplitStock } }));
    const apply = (venue, sign) => nextProducts.forEach(p => {
      const q = c.counts[p.id] || 0;
      if (q) {
        p.stock[venue] = Math.max(0, (p.stock[venue] || 0) + sign * q);
        supabase.rpc('update_stock', { p_product_id: p.id, p_site_id: venue, p_delta: sign * q })
          .then(({ error }) => { if (error) toast("Couldn't save stock change: " + error.message); });
      }
    });
    const applyCases = (venue, sign) => nextProducts.forEach(p => {
      const q = (c.caseCounts && c.caseCounts[p.id]) || 0;
      if (q) {
        p.unsplitStock[venue] = Math.max(0, (p.unsplitStock[venue] || 0) + sign * q);
        supabase.rpc('update_unsplit_stock', { p_product_id: p.id, p_site_id: venue, p_delta: sign * q })
          .then(({ error }) => { if (error) toast("Couldn't save case stock change: " + error.message); });
      }
    });

    if (c.mode === 'transfer') {
      const d = draft || {};
      const anyCounted = Object.keys(c.counts).some(k => c.counts[k] > 0) || Object.keys(c.caseCounts || {}).some(k => c.caseCounts[k] > 0);
      if (!anyCounted) { toast('Nothing counted yet'); return; }
      apply(STORE, -1); applyCases(STORE, -1);
      const rec = { id: 't' + Date.now(), date: new Date().toISOString().slice(0, 10), site: d.site, note: d.note || '', items: { ...c.counts }, caseItems: { ...(c.caseCounts || {}) } };
      setProducts(nextProducts);
      setTransfers(t => [rec, ...t]);
      setCount(null); setDraft(null); setView('transfers');
      setOpenTransfers(o => ({ ...o, [rec.id]: true }));
      toast('Transferred to ' + venueName(d.site));
      return;
    }

    if (c.mode === 'delivery') {
      const d = draft || { supplier: 'Delivery', venue: 'lc', date: new Date().toISOString().slice(0, 10) };
      apply(d.venue, 1); applyCases(d.venue, 1);
      const rec = { id: 'd' + Date.now(), supplier: d.supplier, reference: d.reference || '', date: d.date, venue: d.venue, hasPhoto: !!d.hasPhoto, items: { ...c.counts }, caseItems: { ...(c.caseCounts || {}) } };
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
      ses.outCases = { ...(c.caseCounts || {}) };
      ses.status = 'out';
      apply(ses.venue, -1); applyCases(ses.venue, -1);
      setProducts(nextProducts); setSessions(nextSessions); setCount(null);
      setView('sessionDetail'); setActiveSessionId(ses.id);
      toast('Container is out');
      const items = itemsFromCounts(c.counts, c.caseCounts, products);
      logActivity('Loaded out', ses.name + ' \u2014 ' + summarizeItems(items),
        { sessionId: ses.id, session: ses.name, venue: venueName(ses.venue), mode: 'out', items });
    } else {
      ses.back = { ...c.counts };
      ses.backCases = { ...(c.caseCounts || {}) };
      ses.status = 'complete';
      ses.completedAt = new Date().toISOString();
      apply(ses.venue, 1); applyCases(ses.venue, 1);
      setProducts(nextProducts); setSessions(nextSessions); setCount(null); setActiveSessionId(null);
      setView(role === 'admin' ? 'history' : 'sessions');
      setOpenHistory(o => ({ ...o, [ses.id]: true }));
      toast('Session complete');
      const items = itemsFromCounts(c.counts, c.caseCounts, products);
      logActivity('Returned', ses.name + ' \u2014 ' + summarizeItems(items),
        { sessionId: ses.id, session: ses.name, venue: venueName(ses.venue), mode: 'back', items });
    }
  }

  // ---- invoice auto-read (the one bit of "real logic") ----
  async function autoRead(lines, emptyMessage) {
    if (!lines || !lines.length) {
      setDraft(d => ({ ...d, hasPhoto: true, items: {}, review: [], added: [] }));
      setSheet(null); setView('count'); setPhotoTaken(true);
      setCount({ mode: 'delivery', counts: {}, review: [], added: [] });
      toast(emptyMessage || 'Nothing read — count by hand');
      return;
    }
    const norm = n => n.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const tokens = n => norm(n).split(' ').filter(Boolean);
    const items = {}; const review = [];
    const nextProducts = products.slice(); let matched = 0;

    // Nothing gets created automatically anymore - a noisy OCR read can
    // produce text that looks plausible enough to pass any text heuristic,
    // so every unmatched line goes to manual review instead of being
    // silently inserted as a new product.
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
      review.push({
        id: 'rv' + review.length, name: line.name, quantity: line.quantity,
        candidateId: best && bestScore >= 0.34 ? best.id : null,
        candidateName: best && bestScore >= 0.34 ? best.name : null,
      });
    });

    setDraft(d => ({ ...d, hasPhoto: true, items, review, added: [] }));
    setSheet(null); setView('count'); setPhotoTaken(true);
    setCount({ mode: 'delivery', counts: items, review, added: [] });
    const parts = ['Matched ' + matched];
    if (review.length) parts.push(review.length + ' to review');
    toast(parts.join(' \u00b7 '));
  }

  async function resolveReview(id, action) {
    const item = count && (count.review || []).find(r => r.id === id);
    if (!item) return;
    if (action === 'discard') {
      setCount(c => (c ? { ...c, review: c.review.filter(r => r.id !== id) } : c));
      toast('Discarded');
      return;
    }
    if (action === 'new') {
      const { data: row, error } = await supabase.from('products')
        .insert({ name: item.name, category: 'Other', unit: 'Bottle' })
        .select().single();
      if (error) { toast("Couldn't add that product: " + error.message); return; }
      const np = productFromRow(row);
      setProducts(ps => ps.concat([np]));
      setCount(c => {
        if (!c) return c;
        const counts = { ...c.counts, [np.id]: (c.counts[np.id] || 0) + item.quantity };
        return { ...c, counts, added: (c.added || []).concat([np.name]), review: c.review.filter(r => r.id !== id) };
      });
    } else {
      setCount(c => {
        if (!c) return c;
        const counts = { ...c.counts, [item.candidateId]: (c.counts[item.candidateId] || 0) + item.quantity };
        return { ...c, counts, review: c.review.filter(r => r.id !== id) };
      });
    }
    toast(action === 'new' ? 'Added as a new product' : 'Merged into the existing product');
  }

  function saveRecount() {
    const venue = recount.venue;
    const changes = [];
    const nextProducts = products.map(p => {
      const raw = recountInput.current[p.id];
      if (raw === undefined || raw === '') return p;
      const after = Number(raw) || 0;
      const before = stockAt(p, venue);
      if (after !== before) {
        changes.push({ name: p.name, before, after, variance: after - before });
        supabase.rpc('set_stock', { p_product_id: p.id, p_site_id: venue, p_quantity: after })
          .then(({ error }) => { if (error) toast("Couldn't save recount: " + error.message); });
      }
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
        const unsplitQty = (p.unsplitStock && p.unsplitStock[sv]) || 0;
        const low = p.parLevel && qty < p.parLevel;
        return {
          id: p.id, name: p.name, qty,
          meta: p.unit + (p.parLevel ? ' \u00b7 par ' + p.parLevel : '') + (unsplitQty ? ' \u00b7 +' + unsplitQty + ' unsplit case' + (unsplitQty === 1 ? '' : 's') : ''),
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
        { label: 'Relish stock', note: plural(houseProducts.length, 'product'), showHeader: true, groups: groupsFor(houseProducts) },
        { label: 'Fizzy Cherry (FCG)', note: 'invoiced separately when transferred', showHeader: true, groups: groupsFor(fcgProducts) },
      ].filter(x => x.groups.length)
    : [{ label: '', note: '', showHeader: false, groups: groupsFor(products) }];
  let statLow = 0;
  products.forEach(p => { if (p.parLevel && stockAt(p, sv) < p.parLevel) statLow++; });

  const c = count;
  const ses = c && c.sessionId ? sessions.find(x => x.id === c.sessionId) : null;
  const countTiles = !c ? [] : products.map(p => {
    const qty = (c.counts && c.counts[p.id]) || 0;
    const caseQty = (c.caseCounts && c.caseCounts[p.id]) || 0;
    let meta = p.unit;
    if (c.mode === 'out' && ses) {
      const availCases = (p.unsplitStock && p.unsplitStock[ses.venue]) || 0;
      meta = p.unit + ' \u00b7 available ' + stockAt(p, ses.venue) + (p.caseSize ? ' + ' + availCases + ' case' + (availCases === 1 ? '' : 's') : '');
    }
    if (c.mode === 'back' && ses) {
      meta = 'went out: ' + (ses.out[p.id] || 0) + (p.caseSize ? ' + ' + ((ses.outCases && ses.outCases[p.id]) || 0) + ' cases' : '');
    }
    if (c.mode === 'transfer') meta = p.unit + ' \u00b7 in container ' + stockAt(p, STORE);
    return { id: p.id, name: p.name, meta, qty, caseQty, hasCase: !!p.caseSize, caseSize: p.caseSize, isFcg: p.owner === 'fcg' };
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
      if (caseSizeRef.current) caseSizeRef.current.value = editingProduct.caseSize || '';
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
      || (key === 'stock' && (effectiveView === 'recount' || effectiveView === 'siteStock'))
      || (key === 'more' && (effectiveView === 'products' || effectiveView === 'activity'))
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

  // Best-effort: never let a logging failure block the actual action.
  async function logActivity(action, detail, metadata) {
    if (!session) return;
    const actorLabel = (profile && profile.full_name) || session.user.email || 'Unknown';
    try {
      await supabase.from('activity_log').insert({
        actor_id: session.user.id, actor_label: actorLabel, action, detail: detail || null, metadata: metadata || null,
      });
    } catch { /* logging is non-critical */ }
  }

  function itemsFromCounts(counts, caseCounts, prods) {
    const ids = new Set([...Object.keys(counts), ...Object.keys(caseCounts || {})]);
    return Array.from(ids).filter(k => (counts[k] || 0) > 0 || ((caseCounts && caseCounts[k]) || 0) > 0).map(k => {
      const p = prods.find(x => x.id === k);
      return { name: p ? p.name : 'Removed product', qty: counts[k] || 0, caseQty: (caseCounts && caseCounts[k]) || 0 };
    });
  }
  function summarizeItem(i) {
    const parts = [];
    if (i.caseQty) parts.push(i.caseQty + ' case' + (i.caseQty === 1 ? '' : 's'));
    if (i.qty) parts.push(i.qty + ' individual');
    return i.name + ' (' + parts.join(', ') + ')';
  }
  function summarizeItems(items) {
    if (!items.length) return 'nothing';
    return items.slice(0, 3).map(summarizeItem).join(', ') + (items.length > 3 ? ' +' + (items.length - 3) + ' more' : '');
  }

  async function deleteProduct(id) {
    const target = products.find(p => p.id === id);
    const { error } = await supabase.from('products').delete().eq('id', id);
    if (error) { toast("Couldn't delete: " + error.message); return; }
    setProducts(ps => ps.filter(p => p.id !== id));
    setSheet(null);
    toast('Product deleted');
    logActivity('Deleted product', target ? target.name : null);
  }

  function cancelSession(id) {
    const reason = cancelReasonRef.current ? cancelReasonRef.current.value.trim() : '';
    if (!reason) { setSheetError('Give a reason for cancelling.'); return; }
    const ses = sessions.find(x => x.id === id);
    setSessions(s => s.filter(x => x.id !== id));
    setSheet(null); setView('sessions');
    toast('Session cancelled');
    logActivity('Cancelled session', (ses ? ses.name + ' — ' : '') + reason, { sessionId: id, reason });
  }

  async function onSaveProduct() {
    const name = nameRef.current ? nameRef.current.value.trim() : '';
    if (!name) { setSheetError('Give the product a name.'); return; }
    const cat = catRef.current ? catRef.current.value : 'Other';
    const unit = unitRef.current ? unitRef.current.value : 'Bottle';
    const parRaw = parRef.current ? parRef.current.value.trim() : '';
    const par = parRaw ? Number(parRaw) : null;
    const owner = productOwner === 'fcg' ? 'fcg' : 'house';
    const caseSizeRaw = caseSizeRef.current ? caseSizeRef.current.value : '';
    const caseSize = caseSizeRaw ? Number(caseSizeRaw) : null;
    const row = { name, category: cat, unit, owner, par_level: par, case_size: caseSize };

    if (editingProduct) {
      const { data, error } = await supabase.from('products').update(row).eq('id', editingProduct.id).select().single();
      if (error) { setSheetError('Could not save: ' + error.message); return; }
      // keep this session's in-memory stock numbers as they are — editing
      // the product itself doesn't change quantities, Recount does that
      setProducts(products.map(p => p.id === editingProduct.id ? { ...productFromRow(data), stock: p.stock, unsplitStock: p.unsplitStock } : p));
      logActivity('Edited product', name);
    } else {
      const amountRaw = amountRef.current ? amountRef.current.value.trim() : '';
      const amount = amountRaw ? Math.max(0, Number(amountRaw) || 0) : 0;
      const caseAmountRaw = caseAmountRef.current ? caseAmountRef.current.value.trim() : '';
      const caseAmount = caseAmountRaw ? Math.max(0, Number(caseAmountRaw) || 0) : 0;
      row.stock = amount ? { [STORE]: amount } : {};
      row.unsplit_stock = (caseSize && caseAmount) ? { [STORE]: caseAmount } : {};
      const { data, error } = await supabase.from('products').insert(row).select().single();
      if (error) { setSheetError('Could not save: ' + error.message); return; }
      const created = productFromRow(data);
      setProducts(products.concat([created]));
      const parts = [];
      if (caseSize && caseAmount) parts.push(caseAmount + ' case' + (caseAmount === 1 ? '' : 's'));
      if (amount) parts.push(amount + ' ' + unit.toLowerCase());
      logActivity('Added product', name + (parts.length ? ' \u2014 ' + parts.join(', ') : ''));
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
  function onAutoReadLabelClick(e) {
    // The label's native click opens the camera directly, which iOS Safari
    // requires (a JS-triggered .click() on a hidden input is unreliable
    // there) - so validation has to cancel that default action instead of
    // gating it beforehand.
    if (invoiceReading) { e.preventDefault(); return; }
    const name = nameRef.current ? nameRef.current.value.trim() : '';
    if (!name) { e.preventDefault(); setSheetError('Add the supplier first.'); return; }
    setDraft(d => ({ ...d, supplier: name, date: new Date().toISOString().slice(0, 10) }));
  }
  async function onInvoicePhotoChosen(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    setInvoiceReading(true);
    try {
      const worker = await createWorker('eng');
      const { data } = await worker.recognize(file);
      await worker.terminate();
      const lines = parseInvoiceLines(data.text || '');
      await autoRead(lines, lines.length ? undefined : "Couldn't make out any lines on that invoice — count by hand instead.");
    } catch (err) {
      await autoRead([], "Couldn't read that invoice — " + (err.message || 'try again') + '. Count by hand instead.');
    } finally {
      setInvoiceReading(false);
    }
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
      <Banner text={isAdmin ? lowStockBanner : ''} onDismiss={() => setDismissedLowKey(belowParKey)} />

      <div className="ws-scroll" style={{ flex: 1, overflow: 'auto', padding: '18px 16px 36px' }}>
        {effectiveView === 'stock' && (
          <SitePickerScreen
            sites={sites} products={products} openSessions={openSessions.length}
            onSelectSite={(id) => { setStockVenue(id); go('siteStock'); }}
          />
        )}
        {effectiveView === 'siteStock' && (
          <StockScreen
            sites={sites} sv={sv} stockVenue={stockVenue} setStockVenue={setStockVenue}
            statProducts={products.length} statLow={statLow} statOpen={openSessions.length}
            ownerSections={ownerSections} noProducts={products.length === 0}
            onOpenRecount={() => setView('recount')}
            onGoProducts={() => go('products')}
            stockVenueName={venueName(sv)}
            onBack={() => go('stock')}
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
            reviewItems={(c.review || []).map(r => ({
              ...r,
              merge: () => resolveReview(r.id, 'merge'),
              asNew: () => resolveReview(r.id, 'new'),
              discard: () => resolveReview(r.id, 'discard'),
            }))}
            autoAdded={c.added || []}
            onOpenScan={() => startScan()}
            onInc={(pid) => bump(pid, 1)} onDec={(pid) => bump(pid, -1)}
            onIncCase={(pid) => bump(pid, 1, 'case')} onDecCase={(pid) => bump(pid, -1, 'case')}
            onTapRow={(pid) => bump(pid, 1)}
          />
        )}
        {effectiveView === 'recount' && (
          <RecountScreen
            sites={sites} recount={recount} pickVenue={(id) => setRecount(r => ({ ...r, venue: id }))}
            rows={products.map(p => ({ id: p.id, name: p.name, current: stockAt(p, recount.venue) }))}
            recountInput={recountInput} onSave={saveRecount} onBack={() => setView('siteStock')}
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
            onGoActivity={() => go('activity')}
            sites={sites} STORE={STORE}
            onRemoveSite={(id) => setSites(s => s.filter(x => x.id !== id))}
            siteRef={siteRef} onAddSite={onAddSite}
            summaryOn={summaryOn} onToggleSummary={() => setSummaryOn(v => !v)}
            recipients={recipients} onRemoveRecipient={(email) => setRecipients(r => r.filter(x => x !== email))}
            emailRef={emailRef} onAddRecipient={onAddRecipient}
          />
        )}
        {effectiveView === 'activity' && (
          <ActivityScreen
            items={activityLog} loading={activityLoading} error={activityError}
            onBack={() => go('more')}
          />
        )}
      </div>

      {isAdmin && <TabBar tabs={tabs} />}
      <Toast message={toastMsg} />

      {sheet === 'session' && (
        <Sheet title="New session" onClose={closeSheet} onBackdrop={closeSheet}>
          <FieldLabel>Event name</FieldLabel>
          <input ref={nameRef} placeholder={'Wedding \u2014 The Barn'} style={{ ...inputStyle, marginBottom: 14 }} autoFocus />
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
          <input
            ref={invoicePhotoRef} id="invoice-photo-input" type="file" accept="image/*" capture="environment"
            style={{ position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' }}
            onChange={onInvoicePhotoChosen}
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label
              htmlFor="invoice-photo-input"
              onClick={onAutoReadLabelClick}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                width: '100%', padding: 15, borderRadius: 8, border: `1px solid ${T.accent}`,
                background: 'transparent', color: T.accent, fontSize: 15, fontWeight: 500,
                cursor: invoiceReading ? 'default' : 'pointer', opacity: invoiceReading ? 0.5 : 1,
              }}
            >
              <i className="ph ph-camera" style={{ fontSize: 17 }} />
              {invoiceReading ? 'Reading invoice…' : 'Photograph and auto-read'}
            </label>
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
          <FieldLabel>Sold in cases of</FieldLabel>
          <select ref={caseSizeRef} defaultValue="" style={{ ...inputStyle, marginBottom: 6 }}>
            <option value="">Not sold in cases</option>
            {CASE_SIZES.map(n => <option key={n} value={n}>{n} per case</option>)}
          </select>
          <div style={{ fontSize: 12, color: T.textMuted, marginTop: -4, marginBottom: 16, lineHeight: 1.5 }}>
            If set, this product tracks two pools: whole cases (unsplit) and individual {unitRef.current ? unitRef.current.value.toLowerCase() : 'units'} (split) once a case is opened.
          </div>
          <FieldLabel>Belongs to</FieldLabel>
          <SegmentedTabs options={[
            { id: 'house', name: 'Relish' }, { id: 'fcg', name: 'Fizzy Cherry' },
          ].map(o => ({
            name: o.name, pick: () => setProductOwner(o.id),
            edge: productOwner === o.id ? T.accent : 'transparent',
            bg: productOwner === o.id ? 'rgba(145,132,217,.12)' : 'transparent',
            tone: productOwner === o.id ? T.accentLight : T.textSecondary,
          }))} />
          <div style={{ fontSize: 12, color: T.textMuted, marginTop: -10, marginBottom: 16, lineHeight: 1.5 }}>
            Fizzy Cherry stock sits in the container but is invoiced separately when it moves to a site.
          </div>
          {!editingProduct && (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 8 }}>
                <div>
                  <FieldLabel>{'Starting stock \u2014 cases'}</FieldLabel>
                  <input ref={caseAmountRef} type="number" placeholder="0" style={inputStyle} />
                </div>
                <div>
                  <FieldLabel>{'Starting stock \u2014 individual'}</FieldLabel>
                  <input ref={amountRef} type="number" placeholder="0" style={inputStyle} />
                </div>
              </div>
              <div style={{ fontSize: 12, color: T.textMuted, marginTop: -4, marginBottom: 16, lineHeight: 1.5 }}>
                Both go into the container. Leave cases at 0 if it's not sold that way.
              </div>
            </>
          )}
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
              <div style={{ fontSize: 14, lineHeight: 1.55, color: T.textSecondary, marginBottom: 14 }}>
                Cancel this session? Anything logged so far is discarded and stock goes back as it was.
              </div>
              <FieldLabel>Reason for cancelling</FieldLabel>
              <textarea ref={cancelReasonRef} rows={3} placeholder={'e.g. Event postponed by the client'} style={{ ...inputStyle, marginBottom: 10, resize: 'vertical', fontFamily: 'inherit' }} />
              <ErrorText>{sheetError}</ErrorText>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={closeSheet} style={{ flex: 1, padding: 14, borderRadius: 8, border: '1px solid rgba(233,233,237,.16)', background: 'transparent', color: T.text, cursor: 'pointer' }}>Back</button>
                <button
                  onClick={() => cancelSession(confirmId)}
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
        <input ref={pwRef} type="password" placeholder={'\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'} style={{ ...inputStyle, marginBottom: 14 }} onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
        <ErrorText>{error}</ErrorText>
        <FilledButton onClick={submit} disabled={busy}>{busy ? 'Signing in\u2026' : 'Sign in'}</FilledButton>
        <div style={{ fontSize: 12, color: T.textMuted, textAlign: 'center', marginTop: 16, lineHeight: 1.5 }}>
          {'Accounts are set up by a manager \u2014 ask them if you don\'t have one yet.'}
        </div>
      </div>
    </div>
  );
}


function SitePickerScreen({ sites, products, openSessions, onSelectSite }) {
  return (
    <div>
      <div style={{ fontSize: 26, fontWeight: 500, letterSpacing: '-.02em', marginBottom: 4 }}>Cellar stock</div>
      <div style={{ fontSize: 14, lineHeight: 1.5, color: T.textSecondary, marginBottom: 16 }}>Pick a site to see its stock.</div>
      {sites.map(v => {
        let low = 0;
        products.forEach(p => { if (p.parLevel && stockAt(p, v.id) < p.parLevel) low++; });
        return (
          <div key={v.id} onClick={() => onSelectSite(v.id)} style={{
            background: T.card, border: '1px solid rgba(233,233,237,.09)', borderRadius: 8, padding: 15, marginBottom: 8,
            display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer',
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 16, fontWeight: 500 }}>{v.name}</div>
              <div style={{ fontSize: 12, color: T.textMuted, marginTop: 3 }}>
                {plural(products.length, 'product')}{low ? ' \u00b7 ' + low + ' below par' : ''}
              </div>
            </div>
            <i className="ph ph-caret-right" style={{ color: T.textMuted }} />
          </div>
        );
      })}
    </div>
  );
}

function StockScreen({ sites, sv, setStockVenue, statProducts, statLow, statOpen, ownerSections, noProducts, onOpenRecount, onGoProducts, stockVenueName, onBack }) {
  return (
    <div>
      <button onClick={onBack} style={{ background: 'none', border: 'none', color: T.textSecondary, fontSize: 13.5, display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', marginBottom: 10, padding: 0 }}>
        <i className="ph ph-arrow-left" /> All sites
      </button>
      <div style={{ fontSize: 26, fontWeight: 500, letterSpacing: '-.02em', marginBottom: 4 }}>{stockVenueName}</div>
      <div style={{ fontSize: 14, lineHeight: 1.5, color: T.textSecondary, marginBottom: 14 }}>Live levels here. Updated from deliveries, sessions and recounts.</div>
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

function CountScreen({ title, sub, tiles, finishLabel, onFinish, onBack, reviewItems, autoAdded, onOpenScan, onInc, onDec, onIncCase, onDecCase, onTapRow }) {
  const [expandedId, setExpandedId] = useState(null);
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
          <div style={{ fontSize: 13, fontWeight: 500, color: T.warn, marginBottom: 5 }}>
            {r.candidateName ? 'Needs review \u2014 possible duplicate' : "Needs review \u2014 didn't recognize this"}
          </div>
          <div style={{ fontSize: 14, marginBottom: 4 }}>{r.name} \u00d7 {r.quantity}</div>
          <div style={{ fontSize: 12, color: T.textSecondary, lineHeight: 1.5, marginBottom: 10 }}>
            {r.candidateName
              ? `Similar to "${r.candidateName}", already on the system. Not confident enough to merge on its own.`
              : "Not matched to anything already on the system \u2014 could be a new product, or junk from a bad scan."}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {r.candidateName && (
              <button onClick={r.merge} style={{ flex: 1, padding: 10, borderRadius: 8, border: '1px solid rgba(233,233,237,.16)', background: 'transparent', color: T.text, cursor: 'pointer', fontSize: 13 }}>Same product</button>
            )}
            <button onClick={r.asNew} style={{ flex: 1, padding: 10, borderRadius: 8, border: '1px solid rgba(233,233,237,.16)', background: 'transparent', color: T.text, cursor: 'pointer', fontSize: 13 }}>It's new</button>
            <button onClick={r.discard} style={{ flex: 1, padding: 10, borderRadius: 8, border: '1px solid rgba(233,233,237,.16)', background: 'transparent', color: T.danger, cursor: 'pointer', fontSize: 13 }}>Discard</button>
          </div>
        </div>
      ))}

      {autoAdded.length > 0 && (
        <div style={{ background: T.surface, border: '1px solid rgba(233,233,237,.09)', borderRadius: 8, padding: 13, marginBottom: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 4 }}>Added as new products</div>
          <div style={{ fontSize: 13, color: T.textSecondary }}>{autoAdded.join(', ')}</div>
          <div style={{ fontSize: 11.5, color: T.textMuted, marginTop: 6 }}>Check their category, unit and barcode under Range when you get a moment.</div>
        </div>
      )}

      {tiles.map(p => {
        const on = p.qty > 0 || p.caseQty > 0;

        if (p.hasCase) {
          const expanded = expandedId === p.id;
          return (
            <div key={p.id} style={{
              background: on ? 'rgba(145,132,217,.08)' : T.card,
              border: `1px solid ${on ? 'rgba(145,132,217,.4)' : 'rgba(233,233,237,.09)'}`,
              borderRadius: 8, marginBottom: 8, overflow: 'hidden',
            }}>
              <div
                onClick={() => setExpandedId(expanded ? null : p.id)}
                style={{ padding: 13, display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                    <span style={{ fontSize: 15, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                    {p.isFcg && <FcgChip />}
                  </div>
                  <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2 }}>{p.meta}</div>
                </div>
                <div style={{ fontSize: 13, color: on ? T.accentLight : T.placeholder, textAlign: 'right', flex: 'none' }}>
                  {p.caseQty ? p.caseQty + ' case' + (p.caseQty === 1 ? '' : 's') : ''}
                  {p.caseQty && p.qty ? ' + ' : ''}
                  {p.qty ? p.qty + ' individual' : (!p.caseQty ? '0' : '')}
                </div>
                <i className={`ph ${expanded ? 'ph-caret-up' : 'ph-caret-down'}`} style={{ color: T.textMuted, flex: 'none' }} />
              </div>
              {expanded && (
                <div style={{ padding: '0 13px 13px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontSize: 13, color: T.textSecondary, flex: 1 }}>Cases (of {p.caseSize})</span>
                    <button onClick={() => onDecCase(p.id)} style={{ width: 40, height: 40, borderRadius: 8, border: '1px solid rgba(233,233,237,.16)', background: 'transparent', color: T.textSecondary, fontSize: 17, cursor: 'pointer', flex: 'none' }}>{'\u2212'}</button>
                    <div style={{ width: 26, textAlign: 'center', fontSize: 17, fontWeight: 500, color: p.caseQty ? T.accentLight : T.placeholder }}>{p.caseQty}</div>
                    <button onClick={() => onIncCase(p.id)} style={{ width: 40, height: 40, borderRadius: 8, border: `1px solid ${T.accent}`, background: 'rgba(145,132,217,.12)', color: T.accentLight, fontSize: 17, cursor: 'pointer', flex: 'none' }}>+</button>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontSize: 13, color: T.textSecondary, flex: 1 }}>Individual (split)</span>
                    <button onClick={() => onDec(p.id)} style={{ width: 40, height: 40, borderRadius: 8, border: '1px solid rgba(233,233,237,.16)', background: 'transparent', color: T.textSecondary, fontSize: 17, cursor: 'pointer', flex: 'none' }}>{'\u2212'}</button>
                    <div style={{ width: 26, textAlign: 'center', fontSize: 17, fontWeight: 500, color: p.qty ? T.accentLight : T.placeholder }}>{p.qty}</div>
                    <button onClick={() => onInc(p.id)} style={{ width: 40, height: 40, borderRadius: 8, border: `1px solid ${T.accent}`, background: 'rgba(145,132,217,.12)', color: T.accentLight, fontSize: 17, cursor: 'pointer', flex: 'none' }}>+</button>
                  </div>
                </div>
              )}
            </div>
          );
        }

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
            }}>{'\u2212'}</button>
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
  const byCat = {};
  productList.forEach(p => { (byCat[p.category] = byCat[p.category] || []).push(p); });
  const sections = CATEGORIES.filter(c => byCat[c]).map(cat => ({ cat, items: byCat[cat] }));
  const uncategorized = productList.filter(p => !CATEGORIES.includes(p.category));
  if (uncategorized.length) sections.push({ cat: 'Other', items: uncategorized });

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
      {loading && <div style={{ fontSize: 13, color: T.textMuted, padding: '8px 0' }}>{'Loading products\u2026'}</div>}
      {!loading && !error && productList.length === 0 && <EmptyState title="No products found" body="Try a different search, or add a new product." />}
      {sections.map((s, si) => (
        <div key={si}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: si === 0 ? '4px 2px 10px' : '18px 2px 10px' }}>
            <span style={{ fontSize: 10, fontWeight: 500, letterSpacing: '.1em', textTransform: 'uppercase', color: T.textMuted }}>{s.cat}</span>
            <span style={{ flex: 1, height: 1, background: 'linear-gradient(to right,rgba(233,233,237,.13),transparent)' }} />
          </div>
          {s.items.map(p => (
            <div key={p.id} onClick={() => onEdit(p.id)} style={{
              background: T.card, border: '1px solid rgba(233,233,237,.09)', borderRadius: 8, padding: 13, marginBottom: 8,
              display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer',
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 500 }}>{p.name}</div>
                <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2 }}>
                  {(p.owner === 'fcg' ? 'FCG \u00b7 ' : '') + p.unit + (p.caseSize ? ' \u00b7 unsplit stock' : ' \u00b7 split stock')}
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

function MoreScreen({ productCountLabel, onGoProducts, onGoActivity, sites, STORE, onRemoveSite, siteRef, onAddSite, summaryOn, onToggleSummary, recipients, onRemoveRecipient, emailRef, onAddRecipient }) {
  return (
    <div>
      <div style={{ fontSize: 26, fontWeight: 500, letterSpacing: '-.02em', marginBottom: 16 }}>More</div>

      <div onClick={onGoProducts} style={{
        background: T.card, border: '1px solid rgba(233,233,237,.09)', borderRadius: 8, padding: 14, marginBottom: 8,
        display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer',
      }}>
        <i className="ph ph-package" style={{ fontSize: 20, color: T.accent }} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 500 }}>Product range</div>
          <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2 }}>{productCountLabel}</div>
        </div>
        <i className="ph ph-caret-right" style={{ color: T.textMuted }} />
      </div>

      <div onClick={onGoActivity} style={{
        background: T.card, border: '1px solid rgba(233,233,237,.09)', borderRadius: 8, padding: 14, marginBottom: 20,
        display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer',
      }}>
        <i className="ph ph-list-checks" style={{ fontSize: 20, color: T.accent }} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 500 }}>Activity</div>
          <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2 }}>Who changed what, and when</div>
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

function describeMovementItem(x) {
  const parts = [];
  if (x.caseQty) parts.push(x.caseQty + ' case' + (x.caseQty === 1 ? '' : 's'));
  if (x.qty) parts.push(x.qty + (x.caseQty ? ' individual' : ''));
  return x.name + ' ' + (parts.length ? parts.join(' + ') : x.qty || 0);
}

function ActivityScreen({ items, loading, error, onBack }) {
  // Pair up each "Loaded out" with its matching "Returned" (same session, same person)
  // into one movement card — what they took, and what came back.
  const bySession = {};
  items.forEach(it => {
    if (!it.metadata || (it.metadata.mode !== 'out' && it.metadata.mode !== 'back')) return;
    const key = it.metadata.sessionId + '|' + it.actor_label;
    if (!bySession[key]) {
      bySession[key] = { actor: it.actor_label, session: it.metadata.session, venue: it.metadata.venue, took: null, tookAt: null, broughtBack: null, backAt: null };
    }
    if (it.metadata.mode === 'out') { bySession[key].took = it.metadata.items; bySession[key].tookAt = it.created_at; }
    else { bySession[key].broughtBack = it.metadata.items; bySession[key].backAt = it.created_at; }
  });
  const movements = Object.values(bySession).sort((a, b) => (b.backAt || b.tookAt).localeCompare(a.backAt || a.tookAt));

  return (
    <div>
      <button onClick={onBack} style={{ background: 'none', border: 'none', color: T.textSecondary, fontSize: 13.5, display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', marginBottom: 14, padding: 0 }}>
        <i className="ph ph-arrow-left" /> More
      </button>
      <div style={{ fontSize: 26, fontWeight: 500, letterSpacing: '-.02em', marginBottom: 4 }}>Activity</div>
      <div style={{ fontSize: 14, color: T.textSecondary, marginBottom: 16 }}>Who changed what, most recent first.</div>
      {error && (
        <div style={{ background: 'rgba(224,117,102,.1)', border: `1px solid ${T.danger}`, borderRadius: 8, padding: 12, marginBottom: 14, fontSize: 13, color: T.danger }}>
          Couldn't reach the database: {error}
        </div>
      )}
      {loading && <div style={{ fontSize: 13, color: T.textMuted, padding: '8px 0' }}>{'Loading\u2026'}</div>}
      {!loading && !error && items.length === 0 && <EmptyState title="Nothing logged yet" body="Actions like adding a product, or loading a session out and back, will show up here." />}

      {movements.length > 0 && (
        <>
          <div style={{ fontSize: 11, fontWeight: 500, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 8 }}>Stock movements</div>
          {movements.map((m, i) => (
            <div key={i} style={{ background: T.card, border: '1px solid rgba(233,233,237,.09)', borderRadius: 8, padding: 13, marginBottom: 8 }}>
              <div style={{ fontSize: 14.5, fontWeight: 500 }}>{m.actor}</div>
              <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2, marginBottom: 8 }}>
                {m.session}{m.venue ? ' \u00b7 ' + m.venue : ''} \u00b7 {new Date(m.backAt || m.tookAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
              </div>
              <div style={{ fontSize: 13, marginBottom: 4 }}>
                <span style={{ color: T.textMuted }}>Took: </span>
                {m.took ? m.took.map(describeMovementItem).join(', ') : 'not logged'}
              </div>
              <div style={{ fontSize: 13, color: m.broughtBack ? T.text : T.warn }}>
                <span style={{ color: T.textMuted }}>Brought back: </span>
                {m.broughtBack ? (m.broughtBack.length ? m.broughtBack.map(describeMovementItem).join(', ') : 'nothing') : 'not yet returned'}
              </div>
            </div>
          ))}
          <div style={{ fontSize: 11, fontWeight: 500, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '.06em', margin: '20px 0 8px' }}>All activity</div>
        </>
      )}

      {items.map(it => (
        <div key={it.id} style={{ background: T.card, border: '1px solid rgba(233,233,237,.09)', borderRadius: 8, padding: 13, marginBottom: 8 }}>
          <div style={{ fontSize: 14.5, fontWeight: 500 }}>{it.action}{it.detail ? ' \u2014 ' + it.detail : ''}</div>
          <div style={{ fontSize: 12, color: T.textMuted, marginTop: 3 }}>
            {it.actor_label} \u00b7 {new Date(it.created_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
          </div>
        </div>
      ))}
    </div>
  );
}
