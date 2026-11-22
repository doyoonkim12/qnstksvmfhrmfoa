'use strict';

// 소스(문자 수집) 방
const SOURCE_CHAT_ID = '-1002552721308';

// 타겟 목록
const TARGETS = {
  DOKSAN: '-4786506925',
  YONGSAN: '-5058405436',
  JONGNO1: '-4787323606',
  JONGNO2: '-4698985829',
  JONGNO3: '-1002996545753',
  DOGOK: '-4958074272',
  JONGNO_DEPOSIT: '-4940765825',
};

// 방별 타이틀
const TARGET_TITLES = {
  [TARGETS.YONGSAN]: '용산입금방',
  [TARGETS.JONGNO1]: '종로1차',
  [TARGETS.JONGNO2]: '종로2차',
  [TARGETS.JONGNO3]: '종로3차',
  [TARGETS.DOKSAN]: '도산메리트',
  [TARGETS.DOGOK]: '도곡',
};

// 배타 규칙: 하나라도 걸리면 누적 규칙은 무시하고 여기 타겟으로만 보냄
const EXCLUSIVE_RULES = [
  { keywords: ['박*영(2982)'], targets: [TARGETS.DOKSAN] },
  { keywords: ['문*영(6825)'], targets: [TARGETS.DOGOK] },
];

// 누적 규칙: 걸리는 규칙의 타겟을 모두 합쳐서 보냄
const ADDITIVE_RULES = [
  { keywords: ['문*영(8885)'],     targets: [TARGETS.JONGNO3, TARGETS.JONGNO_DEPOSIT] },
  { keywords: ['110-***-038170'], targets: [TARGETS.YONGSAN] },
  { keywords: ['877001**550'],    targets: [TARGETS.JONGNO2, TARGETS.JONGNO_DEPOSIT] },
  { keywords: ['신한'],            targets: [TARGETS.YONGSAN] },
];

const BASE_URL = 'https://qnstksvmfhrmfoa.onrender.com';

module.exports = {
  SOURCE_CHAT_ID,
  TARGETS,
  TARGET_TITLES,
  EXCLUSIVE_RULES,
  ADDITIVE_RULES,
  BASE_URL,
};
