/* Correlation Studio · core/data.js
 * 第 1 层：数据与诊断（无依赖，依赖 core/stat.js 的分布函数）
 *
 * 设计原则：
 *  - 每个判断都返回 reason，界面直接展示"为什么这么认为"
 *  - 只做诊断，不改数据；所有筛选由调用方显式执行
 *  - 阈值集中在 RULES，便于统一说明
 */
(function (global) {
  'use strict';
  var CS = global.CS || (global.CS = {});
  var S = CS.stat;

  var RULES = {
    iqrK: 1.5,          /* 箱线图须 */
    extremeK: 3.0,      /* 极端值须（3×IQR） */
    madZ: 3.5,          /* 稳健 z 阈值 */
    deltaR: 0.10,       /* 单点对 r 的影响阈值 */
    cookFactor: 4,      /* Cook's D > 4/n */
    missingWarn: 0.05,  /* 缺失率提示线 */
    missingHigh: 0.20,  /* 缺失率警告线 */
    uniqueCat: 10,      /* 整数且不同值 ≤ 10 视为分类 */
    powerTarget: 0.80
  };

  function num(v) {
    if (v === null || v === undefined) return NaN;
    if (typeof v === 'string') { v = v.trim(); if (v === '') return NaN; v = v.replace(/,/g, ''); }
    var n = Number(v);
    return isFinite(n) ? n : NaN;
  }
  function isInt(v) { return Math.abs(v - Math.round(v)) < 1e-9; }

  /* ---------------- 基础矩 ---------------- */
  function moments(a) {
    var n = a.length, s = 0, i;
    for (i = 0; i < n; i++) s += a[i];
    var m = s / n, m2 = 0, m3 = 0, m4 = 0;
    for (i = 0; i < n; i++) {
      var d = a[i] - m, d2 = d * d;
      m2 += d2; m3 += d2 * d; m4 += d2 * d2;
    }
    m2 /= n; m3 /= n; m4 /= n;
    var sd = Math.sqrt(m2 * n / (n - 1)) || 0;
    var g1 = m2 > 0 ? m3 / Math.pow(m2, 1.5) : 0;
    var g2 = m2 > 0 ? m4 / (m2 * m2) - 3 : 0;
    /* 无偏修正（与 scipy bias=False 对齐） */
    var G1 = n > 2 ? g1 * Math.sqrt(n * (n - 1)) / (n - 2) : g1;
    var G2 = n > 3 ? ((n + 1) * g2 + 6) * (n - 1) / ((n - 2) * (n - 3)) : g2;
    return { mean: m, sd: sd, var: sd * sd, g1: g1, g2: g2, G1: G1, G2: G2, n: n };
  }
  function quantile(sorted, p) {
    if (!sorted.length) return NaN;
    var h = (sorted.length - 1) * p, lo = Math.floor(h), hi = Math.min(lo + 1, sorted.length - 1);
    return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
  }

  /* Jarque–Bera：JB = n/6·(g1² + g2²/4)，用有偏矩（经典定义） */
  function jarqueBera(a) {
    var m = moments(a);
    if (m.n < 4 || m.var === 0) return { stat: NaN, p: NaN };
    var jb = m.n / 6 * (m.g1 * m.g1 + m.g2 * m.g2 / 4);
    return { stat: jb, p: Math.exp(-jb / 2) };
  }

  /* ---------------- 类型识别 ---------------- */
  function inferType(values, name) {
    var present = [], i, missing = 0, nonEmptyText = 0;
    for (i = 0; i < values.length; i++) {
      var v = num(values[i]);
      if (isFinite(v)) present.push(v); else {
        missing++;
        if (values[i] !== null && values[i] !== undefined && String(values[i]).trim() !== '') nonEmptyText++;
      }
    }
    var n = present.length;
    if (n === 0) {
      return nonEmptyText > 0
        ? { type: 'text', label: '文本', note: '不含数值，不能进入相关分析', missing: missing, unique: nonEmptyText }
        : { type: 'empty', label: '全空列', note: '没有任何有效数值', missing: missing, unique: 0 };
    }
    var uniq = {}, uCount = 0;
    for (i = 0; i < n; i++) { var k = present[i]; if (!uniq[k]) { uniq[k] = 1; uCount++; } }
    var allInt = present.every(function (v) { return Math.abs(v - Math.round(v)) < 1e-9; });
    var nameHint = /(编号|序号|学号|工号|样本号|受试者|患者|病人|个体|subject|participant|^\s*id\s*$|_id$|代码)/i.test(String(name || ''));
    var type, label, note;

    if (uCount === 1) {
      type = 'constant'; label = '常数'; note = '只有一个取值，不能进入相关分析';
    } else if (uCount === 2) {
      type = 'binary'; label = '二分类'; note = '仅 2 个取值：与连续变量的相关应称"点二列"，数值等于 Pearson';
    } else if (nameHint) {
      type = 'id'; label = '标识列'; note = '列名像编号/受试者，建议作为分组或排除，不参与相关计算';
    } else if (allInt && uCount <= RULES.uniqueCat) {
      type = 'categorical'; label = '分类/等级'; note = '仅 ' + uCount + ' 个整数值；若取值有顺序请按有序变量处理，否则不得直接算 Pearson';
    } else if (allInt && uCount >= n * 0.95 && sequential(present)) {
      type = 'id'; label = '序号'; note = '取值连续递增且近乎唯一，疑似行号';
    } else {
      type = 'continuous'; label = '连续'; note = '取值数 ' + uCount + '，按连续变量处理';
    }
    return { type: type, label: label, note: note, missing: missing, unique: uCount, allInt: allInt };
  }
  function sequential(a) {
    var s = a.slice().sort(function (p, q) { return p - q; }), d = s[1] - s[0];
    if (d !== 1) return false;
    for (var i = 2; i < s.length; i++) if (s[i] - s[i - 1] !== 1) return false;
    return true;
  }

  /* ---------------- 单列概况 ---------------- */
  function columnProfile(values, name) {
    var t = inferType(values, name), present = [], i;
    for (i = 0; i < values.length; i++) { var v = num(values[i]); if (isFinite(v)) present.push(v); }
    var n = present.length;
    var out = { name: name, type: t.type, typeLabel: t.label, typeNote: t.note,
      n: n, missing: values.length - n, missingRate: (values.length - n) / values.length,
      unique: t.unique };

    /* 文本列：不算"缺失 100%"，只统计真正的空白格 */
    if (t.type === 'text' || t.type === 'empty') {
      var blanks = 0;
      for (i = 0; i < values.length; i++) if (!isPresent(values[i])) blanks++;
      out.missing = blanks;
      out.missingRate = values.length ? blanks / values.length : 0;
      out.n = values.length - blanks;
      return out;
    }
    if (n === 0) return out;

    var s = present.slice().sort(function (p, q) { return p - q; });
    out.min = s[0]; out.max = s[n - 1];
    out.median = quantile(s, 0.5);
    out.q1 = quantile(s, 0.25); out.q3 = quantile(s, 0.75);
    out.iqr = out.q3 - out.q1;

    if (t.type !== 'categorical' && t.type !== 'binary' && n >= 3) {
      var m = moments(present);
      out.mean = m.mean; out.sd = m.sd; out.skew = m.G1; out.kurtosis = m.G2;
      var jb = jarqueBera(present);
      out.jb = jb.stat; out.jbP = jb.p;
      /* 离群点（单变量） */
      if (out.iqr > 0) {
        out.outliersIQR = present.filter(function (v) { return v < out.q1 - RULES.iqrK * out.iqr || v > out.q3 + RULES.iqrK * out.iqr; }).length;
        out.outliersExtreme = present.filter(function (v) { return v < out.q1 - RULES.extremeK * out.iqr || v > out.q3 + RULES.extremeK * out.iqr; }).length;
        var med = out.median;
        var dev = present.map(function (v) { return Math.abs(v - med); }).sort(function (p, q) { return p - q; });
        var mad = quantile(dev, 0.5);
        out.mad = mad;
        out.outliersMAD = mad > 0 ? present.filter(function (v) { return Math.abs(0.6745 * (v - med) / mad) > RULES.madZ; }).length : 0;
      }
      /* 天花板 / 地板效应 */
      var cntMin = 0, cntMax = 0;
      for (i = 0; i < n; i++) { if (present[i] === out.min) cntMin++; if (present[i] === out.max) cntMax++; }
      out.atMin = cntMin; out.atMax = cntMax;
      out.floorEffect = cntMin / n >= 0.15;
      out.ceilingEffect = cntMax / n >= 0.15;
      /* 取值范围受限：用极差 / 4SD 粗判 */
      out.rangeRestricted = out.sd > 0 && (out.max - out.min) / out.sd < 2.5;
    } else {
      /* 分类列：给频数 */
      var freq = {}, order = [];
      for (i = 0; i < n; i++) { var key = present[i]; if (!freq[key]) { freq[key] = 0; order.push(key); } freq[key]++; }
      out.freq = order.sort(function (p, q) { return p - q; }).map(function (k) { return { value: k, count: freq[k] }; });
    }
    return out;
  }

  function isPresent(v) {
    if (v === null || v === undefined) return false;
    return String(v).trim() !== '';
  }

  /* ---------------- 数据集整体 ---------------- */
  function profile(headers, rows) {
    var cols = headers.map(function (h) {
      var vals = rows.map(function (r) { return r[h]; });
      return columnProfile(vals, h);
    });
    /* 完整行：按"有没有值"判断，文本列的取值也算有值 */
    var complete = rows.filter(function (r) {
      return headers.every(function (h) { return isPresent(r[h]); });
    }).length;
    var warnings = [];
    cols.forEach(function (c) {
      if (c.type === 'constant') warnings.push({ level: 'error', text: '列「' + c.name + '」为常数，无法参与任何相关分析' });
      if (c.missingRate >= RULES.missingHigh) warnings.push({ level: 'warn', text: '列「' + c.name + '」缺失 ' + (c.missingRate * 100).toFixed(1) + '%，成对删除后该列的有效样本会明显减少' });
      else if (c.missingRate >= RULES.missingWarn) warnings.push({ level: 'info', text: '列「' + c.name + '」缺失 ' + (c.missingRate * 100).toFixed(1) + '%' });
      if (c.type === 'categorical') warnings.push({ level: 'info', text: '列「' + c.name + '」仅 ' + c.unique + ' 个整数值，若为名义分类（如组别编码）请勿直接算 Pearson' });
      if (c.type === 'id') warnings.push({ level: 'info', text: '列「' + c.name + '」疑似标识列，建议从变量列表中排除' });
      if (c.ceilingEffect) warnings.push({ level: 'warn', text: '列「' + c.name + '」有 ' + (c.atMax / c.n * 100).toFixed(0) + '% 观测落在最大值，存在天花板效应，会压低相关系数' });
      if (c.floorEffect) warnings.push({ level: 'warn', text: '列「' + c.name + '」有 ' + (c.atMin / c.n * 100).toFixed(0) + '% 观测落在最小值，存在地板效应' });
    });
    return {
      n: rows.length, columns: cols, completeCases: complete,
      completeRate: rows.length ? complete / rows.length : 0,
      warnings: warnings
    };
  }

  /* ---------------- 缺失模式 ---------------- */
  function missingReport(headers, rows) {
    var perCol = [];
    headers.forEach(function (h) {
      var p = columnProfile(rows.map(function (r) { return r[h]; }), h);
      if (p.missing > 0) perCol.push({ name: h, missing: p.missing, rate: p.missingRate });
    });

    /* 每行缺失的列数分布 */
    var dist = {};
    rows.forEach(function (r) {
      var k = headers.reduce(function (s, h) { return s + (isFinite(num(r[h])) ? 0 : 1); }, 0);
      dist[k] = (dist[k] || 0) + 1;
    });

    /* 最常见的缺失组合 */
    var combo = {};
    rows.forEach(function (r) {
      var key = headers.filter(function (h) { return !isFinite(num(r[h])); }).join('|');
      if (key) combo[key] = (combo[key] || 0) + 1;
    });
    var patterns = Object.keys(combo).map(function (k) { return { columns: k.split('|'), count: combo[k] }; })
      .sort(function (a, b) { return b.count - a.count; }).slice(0, 5);

    return { perColumn: perCol, missingPerRow: dist, topPatterns: patterns,
      completeCases: rows.length - Object.keys(dist).reduce(function (s, k) { return k === '0' ? s : s + dist[k]; }, 0) };
  }

  /* 缺失 vs 观测：该列是否缺失与其他变量有关（MAR 提示） */
  function missingAssociation(headers, rows, colName, targetName) {
    var a = [], b = [];
    rows.forEach(function (r) {
      var t = num(r[targetName]);
      if (!isFinite(t)) return;
      if (isFinite(num(r[colName]))) a.push(t); else b.push(t);
    });
    if (a.length < 3 || b.length < 3) return null;
    var ma = moments(a), mb = moments(b);
    var se = Math.sqrt(ma.var / a.length + mb.var / b.length);
    if (!(se > 0)) return null;
    var t = (ma.mean - mb.mean) / se;
    var p = S.tTestP(t / Math.sqrt(1 + t * t / (a.length + b.length - 2)), a.length + b.length - 2);
    return { target: targetName, column: colName, meanPresent: ma.mean, meanMissing: mb.mean,
      diff: ma.mean - mb.mean, t: t, p: p, nPresent: a.length, nMissing: b.length,
      suspicious: p < 0.05 };
  }

  /* ---------------- 影响点 ---------------- */
  /* 单点对 r 的影响 + 回归 Cook 距离 */
  function influence(x, y, opts) {
    opts = opts || {};
    var d = S.align(x, y), xs = d.x, ys = d.y, n = xs.length;
    if (n < 5) return { n: n, error: '样本不足（n<5）' };
    var r = S.pearson(xs, ys);
    var mx = S.mean(xs), my = S.mean(ys);
    var sxx = 0, syy = 0, sxy = 0, i;
    for (i = 0; i < n; i++) { sxx += (xs[i] - mx) * (xs[i] - mx); syy += (ys[i] - my) * (ys[i] - my); sxy += (xs[i] - mx) * (ys[i] - my); }
    var b1 = sxy / sxx, b0 = my - b1 * mx;
    var sse = 0, pts = [];
    for (i = 0; i < n; i++) {
      var e = ys[i] - (b0 + b1 * xs[i]);
      sse += e * e;
    }
    var mse = sse / (n - 2);
    for (i = 0; i < n; i++) {
      var ei = ys[i] - (b0 + b1 * xs[i]);
      var h = 1 / n + (xs[i] - mx) * (xs[i] - mx) / sxx;
      var cook = mse > 0 ? (ei * ei) / (2 * mse) * h / ((1 - h) * (1 - h)) : 0;
      pts.push({ index: i, x: xs[i], y: ys[i], residual: ei, leverage: h, cook: cook });
    }
    /* 留一法 Δr：用 Σx、Σx²、Σxy 的闭式更新，O(n)，且均值按"去掉 i 后"重算 */
    var Sx = 0, Sy = 0, Sxx = 0, Syy = 0, Sxy = 0;
    for (i = 0; i < n; i++) {
      Sx += xs[i]; Sy += ys[i];
      Sxx += xs[i] * xs[i]; Syy += ys[i] * ys[i]; Sxy += xs[i] * ys[i];
    }
    for (i = 0; i < n; i++) {
      var m = n - 1, mxi = (Sx - xs[i]) / m, myi = (Sy - ys[i]) / m;
      var cxx = (Sxx - xs[i] * xs[i]) - m * mxi * mxi;
      var cyy = (Syy - ys[i] * ys[i]) - m * myi * myi;
      var cxy = (Sxy - xs[i] * ys[i]) - m * mxi * myi;
      pts[i].deltaR = r - (cxx > 0 && cyy > 0 ? cxy / Math.sqrt(cxx * cyy) : NaN);
      pts[i].rExcl = cxx > 0 && cyy > 0 ? cxy / Math.sqrt(cxx * cyy) : NaN;
    }
    var sorted = pts.slice().sort(function (p, q) { return Math.abs(q.deltaR) - Math.abs(p.deltaR); });
    var cookCut = RULES.cookFactor / n;
    var flagged = pts.filter(function (p) { return Math.abs(p.deltaR) > (opts.deltaR || RULES.deltaR) || p.cook > cookCut; });
    return {
      n: n, r: r, slope: b1, intercept: b0,
      maxDeltaR: Math.abs(sorted[0].deltaR),
      worst: sorted[0],
      top: sorted.slice(0, Math.min(5, n)),
      flagged: flagged, cookCut: cookCut,
      /* 去掉最强影响点后的 r */
      rWithoutWorst: r - sorted[0].deltaR
    };
  }

  /* ---------------- 重复测量 / 聚类 ---------------- */
  function clustering(ids, values) {
    var groups = {}, i;
    for (i = 0; i < ids.length; i++) {
      var v = num(values[i]);
      if (!isFinite(v)) continue;
      var k = String(ids[i]);
      if (k === '' || k === 'undefined' || k === 'null') continue;
      (groups[k] = groups[k] || []).push(v);
    }
    var keys = Object.keys(groups), sizes = keys.map(function (k) { return groups[k].length; });
    var N = sizes.reduce(function (a, b) { return a + b; }, 0), K = keys.length;
    var multi = sizes.filter(function (s) { return s > 1; }).length;
    var out = { clusters: K, observations: N, meanSize: K ? N / K : 0, maxSize: Math.max.apply(null, sizes.concat([0])),
      repeated: multi >= 2 && N > K, icc: null, designEffect: null, effectiveN: null };
    if (!out.repeated) return out;

    /* 单因素随机效应 ICC(1) */
    var grand = 0;
    keys.forEach(function (k) { groups[k].forEach(function (v) { grand += v; }); });
    grand /= N;
    var ssb = 0, ssw = 0;
    keys.forEach(function (k) {
      var g = groups[k], m = g.reduce(function (a, b) { return a + b; }, 0) / g.length;
      ssb += g.length * (m - grand) * (m - grand);
      g.forEach(function (v) { ssw += (v - m) * (v - m); });
    });
    var dfB = K - 1, dfW = N - K;
    var msb = ssb / dfB, msw = dfW > 0 ? ssw / dfW : 0;
    var m0 = (N - sizes.reduce(function (s, ni) { return s + ni * ni; }, 0) / N) / (K - 1);
    var icc = (msb + (m0 - 1) * msw) > 0 ? (msb - msw) / (msb + (m0 - 1) * msw) : 0;
    out.icc = icc;                                  /* 原始估计，可为负 */
    out.iccUsed = Math.max(0, Math.min(1, icc));    /* 设计效应用非负值 */
    out.designEffect = 1 + (out.meanSize - 1) * out.iccUsed;
    out.effectiveN = N / out.designEffect;
    out.sizes = sizes.sort(function (a, b) { return b - a; }).slice(0, 8);
    return out;
  }

  /* ---------------- 样本量与功效 ---------------- */
  /* r 的临界值：精确解 t = qt(1-α/2, n-2) 反解 r */
  function rCritical(n, alpha) {
    alpha = alpha || 0.05;
    var df = n - 2;
    if (df < 1) return NaN;
    var lo = 0, hi = 1 - 1e-12;
    for (var i = 0; i < 200; i++) {
      var mid = (lo + hi) / 2;
      var p = S.tTestP(mid, df);
      if (p > alpha) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }
  /* power=0.8 时的最小可检测 r（Fisher z 近似） */
  function mde(n, alpha, power) {
    alpha = alpha || 0.05; power = power || RULES.powerTarget;
    if (n <= 3) return NaN;
    var z = S.normInv(1 - alpha / 2) + S.normInv(power);
    return Math.tanh(z / Math.sqrt(n - 3));
  }
  /* 达到指定 r 与 power 所需样本量 */
  function requiredN(r, alpha, power) {
    alpha = alpha || 0.05; power = power || RULES.powerTarget;
    if (!(Math.abs(r) > 0 && Math.abs(r) < 1)) return NaN;
    var z = (S.normInv(1 - alpha / 2) + S.normInv(power)) / Math.atanh(Math.abs(r));
    return Math.ceil(z * z + 3);
  }

  /* ---------------- 综合诊断 ---------------- */
  function diagnose(headers, rows, opts) {
    opts = opts || {};
    var prof = profile(headers, rows);
    var miss = missingReport(headers, rows);
    var out = { profile: prof, missing: miss, findings: [], influence: null, clustering: null };

    /* 自动挑一对数值列做影响点诊断 */
    var numericCols = prof.columns.filter(function (c) { return c.type === 'continuous' || c.type === 'binary'; });
    if (numericCols.length >= 2) {
      var xc = opts.x || numericCols[0].name, yc = opts.y || numericCols[1].name;
      var inf = influence(rows.map(function (r) { return r[xc]; }), rows.map(function (r) { return r[yc]; }));
      inf.xName = xc; inf.yName = yc;
      out.influence = inf;
    }
    /* 重复测量：只在"标识列"里找分组（分类列是处理组，不是个体） */
    var groupingCands = prof.columns.filter(function (c) {
      return c.type === 'id' && c.unique < prof.n;
    });
    var best = null;
    groupingCands.forEach(function (g) {
      numericCols.forEach(function (c) {
        if (c.name === g.name) return;
        var cl = clustering(rows.map(function (r) { return r[g.name]; }),
          rows.map(function (r) { return r[c.name]; }));
        if (cl.repeated && (!best || cl.icc > best.icc)) { cl.target = c.name; cl.idColumn = g.name; best = cl; }
      });
    });
    out.clustering = best;

    /* 结论（可直接进报告） */
    var f = out.findings;
    if (prof.n < 30) f.push({ level: 'warn', text: '样本量 n=' + prof.n + '。按 α=0.05、power=0.8，只能检出 |r|≥' + mde(prof.n).toFixed(2) + ' 的相关；更小的效应即使真实存在也检不出来。' });
    else f.push({ level: 'ok', text: '样本量 n=' + prof.n + '，α=0.05、power=0.8 时可检出 |r|≥' + mde(prof.n).toFixed(2) + '；这决定了结论能覆盖多大的效应。' });
    if (prof.completeRate < 0.8) f.push({ level: 'warn', text: '完整行仅占 ' + (prof.completeRate * 100).toFixed(1) + '%。若改用列表删除，样本将从 ' + prof.n + ' 降到 ' + prof.completeCases + '，所有方法的 n 不一致。' });
    if (miss.perColumn.length) f.push({ level: 'info', text: '有 ' + miss.perColumn.length + ' 列存在缺失，最高缺失率为 ' + (Math.max.apply(null, miss.perColumn.map(function (c) { return c.rate; })) * 100).toFixed(1) + '%。工具默认成对删除，每个系数都会单独报告 n。' });
    if (out.influence && Math.abs(out.influence.maxDeltaR) > 0.1) {
      f.push({ level: 'warn', text: '剔除单个观测可使 r 变化 ' + out.influence.maxDeltaR.toFixed(2) + '（' + out.influence.r.toFixed(2) + ' → ' + out.influence.rWithoutWorst.toFixed(2) + '），结论对单点敏感。' });
    }
    if (out.clustering && out.clustering.repeated) {
      var cl = out.clustering;
      if (cl.designEffect >= 1.5) {
        f.push({ level: 'error', text: '检测到重复测量：' + cl.clusters + ' 个个体共 ' + cl.observations + ' 行，ICC=' + cl.icc.toFixed(2) + '，设计效应 ' + cl.designEffect.toFixed(2) + '，有效样本仅 ' + cl.effectiveN.toFixed(0) + '。按行计算 p 值会显著偏小，必须改用聚类 bootstrap 或按个体聚合。' });
      } else if (cl.designEffect >= 1.15) {
        f.push({ level: 'warn', text: '存在重复测量：' + cl.clusters + ' 个个体共 ' + cl.observations + ' 行，ICC=' + cl.icc.toFixed(2) + '，设计效应 ' + cl.designEffect.toFixed(2) + '（有效样本 ' + cl.effectiveN.toFixed(0) + '）。按行分析会轻度高估显著性，建议在报告中说明并做聚类检验。' });
      } else {
        f.push({ level: 'info', text: '检测到重复测量（' + cl.clusters + ' 个个体 / ' + cl.observations + ' 行），但聚集性很弱（ICC=' + cl.icc.toFixed(2) + '，设计效应 ' + cl.designEffect.toFixed(2) + '）。按行分析影响有限，仍建议在报告中注明数据结构。' });
      }
    }
    return out;
  }

  CS.data = {
    RULES: RULES, num: num,
    moments: moments, quantile: quantile, jarqueBera: jarqueBera,
    inferType: inferType, columnProfile: columnProfile, profile: profile,
    missingReport: missingReport, missingAssociation: missingAssociation,
    influence: influence, clustering: clustering,
    rCritical: rCritical, mde: mde, requiredN: requiredN,
    diagnose: diagnose
  };
})(typeof window !== 'undefined' ? window : globalThis);
