import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Billing, Tariff } from './billing';
import { activeFreeze, compareDue, dueStatus, freezeDays, planFreeze, returnFromFreeze } from './billing';
import { createClient, deleteClients, listClients, saveTariff, setArchived, updateBilling } from './clients';

const tariff: Tariff = { id: 't', enabled: true, name: 'Месяц', price: 300_000, unit: 'months', duration: 1 };
function fixture(): Billing {
  return {
    periods: [
      { id: 'p1', tariff, start: '2026-01-31', due: '2026-02-28', charge: tariff.price, transferred: false },
      { id: 'p2', tariff, start: '2026-02-28', due: '2026-03-28', charge: tariff.price, transferred: false },
    ],
    payments: [{ id: 'pay', periodId: 'p2', date: '2026-02-04', amount: tariff.price }],
  };
}

afterEach(() => vi.useRealTimers());

describe('calendar freezes', () => {
  it('shifts each boundary exactly once and never changes payment data', () => {
    const billing = fixture();
    const payments = structuredClone(billing.payments);
    planFreeze(billing, 'f1', '2026-02-05', '2026-02-10', '2026-02-04');
    expect(freezeDays(billing.freezes![0])).toBe(5);
    expect(billing.periods.map(({ start, due }) => [start, due])).toEqual([
      ['2026-01-31', '2026-03-05'], ['2026-03-05', '2026-04-02'],
    ]);
    returnFromFreeze(billing, 'f1', '2026-02-08');
    expect(freezeDays(billing.freezes![0])).toBe(3);
    expect(billing.freezes![0]).toMatchObject({ plannedReturn: '2026-02-10', returnedOn: '2026-02-08' });
    expect(billing.periods.map(({ start, due, charge }) => [start, due, charge])).toEqual([
      ['2026-01-31', '2026-03-03', tariff.price], ['2026-03-03', '2026-03-31', tariff.price],
    ]);
    expect(() => returnFromFreeze(billing, 'f1', '2026-02-08')).toThrow();
    expect(billing.payments).toEqual(payments);
  });

  it('reports frozen even past the original due date and resumes on the exclusive return day', () => {
    const billing = fixture();
    billing.periods.pop();
    const overdue = fixture();
    overdue.periods.pop();
    planFreeze(billing, 'f', '2026-02-27', '2026-03-05', '2026-02-26');
    expect(activeFreeze(billing, '2026-02-26')).toBeUndefined();
    expect(dueStatus(billing, '2026-02-27')).toBe('Заморожен');
    expect(dueStatus(billing, '2026-03-04')).toBe('Заморожен');
    expect(compareDue(billing, overdue, '2026-03-04')).toBeGreaterThan(0);
    expect(activeFreeze(billing, '2026-03-05')).toBeUndefined();
    expect(billing.periods[0].due).toBe('2026-03-06');
  });

  it('rejects out of period, bad or overlapping dates and accepts adjacent pauses', () => {
    const billing = fixture();
    const today = '2026-01-28';
    expect(() => planFreeze(billing, 'bad', '2026-01-30', '2026-02-01', today)).toThrow(/внутри/);
    expect(() => planFreeze(billing, 'bad', '2026-03-28', '2026-04-01', today)).toThrow(/внутри/);
    expect(() => planFreeze(billing, 'bad', '2026-02-29', '2026-03-01', today)).toThrow();
    expect(() => planFreeze(billing, 'bad', '2026-02-05', '2026-02-05', today)).toThrow();
    planFreeze(billing, 'a', '2026-02-05', '2026-02-10', today);
    expect(() => planFreeze(billing, 'bad', '2026-02-07', '2026-02-11', today)).toThrow(/пересекаться/);
    planFreeze(billing, 'b', '2026-02-10', '2026-02-12', today);
    expect(activeFreeze(billing, '2026-02-10')?.id).toBe('b');
    returnFromFreeze(billing, 'a', '2026-02-05');
    planFreeze(billing, 'c', '2026-02-05', '2026-02-06', '2026-02-05');
    expect(activeFreeze(billing, '2026-02-05')?.id).toBe('c');
  });

  it('rejects a reservation that would fall outside its period after an early return', () => {
    const billing = fixture();
    planFreeze(billing, 'a', '2026-02-05', '2026-02-10', '2026-02-04');
    expect(() => planFreeze(billing, 'b', '2026-03-29', '2026-04-01', '2026-02-04')).toThrow(/зависит/);
    expect(billing.freezes).toHaveLength(1);
  });
});

it('persists history, preserves renewal across early return, and leaves archive read-only', async () => {
  vi.setSystemTime(new Date(2026, 1, 4, 12));
  const saved = await saveTariff(tariff);
  const client = await createClient({ firstName: 'Учебный', lastName: '', phone: '', notes: '' }, {
    kind: 'start', tariffId: saved.id, date: '2026-01-31', amount: tariff.price,
  });
  const { billing } = await updateBilling(client.id, { kind: 'freeze', start: '2026-02-05', plannedReturn: '2026-02-10' });
  const freeze = billing!.freezes![0];
  const renewed = await updateBilling(client.id, { kind: 'renew', tariffId: saved.id, date: '2026-02-04', amount: tariff.price });
  expect(renewed.billing!.periods[1]).toMatchObject({ start: '2026-03-05', due: '2026-04-05' });
  vi.setSystemTime(new Date(2026, 1, 8, 12));
  await updateBilling(client.id, { kind: 'return', freezeId: freeze.id });
  await setArchived([client.id], true);
  await expect(updateBilling(client.id, { kind: 'freeze', start: '2026-02-15', plannedReturn: '2026-02-17' })).rejects.toThrow(/Архивную/);
  const persisted = (await listClients()).find(item => item.id === client.id)!;
  expect(persisted.billing!.periods[1]).toMatchObject({ start: '2026-03-03', due: '2026-04-03' });
  expect(persisted.billing!.payments).toEqual(renewed.billing!.payments);
  expect(persisted.billing!.freezes).toEqual([{ ...freeze, returnedOn: '2026-02-08' }]);
  await deleteClients([client.id]);
  expect(await listClients()).not.toContainEqual(expect.objectContaining({ id: client.id }));
});

it('reads v2 clients and tariffs intact when upgrading to v3', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  try {
    const client = { id: 'v2', firstName: '', lastName: '', phone: '', notes: '', archived: false, billing: fixture() };
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('podhod', 2);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('clients', { keyPath: 'id' }).add(client);
        request.result.createObjectStore('tariffs', { keyPath: 'id' }).add(tariff);
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => { request.result.close(); resolve(); };
    });
    expect(await listClients()).toEqual([client]);
    vi.setSystemTime(new Date(2026, 1, 4, 12));
    const updated = await updateBilling(client.id, { kind: 'renew', tariffId: tariff.id, date: '2026-02-04', amount: 0 });
    expect(updated.billing!.periods.slice(0, 2)).toEqual(client.billing.periods);
    expect(updated.billing!.payments).toEqual(client.billing.payments);
  } finally {
    vi.unstubAllGlobals();
  }
});
