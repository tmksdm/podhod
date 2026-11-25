import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { createClient, deleteClients, listClients, matchesClient, setArchived } from './clients';
import type { Client, ClientFields } from './clients';
import './styles.css';

const emptyFields: ClientFields = { firstName: '', lastName: '', phone: '', notes: '' };
const nameOf = (client: Client) => [client.firstName, client.lastName].filter(Boolean).join(' ') || 'Без имени';
type Screen = { kind: 'list' } | { kind: 'new' } | { kind: 'card'; client: Client };

function DeleteDialog({ clients, busy, error, onCancel, onConfirm }: {
  clients: Client[]; busy: boolean; error: string; onCancel: () => void; onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => { element?.close(); };
  }, []);

  return (
    <dialog ref={dialog} aria-labelledby="delete-title" aria-describedby="delete-warning"
      onCancel={(event) => { event.preventDefault(); if (!busy) onCancel(); }}>
      <h2 id="delete-title">Удалить выбранных?</h2>
      <p id="delete-warning">Записи будут удалены навсегда. Отменить это действие нельзя.</p>
      <ul className="delete-list">
        {clients.map(client => <li key={client.id}>
          <strong>{nameOf(client)}</strong>
          {client.phone && <span>{client.phone}</span>}
          {!client.firstName && !client.lastName && !client.phone && <small>Карточка {client.id.slice(0, 8)}</small>}
        </li>)}
      </ul>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="actions">
        <button type="button" autoFocus disabled={busy} onClick={onCancel}>Отмена</button>
        <button type="button" className="danger" disabled={busy} onClick={onConfirm}>Удалить навсегда</button>
      </div>
    </dialog>
  );
}

function App() {
  const [clients, setClients] = useState<Client[] | null>(null);
  const [screen, setScreen] = useState<Screen>({ kind: 'list' });
  const [archive, setArchive] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [pendingDelete, setPendingDelete] = useState<Client[]>([]);
  const [fields, setFields] = useState(emptyFields);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function load() {
    setError('');
    try { setClients(await listClients()); }
    catch { setError('Не удалось открыть журнал. Проверьте, доступно ли хранилище браузера.'); }
  }
  useEffect(() => { void load(); }, []);

  const section = (clients ?? []).filter(client => client.archived === archive);
  const visible = section.filter(client => matchesClient(client, query)).sort(
    (a, b) => nameOf(a).localeCompare(nameOf(b), 'ru'),
  );
  const chosen = visible.filter(client => selected.includes(client.id));

  function switchList(nextArchive: boolean) {
    setArchive(nextArchive);
    setQuery('');
    setSelected([]);
    setScreen({ kind: 'list' });
    setError('');
    setNotice('');
  }

  async function write(action: () => Promise<void>, message: string) {
    setBusy(true);
    setError('');
    setNotice('');
    try { await action(); setNotice(message); }
    catch { setError('Не удалось сохранить изменения. Повторите попытку.'); }
    finally { setBusy(false); }
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void write(async () => {
      const client = await createClient(fields);
      setClients(current => [...(current ?? []), client]);
      switchList(false);
      setScreen({ kind: 'card', client });
    }, 'Карточка сохранена.');
  }

  function move() {
    const ids = chosen.map(client => client.id);
    void write(async () => {
      await setArchived(ids, !archive);
      setClients(current => current?.map(client => ids.includes(client.id) ? { ...client, archived: !archive } : client) ?? null);
      setSelected([]);
    }, archive ? 'Выбранные карточки возвращены.' : 'Выбранные карточки отправлены в архив.');
  }

  function remove() {
    const ids = new Set(pendingDelete.map(client => client.id));
    void write(async () => {
      await deleteClients([...ids]);
      setClients(current => current?.filter(client => !ids.has(client.id)) ?? null);
      setPendingDelete([]);
      setSelected([]);
    }, 'Выбранные карточки удалены.');
  }

  return (
    <main className="shell" aria-busy={busy}>
      <header className="masthead">
        <span className="mark" aria-hidden="true"><i /><i /><i /></span>
        <div><div className="brand">Подход</div><div className="subtitle">Журнал тренера</div></div>
      </header>
      {notice && <p className="notice" role="status">{notice}</p>}
      {error && !pendingDelete.length && <p className="error" role="alert">{error}</p>}

      {screen.kind === 'list' && <>
        <nav aria-label="Разделы журнала">
          <button className={!archive ? 'current' : ''} type="button" aria-current={!archive ? 'page' : undefined}
            disabled={busy} onClick={() => switchList(false)}>Клиенты</button>
          <button className={archive ? 'current' : ''} type="button" aria-current={archive ? 'page' : undefined}
            disabled={busy} onClick={() => switchList(true)}>Архив</button>
        </nav>
        <div className="section-heading">
          <h1>{archive ? 'Архив' : 'Клиенты'}</h1>
          {!archive && clients && <button type="button" className="primary" disabled={busy} onClick={() => {
            setFields(emptyFields); setError(''); setNotice(''); setScreen({ kind: 'new' });
          }}>Новый клиент</button>}
        </div>
        {clients === null ? (error ? <button type="button" onClick={() => void load()}>Повторить</button> : <p role="status">Открываем журнал…</p>) : <>
          <label className="search">Поиск
            <input type="search" value={query} placeholder="Начало имени или фамилии" disabled={busy}
              onChange={event => { setQuery(event.target.value); setSelected([]); }} />
          </label>
          {chosen.length > 0 && <div className="selection">
            <p>Выбрано: <strong>{chosen.length}</strong></p>
            <div className="actions">
              <button type="button" disabled={busy} onClick={move}>{archive ? 'Вернуть' : 'В архив'}</button>
              <button type="button" className="danger-outline" disabled={busy} onClick={() => {
                setError(''); setNotice(''); setPendingDelete(chosen);
              }}>Удалить</button>
            </div>
          </div>}
          {visible.length === 0 ? <div className="empty">
            <strong>{query.trim() ? 'Ничего не найдено' : archive ? 'Архив пуст' : 'Пока нет клиентов'}</strong>
            <p>{query.trim() ? 'Попробуйте другое начало имени или фамилии.' : archive
              ? 'Сюда попадают только карточки, которые вы отправили в архив.'
              : 'Добавьте первую карточку. Имя, телефон и заметки необязательны.'}</p>
          </div> : <ul className="clients" aria-label={archive ? 'Клиенты в архиве' : 'Список клиентов'}>
            {visible.map(client => <li key={client.id}>
              <label className="pick">
                <input type="checkbox" aria-label={`Выбрать ${nameOf(client)}`} disabled={busy}
                  checked={selected.includes(client.id)} onChange={event => {
                    const checked = event.target.checked;
                    setSelected(current => checked ? [...current, client.id] : current.filter(id => id !== client.id));
                  }} />
              </label>
              <button type="button" className="client" disabled={busy} onClick={() => {
                setError(''); setNotice(''); setScreen({ kind: 'card', client });
              }}>
                <span><strong>{nameOf(client)}</strong>{client.phone && <small>{client.phone}</small>}</span>
                <span aria-hidden="true">›</span>
              </button>
            </li>)}
          </ul>}
        </>}
      </>}

      {screen.kind !== 'list' && <button type="button" className="back" disabled={busy} onClick={() => {
        setScreen({ kind: 'list' }); setError(''); setNotice('');
      }}>← {archive ? 'К архиву' : 'К списку'}</button>}

      {screen.kind === 'new' && <>
        <h1>Новый клиент</h1>
        <p className="muted">Все поля необязательны.</p>
        <form className="panel" onSubmit={save}>
          {(['firstName', 'lastName', 'phone'] as const).map((key, index) => <label key={key}>
            {['Имя', 'Фамилия', 'Телефон'][index]}
            <input type={key === 'phone' ? 'tel' : 'text'} autoComplete="off" value={fields[key]} disabled={busy}
              onChange={event => setFields({ ...fields, [key]: event.target.value })} />
          </label>)}
          <label>Заметки<textarea rows={4} value={fields.notes} disabled={busy}
            onChange={event => setFields({ ...fields, notes: event.target.value })} /></label>
          <button className="primary" type="submit" disabled={busy}>Сохранить карточку</button>
        </form>
      </>}

      {screen.kind === 'card' && <>
        <h1>{nameOf(screen.client)}</h1>
        <div className="badges"><span>Без абонемента</span>{screen.client.archived && <span>В архиве</span>}</div>
        <dl className="panel details">
          <div><dt>Телефон</dt><dd>{screen.client.phone || 'Не указан'}</dd></div>
          <div><dt>Заметки</dt><dd>{screen.client.notes || 'Нет заметок'}</dd></div>
        </dl>
      </>}

      {pendingDelete.length > 0 && <DeleteDialog clients={pendingDelete} busy={busy} error={error}
        onCancel={() => { setPendingDelete([]); setError(''); }} onConfirm={remove} />}
      <footer>Данные хранятся в этом браузере.</footer>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
