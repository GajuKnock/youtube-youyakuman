/**
 * YouTube Summary Saver - Content Script (v1.2 Stable)
 * 確実なテキスト抽出・ストリーミング完了検知・全文保持を実現します。
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
 * 正規表現のエスケープ
 */
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * テキストからプロンプト全文の塊および初期挨拶のみを安全に除去
 * （AI回答内の見出しや正当な文章は一切削除しない）
 */
function stripSentPromptSafely(text, promptText) {
  if (!text) return '';

  // 1. パネル初期表示の固定システム案内文のみを先頭から除去
  text = text.replace(/^\s*こんにちは。視聴しているコンテンツについて、ご質問にお答えします。\s*/g, '');
  text = text.replace(/^\s*何を質問すればいいかわからない場合、次のいずれかを選択してください。\s*/g, '');

  // 2. 送信されたプロンプト全文が含まれている場合、最後に出現するプロンプト塊の直後（＝最新のAI回答）を取得
  if (promptText && promptText.trim().length > 10) {
    const promptLines = promptText.trim().split('\n').map(l => l.trim()).filter(Boolean);
    if (promptLines.length >= 2) {
      const firstLine = escapeRegExp(promptLines[0]);
      const lastLine = escapeRegExp(promptLines[promptLines.length - 1]);
      // プロンプトの先頭行から末尾行までの最短一致パターン（AI回答内の見出しにはマッチしない）
      const fullPromptPattern = new RegExp(`${firstLine}[\\s\\S]*?${lastLine}`, 'g');
      
      let match;
      let lastEndIndex = -1;
      while ((match = fullPromptPattern.exec(text)) !== null) {
        lastEndIndex = match.index + match[0].length;
      }

      if (lastEndIndex !== -1) {
        // 最後のプロンプトの直後から末尾まで（＝最新のAI回答全文）を切り出す
        text = text.slice(lastEndIndex).trim();
      }
    } else if (promptLines.length === 1) {
      const singlePrompt = promptLines[0];
      const lastIdx = text.lastIndexOf(singlePrompt);
      if (lastIdx !== -1) {
        text = text.slice(lastIdx + singlePrompt.length).trim();
      }
    }
  }

  // 3. デフォルトの「動画を要約して」ボタンで生成した場合の先頭プロンプト除去
  text = text.replace(/^\s*動画を要約して\s*\n+/, '');

  return text.trim();
}

/**
 * 抽出したテキストを整形（回答内の疑問文や見出しは保持）
 */
function cleanExtractedText(rawText, videoUrl, promptText) {
  if (!rawText) return '';

  let lines = rawText.split('\n').map(l => l.trim());

  // パネル枠のUIラベルのみを完全一致で除外（回答本文の疑問文「?」等は絶対に削除しない）
  const uiLabels = [
    /^この動画について質問する$/i,
    /^質問を入力$/i,
    /^Gemini\s*に質問する$/i,
    /^AI\s*は不正確な情報を表示することがあるため[^\n]*$/i,
    /^詳細$/i
  ];

  lines = lines.filter(line => {
    if (!line) return false;
    for (const pat of uiLabels) {
      if (pat.test(line)) return false;
    }
    return true;
  });

  let text = lines.join('\n\n');

  // プロンプト塊の安全な除去（最新回答の抽出）
  text = stripSentPromptSafely(text, promptText);

  // 箇条書き記号の正規化
  text = text.replace(/^[ \t]*[•▪■・][ \t]*/gm, '- ');

  // タイムスタンプリンク化
  text = linkifyTimestamps(text, videoUrl);

  // 連続改行の整理
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  return text;
}

/**
 * パネルから不要なUI要素（ボタン・提案チップ・入力欄）を除いたテキストを取得
 */
function extractPanelSummaryText(panel, videoUrl, promptText) {
  if (!panel) return '';

  const clone = panel.cloneNode(true);

  // ボタン、提案チップ、入力欄、ヘッダー、免責事項をDOMレベルで削除
  const removeSelectors = [
    'button',
    'yt-icon',
    'svg',
    'tp-yt-paper-tooltip',
    'yt-chip-cloud-renderer',
    'yt-chip-cloud-chip-renderer',
    'ytd-comment-simplebox-renderer',
    'textarea',
    'input',
    '#header',
    '.ytd-engagement-panel-title-header-renderer',
    '[class*="chip" i]',
    '[class*="suggestion" i]',
    '[class*="input" i]',
    '[class*="disclaimer" i]',
    '[class*="feedback" i]',
    '[class*="action-bar" i]',
    '[role="button"]'
  ];

  for (const sel of removeSelectors) {
    try {
      const elements = clone.querySelectorAll(sel);
      elements.forEach(el => el.remove());
    } catch {}
  }

  // cloneのinnerTextまたはパネルの可視テキストを取得
  let rawText = clone.innerText || clone.textContent || '';
  if (!rawText || rawText.trim().length < 20) {
    rawText = panel.innerText || panel.textContent || '';
  }

  return cleanExtractedText(rawText, videoUrl, promptText);
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
  lastPrompt: '',
  baselineText: '',
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

  // 送信前のパネル内テキストを記録（古い回答と新しい回答を確実に区別するため）
  const videoUrl = getCleanVideoUrl();
  const baseline = extractPanelSummaryText(panel, videoUrl, promptText);

  automationState = {
    active: true,
    startTime: Date.now(),
    lastPrompt: promptText,
    baselineText: baseline,
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
 * 生成状況のチェック（タイムアウト最優先＆ストリーミング安定完了検知）
 */
function checkAutomationStatus() {
  const panel = findActiveAskPanel();
  if (!panel) {
    return { status: 'PANEL_CLOSED' };
  }

  const elapsedSec = Math.floor((Date.now() - automationState.startTime) / 1000);

  // 1. タイムアウトを最優先で判定（90秒経過で確実に待機終了）
  if (elapsedSec >= 90) {
    return { status: 'TIMEOUT', elapsedSec };
  }

  // 送信直後（最初の4秒間）は生成開始待ち
  if (elapsedSec < 4) {
    return { status: 'GENERATING', elapsedSec };
  }

  // スピナー表示中なら生成中
  if (checkIsGenerating(panel)) {
    automationState.stableCount = 0;
    return { status: 'GENERATING', elapsedSec };
  }

  // 現在の最新回答テキストを取得
  const videoUrl = getCleanVideoUrl();
  const currentSummary = extractPanelSummaryText(panel, videoUrl, automationState.lastPrompt);

  // 2. 送信前の古い回答と同一、またはまだ50文字未満の場合は生成中として待機
  if (!currentSummary || currentSummary.length < 50 || currentSummary === automationState.baselineText) {
    automationState.stableCount = 0;
    return { status: 'GENERATING', elapsedSec };
  }

  // 3. ストリーミング出力が完全に止まったか（文字数が安定したか）を確認
  if (currentSummary.length === automationState.lastSeenLength) {
    automationState.stableCount += 1;
  } else {
    automationState.lastSeenLength = currentSummary.length;
    automationState.stableCount = 1;
  }

  // 2回連続（約3秒間）文字数が変化せず安定していれば、生成完了と判定！
  if (automationState.stableCount >= 2) {
    return { status: 'COMPLETED', elapsedSec };
  }

  return { status: 'GENERATING', elapsedSec };
}

/**
 * 要約データの抽出
 */
function extractSummaryData(promptText) {
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

  const activePrompt = promptText || automationState.lastPrompt;
  const finalMarkdown = extractPanelSummaryText(panel, videoUrl, activePrompt);

  if (!finalMarkdown || finalMarkdown.length < 20) {
    return {
      success: false,
      errorType: 'EMPTY_CONTENT',
      title: '要約本文の取得に失敗しました',
      message: '質問パネル内に要約テキストが検出されませんでした。画面に回答が表示されているかご確認ください。'
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
      const result = extractSummaryData(request.prompt);
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
