/**
 * HTML/DOMノードをMarkdownテキストに変換するユーティリティ
 */

/**
 * 不要なUI要素かどうかを判定
 * @param {Element} element
 * @returns {boolean}
 */
function isIgnoredElement(element) {
  if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;

  const tag = element.tagName.toLowerCase();

  // 明示的に除外すべきタグ
  const ignoredTags = ['button', 'yt-icon', 'tp-yt-paper-tooltip', 'svg', 'script', 'style'];
  if (ignoredTags.includes(tag)) return true;

  // ボタンやフィードバック用UIのクラスや属性
  if (element.getAttribute('role') === 'button') return true;
  if (element.classList.contains('yt-spec-button-shape-next')) return true;
  if (element.classList.contains('ytd-menu-renderer')) return true;

  // コピー完了などのフィードバックトーストや免責事項のボタン周り
  if (element.getAttribute('aria-hidden') === 'true') {
    // スクリーンリーダー非表示でも内容がアイコン等のみなら除外
    if (element.querySelectorAll('*').length === 0 && !element.textContent.trim()) {
      return true;
    }
  }

  return false;
}

/**
 * リンクのURLを正規化（相対パスやタイムスタンプを動画完全URLへ解決）
 * @param {string} href
 * @param {string} baseVideoUrl
 * @returns {string}
 */
function resolveLinkUrl(href, baseVideoUrl) {
  if (!href) return '';

  try {
    // タイムスタンプリンク（例: /watch?v=xxx&t=120s または &t=120s）
    if (href.startsWith('/watch')) {
      return new URL(href, 'https://www.youtube.com').href;
    }
    if (href.startsWith('&t=') || href.startsWith('?t=')) {
      const parsedBase = new URL(baseVideoUrl);
      const params = new URLSearchParams(href.replace(/^[&?]/, ''));
      params.forEach((v, k) => parsedBase.searchParams.set(k, v));
      return parsedBase.href;
    }
    if (href.startsWith('http://') || href.startsWith('https://')) {
      return href;
    }
    return new URL(href, baseVideoUrl).href;
  } catch {
    return href;
  }
}

/**
 * DOMノードを再帰的に走査してMarkdown文字列を生成
 * @param {Node} node
 * @param {string} baseVideoUrl
 * @param {number} listDepth
 * @returns {string}
 */
export function domNodeToMarkdown(node, baseVideoUrl = '', listDepth = 0) {
  if (!node) return '';

  // テキストノード
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent;
  }

  // 要素ノード以外はスキップ
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return '';
  }

  const element = /** @type {Element} */ (node);

  // 無視すべきUI要素
  if (isIgnoredElement(element)) {
    return '';
  }

  const tag = element.tagName.toLowerCase();

  // 子ノードのMarkdown変換（liの場合は深さを引き継ぐ）
  const nextDepth = (tag === 'ul' || tag === 'ol') ? listDepth + 1 : listDepth;
  const childrenMd = Array.from(element.childNodes)
    .map(child => domNodeToMarkdown(child, baseVideoUrl, nextDepth))
    .join('');

  switch (tag) {
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6': {
      // 要約内の見出しはレベル3（###）から始める
      const text = childrenMd.trim();
      return text ? `\n\n### ${text}\n\n` : '';
    }

    case 'strong':
    case 'b': {
      const text = childrenMd.trim();
      return text ? `**${text}**` : '';
    }

    case 'em':
    case 'i': {
      const text = childrenMd.trim();
      return text ? `*${text}*` : '';
    }

    case 'code': {
      const text = childrenMd.trim();
      return text ? `\`${text}\`` : '';
    }

    case 'pre': {
      const text = childrenMd.trim();
      return text ? `\n\`\`\`\n${text}\n\`\`\`\n` : '';
    }

    case 'a': {
      const text = childrenMd.trim();
      if (!text) return '';
      const rawHref = element.getAttribute('href') || '';
      const href = resolveLinkUrl(rawHref, baseVideoUrl);
      return href ? `[${text}](${href})` : text;
    }

    case 'li': {
      const indent = '  '.repeat(Math.max(0, listDepth - 1));
      const text = childrenMd.trim();
      return text ? `${indent}- ${text}\n` : '';
    }

    case 'ul':
    case 'ol': {
      return `\n${childrenMd}\n`;
    }

    case 'p': {
      const text = childrenMd.trim();
      return text ? `\n\n${text}\n\n` : '';
    }

    case 'br': {
      return '\n';
    }

    case 'div':
    case 'yt-formatted-string':
    case 'yt-core-attributed-string': {
      // YouTube特有のテキストラッパー要素
      // 内部にテキストや段落が含まれる場合
      return childrenMd;
    }

    default:
      return childrenMd;
  }
}

/**
 * 抽出したMarkdownテキストの空行・インデント・箇条書きを整形
 * @param {string} rawMd
 * @returns {string}
 */
export function cleanMarkdown(rawMd) {
  if (!rawMd) return '';

  return rawMd
    // 3つ以上の連続改行を2つに圧縮
    .replace(/\n{3,}/g, '\n\n')
    // 箇条書き記号（• や ▪ など）をMarkdownの `- ` に正規化
    .replace(/^[ \t]*[•▪■・][ \t]*/gm, '- ')
    // 行末の不要なスペースを除去
    .replace(/[ \t]+$/gm, '')
    .trim();
}

/**
 * 要件に従った最終的なMarkdownドキュメントを構築
 * @param {Object} params
 * @param {string} params.title - 動画タイトル
 * @param {string} params.url - 動画URL
 * @param {string} params.channel - チャンネル名
 * @param {string} params.savedAt - 保存日時 (YYYY-MM-DD HH:mm:ss など)
 * @param {string} params.summaryContent - Markdown形式の要約本文
 * @returns {string} 完成したMarkdown文字列
 */
export function formatFullMarkdown({ title, url, channel, savedAt, summaryContent }) {
  const cleanSummary = cleanMarkdown(summaryContent);

  return [
    `# ${title || '無題の動画'}`,
    '',
    `- **動画URL**: ${url || ''}`,
    `- **チャンネル名**: ${channel || '不明'}`,
    `- **保存日時**: ${savedAt || ''}`,
    '',
    '## 要約',
    '',
    cleanSummary || '（要約テキストの取得に失敗したか、内容が空です）',
    ''
  ].join('\n');
}
