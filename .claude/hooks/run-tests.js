#!/usr/bin/env node
'use strict';

// PostToolUse(Edit|Write) 훅: .js 파일을 고치면 바로 문법 검사 + 테스트.
// 실패하면 exit 2 로 결과를 Claude 에게 돌려줘서 스스로 고치게 한다.

const { spawnSync } = require('child_process');

let input = '';
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  let file = '';
  try { file = JSON.parse(input).tool_input?.file_path || ''; } catch { process.exit(0); }
  if (!file.endsWith('.js') || file.includes('/.claude/')) process.exit(0);

  const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  for (const [label, args] of [['문법 검사', ['run', 'check']], ['테스트', ['test']]]) {
    const r = spawnSync('npm', ['--silent', ...args], { cwd, encoding: 'utf8' });
    if (r.status !== 0) {
      const out = ((r.stdout || '') + (r.stderr || '')).split('\n').filter((l) => !/^\s*ok \d/.test(l)).join('\n');
      console.error(`❌ ${label} 실패 (${file} 수정 후)\n${out.slice(-4000)}`);
      process.exit(2);
    }
  }
  process.exit(0);
});
