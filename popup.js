import { sanitizeFileName } from './modules/sanitizer.js';
import { formatFullMarkdown } from './modules/markdown.js';

// デフォルトの詳細要約プロンプト
const DEFAULT_PROMPT = `この動画の内容について、動画を見なくても全体像と詳細が深く理解できるように、詳しく要約してください。
以下の構成で出力してください：

1. 【動画の全体概要とテーマ】
2. 【トピック別の詳細解説】（具体的な主張、解説内容、メリット・デメリットなどを詳しく。該当する時間・タイムスタンプも記載してください）
3. 【重要な注意点や補足情報】
4. 【結論・まとめ】`;

// DOM要素
const autoBtn = document.getElementById('auto-btn');
const manualBtn = document.getElementById('manual-btn');
const loadingEl = document.getElementById('loading');
const loadingStatus = document.getElementById('loading-status');
const loadingTimer = document.getElementById('loading-timer');

const successCard = document.getElementById('success-card');
const errorCard = document.getElementById('error-card');

const resultTitle = document.getElementById('result-title');
const resultChannel = document.getElementById('result-channel');
const resultFilename = document.getElementById('result-filename');
const resultPreview = document.getElementById('result-preview');

const errorTitle = document.getElementById('error-title');
const errorMessage = document.getElementById('error-message');
const errorInstructions = document.getElementById('error-instructions');

const promptInput = document.getElementById('prompt-input');
const savePromptBtn = document.getElementById('save-prompt-btn');
const resetPromptBtn = document.getElementById('reset-prompt-btn');
const promptSavedMsg = document.getElementById('prompt-saved-msg');

let currentPrompt = DEFAULT_PROMPT;

// プロンプト設定の読み込み
chrome.storage.local.get(['customPrompt'], (res) => {
  if (res.customPrompt) {
    currentPrompt = res.customPrompt;
  }
  promptInput.value = currentPrompt;
});

// プロンプト保存
savePromptBtn.addEventListener('click', () => {
  const val = promptInput.value.trim();
  if (val) {
    currentPrompt = val;
    chrome.storage.local.set({ customPrompt: val }, () => {
      promptSavedMsg.classList.remove('hidden');
      setTimeout(() => promptSavedMsg.classList.add('hidden'), 2000);
    });
  }
});

// プロンプト初期化
resetPromptBtn.addEventListener('click', () => {
  currentPrompt = DEFAULT_PROMPT;
  promptInput.value = DEFAULT_PROMPT;
  chrome.storage.local.remove(['customPrompt'], () => {
    promptSavedMsg.textContent = '初期設定に戻しました';
    promptSavedMsg.classList.remove('hidden');
    setTimeout(() => {
      promptSavedMsg.textContent = '✓ 保存しました';
      promptSavedMsg.classList.add('hidden');
    }, 2000);
  });
});

// 状態リセット
function resetUI() {
  loadingEl.classList.add('hidden');
  successCard.classList.add('hidden');
  errorCard.classList.add('hidden');
  autoBtn.disabled = false;
  manualBtn.disabled = false;
}

// 進行状況表示
function showLoading(statusText, timerText = '') {
  loadingStatus.textContent = statusText;
  loadingTimer.textContent = timerText;
  loadingEl.classList.remove('hidden');
  successCard.classList.add('hidden');
  errorCard.classList.add('hidden');
  autoBtn.disabled = true;
  manualBtn.disabled = true;
}

// 成功表示
function showSuccess(data, filename) {
  resetUI();
  resultTitle.textContent = data.title;
  resultChannel.textContent = data.channel;
  resultFilename.textContent = filename;
  resultPreview.textContent = data.previewText;
  successCard.classList.remove('hidden');
}

// エラー表示
function showError(error) {
  resetUI();
  errorTitle.textContent = error.title || '処理を完了できませんでした';
  errorMessage.textContent = error.message || '予期せぬエラーが発生しました。';

  errorInstructions.innerHTML = '';
  const instructions = getGuidanceForError(error.errorType);
  instructions.forEach(text => {
    const li = document.createElement('li');
    li.textContent = text;
    errorInstructions.appendChild(li);
  });

  errorCard.classList.remove('hidden');
}

function getGuidanceForError(errorType) {
  switch (errorType) {
    case 'NOT_WATCH_PAGE':
      return ['YouTubeの動画再生ページ（watch?v= を含むURL）で実行してください。'];
    case 'TRIGGER_NOT_FOUND':
      return [
        'この動画では「この動画について質問する」機能が提供されていない可能性があります。',
        '動画再生プレイヤーの下にあるボタン一覧をご確認ください。'
      ];
    case 'PANEL_FAILED_TO_OPEN':
    case 'PANEL_NOT_OPEN':
      return ['手動で「この動画について質問する」ボタンを押してパネルを開いてからお試しください。'];
    case 'INPUT_NOT_FOUND':
      return ['質問パネル内にテキスト入力欄が見つかりませんでした。一度パネルを開き直してください。'];
    case 'NO_RESPONSE_FOUND':
      return [
        '質問パネル内にコピー可能なAIの回答がまだ表示されていません。',
        '「ワンクリックで詳細要約＆保存」を押すか、回答の出力が完了してから実行してください。'
      ];
    case 'IS_GENERATING':
      return [
        '現在AIの回答を生成中です。',
        '回答の出力が完了し、下部にコピーボタンが表示されてから再度押してください。'
      ];
    case 'TIMEOUT':
      return [
        '回答の生成に通常より時間がかかっています。',
        '生成が完了したら「表示中の要約をそのまま保存」ボタンを押してください。'
      ];
    default:
      return [
        '動画ページを一度リロード（F5）してから再度お試しください。',
        '質問パネルが開いていることをご確認ください。'
      ];
  }
}

function downloadMarkdownFile(filename, markdownContent) {
  const bom = new Uint8Array([0xEF, 0xBB, 0xBF]);
  const blob = new Blob([bom, markdownContent], { type: 'text/markdown;charset=utf-8' });

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function sendMessageToContentScript(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (err) {
    console.warn('Content script not ready, injecting dynamically...', err);
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js']
    });
    await new Promise(resolve => setTimeout(resolve, 200));
    return await chrome.tabs.sendMessage(tabId, message);
  }
}

/**
 * 共通の抽出＆ダウンロード処理
 */
async function processExtractionAndDownload(tabId) {
  const response = await sendMessageToContentScript(tabId, {
    action: 'EXTRACT_SUMMARY',
    prompt: currentPrompt
  });

  if (!response || !response.success) {
    showError(response || {
      errorType: 'EXTRACT_FAILED',
      title: '要約の取得に失敗しました',
      message: 'ページから情報を読み取れませんでした。'
    });
    return;
  }

  const { data } = response;
  const fullMarkdown = formatFullMarkdown({
    title: data.title,
    url: data.url,
    channel: data.channel,
    savedAt: data.savedAt,
    summaryContent: data.summaryContent
  });

  const sanitizedTitle = sanitizeFileName(data.title);
  const filename = `${sanitizedTitle}.md`;

  downloadMarkdownFile(filename, fullMarkdown);
  showSuccess(data, filename);
}

// 1. ワンクリック詳細要約＆保存（全自動）
autoBtn.addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id || !tab.url.includes('youtube.com/watch')) {
      showError({
        errorType: 'NOT_WATCH_PAGE',
        title: '動画視聴ページではありません',
        message: 'YouTubeの動画視聴ページで実行してください。'
      });
      return;
    }

    showLoading('質問パネルを開き、詳細指示を送信しています...');

    // 自動送信リクエスト
    const startRes = await sendMessageToContentScript(tab.id, {
      action: 'AUTO_START',
      prompt: currentPrompt
    });

    if (!startRes || !startRes.success) {
      showError(startRes || {
        errorType: 'AUTO_START_FAILED',
        title: '自動送信を開始できませんでした',
        message: 'パネルの起動またはプロンプト送信に失敗しました。'
      });
      return;
    }

    // 回答生成の完了をポーリング待機
    const startTime = Date.now();
    let completed = false;

    while (!completed) {
      await new Promise(r => setTimeout(r, 1500));
      const statusRes = await sendMessageToContentScript(tab.id, { action: 'CHECK_STATUS' });

      const elapsed = Math.floor((Date.now() - startTime) / 1000);

      if (statusRes.status === 'COMPLETED') {
        completed = true;
        break;
      } else if (statusRes.status === 'TIMEOUT') {
        showError({
          errorType: 'TIMEOUT',
          title: '生成待機がタイムアウトしました',
          message: '回答の生成に時間がかかっています。出力が終わったら「表示中の要約をそのまま保存」を押してください。'
        });
        return;
      } else if (statusRes.status === 'PANEL_CLOSED') {
        showError({
          errorType: 'PANEL_CLOSED',
          title: 'パネルが閉じられました',
          message: '処理中に質問パネルが閉じられました。'
        });
        return;
      }

      // 生成中の進捗表示
      showLoading('Geminiが詳細な要約を生成中...', `経過: ${elapsed}秒`);
    }

    // 生成完了 -> 抽出と保存
    showLoading('要約を抽出して保存中...');
    await processExtractionAndDownload(tab.id);

  } catch (err) {
    showError({
      errorType: 'UNEXPECTED_ERROR',
      title: 'エラーが発生しました',
      message: err.message
    });
  }
});

// 2. 表示中の要約をそのまま保存（手動・即時）
manualBtn.addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id || !tab.url.includes('youtube.com/watch')) {
      showError({
        errorType: 'NOT_WATCH_PAGE',
        title: '動画視聴ページではありません',
        message: 'YouTubeの動画視聴ページで実行してください。'
      });
      return;
    }

    showLoading('表示中の要約を取得しています...');
    await processExtractionAndDownload(tab.id);
  } catch (err) {
    showError({
      errorType: 'UNEXPECTED_ERROR',
      title: 'エラーが発生しました',
      message: err.message
    });
  }
});
