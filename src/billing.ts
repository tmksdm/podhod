export type TariffDraft = {
  name: string;
  price: number;
  duration: number;
  unit: 'days' | 'months';
};

export type Tariff = TariffDraft & {
  id: string;
  enabled: boolean;
};

export type Period = {
  id: string;
  tariff: Tariff;
  start: string | null;
  due: string;
  charge: number;
  transferred: boolean;
};

export type Payment = {
  id: string;
  periodId: string;
  date: string;
  amount: number;
};

export type Billing = {
  periods: Period[];
  payments: Payment[];
};

export type Enrollment =
  | {
    kind: 'start' | 'renew';
    tariffId: string;
    date: string;
    amount: number;
    paymentDate?: string;
  }
  | { kind: 'transfer'; tariffId: string; date: string };

export type BillingAction =
  | Enrollment
  | { kind: 'pay'; periodId: string; date: string; amount: number }
  | { kind: 'correct'; paymentId: string; amount: number };

export class BillingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BillingError';
  }
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0');
}

function addExact(total: number, value: number): number {
  const result = total + value;
  if (!Number.isSafeInteger(result)) {
    throw new BillingError('Сумма в копейках выходит за допустимые границы.');
  }
  return result;
}

function utcDate(year: number, monthIndex: number, day: number): Date {
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, monthIndex, day);
  return date;
}

function parseDate(value: string): { year: number; month: number; day: number } {
  if (typeof value !== 'string') {
    throw new BillingError('Дата должна быть строкой в формате ГГГГ-ММ-ДД.');
  }
  const match = DATE_PATTERN.exec(value);
  if (match === null) {
    throw new BillingError('Дата должна быть строкой в формате ГГГГ-ММ-ДД.');
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) {
    throw new BillingError('Дата вне допустимого диапазона.');
  }
  const date = utcDate(year, month - 1, day);
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    throw new BillingError('Такой календарной даты не существует.');
  }
  return { year, month, day };
}

function formatDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  if (
    !Number.isInteger(year)
    || !Number.isInteger(month)
    || !Number.isInteger(day)
    || year < 1
    || year > 9999
  ) {
    throw new BillingError('Дата выходит за допустимые границы.');
  }
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

function daysInMonth(year: number, monthIndex: number): number {
  return utcDate(year, monthIndex + 1, 0).getUTCDate();
}

function assertDuration(duration: number): void {
  if (!Number.isSafeInteger(duration) || duration <= 0) {
    throw new BillingError('Срок должен быть положительным целым числом.');
  }
}

function assertUnit(unit: 'days' | 'months'): void {
  if (unit !== 'days' && unit !== 'months') {
    throw new BillingError('Срок задаётся в днях или календарных месяцах.');
  }
}

export function localToday(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const day = now.getDate();
  if (year < 1 || year > 9999) {
    throw new BillingError('Дата выходит за допустимые границы.');
  }
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

export function addDuration(date: string, duration: number, unit: 'days' | 'months'): string {
  const { year, month, day } = parseDate(date);
  assertDuration(duration);
  assertUnit(unit);

  if (unit === 'days') {
    const result = utcDate(year, month - 1, day + duration);
    return formatDate(result);
  }

  const totalMonths = month - 1 + duration;
  if (!Number.isSafeInteger(totalMonths)) {
    throw new BillingError('Срок выходит за допустимые границы.');
  }
  const targetYear = year + Math.floor(totalMonths / 12);
  const targetMonth = ((totalMonths % 12) + 12) % 12;
  if (targetYear < 1 || targetYear > 9999) {
    throw new BillingError('Срок выходит за допустимые границы.');
  }
  const targetDay = Math.min(day, daysInMonth(targetYear, targetMonth));
  return formatDate(utcDate(targetYear, targetMonth, targetDay));
}

export function periodBalance(billing: Billing, period: Period): number {
  if (!Number.isSafeInteger(period.charge)) {
    throw new BillingError('Начисление периода должно быть целым числом копеек.');
  }
  let paid = 0;
  for (const payment of billing.payments) {
    if (payment.periodId === period.id) {
      paid = addExact(paid, payment.amount);
    }
  }
  const balance = period.charge - paid;
  if (!Number.isSafeInteger(balance)) {
    throw new BillingError('Остаток периода выходит за допустимые границы.');
  }
  return balance;
}

export function billingBalance(billing: Billing | undefined): number {
  if (billing === undefined) {
    return 0;
  }
  let balance = 0;
  for (const period of billing.periods) {
    balance = addExact(balance, periodBalance(billing, period));
  }
  return balance;
}

export function latestPeriod(billing: Billing | undefined): Period | undefined {
  if (billing === undefined || billing.periods.length === 0) {
    return undefined;
  }
  let latest = billing.periods[0];
  for (let index = 1; index < billing.periods.length; index += 1) {
    const candidate = billing.periods[index];
    if (candidate.due >= latest.due) {
      latest = candidate;
    }
  }
  return latest;
}

function dueRank(due: string, today: string): number {
  if (due < today) {
    return 0;
  }
  if (due === today) {
    return 1;
  }
  if (due <= addDuration(today, 3, 'days')) {
    return 2;
  }
  return 3;
}

export function compareDue(
  a: Billing | undefined,
  b: Billing | undefined,
  today: string,
): number {
  const left = latestPeriod(a);
  const right = latestPeriod(b);
  if (left === undefined && right === undefined) {
    return 0;
  }
  if (left === undefined) {
    return 1;
  }
  if (right === undefined) {
    return -1;
  }
  const leftRank = dueRank(left.due, today);
  const rightRank = dueRank(right.due, today);
  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }
  if (left.due < right.due) {
    return -1;
  }
  if (left.due > right.due) {
    return 1;
  }
  return 0;
}

export function previewPeriod(
  tariff: Tariff,
  action: Enrollment,
  billing?: Billing,
): { start: string | null; due: string } {
  assertDuration(tariff.duration);
  assertUnit(tariff.unit);

  if (action.kind === 'transfer') {
    parseDate(action.date);
    return { start: null, due: action.date };
  }

  if (action.kind === 'start') {
    return {
      start: action.date,
      due: addDuration(action.date, tariff.duration, tariff.unit),
    };
  }

  if (action.kind !== 'renew') {
    throw new BillingError('Неизвестное действие абонемента.');
  }

  const latest = latestPeriod(billing);
  const start = latest !== undefined && latest.due > action.date ? latest.due : action.date;
  return {
    start,
    due: addDuration(start, tariff.duration, tariff.unit),
  };
}

export function dueStatus(billing: Billing | undefined, today: string): string {
  const period = latestPeriod(billing);
  if (period === undefined) {
    return 'Без абонемента';
  }
  const current = billing!.periods.some(
    candidate => (candidate.start === null || candidate.start <= today) && today < candidate.due,
  );
  if (!current && period.start !== null && period.start > today) {
    return 'Ещё не начался';
  }
  if (period.due < today) {
    return 'Просрочен';
  }
  if (period.due === today) {
    return 'Оплата сегодня';
  }
  if (period.due <= addDuration(today, 3, 'days')) {
    return 'Оплата в ближайшие 3 дня';
  }
  return 'Действует';
}
