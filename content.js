/**
 * YouTube Summary Saver - Content Script (Enhanced v3)
 * プロンプトや挨拶文を確実に除外し、純粋な要約本文のみを抽出します。
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
 * 挨拶文やユーザー送信プロンプトの完全除去
 */
function stripPromptAndGreetings(text, promptText) {
  if (!text) return '';

  // 1. 挨拶や初期案内文の除去
  text = text.replace(/こんにちは[^\n]*\n*/g, '');
  text = text.replace(/何を質問すればいいかわからない場合[^\n]*\n*/g, '');
  text = text.replace(/次のいずれかを選択してください[^\n]*\n*/g, '');

  // 2. 送信したプロンプトの完全除去
  if (promptText) {
    const lines = promptText.trim().split('\n').map(l => l.trim()).filter(Boolean);
    const lastLine = lines[lines.length - 1]; // "4. 【結論・まとめ】" 等
    const idx = text.indexOf(lastLine);
    if (idx !== -1) {
      text = text.slice(idx + lastLine.length).trim();
    }
  }

  // 3. 一般的なプロンプト断片の除去（フォールバック）
  text = text.replace(/^[\s\S]*?(この動画の内容について[^\n]*|以下の構成で出力してください[^\n]*)/g, '');
  text = text.replace(/^[\s\S]*?[0-9]+[\.、]\s*【[^】]+】\s*(?=[0-9]+[\.、]\s*【)/, '');

  return text.trim();
}

function cleanExtractedText(rawText, videoUrl, promptText) {
  if (!rawText) return '';

  let lines = rawText.split('\n').map(l => l.trim());

  const ignorePatterns = [
    /^この動画について質問する/i,
    /^動画を要約して/i,
    /^質問を入力/i,
    /^Gemini\s*に質問する/i,
    /^AI\s*は不正確な情報を表示することがあるため/i,
    /^詳細$/i,
    /\?|？$/,
    /教えてください$/,
    /おすすめですか$/
  ];

  lines = lines.filter(line => {
    if (!line) return false;
    for (const pat of ignorePatterns) {
      if (pat.test(line)) return false;
    }
    return true;
  });

  let text = lines.join('\n\n');

  // プロンプトと挨拶文の切り落とし
  text = stripPromptAndGreetings(text, promptText);

  // 箇条書き記号の正規化
  text = text.replace(/^[ \t]*[•▪■・][ \t]*/gm, '- ');

  // タイムスタンプリンク化
  text = linkifyTimestamps(text, videoUrl);

  // 連続改行の整理
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  return text;
}

/**
 * AI回答ブロックを優先特定して抽出
 */
function findBestSummaryText(panel, videoUrl, promptText) {
  const root = panel.shadowRoot || panel;

  // 1. Sparkle（✨）アイコンを基準にしたAI回答コンテナの特定
  // AI回答の直前・直上にはキラキラアイコン（Gemini/Sparkle）がある
  const sparkles = Array.from(root.querySelectorAll('yt-icon, svg, [icon*="sparkle" i], [class*="sparkle" i]'));
  for (const sp of sparkles) {
    // 兄弟要素または親要素から回答ブロックを取得
    const parentContainer = sp.closest('[class*="response" i], [class*="turn" i], [class*="model" i], [class*="item" i]') || sp.parentElement;
    if (parentContainer && parentContainer !== panel) {
      const text = parentContainer.innerText || parentContainer.textContent || '';
      if (text.length > 80 && !text.includes('質問を入力')) {
        const cleaned = cleanExtractedText(text, videoUrl, promptText);
        if (cleaned.length > 50) {
          return cleaned;
        }
      }
    }
  }

  // 2. クローンから不要なUIおよびユーザープロンプト要素を削除
  const clone = panel.cloneNode(true);

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
    // ユーザー発言・クエリ要素
    '[class*="user-query" i]',
    '[class*="user-turn" i]',
    '[class*="user-message" i]'
  ];

  for (const sel of removeSelectors) {
    try {
      const elements = clone.querySelectorAll(sel);
      elements.forEach(el => el.remove());
    } catch {}
  }

  const rawText = clone.innerText || clone.textContent || '';
  const cleaned = cleanExtractedText(rawText, videoUrl, promptText);

  if (cleaned && cleaned.length > 50) {
    return cleaned;
  }

  // 3. パネル内の全p/div要素の中から一番文字数が多いブロック
  const allElements = Array.from(panel.querySelectorAll('div, p, yt-formatted-string, yt-core-attributed-string'));
  let maxText = '';
  for (const el of allElements) {
    if (el.closest('yt-chip-cloud-renderer, yt-chip-cloud-chip-renderer, textarea, input, button, #header')) {
      continue;
    }
    const t = el.innerText?.trim() || '';
    if (t.length > maxText.length && !t.includes('質問を入力')) {
      maxText = t;
    }
  }

  return cleanExtractedText(maxText, videoUrl, promptText);
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

let automationState = {
  active: false,
  startTime: 0,
  promptSent: false,
  lastPrompt: ''
};

async function autoStartSummarize(promptText) {
  automationState = {
    active: true,
    startTime: Date.now(),
    promptSent: false,
    lastPrompt: promptText
  };

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

    automationState.promptSent = true;
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

function checkAutomationStatus() {
  const panel = findActiveAskPanel();
  if (!panel) {
    return { status: 'PANEL_CLOSED' };
  }

  const isGenerating = checkIsGenerating(panel);
  const elapsedSec = Math.floor((Date.now() - automationState.startTime) / 1000);

  if (elapsedSec < 3) {
    return { status: 'GENERATING', elapsedSec };
  }

  if (isGenerating) {
    return { status: 'GENERATING', elapsedSec };
  }

  const text = findBestSummaryText(panel, getCleanVideoUrl(), automationState.lastPrompt);
  if (text && text.length > 50) {
    return { status: 'COMPLETED', elapsedSec };
  }

  if (elapsedSec < 90) {
    return { status: 'GENERATING', elapsedSec };
  }

  return { status: 'TIMEOUT', elapsedSec };
}

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

  const finalMarkdown = findBestSummaryText(panel, videoUrl, promptText || automationState.lastPrompt);

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
