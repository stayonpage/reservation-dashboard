'use client';

import { useState } from 'react';
import type { BlockTask } from '../lib/db-types';
import { CHANNEL_LABEL } from '../lib/db-types';
import { formatDateRange } from '../lib/format';
import { CHANNEL_COLOR } from './Badges';
import { ROOMS } from '../lib/rooms';

const COLLAPSED_COUNT = 3;

const ROOM_LABEL: Record<string, string> = Object.fromEntries(
  ROOMS.map((r) => [r.code, r.label]),
);

// 오버부킹 방지 워크리스트 — 자동 방막기는 3채널 모두 불가로 확정(design doc 이슈8).
// "깜빡 누락"을 없애는 게 이 컴포넌트의 유일한 목적: 감지되면 여기 뜨고, 완료 처리하면 바로
// 목록에서 사라진다(할 일 목록이지 이력 목록이 아니므로 이미 처리한 건 안 보여준다).
//
// 상태는 부모(DashboardRealtime)가 소유(realtime 구독 + 서버 액션 낙관적 업데이트) — 이 컴포넌트는 순수 표시.

// 각 채널 관리자 화면 딥링크. 실제 URL 패턴은 계정 로그인 후에만 확인 가능해
// 추측으로 채워넣지 않음 — 확인되는 대로 채워 넣을 것.
const ADMIN_URL: Partial<Record<BlockTask['target_channel'], string>> = {};

export function BlockWorklist({
  tasks,
  onToggle,
  id,
}: {
  tasks: BlockTask[];
  onToggle: (taskId: string, done: boolean) => void;
  id?: string;
}) {
  // pending만 표시 — 이미 막았거나(done) 취소된(skipped) 건은 목록에서 뺀다(완료 처리하면
  // 바로 사라짐). action='unblock'(취소로 다시 열어야 하는 채널)도 pending이면 여기 같이 뜬다.
  const visible = tasks.filter((t) => t.status === 'pending');
  const sorted = [...visible].sort((a, b) => a.check_in.localeCompare(b.check_in));

  const pendingCount = tasks.filter((t) => t.status === 'pending').length;
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? sorted : sorted.slice(0, COLLAPSED_COUNT);
  const hiddenCount = sorted.length - shown.length;

  return (
    <section id={id}>
      <div className="section-title">
        <h2>막아야 할 채널</h2>
        <span className="count-pill">{pendingCount}건 남음</span>
      </div>

      {sorted.length === 0 ? (
        <div className="empty">막아야 할 채널 없음</div>
      ) : (
        shown.map((t) => {
          const unblock = t.action === 'unblock';
          const url = ADMIN_URL[t.target_channel];
          return (
            <div key={t.id} className={`block-item ${unblock ? 'unblock' : ''}`}>
              <button
                type="button"
                className="block-check"
                aria-label="완료 처리"
                onClick={() => onToggle(t.id, true)}
              />
              <div className="block-text">
                <span
                  className="ch-dot"
                  style={{ background: CHANNEL_COLOR[t.target_channel] }}
                />
                <strong>{CHANNEL_LABEL[t.target_channel]}</strong>{' '}
                {formatDateRange(t.check_in, t.check_out)} {unblock ? '다시 열기' : '막기'}
                <div className="block-sub">
                  {t.reservation_id === null ? (
                    <>
                      직접 막기 · {ROOM_LABEL[t.room_code ?? ''] ?? t.room_code} ·{' '}
                      사유: {t.reason}
                    </>
                  ) : unblock ? (
                    <>
                      예약 취소됨 · {t.reservation_guest_name ?? '이름 미상'} ·{' '}
                      {t.reservation_room_name} — 막아뒀던 걸 다시 열어야 함
                    </>
                  ) : (
                    <>
                      {t.reservation_channel && CHANNEL_LABEL[t.reservation_channel]} 예약 ·{' '}
                      {t.reservation_guest_name ?? '이름 미상'} · {t.reservation_room_name}
                    </>
                  )}
                </div>
              </div>
              {url ? (
                <a className="deeplink" href={url} target="_blank" rel="noreferrer">
                  바로가기
                </a>
              ) : (
                <span className="deeplink" title="관리자 URL 미설정">
                  직접 확인
                </span>
              )}
            </div>
          );
        })
      )}

      {hiddenCount > 0 && (
        <button type="button" className="block-more-btn" onClick={() => setExpanded(true)}>
          {hiddenCount}건 더 보기
        </button>
      )}
      {expanded && sorted.length > COLLAPSED_COUNT && (
        <button type="button" className="block-more-btn" onClick={() => setExpanded(false)}>
          접기
        </button>
      )}
    </section>
  );
}
