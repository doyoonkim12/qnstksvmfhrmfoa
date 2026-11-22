#!/usr/bin/env node
'use strict';

// PreToolUse(Bash) 훅: git commit / git push 직전에 스테이징된 변경에서
// 텔레그램 세션 문자열·API_HASH 같은 비밀값이 보이면 막는다 (exit 2 = 차단).

const { execSync } = require('child_process');

let input = '';
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  let cmd = '';
  try { cmd = JSON.parse(input).tool_input?.command || ''; } catch { process.exit(0); }
  if (!/\bgit\s+(commit|push)\b/.test(cmd)) process.exit(0);

  let diff = '';
  try {
    // commit: 스테이징된 것 / push: 아직 원격에 없는 커밋 전체
    diff = /\bgit\s+push\b/.test(cmd)
      ? execSync('git diff @{u}..HEAD 2>/dev/null || git diff HEAD~1..HEAD', { encoding: 'utf8', shell: '/bin/bash' })
      : execSync('git diff --cached', { encoding: 'utf8' });
  } catch { process.exit(0); }

  const added = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
  const patterns = [
    { name: 'Telegram SESSION 문자열', re: /SESSION\s*[=:]\s*['"]?1[A-Za-z0-9_\-+/=]{100,}/ },
    { name: '긴 base64 세션으로 보이는 값', re: /['"]1[A-Za-z0-9_\-+/=]{200,}['"]/ },
    { name: 'API_HASH 실제 값', re: /API_HASH\s*[=:]\s*['"]?(?!abcdef1234567890abcdef1234567890)[0-9a-f]{32}\b/ },
  ];
  const hits = [];
  for (const l of added) for (const p of patterns) if (p.re.test(l)) hits.push(p.name);
  if (/^\+\+\+ b\/(.*\/)?\.env(\.|$)/m.test(diff)) hits.push('.env 파일');

  if (hits.length) {
    console.error(`🚫 비밀값으로 보이는 내용이 커밋/푸시에 포함돼 있어서 막았습니다: ${[...new Set(hits)].join(', ')}\n` +
      'SESSION / API_ID / API_HASH 는 Render 환경변수에만 두고, 코드에서는 process.env 로 읽으세요.');
    process.exit(2);
  }
  process.exit(0);
});
