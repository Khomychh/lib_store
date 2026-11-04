// Картка книги: фото з гортанням, опис, характеристики; відкриття за посиланням #book-15.

// ---------- Картка книги ----------
// Фото — мініатюри Google Диску потрібної ширини: Google сам зменшує важкий оригінал
const photoUrl = (id, width) => `https://drive.google.com/thumbnail?id=${encodeURIComponent(id)}&sz=w${width}`;

// Яка книга відкрита, які її фото вдалося завантажити і яке з них показано
let shelf = { book: null, photos: [], index: 0 };

function openBook(b) {
  shelf = { book: b, photos: [...(b.photos || [])], index: 0 };
  $('bookTitle').textContent = b.title;

  const by = $('bookBy');
  by.textContent = '';
  if (b.author) by.append(el('span', 'author', b.author));
  const meta = [b.year && b.year + ' р.', b.pages && b.pages + ' с.'].filter(Boolean).join(' · ');
  if (meta) by.append((b.author ? ' · ' : '') + meta);

  // абзаци опису — за переносами рядків у клітинці таблиці
  const desc = $('bookDesc');
  desc.textContent = '';
  const facts = $('bookFacts');
  facts.textContent = '';
  for (const [label, value] of [
    ['Видавництво', b.publisher], ['Мова', b.language], ['Обкладинка', b.binding], ['Стан', b.condition], ['ISBN', b.isbn],
  ]) if (value) facts.append(el('dt', null, label), el('dd', null, value));
  for (const text of (b.description || '').split(/\n+/).map(s => s.trim()).filter(Boolean)) {
    desc.append(el('p', null, text));
  }

  $('bookPrice').replaceChildren(...priceLines(b));
  $('bookCtrl').replaceChildren(cartControl(b, el('div')));

  drawPhotos();
  // від поточної адреси, а не відносно: на сторінках книг стоїть <base href="/">, і '#book-…' вело б на головну
  history.replaceState(null, '', location.pathname + location.search + '#book-' + encodeURIComponent(b.id));
  const dlg = $('book');
  if (!dlg.open) dlg.showModal();
  dlg.querySelector('.leaf-text').scrollTop = 0;
  dlg.querySelector('.spread').scrollTop = 0;
}

function drawPhotos() {
  const { photos } = shelf;
  const n = photos.length;
  // без фото ліва сторінка не зникає: на ній тканинна палітурка, як на вітрині
  $('book').classList.toggle('has-photos', n > 0);
  $('book').classList.toggle('has-cloth', !n);
  $('bookImg').hidden = !n;
  $('bookCloth').hidden = !!n;
  // палітурка лише прикраса: назва вже є в заголовку
  if (n) $('bookPhotos').removeAttribute('aria-hidden');
  else $('bookPhotos').setAttribute('aria-hidden', 'true');
  $('bookPrev').hidden = $('bookNext').hidden = n < 2;
  const thumbs = $('bookThumbs');
  thumbs.textContent = '';
  thumbs.hidden = n < 2;
  if (!n) {
    paintCloth($('bookCloth'), shelf.book);
    return;
  }
  if (n > 1) photos.forEach((id, i) => {
    const btn = el('button');
    btn.type = 'button';
    btn.setAttribute('aria-label', `Фото ${i + 1} з ${n}`);
    const img = el('img');
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.src = photoUrl(id, 120);
    btn.append(img);
    btn.onclick = () => showPhoto(i);
    thumbs.append(btn);
  });
  showPhoto(Math.min(shelf.index, n - 1));
}

function showPhoto(index) {
  const { photos, book } = shelf;
  const n = photos.length;
  shelf.index = (index + n) % n;
  const id = photos[shelf.index];
  const img = $('bookImg');
  img.dataset.photo = id;
  img.alt = n > 1 ? `${book.title}, фото ${shelf.index + 1} з ${n}` : book.title;
  // спершу легка мініатюра, потім велике фото, коли довантажиться
  img.src = photoUrl(id, 400);
  loadBig(id, () => { if (img.dataset.photo === id) img.src = photoUrl(id, 1200); });
  [...$('bookThumbs').children].forEach((t, i) => t.setAttribute('aria-current', i === shelf.index));
  $('bookThumbs').children[shelf.index]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  // сусідні фото вантажимо заздалегідь, щоб гортання не гальмувало
  if (n > 1) {
    loadBig(photos[(shelf.index + 1) % n]);
    loadBig(photos[(shelf.index - 1 + n) % n]);
  }
}

function loadBig(id, onload) {
  const big = new Image();
  big.referrerPolicy = 'no-referrer';
  if (onload) big.onload = onload;
  big.src = photoUrl(id, 1200);
}

// файл видалили або закрили доступ — прибираємо фото; не лишилося жодного — тканинна палітурка
$('bookImg').addEventListener('error', () => {
  const id = $('bookImg').dataset.photo;
  if (!id) return;
  delete $('bookImg').dataset.photo;
  shelf.photos = shelf.photos.filter(p => p !== id);
  drawPhotos();
});

// #book-15 в адресі відкриває картку одразу після завантаження каталогу
let hashChecked = false;
function openFromHash() {
  if (hashChecked) return;
  hashChecked = true;
  const m = location.hash.match(/^#book-(.+)$/);
  const b = m && byId.get(decodeURIComponent(m[1]));
  if (b) openBook(b);
}
