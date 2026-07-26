// markdown.js - tiny renderer for the chat answer subset:
// headings, bold, inline code, fenced code blocks, pipe tables, bullet + ordered lists,
// and {{ev:id}} evidence tokens which become inline chip placeholders.

/** Escape for safe innerHTML insertion. */
export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Inline formatting pass: **bold**, `code`, {{ev:id}}.
 * Evidence tokens become <span class="ev-slot" data-ev="id"></span> which chat.js hydrates.
 */
export function renderInline(src) {
  let out = escapeHtml(src);
  out = out.replace(/\{\{ev:([a-z0-9_-]+)\}\}/gi, (_m, id) => `<span class="ev-slot" data-ev="${id}"></span>`);
  out = out.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, (_m, c) => `<strong>${c}</strong>`);
  return out;
}

/**
 * Render the markdown subset to an HTML string.
 * @param {string} src
 * @returns {string}
 */
export function renderMarkdown(src) {
  const lines = String(src == null ? '' : src).replace(/\r\n/g, '\n').split('\n');
  const html = [];
  let i = 0;

  const isTableSep = (l) => /^\s*\|?[\s:-]*-[-\s:|]*\|?\s*$/.test(l) && l.includes('-');

  while (i < lines.length) {
    const line = lines[i];

    // fenced code block
    if (/^\s*```/.test(line)) {
      const lang = line.replace(/^\s*```/, '').trim();
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // closing fence
      html.push(
        `<pre class="md-pre"${lang ? ` data-lang="${escapeHtml(lang)}"` : ''}><code>${escapeHtml(body.join('\n'))}</code></pre>`
      );
      continue;
    }

    // heading
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const lvl = Math.min(h[1].length + 2, 6);
      html.push(`<h${lvl} class="md-h">${renderInline(h[2])}</h${lvl}>`);
      i++;
      continue;
    }

    // table
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const cells = (l) =>
        l
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(cells(lines[i]));
        i++;
      }
      const thead = head.map((c) => `<th>${renderInline(c)}</th>`).join('');
      const tbody = rows
        .map((r) => `<tr>${r.map((c) => `<td>${renderInline(c)}</td>`).join('')}</tr>`)
        .join('');
      html.push(`<div class="md-tablewrap"><table class="md-table"><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table></div>`);
      continue;
    }

    // bullet list
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(`<li>${renderInline(lines[i].replace(/^\s*[-*]\s+/, ''))}</li>`);
        i++;
      }
      html.push(`<ul class="md-ul">${items.join('')}</ul>`);
      continue;
    }

    // ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(`<li>${renderInline(lines[i].replace(/^\s*\d+\.\s+/, ''))}</li>`);
        i++;
      }
      html.push(`<ol class="md-ol">${items.join('')}</ol>`);
      continue;
    }

    // blank
    if (line.trim() === '') {
      i++;
      continue;
    }

    // paragraph (consume until blank / block start)
    const para = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^\s*```/.test(lines[i]) &&
      !/^(#{1,4})\s+/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !(lines[i].includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]))
    ) {
      para.push(lines[i]);
      i++;
    }
    html.push(`<p class="md-p">${renderInline(para.join(' '))}</p>`);
  }

  return html.join('');
}
