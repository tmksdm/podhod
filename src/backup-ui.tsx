import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { decodeBackup, encodeBackup, MAX_BACKUP_PASSWORD_LENGTH, MIN_BACKUP_PASSWORD_LENGTH } from './backup';
import { readJournal } from './clients';
import type { JournalSnapshot } from './clients';

type Preview = Awaited<ReturnType<typeof decodeBackup>>;

function canShareFile(file: File): boolean {
  try { return typeof navigator.share === 'function' && navigator.canShare?.({ files: [file] }) === true; }
  catch { return false; }
}

export function BackupPanel({ busy, onBusy, onRestore, onSaved }: {
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onRestore: (snapshot: JournalSnapshot) => Promise<void>;
  onSaved: () => void;
}) {
  const [exportPassword, setExportPassword] = useState('');
  const [repeatPassword, setRepeatPassword] = useState('');
  const [prepared, setPrepared] = useState<File>();
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File>();
  const [importPassword, setImportPassword] = useState('');
  const [preview, setPreview] = useState<Preview>();
  const [confirmed, setConfirmed] = useState(false);
  const [exportError, setExportError] = useState('');
  const [importError, setImportError] = useState('');
  const [shareOpened, setShareOpened] = useState(false);
  const [backupNotice, setBackupNotice] = useState('');
  const previewHeading = useRef<HTMLHeadingElement>(null);

  useEffect(() => { if (preview) previewHeading.current?.focus(); }, [preview]);

  useEffect(() => {
    if (!prepared) { setUrl(''); return; }
    const next = URL.createObjectURL(prepared);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [prepared]);

  async function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setExportError('');
    setBackupNotice('');
    setShareOpened(false);
    setPrepared(undefined);
    if (exportPassword !== repeatPassword) {
      setRepeatPassword('');
      setExportError('Пароли не совпадают.');
      return;
    }
    onBusy(true);
    try {
      const snapshot = await readJournal().catch(() => { throw new Error('Не удалось прочитать текущий журнал.'); });
      setPrepared(await encodeBackup(snapshot, exportPassword));
    } catch (error) {
      setExportError(error instanceof Error ? error.message : 'Не удалось подготовить копию.');
    } finally {
      setExportPassword('');
      setRepeatPassword('');
      onBusy(false);
    }
  }

  async function share(fileToShare: File) {
    if (busy) return;
    setExportError(''); setBackupNotice(''); setShareOpened(false);
    if (!canShareFile(fileToShare)) {
      setExportError('Передача файла недоступна. Скачайте копию.');
      return;
    }
    onBusy(true);
    try {
      await navigator.share({ files: [fileToShare] });
      setShareOpened(true);
      setBackupNotice('Проверьте, что файл сохранился или отправлен. Журнал не может подтвердить доставку.');
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        setBackupNotice('Передача отменена или нет доступного приложения. Копию по-прежнему можно скачать.');
      } else {
        setExportError('Не удалось передать файл. Скачайте копию.');
      }
    } finally { onBusy(false); }
  }

  async function check(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !file) return;
    setImportError('');
    setPreview(undefined);
    setConfirmed(false);
    onBusy(true);
    try { setPreview(await decodeBackup(file, importPassword)); }
    catch (error) { setImportError(error instanceof Error ? error.message : 'Не удалось прочитать копию.'); }
    finally { setImportPassword(''); onBusy(false); }
  }

  async function restore() {
    if (busy || !preview || !confirmed) return;
    setImportError('');
    onBusy(true);
    try { await onRestore(preview.snapshot); }
    catch { setImportError('Не удалось восстановить копию. Журнал не изменён.'); }
    finally { onBusy(false); }
  }

  const restoredClients = preview?.snapshot.clients ?? [];
  const canShare = prepared !== undefined && canShareFile(prepared);
  return <>
    <h1>Резервные копии</h1>
    {busy && <p role="status" className="muted">Обрабатываем копию…</p>}
    <section className="panel billing-panel" aria-labelledby="backup-export-title">
      <h2 id="backup-export-title">Создать копию</h2>
      <p>Файл зашифрован. Запомните пароль: без него копию нельзя восстановить.</p>
      <form className="billing-fields" onSubmit={event => void prepare(event)}>
        <label>Пароль новой копии<input type="password" autoComplete="new-password" required minLength={MIN_BACKUP_PASSWORD_LENGTH}
          maxLength={MAX_BACKUP_PASSWORD_LENGTH}
          disabled={busy} value={exportPassword} onChange={event => setExportPassword(event.target.value)} /></label>
        <small className="muted">Не менее {MIN_BACKUP_PASSWORD_LENGTH} символов. Лучше использовать длинную фразу.</small>
        <label>Повторите пароль<input type="password" autoComplete="new-password" required minLength={MIN_BACKUP_PASSWORD_LENGTH}
          maxLength={MAX_BACKUP_PASSWORD_LENGTH}
          disabled={busy} value={repeatPassword} onChange={event => setRepeatPassword(event.target.value)} /></label>
        <button className="primary" type="submit" disabled={busy}>Подготовить файл</button>
      </form>
      {exportError && <p className="error" role="alert">{exportError}</p>}
      {prepared && url && <div className="actions" aria-label="Готовый файл резервной копии">
        <button type="button" disabled={busy} onClick={() => {
          const link = document.createElement('a');
          link.href = url;
          link.download = prepared.name;
          document.body.append(link);
          link.click();
          link.remove();
          onSaved();
          setExportError(''); setShareOpened(false);
          setBackupNotice('Скачивание запущено. Проверьте, что файл появился в загрузках.');
        }}>Скачать копию</button>
        {canShare && <button type="button" disabled={busy} onClick={() => void share(prepared)}>Поделиться</button>}
        {shareOpened && <button type="button" disabled={busy} onClick={() => {
          onSaved(); setShareOpened(false); setBackupNotice('Копия отмечена как сохранённая.');
        }}>Отметить копию сохранённой</button>}
      </div>}
      {prepared && !canShare && <small className="muted">Передача через системное меню недоступна. Скачайте файл.</small>}
      {backupNotice && <p role="status">{backupNotice}</p>}
    </section>
    <section className="panel billing-panel" aria-labelledby="backup-import-title">
      <h2 id="backup-import-title">Восстановить из файла</h2>
      <form className="billing-fields" onSubmit={event => void check(event)}>
        <label>Файл резервной копии<input type="file" disabled={busy} required onChange={event => {
          setFile(event.target.files?.[0]);
          setPreview(undefined); setConfirmed(false); setImportError(''); setImportPassword('');
        }} /></label>
        <label>Пароль для восстановления<input type="password" autoComplete="off" required disabled={busy} maxLength={MAX_BACKUP_PASSWORD_LENGTH}
          value={importPassword} onChange={event => {
            setImportPassword(event.target.value); setPreview(undefined); setConfirmed(false);
          }} /></label>
        <button type="submit" disabled={busy || !file}>Проверить копию</button>
      </form>
      {preview && <div className="billing-fields" aria-label="Сводка копии">
        <h3 ref={previewHeading} tabIndex={-1}>Копия от {new Date(preview.createdAt).toLocaleString('ru-RU')}</h3>
        <p>Клиентов: {restoredClients.length}, из них в архиве: {restoredClients.filter(client => client.archived).length}.</p>
        <p>Тарифов: {preview.snapshot.tariffs.length}. Периодов: {restoredClients.reduce((n, c) => n + (c.billing?.periods.length ?? 0), 0)}.
          {' '}Платежей: {restoredClients.reduce((n, c) => n + (c.billing?.payments.length ?? 0), 0)}.
          {' '}Заморозок: {restoredClients.reduce((n, c) => n + (c.billing?.freezes?.length ?? 0), 0)}.</p>
        <p><strong>Текущий журнал будет полностью заменён.</strong> Клиенты, удалённые после создания копии,
          могут вернуться. Сначала сохраните текущий журнал через «Создать копию» выше.</p>
        <label><input type="checkbox" checked={confirmed} disabled={busy}
          onChange={event => setConfirmed(event.target.checked)} /> Подтверждаю полную замену журнала</label>
        <div className="actions">
          <button type="button" disabled={busy} onClick={() => {
            setPreview(undefined); setConfirmed(false); setImportError('');
          }}>Отменить восстановление</button>
          <button type="button" className="danger" disabled={busy || !confirmed} onClick={() => void restore()}>
            Заменить журнал
          </button>
        </div>
      </div>}
      {importError && <p className="error" role="alert">{importError}</p>}
    </section>
  </>;
}
