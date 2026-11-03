// Кошик: кнопки «+»/кількість, смуга кошика, список у замовленні, сторінка книги (/book/15/).

function cartControl(b, row) {
  const slot = el('div', 'ctrl');

  const draw = () => {
    const q = cart[b.id] || 0;
    row.classList.toggle('in-cart', q > 0);
    slot.textContent = '';
    if (!q) {
      const add = el('button', 'add', '+');
      add.type = 'button';
      add.title = 'Додати в кошик';
      add.setAttribute('aria-label', 'Додати в кошик');
      add.onclick = () => set(1);
      slot.append(add);
      return;
    }
    const box = el('div', 'qty');
    const minus = el('button', null, '−');
    minus.type = 'button'; minus.setAttribute('aria-label', 'Менше');
    const plus = el('button', null, '+');
    plus.type = 'button'; plus.setAttribute('aria-label', 'Більше');
    plus.disabled = q >= b.stock;
    const input = el('input');
    input.type = 'number'; input.min = 0; input.max = b.stock; input.inputMode = 'numeric';
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
  q = Math.max(0, Math.min(b.stock, q));
  if (q) cart[id] = q; else delete cart[id];
  saveCart();
  updateCartBar();
  syncControls(id);
}

// В однієї книги буває кілька кнопок кошика: у рядку каталогу і на сторінці книги.
// Після зміни перемальовуємо ті, якими не користувались, — щоб не збити фокус з тієї, де людина зараз
function syncControls(id) {
  const active = document.activeElement;
  const row = $('list').querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (row && !row.contains(active)) row.replaceWith(bookRow(byId.get(id)));
  if (id === PAGE_BOOK && !$('pageCtrl').contains(active)) drawPageBook();
}

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
  $('pageCtrl').replaceChildren(cartControl(b, el('div')));
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
  for (const { book, qty } of cartLines()) {
    const li = el('li');
    const name = el('div');
    name.append(el('div', 'title', book.title), el('div', 'meta', `${qty} × ${money(book.price)}`));
    const rm = el('button', 'remove', '×');
    rm.type = 'button'; rm.title = 'Прибрати';
    rm.onclick = () => {
      setQty(book.id, 0);
      refreshRow(book.id);
      if (!cartLines().length) $('dialog').close();
      else renderLines();
    };
    li.append(name, el('b', null, money(book.price * qty)), rm);
    ul.append(li);
  }
  $('dlgTotal').textContent = money(cartTotal());
}

function refreshRow(id) {
  const old = $('list').querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (old) old.replaceWith(bookRow(byId.get(id)));
}
