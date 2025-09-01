import { parse } from 'csv-parse/sync';
import { validatePhoneNumber } from './vonage.js';

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

// 送信者名のバリデーション（3〜11文字、英数字のみ、数字のみや数字始まりはNG）
export function validateFrom(from: string): boolean {
  if (!from || from.length < 3 || from.length > 11) {
    return false;
  }
  
  // 英数字以外の文字が含まれている場合はNG（日本語等は使用不可）
  if (!/^[A-Za-z0-9]+$/.test(from)) {
    return false;
  }
  
  // 数字のみの場合はNG
  if (/^\d+$/.test(from)) {
    return false;
  }
  
  // 数字で始まる場合はNG
  if (/^\d/.test(from)) {
    return false;
  }
  
  return true;
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
  } else if (!validateFrom(data.from)) {
    errors.push(`無効な送信者名です: ${data.from}（3〜11文字、英数字のみ、数字のみや数字始まりは不可）`);
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