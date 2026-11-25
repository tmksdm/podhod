import 'fake-indexeddb/auto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tariff } from './billing';
import type { ClientFields, JournalSnapshot } from './clients';
import {
  createClient,
  readJournal,
  saveAppearance,
  saveTariff,
  setArchived,
  setTariffEnabled,
  updateBilling,
} from './clients';
import {
  BACKUP_PBKDF2_ITERATIONS,
  BackupError,
  MAX_BACKUP_FILE_BYTES,
  MAX_BACKUP_PASSWORD_LENGTH,
  MIN_BACKUP_PASSWORD_LENGTH,
  decodeBackup,
  encodeBackup,
} from './backup';

const DATABASE_NAME = 'podhod';
const PASSWORD = 'backup-2026!';
const ENVELOPE_FORMAT = 'podhod-backup';
const PAYLOAD_FORMAT = 'podhod-journal';

function removeDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Соединение с базой не закрыто.'));
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

function makeTariff(overrides: Partial<Tariff> = {}): Tariff {
  return {
    id: 'tariff-1',
    name: 'Месяц',
    price: 300_000,
    duration: 1,
    unit: 'months',
    enabled: true,
    ...overrides,
  };
}

function fixture(): JournalSnapshot {
  const month = makeTariff();
  const half = makeTariff({
    id: 'tariff-2',
    name: 'Полмесяца',
    price: 150_000,
    duration: 15,
    unit: 'days',
  });
  const disabled = makeTariff({
    id: 'tariff-3',
    name: 'Архивный',
    price: 0,
    duration: 30,
    unit: 'days',
    enabled: false,
  });
  return {
    appearance: { theme: 'dark', corners: 'square' },
    tariffs: [month, half, disabled],
    clients: [
      {
        id: 'client-1',
        firstName: 'Анна',
        lastName: 'Примерова',
        phone: '',
        notes: '',
        archived: false,
      },
      {
        id: 'client-2',
        firstName: 'Борис',
        lastName: 'Тестов',
        phone: '000-02',
        notes: 'Постоянный клиент',
        archived: true,
        billing: {
          periods: [
            {
              id: 'period-1',
              tariff: { ...month },
              start: '2026-01-31',
              due: '2026-02-28',
              charge: 300_000,
              transferred: false,
            },
            {
              id: 'period-2',
              tariff: { ...half },
              start: '2026-02-28',
              due: '2026-03-28',
              charge: 150_000,
              transferred: false,
            },
          ],
          payments: [
            { id: 'payment-1', periodId: 'period-1', date: '2026-01-31', amount: 300_000 },
            { id: 'payment-2', periodId: 'period-2', date: '2026-02-28', amount: 50_000 },
          ],
          freezes: [
            { id: 'freeze-1', periodId: 'period-2', start: '2026-03-01', plannedReturn: '2026-03-05' },
            {
              id: 'freeze-2',
              periodId: 'period-2',
              start: '2026-03-06',
              plannedReturn: '2026-03-08',
              returnedOn: '2026-03-07',
            },
          ],
        },
      },
      {
        id: 'client-3',
        firstName: 'Вера',
        lastName: 'Перенесова',
        phone: '000-03',
        notes: 'Перенос без абонемента',
        archived: false,
        billing: {
          periods: [
            {
              id: 'period-3',
              tariff: { ...month },
              start: null,
              due: '2026-05-01',
              charge: 0,
              transferred: true,
            },
          ],
          payments: [],
        },
      },
    ],
  };
}

function payloadFor(snapshot: unknown, version = 1): unknown {
  return {
    format: PAYLOAD_FORMAT,
    version,
    createdAt: '2026-11-25T16:00:00.000Z',
    snapshot,
  };
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

async function envelopeOf(file: File): Promise<Record<string, unknown>> {
  return JSON.parse(await file.text()) as Record<string, unknown>;
}

function fileFromEnvelope(
  envelope: unknown,
  name = 'podhod-backup-test.txt',
  type = 'text/plain',
): File {
  return new File([JSON.stringify(envelope)], name, { type });
}

async function sealPayload(payload: unknown, password: string): Promise<File> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const header = {
    format: ENVELOPE_FORMAT,
    version: 1,
    kdf: 'PBKDF2-SHA256',
    iterations: BACKUP_PBKDF2_ITERATIONS,
    cipher: 'AES-GCM',
    salt: toBase64(salt),
    iv: toBase64(iv),
  };
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  const key = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: BACKUP_PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  const additionalData = new TextEncoder().encode(JSON.stringify(header));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData, tagLength: 128 },
    key,
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  return fileFromEnvelope({ ...header, data: toBase64(new Uint8Array(ciphertext)) });
}

describe('файл резервной копии', () => {
  let sharedFile: File;

  beforeAll(async () => {
    sharedFile = await encodeBackup(fixture(), PASSWORD);
  }, 30_000);

  it('возвращает все данные после расшифровки независимо от имени и MIME', async () => {
    expect(PASSWORD).toHaveLength(MIN_BACKUP_PASSWORD_LENGTH);
    const copy = new File(
      [await sharedFile.text()],
      'странное-имя.bin',
      { type: 'application/octet-stream' },
    );
    const decoded = await decodeBackup(copy, PASSWORD);

    expect(decoded.snapshot).toEqual(fixture());
    expect(decoded.snapshot.clients[0]).not.toHaveProperty('billing');
    expect(decoded.snapshot.clients[2].billing).not.toHaveProperty('freezes');
    expect(decoded.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Number.isNaN(Date.parse(decoded.createdAt))).toBe(false);
  });

  it('создаёт текстовый файл с версией и без открытого пароля', async () => {
    expect(sharedFile.name).toMatch(/^podhod-backup-\d{4}-\d{2}-\d{2}\.txt$/);
    expect(sharedFile.type).toBe('text/plain');
    const text = await sharedFile.text();
    expect(text).not.toContain(PASSWORD);
    expect(JSON.parse(text)).toMatchObject({
      format: ENVELOPE_FORMAT,
      version: 1,
      kdf: 'PBKDF2-SHA256',
      cipher: 'AES-GCM',
      iterations: BACKUP_PBKDF2_ITERATIONS,
    });
  });

  it('шифрует один и тот же журнал с разными солью и вектором', async () => {
    const first = await envelopeOf(await encodeBackup(fixture(), PASSWORD));
    const second = await envelopeOf(await encodeBackup(fixture(), PASSWORD));

    expect(first.salt).not.toBe(second.salt);
    expect(first.iv).not.toBe(second.iv);
    expect(first.data).not.toBe(second.data);
  });

  it('отклоняет неверный пароль', async () => {
    await expect(decodeBackup(sharedFile, `${PASSWORD}!`))
      .rejects.toThrow(/Неверный пароль/);
  });

  it('отклоняет изменённый шифротекст', async () => {
    const envelope = await envelopeOf(sharedFile);
    const data = envelope.data as string;
    envelope.data = `${data[0] === 'A' ? 'B' : 'A'}${data.slice(1)}`;
    await expect(decodeBackup(fileFromEnvelope(envelope), PASSWORD))
      .rejects.toThrow(/повреждён/);
  });

  it('отклоняет неизвестную версию, стоимость, формат и лишние поля конверта', async () => {
    const envelope = await envelopeOf(sharedFile);
    const cases: Array<[string, Record<string, unknown>]> = [
      ['версия', { ...envelope, version: 2 }],
      ['стоимость', { ...envelope, iterations: 1 }],
      ['формат', { ...envelope, format: 'other-backup' }],
      ['соль', { ...envelope, salt: 'AAAA' }],
      ['данные', { ...envelope, data: 'AAAA' }],
      ['лишнее поле', { ...envelope, extra: true }],
    ];
    for (const [label, candidate] of cases) {
      await expect(decodeBackup(fileFromEnvelope(candidate), PASSWORD), label)
        .rejects.toBeInstanceOf(BackupError);
    }

    const missing = { ...envelope };
    delete missing.salt;
    await expect(decodeBackup(fileFromEnvelope(missing), PASSWORD))
      .rejects.toBeInstanceOf(BackupError);
    await expect(decodeBackup(fileFromEnvelope({ ...envelope, version: 2 }), PASSWORD))
      .rejects.toThrow(/Версия файла/);
  });

  it('ограничивает размер и отклоняет пустой файл', async () => {
    const oversized = {
      size: MAX_BACKUP_FILE_BYTES + 1,
      arrayBuffer: async () => new ArrayBuffer(0),
    } as unknown as File;
    await expect(decodeBackup(oversized, PASSWORD)).rejects.toThrow(/слишком большой/);
    await expect(decodeBackup(new File([], 'empty.txt'), PASSWORD)).rejects.toBeInstanceOf(BackupError);
    await expect(decodeBackup(new File(['{'], 'broken.txt'), PASSWORD)).rejects.toBeInstanceOf(BackupError);
  });

  it('проверяет большие base64-поля без переполнения стека', async () => {
    const envelope = await envelopeOf(sharedFile);
    envelope.data = `${'A'.repeat(16_000_000)}!!!!`;
    const file = fileFromEnvelope(envelope, 'large.txt');
    expect(file.size).toBeLessThan(MAX_BACKUP_FILE_BYTES);
    await expect(decodeBackup(file, PASSWORD)).rejects.toBeInstanceOf(BackupError);
  }, 10_000);

  it('не создаёт копию больше допустимого размера', async () => {
    const snapshot = fixture();
    snapshot.clients[0].notes = 'A'.repeat(13_000_000);
    await expect(encodeBackup(snapshot, PASSWORD)).rejects.toThrow(/слишком большой/);
  }, 10_000);

  it('требует минимальную длину пароля только при создании', async () => {
    await expect(encodeBackup(fixture(), 'a'.repeat(MIN_BACKUP_PASSWORD_LENGTH - 1)))
      .rejects.toThrow(/не менее/);
    await expect(encodeBackup(fixture(), 'a'.repeat(MAX_BACKUP_PASSWORD_LENGTH + 1)))
      .rejects.toThrow(/длинный/);
    await expect(encodeBackup(fixture(), '')).rejects.toThrow(/не указан/);

    const legacyPassword = 'short';
    const legacy = await sealPayload(payloadFor(fixture()), legacyPassword);
    await expect(decodeBackup(legacy, legacyPassword))
      .resolves.toMatchObject({ snapshot: fixture() });

    await expect(decodeBackup(sharedFile, '')).rejects.toThrow(/не указан/);
    await expect(decodeBackup(sharedFile, 'a'.repeat(MAX_BACKUP_PASSWORD_LENGTH + 1)))
      .rejects.toThrow(/длинный/);
  }, 20_000);
});

describe('проверка данных и связей', () => {
  it('не создаёт копию из журнала с нарушенными типами или связями', async () => {
    const invalid: Array<[string, (snapshot: JournalSnapshot) => void]> = [
      ['платёж без периода', snapshot => {
        snapshot.clients[1].billing!.payments[0].periodId = 'missing';
      }],
      ['заморозка без периода', snapshot => {
        snapshot.clients[1].billing!.freezes![0].periodId = 'missing';
      }],
      ['период без тарифа', snapshot => {
        snapshot.clients[1].billing!.periods[0].tariff.id = 'missing';
      }],
      ['повтор клиента', snapshot => {
        snapshot.clients[1].id = snapshot.clients[0].id;
      }],
      ['повтор периода', snapshot => {
        snapshot.clients[1].billing!.periods[1].id = snapshot.clients[1].billing!.periods[0].id;
      }],
      ['оформление', snapshot => {
        snapshot.appearance.theme = 'blue' as unknown as 'light';
      }],
      ['единица тарифа', snapshot => {
        snapshot.tariffs[0].unit = 'weeks' as unknown as 'days';
      }],
      ['дата платежа', snapshot => {
        snapshot.clients[1].billing!.payments[0].date = '2026-02-30';
      }],
      ['переплата', snapshot => {
        snapshot.clients[1].billing!.payments[0].amount = 300_001;
      }],
      ['нет платежей', snapshot => {
        delete (snapshot.clients[1].billing as unknown as Record<string, unknown>).payments;
      }],
      ['лишнее поле снимка', snapshot => {
        (snapshot as unknown as Record<string, unknown>).extra = true;
      }],
    ];

    for (const [label, mutate] of invalid) {
      const snapshot = structuredClone(fixture());
      mutate(snapshot);
      await expect(encodeBackup(snapshot, PASSWORD), label).rejects.toBeInstanceOf(BackupError);
    }
  });

  it('отклоняет расшифрованную копию с нарушенной связью платежа', async () => {
    const snapshot = structuredClone(fixture());
    snapshot.clients[1].billing!.payments[0].periodId = 'missing';
    const file = await sealPayload(payloadFor(snapshot), PASSWORD);
    await expect(decodeBackup(file, PASSWORD)).rejects.toBeInstanceOf(BackupError);
  }, 20_000);

  it('отклоняет неизвестную версию данных внутри копии', async () => {
    const file = await sealPayload(payloadFor(fixture(), 2), PASSWORD);
    await expect(decodeBackup(file, PASSWORD)).rejects.toThrow(/Версия данных/);
  }, 20_000);

});

describe('журнал, созданный приложением', () => {
  beforeEach(async () => {
    await removeDatabase();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('полностью сохраняется и восстанавливается вместе с оформлением', async () => {
    vi.setSystemTime(new Date(2026, 1, 4, 12));
    const month = await saveTariff({ name: 'Месяц', price: 300_000, duration: 1, unit: 'months' });
    const days = await saveTariff({ name: 'Дни', price: 100_000, duration: 10, unit: 'days' });
    await setTariffEnabled(days.id, false);
    await saveAppearance({ theme: 'dark', corners: 'square' });

    const empty = await createClient(fields({ firstName: 'Анна' }));
    const partial = await createClient(fields({ firstName: 'Борис' }), {
      kind: 'start',
      tariffId: month.id,
      date: '2026-01-31',
      amount: 200_000,
      paymentDate: '2026-01-30',
    });
    const returned = await createClient(fields({ firstName: 'Вера' }), {
      kind: 'start',
      tariffId: month.id,
      date: '2026-01-31',
      amount: 300_000,
    });
    const pending = await createClient(fields({ firstName: 'Глеб' }), {
      kind: 'start',
      tariffId: month.id,
      date: '2026-01-31',
      amount: 0,
    });
    const transferred = await createClient(fields({ firstName: 'Дина' }));
    await updateBilling(transferred.id, {
      kind: 'transfer',
      tariffId: month.id,
      date: '2026-05-01',
    });

    const planned = await updateBilling(returned.id, {
      kind: 'freeze',
      start: '2026-02-05',
      plannedReturn: '2026-02-10',
    });
    const freezeId = planned.billing!.freezes![0].id;
    vi.setSystemTime(new Date(2026, 1, 8, 12));
    await updateBilling(returned.id, { kind: 'return', freezeId });
    await updateBilling(returned.id, {
      kind: 'renew',
      tariffId: month.id,
      date: '2026-02-08',
      amount: 300_000,
    });
    await updateBilling(pending.id, {
      kind: 'freeze',
      start: '2026-02-09',
      plannedReturn: '2026-02-15',
    });
    await saveTariff({ name: 'Месяц обновлён', price: 450_000, duration: 2, unit: 'months' }, month.id);
    await setArchived([empty.id, partial.id], true);

    const snapshot = await readJournal();
    expect(snapshot.appearance).toEqual({ theme: 'dark', corners: 'square' });
    expect(snapshot.clients).toHaveLength(5);
    expect(snapshot.tariffs).toHaveLength(2);

    const file = await encodeBackup(snapshot, PASSWORD);
    const decoded = await decodeBackup(file, PASSWORD);
    expect(decoded.snapshot).toEqual(snapshot);
    expect(decoded.createdAt).toBe(new Date().toISOString());

    const returnedSnapshot = decoded.snapshot.clients.find(client => client.id === returned.id)!;
    expect(returnedSnapshot.billing!.freezes).toEqual([
      expect.objectContaining({ plannedReturn: '2026-02-10', returnedOn: '2026-02-08' }),
    ]);
    expect(returnedSnapshot.billing!.periods).toHaveLength(2);

    const pendingSnapshot = decoded.snapshot.clients.find(client => client.id === pending.id)!;
    expect(pendingSnapshot.billing!.freezes![0].returnedOn).toBeUndefined();

    const transferredSnapshot = decoded.snapshot.clients.find(client => client.id === transferred.id)!;
    expect(transferredSnapshot.billing!.periods[0]).toMatchObject({
      start: null,
      due: '2026-05-01',
      charge: 0,
      transferred: true,
    });
    expect(transferredSnapshot.billing).not.toHaveProperty('freezes');

    const partialSnapshot = decoded.snapshot.clients.find(client => client.id === partial.id)!;
    expect(partialSnapshot.archived).toBe(true);
    expect(partialSnapshot.billing).not.toHaveProperty('freezes');

    const monthSnapshot = decoded.snapshot.tariffs.find(tariff => tariff.id === month.id)!;
    expect(monthSnapshot).toMatchObject({ name: 'Месяц обновлён', price: 450_000, duration: 2 });
    expect(returnedSnapshot.billing!.periods[0].tariff.price).toBe(300_000);
    expect(decoded.snapshot.tariffs.find(tariff => tariff.id === days.id)!.enabled).toBe(false);
  }, 30_000);
});
