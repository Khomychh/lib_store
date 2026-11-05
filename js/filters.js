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

const activeFilters = () => (cat ? 1 : 0) + (coll ? 1 : 0) + FACETS.reduce((s, f) => s + picked[f.key].size, 0);

// «Скинути» в меню: знімає все, що в ньому вибрано (пошук лишається — він не в меню).
// Відкрита добірка — це окрема сторінка, тож з неї повертаємось на головну, як «Усі книги» над добіркою
function resetFilters() {
  for (const f of FACETS) picked[f.key].clear();
  cat = '';
  history.replaceState(null, '', location.pathname + location.search);
  if (coll) { selectColl(''); return; }
  applyFilter();
  buildFilterMenu();
  $('filterMenu').querySelector('input')?.focus();
}

function renderFilters() {
  const any = categoryRoots().length > 0 || collections.length > 0 || FACETS.some(f => books.some(b => facetOf(b, f)));
  $('filter').hidden = !any;
  if (!any) closeFilters();

  const total = activeFilters();
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

// Меню будуємо при відкритті, а після кожної зміни лише оновлюємо галочки й числа — фокус не стрибає.
// Дві частини: категорії (довгі, по одному рівню дерева) і короткі групи — добірка, акція, стан,
// палітурка, мова — кнопками-перемикачами, щоб їх було видно одразу, без гортання повз категорії
function buildFilterMenu() {
  const menu = $('filterMenu');
  menu.textContent = '';
  const hasCats = categoryRoots().length > 0;
  if (hasCats) menu.append(categoryGroup());

  const facets = el('div', 'fm-facets');
  // добірка — одна; вибір відкриває її сторінку (адреса /dobirka/…) з її заголовком
  if (collections.length) {
    facets.append(chipGroup('Добірка', [{ slug: '', name: 'Усі книги' }, ...collections].map(c =>
      chip('radio', c.name, input => { input.name = 'coll'; input.value = c.slug; input.onchange = () => selectColl(c.slug); }))));
  }
  for (const f of FACETS) {
    const values = facetValues(f);
    if (!values.length) continue;
    facets.append(chipGroup(f.title, values.map(v => chip('checkbox', v, input => {
      input.dataset.key = f.key;
      input.dataset.value = v;
      input.onchange = () => toggleFilter(f.key, v);
    }))));
  }
  if (facets.childElementCount) menu.append(facets);
  menu.classList.toggle('two', hasCats && facets.childElementCount > 0);

  // результат видно одразу під меню, але на телефоні меню його закриває — кнопка каже, скільки буде, і закриває меню
  const foot = el('div', 'fm-foot');
  const reset = el('button', 'fm-reset', 'Скинути');
  reset.type = 'button';
  reset.onclick = resetFilters;
  const show = el('button', 'btn fm-show');
  show.type = 'button';
  show.onclick = () => { closeFilters(); $('filterBtn').focus(); };
  foot.append(reset, show);
  menu.append(foot);
  updateFilterMenu();
}

function chipGroup(title, chips) {
  const group = el('fieldset');
  group.append(el('legend', null, title));
  const box = el('div', 'chips');
  box.append(...chips);
  group.append(box);
  return group;
}

// кнопка-перемикач: усередині справжній перемикач чи галочка (для клавіатури й читалок екрана), видно лише підпис
function chip(type, text, setup) {
  const label = el('label', 'chip');
  const input = el('input');
  input.type = type;
  setup(input);
  label.append(input, text, el('span', 'n'));
  return label;
}

// категорія — одна, тож перемикачі. Показуємо один рівень дерева: категорія з підкатегоріями (позначена ›)
// при виборі відкривається, а «‹ …» повертає на рівень вище
function categoryGroup() {
  const group = el('fieldset', 'cat-tree fm-cats');
  group.append(el('legend', null, 'Категорія'));
  const { up, rows } = categoryLevel();
  if (up !== undefined) {
    const back = el('button', 'cat-back', '‹ ' + (up || 'Усі категорії'));
    back.type = 'button';
    back.onclick = () => selectCat(up);
    group.append(back);
  }
  for (const row of rows) {
    const label = el('label', 'check' + (row.head ? ' head' : up !== undefined ? ' sub' : ''));
    const radio = el('input');
    radio.type = 'radio';
    radio.name = 'cat';
    radio.value = row.name;
    radio.onchange = () => selectCat(row.name);
    label.append(radio, row.label, el('span', 'n'), el('span', 'more', row.more ? '›' : ''));
    // повний шлях — у підказці, щоб було видно, звідки ця категорія
    if (row.name && row.name !== NONE) label.title = [...cats.get(row.name).lineage].reverse().join(' › ');
    group.append(label);
  }
  return group;
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
  menu.querySelector('.fm-reset').disabled = !activeFilters();
  const show = menu.querySelector('.fm-show');
  if (show) show.textContent = filtered.length
    ? `Показати ${filtered.length} ${plural(filtered.length, 'книгу', 'книги', 'книг')}`
    : 'Нічого не знайдено';
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
  // на телефоні меню — панель знизу екрана, висоту їй задають стилі
  if (!matchMedia('(max-width: 600px)').matches) {
    // панель пошуку прилипає до верху вікна: підкручуємо сторінку до неї, інакше під шапкою меню лишається кілька рядків
    const gap = $('filter').closest('.toolbar').getBoundingClientRect().top - 10;
    if (gap > 1) scrollBy({ top: gap, behavior: 'instant' });
    // не далі за нижній край вікна і не під смугу кошика: далі частини меню гортаються самі
    const bar = $('cartbar').classList.contains('show') ? innerHeight - $('cartbar').getBoundingClientRect().top : 0;
    menu.style.setProperty('--fm-max', Math.max(300, innerHeight - bar - menu.getBoundingClientRect().top - 16) + 'px');
  }
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

// Рівень дерева для меню фільтрів. Без вибору — верхній рівень. Вибрана категорія з підкатегоріями
// відкривається: вона сама першим рядком («усе в ній»), під нею — її підкатегорії. Вибрана без підкатегорій —
// видно її сусідів. up — куди веде «‹ назад» ('' — до всіх книг); немає up — ми на верхньому рівні
function categoryLevel() {
  const kids = n => n.children.filter(hasBooks);
  const row = n => ({ name: n.name, label: n.name, more: kids(n).length > 0 });
  const node = cats.get(cat);
  const open = !node ? null : kids(node).length ? node : cats.get(node.parent) || null;
  if (!open) {
    const rows = [{ name: '', label: 'Усі книги' }, ...categoryRoots().map(row)];
    if (uncategorized) rows.push({ name: NONE, label: 'Без категорії' });
    return { rows };
  }
  return { up: open.parent, rows: [{ name: open.name, label: open.name, head: true }, ...kids(open).map(row)] };
}
