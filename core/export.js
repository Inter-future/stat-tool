/* Correlation Studio · core/export.js
 * 第 3 层：报告导出（HTML / Excel / Word）
 * 全部在本地生成，不依赖任何第三方库：
 *  - HTML：自带样式与内嵌图片
 *  - Excel：SpreadsheetML 2003（多工作表）
 *  - Word：docx（OPC 包 + 未压缩 ZIP，自带 CRC32）
 */
(function (global) {
  'use strict';
  var CS = global.CS || (global.CS = {});

  /* ---------------- 通用 ---------------- */
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function stamp() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
      pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function download(blob, filename) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }

  /* ---------------- 模型 → HTML ---------------- */
  function tableHTML(t) {
    var h = '<table><thead><tr>' + t.head.map(function (c) { return '<th>' + esc(c) + '</th>'; }).join('') + '</tr></thead><tbody>';
    t.rows.forEach(function (r) {
      h += '<tr>' + r.map(function (c) { return '<td>' + esc(c) + '</td>'; }).join('') + '</tr>';
    });
    h += '</tbody></table>';
    if (t.note) h += '<div class="note">' + esc(t.note) + '</div>';
    return h;
  }
  function bodyHTML(model, forWord) {
    var out = '';
    model.sections.forEach(function (s) {
      if (s.type === 'h2') out += '<h2>' + esc(s.text) + '</h2>';
      else if (s.type === 'h3') out += '<h3>' + esc(s.text) + '</h3>';
      else if (s.type === 'p') out += '<p>' + (s.html || esc(s.text)) + '</p>';
      else if (s.type === 'list') out += '<ul>' + s.items.map(function (i) { return '<li>' + (i.html || esc(i.text || i)) + '</li>'; }).join('') + '</ul>';
      else if (s.type === 'table') out += tableHTML(s);
      else if (s.type === 'image') out += '<figure><img src="' + s.dataUrl + '" style="width:' + (s.width || 620) + 'px"><figcaption>' + esc(s.caption) + '</figcaption></figure>';
      else if (s.type === 'note') out += '<div class="note">' + (s.html || esc(s.text)) + '</div>';
    });
    return out;
  }

  function toHTMLBody(model) {
    return '<h1>' + esc(model.title) + '</h1>' +
      '<div class="meta">' + model.meta.map(function (m) { return '<b>' + esc(m.k) + '</b>：' + esc(m.v); }).join('　｜　') + '</div>' +
      bodyHTML(model);
  }

  function toHTML(model) {
    return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>' + esc(model.title) + '</title>' +
      '<style>' +
      'body{font:14px/1.85 "Microsoft YaHei",-apple-system,Segoe UI,sans-serif;color:#1b2434;max-width:820px;margin:0 auto;padding:40px 28px 70px;background:#fff}' +
      'h1{font-size:24px;margin:0 0 6px;letter-spacing:.5px}' +
      '.meta{color:#6b7789;font-size:12.5px;margin-bottom:26px;line-height:2}' +
      'h2{font-size:17px;margin:30px 0 10px;padding-left:10px;border-left:4px solid #2563eb;line-height:1.3}' +
      'h3{font-size:14.5px;margin:20px 0 8px;color:#33415c}' +
      'p{margin:9px 0;text-align:justify}ul{margin:8px 0 8px 22px}li{margin:5px 0}' +
      'table{width:100%;border-collapse:collapse;margin:12px 0;font-size:12.5px}' +
      'th,td{border:1px solid #d9e0ea;padding:7px 10px;text-align:left}' +
      'th{background:#f4f7fb;font-weight:600}td:not(:first-child){text-align:right;font-variant-numeric:tabular-nums}' +
      'figure{margin:16px 0;text-align:center}figure img{max-width:100%;border:1px solid #e6ebf2;border-radius:8px}' +
      'figcaption{color:#6b7789;font-size:12px;margin-top:6px}' +
      '.note{color:#6b7789;font-size:12px;margin:6px 0}' +
      '.meta b{color:#33415c;font-weight:600}' +
      '@media print{body{padding:0;max-width:none}h2{break-after:avoid}figure{break-inside:avoid}table{break-inside:avoid}}' +
      '</style></head><body>' +
      toHTMLBody(model) +
      '</body></html>';
  }

  /* ---------------- ZIP（store，无压缩） ---------------- */
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256), c, n, k;
    for (n = 0; n < 256; n++) {
      c = n;
      for (k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function utf8(str) {
    if (global.TextEncoder) return new TextEncoder().encode(str);
    var out = [], i, c;
    for (i = 0; i < str.length; i++) {
      c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0xD800 || c >= 0xE000) out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else { c = 0x10000 + (((c & 0x3FF) << 10) | (str.charCodeAt(++i) & 0x3FF)); out.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)); }
    }
    return new Uint8Array(out);
  }
  function zipStore(files) {
    var chunks = [], central = [], offset = 0;
    files.forEach(function (f) {
      var name = utf8(f.name), data = f.data;
      var crc = crc32(data), len = data.length;
      var local = new Uint8Array(30 + name.length);
      var dv = new DataView(local.buffer);
      dv.setUint32(0, 0x04034b50, true);
      dv.setUint16(4, 20, true); dv.setUint16(6, 0x0800, true); dv.setUint16(8, 0, true);
      dv.setUint16(10, 0, true); dv.setUint16(12, 0, true);
      dv.setUint32(14, crc, true); dv.setUint32(18, len, true); dv.setUint32(22, len, true);
      dv.setUint16(26, name.length, true); dv.setUint16(28, 0, true);
      local.set(name, 30);
      chunks.push(local, data);

      var cen = new Uint8Array(46 + name.length);
      var cv = new DataView(cen.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true); cv.setUint16(12, 0, true); cv.setUint16(14, 0, true);
      cv.setUint32(16, crc, true); cv.setUint32(20, len, true); cv.setUint32(24, len, true);
      cv.setUint16(28, name.length, true); cv.setUint16(30, 0, true); cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true); cv.setUint16(36, 0, true); cv.setUint32(38, 0, true);
      cv.setUint32(42, offset, true);
      cen.set(name, 46);
      central.push(cen);
      offset += local.length + len;
    });
    var cenSize = central.reduce(function (s, c) { return s + c.length; }, 0);
    var end = new Uint8Array(22);
    var ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
    ev.setUint32(12, cenSize, true); ev.setUint32(16, offset, true);
    return new Blob(chunks.concat(central, [end]), { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  }

  /* ---------------- DOCX ---------------- */
  var EMU_PER_PX = 9525;
  function docxRun(text, bold, size) {
    return '<w:r><w:rPr>' + (bold ? '<w:b/>' : '') +
      (size ? '<w:sz w:val="' + size + '"/><w:szCs w:val="' + size + '"/>' : '') +
      '</w:rPr><w:t xml:space="preserve">' + esc(text) + '</w:t></w:r>';
  }
  function docxPara(text, opt) {
    opt = opt || {};
    return '<w:p><w:pPr>' + (opt.style ? '<w:pStyle w:val="' + opt.style + '"/>' : '') +
      (opt.align ? '<w:jc w:val="' + opt.align + '"/>' : '') +
      '<w:spacing w:after="120" w:line="320" w:lineRule="auto"/></w:pPr>' +
      docxRun(text, opt.bold, opt.size) + '</w:p>';
  }
  function docxTable(t) {
    var cols = t.head.length, width = Math.floor(9000 / cols);
    var x = '<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/></w:tblPr>';
    x += '<w:tblGrid>' + t.head.map(function () { return '<w:gridCol w:w="' + width + '"/>'; }).join('') + '</w:tblGrid>';
    x += '<w:tr>' + t.head.map(function (c) {
      return '<w:tc><w:tcPr><w:tcW w:w="' + width + '" w:type="dxa"/></w:tcPr>' +
        '<w:p><w:pPr><w:spacing w:after="0"/></w:pPr>' + docxRun(c, true, 18) + '</w:p></w:tc>';
    }).join('') + '</w:tr>';
    t.rows.forEach(function (r) {
      x += '<w:tr>' + r.map(function (c) {
        return '<w:tc><w:tcPr><w:tcW w:w="' + width + '" w:type="dxa"/></w:tcPr>' +
          '<w:p><w:pPr><w:spacing w:after="0"/></w:pPr>' + docxRun(c, false, 18) + '</w:p></w:tc>';
      }).join('') + '</w:tr>';
    });
    return x + '</w:tbl>' + docxPara('', { size: 12 });
  }
  function docxImage(relId, px, py, idx) {
    var cx = Math.min(5.9 * 914400, px * EMU_PER_PX);
    var cy = Math.round(cx * py / px);
    return '<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="80"/></w:pPr><w:r><w:drawing>' +
      '<wp:inline distT="0" distB="0" distL="0" distR="0">' +
      '<wp:extent cx="' + Math.round(cx) + '" cy="' + cy + '"/><wp:docPr id="' + idx + '" name="Picture ' + idx + '"/>' +
      '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
      '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
      '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
      '<pic:nvPicPr><pic:cNvPr id="' + idx + '" name="image' + idx + '.png"/><pic:cNvPicPr/></pic:nvPicPr>' +
      '<pic:blipFill><a:blip r:embed="' + relId + '"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
      '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + Math.round(cx) + '" cy="' + cy + '"/></a:xfrm>' +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>' +
      '</wp:inline></w:drawing></w:r></w:p>';
  }

  function toDOCX(model) {
    var body = '', imgIdx = 0, rels = [], media = [];
    body += docxPara(model.title, { bold: true, size: 36, align: 'center' });
    body += docxPara(model.meta.map(function (m) { return m.k + '：' + m.v; }).join('　｜　'), { size: 18, align: 'center' });
    body += docxPara(' ', {});

    model.sections.forEach(function (s) {
      if (s.type === 'h2') body += docxPara(s.text, { bold: true, size: 28 });
      else if (s.type === 'h3') body += docxPara(s.text, { bold: true, size: 24 });
      else if (s.type === 'p') body += docxPara(s.plain || s.text || '');
      else if (s.type === 'note') body += docxPara(s.plain || s.text || '', { size: 18 });
      else if (s.type === 'list') s.items.forEach(function (i) { body += docxPara('· ' + (i.plain || i.text || i), { size: 20 }); });
      else if (s.type === 'table') body += docxTable(s);
      else if (s.type === 'image') {
        imgIdx++;
        var relId = 'rIdImg' + imgIdx;
        var b64 = s.dataUrl.split(',')[1];
        var bin = atob(b64), arr = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        media.push({ name: 'word/media/image' + imgIdx + '.png', data: arr });
        rels.push('<Relationship Id="' + relId + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image' + imgIdx + '.png"/>');
        body += docxImage(relId, s.width || 620, s.height || 300, imgIdx);
        if (s.caption) body += docxPara(s.caption, { size: 16, align: 'center' });
      }
    });

    var styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:eastAsia="微软雅黑" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>' +
      '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
      '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders>' +
      '<w:top w:val="single" w:sz="4" w:space="0" w:color="D0D7E2"/><w:left w:val="single" w:sz="4" w:space="0" w:color="D0D7E2"/>' +
      '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="D0D7E2"/><w:right w:val="single" w:sz="4" w:space="0" w:color="D0D7E2"/>' +
      '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="D0D7E2"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="D0D7E2"/>' +
      '</w:tblBorders></w:tblPr></w:style></w:styles>';

    var documentXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"' +
      ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"' +
      ' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"' +
      ' xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
      '<w:body>' + body +
      '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>' +
      '</w:body></w:document>';

    var contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Default Extension="png" ContentType="image/png"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
      '</Types>';

    var rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>';

    var docRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      rels.join('') + '</Relationships>';

    var files = [
      { name: '[Content_Types].xml', data: utf8(contentTypes) },
      { name: '_rels/.rels', data: utf8(rootRels) },
      { name: 'word/document.xml', data: utf8(documentXml) },
      { name: 'word/styles.xml', data: utf8(styles) },
      { name: 'word/_rels/document.xml.rels', data: utf8(docRels) }
    ].concat(media);
    return zipStore(files);
  }

  /* ---------------- XLSX（真 .xlsx，ZIP + 内联字符串） ---------------- */
  function colName(i) {
    var s = '';
    i += 1;
    while (i > 0) { var m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
    return s;
  }
  function sheetXML(rows) {
    var out = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>';
    rows.forEach(function (row, ri) {
      out += '<row r="' + (ri + 1) + '">';
      row.forEach(function (v, ci) {
        var ref = colName(ci) + (ri + 1);
        if (v === null || v === undefined || v === '') { out += '<c r="' + ref + '"/>'; return; }
        if (typeof v === 'number' && isFinite(v)) out += '<c r="' + ref + '"><v>' + v + '</v></c>';
        else out += '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + esc(String(v)) + '</t></is></c>';
      });
      out += '</row>';
    });
    return out + '</sheetData></worksheet>';
  }
  function toXLSX(sheets) {
    var n = sheets.length, files = [], i;
    var ct = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>';
    for (i = 1; i <= n; i++) {
      ct += '<Override PartName="/xl/worksheets/sheet' + i + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
    }
    ct += '</Types>';

    var rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>';

    var wbSheets = '', wbRels = '';
    sheets.forEach(function (s, k) {
      wbSheets += '<sheet name="' + esc(String(s.name).slice(0, 31)) + '" sheetId="' + (k + 1) + '" r:id="rId' + (k + 1) + '"/>';
      wbRels += '<Relationship Id="rId' + (k + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (k + 1) + '.xml"/>';
    });
    var workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets>' + wbSheets + '</sheets></workbook>';
    var wbRelsXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + wbRels + '</Relationships>';

    files.push({ name: '[Content_Types].xml', data: utf8(ct) });
    files.push({ name: '_rels/.rels', data: utf8(rootRels) });
    files.push({ name: 'xl/workbook.xml', data: utf8(workbook) });
    files.push({ name: 'xl/_rels/workbook.xml.rels', data: utf8(wbRelsXml) });
    sheets.forEach(function (s, k) {
      var rows = [];
      if (s.head) rows.push(s.head);
      s.rows.forEach(function (r) { rows.push(r); });
      files.push({ name: 'xl/worksheets/sheet' + (k + 1) + '.xml', data: utf8(sheetXML(rows)) });
    });
    var blob = zipStore(files);
    return new Blob([blob], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  /* ---------------- XLS（SpreadsheetML 2003，保留作兼容） ---------------- */
  function xlsCell(v, type) {
    var t = type || (typeof v === 'number' && isFinite(v) ? 'Number' : 'String');
    return '<Cell><Data ss:Type="' + t + '">' + esc(v) + '</Data></Cell>';
  }
  function toXLS(sheets) {
    var xml = '<?xml version="1.0" encoding="UTF-8"?>\n<?mso-application progid="Excel.Sheet"?>\n' +
      '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"' +
      ' xmlns:o="urn:schemas-microsoft-com:office:office"' +
      ' xmlns:x="urn:schemas-microsoft-com:office:excel"' +
      ' xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">' +
      '<Styles><Style ss:ID="h"><Font ss:Bold="1"/><Interior ss:Color="#EEF2F8" ss:Pattern="Solid"/></Style></Styles>';
    sheets.forEach(function (sh) {
      xml += '<Worksheet ss:Name="' + esc(sh.name).slice(0, 31) + '"><Table>';
      if (sh.head) {
        xml += '<Row>' + sh.head.map(function (c) { return '<Cell ss:StyleID="h"><Data ss:Type="String">' + esc(c) + '</Data></Cell>'; }).join('') + '</Row>';
      }
      sh.rows.forEach(function (r) {
        xml += '<Row>' + r.map(function (c) { return xlsCell(c); }).join('') + '</Row>';
      });
      xml += '</Table></Worksheet>';
    });
    return new Blob([xml + '</Workbook>'], { type: 'application/vnd.ms-excel;charset=utf-8' });
  }

  CS.export = {
    toHTML: toHTML, toHTMLBody: toHTMLBody, toDOCX: toDOCX, toXLSX: toXLSX, toXLS: toXLS,
    download: download, stamp: stamp, esc: esc
  };
})(typeof window !== 'undefined' ? window : globalThis);
