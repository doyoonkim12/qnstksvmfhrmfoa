'use strict';

/**
 * 단일 파일 버전: 외부 라이브러리 없이 Telegram API 호출
 * - Node 16+ 권장
 * - Render: Web Service로 배포, Start Command: node router-bot.js
 * - Bot Privacy(비공개) 해제 필요: BotFather → /setprivacy → Disable
 */

const https = require('https');

// 1) 토큰/방ID 상수 (요청하신 단일파일 구성을 위해 직접 하드코딩)
const TELEGRAM_BOT_TOKEN = '8256150140:AAEE6OKmkTfJD_Li-41CP6UmKrMOMTE6Qnc'.trim();

// 소스(문자 수집) 방: "자동메세지 시스템"
const SOURCE_CHAT_ID = -1002552721308;

// 타겟 방들
const TARGETS = {
	// 독산동 계약서 관리비 확인방
	DOKSAN: -4786506925,
	// 종로1차
	JONGNO1: -4787323606,
	// 종로2차
	JONGNO2: -4698985829,
	// 종로3차
	JONGNO3: -4651498378,
	// 도곡동입금관리비방
	DOGOK: -1002723031579,
	// 종로 입금확인방
	JONGNO_DEPOSIT: -4940765825,
};

// 라우팅 규칙
const RULES = [
	// 은행(입금 알림류는 기본 종로 입금확인방으로)
	{ target: TARGETS.JONGNO_DEPOSIT, keywords: ['KB', '국민', '국민은행'] },
	{ target: TARGETS.JONGNO_DEPOSIT, keywords: ['카카오뱅크', '카뱅', 'kakaobank'] },

	// 지점/현장 키워드 기반
	{ target: TARGETS.DOGOK, keywords: ['도곡', '도곡동'] },
	{ target: TARGETS.DOKSAN, keywords: ['독산', '독산동'] },
	{ target: TARGETS.JONGNO1, keywords: ['종로1', '종로 1', '종로1차'] },
	{ target: TARGETS.JONGNO2, keywords: ['종로2', '종로 2', '종로2차'] },
	{ target: TARGETS.JONGNO3, keywords: ['종로3', '종로 3', '종로3차'] },
];

// ──────────────────────────────────────────────────────────────
// Telegram API 래퍼 (GET)
// ──────────────────────────────────────────────────────────────
function tg(method, params = {}) {
	const query = new URLSearchParams();
	for (const [k, v] of Object.entries(params)) {
		query.append(k, String(v));
	}
	const path = `/bot${TELEGRAM_BOT_TOKEN}/${method}${query.toString() ? `?${query}` : ''}`;

	return new Promise((resolve, reject) => {
		const req = https.request(
			{ hostname: 'api.telegram.org', path, method: 'GET' },
			(res) => {
				let data = '';
				res.on('data', (d) => (data += d));
				res.on('end', () => {
					try {
						const json = JSON.parse(data);
						resolve(json);
					} catch (e) {
						reject(e);
					}
				});
			}
		);
		req.on('error', reject);
		req.end();
	});
}

// ──────────────────────────────────────────────────────────────
// 유틸
// ──────────────────────────────────────────────────────────────
function normalize(text) {
	return (text || '').toString().trim().toLowerCase();
}

function matchTargets(text) {
	const norm = normalize(text);
	const out = new Set();
	for (const rule of RULES) {
		if (!rule.target) continue;
		const hit = rule.keywords.some((k) => norm.includes(normalize(k)));
		if (hit) out.add(rule.target);
	}
	return [...out];
}

// ──────────────────────────────────────────────────────────────
// 런타임
// ──────────────────────────────────────────────────────────────
let botUserId = null;
let offset = 0;
let started = false;

async function boot() {
	try {
		const me = await tg('getMe');
		if (!me.ok) throw new Error(`getMe 실패: ${JSON.stringify(me)}`);
		botUserId = me.result.id;
		console.log(`Bot started as @${me.result.username} (id=${me.result.id})`);
		started = true;
		poll();
	} catch (e) {
		console.error('부팅 실패:', e.message);
		setTimeout(boot, 3000);
	}
}

async function poll() {
	if (!started) return;
	try {
		const res = await tg('getUpdates', {
			offset,
			timeout: 50, // long polling
			allowed_updates: JSON.stringify(['message']),
		});

		if (res.ok && Array.isArray(res.result) && res.result.length > 0) {
			for (const update of res.result) {
				offset = update.update_id + 1;
				const msg = update.message;
				if (!msg || !msg.chat) continue;

				// 텍스트만 대상
				if (!msg.text) continue;

				// 봇이 보낸 메시지 무시
				if (botUserId && msg.from && msg.from.id === botUserId) continue;

				// 소스 방 필터
				if (SOURCE_CHAT_ID && msg.chat.id !== SOURCE_CHAT_ID) continue;

				const targets = matchTargets(msg.text);
				if (targets.length === 0) continue;

				const header = msg.chat.title ? `(${msg.chat.title})` : '';
				const content = `자동전달 ${header}\n${msg.text}`;

				await Promise.all(
					targets.map((chatId) =>
						tg('sendMessage', {
							chat_id: chatId,
							text: content,
							disable_web_page_preview: true,
						})
					)
				);
			}
		}
	} catch (e) {
		console.error('poll 에러:', e.message);
	}

	// 다음 폴링
	setImmediate(poll);
}

process.on('SIGINT', () => {
	console.log('Shutting down…');
	process.exit(0);
});

boot();
