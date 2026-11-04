// Каталог: налаштування, стан, завантаження книг, пошук і сортування, показ вітриною чи списком, обкладинки.
// Скрипти підключаються в index.html по черзі й мають спільні змінні: catalog → filters → collections → cart → book → order → app.

// URL веб-застосунку Google Apps Script (див. docs/setup.md, крок 3)
const API_URL = 'https://script.google.com/macros/s/AKfycby2gayZYooqZHYsOsrKM7wTZVsP68SlDtbBXQKCvr8XmuiLiYXL5qBouuTsO5U3UHkc/exec';

const PAGE = 50; // книг на сторінці каталогу (10 повних рядів по 5 на ПК); те саме число — PAGE у scripts/build.mjs
const CART_KEY = 'lib_store_cart';
const BOOKS_KEY = 'lib_store_books';

const $ = id => document.getElementById(id);
const money = n => n.toLocaleString('uk-UA') + ' грн';

let books = [];
let byId = new Map();
let filtered = [];
let pageNo = 1; // поточна сторінка каталогу; з адреси читається в init()
let cart = loadCart();
let sortBy = 'newest';
const VIEW_KEY = 'lib_store_view';
let view = loadView();

function loadView() {
  try { return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid'; } catch { return 'grid'; }
}

function loadCart() {
  try { return JSON.parse(localStorage.getItem(CART_KEY)) || {}; } catch { return {}; }
}
function saveCart() {
  try { localStorage.setItem(CART_KEY, JSON.stringify(cart)); } catch {}
}

function showState(text, isError) {
  $('state').hidden = !text;
  $('state').textContent = text;
  $('state').classList.toggle('error', !!isError);
}

function renderSkeleton() {
  const row = `<li class="row skeleton"><div class="cover"></div><div class="info">
    <div class="line" style="width:60%;height:16px"></div><div class="line" style="width:30%"></div></div>
    <div class="line" style="width:70px;height:16px;justify-self:end"></div><div></div></li>`;
  $('list').innerHTML = row.repeat(10);
}

async function init() {
  if (!API_URL) {
    showState('Сайт ще не налаштовано: вкажіть API_URL в index.html.', true);
    return;
  }
  if (onCatalogPath()) pageNo = pageFromPath();
  // спочатку показуємо збережений каталог, поки Google віддає свіжий
  // збережений каталог без добірок (з часів до них) на сторінці добірки нічого не покаже — чекаємо свіжий
  let cached = loadCachedBooks();
  if (cached && !cached.collections && COLL_PATH.test(location.pathname)) cached = null;
  if (cached) setBooks(cached, false);
  // на опублікованому сайті перші книги вже вписані в HTML (scripts/build.mjs) — заглушки не потрібні
  else if (!$('list').children.length) renderSkeleton();

  try {
    const res = await fetch(API_URL);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    const catalog = { books: data.books, categories: data.categories || [], collections: data.collections || [] };
    try { localStorage.setItem(BOOKS_KEY, JSON.stringify(catalog)); } catch {}
    setBooks(catalog, !!cached);
  } catch (err) {
    console.error(err);
    if (cached) return;
    // книги, вписані в HTML, лишаємо: їхні сторінки відкриваються й без каталогу
    if ($('list').querySelector('.row:not(.skeleton)')) {
      showState('Не вдалося завантажити весь каталог — показано лише нові надходження. Спробуйте оновити сторінку.', true);
      return;
    }
    $('list').textContent = '';
    showState('Не вдалося завантажити каталог. Спробуйте оновити сторінку.', true);
  }
}

function loadCachedBooks() {
  try {
    const saved = JSON.parse(localStorage.getItem(BOOKS_KEY));
    // раніше зберігався лише масив книг
    if (Array.isArray(saved)) return { books: saved, categories: [] };
    return saved?.books ? saved : null;
  } catch { return null; }
}

// ---------- Сторінки каталогу: /, /storinka/2/, /storinka/3/…, добірки /dobirka/<адреса>/ ----------
// Збирач робить такі сторінки й статично (scripts/build.mjs) — для Google і без JavaScript;
// тут перемикаємо їх без перезавантаження. Кнопка «Назад» повертає на попередню сторінку
const PAGE_PATH = /^\/storinka\/(\d+)\/?$/;
function pageFromPath() {
  const m = location.pathname.match(PAGE_PATH);
  return m ? Math.max(1, Number(m[1])) : 1;
}
const pagePath = n => n > 1 ? `/storinka/${n}/` : '/';
// адресу міняємо лише на сторінках каталогу: на сторінці книги чи 404 вона своя
const onCatalogPath = () => !document.body.hasAttribute('data-page') &&
  (location.pathname === '/' || location.pathname.endsWith('/index.html') || PAGE_PATH.test(location.pathname) ||
    COLL_PATH.test(location.pathname));

// Адреса = сторінка каталогу чи добірка + вибрана категорія; відкрита картка книги (#book-…) лишається
function syncUrl(push) {
  const hash = location.hash.startsWith('#book-') ? location.hash : catHash();
  const path = onCatalogPath() ? (coll ? collPath(coll) : pagePath(pageNo)) : location.pathname;
  if (path + hash === location.pathname + location.hash) return;
  history[push ? 'pushState' : 'replaceState'](null, '', path + location.search + hash);
}

function goPage(n) {
  pageNo = n;
  render();
  syncUrl(true);
  // до початку каталогу, якщо ми нижче (панель пошуку прилипає згори — лишаємо їй місце)
  const top = $('count').getBoundingClientRect().top + scrollY - 90;
  if (scrollY > top) scrollTo({ top, behavior: 'instant' });
}

addEventListener('popstate', () => {
  if (!onCatalogPath() || !books.length) return;
  pageNo = pageFromPath();
  if (collFromPath() !== coll) {
    setColl(collFromPath());
    applyFilter(true);
  } else render();
});

// Номери в перемикачі: перша, остання і сусіди поточної; проміжки — «…»
function pagerItems(cur, pages) {
  const keep = new Set([1, pages, cur - 1, cur, cur + 1]);
  const out = [];
  for (let n = 1; n <= pages; n++) {
    if (keep.has(n)) out.push(n);
    else if (out.at(-1) !== '…') out.push('…');
  }
  return out;
}

// Розмітку перемикача повторює збирач (pagerHtml у scripts/build.mjs) — міняєте тут, міняйте й там
function renderPager(pages) {
  const nav = $('pager');
  nav.textContent = '';
  nav.hidden = pages < 2;
  if (pages < 2) return;
  const link = (n, cls, content, label) => {
    const a = el('a', cls);
    a.href = pagePath(n);
    a.append(...content);
    if (label) a.setAttribute('aria-label', label);
    a.onclick = e => { e.preventDefault(); goPage(n); };
    return a;
  };
  const step = (n, dir) => {
    const parts = dir < 0
      ? [arrow(dir), el('span', 'label', 'Попередня')]
      : [el('span', 'label', 'Наступна'), arrow(dir)];
    if (n < 1 || n > pages) {
      const off = el('span', 'step');
      off.setAttribute('aria-disabled', 'true');
      off.append(...parts);
      return off;
    }
    return link(n, 'step', parts, dir < 0 ? 'Попередня сторінка' : 'Наступна сторінка');
  };
  nav.append(step(pageNo - 1, -1));
  for (const n of pagerItems(pageNo, pages)) {
    if (n === '…') nav.append(el('span', 'gap', '…'));
    else if (n === pageNo) {
      const cur = el('span', 'num', String(n));
      cur.setAttribute('aria-current', 'page');
      nav.append(cur);
    } else nav.append(link(n, 'num', [String(n)], `Сторінка ${n}`));
  }
  nav.append(step(pageNo + 1, 1));
}
function arrow(dir) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('width', '16'); s.setAttribute('height', '16'); s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = `<path d="${dir < 0 ? 'm15 6-6 6 6 6' : 'm9 6 6 6-6 6'}" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`;
  return s;
}

function setBooks(catalog, keepPage) {
  books = catalog.books;
  byId = new Map(books.map(b => [b.id, b]));
  buildCategories(catalog.categories);
  buildCollections(catalog.collections);
  // добірка з адреси; якої вже немає (прибрали з аркуша, усе продано) — показуємо всі книги й міняємо адресу
  const wantColl = onCatalogPath() ? collFromPath() : '';
  setColl(wantColl);
  readHashCategory();
  // категорія з посилання чи з минулого показу могла спорожніти — тоді показуємо всі книги
  const anyCategory = [...cats.values()].some(hasBooks);
  if (!anyCategory || (cat === NONE ? !uncategorized : cat && !cats.get(cat)?.count)) cat = '';
  // прибрати з кошика те, чого вже немає або менше в наявності (крім передзамовлення — там без обмеження)
  for (const id of Object.keys(cart)) {
    const b = byId.get(id);
    if (!b) delete cart[id];
    else cart[id] = Math.min(cart[id], maxQty(b));
  }
  saveCart();
  pruneFilters();
  // перше завантаження — сторінка з адреси; свіжий каталог після збереженого — та сама сторінка
  applyFilter(true);
  if (!keepPage || wantColl !== coll) syncUrl(false);
  updateCartBar();
  drawPageBook();
  openFromHash();
}

const searchWords = () => $('search').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
function matchesSearch(b, words) {
  const hay = [b.title, b.author, b.publisher].filter(Boolean).join(' ').toLowerCase();
  return words.every(w => hay.includes(w));
}

// keepPage — лишити поточну сторінку (нові дані); інакше (змінили пошук, фільтр, сортування) — перша сторінка
function applyFilter(keepPage) {
  const words = searchWords();
  filtered = books.filter(b => inCollection(b) && inCategory(b) && passFilters(b) && matchesSearch(b, words));
  const collator = new Intl.Collator('uk');
  const sorters = {
    // як розставили в аркуші «Добірки»
    'collection': (a, b) => collectionRank(a) - collectionRank(b),
    // більший № у таблиці — пізніше додана книга
    'newest': (a, b) => (Number(b.id) || 0) - (Number(a.id) || 0),
    'title': (a, b) => collator.compare(a.title, b.title),
    'author': (a, b) => collator.compare(a.author || '￿', b.author || '￿'),
    'price-asc': (a, b) => a.price - b.price,
    'price-desc': (a, b) => b.price - a.price,
    'year-desc': (a, b) => (Number(b.year) || 0) - (Number(a.year) || 0),
  };
  filtered.sort(sorters[sortBy]);
  if (!keepPage) pageNo = 1;
  render();
  renderFilters();
  if (!keepPage) syncUrl(false);
}

function render() {
  // добірка — уся на одній сторінці: їх складають невеликими
  const per = coll ? Infinity : PAGE;
  const pages = coll ? 1 : Math.max(1, Math.ceil(filtered.length / PAGE));
  // сторінки, якої вже немає (книги продали, звузили фільтр), — показуємо останню
  if (pageNo > pages) { pageNo = pages; syncUrl(false); }
  const list = $('list');
  list.textContent = '';
  const frag = document.createDocumentFragment();
  for (const b of filtered.slice((pageNo - 1) * per, pageNo * per)) frag.append(bookRow(b));
  list.append(frag);
  renderPager(pages);
  renderIntro();
  renderShelves();

  $('count').textContent = `${filtered.length} ${plural(filtered.length, 'книга', 'книги', 'книг')}`;
  showState(filtered.length ? '' : coll
    ? 'У цій добірці нічого не знайдено. Спробуйте інший запит або приберіть фільтри.'
    : cat
    ? 'У цій категорії нічого не знайдено. Спробуйте інший запит або виберіть «Усі книги».'
    : 'Нічого не знайдено. Спробуйте інший запит.');
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// Розмітку картки для вітрини повторює збирач (staticRow у scripts/build.mjs) — міняєте тут, міняйте й там.
// grid — картка вітрини з обкладинкою (типово — як вибрано для каталогу; на полицях добірок — завжди)
function bookRow(b, grid = view === 'grid') {
  const li = el('li', 'row');
  li.dataset.id = b.id;

  const info = el('div', 'info');
  const sub = el('div', 'byline');
  if (b.author) sub.append(el('span', 'author', b.author));
  // одне фото вже видно на мініатюрі; підпис лишаємо, лише коли є що гортати
  const photos = b.photos?.length > 1 && b.photos.length + ' фото';
  // стан уживаної книги: у списку — у підписі, на вітрині — позначкою на обкладинці
  const cond = !grid && isUsed(b) && 'стан: ' + b.condition.toLowerCase();
  const meta = [b.year && b.year + ' р.', b.pages && b.pages + ' с.', cond, photos].filter(Boolean).join(' · ');
  if (meta) sub.append((b.author ? ' · ' : '') + meta);
  // позначка на обкладинці схована від читачів екрана разом з обкладинкою — дублюємо її для них
  if (grid && isUsed(b)) sub.append(el('span', 'sr-only', `, стан: ${b.condition}`));
  const title = el('a', 'title', b.title);
  // справжня адреса сторінки книги — за нею Google знаходить книги, а середня кнопка миші відкриває її окремо;
  // звичайний клік відкриває картку тут же, без переходу
  title.href = '/book/' + encodeURIComponent(b.id) + '/';
  title.onclick = e => { e.preventDefault(); openBook(b); };
  info.append(title, sub);

  const priceBox = el('div', 'pricebox');
  priceBox.append(...priceLines(b));

  li.append(bookCover(b, false, grid), info, priceBox, cartControl(b, li));
  li.classList.toggle('in-cart', !!cart[b.id]);
  return li;
}

// Знижка у відсотках; 0 — книга не акційна. Скрипт передає price — ціну продажу (акційну, якщо є)
// і oldPrice — звичайну ціну, лише коли акційна справді менша
const discount = b => b.oldPrice > b.price ? Math.round((1 - b.price / b.oldPrice) * 100) : 0;

// Скільки примірників можна покласти в кошик: під передзамовлення — скільки завгодно, інакше — скільки є.
// Саму наявність на сайті не показуємо
const maxQty = b => b.preorder ? Infinity : b.stock;
// Скільки з q піде передзамовленням (понад наявність)
const preorderPart = (b, q) => b.preorder ? Math.max(0, q - Math.max(0, b.stock)) : 0;

// Ціна, під акцію — перекреслена стара зі знижкою над нею
function priceLines(b) {
  const off = discount(b);
  const lines = [];
  if (off) {
    const was = el('div', 'was');
    const old = el('s', null, money(b.oldPrice));
    old.prepend(el('span', 'sr-only', 'Звичайна ціна: '));
    was.append(old, el('span', 'off', `−${off}%`));
    lines.push(was);
  }
  const price = el('div', off ? 'price sale' : 'price', money(b.price));
  if (off) price.prepend(el('span', 'sr-only', 'Ціна зі знижкою: '));
  lines.push(price);
  return lines;
}

// Тканинні палітурки книг без фото: [тканина, тиснення, світла тканина?] і оформлення обкладинки.
// Книга завжди отримує ту саму пару «тканина + оформлення» — за номером
const CLOTHS = [
  ['#232427', '#cfc9b8'], // майже чорна, тиснення кольору старого золота
  ['#34383d', '#e2dfd6'], // графіт
  ['#4b4f55', '#ecebe5'], // сланець
  ['#6e7175', '#f4f3ef'], // попіл
  ['#a3a4a2', '#232427'], // сіра
  ['#d6d2c7', '#2e3034', true], // льон
  ['#e9e7e0', '#34363a', true], // слонова кістка
];
// рамка, паперова наклейка з назвою, тиснені смуги, корінець іншою тканиною («напівпалітурка»)
const LOOKS = ['frame', 'label', 'bands', 'quarter'];
// номери йдуть підряд (15, 16, 17…) — перемішуємо біти, щоб сусідні книги не виходили однаковими
function coverHash(id) {
  let h = [...String(id)].reduce((h, c) => h * 31 + c.charCodeAt(0) >>> 0, 7);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  return (h ^ (h >>> 15)) >>> 0;
}
function clothOf(id) {
  const h = coverHash(id);
  const [cloth, stamp, light] = CLOTHS[h % CLOTHS.length];
  return { cloth, stamp, tone: light ? 'light' : 'dark', look: LOOKS[Math.floor(h / CLOTHS.length) % LOOKS.length] };
}
// Ті самі списки — у scripts/build.mjs (clothCover)

// Тканинна палітурка книги без фото: колір тканини за номером книги, назва й автор тисненням.
// Та сама — на вітрині і великою на лівій сторінці картки книги (js/book.js)
function paintCloth(box, b) {
  const { cloth, stamp, tone, look } = clothOf(b.id);
  box.style.setProperty('--cloth', cloth);
  box.style.setProperty('--stamp', stamp);
  box.dataset.tone = tone;
  box.dataset.look = look;
  box.replaceChildren(
    el('span', 'cover-letter', (b.title || '').trim().charAt(0).toUpperCase()),
    el('span', 'cover-title', b.title),
    el('span', 'cover-author', b.author || ''),
  );
}

// Рамка обкладинки 5:7, як у CSS. Фото, що відрізняється від неї не більше ніж на 12%
// (від 2:3 до 3:4), заповнює рамку повністю — назва й автор на обкладинці при цьому вціліють
const COVER_RATIO = 5 / 7;
const FILL_TOLERANCE = 0.12;

// Перше фото книги як обкладинка; немає фото або воно не відкрилося — тканинна палітурка.
// plain — без позначок стану й знижки (мініатюра в замовленні); grid — велика обкладинка вітрини
function bookCover(b, plain, grid = view === 'grid') {
  const box = el('div', 'cover');
  box.setAttribute('aria-hidden', 'true');
  const badge = () => {
    if (!grid || plain) return;
    if (isUsed(b)) box.append(el('span', 'cond', b.condition));
    if (discount(b)) box.append(el('span', 'ribbon', `−${discount(b)}%`));
  };
  const blank = () => {
    box.className = 'cover blank';
    paintCloth(box, b);
    badge();
  };
  const id = b.photos?.[0];
  if (!id) { blank(); return box; }
  // з запасом на екрани з високою щільністю: 48px у списку, до ~200px на вітрині
  const src = photoUrl(id, grid ? 480 : 150);
  // книга будь-яких пропорцій видна цілою; поля навколо заповнює вона ж, розмита, як скло над фото
  const layer = cls => {
    const img = el('img', cls);
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.src = src;
    return img;
  };
  const front = layer('cover-img');
  front.onerror = blank;
  // розмитий фон лишаємо лише незвичним форматам: альбомним, квадратним, дуже вузьким
  front.onload = () => {
    const fit = front.naturalWidth / front.naturalHeight / COVER_RATIO;
    box.classList.toggle('fill', Math.abs(fit - 1) <= FILL_TOLERANCE);
  };
  box.classList.add('photo');
  box.append(layer('cover-bg'), front);
  badge();
  return box;
}
