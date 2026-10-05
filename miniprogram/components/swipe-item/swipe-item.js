/**
 * 自绘左滑操作组件（列表项左滑露出操作按钮）。
 *  - 动作按钮：修改(蓝) + 删除/撤销(红)，各 76px，合计 ACTION=152；
 *  - 滑动只负责「露出/收起」按钮，绝不删除；删除/撤销仅由点击已露出的按钮触发；
 *  - 展开/拖拽态容器转主色蓝（与最内侧按钮同色），动作条闭合态 visibility:hidden，杜绝圆角渗色；
 *  - 横向拖动时通过 bind:lock 通知页面锁定 scroll-view 滚动；纵向手势不拦截，正常滚动列表；
 *  - 通过 closeToken + openKey 实现「全局仅一个展开行」，与页面内的下拉/弹层/切页互斥关闭；
 *  - 拖拽结束后短暂 suppress，屏蔽合成 click，避免「一滑就误触」。
 */
Component({
  properties: {
    recId: { type: Number, value: 0 },
    /* leaveDate 为「展示文本」（如 2026-10-05 · 周一）；iso 为真实日期，供页面
       做撤销/编辑时的数据比对（不可拿展示文本去比对存储里的 ISO 日期）。 */
    leaveDate: { type: String, value: '' },
    iso: { type: String, value: '' },
    delLabel: { type: String, value: '删除' },
    closeToken: { type: Number, value: 0 },
    openKey: { type: String, value: '' }
  },
  data: {
    offset: 0,
    open: false,
    revealing: false,
    dragging: false
  },
  observers: {
    'closeToken': function (tok) {
      if (this._lastToken === undefined) { this._lastToken = tok; return; }
      if (this._lastToken === tok) return;
      this._lastToken = tok;
      // 仅当本行不是当前全局展开行时才收起（保证「单展开」语义）
      if (this.myKey() !== this.data.openKey) this.closeSelf(true);
    }
  },
  methods: {
    myKey: function () {
      return this.data.leaveDate ? ('l' + this.data.leaveDate) : ('r' + this.data.recId);
    },
    ts: function (e) {
      var t = e.touches[0]; if (!t) return;
      this._sx = t.clientX; this._sy = t.clientY;
      this._moved = false; this._dragging = false; this._suppress = false;
      // 由闭合态起手：先撤蓝底，待真正左移露出时再叠加；已展开态保留蓝底（与拖拽中一致）
      this.setData({ dragging: false, revealing: this.data.open });
    },
    tm: function (e) {
      var t = e.touches[0]; if (!t) return;
      var dx = t.clientX - this._sx, dy = t.clientY - this._sy;
      if (!this._moved) {
        if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 6) {
          this._moved = true; this._dragging = true;
          this.setData({ dragging: true });
          this.triggerEvent('lock', { v: true });   // 横向拖动：锁定列表滚动
        } else if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 6) {
          this._dragging = false; return;           // 纵向：放行，列表正常滚动
        } else { return; }
      }
      if (!this._dragging) return;
      var ACTION = 152;
      var cur = (this.data.open ? (-ACTION + dx) : dx);
      cur = Math.max(-ACTION, Math.min(0, cur));
      this.setData({ offset: cur, revealing: (cur < -0.5) || this.data.open });
    },
    te: function () {
      if (!this._dragging) {
        if (this.data.open) this.closeItem();        // 纯点击已展开卡片 -> 收起
        return;
      }
      this._dragging = false;
      this.setData({ dragging: false });
      this._suppress = true;                          // 拖拽后屏蔽合成 click
      var self = this;
      clearTimeout(this._supTimer);
      this._supTimer = setTimeout(function () { self._suppress = false; }, 350);
      var ACTION = 152;
      if (this.data.offset <= -ACTION / 2) this.openItem();
      else this.closeItem();
    },
    snap: function (toOpen) {
      var ACTION = 152, self = this;
      this.setData({ open: toOpen, revealing: true, offset: toOpen ? -ACTION : 0 });
      clearTimeout(this._revealT);
      this._revealT = setTimeout(function () {
        if (!self.data.open) self.setData({ revealing: false });  // 完全收起后才撤蓝底
      }, 260);
      this.triggerEvent('lock', { v: false });
    },
    openItem: function () {
      this.snap(true);
      this.triggerEvent('open', { key: this.myKey() });
    },
    closeItem: function () {
      this.snap(false);
      this.triggerEvent('close', { key: this.myKey() });
    },
    closeSelf: function (silent) {
      this.snap(false);
      if (!silent) {
        this.triggerEvent('close', { key: this.myKey() });
      }
    },
    onEdit: function () {
      if (this._suppress || !this.data.open) return;  // 未滑出或拖拽后误触：忽略
      this.triggerEvent('edit', { recId: this.data.recId, leaveDate: this.data.leaveDate, iso: this.data.iso });
    },
    onDelete: function () {
      if (this._suppress || !this.data.open) return;
      this.triggerEvent('delete', { recId: this.data.recId, leaveDate: this.data.leaveDate, iso: this.data.iso });
    },
    onContentTap: function () {
      if (this._suppress) return;
      if (this.data.open) this.closeItem();
    }
  }
});
