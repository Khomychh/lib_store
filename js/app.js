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

// пункт «Як у добірці» видно лише в добірці — стрілками ходимо лише видимими
const shownSorts = () => sortItems.filter(li => !li.hidden);

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
// вибрати сортування без перемальовування (його вмикає й вимикає вибір добірки, js/collections.js)
function setSort(value) {
  sortBy = value;
  for (const li of sortItems) {
    li.setAttribute('aria-selected', li.dataset.value === value);
    if (li.dataset.value === 'collection') li.hidden = !coll;
  }
  $('sortLabel').textContent = sortItems.find(li => li.dataset.value === value).textContent;
}
function chooseSort(li) {
  setSort(li.dataset.value);
  closeSort();
  sortBtn.focus();
  applyFilter();
}

sortBtn.addEventListener('click', () => sortMenu.hidden ? openSort() : closeSort());
sortMenu.addEventListener('keydown', e => {
  const shown = shownSorts();
  const at = shown.indexOf(sortItems[activeItem]);
  if (e.key === 'ArrowDown') highlight(sortItems.indexOf(shown[(at + 1) % shown.length]));
  else if (e.key === 'ArrowUp') highlight(sortItems.indexOf(shown[(at - 1 + shown.length) % shown.length]));
  else if (e.key === 'Enter' || e.key === ' ') chooseSort(sortItems[activeItem]);
  else if (e.key === 'Escape' || e.key === 'Tab') { closeSort(); sortBtn.focus(); }
  else return;
  e.preventDefault();
});
document.addEventListener('click', e => {
  if (!sortMenu.hidden && !e.target.closest('.sort')) closeSort();
  // шлях події, а не e.target.closest: «‹ назад» у меню перебудовує його, і натиснута кнопка вже поза сторінкою
  if (!$('filterMenu').hidden && !e.composedPath().includes($('filter'))) closeFilters();
  if (!$('chatMenu').hidden && !e.target.closest('.chat')) closeChat();
});

// Кнопка «Написати продавцю»: меню з Telegram і поштою
function closeChat() {
  $('chatMenu').hidden = true;
  $('chatBtn').setAttribute('aria-expanded', 'false');
}
$('chatBtn').addEventListener('click', () => {
  const open = $('chatMenu').hidden;
  $('chatMenu').hidden = !open;
  $('chatBtn').setAttribute('aria-expanded', String(open));
  if (open) $('chatMenu').querySelector('a').focus();
});
$('chat').addEventListener('keydown', e => {
  if (e.key !== 'Escape' || $('chatMenu').hidden) return;
  closeChat();
  $('chatBtn').focus();
});
// перейшли в Telegram чи пошту — меню закриваємо, щоб, повернувшись, людина бачила сторінку
for (const a of $('chatMenu').querySelectorAll('a')) a.addEventListener('click', () => setTimeout(closeChat, 0));

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

$('openOrder').addEventListener('click', () => {
  renderLines();
  $('orderBody').hidden = false;
  $('orderDone').hidden = true;
  $('formMsg').textContent = '';
  resetValidation();
  $('dialog').showModal();
});
$('closeOrder').addEventListener('click', () => $('dialog').close());
$('preNoteClose').addEventListener('click', () => {
  dismissPreNote();
  $('submitOrder').focus(); // кнопка зникла разом з попередженням — фокус на наступне, що можна натиснути
});
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
