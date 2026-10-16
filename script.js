/* 게임 로그 말풍선 생성기 (티스토리용)
 * - 서버/DB 없이 브라우저에서만 동작합니다.
 * - 생성되는 HTML은 모든 CSS가 .vnlog 안으로 한정됩니다.
 */
(() => {
'use strict';

/* =====================================================================
 * 1. 유틸
 * ===================================================================== */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const uid = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escA = s => esc(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const pad2 = n => String(n).padStart(2, '0');

const _cctx = document.createElement('canvas').getContext('2d');
function toHex(c) {
  if (c == null) return '';
  c = String(c).trim().toLowerCase();
  if (!c || c === 'transparent' || c === 'inherit' || c === 'initial' || c === 'currentcolor') return '';
  let m = c.match(/^#([0-9a-f]{3})$/);
  if (m) return '#' + m[1].split('').map(x => x + x).join('');
  if (/^#[0-9a-f]{6}$/.test(c)) return c;
  m = c.match(/^rgba?\(([^)]+)\)/);
  if (m) {
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(parseFloat);
    if (p.length >= 4 && p[3] === 0) return '';
    if (p.length < 3 || p.slice(0, 3).some(isNaN)) return '';
    return '#' + p.slice(0, 3).map(n => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0')).join('');
  }
  if (!/^[a-z]+$/.test(c)) return '';
  _cctx.fillStyle = '#000'; _cctx.fillStyle = c;
  const v = _cctx.fillStyle;
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  return v.startsWith('rgb') ? toHex(v) : '';
}
const cleanColor = (v, fb) => { const h = toHex(v); return /^#[0-9a-f]{6}$/.test(h) ? h : fb; };

function cleanUrl(u) {
  u = String(u == null ? '' : u).trim();
  if (!u) return '';
  if (/^data:image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml);/i.test(u)) return u.replace(/[\r\n]/g, '');
  if (/^(https?:)?\/\//i.test(u)) {
    return u.replace(/[\r\n]/g, '').replace(/[\s"'<>`\\]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
  }
  return '';
}
const cssUrl = u => String(u).replace(/[\r\n]/g, '').replace(/["\\<>]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
const isData = u => /^data:/i.test(u || '');
const kb = n => (n / 1024).toFixed(n < 10240 ? 1 : 0) + 'KB';

/* =====================================================================
 * 2. 리치 텍스트 엔진
 *    - 내부 저장 형식(model): 이스케이프된 텍스트 + <b><i><u><s><span style="color;background"> + 줄바꿈(\n)
 *    - 편집 영역(contenteditable)의 DOM → 런(run) 배열 → model 로 항상 정규화합니다.
 * ===================================================================== */
const BLOCK_RE = /^(DIV|P|LI|UL|OL|H[1-6]|BLOCKQUOTE|PRE|TABLE|TR)$/;
const SKIP_RE = /^(SCRIPT|STYLE|IMG|SVG|CANVAS|IFRAME|OBJECT|VIDEO|AUDIO|NOSCRIPT)$/;

function styleOf(el, st) {
  const s = Object.assign({}, st), tag = el.tagName;
  if (tag === 'B' || tag === 'STRONG') s.b = 1;
  else if (tag === 'I' || tag === 'EM') s.i = 1;
  else if (tag === 'U') s.u = 1;
  else if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') s.s = 1;
  else if (tag === 'FONT') { const c = toHex(el.getAttribute('color')); if (c) s.c = c; }
  const cs = el.style;
  if (cs && cs.length) {
    const fw = cs.fontWeight;
    if (fw) { if (fw === 'bold' || fw === 'bolder' || +fw >= 600) s.b = 1; else if (fw === 'normal' || +fw < 600) delete s.b; }
    const fs = cs.fontStyle;
    if (fs) { if (/italic|oblique/.test(fs)) s.i = 1; else if (fs === 'normal') delete s.i; }
    const td = cs.textDecorationLine || cs.textDecoration || '';
    if (td) { if (/underline/.test(td)) s.u = 1; if (/line-through/.test(td)) s.s = 1; }
    if (cs.color) { const c = toHex(cs.color); if (c) s.c = c; }
    if (cs.backgroundColor) { const h = toHex(cs.backgroundColor); if (h) s.h = h; else delete s.h; }
  }
  return s;
}

/** DOM을 훑어 런 배열과, DOM 위치 ↔ 문자 오프셋 매핑을 만든다. */
function walk(root, raw) {
  const runs = [], starts = new Map(), ends = new Map(), spans = [];
  let len = 0, started = false, needNL = false;
  const add = (t, st) => { runs.push(Object.assign({ t }, st)); len += t.length; };
  const rec = (node, st) => {
    if (node.nodeType === 3) {
      let t = node.nodeValue.replace(/\u200b/g, '').replace(/\u00a0/g, ' ');
      if (!raw) t = t.replace(/[\r\n]+/g, ' ');
      starts.set(node, len);
      if (!t) { ends.set(node, len); return; }
      if (needNL) { add('\n'); needNL = false; }
      started = true;
      starts.set(node, len);
      add(t, st);
      spans.push({ node, start: len - t.length, end: len });
      ends.set(node, len);
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.tagName;
    if (tag === 'BR') {
      const p = node.parentNode;
      const last = p && p.lastChild === node && (p === root || BLOCK_RE.test(p.tagName));
      starts.set(node, len);
      if (!last) { if (needNL) { add('\n'); needNL = false; } started = true; add('\n'); }
      ends.set(node, len);
      return;
    }
    if (SKIP_RE.test(tag)) return;
    const isRoot = node === root;
    const st2 = isRoot ? st : styleOf(node, st);
    const isBlock = !isRoot && BLOCK_RE.test(tag);
    if (isBlock) { if (started) add('\n'); needNL = false; started = true; }
    starts.set(node, len);
    for (const c of node.childNodes) rec(c, st2);
    ends.set(node, len);
    if (isBlock) needNL = true;
  };
  rec(root, {});
  return { runs, starts, ends, spans, len };
}

function runsToModel(runs) {
  const items = [];
  for (const r of runs) {
    if (!r.t) continue;
    const key = [r.b ? 1 : 0, r.i ? 1 : 0, r.u ? 1 : 0, r.s ? 1 : 0, r.c || '', r.h || ''].join();
    const last = items[items.length - 1];
    if (last && last.key === key) last.t += r.t; else items.push({ key, t: r.t, r });
  }
  while (items.length) {
    const l = items[items.length - 1];
    l.t = l.t.replace(/\n+$/, '');
    if (l.t === '') items.pop(); else break;
  }
  return items.map(it => {
    const r = it.r;
    let o = esc(it.t);
    if (r.b) o = '<b>' + o + '</b>';
    if (r.i) o = '<i>' + o + '</i>';
    if (r.u) o = '<u>' + o + '</u>';
    if (r.s) o = '<s>' + o + '</s>';
    if (r.c || r.h) {
      const st = [];
      if (r.c) st.push('color:' + r.c);
      if (r.h) st.push('background:' + r.h);
      o = '<span style="' + st.join(';') + '">' + o + '</span>';
    }
    return o;
  }).join('');
}

/** 외부(불러온 JSON 등)에서 온 model 문자열을 안전하게 정규화한다. DOMParser는 스크립트/이미지를 실행하지 않는다. */
function sanitizeModel(html) {
  html = String(html == null ? '' : html);
  if (!html) return '';
  if (!/[<&]/.test(html)) return runsToModel([{ t: html.replace(/\u00a0/g, ' ') }]);
  const doc = new DOMParser().parseFromString('<!doctype html><body>' + html, 'text/html');
  return runsToModel(walk(doc.body, true).runs);
}
const modelToEditor = m => (m || '').replace(/\n/g, '<br>');
const modelPlain = m => (m || '').replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function ptOffset(res, container, off) {
  if (container.nodeType === 3) {
    const s = res.starts.get(container);
    if (s === undefined) return null;
    return s + container.nodeValue.slice(0, off).replace(/\u200b/g, '').length;
  }
  const kids = container.childNodes;
  if (off < kids.length) { const s = res.starts.get(kids[off]); if (s !== undefined) return s; }
  const e = res.ends.get(container);
  return e === undefined ? null : e;
}
function locate(res, off, root) {
  for (const sp of res.spans) if (off >= sp.start && off <= sp.end) return [sp.node, off - sp.start];
  let best = null;
  for (const sp of res.spans) if (sp.end < off) best = sp;
  if (best) return [best.node, best.node.nodeValue.length];
  if (res.spans.length) return [res.spans[0].node, 0];
  return [root, 0];
}
function mutateRuns(runs, a, b, fn) {
  const out = []; let pos = 0;
  for (const r of runs) {
    const l = r.t.length, s = pos, e = pos + l; pos = e;
    if (e <= a || s >= b) { out.push(r); continue; }
    const i1 = Math.max(a, s) - s, i2 = Math.min(b, e) - s;
    if (i1 > 0) out.push(Object.assign({}, r, { t: r.t.slice(0, i1) }));
    const mid = Object.assign({}, r, { t: r.t.slice(i1, i2) });
    if (mid.t !== '\n') fn(mid);
    out.push(mid);
    if (i2 < l) out.push(Object.assign({}, r, { t: r.t.slice(i2) }));
  }
  return out;
}

/* =====================================================================
 * 3. 저장소 (IndexedDB, 실패 시 localStorage)
 * ===================================================================== */
const kv = (() => {
  let db = null;
  const ready = new Promise(res => {
    try {
      const rq = indexedDB.open('vnlog-generator', 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore('kv');
      rq.onsuccess = () => { db = rq.result; res(); };
      rq.onerror = rq.onblocked = () => res();
    } catch (e) { res(); }
  });
  const run = (mode, fn) => ready.then(() => new Promise((res, rej) => {
    if (!db) return rej(new Error('nodb'));
    try {
      const t = db.transaction('kv', mode), st = t.objectStore('kv'), r = fn(st);
      t.oncomplete = () => res(r ? r.result : undefined);
      t.onerror = t.onabort = () => rej(t.error || new Error('tx'));
    } catch (e) { rej(e); }
  }));
  const LS = 'vnlog.kv.';
  return {
    get: k => run('readonly', s => s.get(k)).catch(() => { try { const v = localStorage.getItem(LS + k); return v ? JSON.parse(v) : undefined; } catch (e) { return undefined; } }),
    set: (k, v) => run('readwrite', s => s.put(v, k)).catch(() => { try { localStorage.setItem(LS + k, JSON.stringify(v)); } catch (e) { throw e; } }),
    del: k => run('readwrite', s => s.delete(k)).catch(() => { try { localStorage.removeItem(LS + k); } catch (e) { /* noop */ } })
  };
})();

/* =====================================================================
 * 4. 상태
 * ===================================================================== */
const S = { title: '', width: 'basic', expand: false, blocks: [] };
let chars = [];
let logId = uid();
let activeId = null;
let dirty = false;
let insertMode = 'end';
let view = 'edit';
const advOpen = new Set();
const CHAR_KEY = 'vnlog.chars.v1';

const DEF_STYLE = { name: '', icon: '', accent: '#8d98ad', bubble: '#293342', nameColor: '#ffffff', textColor: '#ffffff' };
const NARR_DEF = { nbg: '#252d47', nborder: '#525a85', ncolor: '#e9e9f5' };
const TAGS = { in: '수신', out: '발신', narr: '지문', img: '이미지' };

const norm = s => ({
  name: String((s && s.name) || '').slice(0, 40),
  icon: cleanUrl((s && s.icon) || ''),
  accent: cleanColor(s && s.accent, DEF_STYLE.accent),
  bubble: cleanColor(s && s.bubble, DEF_STYLE.bubble),
  nameColor: cleanColor(s && s.nameColor, '#ffffff'),
  textColor: cleanColor(s && s.textColor, '#ffffff')
});
const normChar = c => {
  if (!c || typeof c !== 'object') return null;
  return Object.assign({ id: (typeof c.id === 'string' && c.id.slice(0, 60)) || uid(), dir: c.dir === 'out' ? 'out' : 'in' }, norm(c));
};
const sampleChars = () => [normChar({ id: 'c_mob', name: '???', accent: '#8d98ad', bubble: '#293342', dir: 'in' })];

function loadChars() {
  try {
    const a = JSON.parse(localStorage.getItem(CHAR_KEY));
    if (Array.isArray(a)) return a.map(normChar).filter(Boolean);
  } catch (e) { /* noop */ }
  return null;
}
function saveChars() {
  try { localStorage.setItem(CHAR_KEY, JSON.stringify(chars)); }
  catch (e) { toast('캐릭터를 저장할 공간이 부족합니다. 프로필 이미지는 URL 방식을 권장합니다.'); }
}
const charOf = id => chars.find(c => c.id === id);
const baseStyle = b => b.snap || charOf(b.charId) || DEF_STYLE;
const dispName = b => b.x_name || baseStyle(b).name || '';
const byId = id => S.blocks.find(b => b.id === id);
const cardEl = id => $('.blk[data-id="' + id + '"]', listEl);

/* 블록 필드 검증표 (불러오기/정규화용) */
const numV = (a, b) => v => { v = +v; return Number.isFinite(v) ? clamp(Math.round(v), a, b) : undefined; };
const colV = v => { const h = toHex(v); return /^#[0-9a-f]{6}$/.test(h) ? h : undefined; };
const strV = n => v => typeof v === 'string' ? v.slice(0, n) : undefined;
const boolV = v => typeof v === 'boolean' ? v : undefined;
const enumV = (...a) => v => a.includes(v) ? v : undefined;
const FIELDS = {
  charId: strV(60), showIcon: boolV, showName: boolV, collapsed: boolV,
  x_name: strV(40), x_accent: colV, x_bubble: colV, x_tcolor: colV, x_fsize: numV(8, 40), x_radius: numV(0, 40), x_isize: numV(16, 96),
  x_nbg: colV, x_nborder: colV, x_ncolor: colV, x_width: numV(30, 100),
  src: v => typeof v === 'string' ? cleanUrl(v) : undefined, alt: strV(200),
  width: numV(5, 100), align: enumV('left', 'center', 'right'), mt: numV(0, 300), mb: numV(0, 300), radius: numV(0, 60)
};
function normBlock(r) {
  if (!r || typeof r !== 'object' || !['in', 'out', 'narr', 'img'].includes(r.type)) return null;
  const b = { id: uid(), type: r.type };
  if (b.type !== 'img') b.html = sanitizeModel(typeof r.html === 'string' ? r.html : '');
  for (const k in FIELDS) { if (r[k] === undefined) continue; const v = FIELDS[k](r[k]); if (v !== undefined) b[k] = v; }
  if (b.x_name === '') delete b.x_name;
  if (r.snap && typeof r.snap === 'object') b.snap = norm(r.snap);
  if (b.type === 'in' || b.type === 'out') { if (b.showIcon === undefined) b.showIcon = true; if (b.showName === undefined) b.showName = true; if (b.charId === undefined) b.charId = ''; }
  if (b.type === 'img') {
    if (b.src === undefined) b.src = '';
    if (b.alt === undefined) b.alt = '';
    if (b.width === undefined) b.width = 100;
    if (!b.align) b.align = 'center';
    if (b.mt === undefined) b.mt = 0;
    if (b.mb === undefined) b.mb = 22;
    if (b.radius === undefined) b.radius = 0;
  }
  return b;
}
function pickChar(type) {
  for (let i = S.blocks.length - 1; i >= 0; i--) { const b = S.blocks[i]; if (b.type === type && b.charId && charOf(b.charId)) return b.charId; }
  const c = chars.find(c => c.dir === type) || chars[0];
  return c ? c.id : '';
}
function newBlock(type) {
  const b = { id: uid(), type };
  if (type === 'in' || type === 'out') Object.assign(b, { charId: pickChar(type), html: '', showIcon: true, showName: true });
  else if (type === 'narr') b.html = '';
  else Object.assign(b, { src: '', alt: '', width: 100, align: 'center', mt: 0, mb: 22, radius: 0 });
  return b;
}

/* =====================================================================
 * 5. 실행 취소 / 다시 실행
 * ===================================================================== */
const hist = { undo: [], redo: [], key: null, t: 0 };
const snapshot = () => ({ width: S.width, expand: S.expand, blocks: S.blocks.map(b => Object.assign({}, b)) });
function pushHistory(key) {
  const now = Date.now();
  if (key && key === hist.key && now - hist.t < 1500) { hist.t = now; return; }
  hist.undo.push(snapshot());
  if (hist.undo.length > 100) hist.undo.shift();
  hist.redo.length = 0; hist.key = key; hist.t = now;
  updateUndoUi();
}
function restore(sn) {
  S.width = sn.width; S.expand = sn.expand; S.blocks = sn.blocks.map(b => Object.assign({}, b));
  if (activeId && !byId(activeId)) activeId = null;
  hist.key = null;
  renderAll(); markDirty();
}
function undo() { if (!hist.undo.length) return; hist.redo.push(snapshot()); restore(hist.undo.pop()); updateUndoUi(); }
function redo() { if (!hist.redo.length) return; hist.undo.push(snapshot()); restore(hist.redo.pop()); updateUndoUi(); }
function updateUndoUi() { $('#btnUndo').disabled = !hist.undo.length; $('#btnRedo').disabled = !hist.redo.length; }
function resetHistory() { hist.undo.length = 0; hist.redo.length = 0; hist.key = null; updateUndoUi(); }

/* =====================================================================
 * 6. 로그 HTML 생성 (미리보기와 출력 코드가 같은 함수를 사용)
 * ===================================================================== */
function makeCtx() {
  const map = new Map();
  return {
    map, flags: { pic: false, ph: false },
    cls(s) {
      const k = [s.accent, s.bubble, s.nameColor, s.textColor, s.icon].join('|');
      let e = map.get(k);
      if (!e) { e = { n: map.size + 1, s }; map.set(k, e); }
      return 'c' + e.n;
    }
  };
}
const stAttr = a => a.length ? ' style="' + escA(a.join(';')) + '"' : '';
const brs = h => (h || '').replace(/\n/g, '<br>');

function entryHtml(b, ctx, pv) {
  const da = pv ? ' data-id="' + b.id + '"' : '';
  if (b.type === 'narr') {
    const st = [];
    if (b.x_nbg) st.push('background:' + b.x_nbg);
    if (b.x_nborder) st.push('border-color:' + b.x_nborder);
    if (b.x_ncolor) st.push('color:' + b.x_ncolor);
    if (b.x_fsize !== undefined) st.push('font-size:' + b.x_fsize + 'px');
    if (b.x_radius !== undefined) st.push('border-radius:' + b.x_radius + 'px');
    if (b.x_width !== undefined) st.push('width:' + b.x_width + '%');
    return '<div class="entry narration"' + stAttr(st) + da + '>' + brs(b.html) + '</div>';
  }
  if (b.type === 'img') {
    const src = cleanUrl(b.src);
    if (!src) {
      return pv ? '<div class="entry"' + da + ' style="padding:22px;border:1px dashed #525a85;color:#8d98ad;text-align:center;background:#1b2440">이미지를 등록하세요</div>' : '';
    }
    ctx.flags.pic = true;
    const ws = [];
    if (b.width < 100) ws.push('width:' + b.width + '%');
    if (b.align === 'center') ws.push('margin:0 auto');
    else if (b.align === 'right') ws.push('margin:0 0 0 auto');
    if (b.radius) ws.push('border-radius:' + b.radius + 'px');
    const es = (b.mt !== 0 || b.mb !== 22) ? ' style="margin:' + b.mt + 'px 0 ' + b.mb + 'px"' : '';
    return '<div class="entry"' + es + da + '><img class="pic" src="' + escA(src) + '" alt="' + escA(b.alt || '') + '"' + stAttr(ws) + '></div>';
  }
  const s = baseStyle(b), cls = ctx.cls(s);
  const es = [];
  if (b.x_accent) es.push('--accent:' + b.x_accent);
  if (b.x_bubble) es.push('--bubble:' + b.x_bubble);
  const bs = [];
  if (b.x_tcolor) bs.push('color:' + b.x_tcolor);
  if (b.x_fsize !== undefined) bs.push('font-size:' + b.x_fsize + 'px');
  if (b.x_radius !== undefined) bs.push('border-radius:' + b.x_radius + 'px');
  const name = b.x_name || s.name;
  const sp = (b.showName !== false && name) ? '<div class="speaker">' + esc(name) + '</div>' : '';
  let av = '';
  if (b.showIcon !== false) {
    const as = b.x_isize !== undefined ? ' style="width:' + b.x_isize + 'px;height:' + b.x_isize + 'px;flex-basis:' + b.x_isize + 'px"' : '';
    if (s.icon) av = '<span class="avatar" aria-hidden="true"' + as + '></span>';
    else { ctx.flags.ph = true; av = '<span class="avatar" aria-hidden="true"' + as + '><span class="avatar-icon"></span></span>'; }
  }
  const body = '<div class="dialog-body">' + sp + '<div class="bubble"' + stAttr(bs) + '>' + brs(b.html) + '</div></div>';
  return '<div class="entry dialog ' + cls + ' ' + b.type + '"' + stAttr(es) + da + '>' + (b.type === 'in' ? av + body : body + av) + '</div>';
}

/** .vnlog 한정 CSS. opt.all=true 이면 선택적 규칙(아이콘/이미지)도 모두 포함 */
function buildCss(ctx, opt) {
  opt = opt || {};
  const L = [];
  L.push('/* 게임 로그: 이 글에서만 적용됩니다 */');
  L.push('.vnlog, .vnlog * { box-sizing:border-box; }');
  L.push('.vnlog { width:100%;max-width:' + (S.width === 'full' ? 'none' : '900px') + ';margin:0 auto;padding:30px 18px;background:#141d34;color:#fff;font-family:Pretendard,"Noto Sans KR",Arial,sans-serif;font-size:12px;line-height:1.65; }');
  L.push('.vnlog .entry {margin:0 0 22px;}');
  L.push('.vnlog .dialog {display:flex;align-items:flex-start;gap:8px;width:82%;max-width:none;min-width:0;}');
  L.push('.vnlog .dialog.in {margin-right:auto;margin-left:0;}');
  L.push('.vnlog .dialog.out {margin-left:auto;margin-right:0;justify-content:flex-end;}');
  L.push('.vnlog .avatar {display:flex;align-items:center;justify-content:center;flex:0 0 30px;width:30px;height:30px;border-radius:50%;background:var(--accent);overflow:hidden;}');
  if (opt.all || ctx.flags.ph) {
    L.push('.vnlog .avatar-icon {width:15px;height:15px;display:block;border-radius:50% 50% 35% 35%;background:#344057;position:relative;transform:translateY(6px);}');
    L.push('.vnlog .avatar-icon:before {content:"";position:absolute;width:10px;height:10px;border-radius:50%;background:#344057;top:-10px;left:2.5px;}');
  }
  L.push('.vnlog .dialog-body {flex:1;min-width:0;display:flex;flex-direction:column;align-items:stretch;}');
  L.push('.vnlog .speaker {width:85%;min-height:23px;margin:0;padding:3px 8px;color:#fff;font-size:11px;font-weight:700;line-height:1.45;background:linear-gradient(90deg,var(--accent),transparent);text-align:left;}');
  L.push('.vnlog .out .speaker {align-self:flex-end;background:linear-gradient(270deg,var(--accent),transparent);text-align:right;}');
  L.push('.vnlog .bubble {width:100%;margin:0;padding:10px 12px;border:1px solid var(--accent);border-radius:2px;background:var(--bubble);color:#fff;font-size:12px;font-weight:400;line-height:1.65;text-align:left;white-space:pre-line;word-break:break-all;overflow-wrap:anywhere;}');
  L.push('.vnlog .narration {width:94%;max-width:none;margin:22px auto;padding:12px 15px;text-align:center;background:#252d47;border:1px solid #525a85;border-radius:2px;color:#e9e9f5;font-size:12px;line-height:1.7;white-space:pre-line;word-break:break-all;overflow-wrap:anywhere;}');
  if (opt.all || ctx.flags.pic) L.push('.vnlog .pic {display:block;max-width:100%;height:auto;}');
  ctx.map.forEach(e => {
    const s = e.s, c = '.vnlog .c' + e.n;
    L.push(c + ' {--accent:' + s.accent + ';--bubble:' + s.bubble + ';}');
    if (s.nameColor !== '#ffffff') L.push(c + ' .speaker {color:' + s.nameColor + ';}');
    if (s.textColor !== '#ffffff') L.push(c + ' .bubble {color:' + s.textColor + ';}');
    if (s.icon) L.push(c + ' .avatar {background:url("' + cssUrl(s.icon) + '") center/cover no-repeat var(--accent);}');
  });
  L.push('@media(max-width:600px){.vnlog{padding:20px 8px}.vnlog .dialog{width:82%;gap:6px}.vnlog .avatar{flex-basis:28px;width:28px;height:28px}.vnlog .bubble{padding:9px 10px}.vnlog .narration{padding:12px 10px;margin:19px auto}.vnlog .entry{margin-bottom:19px}}');
  if (S.expand && !opt.noExpand) {
    L.push('/* 모바일에서 로그를 화면 가로 전체로 확장 */');
    L.push('@media screen and (max-width:768px){.vnlog{width:100vw !important;max-width:none !important;margin-left:calc(50% - 50vw) !important;margin-right:calc(50% - 50vw) !important;padding-left:16px !important;padding-right:16px !important;border-radius:0 !important}body:has(.vnlog){overflow-x:clip !important}}');
  }
  return L.join('\n');
}

function genCode() {
  const ctx = makeCtx();
  const entries = S.blocks.map(b => entryHtml(b, ctx, false)).filter(Boolean);
  return '<div>\n<style>\n' + buildCss(ctx) + '\n</style>\n</div>\n<div class="vnlog">\n' + entries.join('\n') + '\n</div>';
}
function standaloneHtml() {
  return '<!doctype html>\n<html lang="ko">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n<title>' +
    esc(S.title || '게임 로그') + '</title>\n</head>\n<body style="margin:0;padding:16px;background:#fff">\n' + genCode() + '\n</body>\n</html>\n';
}

/* =====================================================================
 * 7. 미리보기 (iframe — 티스토리 본문과 같은 조건으로 렌더링)
 * ===================================================================== */
const pvFrame = $('#pvFrame');
let pvDoc = null, pvMount = null, pvGen = null, pvCtx = makeCtx(), pvCssCache = '';
const PV_TPL = '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<style>html{scroll-behavior:auto}body{margin:0;padding:16px;background:#fff;font-family:Pretendard,"Noto Sans KR",Arial,sans-serif}' +
  '.vn-hl{outline:2px solid #3b8bff;outline-offset:4px}[data-id]{cursor:pointer}' +
  '.vnlog.big>.entry:not(.vn-hl){content-visibility:auto;contain-intrinsic-size:auto 76px}</style>' +
  '<style id="gen"></style></head><body><div id="mount"></div></body></html>';

function initPreview() {
  pvFrame.addEventListener('load', () => {
    pvDoc = pvFrame.contentDocument;
    if (!pvDoc) return;
    pvMount = pvDoc.getElementById('mount'); pvGen = pvDoc.getElementById('gen');
    pvDoc.addEventListener('click', e => {
      const en = e.target.closest && e.target.closest('[data-id]');
      if (!en) return;
      if (matchMedia('(max-width:900px)').matches) setView('edit');
      focusBlock(en.dataset.id, { edit: true, center: true });
    });
    renderPreviewFull();
  });
  pvFrame.srcdoc = PV_TPL;
}
function applyPvCss() {
  if (!pvGen) return;
  const css = buildCss(pvCtx, {});
  if (css !== pvCssCache) { pvGen.textContent = css; pvCssCache = css; }
}
function renderPreviewFull() {
  if (!pvMount) return;
  pvCtx = makeCtx(); pvCssCache = '';
  pvMount.innerHTML = '<div class="vnlog' + (S.blocks.length > 120 ? ' big' : '') + '">' + S.blocks.map(b => entryHtml(b, pvCtx, true)).join('\n') + '</div>';
  applyPvCss(); markPv(false);
}
function renderPreviewBlock(id) {
  if (!pvMount) return;
  const b = byId(id); if (!b) return;
  const el = pvDoc.querySelector('[data-id="' + id + '"]');
  if (!el) return renderPreviewFull();
  const t = document.createElement('template');
  t.innerHTML = entryHtml(b, pvCtx, true);
  const n = t.content.firstElementChild;
  if (id === activeId) n.classList.add('vn-hl');
  el.replaceWith(n);
  applyPvCss();
}
const pvQueue = new Set(); let pvRaf = 0;
function queuePv(id) {
  pvQueue.add(id);
  if (pvRaf) return;
  pvRaf = requestAnimationFrame(() => { pvRaf = 0; const ids = Array.from(pvQueue); pvQueue.clear(); ids.forEach(renderPreviewBlock); });
}
function previewVisible() { return !!pvFrame.offsetParent; }
function markPv(scroll) {
  if (!pvDoc) return;
  pvDoc.querySelectorAll('.vn-hl').forEach(x => x.classList.remove('vn-hl'));
  if (!activeId) return;
  const el = pvDoc.querySelector('[data-id="' + activeId + '"]');
  if (el) { el.classList.add('vn-hl'); if (scroll && previewVisible()) el.scrollIntoView({ block: 'center' }); }
}

/* =====================================================================
 * 8. 왼쪽 편집 패널 렌더링
 * ===================================================================== */
const listEl = $('#blockList');
const avStyle = (s) => s.icon ? ' style="background-image:url(&quot;' + escA(cssUrl(s.icon)) + '&quot;)"' : '';

function renderChars() {
  const el = $('#charList');
  if (!chars.length) { el.innerHTML = '<div class="empty">등록된 캐릭터가 없습니다. "+ 캐릭터 추가"로 시작하세요.</div>'; return; }
  el.innerHTML = chars.map(c =>
    '<button type="button" class="chip" data-char="' + escA(c.id) + '" style="--ac:' + c.accent + '" title="클릭하여 수정">' +
    '<span class="chip-av"' + avStyle(c) + '></span><span class="chip-name">' + esc(c.name || '(이름 없음)') + '</span>' +
    '<span class="chip-dir">' + (c.dir === 'out' ? '발신' : '수신') + '</span></button>').join('');
}

const sw = (label, f, on) => '<div class="row sw"><span>' + label + '</span><label class="switch"><input type="checkbox" data-f="' + f + '"' + (on ? ' checked' : '') + '><i></i></label></div>';
function ovDefault(b, key) {
  const s = baseStyle(b);
  return ({ x_accent: s.accent, x_bubble: s.bubble, x_tcolor: s.textColor, x_nbg: NARR_DEF.nbg, x_nborder: NARR_DEF.nborder, x_ncolor: NARR_DEF.ncolor })[key];
}
const ovColor = (b, label, key) => {
  const set = b[key] !== undefined;
  return '<div class="ov' + (set ? ' set' : '') + '"><span>' + label + '</span><div class="ov-ctl"><input type="color" data-f="' + key + '" value="' + (set ? b[key] : ovDefault(b, key)) +
    '"><button type="button" class="rst" data-reset="' + key + '"' + (set ? '' : ' hidden') + '>초기화</button></div></div>';
};
const ovNum = (b, label, key, def, min, max) => {
  const set = b[key] !== undefined;
  return '<div class="ov' + (set ? ' set' : '') + '"><span>' + label + '</span><div class="ov-ctl"><input type="number" data-f="' + key + '" min="' + min + '" max="' + max + '" placeholder="' + def + '" value="' + (set ? b[key] : '') +
    '"><button type="button" class="rst" data-reset="' + key + '"' + (set ? '' : ' hidden') + '>초기화</button></div></div>';
};
const ovText = (b, label, key, def) => {
  const set = b[key] !== undefined;
  return '<div class="ov' + (set ? ' set' : '') + '"><span>' + label + '</span><div class="ov-ctl"><input type="text" data-f="' + key + '" maxlength="40" placeholder="' + escA(def) + '" value="' + escA(set ? b[key] : '') +
    '"><button type="button" class="rst" data-reset="' + key + '"' + (set ? '' : ' hidden') + '>초기화</button></div></div>';
};
function rtHtml(b, ph) {
  return '<div class="rt"><div class="rt-bar">' +
    '<button type="button" data-cmd="bold" title="굵게 (Ctrl+B)"><b>B</b></button>' +
    '<button type="button" data-cmd="italic" title="기울임 (Ctrl+I)"><i>I</i></button>' +
    '<button type="button" data-cmd="underline" title="밑줄 (Ctrl+U)"><u>U</u></button>' +
    '<button type="button" data-cmd="strike" title="취소선"><s>S</s></button>' +
    '<span class="bar-sep"></span>' +
    '<button type="button" data-pal="fg" class="sw-a" title="글자색">A</button>' +
    '<button type="button" data-pal="bg" class="sw-h" title="글자 배경색">가</button>' +
    '<button type="button" data-cmd="clear" class="clr" title="선택한 글자의 서식 제거 (선택이 없으면 전체)">서식 제거</button>' +
    '</div><div class="rt-edit" contenteditable="true" spellcheck="false" data-ph="' + escA(ph) + '">' + modelToEditor(b.html) + '</div></div>';
}
function cprevHtml(b) {
  const s = baseStyle(b), ac = b.x_accent || s.accent, bg = b.x_bubble || s.bubble;
  return '<div class="cprev"><span class="cp-av" style="--ac:' + ac + (s.icon ? ';background-image:url(&quot;' + escA(cssUrl(s.icon)) + '&quot;)' : '') + '"></span>' +
    '<span class="cp-name">' + esc(dispName(b) || '(캐릭터 없음)') + (b.snap ? ' <small>· 고정된 스타일</small>' : '') + '</span>' +
    '<span class="cp-dot" title="상징색" style="background:' + ac + '"></span><span class="cp-dot" title="말풍선 배경" style="background:' + bg + '"></span></div>';
}
function bodyHtml(b) {
  if (b.type === 'in' || b.type === 'out') {
    const s = baseStyle(b);
    let opts = '<option value="">(캐릭터 없음)</option>' + chars.map(c => '<option value="' + escA(c.id) + '"' + (c.id === b.charId && !b.snap ? ' selected' : '') + '>' + esc(c.name || '(이름 없음)') + '</option>').join('');
    if (b.snap) opts = '<option value="" selected>' + esc(b.snap.name || '(이름 없음)') + ' (고정된 스타일)</option>' + opts.replace('<option value="">(캐릭터 없음)</option>', '<option value="">(캐릭터 없음)</option>');
    return sw('수신 ↔ 발신 전환', 'dir', b.type === 'out') + sw('아이콘 사용', 'showIcon', b.showIcon !== false) +
      '<div class="sep"></div><label class="lbl">캐릭터</label><select class="sel" data-f="charId">' + opts + '</select>' + cprevHtml(b) +
      '<label class="lbl">대사</label>' + rtHtml(b, '대사를 입력하세요') +
      '<details class="adv" data-adv="' + b.id + '"' + (advOpen.has(b.id) ? ' open' : '') + '><summary>추가 설정 (색상 · 글자 크기 · 모서리)</summary><div class="adv-body">' +
      ovText(b, '표시 이름', 'x_name', s.name || '캐릭터 이름') + sw('이름표 표시', 'showName', b.showName !== false) +
      ovColor(b, '상징색 (테두리·이름표)', 'x_accent') + ovColor(b, '말풍선 배경', 'x_bubble') + ovColor(b, '말풍선 글자색', 'x_tcolor') +
      ovNum(b, '글자 크기(px)', 'x_fsize', 12, 8, 40) + ovNum(b, '모서리(px)', 'x_radius', 2, 0, 40) + ovNum(b, '아이콘 크기(px)', 'x_isize', 30, 16, 96) +
      '</div></details>';
  }
  if (b.type === 'narr') {
    return '<label class="lbl">지문</label>' + rtHtml(b, '행동 지문 · 서술 지문을 입력하세요') +
      '<details class="adv" data-adv="' + b.id + '"' + (advOpen.has(b.id) ? ' open' : '') + '><summary>추가 설정 (색상 · 글자 크기 · 모서리)</summary><div class="adv-body">' +
      ovColor(b, '배경색', 'x_nbg') + ovColor(b, '테두리색', 'x_nborder') + ovColor(b, '글자색', 'x_ncolor') +
      ovNum(b, '글자 크기(px)', 'x_fsize', 12, 8, 40) + ovNum(b, '모서리(px)', 'x_radius', 2, 0, 40) + ovNum(b, '가로폭(%)', 'x_width', 94, 30, 100) +
      '</div></details>';
  }
  const data = isData(b.src);
  const seg = (v, t) => '<button type="button" data-v="' + v + '"' + (b.align === v ? ' class="on"' : '') + '>' + t + '</button>';
  return '<div class="thumb" data-drop="1">' + (cleanUrl(b.src) ? '<img src="' + escA(cleanUrl(b.src)) + '" alt="">' : '<span>이미지 없음 · 파일을 끌어다 놓거나 Ctrl+V</span>') + '</div>' +
    '<label class="lbl">이미지 URL (권장)</label><input type="text" class="inp" data-f="src" placeholder="https://..." value="' + (data ? '' : escA(b.src)) + '">' +
    '<div class="btn-row"><button type="button" class="btn small" data-act="pickimg">로컬 파일 선택</button><button type="button" class="btn small" data-act="clearimg">이미지 제거</button></div>' +
    (data ? '<div class="warn">업로드한 파일은 <b>Data URL</b>로 코드에 포함됩니다 (현재 약 ' + kb(b.src.length) + '). 용량이 커서 티스토리 저장 시 오류가 날 수 있으니, 가능하면 <b>이미지 URL 방식</b>을 사용하세요.</div>' : '') +
    '<label class="lbl">이미지 너비 (%)</label><div class="rng"><input type="range" min="5" max="100" data-f="width" value="' + b.width + '"><input type="number" class="inp" min="5" max="100" data-f="width" value="' + b.width + '"></div>' +
    '<label class="lbl">정렬</label><div class="seg mini" data-seg="align">' + seg('left', '왼쪽') + seg('center', '가운데') + seg('right', '오른쪽') + '</div>' +
    '<div class="ov" style="margin-top:8px"><span>위 여백(px)</span><div class="ov-ctl"><input type="number" data-f="mt" min="0" max="300" value="' + b.mt + '"></div></div>' +
    '<div class="ov" style="margin-top:6px"><span>아래 여백(px)</span><div class="ov-ctl"><input type="number" data-f="mb" min="0" max="300" value="' + b.mb + '"></div></div>' +
    '<div class="ov" style="margin-top:6px"><span>모서리 둥글기(px)</span><div class="ov-ctl"><input type="number" data-f="radius" min="0" max="60" value="' + b.radius + '"></div></div>' +
    '<label class="lbl">대체 텍스트</label><input type="text" class="inp" data-f="alt" maxlength="200" value="' + escA(b.alt) + '" placeholder="이미지 설명">';
}
function cardHtml(b, i) {
  const col = !!b.collapsed;
  let sum;
  if (col) {
    let t;
    if (b.type === 'img') t = b.alt || (b.src ? (isData(b.src) ? '(업로드한 이미지)' : b.src) : '(이미지 없음)');
    else { t = modelPlain(b.html).replace(/\n/g, ' ').slice(0, 60) || '(빈 내용)'; const nm = (b.type === 'in' || b.type === 'out') ? dispName(b) : ''; if (nm) t = nm + ': ' + t; }
    sum = t;
  } else sum = (b.type === 'in' || b.type === 'out') ? dispName(b) : '';
  return '<div class="blk' + (col ? ' collapsed' : '') + (b.id === activeId ? ' active' : '') + '" data-id="' + b.id + '" data-type="' + b.type + '">' +
    '<div class="blk-head"><span class="grip" title="드래그하여 순서 변경">⠿</span><span class="idx">' + (i + 1) + '</span><span class="tag ' + b.type + '">' + TAGS[b.type] + '</span>' +
    '<span class="sumtxt">' + esc(sum) + '</span><div class="head-actions">' +
    '<button type="button" class="ib" data-act="fold" title="' + (col ? '펼치기' : '접기') + '">' + (col ? '▸' : '▾') + '</button>' +
    '<button type="button" class="ib" data-act="dup">복제</button><button type="button" class="ib" data-act="up" title="위로">▲</button>' +
    '<button type="button" class="ib" data-act="down" title="아래로">▼</button><button type="button" class="ib del" data-act="del">삭제</button></div></div>' +
    '<div class="blk-body">' + (col ? '' : bodyHtml(b)) + '</div></div>';
}
function renderList() {
  const st = listEl.scrollTop, pt = $('#paneLeft').scrollTop;
  listEl.innerHTML = S.blocks.length ? S.blocks.map(cardHtml).join('') :
    '<div class="empty-msg">아직 블록이 없습니다.<br>위의 <b>+ 수신 말풍선</b> · <b>+ 발신 말풍선</b> · <b>+ 행동 지문</b> · <b>+ 이미지 첨부</b> 버튼으로 시작하세요.</div>';
  listEl.scrollTop = st; $('#paneLeft').scrollTop = pt;
  $('#blkCount').textContent = S.blocks.length;
}
function rerenderCard(id) {
  const old = cardEl(id), i = S.blocks.findIndex(b => b.id === id);
  if (!old || i < 0) return;
  const t = document.createElement('template');
  t.innerHTML = cardHtml(S.blocks[i], i);
  old.replaceWith(t.content.firstElementChild);
}
function syncChrome() {
  $('#logTitle').value = S.title;
  $$('#segFrame button').forEach(x => x.classList.toggle('on', x.dataset.v === S.width));
  $('#chkExpand').checked = S.expand;
  $$('#segInsert button').forEach(x => x.classList.toggle('on', x.dataset.v === insertMode));
}
function renderAll() {
  syncChrome(); renderChars(); renderList(); renderPreviewFull(); scheduleCode();
}

/* =====================================================================
 * 9. 블록 동작
 * ===================================================================== */
function markDirty() { dirty = true; scheduleSave(); scheduleCode(); }
function changed(id) { markDirty(); queuePv(id); }

function setActive(id, opt) {
  opt = opt || {};
  if (activeId !== id) {
    activeId = id;
    $$('.blk.active', listEl).forEach(x => x.classList.remove('active'));
    const c = cardEl(id); if (c) c.classList.add('active');
    markPv(!!opt.scroll);
  } else if (opt.scroll) markPv(true);
}
function placeCaretEnd(el) {
  const r = document.createRange(); r.selectNodeContents(el); r.collapse(false);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
}
function focusBlock(id, opt) {
  opt = opt || {};
  const b = byId(id); if (!b) return;
  if (b.collapsed) { b.collapsed = false; rerenderCard(id); }
  const el = cardEl(id); if (!el) return;
  el.scrollIntoView({ block: opt.center ? 'center' : 'nearest' });
  setActive(id, { scroll: !opt.fromEditor });
  if (opt.edit) {
    const ed = $('.rt-edit', el);
    if (ed) { ed.focus({ preventScroll: true }); placeCaretEnd(ed); }
    else { const i = $('input[data-f="src"]', el); if (i) i.focus({ preventScroll: true }); }
  }
}
function addBlock(type) {
  pushHistory(null);
  const b = newBlock(type);
  let idx = S.blocks.length;
  if (insertMode === 'after' && activeId) { const i = S.blocks.findIndex(x => x.id === activeId); if (i >= 0) idx = i + 1; }
  S.blocks.splice(idx, 0, b);
  activeId = b.id;
  renderList(); renderPreviewFull(); markDirty();
  focusBlock(b.id, { edit: true });
  return b;
}
function removeBlock(id) {
  const i = S.blocks.findIndex(b => b.id === id); if (i < 0) return;
  pushHistory(null);
  S.blocks.splice(i, 1);
  if (activeId === id) activeId = null;
  renderList(); renderPreviewFull(); markDirty();
  toast('블록을 삭제했습니다.', { label: '실행 취소', fn: undo });
}
function dupBlock(id) {
  const i = S.blocks.findIndex(b => b.id === id); if (i < 0) return;
  pushHistory(null);
  const c = Object.assign({}, S.blocks[i], { id: uid() });
  S.blocks.splice(i + 1, 0, c);
  activeId = c.id;
  renderList(); renderPreviewFull(); markDirty();
  focusBlock(c.id);
}
function moveBlock(id, to) {
  const i = S.blocks.findIndex(b => b.id === id);
  to = clamp(to, 0, S.blocks.length - 1);
  if (i < 0 || i === to) return;
  pushHistory(null);
  const [b] = S.blocks.splice(i, 1);
  S.blocks.splice(to, 0, b);
  renderList(); renderPreviewFull(); markDirty();
  const el = cardEl(id); if (el) el.scrollIntoView({ block: 'nearest' });
}
function setCollapsed(id, v) {
  const b = byId(id); if (!b) return;
  b.collapsed = v; rerenderCard(id);
}
function foldAll(v) {
  S.blocks.forEach(b => { b.collapsed = v; });
  renderList(); scheduleSave();
}

/** 카드 안의 입력 컨트롤 변경 처리 */
function applyField(el) {
  const card = el.closest('.blk'); if (!card) return;
  const b = byId(card.dataset.id); if (!b) return;
  const f = el.dataset.f; if (!f) return;
  let v;
  if (el.type === 'checkbox') v = el.checked;
  else if (el.type === 'number' || el.type === 'range') v = el.value === '' ? '' : +el.value;
  else v = el.value;

  if (f === 'dir') {
    pushHistory(null); b.type = v ? 'out' : 'in';
    rerenderCard(b.id); renderPreviewBlock(b.id); markDirty(); return;
  }
  if (f === 'charId') {
    pushHistory(null); b.charId = v; delete b.snap;
    rerenderCard(b.id); renderPreviewBlock(b.id); markDirty(); return;
  }
  pushHistory('f:' + b.id + ':' + f);
  if (v === '' || v == null || (typeof v === 'number' && !Number.isFinite(v))) {
    if (f in { x_name: 1, x_accent: 1, x_bubble: 1, x_tcolor: 1, x_fsize: 1, x_radius: 1, x_isize: 1, x_nbg: 1, x_nborder: 1, x_ncolor: 1, x_width: 1 }) delete b[f];
    else if (f === 'src' || f === 'alt') b[f] = '';
    else return;
  } else {
    if (el.type === 'number' || el.type === 'range') v = clamp(Math.round(v), +el.min || 0, +el.max || 999);
    if (f === 'src') {
      v = cleanUrl(v);
      if (!v) { toast('http(s):// 로 시작하는 이미지 주소를 입력하세요.'); }
      b.src = v;
    } else b[f] = v;
  }
  if (f === 'width') $$('[data-f="width"]', card).forEach(x => { if (x !== el) x.value = b.width; });
  if (f.startsWith('x_')) {
    const ov = el.closest('.ov'), rs = ov && $('[data-reset]', ov);
    const set = b[f] !== undefined;
    if (ov) ov.classList.toggle('set', set);
    if (rs) rs.hidden = !set;
    const cp = $('.cprev', card); if (cp && (b.type === 'in' || b.type === 'out')) cp.outerHTML = cprevHtml(b);
  }
  if (f === 'src') { rerenderCard(b.id); renderPreviewBlock(b.id); markDirty(); return; }
  if (f === 'showName' || f === 'showIcon') { /* 미리보기만 갱신 */ }
  changed(b.id);
}
function resetField(btn) {
  const card = btn.closest('.blk'), b = byId(card.dataset.id), key = btn.dataset.reset; if (!b) return;
  pushHistory(null);
  delete b[key];
  const ov = btn.closest('.ov'), inp = $('[data-f="' + key + '"]', ov);
  if (inp) inp.value = inp.type === 'color' ? ovDefault(b, key) : '';
  ov.classList.remove('set'); btn.hidden = true;
  const cp = $('.cprev', card); if (cp && (b.type === 'in' || b.type === 'out')) cp.outerHTML = cprevHtml(b);
  changed(b.id);
}

/* 리치 텍스트 편집 영역 → 상태 */
function syncFromEditor(el) {
  const card = el.closest('.blk'); if (!card) return;
  const b = byId(card.dataset.id); if (!b) return;
  const res = walk(el, false), model = runsToModel(res.runs);
  if (!res.runs.length && el.innerHTML !== '' && !el.querySelector('div,p')) el.innerHTML = '';
  if (model === (b.html || '')) return;
  pushHistory('t:' + b.id);
  b.html = model;
  changed(b.id);
}
let savedSel = null;
document.addEventListener('selectionchange', () => {
  const s = document.getSelection();
  if (!s || !s.rangeCount) return;
  const r = s.getRangeAt(0);
  const n = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement;
  const el = n && n.closest ? n.closest('.rt-edit') : null;
  if (el && el.contains(r.endContainer)) savedSel = { el, range: r.cloneRange() };
});
/** 선택한 글자에만 서식을 적용한다. (execCommand 대신 모델 기반으로 처리해 브라우저별 차이를 없앰) */
function applyFormat(el, cmd, val) {
  const sel = savedSel && savedSel.el === el && el.isConnected ? savedSel : null;
  if (!sel) { toast('서식을 적용할 글자를 먼저 드래그해서 선택하세요.'); return; }
  const res = walk(el, false);
  let a = ptOffset(res, sel.range.startContainer, sel.range.startOffset);
  let b = ptOffset(res, sel.range.endContainer, sel.range.endOffset);
  if (a == null || b == null) { toast('서식을 적용할 글자를 먼저 드래그해서 선택하세요.'); return; }
  if (a > b) [a, b] = [b, a];
  if (a === b) {
    if (cmd === 'clear') { a = 0; b = res.len; }
    else { toast('서식을 적용할 글자를 드래그해서 선택하세요.'); return; }
  }
  const flag = { bold: 'b', italic: 'i', underline: 'u', strike: 's' }[cmd];
  let fn;
  if (flag) {
    let all = true, any = false;
    mutateRuns(res.runs, a, b, m => { any = true; if (!m[flag]) all = false; });
    if (!any) { toast('서식을 적용할 글자를 드래그해서 선택하세요.'); return; }
    fn = m => { if (all) delete m[flag]; else m[flag] = 1; };
  } else if (cmd === 'color') fn = m => { if (val) m.c = val; else delete m.c; };
  else if (cmd === 'bg') fn = m => { if (val) m.h = val; else delete m.h; };
  else if (cmd === 'clear') fn = m => { delete m.b; delete m.i; delete m.u; delete m.s; delete m.c; delete m.h; };
  else return;
  const runs = mutateRuns(res.runs, a, b, fn);
  el.innerHTML = modelToEditor(runsToModel(runs));
  el.focus({ preventScroll: true });
  const res2 = walk(el, false);
  const [n1, o1] = locate(res2, a, el), [n2, o2] = locate(res2, b, el);
  const r = document.createRange();
  try { r.setStart(n1, o1); r.setEnd(n2, o2); const s = getSelection(); s.removeAllRanges(); s.addRange(r); savedSel = { el, range: r.cloneRange() }; } catch (e) { /* noop */ }
  syncFromEditor(el);
}

/* 색상 팔레트 */
const PALETTE = ['#ff4d4f', '#ff9f43', '#ffd43b', '#69db7c', '#4dabf7', '#9775fa', '#f783ac', '#ffffff', '#adb5bd', '#000000'];
const paletteEl = $('#palette');
let palTarget = null, palKind = 'fg';
function openPalette(btn, kind) {
  const ed = $('.rt-edit', btn.closest('.rt'));
  palTarget = ed; palKind = kind;
  paletteEl.innerHTML = '<div class="pal-grid">' + PALETTE.map(c => '<button type="button" data-c="' + c + '" style="background:' + c + '" title="' + c + '"></button>').join('') + '</div>' +
    '<div class="pal-foot"><label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--sub)">직접 선택 <input type="color" id="palCustom" value="' + (kind === 'fg' ? '#ff4d4f' : '#ffe066') + '"></label>' +
    '<button type="button" class="rst" data-c="">' + (kind === 'fg' ? '색 제거' : '배경 제거') + '</button></div>';
  paletteEl.hidden = false;
  const r = btn.getBoundingClientRect(), w = 196, h = paletteEl.offsetHeight;
  paletteEl.style.left = clamp(r.left, 6, innerWidth - w - 6) + 'px';
  paletteEl.style.top = (r.bottom + h + 8 > innerHeight ? Math.max(6, r.top - h - 6) : r.bottom + 6) + 'px';
}
function closePalette() { paletteEl.hidden = true; palTarget = null; }
paletteEl.addEventListener('mousedown', e => { if (!e.target.closest('input')) e.preventDefault(); });
paletteEl.addEventListener('click', e => {
  const c = e.target.closest('[data-c]'); if (!c || !palTarget) return;
  applyFormat(palTarget, palKind === 'fg' ? 'color' : 'bg', c.dataset.c);
  closePalette();
});
paletteEl.addEventListener('change', e => {
  if (e.target.id === 'palCustom' && palTarget) { applyFormat(palTarget, palKind === 'fg' ? 'color' : 'bg', e.target.value); closePalette(); }
});
document.addEventListener('mousedown', e => { if (!paletteEl.hidden && !e.target.closest('#palette') && !e.target.closest('[data-pal]')) closePalette(); });

/* ---- 목록 이벤트 위임 ---- */
listEl.addEventListener('mousedown', e => {
  if (e.target.closest('.rt-bar button')) e.preventDefault();
  const g = e.target.closest('.grip');
  if (g) g.closest('.blk').draggable = true;
});
document.addEventListener('mouseup', () => { $$('.blk[draggable="true"]', listEl).forEach(x => x.removeAttribute('draggable')); });
listEl.addEventListener('focusin', e => {
  const card = e.target.closest('.blk');
  if (card && card.dataset.id !== activeId) setActive(card.dataset.id, { scroll: true });
});
listEl.addEventListener('click', e => {
  const card = e.target.closest('.blk'); if (!card) return;
  const id = card.dataset.id;
  if (id !== activeId) setActive(id, { scroll: true });
  const act = e.target.closest('[data-act]');
  if (act) {
    const a = act.dataset.act, i = S.blocks.findIndex(b => b.id === id);
    if (a === 'fold') setCollapsed(id, !byId(id).collapsed);
    else if (a === 'dup') dupBlock(id);
    else if (a === 'up') moveBlock(id, i - 1);
    else if (a === 'down') moveBlock(id, i + 1);
    else if (a === 'del') removeBlock(id);
    else if (a === 'pickimg') { imgTarget = id; $('#fileImg').click(); }
    else if (a === 'clearimg') { const b = byId(id); if (b.src) { pushHistory(null); b.src = ''; rerenderCard(id); renderPreviewBlock(id); markDirty(); } }
    return;
  }
  const rs = e.target.closest('[data-reset]'); if (rs) { resetField(rs); return; }
  const cmd = e.target.closest('[data-cmd]');
  if (cmd) { applyFormat($('.rt-edit', cmd.closest('.rt')), cmd.dataset.cmd); return; }
  const pal = e.target.closest('[data-pal]');
  if (pal) { openPalette(pal, pal.dataset.pal); return; }
  const sg = e.target.closest('[data-seg] button');
  if (sg) {
    const b = byId(id), k = sg.parentElement.dataset.seg;
    pushHistory(null); b[k] = sg.dataset.v;
    $$('button', sg.parentElement).forEach(x => x.classList.toggle('on', x === sg));
    changed(id);
  }
});
listEl.addEventListener('input', e => {
  const t = e.target;
  if (t.classList.contains('rt-edit')) { syncFromEditor(t); return; }
  if (t.dataset.f && t.dataset.f !== 'src' && t.type !== 'checkbox' && t.tagName !== 'SELECT' && t.type !== 'color') applyField(t);
  else if (t.type === 'color' && t.dataset.f) applyField(t);
});
listEl.addEventListener('change', e => {
  const t = e.target;
  if (!t.dataset || !t.dataset.f) return;
  if (t.type === 'checkbox' || t.tagName === 'SELECT' || t.dataset.f === 'src') applyField(t);
});
listEl.addEventListener('toggle', e => {
  const d = e.target; if (!d.dataset || !d.dataset.adv) return;
  if (d.open) advOpen.add(d.dataset.adv); else advOpen.delete(d.dataset.adv);
}, true);
listEl.addEventListener('keydown', e => {
  const t = e.target;
  if (!t.classList || !t.classList.contains('rt-edit')) return;
  if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); document.execCommand('insertLineBreak'); return; }
  if ((e.ctrlKey || e.metaKey) && !e.altKey && ['b', 'i', 'u'].includes(e.key.toLowerCase())) {
    const s = document.getSelection();
    if (s.rangeCount && !s.isCollapsed) {
      e.preventDefault();
      savedSel = { el: t, range: s.getRangeAt(0).cloneRange() };
      applyFormat(t, { b: 'bold', i: 'italic', u: 'underline' }[e.key.toLowerCase()]);
    }
  }
});
listEl.addEventListener('paste', e => {
  const t = e.target;
  if (!t.classList || !t.classList.contains('rt-edit')) return;
  const text = (e.clipboardData && e.clipboardData.getData('text/plain')) || '';
  if (!text) return;
  e.preventDefault();
  text.replace(/\r\n?/g, '\n').split('\n').forEach((ln, i) => { if (i) document.execCommand('insertLineBreak'); if (ln) document.execCommand('insertText', false, ln); });
});

/* 드래그 앤 드롭: 블록 순서 변경 / 이미지 파일 드롭 */
let dragId = null, dropInfo = null;
function clearDrop() { $$('.drop-before,.drop-after', listEl).forEach(x => x.classList.remove('drop-before', 'drop-after')); }
listEl.addEventListener('dragstart', e => {
  const card = e.target.closest && e.target.closest('.blk');
  if (!card || card.draggable !== true) return;
  dragId = card.dataset.id; card.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  try { e.dataTransfer.setData('text/plain', dragId); } catch (x) { /* noop */ }
});
listEl.addEventListener('dragover', e => {
  const types = Array.from(e.dataTransfer.types || []);
  if (types.includes('Files')) {
    const th = e.target.closest('[data-drop]');
    if (th) { e.preventDefault(); th.classList.add('over'); }
    return;
  }
  if (!dragId) return;
  e.preventDefault();
  const sc = $('#paneLeft'), r = sc.getBoundingClientRect();
  if (e.clientY < r.top + 150) sc.scrollTop -= 14; else if (e.clientY > r.bottom - 40) sc.scrollTop += 14;
  const card = e.target.closest('.blk');
  clearDrop();
  if (!card || card.dataset.id === dragId) { dropInfo = null; return; }
  const cr = card.getBoundingClientRect(), after = e.clientY > cr.top + cr.height / 2;
  card.classList.add(after ? 'drop-after' : 'drop-before');
  dropInfo = { id: card.dataset.id, after };
});
listEl.addEventListener('dragleave', e => { const th = e.target.closest && e.target.closest('[data-drop]'); if (th) th.classList.remove('over'); });
listEl.addEventListener('drop', e => {
  const files = e.dataTransfer && e.dataTransfer.files;
  if (files && files.length) {
    const th = e.target.closest('[data-drop]');
    if (th) { e.preventDefault(); th.classList.remove('over'); const card = th.closest('.blk'); setImageFromFile(files[0], card.dataset.id); }
    return;
  }
  if (!dragId || !dropInfo) return;
  e.preventDefault();
  const from = S.blocks.findIndex(b => b.id === dragId);
  let to = S.blocks.findIndex(b => b.id === dropInfo.id) + (dropInfo.after ? 1 : 0);
  if (from < to) to--;
  const id = dragId; dragId = null; clearDrop();
  moveBlock(id, to);
});
listEl.addEventListener('dragend', () => { dragId = null; dropInfo = null; clearDrop(); $$('.dragging', listEl).forEach(x => x.classList.remove('dragging')); $$('.blk[draggable]', listEl).forEach(x => x.removeAttribute('draggable')); });

/* =====================================================================
 * 10. 이미지 처리
 * ===================================================================== */
let imgTarget = null;
const readDataUrl = f => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(fr.error); fr.readAsDataURL(f); });
const loadImage = f => new Promise((res, rej) => {
  const u = URL.createObjectURL(f), im = new Image();
  im.onload = () => { URL.revokeObjectURL(u); res(im); };
  im.onerror = () => { URL.revokeObjectURL(u); rej(new Error('이미지를 읽을 수 없습니다.')); };
  im.src = u;
});
async function fileToDataUrl(file, opt) {
  opt = opt || {};
  if (!/^image\//.test(file.type)) throw new Error('이미지 파일만 사용할 수 있습니다.');
  if (/svg/.test(file.type) || (/gif/.test(file.type) && !opt.square)) return readDataUrl(file);
  const im = await loadImage(file), w = im.naturalWidth, h = im.naturalHeight;
  const cv = document.createElement('canvas'), c = cv.getContext('2d');
  if (opt.square) {
    cv.width = cv.height = opt.square;
    const s = Math.min(w, h);
    c.drawImage(im, (w - s) / 2, (h - s) / 2, s, s, 0, 0, opt.square, opt.square);
  } else {
    const k = Math.min(1, (opt.max || 1280) / Math.max(w, h));
    cv.width = Math.max(1, Math.round(w * k)); cv.height = Math.max(1, Math.round(h * k));
    c.drawImage(im, 0, 0, cv.width, cv.height);
  }
  let out = cv.toDataURL('image/webp', 0.88);
  if (!out.startsWith('data:image/webp')) out = cv.toDataURL('image/png');
  return out;
}
async function setImageFromFile(file, id) {
  try {
    const url = await fileToDataUrl(file, { max: 1280 });
    const b = byId(id); if (!b || b.type !== 'img') return;
    pushHistory(null); b.src = url; if (!b.alt) b.alt = '';
    rerenderCard(id); renderPreviewBlock(id); markDirty();
    toast('이미지를 추가했습니다. (가로 최대 1280px로 압축, 약 ' + kb(url.length) + ')');
  } catch (err) { toast(err.message || '이미지를 불러오지 못했습니다.'); }
}
$('#fileImg').addEventListener('change', e => {
  const f = e.target.files[0]; e.target.value = '';
  if (f && imgTarget) setImageFromFile(f, imgTarget);
});
document.addEventListener('paste', e => {
  if (e.defaultPrevented) return;
  const cd = e.clipboardData; if (!cd) return;
  if (cd.getData('text/plain')) return;
  const item = Array.from(cd.items || []).find(i => i.kind === 'file' && /^image\//.test(i.type));
  if (!item) return;
  const f = item.getAsFile(); if (!f) return;
  e.preventDefault();
  const act = activeId && byId(activeId);
  if (act && act.type === 'img' && !act.src) setImageFromFile(f, act.id);
  else { const b = addBlock('img'); setImageFromFile(f, b.id); }
});

/* =====================================================================
 * 11. 모달 · 토스트
 * ===================================================================== */
const modalRoot = $('#modalRoot');
let modalClose = null;
function openModal(html) {
  closeModal();
  const w = document.createElement('div');
  w.className = 'modal-wrap'; w.innerHTML = '<div class="modal" role="dialog" aria-modal="true">' + html + '</div>';
  modalRoot.appendChild(w);
  return w;
}
function closeModal() { modalRoot.innerHTML = ''; if (modalClose) { const f = modalClose; modalClose = null; f(); } }
function ask(msg, opt) {
  opt = opt || {};
  return new Promise(res => {
    const w = openModal('<h3>' + esc(opt.title || '확인') + '</h3><p>' + esc(msg) + '</p><div class="modal-foot"><button type="button" class="btn" data-x="0">' + esc(opt.cancel || '취소') +
      '</button><button type="button" class="btn ' + (opt.danger ? 'danger' : 'primary') + '" data-x="1">' + esc(opt.ok || '확인') + '</button></div>');
    let done = false;
    const fin = v => { if (done) return; done = true; modalClose = null; modalRoot.innerHTML = ''; res(v); };
    modalClose = () => fin(false);
    w.addEventListener('click', e => { const x = e.target.closest('[data-x]'); if (x) fin(x.dataset.x === '1'); });
    const ok = $('[data-x="1"]', w); ok && ok.focus();
  });
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') { if (modalRoot.firstChild) closeModal(); closePalette(); } });

let toastT = 0;
function toast(msg, action) {
  const t = $('#toast');
  t.innerHTML = '<span>' + esc(msg) + '</span>' + (action ? '<button type="button">' + esc(action.label) + '</button>' : '');
  t.hidden = false;
  const btn = $('button', t);
  if (btn) btn.onclick = () => { t.hidden = true; action.fn(); };
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, action ? 7000 : 3200);
}

/* ---- 캐릭터 편집 모달 ---- */
function prevEntry(s, dir, text) {
  const av = '<span class="avatar" aria-hidden="true"' + (s.icon ? ' style="background:url(&quot;' + escA(cssUrl(s.icon)) + '&quot;) center/cover no-repeat ' + s.accent + '"' : '') + '>' + (s.icon ? '' : '<span class="avatar-icon"></span>') + '</span>';
  const body = '<div class="dialog-body"><div class="speaker" style="color:' + s.nameColor + '">' + esc(s.name || '이름') + '</div><div class="bubble" style="color:' + s.textColor + '">' + esc(text) + '</div></div>';
  return '<div class="entry dialog ' + dir + '" style="--accent:' + s.accent + ';--bubble:' + s.bubble + '">' + (dir === 'in' ? av + body : body + av) + '</div>';
}
let iconCb = null;
$('#fileIcon').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f || !iconCb) return;
  try { iconCb(await fileToDataUrl(f, { square: 128 })); } catch (err) { toast(err.message || '이미지를 불러오지 못했습니다.'); }
});
function openCharModal(id) {
  const ex = id ? charOf(id) : null;
  const m = ex ? Object.assign({}, ex) : { name: '', icon: '', accent: '#9fa5d3', bubble: '#29344c', nameColor: '#ffffff', textColor: '#ffffff', dir: 'in' };
  const used = ex ? S.blocks.filter(b => (b.type === 'in' || b.type === 'out') && b.charId === ex.id && !b.snap).length : 0;
  const colorRow = (key, label) => '<div class="mrow"><span class="l">' + label + '</span><input type="color" data-ck="' + key + '" value="' + m[key] + '"><input class="inp hex" data-ct="' + key + '" value="' + m[key] + '" maxlength="7" spellcheck="false"></div>';
  const w = openModal(
    '<h3>' + (ex ? '캐릭터 수정' : '캐릭터 추가') + '</h3>' +
    '<div class="mrow"><label class="l" for="cmName">캐릭터 이름</label><input class="inp" id="cmName" maxlength="40" placeholder="예: 칸노 유라기" value="' + escA(m.name) + '"></div>' +
    '<div class="mrow"><span class="l">프로필 이미지</span><span class="cm-av" id="cmAv"></span><div class="cm-icon-btns"><button type="button" class="btn small" id="cmUp">파일 업로드</button><button type="button" class="btn small" id="cmClr">제거</button></div></div>' +
    '<div class="mrow"><span class="l">이미지 URL</span><input class="inp" id="cmUrl" placeholder="https://... (권장)" value="' + (isData(m.icon) ? '' : escA(m.icon)) + '"></div>' +
    '<div class="hint" id="cmIconHint" style="margin:-2px 0 4px 118px"></div>' +
    colorRow('accent', '상징색') + colorRow('bubble', '말풍선 배경색') + colorRow('nameColor', '이름표 글자색') + colorRow('textColor', '말풍선 글자색') +
    '<div class="mrow"><span class="l">기본 방향</span><div class="seg mini" id="cmDir"><button type="button" data-v="in">수신 (왼쪽)</button><button type="button" data-v="out">발신 (오른쪽)</button></div></div>' +
    (ex ? '<label class="check"><input type="checkbox" id="cmReflect" checked> 이미 만든 로그의 이 캐릭터 블록(' + used + '개)에도 변경사항 반영</label>' : '') +
    '<div class="vnlog cm-preview" id="cmPrev"></div>' +
    '<div class="modal-foot">' + (ex ? '<button type="button" class="btn danger" id="cmDel">삭제</button>' : '') + '<span class="grow"></span><button type="button" class="btn" id="cmCancel">취소</button><button type="button" class="btn primary" id="cmSave">저장</button></div>');
  const q = s => $(s, w);
  const paint = () => {
    const s = norm(m);
    q('#cmPrev').innerHTML = prevEntry(s, 'in', '수신 말풍선 미리보기입니다.') + prevEntry(s, 'out', '발신 말풍선 미리보기입니다.');
    const av = q('#cmAv'); av.style.setProperty('--ac', s.accent); av.style.backgroundImage = s.icon ? 'url("' + cssUrl(s.icon) + '")' : '';
    $$('#cmDir button', w).forEach(x => x.classList.toggle('on', x.dataset.v === m.dir));
    q('#cmIconHint').textContent = isData(m.icon) ? '업로드한 이미지는 128px로 줄여 코드에 포함됩니다. (약 ' + kb(m.icon.length) + ')' : '';
  };
  paint();
  q('#cmName').addEventListener('input', e => { m.name = e.target.value; paint(); });
  q('#cmUrl').addEventListener('input', e => { m.icon = cleanUrl(e.target.value); paint(); });
  q('#cmUp').onclick = () => { iconCb = url => { m.icon = url; q('#cmUrl').value = ''; paint(); }; $('#fileIcon').click(); };
  q('#cmClr').onclick = () => { m.icon = ''; q('#cmUrl').value = ''; paint(); };
  $$('[data-ck]', w).forEach(i => i.addEventListener('input', () => { m[i.dataset.ck] = i.value; q('[data-ct="' + i.dataset.ck + '"]').value = i.value; paint(); }));
  $$('[data-ct]', w).forEach(i => {
    i.addEventListener('input', () => { let v = i.value.trim(); if (v && v[0] !== '#') v = '#' + v; const h = toHex(v); if (/^#[0-9a-f]{6}$/.test(h) && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) { m[i.dataset.ct] = h; q('[data-ck="' + i.dataset.ct + '"]').value = h; paint(); } });
    i.addEventListener('blur', () => { i.value = m[i.dataset.ct]; });
  });
  $$('#cmDir button', w).forEach(x => x.onclick = () => { m.dir = x.dataset.v; paint(); });
  q('#cmCancel').onclick = closeModal;
  q('#cmSave').onclick = () => {
    const name = m.name.trim();
    if (!name) { toast('캐릭터 이름을 입력하세요.'); q('#cmName').focus(); return; }
    const data = norm(Object.assign({}, m, { name }));
    data.dir = m.dir === 'out' ? 'out' : 'in';
    if (ex) {
      const reflect = q('#cmReflect').checked;
      if (!reflect) {
        const old = norm(ex);
        pushHistory(null);
        S.blocks.forEach(b => { if ((b.type === 'in' || b.type === 'out') && b.charId === ex.id && !b.snap) b.snap = Object.assign({}, old); });
      }
      Object.assign(ex, data);
    } else chars.push(Object.assign({ id: uid() }, data));
    saveChars(); closeModal(); renderChars(); renderList(); renderPreviewFull(); markDirty();
    toast(ex ? '캐릭터를 수정했습니다.' : '캐릭터를 추가했습니다.');
  };
  if (ex) q('#cmDel').onclick = async () => {
    const n = S.blocks.filter(b => (b.type === 'in' || b.type === 'out') && b.charId === ex.id && !b.snap).length;
    const ok = await ask(n ? '이 캐릭터를 사용 중인 블록이 ' + n + '개 있습니다.\n삭제해도 해당 블록은 현재 모습 그대로 유지됩니다. 삭제할까요?' : '"' + ex.name + '" 캐릭터를 삭제할까요?', { ok: '삭제', danger: true });
    if (!ok) return;
    if (n) { pushHistory(null); const old = norm(ex); S.blocks.forEach(b => { if (b.charId === ex.id && !b.snap && (b.type === 'in' || b.type === 'out')) { b.snap = Object.assign({}, old); b.charId = ''; } }); }
    chars = chars.filter(c => c.id !== ex.id); saveChars();
    renderChars(); renderList(); renderPreviewFull(); markDirty(); toast('캐릭터를 삭제했습니다.');
  };
  setTimeout(() => q('#cmName').focus(), 30);
}

/* =====================================================================
 * 12. 저장 / 불러오기 / 새로 만들기 / 자동 저장 / 최근 작업
 * ===================================================================== */
function exportData() {
  return {
    app: 'vnlog-generator', version: 1, savedAt: new Date().toISOString(),
    title: S.title, frame: { width: S.width, mobileExpand: S.expand },
    characters: chars.map(c => Object.assign({}, c)),
    blocks: S.blocks.map(b => Object.assign({}, b))
  };
}
function normalize(d) {
  if (!d || typeof d !== 'object' || !Array.isArray(d.blocks)) return null;
  const blocks = d.blocks.map(normBlock).filter(Boolean);
  return {
    title: typeof d.title === 'string' ? d.title.slice(0, 80) : '',
    width: d.frame && d.frame.width === 'full' ? 'full' : 'basic',
    expand: !!(d.frame && d.frame.mobileExpand),
    chars: Array.isArray(d.characters) ? d.characters.map(normChar).filter(Boolean) : [],
    blocks
  };
}
async function loadData(d, opt) {
  opt = opt || {};
  const n = normalize(d);
  if (!n) { toast('올바른 로그 파일이 아닙니다.'); return false; }
  const diff = [];
  n.chars.forEach(c => {
    const ex = charOf(c.id);
    if (!ex) chars.push(c);
    else if (JSON.stringify(norm(ex)) !== JSON.stringify(norm(c)) || ex.dir !== c.dir) diff.push(c);
  });
  if (diff.length) {
    const use = await ask('저장 파일의 캐릭터 설정 ' + diff.length + '개(' + diff.map(c => c.name).join(', ') + ')가 현재 캐릭터 목록과 다릅니다.\n파일에 저장된 설정으로 덮어쓸까요?', { ok: '파일 설정 사용', cancel: '현재 설정 유지' });
    if (use) diff.forEach(c => Object.assign(charOf(c.id), c));
  }
  saveChars();
  S.title = n.title; S.width = n.width; S.expand = n.expand; S.blocks = n.blocks;
  if (S.blocks.length > 80) S.blocks.forEach((b, i) => { b.collapsed = i > 0; });
  activeId = null; resetHistory();
  logId = opt.id || uid();
  dirty = !!opt.dirty;
  renderAll();
  if (opt.save !== false) scheduleSave();
  return true;
}
function download(name, text, mime) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
const fileBase = () => (S.title.trim() || '게임로그').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60);
const stamp = () => { const d = new Date(); return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' + pad2(d.getHours()) + pad2(d.getMinutes()); };

function saveFile() {
  download(fileBase() + '-' + stamp() + '.json', JSON.stringify(exportData()), 'application/json');
  dirty = false; scheduleSave(); toast('로그를 JSON 파일로 저장했습니다.');
}
async function newLog() {
  if (dirty && S.blocks.length) {
    const ok = await ask('저장하지 않은 변경사항이 있습니다.\n새로 만들면 현재 로그는 "최근 작업"에만 남습니다. 계속할까요?', { ok: '새로 만들기', danger: true });
    if (!ok) return;
  }
  await saveNow();
  S.title = ''; S.width = 'basic'; S.expand = false; S.blocks = [];
  activeId = null; logId = uid(); dirty = false; resetHistory();
  kv.set('current', logId).catch(() => {});
  renderAll(); setSaveText('새 로그를 시작했습니다');
  toast('새 로그를 만들었습니다. 캐릭터 목록은 그대로 유지됩니다.');
}

let saveT = 0, saveQ = Promise.resolve();
function setSaveText(t) { $('#saveState').textContent = t; }
function scheduleSave() {
  setSaveText('저장 중…');
  clearTimeout(saveT);
  saveT = setTimeout(() => { saveQ = saveQ.then(saveNow).catch(() => setSaveText('자동 저장 실패 (저장 공간 부족)')); }, 700);
}
async function saveNow() {
  clearTimeout(saveT);
  let idx = (await kv.get('index')) || [];
  idx = idx.filter(x => x.id !== logId);
  if (S.blocks.length || S.title) {
    try {
      await kv.set('log:' + logId, exportData());
      idx.unshift({ id: logId, title: S.title, updated: Date.now(), count: S.blocks.length });
    } catch (e) { setSaveText('자동 저장 실패 (저장 공간 부족)'); return; }
  } else await kv.del('log:' + logId);
  while (idx.length > 12) { const old = idx.pop(); await kv.del('log:' + old.id); }
  await kv.set('index', idx);
  await kv.set('current', logId);
  const d = new Date();
  setSaveText('자동 저장됨 · ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) + (dirty ? ' (JSON 파일로는 아직 저장 안 됨)' : ''));
}
async function openRecent() {
  await saveNow();
  const idx = (await kv.get('index')) || [];
  const fmt = t => { const d = new Date(t); return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()); };
  const w = openModal('<h3>최근 작업</h3><div id="rcList">' + (idx.length ? idx.map(x =>
    '<div class="recent-item" data-id="' + escA(x.id) + '"><div class="ri-main"><div class="ri-t">' + esc(x.title || '(제목 없음)') + (x.id === logId ? ' · 현재' : '') + '</div><div class="ri-s">블록 ' + x.count + '개 · ' + fmt(x.updated) + '</div></div>' +
    '<button type="button" class="btn small" data-o="1"' + (x.id === logId ? ' disabled' : '') + '>열기</button><button type="button" class="btn small danger" data-d="1"' + (x.id === logId ? ' disabled' : '') + '>삭제</button></div>').join('') :
    '<p>최근 작업이 없습니다.</p>') + '</div><p class="hint" style="margin-top:8px">브라우저에 자동 저장된 최근 12개의 로그입니다. 다른 기기에서 쓰려면 "로그 저장"으로 JSON 파일을 받아두세요.</p><div class="modal-foot"><button type="button" class="btn" id="rcClose">닫기</button></div>');
  $('#rcClose', w).onclick = closeModal;
  w.addEventListener('click', async e => {
    const it = e.target.closest('.recent-item'); if (!it) return;
    const id = it.dataset.id;
    if (e.target.closest('[data-o]')) {
      const d = await kv.get('log:' + id);
      if (!d) { toast('저장된 데이터를 찾을 수 없습니다.'); return; }
      closeModal(); await saveNow();
      if (await loadData(d, { id, save: false })) toast('최근 작업을 열었습니다.');
    } else if (e.target.closest('[data-d]')) {
      if (!(await ask('이 최근 작업을 삭제할까요? 복구할 수 없습니다.', { ok: '삭제', danger: true }))) { openRecent(); return; }
      await kv.del('log:' + id);
      const idx2 = ((await kv.get('index')) || []).filter(x => x.id !== id); await kv.set('index', idx2);
      openRecent();
    }
  });
}

/* =====================================================================
 * 13. 코드 탭
 * ===================================================================== */
const codeOut = $('#codeOut');
let codeDirty = true;
const scheduleCode = (() => { let t = 0; return () => { codeDirty = true; if ($('#tabCode').hidden) return; clearTimeout(t); t = setTimeout(refreshCode, 350); }; })();
function refreshCode() {
  const code = genCode();
  codeOut.value = code; codeDirty = false;
  const bytes = new Blob([code]).size, dataN = (code.match(/data:image\//g) || []).length;
  const emptyImg = S.blocks.filter(b => b.type === 'img' && !cleanUrl(b.src)).length;
  let info = '코드 크기 <b>' + kb(bytes) + '</b> · ' + code.split('\n').length.toLocaleString() + '줄 · 블록 ' + S.blocks.length + '개';
  if (emptyImg) info += ' · 이미지가 비어 있는 블록 ' + emptyImg + '개는 코드에서 제외됩니다';
  if (dataN) info += '<div class="warn">Data URL 이미지 ' + dataN + '개가 코드에 포함되어 있습니다. 용량이 커져 티스토리 저장 시 오류가 날 수 있으니, <b>이미지를 따로 업로드한 뒤 URL 방식</b>을 쓰는 것을 권장합니다.</div>';
  else if (bytes > 400 * 1024) info += '<div class="warn">코드가 매우 큽니다. 티스토리 저장 제한에 걸리면 글을 여러 편으로 나누어 올려 보세요.</div>';
  $('#codeInfo').innerHTML = info;
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* fallback */ }
  try { codeOut.focus(); codeOut.select(); const ok = document.execCommand('copy'); codeOut.setSelectionRange(0, 0); return ok; } catch (e) { return false; }
}

/* =====================================================================
 * 14. 화면 전환 · 테마 · 초기화
 * ===================================================================== */
function setView(v) {
  view = v;
  const code = v === 'code';
  $('#app').dataset.view = v;
  $('#tabPreview').hidden = code;
  $('#tabCode').hidden = !code;
  $$('.tabs [data-tab]').forEach(x => x.classList.toggle('on', x.dataset.tab === (code ? 'code' : 'preview')));
  $$('#bottomBar button').forEach(x => x.classList.toggle('on', x.dataset.view === v));
  if (code) refreshCode(); else if (v === 'preview') markPv(true);
}
matchMedia('(min-width:901px)').addEventListener('change', () => setView(view === 'edit' && matchMedia('(min-width:901px)').matches ? 'preview' : view));
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  $('#btnTheme').textContent = t === 'dark' ? '☀️' : '🌙';
  try { localStorage.setItem('vnlog.theme', t); } catch (e) { /* noop */ }
}

function bind() {
  $('#btnSave').onclick = saveFile;
  $('#btnLoad').onclick = () => $('#fileJson').click();
  $('#fileJson').addEventListener('change', async e => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    let d;
    try { d = JSON.parse(await f.text()); } catch (err) { toast('JSON 파일을 읽을 수 없습니다.'); return; }
    if (dirty && S.blocks.length && !(await ask('저장하지 않은 변경사항이 있습니다.\n불러오면 현재 로그는 "최근 작업"에만 남습니다. 계속할까요?', { ok: '불러오기' }))) return;
    await saveNow();
    if (await loadData(d, { dirty: false })) toast('로그를 불러왔습니다. (블록 ' + S.blocks.length + '개)');
  });
  $('#btnNew').onclick = newLog;
  $('#btnRecent').onclick = openRecent;
  $('#btnUndo').onclick = undo; $('#btnRedo').onclick = redo;
  $('#btnTheme').onclick = () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  $('#logTitle').addEventListener('input', e => { S.title = e.target.value; markDirty(); });
  $('#segFrame').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b || S.width === b.dataset.v) return;
    pushHistory(null); S.width = b.dataset.v; syncChrome(); applyPvCss(); markDirty();
  });
  $('#chkExpand').addEventListener('change', e => { pushHistory(null); S.expand = e.target.checked; applyPvCss(); markDirty(); });
  $('#segInsert').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; insertMode = b.dataset.v; syncChrome(); });
  $('#btnAddChar').onclick = () => openCharModal(null);
  $('#charList').addEventListener('click', e => { const c = e.target.closest('[data-char]'); if (c) openCharModal(c.dataset.char); });
  $$('[data-add]').forEach(b => b.addEventListener('click', () => addBlock(b.dataset.add)));
  $('#btnFoldAll').onclick = () => foldAll(true);
  $('#btnUnfoldAll').onclick = async () => {
    if (S.blocks.length > 120 && !(await ask('블록이 ' + S.blocks.length + '개입니다. 모두 펼치면 편집 화면이 느려질 수 있습니다. 계속할까요?', { ok: '펼치기' }))) return;
    foldAll(false);
  };
  $$('.tabs [data-tab]').forEach(b => b.addEventListener('click', () => setView(b.dataset.tab)));
  $$('#bottomBar button').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
  $('#pvDevice').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    $$('#pvDevice button').forEach(x => x.classList.toggle('on', x === b));
    $('#pvStage').classList.toggle('mobile', b.dataset.v === 'mobile');
  });
  $('#btnCodeRefresh').onclick = () => { refreshCode(); toast('코드를 새로 만들었습니다.'); };
  $('#btnCodeCopy').onclick = async () => { refreshCode(); toast((await copyText(codeOut.value)) ? '전체 코드를 복사했습니다. 티스토리 HTML 모드에 붙여넣으세요.' : '복사에 실패했습니다. 코드 영역을 직접 선택해 복사하세요.'); };
  $('#btnCodeHtml').onclick = () => download(fileBase() + '.html', standaloneHtml(), 'text/html');
  $('#btnCodeTxt').onclick = () => { refreshCode(); download(fileBase() + '.txt', codeOut.value, 'text/plain'); };
  document.addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const k = e.key.toLowerCase(), t = e.target;
    if (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    if (k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (k === 'y') { e.preventDefault(); redo(); }
    else if (k === 's') { e.preventDefault(); saveFile(); }
  });
}

async function init() {
  const th = (() => { try { return localStorage.getItem('vnlog.theme'); } catch (e) { return null; } })();
  applyTheme(th || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  $('#vnBase').textContent = buildCss(makeCtx(), { all: true, noExpand: true }).replace(/@media[^{]*\{[\s\S]*$/, '').replace(/max-width:(none|900px)/, 'max-width:none');
  chars = loadChars() || sampleChars();
  saveChars();
  bind();
  initPreview();
  setView(matchMedia('(min-width:901px)').matches ? 'preview' : 'edit');
  let restored = false;
  try {
    const cur = await kv.get('current');
    const d = cur && await kv.get('log:' + cur);
    if (d && await loadData(d, { id: cur, save: false })) { restored = true; setSaveText('자동 저장된 작업을 복구했습니다'); toast('이전에 작업하던 로그를 복구했습니다.'); }
  } catch (e) { /* noop */ }
  if (!restored) {
    const mob = chars.length ? chars[0].id : '';
    S.blocks = [
      Object.assign(newBlock('narr'), { html: '게임 로그 말풍선 생성기에 오신 것을 환영합니다. 아래 버튼으로 블록을 추가해 보세요.' }),
      Object.assign(newBlock('in'), { charId: mob, html: '――어라. 처음 오셨나요?' }),
      Object.assign(newBlock('out'), { charId: mob, html: '네, 안녕하세요!\n<b>일부 글자만</b> <span style="color:#ff4d4f">색을 바꿀 수도</span> 있어요.' })
    ];
    S.blocks.forEach(b => { if (b.html) b.html = sanitizeModel(b.html); });
    renderAll(); setSaveText('자동 저장 대기 중');
  }
  updateUndoUi();
}

window.__vnlog = { get state() { return S; }, get chars() { return chars; }, genCode, sanitizeModel };
init();
})();
