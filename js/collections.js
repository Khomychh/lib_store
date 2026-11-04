// Добірки з аркуша «Добірки»: полиці на головній, сторінка добірки /dobirka/<адреса>/ і пункт у меню «Фільтри».
// Вибрана добірка — такий самий фільтр, як категорія, лише з власною адресою, заголовком і порядком книг.
// Сторінки добірок збирач робить і статично (scripts/build.mjs) — для Google, прев'ю в месенджерах і без JavaScript

let collections = []; // [{ name, slug, description, books: ['15', '42'], order: Map(№ → місце) }]
let collBySlug = new Map();
let coll = ''; // адреса вибраної добірки; '' — без добірки

const SHELF_MAX = 12; // книг на полиці головної; решта — на сторінці добірки
const COLL_PATH = /^\/dobirka\/([^/]+)\/?$/;
const collPath = slug => `/dobirka/${encodeURIComponent(slug)}/`;
const collFromPath = () => {
  const m = location.pathname.match(COLL_PATH);
  return m ? decodeURIComponent(m[1]) : '';
};
const curColl = () => collBySlug.get(coll);

// назва вкладки: на сторінці добірки — її назва; повертаючись, — назва головної
// (відкрили одразу сторінку добірки — назви головної не знаємо, тоді просто назва магазину)
const STORE_NAME = document.querySelector('.brand').textContent.trim();
const HOME_TITLE = COLL_PATH.test(location.pathname) ? STORE_NAME : document.title;

// Скрипт уже лишив у добірках лише книги з сайту; тут — ще раз, бо збережений каталог міг застаріти
function buildCollections(list) {
  collections = (list || [])
    .map(c => ({ ...c, books: (c.books || []).filter(id => byId.has(id)) }))
    .filter(c => c.slug && c.books.length);
  for (const c of collections) c.order = new Map(c.books.map((id, i) => [id, i]));
  collBySlug = new Map(collections.map(c => [c.slug, c]));
}

const inCollection = b => !coll || !!curColl()?.order.has(b.id);
const collectionRank = b => curColl()?.order.get(b.id) ?? Infinity;

// Змінити добірку без перемальовування. Невідома (прибрали з аркуша, усе продано) — без добірки.
// У добірці книги типово стоять так, як їх розставили в аркуші; вийшли з неї — знову «Нові надходження»
function setColl(slug) {
  const was = coll;
  coll = collBySlug.has(slug) ? slug : '';
  if (coll && !was && sortBy === 'newest') setSort('collection');
  else if (!coll && sortBy === 'collection') setSort('newest');
  else setSort(sortBy); // пункт «Як у добірці» видно лише в добірці
  const c = curColl();
  document.title = c ? `${c.name} | ${STORE_NAME}` : HOME_TITLE;
}

// Відкрити добірку (чи вийти з неї — '') на місці, без перезавантаження; «Назад» повертає, як було
function selectColl(slug) {
  setColl(slug);
  pageNo = 1;
  applyFilter(true);
  syncUrl(true);
  closeFilters();
  scrollTo({ top: 0, behavior: 'instant' });
}

// ---------- Заголовок добірки над книгами ----------
// Розмітку повторює збирач (collIntroHtml у scripts/build.mjs) — міняєте тут, міняйте й там
function renderIntro() {
  const box = $('collIntro');
  const c = curColl();
  box.hidden = !c;
  if (!c) { box.textContent = ''; return; }
  const back = el('a', 'back glass');
  back.href = '/';
  back.append(arrow(-1), 'Усі книги');
  back.onclick = e => { e.preventDefault(); selectColl(''); };
  const head = el('section', 'coll-head glass');
  // на головній <h1> — назва магазину; на сторінці добірки (збирач робить назву магазину посиланням) — назва добірки
  head.append(el('p', 'coll-kicker', 'Добірка'), el(document.querySelector('h1.brand') ? 'h2' : 'h1', null, c.name));
  for (const text of (c.description || '').split(/\n+/).map(s => s.trim()).filter(Boolean)) {
    head.append(el('p', 'coll-desc', text));
  }
  box.replaceChildren(back, head);
}

// ---------- Полиці на головній ----------
// Лише на першій сторінці каталогу без пошуку й фільтрів — інакше вони заважають тому, що людина шукає
let shelvesFor = null; // для якого каталогу намальовані: перемальовуємо лише нові дані, а не кожну літеру пошуку
function renderShelves() {
  const box = $('shelves');
  const show = collections.length > 0 && onCatalogPath() && !coll && !cat && pageNo === 1 &&
    !searchWords().length && FACETS.every(f => !picked[f.key].size);
  box.hidden = !show;
  if (!show) { box.textContent = ''; shelvesFor = null; return; }
  if (shelvesFor === collections) return;
  shelvesFor = collections;
  box.replaceChildren(...collections.map(shelfSection));
  for (const row of box.querySelectorAll('.shelf-row')) row.dispatchEvent(new Event('scroll'));
}

function shelfSection(c) {
  const sec = el('section', 'shelf glass');
  const titleId = 'shelf-' + c.slug;
  sec.setAttribute('aria-labelledby', titleId);
  const open = (a, label) => {
    a.href = collPath(c.slug);
    a.onclick = e => { e.preventDefault(); selectColl(c.slug); };
    if (label) a.setAttribute('aria-label', label);
    return a;
  };

  const head = el('div', 'shelf-head');
  const title = el('h2', 'shelf-title');
  title.id = titleId;
  title.append(open(el('a', null, c.name)));
  const n = c.books.length;
  const all = open(el('a', 'shelf-all'), `Усі ${n} ${plural(n, 'книга', 'книги', 'книг')} добірки «${c.name}»`);
  all.append(`Усі ${n} ${plural(n, 'книга', 'книги', 'книг')}`, arrow(1));
  const nav = el('div', 'shelf-nav');
  const prev = el('button');
  const next = el('button');
  prev.type = next.type = 'button';
  prev.setAttribute('aria-label', 'Гортати назад');
  next.setAttribute('aria-label', 'Гортати далі');
  prev.append(arrow(-1));
  next.append(arrow(1));
  nav.append(prev, next);
  head.append(title, nav, all);
  sec.append(head);
  // на вітрині лише назва; опис (якщо є в аркуші) — на сторінці добірки

  const row = el('ul', 'shelf-row grid');
  for (const id of c.books.slice(0, SHELF_MAX)) row.append(bookRow(byId.get(id), true));
  // полиця коротша за добірку — останньою карткою запрошення на сторінку добірки
  if (n > SHELF_MAX) {
    const li = el('li', 'shelf-more');
    const a = open(el('a'));
    a.append(el('b', null, `Ще ${n - SHELF_MAX}`), el('span', null, 'Уся добірка'), arrow(1));
    li.append(a);
    row.append(li);
  }
  sec.append(row);

  // кнопки гортання (на ПК; на телефоні полицю гортають пальцем) — на ширину видимої частини
  const step = dir => row.scrollBy({ left: dir * row.clientWidth * 0.85, behavior: 'smooth' });
  prev.onclick = () => step(-1);
  next.onclick = () => step(1);
  row.addEventListener('scroll', () => {
    prev.disabled = row.scrollLeft < 4;
    next.disabled = row.scrollLeft + row.clientWidth >= row.scrollWidth - 4;
    nav.hidden = row.scrollWidth <= row.clientWidth + 4;
  }, { passive: true });
  return sec;
}
// полиця могла стати ширшою чи вужчою — оновлюємо кнопки
addEventListener('resize', () => {
  for (const row of document.querySelectorAll('#shelves .shelf-row')) row.dispatchEvent(new Event('scroll'));
});
