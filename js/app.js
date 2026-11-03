// Запуск: прив’язка кнопок і меню, нескінченна прокрутка, вікна, жести. Підключається останнім.

let searchTimer;
$('search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => applyFilter(), 150); });
// меню сортування
const sortBtn = $('sortBtn');
const sortMenu = $('sortMenu');
const sortItems = [...sortMenu.children];
let activeItem = -1;

for (const li of sortItems) {
  li.insertAdjacentHTML('afterbegin', '<svg class="tick" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5 9-10"/></svg>');
  li.addEventListener('click', () => chooseSort(li));
  li.addEventListener('mousemove', () => highlight(sortItems.indexOf(li)));
}

function openSort() {
  sortMenu.hidden = false;
  sortBtn.setAttribute('aria-expanded', 'true');
  highlight(sortItems.findIndex(li => li.dataset.value === sortBy));
  sortMenu.focus();
}
function closeSort() {
  sortMenu.hidden = true;
  sortBtn.setAttribute('aria-expanded', 'false');
}
function highlight(i) {
  activeItem = i;
  sortItems.forEach((li, j) => li.classList.toggle('active', j === i));
}
function chooseSort(li) {
  sortBy = li.dataset.value;
  sortItems.forEach(x => x.setAttribute('aria-selected', x === li));
  $('sortLabel').textContent = li.textContent;
  closeSort();
  sortBtn.focus();
  applyFilter();
}

sortBtn.addEventListener('click', () => sortMenu.hidden ? openSort() : closeSort());
sortMenu.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown') highlight((activeItem + 1) % sortItems.length);
  else if (e.key === 'ArrowUp') highlight((activeItem - 1 + sortItems.length) % sortItems.length);
  else if (e.key === 'Enter' || e.key === ' ') chooseSort(sortItems[activeItem]);
  else if (e.key === 'Escape' || e.key === 'Tab') { closeSort(); sortBtn.focus(); }
  else return;
  e.preventDefault();
});
document.addEventListener('click', e => {
  if (!sortMenu.hidden && !e.target.closest('.sort')) closeSort();
  if (!$('filterMenu').hidden && !e.target.closest('.filter')) closeFilters();
});

$('filterBtn').addEventListener('click', () => $('filterMenu').hidden ? openFilters() : closeFilters());
$('filterMenu').addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  closeFilters();
  $('filterBtn').focus();
});

// Вигляд каталогу: вітрина з обкладинками або компактний список. Кнопка показує той, на який перемкне
const ICON_GRID = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="4" y="3.5" width="6.5" height="8" rx="1"/><rect x="13.5" y="3.5" width="6.5" height="8" rx="1"/><rect x="4" y="13.5" width="6.5" height="8" rx="1"/><rect x="13.5" y="13.5" width="6.5" height="8" rx="1"/></svg>';
const ICON_LIST = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4" width="4" height="5.5" rx=".8"/><rect x="3.5" y="14.5" width="4" height="5.5" rx=".8"/><path d="M11 6.75h9.5M11 17.25h9.5"/></svg>';
function applyView() {
  const grid = view === 'grid';
  $('list').classList.toggle('grid', grid);
  const btn = $('viewBtn');
  btn.innerHTML = grid ? ICON_LIST : ICON_GRID;
  btn.title = grid ? 'Показати списком' : 'Показати обкладинками';
  btn.setAttribute('aria-label', btn.title);
}
$('viewBtn').addEventListener('click', () => {
  view = view === 'grid' ? 'list' : 'grid';
  try { localStorage.setItem(VIEW_KEY, view); } catch {}
  applyView();
  if (books.length) render();
});
applyView();

// повна підказка в полі пошуку на телефоні обрізається — там лишаємо коротку
const narrow = matchMedia('(max-width: 600px)');
const fitPlaceholder = () => { $('search').placeholder = narrow.matches ? 'Пошук' : 'Назва, автор або видавництво'; };
narrow.addEventListener('change', fitPlaceholder);
fitPlaceholder();

// Нескінченна прокрутка: коли до кінця списку лишається ~2 екрани, дописуємо ще книги
const moreObserver = new IntersectionObserver(entries => {
  if (!entries[0].isIntersecting) return;
  loadMore();
  // якщо після дописування кінець списку досі видно — перевіряємо ще раз
  moreObserver.unobserve($('more'));
  moreObserver.observe($('more'));
}, { rootMargin: '0px 0px 1200px 0px' });
moreObserver.observe($('more'));
$('openOrder').addEventListener('click', () => {
  renderLines();
  $('orderBody').hidden = false;
  $('orderDone').hidden = true;
  $('formMsg').textContent = '';
  resetValidation();
  $('dialog').showModal();
});
$('closeOrder').addEventListener('click', () => $('dialog').close());
$('doneClose').addEventListener('click', () => $('dialog').close());
$('orderForm').addEventListener('submit', submitOrder);

const bookDlg = $('book');
$('bookClose').addEventListener('click', () => bookDlg.close());
$('bookPrev').addEventListener('click', () => showPhoto(shelf.index - 1));
$('bookNext').addEventListener('click', () => showPhoto(shelf.index + 1));
// клік по затемненому тлу закриває картку
bookDlg.addEventListener('click', e => { if (e.target === bookDlg) bookDlg.close(); });
bookDlg.addEventListener('close', () => {
  history.replaceState(null, '', location.pathname + location.search + catHash());
  if (shelf.book) refreshRow(shelf.book.id);
});
bookDlg.addEventListener('keydown', e => {
  if (shelf.photos.length < 2 || e.target.tagName === 'INPUT') return;
  if (e.key === 'ArrowLeft') showPhoto(shelf.index - 1);
  else if (e.key === 'ArrowRight') showPhoto(shelf.index + 1);
});
// свайп по фото на телефоні
let touchX = null;
$('bookStage').addEventListener('touchstart', e => { touchX = e.touches.length === 1 ? e.touches[0].clientX : null; }, { passive: true });
$('bookStage').addEventListener('touchend', e => {
  if (touchX == null || shelf.photos.length < 2) return;
  const dx = e.changedTouches[0].clientX - touchX;
  touchX = null;
  if (Math.abs(dx) >= 50) showPhoto(shelf.index + (dx < 0 ? 1 : -1));
});

init();
