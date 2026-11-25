import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient, deleteClients, listClients, matchesClient, setArchived } from './clients';
import type { Client, ClientFields } from './clients';

const DATABASE_NAME = 'podhod';

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

beforeEach(async () => {
  await deleteDatabase();
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

  it('создаёт версию базы 2 и закрывает соединение после операции', async () => {
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

    expect(version).toBe(3);
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
