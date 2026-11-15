// 직원이 "손님이 네이버에서 날짜를 바꿨다"를 대시보드에 접수할 때 쓰는 순수 함수들.
// (네이버는 변경 메일을 보내지 않고 스마트플레이스 앱 푸시로만 알린다 — 2026-11-14 은*은 건)

const DAY_MS = 86_400_000;

function toUtcMs(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

export function addDaysISO(iso: string, days: number): string {
  return new Date(toUtcMs(iso) + days * DAY_MS).toISOString().slice(0, 10);
}

/** 새 체크인을 골랐을 때 기존 박수를 유지한 체크아웃을 제안한다(박수가 1 미만이면 1박). */
export function defaultCheckOut(
  currentCheckIn: string,
  currentCheckOut: string,
  newCheckIn: string,
): string {
  const nights = Math.round((toUtcMs(currentCheckOut) - toUtcMs(currentCheckIn)) / DAY_MS);
  return addDaysISO(newCheckIn, nights >= 1 ? nights : 1);
}

/** 오류 메시지(없으면 null). */
export function validateDateChange(
  current: { check_in: string; check_out: string },
  newCheckIn: string,
  newCheckOut: string,
): string | null {
  if (!newCheckIn || !newCheckOut) return '체크인·체크아웃 날짜를 모두 입력해 주세요.';
  if (newCheckOut <= newCheckIn) return '체크아웃은 체크인보다 늦어야 합니다.';
  if (newCheckIn === current.check_in && newCheckOut === current.check_out) {
    return '현재와 같은 날짜입니다.';
  }
  return null;
}
