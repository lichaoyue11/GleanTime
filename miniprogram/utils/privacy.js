// 隐私授权协调器：在 app.js 的 onNeedPrivacyAuthorize 与页面级 privacy-popup 组件之间传递状态。
// 设计：app 侧注册全局隐私触发回调并保存 resolve；弹窗组件注册自己的"显示钩子"，
// 当隐私接口被调用（或首次启动需授权）时由 app 调用 show() 拉起当前页面的弹窗。

let pendingResolve = null; // 微信传入的 resolve({event:'agree'|'disagree'})，用于告知系统用户选择
let showHook = null;       // 当前页面隐私弹窗的显示函数

function setPendingResolve(fn) {
  pendingResolve = fn;
}

function getPendingResolve() {
  return pendingResolve;
}

function clearPendingResolve() {
  pendingResolve = null;
}

function registerShow(fn) {
  showHook = fn;
}

function show() {
  if (typeof showHook === 'function') {
    showHook();
  }
}

module.exports = {
  setPendingResolve: setPendingResolve,
  getPendingResolve: getPendingResolve,
  clearPendingResolve: clearPendingResolve,
  registerShow: registerShow,
  show: show
};
