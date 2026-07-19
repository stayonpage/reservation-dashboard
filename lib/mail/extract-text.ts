import { convert } from 'html-to-text';

// 여러 채널의 실제 알림 메일이 HTML 전용(text/plain 파트 없음)으로 확인됨(2026-07 실접속 검증,
// 네이버·스테이폴리오 둘 다 해당). mailparser의 .text가 비어있으면 .html을 텍스트로 변환해
// 폴백 — 그래야 라벨 기반 파서가 읽을 수 있는 형태가 된다.
export function extractPlainText(parsedMail: {
  text?: string;
  html?: string | false;
}): string {
  if (parsedMail.text?.trim()) return parsedMail.text;
  if (parsedMail.html) {
    return convert(parsedMail.html, { wordwrap: false });
  }
  return '';
}
