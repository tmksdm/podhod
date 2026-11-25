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
    await expect(page.getByText('Без абонемента')).toBeVisible();
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
  assert.deepEqual(errors, []);
  console.log('PASS: Chromium 390×844, создание, поиск, архив, возврат, отмена, одиночное и массовое удаление, перезапуск.');
} finally {
  try { await browser?.close(); } finally {
    server?.httpServer.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5 });
  }
}
