/**
 * YouTube Summary Saver - Content Script (Reviewed & Hardened)
 * 厳密なDOM要素識別により、最後のAI回答のみを完全かつ安全に抽出します。
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
  panel: [
    'ytd-engagement-panel-section-list-renderer[target-id="PAyouchat"]',
    'ytd-engagement-panel-section-list-renderer[target-id*="youchat" i]',
    'ytd-engagement-panel-section-list-renderer[target-id*="ask" i]',
    'ytd-engagement-panel-section-list-renderer[visibility="EXPANDED"]'
  ],
  generating: [
    'tp-yt-paper-spinner[active]',
    'yt-activity-indicator',
    '[class*="loading" i]',
    '[class*="thinking" i]',
    '[class*="pending" i]',
    '[class*="streaming" i]'
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
 * 不要なUI要素を除外してクリーンアップ（正当な疑問文や文章は保持）
 */
function cleanExtractedText(rawText, videoUrl) {
  if (!rawText) return '';

  let lines = rawText.split('\n').map(l => l.trim());

  // 固定のヘッダーや操作文言のみを除外（正当な疑問文「?」や「教えてください」等は削除しない）
  const ignoreExactHeaders = [
    /^この動画について質問する$/i,
    /^質問を入力$/i,
    /^Gemini\s*に質問する$/i,
    /^AI\s*は不正確な情報を表示することがあるため/i,
    /^詳細$/i
  ];

  lines = lines.filter(line => {
    if (!line) return false;
    for (const pat of ignoreExactHeaders) {
      if (pat.test(line)) return false;
    }
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

/**
 * パネル内からすべての「AI回答要素」を要素単位で特定して取得
 * @param {Element} panel
 * @returns {Element[]} AI回答要素のリスト（古い順）
 */
function getAllAiResponseElements(panel) {
  if (!panel) return [];
  const root = panel.shadowRoot || panel;

  // 1. 明示的なタグ・セレクタによる探索
  const candidateSelectors = [
    'ytd-conversational-ai-response-renderer',
    'you-chat-item-view-model:not([class*="user" i]):not([is-user])',
    'yt-convo-item-view-model:not([class*="user" i])',
    'ytd-chat-item-renderer:not([class*="user" i])'
  ];

  for (const sel of candidateSelectors) {
    try {
      const found = Array.from(root.querySelectorAll(sel));
      if (found.length > 0) {
        return found;
      }
    } catch {}
  }

  // 2. Sparkle（✨）アイコンからAI回答ブロックを特定
  const allIcons = Array.from(root.querySelectorAll('yt-icon, svg, [icon*="sparkle" i], [class*="sparkle" i]'));
  const sparkleIcons = allIcons.filter(icon => {
    const iconAttr = (icon.getAttribute('icon') || '').toLowerCase();
    const classAttr = (icon.getAttribute('class') || '').toLowerCase();
    const html = (icon.innerHTML || '').toLowerCase();
    return iconAttr.includes('sparkle') ||
           iconAttr.includes('gemini') ||
           iconAttr.includes('auto-awesome') ||
           classAttr.includes('sparkle') ||
           html.includes('sparkle') ||
           html.includes('m19 9l1.25'); // Sparkle SVG path
  });

  if (sparkleIcons.length > 0) {
    const aiBlocks = [];
    for (const icon of sparkleIcons) {
      // 祖先を遡り、独立した回答コンテナを見つける
      let current = icon.parentElement;
      let bestBlock = null;

      while (current && current !== panel && current !== root && current.tagName.toLowerCase() !== 'body') {
        const tag = current.tagName.toLowerCase();
        // ヘッダーや入力欄、提案チップはスキップ
        if (current.id === 'header' || tag.includes('chip') || current.querySelector('textarea, input')) {
          break;
        }

        // 回答コンテナの候補
        if (current.clientHeight > 40) {
          bestBlock = current;
          // 特定のクラスやタグがあれば確定
          if (current.classList.contains('response') || tag.includes('item') || tag.includes('turn')) {
            break;
          }
        }
        current = current.parentElement;
      }

      if (bestBlock && !aiBlocks.includes(bestBlock)) {
        aiBlocks.push(bestBlock);
      }
    }

    if (aiBlocks.length > 0) {
      return aiBlocks;
    }
  }

  // 3. チャットスレッドの要素一覧からユーザーメッセージを除外して探索
  const threadContainer = root.querySelector('#contents, #items, [class*="chat-history" i], [class*="messages" i]');
  if (threadContainer && threadContainer.children.length > 0) {
    const turns = Array.from(threadContainer.children).filter(child => {
      // ヘッダー・チップ・入力欄を除外
      const tag = child.tagName.toLowerCase();
      if (tag.includes('chip') || child.querySelector('textarea, input, [class*="chip" i]')) return false;
      if (child.id === 'header') return false;
      // ユーザー発言要素を除外
      const isUser = child.matches('[class*="user" i], [class*="query" i]') ||
                     child.querySelector('[class*="user" i], [class*="query" i]') !== null;
      if (isUser) return false;

      return (child.textContent || '').trim().length > 30;
    });

    if (turns.length > 0) {
      return turns;
    }
  }

  return [];
}

/**
 * 単一のAI回答要素から純粋な要約本文を抽出する
 * @param {Element} aiElement
 * @param {string} videoUrl
 * @returns {string}
 */
function extractSummaryFromAiElement(aiElement, videoUrl) {
  if (!aiElement) return '';

  // クローンを作成して、要素内部のボタンやフィードバックUIを除去
  const clone = aiElement.cloneNode(true);
  const removeSelectors = [
    'button',
    'yt-icon',
    'svg',
    'tp-yt-paper-tooltip',
    '[class*="feedback" i]',
    '[class*="action-bar" i]',
    '[class*="disclaimer" i]',
    'ytd-menu-renderer'
  ];

  for (const sel of removeSelectors) {
    try {
      const els = clone.querySelectorAll(sel);
      els.forEach(el => el.remove());
    } catch {}
  }

  const rawText = clone.innerText || clone.textContent || '';
  return cleanExtractedText(rawText, videoUrl);
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
  initialAiCount: 0
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

  // 送信前のAI回答数を正確に記録（古い回答を新回答と誤判定しないため）
  const initialElements = getAllAiResponseElements(panel);
  automationState = {
    active: true,
    startTime: Date.now(),
    initialAiCount: initialElements.length
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
 * 生成状況のチェック（タイムアウト最優先判定＆新回答の監視）
 */
function checkAutomationStatus() {
  const panel = findActiveAskPanel();
  if (!panel) {
    return { status: 'PANEL_CLOSED' };
  }

  const elapsedSec = Math.floor((Date.now() - automationState.startTime) / 1000);

  // 【修正点4】タイムアウトを最優先で判定（生成中表示が残っていても90秒で確実に終了）
  if (elapsedSec >= 90) {
    return { status: 'TIMEOUT', elapsedSec };
  }

  // 送信直後（最初の3秒間）は待機
  if (elapsedSec < 3) {
    return { status: 'GENERATING', elapsedSec };
  }

  // 【修正点2】送信前の回答数と比較し、新しい回答がDOMに追加されたか確認
  const currentAiElements = getAllAiResponseElements(panel);
  if (currentAiElements.length <= automationState.initialAiCount) {
    // まだ新しい回答要素が生成されていない
    return { status: 'GENERATING', elapsedSec };
  }

  // 生成中スピナーのチェック
  const isGenerating = checkIsGenerating(panel);
  if (isGenerating) {
    return { status: 'GENERATING', elapsedSec };
  }

  // 最新のAI回答要素を取得し、本文が十分に出力されたか確認
  const latestAiEl = currentAiElements[currentAiElements.length - 1];
  const videoUrl = getCleanVideoUrl();
  const summaryText = extractSummaryFromAiElement(latestAiEl, videoUrl);

  if (summaryText && summaryText.length >= 40) {
    return { status: 'COMPLETED', elapsedSec };
  }

  return { status: 'GENERATING', elapsedSec };
}

/**
 * 要約データの抽出（最後のAI回答のみを厳格に取得）
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

  // 【修正点1・2】AI回答要素一覧を取得し、「最後のAI回答のみ」を厳密に対象とする
  const aiElements = getAllAiResponseElements(panel);
  if (!aiElements || aiElements.length === 0) {
    return {
      success: false,
      errorType: 'AI_RESPONSE_NOT_FOUND',
      title: 'AI回答が見つかりません',
      message: 'パネル内にAIの回答が表示されていません。回答が出力されてから再度実行してください。'
    };
  }

  // 常に「最後のAI回答要素」だけを取得
  const latestAiEl = aiElements[aiElements.length - 1];
  const finalMarkdown = extractSummaryFromAiElement(latestAiEl, videoUrl);

  if (!finalMarkdown || finalMarkdown.length < 20) {
    return {
      success: false,
      errorType: 'EMPTY_CONTENT',
      title: '要約本文の取得に失敗しました',
      message: 'AI回答要素から本文テキストを読み取れませんでした。画面に回答が表示されているかご確認ください。'
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
