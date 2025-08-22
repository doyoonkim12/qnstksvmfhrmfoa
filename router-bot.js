// todo-bot-proxy.js
'use strict';

/**
 * 문자 → 서버(/sms) → 규칙 라우팅 → 각 타겟 방 전송 (+옵션: 소스방에도 기록)
 * - Render Web Service 배포용 (포트 리슨)
 * - Start Command: node todo-bot-proxy.js
 */

const http = require('http');
const https = require('https');

// 1) 설정
const TELEGRAM_BOT_TOKEN = '8256150140:AAEE6OKmkTfJD_Li-41CP6UmKrMOMTE6Qnc'.trim();

// 소스(로그용) 방: "자동메세지 시스템" (선택)
const SOURCE_CHAT_ID = -1002552721308;

// 타겟 방들
const TARGETS = {
	DOKSAN: -4786506925,        // 독산동 계약서 관리비 확인방
	JONGNO1: -4787323606,       // 종로1차
	JONGNO2: -4698985829,       // 종로2차
	JONGNO3: -4651498378,       // 종로3차
	DOGOK: -1002723031579,      // 도곡동입금관리비방
	JONGNO_DEPOSIT: -4940765825 // 종로 입금확인방
};

// 보안 토큰(임의 값으로 바꿔서 사용). 요청 시 ?secret= 또는 헤더 X-Secret 로 전달
const SMS_SECRET = process.env.SMS_SECRET || 'change-me-please';

// 2) 라우팅 규칙
const RULES = [
	// 은행 → 종로 입금확인방
	{ target: TARGETS.JONGNO_DEPOSIT, keywords: ['KB', '국민', '국민은행'] },
	{ target: TARGETS.JONGNO_DEPOSIT, keywords: ['카카오뱅크', '카뱅', 'kakaobank'] },

	// 지점/현장
	{ target: TARGETS.DOGOK, keywords: ['도곡', '도곡동'] },
	{ target: TARGETS.DOKSAN, keywords: ['독산', '독산동'] },
	{ target: TARGETS.JONGNO1, keywords: ['종로1', '종로 1', '종로1차'] },
	{ target: TARGETS.JONGNO2, keywords: ['종로2', '종로 2', '종로2차'] },
	{ target: TARGETS.JONGNO3, keywords: ['종로3', '종로 3', '종로3차'] },
];

// ───────────────────────── Telegram API
function tg(method, params = {}) {
	const query = new URLSearchParams();
	for (const [k, v] of Object.entries(params)) query.append(k, String(v));
	const path = `/bot${TELEGRAM_BOT_TOKEN}/${method}${query.toString() ? `?${query}` : ''}`;

	return new Promise((resolve, reject) => {
		const req = https.request(
			{ hostname: 'api.telegram.org', path, method: 'GET' },
			(res) => {
				let data = '';
				res.on('data', (d) => (data += d));
				res.on('end', () => {
					try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
				});
			}
		);
		req.on('error', reject);
		req.end();
	});
}

// ───────────────────────── 라우팅 로직
function normalize(text) {
	return (text || '').toString().trim().toLowerCase();
}

function matchTargets(text) {
	const norm = normalize(text);
	const out = new Set();
	for (const rule of RULES) {
		if (!rule.target) continue;
		if (rule.keywords.some((k) => norm.includes(normalize(k)))) out.add(rule.target);
	}
	return [...out];
}

async function routeAndSend(incomingText) {
	const targets = matchTargets(incomingText);
	const header = '(자동메세지)';
	const content = `자동전달 ${header}\n${incomingText}`;

	// 1) 소스(로그) 방에도 남기고 싶다면
	if (SOURCE_CHAT_ID) {
		await tg('sendMessage', {
			chat_id: SOURCE_CHAT_ID,
			text: incomingText,
			disable_web_page_preview: true
		});
	}

	// 2) 타겟들로 전달
	if (targets.length > 0) {
		await Promise.all(
			targets.map((chatId) =>
				tg('sendMessage', {
					chat_id: chatId,
					text: content,
					disable_web_page_preview: true
				})
			)
		);
	}
	return { targets };
}

// ───────────────────────── HTTP 서버 (/sms)
const PORT = Number(process.env.PORT || 10000);

const server = http.createServer(async (req, res) => {
	try {
		// health
		if (req.method === 'GET' && req.url.startsWith('/healthz')) {
			res.writeHead(200, { 'Content-Type': 'text/plain' });
			return res.end('ok');
		}

		// 문자 수신 엔드포인트
		if (req.url.startsWith('/sms')) {
			// 인증
			const url = new URL(req.url, `http://${req.headers.host}`);
			const qSecret = url.searchParams.get('secret');
			const hSecret = req.headers['x-secret'];
			if (SMS_SECRET && !(qSecret === SMS_SECRET || hSecret === SMS_SECRET)) {
				res.writeHead(401, { 'Content-Type': 'application/json' });
				return res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
			}

			let body = '';
			req.on('data', (chunk) => {
				body += chunk;
				if (body.length > 1e6) req.destroy(); // 1MB 제한
			});
			req.on('end', async () => {
				try {
					let text = '';
					if (req.method === 'POST') {
						if (req.headers['content-type']?.includes('application/json')) {
							const json = JSON.parse(body || '{}');
							text = json.text || json.body || json.message || '';
						} else {
							// 폼이나 텍스트도 지원
							text = body.toString();
						}
					} else {
						text = url.searchParams.get('text') || '';
					}

					if (!text.trim()) {
						res.writeHead(400, { 'Content-Type': 'application/json' });
						return res.end(JSON.stringify({ ok: false, error: 'empty text' }));
					}

					const result = await routeAndSend(text);
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ ok: true, routed_to: result.targets }));
				} catch (e) {
					console.error('sms 처리 실패:', e.message);
					res.writeHead(500, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ ok: false, error: 'server error' }));
				}
			});
			return;
		}

		res.writeHead(404, { 'Content-Type': 'text/plain' });
		res.end('not found');
	} catch (e) {
		console.error('서버 에러:', e.message);
		try {
			res.writeHead(500, { 'Content-Type': 'text/plain' });
			res.end('error');
		} catch {}
	}
});

server.listen(PORT, () => {
	console.log('Server listening on', PORT);
});
