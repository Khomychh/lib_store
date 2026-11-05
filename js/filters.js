// Фільтри: акція, стан, обкладинка, мова і категорії (дерево з аркуша «Категорії»), меню «Фільтри».
// Добірки (js/collections.js) теж є в меню, але знімаються не «пігулкою», а посиланням «Усі книги» над добіркою

// ---------- Фільтри за акцією, станом, обкладинкою і мовою ----------
// Значення беруться з самих книг; відомі йдуть у цьому порядку, решта — за абеткою після них.
// У групі можна відмітити кілька (будь-яке з них), між групами — всі одразу.
// value — як дістати значення з книги, якщо його немає готовим полем (типово — b[key])
const FACETS = [
  // акційна — та, у якої є звичайна ціна, вища за ціну продажу (oldPrice передає скрипт, див. discount у js/catalog.js)
  { key: 'sale', title: 'Акція', order: ['Зі знижкою'], value: b => b.oldPrice > b.price ? 'Зі знижкою' : '' },
  { key: 'condition', title: 'Стан', order: ['Нова', 'Вживана'] },
  { key: 'binding', title: 'Палітурка', order: ['Тверда', 'Суперобкладинка', 'М’яка', 'Інтегральна'] },
  { key: 'language', title: 'Мова', order: ['Українська', 'Англійська', 'Російська'] },
];
const picked = Object.fromEntries(FACETS.map(f => [f.key, new Set()]));
const facetOf = (b, f) => f.value ? f.value(b) : b[f.key];
const facetByKey = key => FACETS.find(f => f.key === key);

// Нова книга — звичайна справа, позначаємо лише вживані
const isUsed = b => !!b.condition && !/^нов/i.test(b.condition);

function passFilters(b, skip) {
  return FACETS.every(f => f.key === skip || !picked[f.key].size || picked[f.key].has(facetOf(b, f)));
}

function facetValues(f) {
  const collator = new Intl.Collator('uk');
  const rank = v => { const i = f.order.indexOf(v); return i < 0 ? f.order.length : i; };
  return [...new Set(books.map(b => facetOf(b, f)).filter(Boolean))]
    .sort((a, b) => rank(a) - rank(b) || collator.compare(a, b));
}

// усі книги з вибраним значенням продані — значення зникає з фільтра і перестає фільтрувати
function pruneFilters() {
  for (const f of FACETS) {
    for (const v of picked[f.key]) if (!books.some(b => facetOf(b, f) === v)) picked[f.key].delete(v);
  }
}

function toggleFilter(key, value) {
  if (picked[key].has(value)) picked[key].delete(value); else picked[key].add(value);
  applyFilter();
}

function renderFilters() {
  const any = categoryRoots().length > 0 || collections.length > 0 || FACETS.some(f => books.some(b => facetOf(b, f)));
  $('filter').hidden = !any;
  if (!any) closeFilters();

  const total = (cat ? 1 : 0) + (coll ? 1 : 0) + FACETS.reduce((s, f) => s + picked[f.key].size, 0);
  $('filterBadge').hidden = !total;
  $('filterBadge').textContent = total;
  $('filterBtn').setAttribute('aria-label', total ? `Фільтри, увімкнено: ${total}` : 'Фільтри');

  const pills = $('picked');
  pills.textContent = '';
  if (cat) {
    const label = cat === NONE ? 'Без категорії' : cat;
    const btn = el('button', 'picked', label);
    btn.type = 'button';
    btn.append(el('span', null, '×'));
    // повний шлях — у підказці, щоб було видно, звідки ця категорія
    if (cat !== NONE) btn.title = [...cats.get(cat).lineage].reverse().join(' › ');
    btn.setAttribute('aria-label', `Прибрати фільтр «Категорія: ${label}»`);
    btn.onclick = () => selectCat('');
    pills.append(btn);
  }
  for (const f of FACETS) {
    for (const v of picked[f.key]) {
      const btn = el('button', 'picked', v);
      btn.type = 'button';
      btn.append(el('span', null, '×'));
      btn.setAttribute('aria-label', `Прибрати фільтр «${f.title}: ${v}»`);
      btn.onclick = () => toggleFilter(f.key, v);
      pills.append(btn);
    }
  }
  updateFilterMenu();
}

// Меню будуємо при відкритті, а після кожної зміни лише оновлюємо галочки й числа — фокус не стрибає
function buildFilterMenu() {
  const menu = $('filterMenu');
  menu.textContent = '';
  // категорія — одна, тож перемикачі; вкладені зсунуті вправо за рівнем
  if (categoryRoots().length) {
    const group = el('fieldset', 'cat-tree');
    group.append(el('legend', null, 'Категорія'));
    for (const row of categoryRows()) {
      const label = el('label', 'check');
      label.style.paddingLeft = 12 + row.depth * 18 + 'px';
      const radio = el('input');
      radio.type = 'radio';
      radio.name = 'cat';
      radio.value = row.name;
      radio.onchange = () => selectCat(row.name);
      label.append(radio, row.label, el('span', 'n'));
      group.append(label);
    }
    menu.append(group);
  }
  // добірка — одна; вибір відкриває її сторінку (адреса /dobirka/…) з її заголовком
  if (collections.length) {
    const group = el('fieldset');
    group.append(el('legend', null, 'Добірка'));
    for (const c of [{ slug: '', name: 'Усі книги' }, ...collections]) {
      const label = el('label', 'check');
      const radio = el('input');
      radio.type = 'radio';
      radio.name = 'coll';
      radio.value = c.slug;
      radio.onchange = () => selectColl(c.slug);
      label.append(radio, c.name, el('span', 'n'));
      group.append(label);
    }
    menu.append(group);
  }
  for (const f of FACETS) {
    const values = facetValues(f);
    if (!values.length) continue;
    const group = el('fieldset');
    group.append(el('legend', null, f.title));
    for (const v of values) {
      const label = el('label', 'check');
      const box = el('input');
      box.type = 'checkbox';
      box.dataset.key = f.key;
      box.dataset.value = v;
      box.onchange = () => toggleFilter(f.key, v);
      label.append(box, v, el('span', 'n'));
      group.append(label);
    }
    menu.append(group);
  }
  updateFilterMenu();
}

// числа — скільки книг буде, якщо відмітити значення, з урахуванням категорії, пошуку та іншої групи
function updateFilterMenu() {
  const menu = $('filterMenu');
  if (menu.hidden) return;
  const words = searchWords();
  // категорії рахуємо з урахуванням пошуку й решти фільтрів, але без самої категорії
  const searched = books.filter(b => matchesSearch(b, words));
  const forCats = searched.filter(b => passFilters(b) && inCollection(b));
  for (const radio of menu.querySelectorAll('input[name="cat"]')) {
    const name = radio.value;
    const n = !name ? forCats.length
      : name === NONE ? forCats.filter(b => !b.category).length
      : forCats.filter(b => b.category && cats.get(b.category).lineage.includes(name)).length;
    radio.checked = name === cat;
    radio.parentElement.querySelector('.n').textContent = n;
    radio.parentElement.classList.toggle('empty', !n && !radio.checked);
  }
  // добірки — так само, без самої добірки
  const forColls = searched.filter(b => passFilters(b) && inCategory(b));
  for (const radio of menu.querySelectorAll('input[name="coll"]')) {
    const c = collBySlug.get(radio.value);
    const n = c ? forColls.filter(b => c.order.has(b.id)).length : forColls.length;
    radio.checked = radio.value === coll;
    radio.parentElement.querySelector('.n').textContent = n;
    radio.parentElement.classList.toggle('empty', !n && !radio.checked);
  }
  const base = searched.filter(b => inCategory(b) && inCollection(b));
  for (const box of menu.querySelectorAll('input[type="checkbox"]')) {
    const { key, value } = box.dataset;
    const n = base.filter(b => facetOf(b, facetByKey(key)) === value && passFilters(b, key)).length;
    box.checked = picked[key].has(value);
    box.parentElement.querySelector('.n').textContent = n;
    box.parentElement.classList.toggle('empty', !n && !box.checked);
  }
}

function openFilters() {
  const menu = $('filterMenu');
  menu.hidden = false;
  $('filterBtn').setAttribute('aria-expanded', 'true');
  buildFilterMenu();
  // не далі за нижній край вікна і не під смугу кошика: далі меню гортається саме
  const bar = $('cartbar').classList.contains('show') ? innerHeight - $('cartbar').getBoundingClientRect().top : 0;
  menu.style.maxHeight = Math.max(240, innerHeight - bar - menu.getBoundingClientRect().top - 16) + 'px';
  menu.querySelector('input')?.focus();
}
function closeFilters() {
  $('filterMenu').hidden = true;
  $('filterBtn').setAttribute('aria-expanded', 'false');
}

// ---------- Категорії ----------
// Дерево з аркуша «Категорії»: кожна знає батьківську, дочірні (у порядку аркуша),
// свій шлях угору до верхнього рівня і скільки книг у ній разом з усіма вкладеними
const NONE = '\u0000none'; // «Без категорії»
let cats = new Map();
let uncategorized = 0;
let cat = ''; // вибрана категорія; '' — усі книги

function buildCategories(list) {
  cats = new Map();
  const add = (name, parent) => cats.set(name, { name, parent, children: [], count: 0, lineage: [] });
  for (const c of list || []) {
    const name = String(c.name || '').trim();
    if (name && !cats.has(name)) add(name, String(c.parent || '').trim());
  }
  // категорія є в книзі, але її немає на аркуші — показуємо її на верхньому рівні, щоб помилку було видно
  for (const b of books) if (b.category && !cats.has(b.category)) add(b.category, '');
  for (const n of cats.values()) if (n.parent === n.name || !cats.has(n.parent)) n.parent = '';
  for (const n of cats.values()) if (n.parent) cats.get(n.parent).children.push(n);
  // шлях від категорії вгору; захист від кола, якщо в аркуші дві категорії вказали одна на одну
  for (const n of cats.values()) {
    for (let p = n; p && !n.lineage.includes(p.name); p = cats.get(p.parent)) n.lineage.push(p.name);
  }
  uncategorized = 0;
  for (const b of books) {
    if (!b.category) { uncategorized++; continue; }
    for (const name of cats.get(b.category).lineage) cats.get(name).count++;
  }
}

function inCategory(b) {
  if (!cat) return true;
  if (cat === NONE) return !b.category;
  return !!b.category && cats.get(b.category).lineage.includes(cat);
}

const hasBooks = n => n.count > 0;

function selectCat(name) {
  cat = name;
  history.replaceState(null, '', location.pathname + location.search + catHash());
  applyFilter();
  // у меню розгортається гілка нової категорії — перебудовуємо його й лишаємо фокус на вибраній
  if (!$('filterMenu').hidden) {
    buildFilterMenu();
    [...$('filterMenu').querySelectorAll('input[name="cat"]')].find(r => r.value === name)?.focus();
  }
}

function catHash() {
  if (!cat) return '';
  return '#cat=' + (cat === NONE ? 'none' : encodeURIComponent(cat));
}

// #cat=Богослов'я в адресі відкриває категорію після завантаження каталогу. Читаємо щоразу:
// збережений у браузері каталог може ще не знати категорії, а свіжий від Google — уже знає.
// Адреса завжди відповідає вибору (selectCat її оновлює), тож чужого вибору це не перебʼє
function readHashCategory() {
  const m = location.hash.match(/^#cat=(.+)$/);
  if (m) cat = m[1] === 'none' ? NONE : decodeURIComponent(m[1]);
}

const categoryRoots = () => [...cats.values()].filter(n => !n.parent && hasBooks(n));

// Рядки дерева для меню фільтрів: верхній рівень видно завжди, а вкладені — лише вздовж гілки
// вибраної категорії (її предки, сусіди на кожному рівні та її власні підкатегорії)
function categoryRows() {
  const open = new Set(cats.get(cat)?.lineage || []);
  const rows = [{ name: '', label: 'Усі книги', depth: 0 }];
  const walk = (list, depth) => {
    for (const n of list.filter(hasBooks)) {
      rows.push({ name: n.name, label: n.name, depth });
      if (open.has(n.name)) walk(n.children, depth + 1);
    }
  };
  walk(categoryRoots(), 0);
  if (uncategorized) rows.push({ name: NONE, label: 'Без категорії', depth: 0 });
  return rows;
}
