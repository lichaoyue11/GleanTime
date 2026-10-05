const Store = require('../../utils/store.js');
const wxfile = require('../../utils/wxfile.js');

/* ---------------- 模块级小工具 ---------------- */
function pad(n) { return (n < 10 ? '0' : '') + n; }
function isoToText(iso) { return iso ? iso.replace(/-/g, '/') : ''; }

/* ---------------- 自定义导航安全区（刘海 / 挖孔适配） ----------------
   navigationStyle:"custom" 时页面从物理屏顶端开始绘制，顶部安全区必须手动让出。
   关键：env(safe-area-inset-top) 在多数微信宿主（尤其安卓 / 挖孔屏）上恒为 0，
   不可依赖；唯一可靠来源是系统信息的 statusBarHeight / safeArea.top。
   返回：
   - padTop   需要让出的顶部高度（纯状态栏/挖孔高度，不含标题栏），由 .hero 内联
              padding-top 吸收，使内容避开状态栏与挖孔、且不产生多余留白。
   - padRight 需要让出的右侧宽度，用于避开右上角「微信胶囊按钮」（··· / ⊙）。
              navigationStyle:"custom" 时胶囊由微信叠绘在页面右上角，任何落在该
              区域的文字都会被盖住，必须用 getMenuButtonBoundingClientRect() 实测。 */
function getNavMetrics() {
  var info = {};
  try {
    info = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()) || {};
  } catch (e) { info = {}; }
  var statusBarHeight = info.statusBarHeight || 0;
  var safeTop = (info.safeArea && info.safeArea.top) ? info.safeArea.top : statusBarHeight;
  var padTop = Math.round(Math.max(statusBarHeight, safeTop, 0));

  /* 右上角胶囊：内容右边界必须停在胶囊左侧，再留 8px 呼吸位。
     胶囊尺寸在各机型上基本固定（约 87×32px），所以用实测 left 值反推。 */
  var winW = info.windowWidth || 375;
  var padRight = 0;
  try {
    var cap = wx.getMenuButtonBoundingClientRect && wx.getMenuButtonBoundingClientRect();
    if (cap && cap.left > 0) padRight = Math.round(winW - cap.left + 8);
  } catch (e2) { padRight = 0; }
  if (!(padRight > 0)) padRight = 102;   /* 兜底：≈ 胶囊宽 87 + 右边距 7 + 呼吸位 8 */

  return { padTop: padTop, padRight: padRight };
}

Page({
  data: {
    tab: 'records',
    appStyle: '',
    heroInnerStyle: '',
    heroDate: '',
    heroWeek: '',
    scrollLock: false,
    closeToken: 0,
    swipeOpenKey: '',
    /* 是否移动端：用于隐藏移动端不存在的入口。
       - 移动端无「打开本地文件管理器」的接口（chooseMessageFile 只会弹聊天文件），
         故隐藏「从本地文件选择」，只保留「从微信聊天文件选择」；
       - wx.saveFileToDisk 仅 PC 支持，故移动端隐藏「保存到本地文件」。
       onLoad 时由 wxfile.isMobile() 写入。 */
    mobile: false,

    recSummary: { total: '0.0', comp: '0.0', days: '0' },
    recNoteShow: false,
    recNote: '',
    recFilter: { yVal: '全部年份', mVal: '全部月份', yOn: false, mOn: false, resetShow: false },
    recCount: '',
    recordsExist: true,
    recList: [],

    statRange: { mode: 'all', start: '', end: '' },
    statCustomShow: false,
    statStartText: '',
    statEndText: '',
    statNoteShow: false,
    statNote: '',
    stat: { donutBg: 'var(--divider)', donutBig: '0', lgAv: '0.0h', lgUs: '0.0h', lgEx: '0.0h',
      total: '0.0', comp: '0.0', pr: '0.0', holiday: '0.0', days: '0' },

    lvSummary: { av: '0.0', us: '0.0', ex: '0.0' },
    lvFilter: { yVal: '全部年份', mVal: '全部月份', yOn: false, mOn: false, resetShow: false },
    lvCount: '',
    leavesExist: true,
    lvList: [],

    add: { show: false, editingId: null, validTouched: false, dateIso: '', dateText: '', start: '18:30', end: '21:30',
      startText: '18:30', endText: '21:30', reason: '', type: 'comp', durText: '0.0 小时', cross: false, crossHint: '',
      validText: '', validPh: '0.0', validSelStart: 0, validSelEnd: 0,
      title: '添加加班记录', sub: '填写加班信息，时长将根据起止时间自动计算', saveLabel: '保存记录' },

    leave: { show: false, dateIso: '', dateText: '', avail: '0.0', picks: [], rtUse: '0.0', rtAfter: '0.0', rtNeg: false,
      title: '使用调休', sub: '选择使用调休的日期，并从下方「可调休且仍有剩余」的加班中勾选要抵扣的时长', saveLabel: '确认抵扣' },

    imp: { show: false, title: '数据导入', sub: '选择导入方式，数据按记录 ID 合并还原到本机。' },
    exp: { show: false, title: '数据导出', sub: '备份文件已生成，请选择导出方式', file: '', meta: '', raw: '', path: '' },

    /* 弹层下拉关闭：拖动顶部把手时把位移写进 sheetDrag.style（name 标记当前被拖的弹层），
       松手后按位移阈值决定「回弹」还是「关闭」。 */
    sheetDrag: { name: '', style: '' },

    dd: { show: false, up: false, type: 'sel', top: 0, left: 0, width: 0, selTarget: '', openTarget: '', options: [], hours: [], minutes: [], hourSel: '', minuteSel: '' },
    dp: { show: false, view: 'date', y: 2026, m: 1, title: '', cells: [] },

    toastMsg: '',
    toastShow: false
  },

  /* ============ 生命周期 ============ */
  onLoad: function () {
    /* 页面从物理屏顶端绘制（navigationStyle:custom），顶部安全区必须手动让出。
       - .hero 内联 padding-top：内容避开状态栏 / 挖孔（env 在安卓挖孔屏恒为 0，不可依赖）；
       - .hero-inner 内联 padding-right：内容右边界停在微信胶囊按钮左侧，避免日期被盖住。 */
    var nav = getNavMetrics();
    var d = new Date();
    var wk = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
    this.setData({
      appStyle: 'padding-top:' + nav.padTop + 'px;',
      heroInnerStyle: 'padding-right:' + nav.padRight + 'px;',
      heroDate: (d.getMonth() + 1) + '月' + d.getDate() + '日',
      heroWeek: wk,
      mobile: wxfile.isMobile()
    });
    this.recFilter = { y: 'all', m: 'all' };
    this.lvFilter = { y: 'all', m: 'all' };
    this.statRange = { mode: 'all', start: '', end: '' };
    this._hours = []; this._minutes = [];
    for (var i = 0; i < 24; i++) this._hours.push(pad(i));
    for (var j = 0; j < 60; j++) this._minutes.push(pad(j));
    this._ddTarget = null; this._dpTarget = '';
    this._picks = {};
    this._editingId = null; this._validTouched = false; this._editingLeave = null;
    /* _timeTouched：用户是否手动改过「起止时间」。未改过时，切换加班日期会按新日期的
       工作日/休息日重新套用默认时段（周一~周五 18:30-21:00 / 周末 09:00-18:00）；
       改过之后则保留用户输入，仅实时重算时长，避免把手工填的时间冲掉。 */
    this._timeTouched = false;
    this._dragSheet = null; this._dragY = 0; this._dragMoved = false;
    this._toastTimer = null;
    this.renderAll();
  },
  onShow: function () { this.renderAll(); },

  /* ============ 全量渲染 ============ */
  renderAll: function () {
    this.renderRecords();
    this.renderStats();
    this.renderLeaves();
  },

  /* ---------- 年份 / 月份派生（筛选下拉用） ---------- */
  yearsFor: function (dates) { var s = {}; dates.forEach(function (d) { s[d.slice(0, 4)] = 1; }); return Object.keys(s).sort().reverse(); },
  monthsFor: function (dates, y) {
    var s = {};
    dates.forEach(function (d) { if (y !== 'all' && d.slice(0, 4) !== y) return; s[d.slice(5, 7)] = 1; });
    return Object.keys(s).sort();
  },

  /* ============ 加班记录页 ============ */
  matchRec: function (iso) {
    if (this.recFilter.y !== 'all' && iso.slice(0, 4) !== this.recFilter.y) return false;
    if (this.recFilter.m !== 'all' && iso.slice(5, 7) !== this.recFilter.m) return false;
    return true;
  },
  matchLv: function (iso) {
    if (this.lvFilter.y !== 'all' && iso.slice(0, 4) !== this.lvFilter.y) return false;
    if (this.lvFilter.m !== 'all' && iso.slice(5, 7) !== this.lvFilter.m) return false;
    return true;
  },

  recToView: function (r) {
    var st = Store.statusOf(r);
    var used = Store.usedOf(r), rem = Store.remainOf(r), exp = Store.isExpired(r);
    var tags = [{ cls: st.cls, text: st.k }];
    if (r.type === 'comp') {
      if (used > 0) tags.push({ cls: 'used', text: '已抵扣 ' + Store.fmtH(used) + 'h' });
      if (rem > 0 && !exp) tags.push({ cls: 'comp', text: '剩余 ' + Store.fmtH(rem) + 'h' });
      tags.push({ cls: 'valid' + (exp ? ' exp' : ''), text: '有效期至 ' + Store.validUntilOf(r.date) });
    }
    var deduct = null, deductRem = '0', deductHas = false;
    if (r.type === 'comp' && (r.deductions || []).length) {
      deductHas = true;
      deduct = (r.deductions || []).map(function (d) {
        return { text: '用于抵扣 ' + Store.ymdWd(d.leaveDate) + ' 调休', amt: Store.fmtH(d.hours) + 'h' };
      });
      deductRem = Store.fmtH(rem);
    }
    return {
      id: r.id, date: Store.ymdWd(r.date), range: Store.rangeText(r.start, r.end),
      dur: Store.fmtH(Store.calcDur(r.start, r.end)), valid: Store.fmtH(Store.effOf(r)),
      reason: r.reason || '未填写原因', tags: tags, deductHas: deductHas, deduct: deduct, deductRem: deductRem
    };
  },

  renderRecords: function () {
    var that = this;
    var st = this.recFilter;
    var on = st.y !== 'all' || st.m !== 'all';
    var rows = Store.records.filter(function (r) { return that.matchRec(Store.ymd(r.date)); });
    var t = Store.totals(rows);
    var sorted = rows.slice().sort(function (a, b) { return a.date < b.date ? 1 : -1; });
    var data = {
      recSummary: { total: Store.fmtH(t.total), comp: Store.fmtH(t.comp), days: String(t.days) },
      recNoteShow: on,
      recNote: on ? ('已按所选时间区间实时统计（命中 ' + rows.length + ' 条加班记录）') : '',
      recordsExist: Store.records.length > 0,
      recCount: on ? ('共 ' + rows.length + ' 条（全部 ' + Store.records.length + ' 条）') : ('共 ' + Store.records.length + ' 条'),
      recList: sorted.map(function (r) { return that.recToView(r); })
    };
    data.recFilter = this.syncRecFilter();
    this.setData(data);
  },

  syncRecFilter: function () {
    var st = this.recFilter;
    var dates = Store.records.map(function (r) { return Store.ymd(r.date); });
    var ys = this.yearsFor(dates);
    if (st.y !== 'all' && ys.indexOf(st.y) < 0) st.y = 'all';
    var ms = this.monthsFor(dates, st.y);
    if (st.m !== 'all' && ms.indexOf(st.m) < 0) st.m = 'all';
    var disp = {
      yVal: st.y === 'all' ? '全部年份' : st.y + ' 年',
      mVal: st.m === 'all' ? '全部月份' : Number(st.m) + ' 月',
      yOn: st.y !== 'all', mOn: st.m !== 'all',
      resetShow: st.y !== 'all' || st.m !== 'all'
    };
    this.setData({ recFilter: disp });
    return disp;
  },

  onRecFilterReset: function () { this.recFilter = { y: 'all', m: 'all' }; this.renderRecords(); },

  /* ============ 调休记录页 ============ */
  renderLeaves: function () {
    var that = this;
    var q = Store.quotaSummary();
    var all = Store.leaveEvents();
    var on = this.lvFilter.y !== 'all' || this.lvFilter.m !== 'all';
    var ev = all.filter(function (e) { return that.matchLv(Store.ymd(e.leaveDate)); });
    var data = {
      lvSummary: { av: Store.fmtH(q.av), us: Store.fmtH(q.us), ex: Store.fmtH(q.ex) },
      leavesExist: all.length > 0,
      lvCount: on ? ('共 ' + ev.length + ' 次（全部 ' + all.length + ' 次）') : ('共 ' + all.length + ' 次'),
      lvList: ev.map(function (e) {
        return {
          iso: e.leaveDate,                       // 真实 ISO 日期（供撤销/编辑使用）
          leaveDate: Store.ymdWd(e.leaveDate),    // 展示用文本
          hours: Store.fmtH(e.hours),
          sources: e.sources.slice().sort(function (a, b) { return a.recDate < b.recDate ? 1 : -1; })
            .map(function (s) { return Store.ymdWd(s.recDate) + ' ' + Store.fmtH(s.hours) + 'h'; }).join('、')
        };
      })
    };
    data.lvFilter = this.syncLvFilter();
    this.setData(data);
  },

  syncLvFilter: function () {
    var st = this.lvFilter;
    var dates = Store.leaveEvents().map(function (e) { return Store.ymd(e.leaveDate); });
    var ys = this.yearsFor(dates);
    if (st.y !== 'all' && ys.indexOf(st.y) < 0) st.y = 'all';
    var ms = this.monthsFor(dates, st.y);
    if (st.m !== 'all' && ms.indexOf(st.m) < 0) st.m = 'all';
    var disp = {
      yVal: st.y === 'all' ? '全部年份' : st.y + ' 年',
      mVal: st.m === 'all' ? '全部月份' : Number(st.m) + ' 月',
      yOn: st.y !== 'all', mOn: st.m !== 'all',
      resetShow: st.y !== 'all' || st.m !== 'all'
    };
    this.setData({ lvFilter: disp });
    return disp;
  },

  onLvFilterReset: function () { this.lvFilter = { y: 'all', m: 'all' }; this.renderLeaves(); },

  /* ============ 时长统计页 ============ */
  rngBounds: function () {
    var y = new Date().getFullYear(), r = this.statRange;
    if (r.mode === 'last') return { from: (y - 1) + '-01-01', to: (y - 1) + '-12-31' };
    if (r.mode === 'year') return { from: y + '-01-01', to: y + '-12-31' };
    if (r.mode === 'time') {
      if (r.start && r.end) return { from: r.start, to: r.end };
      return { from: '', to: '' };
    }
    return { from: '', to: '' };
  },
  rangedRecords: function () {
    var b = this.rngBounds(), r = this.statRange;
    if (!b.from && !b.to) return Store.records;
    return Store.records.filter(function (x) {
      var s = Store.ymd(x.date);
      if (b.from && s < b.from) return false;
      if (b.to && s > b.to) return false;
      return true;
    });
  },
  renderStats: function () {
    var list = this.rangedRecords();
    var t = Store.totals(list), q = Store.quotaSummary(list);
    var sum = q.av + q.us + q.ex;
    var pAv = sum ? q.av / sum * 100 : 0, pUs = sum ? q.us / sum * 100 : 0;
    var donutBg = sum
      ? ('conic-gradient(var(--green) 0 ' + pAv + '%, var(--primary) ' + pAv + '% ' + (pAv + pUs) + '%, var(--red) ' + (pAv + pUs) + '% 100%)')
      : 'var(--divider)';
    var mode = this.statRange.mode, noteShow = false, note = '';
    if (mode !== 'all') {
      noteShow = true;
      if (mode === 'time' && !(this.statRange.start && this.statRange.end)) {
        note = '请选择开始与结束日期，两者都选定后即按该区间统计';
      } else {
        var b = this.rngBounds();
        note = '统计范围：' + (b.from || '不限') + ' ~ ' + (b.to || '不限') + '　·　命中 ' + list.length + ' 条加班记录';
      }
    }
    this.setData({
      stat: {
        donutBg: donutBg, donutBig: Store.r1(q.av / 8),
        lgAv: Store.fmtH(q.av) + 'h', lgUs: Store.fmtH(q.us) + 'h', lgEx: Store.fmtH(q.ex) + 'h',
        total: Store.fmtH(t.total), comp: Store.fmtH(t.comp), pr: Store.fmtH(t.pr), holiday: Store.fmtH(t.holiday), days: String(t.days)
      },
      // 关键：把 statRange 写回 data，驱动顶部选中态与「时间」区间选择栏联动（WXML 读 statRange.mode）
      statRange: { mode: mode, start: this.statRange.start || '', end: this.statRange.end || '' },
      statCustomShow: mode === 'time',
      statNoteShow: noteShow, statNote: note
    });
  },
  onRangeTap: function (e) { this.statRange.mode = e.currentTarget.dataset.rng; this.renderStats(); },
  onRangeClear: function () {
    this.statRange.start = ''; this.statRange.end = '';
    this.setData({ statStartText: '', statEndText: '' });
    this.renderStats();
  },

  /* ============ 底部导航 / FAB ============ */
  switchTab: function (e) {
    var tab = e.currentTarget.dataset.tab;
    this.setData({ tab: tab });
    this.closeAllSwipes(); this.closeDropdown(); this.closeSheets();
  },
  onFab: function () {
    if (this.data.tab === 'leaves') this.openLeaveSheet();
    else this.openAddSheet();
  },

  /* ============ 全局下拉面板 ============ */
  onDdTrigger: function (e) {
    var dd = e.currentTarget.dataset.dd;
    if (this._ddTarget === dd && this.data.dd.show) { this.closeDropdown(); return; }
    this.closeAllSwipes();
    var type, options = [], value = '';
    if (dd === 'fy' || dd === 'fm') {
      type = 'sel';
      var rdates = Store.records.map(function (r) { return Store.ymd(r.date); });
      if (dd === 'fy') {
        var ys = this.yearsFor(rdates);
        options = [{ v: 'all', label: '全部年份' }].concat(ys.map(function (y) { return { v: y, label: y + ' 年' }; }));
        value = this.recFilter.y;
      } else {
        var rms = this.monthsFor(rdates, this.recFilter.y);
        options = [{ v: 'all', label: '全部月份' }].concat(rms.map(function (m) { return { v: m, label: String(Number(m)) + ' 月' }; }));
        value = this.recFilter.m;
      }
    } else if (dd === 'ly' || dd === 'lm') {
      type = 'sel';
      var ldates = Store.leaveEvents().map(function (ev) { return Store.ymd(ev.leaveDate); });
      if (dd === 'ly') {
        var lys = this.yearsFor(ldates);
        options = [{ v: 'all', label: '全部年份' }].concat(lys.map(function (y) { return { v: y, label: y + ' 年' }; }));
        value = this.lvFilter.y;
      } else {
        var lms = this.monthsFor(ldates, this.lvFilter.y);
        options = [{ v: 'all', label: '全部月份' }].concat(lms.map(function (m) { return { v: m, label: String(Number(m)) + ' 月' }; }));
        value = this.lvFilter.m;
      }
    } else {
      type = 'time';
      value = (dd === 'start') ? this.data.add.start : this.data.add.end;
    }
    this._ddTarget = dd; this._ddType = type;
    var that = this;
    var q = wx.createSelectorQuery().in(this);
    q.select('#ddTrig-' + dd).boundingClientRect();
    q.select('.app').boundingClientRect();
    q.exec(function (res) {
      var trig = res[0], appR = res[1];
      if (!trig || !appR) return;
      var GAP = 6;
      var below = appR.height - (trig.top - appR.top) - trig.height - GAP;
      var above = (trig.top - appR.top) - GAP;
      var flip = above > below;
      var maxH = Math.max(132, Math.min(300, flip ? above : below));
      var width = type === 'time' ? Math.max(trig.width, 168) : trig.width;
      var left = trig.left - appR.left;
      if (left + width > appR.width - 8) left = Math.max(8, appR.width - 8 - width);
      var top = flip ? Math.max(8, (trig.top - appR.top) - GAP - maxH) : (trig.bottom - appR.top) + GAP;
      var ddData = {
        show: true, up: flip, type: type, top: top, left: left, width: width, selTarget: dd, openTarget: dd,
        options: type === 'sel' ? options.map(function (o) { return { v: o.v, label: o.label, sel: o.v === value }; }) : [],
        hours: type === 'time' ? that._hours : [], minutes: type === 'time' ? that._minutes : [],
        hourSel: type === 'time' ? value.split(':')[0] : '', minuteSel: type === 'time' ? value.split(':')[1] : ''
      };
      that.setData({ dd: ddData });
    });
  },
  onDdOptionTap: function (e) {
    var v = e.currentTarget.dataset.v, dd = this._ddTarget;
    if (dd === 'fy') this.recFilter.y = v;
    else if (dd === 'fm') this.recFilter.m = v;
    else if (dd === 'ly') this.lvFilter.y = v;
    else if (dd === 'lm') this.lvFilter.m = v;
    this.closeDropdown();
    if (dd === 'fy' || dd === 'fm') this.renderRecords();
    else this.renderLeaves();
  },
  onDdTimeTap: function (e) {
    var k = e.currentTarget.dataset.k, v = e.currentTarget.dataset.v;
    var field = this._ddTarget === 'start' ? 'start' : 'end';
    var cur = this.data.add[field];
    var p = cur.split(':');
    if (k === 'h') p[0] = v; else p[1] = v;
    var nv = p[0] + ':' + p[1];
    var upd = {};
    upd['add.' + field] = nv;
    upd['add.' + field + 'Text'] = nv;
    upd['dd.hourSel'] = nv.split(':')[0];
    upd['dd.minuteSel'] = nv.split(':')[1];
    this.setData(upd);
    this._timeTouched = true;          // 用户手动改过时间：后续切换日期不再覆盖
    this.recalcAdd();                  // 起止时间 → 加班时长 实时联动（选时/选分都刷新）
    if (k === 'm') this.closeDropdown();
  },
  closeDropdown: function () { this._ddTarget = null; this.setData({ 'dd.show': false, 'dd.openTarget': '' }); },
  /* 列表滚动时收起全局下拉面板，避免浮层随内容滚动错位 */
  onPageScroll: function () { if (this.data.dd && this.data.dd.show) this.closeDropdown(); },
  onSwipeLock: function (e) { this.setData({ scrollLock: !!e.detail.v }); },
  /* 左滑行展开/收起：保证全局仅一个展开行，并与下拉/弹层/切页互斥 */
  onSwipeOpen: function (e) {
    this.setData({ swipeOpenKey: e.detail.key, closeToken: this.data.closeToken + 1, scrollLock: false });
  },
  onSwipeClose: function () { this.setData({ swipeOpenKey: '' }); },

  /* ============ 自绘日历 ============ */
  openDatePicker: function (e) {
    this._dpTarget = e.currentTarget.dataset.target;
    var iso = '';
    if (this._dpTarget === 'fDate') iso = this.data.add.dateIso;
    else if (this._dpTarget === 'lvDate') iso = this.data.leave.dateIso;
    else if (this._dpTarget === 'rngStart') iso = this.statRange.start;
    else if (this._dpTarget === 'rngEnd') iso = this.statRange.end;
    this.dpView = 'date';
    if (iso) { this.dpY = +iso.slice(0, 4); this.dpM = +iso.slice(5, 7); }
    else { var n = new Date(); this.dpY = n.getFullYear(); this.dpM = n.getMonth() + 1; }
    this._dpSelIso = iso;
    this.closeAllSwipes();
    this.renderDp();
  },
  renderDp: function () {
    var view = this.dpView, y = this.dpY, m = this.dpM, cells = [], title = '', that = this;
    if (view === 'date') {
      title = y + '年 ' + m + '月';
      var start = new Date(y, m - 1, 1); start.setDate(1 - start.getDay());
      var selIso = this._dpSelIso;
      for (var i = 0; i < 42; i++) {
        var d = new Date(start); d.setDate(start.getDate() + i);
        var iso = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
        var cls = 'dp-cell' + (d.getMonth() + 1 !== m ? ' dim' : '') + (iso === selIso ? ' sel' : '') + (iso === Store.todayStr() ? ' today' : '');
        cells.push({ iso: iso, day: d.getDate(), cls: cls });
      }
    } else if (view === 'month') {
      title = y + '年';
      for (var mm = 1; mm <= 12; mm++) cells.push({ m: mm, label: mm + ' 月', cls: 'dp-cell big' + (mm === m ? ' sel' : '') });
    } else {
      var y0 = Math.floor(y / 10) * 10; title = y0 + ' - ' + (y0 + 9);
      for (var yy = y0 - 1; yy <= y0 + 10; yy++) {
        var dimY = (yy < y0 || yy > y0 + 9);
        cells.push({ y: yy, cls: 'dp-cell big' + (dimY ? ' dim' : '') + (yy === y ? ' sel' : '') });
      }
    }
    this.setData({ dp: { show: true, view: view, y: y, m: m, title: title, cells: cells } });
  },
  onDpTitleTap: function () {
    this.dpView = this.dpView === 'date' ? 'month' : (this.dpView === 'month' ? 'year' : 'date');
    this.renderDp();
  },
  onDpPrevMonth: function () { if (this.dpView === 'date') { this.dpM--; if (this.dpM < 1) { this.dpM = 12; this.dpY--; } } else if (this.dpView === 'month') { this.dpY--; } else { this.dpY -= 10; } this.renderDp(); },
  onDpNextMonth: function () { if (this.dpView === 'date') { this.dpM++; if (this.dpM > 12) { this.dpM = 1; this.dpY++; } } else if (this.dpView === 'month') { this.dpY++; } else { this.dpY += 10; } this.renderDp(); },
  onDpPrevYear: function () { if (this.dpView === 'year') this.dpY -= 10; else this.dpY--; this.renderDp(); },
  onDpNextYear: function () { if (this.dpView === 'year') this.dpY += 10; else this.dpY++; this.renderDp(); },
  onDpCellTap: function (e) {
    var iso = e.currentTarget.dataset.iso;
    var t = this._dpTarget;
    if (t === 'fDate') this._setAddDate(iso);
    else if (t === 'lvDate') this.setData({ 'leave.dateIso': iso, 'leave.dateText': isoToText(iso) });
    else if (t === 'rngStart') { this.statRange.start = iso; this.setData({ statStartText: isoToText(iso) }); }
    else if (t === 'rngEnd') { this.statRange.end = iso; this.setData({ statEndText: isoToText(iso) }); }
    this.setData({ 'dp.show': false });
    if (t === 'rngStart' || t === 'rngEnd') this.renderStats();
  },
  onDpMonthTap: function (e) { this.dpM = +e.currentTarget.dataset.m; this.dpView = 'date'; this.renderDp(); },
  onDpYearTap: function (e) { this.dpY = +e.currentTarget.dataset.y; this.dpView = 'month'; this.renderDp(); },
  onDpClear: function () {
    var t = this._dpTarget;
    if (t === 'fDate') this.setData({ 'add.dateIso': '', 'add.dateText': '' });
    else if (t === 'lvDate') this.setData({ 'leave.dateIso': '', 'leave.dateText': '' });
    else if (t === 'rngStart') { this.statRange.start = ''; this.setData({ statStartText: '' }); }
    else if (t === 'rngEnd') { this.statRange.end = ''; this.setData({ statEndText: '' }); }
    this.setData({ 'dp.show': false });
    if (t === 'rngStart' || t === 'rngEnd') this.renderStats();
  },
  onDpToday: function () {
    var iso = Store.todayStr();
    this._dpSelIso = iso;
    this.dpY = +iso.slice(0, 4); this.dpM = +iso.slice(5, 7);
    var t = this._dpTarget;
    if (t === 'fDate') this._setAddDate(iso);
    else if (t === 'lvDate') this.setData({ 'leave.dateIso': iso, 'leave.dateText': isoToText(iso) });
    else if (t === 'rngStart') { this.statRange.start = iso; this.setData({ statStartText: isoToText(iso) }); }
    else if (t === 'rngEnd') { this.statRange.end = iso; this.setData({ statEndText: isoToText(iso) }); }
    this.setData({ 'dp.show': false });
    if (t === 'rngStart' || t === 'rngEnd') this.renderStats();
  },
  onDpMaskTap: function () { this.setData({ 'dp.show': false }); },
  noop: function () {},

  /* ============ 底部弹层通用 ============ */
  openSheet: function (name) {
    this.closeSheets();
    var upd = { sheetShow: true };
    upd[name + '.show'] = true;
    this.setData(upd);
  },
  closeSheets: function () {
    this._dragSheet = null; this._dragY = 0; this._dragMoved = false;
    this.setData({
      sheetShow: false, 'sheetDrag.name': '', 'sheetDrag.style': '',
      'add.show': false, 'leave.show': false, 'imp.show': false, 'exp.show': false
    });
  },
  closeAllSwipes: function () { this.setData({ closeToken: this.data.closeToken + 1, swipeOpenKey: '', scrollLock: false }); },

  /* ---------- 弹层顶部把手：下拉缩回并关闭 ----------
     拖动热区（.grab-area）跟手位移，松手后按阈值决定「回弹」或「关闭」；
     位移只允许向下（dy >= 0），避免把手被拖出屏幕顶部。 */
  onSheetDragStart: function (e) {
    this._dragSheet = e.currentTarget.dataset.sheet;
    this._dragStartY = (e.touches && e.touches[0]) ? e.touches[0].clientY : 0;
    this._dragY = 0; this._dragMoved = false;
    this.setData({ 'sheetDrag.name': this._dragSheet, 'sheetDrag.style': '' });
  },
  onSheetDragMove: function (e) {
    if (!this._dragSheet) return;
    var y = (e.touches && e.touches[0]) ? e.touches[0].clientY : 0;
    var dy = y - this._dragStartY;
    if (dy < 0) dy = 0;
    if (dy > 4) this._dragMoved = true;
    this._dragY = dy;
    this.setData({ 'sheetDrag.style': 'transform:translateY(' + dy + 'px);transition:none;' });
  },
  onSheetDragEnd: function () {
    var name = this._dragSheet;
    if (!name) return;
    var dy = this._dragY || 0, moved = this._dragMoved;
    this._dragSheet = null; this._dragY = 0; this._dragMoved = false;
    var that = this;
    if (moved && dy > 96) {                       // 拖过阈值：顺势滑出并关闭
      this.setData({ 'sheetDrag.style': 'transform:translateY(100%);transition:transform .2s cubic-bezier(.2,.8,.2,1);' });
      setTimeout(function () {
        that.closeSheets();
      }, 170);
      return;
    }
    // 未达阈值：回弹归位后交还 class 控制（避免内联样式长期挂住 transition）
    this.setData({ 'sheetDrag.style': 'transform:translateY(0);transition:transform .2s cubic-bezier(.2,.8,.2,1);' });
    setTimeout(function () { that.setData({ 'sheetDrag.name': '', 'sheetDrag.style': '' }); }, 210);
  },

  /* ============ 添加 / 修改加班 ============ */
  openAddSheet: function () {
    this._editingId = null; this._validTouched = false; this._timeTouched = false;
    var add = this.data.add;
    var iso = Store.todayStr();
    var df = Store.defTimes(iso);          // 默认时段随「今天」是工作日/周末而定
    add.editingId = null; add.validTouched = false;
    add.dateIso = iso; add.dateText = isoToText(iso);
    add.start = df.start; add.end = df.end; add.startText = df.start; add.endText = df.end;
    add.reason = ''; add.type = 'comp'; add.title = '添加加班记录';
    add.validText = '';               // 新增态留空：默认值仅以 placeholder 隐含显示
    add.validSelStart = 0; add.validSelEnd = 0;
    add.sub = '填写加班信息，时长将根据起止时间自动计算';
    add.saveLabel = '保存记录';
    this.setData({ add: add });
    this.recalcAdd();
    this.openSheet('add');
  },
  openEditRecord: function (id) {
    var r = Store.records.filter(function (x) { return x.id === id; })[0];
    if (!r) return;
    this._editingId = id; this._validTouched = true;
    this._timeTouched = true;              // 修改态：时间来自记录本身，不随日期自动改写
    var add = this.data.add;
    add.editingId = id; add.validTouched = true;
    add.dateIso = r.date; add.dateText = isoToText(r.date);
    add.start = r.start; add.end = r.end; add.startText = r.start; add.endText = r.end;
    add.reason = r.reason || ''; add.type = r.type;
    add.validText = Store.fmtH(r.valid);
    add.validSelStart = 0; add.validSelEnd = 0;
    add.title = '修改加班记录';
    add.sub = '修改加班信息，时长将根据起止时间自动计算';
    add.saveLabel = '保存修改';
    this.setData({ add: add });
    this.recalcAdd();
    this.openSheet('add');
  },
  /* 变更加班日期：日期 → 默认起止时段 → 加班时长 全链联动。
     未手动改过时间时套用该日期（工作日/周末）的默认时段；改过则保留用户输入。 */
  _setAddDate: function (iso) {
    this.setData({ 'add.dateIso': iso, 'add.dateText': isoToText(iso) });
    if (!this._timeTouched) {
      var df = Store.defTimes(iso);
      this.setData({ 'add.start': df.start, 'add.end': df.end, 'add.startText': df.start, 'add.endText': df.end });
    }
    this.recalcAdd();
  },
  onReasonInput: function (e) { this.setData({ 'add.reason': e.detail.value }); },
  onTypeTap: function (e) { this.setData({ 'add.type': e.currentTarget.dataset.v }); },
  // 有效加班时长：聚焦即全选，用户可直接输入替换（无需先手动清空预填的默认值）
  onValidFocus: function () {
    var len = String(this.data.add.validText || '').length;
    this.setData({ 'add.validSelStart': 0, 'add.validSelEnd': len });
  },
  // 输入中实时过滤：只允许数字与一个小数点、最多两位小数（保留输入形态，不即时补零）
  // 关键：每轮输入把光标移到末尾（用 e.detail.cursor），避免受控的 selection-start/end 在
  // 每次输入后被框架重新应用为 (0, len) 而反复全选、导致无法连续输入。
  onValidInput: function (e) {
    this._validTouched = true;
    var text = Store.filterAmount(e.detail.value);
    var cur = (typeof e.detail.cursor === 'number') ? e.detail.cursor : text.length;
    this.setData({ 'add.validText': text, 'add.validSelStart': cur, 'add.validSelEnd': cur });
  },
  // 失焦收尾：留空/非法 → 回到「隐含默认值」态（输入框清空、由 placeholder 显示本次加班时长）；
  // 否则夹取到 [0, 本次加班时长] 后按 fmtH 规范化（整数补一位小数，最多两位）
  onValidBlur: function (e) {
    var f = this.data.add;
    var raw = String(e.detail.value == null ? '' : e.detail.value).trim();
    var num = Number(raw);
    var h = Store.calcDur(f.start, f.end);
    if (!raw || isNaN(num)) {
      this._validTouched = false;   // 视为未手动修改，保持与起止时间联动、保存时按默认值落库
      this.setData({ 'add.validText': '', 'add.validPh': Store.fmtH(h), 'add.validSelStart': 0, 'add.validSelEnd': 0 });
      return;
    }
    if (num < 0) num = 0;
    if (num > h) num = h;           // 有效时长不超过本次加班时长
    this._validTouched = true;
    this.setData({ 'add.validText': Store.fmtH(num), 'add.validSelStart': 0, 'add.validSelEnd': 0 });
  },
  recalcAdd: function () {
    var f = this.data.add;
    var h = Store.calcDur(f.start, f.end);
    var cross = Store.isCrossDay(f.start, f.end);
    /* 未手动改过「有效加班时长」时，输入框保持为空，默认值只作 placeholder 隐含显示
       （点击即可直接键入，无需先删除预填值）；用户改过后（_validTouched）不再随起止时间联动。 */
    var validText = this._validTouched ? f.validText : '';
    this.setData({
      'add.durText': Store.fmtH(h) + ' 小时',
      'add.cross': cross,
      'add.crossHint': cross ? ('跨天加班：结束时间按次日计算，列表中显示为 ' + Store.rangeText(f.start, f.end)) : '',
      'add.validPh': Store.fmtH(h),
      'add.validText': validText
    });
  },
  saveAdd: function () {
    var f = this.data.add;
    if (!f.dateIso) { this.toast('请选择加班日期'); return; }
    if (!f.start || !f.end) { this.toast('请填写起止时间'); return; }
    // 留空 → valid 传 null，由 Store 回退为「本次加班时长」（与输入框隐含默认值一致）
    var ev = parseFloat(f.validText);
    var payload = { date: f.dateIso, start: f.start, end: f.end, reason: f.reason, type: f.type, valid: (isNaN(ev) ? null : ev) };
    var res = this._editingId != null ? Store.updateRecord(this._editingId, payload) : Store.addRecord(payload);
    this.toast(res.toast);
    this.closeSheets();
    this.renderAll();
  },
  onRecEdit: function (e) {
    this.closeAllSwipes();   // 打开编辑 dialog 的同一刻复位该行左滑展开态，避免保存后仍处于左滑
    this.openEditRecord(e.detail.recId);
  },
  onRecDelete: function (e) { this.deleteRecord(e.detail.recId); },
  deleteRecord: function (id) {
    var res = Store.deleteRecord(id);
    this.toast(res.toast);
    this.renderAll();
  },

  /* ============ 使用 / 修改调休 ============ */
  openLeaveSheet: function () {
    this._editingLeave = null;
    var lv = this.data.leave;
    lv.dateIso = Store.todayStr(); lv.dateText = isoToText(Store.todayStr());
    lv.title = '使用调休';
    lv.sub = '选择使用调休的日期，并从下方「可调休且仍有剩余」的加班中勾选要抵扣的时长';
    lv.saveLabel = '确认抵扣';
    this._buildPicks(null);
    this.setData({ leave: lv });
    this.renderPickList(); this.updateRt();
    this.openSheet('leave');
  },
  openEditLeave: function (lvDate) {
    this._editingLeave = lvDate;
    var lv = this.data.leave;
    lv.dateIso = lvDate; lv.dateText = isoToText(lvDate);
    lv.title = '修改调休记录';
    lv.sub = '修改调休使用日期，或调整抵扣的加班与时长';
    lv.saveLabel = '保存修改';
    this._buildPicks(lvDate);
    this.setData({ leave: lv });
    this.renderPickList(); this.updateRt();
    this.openSheet('leave');
  },
  _buildPicks: function (editingLeave) {
    var that = this;
    this._picks = {};
    Store.availableRecords().forEach(function (r) {
      that._picks[r.id] = { checked: false, max: Store.remainOf(r), hours: Store.remainOf(r), dateWd: Store.ymdWd(r.date) };
    });
    if (editingLeave) {
      Store.records.forEach(function (r) {
        var d = (r.deductions || []).filter(function (x) { return x.leaveDate === editingLeave; });
        if (!d.length) return;
        var prev = d.reduce(function (s, x) { return s + x.hours; }, 0);
        var p = that._picks[r.id] || (that._picks[r.id] = { checked: true, max: Store.remainOf(r), hours: prev, dateWd: Store.ymdWd(r.date) });
        p.checked = true; p.max = Store.remainOf(r) + prev; p.hours = prev;
      });
    }
  },
  renderPickList: function () {
    var that = this;
    var ids = Object.keys(this._picks);
    var list = ids.map(function (id) {
      var p = that._picks[id];
      return { id: Number(id), checked: p.checked, maxText: Store.fmtH(p.max), hoursText: Store.fmtH(p.hours), dateWd: p.dateWd, selStart: 0, selEnd: 0 };
    });
    this.setData({ 'leave.picks': list, 'leave.avail': Store.fmtH(Store.currentAvailable()) });
  },
  onPickTap: function (e) {
    var id = e.currentTarget.dataset.id, p = this._picks[id];
    if (!p) return;
    p.checked = !p.checked;
    // 勾选默认按「全部剩余」抵扣；之后可直接点击右侧数字改为部分抵扣（支持分次使用当日加班）
    if (p.checked) p.hours = p.max;
    this.renderPickList(); this.updateRt();
  },
  // 抵扣时长可点击编辑：输入规则同「有效加班时长」（数字 + 一个小数点、最多两位小数）
  // 聚焦即全选默认值（同「有效加班时长」），用户可直接键入部分抵扣时长、无需先删除
  onPickAmtFocus: function (e) {
    var id = e.currentTarget.dataset.id, p = this._picks[id];
    if (!p) return;
    var list = this.data.leave.picks, len = Store.fmtH(p.hours).length;
    for (var i = 0; i < list.length; i++) {
      if (Number(list[i].id) === Number(id)) {
        var upd = {};
        upd['leave.picks[' + i + '].selStart'] = 0;
        upd['leave.picks[' + i + '].selEnd'] = len;
        this.setData(upd);
        return;
      }
    }
  },
  onPickAmtInput: function (e) {
    var id = e.currentTarget.dataset.id, p = this._picks[id];
    if (!p) return;
    var raw = Store.filterAmount(e.detail.value);
    var num = Number(raw);
    p.hours = (!raw || isNaN(num)) ? 0 : num;
    p.checked = true;
    this._setPickHoursText(id, raw, e.detail.cursor);   // 仅刷新该行，保留输入形态与光标
    this.updateRt();
  },
  onPickAmtBlur: function (e) {
    var id = e.currentTarget.dataset.id, p = this._picks[id];
    if (!p) return;
    var raw = String(e.detail.value == null ? '' : e.detail.value).trim();
    var num = Number(raw);
    if (!raw || isNaN(num) || num <= 0) num = p.max;   // 留空/非法 → 默认抵扣全部剩余
    if (num > p.max) num = p.max;
    p.hours = Store.r2(num);
    p.checked = true;
    this.renderPickList(); this.updateRt();
  },
  // 输入过程中只更新该行显示文本与光标（避免整表重渲染用 fmtH 覆盖用户输入导致光标跳动）
  _setPickHoursText: function (id, text, cursor) {
    var list = this.data.leave.picks;
    var len = String(text == null ? '' : text).length;
    var cur = (typeof cursor === 'number' && cursor >= 0) ? Math.min(cursor, len) : len;
    for (var i = 0; i < list.length; i++) {
      if (Number(list[i].id) === Number(id)) {
        var upd = {};
        upd['leave.picks[' + i + '].hoursText'] = text;
        upd['leave.picks[' + i + '].selStart'] = cur;
        upd['leave.picks[' + i + '].selEnd'] = cur;
        this.setData(upd);
        return;
      }
    }
  },
  updateRt: function () {
    var that = this, use = 0;
    Object.keys(this._picks).forEach(function (k) { var p = that._picks[k]; if (p.checked) use += p.hours; });
    var after = Store.currentAvailable() - use;
    this.setData({
      'leave.rtUse': Store.fmtH(use),
      'leave.rtAfter': Store.fmtH(Math.max(0, after)),
      'leave.rtNeg': after < 0
    });
  },
  saveLeave: function () {
    var leaveDate = this.data.leave.dateIso;
    if (!leaveDate) { this.toast('请选择调休使用日期'); return; }
    var chosen = Object.keys(this._picks).map(Number).filter(function (id) { return this._picks[id].checked && this._picks[id].hours > 0; }.bind(this));
    if (!chosen.length) { this.toast('请至少勾选一项加班时长'); return; }
    var payload = { leaveDate: leaveDate, items: chosen.map(function (id) { return { id: id, hours: this._picks[id].hours }; }.bind(this)), editingLeave: this._editingLeave };
    var res = Store.applyLeave(payload);
    this.toast(res.toast);
    this.closeSheets();
    this.renderAll();
  },
  /* 注意：swipe-item 的 leaveDate 属性承载的是「显示文本」（如 2026-10-05 · 周一），
     不能直接拿去比对存储里的 ISO 日期；真实日期走 detail.iso（组件透传）。
     之前直接传显示文本，导致撤销/编辑的比对永远不命中 —— 表现为「点撤销没反应」。 */
  onLvEdit: function (e) {
    this.closeAllSwipes();   // 打开编辑 dialog 的同一刻复位该行左滑展开态，避免保存后仍处于左滑
    this.openEditLeave(e.detail.iso || e.detail.leaveDate);
  },
  onLvUndo: function (e) {
    var iso = e.detail.iso || e.detail.leaveDate;
    var res = Store.undoLeave(iso);
    this.toast(res.toast);
    this.renderAll();
  },

  /* ============ 数据导入 ============ */
  openImportSheet: function () {
    this.setData({ imp: { show: false, title: '数据导入', sub: '选择导入方式，数据按记录 ID 合并还原到本机。' } });
    this.openSheet('imp');
  },
  // 从本地文件选择（微信电脑版：系统本地文件对话框）并导入
  onImpLocalFile: function () {
    var that = this;
    wxfile.chooseLocalFile(function (text, fileName) {
      that._applyImportText(text, fileName);
    }, function (msg) { that.toast(msg); });
  },
  // 从微信聊天文件选择（手机端：聊天记录文件）并导入
  onImpChatFile: function () {
    var that = this;
    wxfile.chooseChatFile(function (text, fileName) {
      that._applyImportText(text, fileName);
    }, function (msg) { that.toast(msg); });
  },
  // 从剪贴板粘贴备份文本并导入
  onImpClipboard: function () {
    var that = this;
    wxfile.readClipboard(function (text) {
      if (!String(text || '').trim()) { that.toast('剪贴板为空，请先复制备份文本'); return; }
      that._applyImportText(text, '剪贴板');
    }, function (msg) { that.toast(msg); });
  },
  // 解析备份文本并按记录 ID 合并；label 为来源名称（文件名 / 剪贴板）
  _applyImportText: function (text, label) {
    var p = wxfile.parsePayload(text);
    if (!p.ok) { this.toast(p.msg); return; }
    if (!p.list.length) { this.toast('备份文件中没有可导入的记录'); return; }
    var r = Store.mergeImport(p.list);
    this.closeSheets();
    this.renderAll();
    var head = label ? '「' + label + '」' : '';
    if (r.added === 0 && r.kept === 0) {
      this.toast(head + '未导入任何记录：' + r.skipped + ' 条数据不完整', 2600);
      return;
    }
    var msg = head + '导入完成：新增 ' + r.added + ' 条 · 覆盖 ' + r.kept + ' 条';
    if (r.skipped) msg += ' · 跳过 ' + r.skipped + ' 条异常';
    this.toast(msg, 2600);
  },

  /* ============ 数据导出 ============ */
  openExportSheet: function () {
    var that = this;
    this.setData({
      exp: {
        show: false, title: '数据导出', sub: '备份文件已生成，请选择导出方式',
        file: wxfile.exportFileName(), meta: wxfile.exportMeta(), raw: wxfile.exportJson(), path: ''
      }
    });
    this.openSheet('exp');
    // 关键：面板一打开就把备份写入临时文件，使后续「发送到微信 / 保存到本地」
    // 无需再异步写文件，可在点击手势的同步链路内直接调用分享接口。
    wxfile.prepareExport(function (path) {
      that.setData({ 'exp.path': path || '' });
    });
  },
  // 保存到本地文件：仅电脑端支持；当前环境不支持或保存失败时自动回退为复制文本
  onExpSaveDisk: function () {
    var that = this, name = this.data.exp.file;
    var run = function (p) {
      wxfile.saveToDisk(p, name, function (ok) {
        if (ok) { that.closeSheets(); that.toast('备份文件已保存到本地'); return; }
        wxfile.copyToClipboard(that.data.exp.raw, function (copied) {
          that.closeSheets();
          that.toast(copied ? '当前环境不支持保存到本地，已复制备份文本' : '保存失败，请改用「复制为文本」', 2400);
        });
      });
    };
    if (this.data.exp.path) { run(this.data.exp.path); return; }
    wxfile.prepareExport(function (p) { run(p); });   // 兜底：预写尚未完成时同步补写
  },
  // 发送到微信：唤起微信的文件转发面板，由用户选择会话后发出
  // 必须使用预写好的本地路径同步调用（否则失去点击手势会导致首次失败）
  onExpShare: function () {
    var that = this, name = this.data.exp.file;
    var run = function (p) {
      wxfile.shareToChat(p, name, function (status) {
        if (status === 'ok') { that.closeSheets(); return; }
        if (status === 'cancel') { that.toast('已取消发送'); return; }
        if (status === 'unsupported') { that.toast('当前环境不支持转发文件，请改用「保存到本地」或「复制为文本」', 2600); return; }
        that.toast('发送失败，请重试');
      });
    };
    if (this.data.exp.path) { run(this.data.exp.path); return; }
    wxfile.prepareExport(function (p) { run(p); });   // 兜底：预写尚未完成时同步补写
  },
  // 复制备份文本到剪贴板
  onExpCopy: function () {
    var that = this;
    wxfile.copyToClipboard(this.data.exp.raw, function (ok) {
      if (ok) { that.closeSheets(); that.toast('备份文本已复制到剪贴板'); }
      else { that.toast('复制失败，请重试'); }
    });
  },

  /* ============ Toast ============ */
  toast: function (msg, dur) {
    var that = this;
    this.setData({ toastMsg: msg, toastShow: true });
    if (this._toastTimer) clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(function () { that.setData({ toastShow: false }); }, dur || 1900);
  }
});
