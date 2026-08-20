import { parse } from 'csv-parse/sync';
import { validatePhoneNumber } from './vonage.js';
import { normalizeToE164, validateSenderId } from './guardrails.js';

// CSVの行データのインターフェース
export interface CSVRow {
  phone: string;
  from: string;
  message: string;
}

// CSV解析結果のインターフェース
export interface CSVParseResult {
  validRows: CSVRow[];
  invalidRows: { row: number; data: any; errors: string[] }[];
  totalRows: number;
}

/**
 * 送信者名のバリデーション。判定は guardrails.validateSenderId に委譲する。
 *
 * 以前はここに独自ルール（3〜11文字・数字始まり不可）を持っていたが、
 * 単発の send_sms とルールがずれていた。`2FA` は CSV だけ弾かれ、日本で禁止
 * されている `INFO` は CSV だけ通る、という食い違いが起きる。
 */
export function validateFrom(from: string, destinationE164?: string): boolean {
  return validateSenderId(from, destinationE164).valid;
}

// メッセージ長の検証（70文字以内を推奨）
export function validateMessage(message: string): { valid: boolean; warning?: string } {
  if (!message || message.trim().length === 0) {
    return { valid: false };
  }
  
  if (message.length > 70) {
    return { 
      valid: true, 
      warning: `メッセージが70文字を超えています（${message.length}文字）。送信料金が高くなる可能性があります。`
    };
  }
  
  return { valid: true };
}

// CSVの行データをバリデーション
function validateCSVRow(data: any): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  // 必須フィールドのチェック
  if (!data.phone) {
    errors.push('電話番号が入力されていません');
  } else if (!validatePhoneNumber(data.phone)) {
    errors.push(`無効な電話番号形式です: ${data.phone}`);
  }
  
  if (!data.from) {
    errors.push('送信者名が入力されていません');
  } else {
    // 宛先の国で可否が変わるため、行の電話番号から判定する。
    // 電話番号が不正な行は宛先不明として扱われ、厳しい側（日本宛）で判定される。
    const destination = data.phone ? normalizeToE164(String(data.phone)) : undefined;
    const sender = validateSenderId(String(data.from), destination);
    if (!sender.valid) {
      errors.push(sender.reason!);
    }
  }
  
  if (!data.message) {
    errors.push('メッセージが入力されていません');
  } else {
    const messageValidation = validateMessage(data.message);
    if (!messageValidation.valid) {
      errors.push('メッセージが空です');
    }
    // 警告は表示するがエラーとはしない
  }
  
  return {
    valid: errors.length === 0,
    errors
  };
}

// CSVコンテンツを解析してバリデーション
export function parseAndValidateCSV(csvContent: string): CSVParseResult {
  try {
    // CSVをパース（ヘッダー行ありとして処理）
    const records = parse(csvContent, {
      columns: true, // 最初の行をヘッダーとして使用
      skip_empty_lines: true,
      trim: true
    });
    
    const validRows: CSVRow[] = [];
    const invalidRows: { row: number; data: any; errors: string[] }[] = [];
    
    records.forEach((record: any, index: number) => {
      const validation = validateCSVRow(record);
      
      if (validation.valid) {
        validRows.push({
          phone: record.phone,
          from: record.from,
          message: record.message
        });
      } else {
        invalidRows.push({
          row: index + 1,
          data: record,
          errors: validation.errors
        });
      }
    });
    
    return {
      validRows,
      invalidRows,
      totalRows: records.length
    };
    
  } catch (error) {
    throw new Error(`CSV解析エラー: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// CSV解析結果のサマリーを生成
export function generateCSVSummary(result: CSVParseResult): string {
  const { validRows, invalidRows, totalRows } = result;
  
  let summary = `CSV解析結果:\n`;
  summary += `- 総行数: ${totalRows}行\n`;
  summary += `- 有効な行: ${validRows.length}行\n`;
  summary += `- 無効な行: ${invalidRows.length}行\n`;
  
  if (invalidRows.length > 0) {
    summary += `\n無効な行の詳細:\n`;
    invalidRows.forEach(invalid => {
      summary += `- ${invalid.row}行目: ${invalid.errors.join(', ')}\n`;
    });
  }
  
  return summary;
}