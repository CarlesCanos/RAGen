// A small Markdown renderer for model replies. Text is always added through DOM
// text nodes, so replies cannot inject HTML or event handlers into the chat.
function renderMarkdown(text) {
  const fragment = document.createDocumentFragment();
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  let index = 0;

  function inline(value, parent) {
    let position = 0;
    let plain = '';
    const flush = () => {
      if (plain) parent.append(document.createTextNode(plain));
      plain = '';
    };
    while (position < value.length) {
      const rest = value.slice(position);
      const link = /^\[([^\]\n]+)\]\(([^\s)]+)\)/.exec(rest);
      if (link) {
        let url;
        try { url = new URL(link[2], window.location.href); } catch { /* Leave invalid links as text. */ }
        if (url && ['http:', 'https:', 'mailto:'].includes(url.protocol)) {
          flush();
          const anchor = document.createElement('a');
          anchor.href = url.href;
          anchor.target = '_blank';
          anchor.rel = 'noopener noreferrer';
          inline(link[1], anchor);
          parent.append(anchor);
          position += link[0].length;
          continue;
        }
      }
      const code = /^(`+)([^`\n]+)\1/.exec(rest);
      if (code) {
        flush();
        const element = document.createElement('code');
        element.textContent = code[2];
        parent.append(element);
        position += code[0].length;
        continue;
      }
      let formatted = false;
      for (const [marker, tag] of [['**', 'strong'], ['__', 'strong'], ['*', 'em'], ['_', 'em']]) {
        if (!rest.startsWith(marker)) continue;
        const end = rest.indexOf(marker, marker.length);
        if (end <= marker.length) continue;
        flush();
        const element = document.createElement(tag);
        inline(rest.slice(marker.length, end), element);
        parent.append(element);
        position += end + marker.length;
        formatted = true;
        break;
      }
      if (formatted) continue;
      plain += value[position];
      position++;
    }
    flush();
  }

  function paragraph(content, parent = fragment) {
    const element = document.createElement('p');
    content.forEach(line => {
      const span = document.createElement('span');
      span.className = 'chat-line';
      if (line) inline(line, span);
      else span.textContent = '\u00a0';
      element.append(span);
    });
    parent.append(element);
  }

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index++; continue; }
    const fence = /^\s*(```+|~~~+)(.*)$/.exec(line);
    if (fence) {
      const language = fence[2].trim();
      const content = [];
      index++;
      while (index < lines.length && !new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`).test(lines[index])) content.push(lines[index++]);
      if (index < lines.length) index++;
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      if (/^[\w+-]+$/.test(language)) code.className = `language-${language}`;
      code.textContent = content.join('\n');
      pre.append(code);
      fragment.append(pre);
      continue;
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      const element = document.createElement(`h${heading[1].length}`);
      inline(heading[2], element);
      fragment.append(element);
      index++;
      continue;
    }
    const listItem = /^\s{0,3}([-+*]|\d+[.)])\s+(.+)$/.exec(line);
    if (listItem) {
      const ordered = /^\d/.test(listItem[1]);
      const list = document.createElement(ordered ? 'ol' : 'ul');
      if (ordered) list.start = Number.parseInt(listItem[1], 10);
      while (index < lines.length) {
        const item = /^\s{0,3}([-+*]|\d+[.)])\s+(.+)$/.exec(lines[index]);
        if (!item || /^\d/.test(item[1]) !== ordered) break;
        const element = document.createElement('li');
        inline(item[2], element);
        list.append(element);
        index++;
      }
      fragment.append(list);
      continue;
    }
    if (/^\s{0,3}>\s?/.test(line)) {
      const quote = document.createElement('blockquote');
      const content = [];
      while (index < lines.length && /^\s{0,3}>\s?/.test(lines[index])) content.push(lines[index++].replace(/^\s{0,3}>\s?/, ''));
      paragraph(content, quote);
      fragment.append(quote);
      continue;
    }
    const content = [];
    while (index < lines.length && lines[index].trim() && !/^\s{0,3}(?:#{1,6}\s|[-+*]\s|\d+[.)]\s|>\s?|```|~~~)/.test(lines[index])) content.push(lines[index++]);
    if (content.length) paragraph(content);
    else { paragraph([line]); index++; }
  }
  return fragment;
}
