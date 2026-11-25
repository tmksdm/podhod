import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { createClient, deleteClients, listClients, listTariffs, matchesClient, saveTariff, setArchived, setTariffEnabled, updateBilling } from './clients';
import type { Client, ClientFields } from './clients';
import { billingBalance, compareDue, dueStatus, localToday } from './billing';
import type { Tariff } from './billing';
import { BillingCard, EnrollmentFields, Tariffs, enrollmentOf, initialEnrollment, money } from './billing-ui';
import type { EnrollmentForm } from './billing-ui';
import './styles.css';

const emptyFields: ClientFields = { firstName: '', lastName: '', phone: '', notes: '' };
const nameOf = (client: Client) => [client.firstName, client.lastName].filter(Boolean).join(' ') || 'Без имени';
const byTariffName = (a: Tariff, b: Tariff) => a.name.localeCompare(b.name, 'ru');
type Screen = { kind: 'list' } | { kind: 'new' } | { kind: 'card'; client: Client } | { kind: 'tariffs' };

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
      <p id="delete-warning">Карточки будут удалены навсегда.
        {clients.some(client => client.billing) && ' Их абонементы и история платежей тоже будут удалены.'}
        {' Отменить это действие нельзя.'}</p>
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
  const [tariffs, setTariffs] = useState<Tariff[]>([]);
  const [screen, setScreen] = useState<Screen>({ kind: 'list' });
  const [archive, setArchive] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [pendingDelete, setPendingDelete] = useState<Client[]>([]);
  const [fields, setFields] = useState(emptyFields);
  const [enrollment, setEnrollment] = useState<EnrollmentForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [today, setToday] = useState(localToday);
  const errorBanner = useRef<HTMLParagraphElement>(null);

  async function load() {
    setError('');
    try {
      const [nextClients, nextTariffs] = await Promise.all([listClients(), listTariffs()]);
      setTariffs(nextTariffs.sort(byTariffName));
      setClients(nextClients);
    }
    catch { setError('Не удалось открыть журнал. Проверьте, доступно ли хранилище браузера.'); }
  }
  useEffect(() => { void load(); }, []);
  useEffect(() => { if (error) errorBanner.current?.focus(); }, [error]);
  useEffect(() => {
    const refreshToday = () => setToday(localToday());
    window.addEventListener('focus', refreshToday);
    document.addEventListener('visibilitychange', refreshToday);
    return () => {
      window.removeEventListener('focus', refreshToday);
      document.removeEventListener('visibilitychange', refreshToday);
    };
  }, []);

  const section = (clients ?? []).filter(client => client.archived === archive);
  const visible = section.filter(client => matchesClient(client, query)).sort(
    (a, b) => (archive ? 0 : compareDue(a.billing, b.billing, today)) || nameOf(a).localeCompare(nameOf(b), 'ru'),
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
    try { await action(); setNotice(message); return true; }
    catch (reason) {
      setError(reason instanceof Error && reason.name === 'BillingError' ? reason.message :
        'Не удалось сохранить изменения. Повторите попытку.');
      return false;
    }
    finally { setBusy(false); }
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void write(async () => {
      const client = await createClient(fields, enrollment ? enrollmentOf(enrollment) : undefined);
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

  function rememberTariff(tariff: Tariff) {
    setTariffs(current => [...current.filter(item => item.id !== tariff.id), tariff].sort(byTariffName));
  }

  return (
    <main className="shell" aria-busy={busy}>
      <header className="masthead">
        <span className="mark" aria-hidden="true"><i /><i /><i /></span>
        <div><div className="brand">Подход</div><div className="subtitle">Журнал тренера</div></div>
      </header>
      {notice && <p className="notice" role="status">{notice}</p>}
      {error && !pendingDelete.length && <p ref={errorBanner} tabIndex={-1} className="error" role="alert">{error}</p>}

      {screen.kind === 'list' && <>
        <nav aria-label="Разделы журнала">
          <button className={!archive ? 'current' : ''} type="button" aria-current={!archive ? 'page' : undefined}
            disabled={busy} onClick={() => switchList(false)}>Клиенты</button>
          <button className={archive ? 'current' : ''} type="button" aria-current={archive ? 'page' : undefined}
            disabled={busy} onClick={() => switchList(true)}>Архив</button>
          <button type="button" disabled={busy || !clients} onClick={() => {
            setError(''); setNotice(''); setScreen({ kind: 'tariffs' });
          }}>Настройки</button>
        </nav>
        <div className="section-heading">
          <h1>{archive ? 'Архив' : 'Клиенты'}</h1>
          {!archive && clients && <button type="button" className="primary" disabled={busy} onClick={() => {
            setFields(emptyFields); setEnrollment(null); setError(''); setNotice(''); setScreen({ kind: 'new' });
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
            {visible.map(client => {
              const balance = billingBalance(client.billing);
              return <li key={client.id}>
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
                  <span><strong>{nameOf(client)}</strong>{client.phone && <small>{client.phone}</small>}
                    {client.billing && <small>{dueStatus(client.billing, today)}</small>}
                    {balance > 0 && <small className="debt">К доплате: {money(balance)}</small>}</span>
                  <span aria-hidden="true">›</span>
                </button>
              </li>;
            })}
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
          {tariffs.some(tariff => tariff.enabled) ? <fieldset className="billing-fields" disabled={busy}>
            <label>Абонемент<select aria-label="Абонемент" value={enrollment?.kind ?? ''} onChange={event => {
              const kind = event.target.value;
              setEnrollment(kind === 'start' || kind === 'transfer' ? initialEnrollment(kind, tariffs) : null);
            }}><option value="">Без абонемента</option><option value="start">Оформить новый</option>
              <option value="transfer">Перенести действующий</option></select></label>
            {enrollment && <EnrollmentFields form={enrollment} onChange={setEnrollment} tariffs={tariffs} />}
          </fieldset> : <small className="muted">Добавить абонемент можно позже, после настройки тарифов.</small>}
          <button className="primary" type="submit" disabled={busy}>Сохранить карточку</button>
        </form>
      </>}

      {screen.kind === 'card' && <>
        <h1>{nameOf(screen.client)}</h1>
        <dl className="panel details">
          <div><dt>Телефон</dt><dd>{screen.client.phone || 'Не указан'}</dd></div>
          <div><dt>Заметки</dt><dd>{screen.client.notes || 'Нет заметок'}</dd></div>
        </dl>
        <BillingCard key={screen.client.id} billing={screen.client.billing} archived={screen.client.archived}
          tariffs={tariffs} today={today} busy={busy} onSave={action => write(async () => {
            const client = await updateBilling(screen.client.id, action);
            setClients(current => current?.map(item => item.id === client.id ? client : item) ?? null);
            setScreen({ kind: 'card', client });
          }, 'Изменения сохранены.')} />
      </>}

      {screen.kind === 'tariffs' && <Tariffs tariffs={tariffs} busy={busy} onSave={(draft, id) => write(async () => {
        rememberTariff(await saveTariff(draft, id));
      }, 'Тариф сохранён.')} onToggle={tariff => void write(async () => {
        rememberTariff(await setTariffEnabled(tariff.id, !tariff.enabled));
      }, tariff.enabled ? 'Тариф отключён.' : 'Тариф включён.')} />}

      {pendingDelete.length > 0 && <DeleteDialog clients={pendingDelete} busy={busy} error={error}
        onCancel={() => { setPendingDelete([]); setError(''); }} onConfirm={remove} />}
      <footer>Данные хранятся в этом браузере.</footer>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
