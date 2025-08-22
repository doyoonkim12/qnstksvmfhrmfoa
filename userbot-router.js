'use strict';

// Web Service 무료 유지 버전: userbot + 간단 HTTP 서버(/healthz)
// - Start Command: node userbot-router.js
// - Env: API_ID, API_HASH, SESSION, (선택) SEND_MODE=copy|forward
// - UptimeRobot에서 https://<서비스도메인>/healthz 를 1~5분 간격으로 ping

const http = require('http');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');

// 필수 환경변수
const API_ID = Number(process.env.API_ID || 0);
const API_HASH = process.env.API_HASH || '';
const SESSION = process.env.SESSION || '';

// 소스/타겟 방
const SOURCE_CHAT_ID = '-1002552721308'; // 자동메세지 시스템
const TARGETS = {
	DOKSAN: '-4786506925',
	JONGNO1: '-4787323606',
	JONGNO2: '-4698985829',
	JONGNO3: '-4651498378',
	DOGOK: '-1002723031579',
	JONGNO_DEPOSIT: '-4940765825'
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

// 전달 모드
const SEND_MODE = (process.env.SEND_MODE || 'copy').toLowerCase();

function normalize(s) { return (s || '').toString().trim().toLowerCase(); }
function matchTargets(text) {
	const norm = normalize(text);
	const out = new Set();
	for (const r of RULES) if (r.target && r.keywords.some(k => norm.includes(normalize(k)))) out.add(r.target);
	return [...out];
}

const client = new TelegramClient(new StringSession(SESSION), API_ID, API_HASH, { connectionRetries: 5 });
const forwardedMessageIds = new Set();

// 텔레그램 런
async function startUserbot() {
	if (!API_ID || !API_HASH || !SESSION) throw new Error('API_ID/API_HASH/SESSION 필요');

	await client.connect();
	console.log('Userbot connected.');

	client.addEventHandler(async (event) => {
		try {
			const chatId = (event.chatId && event.chatId.toString()) || '';
			if (chatId !== SOURCE_CHAT_ID) return;

			const msg = event.message;
			if (!msg || msg.isOut) return;

			const text = msg.message || '';
			if (!text.trim()) return;

			if (forwardedMessageIds.has(msg.id)) return;

			const targets = matchTargets(text);
			if (targets.length === 0) return;

			if (SEND_MODE === 'forward') {
				await Promise.all(targets.map(id =>
					client.forwardMessages(id, { messages: [msg.id], fromPeer: SOURCE_CHAT_ID, dropAuthor: false })
				));
			} else {
				const content = `자동전달 (자동메세지 시스템)\n${text}`;
				await Promise.all(targets.map(id => client.sendMessage(id, { message: content })));
			}

			forwardedMessageIds.add(msg.id);
			if (forwardedMessageIds.size > 10000) forwardedMessageIds.clear();
		} catch (e) {
			console.error('forward error:', e.message);
		}
	}, new NewMessage({}));

	console.log('Listening on source chat:', SOURCE_CHAT_ID);
}

// 헬스체크 HTTP 서버
const PORT = Number(process.env.PORT || 10000);
const server = http.createServer((req, res) => {
	if (req.url === '/healthz') {
		res.writeHead(200, { 'Content-Type': 'text/plain' });
		return res.end('ok');
	}
	res.writeHead(404, { 'Content-Type': 'text/plain' });
	res.end('not found');
});

(async () => {
	try {
		await startUserbot();
		server.listen(PORT, () => console.log('Health server on', PORT));
	} catch (e) {
		console.error('startup error:', e.message);
		process.exit(1);
	}
})();
