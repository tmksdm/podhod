import type {
  Billing,
  BillingAction,
  Enrollment,
  Period,
  Tariff,
  TariffDraft,
} from './billing';
import { BillingError, billingBalance, localToday, periodBalance, planFreeze, previewPeriod, returnFromFreeze } from './billing';

export type ClientFields = {
  firstName: string;
  lastName: string;
  phone: string;
  notes: string;
};

export type Client = ClientFields & {
  id: string;
  archived: boolean;
  billing?: Billing;
};

export type Appearance = {
  theme: 'light' | 'dark';
  corners: 'rounded' | 'square';
};

export type JournalSnapshot = {
  clients: Client[];
  tariffs: Tariff[];
  appearance: Appearance;
};

const DATABASE_NAME = 'podhod';
const DATABASE_VERSION = 4;
const CLIENT_STORE = 'clients';
const TARIFF_STORE = 'tariffs';
const SETTINGS_STORE = 'settings';
const APPEARANCE_RECORD_ID = 'appearance';
const LEGACY_APPEARANCE_KEY = 'podhod.appearance';
const DEFAULT_APPEARANCE: Appearance = { theme: 'light', corners: 'rounded' };

type AppearanceRecord = Appearance & { id: typeof APPEARANCE_RECORD_ID };

let recordSequence = 0;

function newClientId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `client-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function newRecordId(prefix: string): string {
  recordSequence = (recordSequence + 1) % 1679616;
  const stamp = Date.now().toString(36).padStart(9, '0');
  const sequence = recordSequence.toString(36).padStart(4, '0');
  return `${prefix}-${stamp}-${sequence}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeAppearance(value: unknown): Appearance {
  if (typeof value !== 'object' || value === null) {
    return { ...DEFAULT_APPEARANCE };
  }
  const candidate = value as { theme?: unknown; corners?: unknown };
  return {
    theme: candidate.theme === 'dark' ? 'dark' : 'light',
    corners: candidate.corners === 'square' ? 'square' : 'rounded',
  };
}

function readLegacyAppearance(): Appearance | null {
  try {
    if (typeof localStorage === 'undefined') {
      return null;
    }
    const raw = localStorage.getItem(LEGACY_APPEARANCE_KEY);
    if (raw === null) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    return normalizeAppearance(parsed);
  } catch {
    return null;
  }
}

function migrateLegacyAppearance(transaction: IDBTransaction | null): void {
  if (transaction === null) {
    return;
  }
  const appearance = readLegacyAppearance();
  if (appearance === null) {
    return;
  }
  const record: AppearanceRecord = { id: APPEARANCE_RECORD_ID, ...appearance };
  try {
    transaction.objectStore(SETTINGS_STORE).put(record);
  } catch {
    return;
  }
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
      if (!database.objectStoreNames.contains(TARIFF_STORE)) {
        database.createObjectStore(TARIFF_STORE, { keyPath: 'id' });
      }
      if (!database.objectStoreNames.contains(SETTINGS_STORE)) {
        database.createObjectStore(SETTINGS_STORE, { keyPath: 'id' });
        migrateLegacyAppearance(request.transaction);
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

function abortQuietly(transaction: IDBTransaction): void {
  try {
    transaction.abort();
  } catch {
    return;
  }
}

async function withDatabase<T>(operation: (database: IDBDatabase) => Promise<T>): Promise<T> {
  const database = await openDatabase();
  try {
    return await operation(database);
  } finally {
    database.close();
  }
}

async function runTransaction<T>(
  database: IDBDatabase,
  storeNames: string | string[],
  mode: IDBTransactionMode,
  operation: (transaction: IDBTransaction) => Promise<T>,
): Promise<T> {
  const transaction = database.transaction(storeNames, mode);
  const completed = transactionComplete(transaction);
  try {
    const result = await operation(transaction);
    await completed;
    return result;
  } catch (error) {
    abortQuietly(transaction);
    await completed.catch(() => undefined);
    throw error;
  }
}

function addExact(total: number, value: number): number {
  const result = total + value;
  if (!Number.isSafeInteger(result)) {
    throw new BillingError('Сумма в копейках выходит за допустимые границы.');
  }
  return result;
}

function assertDate(value: string): void {
  if (typeof value !== 'string') {
    throw new BillingError('Дата должна быть строкой в формате ГГГГ-ММ-ДД.');
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) {
    throw new BillingError('Дата должна быть строкой в формате ГГГГ-ММ-ДД.');
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) {
    throw new BillingError('Дата вне допустимого диапазона.');
  }
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    throw new BillingError('Такой календарной даты не существует.');
  }
}

function validateTariffDraft(draft: TariffDraft): TariffDraft {
  if (typeof draft !== 'object' || draft === null) {
    throw new BillingError('Тариф не передан.');
  }
  const { name, price, duration, unit } = draft;
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new BillingError('Название тарифа обязательно.');
  }
  if (!Number.isSafeInteger(price) || price < 0) {
    throw new BillingError('Цена тарифа должна быть целым числом копеек, включая ноль.');
  }
  if (!Number.isSafeInteger(duration) || duration <= 0) {
    throw new BillingError('Срок тарифа должен быть положительным целым числом.');
  }
  if (unit !== 'days' && unit !== 'months') {
    throw new BillingError('Срок тарифа задаётся в днях или календарных месяцах.');
  }
  return { name, price, duration, unit };
}

function validateTariffRecord(tariff: Tariff): Tariff {
  if (typeof tariff.id !== 'string' || tariff.id.length === 0) {
    throw new BillingError('Идентификатор тарифа обязателен.');
  }
  if (typeof tariff.enabled !== 'boolean') {
    throw new BillingError('Признак доступности тарифа должен быть логическим.');
  }
  return { ...validateTariffDraft(tariff), id: tariff.id, enabled: tariff.enabled };
}

async function readEnabledTariff(transaction: IDBTransaction, id: string): Promise<Tariff> {
  if (typeof id !== 'string' || id.length === 0) {
    throw new BillingError('Идентификатор тарифа обязателен.');
  }
  const request = transaction.objectStore(TARIFF_STORE).get(id) as IDBRequest<Tariff | undefined>;
  const tariff = await requestResult(request);
  if (tariff === undefined) {
    throw new BillingError('Тариф не найден.');
  }
  const valid = validateTariffRecord(tariff);
  if (!valid.enabled) {
    throw new BillingError('Тариф отключён и недоступен для выбора.');
  }
  return valid;
}

function cloneBilling(billing: Billing | undefined): Billing {
  return {
    periods: (billing?.periods ?? []).map(period => ({ ...period, tariff: { ...period.tariff } })),
    payments: (billing?.payments ?? []).map(payment => ({ ...payment })),
    ...(billing?.freezes && { freezes: billing.freezes.map(freeze => ({ ...freeze })) }),
  };
}

function validateEnrollmentAmount(amount: number, price: number): void {
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new BillingError('Сумма должна быть целым числом копеек не меньше нуля.');
  }
  if (amount > price) {
    throw new BillingError('Сумма не может превышать стоимость периода.');
  }
}

function addEnrollment(billing: Billing, tariff: Tariff, action: Enrollment): void {
  if (action.kind === 'start' && billing.periods.length > 0) {
    throw new BillingError('У клиента уже есть абонемент.');
  }
  if (action.kind === 'renew' && billing.periods.length === 0) {
    throw new BillingError('Продлить можно только существующий абонемент.');
  }
  if (action.kind === 'transfer' && billing.periods.length > 0) {
    throw new BillingError('Перенести срок можно только без действующего абонемента.');
  }
  if (action.kind !== 'transfer' && action.paymentDate !== undefined) {
    assertDate(action.paymentDate);
  }

  const preview = previewPeriod(tariff, action, billing);
  const charge = action.kind === 'transfer' ? 0 : tariff.price;
  if (action.kind !== 'transfer') {
    validateEnrollmentAmount(action.amount, charge);
  }

  const period: Period = {
    id: newRecordId('period'),
    tariff: { ...tariff },
    start: preview.start,
    due: preview.due,
    charge,
    transferred: action.kind === 'transfer',
  };
  billing.periods.push(period);

  if (action.kind !== 'transfer' && action.amount > 0) {
    billing.payments.push({
      id: newRecordId('payment'),
      periodId: period.id,
      date: action.paymentDate ?? action.date,
      amount: action.amount,
    });
  }
}

function applyPayment(
  billing: Billing,
  action: { kind: 'pay'; periodId: string; date: string; amount: number },
): void {
  assertDate(action.date);
  if (!Number.isSafeInteger(action.amount) || action.amount <= 0) {
    throw new BillingError('Платёж должен быть положительным целым числом копеек.');
  }
  const period = billing.periods.find(candidate => candidate.id === action.periodId);
  if (period === undefined) {
    throw new BillingError('Период не найден.');
  }
  const remaining = periodBalance(billing, period);
  if (action.amount > remaining) {
    throw new BillingError('Платёж превышает остаток по периоду.');
  }
  billing.payments.push({
    id: newRecordId('payment'),
    periodId: period.id,
    date: action.date,
    amount: action.amount,
  });
}

function applyCorrection(
  billing: Billing,
  action: { kind: 'correct'; paymentId: string; amount: number },
): void {
  if (!Number.isSafeInteger(action.amount) || action.amount <= 0) {
    throw new BillingError('Исправленная сумма должна быть положительным целым числом копеек.');
  }
  const payment = billing.payments.find(candidate => candidate.id === action.paymentId);
  if (payment === undefined) {
    throw new BillingError('Платёж не найден.');
  }
  const period = billing.periods.find(candidate => candidate.id === payment.periodId);
  if (period === undefined) {
    throw new BillingError('Период платежа не найден.');
  }
  if (!Number.isSafeInteger(period.charge)) {
    throw new BillingError('Начисление периода должно быть целым числом копеек.');
  }
  let otherPayments = 0;
  for (const candidate of billing.payments) {
    if (candidate.id !== payment.id && candidate.periodId === payment.periodId) {
      otherPayments = addExact(otherPayments, candidate.amount);
    }
  }
  const remaining = period.charge - otherPayments;
  if (!Number.isSafeInteger(remaining)) {
    throw new BillingError('Остаток периода выходит за допустимые границы.');
  }
  if (action.amount > remaining) {
    throw new BillingError('Исправленная сумма превышает остаток по периоду.');
  }
  payment.amount = action.amount;
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

export async function listTariffs(): Promise<Tariff[]> {
  return withDatabase(database => runTransaction(
    database,
    TARIFF_STORE,
    'readonly',
    async (transaction) => {
      const request = transaction.objectStore(TARIFF_STORE).getAll() as IDBRequest<Tariff[]>;
      return requestResult(request);
    },
  ));
}

export async function readJournal(): Promise<JournalSnapshot> {
  return withDatabase(database => runTransaction(
    database,
    [CLIENT_STORE, TARIFF_STORE, SETTINGS_STORE],
    'readonly',
    async (transaction) => {
      const clientRequest = transaction.objectStore(CLIENT_STORE).getAll() as IDBRequest<Client[]>;
      const tariffRequest = transaction.objectStore(TARIFF_STORE).getAll() as IDBRequest<Tariff[]>;
      const appearanceRequest = transaction
        .objectStore(SETTINGS_STORE)
        .get(APPEARANCE_RECORD_ID) as IDBRequest<AppearanceRecord | undefined>;
      const [clients, tariffs, appearanceRecord] = await Promise.all([
        requestResult(clientRequest),
        requestResult(tariffRequest),
        requestResult(appearanceRequest),
      ]);
      const appearance = appearanceRecord === undefined
        ? readLegacyAppearance() ?? { ...DEFAULT_APPEARANCE }
        : normalizeAppearance(appearanceRecord);
      return { clients, tariffs, appearance };
    },
  ));
}

export async function replaceJournal(snapshot: JournalSnapshot): Promise<void> {
  if (typeof snapshot !== 'object' || snapshot === null) {
    throw new Error('Снимок журнала не передан.');
  }
  if (!Array.isArray(snapshot.clients) || !Array.isArray(snapshot.tariffs)) {
    throw new Error('Снимок журнала повреждён: нет списка клиентов или тарифов.');
  }
  const appearance = normalizeAppearance(snapshot.appearance);
  const appearanceRecord: AppearanceRecord = { id: APPEARANCE_RECORD_ID, ...appearance };

  await withDatabase(database => runTransaction(
    database,
    [CLIENT_STORE, TARIFF_STORE, SETTINGS_STORE],
    'readwrite',
    async (transaction) => {
      const clientStore = transaction.objectStore(CLIENT_STORE);
      const tariffStore = transaction.objectStore(TARIFF_STORE);
      const settingsStore = transaction.objectStore(SETTINGS_STORE);
      clientStore.clear();
      tariffStore.clear();
      settingsStore.clear();
      for (const client of snapshot.clients) {
        clientStore.add(client);
      }
      for (const tariff of snapshot.tariffs) {
        tariffStore.add(tariff);
      }
      settingsStore.add(appearanceRecord);
    },
  ));
}

export async function saveAppearance(appearance: Appearance): Promise<void> {
  const record: AppearanceRecord = { id: APPEARANCE_RECORD_ID, ...normalizeAppearance(appearance) };
  await withDatabase(database => runTransaction(
    database,
    SETTINGS_STORE,
    'readwrite',
    async (transaction) => {
      transaction.objectStore(SETTINGS_STORE).put(record);
    },
  ));
}

export async function saveTariff(draft: TariffDraft, id?: string): Promise<Tariff> {
  const validDraft = validateTariffDraft(draft);
  return withDatabase(database => runTransaction(
    database,
    TARIFF_STORE,
    'readwrite',
    async (transaction) => {
      const store = transaction.objectStore(TARIFF_STORE);
      if (id === undefined) {
        const tariff: Tariff = {
          ...validDraft,
          id: newRecordId('tariff'),
          enabled: true,
        };
        store.add(tariff);
        return tariff;
      }
      if (typeof id !== 'string' || id.length === 0) {
        throw new BillingError('Идентификатор тарифа обязателен.');
      }
      const existing = await requestResult(
        store.get(id) as IDBRequest<Tariff | undefined>,
      );
      if (existing === undefined) {
        throw new BillingError('Тариф не найден.');
      }
      const updated: Tariff = {
        ...validDraft,
        id,
        enabled: existing.enabled,
      };
      store.put(updated);
      return updated;
    },
  ));
}

export async function setTariffEnabled(id: string, enabled: boolean): Promise<Tariff> {
  if (typeof id !== 'string' || id.length === 0) {
    throw new BillingError('Идентификатор тарифа обязателен.');
  }
  if (typeof enabled !== 'boolean') {
    throw new BillingError('Признак доступности тарифа должен быть логическим.');
  }
  return withDatabase(database => runTransaction(
    database,
    TARIFF_STORE,
    'readwrite',
    async (transaction) => {
      const store = transaction.objectStore(TARIFF_STORE);
      const existing = await requestResult(
        store.get(id) as IDBRequest<Tariff | undefined>,
      );
      if (existing === undefined) {
        throw new BillingError('Тариф не найден.');
      }
      const updated: Tariff = { ...existing, enabled };
      store.put(updated);
      return updated;
    },
  ));
}

export async function createClient(
  fields: ClientFields,
  enrollment?: Enrollment,
): Promise<Client> {
  return withDatabase(database => runTransaction(
    database,
    enrollment === undefined ? CLIENT_STORE : [CLIENT_STORE, TARIFF_STORE],
    'readwrite',
    async (transaction) => {
      let billing: Billing | undefined;
      if (enrollment !== undefined) {
        const tariff = await readEnabledTariff(transaction, enrollment.tariffId);
        billing = { periods: [], payments: [] };
        addEnrollment(billing, tariff, enrollment);
      }

      const client: Client = {
        firstName: fields.firstName,
        lastName: fields.lastName,
        phone: fields.phone,
        notes: fields.notes,
        id: newClientId(),
        archived: false,
      };
      if (billing !== undefined) {
        client.billing = billing;
      }
      transaction.objectStore(CLIENT_STORE).add(client);
      return client;
    },
  ));
}

export async function updateBilling(id: string, action: BillingAction): Promise<Client> {
  if (typeof id !== 'string' || id.length === 0) {
    throw new BillingError('Идентификатор клиента обязателен.');
  }
  return withDatabase(database => runTransaction(
    database,
    [CLIENT_STORE, TARIFF_STORE],
    'readwrite',
    async (transaction) => {
      const clientStore = transaction.objectStore(CLIENT_STORE);
      const client = await requestResult(
        clientStore.get(id) as IDBRequest<Client | undefined>,
      );
      if (client === undefined) {
        throw new BillingError('Клиент не найден.');
      }
      if (client.archived) {
        throw new BillingError('Архивную карточку нельзя изменить.');
      }

      const billing = cloneBilling(client.billing);
      switch (action.kind) {
        case 'start':
        case 'renew':
        case 'transfer': {
          const tariff = await readEnabledTariff(transaction, action.tariffId);
          addEnrollment(billing, tariff, action);
          break;
        }
        case 'pay':
          applyPayment(billing, action);
          break;
        case 'correct':
          applyCorrection(billing, action);
          break;
        case 'freeze':
          planFreeze(billing, newRecordId('freeze'), action.start, action.plannedReturn, localToday());
          break;
        case 'return':
          returnFromFreeze(billing, action.freezeId, localToday());
          break;
        default:
          throw new BillingError('Неизвестное действие с абонементом.');
      }

      billingBalance(billing);
      const updated: Client = { ...client, billing };
      clientStore.put(updated);
      return updated;
    },
  ));
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
    (field) => field.trim().toLocaleLowerCase('ru-RU').includes(needle),
  );
}
