import { isPlanMonths, type PlanMonths } from '../subscription';

// 아임웹 입력폼 "월간구독N개월 신청" 알림 메일 파서.
// 발신: 사장님 네이버 릴레이(misomamy@naver.com) — 예약 알림과 같은 발신자. 제목은
// "[스테이 온 페이지] 월간구독4개월 신청에 새 응답이 접수되었습니다."
//
// 입력(raw)은 폴러가 만든 "제목: <subject>\n<html-to-text 본문>" 형식. 본문(2026-10-15 실메일):
//   등록자비회원 등록위치월간구독4개월 신청 등록시각2026-10-15 08:52 응답
//   이름 / 홍길동 / 연락처 / 01012345678 / 주소 / (38334) / 경북 청도군 … / 오마이뷱 / (빈 줄)
// 라벨(이름·연락처·주소)은 각자 한 줄, 값은 다음 줄(주소만 여러 줄, 빈 줄에서 끝).
// 개월 수는 제목(= 본문 "등록위치")의 "월간구독N개월" 에서 읽는다. 시작달은 메일에 없다.

const PLAN_RE = /월간구독\s*(\d+)\s*개월/;
const LABELS = new Set(['이름', '연락처', '주소']);
const ZIP_RE = /^\(\d{5}\)$/;

export interface ParsedSubscription {
  name: string;
  phone: string | null;
  address: string | null;
  address_detail: string | null;
  plan_months: PlanMonths;
}

export function isSubscriptionSubject(subject?: string | null): boolean {
  return !!subject && PLAN_RE.test(subject);
}

function valueAfter(lines: string[], label: string): string | null {
  const i = lines.indexOf(label);
  if (i === -1) return null;
  const v = lines[i + 1];
  if (!v || LABELS.has(v)) return null; // 값이 비어 다음 라벨이 바로 오는 경우
  return v;
}

export function parseSubscriptionEmail(raw: string): ParsedSubscription | null {
  const planMatch = raw.match(PLAN_RE);
  if (!planMatch) return null;
  const months = Number(planMatch[1]);
  if (!isPlanMonths(months)) return null; // 금액을 추측하지 않는다 — 파싱 실패로 가시화

  const lines = raw.split('\n').map((l) => l.trim());

  const name = valueAfter(lines, '이름');
  if (!name) return null;

  const phoneRaw = valueAfter(lines, '연락처');
  const phone = phoneRaw ? phoneRaw.replace(/\D/g, '') || null : null;

  const ai = lines.indexOf('주소');
  const addrLines: string[] = [];
  if (ai !== -1) {
    for (let j = ai + 1; j < lines.length && lines[j] !== ''; j++) addrLines.push(lines[j]);
  }

  let address: string | null = null;
  let addressDetail: string | null = null;
  if (addrLines.length > 0) {
    if (ZIP_RE.test(addrLines[0])) {
      address = addrLines.length > 1 ? `${addrLines[0]} ${addrLines[1]}` : addrLines[0];
      addressDetail = addrLines.slice(2).join(' ') || null;
    } else {
      address = addrLines[0];
      addressDetail = addrLines.slice(1).join(' ') || null;
    }
  }

  return { name, phone, address, address_detail: addressDetail, plan_months: months };
}
