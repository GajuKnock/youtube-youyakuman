/**
 * Windowsおよび主要OSで安全なファイル名に変換するユーティリティ
 */

// Windowsで禁止されている文字: \ / : * ? " < > |
const WINDOWS_INVALID_CHARS_REGEX = /[\\/:*?"<>|]/g;

// Windowsの予約名（大文字小文字を問わない）
const WINDOWS_RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;

/**
 * ファイル名をサニタイズする
 * @param {string} rawName - 元のファイル名候補（動画タイトルなど）
 * @param {number} maxLength - 最大文字数（デフォルト: 120文字）
 * @returns {string} サニタイズされたファイル名（拡張子なし）
 */
export function sanitizeFileName(rawName, maxLength = 120) {
  if (!rawName || typeof rawName !== 'string') {
    return 'youtube_summary';
  }

  // 1. 禁止文字を半角アンダースコアに置換
  let cleaned = rawName.replace(WINDOWS_INVALID_CHARS_REGEX, '_');

  // 2. 制御文字（改行、タブなど）を除去
  cleaned = cleaned.replace(/[\x00-\x1f\x80-\x9f]/g, '');

  // 3. 連続する空白やアンダースコアを整理
  cleaned = cleaned.replace(/\s+/g, ' ');
  cleaned = cleaned.replace(/_+/g, '_');

  // 4. 前後の空白およびWindowsで問題となる末尾のドット/スペースを除去
  cleaned = cleaned.trim().replace(/[. ]+$/, '');

  // 5. Windows予約デバイス名の場合はプレフィックスを付与して回避
  if (WINDOWS_RESERVED_NAMES.test(cleaned)) {
    cleaned = `_${cleaned}`;
  }

  // 6. 最大長制限（長すぎるパスによるエラー防止）
  if (cleaned.length > maxLength) {
    cleaned = cleaned.slice(0, maxLength).trim().replace(/[. ]+$/, '');
  }

  return cleaned || 'youtube_summary';
}
