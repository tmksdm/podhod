export type ClientFields = {
  firstName: string;
  lastName: string;
  phone: string;
  notes: string;
};

export type Client = ClientFields & {
  id: string;
  archived: boolean;
};

const DATABASE_NAME = 'podhod';
const DATABASE_VERSION = 1;
const CLIENT_STORE = 'clients';

function newClientId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `client-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    let failed = false;

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(CLIENT_STORE)) {
        database.createObjectStore(CLIENT_STORE, { keyPath: 'id' });
      }
    };

    request.onsuccess = () => {
      const database = request.result;
      if (failed) {
        database.close();
        return;
      }
      database.onversionchange = () => database.close();
      resolve(database);
    };

    request.onerror = () => {
      failed = true;
      reject(request.error ?? new Error('Не удалось открыть хранилище клиентов.'));
    };

    request.onblocked = () => {
      failed = true;
      reject(new Error('Обновление хранилища заблокировано другой вкладкой.'));
    };
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('Транзакция отменена.'));
    transaction.onerror = () => reject(transaction.error ?? new Error('Не удалось выполнить транзакцию.'));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Не удалось прочитать данные.'));
  });
}

async function withDatabase<T>(operation: (database: IDBDatabase) => Promise<T>): Promise<T> {
  const database = await openDatabase();
  try {
    return await operation(database);
  } finally {
    database.close();
  }
}

export async function listClients(): Promise<Client[]> {
  return withDatabase(async (database) => {
    const transaction = database.transaction(CLIENT_STORE, 'readonly');
    const completed = transactionComplete(transaction);
    const request = transaction.objectStore(CLIENT_STORE).getAll() as IDBRequest<Client[]>;
    const [clients] = await Promise.all([requestResult(request), completed]);
    return clients;
  });
}

export async function createClient(fields: ClientFields): Promise<Client> {
  const client: Client = {
    firstName: fields.firstName,
    lastName: fields.lastName,
    phone: fields.phone,
    notes: fields.notes,
    id: newClientId(),
    archived: false,
  };

  return withDatabase(async (database) => {
    const transaction = database.transaction(CLIENT_STORE, 'readwrite');
    const completed = transactionComplete(transaction);
    transaction.objectStore(CLIENT_STORE).add(client);
    await completed;
    return client;
  });
}

export async function setArchived(ids: readonly string[], archived: boolean): Promise<void> {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) {
    return;
  }

  await withDatabase(async (database) => {
    const transaction = database.transaction(CLIENT_STORE, 'readwrite');
    const completed = transactionComplete(transaction);
    const store = transaction.objectStore(CLIENT_STORE);

    for (const id of uniqueIds) {
      const request = store.get(id);
      request.onsuccess = () => {
        const client = request.result as Client | undefined;
        if (client !== undefined) {
          store.put({ ...client, archived });
        }
      };
    }

    await completed;
  });
}

export async function deleteClients(ids: readonly string[]): Promise<void> {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) {
    return;
  }

  await withDatabase(async (database) => {
    const transaction = database.transaction(CLIENT_STORE, 'readwrite');
    const completed = transactionComplete(transaction);
    const store = transaction.objectStore(CLIENT_STORE);
    for (const id of uniqueIds) {
      store.delete(id);
    }
    await completed;
  });
}

export function matchesClient(client: ClientFields, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase('ru-RU');
  if (needle.length === 0) {
    return true;
  }
  return [client.firstName, client.lastName].some(
    (field) => field.trim().toLocaleLowerCase('ru-RU').startsWith(needle),
  );
}
