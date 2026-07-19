import { describe, it, expect, vi, beforeEach } from 'vitest';

// IMAP/메일 파싱/DB 저장은 전부 목(mock) — 실제 접속 없이 폴링 오케스트레이션
// 로직(검색→다운로드→파싱→handleIncoming→읽음처리)만 검증한다.

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

vi.mock('../parsers/naver', () => ({ parseNaverEmail: vi.fn() }));

import { pollNaverInbox } from './poll-naver';

describe('pollNaverInbox', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.getMailboxLock.mockResolvedValue(mockLock);
    process.env.NAVER_MAIL_USER = 'test@naver.com';
    process.env.NAVER_MAIL_APP_PASSWORD = 'app-pw';
  });

  it('환경변수 없으면 에러', async () => {
    delete process.env.NAVER_MAIL_USER;
    await expect(pollNaverInbox()).rejects.toThrow(/환경변수/);
  });

  it('미확인 메일이 없으면 checked=0, 접속은 정리된다', async () => {
    mockClient.search.mockResolvedValue([]);
    const result = await pollNaverInbox();
    expect(result).toEqual({ checked: 0, parsed: 0, duplicate: 0, parseFailed: 0, errors: [] });
    expect(mockClient.connect).toHaveBeenCalled();
    expect(mockClient.logout).toHaveBeenCalled();
    expect(mockLock.release).toHaveBeenCalled();
  });

  it('search()가 false를 반환해도(지원 안 함) 빈 배열처럼 처리', async () => {
    mockClient.search.mockResolvedValue(false);
    const result = await pollNaverInbox();
    expect(result.checked).toBe(0);
  });

  it('정상 파싱된 메일은 parsed 카운트 + 읽음 처리', async () => {
    mockClient.search.mockResolvedValue([101]);
    mockClient.download.mockResolvedValue({ content: Buffer.from('raw') });
    mockParsed.mockResolvedValue({ messageId: '<msg-1>', text: '예약 내용' });
    mockHandleIncoming.mockResolvedValue({ status: 'parsed', reservationId: 'r1' });

    const result = await pollNaverInbox();

    expect(result).toEqual({ checked: 1, parsed: 1, duplicate: 0, parseFailed: 0, errors: [] });
    expect(mockHandleIncoming).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'naver_email', externalId: '<msg-1>', raw: '예약 내용' }),
    );
    expect(mockClient.messageFlagsAdd).toHaveBeenCalledWith(
      { uid: '101' },
      ['\\Seen'],
      { uid: true },
    );
  });

  it('text 파트가 없으면(HTML 전용 메일) html에서 텍스트를 추출해 파싱에 넘긴다', async () => {
    // 실제 네이버 알림 메일이 HTML 전용으로 오는 것을 실접속으로 확인(2026-07) — 회귀 방지.
    mockClient.search.mockResolvedValue([303]);
    mockClient.download.mockResolvedValue({ content: Buffer.from('raw') });
    mockParsed.mockResolvedValue({
      messageId: '<html-only>',
      text: '', // mailparser가 text/plain 파트를 못 찾으면 빈 문자열
      html: '<div>예약번호<br>1234567890</div>',
    });
    mockHandleIncoming.mockResolvedValue({ status: 'parsed', reservationId: 'r3' });

    await pollNaverInbox();

    const call = mockHandleIncoming.mock.calls[0][0];
    expect(call.raw).toContain('예약번호');
    expect(call.raw).toContain('1234567890');
    expect(call.raw).not.toContain('<div>');
  });

  it('text·html 둘 다 없으면 빈 문자열로 파싱 시도(파서가 null 반환 → parse_failed로 자연 처리)', async () => {
    mockClient.search.mockResolvedValue([304]);
    mockClient.download.mockResolvedValue({ content: Buffer.from('raw') });
    mockParsed.mockResolvedValue({ messageId: '<empty>' }); // text·html 둘 다 undefined
    mockHandleIncoming.mockResolvedValue({ status: 'parse_failed' });

    await pollNaverInbox();

    expect(mockHandleIncoming).toHaveBeenCalledWith(expect.objectContaining({ raw: '' }));
  });

  it('Message-ID 없으면 uid 기반 폴백 externalId 사용', async () => {
    mockClient.search.mockResolvedValue([202]);
    mockClient.download.mockResolvedValue({ content: Buffer.from('raw') });
    mockParsed.mockResolvedValue({ text: '내용' }); // messageId 없음
    mockHandleIncoming.mockResolvedValue({ status: 'parsed', reservationId: 'r2' });

    await pollNaverInbox();

    expect(mockHandleIncoming).toHaveBeenCalledWith(
      expect.objectContaining({ externalId: 'naver-uid-202' }),
    );
  });

  it('중복/파싱실패도 각각 카운트되고 읽음 처리된다(무한 재시도 방지)', async () => {
    mockClient.search.mockResolvedValue([1, 2]);
    mockClient.download.mockResolvedValue({ content: Buffer.from('raw') });
    mockParsed.mockResolvedValue({ messageId: '<m>', text: 't' });
    mockHandleIncoming
      .mockResolvedValueOnce({ status: 'duplicate' })
      .mockResolvedValueOnce({ status: 'parse_failed' });

    const result = await pollNaverInbox();

    expect(result.duplicate).toBe(1);
    expect(result.parseFailed).toBe(1);
    expect(mockClient.messageFlagsAdd).toHaveBeenCalledTimes(2);
  });

  it('DB 오류로 handleIncoming이 throw하면 errors에 기록되고 읽음 처리 안 함(재시도 위해)', async () => {
    mockClient.search.mockResolvedValue([9]);
    mockClient.download.mockResolvedValue({ content: Buffer.from('raw') });
    mockParsed.mockResolvedValue({ messageId: '<m9>', text: 't' });
    mockHandleIncoming.mockRejectedValue(new Error('DB down'));

    const result = await pollNaverInbox();

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('DB down');
    expect(mockClient.messageFlagsAdd).not.toHaveBeenCalled();
    // 개별 메일 오류가 나머지 처리·정상 종료를 막지 않는다.
    expect(mockClient.logout).toHaveBeenCalled();
    expect(mockLock.release).toHaveBeenCalled();
  });

  it('mailbox lock은 성공/실패와 무관하게 항상 release된다', async () => {
    mockClient.search.mockRejectedValue(new Error('search boom'));
    await expect(pollNaverInbox()).rejects.toThrow('search boom');
    expect(mockLock.release).toHaveBeenCalled();
    expect(mockClient.logout).toHaveBeenCalled();
  });
});
