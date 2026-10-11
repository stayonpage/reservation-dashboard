// "전체 예약" 목록의 표시 규칙(순수 함수) — 컴포넌트에서 분리해 테스트한다.
//
//  · 정렬: 접수 최신순(detected_at 내림차순). 새로 들어온 예약이 맨 위. 같은 시각이면 체크인
//    늦은 순. (예전엔 체크인 늦은 순이라 12/27 같은 먼 미래 예약이 맨 위에 와서 "최근 순서"가
//    아니었다 — 2026-10 사용자 요청으로 변경.) 모든 탭(전체·신규·입금대기·확정·취소…) 공통.
//  · 6개월 이전 숨김: 체크아웃이 오늘 기준 6개월 전 날짜보다 앞선 예약은 목록에서만 뺀다.
//    DB 는 그대로 — 통계(매출·점유율)·달력은 과거 데이터를 계속 써야 하므로 삭제하지 않는다.

type ListRow = { status: string; check_in: string; check_out: string; detected_at: string };

/** 'YYYY-MM-DD' 의 6개월 전 같은 날짜. 그 달에 없는 날이면(8/31→2월) 말일로 보정. */
export function sixMonthsAgoISO(todayISO: string): string {
  const [y, m, d] = todayISO.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 - 6, 1)); // 6개월 전 달의 1일
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

export function listReservations<T extends ListRow>(
  reservations: readonly T[],
  tab: string, // 'all' 또는 예약 상태
  todayISO: string,
): T[] {
  const cutoff = sixMonthsAgoISO(todayISO);
  return reservations
    .filter((r) => r.check_out >= cutoff)
    .filter((r) => tab === 'all' || r.status === tab)
    .sort((a, b) => {
      // 문자열 비교 대신 시각으로 — 'Z'/'+00:00'·소수점 자릿수 표기가 섞여 와도(PostgREST vs
      // realtime payload) 순서가 어긋나지 않게.
      const diff = Date.parse(b.detected_at) - Date.parse(a.detected_at);
      if (diff !== 0 && !Number.isNaN(diff)) return diff;
      return b.check_in.localeCompare(a.check_in);
    });
}
