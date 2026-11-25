import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Billing, Enrollment, Payment, Period, Tariff, TariffDraft } from './billing';
import {
  BillingError,
  addDuration,
  billingBalance,
  compareDue,
  dueStatus,
  latestPeriod,
  localToday,
  periodBalance,
  previewPeriod,
} from './billing';
import type { Client, ClientFields } from './clients';
import {
  createClient,
  deleteClients,
  listClients,
  listTariffs,
  saveTariff,
  setArchived,
  setTariffEnabled,
  updateBilling,
} from './clients';

const DATABASE_NAME = 'podhod';

function removeDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Соединение с базой не закрыто.'));
  });
}

function openDatabaseVersion(
  version: number | undefined,
  upgrade?: (database: IDBDatabase) => void,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = version === undefined
      ? indexedDB.open(DATABASE_NAME)
      : indexedDB.open(DATABASE_NAME, version);
    request.onupgradeneeded = () => {
      upgrade?.(request.result);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Обновление базы заблокировано.'));
  });
}

function fields(overrides: Partial<ClientFields> = {}): ClientFields {
  return {
    firstName: 'Лада',
    lastName: 'Тестова',
    phone: '000-01',
    notes: 'Учебная заметка',
    ...overrides,
  };
}

const monthDraft: TariffDraft = {
  name: 'Месяц',
  price: 300000,
  duration: 1,
  unit: 'months',
};

async function createMonthTariff(overrides: Partial<TariffDraft> = {}): Promise<Tariff> {
  return saveTariff({ ...monthDraft, ...overrides });
}

function makeTariff(overrides: Partial<Tariff> = {}): Tariff {
  return {
    id: 'tariff-1',
    name: 'Месяц',
    price: 300000,
    duration: 1,
    unit: 'months',
    enabled: true,
    ...overrides,
  };
}

function makePeriod(overrides: Partial<Period> = {}): Period {
  return {
    id: 'period-1',
    tariff: makeTariff(),
    start: '2026-01-01',
    due: '2026-02-01',
    charge: 300000,
    transferred: false,
    ...overrides,
  };
}

function makeBilling(periods: Period[], payments: Payment[] = []): Billing {
  return { periods, payments };
}

async function subscriptionClient(amount = 0): Promise<{ client: Client; tariff: Tariff }> {
  const tariff = await createMonthTariff();
  const client = await createClient(fields(), {
    kind: 'start',
    tariffId: tariff.id,
    date: '2026-01-31',
    amount,
  });
  return { client, tariff };
}

beforeEach(async () => {
  await removeDatabase();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('addDuration', () => {
  it('прибавляет дни через календарную UTC-арифметику', () => {
    expect(addDuration('2026-12-31', 1, 'days')).toBe('2027-01-01');
    expect(addDuration('2028-02-28', 1, 'days')).toBe('2028-02-29');
    expect(addDuration('2026-01-31', 29, 'days')).toBe('2026-03-01');
  });

  it('ограничивает месяцы последним днём целевого месяца одной операцией', () => {
    expect(addDuration('2026-01-31', 1, 'months')).toBe('2026-02-28');
    expect(addDuration('2028-01-31', 1, 'months')).toBe('2028-02-29');
    expect(addDuration('2026-01-31', 2, 'months')).toBe('2026-03-31');
    expect(addDuration('2026-01-31', 13, 'months')).toBe('2027-02-28');
    expect(addDuration('2026-03-31', 1, 'months')).toBe('2026-04-30');
  });

  it('не зависит от времени суток и часового пояса', () => {
    expect(addDuration('2026-03-29', 1, 'days')).toBe('2026-03-30');
    expect(addDuration('2026-10-25', 1, 'days')).toBe('2026-10-26');
  });

  it('отклоняет неположительный или дробный срок', () => {
    expect(() => addDuration('2026-01-01', 0, 'days')).toThrow(BillingError);
    expect(() => addDuration('2026-01-01', -1, 'months')).toThrow(BillingError);
    expect(() => addDuration('2026-01-01', 1.5, 'months')).toThrow(BillingError);
    expect(() => addDuration('2026-01-01', Number.NaN, 'days')).toThrow(BillingError);
  });

  it('отклоняет несуществующие даты и неизвестные единицы', () => {
    expect(() => addDuration('2026-02-30', 1, 'days')).toThrow(BillingError);
    expect(() => addDuration('2026-13-01', 1, 'days')).toThrow(BillingError);
    expect(() => addDuration('31.01.2026', 1, 'days')).toThrow(BillingError);
    expect(() => addDuration('2026-01-01', 1, 'weeks' as unknown as 'days')).toThrow(BillingError);
  });

  it('не выходит за допустимые границы календаря', () => {
    expect(() => addDuration('9999-12-31', 1, 'days')).toThrow(BillingError);
    expect(() => addDuration('9999-12-31', 1, 'months')).toThrow(BillingError);
  });

  it('возвращает ошибку с именем BillingError', () => {
    try {
      addDuration('2026-02-30', 1, 'days');
      expect.unreachable('Ожидалась ошибка.');
    } catch (error) {
      expect(error).toBeInstanceOf(BillingError);
      expect((error as Error).name).toBe('BillingError');
    }
  });
});

describe('localToday', () => {
  it('возвращает локальную календарную дату без времени', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 9, 23, 30));
    expect(localToday()).toBe('2026-03-09');
    vi.setSystemTime(new Date(2026, 2, 10, 0, 5));
    expect(localToday()).toBe('2026-03-10');
  });
});

describe('остатки и последний период', () => {
  it('считает остаток периода по фактическим взносам', () => {
    const period = makePeriod();
    const other = makePeriod({ id: 'period-2', charge: 100000 });
    const billing = makeBilling([period, other], [
      { id: 'payment-1', periodId: period.id, date: '2026-01-10', amount: 200000 },
      { id: 'payment-2', periodId: period.id, date: '2026-01-20', amount: 50000 },
      { id: 'payment-3', periodId: other.id, date: '2026-01-21', amount: 100000 },
    ]);

    expect(periodBalance(billing, period)).toBe(50000);
    expect(periodBalance(billing, other)).toBe(0);
    expect(billingBalance(billing)).toBe(50000);
  });

  it('возвращает ноль без абонемента и суммирует несколько периодов', () => {
    expect(billingBalance(undefined)).toBe(0);
    expect(billingBalance(makeBilling([]))).toBe(0);

    const first = makePeriod();
    const second = makePeriod({ id: 'period-2', charge: 500000 });
    expect(billingBalance(makeBilling([first, second], [
      { id: 'payment-1', periodId: first.id, date: '2026-01-10', amount: 300000 },
    ]))).toBe(500000);
  });

  it('защищает агрегат от выхода за точные целые копейки', () => {
    const first = makePeriod({ charge: Number.MAX_SAFE_INTEGER });
    const second = makePeriod({ id: 'period-2', charge: Number.MAX_SAFE_INTEGER });
    expect(() => billingBalance(makeBilling([first, second]))).toThrow(BillingError);
  });

  it('находит последний период по сроку оплаты', () => {
    expect(latestPeriod(undefined)).toBeUndefined();
    expect(latestPeriod(makeBilling([]))).toBeUndefined();

    const first = makePeriod({ due: '2026-02-01' });
    const second = makePeriod({ id: 'period-2', due: '2026-03-01' });
    expect(latestPeriod(makeBilling([second, first]))).toBe(second);
  });
});

describe('previewPeriod', () => {
  it('для нового абонемента начинает с выбранной даты и ограничивает месяц', () => {
    expect(previewPeriod(makeTariff(), {
      kind: 'start',
      tariffId: 'tariff-1',
      date: '2026-01-31',
      amount: 0,
    })).toEqual({ start: '2026-01-31', due: '2026-02-28' });
  });

  it('при досрочном продлении прибавляет срок к текущей дате оплаты', () => {
    const billing = makeBilling([makePeriod({ due: '2026-03-15' })]);
    expect(previewPeriod(makeTariff(), {
      kind: 'renew',
      tariffId: 'tariff-1',
      date: '2026-03-01',
      amount: 0,
    }, billing)).toEqual({ start: '2026-03-15', due: '2026-04-15' });
  });

  it('после просрочки начинает новый срок с даты платежа', () => {
    const billing = makeBilling([makePeriod({ due: '2026-02-01' })]);
    expect(previewPeriod(makeTariff(), {
      kind: 'renew',
      tariffId: 'tariff-1',
      date: '2026-03-10',
      amount: 0,
    }, billing)).toEqual({ start: '2026-03-10', due: '2026-04-10' });
  });

  it('при оплате ровно в срок начинает с даты оплаты', () => {
    const billing = makeBilling([makePeriod({ due: '2026-03-01' })]);
    expect(previewPeriod(makeTariff(), {
      kind: 'renew',
      tariffId: 'tariff-1',
      date: '2026-03-01',
      amount: 0,
    }, billing)).toEqual({ start: '2026-03-01', due: '2026-04-01' });
  });

  it('для переноса берёт известную дату оплаты без начала', () => {
    expect(previewPeriod(makeTariff(), {
      kind: 'transfer',
      tariffId: 'tariff-1',
      date: '2026-05-01',
    })).toEqual({ start: null, due: '2026-05-01' });
  });

  it('не связывает дату платежа с началом нового абонемента', () => {
    expect(previewPeriod(makeTariff(), {
      kind: 'start',
      tariffId: 'tariff-1',
      date: '2026-01-10',
      amount: 100000,
      paymentDate: '2026-01-01',
    })).toEqual({ start: '2026-01-10', due: '2026-02-10' });
  });

  it('отклоняет несуществующую дату переноса', () => {
    expect(() => previewPeriod(makeTariff(), {
      kind: 'transfer',
      tariffId: 'tariff-1',
      date: '2026-02-30',
    })).toThrow(BillingError);
  });
});

describe('dueStatus', () => {
  const today = '2026-03-10';

  it('показывает отсутствие абонемента', () => {
    expect(dueStatus(undefined, today)).toBe('Без абонемента');
    expect(dueStatus(makeBilling([]), today)).toBe('Без абонемента');
  });

  it('различает просрочку, оплату сегодня и ближайшие три дня', () => {
    expect(dueStatus(makeBilling([makePeriod({ due: '2026-03-09' })]), today)).toBe('Просрочен');
    expect(dueStatus(makeBilling([makePeriod({ due: '2026-03-10' })]), today)).toBe('Оплата сегодня');
    expect(dueStatus(makeBilling([makePeriod({ due: '2026-03-11' })]), today)).toBe('Оплата в ближайшие 3 дня');
    expect(dueStatus(makeBilling([makePeriod({ due: '2026-03-13' })]), today)).toBe('Оплата в ближайшие 3 дня');
    expect(dueStatus(makeBilling([makePeriod({ due: '2026-03-14' })]), today)).toBe('Действует');
  });

  it('учитывает переход через конец месяца', () => {
    expect(dueStatus(makeBilling([makePeriod({ due: '2026-02-02' })]), '2026-01-30'))
      .toBe('Оплата в ближайшие 3 дня');
  });

  it('показывает ещё не начавшийся абонемент', () => {
    expect(dueStatus(makeBilling([makePeriod({ start: '2026-04-01', due: '2026-05-01' })]), today))
      .toBe('Ещё не начался');
  });

  it('при досрочном продлении сохраняет действующий статус текущего периода', () => {
    const billing = makeBilling([
      makePeriod({ start: '2026-01-31', due: '2026-02-28' }),
      makePeriod({ id: 'period-2', start: '2026-02-28', due: '2026-03-28' }),
    ]);
    expect(dueStatus(billing, '2026-02-15')).toBe('Действует');
  });

  it('для перенесённого срока без начала использует дату оплаты', () => {
    expect(dueStatus(makeBilling([makePeriod({
      start: null,
      due: '2026-03-01',
      charge: 0,
      transferred: true,
    })]), today)).toBe('Просрочен');
  });
});

describe('compareDue', () => {
  const today = '2026-03-10';

  it('сортирует просрочку, сегодня, ближайшие дни, остальных и без абонемента', () => {
    const items = [
      { name: 'без', billing: undefined },
      { name: 'позже', billing: makeBilling([makePeriod({ due: '2026-04-20' })]) },
      { name: 'сегодня', billing: makeBilling([makePeriod({ due: '2026-03-10' })]) },
      { name: 'просрочка-2', billing: makeBilling([makePeriod({ due: '2026-03-01' })]) },
      { name: 'скоро', billing: makeBilling([makePeriod({ due: '2026-03-12' })]) },
      { name: 'просрочка-1', billing: makeBilling([makePeriod({ due: '2026-02-01' })]) },
    ];
    items.sort((a, b) => compareDue(a.billing, b.billing, today));
    expect(items.map(item => item.name)).toEqual([
      'просрочка-1',
      'просрочка-2',
      'сегодня',
      'скоро',
      'позже',
      'без',
    ]);
  });

  it('возвращает ноль при равных сроках и двух пустых абонементах', () => {
    expect(compareDue(undefined, undefined, today)).toBe(0);
    const left = makeBilling([makePeriod({ due: '2026-04-01' })]);
    const right = makeBilling([makePeriod({ id: 'period-2', due: '2026-04-01' })]);
    expect(compareDue(left, right, today)).toBe(0);
  });
});

describe('тарифы', () => {
  it('создаёт тариф с ценой ноль и возвращает сохранённые значения', async () => {
    const tariff = await saveTariff({
      name: 'Пробный',
      price: 0,
      duration: 10,
      unit: 'days',
    });

    expect(tariff).toEqual({
      id: expect.any(String),
      name: 'Пробный',
      price: 0,
      duration: 10,
      unit: 'days',
      enabled: true,
    });
    await expect(listTariffs()).resolves.toEqual([tariff]);
  });

  it('сохраняет порядок создания и редактирует без смены идентификатора', async () => {
    const first = await createMonthTariff({ name: 'Первый' });
    const second = await createMonthTariff({ name: 'Второй' });
    expect((await listTariffs()).map(tariff => tariff.id)).toEqual([first.id, second.id]);

    const updated = await saveTariff({
      name: 'Обновлённый',
      price: 450000,
      duration: 3,
      unit: 'months',
    }, first.id);

    expect(updated).toEqual({
      id: first.id,
      name: 'Обновлённый',
      price: 450000,
      duration: 3,
      unit: 'months',
      enabled: true,
    });
    await expect(listTariffs()).resolves.toEqual([updated, second]);
  });

  it('отключает тариф, сохраняет его в истории и не включает при редактировании', async () => {
    const tariff = await createMonthTariff();
    const disabled = await setTariffEnabled(tariff.id, false);
    expect(disabled).toEqual({ ...tariff, enabled: false });
    await expect(listTariffs()).resolves.toEqual([disabled]);

    const edited = await saveTariff({ ...monthDraft, name: 'Архивный' }, tariff.id);
    expect(edited.enabled).toBe(false);
    await expect(listTariffs()).resolves.toEqual([edited]);
  });

  it('отклоняет некорректные черновики и не создаёт записи', async () => {
    const invalid: TariffDraft[] = [
      { name: '', price: 100, duration: 1, unit: 'days' },
      { name: '   ', price: 100, duration: 1, unit: 'days' },
      { name: 'Минус', price: -1, duration: 1, unit: 'days' },
      { name: 'Дробь', price: 100.5, duration: 1, unit: 'days' },
      { name: 'Ноль', price: 100, duration: 0, unit: 'days' },
      { name: 'Дробный срок', price: 100, duration: 1.5, unit: 'days' },
      { name: 'Год', price: 100, duration: 1, unit: 'years' as unknown as 'days' },
    ];

    for (const draft of invalid) {
      await expect(saveTariff(draft)).rejects.toBeInstanceOf(BillingError);
    }
    await expect(listTariffs()).resolves.toEqual([]);
  });

  it('отклоняет неизвестные идентификаторы при правке и переключении', async () => {
    await expect(saveTariff(monthDraft, 'unknown-id')).rejects.toBeInstanceOf(BillingError);
    await expect(setTariffEnabled('unknown-id', false)).rejects.toBeInstanceOf(BillingError);
    await expect(listTariffs()).resolves.toEqual([]);
  });
});

describe('версия базы и миграция', () => {
  it('обновляет схему и переносит карточки из версии 1', async () => {
    const seed = { ...fields(), id: 'old-client', archived: false };
    const versionOne = await openDatabaseVersion(1, (database) => {
      database.createObjectStore('clients', { keyPath: 'id' });
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = versionOne.transaction('clients', 'readwrite');
      transaction.objectStore('clients').add(seed);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    versionOne.close();

    await expect(listClients()).resolves.toEqual([seed]);
    await expect(listTariffs()).resolves.toEqual([]);
    const tariff = await createMonthTariff();
    await expect(listTariffs()).resolves.toEqual([tariff]);

    const current = await openDatabaseVersion(undefined);
    try { expect(current.version).toBe(4); }
    finally { current.close(); }
  });
});

describe('createClient с абонементом', () => {
  it('сохраняет карточку без абонемента без поля billing', async () => {
    const values = fields();
    const created = await createClient(values);

    expect(created).toEqual({ ...values, id: created.id, archived: false });
    expect('billing' in created).toBe(false);
    await expect(listClients()).resolves.toEqual([created]);
  });

  it('оформляет абонемент с частичной оплатой и отдельной датой платежа', async () => {
    const tariff = await createMonthTariff();
    const enrollment: Enrollment = {
      kind: 'start',
      tariffId: tariff.id,
      date: '2026-01-31',
      amount: 200000,
      paymentDate: '2026-01-25',
    };
    const client = await createClient(fields(), enrollment);
    const billing = client.billing;

    expect(billing?.periods).toHaveLength(1);
    const period = billing!.periods[0];
    expect(period).toMatchObject({
      start: '2026-01-31',
      due: '2026-02-28',
      charge: 300000,
      transferred: false,
    });
    expect(period.tariff).toEqual(tariff);
    expect(billing!.payments).toHaveLength(1);
    expect(billing!.payments[0]).toMatchObject({
      periodId: period.id,
      date: '2026-01-25',
      amount: 200000,
    });
    expect(periodBalance(billing!, period)).toBe(100000);
    expect(billingBalance(billing)).toBe(100000);
  });

  it('при нулевой сумме не создаёт фиктивный платёж', async () => {
    const { client } = await subscriptionClient(0);

    expect(client.billing?.payments).toEqual([]);
    expect(billingBalance(client.billing)).toBe(300000);
  });

  it('переносит известную дату оплаты без платежа и долга', async () => {
    const tariff = await createMonthTariff();
    const client = await createClient(fields(), {
      kind: 'transfer',
      tariffId: tariff.id,
      date: '2026-05-01',
    });
    const period = client.billing!.periods[0];

    expect(period).toMatchObject({
      start: null,
      due: '2026-05-01',
      charge: 0,
      transferred: true,
    });
    expect(client.billing!.payments).toEqual([]);
    expect(billingBalance(client.billing)).toBe(0);
    expect(dueStatus(client.billing, '2026-04-30')).toBe('Оплата в ближайшие 3 дня');
  });

  it('не создаёт карточку при неизвестном, отключённом тарифе или ошибке суммы', async () => {
    const tariff = await createMonthTariff();
    await setTariffEnabled(tariff.id, false);

    await expect(createClient(fields(), {
      kind: 'start',
      tariffId: tariff.id,
      date: '2026-01-01',
      amount: 0,
    })).rejects.toBeInstanceOf(BillingError);
    await expect(createClient(fields(), {
      kind: 'start',
      tariffId: 'unknown-id',
      date: '2026-01-01',
      amount: 0,
    })).rejects.toBeInstanceOf(BillingError);
    await expect(createClient(fields(), {
      kind: 'start',
      tariffId: tariff.id,
      date: '2026-01-01',
      amount: 300001,
    })).rejects.toBeInstanceOf(BillingError);
    await expect(listClients()).resolves.toEqual([]);
  });

  it('отклоняет продление без существующего абонемента', async () => {
    const tariff = await createMonthTariff();
    await expect(createClient(fields(), {
      kind: 'renew',
      tariffId: tariff.id,
      date: '2026-01-01',
      amount: 0,
    })).rejects.toBeInstanceOf(BillingError);
    await expect(listClients()).resolves.toEqual([]);
  });

  it('отклоняет несуществующие даты и нецелые суммы', async () => {
    const tariff = await createMonthTariff();
    await expect(createClient(fields(), {
      kind: 'start',
      tariffId: tariff.id,
      date: '2026-02-30',
      amount: 0,
    })).rejects.toBeInstanceOf(BillingError);
    await expect(createClient(fields(), {
      kind: 'start',
      tariffId: tariff.id,
      date: '2026-01-01',
      amount: 100.5,
    })).rejects.toBeInstanceOf(BillingError);
    await expect(createClient(fields(), {
      kind: 'start',
      tariffId: tariff.id,
      date: '2026-01-01',
      amount: 0,
      paymentDate: '2025-02-30',
    })).rejects.toBeInstanceOf(BillingError);
    await expect(listClients()).resolves.toEqual([]);
  });

  it('различает будущее начало абонемента', async () => {
    const tariff = await createMonthTariff();
    const client = await createClient(fields(), {
      kind: 'start',
      tariffId: tariff.id,
      date: '2026-04-01',
      amount: 0,
      paymentDate: '2026-03-20',
    });

    expect(dueStatus(client.billing, '2026-03-10')).toBe('Ещё не начался');
  });
});

describe('updateBilling: оплаты', () => {
  it('принимает доплату без изменения срока', async () => {
    const { client } = await subscriptionClient(200000);
    const period = client.billing!.periods[0];

    const updated = await updateBilling(client.id, {
      kind: 'pay',
      periodId: period.id,
      date: '2026-02-01',
      amount: 100000,
    });

    expect(updated.billing!.periods[0]).toEqual(period);
    expect(billingBalance(updated.billing)).toBe(0);
    expect(updated.billing!.payments).toHaveLength(2);
  });

  it('не теряет предыдущие взносы при последовательных действиях', async () => {
    const { client } = await subscriptionClient(0);
    const period = client.billing!.periods[0];

    await updateBilling(client.id, {
      kind: 'pay',
      periodId: period.id,
      date: '2026-01-10',
      amount: 100000,
    });
    const updated = await updateBilling(client.id, {
      kind: 'pay',
      periodId: period.id,
      date: '2026-01-11',
      amount: 50000,
    });

    expect(updated.billing!.payments).toHaveLength(2);
    expect(billingBalance(updated.billing)).toBe(150000);
  });

  it('разрешает оплатить прошлый период после продления', async () => {
    const { client } = await subscriptionClient(0);
    const first = client.billing!.periods[0];
    const renewed = await updateBilling(client.id, {
      kind: 'renew',
      tariffId: client.billing!.periods[0].tariff.id,
      date: '2026-02-01',
      amount: 0,
    });

    expect(renewed.billing!.periods).toHaveLength(2);
    const updated = await updateBilling(client.id, {
      kind: 'pay',
      periodId: first.id,
      date: '2026-02-10',
      amount: 100000,
    });

    expect(updated.billing!.periods).toEqual(renewed.billing!.periods);
    expect(billingBalance(updated.billing)).toBe(500000);
  });

  it('отклоняет переплату и не меняет карточку', async () => {
    const { client } = await subscriptionClient(200000);
    const period = client.billing!.periods[0];

    await expect(updateBilling(client.id, {
      kind: 'pay',
      periodId: period.id,
      date: '2026-02-01',
      amount: 100001,
    })).rejects.toBeInstanceOf(BillingError);

    const [stored] = (await listClients()).filter(item => item.id === client.id);
    expect(stored).toEqual(client);
  });

  it('отклоняет нулевую, дробную, отрицательную оплату и неверную дату', async () => {
    const { client } = await subscriptionClient(0);
    const period = client.billing!.periods[0];
    const invalid = [
      { date: '2026-01-10', amount: 0 },
      { date: '2026-01-10', amount: -100 },
      { date: '2026-01-10', amount: 100.5 },
      { date: '2026-02-30', amount: 100 },
    ];

    for (const action of invalid) {
      await expect(updateBilling(client.id, {
        kind: 'pay',
        periodId: period.id,
        ...action,
      })).rejects.toBeInstanceOf(BillingError);
    }
    await expect(updateBilling(client.id, {
      kind: 'pay',
      periodId: 'unknown-period',
      date: '2026-01-10',
      amount: 100,
    })).rejects.toBeInstanceOf(BillingError);
  });
});

describe('updateBilling: продление и тарифы', () => {
  it('досрочно прибавляет срок к текущей дате оплаты', async () => {
    const { client } = await subscriptionClient(0);
    const updated = await updateBilling(client.id, {
      kind: 'renew',
      tariffId: client.billing!.periods[0].tariff.id,
      date: '2026-01-15',
      amount: 100000,
    });

    expect(updated.billing!.periods).toHaveLength(2);
    expect(updated.billing!.periods[1]).toMatchObject({
      start: '2026-02-28',
      due: '2026-03-28',
      charge: 300000,
    });
    expect(updated.billing!.payments[0]).toMatchObject({
      date: '2026-01-15',
      amount: 100000,
    });
  });

  it('после просрочки начинает срок с даты платежа', async () => {
    const { client } = await subscriptionClient(0);
    const updated = await updateBilling(client.id, {
      kind: 'renew',
      tariffId: client.billing!.periods[0].tariff.id,
      date: '2026-03-10',
      amount: 0,
    });

    expect(updated.billing!.periods[1]).toMatchObject({
      start: '2026-03-10',
      due: '2026-04-10',
    });
  });

  it('берёт свежий тариф и сохраняет снимок прошлого периода', async () => {
    const { client, tariff } = await subscriptionClient(0);
    const oldPeriod = client.billing!.periods[0];

    await saveTariff({
      name: 'Новый',
      price: 450000,
      duration: 2,
      unit: 'months',
    }, tariff.id);

    const updated = await updateBilling(client.id, {
      kind: 'renew',
      tariffId: tariff.id,
      date: '2026-01-15',
      amount: 100000,
    });
    const newPeriod = updated.billing!.periods[1];

    expect(updated.billing!.periods[0]).toEqual(oldPeriod);
    expect(newPeriod.tariff).toMatchObject({
      id: tariff.id,
      name: 'Новый',
      price: 450000,
      duration: 2,
      unit: 'months',
      enabled: true,
    });
    expect(newPeriod).toMatchObject({
      start: '2026-02-28',
      due: '2026-04-28',
      charge: 450000,
    });
  });

  it('отклоняет отключённый тариф и не меняет абонемент', async () => {
    const { client } = await subscriptionClient(0);
    await setTariffEnabled(client.billing!.periods[0].tariff.id, false);

    await expect(updateBilling(client.id, {
      kind: 'renew',
      tariffId: client.billing!.periods[0].tariff.id,
      date: '2026-01-15',
      amount: 0,
    })).rejects.toBeInstanceOf(BillingError);

    const [stored] = (await listClients()).filter(item => item.id === client.id);
    expect(stored).toEqual(client);
  });

  it('не сохраняет абонемент с неточным агрегатным остатком', async () => {
    const tariff = await createMonthTariff({ price: Number.MAX_SAFE_INTEGER });
    const client = await createClient(fields(), {
      kind: 'start',
      tariffId: tariff.id,
      date: '2026-01-31',
      amount: 0,
    });

    await expect(updateBilling(client.id, {
      kind: 'renew',
      tariffId: tariff.id,
      date: '2026-02-01',
      amount: 0,
    })).rejects.toBeInstanceOf(BillingError);

    const [stored] = (await listClients()).filter(item => item.id === client.id);
    expect(stored).toEqual(client);
  });

  it('переносит срок на пустой карточке и затем продлевает его', async () => {
    const tariff = await createMonthTariff();
    const client = await createClient(fields());
    const transferred = await updateBilling(client.id, {
      kind: 'transfer',
      tariffId: tariff.id,
      date: '2026-05-01',
    });
    const period = transferred.billing!.periods[0];

    expect(period).toMatchObject({
      start: null,
      due: '2026-05-01',
      charge: 0,
      transferred: true,
    });
    expect(billingBalance(transferred.billing)).toBe(0);

    const renewed = await updateBilling(client.id, {
      kind: 'renew',
      tariffId: tariff.id,
      date: '2026-04-20',
      amount: 0,
    });
    expect(renewed.billing!.periods[1]).toMatchObject({
      start: '2026-05-01',
      due: '2026-06-01',
      charge: 300000,
    });
  });

  it('отклоняет повторное оформление и перенос при существующих периодах', async () => {
    const { client } = await subscriptionClient(0);
    const tariffId = client.billing!.periods[0].tariff.id;

    await expect(updateBilling(client.id, {
      kind: 'start',
      tariffId,
      date: '2026-01-15',
      amount: 0,
    })).rejects.toBeInstanceOf(BillingError);
    await expect(updateBilling(client.id, {
      kind: 'transfer',
      tariffId,
      date: '2026-05-01',
    })).rejects.toBeInstanceOf(BillingError);
  });
});

describe('updateBilling: исправление платежа', () => {
  it('меняет только сумму и пересчитывает остаток', async () => {
    const { client } = await subscriptionClient(100000);
    const payment = client.billing!.payments[0];
    const period = client.billing!.periods[0];

    const updated = await updateBilling(client.id, {
      kind: 'correct',
      paymentId: payment.id,
      amount: 250000,
    });
    const corrected = updated.billing!.payments[0];

    expect(corrected).toEqual({ ...payment, amount: 250000 });
    expect(corrected.date).toBe(payment.date);
    expect(corrected.periodId).toBe(payment.periodId);
    expect(updated.billing!.periods[0]).toEqual(period);
    expect(periodBalance(updated.billing!, period)).toBe(50000);
  });

  it('учитывает другие взносы и отклоняет переплату', async () => {
    const { client } = await subscriptionClient(100000);
    const period = client.billing!.periods[0];
    const payment = client.billing!.payments[0];
    const afterPay = await updateBilling(client.id, {
      kind: 'pay',
      periodId: period.id,
      date: '2026-01-15',
      amount: 100000,
    });

    await expect(updateBilling(client.id, {
      kind: 'correct',
      paymentId: payment.id,
      amount: 250000,
    })).rejects.toBeInstanceOf(BillingError);
    await expect(updateBilling(client.id, {
      kind: 'correct',
      paymentId: payment.id,
      amount: 200000,
    })).resolves.toBeDefined();
    expect(billingBalance(afterPay.billing)).toBe(100000);
  });

  it('разрешает исправить платёж прошлого периода после продления', async () => {
    const { client } = await subscriptionClient(100000);
    const firstPeriod = client.billing!.periods[0];
    const firstPayment = client.billing!.payments[0];
    await updateBilling(client.id, {
      kind: 'renew',
      tariffId: firstPeriod.tariff.id,
      date: '2026-02-01',
      amount: 0,
    });

    const updated = await updateBilling(client.id, {
      kind: 'correct',
      paymentId: firstPayment.id,
      amount: 300000,
    });

    expect(updated.billing!.periods[0]).toEqual(firstPeriod);
    expect(periodBalance(updated.billing!, firstPeriod)).toBe(0);
    expect(billingBalance(updated.billing)).toBe(300000);
  });

  it('отклоняет пустую, отрицательную, дробную сумму и неизвестный платёж', async () => {
    const { client } = await subscriptionClient(100000);
    const payment = client.billing!.payments[0];
    for (const amount of [0, -100, 100.5]) {
      await expect(updateBilling(client.id, {
        kind: 'correct',
        paymentId: payment.id,
        amount,
      })).rejects.toBeInstanceOf(BillingError);
    }
    await expect(updateBilling(client.id, {
      kind: 'correct',
      paymentId: 'unknown-payment',
      amount: 100,
    })).rejects.toBeInstanceOf(BillingError);
  });
});

describe('архив и удаление', () => {
  it('архив сохраняет абонемент, но запрещает его менять', async () => {
    const { client } = await subscriptionClient(100000);
    await setArchived([client.id], true);

    const archived = (await listClients())[0];
    expect(archived.archived).toBe(true);
    expect(archived.billing).toEqual(client.billing);

    await expect(updateBilling(client.id, {
      kind: 'pay',
      periodId: client.billing!.periods[0].id,
      date: '2026-01-15',
      amount: 100000,
    })).rejects.toBeInstanceOf(BillingError);
    expect((await listClients())[0]).toEqual(archived);

    await setArchived([client.id], false);
    await expect(updateBilling(client.id, {
      kind: 'pay',
      periodId: client.billing!.periods[0].id,
      date: '2026-01-15',
      amount: 100000,
    })).resolves.toBeDefined();
  });

  it('удаляет карточку вместе со встроенным абонементом', async () => {
    const { client } = await subscriptionClient(100000);
    await deleteClients([client.id]);
    await expect(listClients()).resolves.toEqual([]);
  });
});
