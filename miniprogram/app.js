// 小程序入口：仅做初始化（数据层在 require 时即完成加载与本地持久化挂载）
const store = require('./utils/store.js');
const privacy = require('./utils/privacy.js');

App({
  globalData: {
    appName: '拾时簿 GleanTime',
    appVersion: 'v1.1.0',
    store: store
  },
  onLaunch: function () {
    // 触发一次加载，确保本地存储契约就绪
    store.load();

    // 隐私合规：注册全局回调，当任意隐私相关接口（文件选择/分享/剪贴板等）
    // 在用户授权前被调用时，由协调器拉起当前页面的隐私授权弹窗
    if (typeof wx.onNeedPrivacyAuthorize === 'function') {
      wx.onNeedPrivacyAuthorize(function (resolve) {
        privacy.setPendingResolve(resolve);
        privacy.show();
      });
    }
  }
});
