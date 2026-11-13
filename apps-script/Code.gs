/**
 * Бекенд книжкового магазину (Google Apps Script).
 *
 * Скрипт прив'язаний до таблиці ЗАМОВЛЕНЬ (Розширення → Apps Script).
 *   GET  → повертає JSON зі списком книг у наявності (і тих, що можна передзамовити) з таблиці-каталогу;
 *          лише з галочкою «Публікація», якщо така колонка є
 *   POST → записує замовлення в два аркуші:
 *          «Замовлення» — один рядок на замовлення, з колонкою «Статус»
 *          «Позиції»    — один рядок на кожну книгу, пов'язаний номером замовлення
 */

// Налаштування — не тут, а у Властивостях скрипта (Налаштування проєкту → Властивості скрипта),
// тож цей файл можна вставляти в редактор як є, нічого не правлячи:
//   CATALOG_ID    — таблиця з книгами: ID (частина посилання між /d/ і /edit) або все посилання; обов'язково;
//   CATALOG_SHEET — назва аркуша з книгами; немає — перший аркуш;
//   PHOTOS_FOLDER — папка з фото на Google Диску: ID (частина посилання після /folders/) або все посилання;
//                   немає — сайт без фото. Файл називається номером книги з колонки «№»:
//                   15.jpg — обкладинка, 15-2.jpg, 15-3.jpg — ще фото;
//   TELEGRAM_TOKEN, TELEGRAM_CHAT_ID — сповіщення про замовлення, див. нижче.
// Аркуш з деревом категорій у таблиці з книгами: «Категорія» і «Батьківська» (порожньо — верхній рівень).
// Створюється функцією setupCatalog; якщо аркуша немає — сайт працює без категорій
const CATEGORIES_SHEET = 'Категорії';
// Аркуш з добірками в таблиці з книгами: «Назва», «Опис», «Книги» (номери через кому, у потрібному порядку),
// «Адреса» (необов'язково). Створюється функцією setupCatalog; якщо аркуша немає — сайт працює без добірок
const COLLECTIONS_SHEET = 'Добірки';
// Аркуші в цій (прив'язаній) таблиці; створюються самі
const ORDERS_SHEET = 'Замовлення';
const ITEMS_SHEET = 'Позиції';

// Сповіщення в Telegram про нові замовлення. Токен бота і chat_id зберігаються не тут
// (репозиторій публічний), а у Властивостях скрипта: Налаштування проєкту → Властивості скрипта →
// TELEGRAM_TOKEN і TELEGRAM_CHAT_ID. Якщо їх немає — сповіщення просто не надсилаються.

// Захист від спаму: скільки різних книг можна в одному замовленні
const MAX_ITEMS = 100;
// Повтор того самого замовлення (той самий телефон і ті самі книги в тій самій кількості) протягом цього часу
// не записується вдруге: покупець отримує номер першого. Буває, коли відповідь загубилась і людина натиснула ще раз
const DUPLICATE_WINDOW_SECONDS = 600;

const ORDER_HEADERS = [
  'Дата', '№ замовлення', 'ПІБ', 'Телефон', 'Email',
  'Спосіб доставки', 'Адреса доставки', 'Отримувач', 'Оплата', 'Коментар',
  'Книг, шт.', 'Сума', 'Склад замовлення', 'Статус',
];
// «Передзамовлення, шт.» — скільки з «К-сть» понад наявність (порожньо — усе є в наявності)
const ITEM_HEADERS = ['Дата', '№ замовлення', '№ книги', 'Автор', 'Назва', 'Ціна', 'К-сть', 'Сума', 'Передзамовлення, шт.'];

const STATUS_COL = ORDER_HEADERS.length; // «Статус» — остання колонка аркуша «Замовлення»
const NEW_STATUS = 'Нове';
// Статус і колір рядка; порядок = порядок у випадному списку
// Способи доставки: назва в таблиці і обов'язкові поля
const DELIVERY = {
  np_branch: { label: 'Нова пошта, відділення', required: ['city', 'warehouse'] },
  np_locker: { label: 'Нова пошта, поштомат', required: ['city', 'warehouse'] },
  np_courier: { label: 'Нова пошта, кур’єр', required: ['city', 'street', 'house'] },
  ukrposhta: { label: 'Укрпошта', required: ['city', 'zip'] },
  meest: { label: 'Meest Пошта', required: ['city', 'branch'] },
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
    // з К-сть 0 лишаються лише книги, які можна передзамовити
    .filter(b => b.stock > 0 || b.preorder)
    .map(b => Object.assign(b, { photos: photos[b.id.toLowerCase()] || [] }));
  return json_({ ok: true, books, categories: readCategories_(), collections: readCollections_(books) });
}

// Значення з Властивостей скрипта; читаються один раз за запуск
let settings_;
function setting_(name) {
  if (!settings_) settings_ = PropertiesService.getScriptProperties().getProperties();
  return String(settings_[name] || '').trim();
}
// ID з властивості, куди можна вписати й усе посилання: …/d/<ID>/edit, …/folders/<ID>?usp=…
function settingId_(name) {
  const value = setting_(name);
  const m = value.match(/\/(?:d|folders)\/([\w-]+)/);
  return m ? m[1] : value;
}
const photosFolder_ = () => settingId_('PHOTOS_FOLDER');

function catalog_() {
  const id = settingId_('CATALOG_ID');
  if (!id) {
    throw new Error('Не вказано таблицю з книгами: додайте CATALOG_ID у Властивості скрипта ' +
      '(Налаштування проєкту → Властивості скрипта).');
  }
  return SpreadsheetApp.openById(id);
}

function catalogSheet_(ss) {
  const name = setting_('CATALOG_SHEET');
  const sheet = name ? ss.getSheetByName(name) : ss.getSheets()[0];
  if (!sheet) {
    const names = ss.getSheets().map(s => `«${s.getName()}»`).join(', ');
    throw new Error(`У таблиці з книгами немає аркуша «${name}» (властивість CATALOG_SHEET). Є аркуші: ${names}`);
  }
  // порожній чи службовий аркуш замість каталогу: у першому рядку мають бути заголовки, серед них «Назва»
  const head = sheet.getLastColumn()
    ? sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(h => String(h).trim())
    : [];
  if (head.indexOf('Назва') < 0) {
    throw new Error(`Аркуш «${sheet.getName()}» не схожий на каталог: у першому рядку немає заголовка «Назва». ` +
      (name ? 'Перевірте властивість CATALOG_SHEET.'
        : 'Додайте у Властивості скрипта CATALOG_SHEET з назвою аркуша з книгами або перетягніть цей аркуш першим.'));
  }
  return sheet;
}

// Категорії в порядку рядків аркуша: [{ name, parent }]. Сайт сам будує з них дерево
// і ховає категорії, в яких немає книг у наявності
function readCategories_() {
  const sheet = catalog_().getSheetByName(CATEGORIES_SHEET);
  if (!sheet) return [];
  const values = sheet.getDataRange().getValues();
  const head = values[0].map(h => String(h).trim());
  const name = head.indexOf('Категорія');
  const parent = head.indexOf('Батьківська');
  if (name < 0) return [];
  const seen = {};
  return values.slice(1)
    .map(r => ({ name: String(r[name]).trim(), parent: parent < 0 ? '' : String(r[parent]).trim() }))
    .filter(c => c.name && !seen[c.name] && (seen[c.name] = true));
}

// Добірки в порядку рядків аркуша: [{ name, slug, description, books: ['15', '42'] }].
// Лишаються лише книги, які є на сайті (books), у порядку з клітинки; добірка без жодної такої книги не передається.
// slug — адреса сторінки /dobirka/<slug>/: з колонки «Адреса» або латиницею з назви
function readCollections_(books) {
  const sheet = catalog_().getSheetByName(COLLECTIONS_SHEET);
  if (!sheet) return [];
  // як видно в таблиці: «15,42», яке таблиця вважала б дробовим числом, лишається «15,42»
  const values = sheet.getDataRange().getDisplayValues();
  const head = values[0].map(h => String(h).trim());
  const col = name => head.indexOf(name);
  const c = { name: col('Назва'), description: col('Опис'), books: col('Книги'), slug: col('Адреса') };
  if (c.name < 0 || c.books < 0) return [];
  const onSite = {};
  books.forEach(b => { onSite[b.id] = true; });
  const slugs = {};
  const out = [];
  values.slice(1).forEach(r => {
    const name = String(r[c.name]).trim();
    if (!name) return;
    const ids = [];
    String(r[c.books]).split(/[\s,;.]+/).forEach(id => {
      if (id && onSite[id] && ids.indexOf(id) < 0) ids.push(id);
    });
    if (!ids.length) return;
    let slug = slug_(c.slug < 0 ? '' : r[c.slug]) || slug_(name) || 'dobirka';
    // дві добірки з однаковою адресою — другій дописуємо номер
    for (let i = 2, base = slug; slugs[slug]; i++) slug = `${base}-${i}`;
    slugs[slug] = true;
    const item = { name, slug, books: ids };
    const description = c.description < 0 ? '' : String(r[c.description]).trim();
    if (description) item.description = description;
    out.push(item);
  });
  return out;
}

// «Для початківців у богослов'ї» → «dlia-pochatkivtsiv-u-bohoslovi» (українська транслітерація, як у паспортах)
const TRANSLIT_ = {
  а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', є: 'ie', ж: 'zh', з: 'z', и: 'y', і: 'i', ї: 'i', й: 'i',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts',
  ч: 'ch', ш: 'sh', щ: 'shch', ь: '', ю: 'iu', я: 'ia', ы: 'y', э: 'e', ё: 'io', ъ: '',
};
// на початку слова — інакше: «Юрій» → «yurii»
const TRANSLIT_START_ = { є: 'ye', ї: 'yi', й: 'y', ю: 'yu', я: 'ya' };
function slug_(text) {
  const s = String(text || '').toLowerCase().replace(/[’'ʼ`]/g, '');
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const start = !i || !/[a-zа-яіїєґё0-9]/.test(s[i - 1]);
    if (ch === 'г' && s[i - 1] === 'з') out += 'gh'; // «зг» → «zgh», щоб не читалось як «ж»
    else if (start && TRANSLIT_START_[ch]) out += TRANSLIT_START_[ch];
    else if (ch in TRANSLIT_) out += TRANSLIT_[ch];
    else out += /[a-z0-9]/.test(ch) ? ch : '-';
  }
  return out.replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80).replace(/-$/, '');
}

// Підказки у випадних списках каталогу. «Стан» — лише з цього списку; в інші колонки можна вписати
// й інше значення (таблиця лише попередить), і воно з'явиться у фільтрі на сайті, тож пишіть однаково:
// «Тверда», а не «тверда» чи «Тверда обкладинка»
const STRICT_FIELDS = ['Стан', 'Передзамовлення'];
// Колонка «Палітурка» раніше звалася «Обкладинка». Стару назву скрипт розуміє як нову, а setupCatalog
// перейменовує заголовок у таблиці сам — дані в колонці лишаються
const BINDING_COL = 'Палітурка';
const RENAMED_COLS = { 'Обкладинка': BINDING_COL };
// Заголовки каталогу без пробілів по краях і зі старими назвами, заміненими на нові
const catalogHead_ = row => row.map(h => String(h).trim()).map(h => RENAMED_COLS[h] || h);
const FIELD_OPTIONS = {
  'Стан': ['Нова', 'Вживана'],
  [BINDING_COL]: ['Тверда', 'Суперобкладинка', 'М’яка', 'Інтегральна'],
  'Мова': ['Українська', 'Англійська', 'Російська'],
  // «Доступне» — книгу можна замовити понад наявність, а з К-сть 0 вона не зникає з сайту;
  // «Недоступне» чи порожньо — продається лише те, що є
  'Передзамовлення': ['Доступне', 'Недоступне'],
};
// «Доступне», «доступне» — так; «Недоступне», «Не доступне», порожньо — ні
const preorderOn_ = v => /^доступн/i.test(String(v).trim());

// Колонка-галочка «Публікація»: книга дозволена до показу на сайті. Не скасовує інших умов — ціна, наявність
// чи передзамовлення потрібні, як і раніше. Без галочки книги немає ні на сайті, ні в замовленнях.
// Колонки в каталозі немає зовсім — показуються всі книги, як до її появи
const PUBLISH_COL = 'Публікація';
// галочка (TRUE); вписане руками «так», «+», «1» — теж так; порожньо, FALSE, інше — ні
const publishedOn_ = v => v === true || /^(true|так|1|\+|✓|✔)$/i.test(String(v).trim());

// Галочки в колонці «Публікація» (col — номер з 1) для всіх рядків каталогу.
// У таблиці Google з типами колонок галочки дає тип колонки — тоді пропускаємо
function publishCheckboxes_(sheet, col) {
  sheet.getRange(2, col, Math.max(sheet.getMaxRows() - 1, 1), 1).insertCheckboxes();
}

// Нова колонка «Публікація»: галочка в кожного рядка з назвою, у решти — порожньо.
// Поки колонки не було, на сайті були всі книги, тож з її появою нічого не зникає;
// зняти галочку з книги, якої не треба показувати, — вручну. titleCol — номер колонки «Назва» з 1
function publishFillAll_(sheet, col, titleCol) {
  const rows = sheet.getLastRow() - 1;
  if (rows < 1 || titleCol < 1) return;
  const titles = sheet.getRange(2, titleCol, rows, 1).getValues();
  sheet.getRange(2, col, rows, 1).setValues(titles.map(([t]) => [Boolean(String(t).trim())]));
}

// Новий заголовок оформлюємо як перший (колір тексту, заливка, шрифт): вставлена колонка бере формат сусідньої,
// і в аркуші з кольоровою шапкою заголовок виходив білим на білому — невидимим.
// Клітинки під заголовком — з кольором тексту за замовчуванням, з тієї ж причини
function columnLook_(sheet, col) {
  if (col === 1) return;
  sheet.getRange(1, 1).copyFormatToRange(sheet, col, col, 1, 1);
  sheet.getRange(2, col, Math.max(sheet.getMaxRows() - 1, 1), 1).setFontColor(null);
}

// Запустіть вручну один раз (і щоразу, коли додали рядки в каталог за межами випадних списків).
// У таблиці з книгами:
//  - створює аркуш «Категорії» з випадним списком батьківської категорії;
//  - створює аркуш «Добірки» (назва, опис, номери книг, адреса сторінки);
//  - перейменовує стару «Обкладинка» на «Палітурка» (RENAMED_COLS);
//  - додає в кінець каталогу колонки, яких ще немає: «Категорія», «Стан», «Палітурка», «Мова», «Передзамовлення»,
//    «Публікація», «Видавництво», «Акційна ціна», «ISBN»;
//  - ставить випадні списки: категорія — лише з аркуша «Категорії», стан, палітурка, мова, передзамовлення — з FIELD_OPTIONS;
//  - у «Публікації» — галочки; у новій колонці вони одразу відмічені в усіх книг (publishFillAll_).
// Аркуш, перетворений на таблицю Google (Формат → Перетворити на таблицю), не дає міняти списки й формат у колонках
// з типом — там тип колонки робить те саме. Такі кроки пропускаються (список — у журналі виконання), решта виконується
function setupCatalog() {
  const ss = catalog_();
  const skipped = [];
  // Таблиця збирає зміни й застосовує їх пачкою аж у кінці запуску — тоді помилка вилетіла б уже після «Готово»
  // і без пояснення. Тому кожен такий крок застосовуємо одразу (flush): спершу все, що було до нього
  // (помилка там — справжня, її не ховаємо), потім сам крок — його помилку записуємо й ідемо далі
  const format = (what, fn) => {
    SpreadsheetApp.flush();
    try {
      fn();
      SpreadsheetApp.flush();
    } catch (err) {
      skipped.push(`${what}: ${err.message}`);
    }
  };
  let sheet = ss.getSheetByName(CATEGORIES_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(CATEGORIES_SHEET, ss.getSheets().length);
    sheet.getRange(1, 1, 1, 2).setValues([['Категорія', 'Батьківська']]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    sheet.setColumnWidths(1, 2, 280);
  }
  const list = SpreadsheetApp.newDataValidation()
    .requireValueInRange(sheet.getRange('A2:A'), true)
    .setAllowInvalid(false)
    .setHelpText('Виберіть категорію з аркуша «Категорії»')
    .build();
  format('аркуш «Категорії», список у колонці «Батьківська»', () => sheet.getRange('B2:B').setDataValidation(list));

  if (!ss.getSheetByName(COLLECTIONS_SHEET)) {
    const coll = ss.insertSheet(COLLECTIONS_SHEET, ss.getSheets().length);
    coll.getRange(1, 1, 1, 4).setValues([['Назва', 'Опис', 'Книги', 'Адреса']]).setFontWeight('bold');
    coll.getRange(1, 3).setNote('Номери книг з колонки «№» через кому, у тому порядку, в якому їх показувати: 15, 42, 7');
    coll.getRange(1, 4).setNote('Необов\'язково. Адреса сторінки /dobirka/<адреса>/ латиницею; порожньо — складається з назви. ' +
      'Якщо вже поширили посилання на добірку, а потім змінили назву, впишіть сюди стару адресу — посилання не зламається');
    coll.setFrozenRows(1);
    coll.setColumnWidth(1, 260);
    coll.setColumnWidth(2, 380);
    coll.setColumnWidth(3, 220);
    coll.setColumnWidth(4, 200);
    coll.getRange('B2:B').setWrap(true);
  }
  // номери — як текст: інакше «15,42» таблиця вважає дробовим числом
  format('аркуш «Добірки», колонка «Книги» як текст', () => ss.getSheetByName(COLLECTIONS_SHEET).getRange('C2:C').setNumberFormat('@'));

  const books = catalogSheet_(ss);
  const rawHead = books.getRange(1, 1, 1, books.getLastColumn()).getValues()[0].map(h => String(h).trim());
  const head = catalogHead_(rawHead);
  // старі назви колонок → нові, просто в заголовку (якщо нової колонки ще немає — інакше було б дві однакові)
  rawHead.forEach((h, i) => {
    if (RENAMED_COLS[h] && rawHead.indexOf(RENAMED_COLS[h]) < 0) {
      format(`каталог, перейменування «${h}» на «${RENAMED_COLS[h]}»`, () => books.getRange(1, i + 1).setValue(RENAMED_COLS[h]));
    }
  });
  const rows = Math.max(books.getMaxRows() - 1, 1);
  // номер колонки за заголовком; немає — дописуємо її в кінець
  const column = name => {
    let col = head.indexOf(name) + 1;
    if (!col) {
      head.push(name);
      col = head.length;
      // аркуш, збережений з xlsx, має рівно стільки колонок, скільки було даних: за його межами
      // getRange падає з помилкою, і решта колонок не додається — тож спершу розширюємо аркуш
      if (col > books.getMaxColumns()) books.insertColumnsAfter(books.getMaxColumns(), col - books.getMaxColumns());
      books.getRange(1, col).setValue(name);
    }
    // і нові, і вже додані раніше: колонки, створені до виправлення, теж стають видимими.
    // У таблиці Google заголовки оформлює вона сама — формат там може бути заборонений
    format(`каталог, вигляд колонки «${name}»`, () => columnLook_(books, col));
    format(`каталог, жирний заголовок «${name}»`, () => books.getRange(1, col).setFontWeight('bold'));
    return col;
  };

  const categoryCol = column('Категорія');
  format('каталог, список у колонці «Категорія»', () => books.getRange(2, categoryCol, rows, 1).setDataValidation(list));
  Object.keys(FIELD_OPTIONS).forEach(name => {
    const col = column(name);
    format(`каталог, список у колонці «${name}»`, () => books.getRange(2, col, rows, 1).setDataValidation(SpreadsheetApp.newDataValidation()
      .requireValueInList(FIELD_OPTIONS[name], true)
      .setAllowInvalid(STRICT_FIELDS.indexOf(name) < 0)
      .build()));
  });
  const publishIsNew = head.indexOf(PUBLISH_COL) < 0;
  const publishCol = column(PUBLISH_COL);
  format(`каталог, галочки в колонці «${PUBLISH_COL}»`, () => publishCheckboxes_(books, publishCol));
  if (publishIsNew) {
    format(`каталог, відмітки в новій колонці «${PUBLISH_COL}»`,
      () => publishFillAll_(books, publishCol, head.indexOf('Назва') + 1));
  }
  column('Видавництво');
  column('Акційна ціна');
  // ISBN — як текст: інакше таблиця вважає його числом і з'їдає нуль на початку ISBN-10
  const isbnCol = column('ISBN');
  format('каталог, колонка «ISBN» як текст', () => books.getRange(2, isbnCol, rows, 1).setNumberFormat('@'));
  // решта змін — до звіту, щоб «Готово» означало, що справді все записано
  SpreadsheetApp.flush();

  if (skipped.length) {
    console.warn('Пропущено (аркуш — таблиця Google з типами колонок; задайте тип колонки в самій таблиці):\n- ' +
      skipped.join('\n- '));
  } else {
    console.log('Готово');
  }
}

// Номер книги → ID файлів фото по порядку (перше — обкладинка). Обхід папки повільний,
// тому список кешується на 10 хвилин: нове фото з'являється на сайті не одразу
function photos_() {
  const folder = photosFolder_();
  if (!folder) return {};
  const cached = cacheGet_('photos');
  if (cached) return JSON.parse(cached);

  const found = {}; // номер книги → { порядковий номер фото → { file, date } }
  try {
    const files = DriveApp.getFolderById(folder).getFiles();
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
      const stock = Math.max(0, book.stock);
      // понад наявність — лише під передзамовлення
      if (qty > stock && !book.preorder) {
        problems.push(stock ? `«${book.title}»: доступно лише ${stock} шт.` : `«${book.title}» уже продано.`);
        return;
      }
      lines.push({ book, qty, sum: book.price * qty, pre: Math.max(0, qty - stock) });
    });

    if (problems.length) return json_({ ok: false, error: problems.join('\n') });
    if (!lines.length) return json_({ ok: false, error: 'Кошик порожній.' });

    // те саме замовлення вже записане щойно — відповідаємо так само, як тоді, і нічого не дублюємо
    const repeatKey = repeatKey_(customer.phone, lines);
    const earlier = CacheService.getScriptCache().get(repeatKey);
    if (earlier) return json_(Object.assign({ ok: true }, JSON.parse(earlier)));

    const total = lines.reduce((s, l) => s + l.sum, 0);
    const now = new Date();
    const orderId = nextOrderId_(now);

    const pcs = lines.reduce((s, l) => s + l.qty, 0);
    const summary = lines
      .map(l => `№${l.book.id} ${l.book.author ? l.book.author + ', ' : ''}«${l.book.title}» × ${l.qty} — ${l.sum} грн` +
        (l.pre ? ` (передзамовлення: ${l.pre} шт.)` : ''))
      .join('\n');
    const preorders = lines.reduce((s, l) => s + l.pre, 0);

    appendRows_(itemsSheet_(), lines.map(l => [
      now, orderId, l.book.id, text_(l.book.author), text_(l.book.title), l.book.price, l.qty, l.sum, l.pre || '',
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
      preorders ? `⏳ Є передзамовлення: ${preorders} шт.` : null,
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

    try {
      CacheService.getScriptCache().put(repeatKey, JSON.stringify({ orderId, total }), DUPLICATE_WINDOW_SECONDS);
    } catch (err) { console.error(err); } // кеш недоступний — замовлення однаково записане
    return json_({ ok: true, orderId, total });
  } catch (err) {
    console.error(err);
    return json_({ ok: false, error: 'Помилка на сервері. Спробуйте ще раз.' });
  } finally {
    lock.releaseLock();
  }
}

// Номер замовлення: дата і порядковий номер за цей день — 261105-03. Лічильник у Властивостях скрипта
// (ORDER_SEQ = «261105:3»), а не за рядками аркуша: видалений рядок не звільняє номер, номери не повторюються.
// Викликати лише під блокуванням (doPost), інакше два замовлення можуть отримати один номер
const ORDER_SEQ_PROP = 'ORDER_SEQ';

function nextOrderId_(now) {
  const day = Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyMMdd');
  const props = PropertiesService.getScriptProperties();
  const [lastDay, lastN] = String(props.getProperty(ORDER_SEQ_PROP) || '').split(':');
  const n = lastDay === day ? (Number(lastN) || 0) + 1 : 1;
  props.setProperty(ORDER_SEQ_PROP, `${day}:${n}`);
  return `${day}-${String(n).padStart(2, '0')}`;
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
  const values = catalogSheet_(catalog_()).getDataRange().getValues();
  const head = catalogHead_(values[0]);
  const col = name => head.indexOf(name);
  const c = {
    id: col('№'), author: col('Автор'), title: col('Назва'), year: col('Рік'),
    pages: col('Сторінки'), price: col('Ціна'), stock: col('К-сть'),
    // необов'язкова: ціна під час акції. Менша за «Ціну» — книга продається за нею і на сайті позначається
    // як акційна; очистили клітинку — акція закінчилась
    salePrice: col('Акційна ціна'),
    // необов'язкова колонка; якщо її немає — книги без опису
    description: col('Опис'),
  };
  // необов'язкові колонки: назва в таблиці → поле книги. Порожні не передаємо — каталог і так великий
  const optional = {
    category: col('Категорія'), // одна категорія будь-якого рівня з аркуша «Категорії»
    condition: col('Стан'),
    binding: col(BINDING_COL),
    language: col('Мова'),
    publisher: col('Видавництво'),
    // ISBN з книги (10 чи 13 цифр, дефіси не заважають) — потрібен Google Покупкам; у старих книг його може не бути
    isbn: col('ISBN'),
  };
  const preorder = col('Передзамовлення');
  const publish = col(PUBLISH_COL);

  return values.slice(1)
    .filter(r => String(r[c.title]).trim())
    // без галочки «Публікація» книги немає ні на сайті, ні в замовленнях (немає колонки — показуємо всі)
    .filter(r => publish < 0 || publishedOn_(r[publish]))
    .map(r => {
      const book = {
        id: String(r[c.id]).trim(),
        author: String(r[c.author]).trim(),
        title: String(r[c.title]).trim(),
        year: String(r[c.year]).trim(),
        pages: String(r[c.pages]).trim(),
        price: Number(r[c.price]) || 0,
        stock: Number(r[c.stock]) || 0,
      };
      // порожній опис не передаємо — каталог і так великий
      const description = c.description < 0 ? '' : String(r[c.description]).trim();
      if (description) book.description = description;
      // акційна ціна стає ціною продажу (за нею рахуються й замовлення), звичайна йде в oldPrice —
      // сайт показує її перекресленою. Не менша за звичайну, нуль чи текст — не знижка, ігнорується
      const salePrice = c.salePrice < 0 ? 0 : Number(r[c.salePrice]) || 0;
      if (salePrice > 0 && salePrice < book.price) {
        book.oldPrice = book.price;
        book.price = salePrice;
      }
      Object.keys(optional).forEach(key => {
        const value = optional[key] < 0 ? '' : String(r[optional[key]]).trim();
        if (value) book[key] = value;
      });
      if (preorder >= 0 && preorderOn_(r[preorder])) book.preorder = true;
      return book;
    })
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
  const sheet = ss.getSheetByName(ITEMS_SHEET);
  if (!sheet) return createSheet_(ss, ITEMS_SHEET, ITEM_HEADERS);
  // аркуш, створений до появи передзамовлень: дописуємо заголовок нової колонки, старі рядки не чіпаємо
  const col = ITEM_HEADERS.length;
  if (String(sheet.getRange(1, col).getValue()).trim() !== ITEM_HEADERS[col - 1]) {
    if (col > sheet.getMaxColumns()) sheet.insertColumnsAfter(sheet.getMaxColumns(), col - sheet.getMaxColumns());
    sheet.getRange(1, col).setValue(ITEM_HEADERS[col - 1]).setFontWeight('bold');
  }
  return sheet;
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
    case 'meest': return `${v('city')}, відділення/поштомат № ${v('branch').replace(/^№\s*/, '')}`;
    default: return '';
  }
}

// Ключ «того самого замовлення»: останні 9 цифр телефону (067… і +38067… — один номер) і книги з кількістю.
// Хеш — бо ключ кешу Apps Script не довший за 250 знаків
function repeatKey_(phone, lines) {
  const digits = str_(phone).replace(/\D/g, '').slice(-9);
  const items = lines.map(l => `${l.book.id}x${l.qty}`).sort().join(',');
  const hash = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, digits + '|' + items, Utilities.Charset.UTF_8);
  return 'order:' + Utilities.base64EncodeWebSafe(hash);
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

// ───────────────────────── Форма «Книга» ─────────────────────────
// Вікно для додавання й редагування книг замість ручного заповнення таблиці: меню «Каталог» у таблиці
// замовлень. Сама форма — файл BookForm.html у цьому ж проєкті. Сайту ця частина не потрібна,
// тож після її змін нова версія розгортання не обов'язкова.

// Поле форми → заголовок колонки каталогу
const FORM_FIELDS = {
  id: '№', title: 'Назва', author: 'Автор', year: 'Рік', pages: 'Сторінки',
  price: 'Ціна', salePrice: 'Акційна ціна', stock: 'К-сть',
  category: 'Категорія', condition: 'Стан', binding: BINDING_COL, language: 'Мова',
  publisher: 'Видавництво', isbn: 'ISBN', description: 'Опис', preorder: 'Передзамовлення',
  publish: PUBLISH_COL, // 'true' / 'false'; у таблиці — галочка
};
const FORM_NUMBERS = ['year', 'pages', 'price', 'salePrice', 'stock'];

// Простий тригер: додає меню щоразу, коли відкривають таблицю замовлень
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Каталог')
    .addItem('Додати / змінити книгу', 'showBookForm')
    .addToUi();
}

function showBookForm() {
  const html = HtmlService.createHtmlOutputFromFile('BookForm').setWidth(780).setHeight(720);
  // немодальне — таблицю поруч можна гортати
  SpreadsheetApp.getUi().showModelessDialog(html, 'Книга');
}

// Каталог для форми: заголовки, рядки і номер колонки за назвою
function formSheet_() {
  const sheet = catalogSheet_(catalog_());
  const values = sheet.getDataRange().getValues();
  const head = catalogHead_(values[0]);
  return { sheet, values, head, col: name => head.indexOf(name) };
}

// Найбільший № книги, який будь-коли видавався, — у Властивостях скрипта. Без нього після видалення
// останньої книги її № дістався б новій, і старі замовлення, фото та посилання /book/<№>/ вказували б не на ту книгу
const LAST_BOOK_ID_PROP = 'LAST_BOOK_ID';

// Наступний вільний №: більший і за всі номери в каталозі, і за всі колись видані
function formNextId_(values, idCol) {
  const issued = Number(PropertiesService.getScriptProperties().getProperty(LAST_BOOK_ID_PROP)) || 0;
  return values.slice(1).reduce((max, r) => {
    const s = String(r[idCol]).trim();
    return /^\d+$/.test(s) ? Math.max(max, Number(s)) : max;
  }, issued) + 1;
}

// Запам'ятовує № нової книги як виданий (лише числовий і лише якщо більший за попередній)
function rememberBookId_(id) {
  if (!/^\d+$/.test(id)) return;
  const props = PropertiesService.getScriptProperties();
  if (Number(id) > (Number(props.getProperty(LAST_BOOK_ID_PROP)) || 0)) props.setProperty(LAST_BOOK_ID_PROP, id);
}

// Різні непорожні значення колонки, за алфавітом
function formDistinct_(values, col) {
  if (col < 0) return [];
  const seen = {};
  values.slice(1).forEach(r => {
    const v = String(r[col]).trim();
    if (v) seen[v] = true;
  });
  return Object.keys(seen).sort((a, b) => a.localeCompare(b, 'uk'));
}

// Усе, що потрібно формі при відкритті: книги для пошуку й перевірки дублів, списки, наступний №
function formInit() {
  const { values, col } = formSheet_();
  const id = col('№'), title = col('Назва'), author = col('Автор'), stock = col('К-сть');
  const books = values.slice(1)
    .filter(r => String(r[title]).trim())
    .map(r => [String(r[id]).trim(), author < 0 ? '' : String(r[author]).trim(), String(r[title]).trim(),
      stock < 0 ? '' : String(r[stock]).trim()]);
  const merge = (name) => {
    const extra = formDistinct_(values, col(name))
      .filter(v => !FIELD_OPTIONS[name].some(o => o.toLowerCase() === v.toLowerCase()));
    return FIELD_OPTIONS[name].concat(extra);
  };
  const nextId = formNextId_(values, id);
  // номери, вписані в таблицю вручну, теж вважаються виданими — щоб не повторились після видалення
  rememberBookId_(String(nextId - 1));
  return {
    books,
    nextId,
    categories: readCategories_(),
    conditions: FIELD_OPTIONS['Стан'],
    bindings: merge(BINDING_COL),
    languages: merge('Мова'),
    authors: formDistinct_(values, author),
    publishers: formDistinct_(values, col('Видавництво')),
    photos: Boolean(photosFolder_()),
  };
}

// Книга з таблиці як є (без перерахунку акцій тощо) — для редагування
function formGetBook(id) {
  const { values, col } = formSheet_();
  const row = formFindRow_(values, col('№'), id);
  if (row < 0) throw new Error(`Книги №${id} немає в каталозі`);
  const book = {};
  Object.keys(FORM_FIELDS).forEach(key => {
    const c = col(FORM_FIELDS[key]);
    book[key] = c < 0 ? '' : String(values[row][c]).trim();
  });
  // немає колонки — книга на сайті, як і всі
  const pub = col(PUBLISH_COL);
  book.publish = pub < 0 || publishedOn_(values[row][pub]) ? 'true' : 'false';
  book.photoCount = formPhotoNumbers_(book.id).length;
  return book;
}

// Індекс рядка в values (0 — заголовки) або -1
function formFindRow_(values, idCol, id) {
  const key = String(id).trim().toLowerCase();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][idCol]).trim().toLowerCase() === key) return i;
  }
  return -1;
}

// Ті самі перевірки, що й у формі: браузеру не довіряємо. Повертає текст помилок або ''
function formValidate_(b, categories) {
  const errors = [];
  const num = v => (v === '' ? null : Number(v));
  if (!b.title) errors.push('Вкажіть назву.');
  if (b.id && !/^[\p{L}\p{N}_-]+$/u.test(b.id)) errors.push('№: лише літери, цифри, дефіс.');
  const price = num(b.price);
  if (!(price > 0)) errors.push('Ціна — число більше 0.');
  const stock = num(b.stock);
  if (stock === null || !Number.isInteger(stock) || stock < 0) errors.push('К-сть — ціле число від 0.');
  const sale = num(b.salePrice);
  if (sale !== null && !(sale > 0 && sale < price)) errors.push('Акційна ціна має бути менша за ціну (або порожньо).');
  ['year', 'pages'].forEach(k => {
    if (b[k] && !/^\d+$/.test(b[k])) errors.push(`${FORM_FIELDS[k]} — лише цифри.`);
  });
  if (b.condition && FIELD_OPTIONS['Стан'].indexOf(b.condition) < 0) errors.push('Стан — зі списку.');
  if (b.preorder && FIELD_OPTIONS['Передзамовлення'].indexOf(b.preorder) < 0) errors.push('Передзамовлення — зі списку.');
  if (b.category && categories.length && !categories.some(c => c.name === b.category)) {
    errors.push(`Категорії «${b.category}» немає на аркуші «${CATEGORIES_SHEET}».`);
  }
  return errors.join('\n');
}

// Зберігає книгу. isNew — новий рядок (№ не повинен повторюватись), інакше змінює рядок з цим №.
// У наявному рядку пишемо лише змінені клітинки — решту колонок і формули не чіпаємо
function formSaveBook(input, isNew) {
  const b = {};
  Object.keys(FORM_FIELDS).forEach(k => { b[k] = String(input[k] == null ? '' : input[k]).trim(); });
  b.publish = publishedOn_(b.publish) ? 'true' : 'false';
  const error = formValidate_(b, readCategories_());
  if (error) throw new Error(error);

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const { sheet, values, head, col } = formSheet_();
    const idCol = col('№');
    if (idCol < 0) throw new Error('У каталозі немає колонки «№».');
    let rowIndex;
    if (isNew) {
      // № нової книги завжди ставимо тут, а не беремо з форми: форма лише показує очікуваний. Якщо тим часом
      // хтось додав книгу в таблицю, ця отримає наступний — без помилки й без повтору номера видаленої книги
      b.id = String(formNextId_(values, idCol));
      rememberBookId_(b.id);
      rowIndex = sheet.getLastRow(); // наступний після останнього заповненого (values рахує з 0)
    } else {
      rowIndex = formFindRow_(values, idCol, b.id);
      if (rowIndex < 0) throw new Error(`Книги №${b.id} немає в каталозі — можливо, її видалили.`);
    }
    const old = values[rowIndex] || [];
    const row = rowIndex + 1;

    Object.keys(FORM_FIELDS).forEach(key => {
      const name = FORM_FIELDS[key];
      const v = b[key];
      let c = col(name);
      if (c < 0) {
        if (!v) return;
        c = formAddColumn_(sheet, head, name);
        // нова колонка «Публікація» — галочки в усіх рядках, відмічені в усіх книг; цій книзі — як у формі (нижче)
        if (key === 'publish') {
          try { publishCheckboxes_(sheet, c + 1); } catch (err) { console.warn(err.message); }
          try { publishFillAll_(sheet, c + 1, col('Назва') + 1); } catch (err) { console.warn(err.message); }
          // щойно відмічене — у old, щоб рядок цієї книги порівнювався з тим, що тепер у таблиці
          old[c] = sheet.getRange(row, c + 1).getValue();
        }
      }
      if (String(old[c] == null ? '' : old[c]).trim() === v) return;
      const cell = sheet.getRange(row, c + 1);
      if (key === 'publish') {
        cell.setValue(v === 'true');
      } else if (key === 'isbn') {
        // текстом: інакше таблиця з'їсть нуль на початку ISBN-10
        cell.setNumberFormat('@').setValue(v);
      } else if (v && (FORM_NUMBERS.indexOf(key) >= 0 || (key === 'id' && /^\d+$/.test(v)))) {
        cell.setValue(Number(v));
      } else {
        cell.setValue(/^[=+\-@]/.test(v) ? "'" + v : v);
      }
    });
    SpreadsheetApp.flush();
    return { id: b.id, row };
  } finally {
    lock.releaseLock();
  }
}

// Дописує колонку в кінець каталогу; повертає її індекс (з 0)
function formAddColumn_(sheet, head, name) {
  head.push(name);
  const col = head.length;
  if (col > sheet.getMaxColumns()) sheet.insertColumnsAfter(sheet.getMaxColumns(), col - sheet.getMaxColumns());
  sheet.getRange(1, col).setValue(name);
  // у таблиці Google з типами колонок формат шапки може бути заборонений — тоді лишаємо як є
  try { columnLook_(sheet, col); } catch (err) { console.warn(err.message); }
  try { sheet.getRange(1, col).setFontWeight('bold'); } catch (err) { console.warn(err.message); }
  return col - 1;
}

// Порядкові номери наявних фото книги: 15.jpg → 1, 15-3.jpg → 3
function formPhotoNumbers_(id) {
  const folder = photosFolder_();
  if (!folder || !id) return [];
  const key = String(id).toLowerCase();
  const numbers = [];
  // пошук Диска за початком назви; точний збіг перевіряємо самі (щоб 150.jpg не зарахувався книзі 15)
  const files = DriveApp.getFolderById(folder).searchFiles(`title contains '${String(id).replace(/'/g, '')}'`);
  while (files.hasNext()) {
    const f = files.next();
    if (f.isTrashed() || !f.getMimeType().startsWith('image/')) continue;
    const name = f.getName().replace(/\.[^.]*$/, '').trim().toLowerCase();
    const m = name.match(/^(.+?)\s*-\s*(\d+)$/);
    if ((m ? m[1] : name) === key) numbers.push(m ? Number(m[2]) : 1);
  }
  return numbers;
}

// Додає фото книги в папку з наступним вільним номером (перше — 15.jpg, далі 15-2.jpg…).
// base64 — JPEG, уже зменшений у браузері
function formAddPhoto(id, base64) {
  const folder = photosFolder_();
  if (!folder) throw new Error('Папка з фото не налаштована: додайте PHOTOS_FOLDER у Властивості скрипта.');
  if (!/^[\p{L}\p{N}_-]+$/u.test(String(id))) throw new Error('Неправильний № книги.');
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const n = formPhotoNumbers_(id).reduce((max, x) => Math.max(max, x), 0) + 1;
    const name = n === 1 ? `${id}.jpg` : `${id}-${n}.jpg`;
    DriveApp.getFolderById(folder)
      .createFile(Utilities.newBlob(Utilities.base64Decode(base64), 'image/jpeg', name));
    // скидаємо кеш списку фото, щоб сайт побачив нове одразу, а не за 10 хвилин
    try { CacheService.getScriptCache().remove('photos'); } catch (err) { console.error(err); }
    return name;
  } finally {
    lock.releaseLock();
  }
}
