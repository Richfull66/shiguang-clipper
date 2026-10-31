/* 时光库 Clipper · 页面内容提取
 * 在隔离世界中运行，把当前页面的正文/选中内容转成 Markdown。
 * 图片先以 __IMG_n__ 占位，由后台下载后替换成仓库内的相对路径。
 */
(() => {
  if (window.__shiguangClipperLoaded) return;
  window.__shiguangClipperLoaded = true;

  const MIN_IMAGE_SIDE = 100;
  const SKIP_TAGS = new Set([
    'script', 'style', 'noscript', 'iframe', 'svg', 'canvas', 'video', 'audio',
    'form', 'input', 'button', 'select', 'textarea', 'template', 'object', 'embed'
  ]);
  const NOISE_SELECTOR = [
    'nav', 'footer', 'aside',
    '[role="navigation"]', '[role="banner"]', '[role="complementary"]',
    '[aria-hidden="true"]', '[hidden]',
    '.ad', '.ads', '.advert', '.advertisement', '.share', '.social',
    '.comment', '.comments', '.sidebar', '.related', '.recommend',
    '.breadcrumb', '.cookie', '.popup', '.modal', '.subscribe'
  ].join(',');

  // ---------- 元信息 ----------
  function metaContent(selector) {
    const el = document.querySelector(selector);
    if (!el) return '';
    return (el.getAttribute('content') || el.getAttribute('datetime') || '').trim();
  }

  function getMeta() {
    const ogTitle = metaContent('meta[property="og:title"]');
    const time = document.querySelector('time[datetime]');
    return {
      title: (ogTitle || document.title || location.hostname).trim(),
      url: location.href,
      site: metaContent('meta[property="og:site_name"]') || location.hostname,
      author: metaContent('meta[name="author"]') || metaContent('meta[property="article:author"]'),
      description: metaContent('meta[name="description"]') || metaContent('meta[property="og:description"]'),
      published: metaContent('meta[property="article:published_time"]') || (time ? time.getAttribute('datetime') : '') || ''
    };
  }

  // ---------- 图片 ----------
  function resolveImageUrl(img) {
    const raw = img.currentSrc ||
      img.getAttribute('src') ||
      img.getAttribute('data-src') ||
      img.getAttribute('data-original') ||
      img.getAttribute('data-lazy-src') ||
      img.getAttribute('data-actualsrc') ||
      img.getAttribute('data-url') || '';
    if (!raw || raw.startsWith('data:') || raw.startsWith('blob:')) return '';
    try {
      const u = new URL(raw, location.href);
      return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : '';
    } catch (e) {
      return '';
    }
  }

  function imageUsable(img) {
    const w = img.naturalWidth || img.width || 0;
    const h = img.naturalHeight || img.height || 0;
    if (w && h && (w < MIN_IMAGE_SIDE || h < MIN_IMAGE_SIDE)) return false;
    const cls = (img.className && typeof img.className === 'string') ? img.className : '';
    if (/(^|[\s_-])(avatar|icon|logo|emoji|badge|qr)([\s_-]|$)/i.test(cls)) return false;
    return true;
  }

  function renderImage(img, ctx) {
    const url = resolveImageUrl(img);
    if (!url || !imageUsable(img)) return '';
    const alt = (img.getAttribute('alt') || '').replace(/[\[\]]/g, ' ').trim();
    let index = ctx.urlToIndex.get(url);
    if (!index) {
      if (ctx.images.length >= ctx.maxImages) return '';
      index = ctx.images.length + 1;
      ctx.urlToIndex.set(url, index);
      ctx.images.push({ index, url, alt });
    }
    return `![${alt}](__IMG_${index}__)`;
  }

  // ---------- HTML → Markdown ----------
  function cleanInline(text) {
    return text.replace(/[ \t\f\v]+/g, ' ').replace(/\s*\n\s*/g, ' ').trim();
  }

  // 段落保留 <br> 的换行，输出 Markdown 硬换行（行尾两个空格）
  function cleanParagraph(text) {
    const lines = text
      .split('\n')
      .map(line => line.replace(/[ \t\f\v]+/g, ' ').trim())
      .filter(line => line !== '');
    return lines.join('  \n');
  }

  function renderChildren(node, ctx) {
    let out = '';
    for (const child of node.childNodes) out += renderNode(child, ctx);
    return out;
  }

  function renderList(el, ctx, ordered) {
    let out = '';
    let n = 1;
    for (const li of el.children) {
      if (li.tagName.toLowerCase() !== 'li') continue;
      let main = '';
      let nested = '';
      for (const child of li.childNodes) {
        const tag = child.nodeType === 1 ? child.tagName.toLowerCase() : '';
        if (tag === 'ul' || tag === 'ol') nested += renderNode(child, ctx);
        else main += renderNode(child, ctx);
      }
      main = cleanParagraph(main);
      out += `${ordered ? n + '. ' : '- '}${main}\n`;
      if (nested.trim()) {
        out += nested.trim().split('\n').map(line => '  ' + line).join('\n') + '\n';
      }
      n += 1;
    }
    return out;
  }

  function renderTable(table, ctx) {
    const rows = [];
    for (const tr of table.querySelectorAll('tr')) {
      const cells = [];
      for (const cell of tr.children) {
        if (!/^(td|th)$/i.test(cell.tagName)) continue;
        cells.push(cleanInline(renderChildren(cell, ctx)).replace(/\|/g, '\\|'));
      }
      if (cells.length) rows.push(cells);
    }
    if (!rows.length) return '';
    const cols = Math.max(...rows.map(r => r.length));
    const norm = row => {
      const copy = row.slice();
      while (copy.length < cols) copy.push('');
      return copy;
    };
    const header = norm(rows[0]);
    const lines = [
      '| ' + header.join(' | ') + ' |',
      '| ' + header.map(() => '---').join(' | ') + ' |'
    ];
    for (const row of rows.slice(1)) lines.push('| ' + norm(row).join(' | ') + ' |');
    return lines.join('\n');
  }

  function renderNode(node, ctx) {
    if (node.nodeType === 3) {
      const raw = node.nodeValue;
      // 丢弃源码排版用的纯空白（含换行）；行内空格保留
      if (!raw.trim() && raw.includes('\n')) return '';
      return raw.replace(/\s+/g, ' ');
    }
    if (node.nodeType !== 1) return '';

    const tag = node.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return '';
    if (node.id && /^(comments?|respond|sidebar|footer)$/i.test(node.id)) return '';
    const cls = (node.className && typeof node.className === 'string') ? node.className : '';
    if (cls && /(^|[\s_-])(ad|ads|advert|share|social|comment|sidebar|related|recommend|breadcrumb|cookie|popup|modal)([\s_-]|$)/i.test(cls)) {
      return '';
    }

    switch (tag) {
      case 'br': return '  \n';
      case 'hr': return '\n\n---\n\n';
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
        const level = Number(tag[1]);
        const text = cleanInline(renderChildren(node, ctx));
        return text ? `\n\n${'#'.repeat(level)} ${text}\n\n` : '';
      }
      case 'p': {
        const text = cleanParagraph(renderChildren(node, ctx));
        return text ? `\n\n${text}\n\n` : '';
      }
      case 'blockquote': {
        const inner = renderChildren(node, ctx).trim();
        if (!inner) return '';
        return '\n\n' + inner.split('\n').map(line => '> ' + line).join('\n') + '\n\n';
      }
      case 'pre': {
        const code = node.textContent.replace(/\n+$/, '');
        return '\n\n```\n' + code + '\n```\n\n';
      }
      case 'code': {
        const text = node.textContent.replace(/`/g, '\\`');
        return text ? '`' + text + '`' : '';
      }
      case 'ul': return '\n\n' + renderList(node, ctx, false) + '\n';
      case 'ol': return '\n\n' + renderList(node, ctx, true) + '\n';
      case 'li': return renderChildren(node, ctx);
      case 'img': return renderImage(node, ctx);
      case 'a': {
        const href = node.getAttribute('href') || '';
        const text = cleanInline(renderChildren(node, ctx));
        if (!text) return '';
        if (!href || href.startsWith('javascript:') || href.startsWith('#')) return text;
        let abs = href;
        try { abs = new URL(href, location.href).href; } catch (e) { /* keep raw */ }
        const target = /[()\s]/.test(abs) ? `<${abs}>` : abs;
        return `[${text}](${target})`;
      }
      case 'strong': case 'b': {
        const text = cleanInline(renderChildren(node, ctx));
        return text ? `**${text}**` : '';
      }
      case 'em': case 'i': {
        const text = cleanInline(renderChildren(node, ctx));
        return text ? `*${text}*` : '';
      }
      case 'table': return '\n\n' + renderTable(node, ctx) + '\n\n';
      case 'div': case 'section': case 'article': case 'main':
      case 'header': case 'figure': case 'figcaption': case 'details': case 'summary':
        return '\n\n' + renderChildren(node, ctx) + '\n\n';
      default:
        return renderChildren(node, ctx);
    }
  }

  function tidyMarkdown(md) {
    // 注意：不要删除行尾空格，段落里的 <br> 依赖两个空格实现 Markdown 硬换行
    return md
      .replace(/^[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^\s+|\s+$/g, '');
  }

  function removeNoise(root) {
    root.querySelectorAll(NOISE_SELECTOR).forEach(el => el.remove());
    root.querySelectorAll('[style]').forEach(el => {
      const style = (el.getAttribute('style') || '').toLowerCase();
      if (style.includes('display:none') || style.includes('visibility:hidden')) el.remove();
    });
  }

  function pickRoot() {
    const selectors = [
      'article', 'main', '[role="main"]',
      '.post-content', '.article-content', '.entry-content', '.post-body',
      '.article', '.post', '#content', '.content'
    ];
    let best = null;
    let bestScore = 0;
    for (const el of document.querySelectorAll(selectors.join(','))) {
      const text = (el.innerText || '').trim();
      if (text.length < 200) continue;
      const score = text.length + el.querySelectorAll('p').length * 150;
      if (score > bestScore) { bestScore = score; best = el; }
    }
    return best || document.body;
  }

  function stripLeadingTitle(md, title) {
    const lines = md.split('\n');
    if (!lines.length) return md;
    const first = lines[0].trim();
    if (/^#\s+/.test(first)) {
      const heading = first.replace(/^#\s+/, '').trim();
      const a = heading.replace(/\s+/g, '');
      const b = (title || '').replace(/\s+/g, '');
      if (a && b && (a === b || a.includes(b) || b.includes(a))) {
        return tidyMarkdown(lines.slice(1).join('\n'));
      }
    }
    return md;
  }

  function extract(mode, maxImages) {
    const meta = getMeta();
    const ctx = { images: [], urlToIndex: new Map(), maxImages: Math.max(1, Math.min(Number(maxImages) || 30, 60)) };
    let markdown = '';

    if (mode === 'selection') {
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && selection.rangeCount > 0) {
        const holder = document.createElement('div');
        holder.appendChild(selection.getRangeAt(0).cloneContents());
        removeNoise(holder);
        markdown = tidyMarkdown(renderChildren(holder, ctx));
      }
      if (!markdown) {
        const root = pickRoot();
        const clone = root.cloneNode(true);
        removeNoise(clone);
        markdown = tidyMarkdown(renderChildren(clone, ctx));
      }
    } else {
      const root = pickRoot();
      const clone = root.cloneNode(true);
      removeNoise(clone);
      markdown = tidyMarkdown(renderChildren(clone, ctx));
      markdown = stripLeadingTitle(markdown, meta.title);
    }

    return {
      ok: true,
      meta,
      title: meta.title,
      url: meta.url,
      site: meta.site,
      author: meta.author,
      description: meta.description,
      published: meta.published,
      markdown,
      images: ctx.images,
      stats: {
        chars: markdown.length,
        imageCount: ctx.images.length
      }
    };
  }

  function preview() {
    const selection = window.getSelection();
    const selected = selection ? selection.toString().trim() : '';
    const root = pickRoot();
    const seen = new Set();
    let count = 0;
    for (const img of root.querySelectorAll('img')) {
      const url = resolveImageUrl(img);
      if (!url || !imageUsable(img) || seen.has(url)) continue;
      seen.add(url);
      count += 1;
    }
    return {
      ok: true,
      title: document.title,
      url: location.href,
      selectionLength: selected.length,
      imageCount: count
    };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    try {
      if (message.type === 'PING') {
        sendResponse({ ok: true });
      } else if (message.type === 'PREVIEW') {
        sendResponse(preview());
      } else if (message.type === 'EXTRACT') {
        sendResponse(extract(message.mode || 'page', message.maxImages));
      }
    } catch (error) {
      sendResponse({ ok: false, error: error.message });
    }
    return false;
  });
})();
