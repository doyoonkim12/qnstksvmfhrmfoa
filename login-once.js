'use strict';

/**
 * ✅ Telegram 세션 생성기 (최초 1회 실행용)
 * -------------------------------------------------
 * 📌 목적: Telegram 세션 문자열(SESSION)을 생성하여 Render 등의 환경변수에 등록
 * 📌 필요 환경변수: API_ID, API_HASH, (선택) PHONE_NUMBER
 * 📌 실행 명령: node login-once.js
 * 📌 출력: SESSION=... 문자열 (Render 환경변수에 복사)
 */

const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const input = require('input');

const API_ID = Number(process.env.API_ID || 0);
const API_HASH = process.env.API_HASH || '';
const PHONE_NUMBER = process.env.PHONE_NUMBER || '';

(async () => {
  console.log('========================================');
  console.log('🟢 Telegram Session Generator 시작');
  console.log('========================================');

  if (!API_ID || !API_HASH) {
    console.error('\n❌ 오류: 환경변수(API_ID, API_HASH)가 필요합니다.');
    console.error('예시 (PowerShell):');
    console.error('$env:API_ID="123456"');
    console.error('$env:API_HASH="abcdef1234567890abcdef1234567890"');
    console.error('\n다 설정 후 다시 실행하세요:');
    console.error('node login-once.js');
    process.exit(1);
  }

  const client = new TelegramClient(new StringSession(''), API_ID, API_HASH, { connectionRetries: 5 });

  try {
    await client.start({
      phoneNumber: async () => PHONE_NUMBER || await input.text('📱 전화번호 (+82...): '),
      phoneCode: async () => await input.text('🔢 인증코드: '),
      password: async () => await input.text('🔒 2단계 비밀번호 (있다면): '),
      onError: (err) => console.error('⚠️ 로그인 중 오류 발생:', err.message),
    });

    const session = client.session.save();

    console.log('\n✅ Telegram 로그인 성공!');
    console.log('----------------------------------------');
    console.log('SESSION=' + session);
    console.log('----------------------------------------');
    console.log('📋 Render 환경변수 탭에 아래처럼 추가하세요:');
    console.log('  - KEY: SESSION');
    console.log('  - VALUE: 위 SESSION 문자열 전체');
    console.log('\n📌 PHONE_NUMBER 환경변수는 더 이상 필요 없습니다.');
    console.log('========================================\n');
  } catch (err) {
    console.error('\n❌ 세션 생성 실패:', err.message);
    process.exit(1);
  } finally {
    await client.disconnect().catch(() => {});
    process.exit(0);
  }
})();
