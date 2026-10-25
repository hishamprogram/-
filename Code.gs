// نظام الدوام والمتابعة - نقطة المزامنة السحابية (Google Apps Script Web App)
// النشر: Deploy > New deployment > Web app > Execute as: Me > Who has access: Anyone
// ثم انسخ رابط /exec والصقه في إعدادات التطبيق.
// عند تعديل الكود: Deploy > Manage deployments > Edit > New version.

const FILE_NAME = 'hr-attendance-data.json';
const SECRET = 'Remas-1d7e76f17adb-d5fdb4fa'; // مفتاح أمان اختياري (اتركه فارغًا لتعطيله)
const SECURE_MODE = true; // الوضع الآمن: دخول من الخادم + كل مستخدم يستلم بياناته المسموحة فقط
const COLLS = ['users', 'depts', 'emps', 'viol', 'vtypes', 'rates', 'ropen', 'rlaws', 'notes', 'nreads', 'anotes', 'log'];

function doGet(e) {
  return out_({ ok: true, service: 'hr-sync', time: new Date().toISOString() });
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(25000);
  } catch (err) {
    return out_({ ok: false, error: 'الخادم مشغول، أعد المحاولة' });
  }
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (SECRET && req.key !== SECRET) return out_({ ok: false, error: 'مفتاح الأمان غير صحيح' });
    if (req.action === 'ping') return out_({ ok: true, pong: true, secure: SECURE_MODE });

    let data = readDb_();

    if (!SECURE_MODE) {
      if (req.action === 'sync' && req.data) {
        data = data ? mergeDb_(data, req.data) : normalize_(req.data);
        writeDb_(data);
        monthlyBackup_(data);
      }
      return out_({ ok: true, data: data || null, at: Date.now() });
    }

    // ===== الوضع الآمن: التحقق من الهوية وتصفية البيانات حسب الصلاحية =====
    if (req.action === 'login') {
      if (!data) return out_({ ok: false, code: 'NODATA', error: 'لا توجد بيانات على الخادم بعد. ارفع البيانات الأولى من جهاز المدير.' });
      const lim = checkLock_(req);
      if (lim) return out_({ ok: false, code: 'LOCK', error: lim });
      const A = verifyLogin_(data, req);
      if (!A) { noteFail_(req); return out_({ ok: false, code: 'BAD', error: 'بيانات الدخول غير صحيحة أو الحساب غير مفعّل' }); }
      clearFail_(req);
      const rp = reply_(data, A, {}); return out_({ ok: true, secure: true, token: tokenFor_(A.k, A.rec), k: A.k, id: A.rec.id, data: rp.data, full: true, seq: rp.seq, sig: rp.sig, at: Date.now() });
    }
    if (req.action === 'sync') {
      if (!data) {
        // أول رفع للبيانات فقط (لا توجد نسخة على الخادم)
        if (req.data && req.boot) { data = normalize_(req.data); writeDb_(data); return out_({ ok: true, data: data, at: Date.now() }); }
        return out_({ ok: false, code: 'NODATA', error: 'لا توجد بيانات على الخادم بعد' });
      }
      const A = verifyToken_(data, req);
      if (!A) return out_({ ok: false, code: 'AUTH', error: 'انتهت الجلسة أو التطبيق قديم — سجّل الدخول من جديد' });
      if (req.data) {
        data = mergeIncoming_(data, normalize_(req.data), A);
        writeDb_(data);
        monthlyBackup_(data);
      }
      return out_(reply_(data, A, req));
    }
    return out_({ ok: false, code: 'AUTH', error: 'طلب غير مسموح' });
  } catch (err) {
    return out_({ ok: false, error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

// ---------- الإدخال والإخراج ----------
function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function findFile_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('FILE_ID');
  if (id) {
    try {
      const f = DriveApp.getFileById(id);
      if (!f.isTrashed()) return f;
    } catch (err) {
      // يُعاد البحث بالاسم
    }
  }
  const it = DriveApp.getFilesByName(FILE_NAME);
  while (it.hasNext()) {
    const f = it.next();
    if (!f.isTrashed()) { props.setProperty('FILE_ID', f.getId()); return f; }
  }
  return null;
}

function readDb_() {
  const f = findFile_();
  if (!f) return null;
  const txt = f.getBlob().getDataAsString('UTF-8');
  if (!txt) return null;
  return normalize_(JSON.parse(txt));
}

function writeDb_(db) {
  const content = JSON.stringify(db);
  const f = findFile_();
  if (f) {
    f.setContent(content);
  } else {
    const nf = DriveApp.createFile(FILE_NAME, content, MimeType.PLAIN_TEXT);
    PropertiesService.getScriptProperties().setProperty('FILE_ID', nf.getId());
  }
}

function monthlyBackup_(db) {
  const name = 'hr-backup-' + Utilities.formatDate(new Date(), 'GMT', 'yyyy-MM') + '.json';
  const it = DriveApp.getFilesByName(name);
  if (!it.hasNext()) DriveApp.createFile(name, JSON.stringify(db), MimeType.PLAIN_TEXT);
}

// ---------- الدمج الذكي (مطابق لمنطق التطبيق) ----------
function normalize_(o) {
  o = o || {};
  COLLS.forEach(function (c) { if (!Array.isArray(o[c])) o[c] = []; });
  if (!o.att || typeof o.att !== 'object') o.att = {};
  if (!o.presence || typeof o.presence !== 'object') o.presence = {};
  if (!o.settings || typeof o.settings !== 'object') o.settings = { u: 0 };
  o.v = 2;
  return o;
}

function mergeColl_(a, b) {
  const m = {};
  (a || []).forEach(function (r) { m[r.id] = r; });
  (b || []).forEach(function (r) {
    const o = m[r.id];
    if (!o || (r.u || 0) > (o.u || 0)) m[r.id] = r;
  });
  return Object.keys(m).map(function (k) { return m[k]; });
}

function mergeAtt_(a, b) {
  const win = (b.u || 0) > (a.u || 0) ? b : a;
  const lose = win === a ? b : a;
  const copy = {};
  Object.keys(win).forEach(function (k) { copy[k] = win[k]; });
  if (win.d) {
    copy.e = {};
  } else {
    const e = {};
    Object.keys(lose.e || {}).forEach(function (k) { e[k] = lose.e[k]; });
    Object.keys(win.e || {}).forEach(function (k) { e[k] = win.e[k]; });
    copy.e = e;
  }
  return copy;
}

function mergeDb_(L, R) {
  L = normalize_(L);
  R = normalize_(R);
  const o = {};
  Object.keys(L).forEach(function (k) { o[k] = L[k]; });
  COLLS.forEach(function (c) { o[c] = mergeColl_(L[c], R[c]); });
  o.log = o.log.sort(function (p, q) { return (q.u || 0) - (p.u || 0); });

  o.att = {};
  Object.keys(L.att).forEach(function (k) { o.att[k] = L.att[k]; });
  Object.keys(R.att).forEach(function (k) {
    o.att[k] = o.att[k] ? mergeAtt_(o.att[k], R.att[k]) : R.att[k];
  });

  o.settings = ((R.settings.u || 0) > (L.settings.u || 0)) ? R.settings : L.settings;

  const now = Date.now();
  o.presence = {};
  Object.keys(L.presence).forEach(function (k) { o.presence[k] = L.presence[k]; });
  Object.keys(R.presence).forEach(function (k) {
    if (!o.presence[k] || R.presence[k].t > o.presence[k].t) o.presence[k] = R.presence[k];
  });
  Object.keys(o.presence).forEach(function (k) {
    if (now - o.presence[k].t > 86400000) delete o.presence[k];
  });
  o.v = 2;
  return o;
}

// ===================== الوضع الآمن =====================
function sha256_(s) {
  const b = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8);
  return b.map(function (x) { return ('0' + (x & 255).toString(16)).slice(-2); }).join('');
}
// نفس بصمة التطبيق (SHA-256، أو البديل عند غياب crypto في المتصفح)
function hashLike_(stored, s) {
  if (String(stored || '').charAt(0) === 'x') {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return 'x' + h;
  }
  return sha256_(s);
}
function normNo_(s) {
  return String(s == null ? '' : s)
    .replace(/[٠-٩]/g, function (c) { return '٠١٢٣٤٥٦٧٨٩'.indexOf(c); })
    .replace(/[۰-۹]/g, function (c) { return '۰۱۲۳۴۵۶۷۸۹'.indexOf(c); }).trim();
}
function salt_() {
  const p = PropertiesService.getScriptProperties();
  let s = p.getProperty('SALT');
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); p.setProperty('SALT', s); }
  return s;
}
function tokenFor_(k, rec) {
  return sha256_(salt_() + '|' + k + '|' + rec.id + '|' + (rec.pass || '') + '|' + (rec.def ? 1 : 0));
}
function verifyLogin_(db, req) {
  const un = String(req.un || '').trim(), pw = String(req.pw == null ? '' : req.pw);
  if (!un || !pw) return null;
  if (req.type === 'e') {
    const no = normNo_(un);
    const em = db.emps.filter(function (x) { return !x.d && String(normNo_(x.no)) === no; })[0];
    if (!em || !em.portal || em.active === false) return null;
    const ok = em.pass ? hashLike_(em.pass, 'e:' + no + ':' + pw) === em.pass : pw === String(em.no);
    return ok ? { k: 'e', rec: em } : null;
  }
  const u = db.users.filter(function (x) { return !x.d && x.username === un; })[0];
  if (!u) return null;
  const ok = u.def ? pw === 'admin123' : hashLike_(u.pass, u.username + ':' + pw) === u.pass;
  return ok ? { k: 'u', rec: u } : null;
}
function verifyToken_(db, req) {
  const w = req.who || {};
  if (!req.tok || (w.k !== 'u' && w.k !== 'e') || !w.id) return null;
  const list = w.k === 'u' ? db.users : db.emps;
  const rec = list.filter(function (x) { return x.id === w.id && !x.d; })[0];
  if (!rec) return null;
  if (w.k === 'e' && (!rec.portal || rec.active === false)) return null;
  if (tokenFor_(w.k, rec) !== req.tok) return null;
  return { k: w.k, rec: rec };
}
// حماية من تخمين كلمات المرور: 8 محاولات خاطئة = إيقاف 10 دقائق لهذا الاسم
function failKey_(req) { return 'F_' + String(req.type || 'u') + '_' + String(req.un || '').toLowerCase().slice(0, 40); }
function checkLock_(req) {
  const v = PropertiesService.getScriptProperties().getProperty(failKey_(req));
  if (!v) return '';
  const o = JSON.parse(v);
  if (o.n >= 8 && Date.now() - o.t < 600000) return 'محاولات كثيرة خاطئة. أعد المحاولة بعد 10 دقائق.';
  return '';
}
function noteFail_(req) {
  const p = PropertiesService.getScriptProperties(), k = failKey_(req), v = p.getProperty(k);
  let o = v ? JSON.parse(v) : { n: 0, t: 0 };
  if (Date.now() - o.t > 600000) o = { n: 0, t: 0 };
  o.n++; o.t = Date.now();
  p.setProperty(k, JSON.stringify(o));
}
function clearFail_(req) { PropertiesService.getScriptProperties().deleteProperty(failKey_(req)); }

function myKey_(A) { return A.k + A.rec.id; }
function scopeOf_(A) {
  // all = كل الأقسام؛ set = الأقسام المسموحة
  if (A.k === 'e') { const s = {}; s[A.rec.dept] = 1; return { all: false, set: s }; }
  const d = A.rec.depts || [];
  if (A.rec.role === 'admin' || !d.length) return { all: true, set: {} };
  const s = {}; d.forEach(function (x) { s[x] = 1; });
  return { all: false, set: s };
}
function inScope_(sc, dept) { return sc.all || !!sc.set[dept]; }
function empDeptMap_(db) { const m = {}; db.emps.forEach(function (e) { m[e.id] = e.dept; }); return m; }
function strip_(o, keys) { const c = {}; Object.keys(o).forEach(function (k) { if (keys.indexOf(k) < 0) c[k] = o[k]; }); return c; }

// ما يُرسَل إلى جهاز المستخدم فقط
function scoped_(db, A) {
  if (A.k === 'u' && A.rec.role === 'admin') return db;
  const me = myKey_(A), sc = scopeOf_(A), dm = empDeptMap_(db), P = (A.k === 'u' ? A.rec.perms : {}) || {};
  const o = normalize_({});
  o.settings = db.settings; o.v = 2;
  const portal = (db.settings && db.settings.portal) || {};
  o.notes = db.notes.filter(function (n) { return n.to === me || n.to === '*' + A.k || n.from === me; });
  o.nreads = db.nreads.filter(function (r) { return String(r.id).slice(-(me.length + 1)) === '|' + me; });
  o.presence = db.presence;
  if (A.k === 'e') {
    const em = A.rec;
    o.emps = [em];
    o.depts = db.depts.filter(function (d) { return d.id === em.dept; });
    Object.keys(db.att).forEach(function (k) {
      if (k.split('|')[1] !== em.dept) return;
      const r = db.att[k], e = {};
      if (r.e && r.e[em.id] !== undefined) e[em.id] = r.e[em.id];
      const c = strip_(r, ['e']); c.e = e; o.att[k] = c;
    });
    if (portal.viol) o.viol = db.viol.filter(function (v) { return v.emp === em.id; });
    if (portal.rate) o.rates = db.rates.filter(function (v) { return v.emp === em.id; });
    return o;
  }
  const rateAny = P.rate_view || P.rate_do || P.rate_open || P.rate_laws;
  o.users = db.users.map(function (u) { return u.id === A.rec.id ? u : { id: u.id, username: u.username, name: u.name, role: u.role, d: u.d, u: u.u }; });
  o.depts = db.depts.filter(function (d) { return inScope_(sc, d.id); });
  o.emps = db.emps.filter(function (e) { return inScope_(sc, e.dept); }).map(function (e) { return strip_(e, ['pass']); });
  o.viol = db.viol.filter(function (v) { return inScope_(sc, dm[v.emp]) && (P.viol_view || v.by === A.rec.id); });
  o.vtypes = db.vtypes;
  o.rates = rateAny ? db.rates.filter(function (r) { return inScope_(sc, r.dept || dm[r.emp]) && (P.rate_view || r.by === A.rec.id); }) : [];
  o.ropen = rateAny ? db.ropen.filter(function (r) { return inScope_(sc, String(r.id).split('|')[1]); }) : [];
  o.rlaws = rateAny ? db.rlaws : [];
  o.anotes = db.anotes.filter(function (a) { return inScope_(sc, a.dept); });
  Object.keys(db.att).forEach(function (k) { if (inScope_(sc, k.split('|')[1])) o.att[k] = db.att[k]; });
  return o;
}

// دمج مع ترقيم خادمي: كل سجل يتغير يأخذ رقم _s أكبر، فيستلم كل جهاز التغييرات منذ آخر رقم عرفه
function mergeStamp_(L, R) {
  L = normalize_(L);
  const before = {};
  COLLS.forEach(function (c) { before[c] = {}; L[c].forEach(function (r) { before[c][r.id] = r; }); });
  const oldAtt = {}; Object.keys(R.att || {}).forEach(function (k) { const o = L.att[k]; oldAtt[k] = o ? JSON.stringify([o.u, o.e, o.d]) : ''; });
  const oldSet = L.settings;
  let seq = Number(L.seq) || 0;
  const o = mergeDb_(L, R);
  COLLS.forEach(function (c) { o[c].forEach(function (r) { if (before[c][r.id] !== r) r._s = ++seq; }); });
  Object.keys(oldAtt).forEach(function (k) {
    const n = o.att[k];
    if (n && JSON.stringify([n.u, n.e, n.d]) !== oldAtt[k]) n._s = ++seq;
  });
  if (o.settings !== oldSet) o.settings._s = ++seq;
  o.seq = seq;
  return o;
}
function sigOf_(db, A) {
  const r = A.rec;
  return sha256_(JSON.stringify([A.k, r.role || '', (r.depts || []).slice().sort(), r.perms || {}, r.portal || 0, (db.settings && db.settings.portal) || {}, r.dept || ''])).slice(0, 16);
}
// رد المزامنة: تفاضلي إن أمكن وإلا كامل
function reply_(db, A, req) {
  const sig = sigOf_(db, A), seq = Number(db.seq) || 0;
  const full = scoped_(db, A);
  const since = Number(req.since) || 0;
  if (!(req.delta && typeof req.since === 'number' && req.sig === sig && since <= seq)) {
    return { ok: true, data: full, full: true, seq: seq, sig: sig, at: Date.now() };
  }
  const d = normalize_({});
  COLLS.forEach(function (c) { d[c] = (full[c] || []).filter(function (r) { return (r._s || 0) > since; }); });
  Object.keys(full.att || {}).forEach(function (k) { if ((full.att[k]._s || 0) > since) d.att[k] = full.att[k]; });
  d.presence = full.presence || {};
  d.settings = (full.settings && (full.settings._s || 0) > since) ? full.settings : { u: 0 };
  return { ok: true, data: d, full: false, seq: seq, sig: sig, at: Date.now() };
}

function hasAny_(P, list) { for (let i = 0; i < list.length; i++) if (P[list[i]]) return true; return false; }

// ما يُقبل من جهاز المستخدم (كل شيء خارج الصلاحية يُتجاهل)
function mergeIncoming_(db, inc, A) {
  if (A.k === 'u' && A.rec.role === 'admin') return mergeStamp_(db, inc);
  const me = myKey_(A), sc = scopeOf_(A), dm = empDeptMap_(db), sub = normalize_({});
  const byId = function (list) { const m = {}; list.forEach(function (r) { m[r.id] = r; }); return m; };
  sub.presence = {};
  if (inc.presence && inc.presence[me]) sub.presence[me] = inc.presence[me];
  sub.nreads = inc.nreads.filter(function (r) { return String(r.id).slice(-(me.length + 1)) === '|' + me; });

  if (A.k === 'e') {
    const mine = inc.emps.filter(function (x) { return x.id === A.rec.id; })[0];
    if (mine && (mine.u || 0) > (A.rec.u || 0) && mine.pass) {
      const c = {}; Object.keys(A.rec).forEach(function (k) { c[k] = A.rec[k]; });
      c.pass = mine.pass; c.u = mine.u; sub.emps = [c];
    }
    return mergeStamp_(db, sub);
  }
  const P = A.rec.perms || {};
  const sEmp = byId(db.emps), sViol = byId(db.viol);
  // كلمة المرور الخاصة بالمستخدم فقط
  const myU = inc.users.filter(function (x) { return x.id === A.rec.id; })[0];
  if (myU && (myU.u || 0) > (A.rec.u || 0)) {
    const c = {}; Object.keys(A.rec).forEach(function (k) { c[k] = A.rec[k]; });
    c.pass = myU.pass; c.def = !!myU.def && A.rec.def; c.name = myU.name || c.name; c.u = myU.u; sub.users = [c];
  }
  if (P.depts_edit) sub.depts = inc.depts.filter(function (d) { return inScope_(sc, d.id); });
  if (hasAny_(P, ['emps_edit', 'emps_status', 'emps_import', 'emps_delete', 'roster_edit'])) {
    sub.emps = inc.emps.filter(function (e) {
      const o = sEmp[e.id];
      return inScope_(sc, e.dept) && (!o || inScope_(sc, o.dept));
    }).map(function (e) {
      const o = sEmp[e.id], c = strip_(e, ['pass']);
      if (o && o.pass) c.pass = o.pass;
      if (!o && e.pass) c.pass = e.pass;
      if (o && normNo_(o.no) !== normNo_(e.no)) c.pass = '';
      if (o && P.emps_edit && e.pass) c.pass = e.pass;
      return c;
    });
  }
  if (hasAny_(P, ['att_take', 'att_unlock'])) {
    Object.keys(inc.att).forEach(function (k) { if (inScope_(sc, k.split('|')[1])) sub.att[k] = inc.att[k]; });
    sub.anotes = inc.anotes.filter(function (a) { return inScope_(sc, a.dept); });
  }
  sub.viol = inc.viol.filter(function (v) {
    const e = sEmp[v.emp], o = sViol[v.id];
    if (!e || !inScope_(sc, e.dept)) return false;
    if (!o) return !!P.viol_add;
    if (v.d && !o.d) return !!P.viol_delete;
    return !!P.viol_edit && !o.d;
  });
  if (P.rate_do || P.rate_open) sub.rates = inc.rates.filter(function (r) { return inScope_(sc, r.dept || dm[r.emp]); });
  if (P.rate_open) sub.ropen = inc.ropen.filter(function (r) { return inScope_(sc, String(r.id).split('|')[1]); });
  if (P.rate_laws) sub.rlaws = inc.rlaws;
  if (P.notify_send) sub.notes = inc.notes.filter(function (n) { return n.from === me; });
  const logIds = byId(db.log);
  sub.log = inc.log.filter(function (l) { return !logIds[l.id] && !l.d; }).slice(0, 500);
  return mergeStamp_(db, sub);
}
