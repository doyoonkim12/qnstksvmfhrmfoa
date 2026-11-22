'use strict';

// 은행 입금 문자를 보기 좋게 다시 정리 (날짜 / 이름 / 입금 / 금액 / 호실)
function formatMessage(raw) {
  const lines = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);

  const isMaskedAccount = (s) => /[*-]/.test(s) || /^\d{6,}$/.test(s);
  const drop = (s) =>
    /^\d{7,}$/.test(s) ||
    /^\[?Web발신\]?$/i.test(s) ||
    /^거래후잔액\s*:/.test(s) ||
    /^잔액\s*[\d,]+/.test(s) ||
    /^\[?카카오뱅크\]?$/i.test(s) ||
    isMaskedAccount(s);

  const cleaned = lines.filter(s => !drop(s));

  const dateRegex = /\d{2}\/\d{2}\s+\d{2}:\d{2}/;
  const isKakao = lines.some(s => /카카오뱅크/i.test(s));

  const bankDateLine = cleaned.find(s => dateRegex.test(s) && /신한|\[?kb\]?|국민|농협|우리|ibk|하나|기업/i.test(s));
  const dateOnlyLine = cleaned.find(s => dateRegex.test(s));

  const depositLine = cleaned.find(s => /입금/.test(s));
  const depositIdx = depositLine ? cleaned.indexOf(depositLine) : -1;

  const looksLikeNameLoose = (s) => /[가-힣]{2,}/.test(s) && !/\d/.test(s) && !/입금/.test(s);
  const nameLike = (s) => /\(.+\)/.test(s) || /(호|실)/.test(s) || looksLikeNameLoose(s);
  const nameLine = cleaned.find(s => nameLike(s) && !/입금/.test(s));
  const nameIdx = nameLine ? cleaned.indexOf(nameLine) : -1;

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

  let extraLine = null;
  for (const s of cleaned) {
    if (s !== nameLine && !/입금/.test(s) && /(호|실)/.test(s)) { extraLine = s; break; }
  }
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

module.exports = { formatMessage };
