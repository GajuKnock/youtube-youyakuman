/**
 * YouTube Summary Saver - Content Script (v1.3 Copy-Button Anchor Architecture)
 * AI回答直下の「コピーボタン（アクションバー）」を目印（アンカー）として、
 * 質問文・初期挨拶・提案チップを一切含まない「最新のAI回答本文DOM」のみを直接特定・抽出します。
 */

const SELECTORS = {
  title: [
    'h1.ytd-watch-metadata yt-formatted-string',
    '#title h1 yt-formatted-string',
    '#title h1',
    'h1.title yt-formatted-string',
    'h1.title',
    'meta[name="title"]'
  ],
  channel: [
    'ytd-watch-metadata #channel-name a',
    '#owner #channel-name a',
    '#upload-info #channel-name yt-formatted-string a',
    'ytd-video-owner-renderer #channel-name a',
    '#channel-name yt-formatted-string a',
    '#channel-name a'
  ],
  generating: [
    'tp-yt-paper-spinner[active]',
    'yt-activity-indicator',
    '[class*="loading" i]',
    '[class*="thinking" i]',
    '[class*="pending" i]',
    '[class*="streaming" i]'
  ],
  // 個別のチャットアイテムを表すカスタム要素・コンテナ
  chatItemContainers: [
    'you-chat-item-view-model',
    'yt-convo-item-view-model',
    'ytd-conversational-ai-response-renderer',
    'ytd-chat-item-renderer'
  ]
};

function getCleanVideoUrl() {
  try {
    const url = new URL(window.location.href);
    const videoId = url.searchParams.get('v');
    if (videoId) {
      return `https://www.youtube.com/watch?v=${videoId}`;
    }
  } catch {}
  return window.location.href.split('&')[0];
}

function getFirstMatchText(selectors) {
  for (const selector of selectors) {
    try {
      const el = document.querySelector(selector);
      if (el) {
        if (el.tagName.toLowerCase() === 'meta') {
          const content = el.getAttribute('content');
          if (content && content.trim()) return content.trim();
        } else {
          const text = el.textContent || el.innerText;
          if (text && text.trim()) return text.trim();
        }
      }
    } catch {}
  }
  return '';
}

function findActiveAskPanel() {
  const panels = document.querySelectorAll('ytd-engagement-panel-section-list-renderer');
  
  for (const panel of panels) {
    const targetId = panel.getAttribute('target-id') || '';
    if (/youchat|ask|convo/i.test(targetId)) {
      if (panel.getAttribute('visibility') === 'EXPANDED' || panel.offsetParent !== null) {
        return panel;
      }
    }
  }

  for (const panel of panels) {
    const isExpanded = panel.getAttribute('visibility') === 'EXPANDED' ||
                       (panel.offsetParent !== null && panel.clientHeight > 100);
    if (!isExpanded) continue;

    const text = panel.innerText || panel.textContent || '';
    if (/質問|要約|Gemini|Ask/i.test(text)) {
      return panel;
    }
  }

  return null;
}

function findAskTriggerButton() {
  const candidates = Array.from(document.querySelectorAll('ytd-button-renderer, button, yt-button-shape, div[role="button"]'));
  for (const btn of candidates) {
    const text = btn.innerText || btn.textContent || btn.getAttribute('aria-label') || '';
    if (/質問する|この動画について質問|Ask about this video|Gemini/i.test(text)) {
      if (btn.offsetParent !== null) {
        return btn;
      }
    }
  }
  return null;
}

function checkIsGenerating(panel) {
  if (!panel) return false;
  for (const sel of SELECTORS.generating) {
    try {
      const el = panel.querySelector(sel);
      if (el && (el.offsetParent !== null || el.getAttribute('active') !== null)) {
        return true;
      }
    } catch {}
  }
  return false;
}

function timeToSeconds(timeStr) {
  const parts = timeStr.trim().split(':').map(Number);
  if (parts.some(isNaN)) return 0;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}

function linkifyTimestamps(text, videoUrl) {
  return text.replace(/(?<!\[)(\b\d{1,2}:\d{2}(?::\d{2})?\b)(?!\])/g, (match) => {
    const secs = timeToSeconds(match);
    const href = `${videoUrl}&t=${secs}s`;
    return `[${match}](${href})`;
  });
}

/**
 * ボタン要素が「コピーボタン」または「AI回答下部のアクションボタン（高評価・低評価・コピー）」であるかを判定
 * ※提案チップのボタン（テキストが入っているボタン）やヘッダーの閉じるボタンとは厳密に区別する
 * @param {Element} btn
 * @returns {boolean}
 */
function isCopyOrFeedbackButton(btn) {
  if (!btn) return false;

  // ヘッダー内や入力エリア内のボタンは除外
  if (btn.closest('#header, .ytd-engagement-panel-title-header-renderer, ytd-comment-simplebox-renderer')) {
    return false;
  }

  // 提案チップ内のボタンは除外
  if (btn.closest('yt-chip-cloud-renderer, yt-chip-cloud-chip-renderer, [class*="chip" i]')) {
    return false;
  }

  const label = (
    btn.getAttribute('aria-label') ||
    btn.getAttribute('title') ||
    btn.getAttribute('data-tooltip-text') ||
    ''
  ).toLowerCase();

  // 1. aria-label 等で明示的にコピーボタンとわかる場合
  if (/コピー|copy/i.test(label)) {
    return true;
  }

  // 2. 高評価・低評価ボタン（AI回答アクションバーの構成要素）
  if (/高評価|低評価|役に立った|役に立たなかった|good|bad|like|dislike|helpful/i.test(label)) {
    return true;
  }

  return false;
}

/**
 * チャットアイテム要素が「AI回答のアクションバー（アイコンボタン群）」を持っているか判定
 * 初期挨拶（ボタンなし）、ユーザー質問（ボタンなし）、提案チップ（文字入りボタン）を除外し、
 * アイコンボタン（👍 👎 📋）を持つAI回答アイテムのみを識別する
 * @param {Element} itemEl
 * @returns {Element|null} アクションバーまたはコピーボタン要素
 */
function findActionAnchorInItem(itemEl) {
  if (!itemEl) return null;

  // 提案チップコンテナそのものなら除外
  const tag = itemEl.tagName.toLowerCase();
  if (tag.includes('chip') || itemEl.querySelector('yt-chip-cloud-chip-renderer')) {
    return null;
  }

  const buttons = Array.from(itemEl.querySelectorAll('button, yt-button-shape, yt-icon-button, [role="button"]'));
  if (buttons.length === 0) return null;

  // 1. 明示的なコピー・フィードバックボタンを探す
  for (const btn of buttons) {
    if (isCopyOrFeedbackButton(btn)) {
      return btn;
    }
  }

  // 2. テキストを持たないアイコン専用ボタン（👍 👎 📋）が2つ以上並んでいる箇所を探す
  // （提案チップのボタンは質問テキストが入っているため visibleText.length > 2 となり除外される）
  const iconOnlyButtons = buttons.filter(btn => {
    if (btn.closest('yt-chip-cloud-renderer, yt-chip-cloud-chip-renderer, [class*="chip" i], #header')) {
      return false;
    }
    const visibleText = (btn.innerText || btn.textContent || '').trim();
    const hasIcon = btn.querySelector('svg, yt-icon, path') !== null;
    // ボタン自体の表示文字が空（または空白のみ）でアイコンを持つもの
    return visibleText.length === 0 && hasIcon;
  });

  if (iconOnlyButtons.length >= 2) {
    // 最後のアイコンボタン（＝コピーボタン）を返す
    return iconOnlyButtons[iconOnlyButtons.length - 1];
  }

  return null;
}

/**
 * パネル内から「コピーボタン（アクションバー）を持つAI回答ブロック」をすべてDOM順（古い順）に取得
 * @param {Element} panel
 * @returns {Array<{ container: Element, anchorBtn: Element }>}
 */
function findAiResponseBlocksByCopyAnchor(panel) {
  if (!panel) return [];
  const root = panel.shadowRoot || panel;
  const results = [];
  const seenContainers = new Set();

  // 方法1: チャットアイテムタグ（you-chat-item-view-model 等）ごとに走査
  const itemSelector = SELECTORS.chatItemContainers.join(', ');
  const chatItems = Array.from(root.querySelectorAll(itemSelector));

  if (chatItems.length > 0) {
    for (const item of chatItems) {
      const anchorBtn = findActionAnchorInItem(item);
      if (anchorBtn && !seenContainers.has(item)) {
        // 本文テキストが存在するか確認
        const textLen = (item.innerText || item.textContent || '').trim().length;
        if (textLen >= 20) {
          seenContainers.add(item);
          results.push({ container: item, anchorBtn });
        }
      }
    }
    if (results.length > 0) {
      return results;
    }
  }

  // 方法2: パネル内のコピーボタンを直接探し、そこから対応する回答ブロックを逆引きする
  const allButtons = Array.from(root.querySelectorAll('button, yt-button-shape, yt-icon-button, [role="button"]'));
  const copyButtons = allButtons.filter(btn => {
    const label = (btn.getAttribute('aria-label') || btn.getAttribute('title') || '').toLowerCase();
    return /コピー|copy/i.test(label) && !btn.closest('#header, yt-chip-cloud-renderer');
  });

  for (const copyBtn of copyButtons) {
    // コピーボタンから親方向へ辿り、本文を含む最小の回答ブロックを特定する
    let current = copyBtn.parentElement;
    let matchedContainer = null;

    while (current && current !== panel && current !== root && current.tagName.toLowerCase() !== 'body') {
      // パネル全体のスクロール領域（複数の回答をまとめている親）まで行く手前で止める
      const ownText = (current.innerText || current.textContent || '').trim();
      if (ownText.length >= 20) {
        matchedContainer = current;
        // もしそのコンテナ内にコピーボタンが1つだけなら、それが個別回答ブロック！
        const copyCountInCurrent = copyButtons.filter(b => current.contains(b)).length;
        if (copyCountInCurrent === 1) {
          // さらに親も同じ1つだけなら、挨拶やユーザー質問を含まない範囲で適切なラッパーを選ぶ
          const parent = current.parentElement;
          if (parent && parent !== panel && parent !== root) {
            const copyCountInParent = copyButtons.filter(b => parent.contains(b)).length;
            // 親がチャットリスト全体（複数アイテムを持つコンテナ）でなければ親を見る
            if (copyCountInParent > 1 || parent.id === 'contents' || parent.id === 'items' || parent.id === 'content') {
              break;
            }
          }
          break;
        }
      }
      current = current.parentElement;
    }

    if (matchedContainer && !seenContainers.has(matchedContainer)) {
      seenContainers.add(matchedContainer);
      results.push({ container: matchedContainer, anchorBtn: copyBtn });
    }
  }

  return results;
}

/**
 * 特定された単一のAI回答ブロックから、アクションバーや免責事項を除いた「純粋な回答本文」のみを抽出する
 * @param {Element} container - AI回答ブロック要素
 * @param {string} videoUrl - 動画URL
 * @returns {string} 整形済みMarkdown本文
 */
function extractCleanBodyFromAiBlock(container, videoUrl) {
  if (!container) return '';

  // クローンを作成して不要な付属要素（ボタンバー、免責事項、アイコン等）だけを除去
  const clone = container.cloneNode(true);

  const removeSelectors = [
    'button',
    'yt-button-shape',
    'yt-icon-button',
    'yt-icon',
    'svg',
    'tp-yt-paper-tooltip',
    'yt-chip-cloud-renderer',
    'yt-chip-cloud-chip-renderer',
    '[role="button"]',
    '[class*="feedback" i]',
    '[class*="action" i]',
    '[class*="disclaimer" i]',
    '[class*="footer" i]'
  ];

  for (const sel of removeSelectors) {
    try {
      const els = clone.querySelectorAll(sel);
      els.forEach(el => el.remove());
    } catch {}
  }

  const rawText = clone.innerText || clone.textContent || '';
  if (!rawText) return '';

  // 行単位でシステム免責事項のみ除外（回答内の疑問文や見出しは100%そのまま保持！）
  const lines = rawText
    .split('\n')
    .map(l => l.trim())
    .filter(line => {
      if (!line) return false;
      if (/^AI\s*は不正確な情報を表示することがあるため/i.test(line)) return false;
      if (/^詳細$/i.test(line)) return false;
      return true;
    });

  let text = lines.join('\n\n');

  // 箇条書き記号の正規化
  text = text.replace(/^[ \t]*[•▪■・][ \t]*/gm, '- ');

  // タイムスタンプリンク化
  text = linkifyTimestamps(text, videoUrl);

  // 連続改行の整理
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  return text;
}

function findInputAndSendButton(panel) {
  const root = panel.shadowRoot || panel;
  const inputEl = root.querySelector('textarea, input[type="text"], [contenteditable="true"], #input');
  
  let sendBtn = root.querySelector('button[aria-label*="送信" i], button[aria-label*="Send" i], [class*="send" i] button, #send-button button');
  if (!sendBtn) {
    const allBtns = Array.from(root.querySelectorAll('button, yt-icon-button'));
    sendBtn = allBtns.find(b => {
      const label = b.getAttribute('aria-label') || b.innerText || '';
      return /送信|send/i.test(label);
    });
  }

  return { inputEl, sendBtn };
}

/**
 * 自動化状態の管理
 */
let automationState = {
  active: false,
  startTime: 0,
  initialBlockCount: 0,
  initialLastText: '',
  lastSeenLength: 0,
  stableCount: 0
};

/**
 * 自動要約の開始
 */
async function autoStartSummarize(promptText) {
  let panel = findActiveAskPanel();
  if (!panel) {
    const btn = findAskTriggerButton();
    if (!btn) {
      return {
        success: false,
        errorType: 'TRIGGER_NOT_FOUND',
        title: '質問ボタンが見つかりません',
        message: 'この動画では「この動画について質問する」機能が利用できないか、ボタンが表示されていません。'
      };
    }
    btn.click();

    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 200));
      panel = findActiveAskPanel();
      if (panel) break;
    }
  }

  if (!panel) {
    return {
      success: false,
      errorType: 'PANEL_FAILED_TO_OPEN',
      title: 'パネルを開けませんでした',
      message: '質問パネルの展開に失敗しました。手動でパネルを開いてからお試しください。'
    };
  }

  // 送信前の「コピーボタン付きAI回答ブロック」の数と最後の回答本文を記録
  const videoUrl = getCleanVideoUrl();
  const existingBlocks = findAiResponseBlocksByCopyAnchor(panel);
  const lastBlock = existingBlocks.length > 0 ? existingBlocks[existingBlocks.length - 1] : null;
  const lastText = lastBlock ? extractCleanBodyFromAiBlock(lastBlock.container, videoUrl) : '';

  automationState = {
    active: true,
    startTime: Date.now(),
    initialBlockCount: existingBlocks.length,
    initialLastText: lastText,
    lastSeenLength: 0,
    stableCount: 0
  };

  await new Promise(r => setTimeout(r, 500));
  const { inputEl, sendBtn } = findInputAndSendButton(panel);

  if (!inputEl) {
    return {
      success: false,
      errorType: 'INPUT_NOT_FOUND',
      title: '質問入力欄が見つかりません',
      message: 'パネル内のテキスト入力欄を検出できませんでした。'
    };
  }

  try {
    inputEl.focus();
    if (inputEl.tagName.toLowerCase() === 'textarea' || inputEl.tagName.toLowerCase() === 'input') {
      inputEl.value = promptText;
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      inputEl.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (inputEl.isContentEditable) {
      inputEl.textContent = promptText;
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    }

    await new Promise(r => setTimeout(r, 300));

    if (sendBtn && !sendBtn.disabled) {
      sendBtn.click();
    } else {
      const enterEvent = new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true
      });
      inputEl.dispatchEvent(enterEvent);
    }

    return { success: true, status: 'PROMPT_SENT' };
  } catch (err) {
    return {
      success: false,
      errorType: 'SEND_FAILED',
      title: 'プロンプト送信に失敗しました',
      message: err.message
    };
  }
}

/**
 * 生成状況のチェック
 * 1. 90秒タイムアウトを最優先で判定
 * 2. 新しい「コピーボタン付きAI回答ブロック」が出現したかを確認
 * 3. スピナーが消え、本文テキストの出力が安定（ストリーミング完了）したかを確認
 */
function checkAutomationStatus() {
  const panel = findActiveAskPanel();
  if (!panel) {
    return { status: 'PANEL_CLOSED' };
  }

  const elapsedSec = Math.floor((Date.now() - automationState.startTime) / 1000);

  // 1. タイムアウト最優先判定（生成中表示が残っていても90秒で確実に終了）
  if (elapsedSec >= 90) {
    return { status: 'TIMEOUT', elapsedSec };
  }

  // 送信直後（3秒以内）は待機
  if (elapsedSec < 3) {
    return { status: 'GENERATING', elapsedSec };
  }

  // 生成中スピナーが表示されている間は待機
  if (checkIsGenerating(panel)) {
    automationState.stableCount = 0;
    return { status: 'GENERATING', elapsedSec };
  }

  // 2. コピーボタンを目印にAI回答ブロックを検索
  const currentBlocks = findAiResponseBlocksByCopyAnchor(panel);
  if (currentBlocks.length === 0) {
    automationState.stableCount = 0;
    return { status: 'GENERATING', elapsedSec };
  }

  const latestBlock = currentBlocks[currentBlocks.length - 1];
  const videoUrl = getCleanVideoUrl();
  const latestBody = extractCleanBodyFromAiBlock(latestBlock.container, videoUrl);

  // 送信前の古い回答のままで、新しい回答がまだ来ていない場合は待機
  const isNewBlockAdded = currentBlocks.length > automationState.initialBlockCount;
  const isContentUpdated = latestBody !== automationState.initialLastText;

  if (!isNewBlockAdded && !isContentUpdated) {
    automationState.stableCount = 0;
    return { status: 'GENERATING', elapsedSec };
  }

  if (!latestBody || latestBody.length < 30) {
    automationState.stableCount = 0;
    return { status: 'GENERATING', elapsedSec };
  }

  // 3. ストリーミング出力が完全に止まったか（文字数が安定したか）を確認
  if (latestBody.length === automationState.lastSeenLength) {
    automationState.stableCount += 1;
  } else {
    automationState.lastSeenLength = latestBody.length;
    automationState.stableCount = 1;
  }

  // コピーボタンが存在し、かつ文字数の増加が止まって安定したら完了！
  if (automationState.stableCount >= 2) {
    return { status: 'COMPLETED', elapsedSec };
  }

  return { status: 'GENERATING', elapsedSec };
}

/**
 * 要約データの抽出（コピーボタンを目印に最新のAI回答本文のみを取得）
 */
function extractSummaryData() {
  const isYouTube = window.location.hostname.includes('youtube.com');
  const isWatchPage = window.location.pathname === '/watch' || window.location.search.includes('v=');

  if (!isYouTube || !isWatchPage) {
    return {
      success: false,
      errorType: 'NOT_WATCH_PAGE',
      title: '動画視聴ページではありません',
      message: 'YouTubeの動画視聴ページ（watchページ）で実行してください。'
    };
  }

  let title = getFirstMatchText(SELECTORS.title);
  if (!title) {
    title = document.title.replace(/\s*-\s*YouTube\s*$/i, '').trim();
  }

  const channel = getFirstMatchText(SELECTORS.channel) || '不明なチャンネル';
  const videoUrl = getCleanVideoUrl();

  const panel = findActiveAskPanel();
  if (!panel) {
    return {
      success: false,
      errorType: 'PANEL_NOT_OPEN',
      title: '質問パネルが開かれていません',
      message: 'YouTubeの「この動画について質問する」ボタンを押して質問パネルを開いてから、再度お試しください。'
    };
  }

  if (checkIsGenerating(panel)) {
    return {
      success: false,
      errorType: 'IS_GENERATING',
      title: '回答の生成中です',
      message: '要約の出力が完了するまでお待ちいただき、完了後に再度保存してください。'
    };
  }

  // コピーボタンを目印にすべてのAI回答ブロックを特定
  const aiBlocks = findAiResponseBlocksByCopyAnchor(panel);
  if (aiBlocks.length === 0) {
    return {
      success: false,
      errorType: 'NO_RESPONSE_FOUND',
      title: 'AI回答が見つかりません',
      message: 'コピー可能なAI回答がパネル内に見つかりませんでした。回答が表示されてから実行してください。'
    };
  }

  // 複数の回答がある場合も、常に「最後のAI回答ブロック」を選択
  const latestAiBlock = aiBlocks[aiBlocks.length - 1];
  const finalMarkdown = extractCleanBodyFromAiBlock(latestAiBlock.container, videoUrl);

  if (!finalMarkdown || finalMarkdown.length < 15) {
    return {
      success: false,
      errorType: 'EMPTY_CONTENT',
      title: '要約本文の取得に失敗しました',
      message: 'AI回答ブロックから本文テキストを抽出できませんでした。'
    };
  }

  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const savedAt = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  const previewText = finalMarkdown.slice(0, 150).replace(/\n+/g, ' ') + (finalMarkdown.length > 150 ? '...' : '');

  return {
    success: true,
    data: {
      title,
      url: videoUrl,
      channel,
      savedAt,
      summaryContent: finalMarkdown,
      previewText
    }
  };
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'AUTO_START') {
    autoStartSummarize(request.prompt).then(sendResponse);
    return true;
  }

  if (request.action === 'CHECK_STATUS') {
    sendResponse(checkAutomationStatus());
    return false;
  }

  if (request.action === 'EXTRACT_SUMMARY') {
    try {
      const result = extractSummaryData();
      sendResponse(result);
    } catch (err) {
      sendResponse({
        success: false,
        errorType: 'UNEXPECTED_ERROR',
        title: '予期せぬエラーが発生しました',
        message: err.message || 'スクリプト実行中にエラーが発生しました。'
      });
    }
    return false;
  }
});
