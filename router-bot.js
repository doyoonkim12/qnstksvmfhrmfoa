'use strict';

// 개인계정(Userbot)으로 "자동메세지 시스템" 방의 메시지를 읽어
// 키워드에 따라 지정한 방들로 자동 전달합니다.
// - Start Command: node userbot-router.js
// - 환경변수: API_ID, API_HASH, SESSION (my.telegram.org 발급 + login-once.js로 생성)

const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');

// 필수 환경변수
const API_ID = Number(process.env.API_ID || 0);
const API_HASH = process.env.API_HASH || '';
const SESSION = process.env.SESSION || '';

// 소스(읽어올) 방
const SOURCE_CHAT_ID = '-1002552721308'; // 자동메세지 시스템

// 타겟 방들
const TARGETS = {
	DOKSAN: '-4786506925',        // 독산동 계약서 관리비 확인방
	JONGNO1: '-4787323606',       // 종로1차
	JONGNO2: '-4698985829',       // 종로2차
	JONGNO3: '-4651498378',       // 종로3차
	DOGOK: '-1002723031579',      // 도곡동입금관리비방
	JONGNO_DEPOSIT: '-4940765825' // 종로 입금확인방
};

// 라우팅 규칙
const RULES = [
	{ target: TARGETS.JONGNO_DEPOSIT, keywords: ['KB', '국민', '국민은행'] },
	{ target: TARGETS.JONGNO_DEPOSIT, keywords: ['카카오뱅크', '카뱅', 'kakaobank'] },
	{ target: TARGETS.DOGOK, keywords: ['도곡', '도곡동'] },
	{ target: TARGETS.DOKSAN, keywords: ['독산', '독산동'] },
	{ target: TARGETS.JONGNO1, keywords: ['종로1', '종로 1', '종로1차'] },
	{ target: TARGETS.JONGNO2, keywords: ['종로2', '종로 2', '종로2차'] },
	{ target: TARGETS.JONGNO3, keywords: ['종로3', '종로 3', '종로3차'] },
];

// 전달 모드: 'copy' 또는 'forward' (기본 copy)
const SEND_MODE = (process.env.SEND_MODE || 'copy').toLowerCase();

// 간단 유틸
function normalize(text) {
	return (text || '').toString().trim().toLowerCase();
}
function matchTargets(text) {
	const norm = normalize(text);
	const out = new Set();
	for (const r of RULES) {
		if (!r.target) continue;
		if (r.keywords.some(k => norm.includes(normalize(k)))) out.add(r.target);
	}
	return [...out];
}

const client = new TelegramClient(new StringSession(SESSION), API_ID, API_HASH, {
	connectionRetries: 5,
});

// 루프/중복 방지
const forwardedMessageIds = new Set();

(async () => {
	if (!API_ID || !API_HASH || !SESSION) {
		console.error('환경변수(API_ID, API_HASH, SESSION)가 필요합니다.');
		process.exit(1);
	}

	await client.connect();
	console.log('Userbot connected.');

	client.addEventHandler(async (event) => {
		try {
			const chatId = (event.chatId && event.chatId.toString()) || '';
			if (chatId !== SOURCE_CHAT_ID) return;

			const msg = event.message;
			if (!msg) return;

			// 내가 보낸 메시지/서비스 메시지/빈 텍스트 제외
			if (msg.isOut) return;
			const text = msg.message || '';
			if (!text.trim()) return;

			// 중복 포워드 방지
			if (forwardedMessageIds.has(msg.id)) return;

			const targets = matchTargets(text);
			if (targets.length === 0) return;

			if (SEND_MODE === 'forward') {
				// 원본 전달 표시 유지
				await Promise.all(
					targets.map(id =>
						client.forwardMessages(id, { messages: [msg.id], fromPeer: SOURCE_CHAT_ID, dropAuthor: false })
					)
				);
			} else {
				// 기본: 복사본으로 전송
				const content = `자동전달 (자동메세지 시스템)\n${text}`;
				await Promise.all(
					targets.map(id => client.sendMessage(id, { message: content }))
				);
			}

			forwardedMessageIds.add(msg.id);
			if (forwardedMessageIds.size > 10000) forwardedMessageIds.clear();
		} catch (e) {
			console.error('forward error:', e.message);
		}
	}, new NewMessage({}));

	console.log('Listening on source chat:', SOURCE_CHAT_ID);
})();
