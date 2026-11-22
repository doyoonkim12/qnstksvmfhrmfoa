'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { TARGETS, TARGET_TITLES } = require('../src/config');
const { shouldForward, matchTargets, calcOriginTitle, buildBody } = require('../src/routing');

test('shouldForward: 입금만 있으면 전달, 출금이 섞이면 차단', () => {
  assert.equal(shouldForward('신한 입금 10,000'), true);
  assert.equal(shouldForward('신한 입 금 10,000'), true, '공백이 끼어 있어도 입금으로 인식');
  assert.equal(shouldForward('신한 출금 10,000'), false);
  assert.equal(shouldForward('입금 취소 후 출금'), false);
  assert.equal(shouldForward(''), false);
  assert.equal(shouldForward(undefined), false);
});

test('matchTargets: 출금 문자는 어떤 규칙에도 안 보냄', () => {
  assert.deepEqual(matchTargets('신한 110-***-038170 출금 10,000'), []);
});

test('matchTargets: 배타 규칙이 걸리면 누적 규칙은 무시', () => {
  // "신한"은 누적 규칙(용산)에 해당하지만, 배타 규칙(도산)이 우선
  assert.deepEqual(matchTargets('박*영(2982) 입금 10,000 신한'), [TARGETS.DOKSAN]);
  assert.deepEqual(matchTargets('문*영(6825) 입금 10,000'), [TARGETS.DOGOK]);
});

test('matchTargets: 누적 규칙은 타겟을 합치고 중복은 제거', () => {
  assert.deepEqual(
    matchTargets('문*영(8885) 입금 10,000'),
    [TARGETS.JONGNO3, TARGETS.JONGNO_DEPOSIT],
  );
  assert.deepEqual(
    matchTargets('877001**550 입금 10,000 신한'),
    [TARGETS.JONGNO2, TARGETS.JONGNO_DEPOSIT, TARGETS.YONGSAN],
  );
  // 110 계좌 + 신한 둘 다 용산 → 한 번만
  assert.deepEqual(matchTargets('신한 110-***-038170 입금 10,000'), [TARGETS.YONGSAN]);
});

test('matchTargets: 대소문자/앞뒤 공백 무시', () => {
  assert.deepEqual(matchTargets('  877001**550 입금  '), [TARGETS.JONGNO2, TARGETS.JONGNO_DEPOSIT]);
});

test('matchTargets: 아무 규칙에도 안 걸리면 빈 배열', () => {
  assert.deepEqual(matchTargets('[카카오뱅크] 이영희 입금 120,000원'), []);
});

test('calcOriginTitle: 종로 1 > 2 > 3 순서로 출처 타이틀 결정', () => {
  assert.equal(calcOriginTitle([TARGETS.JONGNO3, TARGETS.JONGNO_DEPOSIT]), '종로3차');
  assert.equal(calcOriginTitle([TARGETS.JONGNO3, TARGETS.JONGNO2]), '종로2차');
  assert.equal(calcOriginTitle([TARGETS.YONGSAN]), null);
});

test('buildBody: 종로 입금방에는 출처 종로 방 이름을 붙임', () => {
  const targets = [TARGETS.JONGNO2, TARGETS.JONGNO_DEPOSIT];
  assert.equal(buildBody(TARGETS.JONGNO_DEPOSIT, '내용', targets), '종로2차\n내용');
  assert.equal(buildBody(TARGETS.JONGNO2, '내용', targets), '종로2차\n내용');
});

test('buildBody: 타이틀이 있는 방은 타이틀 + 내용, 없으면 내용만', () => {
  assert.equal(buildBody(TARGETS.YONGSAN, '내용', [TARGETS.YONGSAN]), `${TARGET_TITLES[TARGETS.YONGSAN]}\n내용`);
  // 종로 출처 없이 종로 입금방만 걸리는 경우 (현재 규칙상 없음) → 타이틀 없이 내용만
  assert.equal(buildBody(TARGETS.JONGNO_DEPOSIT, '내용', [TARGETS.JONGNO_DEPOSIT]), '내용');
});
