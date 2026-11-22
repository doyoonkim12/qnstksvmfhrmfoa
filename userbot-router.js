'use strict';

const http = require('http');
const https = require('https');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');

const { SOURCE_CHAT_ID, TARGETS, BASE_URL } = require('./src/config');
const { matchTargets, buildBody } = require('./src/routing');
const { formatMessage } = require('./src/format');

const API_ID = Number(process.env.API_ID || 0);
const API_HASH = process.env.API_HASH || '';
const SESSION = process.env.SESSION || '';

const client = new TelegramClient(new StringSession(SESSION), API_ID, API_HASH, { connectionRetries: 5 });

const RESOLVED = {};
async function resolveAllTargets() {
  const ids = Object.values(TARGETS).map(String);
  for (const id of ids) {
    try {
      const entity = await client.getEntity(id);
      RESOLVED[id] = entity;
      const title = entity?.title || entity?.username || '';
      console.log('target ok:', id, title);
    } catch (e) {
      console.error('target resolve fail:', id, e.message);
    }
  }
}
function toPeer(id) { return RESOLVED[String(id)] || id; }

async function sendToTargets(content, targets) {
  const results = await Promise.allSettled(
    targets.map((id) => client.sendMessage(toPeer(id), { message: buildBody(id, content, targets) }))
  );
  results.forEach((r, i) => {
    if (r.status === 'rejected') console.error('send fail:', targets[i], r.reason?.message || r.reason);
    else console.log('send ok:', targets[i]);
  });
}

async function startUserbot() {
  await client.connect();
  console.log('Userbot connected.');
  await resolveAllTargets();

  // /probe : 아무 방에서나 입력하면 그 방의 chat_id 를 알려줌
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

  // 소스 방의 입금 문자를 규칙에 맞는 타겟 방들로 전달
  client.addEventHandler(async (event) => {
    try {
      const chatId = (event.chatId && event.chatId.toString()) || '';
      const msg = event.message;
      const original = msg?.message || '';

      if (chatId !== SOURCE_CHAT_ID) return;
      if (!msg || msg.isOut) return;
      if (!original.trim()) return;

      const targets = matchTargets(original);
      if (targets.length === 0) return;

      const content = formatMessage(original);
      await sendToTargets(content, targets);
    } catch (e) {
      console.error('forward error:', e.message);
    }
  }, new NewMessage({}));

  console.log('Listening on source chat:', SOURCE_CHAT_ID);
}

const PORT = Number(process.env.PORT || 10000);
const server = http.createServer((req, res) => {
  if (req.url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found');
});

(async () => {
  try {
    await startUserbot();
    server.listen(PORT, () => {
      console.log('Health server on', PORT);

      // Render 무료 플랜 슬립 방지용 자기 핑
      const KEEPALIVE_URL = `${BASE_URL}/healthz`;
      console.log('keepalive to:', KEEPALIVE_URL);
      const ping = () => {
        https.get(KEEPALIVE_URL, (res) => res.resume())
          .on('error', (e) => console.log('keepalive error:', e.message));
      };
      ping();
      setInterval(ping, 4 * 60 * 1000);
    });
  } catch (e) {
    console.error('startup error:', e.message);
    process.exit(1);
  }
})();
