import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

type FakeNode = { tag: string; text: string; children: FakeNode[]; href?: string; rel?: string };
function node(tag: string): FakeNode & { append: (...children: FakeNode[]) => void; textContent: string } {
  const value = { tag, text: '', children: [] as FakeNode[], append(...children: FakeNode[]) { this.children.push(...children); } };
  return Object.defineProperty(value, 'textContent', { get() { return this.text; }, set(text: string) { this.text = text; this.children = []; } }) as typeof value & { textContent: string };
}

const context = createContext({
  document: {
    createDocumentFragment: () => node('fragment'),
    createElement: (tag: string) => node(tag),
    createTextNode: (text: string) => ({ tag: '#text', text, children: [] }),
  },
  window: { location: { href: 'http://localhost:3000/' } },
  URL,
});
runInContext(readFileSync(new URL('../markdown.js', import.meta.url), 'utf8'), context);
const renderMarkdown = runInContext('renderMarkdown', context) as (text: string) => FakeNode;

function descendants(root: FakeNode, tag: string): FakeNode[] {
  return [root, ...root.children.flatMap(child => descendants(child, tag))].filter(child => child.tag === tag);
}

test('formats paragraphs, emphasis, links and lists', () => {
  const result = renderMarkdown('A **bold** and *italic* [link](https://example.com).\n\n- First\n- Second');
  assert.equal(descendants(result, 'strong').length, 1);
  assert.equal(descendants(result, 'em').length, 1);
  assert.equal(descendants(result, 'ul').length, 1);
  assert.equal(descendants(result, 'li').length, 2);
  assert.equal(descendants(result, 'a')[0].href, 'https://example.com/');
  assert.equal(descendants(result, 'a')[0].rel, 'noopener noreferrer');
});

test('treats HTML and unsafe links as text', () => {
  const result = renderMarkdown('<img src=x onerror=alert(1)> [click](javascript:alert)');
  assert.equal(descendants(result, 'img').length, 0);
  assert.equal(descendants(result, 'a').length, 0);
  assert.match(descendants(result, '#text').map(item => item.text).join(''), /<img src=x onerror=alert\(1\)>/);
});

test('renders fenced code literally', () => {
  const result = renderMarkdown('```html\n<script>alert(1)</script>\n```');
  assert.equal(descendants(result, 'pre').length, 1);
  assert.equal(descendants(result, 'script').length, 0);
  assert.equal(descendants(result, 'code')[0].text, '<script>alert(1)</script>');
});

test('keeps explicit line breaks separate from paragraph spacing', () => {
  const result = renderMarkdown('First line\nSecond line\n\nNext paragraph');
  assert.equal(descendants(result, 'p').length, 2);
  assert.equal(descendants(result, 'span').length, 3);
  assert.equal(descendants(result, 'br').length, 0);
});
