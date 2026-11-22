'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { formatMessage } = require('../src/format');

const lines = (...xs) => xs.join('\n');

test('신한: 날짜 → 입금 → 이름 순, 계좌·잔액·Web발신 줄 제거', () => {
  const raw = lines('[Web발신]', '신한11/21 14:30', '110-***-038170', '입금 50,000', '잔액 1,234,000', '홍길동');
  assert.equal(formatMessage(raw), lines('신한11/21 14:30', '입금 50,000', '홍길동'));
});

test('KB: 이름이 입금보다 위에 있으면 날짜 → 이름 → 입금 → 금액', () => {
  const raw = lines('[Web발신]', '[KB]11/21 09:12', '877001**550', '김철수(301호)', '입금', '300,000', '잔액 500,000');
  assert.equal(formatMessage(raw), lines('[KB]11/21 09:12', '김철수(301호)', '입금', '300,000'));
});

test('카카오뱅크: 이름 → 날짜 → 입금 → 호실', () => {
  const raw = lines('[카카오뱅크]', '이영희', '11/21 10:00', '입금 120,000원', '1203호');
  assert.equal(formatMessage(raw), lines('이영희', '11/21 10:00', '입금 120,000원', '1203호'));
});

test('거래후잔액 줄과 7자리 이상 숫자 줄 제거', () => {
  const raw = lines('농협 11/20 23:59', '입금 10,000', '1234567890', '거래후잔액: 10,000', '박민수');
  assert.equal(formatMessage(raw), lines('농협 11/20 23:59', '입금 10,000', '박민수'));
});

test('Windows 줄바꿈(\\r\\n)도 처리', () => {
  const raw = ['신한11/21 14:30', '입금 50,000', '홍길동'].join('\r\n');
  assert.equal(formatMessage(raw), lines('신한11/21 14:30', '입금 50,000', '홍길동'));
});

test('정리할 게 하나도 안 남으면 원문 그대로 반환', () => {
  const raw = '박*영(2982) 입금 10,000 신한';
  assert.equal(formatMessage(raw), raw);
});

// ⚠️ 현재 동작 기록용: "*" 또는 "-" 가 들어간 줄은 계좌번호로 보고 지움.
// 그래서 "박*영(2982)" 같은 마스킹된 이름 줄도 결과에서 빠짐.
// 의도된 동작이 아니라면 이 테스트를 바꾸고 src/format.js 의 isMaskedAccount 를 고칠 것.
test('[현재 동작] 마스킹된 이름 줄(*)은 계좌로 간주되어 제거됨', () => {
  const raw = lines('[Web발신]', '신한11/21 14:30', '입금 10,000', '박*영(2982)', '잔액 5,000');
  assert.equal(formatMessage(raw), lines('신한11/21 14:30', '입금 10,000'));
});
