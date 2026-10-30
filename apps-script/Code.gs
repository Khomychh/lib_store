/**
 * Бекенд книжкового магазину (Google Apps Script).
 *
 * Скрипт прив'язаний до таблиці ЗАМОВЛЕНЬ (Розширення → Apps Script).
 *   GET  → повертає JSON зі списком книг у наявності з таблиці-каталогу
 *   POST → записує замовлення в аркуш «Замовлення»
 */

// ID таблиці з книгами: частина посилання між /d/ і /edit
const CATALOG_ID = 'ВСТАВТЕ_ID_ТАБЛИЦІ_З_КНИГАМИ';
// Назва аркуша з книгами; порожньо — перший аркуш
const CATALOG_SHEET = '';
// Аркуш для замовлень у цій (прив'язаній) таблиці; створиться сам
const ORDERS_SHEET = 'Замовлення';

const ORDER_HEADERS = [
  'Дата', '№ замовлення', 'ПІБ', 'Телефон', 'Email', 'Доставка', 'Коментар',
  '№ книги', 'Автор', 'Назва', 'Ціна', 'К-сть', 'Сума', 'Разом по замовленню',
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
    if (!str_(customer.name) || !str_(customer.phone)) {
      return json_({ ok: false, error: 'Вкажіть ПІБ і телефон.' });
    }

    // Ціни й наявність беремо з каталогу, а не з браузера
    const byId = {};
    readCatalog_().forEach(b => { byId[b.id] = b; });

    const lines = [];
    const problems = [];
    (order.items || []).forEach(item => {
      const book = byId[String(item.id)];
      const qty = Math.floor(Number(item.qty));
      if (!book || !(qty > 0)) return;
      if (qty > book.stock) {
        problems.push(`«${book.title}»: доступно лише ${book.stock} шт.`);
        return;
      }
      lines.push({ book, qty, sum: book.price * qty });
    });

    if (problems.length) return json_({ ok: false, error: problems.join('\n') });
    if (!lines.length) return json_({ ok: false, error: 'Кошик порожній.' });

    const total = lines.reduce((s, l) => s + l.sum, 0);
    const orderId = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyMMdd-HHmmss');
    const now = new Date();

    const rows = lines.map(l => [
      now, orderId, str_(customer.name), "'" + str_(customer.phone), str_(customer.email),
      str_(customer.delivery), str_(customer.comment),
      l.book.id, l.book.author, l.book.title, l.book.price, l.qty, l.sum, total,
    ]);

    const sheet = ordersSheet_();
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);

    return json_({ ok: true, orderId, total });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
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

function ordersSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(ORDERS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(ORDERS_SHEET);
    sheet.appendRow(ORDER_HEADERS);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, ORDER_HEADERS.length).setFontWeight('bold');
  }
  return sheet;
}

function str_(v) {
  return String(v == null ? '' : v).trim().slice(0, 500);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
