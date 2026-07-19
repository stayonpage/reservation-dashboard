import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { handleIncoming } from '../ingest';
import { parseNaverEmail } from '../parsers/naver';
import { extractPlainText } from './extract-text';

// 네이버 메일함을 IMAP으로 폴링해 예약 알림을 수신한다.
// 설계 근거: design doc 이슈3(멱등성) — Message-ID를 external_id로 써서
// 같은 메일을 여러 번 폴링해도 ingest_log의 unique(source, external_id)가 중복을 막는다.
//
// 정책 주의: 네이버는 2025-06부터 IMAP 접속에 2단계 인증 + "애플리케이션 비밀번호"를
// 사실상 강제한다(일반 로그인 비밀번호로는 접속 불가). NAVER_MAIL_APP_PASSWORD에
// 발급받은 앱 비밀번호를 넣어야 한다.

export interface PollResult {
  checked: number;
  parsed: number;
  duplicate: number;
  parseFailed: number;
  errors: string[];
}

export async function pollNaverInbox(): Promise<PollResult> {
  const user = process.env.NAVER_MAIL_USER;
  const pass = process.env.NAVER_MAIL_APP_PASSWORD;
  if (!user || !pass) {
    throw new Error(
      'NAVER_MAIL_USER / NAVER_MAIL_APP_PASSWORD 환경변수가 설정되지 않았습니다.',
    );
  }

  const client = new ImapFlow({
    host: 'imap.naver.com',
    port: 993,
    secure: true,
    auth: { user, pass },
    logger: false,
  });

  const result: PollResult = {
    checked: 0,
    parsed: 0,
    duplicate: 0,
    parseFailed: 0,
    errors: [],
  };

  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  try {
    // 미확인(안 읽은) 메일만 대상 — 처리 후 \Seen 처리해 재폴링 시 중복 조회 방지.
    // (ingest_log의 unique(source, external_id)가 최종 안전장치라, 이 필터는 성능 최적화용.)
    const searchResult = await client.search({ seen: false }, { uid: true });
    const uids = searchResult === false ? [] : searchResult;

    for (const uid of uids) {
      result.checked++;
      try {
        const { content } = await client.download(String(uid), undefined, {
          uid: true,
        });
        const parsedMail = await simpleParser(content);
        const externalId = parsedMail.messageId ?? `naver-uid-${uid}`;
        const text = extractPlainText(parsedMail);

        const outcome = await handleIncoming({
          source: 'naver_email',
          externalId,
          raw: text,
          parse: parseNaverEmail,
        });

        if (outcome.status === 'parsed') result.parsed++;
        else if (outcome.status === 'duplicate') result.duplicate++;
        else result.parseFailed++;

        // 처리(성공/중복/파싱실패 불문) 완료 → 읽음 처리해 다음 폴링에서 재조회 방지.
        // DB 오류(throw)면 여기 도달 못 하고 안 읽음 상태로 남아 다음 폴링에서 재시도.
        await client.messageFlagsAdd(
          { uid: String(uid) },
          ['\\Seen'],
          { uid: true },
        );
      } catch (e) {
        result.errors.push(`uid ${uid}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } finally {
    lock.release();
    await client.logout();
  }

  return result;
}
