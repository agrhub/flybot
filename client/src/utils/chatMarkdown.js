// Markdown for assistant replies: headings, lists, tables, quotes, rules, bold, italics, code.
// Replies can contain camera names and other user-written text, so every piece of text is
// HTML-escaped before any tag is added; links are left as plain text.

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

/** Inline formatting on one line of raw text. */
export function renderInline(raw) {
  // Code spans first, kept aside so their content is not formatted
  const codes = [];
  let text = String(raw ?? '').replace(/`([^`\n]+)`/g, (m, code) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });
  text = escapeHtml(text)
    // [label](url) -> label
    .replace(/\[([^\]\n]+)\]\((?:https?:\/\/|\/)[^)\s]*\)/g, '$1')
    .replace(/\*\*(?!\s)(.+?)(?<!\s)\*\*/g, '<strong class="md-strong">$1</strong>')
    .replace(/__(?!\s)(.+?)(?<!\s)__/g, '<strong class="md-strong">$1</strong>')
    // Single * or _ only around a word or phrase, so "5 * 3" or snake_case stay as they are
    .replace(/(^|[^\w*])\*(?![\s*])([^*\n]+?)(?<!\s)\*(?![\w*])/g, '$1<em class="md-em">$2</em>')
    .replace(/(^|[^\w])_(?![\s_])([^_\n]+?)(?<!\s)_(?!\w)/g, '$1<em class="md-em">$2</em>');
  return text.replace(/\u0000(\d+)\u0000/g, (m, i) => `<code class="md-code">${escapeHtml(codes[Number(i)])}</code>`);
}

const LIST_ITEM = /^(\s*)([*+-]|\d{1,3}[.)])\s+(.*)$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const cells = (row) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());

/** A whole reply as HTML. */
export function renderMarkdown(raw) {
  if (!raw) return '';
  const lines = String(raw).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let paragraph = [];
  // Open lists, innermost last: { type: 'ul' | 'ol', indent }
  const lists = [];

  const flushParagraph = () => {
    if (paragraph.length) out.push(`<p class="md-p">${paragraph.map(renderInline).join('<br/>')}</p>`);
    paragraph = [];
  };
  const closeLists = (toIndent = -1) => {
    while (lists.length && lists[lists.length - 1].indent > toIndent) out.push(`</li></${lists.pop().type}>`);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      flushParagraph();
      // A blank line between items keeps the list open; anything else after it closes it
      const next = lines.slice(i + 1).find(l => l.trim());
      if (!next || !LIST_ITEM.test(next)) closeLists();
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.*?)\s*#*$/);
    if (heading) {
      flushParagraph(); closeLists();
      out.push(`<p class="md-h md-h${Math.min(heading[1].length, 4)}">${renderInline(heading[2])}</p>`);
      continue;
    }
    if (/^(\*\s*){3,}$|^(-\s*){3,}$|^(_\s*){3,}$/.test(trimmed)) {
      flushParagraph(); closeLists();
      out.push('<hr class="md-hr"/>');
      continue;
    }
    if (TABLE_ROW.test(line) && TABLE_RULE.test(lines[i + 1] || '')) {
      flushParagraph(); closeLists();
      const head = cells(line);
      const body = [];
      i += 2;
      while (i < lines.length && TABLE_ROW.test(lines[i])) body.push(cells(lines[i++]));
      i--;
      out.push('<div class="md-table-wrap"><table class="md-table"><thead><tr>'
        + head.map(c => `<th>${renderInline(c)}</th>`).join('')
        + '</tr></thead><tbody>'
        + body.map(r => `<tr>${head.map((h, k) => `<td>${renderInline(r[k] ?? '')}</td>`).join('')}</tr>`).join('')
        + '</tbody></table></div>');
      continue;
    }
    if (trimmed.startsWith('>')) {
      flushParagraph(); closeLists();
      const quote = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) quote.push(lines[i++].trim().replace(/^>\s?/, ''));
      i--;
      out.push(`<blockquote class="md-quote">${quote.map(renderInline).join('<br/>')}</blockquote>`);
      continue;
    }

    const item = line.match(LIST_ITEM);
    if (item) {
      flushParagraph();
      const indent = item[1].replace(/\t/g, '  ').length;
      const type = /\d/.test(item[2]) ? 'ol' : 'ul';
      closeLists(indent);
      const top = lists[lists.length - 1];
      if (top && top.indent === indent && top.type !== type) closeLists(indent - 1);
      const current = lists[lists.length - 1];
      if (current && current.indent === indent) {
        out.push(`</li><li>${renderInline(item[3])}`);
      } else {
        const start = type === 'ol' && parseInt(item[2], 10) > 1 ? ` start="${parseInt(item[2], 10)}"` : '';
        lists.push({ type, indent });
        out.push(`<${type} class="md-list"${start}><li>${renderInline(item[3])}`);
      }
      continue;
    }

    // Text indented under a list item continues it
    if (lists.length && /^\s+/.test(line)) {
      out.push(`<br/>${renderInline(trimmed)}`);
      continue;
    }
    closeLists();
    paragraph.push(trimmed);
  }
  flushParagraph();
  closeLists();
  return out.join('');
}
