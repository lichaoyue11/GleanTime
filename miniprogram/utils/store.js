/**
 * 拾时簿 GleanTime —— 数据层（纯本地，wx.storage）
 * 数据模型、派生统计、增删改 / 调休抵扣 / 导入合并。
 * 业务规则：加班三分类 / 折算 8h = 1 天 / 2026-10-01 有效期分界。
 */

var STORE_KEY = 'overtime_records_v3';   // v3：加班类型三分类 + 新增「有效加班时长」字段
var SCHEMA_VERSION = 3;
var WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

// 调休有效期（有效截止日）规则：
//   · 2026 年 10 月之前的加班时长 —— 有效期至「次年 3 月 31 日」
//   · 2026 年 10 月及之后的加班时长 —— 有效期至「下一自然季度末」
var VALID_CUTOFF = '2026-10-01';
var QUARTER_END = [[3, 31], [6, 30], [9, 30], [12, 31]];

/* ---------------- 基础工具 ---------------- */
function r1(n) { return Math.round(n * 10) / 10; }
function r2(n) { return Math.round(n * 100) / 100; }

function calcDur(start, end) {
  if (!start || !end) return 0;
  var a = String(start).split(':').map(Number);
  var b = String(end).split(':').map(Number);
  if (isNaN(a[0]) || isNaN(b[0])) return 0;
  var m = (b[0] * 60 + b[1]) - (a[0] * 60 + a[1]);
  if (m <= 0) m += 24 * 60;
  return r2(m / 60);
}
function isCrossDay(start, end) {
  if (!start || !end) return false;
  var a = String(start).split(':').map(Number);
  var b = String(end).split(':').map(Number);
  return (b[0] * 60 + b[1]) - (a[0] * 60 + a[1]) <= 0;
}
function rangeText(start, end) {
  return start + ' — ' + (isCrossDay(start, end) ? '次日 ' : '') + end;
}
function effOf(r) { return r2(typeof r.valid === 'number' ? r.valid : calcDur(r.start, r.end)); }
function usedOf(r) { return r2((r.deductions || []).reduce(function (a, d) { return a + d.hours; }, 0)); }
function remainOf(r) { return Math.max(0, r2(effOf(r) - usedOf(r))); }

// 时长显示：默认 1 位小数；确需 2 位（如 3.25）则保留 2 位
function fmtH(h) {
  var n = Number(h) || 0;
  var v2 = r2(n);
  var v1 = r1(v2);
  if (Math.abs(v2 - v1) < 1e-9) return v1.toFixed(1);
  return v2.toFixed(2);
}
// 输入期实时过滤：仅保留数字与「一个」小数点、小数点后最多两位（保留输入形态，不补零/不四舍五入）
// 用于「有效加班时长」与「抵扣时长」的可编辑输入框，避免用户输入过程中被强制规范化打断。
function filterAmount(v) {
  v = String(v == null ? '' : v);
  v = v.replace(/[^\d.]/g, '');                 // 去掉非数字（除小数点）
  var firstDot = v.indexOf('.');
  if (firstDot >= 0) {
    // 仅保留第一个小数点，后续的小数点一律剔除
    v = v.slice(0, firstDot + 1) + v.slice(firstDot + 1).replace(/\./g, '');
  }
  var parts = v.split('.');
  if (parts.length === 2 && parts[1].length > 2) {
    parts[1] = parts[1].slice(0, 2);            // 最多两位小数
    v = parts[0] + '.' + parts[1];
  }
  return v;
}
function ymd(d) { return String(d).substring(0, 10); }
function md(d) { var p = ymd(d).split('-'); return p[1] + '月' + p[2] + '日'; }
function wd(d) { return WEEK[new Date(ymd(d) + 'T00:00:00').getDay()]; }
function ymdWd(d) { return ymd(d) + ' · ' + wd(d); }

// 「添加加班」弹层的默认起止时段 —— 由加班日期落在星期几决定：
//   周一~周五（工作日）→ 18:30 - 21:00
//   周六 / 周日（休息日）→ 09:00 - 18:00
// 说明：这里只按「星期」粗分工作日/休息日，不涉及法定节假日与调休补班
//（小程序无内置节假日判定能力，且国务院年度安排需外部数据支撑）。
function defTimes(dateIso) {
  var iso = ymd(dateIso || todayStr());
  var w = new Date(iso + 'T00:00:00').getDay();   // 0 = 周日 … 6 = 周六
  if (w === 0 || w === 6) return { start: '09:00', end: '18:00' };
  return { start: '18:30', end: '21:00' };
}
function isRestDay(dateIso) {
  var w = new Date(ymd(dateIso || todayStr()) + 'T00:00:00').getDay();
  return w === 0 || w === 6;
}

function validUntilOf(d) {
  var s = ymd(d), p = s.split('-'), y = +p[0], m = +p[1];
  if (s < VALID_CUTOFF) return (y + 1) + '-03-31';
  var nq = Math.floor((m - 1) / 3) + 1;
  var e = QUARTER_END[nq % 4];
  return (y + Math.floor(nq / 4)) + '-' + String(e[0]).padStart(2, '0') + '-' + String(e[1]).padStart(2, '0');
}
function isExpired(r) { return todayStr() > validUntilOf(r.date); }
function todayStr() {
  var n = new Date();
  return n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0') + '-' + String(n.getDate()).padStart(2, '0');
}

// 明细状态标签
function statusOf(r) {
  if (r.type === 'pr') return { k: '攻关', cls: 'pr' };
  if (r.type === 'holiday') return { k: '法定节假日', cls: 'paid' };
  if (remainOf(r) <= 0) return { k: '已使用', cls: 'used' };
  if (isExpired(r)) return { k: '已过期', cls: 'exp' };
  return { k: '可用', cls: 'comp' };
}

/* ---------------- 数据规范化（旧数据兼容） ---------------- */
function norm(r) {
  if (r.type !== 'comp' && r.type !== 'pr' && r.type !== 'holiday') r.type = 'holiday';
  if (typeof r.valid !== 'number' || isNaN(r.valid)) r.valid = r2(calcDur(r.start, r.end));
  r.valid = r2(r.valid);
  r.deductions = Array.isArray(r.deductions) ? r.deductions : [];
  if (typeof r.reason !== 'string' || !r.reason.trim()) r.reason = '未填写原因';
  return r;
}

/* ---------------- 派生统计（全部由加班明细派生，无独立额度表） ---------------- */
function totals(list) {
  list = list || Store.records;
  var total = 0, comp = 0, pr = 0, holiday = 0;
  list.forEach(function (r) {
    var e = effOf(r); total += e;
    if (r.type === 'comp') comp += e; else if (r.type === 'pr') pr += e; else holiday += e;
  });
  return { total: r2(total), comp: r2(comp), pr: r2(pr), holiday: r2(holiday), days: r1(comp / 8) };
}
function quotaSummary(list) {
  list = list || Store.records;
  var av = 0, us = 0, ex = 0;
  list.forEach(function (r) {
    if (r.type !== 'comp') return;
    var used = usedOf(r), rem = remainOf(r);
    us += used;
    if (rem > 0) { if (isExpired(r)) ex += rem; else av += rem; }
  });
  return { av: r2(av), us: r2(us), ex: r2(ex) };
}
// 调休使用事件：按 leaveDate 聚合所有加班明细上的 deductions
function leaveEvents() {
  var map = {};
  Store.records.forEach(function (r) {
    (r.deductions || []).forEach(function (d) {
      if (!map[d.leaveDate]) map[d.leaveDate] = { leaveDate: d.leaveDate, hours: 0, sources: [] };
      map[d.leaveDate].hours += d.hours;
      map[d.leaveDate].sources.push({ recDate: r.date, hours: d.hours });
    });
  });
  var arr = Object.keys(map).map(function (k) { map[k].hours = r2(map[k].hours); return map[k]; });
  arr.sort(function (a, b) { return a.leaveDate < b.leaveDate ? 1 : -1; });
  return arr;
}
// 可供选择的加班：comp 且有剩余、未过期
function availableRecords() {
  return Store.records.filter(function (r) { return r.type === 'comp' && remainOf(r) > 0 && !isExpired(r); })
    .sort(function (a, b) { return a.date > b.date ? -1 : 1; });
}
function currentAvailable() {
  return r2(availableRecords().reduce(function (a, r) { return a + remainOf(r); }, 0));
}

/* ---------------- 状态与持久化 ---------------- */
function load() {
  try {
    var raw = wx.getStorageSync(STORE_KEY);
    if (raw) return JSON.parse(raw).map(norm);
  } catch (e) { /* 忽略损坏数据 */ }
  // 首次启动、本地无存储时返回空列表（不注入种子数据）
  return [];
}
function persist() {
  try { wx.setStorageSync(STORE_KEY, JSON.stringify(Store.records)); } catch (e) { /* 容量满等异常忽略 */ }
}

/* ---------------- 动作（增删改 / 调休 / 导入） ---------------- */
function addRecord(data) {
  var h = calcDur(data.start, data.end);              // 起止时长（小时）
  var ev = (data.valid == null || isNaN(data.valid) || data.valid < 0) ? h : r2(data.valid);
  if (ev > h) ev = h;                                 // 有效时长不超过本次加班时长
  var id = Store.records.length ? Math.max.apply(null, Store.records.map(function (r) { return r.id; })) + 1 : 1;
  var rec = norm({
    id: id, date: data.date, start: data.start, end: data.end,
    reason: data.reason || '未填写原因', type: data.type, valid: ev, deductions: []
  });
  Store.records.push(rec);
  persist();
  return { ok: true, toast: '已添加 ' + typeName(data.type) + ' · 加班 ' + fmtH(h) + 'h / 有效 ' + fmtH(ev) + 'h' };
}
function updateRecord(id, data) {
  var rec = Store.records.filter(function (x) { return x.id === id; })[0];
  if (!rec) return { ok: false, toast: '记录不存在' };
  var h = calcDur(data.start, data.end);
  var ev = (data.valid == null || isNaN(data.valid) || data.valid < 0) ? h : r2(data.valid);
  if (ev > h) ev = h;
  var deducted = usedOf(rec);                          // 有效时长不得低于已被抵扣的部分
  var adjusted = false;
  if (ev < deducted) { ev = deducted; adjusted = true; }
  rec.date = data.date; rec.start = data.start; rec.end = data.end;
  rec.reason = data.reason || '未填写原因'; rec.type = data.type; rec.valid = ev;
  persist();
  return {
    ok: true, adjusted: adjusted,
    toast: adjusted ? ('有效时长已自动调整为已抵扣的 ' + fmtH(deducted) + 'h') : ('已更新加班记录 · 加班 ' + fmtH(h) + 'h / 有效 ' + fmtH(ev) + 'h')
  };
}
function deleteRecord(id) {
  Store.records = Store.records.filter(function (r) { return r.id !== id; });
  persist();
  return { ok: true, toast: '已删除加班记录' };
}
// 调休抵扣：items = [{id, hours}]（已勾选且 hours>0）；editingLeave 为被修改事件的原始 leaveDate
function applyLeave(payload) {
  var leaveDate = payload.leaveDate;
  var items = payload.items || [];
  var editingLeave = payload.editingLeave;
  if (!leaveDate) return { ok: false, toast: '请选择调休使用日期' };
  if (!items.length) return { ok: false, toast: '请至少勾选一项加班时长' };
  if (editingLeave) {
    // 修改模式：先撤销原事件（删除该 leaveDate 的全部抵扣），再按新选择重算
    Store.records.forEach(function (r) { r.deductions = (r.deductions || []).filter(function (x) { return x.leaveDate !== editingLeave; }); });
  }
  var total = 0;
  items.forEach(function (it) {
    var r = Store.records.filter(function (x) { return x.id === it.id; })[0]; if (!r) return;
    var add = it.hours, rem = remainOf(r);
    if (add > rem) add = rem;
    if (add <= 0) return;
    r.deductions = r.deductions || [];
    r.deductions.push({ leaveDate: leaveDate, hours: r2(add) });
    total += add;
  });
  persist();
  return { ok: true, toast: (editingLeave ? '已更新 ' : '已记录 ') + ymdWd(leaveDate) + ' 调休抵扣 ' + fmtH(total) + ' 小时' };
}
function undoLeave(leaveDate) {
  Store.records.forEach(function (r) { r.deductions = (r.deductions || []).filter(function (x) { return x.leaveDate !== leaveDate; }); });
  persist();
  return { ok: true, toast: '已撤销 ' + ymdWd(leaveDate) + ' 调休记录' };
}
// 导入合并：按 id 合并去重（同 id 覆盖，新 id 追加，字段不完整/格式非法则跳过）
function isImportable(n) {
  return !!(n && typeof n === 'object' && n.id != null && n.id !== ''
    && /^\d{4}-\d{2}-\d{2}$/.test(String(n.date))
    && /^\d{1,2}:\d{2}$/.test(String(n.start))
    && /^\d{1,2}:\d{2}$/.test(String(n.end)));
}
function mergeImport(list) {
  var merged = {};
  var kept = 0, added = 0, skipped = 0;
  Store.records.forEach(function (r) { merged[r.id] = r; });
  (Array.isArray(list) ? list : []).forEach(function (n) {
    if (!isImportable(n)) { skipped++; return; }
    var id = n.id;
    if (typeof id === 'string' && /^\d+$/.test(id)) id = Number(id);   // 数字字符串 id 归一为 number
    n.id = id;
    var existed = Object.prototype.hasOwnProperty.call(merged, id);
    merged[id] = norm(n);
    if (existed) kept++; else added++;
  });
  Store.records = Object.keys(merged).map(function (k) { return merged[k]; });
  persist();
  return { added: added, kept: kept, skipped: skipped };
}
function buildPayload() {
  return { schemaVersion: SCHEMA_VERSION, app: 'glean-time-overtime', exportedAt: new Date().toISOString(), records: Store.records };
}
function typeName(t) { return t === 'comp' ? '可调休' : t === 'pr' ? '攻关' : '法定节假日'; }

/* ---------------- 订阅 / 通知（跨页刷新） ---------------- */
var subs = [];
function subscribe(cb) {
  subs.push(cb);
  return function () { var i = subs.indexOf(cb); if (i >= 0) subs.splice(i, 1); };
}
function notify() { subs.forEach(function (cb) { try { cb(); } catch (e) {} }); }

/* ---------------- 导出 Store 单例 ---------------- */
var Store = {
  STORE_KEY: STORE_KEY,
  SCHEMA_VERSION: SCHEMA_VERSION,
  APP_NAME: '拾时簿 GleanTime',
  APP_VERSION: 'v1.1.1',
  VALID_CUTOFF: VALID_CUTOFF,
  records: [],

  load: load,
  persist: persist,
  subscribe: subscribe,
  notify: notify,

  // 工具
  r1: r1,
  r2: r2,
  calcDur: calcDur,
  isCrossDay: isCrossDay,
  rangeText: rangeText,
  effOf: effOf,
  usedOf: usedOf,
  remainOf: remainOf,
  fmtH: fmtH,
  filterAmount: filterAmount,
  ymd: ymd,
  md: md,
  wd: wd,
  ymdWd: ymdWd,
  defTimes: defTimes,
  isRestDay: isRestDay,
  validUntilOf: validUntilOf,
  isExpired: isExpired,
  todayStr: todayStr,
  statusOf: statusOf,
  norm: norm,
  isImportable: isImportable,
  typeName: typeName,

  // 派生
  totals: totals,
  quotaSummary: quotaSummary,
  leaveEvents: leaveEvents,
  availableRecords: availableRecords,
  currentAvailable: currentAvailable,

  // 动作
  addRecord: addRecord,
  updateRecord: updateRecord,
  deleteRecord: deleteRecord,
  applyLeave: applyLeave,
  undoLeave: undoLeave,
  mergeImport: mergeImport,
  buildPayload: buildPayload
};

// 模块加载即初始化
Store.records = load();

module.exports = Store;
