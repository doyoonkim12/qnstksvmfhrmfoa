'use strict';

// 최초 1회 로컬/코드스페이스에서 실행하여 SESSION 문자열을 생성합니다.
// - 환경변수: API_ID, API_HASH, PHONE_NUMBER
// 실행: node login-once.js  → 콘솔에 SESSION=... 출력

const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const input = require('input');

const API_ID = Number(process.env.API_ID || 0);
const API_HASH = process.env.API_HASH || '';
const PHONE_NUMBER = process.env.PHONE_NUMBER || '';

(async () => {
	if (!API_ID || !API_HASH) {
		console.error('환경변수(API_ID, API_HASH)가 필요합니다.');
		process.exit(1);
	}

	const client = new TelegramClient(new StringSession(''), API_ID, API_HASH, { connectionRetries: 5 });

	await client.start({
		phoneNumber: async () => PHONE_NUMBER || await input.text('전화번호(+82...): '),
		phoneCode: async () => await input.text('인증코드: '),
		password: async () => await input.text('2단계 비밀번호(있다면): '),
		onError: (e) => console.error('login error:', e),
	});

	const session = client.session.save();
	console.log('SESSION=' + session);
	console.log('이 값을 Render 환경변수 SESSION에 저장하세요. PHONE_NUMBER는 더 이상 필요 없습니다.');
	process.exit(0);
})();
