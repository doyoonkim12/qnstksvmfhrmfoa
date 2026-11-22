'use strict';

const {
  TARGETS,
  TARGET_TITLES,
  EXCLUSIVE_RULES,
  ADDITIVE_RULES,
} = require('./config');

function normalize(s) { return (s || '').toString().trim().toLowerCase(); }
function includesAny(norm, arr) { return arr.some(k => norm.includes(normalize(k))); }

// 입금 포함 AND 출금 미포함
function shouldForward(text) {
  const t = (text || '').replace(/\s+/g, '');
  const hasDeposit = /입금/.test(t);
  const hasWithdraw = /출금/.test(t);
  return hasDeposit && !hasWithdraw;
}

function matchTargets(text, rules = { exclusive: EXCLUSIVE_RULES, additive: ADDITIVE_RULES }) {
  if (!shouldForward(text)) return [];
  const norm = normalize(text);
  const result = new Set();

  let exclusiveHit = false;
  for (const r of rules.exclusive) {
    if (includesAny(norm, r.keywords)) { exclusiveHit = true; r.targets.forEach(t => result.add(t)); }
  }
  if (exclusiveHit) return [...result];

  for (const r of rules.additive) {
    if (includesAny(norm, r.keywords)) r.targets.forEach(t => result.add(t));
  }
  return [...result];
}

// 종로 입금방(JONGNO_DEPOSIT)에 붙일 "어느 종로 방에서 왔는지" 타이틀
function calcOriginTitle(targets) {
  if (TARGETS.JONGNO1 && targets.includes(TARGETS.JONGNO1)) return TARGET_TITLES[TARGETS.JONGNO1];
  if (TARGETS.JONGNO2 && targets.includes(TARGETS.JONGNO2)) return TARGET_TITLES[TARGETS.JONGNO2];
  if (TARGETS.JONGNO3 && targets.includes(TARGETS.JONGNO3)) return TARGET_TITLES[TARGETS.JONGNO3];
  return null;
}

// 타겟 방 하나에 보낼 최종 본문 (타이틀 + 내용)
function buildBody(id, content, targets) {
  const originTitle = calcOriginTitle(targets);
  const title =
    (String(id) === String(TARGETS.JONGNO_DEPOSIT) && originTitle)
      ? originTitle
      : TARGET_TITLES[String(id)];
  return title ? `${title}\n${content}` : content;
}

module.exports = {
  normalize,
  includesAny,
  shouldForward,
  matchTargets,
  calcOriginTitle,
  buildBody,
};
