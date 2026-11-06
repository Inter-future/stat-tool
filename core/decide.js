/* Correlation Studio · core/decide.js
 * 第 2 层：方法决策 + 可靠性评级 + 全变量扫描
 *
 * 设计原则：
 *  - 规则可查、可覆盖：每条建议都带 ruleId 与具体理由，用户可手动改方法
 *  - 只建议不禁止：被"排除"的方法仍给出原因，而不是从界面消失
 *  - 可靠性是清单 + 三档，不是 0–100 分：每个扣分项都要能指到具体数字
 */
(function (global) {
  'use strict';
  var CS = global.CS || (global.CS = {});
  var S = CS.stat, D = CS.data;

  /* ---------------- 多重比较 ---------------- */
  function bhAdjust(pvals) {
    var m = pvals.length, idx = [], out = new Array(m), i;
    for (i = 0; i < m; i++) idx.push(i);
    idx.sort(function (a, b) { return pvals[a] - pvals[b]; });
    var prev = 1;
    for (i = m - 1; i >= 0; i--) {
      var k = i + 1, v = pvals[idx[i]] * m / k;
      prev = Math.min(prev, v);
      out[idx[i]] = Math.min(1, prev);
    }
    return out;
  }
  function holmAdjust(pvals) {
    var m = pvals.length, idx = [], out = new Array(m), i;
    for (i = 0; i < m; i++) idx.push(i);
    idx.sort(function (a, b) { return pvals[a] - pvals[b]; });
    var prev = 0;
    for (i = 0; i < m; i++) {
      var v = Math.min(1, pvals[idx[i]] * (m - i));
      prev = Math.max(prev, v);
      out[idx[i]] = prev;
    }
    return out;
  }

  /* ---------------- 分类变量的关联：Cramér's V ---------------- */
  function cramersV(xa, xb) {
    var rowKeys = {}, colKeys = {}, i;
    var rows = [], cols = [];
    for (i = 0; i < xa.length; i++) {
      if (!rowKeys[xa[i]]) { rowKeys[xa[i]] = rows.length + 1; rows.push(xa[i]); }
      if (!colKeys[xb[i]]) { colKeys[xb[i]] = cols.length + 1; cols.push(xb[i]); }
    }
    var R = rows.length, C = cols.length, n = xa.length;
    if (R < 2 || C < 2) throw new Error('两个变量至少各需 2 个类别');
    var O = [], r, c;
    for (r = 0; r < R; r++) { O.push(new Array(C).fill(0)); }
    for (i = 0; i < n; i++) O[rowKeys[xa[i]] - 1][colKeys[xb[i]] - 1]++;
    var rowSum = new Array(R).fill(0), colSum = new Array(C).fill(0);
    for (r = 0; r < R; r++) for (c = 0; c < C; c++) { rowSum[r] += O[r][c]; colSum[c] += O[r][c]; }
    var chi2 = 0;
    for (r = 0; r < R; r++) for (c = 0; c < C; c++) {
      var E = rowSum[r] * colSum[c] / n;
      if (E > 0) chi2 += (O[r][c] - E) * (O[r][c] - E) / E;
    }
    var df = (R - 1) * (C - 1);
    /* 卡方上尾 = 正则化上不完全 gamma Q(df/2, chi2/2) */
    var p = gammaQ(df / 2, chi2 / 2);
    return { v: Math.sqrt(chi2 / (n * Math.min(R - 1, C - 1))), chi2: chi2, df: df, p: p, n: n, R: R, C: C };
  }
  function gammaQ(a, x) {
    function lnGamma(z) {
      var p = [676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
        12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
      if (z < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * z)) - lnGamma(1 - z);
      z -= 1; var x2 = 0.99999999999980993;
      for (var i = 0; i < p.length; i++) x2 += p[i] / (z + i + 1);
      var t = z + 7.5;
      return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x2);
    }
    if (x <= 0) return 1;
    if (x < a + 1) {
      var ap = a, sum = 1 / a, del = sum;
      for (var n = 0; n < 500; n++) { ap++; del *= x / ap; sum += del; if (Math.abs(del) < Math.abs(sum) * 1e-15) break; }
      return 1 - sum * Math.exp(-x + a * Math.log(x) - lnGamma(a));
    }
    var b = x + 1 - a, cc = 1e300, d = 1 / b, h = d;
    for (var i2 = 1; i2 < 500; i2++) {
      var an = -i2 * (i2 - a);
      b += 2; d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
      cc = b + an / cc; if (Math.abs(cc) < 1e-300) cc = 1e-300;
      d = 1 / d; var del2 = d * cc; h *= del2;
      if (Math.abs(del2 - 1) < 1e-15) break;
    }
    return Math.exp(-x + a * Math.log(x) - lnGamma(a)) * h;
  }

  /* ---------------- 分类 × 连续：相关比 η ---------------- */
  /* 名义多分类变量与连续变量之间不能用 Cramér's V（连续变量会被拆成 n 个类别），
     正确指标是相关比 η = sqrt(SSB/SST)，等价于单因素方差分析的解释比例。 */
  function correlationRatio(groups, values) {
    var map = {}, order = [], i;
    for (i = 0; i < groups.length; i++) {
      var g = String(groups[i]);
      if (!map[g]) { map[g] = []; order.push(g); }
      map[g].push(+values[i]);
    }
    var n = 0, grand = 0, k = order.length;
    order.forEach(function (g) { map[g].forEach(function (v) { grand += v; n++; }); });
    if (n === 0 || k < 2) throw new Error('类别不足');
    grand /= n;
    var ssb = 0, ssw = 0;
    order.forEach(function (g) {
      var a = map[g], m = 0, j;
      for (j = 0; j < a.length; j++) m += a[j];
      m /= a.length;
      ssb += a.length * (m - grand) * (m - grand);
      for (j = 0; j < a.length; j++) ssw += (a[j] - m) * (a[j] - m);
    });
    var sst = ssb + ssw, df1 = k - 1, df2 = n - k;
    var eta2 = sst > 0 ? ssb / sst : 0;
    var F = df2 > 0 && ssw > 0 ? (ssb / df1) / (ssw / df2) : NaN;
    /* F 上尾 = I_{df2/(df2+df1·F)}(df2/2, df1/2) */
    var p = isFinite(F) ? S.ibeta(df2 / (df2 + df1 * F), df2 / 2, df1 / 2) : NaN;
    return { eta: Math.sqrt(eta2), eta2: eta2, F: F, df1: df1, df2: df2, p: p, n: n, k: k };
  }

  /* ---------------- 规则引擎 ---------------- */
  /* 每条规则：{id, when(ctx), apply(ctx, memo)}，按顺序求值，结果写入 memo */
  function buildContext(rows, headers, x, y, opts) {
    opts = opts || {};
    var colInfo = {};
    headers.forEach(function (h) {
      colInfo[h] = D.columnProfile(rows.map(function (r) { return r[h]; }), h);
    });
    var cx = colInfo[x], cy = colInfo[y];
    var xs = rows.map(function (r) { return r[x]; }), ys = rows.map(function (r) { return r[y]; });
    var al = S.align(xs, ys);
    var n = al.n;
    var xCat = cx.type === 'categorical' || cx.type === 'binary';
    var yCat = cy.type === 'categorical' || cy.type === 'binary';
    var ctx = {
      x: x, y: y, n: n, total: rows.length, removed: al.removed,
      xType: cx.type, yType: cy.type, xInfo: cx, yInfo: cy,
      isCategorical: function (t) { return t === 'categorical' || t === 'binary'; },
      bothCat: xCat && yCat,
      /* 多分类 × 连续：既不能用 Cramér's V（连续变量会被拆成 n 类），也不能用 Pearson */
      mixedCat: (cx.type === 'categorical' && cy.type === 'continuous') ? 'x'
        : ((cy.type === 'categorical' && cx.type === 'continuous') ? 'y' : null),
      alpha: opts.alpha || 0.05
    };
    if (n < 3) return ctx;

    /* 单调关系的"结"比例：用来判断是否该用秩方法 */
    var rx = S.ranks(al.x);
    ctx.ties = 1 - new Set(rx).size / n;

    if (ctx.bothCat) {
      ctx.cramers = cramersV(rows.map(function (r) { return r[x]; }), rows.map(function (r) { return r[y]; }));
      return ctx;
    }

    ctx.pearson = S.pearsonTest(al.x, al.y);
    ctx.spearman = S.spearman(al.x, al.y);
    try { ctx.kendall = S.kendall(al.x, al.y); } catch (e) { ctx.kendall = null; }
    if (ctx.mixedCat) {
      /* 多分类 × 连续：用相关比 η。注意必须按行对齐后再算，不能拿已对齐的数值列配未对齐的标签 */
      var gRaw = ctx.mixedCat === 'x' ? xs : ys;
      var vRaw = ctx.mixedCat === 'x' ? ys : xs;
      var gl = [], vl = [], t;
      for (t = 0; t < gRaw.length; t++) {
        var gv = gRaw[t], vv = D.num(vRaw[t]);
        if (gv === null || gv === undefined || String(gv).trim() === '' || !isFinite(vv)) continue;
        gl.push(gv); vl.push(vv);
      }
      try { ctx.eta = correlationRatio(gl, vl); } catch (e) { ctx.eta = null; }
      return ctx;
    }
    if (n <= (opts.dcorMaxN || 400) && opts.dcor !== false) {
      try {
        var dv = S.dcor(al.x, al.y).v;
        var pm = S.permTest(function (a, b) { return S.dcor(a, b).v; }, al.x, al.y, opts.dcorB || 199, 20260101);
        ctx.dcor = { v: dv, p: pm.p, B: pm.B, minP: pm.minP };
      } catch (e) { ctx.dcor = null; }
    }
    if (n <= (opts.infMaxN || 3000)) ctx.influence = D.influence(al.x, al.y);
    ctx.ciPearson = S.fisherCI(ctx.pearson.r, n, 1 - ctx.alpha);
    ctx.ciSpearman = S.fisherCI(ctx.spearman.rho, n, 1 - ctx.alpha);
    return ctx;
  }

  function decide(ctx) {
    var rules = [], primary = null, secondary = [], excluded = [];

    if (ctx.n < 3) {
      return { primary: null, secondary: [], excluded: [{ method: 'all', reason: '有效样本 n=' + ctx.n + '，不足以计算任何相关系数', ruleId: 'R00' }],
        reasons: [{ ruleId: 'R00', text: '有效样本不足' }] };
    }
    if (ctx.eta) {
      var catName = ctx.mixedCat === 'x' ? ctx.x : ctx.y;
      var numName = ctx.mixedCat === 'x' ? ctx.y : ctx.x;
      rules.push({ ruleId: 'R04', text: '「' + catName + '」是多分类变量、「' + numName + '」是连续变量：Cramér\'s V 会把连续变量拆成 n 个类别，Pearson 又把类别编码当成数值，两者都不适用；改用相关比 η（等价于单因素方差分析的解释比例）' });
      primary = { method: 'eta', label: '相关比 η', value: ctx.eta.eta, p: ctx.eta.p, n: ctx.eta.n,
        note: 'η² = ' + ctx.eta.eta2.toFixed(3) + '，F(' + ctx.eta.df1 + ',' + ctx.eta.df2 + ') = ' + (isFinite(ctx.eta.F) ? ctx.eta.F.toFixed(2) : '—') };
      excluded.push({ method: 'pearson', reason: '类别编码（1/2/3）的数值大小没有意义，r 会随编码方式改变', ruleId: 'R04' });
      excluded.push({ method: 'cramersv', reason: '连续变量不能当类别处理，否则每个观测自成一类，V 会虚高到接近 1', ruleId: 'R04' });
      return { primary: primary, secondary: [], excluded: excluded, reasons: rules };
    }
    if (ctx.bothCat) {
      rules.push({ ruleId: 'R04', text: '两个变量都是分类变量（' + ctx.xType + '/' + ctx.yType + '），Pearson/Spearman 在该情形下没有意义' });
      primary = { method: 'cramersv', label: "Cramér's V", value: ctx.cramers.v, p: ctx.cramers.p, n: ctx.cramers.n };
      excluded.push({ method: 'pearson', reason: '名义变量编码成数字后算出的 r 只反映编码方式，不是关联强度', ruleId: 'R04' });
      return { primary: primary, secondary: [], excluded: excluded, reasons: rules };
    }
    if (ctx.xType === 'binary' || ctx.yType === 'binary') {
      rules.push({ ruleId: 'R03', text: '含二分类变量：按点二列相关处理——数值等于 Pearson r，解释则按"两组的均值差"来讲' });
    }

    /* 主方法选择
       注意：二分类变量的秩只有 2 个取值，"并列比例"必然接近 1，
       不能用并列规则把它推到 Spearman——点二列才是正确口径。 */
    var tieHigh = ctx.ties > 0.2 && !(ctx.xType === 'binary' || ctx.yType === 'binary');
    var rhoGain = ctx.spearman ? Math.abs(ctx.spearman.rho) - Math.abs(ctx.pearson.r) : 0;
    var dcorGain = ctx.dcor ? ctx.dcor.v - Math.abs(ctx.pearson.r) : 0;
    var nonlinearHint = dcorGain > 0.2;
    if (tieHigh) {
      rules.push({ ruleId: 'R02', text: '并列值占 ' + (ctx.ties * 100).toFixed(0) + '%（>20%），秩方法更稳健' });
      primary = { method: 'spearman', label: 'Spearman ρ', value: ctx.spearman.rho, p: ctx.spearman.p, n: ctx.n, ci: ctx.ciSpearman };
      secondary = [{ method: 'kendall', label: 'Kendall τ-b', value: ctx.kendall && ctx.kendall.tau, p: ctx.kendall && ctx.kendall.p, n: ctx.n }];
    } else if (ctx.xType === 'categorical' || ctx.yType === 'categorical') {
      rules.push({ ruleId: 'R02', text: '含有序分类变量，按秩相关处理' });
      primary = { method: 'spearman', label: 'Spearman ρ', value: ctx.spearman.rho, p: ctx.spearman.p, n: ctx.n, ci: ctx.ciSpearman };
      secondary = [{ method: 'kendall', label: 'Kendall τ-b', value: ctx.kendall && ctx.kendall.tau, p: ctx.kendall && ctx.kendall.p, n: ctx.n }];
    } else if (rhoGain > 0.15) {
      rules.push({ ruleId: 'R02', text: 'ρ = ' + ctx.spearman.rho.toFixed(2) + ' 明显高于 r = ' + ctx.pearson.r.toFixed(2) + '，关系单调但不成直线' });
      primary = { method: 'spearman', label: 'Spearman ρ', value: ctx.spearman.rho, p: ctx.spearman.p, n: ctx.n, ci: ctx.ciSpearman };
      secondary = [{ method: 'kendall', label: 'Kendall τ-b', value: ctx.kendall && ctx.kendall.tau, p: ctx.kendall && ctx.kendall.p, n: ctx.n }];
    } else if (nonlinearHint) {
      rules.push({ ruleId: 'R05', text: '距离相关 ' + ctx.dcor.v.toFixed(2) + ' 明显高于 |r| = ' + Math.abs(ctx.pearson.r).toFixed(2) +
        '，而 |ρ| 也只有 ' + Math.abs(ctx.spearman.rho).toFixed(2) + '：关系非单调，线性与秩方法都会低估依赖' });
      primary = { method: 'dcor', label: '距离相关 V', value: ctx.dcor.v, p: ctx.dcor.p, n: ctx.n, pMethod: 'permutation', B: ctx.dcor.B };
      secondary = [{ method: 'spearman', label: 'Spearman ρ', value: ctx.spearman.rho, p: ctx.spearman.p, n: ctx.n, ci: ctx.ciSpearman }];
      excluded.push({ method: 'pearson', reason: '非单调关系下 r 会趋近 0，不能作为"无关系"的证据', ruleId: 'R05' });
    } else {
      rules.push({ ruleId: 'R01', text: '两个连续变量、样本量 n=' + ctx.n + '，未见明显非线性证据，Pearson 是标准选择' });
      primary = { method: 'pearson', label: 'Pearson r', value: ctx.pearson.r, p: ctx.pearson.p, n: ctx.n, ci: ctx.ciPearson };
      secondary = [{ method: 'spearman', label: 'Spearman ρ', value: ctx.spearman.rho, p: ctx.spearman.p, n: ctx.n, ci: ctx.ciSpearman }];
    }

    /* 补充对照 */
    if (ctx.dcor && !secondary.some(function (s) { return s.method === 'dcor'; })) {
      secondary.push({ method: 'dcor', label: '距离相关 V', value: ctx.dcor.v, p: ctx.dcor.p, n: ctx.n, pMethod: 'permutation', B: ctx.dcor.B });
    }
    if (ctx.influence && Math.abs(ctx.influence.maxDeltaR) > 0.1) {
      rules.push({ ruleId: 'R06', text: '存在强影响点：去掉第 ' + (ctx.influence.worst.index + 1) + ' 行后，r 从 ' + ctx.pearson.r.toFixed(2) + ' 变为 ' + ctx.influence.rWithoutWorst.toFixed(2) });
    }

    /* 排除项 */
    if (ctx.xType === 'binary' || ctx.yType === 'binary') {
      excluded.push({ method: 'spearman', reason: '二分类变量的秩只有两个取值，秩相关与点二列相关在此退化，不增加信息', ruleId: 'R03' });
    }
    excluded.push({ method: 'cramersv', reason: '两个变量都不是名义分类，Cramér\'s V 不适用', ruleId: 'R04' });

    return { primary: primary, secondary: secondary, excluded: excluded, reasons: rules };
  }

  /* ---------------- 矛盾检测 ---------------- */
  function contradictions(ctx) {
    var out = [];
    if (!ctx || ctx.n < 5) return out;
    if (ctx.dcor) {
      if (Math.abs(ctx.dcor.v) - Math.abs(ctx.pearson.r) > 0.2) {
        out.push({ code: 'NONLINEAR', level: 'warn',
          text: '|r| = ' + Math.abs(ctx.pearson.r).toFixed(2) + '，但距离相关 V = ' + ctx.dcor.v.toFixed(2) +
            '。两者差距过大，提示关系可能弯曲或非单调——先看散点图，不要只报 r。' });
      }
    }
    if (ctx.spearman && ctx.pearson && Math.abs(ctx.spearman.rho) - Math.abs(ctx.pearson.r) > 0.15) {
      out.push({ code: 'MONOTONE_NONLINEAR', level: 'info',
        text: 'ρ = ' + ctx.spearman.rho.toFixed(2) + ' 明显高于 r = ' + ctx.pearson.r.toFixed(2) +
          '：关系单调但不成直线（常见于对数、幂、饱和型）。' });
    }
    if (ctx.influence && Math.abs(ctx.influence.maxDeltaR) > 0.2) {
      out.push({ code: 'SINGLE_POINT', level: 'warn',
        text: '去掉 1 个观测，r 从 ' + ctx.pearson.r.toFixed(2) + ' 变为 ' + ctx.influence.rWithoutWorst.toFixed(2) +
          '（Δ = ' + ctx.influence.maxDeltaR.toFixed(2) + '）。结论由单点驱动。' });
    }
    if (ctx.pearson && ctx.pearson.p < 0.05 && Math.abs(ctx.pearson.r) < 0.2) {
      out.push({ code: 'SIGNIFICANT_BUT_WEAK', level: 'info',
        text: 'p < 0.05 但 |r| = ' + Math.abs(ctx.pearson.r).toFixed(2) + '：显著只是因为样本量大，效应很小。' });
    }
    return out;
  }

  /* ---------------- 可靠性 ---------------- */
  function reliability(ctx, dec, opts) {
    opts = opts || {};
    var items = [], critical = false, warnCount = 0;
    var primary = (dec && dec.primary) || ctx.primary || null;
    var r = primary ? primary.value : NaN;
    var ci = primary && primary.ci;
    var ciWidth = ci ? Math.abs(ci.hi - ci.lo) : NaN;

    function item(key, ok, level, text) {
      items.push({ key: key, ok: ok, text: text });
      if (!ok) { if (level === 'critical') critical = true; else warnCount++; }
    }

    item('sample', ctx.n >= 30, 'critical',
      ctx.n >= 30 ? '样本量 n=' + ctx.n + '，达到基本要求' : '样本量 n=' + ctx.n + ' < 30，系数极不稳定');
    item('ci_width', isFinite(ciWidth) && ciWidth < 0.4, 'warn',
      isFinite(ciWidth) ? '95% CI 宽度 ' + ciWidth.toFixed(2) + (ciWidth < 0.4 ? '，较窄' : '，过宽（>0.4），估计精度不足') : '无可用置信区间');
    var de = opts.designEffect || 1;
    item('independence', de < 1.15, de >= 1.5 ? 'critical' : 'warn',
      de >= 1.15
        ? '存在聚集（设计效应 ' + de.toFixed(2) + '），按行计算的 p 值偏小'
        : '未发现重复测量聚集');
    item('influence', !(ctx.influence && Math.abs(ctx.influence.maxDeltaR) > 0.1), 'warn',
      ctx.influence
        ? '最大单点影响 Δr = ' + ctx.influence.maxDeltaR.toFixed(2) + (ctx.influence.maxDeltaR > 0.1 ? '，超过 0.1' : '，可接受')
        : '未做影响点诊断');
    var agree = true, agreeText = '各方法方向一致';
    if (ctx.pearson && ctx.spearman && ctx.pearson.r * ctx.spearman.rho < 0) { agree = false; agreeText = 'Pearson 与 Spearman 方向相反'; }
    else if (ctx.dcor && Math.abs(Math.abs(ctx.pearson.r) - ctx.dcor.v) > 0.35) { agree = false; agreeText = '线性与非线性指标差距过大'; }
    item('agreement', agree, 'critical', agreeText);
    if (opts.adjustedP !== undefined && opts.adjustedP !== null) {
      item('multiplicity', opts.adjustedP < 0.05, 'warn',
        '多重比较校正后 p = ' + opts.adjustedP.toFixed(4) + (opts.adjustedP < 0.05 ? '，仍显著' : '，不再显著'));
    }
    var typeMatch = !((ctx.xType === 'categorical' || ctx.yType === 'categorical') &&
      (primary.method === 'pearson' || primary.method === 'spearman'));
    item('assumption', typeMatch, 'warn',
      typeMatch ? '变量类型与方法匹配' : '变量类型与方法不匹配');

    var sig = primary && primary.p < 0.05;
    var noCI = !ci;
    var crossesZero = ci ? (ci.lo <= 0 && ci.hi >= 0) : false;
    var grade, label;
    if (critical) { grade = 'C'; label = '不建议下结论'; }
    else if (!sig || crossesZero || (isFinite(ciWidth) && ciWidth > 0.6)) { grade = 'C'; label = '不建议下结论'; }
    else if (warnCount === 0) { grade = 'A'; label = '可下结论'; }
    else { grade = 'B'; label = '谨慎解读'; }
    return { grade: grade, label: label, items: items, ciWidth: ciWidth };
  }

  /* ---------------- 单对变量：一条龙 ---------------- */
  function analyzePair(rows, headers, x, y, opts) {
    opts = opts || {};
    var ctx = buildContext(rows, headers, x, y, opts);
    var dec = decide(ctx);
    var cont = contradictions(ctx);
    var rel = reliability(ctx, dec, {
      designEffect: opts.designEffect,
      adjustedP: opts.adjustedP
    });
    return { context: ctx, decision: dec, contradictions: cont, reliability: rel };
  }

  /* ---------------- 全变量扫描 ---------------- */
  function scan(rows, headers, target, opts) {
    opts = opts || {};
    var tInfo = D.columnProfile(rows.map(function (r) { return r[target]; }), target);
    var items = [], tested = [], i;

    headers.forEach(function (h) {
      if (h === target) return;
      var info = D.columnProfile(rows.map(function (r) { return r[h]; }), h);
      var usable = (info.type === 'continuous' || info.type === 'binary' || info.type === 'categorical');
      if (!usable) return;
      if (info.unique < 2) return;
      var al = S.align(rows.map(function (r) { return r[h]; }), rows.map(function (r) { return r[target]; }));
      if (al.n < 4) return;
      var varNom = info.type === 'categorical', tgtNom = tInfo.type === 'categorical';
      var varCat = varNom || info.type === 'binary', tgtCat = tgtNom || tInfo.type === 'binary';
      var rec;
      try {
        if (varCat && tgtCat) {
          var cv = cramersV(rows.map(function (r) { return r[h]; }), rows.map(function (r) { return r[target]; }));
          rec = { method: 'cramersv', label: "Cramér's V", value: cv.v, p: cv.p, n: cv.n, df: cv.df };
        } else if ((varNom && tInfo.type === 'continuous') || (tgtNom && info.type === 'continuous')) {
          var gA = varNom ? rows.map(function (r) { return r[h]; }) : rows.map(function (r) { return r[target]; });
          var vA = varNom ? rows.map(function (r) { return r[target]; }) : rows.map(function (r) { return r[h]; });
          var gl2 = [], vl2 = [], ti;
          for (ti = 0; ti < gA.length; ti++) {
            var gv2 = gA[ti], vv2 = D.num(vA[ti]);
            if (gv2 === null || gv2 === undefined || String(gv2).trim() === '' || !isFinite(vv2)) continue;
            gl2.push(gv2); vl2.push(vv2);
          }
          var et = correlationRatio(gl2, vl2);
          rec = { method: 'eta', label: '相关比 η', value: et.eta, p: et.p, n: et.n, df: et.k - 1, note: 'η² = ' + et.eta2.toFixed(3) };
        } else {
          var pt = S.pearsonTest(al.x, al.y), sp = S.spearman(al.x, al.y);
          var ties = 1 - new Set(S.ranks(al.x)).size / al.n;
          /* 多水平整数按有序处理：水平数多时 Cramér's V 的自由度会让数值虚高 */
          var useRank = (ties > 0.2 && info.type !== 'binary') || info.type === 'categorical';
          var pick = useRank ? { m: 'spearman', v: sp.rho, p: sp.p } : { m: 'pearson', v: pt.r, p: pt.p };
          var ci = S.fisherCI(pick.v, al.n, 1 - (opts.alpha || 0.05));
          rec = { method: pick.m, value: pick.v, p: pick.p, n: al.n, ci: ci };
          if (info.type === 'categorical') rec.note = '有 ' + info.unique + ' 个水平，按有序处理';
        }
      } catch (e) { return; }
      rec.variable = h;
      rec.type = info.type;
      rec.label = rec.method === 'pearson' ? 'Pearson r'
        : rec.method === 'spearman' ? 'Spearman ρ'
        : rec.method === 'cramersv' ? "Cramér's V"
        : rec.method === 'eta' ? '相关比 η' : rec.method;
      rec.ruleId = (rec.method === 'cramersv' || rec.method === 'eta') ? 'R04'
        : (rec.method === 'spearman' ? 'R02' : 'R01');
      items.push(rec);
      tested.push({ idx: items.length - 1, p: rec.p });
    });

    var ps = items.map(function (it) { return isFinite(it.p) ? it.p : 1; });
    var bh = bhAdjust(ps), hm = holmAdjust(ps);
    items.forEach(function (it, k) { it.pBH = bh[k]; it.pHolm = hm[k]; });

    items.sort(function (a, b) { return Math.abs(b.value) - Math.abs(a.value); });
    var m = items.length;
    var multi = m > (opts.multiThreshold || 5);

    items.forEach(function (it) {
      it.significant = isFinite(it.p) && it.p < (opts.alpha || 0.05);
      it.significantBH = it.pBH < (opts.alpha || 0.05);
      it.warning = it.significant && !it.significantBH && multi
        ? '未通过 BH 校正，可能是多重比较造成的假阳性' : '';
    });

    return {
      target: target, targetType: tInfo.type, items: items, m: m,
      multiple: multi,
      note: multi
        ? '同时检验 ' + m + ' 个变量，已给出 BH 与 Holm 校正后的 p。未通过校正的"显著"不要单独引用。'
        : '检验变量数 ' + m + '，未触发多重比较校正（阈值 5）。'
    };
  }

  /* ---------------- 相关矩阵 ---------------- */
  function matrix(rows, headers, opts) {
    opts = opts || {};
    /* 只放连续与二分类：多分类变量之间该用 V 或 η，塞进相关矩阵会给出误导性的数字 */
    var cols = headers.filter(function (h) {
      var p = D.columnProfile(rows.map(function (r) { return r[h]; }), h);
      return p.type === 'continuous' || p.type === 'binary';
    });
    var k = cols.length, values = [], pmat = [], nmat = [], i, j;
    for (i = 0; i < k; i++) { values.push(new Array(k).fill(NaN)); pmat.push(new Array(k).fill(NaN)); nmat.push(new Array(k).fill(0)); }
    for (i = 0; i < k; i++) {
      values[i][i] = 1; pmat[i][i] = 0;
      for (j = i + 1; j < k; j++) {
        var al = S.align(rows.map(function (r) { return r[cols[i]]; }), rows.map(function (r) { return r[cols[j]]; }));
        if (al.n < 4) continue;
        var info = D.columnProfile(rows.map(function (r) { return r[cols[i]]; }), cols[i]);
        var ties = 1 - new Set(S.ranks(al.x)).size / al.n;
        var useRank = (ties > 0.2 && info.type !== 'binary') || info.type === 'categorical';
        var rho, p;
        try {
          if (useRank) { var sp = S.spearman(al.x, al.y); rho = sp.rho; p = sp.p; }
          else { var pt = S.pearsonTest(al.x, al.y); rho = pt.r; p = pt.p; }
        } catch (e) { continue; }
        values[i][j] = values[j][i] = rho;
        pmat[i][j] = pmat[j][i] = p;
        nmat[i][j] = nmat[j][i] = al.n;
      }
    }
    /* 排序：按第一主成分载荷做序列化，让高相关变量相邻 */
    var order = [];
    for (i = 0; i < k; i++) order.push(i);
    if (k > 2) {
      var v = new Array(k).fill(1), w, norm, it;
      for (it = 0; it < 40; it++) {
        w = new Array(k).fill(0);
        for (i = 0; i < k; i++) for (j = 0; j < k; j++) if (isFinite(values[i][j])) w[i] += Math.abs(values[i][j]) * v[j];
        norm = Math.sqrt(w.reduce(function (s, x) { return s + x * x; }, 0)) || 1;
        for (i = 0; i < k; i++) v[i] = w[i] / norm;
      }
      order.sort(function (a, b) { return v[a] - v[b]; });
    }
    var labels = order.map(function (idx) { return cols[idx]; });
    var M = order.map(function (ri) { return order.map(function (ci) { return values[ri][ci]; }); });
    var P = order.map(function (ri) { return order.map(function (ci) { return pmat[ri][ci]; }); });
    return { labels: labels, values: M, p: P, n: nmat, cols: cols, raw: values };
  }

  CS.decide = {
    bhAdjust: bhAdjust, holmAdjust: holmAdjust, cramersV: cramersV, correlationRatio: correlationRatio, matrix: matrix,
    buildContext: buildContext, decide: decide, contradictions: contradictions,
    reliability: reliability, analyzePair: analyzePair, scan: scan
  };
})(typeof window !== 'undefined' ? window : globalThis);
