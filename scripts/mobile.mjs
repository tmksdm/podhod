import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { preview } from 'vite';

const profile = await mkdtemp(join(tmpdir(), 'podhod-test-'));
let browser;
let server;
const errors = [];

try {
  server = await preview({ preview: { host: '127.0.0.1', port: 0 } });
  const url = `http://127.0.0.1:${server.httpServer.address().port}/`;
  async function launch() {
    browser = await chromium.launchPersistentContext(profile, {
      viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
      channel: process.argv[2],
    });
    const page = browser.pages()[0] ?? await browser.newPage();
    page.setDefaultTimeout(10_000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    await expect(page.getByRole('searchbox')).toBeVisible();
    assert.equal(await page.evaluate(() => document.documentElement.clientWidth), 390);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
    return page;
  }
  let page = await launch();
  const button = name => page.getByRole('button', { name, exact: true });
  const checkbox = name => page.getByRole('checkbox', { name: `Выбрать ${name}`, exact: true });
  const search = () => page.getByRole('searchbox');
  async function add(first = '', last = '', phone = '', notes = '') {
    await button('Новый клиент').click();
    await page.getByLabel('Имя', { exact: true }).fill(first);
    await page.getByLabel('Фамилия', { exact: true }).fill(last);
    await page.getByLabel('Телефон', { exact: true }).fill(phone);
    await page.getByLabel('Заметки', { exact: true }).fill(notes);
    await button('Сохранить карточку').click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText([first, last].filter(Boolean).join(' ') || 'Без имени');
    await expect(page.getByText('Без абонемента', { exact: true })).toBeVisible();
    if (notes) await expect(page.getByText(notes)).toBeVisible();
    await page.getByRole('button', { name: /К списку/ }).click();
  }
  await add();
  await add('Лада', 'Тестова', '000-01', 'Учебная заметка');
  await add('Марк', 'Примеров');
  await add('Жанна');
  await search().fill('лАД');
  await expect(checkbox('Лада Тестова')).toBeVisible();
  await expect(page.getByRole('checkbox')).toHaveCount(1);
  await search().fill('теСТ');
  await expect(checkbox('Лада Тестова')).toBeVisible();
  await search().fill('ест');
  await expect(page.getByText('Ничего не найдено')).toBeVisible();
  await search().clear();
  await checkbox('Лада Тестова').check();
  await checkbox('Без имени').check();
  await button('В архив').click();
  await expect(checkbox('Лада Тестова')).toHaveCount(0);
  await expect(checkbox('Без имени')).toHaveCount(0);
  await browser.close();
  browser = undefined;
  page = await launch();
  await expect(checkbox('Марк Примеров')).toBeVisible();
  await expect(checkbox('Лада Тестова')).toHaveCount(0);
  await button('Архив').click();
  await expect(page.getByRole('checkbox')).toHaveCount(2);
  await search().fill('ТЕС');
  await page.getByRole('button', { name: /Лада Тестова/ }).click();
  await expect(page.getByText('В архиве', { exact: true })).toBeVisible();
  await expect(page.getByText('Учебная заметка')).toBeVisible();
  await expect(page.getByText('000-01')).toBeVisible();
  await page.getByRole('button', { name: /К архиву/ }).click();
  await checkbox('Лада Тестова').check();
  await button('Вернуть').click();
  await expect(checkbox('Лада Тестова')).toHaveCount(0);
  await search().clear();
  await checkbox('Без имени').check();
  await button('Удалить').click();
  const dialog = () => page.getByRole('dialog');
  await expect(dialog()).toContainText('Без имени');
  await button('Удалить навсегда').click();
  await expect(page.getByText('Архив пуст')).toBeVisible();
  await button('Клиенты').click();
  await checkbox('Жанна').check();
  await button('Удалить').click();
  await expect(dialog()).toContainText('Жанна');
  await button('Отмена').click();
  await expect(checkbox('Жанна')).toBeVisible();
  await button('Удалить').click();
  await button('Удалить навсегда').click();
  await expect(checkbox('Жанна')).toHaveCount(0);
  await checkbox('Марк Примеров').check();
  await checkbox('Лада Тестова').check();
  await button('Удалить').click();
  await expect(dialog()).toContainText('Марк Примеров');
  await expect(dialog()).toContainText('Лада Тестова');
  await button('Удалить навсегда').click();
  await expect(page.getByText('Пока нет клиентов')).toBeVisible();
  await page.reload();
  await expect(page.getByText('Пока нет клиентов')).toBeVisible();

  const label = name => page.getByLabel(name, { exact: true });
  const back = () => page.getByRole('button', { name: /К списку/ }).click();
  const subscription = () => page.getByRole('region', { name: 'Абонемент', exact: true });
  const history = () => page.getByRole('region', { name: 'История платежей' });
  const noHorizontalScroll = async () => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  async function setDate(date) {
    await page.clock.setFixedTime(new Date(`${date}T12:00:00`));
    await page.reload();
    await expect(search()).toBeVisible();
  }

  await setDate('2026-02-15');
  await button('Настройки').click();
  await button('Новый тариф').click();
  await noHorizontalScroll();
  await label('Название тарифа').fill('Учебный месяц');
  await label('Цена, ₽').fill('3000');
  await button('Сохранить тариф').click();
  await expect(page.getByText('Учебный месяц', { exact: true })).toBeVisible();
  await back();
  await button('Новый клиент').click();
  await label('Имя').fill('Клиент Пример');
  await label('Абонемент').selectOption('start');
  await noHorizontalScroll();
  await expect(label('Дата начала')).toHaveValue('2026-02-15');
  await expect(label('Получено, ₽')).toHaveValue('3000.00');
  await label('Дата начала').fill('2026-01-31');
  await label('Получено, ₽').fill('2000');
  await expect(page.getByText(/Период с 31\.01\.2026.*28\.02\.2026/)).toBeVisible();
  await button('Сохранить карточку').click();
  await expect(subscription()).toContainText('Следующая оплата: 28.02.2026');
  await expect(subscription()).toContainText(/Осталось доплатить 1\s000/);
  await expect(history()).toContainText(/15\.02\.2026: 2\s000/);
  await button('Внести доплату').click();
  await expect(label('Сумма взноса, ₽')).toHaveValue('1000.00');
  await button('Сохранить платёж').click();
  await expect(subscription()).not.toContainText('Осталось доплатить');
  await expect(subscription()).toContainText('Следующая оплата: 28.02.2026');
  await expect(history()).toContainText(/15\.02\.2026: 1\s000/);
  await button('Продлить').click();
  await expect(label('Тариф').locator('option:checked')).toContainText('Учебный месяц');
  await expect(page.getByText(/Период с 28\.02\.2026.*28\.03\.2026/)).toBeVisible();
  await button('Сохранить абонемент').click();
  await expect(subscription()).toContainText('Действует');
  await expect(subscription()).toContainText('Следующая оплата: 28.03.2026');
  await noHorizontalScroll();

  const open = name => page.getByRole('button', { name: new RegExp(`^${name}`) }).click();
  await back();
  await button('Настройки').click();
  await button('Редактировать').click();
  await label('Название тарифа').fill('Месяц обновлённый');
  await label('Цена, ₽').fill('4000');
  await button('Сохранить тариф').click();
  await expect(page.getByText('Месяц обновлённый', { exact: true })).toBeVisible();
  await button('Отключить').click();
  await expect(page.getByText(/Отключён/)).toBeVisible();
  await back();
  await open('Клиент Пример');
  await expect(history()).toContainText(/Учебный месяц.*3\s000/);
  await expect(button('Продлить')).toHaveCount(0);

  await history().getByRole('button', { name: /Исправить.*1\s000/ }).click();
  await label('Сумма взноса, ₽').fill('1500');
  await button('Сохранить платёж').click();
  await expect(page.getByRole('alert')).toContainText(/превышает остаток/i);
  await expect(label('Сумма взноса, ₽')).toBeVisible();
  await label('Сумма взноса, ₽').fill('700');
  await button('Сохранить платёж').click();
  await expect(subscription()).toContainText('Следующая оплата: 28.03.2026');
  await expect(subscription()).toContainText('Осталось доплатить 300');
  await expect(history()).toContainText(/15\.02\.2026: 700/);

  await setDate('2026-05-08');
  await button('Настройки').click();
  await button('Включить').click();
  await expect(button('Отключить')).toBeVisible();
  await back();
  await open('Клиент Пример');
  await expect(subscription()).toContainText('Просрочен');
  await button('Продлить').click();
  await expect(label('Получено, ₽')).toHaveValue('4000.00');
  await expect(page.getByText(/Период с 08\.05\.2026.*08\.06\.2026/)).toBeVisible();
  await button('Сохранить абонемент').click();
  await expect(subscription()).toContainText('Следующая оплата: 08.06.2026');
  await expect(history()).toContainText(/Месяц обновлённый.*4\s000/);
  await expect(history()).toContainText(/Учебный месяц.*3\s000/);

  await back();
  await button('Настройки').click();
  await button('Новый тариф').click();
  await label('Название тарифа').fill('Пробный');
  await label('Цена, ₽').fill('0');
  await label('Единица срока').selectOption('days');
  await button('Сохранить тариф').click();
  await expect(page.getByText('Пробный', { exact: true })).toBeVisible();
  await back();
  await add('А без абонемента');

  await add('З бесплатно');
  await open('З бесплатно');
  await button('Оформить абонемент').click();
  const trialId = await label('Тариф').locator('option').filter({ hasText: 'Пробный' }).getAttribute('value');
  assert.ok(trialId);
  await label('Тариф').selectOption(trialId);
  await label('Дата начала').fill('2026-05-08');
  await button('Сохранить абонемент').click();
  await expect(subscription()).toContainText('Следующая оплата: 09.05.2026');
  await expect(subscription()).not.toContainText('Осталось доплатить');
  await expect(history()).toContainText('Платежей пока нет.');
  await back();

  await button('Новый клиент').click();
  await label('Имя').fill('Я перенос');
  await label('Абонемент').selectOption('transfer');
  await label('Дата следующей оплаты').fill('2026-05-08');
  await expect(label('Получено, ₽')).toHaveCount(0);
  await button('Сохранить карточку').click();
  await expect(subscription()).toContainText('Оплата сегодня');
  await expect(subscription()).not.toContainText('Осталось доплатить');
  await expect(history()).toContainText('Перенесён без начисления');
  await expect(history()).toContainText('Платежей пока нет.');
  await back();

  await setDate('2026-05-09');
  await expect(page.getByRole('list', { name: 'Список клиентов' }).locator('strong')).toHaveText([
    'Я перенос', 'З бесплатно', 'Клиент Пример', 'А без абонемента',
  ]);
  await expect(page.getByRole('button', { name: /Клиент Пример/ })).toContainText('К доплате: 300');
  await noHorizontalScroll();

  await checkbox('Клиент Пример').check();
  await button('В архив').click();
  await expect(checkbox('Клиент Пример')).toHaveCount(0);
  await browser.close();
  browser = undefined;
  page = await launch();
  await setDate('2026-05-09');
  await button('Архив').click();
  await open('Клиент Пример');
  await expect(subscription()).toContainText('В архиве');
  await expect(subscription()).toContainText('Следующая оплата: 08.06.2026');
  await expect(history()).toContainText(/15\.02\.2026: 700/);
  await page.getByRole('button', { name: /К архиву/ }).click();
  await checkbox('Клиент Пример').check();
  await button('Удалить').click();
  await expect(dialog()).toContainText('история платежей тоже будут удалены');
  await button('Удалить навсегда').click();
  await expect(page.getByText('Архив пуст')).toBeVisible();
  await button('Клиенты').click();
  await expect(checkbox('Клиент Пример')).toHaveCount(0);
  await expect(checkbox('Я перенос')).toBeVisible();
  assert.deepEqual(errors, []);
  console.log('PASS: Chromium 390×844, тарифы, взносы и исправления, продление, перенос, сортировка; сохранение архива платежей после перезапуска и удаление.');
} finally {
  try { await browser?.close(); } finally {
    server?.httpServer.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5 });
  }
}
