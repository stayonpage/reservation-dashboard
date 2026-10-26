import { describe, it, expect, vi, beforeEach } from 'vitest';

// 지메일은 개인 계정이라(933건, 안읽음 859건 확인) — 발신자 제한이 실제로 걸리는지가
// 가장 중요한 테스트다. 나머지는 poll-naver와 동일한 오케스트레이션 로직.

const mockLock = { release: vi.fn() };
const mockClient = {
  connect: vi.fn(),
  getMailboxLock: vi.fn().mockResolvedValue(mockLock),
  search: vi.fn(),
  download: vi.fn(),
  messageFlagsAdd: vi.fn(),
  logout: vi.fn(),
};

vi.mock('imapflow', () => ({
  ImapFlow: vi.fn(() => mockClient),
}));

const mockParsed = vi.fn();
vi.mock('mailparser', () => ({
  simpleParser: (...args: unknown[]) => mockParsed(...args),
}));

const mockHandleIncoming = vi.fn();
vi.mock('../ingest', () => ({
  handleIncoming: (...args: unknown[]) => mockHandleIncoming(...args),
}));

vi.mock('../parsers/stayfolio-email-enrich', () => ({
  parseStayfolioEmailWithRealId: vi.fn(),
}));

vi.mock('../parsers/imweb-email', () => ({
  parseImwebEmail: vi.fn(),
}));

const mockHandleSubscription = vi.fn();
vi.mock('../ingest-subscription', () => ({
  handleSubscriptionIncoming: (...args: unknown[]) => mockHandleSubscription(...args),
}));

import { pollGmailStayfolioInbox, pollGmailImwebInbox } from './poll-gmail';

describe('pollGmailStayfolioInbox', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.getMailboxLock.mockResolvedValue(mockLock);
    process.env.GMAIL_MAIL_USER = 'test@gmail.com';
    process.env.GMAIL_MAIL_APP_PASSWORD = 'app-pw';
  });

  it('개인 메일함 보호: 검색 조건에 반드시 hello@stayfolio.com 발신자 제한이 걸린다', async () => {
    mockClient.search.mockResolvedValue([]);
    await pollGmailStayfolioInbox();

    expect(mockClient.search).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'hello@stayfolio.com', since: expect.any(Date) }),
      expect.anything(),
    );
  });

  it('★ 안전장치: seen 여부로 거르지 않는다(사람이 먼저 읽어도 잡아야 함 — 2026-08-12 실사고)', async () => {
    mockClient.search.mockResolvedValue([]);
    await pollGmailStayfolioInbox();

    expect(mockClient.search).toHaveBeenCalledWith(
      expect.not.objectContaining({ seen: expect.anything() }),
      expect.anything(),
    );
  });

  it('환경변수 없으면 에러', async () => {
    delete process.env.GMAIL_MAIL_USER;
    await expect(pollGmailStayfolioInbox()).rejects.toThrow(/환경변수/);
  });

  it('정상 파싱된 메일은 stayfolio_email 소스로 저장되고 읽음 처리된다', async () => {
    mockClient.search.mockResolvedValue([501]);
    mockClient.download.mockResolvedValue({ content: Buffer.from('raw') });
    mockParsed.mockResolvedValue({ messageId: '<sf-1>', text: '예약 내용' });
    mockHandleIncoming.mockResolvedValue({ status: 'parsed', reservationId: 'r1' });

    const result = await pollGmailStayfolioInbox();

    expect(result).toEqual({ checked: 1, parsed: 1, duplicate: 0, parseFailed: 0, errors: [] });
    expect(mockHandleIncoming).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'stayfolio_email', externalId: '<sf-1>' }),
    );
    expect(mockClient.messageFlagsAdd).toHaveBeenCalledWith(
      { uid: '501' },
      ['\\Seen'],
      { uid: true },
    );
  });

  it('★ 취소 제목("…취소하였습니다")이면 본문 앞에 취소 표시를 붙여 넘긴다(2026-10-11 김민주님 사례)', async () => {
    mockClient.search.mockResolvedValue([502]);
    mockClient.download.mockResolvedValue({ content: Buffer.from('raw') });
    mockParsed.mockResolvedValue({
      messageId: '<sf-cancel>',
      subject: '스테이폴리오 홍길동(a@b.com)님이 확정 전 예약을 취소하였습니다. - 스테이온페이지(page26)',
      text: '스테이온페이지(page26) 본문',
    });
    mockHandleIncoming.mockResolvedValue({ status: 'parsed', reservationId: 'r1' });

    await pollGmailStayfolioInbox();

    expect(mockHandleIncoming).toHaveBeenCalledWith(
      expect.objectContaining({ externalId: '<sf-cancel>', raw: '[예약 취소] 스테이온페이지(page26) 본문' }),
    );
  });

  it('★ 회귀: 일반 예약 제목이면 본문을 그대로 넘긴다', async () => {
    mockClient.search.mockResolvedValue([503]);
    mockClient.download.mockResolvedValue({ content: Buffer.from('raw') });
    mockParsed.mockResolvedValue({
      messageId: '<sf-book>',
      subject: '스테이폴리오 홍길동(a@b.com)님의 예약내용입니다. - 스테이온페이지(page26)',
      text: '스테이온페이지(page26) 본문',
    });
    mockHandleIncoming.mockResolvedValue({ status: 'parsed', reservationId: 'r1' });

    await pollGmailStayfolioInbox();

    expect(mockHandleIncoming).toHaveBeenCalledWith(
      expect.objectContaining({ raw: '스테이온페이지(page26) 본문' }),
    );
  });

  it('DB 오류 시 읽음 처리 안 함(재시도 위해) — 개인 메일함이라도 예외 없이 동일 원칙', async () => {
    mockClient.search.mockResolvedValue([9]);
    mockClient.download.mockResolvedValue({ content: Buffer.from('raw') });
    mockParsed.mockResolvedValue({ messageId: '<m9>', text: 't' });
    mockHandleIncoming.mockRejectedValue(new Error('DB down'));

    const result = await pollGmailStayfolioInbox();

    expect(result.errors).toHaveLength(1);
    expect(mockClient.messageFlagsAdd).not.toHaveBeenCalled();
  });

  it('mailbox lock은 항상 release되고 로그아웃된다', async () => {
    mockClient.search.mockResolvedValue([]);
    await pollGmailStayfolioInbox();
    expect(mockLock.release).toHaveBeenCalled();
    expect(mockClient.logout).toHaveBeenCalled();
  });
});

describe('pollGmailImwebInbox', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.getMailboxLock.mockResolvedValue(mockLock);
    process.env.GMAIL_MAIL_USER = 'test@gmail.com';
    process.env.GMAIL_MAIL_APP_PASSWORD = 'app-pw';
  });

  it('전용 릴레이 계정(misomamy@naver.com) 발신자로 좁혀 검색한다(제목은 브랜드별로 달라 필터링 안 함)', async () => {
    mockClient.search.mockResolvedValue([]);
    await pollGmailImwebInbox();

    expect(mockClient.search).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'misomamy@naver.com',
        since: expect.any(Date),
      }),
      expect.anything(),
    );
    expect(mockClient.search).toHaveBeenCalledWith(
      expect.not.objectContaining({ subject: expect.anything() }),
      expect.anything(),
    );
  });

  it('★ 안전장치: seen 여부로 거르지 않는다(같은 개인 메일함이라 stayfolio와 동일한 위험)', async () => {
    mockClient.search.mockResolvedValue([]);
    await pollGmailImwebInbox();

    expect(mockClient.search).toHaveBeenCalledWith(
      expect.not.objectContaining({ seen: expect.anything() }),
      expect.anything(),
    );
  });

  it('정상 파싱된 메일은 imweb_email 소스로 저장되고 읽음 처리된다', async () => {
    mockClient.search.mockResolvedValue([701]);
    mockClient.download.mockResolvedValue({ content: Buffer.from('raw') });
    mockParsed.mockResolvedValue({ messageId: '<iw-1>', text: '예약 내용' });
    mockHandleIncoming.mockResolvedValue({ status: 'parsed', reservationId: 'r2' });

    const result = await pollGmailImwebInbox();

    expect(result).toEqual({ checked: 1, parsed: 1, duplicate: 0, parseFailed: 0, errors: [] });
    expect(mockHandleIncoming).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'imweb_email', externalId: '<iw-1>' }),
    );
    expect(mockClient.messageFlagsAdd).toHaveBeenCalledWith(
      { uid: '701' },
      ['\\Seen'],
      { uid: true },
    );
  });

  it('DB 오류 시 읽음 처리 안 함(재시도 위해)', async () => {
    mockClient.search.mockResolvedValue([9]);
    mockClient.download.mockResolvedValue({ content: Buffer.from('raw') });
    mockParsed.mockResolvedValue({ messageId: '<m9>', text: 't' });
    mockHandleIncoming.mockRejectedValue(new Error('DB down'));

    const result = await pollGmailImwebInbox();

    expect(result.errors).toHaveLength(1);
    expect(mockClient.messageFlagsAdd).not.toHaveBeenCalled();
  });

  it('★ 제목이 월간구독 신청이면 구독 수집기로 보내고 예약 수집기는 부르지 않는다(읽음 처리 포함)', async () => {
    mockClient.search.mockResolvedValue([801]);
    mockClient.download.mockResolvedValue({ content: Buffer.from('raw') });
    const date = new Date('2026-10-14T23:53:08Z');
    mockParsed.mockResolvedValue({
      messageId: '<sub-1>',
      subject: '[스테이 온 페이지] 월간구독4개월 신청에 새 응답이 접수되었습니다.',
      text: '이름\n홍길동',
      date,
    });
    mockHandleSubscription.mockResolvedValue({ status: 'parsed' });

    const result = await pollGmailImwebInbox();

    expect(mockHandleSubscription).toHaveBeenCalledWith({
      externalId: '<sub-1>',
      raw: '제목: [스테이 온 페이지] 월간구독4개월 신청에 새 응답이 접수되었습니다.\n이름\n홍길동',
      appliedAt: date,
    });
    expect(mockHandleIncoming).not.toHaveBeenCalled();
    expect(result).toEqual({ checked: 1, parsed: 1, duplicate: 0, parseFailed: 0, errors: [] });
    expect(mockClient.messageFlagsAdd).toHaveBeenCalledWith({ uid: '801' }, ['\\Seen'], { uid: true });
  });

  it('★ 회귀: 일반 예약 메일(제목에 월간구독 없음)은 기존대로 handleIncoming', async () => {
    mockClient.search.mockResolvedValue([802]);
    mockClient.download.mockResolvedValue({ content: Buffer.from('raw') });
    mockParsed.mockResolvedValue({
      messageId: '<iw-2>',
      subject: '[스테이 온 페이지] 예약이 접수되어 입금 확인이 필요합니다.',
      text: '예약 내용',
    });
    mockHandleIncoming.mockResolvedValue({ status: 'parsed', reservationId: 'r9' });

    await pollGmailImwebInbox();

    expect(mockHandleIncoming).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'imweb_email', externalId: '<iw-2>' }),
    );
    expect(mockHandleSubscription).not.toHaveBeenCalled();
  });
});
