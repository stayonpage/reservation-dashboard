// 채널 파서 공용 유틸.

/** 'YYYY.MM.DD' / 'YYYY-MM-DD'(요일·괄호 노이즈 무시) 두 개를 체크인/아웃으로. */
export function parseTwoDates(
  s: string,
): { check_in: string; check_out: string } | null {
  const ds = [...s.matchAll(/(\d{4})[.\-](\d{2})[.\-](\d{2})/g)];
  if (ds.length < 2) return null;
  const fmt = (m: RegExpMatchArray) => `${m[1]}-${m[2]}-${m[3]}`;
  return { check_in: fmt(ds[0]), check_out: fmt(ds[1]) };
}

/** '2026년 7월 29일' 형태의 단일 한국어 날짜 → 'YYYY-MM-DD'. (스테이폴리오 이메일 포맷) */
export function parseKoreanDate(s: string): string | null {
  const m = s.match(/(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/);
  if (!m) return null;
  const pad = (n: string) => n.padStart(2, '0');
  return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
}

/** 한국 전화번호 정규화: '+821096406605' → '01096406605', 공백·하이픈 제거. */
export function normalizeKrPhone(raw: string): string | null {
  const digits = raw.replace(/[^\d+]/g, '');
  if (!digits) return null;
  if (digits.startsWith('+82')) return '0' + digits.slice(3);
  if (digits.startsWith('82') && digits.length >= 11) return '0' + digits.slice(2);
  return digits.replace(/^\+/, '');
}

/** '₩176,000' / '301,000원' 같은 첫 금액을 정수로. */
export function firstAmount(s: string): number | null {
  const m = s.match(/([\d,]{2,})/);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 라벨:값 형태(줄바꿈 구분이든 한 줄에 여러 개 붙어 나오든)로 나오는 메일 본문에서
 *  각 라벨의 값을 추출.
 *
 *  라벨 뒤에 한글 음절이 바로 이어지면(조사 등으로 다른 단어에 붙어 나온 것) 라벨로 인정하지
 *  않는다 — 그냥 text.indexOf(라벨)로 찾으면, 다른 라벨의 값 문구 안에 우연히 같은 글자가
 *  섞여 있을 때 그걸 라벨로 오인한다. 실사례(2026-07 네이버 취소 메일): "환불수수료
 *  0원(결제금액의 0%)" 문장 안의 "결제금액"을 실제 "결제금액" 라벨로 잘못 짚어서, 그 뒤 진짜
 *  결제내역 문자열이 "환불수수료"의 값으로, "의 0%)..."가 "결제금액"의 값으로 밀려버려 옵션
 *  이름이 깨졌다. 진짜 라벨은 뒤에 공백·숫자·영문·문장부호가 오지, 조사처럼 한글 글자가 바로
 *  붙지 않는다 — 줄 시작 여부로는 스테이폴리오처럼 라벨 여러 개가 한 줄에 붙어 나오는 포맷을
 *  못 찾게 되므로(회귀로 확인됨), 줄 위치 대신 이 경계 조건으로 판별한다. */
export function extractLabeledFields(
  text: string,
  labels: readonly string[],
): Record<string, string> {
  const positions = labels
    .map((l) => {
      const m = text.match(new RegExp(escapeRegExp(l) + '(?![가-힣])'));
      if (!m || m.index === undefined) return { l, i: -1 };
      return { l, i: m.index };
    })
    .filter((p) => p.i >= 0)
    .sort((a, b) => a.i - b.i);

  const out: Record<string, string> = {};
  for (let k = 0; k < positions.length; k++) {
    const { l, i } = positions[k];
    const start = i + l.length;
    const end = k + 1 < positions.length ? positions[k + 1].i : text.length;
    out[l] = text
      .slice(start, end)
      .replace(/^[\s:：]+/, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
  return out;
}
