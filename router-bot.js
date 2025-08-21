// todo-bot-proxy.js
'use strict';

/**
 * Telegram Webhook 버전(무의존, 단일파일)
 * - Render(Web Service) 배포용: 포트 리슨 + 웹훅 자동 설정
 * - 같은 토큰으로 다른 인스턴스(폴링/웹훅)가 돌면 409 발생 → 반드시 한 곳만 실행
 * - Render에서 Start Command: node todo-bot-proxy.js
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

// 1) 토큰/방 ID (요청하신 단일파일 구성)
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

// ──────────────────────────────────────────────────────────────
// Telegram API
// ──────────────────────────────────────────────────────────────
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

async function handleUpdate(update) {
	try {
		const msg = update && update.message;
		if (!msg || !msg.text || !msg.chat) return;

		// 소스 방 필터
		if (SOURCE_CHAT_ID && msg.chat.id !== SOURCE_CHAT_ID) return;

		const targets = matchTargets(msg.text);
		if (targets.length === 0) return;

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
	} catch (e) {
		console.error('handleUpdate 에러:', e.message);
	}
}

// ──────────────────────────────────────────────────────────────
/**
 * 서버 + 웹훅 설정
 * - Render에서는 RENDER_EXTERNAL_URL 이 자동으로 주어짐
 * - 그 외 환경이면 PUBLIC_URL 환경변수로 외부 URL 지정
 */
const PORT = Number(process.env.PORT || 10000);
const BASE_URL =
	process.env.RENDER_EXTERNAL_URL?.replace(/\/+$/, '') ||
	process.env.PUBLIC_URL?.replace(/\/+$/, '');

const WEBHOOK_PATH = `/webhook/${TELEGRAM_BOT_TOKEN}`;
const WEBHOOK_URL = BASE_URL ? `${BASE_URL}${WEBHOOK_PATH}` : null;

const server = http.createServer(async (req, res) => {
	try {
		if (req.method === 'GET' && req.url === '/healthz') {
			res.writeHead(200, { 'Content-Type': 'text/plain' });
			return res.end('ok');
		}

		// Telegram webhook
		if (req.method === 'POST' && req.url === WEBHOOK_PATH) {
			let body = '';
			req.on('data', (chunk) => {
				body += chunk;
				// 1MB 초과 방지
				if (body.length > 1e6) req.destroy();
			});
			req.on('end', () => {
				res.writeHead(200, { 'Content-Type': 'text/plain' });
				res.end('ok'); // 먼저 응답
				try {
					const update = JSON.parse(body || '{}');
					handleUpdate(update); // 비동기 처리
				} catch (e) {
					console.error('웹훅 JSON 파싱 실패:', e.message);
				}
			});
			return;
		}

		// 기타
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

async function boot() {
	try {
		// 1) 웹훅 초기화(중복/폴링 충돌 방지)
		await tg('deleteWebhook', { drop_pending_updates: true });

		// 2) 웹훅 설정
		if (!WEBHOOK_URL) {
			console.warn('외부 URL을 알 수 없습니다. PUBLIC_URL 또는 RENDER_EXTERNAL_URL을 설정하세요.');
		} else {
			const set = await tg('setWebhook', { url: WEBHOOK_URL });
			if (!set.ok) throw new Error(`setWebhook 실패: ${JSON.stringify(set)}`);
			console.log('Webhook set to:', WEBHOOK_URL);
		}

		// 3) 서버 시작
		server.listen(PORT, () => {
			console.log('Server listening on', PORT);
		});
	} catch (e) {
		console.error('부팅 실패:', e.message);
		setTimeout(boot, 3000);
	}
}

process.on('SIGINT', () => {
	console.log('Shutting down…');
	process.exit(0);
});

boot();
