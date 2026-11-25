import type { Billing, Freeze, Payment, Period, Tariff } from './billing';
import type { Appearance, Client, JournalSnapshot } from './clients';

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

const ENVELOPE_FORMAT = 'podhod-backup';
const ENVELOPE_VERSION = 1;
const PAYLOAD_FORMAT = 'podhod-journal';
const PAYLOAD_VERSION = 1;
const KDF_NAME = 'PBKDF2-SHA256';
const CIPHER_NAME = 'AES-GCM';
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const TAG_BITS = TAG_BYTES * 8;
const KEY_BITS = 256;

export const BACKUP_PBKDF2_ITERATIONS = 600_000;
export const MIN_BACKUP_PASSWORD_LENGTH = 12;
export const MAX_BACKUP_PASSWORD_LENGTH = 1024;
export const MAX_BACKUP_FILE_BYTES = 16 * 1024 * 1024;

const FILE_DAMAGED_MESSAGE = 'Файл резервной копии повреждён или имеет неподдерживаемый формат.';
const FILE_VERSION_MESSAGE = 'Версия файла резервной копии не поддерживается.';
const DATA_DAMAGED_MESSAGE = 'Данные журнала повреждены: нарушены типы или связи записей.';
const DATA_VERSION_MESSAGE = 'Версия данных резервной копии не поддерживается.';
const PASSWORD_MISSING_MESSAGE = 'Пароль резервной копии не указан.';
const PASSWORD_SHORT_MESSAGE = `Пароль резервной копии должен содержать не менее ${MIN_BACKUP_PASSWORD_LENGTH} символов.`;
const PASSWORD_LONG_MESSAGE = `Пароль резервной копии слишком длинный: не более ${MAX_BACKUP_PASSWORD_LENGTH} символов.`;
const PASSWORD_OR_FILE_MESSAGE = 'Неверный пароль или файл резервной копии повреждён.';
const FILE_TOO_LARGE_MESSAGE = 'Файл резервной копии слишком большой.';
const SNAPSHOT_TOO_LARGE_MESSAGE = 'Журнал слишком большой для одной резервной копии.';
const FILE_UNREADABLE_MESSAGE = 'Не удалось прочитать файл резервной копии.';
const CRYPTO_UNAVAILABLE_MESSAGE = 'Шифрование недоступно в этом браузере.';
const ENCRYPT_MESSAGE = 'Не удалось зашифровать резервную копию.';

const ENVELOPE_KEYS = [
  'format',
  'version',
  'kdf',
  'iterations',
  'cipher',
  'salt',
  'iv',
  'data',
] as const;
const PAYLOAD_KEYS = ['format', 'version', 'createdAt', 'snapshot'] as const;
const SNAPSHOT_KEYS = ['clients', 'tariffs', 'appearance'] as const;

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

type JsonObject = Record<string, unknown>;

type EnvelopeHeader = {
  format: typeof ENVELOPE_FORMAT;
  version: typeof ENVELOPE_VERSION;
  kdf: typeof KDF_NAME;
  iterations: number;
  cipher: typeof CIPHER_NAME;
  salt: string;
  iv: string;
};

type Envelope = EnvelopeHeader & { data: string };

type Payload = {
  format: typeof PAYLOAD_FORMAT;
  version: typeof PAYLOAD_VERSION;
  createdAt: string;
  snapshot: JournalSnapshot;
};

function failFile(): never {
  throw new BackupError(FILE_DAMAGED_MESSAGE);
}

function failData(): never {
  throw new BackupError(DATA_DAMAGED_MESSAGE);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: JsonObject, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length
    && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}

function getCrypto(): Crypto {
  if (typeof globalThis.crypto === 'undefined' || typeof globalThis.crypto.subtle === 'undefined') {
    throw new BackupError(CRYPTO_UNAVAILABLE_MESSAGE);
  }
  return globalThis.crypto;
}

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  getCrypto().getRandomValues(bytes);
  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  const chunk = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

function isBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) {
    return false;
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const limit = value.length - padding;
  for (let index = 0; index < limit; index += 1) {
    const code = value.charCodeAt(index);
    const valid = (code >= 65 && code <= 90)
      || (code >= 97 && code <= 122)
      || (code >= 48 && code <= 57)
      || code === 43
      || code === 47;
    if (!valid) {
      return false;
    }
  }
  return true;
}

function decodeBase64(value: unknown): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || !isBase64(value)) {
    failFile();
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    failFile();
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function headerFor(salt: string, iv: string): EnvelopeHeader {
  return {
    format: ENVELOPE_FORMAT,
    version: ENVELOPE_VERSION,
    kdf: KDF_NAME,
    iterations: BACKUP_PBKDF2_ITERATIONS,
    cipher: CIPHER_NAME,
    salt,
    iv,
  };
}

async function deriveKey(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  usage: KeyUsage,
): Promise<CryptoKey> {
  const webCrypto = getCrypto();
  const passwordBytes = new TextEncoder().encode(password);
  const material = await webCrypto.subtle.importKey(
    'raw',
    passwordBytes,
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return webCrypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: BACKUP_PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    material,
    { name: 'AES-GCM', length: KEY_BITS },
    false,
    [usage],
  );
}

function assertExportPassword(password: unknown): asserts password is string {
  if (typeof password !== 'string' || password.length === 0) {
    throw new BackupError(PASSWORD_MISSING_MESSAGE);
  }
  if (password.length < MIN_BACKUP_PASSWORD_LENGTH) {
    throw new BackupError(PASSWORD_SHORT_MESSAGE);
  }
  if (password.length > MAX_BACKUP_PASSWORD_LENGTH) {
    throw new BackupError(PASSWORD_LONG_MESSAGE);
  }
}

function assertImportPassword(password: unknown): asserts password is string {
  if (typeof password !== 'string' || password.length === 0) {
    throw new BackupError(PASSWORD_MISSING_MESSAGE);
  }
  if (password.length > MAX_BACKUP_PASSWORD_LENGTH) {
    throw new BackupError(PASSWORD_LONG_MESSAGE);
  }
}

function fileString(value: unknown): string {
  if (typeof value !== 'string') {
    failFile();
  }
  return value;
}

function requireDate(value: unknown): string {
  if (typeof value !== 'string') {
    failData();
  }
  const match = DATE_PATTERN.exec(value);
  if (match === null) {
    failData();
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) {
    failData();
  }
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    failData();
  }
  return value;
}

function requireTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !ISO_PATTERN.test(value)) {
    failData();
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) {
    failData();
  }
  return value;
}

function requireString(value: unknown): string {
  if (typeof value !== 'string') {
    failData();
  }
  return value;
}

function requireIdentifier(value: unknown): string {
  const text = requireString(value);
  if (text.length === 0) {
    failData();
  }
  return text;
}

function requireInteger(value: unknown, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    failData();
  }
  return value as number;
}

function requireBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    failData();
  }
  return value;
}

function assertUnique(ids: readonly string[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      failData();
    }
    seen.add(id);
  }
}

function validateTariff(value: unknown): Tariff {
  if (!isJsonObject(value)) {
    failData();
  }
  const id = requireIdentifier(value.id);
  const name = requireString(value.name);
  if (name.trim().length === 0) {
    failData();
  }
  const price = requireInteger(value.price, 0);
  const duration = requireInteger(value.duration, 1);
  const unit = value.unit;
  if (unit !== 'days' && unit !== 'months') {
    failData();
  }
  const enabled = requireBoolean(value.enabled);
  return { id, name, price, duration, unit, enabled };
}

function validatePeriod(value: unknown, tariffIds: ReadonlySet<string>): Period {
  if (!isJsonObject(value)) {
    failData();
  }
  const id = requireIdentifier(value.id);
  const tariff = validateTariff(value.tariff);
  if (!tariffIds.has(tariff.id)) {
    failData();
  }
  const start = value.start === null ? null : requireDate(value.start);
  const due = requireDate(value.due);
  if (start !== null && start >= due) {
    failData();
  }
  const charge = requireInteger(value.charge, 0);
  const transferred = requireBoolean(value.transferred);
  return { id, tariff, start, due, charge, transferred };
}

function validatePayment(value: unknown, periodIds: ReadonlySet<string>): Payment {
  if (!isJsonObject(value)) {
    failData();
  }
  const id = requireIdentifier(value.id);
  const periodId = requireIdentifier(value.periodId);
  if (!periodIds.has(periodId)) {
    failData();
  }
  const date = requireDate(value.date);
  const amount = requireInteger(value.amount, 1);
  return { id, periodId, date, amount };
}

function validateFreeze(value: unknown, periodIds: ReadonlySet<string>): Freeze {
  if (!isJsonObject(value)) {
    failData();
  }
  const id = requireIdentifier(value.id);
  const periodId = requireIdentifier(value.periodId);
  if (!periodIds.has(periodId)) {
    failData();
  }
  const start = requireDate(value.start);
  const plannedReturn = requireDate(value.plannedReturn);
  if (start >= plannedReturn) {
    failData();
  }
  if (value.returnedOn === undefined) {
    return { id, periodId, start, plannedReturn };
  }
  const returnedOn = requireDate(value.returnedOn);
  if (returnedOn < start || returnedOn >= plannedReturn) {
    failData();
  }
  return { id, periodId, start, plannedReturn, returnedOn };
}

function validateBilling(value: unknown, tariffIds: ReadonlySet<string>): Billing {
  if (!isJsonObject(value)) {
    failData();
  }
  if (!Array.isArray(value.periods) || !Array.isArray(value.payments)) {
    failData();
  }
  if (value.freezes !== undefined && !Array.isArray(value.freezes)) {
    failData();
  }

  const periods = value.periods.map(period => validatePeriod(period, tariffIds));
  assertUnique(periods.map(period => period.id));
  const periodIds = new Set(periods.map(period => period.id));

  const payments = value.payments.map(payment => validatePayment(payment, periodIds));
  assertUnique(payments.map(payment => payment.id));

  const freezes = value.freezes === undefined
    ? undefined
    : value.freezes.map(freeze => validateFreeze(freeze, periodIds));
  if (freezes !== undefined) {
    assertUnique(freezes.map(freeze => freeze.id));
  }

  const charges = new Map<string, number>();
  let totalCharge = 0;
  for (const period of periods) {
    charges.set(period.id, period.charge);
    totalCharge += period.charge;
    if (!Number.isSafeInteger(totalCharge)) {
      failData();
    }
  }

  const paid = new Map<string, number>();
  for (const payment of payments) {
    const next = (paid.get(payment.periodId) ?? 0) + payment.amount;
    if (!Number.isSafeInteger(next) || next > (charges.get(payment.periodId) ?? 0)) {
      failData();
    }
    paid.set(payment.periodId, next);
  }

  return freezes === undefined
    ? { periods, payments }
    : { periods, payments, freezes };
}

function validateClient(value: unknown, tariffIds: ReadonlySet<string>): Client {
  if (!isJsonObject(value)) {
    failData();
  }
  const firstName = requireString(value.firstName);
  const lastName = requireString(value.lastName);
  const phone = requireString(value.phone);
  const notes = requireString(value.notes);
  const id = requireIdentifier(value.id);
  const archived = requireBoolean(value.archived);
  if (value.billing === undefined) {
    return { firstName, lastName, phone, notes, id, archived };
  }
  return {
    firstName,
    lastName,
    phone,
    notes,
    id,
    archived,
    billing: validateBilling(value.billing, tariffIds),
  };
}

function validateAppearance(value: unknown): Appearance {
  if (!isJsonObject(value)) {
    failData();
  }
  if (value.theme !== 'light' && value.theme !== 'dark') {
    failData();
  }
  if (value.corners !== 'rounded' && value.corners !== 'square') {
    failData();
  }
  return { theme: value.theme, corners: value.corners };
}

function validateSnapshot(value: unknown): JournalSnapshot {
  if (!isJsonObject(value) || !hasExactKeys(value, SNAPSHOT_KEYS)) {
    failData();
  }
  if (!Array.isArray(value.clients) || !Array.isArray(value.tariffs)) {
    failData();
  }
  const tariffs = value.tariffs.map(validateTariff);
  assertUnique(tariffs.map(tariff => tariff.id));
  const tariffIds = new Set(tariffs.map(tariff => tariff.id));
  const clients = value.clients.map(client => validateClient(client, tariffIds));
  assertUnique(clients.map(client => client.id));
  const appearance = validateAppearance(value.appearance);
  return { clients, tariffs, appearance };
}

function readBackupBytes(file: File): Promise<Uint8Array<ArrayBuffer>> {
  if (file === null || typeof file !== 'object' || typeof file.arrayBuffer !== 'function') {
    throw new BackupError('Файл резервной копии не передан.');
  }
  if (typeof file.size !== 'number' || !Number.isFinite(file.size) || file.size <= 0) {
    failFile();
  }
  if (file.size > MAX_BACKUP_FILE_BYTES) {
    throw new BackupError(FILE_TOO_LARGE_MESSAGE);
  }
  return file.arrayBuffer().then(
    (buffer) => {
      if (buffer.byteLength === 0) {
        failFile();
      }
      if (buffer.byteLength > MAX_BACKUP_FILE_BYTES) {
        throw new BackupError(FILE_TOO_LARGE_MESSAGE);
      }
      return new Uint8Array(buffer);
    },
    () => {
      throw new BackupError(FILE_UNREADABLE_MESSAGE);
    },
  );
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    failFile();
  }
}

function parseEnvelope(text: string): Envelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    failFile();
  }
  if (!isJsonObject(parsed) || !hasExactKeys(parsed, ENVELOPE_KEYS)) {
    failFile();
  }
  if (parsed.format !== ENVELOPE_FORMAT || parsed.kdf !== KDF_NAME || parsed.cipher !== CIPHER_NAME) {
    failFile();
  }
  if (parsed.version !== ENVELOPE_VERSION) {
    if (typeof parsed.version === 'number' && Number.isSafeInteger(parsed.version) && parsed.version > 0) {
      throw new BackupError(FILE_VERSION_MESSAGE);
    }
    failFile();
  }
  if (parsed.iterations !== BACKUP_PBKDF2_ITERATIONS) {
    failFile();
  }
  const saltText = fileString(parsed.salt);
  const ivText = fileString(parsed.iv);
  const dataText = fileString(parsed.data);
  const salt = decodeBase64(saltText);
  if (salt.length !== SALT_BYTES) {
    failFile();
  }
  const iv = decodeBase64(ivText);
  if (iv.length !== IV_BYTES) {
    failFile();
  }
  const data = decodeBase64(dataText);
  if (data.length < TAG_BYTES || data.length > MAX_BACKUP_FILE_BYTES) {
    failFile();
  }
  return {
    ...headerFor(saltText, ivText),
    data: dataText,
  };
}

function decodePayload(bytes: ArrayBuffer): Payload {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    failData();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    failData();
  }
  if (!isJsonObject(parsed) || !hasExactKeys(parsed, PAYLOAD_KEYS)) {
    failData();
  }
  if (parsed.format !== PAYLOAD_FORMAT) {
    failData();
  }
  if (parsed.version !== PAYLOAD_VERSION) {
    if (typeof parsed.version === 'number' && Number.isSafeInteger(parsed.version) && parsed.version > 0) {
      throw new BackupError(DATA_VERSION_MESSAGE);
    }
    failData();
  }
  const createdAt = requireTimestamp(parsed.createdAt);
  const snapshot = validateSnapshot(parsed.snapshot);
  return {
    format: PAYLOAD_FORMAT,
    version: PAYLOAD_VERSION,
    createdAt,
    snapshot,
  };
}

export async function encodeBackup(snapshot: JournalSnapshot, password: string): Promise<File> {
  assertExportPassword(password);
  const validSnapshot = validateSnapshot(snapshot);
  const webCrypto = getCrypto();
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const saltText = encodeBase64(salt);
  const ivText = encodeBase64(iv);
  const header = headerFor(saltText, ivText);
  const additionalData = new TextEncoder().encode(JSON.stringify(header));
  const createdAt = new Date().toISOString();
  const payload: Payload = {
    format: PAYLOAD_FORMAT,
    version: PAYLOAD_VERSION,
    createdAt,
    snapshot: validSnapshot,
  };
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const estimatedBase64 = Math.ceil((plaintext.byteLength + TAG_BYTES) / 3) * 4;
  if (estimatedBase64 + 512 > MAX_BACKUP_FILE_BYTES) {
    throw new BackupError(SNAPSHOT_TOO_LARGE_MESSAGE);
  }

  let ciphertext: ArrayBuffer;
  try {
    const key = await deriveKey(password, salt, 'encrypt');
    ciphertext = await webCrypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData, tagLength: TAG_BITS },
      key,
      plaintext,
    );
  } catch {
    throw new BackupError(ENCRYPT_MESSAGE);
  }

  const envelope: Envelope = {
    ...header,
    data: encodeBase64(new Uint8Array(ciphertext)),
  };
  const name = `podhod-backup-${createdAt.slice(0, 10)}.txt`;
  const file = new File([JSON.stringify(envelope)], name, { type: 'text/plain' });
  if (file.size > MAX_BACKUP_FILE_BYTES) {
    throw new BackupError(SNAPSHOT_TOO_LARGE_MESSAGE);
  }
  return file;
}

export async function decodeBackup(
  file: File,
  password: string,
): Promise<{ snapshot: JournalSnapshot; createdAt: string }> {
  assertImportPassword(password);
  const bytes = await readBackupBytes(file);
  const envelope = parseEnvelope(decodeUtf8(bytes));
  const salt = decodeBase64(envelope.salt);
  const iv = decodeBase64(envelope.iv);
  const encrypted = decodeBase64(envelope.data);
  const additionalData = new TextEncoder().encode(JSON.stringify(headerFor(envelope.salt, envelope.iv)));

  let plaintext: ArrayBuffer;
  try {
    const key = await deriveKey(password, salt, 'decrypt');
    plaintext = await getCrypto().subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData, tagLength: TAG_BITS },
      key,
      encrypted,
    );
  } catch {
    throw new BackupError(PASSWORD_OR_FILE_MESSAGE);
  }

  const payload = decodePayload(plaintext);
  return { snapshot: payload.snapshot, createdAt: payload.createdAt };
}
