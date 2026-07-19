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
      expect.objectContaining({ seen: false, from: 'hello@stayfolio.com' }),
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
        seen: false,
        from: 'misomamy@naver.com',
      }),
      expect.anything(),
    );
    expect(mockClient.search).toHaveBeenCalledWith(
      expect.not.objectContaining({ subject: expect.anything() }),
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
});
