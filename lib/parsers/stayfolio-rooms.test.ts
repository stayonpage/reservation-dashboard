import { describe, it, expect } from 'vitest';
import { findIcsUrlForRoom, STAYFOLIO_ROOM_ICS_URLS } from './stayfolio-rooms';

describe('findIcsUrlForRoom', () => {
  it('설명 문구가 붙은 실제 이메일 객실명에서 방 코드로 매칭한다', () => {
    expect(findIcsUrlForRoom('page26 - 시가 내려앉는 순간')).toBe(
      STAYFOLIO_ROOM_ICS_URLS.page26,
    );
    expect(findIcsUrlForRoom('page452 - 지금, 나를 세우는 시간')).toBe(
      STAYFOLIO_ROOM_ICS_URLS.page452,
    );
  });

  it('page8과 page127처럼 접두어가 겹치지 않는 코드도 정확히 구분한다', () => {
    expect(findIcsUrlForRoom('page8 - 아무 설명')).toBe(STAYFOLIO_ROOM_ICS_URLS.page8);
    expect(findIcsUrlForRoom('page127 - 아무 설명')).toBe(STAYFOLIO_ROOM_ICS_URLS.page127);
  });

  it('알 수 없는 방이나 null이면 null', () => {
    expect(findIcsUrlForRoom('page999 - 없는 방')).toBeNull();
    expect(findIcsUrlForRoom(null)).toBeNull();
  });
});
