import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createClient,
  deleteClients,
  listClients,
  matchesClient,
  readJournal,
  replaceJournal,
  saveAppearance,
  saveTariff,
  setArchived,
} from './clients';
import type { Appearance, Client, ClientFields, JournalSnapshot } from './clients';
import type { Tariff } from './billing';

const DATABASE_NAME = 'podhod';
const CLIENT_STORE = 'clients';
const TARIFF_STORE = 'tariffs';
const SETTINGS_STORE = 'settings';
const APPEARANCE_KEY = 'podhod.appearance';

function fields(overrides: Partial<ClientFields> = {}): ClientFields {
  return {
    firstName: 'Лада',
    lastName: 'Тестова',
    phone: '000-01',
    notes: 'Учебная заметка',
    ...overrides,
  };
}

function deleteDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Соединение с базой не закрыто.'));
  });
}

async function byId(ids: readonly string[]): Promise<Map<string, Client>> {
  const clients = await listClients();
  return new Map(clients.filter(client => ids.includes(client.id)).map(client => [client.id, client]));
}

function installLegacyStorage(initial: Record<string, string> = {}): Map<string, string> {
  const values = new Map(Object.entries(initial));
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => { values.clear(); },
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  });
  return values;
}

function sampleClient(id: string, firstName = 'Лада'): Client {
  return {
    firstName,
    lastName: 'Тестова',
    phone: '000-10',
    notes: 'Вымышленная запись',
    id,
    archived: false,
  };
}

const sampleTariff: Tariff = {
  id: 'tariff-sample',
  name: 'Пробный',
  price: 0,
  duration: 7,
  unit: 'days',
  enabled: true,
};

function seedVersion3(clients: readonly Client[], tariffs: readonly Tariff[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 3);
    request.onupgradeneeded = () => {
      const database = request.result;
      database.createObjectStore(CLIENT_STORE, { keyPath: 'id' });
      database.createObjectStore(TARIFF_STORE, { keyPath: 'id' });
      const transaction = request.transaction;
      if (transaction === null) {
        reject(new Error('Нет транзакции обновления.'));
        return;
      }
      const clientStore = transaction.objectStore(CLIENT_STORE);
      const tariffStore = transaction.objectStore(TARIFF_STORE);
      for (const client of clients) {
        clientStore.add(client);
      }
      for (const tariff of tariffs) {
        tariffStore.add(tariff);
      }
    };
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
    request.onerror = () => reject(request.error ?? new Error('Не удалось создать базу версии 3.'));
    request.onblocked = () => reject(new Error('Соединение с базой не закрыто.'));
  });
}

beforeEach(async () => {
  await deleteDatabase();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('createClient и listClients', () => {
  it('сохраняет заполненную карточку и возвращает её после фиксации', async () => {
    const values = fields();
    const created = await createClient(values);

    expect(created.id).toEqual(expect.any(String));
    expect(created.id.length).toBeGreaterThan(0);
    expect(created).toEqual({ ...values, id: created.id, archived: false });
    await expect(listClients()).resolves.toEqual([created]);
  });

  it('сохраняет пустую карточку', async () => {
    const empty: ClientFields = { firstName: '', lastName: '', phone: '', notes: '' };
    const created = await createClient(empty);

    expect(created).toEqual({ ...empty, id: created.id, archived: false });
    await expect(listClients()).resolves.toEqual([created]);
  });

  it('не стирает ранее сохранённые записи при повторном открытии', async () => {
    const first = await createClient(fields());
    const second = await createClient(fields({ firstName: 'Марк', lastName: 'Примеров' }));

    const clients = await listClients();
    expect(clients).toHaveLength(2);
    expect(clients).toEqual(expect.arrayContaining([first, second]));
  });

  it('создаёт версию базы 4 и закрывает соединение после операции', async () => {
    const created = await createClient(fields());

    const version = await new Promise<number>((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME);
      request.onsuccess = () => {
        const database = request.result;
        const value = database.version;
        database.close();
        resolve(value);
      };
      request.onerror = () => reject(request.error);
    });

    expect(version).toBe(4);
    await expect(deleteDatabase()).resolves.toBeUndefined();
    await expect(listClients()).resolves.toEqual([]);
    expect(created.archived).toBe(false);
  });
});

describe('setArchived', () => {
  it('архивирует и возвращает нескольких клиентов, не меняя остальных', async () => {
    const first = await createClient(fields({ firstName: 'Анна' }));
    const second = await createClient(fields({ firstName: 'Борис' }));
    const third = await createClient(fields({ firstName: 'Вера' }));

    await setArchived([first.id, second.id], true);
    const archived = await byId([first.id, second.id, third.id]);
    expect(archived.get(first.id)).toEqual({ ...first, archived: true });
    expect(archived.get(second.id)).toEqual({ ...second, archived: true });
    expect(archived.get(third.id)).toEqual(third);

    await setArchived([first.id], false);
    const restored = await byId([first.id, second.id]);
    expect(restored.get(first.id)).toEqual({ ...first, archived: false });
    expect(restored.get(second.id)).toEqual({ ...second, archived: true });
  });

  it('не создаёт изменений при пустом списке или неизвестных идентификаторах', async () => {
    const client = await createClient(fields());

    await setArchived([], true);
    await setArchived(['unknown-id'], true);

    await expect(listClients()).resolves.toEqual([client]);
  });

  it('при отмене транзакции не оставляет частичных изменений', async () => {
    const first = await createClient(fields({ firstName: 'Анна' }));
    const second = await createClient(fields({ firstName: 'Борис' }));
    const originalPut = IDBObjectStore.prototype.put;
    let puts = 0;

    const putSpy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      value: Client,
      key?: IDBValidKey,
    ) {
      const request = key === undefined
        ? originalPut.call(this, value)
        : originalPut.call(this, value, key);
      puts += 1;
      if (puts === 2) {
        this.transaction.abort();
      }
      return request;
    });

    try {
      await expect(setArchived([first.id, second.id], true)).rejects.toBeDefined();
    } finally {
      putSpy.mockRestore();
    }

    const clients = await byId([first.id, second.id]);
    expect(clients.get(first.id)).toEqual(first);
    expect(clients.get(second.id)).toEqual(second);
  });
});

describe('deleteClients', () => {
  it('удаляет выбранных клиентов, включая архивных, и сохраняет остальных', async () => {
    const first = await createClient(fields({ firstName: 'Анна' }));
    const second = await createClient(fields({ firstName: 'Борис' }));
    const third = await createClient(fields({ firstName: 'Вера' }));
    await setArchived([second.id, third.id], true);

    await deleteClients([first.id, third.id]);

    await expect(listClients()).resolves.toEqual([{ ...second, archived: true }]);
  });

  it('игнорирует повторы, неизвестные идентификаторы и пустой список', async () => {
    const client = await createClient(fields());

    await deleteClients([]);
    await deleteClients(['unknown-id']);
    await deleteClients([client.id, client.id]);

    await expect(listClients()).resolves.toEqual([]);
  });
});

describe('readJournal', () => {
  it('читает клиентов, тарифы и оформление одной readonly-транзакцией', async () => {
    const client = await createClient(fields());
    const tariff = await saveTariff({ name: 'Пробный', price: 0, duration: 7, unit: 'days' });
    const appearance: Appearance = { theme: 'dark', corners: 'square' };
    await saveAppearance(appearance);

    const transactionSpy = vi.spyOn(IDBDatabase.prototype, 'transaction');
    try {
      const snapshot = await readJournal();
      expect(snapshot).toEqual({ clients: [client], tariffs: [tariff], appearance });
      expect(transactionSpy).toHaveBeenCalledTimes(1);
      const [storeNames, mode] = transactionSpy.mock.calls[0];
      expect([...(storeNames as string[])].sort()).toEqual([CLIENT_STORE, SETTINGS_STORE, TARIFF_STORE]);
      expect(mode).toBe('readonly');
    } finally {
      transactionSpy.mockRestore();
    }
  });

  it('переносит оформление из localStorage при обновлении базы версии 3', async () => {
    const client = sampleClient('client-legacy');
    const tariff = { ...sampleTariff };
    await seedVersion3([client], [tariff]);
    const legacy = JSON.stringify({ theme: 'dark', corners: 'square' });
    const storage = installLegacyStorage({ [APPEARANCE_KEY]: legacy });
    const expected: JournalSnapshot = {
      clients: [client],
      tariffs: [tariff],
      appearance: { theme: 'dark', corners: 'square' },
    };

    await expect(readJournal()).resolves.toEqual(expected);
    expect(storage.get(APPEARANCE_KEY)).toBe(legacy);

    storage.delete(APPEARANCE_KEY);
    await expect(readJournal()).resolves.toEqual(expected);
  });

  it('при отсутствии записи использует localStorage с нормализацией', async () => {
    await listClients();
    const storage = installLegacyStorage();
    storage.set(APPEARANCE_KEY, JSON.stringify({ theme: 'dark', corners: 'unknown' }));

    await expect(readJournal()).resolves.toMatchObject({ appearance: { theme: 'dark', corners: 'rounded' } });
    expect(storage.has(APPEARANCE_KEY)).toBe(true);

    storage.set(APPEARANCE_KEY, '{не json');
    await expect(readJournal()).resolves.toMatchObject({ appearance: { theme: 'light', corners: 'rounded' } });
  });
});

describe('saveAppearance', () => {
  it('сохраняет оформление в базе и не перекрывает его устаревшим localStorage', async () => {
    await listClients();
    const legacy = JSON.stringify({ theme: 'dark', corners: 'square' });
    const storage = installLegacyStorage({ [APPEARANCE_KEY]: legacy });

    await saveAppearance({ theme: 'light', corners: 'square' });

    await expect(readJournal()).resolves.toMatchObject({ appearance: { theme: 'light', corners: 'square' } });
    expect(storage.get(APPEARANCE_KEY)).toBe(legacy);
  });
});

describe('replaceJournal', () => {
  it('заменяет клиентов, тарифы и оформление одной readwrite-транзакцией', async () => {
    await createClient(fields({ firstName: 'Старая' }));
    await saveTariff({ name: 'Старый', price: 100, duration: 1, unit: 'days' });
    await saveAppearance({ theme: 'dark', corners: 'square' });
    const replacement: JournalSnapshot = {
      clients: [sampleClient('client-new', 'Новая')],
      tariffs: [{ ...sampleTariff, id: 'tariff-new' }],
      appearance: { theme: 'light', corners: 'rounded' },
    };

    const transactionSpy = vi.spyOn(IDBDatabase.prototype, 'transaction');
    try {
      await replaceJournal(replacement);
      expect(transactionSpy).toHaveBeenCalledTimes(1);
      const [storeNames, mode] = transactionSpy.mock.calls[0];
      expect([...(storeNames as string[])].sort()).toEqual([CLIENT_STORE, SETTINGS_STORE, TARIFF_STORE]);
      expect(mode).toBe('readwrite');
    } finally {
      transactionSpy.mockRestore();
    }

    await expect(readJournal()).resolves.toEqual(replacement);
  });

  it('откатывает все хранилища при повторе идентификатора тарифа', async () => {
    const client = await createClient(fields({ firstName: 'До' }));
    const tariff = await saveTariff({ name: 'До', price: 100, duration: 1, unit: 'days' });
    await saveAppearance({ theme: 'dark', corners: 'square' });
    const duplicate: Tariff = { ...sampleTariff, id: 'tariff-repeat' };

    await expect(replaceJournal({
      clients: [sampleClient('client-after', 'После')],
      tariffs: [duplicate, { ...duplicate, name: 'Повтор' }],
      appearance: { theme: 'light', corners: 'rounded' },
    })).rejects.toBeDefined();

    await expect(readJournal()).resolves.toEqual({
      clients: [client],
      tariffs: [tariff],
      appearance: { theme: 'dark', corners: 'square' },
    });
  });

  it('откатывает все хранилища при синхронной ошибке записи', async () => {
    const client = await createClient(fields({ firstName: 'До' }));
    const tariff = await saveTariff({ name: 'До', price: 100, duration: 1, unit: 'days' });
    await saveAppearance({ theme: 'dark', corners: 'square' });
    const broken = { ...sampleClient('client-broken'), id: undefined } as unknown as Client;

    await expect(replaceJournal({
      clients: [broken],
      tariffs: [],
      appearance: { theme: 'light', corners: 'rounded' },
    })).rejects.toBeDefined();

    await expect(readJournal()).resolves.toEqual({
      clients: [client],
      tariffs: [tariff],
      appearance: { theme: 'dark', corners: 'square' },
    });
  });

  it('при восстановлении копии оформление из копии важнее localStorage', async () => {
    const legacy = JSON.stringify({ theme: 'dark', corners: 'square' });
    const storage = installLegacyStorage({ [APPEARANCE_KEY]: legacy });
    const restored: JournalSnapshot = {
      clients: [],
      tariffs: [],
      appearance: { theme: 'light', corners: 'rounded' },
    };

    await replaceJournal(restored);

    await expect(readJournal()).resolves.toEqual(restored);
    expect(storage.get(APPEARANCE_KEY)).toBe(legacy);
  });
});

describe('matchesClient', () => {
  const client: ClientFields = {
    firstName: 'Анна',
    lastName: 'Петрова',
    phone: '000-02',
    notes: 'Пробная запись',
  };

  it('находит начало имени без учёта регистра', () => {
    expect(matchesClient(client, 'аНн')).toBe(true);
    expect(matchesClient(client, 'АННА')).toBe(true);
  });

  it('находит начало фамилии без учёта регистра', () => {
    expect(matchesClient(client, 'пЕТ')).toBe(true);
    expect(matchesClient(client, 'Петрова')).toBe(true);
  });

  it('находит любую часть имени или фамилии без учёта регистра', () => {
    expect(matchesClient(client, 'нна')).toBe(true);
    expect(matchesClient(client, 'етров')).toBe(true);
    expect(matchesClient({ ...client, lastName: 'Бубликов' }, '  ЛиК  ')).toBe(true);
    expect(matchesClient(client, 'лик')).toBe(false);
  });

  it('игнорирует пробелы вокруг запроса и пустой запрос', () => {
    expect(matchesClient(client, '  анна  ')).toBe(true);
    expect(matchesClient(client, '')).toBe(true);
    expect(matchesClient(client, '   ')).toBe(true);
  });

  it('не находит пустые поля по непустому запросу', () => {
    expect(matchesClient({ ...client, firstName: '', lastName: '' }, 'а')).toBe(false);
  });
});
