#!/usr/bin/env node

/**
 * JWT生成の手動テストスクリプト
 * 
 * 使用方法:
 * node --env-file=.env dist/manual-jwt-test.js
 */

import { generateVonageJWT } from './jwtUtils.js';

async function testJWTGeneration() {
  console.log('=== JWT生成テスト ===\n');
  
  // テスト1: デフォルト設定
  console.log('テスト1: デフォルト設定（24時間有効）');
  const result1 = await generateVonageJWT();
  if (result1.success) {
    console.log('✓ 成功');
    console.log(`  トークン: ${result1.token?.substring(0, 50)}...`);
    console.log(`  有効期限: ${result1.expiresAt}`);
  } else {
    console.log('✗ 失敗');
    console.log(`  エラー: ${result1.error}`);
  }
  console.log('');
  
  // テスト2: カスタム有効期限（1時間）
  console.log('テスト2: カスタム有効期限（1時間）');
  const result2 = await generateVonageJWT({ expiresIn: 3600 });
  if (result2.success) {
    console.log('✓ 成功');
    console.log(`  トークン: ${result2.token?.substring(0, 50)}...`);
    console.log(`  有効期限: ${result2.expiresAt}`);
  } else {
    console.log('✗ 失敗');
    console.log(`  エラー: ${result2.error}`);
  }
  console.log('');
  
  // テスト3: カスタムサブジェクト
  console.log('テスト3: カスタムサブジェクト');
  const result3 = await generateVonageJWT({ subject: 'TestUser' });
  if (result3.success) {
    console.log('✓ 成功');
    console.log(`  トークン: ${result3.token?.substring(0, 50)}...`);
    console.log(`  有効期限: ${result3.expiresAt}`);
    console.log(`  サブジェクト: TestUser`);
  } else {
    console.log('✗ 失敗');
    console.log(`  エラー: ${result3.error}`);
  }
  console.log('');
  
  console.log('=== テスト完了 ===');
}

testJWTGeneration().catch(console.error);
