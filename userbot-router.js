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
  DOKSAN: '-4786506925',
  JONGNO1: '-4787323606',
  JONGNO2: '-4698985829',
  JONGNO3: '-1002996545753', // 종로3차 (확인값)
  DOGOK: '-1002723031579',
  JONGNO_DEPOSIT: '-4940765825',
};

const SEND_MODE = (process.env.SEND_MODE || 'copy').toLowerCase();

function normalize(s){ return (s||'').toString().trim().toLowerCase(); }
function includesAny(norm, arr){ return arr.some(k => norm.includes(normalize(k))); }

// 배타 규칙
const EXCLUSIVE_RULES = [
  { keywords: ['박*영(2982)'], targets: [TARGETS.DOKSAN] },
  { keywords: ['문*영(6825)'], targets: [TARGETS.DOGOK] },
];

// 누적 규칙
const ADDITIVE_RULES = [
  { keywords: ['문*영(8885)'],     targets: [TARGETS.JONGNO3, TARGETS.JONGNO_DEPOSIT] },
  { keywords: ['110-***-038170'], targets: [TARGETS.JONGNO1, TARGETS.JONGNO_DEPOSIT] },
  { keywords: ['877001**550'],    targets: [TARGETS.JONGNO2, TARGETS.JONGNO_DEPOSIT] },
];

// “입금” 포함 AND “출금” 미포함일 때만 전달 (공백 제거 후 판별)
function shouldForward(text){
  const t = (text || '').replace(/\s+/g, '');
  const hasDeposit = /입금/.test(t);
  const hasWithdraw = /출금/.test(t);
  return hasDeposit && !hasWithdraw;
}

// 표시용 가공
function formatMessage(raw){
  const lines = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);

  // 계좌/발신/라벨 제거(표시용)
  const isMaskedAccount = (s) => /[*-]/.test(s) || /^\d{6,}$/.test(s); // 마스킹 또는 6자리 이상 숫자
  const drop = (s) =>
    /^\d{7,}$/.test(s) ||                // 긴 발신번호
    /^\[?Web발신\]?$/i.test(s) ||
    /^보낸사람\s*:/.test(s) ||
    /^\[?카카오뱅크\]?$/i.test(s) ||
    isMaskedAccount(s);

  const cleaned = lines.filter(s => !drop(s));

  const dateRegex = /\d{2}\/\d{2}\s+\d{2}:\d{2}/;
  const isKakao = lines.some(s => /카카오뱅크/i.test(s));

  const bankDateLine = cleaned.find(s => dateRegex.test(s) && /신한|\[?kb\]?|국민|농협|우리|ibk|하나|기업/i.test(s));
  const dateOnlyLine = cleaned.find(s => dateRegex.test(s));

  const depositLine = cleaned.find(s => /입금/.test(s));
  const depositIdx = depositLine ? cleaned.indexOf(depositLine) : -1;

  // 이름/호수 후보
  const looksLikeNameLoose = (s) => /[가-힣]{2,}/.test(s) && !/\d/.test(s) && !/입금/.test(s);
  const nameLike = (s) => /\(.+\)/.test(s) || /(호|차)/.test(s) || looksLikeNameLoose(s);
  const nameLine = cleaned.find(s => nameLike(s) && !/입금/.test(s));
  const nameIdx = nameLine ? cleaned.indexOf(nameLine) : -1;

  // 금액 라인(입금 다음 숫자/금액)
  let amountLine = null;
  if (depositIdx >= 0) {
    for (let i = depositIdx + 1; i < cleaned.length; i++) {
      const s = cleaned[i];
      if (!s) continue;
      if (/입금/.test(s)) continue;
      if (/^[0-9][\d,]*원?$/.test(s)) { amountLine = s; break; }
      break;
    }
  }

  // 보조정보(호/차 등)
  let extraLine = null;
  for (const s of cleaned) {
    if (s !== nameLine && !/입금/.test(s) && /(호|차)/.test(s)) { extraLine = s; break; }
  }
  // 카카오: 입금 다음 첫 유의미 라인 보강
  if (isKakao && !extraLine && depositIdx >= 0) {
    for (let i = depositIdx + 1; i < cleaned.length; i++) {
      const s = cleaned[i];
      if (!s || s === nameLine || /입금/.test(s)) continue;
      if (!/^[0-9][\d,]*원?$/.test(s)) { extraLine = s; break; }
    }
  }

  const out = [];
  if (isKakao) {
    if (nameLine) out.push(nameLine);
    if (dateOnlyLine) out.push(dateOnlyLine);
    if (depositLine) out.push(depositLine);
    if (extraLine && extraLine !== nameLine) out.push(extraLine);
  } else {
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

function matchTargets(text){
  const can = shouldForward(text);
  if (!can) {
    console.log('skip: deposit filter not passed');
    return [];
  }
  const norm = normalize(text);
  const result = new Set();

  // 배타 규칙
  let exclusiveHit = false;
  for (const r of EXCLUSIVE_RULES) {
    if (includesAny(norm, r.keywords)) { exclusiveHit = true; r.targets.forEach(t => result.add(t)); }
  }
  if (exclusiveHit) {
    console.log('rule: exclusive hit ->', [...result]);
    return [...result];
  }

  // 누적 규칙
  for (const r of ADDITIVE_RULES) {
    if (includesAny(norm, r.keywords)) r.targets.forEach(t => result.add(t));
  }
  const out = [...result];
  if (out.length === 0) console.log('rule: no match');
  else console.log('rule: additive hit ->', out);
  return out;
}

const client = new TelegramClient(new StringSession(SESSION), API_ID, API_HASH, { connectionRetries: 5 });

// 대상 방 엔티티 미리 resolve
const RESOLVED = {}; // chatId(string) -> entity
async function resolveAllTargets(){
  const ids = Object.values(TARGETS).map(String);
  for (const id of ids) {
    try {
      const entity = await client.getEntity(id);
      RESOLVED[id] = entity;
      const title = entity?.title || entity?.username || '';
      console.log('target ok:', id, title);
    } catch (e) {
      console.error('target resolve fail (가입/권한 확인 필요):', id, e.message);
    }
  }
}
function toPeer(id){ return RESOLVED[String(id)] || id; }

async function sendToTargets(messageEntity, content, targets){
  console.log('route targets:', targets);
  if (SEND_MODE === 'forward') {
    const results = await Promise.allSettled(
      targets.map(id => client.forwardMessages(toPeer(id), {
        messages: [messageEntity.id],
        fromPeer: SOURCE_CHAT_ID,
        dropAuthor: false,
      }))
    );
    results.forEach((r, i) => {
      if (r.status === 'rejected') console.error('forward fail:', targets[i], r.reason?.message || r.reason);
      else console.log('forward ok:', targets[i]);
    });
  } else {
    const results = await Promise.allSettled(
      targets.map(id => client.sendMessage(toPeer(id), { message: content }))
    );
    results.forEach((r, i) => {
      if (r.status === 'rejected') console.error('send fail:', targets[i], r.reason?.message || r.reason);
      else console.log('send ok:', targets[i]);
    });
  }
}

async function startUserbot(){
  if (!API_ID || !API_HASH || !SESSION) throw new Error('API_ID/API_HASH/SESSION 필요');

  await client.connect();
  console.log('Userbot connected.');
  await resolveAllTargets();

  // /probe: 아무 방에서나 chat_id 확인
  client.addEventHandler(async (event) => {
    try {
      const text = event?.message?.message?.trim();
      if (!text || !/^\/probe\b/i.test(text)) return;
      const chatId = (event.chatId && event.chatId.toString()) || '';
      const chat = await event.getChat();
      const title = chat?.title || chat?.username || '';
      console.log('PROBE chat id:', chatId, title);
      await client.sendMessage(event.chatId, { message: `chat_id: ${chatId}\n${title}` });
    } catch (e) {
      console.error('probe error:', e.message);
    }
  }, new NewMessage({}));

  // 메인 라우팅
  client.addEventHandler(async (event) => {
    try {
      const chatId = (event.chatId && event.chatId.toString()) || '';
      const msg = event.message;
      const original = msg?.message || '';

      // 원문 샘플/채널 로그
      console.log('recv:', { chatId, len: original.length, head: original.split('\n').slice(0,4).join(' | ') });

      if (chatId !== SOURCE_CHAT_ID) return;
      if (!msg || msg.isOut) return;
      if (!original.trim()) return;

      const targets = matchTargets(original);
      if (targets.length === 0) return;

      const content = formatMessage(original);
      console.log('content:', content.split('\n').join(' | '));
      if (!content.trim()) return;

      await sendToTargets(msg, content, targets);
    } catch (e) {
      console.error('forward error:', e.message);
    }
  }, new NewMessage({}));

  console.log('Listening on source chat:', SOURCE_CHAT_ID);
}

// healthz
const PORT = Number(process.env.PORT || 10000);
const server = http.createServer((req, res) => {
  if (req.url === '/healthz') { res.writeHead(200, {'Content-Type':'text/plain'}); return res.end('ok'); }
  res.writeHead(404, {'Content-Type':'text/plain'}); res.end('not found');
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
