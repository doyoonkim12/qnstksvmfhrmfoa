'use strict';

// Web Service 무료 유지 버전: userbot + 간단 HTTP 서버(/healthz)
const http = require('http');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');

const API_ID = Number(process.env.API_ID || 0);
const API_HASH = process.env.API_HASH || '';
const SESSION = process.env.SESSION || '';

const SOURCE_CHAT_ID = '-1002552721308'; // 자동메세지 시스템
const TARGETS = {
	DOKSAN: '-4786506925',          // 독산동 계약서 관리비 확인방
	JONGNO1: '-4787323606',         // 종로1차
	JONGNO2: '-4698985829',         // 종로2차
	JONGNO3: '-4651498378',         // 종로3차
	DOGOK: '-1002723031579',        // 도곡동입금관리비방
	JONGNO_DEPOSIT: '-4940765825',  // 종로 입금확인방
};

const SEND_MODE = (process.env.SEND_MODE || 'copy').toLowerCase();

function normalize(s) { return (s || '').toString().trim().toLowerCase(); }
function includesAny(norm, arr) { return arr.some(k => norm.includes(normalize(k))); }

// 배타 규칙: 매칭되면 그 결과만 사용(입금확인방 자동 추가 안 함)
const EXCLUSIVE_RULES = [
	{ keywords: ['박*영(2982)'], targets: [TARGETS.DOKSAN] },
	{ keywords: ['문*영(6825)'], targets: [TARGETS.DOGOK] },
];

// 누적 규칙: 매칭되는 대로 추가
const ADDITIVE_RULES = [
	{ keywords: ['문*영(8885)'],      targets: [TARGETS.JONGNO3, TARGETS.JONGNO_DEPOSIT] },
	{ keywords: ['110-***-038170'],  targets: [TARGETS.JONGNO1, TARGETS.JONGNO_DEPOSIT] },
	{ keywords: ['877001**550'],     targets: [TARGETS.JONGNO2, TARGETS.JONGNO_DEPOSIT] },
];

// 입금만 허용, 출금은 차단
function shouldForward(text) {
	const hasDeposit = /입금/.test(text);
	const hasWithdraw = /출금/.test(text);
	return hasDeposit && !hasWithdraw;
}

// 메시지 요약(은행별 형태 차이 반영)
function formatMessage(raw) {
	const lines = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);

	// 제거할 라인
	const drop = (s) =>
		/^\d{7,}$/.test(s) ||                 // 발신번호(숫자만)
		/^\[?Web발신\]?$/i.test(s) ||
		/^보낸사람\s*:/.test(s) ||
		/^\[?카카오뱅크\]?$/i.test(s);

	const cleaned = lines.filter(s => !drop(s));

	// 특징 라인들 추출
	const dateRegex = /\d{2}\/\d{2}\s+\d{2}:\d{2}/;
	const isKakao = lines.some(s => /카카오뱅크/i.test(s));

	// 은행+일시가 붙어있는 라인 예: "신한08/20 18:52", "[KB]08/20 20:17"
	const bankDateLine = cleaned.find(s => dateRegex.test(s) && /신한|kb|국민|농협|우리|ibk|하나|기업|\[kb\]/i.test(s));
	// 일시만 있는 라인(카카오 예시)
	const dateOnlyLine = cleaned.find(s => dateRegex.test(s));

	// 입금 금액 라인
	const depositLine = cleaned.find(s => /입금/.test(s));

	// 이름/호수 라인(첫 번째 후보)
	const nameLike = (s) =>
		/\(.+\)/.test(s) ||                    // 괄호 포함(예: 박민수(스튜디오다), 문*영(8885))
		/(호|차)/.test(s);                     // 호/차 언급(예: 김도연204호, 3차 802호)
	const nameLine = cleaned.find(s => nameLike(s) && !/입금/.test(s));

	// 추가 정보 라인(카카오: 입금 다음 줄의 첫 유의미 라인 포함)
	let extraLine = null;

	// 1) 호/차 형태 우선 탐색(비카카오 포함 공통)
	for (const s of cleaned) {
		if (s !== nameLine && !/입금/.test(s) && /(호|차)/.test(s)) {
			extraLine = s;
			break;
		}
	}

	// 2) 카카오: 입금 라인 다음의 첫 유의미 라인(이름/호수 등) 보강
	if (!extraLine && depositLine) {
		const idx = cleaned.indexOf(depositLine);
		for (let i = idx + 1; i < cleaned.length; i++) {
			const s = cleaned[i];
			if (!s || s === nameLine) continue;
			if (/입금/.test(s)) continue;
			// 은행 라벨/발신/공백 제외는 이미 cleaned에서 걸렀음
			extraLine = s;
			break;
		}
	}

	// 출력 조립
	const out = [];
	if (isKakao) {
		// 요청 포맷: 이름 → 일시 → 입금 → (있다면) 추가 한 줄(이름/호수)
		if (nameLine) out.push(nameLine);
		if (dateOnlyLine) out.push(dateOnlyLine);
		if (depositLine) out.push(depositLine);
		if (extraLine && extraLine !== nameLine) out.push(extraLine);
	} else {
		// 요청 포맷: 은행+일시(or 일시) → 입금 → 이름/호수 → (있다면) 추가 한 줄
		if (bankDateLine) out.push(bankDateLine);
		else if (dateOnlyLine) out.push(dateOnlyLine);
		if (depositLine) out.push(depositLine);
		if (nameLine) out.push(nameLine);
		if (extraLine && extraLine !== nameLine) out.push(extraLine);
	}

	return out.length ? out.join('\n') : raw;
}

function matchTargets(text) {
	if (!shouldForward(text)) return [];
	const norm = normalize(text);
	const result = new Set();

	// 배타 규칙
	let exclusiveHit = false;
	for (const r of EXCLUSIVE_RULES) {
		if (includesAny(norm, r.keywords)) {
			exclusiveHit = true;
			for (const t of r.targets) result.add(t);
		}
	}
	if (exclusiveHit) return [...result];

	// 누적 규칙
	for (const r of ADDITIVE_RULES) {
		if (includesAny(norm, r.keywords)) {
			for (const t of r.targets) result.add(t);
		}
	}
	return [...result];
}

const client = new TelegramClient(new StringSession(SESSION), API_ID, API_HASH, { connectionRetries: 5 });
const forwardedMessageIds = new Set();

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

			const original = msg.message || '';
			if (!original.trim()) return;

			const targets = matchTargets(original);
			if (targets.length === 0) return;

			const content = formatMessage(original);
			if (!content.trim()) return;

			if (SEND_MODE === 'forward') {
				await Promise.all(targets.map(id =>
					client.forwardMessages(id, { messages: [msg.id], fromPeer: SOURCE_CHAT_ID, dropAuthor: false })
				));
			} else {
				await Promise.all(targets.map(id =>
					client.sendMessage(id, { message: content })
				));
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
