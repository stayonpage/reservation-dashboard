'use client';

import { useMemo, useState } from 'react';
import { ROOMS } from '../lib/rooms';
import { CHANNEL_LABEL, type Reservation } from '../lib/db-types';
import { getKnownOptionNames } from '../lib/stats';
import type { Channel, PaymentStatus, ReservationOption } from '../lib/types';

// 시스템 도입 전 예약 백필 전용 — 이번 한 번 쓰고 나면 다시 쓸 일 거의 없어서, 평소엔
// 버튼 하나만 보이고 눌러야 입력 폼이 나온다(화면을 안 차지하게).

const CHANNELS: Channel[] = ['naver', 'stayfolio', 'imweb'];

interface OptionDraft {
  name: string;
  qty: string;
  price: string;
}

const emptyOption = (): OptionDraft => ({ name: '', qty: '1', price: '' });

export function ManualReservationForm({
  reservations,
  onSubmit,
  id,
}: {
  reservations: Reservation[];
  onSubmit: (params: {
    channel: Channel;
    roomName: string;
    guestName: string;
    guestPhone: string | null;
    checkIn: string;
    checkOut: string;
    amount: number | null;
    paymentStatus: PaymentStatus;
    options: ReservationOption[];
  }) => void;
  id?: string;
}) {
  // 하드코딩 안 함 — 실제 예약 데이터에서 매번 다시 뽑아서, 새 옵션명이 파싱되면
  // (아임웹에 상품이 추가되는 등) 코드 수정 없이 바로 목록에 잡힌다. 많이 나온 순 정렬.
  const knownOptions = useMemo(() => getKnownOptionNames(reservations), [reservations]);

  const [open, setOpen] = useState(false);
  const [channel, setChannel] = useState<Channel>('naver');
  const [roomCode, setRoomCode] = useState(ROOMS[0].code);
  const [guestName, setGuestName] = useState('');
  const [guestPhone, setGuestPhone] = useState('');
  const [checkIn, setCheckIn] = useState('');
  const [checkOut, setCheckOut] = useState('');
  const [amount, setAmount] = useState('');
  const [paymentStatus, setPaymentStatus] = useState<PaymentStatus>('paid');
  const [options, setOptions] = useState<OptionDraft[]>([]);

  const reset = () => {
    setGuestName('');
    setGuestPhone('');
    setCheckIn('');
    setCheckOut('');
    setAmount('');
    setOptions([]);
  };

  const updateOption = (i: number, patch: Partial<OptionDraft>) => {
    setOptions((prev) => prev.map((o, idx) => (idx === i ? { ...o, ...patch } : o)));
  };

  const removeOption = (i: number) => {
    setOptions((prev) => prev.filter((_, idx) => idx !== i));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!guestName.trim() || !checkIn || !checkOut) return;
    if (checkOut <= checkIn) {
      window.alert('체크아웃은 체크인보다 늦어야 해요.');
      return;
    }
    const parsedOptions: ReservationOption[] = options
      .filter((o) => o.name.trim())
      .map((o) => ({
        name: o.name.trim(),
        qty: Number(o.qty) || 1,
        price: Number(o.price) || 0,
      }));

    onSubmit({
      channel,
      roomName: roomCode,
      guestName: guestName.trim(),
      guestPhone: guestPhone.trim() || null,
      checkIn,
      checkOut,
      amount: amount ? Number(amount) : null,
      paymentStatus,
      options: parsedOptions,
    });
    reset();
    setOpen(false);
  };

  if (!open) {
    return (
      <section id={id}>
        <button type="button" className="manual-entry-toggle" onClick={() => setOpen(true)}>
          📝 예약 수동 입력
        </button>
      </section>
    );
  }

  return (
    <section id={id}>
      <div className="section-title">
        <h2>📝 수동 예약 입력</h2>
      </div>
      <form onSubmit={handleSubmit} className="manual-form">
        <label className="manual-field">
          채널
          <select value={channel} onChange={(e) => setChannel(e.target.value as Channel)}>
            {CHANNELS.map((c) => (
              <option key={c} value={c}>
                {CHANNEL_LABEL[c]}
              </option>
            ))}
          </select>
        </label>

        <label className="manual-field">
          방
          <select value={roomCode} onChange={(e) => setRoomCode(e.target.value)}>
            {ROOMS.map((r) => (
              <option key={r.code} value={r.code}>
                {r.label} ({r.property})
              </option>
            ))}
          </select>
        </label>

        <div className="manual-field-row">
          <label className="manual-field">
            손님 이름
            <input
              type="text"
              value={guestName}
              onChange={(e) => setGuestName(e.target.value)}
              required
            />
          </label>
          <label className="manual-field">
            전화번호(선택)
            <input
              type="tel"
              value={guestPhone}
              onChange={(e) => setGuestPhone(e.target.value)}
              placeholder="010-0000-0000"
            />
          </label>
        </div>

        <div className="manual-field-row">
          <label className="manual-field">
            체크인
            <input
              type="date"
              value={checkIn}
              onChange={(e) => setCheckIn(e.target.value)}
              required
            />
          </label>
          <label className="manual-field">
            체크아웃
            <input
              type="date"
              value={checkOut}
              onChange={(e) => setCheckOut(e.target.value)}
              required
            />
          </label>
        </div>

        <div className="manual-field-row">
          <label className="manual-field">
            금액(원)
            <input
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              min={0}
              placeholder="선택"
            />
          </label>
          <label className="manual-field">
            결제상태
            <select
              value={paymentStatus}
              onChange={(e) => setPaymentStatus(e.target.value as PaymentStatus)}
            >
              <option value="paid">확정(결제완료)</option>
              <option value="pending">입금대기</option>
            </select>
          </label>
        </div>

        <div className="manual-options">
          <div className="manual-options-title">옵션(선택)</div>

          {knownOptions.length > 0 && (
            <div className="manual-option-chips">
              {knownOptions.map((o) => (
                <button
                  key={o.name}
                  type="button"
                  className="manual-option-chip"
                  onClick={() =>
                    setOptions((prev) => [...prev, { name: o.name, qty: '1', price: '' }])
                  }
                >
                  {o.name} <span className="manual-option-chip-count">{o.count}</span>
                </button>
              ))}
            </div>
          )}

          {options.map((o, i) => (
            <div key={i} className="manual-option-row">
              <input
                type="text"
                placeholder="옵션명(예: 웰컴키트)"
                value={o.name}
                onChange={(e) => updateOption(i, { name: e.target.value })}
                className="manual-option-name"
              />
              <input
                type="number"
                placeholder="수량"
                min={1}
                value={o.qty}
                onChange={(e) => updateOption(i, { qty: e.target.value })}
                className="manual-option-qty"
              />
              <input
                type="number"
                placeholder="금액"
                min={0}
                value={o.price}
                onChange={(e) => updateOption(i, { price: e.target.value })}
                className="manual-option-price"
              />
              <button
                type="button"
                className="manual-option-remove"
                onClick={() => removeOption(i)}
                aria-label="옵션 삭제"
              >
                ✕
              </button>
            </div>
          ))}
          <button
            type="button"
            className="manual-option-add"
            onClick={() => setOptions((prev) => [...prev, emptyOption()])}
          >
            ➕ 옵션 추가
          </button>
        </div>

        <div className="manual-form-actions">
          <button
            type="button"
            className="deeplink"
            onClick={() => {
              reset();
              setOpen(false);
            }}
          >
            취소
          </button>
          <button type="submit" className="btn-primary">
            등록
          </button>
        </div>
      </form>
    </section>
  );
}
