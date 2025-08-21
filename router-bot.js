'use strict';

process.env.TZ = 'Asia/Seoul';
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

const botToken = process.env.TELEGRAM_BOT_TOKEN;
if (!botToken) {
	console.error('환경변수 TELEGRAM_BOT_TOKEN이 필요합니다 (.env 설정).');
	process.exit(1);
}

const SOURCE_CHAT_ID = Number(process.env.SOURCE_CHAT_ID); // 자동메세지 시스템 방
const CHAT_DOKSAN_MGMT = Number(process.env.CHAT_DOKSAN_MGMT); // 독산동 계약서 관리비 확인방
const CHAT_JONGNO_1 = Number(process.env.CHAT_JONGNO_1);       // 종로1차
const CHAT_JONGNO_2 = Number(process.env.CHAT_JONGNO_2);       // 종로2차
const CHAT_JONGNO_3 = Number(process.env.CHAT_JONGNO_3);       // 종로3차
const CHAT_DOGOK_DEPOSIT = Number(process.env.CHAT_DOGOK_DEPOSIT); // 도곡동입금관리비방
const CHAT_JONGNO_DEPOSIT_CONFIRM = Number(process.env.CHAT_JONGNO_DEPOSIT_CONFIRM); // 종로 입금확인방

const bot = new TelegramBot(botToken, { polling: true });

let botUserId = null;
bot.getMe().then(me => { botUserId = me.id; }).catch(() => {});

const regex = {
	timeOnly: /^\d{2}\/\d{2}\s+\d{2}:\d{2}$/,                   // 08/21 18:31
	kakaoTag: /\[카카오뱅크\]/i,
	webTag: /^\[Web발신\]$/i,
	senderPrefix: /^보낸사람\s*:/,
	onlyDigits: /^\d{6,}$/,                                     // 15993333 같은 번호 줄
	amountLine: /^입금\s*[\d,]+(?:원)?\s*$/i,                   // 입금 900,000원 / 입금 1원
	accountShinhan: /110-\*{3}-038170/,
	kbTagLine: /^\[KB\].*$/,                                    // [KB]08/21 14:38
	accountKB: /877001\*\*550/,
	namePark2982: /박\*영\(2982\)/,
	nameMoon6825: /문\*영\(6825\)/,
	nameMoon8885: /문\*영\(8885\)/,
	shinhanLine: /^신한.*\d{2}\/\d{2}\s+\d{2}:\d{2}/,           // 신한08/21 18:01
};

function normalize(s) { return (s || '').toString().trim(); }
function hasWithdrawal(text) { return text.includes('출금'); }

function cleanCommon(lines) {
	return lines
		.map(l => normalize(l))
		.filter(l => l.length > 0)
		.filter(l => !regex.webTag.test(l))
		.filter(l => !regex.senderPrefix.test(l))
		.filter(l => !regex.onlyDigits.test(l)); // 15993333 등 제거
}

function findLine(lines, r) { return lines.find(l => r.test(l)); }

function fixHoSpacing(s) {
	// 1102호sumiy -> 1102호 sumiy
	return s.replace(/(\d{3,4}호)(?=\S)/g, '$1 ');
}

function buildForDoksanPark2982(lines) {
	const ts = findLine(lines, regex.timeOnly);
	const amt = findLine(lines, regex.amountLine);
	let hoLine = lines.find(l => /호/.test(l)) || lines[lines.length - 1] || '';
	hoLine = fixHoSpacing(hoLine);
	if (!ts || !amt || !hoLine) return null;
	return `${ts}\n${amt}\n${hoLine}`;
}

function buildForDogokMoon6825(lines) {
	const name = findLine(lines, regex.nameMoon6825) || '문*영(6825)';
	const ts = findLine(lines, regex.timeOnly);
	const amt = findLine(lines, regex.amountLine);
	let idxAmt = lines.findIndex(l => regex.amountLine.test(l));
	let tail = '';
	for (let i = idxAmt + 1; i < lines.length; i++) {
		const l = lines[i];
		if (!l) continue;
		if (regex.kakaoTag.test(l) || regex.webTag.test(l) || regex.senderPrefix.test(l)) continue;
		if (regex.timeOnly.test(l)) continue;
		if (regex.nameMoon6825.test(l)) continue;
		tail = l;
		break;
	}
	if (!name || !ts || !amt || !tail) return null;
	return `${name}\n${ts}\n${amt}\n${tail}`;
}

function buildForShinhan(lines) {
	const l1 = findLine(lines, regex.shinhanLine);
	const acct = findLine(lines, regex.accountShinhan);
	const amt = findLine(lines, regex.amountLine);
	let desc = '';
	if (amt) {
		const i = lines.findIndex(l => l === amt);
		for (let k = i + 1; k < lines.length; k++) {
			const cand = lines[k];
			if (!cand) continue;
			desc = cand;
			break;
		}
	}
	if (!l1 || !acct || !amt || !desc) return null;
	return `${l1}\n${acct}\n${amt}\n${desc}`;
}

function buildForKB(lines) {
	const kbLine = findLine(lines, regex.kbTagLine);
	const acct = findLine(lines, regex.accountKB);
	const amtWord = findLine(lines, /^입금$/) || '입금';
	const amtValue = findLine(lines, /^[\d,]+(?:원)?$/);
	const ho = lines.find(l => /^\d{3,4}호/.test(l));
	if (!kbLine || !acct || !amtValue) return null;
	const parts = [kbLine, acct];
	if (ho) parts.push(fixHoSpacing(ho));
	parts.push(amtWord);
	parts.push(amtValue);
	return parts.join('\n');
}

function buildForJongno3Moon8885(lines) {
	const ts = findLine(lines, regex.timeOnly);
	const amt = findLine(lines, regex.amountLine);
	let hoLine = lines.find(l => /호/.test(l)) || lines[lines.length - 1] || '';
	hoLine = fixHoSpacing(hoLine);
	if (!ts || !amt || !hoLine) return null;
	return `${ts}\n${amt}\n${hoLine}`;
}

function routeAndFormat(text) {
	if (!text || hasWithdrawal(text)) return null;

	let lines = text.split(/\r?\n/).map(normalize);
	lines = cleanCommon(lines);

	// 1) 박*영(2982) + 카카오뱅크 → 독산동
	if (regex.kakaoTag.test(text) && regex.namePark2982.test(text)) {
		const body = buildForDoksanPark2982(lines);
		if (body) return { targets: [CHAT_DOKSAN_MGMT], body };
	}

	// 2) 문*영(6825) + 카카오뱅크 → 도곡동
	if (regex.kakaoTag.test(text) && regex.nameMoon6825.test(text)) {
		const body = buildForDogokMoon6825(lines);
		if (body) return { targets: [CHAT_DOGOK_DEPOSIT], body };
	}

	// 3) 신한 + 110-***-038170 → 종로1차 + 종로 입금확인방
	if (regex.accountShinhan.test(text) && /신한/.test(text)) {
		const body = buildForShinhan(lines);
		if (body) return { targets: [CHAT_JONGNO_1, CHAT_JONGNO_DEPOSIT_CONFIRM], body };
	}

	// 4) [KB] + 877001**550 → 종로2차 + 종로 입금확인방
	if (regex.accountKB.test(text) && /\[KB\]/.test(text)) {
		const body = buildForKB(lines);
		if (body) return { targets: [CHAT_JONGNO_2, CHAT_JONGNO_DEPOSIT_CONFIRM], body };
	}

	// 5) 문*영(8885) → 종로3차 + 종로 입금확인방
	if (regex.nameMoon8885.test(text)) {
		const body = buildForJongno3Moon8885(lines);
		if (body) return { targets: [CHAT_JONGNO_3, CHAT_JONGNO_DEPOSIT_CONFIRM], body };
	}

	return null;
}

// 유틸 명령
bot.onText(/^\/id\b/i, (msg) => bot.sendMessage(msg.chat.id, `chat_id: ${msg.chat.id}`));
bot.onText(/^\/ping\b/i, (msg) => bot.sendMessage(msg.chat.id, 'pong'));

bot.on('message', async (msg) => {
	try {
		if (!msg.text) return;
		if (botUserId && msg.from && msg.from.id === botUserId) return;
		if (SOURCE_CHAT_ID && msg.chat && msg.chat.id !== SOURCE_CHAT_ID) return;
		if (/^\/(id|ping)\b/i.test(msg.text)) return;

		const result = routeAndFormat(msg.text);
		if (!result) return;

		await Promise.all(
			result.targets
				.filter(Boolean)
				.map(cid => bot.sendMessage(cid, result.body, { disable_web_page_preview: true }))
		);
	} catch (e) {
		console.error('전달 실패:', e.message);
	}
});

process.on('SIGINT', () => process.exit(0));
