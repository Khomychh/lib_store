/**
 * Бекенд книжкового магазину (Google Apps Script).
 *
 * Скрипт прив'язаний до таблиці ЗАМОВЛЕНЬ (Розширення → Apps Script).
 *   GET  → повертає JSON зі списком книг у наявності з таблиці-каталогу
 *   POST → записує замовлення в два аркуші:
 *          «Замовлення» — один рядок на замовлення, з колонкою «Статус»
 *          «Позиції»    — один рядок на кожну книгу, пов'язаний номером замовлення
 */

// ID таблиці з книгами: частина посилання між /d/ і /edit
const CATALOG_ID = 'ВСТАВТЕ_ID_ТАБЛИЦІ_З_КНИГАМИ';
// Назва аркуша з книгами; порожньо — перший аркуш
const CATALOG_SHEET = '';
// ID папки на Google Диску з фото книг (частина посилання після /folders/); порожньо — без фото.
// Файл називається номером книги з колонки «№»: 15.jpg — обкладинка, 15-2.jpg, 15-3.jpg — ще фото
const PHOTOS_FOLDER = '';
// Аркуші в цій (прив'язаній) таблиці; створюються самі
const ORDERS_SHEET = 'Замовлення';
const ITEMS_SHEET = 'Позиції';

// Сповіщення в Telegram про нові замовлення. Токен бота і chat_id зберігаються не тут
// (репозиторій публічний), а у Властивостях скрипта: Налаштування проєкту → Властивості скрипта →
// TELEGRAM_TOKEN і TELEGRAM_CHAT_ID. Якщо їх немає — сповіщення просто не надсилаються.

// Захист від спаму: скільки різних книг можна в одному замовленні
const MAX_ITEMS = 100;

const ORDER_HEADERS = [
  'Дата', '№ замовлення', 'ПІБ', 'Телефон', 'Email',
  'Спосіб доставки', 'Адреса доставки', 'Отримувач', 'Оплата', 'Коментар',
  'Книг, шт.', 'Сума', 'Склад замовлення', 'Статус',
];
const ITEM_HEADERS = ['Дата', '№ замовлення', '№ книги', 'Автор', 'Назва', 'Ціна', 'К-сть', 'Сума'];

const STATUS_COL = ORDER_HEADERS.length; // «Статус» — остання колонка аркуша «Замовлення»
const NEW_STATUS = 'Нове';
// Статус і колір рядка; порядок = порядок у випадному списку
// Способи доставки: назва в таблиці і обов'язкові поля
const DELIVERY = {
  np_branch: { label: 'Нова пошта, відділення', required: ['city', 'warehouse'] },
  np_locker: { label: 'Нова пошта, поштомат', required: ['city', 'warehouse'] },
  np_courier: { label: 'Нова пошта, кур’єр', required: ['city', 'street', 'house'] },
  ukrposhta: { label: 'Укрпошта', required: ['city', 'zip'] },
  pickup: { label: 'Самовивіз', required: [] },
};
const PAYMENTS = { cod: 'При отриманні', prepay: 'Передоплата на картку' };

const STATUSES = [
  ['Нове', '#fff2cc'],
  ['Підтверджено', '#dbe9f6'],
  ['Оплачено', '#e4dcf3'],
  ['Відправлено', '#d9ead3'],
  ['Виконано', null],
  ['Скасовано', '#eeeeee'],
];

function doGet() {
  const photos = photos_();
  const books = readCatalog_()
    .filter(b => b.stock > 0)
    .map(b => Object.assign(b, { photos: photos[b.id.toLowerCase()] || [] }));
  return json_({ ok: true, books });
}

// Номер книги → ID файлів фото по порядку (перше — обкладинка). Обхід папки повільний,
// тому список кешується на 10 хвилин: нове фото з'являється на сайті не одразу
function photos_() {
  if (!PHOTOS_FOLDER) return {};
  const cached = cacheGet_('photos');
  if (cached) return JSON.parse(cached);

  const found = {}; // номер книги → { порядковий номер фото → { file, date } }
  try {
    const files = DriveApp.getFolderById(PHOTOS_FOLDER).getFiles();
    while (files.hasNext()) {
      const f = files.next();
      if (f.isTrashed() || !f.getMimeType().startsWith('image/')) continue;
      const name = f.getName().replace(/\.[^.]*$/, '').trim().toLowerCase();
      // 15 → книга 15, фото 1;  15-3 → книга 15, фото 3
      const m = name.match(/^(.+?)\s*-\s*(\d+)$/);
      const id = m ? m[1] : name;
      const n = m ? Number(m[2]) : 1;
      const date = f.getLastUpdated().getTime();
      const book = found[id] = found[id] || {};
      // кілька файлів з однаковою назвою — беремо найновіший
      if (!book[n] || date > book[n].date) book[n] = { file: f.getId(), date };
    }
  } catch (err) {
    // неправильний ID папки чи немає доступу — сайт працює без фото
    console.error(err);
    return {};
  }

  const map = {};
  Object.keys(found).forEach(id => {
    map[id] = Object.keys(found[id]).map(Number).sort((a, b) => a - b).map(n => found[id][n].file);
  });
  const json = JSON.stringify(map);
  cachePut_('photos', json, 600);
  return map;
}

// Кеш Apps Script приймає до 100 КБ на запис, тому довгий текст ділимо на шматки
const CACHE_CHUNK = 90000;

function cachePut_(key, text, seconds) {
  const parts = {};
  const count = Math.ceil(text.length / CACHE_CHUNK);
  for (let i = 0; i < count; i++) parts[`${key}:${i}`] = text.slice(i * CACHE_CHUNK, (i + 1) * CACHE_CHUNK);
  parts[key] = String(count);
  try { CacheService.getScriptCache().putAll(parts, seconds); } catch (err) { console.error(err); }
}

function cacheGet_(key) {
  const cache = CacheService.getScriptCache();
  const count = Number(cache.get(key));
  if (!count) return null;
  const keys = Array.from({ length: count }, (_, i) => `${key}:${i}`);
  const parts = cache.getAll(keys);
  // якщо кеш викинув хоч один шматок — вважаємо, що кешу немає
  if (keys.some(k => parts[k] == null)) return null;
  return keys.map(k => parts[k]).join('');
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const order = JSON.parse(e.postData.contents);
    const customer = order.customer || {};
    if (customer.website) return json_({ ok: true, orderId: '-', total: 0 }); // пастка для ботів
    const items = Array.isArray(order.items) ? order.items : [];
    if (items.length > MAX_ITEMS) {
      return json_({ ok: false, error: 'Забагато позицій в одному замовленні.' });
    }
    if (!str_(customer.name) || !str_(customer.phone)) {
      return json_({ ok: false, error: 'Вкажіть ПІБ і телефон.' });
    }
    if (!phoneOk_(customer.phone)) return json_({ ok: false, error: 'Перевірте номер телефону.' });

    const delivery = customer.delivery || {};
    const method = DELIVERY[delivery.method];
    if (!method) return json_({ ok: false, error: 'Виберіть спосіб доставки.' });
    if (method.required.some(f => !str_(delivery[f]))) {
      return json_({ ok: false, error: 'Заповніть дані доставки.' });
    }
    const payment = PAYMENTS[customer.payment];
    if (!payment) return json_({ ok: false, error: 'Виберіть спосіб оплати.' });
    const recipient = customer.recipient;
    if (recipient && (!str_(recipient.name) || !phoneOk_(recipient.phone))) {
      return json_({ ok: false, error: 'Перевірте дані отримувача.' });
    }

    // Ціни й наявність беремо з каталогу, а не з браузера
    const byId = {};
    readCatalog_().forEach(b => { byId[b.id] = b; });

    // одна й та сама книга могла прийти кількома рядками — сумуємо
    const qtyById = {};
    items.forEach(item => {
      const qty = Math.floor(Number(item.qty));
      if (qty > 0) qtyById[String(item.id)] = (qtyById[String(item.id)] || 0) + qty;
    });

    const lines = [];
    const problems = [];
    Object.keys(qtyById).forEach(id => {
      const book = byId[id];
      const qty = qtyById[id];
      if (!book) return;
      if (qty > book.stock) {
        problems.push(`«${book.title}»: доступно лише ${book.stock} шт.`);
        return;
      }
      lines.push({ book, qty, sum: book.price * qty });
    });

    if (problems.length) return json_({ ok: false, error: problems.join('\n') });
    if (!lines.length) return json_({ ok: false, error: 'Кошик порожній.' });

    const total = lines.reduce((s, l) => s + l.sum, 0);
    const now = new Date();
    const orderId = Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyMMdd-HHmmss') +
      '-' + Math.floor(Math.random() * 900 + 100);

    const pcs = lines.reduce((s, l) => s + l.qty, 0);
    const summary = lines
      .map(l => `№${l.book.id} ${l.book.author ? l.book.author + ', ' : ''}«${l.book.title}» × ${l.qty} — ${l.sum} грн`)
      .join('\n');

    appendRows_(itemsSheet_(), lines.map(l => [
      now, orderId, l.book.id, text_(l.book.author), text_(l.book.title), l.book.price, l.qty, l.sum,
    ]));

    const orders = ordersSheet_();
    const row = appendRows_(orders, [[
      now, orderId, text_(customer.name), "'" + str_(customer.phone), text_(customer.email),
      method.label, text_(address_(delivery)),
      recipient ? text_(`${str_(recipient.name)}, ${str_(recipient.phone)}`) : 'Покупець',
      payment, text_(customer.comment), pcs, total, text_(summary), NEW_STATUS,
    ]]);
    orders.getRange(row, STATUS_COL).setDataValidation(statusRule_());

    // null — рядок пропускається, '' — порожній рядок-роздільник
    notifyTelegram_([
      `🛒 Нове замовлення ${orderId}`,
      '',
      `${str_(customer.name)}, ${str_(customer.phone)}`,
      str_(customer.email) || null,
      recipient ? `Отримувач: ${str_(recipient.name)}, ${str_(recipient.phone)}` : null,
      [method.label, address_(delivery)].filter(Boolean).join(': '),
      `Оплата: ${payment}`,
      str_(customer.comment) ? `Коментар: ${str_(customer.comment)}` : null,
      '',
      summary,
      '',
      `Разом: ${pcs} шт., ${total} грн`,
    ].filter(l => l !== null).join('\n'));

    return json_({ ok: true, orderId, total });
  } catch (err) {
    console.error(err);
    return json_({ ok: false, error: 'Помилка на сервері. Спробуйте ще раз.' });
  } finally {
    lock.releaseLock();
  }
}

// Помилка Telegram не повинна зламати замовлення — воно вже записане в таблицю
function notifyTelegram_(text) {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('TELEGRAM_TOKEN');
  const chatId = props.getProperty('TELEGRAM_CHAT_ID');
  if (!token || !chatId) return;
  try {
    const res = UrlFetchApp.fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000) }),
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() !== 200) console.error('Telegram:', res.getContentText());
  } catch (err) {
    console.error(err);
  }
}

// Запустіть вручну в редакторі, щоб перевірити налаштування Telegram
function testTelegram() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('TELEGRAM_TOKEN') || !props.getProperty('TELEGRAM_CHAT_ID')) {
    throw new Error('Додайте TELEGRAM_TOKEN і TELEGRAM_CHAT_ID у Властивості скрипта');
  }
  notifyTelegram_('✅ Сповіщення про замовлення працюють');
}

function readCatalog_() {
  const ss = SpreadsheetApp.openById(CATALOG_ID);
  const sheet = CATALOG_SHEET ? ss.getSheetByName(CATALOG_SHEET) : ss.getSheets()[0];
  const values = sheet.getDataRange().getValues();
  const head = values[0].map(h => String(h).trim());
  const col = name => head.indexOf(name);
  const c = {
    id: col('№'), author: col('Автор'), title: col('Назва'), year: col('Рік'),
    pages: col('Сторінки'), price: col('Ціна'), stock: col('К-сть'),
  };

  return values.slice(1)
    .filter(r => String(r[c.title]).trim())
    .map(r => ({
      id: String(r[c.id]).trim(),
      author: String(r[c.author]).trim(),
      title: String(r[c.title]).trim(),
      year: String(r[c.year]).trim(),
      pages: String(r[c.pages]).trim(),
      price: Number(r[c.price]) || 0,
      stock: Number(r[c.stock]) || 0,
    }))
    // книга без ціни (порожньо, 0 або текст) не продається — інакше була б безкоштовною
    .filter(b => b.price > 0);
}

// Дописує рядки в кінець аркуша; повертає номер першого доданого рядка
function appendRows_(sheet, rows) {
  const row = sheet.getLastRow() + 1;
  sheet.getRange(row, 1, rows.length, rows[0].length).setValues(rows);
  return row;
}

function ordersSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(ORDERS_SHEET);
  // аркуш з іншим набором колонок не чіпаємо — лише перейменовуємо
  if (sheet) {
    const head = sheet.getRange(1, 1, 1, sheet.getLastColumn() || 1).getValues()[0].map(String);
    if (head.join('|') !== ORDER_HEADERS.join('|')) {
      let name = ORDERS_SHEET + ' (старі)';
      for (let i = 2; ss.getSheetByName(name); i++) name = `${ORDERS_SHEET} (старі ${i})`;
      sheet.setName(name);
      sheet = null;
    }
  }
  if (!sheet) {
    sheet = createSheet_(ss, ORDERS_SHEET, ORDER_HEADERS);
    const col = name => colLetter_(ORDER_HEADERS.indexOf(name) + 1);
    const last = colLetter_(ORDER_HEADERS.length);
    sheet.getRange(`A:${last}`).setVerticalAlignment('middle');
    [['Адреса доставки', 260], ['Отримувач', 200], ['Коментар', 240], ['Склад замовлення', 360]].forEach(([name, width]) => {
      sheet.setColumnWidth(ORDER_HEADERS.indexOf(name) + 1, width);
      sheet.getRange(`${col(name)}:${col(name)}`).setWrap(true);
    });
    sheet.getRange(`${col('Сума')}:${col('Сума')}`).setNumberFormat('#,##0 "грн"');

    // кольори рядків за статусом
    const range = sheet.getRange(`A2:${last}`);
    sheet.setConditionalFormatRules(STATUSES
      .filter(([, color]) => color)
      .map(([name, color]) => SpreadsheetApp.newConditionalFormatRule()
        .whenFormulaSatisfied(`=$${last}2="${name}"`)
        .setBackground(color)
        .setRanges([range])
        .build()));
  }
  return sheet;
}

function itemsSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(ITEMS_SHEET) || createSheet_(ss, ITEMS_SHEET, ITEM_HEADERS);
}

function createSheet_(ss, name, headers) {
  const sheet = ss.insertSheet(name);
  sheet.appendRow(headers);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  sheet.getRange('A:A').setNumberFormat('dd.MM.yyyy HH:mm');
  return sheet;
}

function statusRule_() {
  return SpreadsheetApp.newDataValidation()
    .requireValueInList(STATUSES.map(([name]) => name), true)
    .setAllowInvalid(false)
    .build();
}

// Адреса одним рядком для таблиці
function address_(d) {
  const v = name => str_(d[name]);
  switch (d.method) {
    case 'np_branch':
    case 'np_locker': return `${v('city')}, ${v('warehouse')}`;
    case 'np_courier': return [v('city'), v('street'), `буд. ${v('house')}`, v('flat') && `кв. ${v('flat')}`].filter(Boolean).join(', ');
    case 'ukrposhta': return `${v('city')}, індекс ${v('zip')}`;
    default: return '';
  }
}

function phoneOk_(phone) {
  const digits = str_(phone).replace(/\D/g, '').length;
  return digits >= 10 && digits <= 15;
}

// 1 → A, 14 → N
function colLetter_(n) {
  return String.fromCharCode(64 + n);
}

function str_(v) {
  return String(v == null ? '' : v).trim().slice(0, 500);
}

// Текст, який починається з = + - @, таблиця сприйме як формулу.
// Апостроф змушує записати його як звичайний текст.
function text_(v) {
  const t = str_(v);
  return /^[=+\-@]/.test(t) ? "'" + t : t;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
