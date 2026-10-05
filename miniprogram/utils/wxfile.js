/**
 * 拾时簿 GleanTime —— 文件读写封装（正式版）
 *
 *  导入：① 从本地文件选择（wx.chooseMessageFile，PC 端：弹系统文件对话框）
 *        ② 从微信聊天文件选择（wx.chooseMessageFile，移动端：从会话/聊天记录选择）
 *        ③ 从剪贴板导入（wx.getClipboardData）
 *  导出：① 保存到本地文件（wx.saveFileToDisk，仅 PC 端支持）
 *        ② 发送到微信（wx.shareFileMessage，仅移动端支持）
 *        ③ 复制为文本（wx.setClipboardData）
 *
 *  【平台能力边界｜务必遵守】微信小程序运行在沙箱内，**无法访问系统文件目录**：
 *   - wx.chooseMessageFile 官方语义是「从客户端会话选择文件」，在移动端永远只弹聊天文件列表，
 *     不存在「打开手机文件管理器」的接口（要真正选本地文件只能 web-view + H5 <input type=file>，
 *     且需业务域名与服务器，本项目为纯本地小程序、无后端，故不采用）。
 *     因此移动端不得同时展示「从本地文件选择」与「从微信聊天文件选择」——两者会弹同一页面。
 *   - wx.saveFileToDisk 官方文档标注「微信 Windows 版 / Mac 版：支持」→ 仅 PC，移动端调用必然失败。
 *   - wx.shareFileMessage 官方未标注 Windows / Mac 支持 → 仅移动端（含鸿蒙）。
 *  页面据此用 isMobile() 控制入口显隐（见 index.wxml 的 wx:if），不要再凭猜测展示不可用入口。
 *
 * 约定：
 *  - 所有对外回调均带「能力探测 + 失败回退」，保证真机上不抛错；
 *  - 敏感接口（文件选择 / 剪贴板读写）先经 ensurePrivacy 完成隐私授权，授权后续跑；
 *  - 用户主动取消时静默返回，不产生多余提示；
 *  - 【关键】wx.shareFileMessage 必须在「用户点击手势的同步调用链」内触发，
 *    否则报 fail can only be invoked by user TAP gesture（表现为首次失败、二次才成功）。
 *    故导出面板打开时即把备份写入临时文件（prepareExport），点击时直接使用缓存路径同步调用。
 */
var Store = require('./store.js');

var APP_MARK = 'glean-time-overtime';
// 扩展名过滤跨端兼容：PC 端带点的 '.json' 会导致选中后无反应（须写 'json'），
// 而 iOS 端会对扩展名做去点处理、反而需要带点的 '.json'；故两种写法都声明，兼容双端。
var EXT = ['json', '.json'];

/* 导出临时文件缓存：{ path, name, json } */
var _exp = { path: '', name: '', json: '' };

/* ---------------- 文本 / 时间 ---------------- */
function pad2(n) { return (n < 10 ? '0' : '') + n; }
function localDate() {
  var d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}
function localStamp() {
  var d = new Date();
  return localDate() + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}
function toast(msg, dur) { wx.showToast({ title: msg, icon: 'none', duration: dur || 2000 }); }

/* 运行平台：用于区分「电脑端 / 移动端」的能力差异 */
function platform() {
  try {
    var i = wx.getDeviceInfo ? wx.getDeviceInfo() : wx.getSystemInfoSync();
    return String((i && i.platform) || '').toLowerCase();
  } catch (e) { return ''; }
}
function isPC() { var p = platform(); return p.indexOf('windows') >= 0 || p.indexOf('mac') >= 0 || p === 'ohos_pc'; }
/* 移动端：iPhone / iPad、Android、HarmonyOS 手机端。
   注意 devtools（微信开发者工具）不算移动端——工具里可正常调起本地文件对话框，
   与真实 PC 端一致，故按非移动端处理。
   platform 合法值（wx.getDeviceInfo）：ios / android / ohos / ohos_pc / windows / mac / devtools。
   未知平台（空串等）按非移动端处理，保持 PC 端完整入口，避免误伤。 */
function isMobile() { var p = platform(); return p === 'ios' || p === 'android' || p === 'ohos'; }

/* ---------------- 隐私授权 ----------------
   文件选择 / 剪贴板读写属于「隐私接口」。app.json 已关闭 __usePrivacyCheck__，
   微信不再对未在后台声明隐私协议的接口做前置拦截（否则会以
   「xxx:fail api scope is not declared in the privacy agreement」直接失败）。
   这里仍尽力走一次 requirePrivacyAuthorize（若宿主要求弹窗授权可正常弹出），
   但无论成功/失败都继续执行真正逻辑——避免「未配置隐私协议 → 整条链路被卡死」，
   真正的失败交由各接口自身的 fail 回调反馈。 */
function ensurePrivacy(next) {
  if (typeof wx.requirePrivacyAuthorize !== 'function') { next(); return; }
  var done = false;
  var go = function () { if (done) return; done = true; next(); };
  try { wx.requirePrivacyAuthorize({ success: go, fail: go }); }
  catch (e) { go(); }
}

/* ---------------- 导出内容 ---------------- */
function exportJson() { return JSON.stringify(Store.buildPayload(), null, 2); }
function exportFileName() { return 'overtime_records_' + localDate() + '.json'; }
function exportMeta() { return Store.records.length + ' 条加班记录 · 生成于 ' + localStamp(); }

/* ---------------- 导入：解析备份文本 ----------------
   兼容两种历史格式：{ records: [...] } 与裸数组 [...]；剥离 BOM 与首尾空白。 */
function parsePayload(text) {
  var raw = String(text == null ? '' : text).replace(/^\uFEFF/, '').trim();
  if (!raw) return { ok: false, msg: '文件内容为空' };
  var payload;
  try { payload = JSON.parse(raw); } catch (e) { return { ok: false, msg: '内容不是有效的 JSON 数据' }; }
  var list = Array.isArray(payload) ? payload : (payload && payload.records);
  if (!Array.isArray(list)) return { ok: false, msg: '备份格式不正确：缺少 records 记录集' };
  return { ok: true, list: list, app: (payload && payload.app) || '' };
}

/* ---------------- 导入：选择备份文件 → 文本 ----------------
   wx.chooseMessageFile 在电脑端直接弹出本地文件对话框（从本地文件选择），
   在手机端从微信聊天记录选择文件；两种入口共用同一接口，由平台决定具体交互。
   回退语义：能力不存在 → 提示；用户取消 → 静默；读取失败 → 提示。 */
function _pickJsonFile(onOk, onFail) {
  if (typeof wx.chooseMessageFile !== 'function') { onFail && onFail('当前微信版本不支持选择文件'); return; }
  ensurePrivacy(function () {
    wx.chooseMessageFile({
      count: 1, type: 'file', extension: EXT,
      success: function (res) {
        var f = res && res.tempFiles && res.tempFiles[0];
        if (!f || !f.path) return;                       // 未选中：静默
        wx.getFileSystemManager().readFile({
          filePath: f.path, encoding: 'utf8',
          success: function (r) { onOk(String(r.data == null ? '' : r.data), f.name || '备份文件'); },
          fail: function () { onFail && onFail('文件读取失败，请重试'); }
        });
      },
      fail: function (err) {
        if (err && /cancel/i.test(err.errMsg || '')) return;   // 用户取消：静默
        onFail && onFail('无法打开文件选择器，请重试');
      }
    });
  });
}
// 从本地文件选择（微信电脑版：系统文件对话框；手机端回退为聊天文件选择）
function chooseLocalFile(onOk, onFail) { _pickJsonFile(onOk, onFail); }
// 从微信聊天文件选择（手机端：聊天记录文件列表）
function chooseChatFile(onOk, onFail) { _pickJsonFile(onOk, onFail); }

/* ---------------- 导入：剪贴板 → 文本 ---------------- */
function readClipboard(onOk, onFail) {
  if (typeof wx.getClipboardData !== 'function') { onFail && onFail('当前微信版本不支持读取剪贴板'); return; }
  ensurePrivacy(function () {
    wx.getClipboardData({
      success: function (r) { onOk(String((r && r.data) || '')); },
      fail: function () { onFail && onFail('读取剪贴板失败，请重试'); }
    });
  });
}

/* ---------------- 导出：预写临时文件 ----------------
   在「打开导出面板」时调用：把最新备份写入临时文件并缓存路径。
   优先同步写入（writeFileSync）：面板由点击手势打开，同步写不脱离手势，
   用户点击「发送到微信 / 保存到本地」时文件已就绪，分享接口可直接在同步链路内唤起；
   同步不支持时回退异步写。写入失败时 path 为空字符串。 */
function prepareExport(cb) {
  var json = exportJson(), name = exportFileName();
  var p = wx.env.USER_DATA_PATH + '/' + name;
  try {
    wx.getFileSystemManager().writeFileSync(p, json, 'utf8');
    _exp = { path: p, name: name, json: json };
    cb && cb(p, name);
    return;
  } catch (e) { /* 部分基础库无同步接口，回退异步 */ }
  wx.getFileSystemManager().writeFile({
    filePath: p, data: json, encoding: 'utf8',
    success: function () { _exp = { path: p, name: name, json: json }; cb && cb(p, name); },
    fail: function () { _exp = { path: '', name: name, json: json }; cb && cb('', name); }
  });
}
function preparedPath() { return _exp.path; }
function preparedName() { return _exp.name; }

/* ---------------- 导出：保存到本地文件（仅电脑端支持） ----------------
   path 可为预写路径；未预写时内部补写。失败回调 false，由页面回退为「复制为文本」。 */
function saveToDisk(path, name, cb) {
  var run = function (p) {
    if (typeof wx.saveFileToDisk !== 'function') { cb(false); return; }
    wx.saveFileToDisk({
      filePath: p,                     // 参数名为 filePath（非 tempFilePath）
      success: function () { cb(true); },
      fail: function () { cb(false); }
    });
  };
  if (path) { run(path); return; }
  prepareExport(function (p) { run(p); });
}

/* ---------------- 导出：发送到微信 ----------------
   【必须同步调用】wx.shareFileMessage 只在用户点击手势的同步链路内可用。
   回调 status ∈ 'ok' | 'cancel' | 'unsupported' | 'error' */
function shareToChat(path, name, cb) {
  if (!path) { cb('error'); return; }
  if (typeof wx.shareFileMessage !== 'function') { cb('unsupported'); return; }
  wx.shareFileMessage({
    filePath: path, fileName: name,
    success: function () { cb('ok'); },
    fail: function (err) {
      if (err && /cancel/i.test(err.errMsg || '')) { cb('cancel'); return; }
      // 电脑端微信不支持转发文件（API 为空或调用报 not supported）；移动端其它失败归为 error
      var msg = (err && err.errMsg) || '';
      if (isPC() || /not support|not implement|no such api|unsupport/i.test(msg)) { cb('unsupported'); return; }
      cb('error');
    }
  });
}

/* ---------------- 导出：复制为文本 ---------------- */
function copyToClipboard(json, cb) {
  if (typeof wx.setClipboardData !== 'function') { cb && cb(false); return; }
  ensurePrivacy(function () {
    wx.setClipboardData({
      data: typeof json === 'string' ? json : exportJson(),
      success: function () { cb && cb(true); },
      fail: function () { cb && cb(false); }
    });
  });
}

module.exports = {
  APP_MARK: APP_MARK,
  isPC: isPC,
  isMobile: isMobile,
  exportJson: exportJson,
  exportFileName: exportFileName,
  exportMeta: exportMeta,
  parsePayload: parsePayload,
  chooseLocalFile: chooseLocalFile,
  chooseChatFile: chooseChatFile,
  readClipboard: readClipboard,
  prepareExport: prepareExport,
  preparedPath: preparedPath,
  preparedName: preparedName,
  saveToDisk: saveToDisk,
  shareToChat: shareToChat,
  copyToClipboard: copyToClipboard,
  toast: toast
};
