#!/usr/bin/env node
'use strict';

/**
 * 이미지 생성 담당 = GPT. Claude Code 는 예시 사진·목업·일러스트를 직접 만들지 않고 이걸 부른다.
 *
 *   node .claude/cross-review/gen-image.js "<무엇을 그릴지>" <저장 경로.png> [--size 1024x1024]
 *
 * - config.json 의 imageCmd 로 Codex(GPT)를 불러 이미지를 만들게 한다
 * - 진짜 그림 파일(PNG/JPEG/WEBP)이 생겼는지 파일 앞부분까지 검사한다. 말만 하고 파일이 없으면 실패
 * - Codex 가 그림 말고 다른 파일을 바꾸면 경고한다 (되돌리지는 않음 — 사람이 확인)
 * - 성공/실패를 reviews/images.md 에 남긴다
 * 종료 코드: 0 성공, 1 실패(NOT_PROVEN), 2 사용법 오류
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const KIT = path.join(ROOT, '.claude', 'cross-review');

const DEFAULT_IMAGE_CMD = 'codex exec --sandbox workspace-write --skip-git-repo-check -o {log} -';

function loadCfg() {
  try { return JSON.parse(fs.readFileSync(path.join(KIT, 'config.json'), 'utf8')); } catch { return {}; }
}

function imageKind(file) {
  let b;
  try { b = fs.readFileSync(file); } catch { return null; }
  if (b.length < 1024) return null;
  if (b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP') return 'webp';
  return null;
}

function gitChanged() {
  const r = spawnSync('git', ['status', '--porcelain', '-z', '--untracked-files=all'], { cwd: ROOT, encoding: 'utf8' });
  return new Set((r.stdout || '').split('\0').filter(Boolean).map((l) => l.slice(3)));
}

function log(line) {
  const f = path.join(ROOT, loadCfg().outDir || 'reviews', 'images.md');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  if (!fs.existsSync(f)) fs.writeFileSync(f, '# GPT 이미지 생성 기록\n\n');
  fs.appendFileSync(f, `- ${new Date().toISOString().replace('T', ' ').slice(0, 16)} ${line}\n`);
}

function main() {
  const args = process.argv.slice(2);
  const sizeAt = args.indexOf('--size');
  const size = sizeAt >= 0 ? args.splice(sizeAt, 2)[1] : '1024x1024';
  const [desc, outArg] = args;
  if (!desc || !outArg) {
    process.stderr.write('사용법: node .claude/cross-review/gen-image.js "<무엇을 그릴지>" <저장 경로.png> [--size 1024x1024]\n');
    return 2;
  }
  const out = path.resolve(ROOT, outArg);
  const rel = path.relative(ROOT, out);
  if (rel.startsWith('..')) { process.stderr.write('저장 경로는 프로젝트 폴더 안이어야 합니다\n'); return 2; }
  fs.mkdirSync(path.dirname(out), { recursive: true });

  const cfg = loadCfg();
  const { resolveReviewer } = require('./cross-review.js');
  const cmd0 = resolveReviewer(cfg.imageCmd || DEFAULT_IMAGE_CMD);
  const fallback = '대신 쓸 방법: Higgsfield 연결이 있으면 generate_image 도구(기본 모델이 GPT 이미지)로 같은 설명을 넣어 만들고 저장한다.';
  if (!cmd0) {
    log(`❌ ${rel} — codex 를 못 찾음`);
    process.stderr.write(`이미지 생성 실패(NOT_PROVEN): codex 를 이 컴퓨터에서 못 찾음.\n${fallback}\n`);
    return 1;
  }

  const logFile = path.join(KIT, `last-image-${process.pid}.txt`);
  const cmd = cmd0.replace('{log}', JSON.stringify(logFile));
  const prompt = [
    '이미지 생성 도구를 써서 아래 설명대로 이미지를 하나 만들어라.',
    `- 저장 경로: ${rel}  (이 파일 하나만 만든다. 다른 파일은 만들거나 고치지 않는다)`,
    `- 크기: ${size}`,
    `- 설명: ${desc}`,
    '- 실제 사람 얼굴·실존 브랜드 로고는 넣지 않는다. 글자가 필요하면 짧게.',
    '',
    '끝나면 마지막 줄에 정확히: IMAGE: SAVED <경로>   또는   IMAGE: FAILED <이유>',
  ].join('\n');

  const before = gitChanged();
  const t0 = Date.now();
  const r = spawnSync(cmd, { cwd: ROOT, shell: true, encoding: 'utf8', input: prompt, timeout: (cfg.imageTimeoutSec || 600) * 1000, maxBuffer: 64 * 1024 * 1024 });
  const sec = ((Date.now() - t0) / 1000).toFixed(0);
  let said = '';
  try { said = fs.readFileSync(logFile, 'utf8'); fs.unlinkSync(logFile); } catch { said = (r.stdout || '') + (r.stderr || ''); }

  const extra = [...gitChanged()].filter((f) => !before.has(f) && f !== rel && !f.startsWith('reviews/') && !f.startsWith('.claude/'));
  if (extra.length) {
    process.stderr.write(`⚠️ Codex 가 그림 말고 다른 파일도 바꿨습니다: ${extra.join(', ')} — 사장님 확인 필요 (자동으로 되돌리지 않음)\n`);
  }

  const kind = imageKind(out);
  if (!kind) {
    const why = r.error && r.error.code === 'ETIMEDOUT' ? '시간 초과' : ((said.match(/IMAGE:\s*FAILED\s*(.*)/i) || [])[1] || '그림 파일이 안 생김');
    log(`❌ ${rel} — ${why} (${sec}초)${extra.length ? ` ⚠️다른 파일 변경: ${extra.join(', ')}` : ''}`);
    process.stderr.write(`이미지 생성 실패(NOT_PROVEN): ${why}\n${fallback}\n`);
    return 1;
  }
  log(`✅ ${rel} (${kind}, ${size}, ${sec}초) — ${desc.slice(0, 120)}${extra.length ? ` ⚠️다른 파일 변경: ${extra.join(', ')}` : ''}`);
  process.stdout.write(`이미지 생성 완료: ${rel} (${kind}, ${sec}초)\n`);
  return 0;
}

if (require.main === module) process.exit(main());
module.exports = { imageKind };
