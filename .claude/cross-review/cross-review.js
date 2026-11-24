#!/usr/bin/env node
'use strict';

/**
 * 교차 검증 키트 (Claude 수정 → Codex(GPT) 검증 → Claude 재수정 → … → 체크리스트)
 *
 *   node cross-review.js prompt   ← UserPromptSubmit 훅: 작업 시작 시점 스냅샷
 *   node cross-review.js stop     ← Stop 훅: Claude 가 멈출 때마다 검증
 *
 * 흐름
 *   1) Claude 가 코드를 바꾸고 멈춤 → 바뀐 코드 + 테스트 결과를 Codex 에 보내 검증
 *   2) FAIL → 지적 사항을 Claude 에게 돌려줌 (exit 2) → Claude 가 고치거나 근거로 반박
 *   3) 재수정은 maxFixRounds(기본 2)번까지. 그래도 남은 건 사장님 체크리스트로
 *   4) 끝나면 reviews/ 에 검증 파일을 남기고, Claude 가 세션에 요약을 올림
 *
 * 설정: .claude/cross-review/config.json  /  끄기: 환경변수 CROSS_REVIEW_OFF=1
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, spawn } = require('child_process');

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const KIT = path.join(ROOT, '.claude', 'cross-review');
const STATE_FILE = path.join(KIT, 'state.json');

const DEFAULTS = {
  // {out} = Codex 마지막 답을 저장할 파일. 프롬프트는 stdin 으로 들어감
  reviewCmd: 'codex exec --sandbox read-only --skip-git-repo-check -o {out} -',
  testCmd: '',                 // 예: "npm test", "pnpm verify:fast", "pytest -q"
  maxFixRounds: 2,             // 재수정 횟수 (검증은 최대 maxFixRounds+1 번)
  outDir: 'reviews',
  codeExtensions: ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs',
    '.java', '.kt', '.swift', '.rb', '.php', '.sql', '.json', '.yaml', '.yml', '.toml', '.sh'],
  exclude: ['.claude/', 'reviews/', 'node_modules/', 'dist/', 'build/', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'],
  riskyPaths: [],              // 이 경로가 바뀌면 PASS 여도 "사장님 결재" 항목을 붙임
  maxDiffChars: 60000,
  testTimeoutSec: 300,
  reviewTimeoutSec: 600,
  // 속도: 테스트와 Codex 검증을 동시에 돌림. 테스트 실패는 키트가 직접 FAIL 로 합침
  parallelTests: true,
  // 변경 크기별 Codex 옵션 (reviewCmd 의 exec 뒤에 끼워 넣음). 비우면 Codex 기본 모델
  // 예: "small": "-m <빠른모델> -c model_reasoning_effort=low"  ← 이름은 codex 도움말에서 확인
  modelTiers: { small: '', medium: '', large: '', risky: '' },
  tierLines: { small: 40, medium: 400 }, // 바뀐 줄 수 기준. 위험 경로가 있으면 무조건 risky
};

function loadConfig() {
  const f = path.join(KIT, 'config.json');
  if (!fs.existsSync(f)) return { ...DEFAULTS };
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(f, 'utf8')) }; }
  catch (e) {
    process.stderr.write(`cross-review: config.json 을 읽을 수 없어 기본값 사용 (${e.message})\n`);
    return { ...DEFAULTS };
  }
}
function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } }
function saveState(s) { fs.mkdirSync(KIT, { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

function git(args, opts = {}) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  return r.status === 0 ? r.stdout : '';
}
function sh(cmd, { input, timeoutSec }) {
  const r = spawnSync(cmd, { cwd: ROOT, shell: true, encoding: 'utf8', input, timeout: timeoutSec * 1000, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || ''), timedOut: r.error && r.error.code === 'ETIMEDOUT' };
}
// 비동기 버전 (테스트와 Codex 를 동시에 돌릴 때)
function shAsync(cmd, { input, timeoutSec }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(cmd, { cwd: ROOT, shell: true });
    let out = ''; let timedOut = false;
    const cap = (d) => { out += d; if (out.length > 4 * 1024 * 1024) out = out.slice(-2 * 1024 * 1024); };
    child.stdout.on('data', cap); child.stderr.on('data', cap);
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutSec * 1000);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out: out + e.message, timedOut, sec: (Date.now() - t0) / 1000 }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, timedOut, sec: (Date.now() - t0) / 1000 }); });
    child.stdin.on('error', () => {});
    child.stdin.end(input || '');
  });
}
const now = () => new Date().toISOString().replace('T', ' ').slice(0, 16);
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
const tail = (s, n) => (s.length > n ? '…(앞부분 생략)…\n' + s.slice(-n) : s);

// ---------- 스냅샷 / 변경 감지 ----------

function snapshot() {
  const head = git(['rev-parse', 'HEAD']).trim();
  const stash = git(['stash', 'create']).trim(); // 작업 트리 상태를 커밋으로 (아무것도 안 바꿈)
  const untracked = git(['ls-files', '-z', '--others', '--exclude-standard']).split('\0').filter(Boolean);
  return { base: stash || head, untracked };
}

function relevant(file, cfg) {
  if (cfg.exclude.some((e) => file === e || file.startsWith(e))) return false;
  return cfg.codeExtensions.includes(path.extname(file).toLowerCase());
}

function collectDiff(state, cfg) {
  if (!state.base) return { diff: '', files: [] };
  const names = git(['diff', '-z', '--name-only', state.base]).split('\0').filter(Boolean);
  const files = names.filter((f) => relevant(f, cfg));
  let diff = files.length ? git(['diff', '--no-color', state.base, '--', ...files]) : '';
  const known = new Set(state.untracked || []);
  const added = git(['ls-files', '-z', '--others', '--exclude-standard']).split('\0')
    .filter((f) => f && !known.has(f) && relevant(f, cfg));
  for (const f of added) {
    let body = '';
    try { body = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { continue; }
    diff += `\n=== 새 파일: ${f} ===\n${body.slice(0, 20000)}\n`;
    files.push(f);
  }
  return { diff, files };
}

// ---------- Claude 의 마지막 답 (반박 근거로 Codex 에게 전달) ----------

function lastAssistantText(transcriptPath) {
  try {
    const lines = fs.readFileSync(transcriptPath, 'utf8').trim().split('\n').slice(-200);
    for (let i = lines.length - 1; i >= 0; i--) {
      const j = JSON.parse(lines[i]);
      if (j.type !== 'assistant') continue;
      const text = (j.message?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
      if (text) return text.slice(-6000);
    }
  } catch { /* 없으면 빈 값 */ }
  return '';
}

// ---------- Codex 호출 ----------

function buildPrompt({ state, cfg, diff, files, tests, claudeReply }) {
  const round = (state.fixRounds || 0) + 1;
  return [
    '너는 다른 AI(Claude)가 방금 고친 코드를 검증하는 리뷰어다. 코드는 절대 수정하지 말고 판정만 한다.',
    '',
    `[작업 요청] ${state.taskPrompt || '(알 수 없음)'}`,
    `[검증 회차] ${round} / ${cfg.maxFixRounds + 1}`,
    `[바뀐 파일] ${files.join(', ')}`,
    '',
    state.prevFindings ? `[지난 회차 지적]\n${state.prevFindings}\n\n[Claude 의 답변/반박]\n${claudeReply || '(없음)'}\n` : '',
    tests ? `[테스트 결과] ${tests.summary}\n${tests.output}`
      : '[테스트] 검증과 동시에 따로 돌고 있고, 결과는 키트가 직접 판정한다. 테스트 실행 여부는 지적하지 마라.',
    '',
    '[변경 내용]',
    tail(diff, cfg.maxDiffChars),
    '',
    '규칙:',
    '- 실제 버그, 요청과 다른 동작, 깨지는 테스트, 보안·돈·데이터 손실 위험만 지적한다. 취향·스타일은 지적하지 않는다.',
    '- 근거(파일:줄, 테스트 출력)가 없는 지적은 하지 않는다.',
    '- Claude 의 반박이 근거로 타당하면 그 항목은 지적에서 뺀다.',
    tests ? '- 테스트가 실패하거나 실행되지 않았으면 그 사실을 지적한다.' : '',
    '',
    '출력 형식 (정확히):',
    '첫 줄: VERDICT: PASS  또는  VERDICT: FAIL',
    '그다음 지적마다 한 줄: - [F1] 파일:줄 — 문제 — 고칠 방향',
    'PASS 면 지적 줄 없이 "- 확인한 것: ..." 한두 줄만.',
  ].join('\n');
}

// reviewCmd 맨 앞 실행 파일을 찾는다. PATH 에 없으면 흔한 설치 위치를 뒤진다
// (예: macOS ChatGPT 앱에 들어 있는 codex). 못 찾으면 null.
function resolveReviewer(reviewCmd) {
  const [bin, ...rest] = reviewCmd.trim().split(/\s+/);
  const withBin = (p) => [JSON.stringify(p), ...rest].join(' ');
  const exists = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
  if (bin === 'codex' && process.env.CROSS_REVIEW_CODEX) {
    return exists(process.env.CROSS_REVIEW_CODEX) ? withBin(process.env.CROSS_REVIEW_CODEX) : null;
  }
  if (path.isAbsolute(bin)) return exists(bin) ? reviewCmd : null;
  const onPath = process.platform === 'win32' ? `where ${bin}` : `command -v ${bin}`;
  if (sh(onPath, { timeoutSec: 10 }).code === 0) return reviewCmd;
  if (bin !== 'codex') return null;
  const home = require('os').homedir();
  const candidates = process.platform === 'win32'
    ? [path.join(process.env.APPDATA || '', 'npm', 'codex.cmd'), path.join(home, '.local', 'bin', 'codex.exe')]
    : ['/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
      path.join(home, 'Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex'),
      '/opt/homebrew/bin/codex', '/usr/local/bin/codex',
      path.join(home, '.local/bin/codex'), path.join(home, '.npm-global/bin/codex')];
  const hit = candidates.find(exists);
  return hit ? withBin(hit) : null;
}

// 변경 크기 → 모델 단계. 위험 경로가 하나라도 있으면 risky
function pickTier(diff, files, cfg) {
  if (files.some((f) => cfg.riskyPaths.some((p) => f === p || f.startsWith(p)))) return 'risky';
  const changed = diff.split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l)).length;
  if (changed <= cfg.tierLines.small) return 'small';
  if (changed <= cfg.tierLines.medium) return 'medium';
  return 'large';
}

// 단계별 옵션을 reviewCmd 에 끼워 넣음: {model} 자리가 있으면 거기, 없으면 exec 바로 뒤
function withTierArgs(cmd, args) {
  if (cmd.includes('{model}')) return cmd.replace('{model}', args || '');
  if (!args) return cmd;
  return /\sexec(\s|$)/.test(cmd) ? cmd.replace(/\sexec(\s|$)/, ` exec ${args}$1`) : `${cmd} ${args}`;
}

async function runReviewer(prompt, cfg, tier) {
  const out = path.join(KIT, `last-review-${process.pid}.txt`);
  let cmd = withTierArgs(cfg.reviewCmd, (cfg.modelTiers || {})[tier]);
  cmd = cmd.includes('{out}') ? cmd.replace('{out}', JSON.stringify(out)) : cmd;
  const r = await shAsync(cmd, { input: prompt, timeoutSec: cfg.reviewTimeoutSec });
  let text = '';
  try { text = fs.readFileSync(out, 'utf8'); fs.unlinkSync(out); } catch { text = r.out; }
  const m = text.match(/VERDICT:\s*(PASS|FAIL)/i);
  if (r.timedOut || !m) return { verdict: 'NOT_PROVEN', body: r.timedOut ? '리뷰어 시간 초과' : tail(text || r.out || '(출력 없음)', 3000), sec: r.sec };
  const body = text.slice(m.index + m[0].length).trim();
  return { verdict: m[1].toUpperCase(), body, sec: r.sec };
}

async function runTests(cfg) {
  if (!cfg.testCmd) return { summary: '설정된 테스트 명령 없음 (config.json testCmd)', output: '', ok: null, sec: 0 };
  const r = await shAsync(cfg.testCmd, { timeoutSec: cfg.testTimeoutSec });
  const ok = r.code === 0 && !r.timedOut;
  return { summary: `${cfg.testCmd} → ${r.timedOut ? '시간 초과' : ok ? '통과' : `실패(exit ${r.code})`}`, output: tail(r.out, 4000), ok, sec: r.sec };
}

// 동시 실행 모드: 테스트 실패를 판정에 합침 (Codex 가 PASS 해도 테스트가 깨졌으면 FAIL)
function mergeTests(review, tests) {
  if (tests.ok !== false) return review;
  const t = `- [T1] 테스트 실패 — ${tests.summary} — 실패한 테스트를 고칠 것\n\n\`\`\`\n${tail(tests.output, 1500)}\n\`\`\``;
  if (review.verdict === 'PASS') return { ...review, verdict: 'FAIL', body: t };
  return { ...review, verdict: review.verdict === 'NOT_PROVEN' ? 'NOT_PROVEN' : 'FAIL', body: `${review.body}\n${t}` };
}

// ---------- 기록 파일 ----------

function reviewFile(state, cfg) {
  if (!state.file) state.file = path.join(cfg.outDir, `${stamp()}-검증.md`);
  return path.join(ROOT, state.file);
}

function appendRound(state, cfg, { verdict, body, tests, files, tier, timing }) {
  const f = reviewFile(state, cfg);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  if (!fs.existsSync(f)) fs.writeFileSync(f, `# 교차 검증 기록\n\n- 작업: ${state.taskPrompt || '(알 수 없음)'}\n- 시작: ${now()}\n`);
  fs.appendFileSync(f, `\n## ${(state.fixRounds || 0) + 1}회차 검증 — ${verdict} (${now()})\n\n- 바뀐 파일: ${files.join(', ')}\n` +
    `- 테스트: ${tests.summary}\n- 모델 단계: ${tier}${(cfg.modelTiers || {})[tier] ? ` (${cfg.modelTiers[tier]})` : ' (Codex 기본)'}\n` +
    `- 걸린 시간: ${timing}\n\n${body}\n`);
}

function finalize(state, cfg, { verdict, body, files }) {
  const risky = files.filter((f) => cfg.riskyPaths.some((p) => f === p || f.startsWith(p)));
  const lines = ['', `## 최종 정리 (${now()})`, ''];
  lines.push(verdict === 'PASS' ? '- ✅ 마지막 검증 통과' : verdict === 'FAIL'
    ? `- ❌ 재수정 ${cfg.maxFixRounds}번 후에도 남은 지적이 있음` : '- ⚠️ 검증 결과 없음 (NOT_PROVEN) — 통과로 보지 않음');
  if ((state.history || []).length) lines.push(`- 지난 회차 지적 이력: ${state.history.length}회 (위 회차별 기록 참고)`);
  lines.push('', '### ⬜ 사장님 체크리스트');
  const items = [];
  if (verdict === 'FAIL') body.split('\n').filter((l) => /^\s*-\s*\[F\d+\]/.test(l)).forEach((l) => items.push(l.replace(/^\s*-\s*/, '')));
  if (verdict === 'NOT_PROVEN') items.push(`검증이 안 됨: ${body.split('\n')[0]}`);
  risky.forEach((f) => items.push(`위험 경로 변경 — 사람 결재 필요: ${f}`));
  if (!items.length) items.push('없음');
  items.forEach((i) => lines.push(`- [ ] ${i}`));
  fs.appendFileSync(reviewFile(state, cfg), lines.join('\n') + '\n');
  return { items, file: state.file };
}

// ---------- 훅 진입점 ----------

function readInput() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { return {}; }
}

function onPrompt(input) {
  const state = loadState();
  if (state.inReview) return; // 검증 루프 진행 중이면 기준점 유지
  const snap = snapshot();
  saveState({ ...snap, taskPrompt: (input.prompt || '').slice(0, 500), fixRounds: 0, history: [] });
}

async function onStop(input) {
  const cfg = loadConfig();
  let state = loadState();
  if (!state.base) { state = { ...state, ...snapshot() }; saveState(state); return 0; }

  const { diff, files } = collectDiff(state, cfg);
  if (!diff.trim()) return 0;                                   // 코드 변경 없음
  const hash = crypto.createHash('sha1').update(diff).digest('hex');
  if (hash === state.lastHash) return 0;                        // 이미 검증한 상태 그대로

  const resolved = resolveReviewer(cfg.reviewCmd);
  if (!resolved) {
    const bin = cfg.reviewCmd.trim().split(/\s+/)[0];
    process.stderr.write(`cross-review: 리뷰어 '${bin}' 을(를) 이 컴퓨터에서 못 찾아 교차 검증을 건너뜀 ` +
      '(환경변수 CROSS_REVIEW_CODEX 에 전체 경로를 넣거나 config.json reviewCmd 확인)\n');
    return 0;
  }
  cfg.reviewCmd = resolved;

  const t0 = Date.now();
  const tier = pickTier(diff, files, cfg);
  const claudeReply = lastAssistantText(input.transcript_path);
  let tests; let review;
  if (cfg.parallelTests) {
    const prompt = buildPrompt({ state, cfg, diff, files, tests: null, claudeReply });
    [tests, review] = await Promise.all([runTests(cfg), runReviewer(prompt, cfg, tier)]);
    review = mergeTests(review, tests);
  } else {
    tests = await runTests(cfg);
    review = await runReviewer(buildPrompt({ state, cfg, diff, files, tests, claudeReply }), cfg, tier);
  }
  const { verdict, body } = review;
  const timing = `총 ${((Date.now() - t0) / 1000).toFixed(0)}초 (테스트 ${tests.sec.toFixed(0)}초, Codex ${review.sec.toFixed(0)}초, ${cfg.parallelTests ? '동시 실행' : '순서대로'})`;

  appendRound(state, cfg, { verdict, body, tests, files, tier, timing });
  state.lastHash = hash;

  if (verdict === 'FAIL' && (state.fixRounds || 0) < cfg.maxFixRounds) {
    state.inReview = true;
    state.fixRounds = (state.fixRounds || 0) + 1;
    state.prevFindings = body;
    state.history = [...(state.history || []), body];
    saveState(state);
    process.stderr.write(
      `🔍 Codex 교차 검증 ${state.fixRounds}회차: FAIL — 재수정 ${state.fixRounds}/${cfg.maxFixRounds}\n\n${body}\n\n` +
      '각 지적을 고쳐라. 지적이 틀렸다고 판단되면 고치지 말고 근거(테스트 출력, 파일:줄)를 대고 반박을 답변에 써라.\n' +
      '지적과 상관없는 코드는 건드리지 마라. 끝나고 멈추면 자동으로 다시 검증된다.\n');
    return 2;
  }

  const { items, file } = finalize(state, cfg, { verdict, body, files });
  saveState({ base: null, untracked: [], lastHash: hash, inReview: false, fixRounds: 0, history: [] });
  process.stderr.write(
    `🔍 Codex 교차 검증 종료: ${verdict}. 기록 파일: ${file}\n\n` +
    '아래 체크리스트를 사장님께 그대로 보여주고 멈춰라. 코드는 더 고치지 마라.\n\n' +
    `[교차 검증 결과] ${verdict} (재수정 ${state.fixRounds || 0}회)\n` +
    items.map((i) => `- [ ] ${i}`).join('\n') + `\n기록: ${file}\n`);
  return 2;
}

if (require.main === module) {
  if (process.env.CROSS_REVIEW_OFF === '1') process.exit(0);
  const mode = process.argv[2];
  const input = readInput();
  try {
    if (mode === 'prompt') { onPrompt(input); process.exit(0); }
    if (mode === 'stop') {
      onStop(input).then((code) => process.exit(code)).catch((e) => {
        process.stderr.write(`cross-review 오류(검증 건너뜀): ${e.message}\n`);
        process.exit(0);
      });
      return;
    }
  } catch (e) {
    process.stderr.write(`cross-review 오류(검증 건너뜀): ${e.message}\n`);
    process.exit(0); // 키트 오류로 Claude 작업이 막히지 않게
  }
  process.exit(0);
}

module.exports = { buildPrompt, relevant, resolveReviewer, pickTier, withTierArgs, mergeTests, DEFAULTS };
