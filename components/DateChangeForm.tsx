'use client';

import { useState } from 'react';
import type { Reservation } from '../lib/db-types';
import { formatDateRange } from '../lib/format';
import { defaultCheckOut, validateDateChange } from '../lib/change-dates';

// "손님이 네이버에서 날짜를 바꿨다"를 직원이 접수하는 작은 인라인 폼.
// 네이버는 변경 메일을 안 보내고 스마트플레이스 앱 푸시로만 알려서(2026-11-14 은*은 건)
// 푸시를 본 직원이 새 날짜만 넣으면 기존 변경 확인 큐 경로로 즉시 반영된다.

export function DateChangeForm({
  reservation,
  onChangeDates,
  buttonClassName,
}: {
  reservation: Reservation;
  onChangeDates: (
    reservationId: string,
    newCheckIn: string,
    newCheckOut: string,
  ) => Promise<{ error: string | null }>;
  buttonClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [checkIn, setCheckIn] = useState(reservation.check_in);
  const [checkOut, setCheckOut] = useState(reservation.check_out);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!open) {
    return (
      <button type="button" className={buttonClassName ?? 'date-change-btn'} onClick={() => setOpen(true)}>
        날짜 변경
      </button>
    );
  }

  const submit = async () => {
    const invalid = validateDateChange(reservation, checkIn, checkOut);
    if (invalid) {
      setError(invalid);
      return;
    }
    const ok = window.confirm(
      `${reservation.guest_name ?? '이 손님'}\n${formatDateRange(reservation.check_in, reservation.check_out)} → ${formatDateRange(checkIn, checkOut)}\n\n날짜를 변경하고 다른 채널 막기/풀기 작업을 만듭니다. 입금확인은 다시 해야 합니다.`,
    );
    if (!ok) return;
    setBusy(true);
    setError(null);
    const res = await onChangeDates(reservation.id, checkIn, checkOut);
    setBusy(false);
    if (res.error) setError(res.error);
    else setOpen(false);
  };

  return (
    <div className="date-change-form">
      <label>
        체크인
        <input
          type="date"
          value={checkIn}
          onChange={(e) => {
            setCheckIn(e.target.value);
            if (e.target.value) {
              setCheckOut(defaultCheckOut(reservation.check_in, reservation.check_out, e.target.value));
            }
          }}
        />
      </label>
      <label>
        체크아웃
        <input type="date" value={checkOut} onChange={(e) => setCheckOut(e.target.value)} />
      </label>
      <button type="button" className="date-change-submit" disabled={busy} onClick={submit}>
        {busy ? '처리 중…' : '변경 접수'}
      </button>
      <button type="button" className="date-change-cancel" disabled={busy} onClick={() => setOpen(false)}>
        닫기
      </button>
      {error && <div className="date-change-error">{error}</div>}
    </div>
  );
}
