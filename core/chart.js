/* Correlation Studio · core/chart.js
 * 第 3 层：可视化（Canvas，无依赖）
 * 同一套绘制函数同时用于页面显示与报告导出（导出时按 2× 分辨率重绘）
 */
(function (global) {
  'use strict';
  var CS = global.CS || (global.CS = {});
  var S = CS.stat;

  var C = {
    ink: '#172033', muted: '#8b97a8', grid: '#eef1f6', axis: '#cfd8e6',
    blue: '#3778ed', red: '#d93a3a', band: 'rgba(55,120,237,.16)', bandLine: 'rgba(55,120,237,.35)'
  };

  function prep(canvas) {
    var dpr = global.devicePixelRatio || 1;
    var w = canvas.clientWidth || 600, h = canvas.clientHeight || 300;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx: ctx, w: w, h: h };
  }

  function nice(v) {
    if (!isFinite(v)) return '—';
    var a = Math.abs(v);
    if (a !== 0 && (a < 0.01 || a >= 10000)) return v.toExponential(1);
    if (a >= 100) return v.toFixed(0);
    if (a >= 10) return v.toFixed(1);
    return v.toFixed(2);
  }

  function frame(ctx, w, h, pad, xmin, xmax, ymin, ymax, xl, yl, opt) {
    opt = opt || {};
    var nx = opt.nx || 4, ny = opt.ny || 4, i;
    ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
    ctx.fillStyle = C.muted; ctx.font = '11px "Segoe UI", Arial';
    var X = function (v) { return pad.l + (v - xmin) / (xmax - xmin) * (w - pad.l - pad.r); };
    var Y = function (v) { return h - pad.b - (v - ymin) / (ymax - ymin) * (h - pad.t - pad.b); };
    for (i = 0; i <= nx; i++) {
      var gx = xmin + (xmax - xmin) * i / nx;
      ctx.beginPath(); ctx.moveTo(X(gx), pad.t - 4); ctx.lineTo(X(gx), h - pad.b); ctx.stroke();
      ctx.textAlign = 'center'; ctx.fillText(nice(gx), X(gx), h - pad.b + 15);
    }
    for (i = 0; i <= ny; i++) {
      var gy = ymin + (ymax - ymin) * i / ny;
      ctx.beginPath(); ctx.moveTo(pad.l, Y(gy)); ctx.lineTo(w - pad.r, Y(gy)); ctx.stroke();
      ctx.textAlign = 'right'; ctx.fillText(nice(gy), pad.l - 7, Y(gy) + 4);
    }
    ctx.strokeStyle = C.axis; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad.l, pad.t - 4); ctx.lineTo(pad.l, h - pad.b); ctx.lineTo(w - pad.r, h - pad.b); ctx.stroke();
    ctx.fillStyle = '#68758a'; ctx.font = '12px "Segoe UI", Arial'; ctx.textAlign = 'center';
    if (xl) ctx.fillText(xl, (pad.l + w - pad.r) / 2, h - 8);
    if (yl) {
      ctx.save(); ctx.translate(12, (pad.t + h - pad.b) / 2); ctx.rotate(-Math.PI / 2); ctx.fillText(yl, 0, 0); ctx.restore();
    }
    return { X: X, Y: Y };
  }

  /* ---------------- 散点 + 拟合 + 自助带 ---------------- */
  function drawScatter(ctx, w, h, o) {
    var pts = [], i;
    for (i = 0; i < o.x.length; i++) {
      var a = CS.data.num(o.x[i]), b = CS.data.num(o.y[i]);
      if (isFinite(a) && isFinite(b)) pts.push([a, b, i]);
    }
    if (pts.length < 2) {
      ctx.fillStyle = C.muted; ctx.font = '13px "Segoe UI"'; ctx.fillText('有效样本不足', 24, 40); return;
    }
    var xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
    pts.forEach(function (p) { xmin = Math.min(xmin, p[0]); xmax = Math.max(xmax, p[0]); ymin = Math.min(ymin, p[1]); ymax = Math.max(ymax, p[1]); });
    if (o.band) {
      o.band.grid.forEach(function (g, k) { ymin = Math.min(ymin, o.band.lo[k]); ymax = Math.max(ymax, o.band.hi[k]); });
    }
    if (ymin === ymax) { ymin -= 1; ymax += 1; }
    var dy = (ymax - ymin) * 0.05; ymin -= dy; ymax += dy;

    var pad = { l: 52, r: 16, t: 16, b: 40 };
    var ax = frame(ctx, w, h, pad, xmin, xmax, ymin, ymax, o.xLabel, o.yLabel, { nx: 4, ny: 4 });

    if (o.band) {
      ctx.beginPath();
      o.band.grid.forEach(function (g, k) { k ? ctx.lineTo(ax.X(g), ax.Y(o.band.hi[k])) : ctx.moveTo(ax.X(g), ax.Y(o.band.hi[k])); });
      for (var k2 = o.band.grid.length - 1; k2 >= 0; k2--) ctx.lineTo(ax.X(o.band.grid[k2]), ax.Y(o.band.lo[k2]));
      ctx.closePath();
      ctx.fillStyle = C.band; ctx.fill();
    }

    if (o.fit) {
      ctx.strokeStyle = '#e28b28'; ctx.lineWidth = 2.2; ctx.beginPath();
      o.band.grid.forEach(function (g, k) {
        var v = o.fit(g);
        k ? ctx.lineTo(ax.X(g), ax.Y(v)) : ctx.moveTo(ax.X(g), ax.Y(v));
      });
      ctx.stroke();
    }

    var hi = o.highlight || [];
    pts.forEach(function (p) {
      var isHi = hi.indexOf(p[2]) >= 0;
      ctx.beginPath(); ctx.arc(ax.X(p[0]), ax.Y(p[1]), isHi ? 5 : 3.2, 0, Math.PI * 2);
      ctx.fillStyle = isHi ? C.red : C.blue; ctx.fill();
      if (isHi) { ctx.strokeStyle = C.red; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(ax.X(p[0]), ax.Y(p[1]), 8, 0, Math.PI * 2); ctx.stroke(); }
    });
  }

  /* ---------------- 残差两联图 ---------------- */
  function drawResiduals(ctx, w, h, o) {
    var half = w / 2, pad = { l: 46, r: 12, t: 16, b: 34 };
    var i;

    /* 左：残差 vs 拟合 */
    var xs = o.fitted, ys = o.residuals;
    var xmin = Math.min.apply(null, xs), xmax = Math.max.apply(null, xs);
    var ymax = Math.max.apply(null, ys.map(Math.abs)) || 1;
    ymax *= 1.1;
    var ax = frame(ctx, half, h, pad, xmin, xmax, -ymax, ymax, '拟合值', '残差', { nx: 3, ny: 4 });
    ctx.strokeStyle = C.axis; ctx.beginPath(); ctx.moveTo(pad.l, ax.Y(0)); ctx.lineTo(half - pad.r, ax.Y(0)); ctx.stroke();
    for (i = 0; i < xs.length; i++) {
      ctx.beginPath(); ctx.arc(ax.X(xs[i]), ax.Y(ys[i]), 2.8, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(55,120,237,.75)'; ctx.fill();
    }

    /* 右：Q-Q */
    ctx.save(); ctx.translate(half, 0);
    var qq = o.qq;
    var tmin = qq[0].theoretical, tmax = qq[qq.length - 1].theoretical;
    var smin = Math.min.apply(null, qq.map(function (q) { return q.sample; }));
    var smax = Math.max.apply(null, qq.map(function (q) { return q.sample; }));
    var pad2 = { l: 46, r: 12, t: 16, b: 34 };
    var ax2 = frame(ctx, half, h, pad2, Math.min(tmin, smin), Math.max(tmax, smax),
      Math.min(tmin, smin), Math.max(tmax, smax), '理论分位数', '样本分位数', { nx: 3, ny: 4 });
    ctx.strokeStyle = C.red; ctx.setLineDash([4, 3]); ctx.beginPath();
    ctx.moveTo(ax2.X(tmin), ax2.Y(tmin)); ctx.lineTo(ax2.X(tmax), ax2.Y(tmax)); ctx.stroke();
    ctx.setLineDash([]);
    qq.forEach(function (q) {
      ctx.beginPath(); ctx.arc(ax2.X(q.theoretical), ax2.Y(q.sample), 2.8, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(55,120,237,.75)'; ctx.fill();
    });
    ctx.restore();
  }

  /* ---------------- 相关热力图 ---------------- */
  function drawHeatmap(ctx, w, h, o) {
    var labels = o.labels, m = o.matrix, n = labels.length;
    if (!n) return;
    var left = 96, top = 14, right = 12, bottom = 78;
    var cw = (w - left - right) / n, ch = (h - top - bottom) / n;

    /* 色标 */
    function color(v) {
      if (!isFinite(v)) return '#f1f3f7';
      var a = Math.min(1, Math.abs(v)) * 0.72;
      return v >= 0 ? 'rgba(55,120,237,' + a + ')' : 'rgba(217,58,58,' + a + ')';
    }
    var i, j;
    for (i = 0; i < n; i++) {
      for (j = 0; j < n; j++) {
        var x = left + j * cw, y = top + i * ch;
        ctx.fillStyle = j >= i ? color(m[i][j]) : '#fafbfd';
        ctx.fillRect(x, y, cw - 1.5, ch - 1.5);
        if (j >= i && isFinite(m[i][j])) {
          ctx.fillStyle = Math.abs(m[i][j]) > 0.55 ? '#fff' : '#33425c';
          ctx.font = Math.min(12, cw * 0.32) + 'px "Segoe UI", Arial';
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          var txt = m[i][j].toFixed(2);
          if (o.stars && o.stars[i] && o.stars[i][j]) txt += o.stars[i][j];
          ctx.fillText(txt, x + cw / 2, y + ch / 2);
        }
      }
    }
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#526176'; ctx.font = '11px "Segoe UI", Arial';
    ctx.textAlign = 'right';
    for (i = 0; i < n; i++) ctx.fillText(labels[i], left - 8, top + i * ch + ch / 2 + 4);
    if (cw > 58) {
      /* 列名放得下就横排，避免旋转后被裁切 */
      ctx.textAlign = 'center';
      for (j = 0; j < n; j++) ctx.fillText(labels[j], left + j * cw + cw / 2, h - bottom + 18);
    } else {
      for (j = 0; j < n; j++) {
        ctx.save();
        ctx.translate(left + j * cw + cw / 2, h - bottom + 10);
        ctx.rotate(-Math.PI / 4);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(labels[j], 0, 0);
        ctx.restore();
      }
    }
    ctx.textBaseline = 'alphabetic';
  }

  /* ---------------- 对外接口 ---------------- */
  CS.chart = {
    scatter: function (canvas, opt) { var p = prep(canvas); drawScatter(p.ctx, p.w, p.h, opt); },
    residuals: function (canvas, opt) { var p = prep(canvas); drawResiduals(p.ctx, p.w, p.h, opt); },
    heatmap: function (canvas, opt) { var p = prep(canvas); drawHeatmap(p.ctx, p.w, p.h, opt); },

    /* 离屏渲染为 PNG dataURL（报告用），scale 控制清晰度 */
    png: function (kind, w, h, opt, scale) {
      scale = scale || 2;
      var cv = document.createElement('canvas');
      cv.width = w * scale; cv.height = h * scale;
      var ctx = cv.getContext('2d');
      ctx.scale(scale, scale);
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
      if (kind === 'scatter') drawScatter(ctx, w, h, opt);
      else if (kind === 'residuals') drawResiduals(ctx, w, h, opt);
      else if (kind === 'heatmap') drawHeatmap(ctx, w, h, opt);
      return cv.toDataURL('image/png');
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
