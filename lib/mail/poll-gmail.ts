import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { handleIncoming } from '../ingest';
import { parseStayfolioEmailWithRealId } from '../parsers/stayfolio-email-enrich';
import { parseImwebEmail } from '../parsers/imweb-email';
import { extractPlainText } from './extract-text';

// 지메일(개인 계정)을 IMAP으로 폴링해 스테이폴리오 예약 알림을 수신한다.
// 스테이폴리오가 구글 캘린더 연동을 중단하고 이메일로 전환(2026-07 확인).
//
// ⚠️ 이 메일함은 사장님 개인 지메일이다(933건, 안읽음 859건 확인 — 예약 알림 외 잡다한
// 메일이 훨씬 많음). 반드시 발신자를 hello@stayfolio.com으로 좁혀서 검색해야 한다 —
// 그러지 않으면 무관한 개인 메일까지 \Seen 처리해버리는 부작용이 생긴다.
//
// 정책: 지메일도 네이버와 동일하게 2단계 인증 + "앱 비밀번호" 필요.

export interface PollResult {
  checked: number;
  parsed: number;
  duplicate: number;
  parseFailed: number;
  errors: string[];
}

const STAYFOLIO_SENDER = 'hello@stayfolio.com';

export async function pollGmailStayfolioInbox(): Promise<PollResult> {
  const user = process.env.GMAIL_MAIL_USER;
  const pass = process.env.GMAIL_MAIL_APP_PASSWORD;
  if (!user || !pass) {
    throw new Error(
      'GMAIL_MAIL_USER / GMAIL_MAIL_APP_PASSWORD 환경변수가 설정되지 않았습니다.',
    );
  }

  const client = new ImapFlow({
    host: 'imap.gmail.com',
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
    // 반드시 발신자로 좁힌다 — 개인 메일함이라 다른 메일은 절대 건드리면 안 됨.
    const searchResult = await client.search(
      { seen: false, from: STAYFOLIO_SENDER },
      { uid: true },
    );
    const uids = searchResult === false ? [] : searchResult;

    for (const uid of uids) {
      result.checked++;
      try {
        const { content } = await client.download(String(uid), undefined, {
          uid: true,
        });
        const parsedMail = await simpleParser(content);
        const externalId = parsedMail.messageId ?? `gmail-uid-${uid}`;
        const text = extractPlainText(parsedMail);

        const outcome = await handleIncoming({
          source: 'stayfolio_email',
          externalId,
          raw: text,
          parse: parseStayfolioEmailWithRealId,
        });

        if (outcome.status === 'parsed') result.parsed++;
        else if (outcome.status === 'duplicate') result.duplicate++;
        else result.parseFailed++;

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

// 아임웹이 이 같은 지메일로 예약 알림을 보낸다(2026-07 확인) — 발신자는 아임웹이 아니라
// 사장님 개인 네이버 계정(misomamy@naver.com). 이 계정엔 "앱 이름: 아임웹"으로 발급된
// 전용 앱 비밀번호가 있어(네이버 2단계인증 알림메일로 확인) 아임웹 SMTP 릴레이 용도로만 쓰인다
// — 발신자 필터만으로 충분히 안전하다.
//
// 제목 접두어로는 좁히지 않는다: "스테이 온 페이지"(4개 방) 외에 "오마이북"(게스트하우스 2개
// 유닛) 등 여러 브랜드가 같은 사이트/계정에서 알림을 보낼 수 있고(2026-07 네이버 예약 메일로
// 확인 — 제목이 "오마이북"으로 옴), 브랜드별 제목을 일일이 화이트리스트하면 새 브랜드가 생길
// 때마다 놓친다.
const IMWEB_RELAY_SENDER = 'misomamy@naver.com';

export async function pollGmailImwebInbox(): Promise<PollResult> {
  const user = process.env.GMAIL_MAIL_USER;
  const pass = process.env.GMAIL_MAIL_APP_PASSWORD;
  if (!user || !pass) {
    throw new Error(
      'GMAIL_MAIL_USER / GMAIL_MAIL_APP_PASSWORD 환경변수가 설정되지 않았습니다.',
    );
  }

  const client = new ImapFlow({
    host: 'imap.gmail.com',
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
    const searchResult = await client.search(
      { seen: false, from: IMWEB_RELAY_SENDER },
      { uid: true },
    );
    const uids = searchResult === false ? [] : searchResult;

    for (const uid of uids) {
      result.checked++;
      try {
        const { content } = await client.download(String(uid), undefined, {
          uid: true,
        });
        const parsedMail = await simpleParser(content);
        const externalId = parsedMail.messageId ?? `gmail-uid-${uid}`;
        const text = extractPlainText(parsedMail);

        const outcome = await handleIncoming({
          source: 'imweb_email',
          externalId,
          raw: text,
          parse: parseImwebEmail,
        });

        if (outcome.status === 'parsed') result.parsed++;
        else if (outcome.status === 'duplicate') result.duplicate++;
        else result.parseFailed++;

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
