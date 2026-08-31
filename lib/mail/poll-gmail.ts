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
//
// ⚠️ 실사고(2026-08-12): "안읽음(seen:false)"만 검색해서 김석준님 예약 변경(재예약) 메일 하나가
// 통째로 유실됐다. 개인 메일함이라 우리 폴러가 확인하기 전에 사장님이 알림 보고 메일 앱에서
// 먼저 열어보기만 해도 "읽음"으로 바뀌어 폴러가 영영 못 찾는다 — 취소 메일은 잡혔는데 그 직후
// 온 재예약 메일만 조용히 빠짐(ingest_log에 흔적조차 없었음). 그래서 seen 여부로 거르지 않고
// 최근 며칠치를 매번 다시 훑는다 — handleIncoming이 (source, external_id) unique 제약으로
// 이미 처리한 메일은 값싸게 'duplicate'로 걸러주므로 재처리 비용은 없다.
const LOOKBACK_DAYS = 30;

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
    // 발신자로 좁히고(개인 메일함이라 다른 메일은 절대 건드리면 안 됨), seen 여부로는 거르지
    // 않는다(위 실사고 주석 참고) — 최근 LOOKBACK_DAYS일치를 매번 다시 훑되, 이미 처리한
    // 메일은 handleIncoming의 unique 제약이 값싸게 걸러준다.
    const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 3_600_000);
    const searchResult = await client.search(
      { since, from: STAYFOLIO_SENDER },
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
          receivedAt: parsedMail.date,
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
    // seen 여부로 거르지 않는 이유는 pollGmailStayfolioInbox 상단 주석 참고 — 같은 개인
    // 메일함이라 아임웹 알림도 똑같이 무음 유실될 수 있다.
    const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 3_600_000);
    const searchResult = await client.search(
      { since, from: IMWEB_RELAY_SENDER },
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
