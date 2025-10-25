'use strict';

/**
 * ✅ Telegram 세션 생성기 (최초 1회 실행용)
 * -------------------------------------------------
 * - 실행 목적: Telegram 세션 문자열(SESSION)을 생성하여 Render 등 서버 환경변수에 등록
 * - 필요 환경변수: API_ID, API_HASH, (선택) PHONE_NUMBER
 * - 실행 명령: node login-once.js
 * - 출력: SESSION=... 문자열
 */

const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const input = require('input');

const API_ID = Number(process.env.API_ID || 0);
const API_HASH = process.env.API_HASH || '';
const PHONE_NUMBER = process.env.PHONE_NUMBER || '';

(async () => {
  console.log('----------------------------------------');
  console.log('🟢 Telegram Session Generator');
  console.log('----------------------------------------');

  if (!API_ID || !API_HASH) {
    console.error('\n❌ 오류: 환경변수(API_ID, API_HASH)가 필요합니다.');
    console.error('예시:');
    console.error('$env:API_ID="123456"');
    console.error('$env:API_HASH="abcdef1234567890abcdef1234567890"');
    process.exit(1);
  }

  const client = new TelegramClient(new StringSession(''), API_ID, API_HASH, { connectionRetries: 5 });

  try {
    await client.start({
      phoneNumber: async () => PHONE_NUMBER || await input.text('📱 전화번호 입력 (+82...): '),
      phoneCode: async () => await input.text('🔢 인증코드: '),
      password: async () => await input.text('🔒 2단계 비밀번호(있다면): '),
      onError: (err) => console.error('⚠️ 로그인 중 오류:', err.message),
    });

    const session = client.session.save();

    console.log('\n✅ 로그인 성공!');
    console.log('----------------------------------------');
    console.log('SESSION=' + session);
    console.log('----------------------------------------');
    console.log('이 값을 Render 환경변수 SESSION에 복사해 넣으세요.');
    console.log('PHONE_NUMBER 환경변수는 더 이상 필요 없습니다.');
    console.log('----------------------------------------');

  } catch (err) {
    console.error('\n❌ 세션 생성 실패:', err.message);
    process.exit(1);
  } finally {
    await client.disconnect();
    process.exit(0);
  }
})();
