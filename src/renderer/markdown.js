'use strict';
// 同梱の説明書（Markdown）を表示するための小さな変換器。
// 見出し・段落・箇条書き・番号付きリスト・表・引用・区切り線・太字・コードに対応する。
(function () {
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function inline(s) {
    return esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  }

  const isTableRow = l => /^\s*\|.*\|\s*$/.test(l);
  const cells = l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());

  // 戻り値: { html, headings: [{ id, text }] }（目次用に ## 見出しを集める）
  function render(text) {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    const headings = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      let m;
      if ((m = /^(#{1,4})\s+(.*)$/.exec(line))) {
        const level = m[1].length;
        const id = `h-${headings.length + out.length}`;
        if (level === 2) headings.push({ id, text: m[2] });
        out.push(`<h${level} id="${id}">${inline(m[2])}</h${level}>`);
        i++;
      } else if (/^-{3,}\s*$/.test(line)) {
        out.push('<hr>');
        i++;
      } else if (line.startsWith('>')) {
        const buf = [];
        while (i < lines.length && lines[i].startsWith('>')) buf.push(lines[i++].replace(/^>\s?/, ''));
        out.push(`<blockquote>${inline(buf.join(' '))}</blockquote>`);
      } else if (isTableRow(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
        const head = cells(line);
        i += 2;
        const rows = [];
        while (i < lines.length && isTableRow(lines[i])) rows.push(cells(lines[i++]));
        out.push(`<table><thead><tr>${head.map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${
          rows.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      } else if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
        const ordered = /^\s*\d+\./.test(line);
        const items = [];
        while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ''));
          i++;
          // 続く字下げ行は同じ項目に含める
          while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*]|\d+\.)\s+/.test(lines[i])) items[items.length - 1] += ` ${lines[i++].trim()}`;
        }
        const tag = ordered ? 'ol' : 'ul';
        out.push(`<${tag}>${items.map(t => `<li>${inline(t)}</li>`).join('')}</${tag}>`);
      } else {
        const buf = [];
        while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|>|-{3,}\s*$|\s*([-*]|\d+\.)\s+)/.test(lines[i]) && !isTableRow(lines[i])) buf.push(lines[i++].trim());
        out.push(`<p>${inline(buf.join(' '))}</p>`);
      }
    }
    return { html: out.join('\n'), headings };
  }

  window.PCMarkdown = { render };
})();
