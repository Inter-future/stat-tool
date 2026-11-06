/* Correlation Studio · core/stat.js
 * v2.0 统计计算核心（唯一实现，index.html 与 selftest.html 共用）
 * 无依赖、无模块、可直接用 <script src> 在 file:// 下加载。
 *
 * 口径约定（必须与 selftest.html 的参考值一致）：
 *  - 缺失值：成对删除（pairwise），每个结果自带 n
 *  - p 值：Pearson/Spearman 用 t 近似（df=n-2）；Kendall 用正态近似（含并列方差修正）
 *  - 距离相关：同时返回 V 统计量与 U 统计量，二者不可混用
 *  - 多项式：以 x̄ 中心化后用 Householder QR 求解，返回中心化基下的升幂系数
 */
(function (global) {
  'use strict';
  var CS = global.CS || (global.CS = {});
  CS.VERSION = '2.0.0-alpha.1';

  function err(code, msg) { var e = new Error(msg); e.code = code; return e; }

  /* ---------------- 基础 ---------------- */
  function mean(a) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return s / a.length; }
  function sd(a) {
    var n = a.length, m = mean(a), s = 0;
    for (var i = 0; i < n; i++) s += (a[i] - m) * (a[i] - m);
    return Math.sqrt(s / (n - 1));
  }
  function isConst(a) { var v = a[0]; for (var i = 1; i < a.length; i++) if (a[i] !== v) return false; return true; }

  /* 平均秩，正确处理并列 */
  function ranks(a) {
    var n = a.length, idx = [], r = new Array(n), i, j;
    for (i = 0; i < n; i++) idx.push(i);
    idx.sort(function (p, q) { return a[p] - a[q]; });
    i = 0;
    while (i < n) {
      j = i + 1;
      while (j < n && a[idx[j]] === a[idx[i]]) j++;
      var rk = (i + 1 + j) / 2;
      for (var k = i; k < j; k++) r[idx[k]] = rk;
      i = j;
    }
    return r;
  }

  /* ---------------- 特殊函数 ---------------- */
  function gammaln(z) {
    var p = [676.5203681218851, -1259.1392167224028, 771.32342877765313,
      -176.61502916214059, 12.507343278686905, -0.13857109526572012,
      9.9843695780195716e-6, 1.5056327351493116e-7];
    if (z < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * z)) - gammaln(1 - z);
    z -= 1;
    var x = 0.99999999999980993;
    for (var i = 0; i < p.length; i++) x += p[i] / (z + i + 1);
    var t = z + 7.5;
    return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
  }
  function betacf(a, b, x) {
    var qab = a + b, qap = a + 1, qam = a - 1, c = 1, d = 1 - qab * x / qap;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    d = 1 / d;
    var h = d;
    for (var m = 1; m <= 300; m++) {
      var m2 = 2 * m;
      var aa = m * (b - m) * x / ((qam + m2) * (a + m2));
      d = 1 + aa * d; if (Math.abs(d) < 1e-30) d = 1e-30;
      c = 1 + aa / c; if (Math.abs(c) < 1e-30) c = 1e-30;
      d = 1 / d; h *= d * c;
      aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
      d = 1 + aa * d; if (Math.abs(d) < 1e-30) d = 1e-30;
      c = 1 + aa / c; if (Math.abs(c) < 1e-30) c = 1e-30;
      d = 1 / d;
      var del = d * c; h *= del;
      if (Math.abs(del - 1) < 3e-16) break;
    }
    return h;
  }
  /* 正则化不完全 beta：I_x(a,b) */
  function ibeta(x, a, b) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    var bt = Math.exp(gammaln(a + b) - gammaln(a) - gammaln(b) + a * Math.log(x) + b * Math.log(1 - x));
    return x < (a + 1) / (a + b + 2) ? bt * betacf(a, b, x) / a : 1 - bt * betacf(b, a, 1 - x) / b;
  }
  /* t 分布双侧 p 值 */
  function tTestP(r, df) {
    if (df <= 0 || !isFinite(r)) return NaN;
    if (Math.abs(r) >= 1) return 0;
    return ibeta(df / (df + r * r * df / (1 - r * r)), df / 2, 0.5);
  }
  /* 上不完全 gamma Q(a,x)：用于正态尾概率 */
  function gser(a, x) {
    var ap = a, sum = 1 / a, del = sum;
    for (var n = 0; n < 1000; n++) {
      ap += 1; del *= x / ap; sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-16) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - gammaln(a));
  }
  function gcf(a, x) {
    var b = x + 1 - a, c = 1e300, d = 1 / b, h = d;
    for (var i = 1; i < 1000; i++) {
      var an = -i * (i - a);
      b += 2;
      d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
      c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
      d = 1 / d;
      var del = d * c; h *= del;
      if (Math.abs(del - 1) < 1e-16) break;
    }
    return Math.exp(-x + a * Math.log(x) - gammaln(a)) * h;
  }
  function gammaq(a, x) {
    if (x < 0 || a <= 0) return NaN;
    if (x === 0) return 1;
    return x < a + 1 ? 1 - gser(a, x) : gcf(a, x);
  }
  /* 标准正态上尾 P(Z>z) */
  function normSF(z) {
    if (!isFinite(z)) return z > 0 ? 0 : 1;
    if (z < 0) return 1 - normSF(-z);
    return 0.5 * gammaq(0.5, z * z / 2);
  }

  /* ---------------- 数据规整 ---------------- */
  /* 严格数值化：null / undefined / 空串 / 非数字 一律为 NaN
     （注意 isFinite(null) === true，不能直接用它判断缺失） */
  function num(v) {
    if (v === null || v === undefined) return NaN;
    if (typeof v === 'string') { v = v.trim(); if (v === '') return NaN; v = v.replace(/,/g, ''); }
    var n = Number(v);
    return isFinite(n) ? n : NaN;
  }

  /* 把两列（及可选控制列）整理成成对完整样本；返回 {x,y,Z,n,removed} */
  function align(y1, y2, controls) {
    controls = controls || [];
    var x = [], y = [], Z = [], removed = 0, a, b;
    for (var i = 0; i < y1.length; i++) {
      a = num(y1[i]); b = num(y2[i]);
      var ok = isFinite(a) && isFinite(b);
      if (ok) for (var j = 0; j < controls.length; j++) if (!isFinite(num(controls[j][i]))) { ok = false; break; }
      if (!ok) { removed++; continue; }
      x.push(a); y.push(b);
      if (controls.length) { var row = []; for (var k = 0; k < controls.length; k++) row.push(controls[k][i]); Z.push(row); }
    }
    return { x: x, y: y, Z: Z, n: x.length, removed: removed, n0: y1.length };
  }

  /* ---------------- 相关系数 ---------------- */
  function pearson(x, y) {
    var n = x.length, mx = mean(x), my = mean(y), num = 0, dx = 0, dy = 0;
    for (var i = 0; i < n; i++) {
      var a = x[i] - mx, b = y[i] - my;
      num += a * b; dx += a * a; dy += b * b;
    }
    if (dx === 0 || dy === 0) throw err('ZERO_VARIANCE', '变量为零方差，相关系数无定义');
    return num / Math.sqrt(dx * dy);
  }
  function pearsonTest(x, y) {
    var d = align(x, y);
    if (d.n < 3) throw err('N_TOO_SMALL', '有效样本不足（n<3）');
    var r = pearson(d.x, d.y);
    return { r: r, p: tTestP(r, d.n - 2), n: d.n, removed: d.removed };
  }

  function spearman(x, y) {
    var d = align(x, y);
    if (d.n < 3) throw err('N_TOO_SMALL', '有效样本不足（n<3）');
    var rx = ranks(d.x), ry = ranks(d.y);
    if (isConst(rx) || isConst(ry)) throw err('ALL_TIES', '秩完全并列，秩相关无定义');
    var r = pearson(rx, ry);
    return { rho: r, p: tTestP(r, d.n - 2), n: d.n, removed: d.removed };
  }

  /* Kendall tau-b + 正态近似 p（含并列方差修正） */
  function kendall(x, y) {
    var d = align(x, y), n = d.n;
    if (n < 3) throw err('N_TOO_SMALL', '有效样本不足（n<3）');
    var c = 0, dis = 0, tx = 0, ty = 0, i, j;
    for (i = 0; i < n; i++) for (j = i + 1; j < n; j++) {
      var a = x_.sign(d.x[i] - d.x[j]), b = x_.sign(d.y[i] - d.y[j]);
      if (a === 0 && b === 0) continue;
      if (a === 0) tx++; else if (b === 0) ty++; else if (a === b) c++; else dis++;
    }
    var denom = Math.sqrt((c + dis + tx) * (c + dis + ty));
    if (denom === 0) throw err('ALL_TIES', '全部观测并列，Kendall τ-b 无定义');
    var tau = (c - dis) / denom;

    /* S 的方差（Kendall 1975），含并列修正 */
    var tGroups = tieGroups(d.x), uGroups = tieGroups(d.y);
    var sumT1 = 0, sumT2 = 0, sumT3 = 0, sumU1 = 0, sumU2 = 0, sumU3 = 0;
    for (i = 0; i < tGroups.length; i++) {
      var t = tGroups[i]; sumT1 += t * (t - 1) * (2 * t + 5);
      sumT2 += t * (t - 1) * (t - 2); sumT3 += t * (t - 1);
    }
    for (i = 0; i < uGroups.length; i++) {
      var u = uGroups[i]; sumU1 += u * (u - 1) * (2 * u + 5);
      sumU2 += u * (u - 1) * (u - 2); sumU3 += u * (u - 1);
    }
    var varS = (n * (n - 1) * (2 * n + 5) - sumT1 - sumU1) / 18 +
      (sumT2 * sumU2) / (9 * n * (n - 1) * (n - 2)) +
      (sumT3 * sumU3) / (2 * n * (n - 1));
    var z = (c - dis) / Math.sqrt(varS);
    return { tau: tau, p: 2 * normSF(Math.abs(z)), z: z, n: n, removed: d.removed, c: c, d: dis, tx: tx, ty: ty };
    function tieGroups(v) {
      var s = v.slice().sort(function (p, q) { return p - q; }), g = [], run = 1;
      for (var k = 1; k <= s.length; k++) {
        if (k < s.length && s[k] === s[k - 1]) run++;
        else { if (run > 1) g.push(run); run = 1; }
      }
      return g;
    }
  }

  /* 偏相关：先对控制变量做含截距回归取残差，再算 Pearson */
  function partial(x, y, controls) {
    if (!controls || !controls.length) throw err('NO_CONTROLS', '偏相关至少需要一个控制变量');
    var d = align(x, y, controls);
    if (d.n < controls.length + 4) throw err('N_TOO_SMALL', '有效样本不足以估计控制变量');
    var rx = resid(d.y, d.Z), ry = resid(d.x, d.Z);
    var r = pearson(rx, ry), df = d.n - controls.length - 2;
    return { r: r, p: tTestP(r, df), df: df, n: d.n, removed: d.removed, k: controls.length };
  }
  /* 最小二乘残差（QR 求解，稳定） */
  function resid(yy, Z) {
    var n = yy.length, k = Z[0].length + 1;
    var A = [], i, j;
    for (i = 0; i < n; i++) { var row = [1]; for (j = 0; j < k - 1; j++) row.push(Z[i][j]); A.push(row); }
    var beta = lstsq(A, yy);
    var out = new Array(n);
    for (i = 0; i < n; i++) {
      var s = beta[0];
      for (j = 1; j < k; j++) s += beta[j] * A[i][j];
      out[i] = yy[i] - s;
    }
    return out;
  }

  /* Householder QR 最小二乘：A(n×k) b(k) */
  function lstsq(A, b) {
    var n = A.length, k = A[0].length, i, j, m;
    var R = [], qtb = new Array(k);
    for (i = 0; i < n; i++) { R.push(A[i].slice()); }
    qtb = b.slice();
    for (j = 0; j < k; j++) {
      var norm = 0;
      for (i = j; i < n; i++) norm += R[i][j] * R[i][j];
      norm = Math.sqrt(norm);
      if (norm < 1e-14) throw err('SINGULAR', '设计矩阵奇异（变量完全共线）');
      var alpha = R[j][j] > 0 ? -norm : norm;
      var v = new Array(n).fill(0);
      v[j] = R[j][j] - alpha;
      for (i = j + 1; i < n; i++) v[i] = R[i][j];
      var vv = 0; for (i = j; i < n; i++) vv += v[i] * v[i];
      if (vv < 1e-30) continue;
      for (m = j; m < k; m++) {
        var s = 0;
        for (i = j; i < n; i++) s += v[i] * R[i][m];
        s = 2 * s / vv;
        for (i = j; i < n; i++) R[i][m] -= s * v[i];
      }
      var sb = 0;
      for (i = j; i < n; i++) sb += v[i] * qtb[i];
      sb = 2 * sb / vv;
      for (i = j; i < n; i++) qtb[i] -= sb * v[i];
      R[j][j] = alpha;
    }
    var beta = new Array(k).fill(0);
    for (i = k - 1; i >= 0; i--) {
      var s = qtb[i];
      for (j = i + 1; j < k; j++) s -= R[i][j] * beta[j];
      beta[i] = s / R[i][i];
    }
    return beta;
  }

  /* ---------------- 距离相关 ---------------- */
  function distMatrix(a) {
    var n = a.length, D = new Float64Array(n * n), i, j;
    for (i = 0; i < n; i++) for (j = 0; j < n; j++) D[i * n + j] = Math.abs(a[i] - a[j]);
    return D;
  }
  function vCenter(D, n) {
    var row = new Float64Array(n), col = new Float64Array(n), tot = 0, i, j, s;
    for (i = 0; i < n; i++) {
      s = 0;
      for (j = 0; j < n; j++) { s += D[i * n + j]; col[j] += D[i * n + j]; }
      row[i] = s; tot += s;
    }
    var A = new Float64Array(n * n), g = tot / (n * n);
    for (i = 0; i < n; i++) for (j = 0; j < n; j++)
      A[i * n + j] = D[i * n + j] - row[i] / n - col[j] / n + g;
    return A;
  }
  function uCenter(D, n) {
    var row = new Float64Array(n), col = new Float64Array(n), tot = 0, i, j, s;
    for (i = 0; i < n; i++) {
      s = 0;
      for (j = 0; j < n; j++) { s += D[i * n + j]; col[j] += D[i * n + j]; }
      row[i] = s; tot += s;
    }
    var A = new Float64Array(n * n), c = tot / ((n - 1) * (n - 2));
    for (i = 0; i < n; i++) for (j = 0; j < n; j++) {
      A[i * n + j] = (i === j) ? 0 : D[i * n + j] - row[i] / (n - 2) - col[j] / (n - 2) + c;
    }
    return A;
  }
  function inner(A, B, n, skipDiag) {
    var s = 0, i, j;
    for (i = 0; i < n; i++) for (j = 0; j < n; j++) {
      if (skipDiag && i === j) continue;
      s += A[i * n + j] * B[i * n + j];
    }
    return s;
  }

  /* dCor：同时给 V（有偏，用于检验）与 U（无偏，可用于估计，可能为负） */
  function dcor(x, y, options) {
    options = options || {};
    var d = align(x, y), n = d.n;
    if (n < 4) throw err('N_TOO_SMALL', '距离相关至少需要 n=4');
    var limit = options.maxN || 2000;
    if (n > limit) throw err('N_TOO_LARGE', '距离相关计算量为 O(n²)，当前上限 n=' + limit);
    var Dx = distMatrix(d.x), Dy = distMatrix(d.y);
    var Ax = vCenter(Dx, n), Ay = vCenter(Dy, n);
    var dcov2 = inner(Ax, Ay, n) / (n * n);
    var dvx = inner(Ax, Ax, n) / (n * n), dvy = inner(Ay, Ay, n) / (n * n);
    var v = dvx > 0 && dvy > 0 ? Math.sqrt(Math.max(0, dcov2) / Math.sqrt(dvx * dvy)) : 0;

    var Ux = uCenter(Dx, n), Uy = uCenter(Dy, n);
    var ucov2 = inner(Ux, Uy, n, true) / (n * (n - 3));
    var uvx = inner(Ux, Ux, n, true) / (n * (n - 3));
    var uvy = inner(Uy, Uy, n, true) / (n * (n - 3));
    var u2 = uvx > 0 && uvy > 0 ? ucov2 / Math.sqrt(uvx * uvy) : 0;

    return { v: v, u2: u2, u: u2 > 0 ? Math.sqrt(u2) : 0, n: n, removed: d.removed };
  }

  /* 置换检验：返回 p 与最小可达分辨率 */
  function permTest(fn, x, y, B, seed) {
    B = B || 999;
    var rnd = mulberry32(seed === undefined ? 20260101 : seed);
    var obs = fn(x, y);
    var cnt = 0, yy = y.slice();
    for (var b = 0; b < B; b++) {
      /* Fisher-Yates */
      for (var i = yy.length - 1; i > 0; i--) {
        var j = Math.floor(rnd() * (i + 1)), tmp = yy[i]; yy[i] = yy[j]; yy[j] = tmp;
      }
      var s = fn(x, yy);
      if (Math.abs(s) >= Math.abs(obs)) cnt++;
    }
    return { stat: obs, p: (cnt + 1) / (B + 1), B: B, minP: 1 / (B + 1), seed: seed };
  }

  /* ---------------- 置信区间 ---------------- */
  /* 标准正态分位数（Acklam 有理逼近），用于 CI 与 BCa */
  function normInv(p) {
    if (p <= 0) return -Infinity;
    if (p >= 1) return Infinity;
    var a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
      1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
    var b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
      6.680131188771972e+01, -1.328068155288572e+01];
    var c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
      -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
    var d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
      3.754408661907416e+00];
    var q, r;
    if (p < 0.02425) {
      q = Math.sqrt(-2 * Math.log(p));
      return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
             ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
    }
    if (p > 1 - 0.02425) {
      q = Math.sqrt(-2 * Math.log(1 - p));
      return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
              ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
    }
    q = p - 0.5; r = q * q;
    return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q /
           (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
  }

  /* Fisher z 置信区间：r 为 Pearson 或 Spearman，k 为控制变量数 */
  function fisherCI(r, n, level, k) {
    level = level || 0.95; k = k || 0;
    if (Math.abs(r) >= 1) return { lo: r, hi: r, level: level, method: 'fisher-z', approx: true };
    var df = n - 3 - k;
    if (df <= 1) throw err('N_TOO_SMALL', '有效样本不足以构造 Fisher z 区间');
    var z = Math.atanh(r), se = 1 / Math.sqrt(df), zc = normInv(1 - (1 - level) / 2);
    return { lo: Math.tanh(z - zc * se), hi: Math.tanh(z + zc * se), level: level, method: 'fisher-z', approx: true };
  }

  /* Bootstrap 置信区间：type = 'percentile' | 'bca'，按观测对重抽样 */
  function bootstrapCI(x, y, statFn, opt) {
    opt = opt || {};
    var B = opt.B || 999, seed = (opt.seed === undefined ? 20260101 : opt.seed);
    var level = opt.level || 0.95, type = opt.type || 'percentile';
    var d = align(x, y), xs = d.x, ys = d.y, n = xs.length;
    if (n < 5) throw err('N_TOO_SMALL', 'Bootstrap 至少需要 n=5');
    var theta = statFn(xs, ys);
    var rnd = mulberry32(seed), reps = new Float64Array(B);
    var xb = new Array(n), yb = new Array(n), i, b, j;
    for (b = 0; b < B; b++) {
      for (i = 0; i < n; i++) { j = Math.floor(rnd() * n); xb[i] = xs[j]; yb[i] = ys[j]; }
      reps[b] = statFn(xb, yb);
    }
    var sorted = Array.prototype.slice.call(reps).sort(function (p, q) { return p - q; });
    var alpha = 1 - level, lo, hi;
    if (type === 'bca') {
      var less = 0;
      for (b = 0; b < B; b++) if (reps[b] < theta) less++;
      var prop = Math.min(Math.max(less / B, 0.5 / B), 1 - 0.5 / B);
      var z0 = normInv(prop);
      /* 刀切加速度 */
      var jack = new Float64Array(n), xs2 = new Array(n - 1), ys2 = new Array(n - 1);
      for (i = 0; i < n; i++) {
        var t = 0;
        for (j = 0; j < n; j++) if (j !== i) { xs2[t] = xs[j]; ys2[t] = ys[j]; t++; }
        jack[i] = statFn(xs2, ys2);
      }
      var jm = 0;
      for (i = 0; i < n; i++) jm += jack[i];
      jm /= n;
      var num = 0, den = 0;
      for (i = 0; i < n; i++) { var dd = jm - jack[i]; num += dd * dd * dd; den += dd * dd; }
      var accel = den > 0 ? num / (6 * Math.pow(den, 1.5)) : 0;
      var zl = normInv(alpha / 2), zu = normInv(1 - alpha / 2);
      var a1 = normCdf(z0 + (z0 + zl) / (1 - accel * (z0 + zl)));
      var a2 = normCdf(z0 + (z0 + zu) / (1 - accel * (z0 + zu)));
      lo = quantileSorted(sorted, a1);
      hi = quantileSorted(sorted, a2);
    } else {
      lo = quantileSorted(sorted, alpha / 2);
      hi = quantileSorted(sorted, 1 - alpha / 2);
    }
    return { lo: lo, hi: hi, level: level, method: type, B: B, seed: seed, theta: theta };
  }
  function quantileSorted(s, p) {
    if (p <= 0) return s[0];
    if (p >= 1) return s[s.length - 1];
    var h = (s.length - 1) * p, lo = Math.floor(h), hi = Math.min(lo + 1, s.length - 1);
    return s[lo] + (h - lo) * (s[hi] - s[lo]);
  }
  function normCdf(z) { return 1 - normSF(z); }

  /* ---------------- 拟合与残差 ---------------- */
  /* 按观测对重抽样，返回拟合曲线在网格上的 95% 置信带 */
  function bootstrapBand(x, y, opt) {
    opt = opt || {};
    var degree = opt.degree === undefined ? 1 : opt.degree;
    var B = opt.B || 400, seed = (opt.seed === undefined ? 20260101 : opt.seed);
    var level = opt.level || 0.95, gridN = opt.gridN || 80;
    var d = align(x, y), xs = d.x, ys = d.y, n = xs.length;
    if (n < degree + 4) throw err('N_TOO_SMALL', '样本不足以拟合');
    var base = polyfit(xs, ys, degree);
    var xmin = Math.min.apply(null, xs), xmax = Math.max.apply(null, xs);
    var grid = [], i, k;
    for (i = 0; i < gridN; i++) grid.push(xmin + (xmax - xmin) * i / (gridN - 1));
    var fits = [];
    var rnd = mulberry32(seed), xb = new Array(n), yb = new Array(n);
    for (k = 0; k < B; k++) {
      for (i = 0; i < n; i++) { var j = Math.floor(rnd() * n); xb[i] = xs[j]; yb[i] = ys[j]; }
      try {
        var f = polyfit(xb, yb, degree);
        fits.push(grid.map(function (v) { return f.predict(v); }));
      } catch (e) { /* 奇异样本跳过 */ }
    }
    var lo = [], hi = [], alpha = 1 - level;
    for (i = 0; i < gridN; i++) {
      var col = fits.map(function (f) { return f[i]; }).sort(function (p, q) { return p - q; });
      lo.push(quantileSorted(col, alpha / 2));
      hi.push(quantileSorted(col, 1 - alpha / 2));
    }
    return { grid: grid, lo: lo, hi: hi, degree: degree, coef: base.coef, xMean: base.xMean,
      r2: base.r2, rmse: base.rmse, n: n, B: fits.length, seed: seed };
  }

  /* 残差诊断数据 */
  function residuals(x, y, degree) {
    degree = degree === undefined ? 1 : degree;
    var d = align(x, y), n = d.n;
    var f = polyfit(d.x, d.y, degree);
    var res = [], fitted = [], std = 0, i;
    for (i = 0; i < n; i++) {
      var yh = f.predict(d.x[i]);
      fitted.push(yh);
      res.push(d.y[i] - yh);
    }
    var m = mean(res), s = 0;
    for (i = 0; i < n; i++) s += (res[i] - m) * (res[i] - m);
    s = Math.sqrt(s / Math.max(1, n - degree - 1));
    var z = res.map(function (v) { return s > 0 ? (v - m) / s : 0; });
    var sorted = z.slice().sort(function (p, q) { return p - q; });
    var qq = sorted.map(function (v, idx) {
      var p = (idx + 0.5) / n;
      return { theoretical: normInv(p), sample: v };
    });
    return { residuals: res, fitted: fitted, standardized: z, qq: qq, sd: s,
      r2: f.r2, rmse: f.rmse, degree: degree, n: n, coef: f.coef, xMean: f.xMean };
  }

  /* 可播种随机数（mulberry32），保证可复现 */
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  /* ---------------- 多项式拟合 ---------------- */
  /* 以 x̄ 中心化 + Householder QR；返回升幂系数（中心化基） */
  function polyfit(x, y, degree) {
    degree = degree | 0;
    var d = align(x, y), n = d.n;
    if (degree < 1) throw err('BAD_DEGREE', '阶数必须 ≥ 1');
    if (n < degree + 3) throw err('N_TOO_SMALL', '样本不足以拟合 ' + degree + ' 次多项式');
    var mx = mean(d.x), A = [], i, j;
    for (i = 0; i < n; i++) {
      var t = d.x[i] - mx, row = [];
      for (j = 0; j <= degree; j++) row.push(Math.pow(t, j));
      A.push(row);
    }
    var beta = lstsq(A, d.y);
    var yhat = A.map(function (row) { return row.reduce(function (s, v, k) { return s + v * beta[k]; }, 0); });
    var my = mean(d.y), sst = 0, sse = 0;
    for (i = 0; i < n; i++) { sst += (d.y[i] - my) * (d.y[i] - my); sse += (d.y[i] - yhat[i]) * (d.y[i] - yhat[i]); }
    return {
      coef: beta, degree: degree, xMean: mx, r2: 1 - sse / sst,
      rmse: Math.sqrt(sse / n), sse: sse, sst: sst, n: n, removed: d.removed,
      predict: function (v) { var t = v - mx, s = 0; for (var k = 0; k < beta.length; k++) s += beta[k] * Math.pow(t, k); return s; }
    };
  }

  /* ---------------- v1 兼容层（仅用于对照，不用于正式分析） ---------------- */
  var legacy = {
    /* v1 的距离相关：V 统计量 + 负值截断 */
    dcorV: function (x, y) {
      var n = x.length, i, j;
      function dm(a) {
        var m = [], rs = new Array(n).fill(0), cs = new Array(n).fill(0), tot = 0;
        for (i = 0; i < n; i++) { m.push(new Array(n).fill(0)); }
        for (i = 0; i < n; i++) for (j = 0; j < n; j++) { m[i][j] = Math.abs(a[i] - a[j]); rs[i] += m[i][j]; cs[j] += m[i][j]; tot += m[i][j]; }
        var g = tot / (n * n);
        for (i = 0; i < n; i++) for (j = 0; j < n; j++) m[i][j] = m[i][j] - rs[i] / n - cs[j] / n + g;
        return m;
      }
      var A = dm(x), B = dm(y), ab = 0, aa = 0, bb = 0;
      for (i = 0; i < n; i++) for (j = 0; j < n; j++) { ab += A[i][j] * B[i][j]; aa += A[i][j] * A[i][j]; bb += B[i][j] * B[i][j]; }
      var cov = Math.max(0, ab / (n * n));
      return Math.sqrt(cov / Math.sqrt(aa / (n * n) * bb / (n * n)));
    },
    /* v1 的多项式：未中心化的正规方程 + 无主元 Gauss-Jordan */
    polyfit: function (x, y, d) {
      var n = d + 1, i, j, k;
      var X = x.map(function (v) { return Array.from({ length: n }, function (_, jj) { return Math.pow(v, jj); }); });
      var M = [], b = new Array(n).fill(0);
      for (i = 0; i < n; i++) { M.push(new Array(n).fill(0)); }
      for (i = 0; i < x.length; i++) for (j = 0; j < n; j++) {
        b[j] += X[i][j] * y[i];
        for (k = 0; k < n; k++) M[j][k] += X[i][j] * X[i][k];
      }
      for (i = 0; i < n; i++) {
        var q = M[i][i];
        if (Math.abs(q) < 1e-12) throw err('SINGULAR', '拟合矩阵奇异');
        for (k = i; k < n; k++) M[i][k] /= q;
        b[i] /= q;
        for (j = 0; j < n; j++) if (i !== j) {
          q = M[j][i];
          for (k = i; k < n; k++) M[j][k] -= q * M[i][k];
          b[j] -= q * b[i];
        }
      }
      return b;
    }
  };

  function sign(v) { return v > 0 ? 1 : v < 0 ? -1 : 0; }
  var x_ = { sign: sign };

  CS.stat = {
    version: CS.VERSION,
    mean: mean, sd: sd, ranks: ranks, align: align,
    pearson: pearson, pearsonTest: pearsonTest,
    spearman: spearman, kendall: kendall, partial: partial,
    dcor: dcor, permTest: permTest, polyfit: polyfit,
    bootstrapBand: bootstrapBand, residuals: residuals,
    fisherCI: fisherCI, bootstrapCI: bootstrapCI, normInv: normInv, normCdf: normCdf,
    tTestP: tTestP, normSF: normSF, ibeta: ibeta,
    mulberry32: mulberry32, lstsq: lstsq
  };
  CS.legacy = legacy;
})(typeof window !== 'undefined' ? window : globalThis);
