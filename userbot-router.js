'use strict';

const http = require('http');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');

const API_ID = Number(process.env.API_ID || 0);
const API_HASH = process.env.API_HASH || '';
const SESSION = process.env.SESSION || '';

const SOURCE_CHAT_ID = '-1002552721308';
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

// 배타 규칙(매칭되면 그 결과만 사용)
const EXCLUSIVE_RULES = [
  { keywords: ['박*영(2982)'], targets: [TARGETS.DOKSAN] },
  { keywords: ['문*영(6825)'], targets: [TARGETS.DOGOK] },
];

// 누적 규칙(매칭되는 대로 추가)
const ADDITIVE_RULES = [
  { keywords: ['문*영(8885)'],      targets: [TARGETS.JONGNO3, TARGETS.JONGNO_DEPOSIT] },
  { keywords: ['110-***-038170'],  targets: [TARGETS.JONGNO1, TARGETS.JONGNO_DEPOSIT] },
  { keywords: ['877001**550'],     targets: [TARGETS.JONGNO2, TARGETS.JONGNO_DEPOSIT] },
];

// “입금” 포함 AND “출금” 미포함일 때만 전달
function shouldForward(text) {
  const hasDeposit = /입금/.test(text);
  const hasWithdraw = /출금/.test(text);
  return hasDeposit && !hasWithdraw;
}

// 표시용 가공
function formatMessage(raw) {
  const lines = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);

  // 계좌/발신/라벨 제거(표시용)
  //  - 별(*)/대시(-) 포함 라인(마스킹 계좌)
  //  - 순수 숫자 6자리 이상(계정/전화류)
  const isMaskedAccount = (s) => /[*-]/.test(s) || /^\d{6,}$/.test(s);
  const drop = (s) =>
    /^\d{7,}$/.test(s) ||                // 긴 발신번호
    /^\[?Web발신\]?$/i.test(s) ||
    /^보낸사람\s*:/.test(s) ||
    /^\[?카카오뱅크\]?$/i.test(s) ||
    isMaskedAccount(s);

  const cleaned = lines.filter(s => !drop(s));

  const dateRegex = /\d{2}\/\d{2}\s+\d{2}:\d{2}/;
  const isKakao = lines.some(s => /카카오뱅크/i.test(s));

  // “신한08/20 18:52”, “[KB]08/20 20:17” 같은 은행+일시
  const bankDateLine = cleaned.find(s => dateRegex.test(s) && /신한|\[?kb\]?|국민|농협|우리|ibk|하나|기업/i.test(s));
  // 일시만 있는 라인(카카오 일반)
  const dateOnlyLine = cleaned.find(s => dateRegex.test(s));

  const depositLine = cleaned.find(s => /입금/.test(s));
  const depositIdx = depositLine ? cleaned.indexOf(depositLine) : -1;

  // 이름/호수 후보
  const looksLikeNameLoose = (s) => /[가-힣]{2,}/.test(s) && !/\d/.test(s) && !/입금/.test(s);
  const nameLike = (s) => /\(.+\)/.test(s) || /(호|차)/.test(s) || looksLikeNameLoose(s);
  const nameLine = cleaned.find(s => nameLike(s) && !/입금/.test(s));
  const nameIdx = nameLine ? cleaned.indexOf(nameLine) : -1;

  // 금액 라인(입금 다음의 숫자/금액)
  let amountLine = null;
  if (depositIdx >= 0) {
    for (let i = depositIdx + 1; i < cleaned.length; i++) {
      const s = cleaned[i];
      if (!s) continue;
      if (/입금/.test(s)) continue;
      if (/^[0-9][\d,]*원?$/.test(s)) { amountLine = s; break; }
      break; // 다른 유의미 라인이면 중단
    }
  }

  // 보조정보(호/차 등)
  let extraLine = null;
  for (const s of cleaned) {
    if (s !== nameLine && !/입금/.test(s) && /(호|차)/.test(s)) { extraLine = s; break; }
  }
  // 카카오: 입금 다음 첫 유의미 라인(이름/호수 등) 보강
  if (isKakao && !extraLine && depositIdx >= 0) {
    for (let i = depositIdx + 1; i < cleaned.length; i++) {
      const s = cleaned[i];
      if (!s || s === nameLine || /입금/.test(s)) continue;
      if (!/^[0-9][\d,]*원?$/.test(s)) { extraLine = s; break; } // 금액이 아니면 보조정보
    }
  }

  const out = [];
  if (isKakao) {
    // 이름 → 일시 → 입금(한 줄) → (있으면) 보조
    if (nameLine) out.push(nameLine);
    if (dateOnlyLine) out.push(dateOnlyLine);
    if (depositLine) out.push(depositLine);
    if (extraLine && extraLine !== nameLine) out.push(extraLine);
  } else {
    // 비카카오
    // ① 이름이 입금보다 위: 날짜 → 이름 → 입금 → 금액(있으면) → 보조
    // ② 그 외: 날짜 → 입금 → 금액(있으면) → 이름 → 보조
    if (nameIdx >= 0 && (depositIdx < 0 || nameIdx < depositIdx)) {
      if (bankDateLine) out.push(bankDateLine); else if (dateOnlyLine) out.push(dateOnlyLine);
      if (nameLine) out.push(nameLine);
      if (depositLine) out.push(depositLine);
      if (amountLine) out.push(amountLine);
      if (extraLine && extraLine !== nameLine) out.push(extraLine);
    } else {
      if (bankDateLine) out.push(bankDateLine); else if (dateOnlyLine) out.push(dateOnlyLine);
      if (depositLine) out.push(depositLine);
      if (amountLine) out.push(amountLine);
      if (nameLine) out.push(nameLine);
      if (extraLine && extraLine !== nameLine) out.push(extraLine);
    }
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
      r.targets.forEach(t => result.add(t));
    }
  }
  if (exclusiveHit) return [...result];

  // 누적 규칙
  for (const r of ADDITIVE_RULES) {
    if (includesAny(norm, r.keywords)) r.targets.forEach(t => result.add(t));
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

      console.log('route targets:', targets, 'sample:', content.split('\n')[0] || '');

      if (SEND_MODE === 'forward') {
        const results = await Promise.allSettled(
          targets.map(id =>
            client.forwardMessages(id, { messages: [msg.id], fromPeer: SOURCE_CHAT_ID, dropAuthor: false })
          )
        );
        results.forEach((r, i) => {
          if (r.status === 'rejected') console.error('forward fail:', targets[i], r.reason?.message || r.reason);
        });
      } else {
        const results = await Promise.allSettled(
          targets.map(id => client.sendMessage(id, { message: content }))
        );
        results.forEach((r, i) => {
          if (r.status === 'rejected') console.error('send fail:', targets[i], r.reason?.message || r.reason);
        });
      }

      forwardedMessageIds.add(msg.id);
      if (forwardedMessageIds.size > 10000) forwardedMessageIds.clear();
    } catch (e) {
      console.error('forward error:', e.message);
    }
  }, new NewMessage({}));

  console.log('Listening on source chat:', SOURCE_CHAT_ID);
}

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
