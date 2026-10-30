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
// Аркуші в цій (прив'язаній) таблиці; створюються самі
const ORDERS_SHEET = 'Замовлення';
const ITEMS_SHEET = 'Позиції';

// Захист від спаму: скільки різних книг можна в одному замовленні
const MAX_ITEMS = 100;

const ORDER_HEADERS = [
  'Дата', '№ замовлення', 'ПІБ', 'Телефон', 'Email', 'Доставка', 'Коментар',
  'Книг, шт.', 'Сума', 'Склад замовлення', 'Статус',
];
const ITEM_HEADERS = ['Дата', '№ замовлення', '№ книги', 'Автор', 'Назва', 'Ціна', 'К-сть', 'Сума'];

const STATUS_COL = ORDER_HEADERS.length; // «Статус» — остання колонка аркуша «Замовлення» (K)
const NEW_STATUS = 'Нове';
// Статус і колір рядка; порядок = порядок у випадному списку
const STATUSES = [
  ['Нове', '#fff2cc'],
  ['Підтверджено', '#dbe9f6'],
  ['Оплачено', '#e4dcf3'],
  ['Відправлено', '#d9ead3'],
  ['Виконано', null],
  ['Скасовано', '#eeeeee'],
];

function doGet() {
  return json_({ ok: true, books: readCatalog_().filter(b => b.stock > 0) });
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
    const phoneDigits = str_(customer.phone).replace(/\D/g, '').length;
    if (phoneDigits < 10 || phoneDigits > 15) {
      return json_({ ok: false, error: 'Перевірте номер телефону.' });
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
      .map(l => `${l.book.title} × ${l.qty} — ${l.sum} грн`)
      .join('\n');

    appendRows_(itemsSheet_(), lines.map(l => [
      now, orderId, l.book.id, text_(l.book.author), text_(l.book.title), l.book.price, l.qty, l.sum,
    ]));

    const orders = ordersSheet_();
    const row = appendRows_(orders, [[
      now, orderId, text_(customer.name), "'" + str_(customer.phone), text_(customer.email),
      text_(customer.delivery), text_(customer.comment), pcs, total, text_(summary), NEW_STATUS,
    ]]);
    orders.getRange(row, STATUS_COL).setDataValidation(statusRule_());

    return json_({ ok: true, orderId, total });
  } catch (err) {
    console.error(err);
    return json_({ ok: false, error: 'Помилка на сервері. Спробуйте ще раз.' });
  } finally {
    lock.releaseLock();
  }
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
    }));
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
  // аркуш старого формату (рядок на книгу) не чіпаємо — лише перейменовуємо
  if (sheet && sheet.getRange(1, STATUS_COL).getValue() !== 'Статус') {
    let name = ORDERS_SHEET + ' (старі)';
    for (let i = 2; ss.getSheetByName(name); i++) name = `${ORDERS_SHEET} (старі ${i})`;
    sheet.setName(name);
    sheet = null;
  }
  if (!sheet) {
    sheet = createSheet_(ss, ORDERS_SHEET, ORDER_HEADERS);
    sheet.getRange('A:K').setVerticalAlignment('middle');
    sheet.setColumnWidth(7, 240);
    sheet.getRange('G:G').setWrap(true); // Коментар
    sheet.setColumnWidth(10, 360);
    sheet.getRange('J:J').setWrap(true); // Склад замовлення
    sheet.getRange('I:I').setNumberFormat('#,##0 "грн"');

    // кольори рядків за статусом
    const range = sheet.getRange('A2:K');
    sheet.setConditionalFormatRules(STATUSES
      .filter(([, color]) => color)
      .map(([name, color]) => SpreadsheetApp.newConditionalFormatRule()
        .whenFormulaSatisfied(`=$K2="${name}"`)
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
