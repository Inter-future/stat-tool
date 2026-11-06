/* Correlation Studio · core/io.js
 * 导入层：编码识别、分隔符识别、重名列处理
 *  - 中文 Excel 导出的 CSV 常为 GBK，直接按 UTF-8 读会乱码
 *  - file:// 下不能用 fetch，只能走 FileReader / TextDecoder
 */
(function (global) {
  'use strict';
  var CS = global.CS || (global.CS = {});

  function decodeBuffer(buf) {
    var bytes = new Uint8Array(buf);
    /* BOM 判断 */
    if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
      return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'UTF-8(BOM)' };
    }
    if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
      return { text: new TextDecoder('utf-16le').decode(bytes), encoding: 'UTF-16LE' };
    }
    /* 先按严格 UTF-8 解，失败再退回 GBK */
    try {
      var strict = new TextDecoder('utf-8', { fatal: true });
      return { text: strict.decode(bytes), encoding: 'UTF-8' };
    } catch (e) {
      try {
        return { text: new TextDecoder('gbk').decode(bytes), encoding: 'GBK' };
      } catch (e2) {
        return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'UTF-8(容错)' };
      }
    }
  }

  function detectDelimiter(line) {
    var cands = [',', ';', '\t', '|'], best = ',', bestN = -1;
    for (var i = 0; i < cands.length; i++) {
      var n = line.split(cands[i]).length;
      if (n > bestN) { bestN = n; best = cands[i]; }
    }
    return best;
  }

  function splitLine(line, delim) {
    var out = [], v = '', q = false, i;
    for (i = 0; i < line.length; i++) {
      var c = line[i];
      if (c === '"') {
        if (q && line[i + 1] === '"') { v += '"'; i++; }
        else q = !q;
      } else if (c === delim && !q) { out.push(v); v = ''; }
      else v += c;
    }
    out.push(v);
    return out;
  }

  function parseCSV(text) {
    text = text.replace(/^\uFEFF/, '');
    var lines = text.split(/\r?\n/).filter(function (l) { return l.trim() !== ''; });
    if (!lines.length) throw new Error('文件为空');
    var delim = detectDelimiter(lines[0]);
    var raw = splitLine(lines[0], delim).map(function (h, i) {
      var s = h.trim().replace(/^"|"$/g, '');
      return s || ('列' + (i + 1));
    });
    /* 重名列：加后缀，避免对象键互相覆盖 */
    var seen = {}, headers = raw.map(function (h) {
      if (seen[h]) { seen[h]++; return h + '(' + seen[h] + ')'; }
      seen[h] = 1; return h;
    });
    var rows = lines.slice(1).map(function (line) {
      var a = splitLine(line, delim), o = {};
      headers.forEach(function (k, i) { o[k] = a[i] !== undefined ? a[i] : ''; });
      return o;
    });
    return { headers: headers, rows: rows, delimiter: delim, duplicateHeaders: headers.length !== raw.length };
  }

  function readFile(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var d = decodeBuffer(reader.result);
          var p = parseCSV(d.text);
          p.encoding = d.encoding;
          p.fileName = file.name;
          resolve(p);
        } catch (e) { reject(e); }
      };
      reader.onerror = function () { reject(new Error('读取文件失败')); };
      reader.readAsArrayBuffer(file);
    });
  }

  /* 写入 CSV（带 BOM，Excel 打开不乱码） */
  function toCSV(headers, rows) {
    var esc = function (v) {
      var s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    var out = [headers.map(esc).join(',')];
    rows.forEach(function (r) { out.push(headers.map(function (h) { return esc(r[h]); }).join(',')); });
    return '\uFEFF' + out.join('\r\n');
  }

  CS.io = { decodeBuffer: decodeBuffer, parseCSV: parseCSV, readFile: readFile, toCSV: toCSV, splitLine: splitLine };
})(typeof window !== 'undefined' ? window : globalThis);
