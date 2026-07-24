import { describe, it, expect } from 'vitest';
import { roomCodeOf, roomSortIndex, displayRoomName } from './rooms';

describe('roomCodeOf', () => {
  it('page 계열 설명 문구가 붙어도 코드만 뽑는다', () => {
    expect(roomCodeOf('page26 - 시가 내려앉는 순간')).toBe('page26');
    expect(roomCodeOf('page 8 - 숨결같은 선율에 머무는 하루')).toBe('page8');
  });

  it('page1이 page127로 오매칭되지 않는다', () => {
    expect(roomCodeOf('page127 - 별서에서 흐르는 시간')).toBe('page127');
    expect(roomCodeOf('page1234')).toBeNull();
  });

  it('게스트하우스 방 이름을 정확히 매칭한다(네이버 표기)', () => {
    expect(roomCodeOf('객실 서쪽')).toBe('객실 서쪽');
    expect(roomCodeOf('객실 남쪽')).toBe('객실 남쪽');
  });

  it('채널마다 다른 표기(아임웹 "서쪽방"/"남쪽방")도 같은 코드로 매칭한다', () => {
    expect(roomCodeOf('서쪽방')).toBe('객실 서쪽');
    expect(roomCodeOf('남쪽방')).toBe('객실 남쪽');
  });

  it('매칭 안 되는 방/null은 null', () => {
    expect(roomCodeOf('알 수 없는 방')).toBeNull();
    expect(roomCodeOf(null)).toBeNull();
  });
});

describe('roomSortIndex', () => {
  it('ROOMS 배열 순서(객실 달력과 동일)를 따른다', () => {
    const names = ['객실 남쪽', 'page127 - 별서에서 흐르는 시간', '서쪽방', 'page26 - 시가 내려앉는 순간'];
    const sorted = [...names].sort((a, b) => roomSortIndex(a) - roomSortIndex(b));
    expect(sorted).toEqual([
      'page26 - 시가 내려앉는 순간',
      'page127 - 별서에서 흐르는 시간',
      '서쪽방', // 객실 서쪽
      '객실 남쪽',
    ]);
  });

  it('채널마다 표기가 달라도(예: "객실 서쪽" vs "서쪽방") 같은 순서로 묶인다', () => {
    expect(roomSortIndex('객실 서쪽')).toBe(roomSortIndex('서쪽방'));
  });

  it('매칭 안 되는 방/null은 맨 뒤로 보낸다', () => {
    expect(roomSortIndex('알 수 없는 방')).toBeGreaterThan(roomSortIndex('객실 남쪽'));
    expect(roomSortIndex(null)).toBeGreaterThan(roomSortIndex('객실 남쪽'));
  });
});

describe('displayRoomName', () => {
  it('게스트하우스는 채널 표기와 무관하게 "객실 서쪽"/"객실 남쪽"으로 통일한다', () => {
    expect(displayRoomName('서쪽방')).toBe('객실 서쪽');
    expect(displayRoomName('남쪽방')).toBe('객실 남쪽');
    expect(displayRoomName('객실 서쪽')).toBe('객실 서쪽');
    expect(displayRoomName('객실 남쪽')).toBe('객실 남쪽');
  });

  it('스테이 온 페이지는 책 제목이 붙은 원문을 그대로 보여준다', () => {
    expect(displayRoomName('page26 - 시가 내려앉는 순간')).toBe('page26 - 시가 내려앉는 순간');
  });

  it('매칭 안 되는 방/null은 원문(빈 문자열)을 그대로 돌려준다', () => {
    expect(displayRoomName('알 수 없는 방')).toBe('알 수 없는 방');
    expect(displayRoomName(null)).toBe('');
  });
});
