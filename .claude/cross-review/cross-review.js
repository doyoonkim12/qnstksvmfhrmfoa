#!/usr/bin/env node
'use strict';

/**
 * Codex ↔ Claude 협업 키트 — 역할: Codex = 기획·설계·검토·수정 제안 / Claude Code = 구현·수정
 *
 *   node cross-review.js prompt   ← UserPromptSubmit 훅: 시작 스냅샷 + Codex 기획
 *   node cross-review.js stop     ← Stop 훅: Claude 가 멈출 때마다 Codex 검토
 *
 * 흐름 (전부 같은 Claude Code 세션 안에서, 단계 사이 대기 없음)
 *   0) 사장님 요청 → Codex 가 저장소를 읽고 기획·설계·작업 계획(완료 기준 포함)을 세움 → Claude 에게 전달
 *   1) Claude 가 계획대로 구현하고 멈춤 → Codex 가 자기 계획 기준으로 검토 (테스트와 동시에)
 *   2) FAIL → Codex 의 반박·수정 제안을 Claude 에게 → Claude 가 수정 (확실한 근거가 있으면 반론)
 *   3) 재수정은 maxFixRounds(기본 2)번까지. 그래도 남은 건 사장님 체크리스트로
 *   4) 기록은 reviews/ 에 (기획 → 회차별 검토 → 최종 정리), 요약은 세션에
 *   Codex 는 매번 전체 맥락(자기 계획·지난 지적·Claude 답)을 넘겨받아 같은 대화처럼 이어감
 *
 * 설정: .claude/cross-review/config.json  /  끄기: 환경변수 CROSS_REVIEW_OFF=1
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, spawn } = require('child_process');

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const KIT = path.join(ROOT, '.claude', 'cross-review');
// 세션마다 상태 파일을 따로 씀 (같은 폴더에서 Claude 여러 개가 동시에 돌아도 검토 기록이 안 섞이게)
let STATE_FILE = path.join(KIT, 'state.json');
function useSession(id) {
  const safe = String(id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80);
  if (safe) STATE_FILE = path.join(KIT, `state-${safe}.json`);
}

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
  // 기획: 요청이 들어오면 Codex 가 먼저 기획·설계·계획을 세워 Claude 에게 넘김
  planning: true,
  planMinChars: 20,            // 이보다 짧은 메시지("응", "진행해")는 기획하지 않음
  planTier: 'large',           // 기획에 쓸 modelTiers 단계
  planApproval: false,         // true: Claude 가 계획을 보여주고 사장님 승인 후 구현 (코인·결제 권장)
  planTimeoutSec: 600,
  // 심판: 재수정을 다 해도 Codex 와 Claude 가 안 맞으면 Gemini 가 항목마다 판정
  judge: true,
  judgeCmd: 'gemini -p "표준 입력으로 받은 글을 끝까지 읽고, 그 안의 지시와 출력 형식대로만 답하라."',
  judgeTimeoutSec: 300,
  judgeChromeFallback: true,   // CLI 가 안 되면 Claude 가 크롬 Gemini(임시 채팅)로 물어보게 함
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
    state.plan
      ? '너는 이 작업의 기획·설계 담당이다. 네가 세운 계획을 Claude(구현 담당)가 구현했다. 코드는 절대 수정하지 말고, 계획대로 됐는지 검토하고 반박·수정 제안만 한다.'
      : '너는 다른 AI(Claude)가 방금 고친 코드를 검증하는 리뷰어다. 코드는 절대 수정하지 말고 판정만 한다.',
    '',
    `[작업 요청] ${state.taskPrompt || '(알 수 없음)'}`,
    state.plan ? `[네가 세운 계획]\n${state.plan}\n` : '',
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
    state.plan ? '- 계획의 완료 기준(C1, C2 …)을 하나씩 확인하고, 못 채운 기준은 지적한다. 계획에 없던 불필요한 변경도 지적한다.' : '',
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
  const envPath = { codex: process.env.CROSS_REVIEW_CODEX, gemini: process.env.CROSS_REVIEW_GEMINI }[bin];
  if (envPath) return exists(envPath) ? withBin(envPath) : null;
  if (path.isAbsolute(bin)) return exists(bin) ? reviewCmd : null;
  const onPath = process.platform === 'win32' ? `where ${bin}` : `command -v ${bin}`;
  if (sh(onPath, { timeoutSec: 10 }).code === 0) return reviewCmd;
  const home = require('os').homedir();
  if (bin === 'gemini') {
    const g = (process.platform === 'win32'
      ? [path.join(process.env.APPDATA || '', 'npm', 'gemini.cmd')]
      : ['/opt/homebrew/bin/gemini', '/usr/local/bin/gemini', path.join(home, '.local/bin/gemini'), path.join(home, '.npm-global/bin/gemini')]
    ).find(exists);
    return g ? withBin(g) : null;
  }
  if (bin !== 'codex') return null;
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

// Codex 한 번 호출 → 마지막 답 텍스트
async function runCodex(prompt, cfg, tier, timeoutSec) {
  const out = path.join(KIT, `last-review-${process.pid}-${Date.now()}.txt`);
  let cmd = withTierArgs(cfg.reviewCmd, (cfg.modelTiers || {})[tier]);
  cmd = cmd.includes('{out}') ? cmd.replace('{out}', JSON.stringify(out)) : cmd;
  const r = await shAsync(cmd, { input: prompt, timeoutSec });
  let text = '';
  try { text = fs.readFileSync(out, 'utf8'); fs.unlinkSync(out); } catch { text = r.out; }
  return { text, raw: r.out, timedOut: r.timedOut, sec: r.sec };
}

// ---------- 기획 (Codex) ----------

function buildPlanPrompt(taskPrompt) {
  return [
    '너는 이 작업의 기획·설계 담당이다. 구현은 다른 AI(Claude Code)가 한다.',
    '저장소를 읽어서 현재 구조를 파악하고 계획만 세운다. 코드는 절대 수정하지 않는다.',
    '',
    `[사장님 요청] ${taskPrompt}`,
    '',
    '코드를 바꿀 필요가 없는 요청(질문, 확인, 잡담, 설명 요청)이면 첫 줄에 "PLAN: NONE" 만 출력하고 끝낸다.',
    '',
    '코드 작업이면 정확히 이 형식으로:',
    'PLAN: READY',
    '## 목표 (한두 줄)',
    '## 설계 (어떤 방식으로, 왜. 다른 방법을 버린 이유 한 줄)',
    '## 바꿀 파일 (파일 경로 — 무엇을)',
    '## 단계 (1. 2. 3. 순서대로, 각 단계는 작게)',
    '## 테스트 (추가·수정할 테스트와 돌릴 명령)',
    '## 위험 (돈·데이터·보안·배포에 닿는 부분, 없으면 "없음")',
    '## 이미지 (예시 사진·목업·일러스트가 필요하면: 저장 경로 — 무엇을 그릴지. 없으면 "없음")',
    '## 완료 기준 (C1, C2 … 검토 때 하나씩 확인할 수 있게 구체적으로)',
    '',
    '요청이 애매하면 가장 그럴듯한 해석으로 계획하고, ## 위험 에 "확인 필요: …" 로 적는다.',
  ].join('\n');
}

async function makePlan(taskPrompt, cfg) {
  const r = await runCodex(buildPlanPrompt(taskPrompt), cfg, cfg.planTier, cfg.planTimeoutSec);
  if (r.timedOut) return { status: 'NOT_PROVEN', body: 'Codex 기획 시간 초과', sec: r.sec };
  if (/^\s*PLAN:\s*NONE/im.test(r.text)) return { status: 'NONE', sec: r.sec };
  const m = r.text.match(/PLAN:\s*READY/i);
  if (!m) return { status: 'NOT_PROVEN', body: tail(r.text || r.raw || '(출력 없음)', 1500), sec: r.sec };
  return { status: 'READY', body: r.text.slice(m.index + m[0].length).trim(), sec: r.sec };
}

async function runReviewer(prompt, cfg, tier) {
  const { text, raw, timedOut, sec } = await runCodex(prompt, cfg, tier, cfg.reviewTimeoutSec);
  const r = { out: raw, timedOut, sec };
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

// ---------- 심판 (Gemini) ----------

function findingLines(body) {
  return body.split('\n').filter((l) => /^\s*-\s*\[F\d+\]/.test(l)).map((l) => l.replace(/^\s*-\s*/, ''));
}

function buildJudgePrompt(state, findings, claudeReply, diff, cfg) {
  return [
    '너는 두 AI 사이의 심판이다. Codex(기획·검토 담당)와 Claude(구현 담당)가 재수정을 다 하고도 의견이 갈렸다.',
    '코드는 수정하지 말고, 남은 지적 하나하나에 대해 누구 말이 맞는지만 판정한다.',
    '',
    `[사장님 요청] ${state.taskPrompt || '(알 수 없음)'}`,
    state.plan ? `[Codex 의 계획]\n${state.plan}\n` : '',
    '[Codex 의 남은 지적]', ...findings.map((f) => `- ${f}`), '',
    `[Claude 의 마지막 답/반박]\n${claudeReply || '(없음)'}`, '',
    '[현재 변경 내용]', tail(diff, Math.min(cfg.maxDiffChars, 40000)), '',
    '판정 기준: 실제 버그·요청 위반·돈/데이터/보안 위험이면 CODEX. 근거가 약하거나 취향 문제이거나 Claude 반박이 코드·테스트로 뒷받침되면 CLAUDE.',
    '',
    '출력 형식 (지적마다 정확히 한 줄, 다른 말 없이):',
    '- [F1] CODEX — 이유 한 줄',
    '- [F2] CLAUDE — 이유 한 줄',
  ].join('\n');
}

function parseRulings(text) {
  const out = {};
  for (const m of text.matchAll(/\[(F\d+)\]\s*(CODEX|CLAUDE)\s*[—\-:]*\s*(.*)/gi)) out[m[1].toUpperCase()] = { side: m[2].toUpperCase(), why: m[3].trim() };
  return out;
}

async function runJudge(prompt, cfg) {
  if (!cfg.judgeCmd) return { ok: false, why: 'Gemini CLI 심판은 꺼 둠 (judgeCmd 비움) — 크롬으로 판정' };
  const cmd = resolveReviewer(cfg.judgeCmd);
  if (!cmd) return { ok: false, why: 'gemini 를 이 컴퓨터에서 못 찾음' };
  const r = await shAsync(cmd, { input: prompt, timeoutSec: cfg.judgeTimeoutSec });
  if (r.timedOut) return { ok: false, why: 'Gemini 심판 시간 초과', sec: r.sec };
  const rulings = parseRulings(r.out);
  if (!Object.keys(rulings).length) return { ok: false, why: `Gemini 답을 못 읽음: ${tail(r.out.trim(), 300)}`, sec: r.sec };
  return { ok: true, rulings, sec: r.sec };
}

function finalize(state, cfg, { verdict, body, files, judged }) {
  if (judged && judged.ok) {
    const keep = []; const dropped = [];
    for (const l of findingLines(body)) {
      const id = (l.match(/\[(F\d+)\]/) || [])[1];
      const r = judged.rulings[id];
      if (r && r.side === 'CLAUDE') dropped.push(`${l}  ⚖️ Gemini: Claude 가 맞음 — ${r.why}`);
      else keep.push(r ? `${l}  ⚖️ Gemini: Codex 가 맞음 — ${r.why}` : l);
    }
    fs.appendFileSync(reviewFile(state, cfg), `\n## Gemini 심판 (${(judged.sec || 0).toFixed(0)}초)\n\n` +
      [...dropped.map((d) => `- ✅ 빠짐: ${d}`), ...keep.map((k) => `- ⬜ 남음: ${k}`)].join('\n') + '\n');
    body = keep.map((k) => `- ${k}`).join('\n');
    if (!keep.length) verdict = 'PASS';
  }
  const risky = files.filter((f) => cfg.riskyPaths.some((p) => f === p || f.startsWith(p)));
  const lines = ['', `## 최종 정리 (${now()})`, ''];
  lines.push(verdict === 'PASS' ? '- ✅ 마지막 검증 통과' : verdict === 'FAIL'
    ? `- ❌ 재수정 ${cfg.maxFixRounds}번 후에도 남은 지적이 있음` : '- ⚠️ 검증 결과 없음 (NOT_PROVEN) — 통과로 보지 않음');
  if ((state.history || []).length) lines.push(`- 지난 회차 지적 이력: ${state.history.length}회 (위 회차별 기록 참고)`);
  lines.push('', '### ⬜ 사장님 체크리스트');
  const items = [];
  if (verdict === 'FAIL') findingLines(body).forEach((l) => items.push(l));
  if (verdict === 'NOT_PROVEN') items.push(`검증이 안 됨: ${body.split('\n')[0]}`);
  risky.forEach((f) => items.push(`위험 경로 변경 — 사람 결재 필요: ${f}`));
  if (!items.length) items.push('없음');
  items.forEach((i) => lines.push(`- [ ] ${i}`));
  fs.appendFileSync(reviewFile(state, cfg), lines.join('\n') + '\n');
  return { items, file: state.file };
}

// ---------- 훅 진입점 ----------

let RAW_STDIN = '';
function readInput() {
  try { RAW_STDIN = fs.readFileSync(0, 'utf8'); } catch { RAW_STDIN = ''; }
  try { return JSON.parse(RAW_STDIN || '{}'); } catch { return {}; }
}

// UserPromptSubmit 훅이 Claude 에게 맥락을 넘기는 방법
function giveContext(text) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } }));
}

async function onPrompt(input) {
  const cfg = loadConfig();
  const state = loadState();
  const prompt = (input.prompt || '').trim();
  if (state.inReview) return; // 검토 루프 진행 중이면 기준점 유지
  // 계획을 받고 아직 구현 전인데 짧은 답("응", "진행해")이 오면 같은 작업으로 이어감
  if (state.planPending && prompt.length < cfg.planMinChars) return;

  const next = { ...snapshot(), taskPrompt: prompt.slice(0, 2000), fixRounds: 0, history: [] };
  saveState(next);
  if (!cfg.planning || prompt.length < cfg.planMinChars) return;

  const resolved = resolveReviewer(cfg.reviewCmd);
  if (!resolved) return; // codex 없으면 기획 없이 평소대로
  cfg.reviewCmd = resolved;

  const plan = await makePlan(prompt, cfg);
  if (plan.status === 'NONE') return;
  if (plan.status !== 'READY') {
    giveContext(`[Codex 기획 실패 — NOT_PROVEN] ${plan.body}\n평소처럼 진행하되, 기획 없이 진행한다는 사실을 사장님께 한 줄로 알려라.`);
    return;
  }
  next.plan = plan.body;
  next.planPending = true;
  const f = reviewFile(next, cfg);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, `# Codex ↔ Claude 작업 기록\n\n- 작업: ${prompt.slice(0, 500)}\n- 시작: ${now()}\n\n## Codex 기획 (${plan.sec.toFixed(0)}초)\n\n${plan.body}\n`);
  saveState(next);
  giveContext(
    '[Codex 기획] 이 작업의 기획·설계는 Codex 가 맡았고 너(Claude Code)는 구현 담당이다. 아래가 Codex 의 계획이다.\n' +
    (cfg.planApproval
      ? '먼저 계획을 사장님께 5줄 이내로 요약해 보여주고 "이대로 진행할까요?" 라고 물은 뒤 멈춰라. 승인 전에는 코드를 고치지 마라.\n'
      : '먼저 계획을 사장님께 3~5줄로 요약해 보여주고, 바로 이 계획대로 구현하라.\n') +
    '계획이 틀렸다는 확실한 근거(코드·테스트)가 있을 때만 다르게 하고, 그 이유를 답변에 적어라. 구현이 끝나면 Codex 가 이 계획의 완료 기준으로 검토한다.\n' +
    '계획의 ## 이미지 항목(예시 사진·목업)은 직접 만들지 말고 GPT 에게 맡겨라: node .claude/cross-review/gen-image.js "<설명>" <저장 경로>\n' +
    `기록 파일: ${next.file}\n\n${plan.body}`);
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
  state.planPending = false; // 계획이 구현돼서 검토까지 됨
  state.lastHash = hash;

  if (verdict === 'FAIL' && (state.fixRounds || 0) < cfg.maxFixRounds) {
    state.inReview = true;
    state.fixRounds = (state.fixRounds || 0) + 1;
    state.prevFindings = body;
    state.history = [...(state.history || []), body];
    saveState(state);
    process.stderr.write(
      `🔍 Codex 교차 검증 ${state.fixRounds}회차: FAIL — 재수정 ${state.fixRounds}/${cfg.maxFixRounds}\n\n${body}\n\n` +
      '위는 Codex(기획·검토 담당)의 반박과 수정 제안이다. 너(구현 담당)는 제안대로 수정하라.\n' +
      '제안이 틀렸다는 확실한 근거(테스트 출력, 파일:줄)가 있을 때만 고치지 말고 그 근거를 답변에 써라 — Codex 가 다음 회차에 다시 판단한다.\n' +
      '지적과 상관없는 코드는 건드리지 마라. 끝나고 멈추면 자동으로 다시 검증된다.\n');
    return 2;
  }

  // 재수정을 다 했는데도 지적이 남으면 Gemini 심판
  let judged = null; let chromeAsk = '';
  if (verdict === 'FAIL' && cfg.judge && findingLines(body).length) {
    const jp = buildJudgePrompt(state, findingLines(body), lastAssistantText(input.transcript_path), diff, cfg);
    judged = await runJudge(jp, cfg);
    if (!judged.ok && cfg.judgeChromeFallback) {
      const askFile = reviewFile(state, cfg).replace(/\.md$/, '-심판요청.md');
      fs.writeFileSync(askFile, jp);
      chromeAsk = `\n[Gemini CLI 심판 실패: ${judged.why}]\n` +
        '크롬(Claude in Chrome)이 연결돼 있으면: gemini.google.com 을 열고 **반드시 임시 채팅을 켠 뒤**, ' +
        `${path.relative(ROOT, askFile)} 내용을 그대로 붙여 넣어 판정을 받아라. 받은 답은 ` +
        `\`node .claude/cross-review/cross-review.js note ${state.file}\` 에 표준 입력으로 넣어 기록하고, ` +
        'Gemini 가 CLAUDE 로 판정한 항목은 체크리스트에서 "⚖️ Gemini: Claude 가 맞음"으로 표시해 보여라. ' +
        '크롬이 연결돼 있지 않으면 체크리스트를 그대로 보여라.\n';
    }
  }

  const { items, file } = finalize(state, cfg, { verdict, body, files, judged });
  const finalVerdict = judged && judged.ok && !findingLines(body).some((l) => {
    const id = (l.match(/\[(F\d+)\]/) || [])[1]; return !judged.rulings[id] || judged.rulings[id].side !== 'CLAUDE';
  }) ? 'PASS(Gemini 심판)' : verdict;
  saveState({ base: null, untracked: [], lastHash: hash, inReview: false, fixRounds: 0, history: [] });
  process.stderr.write(
    `🔍 Codex 교차 검증 종료: ${finalVerdict}. 기록 파일: ${file}\n\n` +
    '아래 체크리스트를 사장님께 그대로 보여주고 멈춰라. 코드는 더 고치지 마라.\n' + chromeAsk + '\n' +
    `[교차 검증 결과] ${finalVerdict} (재수정 ${state.fixRounds || 0}회${judged && judged.ok ? ', Gemini 심판 거침' : ''})\n` +
    items.map((i) => `- [ ] ${i}`).join('\n') + `\n기록: ${file}\n`);
  return 2;
}

if (require.main === module) {
  if (process.env.CROSS_REVIEW_OFF === '1') process.exit(0);
  const mode = process.argv[2];
  const input = readInput();
  useSession(input.session_id);
  try {
    if (mode === 'prompt') {
      onPrompt(input).then(() => process.exit(0)).catch((e) => {
        process.stderr.write(`cross-review 기획 오류(건너뜀): ${e.message}\n`);
        process.exit(0);
      });
      return;
    }
    if (mode === 'note') { // 크롬 Gemini 판정 등 사람이 아닌 출처의 답을 기록 파일에 붙임
      const target = path.resolve(ROOT, process.argv[3] || '');
      if (!process.argv[3] || path.relative(ROOT, target).startsWith('..')) { process.stderr.write('사용법: cross-review.js note <reviews/기록파일.md> < 답.txt\n'); process.exit(2); }
      const text = RAW_STDIN.trim();
      if (!text) { process.stderr.write('기록할 내용이 비어 있음\n'); process.exit(2); }
      fs.appendFileSync(target, `\n## Gemini 심판 (크롬, ${now()})\n\n${text}\n`);
      process.stdout.write(`기록함: ${path.relative(ROOT, target)}\n`); process.exit(0);
    }
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

module.exports = { parseRulings, buildJudgePrompt, useSession, buildPrompt, buildPlanPrompt, relevant, resolveReviewer, pickTier, withTierArgs, mergeTests, DEFAULTS };
