#!/usr/bin/env node

/**
 * Call Status取得の手動テストスクリプト
 * 
 * 使用方法:
 * node --env-file=.env dist/manual-call-status-test.js
 */

import { getCallStatus } from './callStatus.js';

async function testCallStatus() {
  console.log('=== Call Status取得テスト ===\n');
  
  // テスト用Call ID（ユーザー提供）
  const testCallId = 'ca6b7710-3423-4c8d-b630-7b981ec4b2c2';
  
  console.log(`テスト: Call ID ${testCallId} のステータス取得`);
  const result = await getCallStatus({ callId: testCallId });
  
  if (result.success) {
    console.log('✓ 成功');
    console.log(`  Call ID: ${testCallId}`);
    console.log(`  ステータス: ${result.status}`);
    console.log(`  料金: ${result.price}`);
    console.log(`  レート: ${result.rate}`);
    console.log(`  通話時間: ${result.duration}秒`);
    console.log('');
    
    // 期待値との比較
    console.log('期待値との比較:');
    console.log(`  Duration: ${result.duration} (期待値: 27秒)`);
    console.log(`  Status: ${result.status} (期待値: answered)`);
    console.log(`  Price: ${result.price} (期待値: €0.0628785)`);
  } else {
    console.log('✗ 失敗');
    console.log(`  エラー: ${result.error}`);
  }
  console.log('');
  
  // 存在しないCall IDのテスト
  console.log('テスト: 存在しないCall IDのエラーハンドリング');
  const invalidResult = await getCallStatus({ callId: 'invalid-call-id-12345' });
  
  if (!invalidResult.success) {
    console.log('✓ 正常にエラーハンドリング');
    console.log(`  エラーメッセージ: ${invalidResult.error}`);
  } else {
    console.log('✗ エラーハンドリングが機能していません');
  }
  console.log('');
  
  console.log('=== テスト完了 ===');
}

testCallStatus().catch(console.error);
