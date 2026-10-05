const privacy = require('../../utils/privacy.js');

Component({
  data: {
    show: false,
    privacyContractName: '《隐私保护指引》'
  },

  lifetimes: {
    attached: function () {
      const that = this;

      // 把"如何显示弹窗"的钩子注册给全局协调器，供 app 在隐私接口触发时调用
      privacy.registerShow(function () {
        that.setData({ show: true });
      });

      // 首次启动若需授权，主动拉起一次（同时会把系统授权状态落库，用户同意后不再弹）
      if (typeof wx.getPrivacySetting === 'function') {
        wx.getPrivacySetting({
          success: function (res) {
            if (res.needAuthorization) {
              that.setData({
                privacyContractName: res.privacyContractName || '《隐私保护指引》'
              });
              if (typeof wx.requirePrivacyAuthorize === 'function') {
                // 触发全局 onNeedPrivacyAuthorize -> 由协调器 show() 显示当前页弹窗
                wx.requirePrivacyAuthorize({
                  success: function () {},
                  fail: function () {}
                });
              } else {
                // 低版本基础库：无回调能力，直接显示
                that.setData({ show: true });
              }
            }
          },
          fail: function () {}
        });
      }
    }
  },

  methods: {
    // 打开微信官方隐私协议（内容在公众平台「隐私保护指引」中配置）
    openContract: function () {
      if (typeof wx.openPrivacyContract === 'function') {
        wx.openPrivacyContract({ fail: function () {} });
      }
    },

    handleAgree: function () {
      const resolve = privacy.getPendingResolve();
      this.setData({ show: false });
      if (typeof resolve === 'function') {
        resolve({ event: 'agree' });
        privacy.clearPendingResolve();
      }
    },

    handleDisagree: function () {
      const resolve = privacy.getPendingResolve();
      this.setData({ show: false });
      if (typeof resolve === 'function') {
        resolve({ event: 'disagree' });
        privacy.clearPendingResolve();
      }
    },

    // 点击遮罩不关闭，强制用户做出选择
    noop: function () {}
  }
});
