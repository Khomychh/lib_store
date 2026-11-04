// Кошик: кнопки «+»/кількість, смуга кошика, список у замовленні, сторінка книги (/book/15/).

// wide — велика кнопка з написом (картка й сторінка книги), інакше кругла «+» (каталог)
function cartControl(b, row, wide) {
  const slot = el('div', wide ? 'ctrl wide' : 'ctrl');

  const draw = () => {
    const q = cart[b.id] || 0;
    row.classList.toggle('in-cart', q > 0);
    slot.textContent = '';
    if (!q) {
      const add = el('button', wide ? 'add btn' : 'add', wide ? 'Додати в кошик' : '+');
      add.type = 'button';
      if (!wide) {
        add.title = 'Додати в кошик';
        add.setAttribute('aria-label', 'Додати в кошик');
      }
      add.onclick = () => set(1);
      slot.append(add);
      return;
    }
    if (wide) slot.append(el('span', 'in', 'У кошику'));
    const box = el('div', 'qty');
    const minus = el('button', null, '−');
    minus.type = 'button'; minus.setAttribute('aria-label', 'Менше');
    const plus = el('button', null, '+');
    plus.type = 'button'; plus.setAttribute('aria-label', 'Більше');
    plus.disabled = q >= maxQty(b);
    const input = el('input');
    input.type = 'number'; input.min = 0; input.inputMode = 'numeric';
    if (!b.preorder) input.max = b.stock;
    input.value = q;
    input.setAttribute('aria-label', 'Кількість');

    minus.onclick = () => set(q - 1);
    plus.onclick = () => set(q + 1);
    input.onchange = () => set(parseInt(input.value, 10) || 0);
    input.onfocus = () => input.select();
    box.append(minus, input, plus);
    slot.append(box);
  };
  const set = q => { setQty(b.id, q); draw(); };

  draw();
  return slot;
}

function setQty(id, q) {
  const b = byId.get(id);
  q = Math.max(0, Math.min(maxQty(b), q));
  if (q) cart[id] = q; else delete cart[id];
  saveCart();
  updateCartBar();
  syncControls(id);
}

// В однієї книги буває кілька кнопок кошика: у рядку каталогу, на полиці добірки і на сторінці книги.
// Після зміни перемальовуємо ті, якими не користувались, — щоб не збити фокус з тієї, де людина зараз
function syncControls(id) {
  const active = document.activeElement;
  for (const row of rowsOf(id)) if (!row.contains(active)) redrawRow(row);
  if (id === PAGE_BOOK && !$('pageCtrl').contains(active)) drawPageBook();
}
const rowsOf = id => document.querySelectorAll(`#list .row[data-id="${CSS.escape(id)}"], #shelves .row[data-id="${CSS.escape(id)}"]`);
// на полиці — завжди картка вітрини, у каталозі — як вибрано
const redrawRow = row => row.replaceWith(bookRow(byId.get(row.dataset.id), row.closest('#shelves') ? true : undefined));

// Сторінка книги (/book/15/): збирач кладе номер книги в <body data-book="15">, а сам опис — у розмітку.
// Ціну й наявність підставляємо свіжі з каталогу: сторінку могли зібрати до останньої зміни в таблиці
const PAGE_BOOK = document.body.dataset.book || '';
function drawPageBook() {
  if (!PAGE_BOOK) return;
  const b = byId.get(PAGE_BOOK);
  if (!b) {
    $('pagePrice').replaceChildren(el('div', 'sold', 'Цієї книги зараз немає в наявності'));
    $('pageCtrl').textContent = '';
    return;
  }
  $('pagePrice').replaceChildren(...priceLines(b));
  $('pageCtrl').replaceChildren(cartControl(b, el('div'), true));
  if ($('pageAsk')) fillAsk($('pageAsk'), b);
}

function cartLines() {
  return Object.entries(cart).map(([id, qty]) => ({ book: byId.get(id), qty })).filter(l => l.book);
}
function cartTotal() {
  return cartLines().reduce((s, l) => s + l.book.price * l.qty, 0);
}

function updateCartBar() {
  const pcs = cartLines().reduce((s, l) => s + l.qty, 0);
  $('cartbar').classList.toggle('show', pcs > 0);
  $('cartCount').textContent = pcs;
  $('cartCount').title = `${pcs} шт. у кошику`;
  $('cartTotal').textContent = money(cartTotal());
}

function renderLines() {
  const ul = $('lines');
  ul.textContent = '';
  const lines = cartLines();
  const pcs = lines.reduce((s, l) => s + l.qty, 0);
  $('linesCount').textContent = `${pcs} ${plural(pcs, 'книга', 'книги', 'книг')}`;
  for (const { book, qty } of lines) {
    const li = el('li');
    const name = el('div', 'line-text');
    name.append(el('div', 'title', book.title));
    if (book.author) name.append(el('div', 'meta', book.author));
    if (qty > 1) name.append(el('div', 'meta', `${qty} × ${money(book.price)}`));
    // що піде передзамовленням: уся книга або лише примірники понад наявність
    const pre = preorderPart(book, qty);
    if (pre) name.append(el('div', 'pre', pre === qty ? 'Передзамовлення' : `Передзамовлення: ${pre} шт.`));
    name.append(lineQty(book, qty));
    const rm = el('button', 'remove');
    rm.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
    rm.type = 'button'; rm.title = 'Прибрати';
    rm.setAttribute('aria-label', `Прибрати «${book.title}»`);
    rm.onclick = () => changeLine(book.id, 0);
    const end = el('div', 'line-end');
    end.append(el('b', 'sum', money(book.price * qty)), rm);
    li.append(bookCover(book, true), name, end);
    ul.append(li);
  }
  $('dlgTotal').textContent = money(cartTotal());
  // передзамовлення відправляємо разом з рештою, коли надійде, — попереджаємо до надсилання.
  // Покупець може сховати попередження хрестиком: тоді не показуємо його, доки відкрита вкладка
  $('preNote').hidden = preNoteDismissed() || !lines.some(l => preorderPart(l.book, l.qty) > 0);
}

const PRE_NOTE_KEY = 'lib_store_pre_note_hidden';
function preNoteDismissed() {
  try { return sessionStorage.getItem(PRE_NOTE_KEY) === '1'; } catch { return preNoteHidden; }
}
let preNoteHidden = false; // запасний варіант, коли сховище браузера недоступне
function dismissPreNote() {
  preNoteHidden = true;
  try { sessionStorage.setItem(PRE_NOTE_KEY, '1'); } catch {}
  $('preNote').hidden = true;
}

// Кількість у списку замовлення: «−» до 1 (прибрати — хрестиком), «+» до наявності (під передзамовлення — без межі).
// Вписати 0 — те саме, що прибрати
function lineQty(book, qty) {
  const box = el('div', 'qty');
  const btn = (text, label, role, q) => {
    const b = el('button', null, text);
    b.type = 'button';
    b.dataset.role = role;
    b.setAttribute('aria-label', `${label}: «${book.title}»`);
    b.onclick = () => changeLine(book.id, q, role);
    return b;
  };
  const minus = btn('−', 'Менше', 'minus', qty - 1);
  minus.disabled = qty <= 1;
  const plus = btn('+', 'Більше', 'plus', qty + 1);
  plus.disabled = qty >= maxQty(book);
  if (plus.disabled) plus.title = 'Більше немає в наявності';
  const input = el('input');
  input.type = 'number'; input.min = 0; input.inputMode = 'numeric';
  if (!book.preorder) input.max = book.stock;
  input.value = qty;
  input.dataset.role = 'input';
  input.setAttribute('aria-label', `Кількість: «${book.title}»`);
  input.onfocus = () => input.select();
  input.onchange = () => changeLine(book.id, parseInt(input.value, 10) || 0, 'input');
  input.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } };
  box.dataset.id = book.id;
  box.append(minus, input, plus);
  return box;
}

// Змінює кількість зі списку замовлення й перемальовує список; фокус лишається на тій самій кнопці
function changeLine(id, q, role) {
  setQty(id, q);
  refreshRow(id);
  if (!cartLines().length) { $('dialog').close(); return; }
  renderLines();
  if (!role || !cart[id]) return;
  const box = [...$('lines').querySelectorAll('.qty')].find(b => b.dataset.id === id);
  const target = box?.querySelector(`[data-role="${role}"]`);
  // «−» на одиниці вимикається — тоді фокус на поле
  (target && !target.disabled ? target : box?.querySelector('input'))?.focus({ preventScroll: true });
}

function refreshRow(id) {
  for (const row of rowsOf(id)) redrawRow(row);
}
