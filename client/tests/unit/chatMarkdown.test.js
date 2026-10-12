import { describe, it, expect } from 'vitest';
import { renderMarkdown, renderInline } from '@/utils/chatMarkdown';

describe('assistant reply formatting', () => {
  it('escapes HTML before adding any tag', () => {
    const html = renderMarkdown('Trap <img src=x onerror=alert(1)> **"A1"**');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('<strong class="md-strong">&quot;A1&quot;</strong>');
  });

  it('keeps links as plain text', () => {
    expect(renderInline('see [the report](https://evil.example/x)')).toBe('see the report');
    expect(renderInline('[x](javascript:alert(1))')).not.toContain('href');
  });

  it('formats code spans without formatting inside them', () => {
    expect(renderInline('run `a **b** <c>`')).toBe('run <code class="md-code">a **b** &lt;c&gt;</code>');
  });

  it('leaves arithmetic and snake_case alone', () => {
    expect(renderInline('5 * 3 = 15')).toBe('5 * 3 = 15');
    expect(renderInline('fruit_fly_count')).toBe('fruit_fly_count');
  });

  it('renders headings, nested lists, tables and rules', () => {
    const html = renderMarkdown([
      '### Tóm tắt',
      '- Bẫy A1',
      '  - 12 con',
      '- Bẫy A2',
      '',
      '| Bẫy | Số |',
      '|---|---|',
      '| A1 | 12 |',
      '---'
    ].join('\n'));
    expect(html).toContain('<p class="md-h md-h3">Tóm tắt</p>');
    expect((html.match(/<ul/g) || []).length).toBe(2);
    expect(html).toContain('<table');
    expect(html).toContain('A1');
    expect(html).toContain('<hr class="md-hr"/>');
    // Every list that opens also closes
    expect((html.match(/<ul/g) || []).length).toBe((html.match(/<\/ul>/g) || []).length);
  });

  it('returns nothing for an empty reply', () => {
    expect(renderMarkdown('')).toBe('');
    expect(renderMarkdown(null)).toBe('');
  });
});
