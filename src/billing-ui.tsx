import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { Billing, BillingAction, Enrollment, Tariff, TariffDraft } from './billing';
import { activeFreeze, addDuration, billingBalance, dueStatus, freezeDays, latestPeriod, localToday, periodBalance, previewPeriod } from './billing';

const currency = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', minimumFractionDigits: 0 });
const fractionalCurrency = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', minimumFractionDigits: 2 });
export const dateLabel = (date: string) => date.split('-').reverse().join('.');
function safeAddDays(date: string, days: number): string | undefined {
  try { return addDuration(date, days, 'days'); } catch { return undefined; }
}
const rubles = (amount: number) => `${(amount - amount % 100) / 100}.${String(amount % 100).padStart(2, '0')}`;
const durationText = (tariff: Tariff) => `${tariff.duration} ${tariff.unit === 'days' ? 'дн.' : 'мес.'}`;

export function money(amount: number): string {
  const fraction = amount % 100;
  const whole = (amount - fraction) / 100;
  if (!fraction) return currency.format(whole);
  return fractionalCurrency.formatToParts(whole)
    .map(part => part.type === 'fraction' ? String(fraction).padStart(2, '0') : part.value).join('');
}

function cents(input: string): number {
  if (!/^\d+(?:[.,]\d{1,2})?$/.test(input.trim())) return NaN;
  const [whole, fraction = ''] = input.trim().split(/[.,]/);
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(amount) ? amount : NaN;
}

function MoneyField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label>{label}<input inputMode="decimal" required maxLength={19} pattern="[0-9]+([.,][0-9]{1,2})?"
    value={value} onChange={event => onChange(event.target.value)} /></label>;
}

export function Tariffs({ tariffs, busy, onSave, onToggle }: {
  tariffs: Tariff[]; busy: boolean; onSave: (draft: TariffDraft, id?: string) => Promise<boolean>;
  onToggle: (tariff: Tariff) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [duration, setDuration] = useState('1');
  const [unit, setUnit] = useState<TariffDraft['unit']>('months');

  function edit(tariff?: Tariff) {
    setName(tariff?.name ?? '');
    setPrice(tariff ? rubles(tariff.price) : '');
    setDuration(String(tariff?.duration ?? 1));
    setUnit(tariff?.unit ?? 'months');
    setEditing(tariff?.id ?? '');
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (await onSave({ name, price: cents(price), duration: Number(duration), unit }, editing || undefined)) setEditing(null);
  }

  return <>
    <div className="section-heading"><h2>Тарифы</h2>
      {editing === null && <button type="button" className="primary" disabled={busy} onClick={() => edit()}>Новый тариф</button>}
    </div>
    {editing !== null && <form className="panel billing-panel" onSubmit={save}>
      <fieldset disabled={busy} className="billing-fields">
        <label>Название тарифа<input required value={name} onChange={event => setName(event.target.value)} /></label>
        <MoneyField label="Цена, ₽" value={price} onChange={setPrice} />
        <label>Длительность<input type="number" required min={1} step={1} value={duration} onChange={event => setDuration(event.target.value)} /></label>
        <label>Единица срока<select aria-label="Единица срока" value={unit} onChange={event => setUnit(event.target.value === 'days' ? 'days' : 'months')}>
          <option value="days">Дни</option><option value="months">Календарные месяцы</option>
        </select></label>
        <div className="actions"><button type="submit" className="primary">Сохранить тариф</button>
          <button type="button" onClick={() => setEditing(null)}>Отмена</button></div>
      </fieldset>
    </form>}
    {tariffs.length === 0 && <p className="muted">Пока нет тарифов.</p>}
    {tariffs.map(tariff => <section key={tariff.id} className="panel billing-panel">
      <strong>{tariff.name}</strong><span>{money(tariff.price)} · {durationText(tariff)}{!tariff.enabled && ' · Отключён'}</span>
      <div className="actions"><button type="button" disabled={busy || editing !== null} onClick={() => edit(tariff)}>Редактировать</button>
        <button type="button" disabled={busy || editing !== null} onClick={() => onToggle(tariff)}>{tariff.enabled ? 'Отключить' : 'Включить'}</button></div>
    </section>)}
  </>;
}

export type EnrollmentForm = { kind: Enrollment['kind']; tariffId: string; date: string; amount: string; paymentDate: string };

export function initialEnrollment(kind: Enrollment['kind'], tariffs: Tariff[], preferred?: string): EnrollmentForm {
  const tariff = tariffs.find(item => item.enabled && item.id === preferred) ?? tariffs.find(item => item.enabled);
  const today = localToday();
  return { kind, tariffId: tariff?.id ?? '', date: today, paymentDate: today, amount: tariff ? rubles(tariff.price) : '' };
}

export function enrollmentOf({ kind, tariffId, date, amount, paymentDate }: EnrollmentForm): Enrollment {
  if (kind === 'transfer') return { kind, tariffId, date };
  const received = cents(amount);
  return kind === 'start' && received > 0 ? { kind, tariffId, date, amount: received, paymentDate } :
    { kind, tariffId, date, amount: received };
}

export function EnrollmentFields({ form, onChange, tariffs, billing }: {
  form: EnrollmentForm; onChange: (form: EnrollmentForm) => void; tariffs: Tariff[]; billing?: Billing;
}) {
  const tariff = tariffs.find(item => item.enabled && item.id === form.tariffId);
  let preview: ReturnType<typeof previewPeriod> | undefined;
  if (tariff && form.date) {
    try { preview = previewPeriod(tariff, enrollmentOf(form), billing); } catch { /* Invalid input is handled at save. */ }
  }
  return <>
    <label>Тариф<select aria-label="Тариф" required value={form.tariffId} onChange={event => {
      const next = tariffs.find(item => item.id === event.target.value);
      onChange({ ...form, tariffId: event.target.value, amount: next ? rubles(next.price) : '' });
    }}>
      <option value="" disabled>Выберите тариф</option>
      {tariffs.filter(item => item.enabled).map(item => <option key={item.id} value={item.id}>{item.name} · {money(item.price)}</option>)}
    </select></label>
    <label>{form.kind === 'transfer' ? 'Дата следующей оплаты' : form.kind === 'renew' ? 'Дата платежа' : 'Дата начала'}
      <input type="date" required value={form.date} onChange={event => onChange({ ...form, date: event.target.value })} /></label>
    {form.kind !== 'transfer' && <MoneyField label="Получено, ₽" value={form.amount} onChange={amount => onChange({ ...form, amount })} />}
    {form.kind === 'start' && cents(form.amount) > 0 && <label>Дата платежа
      <input type="date" required value={form.paymentDate} onChange={event => onChange({ ...form, paymentDate: event.target.value })} />
    </label>}
    {tariff && form.kind !== 'transfer' && <small className="muted">Стоимость: {money(tariff.price)} · Срок: {durationText(tariff)}.
      {' Укажите фактический взнос, или 0 ₽, если оплаты ещё не было.'}</small>}
    <small className="muted" aria-live="polite">{form.kind === 'transfer' ? 'Перенос не создаёт взнос и задолженность.' : preview &&
      `Период с ${preview.start ? dateLabel(preview.start) : 'неизвестной даты'} · Следующая оплата: ${dateLabel(preview.due)}`}</small>
  </>;
}

export function BillingCard({ billing, tariffs, archived, today, busy, onSave }: {
  billing?: Billing; tariffs: Tariff[]; archived: boolean; today: string; busy: boolean;
  onSave: (action: BillingAction) => Promise<boolean>;
}) {
  const [form, setForm] = useState<EnrollmentForm | null>(null);
  const [payment, setPayment] = useState<{ kind: 'pay' | 'correct'; id: string; date: string; amount: string } | null>(null);
  const [freezeForm, setFreezeForm] = useState<{ start: string; plannedReturn: string } | null>(null);
  const latest = latestPeriod(billing);
  const current = billing?.periods.find(period => (period.start === null || period.start <= today) && today < period.due);
  const shown = current ?? latest;
  const active = activeFreeze(billing, today);
  const freezeHistory = [...(billing?.freezes ?? [])].sort((a, b) => b.start.localeCompare(a.start));
  const canEnroll = tariffs.some(tariff => tariff.enabled);
  const balance = billingBalance(billing);
  const canAct = !archived && !form && !payment && !freezeForm;

  async function submit(event: FormEvent, action: BillingAction) {
    event.preventDefault();
    if (await onSave(action)) { setForm(null); setPayment(null); setFreezeForm(null); }
  }

  function controls(): ReactNode {
    if (!canAct) return null;
    if (!canEnroll) return <p className="muted">Чтобы оформить или продлить абонемент, добавьте доступный тариф в настройках.</p>;
    return <div className="actions">{latest ?
      <button type="button" disabled={busy} onClick={() => setForm(initialEnrollment('renew', tariffs, latest.tariff.id))}>Продлить</button> : <>
        <button type="button" disabled={busy} onClick={() => setForm(initialEnrollment('start', tariffs))}>Оформить абонемент</button>
        <button type="button" disabled={busy} onClick={() => setForm(initialEnrollment('transfer', tariffs))}>Перенести абонемент</button>
      </>}</div>;
  }

  return <>
    <section className="panel billing-panel" aria-label="Абонемент">
      <h2>Абонемент</h2>
      <div className="badges"><span>{dueStatus(billing, today)}</span>{archived && <span>В архиве</span>}</div>
      {shown && <><strong>{shown.tariff.name}</strong>
        <span>{shown.start ? `Начало периода: ${dateLabel(shown.start)}` : 'Дата начала не указана при переносе'}</span>
        {current && latest && current.id !== latest.id && <span>Текущий период до: {dateLabel(current.due)}</span>}
        {latest && <span>Следующая оплата: {dateLabel(latest.due)}</span>}
        {active && <span>Возвращение: {dateLabel(active.plannedReturn)}</span>}</>}
      {balance > 0 && <strong className="debt">Осталось доплатить {money(balance)}</strong>}
      {controls()}
      {form && <form onSubmit={event => void submit(event, enrollmentOf(form))}>
        <fieldset disabled={busy} className="billing-fields">
          <EnrollmentFields form={form} onChange={setForm} tariffs={tariffs} billing={billing} />
          <div className="actions"><button type="submit" className="primary">Сохранить абонемент</button>
            <button type="button" onClick={() => setForm(null)}>Отмена</button></div>
        </fieldset>
      </form>}
    </section>
    {billing && <section className="panel billing-panel" aria-label="Заморозка">
      <h2>Заморозка</h2>
      {active && <div className="freeze-state">
        <strong>Заморожен до {dateLabel(active.plannedReturn)}</strong>
        <small className="muted">Начало заморозки: {dateLabel(active.start)} · {freezeDays(active)} дн.</small>
        {canAct && <div className="actions"><button type="button" disabled={busy}
          onClick={() => void onSave({ kind: 'return', freezeId: active.id })}>Завершить заморозку сегодня</button></div>}
      </div>}
      {freezeForm && <form onSubmit={event => void submit(event, {
        kind: 'freeze', start: freezeForm.start, plannedReturn: freezeForm.plannedReturn,
      })}>
        <fieldset disabled={busy} className="billing-fields">
          <label>Начало заморозки<input type="date" required min={today} value={freezeForm.start}
            onChange={event => setFreezeForm({ ...freezeForm, start: event.target.value })} /></label>
          <label>День возвращения<input type="date" required min={safeAddDays(freezeForm.start || today, 1)}
            value={freezeForm.plannedReturn}
            onChange={event => setFreezeForm({ ...freezeForm, plannedReturn: event.target.value })} /></label>
          <small className="muted">День возвращения не входит в паузу и станет первым днём занятий.</small>
          <div className="actions"><button type="submit" className="primary">Сохранить заморозку</button>
            <button type="button" onClick={() => setFreezeForm(null)}>Отмена</button></div>
        </fieldset>
      </form>}
      {!freezeForm && canAct && latest && <div className="actions"><button type="button" disabled={busy}
        onClick={() => {
          const start = active?.plannedReturn ?? today;
          setFreezeForm({ start, plannedReturn: safeAddDays(start, 7) ?? start });
        }}>Запланировать заморозку</button></div>}
      {!latest && <p className="muted">Заморозку можно оформить после начала абонемента.</p>}
      {freezeHistory.length === 0 ? <p className="muted">Заморозок пока нет.</p> : <div className="freeze-history">
        <h3>История заморозок</h3>
        {freezeHistory.map(freeze => {
          const plannedDays = freezeDays({ ...freeze, returnedOn: undefined });
          const actualDays = freezeDays(freeze);
          return <section className="freeze-period" key={freeze.id}>
            <strong>{freeze.returnedOn ? 'Досрочное возвращение' : active?.id === freeze.id ? 'Текущая заморозка'
              : freeze.start > today ? 'Запланирована' : 'Завершена'}</strong>
            <small className="muted">Начало: {dateLabel(freeze.start)} · План возвращения: {dateLabel(freeze.plannedReturn)} · {plannedDays} дн.</small>
            {freeze.returnedOn && <small className="muted">Фактическое возвращение: {dateLabel(freeze.returnedOn)} · {actualDays} дн.</small>}
          </section>;
        })}
      </div>}
    </section>}
    {billing && <section className="panel billing-panel" aria-label="История платежей">
      <h2>История платежей</h2>
      {billing.payments.length === 0 && <p className="muted">Платежей пока нет.</p>}
      {payment && <form onSubmit={event => void submit(event, payment.kind === 'correct' ?
        { kind: 'correct', paymentId: payment.id, amount: cents(payment.amount) } :
        { kind: 'pay', periodId: payment.id, date: payment.date, amount: cents(payment.amount) })}>
        <fieldset disabled={busy} className="billing-fields">
          {payment.kind === 'correct' ? <small className="muted">Изменится только сумма; дата, период и сроки останутся прежними.</small> :
            <label>Дата взноса<input type="date" required value={payment.date} onChange={event => setPayment({ ...payment, date: event.target.value })} /></label>}
          <MoneyField label="Сумма взноса, ₽" value={payment.amount} onChange={amount => setPayment({ ...payment, amount })} />
          <div className="actions"><button type="submit" className="primary">Сохранить платёж</button>
            <button type="button" onClick={() => setPayment(null)}>Отмена</button></div>
        </fieldset>
      </form>}
      {[...billing.periods].reverse().map(period => {
        const debt = periodBalance(billing, period);
        return <section className="payment-period" key={period.id}>
          <strong>{period.tariff.name} · до {dateLabel(period.due)}</strong>
          <small className="muted">{period.transferred ? 'Перенесён без начисления' : `${money(period.charge)} · ${durationText(period.tariff)}`}</small>
          {billing.payments.filter(item => item.periodId === period.id).sort((a, b) => b.date.localeCompare(a.date)).map(item =>
            <div key={item.id} className="payment-line"><span>{dateLabel(item.date)}: {money(item.amount)}</span>
              {canAct && <button type="button" disabled={busy} aria-label={`Исправить платёж ${dateLabel(item.date)}, ${money(item.amount)}`}
                onClick={() => setPayment({ kind: 'correct', id: item.id, date: item.date, amount: rubles(item.amount) })}>Исправить</button>}</div>)}
          {debt > 0 && <div className="payment-line"><span className="debt">К доплате: {money(debt)}</span>
            {canAct && <button type="button" disabled={busy} onClick={() => setPayment({ kind: 'pay', id: period.id, date: localToday(), amount: rubles(debt) })}>Внести доплату</button>}</div>}
        </section>;
      })}
    </section>}
  </>;
}
