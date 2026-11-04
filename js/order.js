// Форма замовлення: контакти, доставка (довідник Нової пошти), оплата, перевірка полів, відправка.

// ---------- Форма замовлення ----------
const form = $('orderForm');
const F = form.elements;

// Що треба заповнити для кожного способу доставки
const METHODS = {
  np_branch:  { fields: ['city', 'warehouse'], np: true, wh: 'Відділення', cats: ['Branch', 'DropOff'] },
  np_locker:  { fields: ['city', 'warehouse'], np: true, wh: 'Поштомат', cats: ['Postomat'] },
  np_courier: { fields: ['city', 'street', 'house', 'flat'], np: true },
  ukrposhta:  { fields: ['city', 'zip'] },
  // довідника відділень Meest з документованим API немає — номер вписують самі (є посилання на карту Meest)
  meest:      { fields: ['city', 'branch'] },
  pickup:     { fields: [] },
};
const method = () => F.method.value;

// Довідник Нової пошти: міста й відділення. Працює без ключа; якщо недоступний —
// поля стають звичайними текстовими
const NP_URL = 'https://api.novaposhta.ua/v2.0/json/';
const NP_POSTOMAT = 'f9316480-5f2d-425d-bc2c-ac7cd29decf0';
let npOnline = true;

async function np(calledMethod, methodProperties) {
  const res = await fetch(NP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: '', modelName: 'Address', calledMethod, methodProperties }),
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.errors.join('; '));
  return data.data;
}

// Поле з випадним списком підказок
function combo(input, { minChars, search, onPick }) {
  const list = input.nextElementSibling;
  let items = [];
  let active = -1;
  let timer;
  let seq = 0;

  const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); };
  const message = text => {
    list.textContent = '';
    list.append(el('li', 'combo-empty', text));
    list.hidden = false;
  };
  const draw = () => {
    if (!items.length) return message('Нічого не знайдено');
    list.textContent = '';
    items.forEach((it, i) => {
      const li = el('li', i === active ? 'active' : null, it.label);
      li.setAttribute('role', 'option');
      li.addEventListener('mousedown', e => { e.preventDefault(); pick(it); });
      list.append(li);
    });
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    list.children[active]?.scrollIntoView({ block: 'nearest' });
  };
  const pick = it => {
    input.value = it.label;
    input.dataset.ref = it.ref;
    close();
    onPick?.(it);
    if (input.getAttribute('aria-invalid') === 'true') validateField(input);
  };
  const run = async () => {
    const q = input.value.trim();
    const my = ++seq;
    if (!npOnline || !METHODS[method()].np || q.length < minChars) return close();
    message('Шукаємо…');
    try {
      const found = await search(q);
      if (my !== seq) return;
      items = found;
      active = items.length ? 0 : -1;
      draw();
    } catch (err) {
      if (my !== seq) return;
      console.error(err);
      npOnline = false;
      F.warehouse.disabled = false;
      close();
    }
  };

  input.addEventListener('input', () => {
    delete input.dataset.ref;
    onPick?.(null);
    clearTimeout(timer);
    timer = setTimeout(run, 250);
  });
  input.addEventListener('focus', () => { if (!input.dataset.ref) run(); });
  input.addEventListener('click', () => { if (list.hidden && !input.dataset.ref) run(); });
  input.addEventListener('blur', () => { seq++; close(); });
  input.addEventListener('keydown', e => {
    if (list.hidden || !items.length) return;
    if (e.key === 'ArrowDown') active = (active + 1) % items.length;
    else if (e.key === 'ArrowUp') active = (active - 1 + items.length) % items.length;
    else if (e.key === 'Enter') { pick(items[active]); e.preventDefault(); return; }
    else if (e.key === 'Escape') { close(); e.preventDefault(); return; }
    else return;
    e.preventDefault();
    draw();
  });
}

combo(F.city, {
  minChars: 2,
  search: async q => {
    const data = await np('searchSettlements', { CityName: q, Limit: '20', Page: '1' });
    const courier = method() === 'np_courier';
    return (data[0]?.Addresses || [])
      .filter(a => courier ? a.AddressDeliveryAllowed : a.Warehouses > 0)
      .map(a => ({ label: a.Present, ref: a.DeliveryCity }));
  },
  onPick: () => resetWarehouse(),
});

combo(F.warehouse, {
  minChars: 0,
  search: async q => {
    const m = METHODS[method()];
    const props = { CityRef: F.city.dataset.ref, Limit: '200', Page: '1' };
    if (q) props.FindByString = q;
    if (m.cats.includes('Postomat')) props.TypeOfWarehouseRef = NP_POSTOMAT;
    const data = await np('getWarehouses', props);
    return data
      .filter(w => m.cats.includes(w.CategoryOfWarehouse) && w.WarehouseStatus === 'Working' && w.DenyToSelect !== '1')
      // поштомати в під'їздах і на підприємствах — не для всіх
      .filter(w => !/тільки для|лише для|для мешканців|для працівників|для співробітників/i.test(w.Description))
      .sort((a, b) => (b.Number === q) - (a.Number === q) || Number(a.Number) - Number(b.Number))
      .slice(0, 60)
      .map(w => ({ label: w.Description, ref: w.Ref }));
  },
});

function resetWarehouse() {
  F.warehouse.value = '';
  delete F.warehouse.dataset.ref;
  clearError(F.warehouse);
  const needCity = npOnline && !F.city.dataset.ref;
  F.warehouse.disabled = needCity;
  const what = METHODS[method()].wh === 'Поштомат' ? 'поштомату' : 'відділення';
  F.warehouse.placeholder = needCity ? 'Спочатку виберіть місто' : `Номер або адреса ${what}`;
}

// Показує лише поля вибраного способу доставки
function updateDelivery() {
  const m = METHODS[method()];
  for (const node of form.querySelectorAll('[data-for]')) {
    node.hidden = !node.dataset.for.split(' ').includes(method());
  }
  for (const node of form.querySelectorAll('[data-recipient]')) node.hidden = !F.otherRecipient.checked;
  if (m.wh) $('whLabel').textContent = m.wh + ' *';
  F.city.placeholder = m.np && npOnline ? 'Почніть вводити назву' : 'Назва населеного пункту';

  const pickup = method() === 'pickup';
  $('codSub').textContent = pickup ? 'готівкою або переказом' : 'накладений платіж';
  $('payNote').textContent = F.payment.value === 'prepay'
    ? 'Після підтвердження замовлення надішлемо реквізити для оплати.'
    : pickup ? '' : 'Перевізник бере комісію за грошовий переказ за своїми тарифами.';
}

// Спосіб доставки складається з двох виборів: перевізник і (для Нової пошти) як отримати.
// Результат — у прихованому полі method, з тими самими значеннями, що й раніше
function syncMethod() {
  F.method.value = F.carrier.value === 'np' ? F.npType.value : F.carrier.value;
}
syncMethod();

let lastMethod = method();
form.addEventListener('change', e => {
  if (e.target.name === 'carrier' || e.target.name === 'npType') {
    syncMethod();
    // відділення і поштомат — різні списки, а місто без вибору зі списку Новій пошті не підходить
    if (!METHODS[lastMethod].np && METHODS[method()].np) delete F.city.dataset.ref;
    lastMethod = method();
    resetWarehouse();
    for (const input of Object.keys(RULES).map(n => F[n])) if (input.closest('[hidden]')) clearError(input);
  }
  if (['carrier', 'npType', 'payment', 'otherRecipient'].includes(e.target.name)) updateDelivery();
});

// Валідація: кожне правило повертає текст помилки або ''
const phoneDigits = v => v.replace(/\D/g, '');
const NAME_RE = /^[\p{L}][\p{L}\s'’ʼ.\-]*$/u;

function nameRule(v, empty) {
  if (!v) return empty;
  if (!NAME_RE.test(v)) return 'Лише літери, пробіли, апостроф і дефіс';
  if (v.split(/\s+/).length < 2) return 'Вкажіть прізвище та ім’я, як у документі';
  return '';
}
function phoneRule(v, empty) {
  if (!v) return empty;
  if (/[^\d\s()+\-]/.test(v)) return 'Номер може містити лише цифри';
  const d = phoneDigits(v);
  if (/^0\d{9}$/.test(d) || /^380\d{9}$/.test(d)) return '';
  if (v.startsWith('+') && d.length >= 10 && d.length <= 15 && !d.startsWith('380')) return '';
  return 'Формат: +380 67 123 45 67 або 067 123 45 67';
}

const RULES = {
  name: v => nameRule(v, 'Вкажіть прізвище та ім’я'),
  phone: v => phoneRule(v, 'Вкажіть номер телефону'),
  email: v => !v || /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) ? '' : 'Схоже, в адресі помилка: приклад name@gmail.com',
  city(v) {
    if (!v) return 'Вкажіть населений пункт';
    if (METHODS[method()].np && npOnline && !F.city.dataset.ref) return 'Виберіть населений пункт зі списку';
    return '';
  },
  warehouse(v) {
    const what = METHODS[method()].wh === 'Поштомат' ? 'поштомат' : 'відділення';
    if (!v) return `Виберіть ${what}`;
    if (npOnline && !F.warehouse.dataset.ref) return `Виберіть ${what} зі списку`;
    return '';
  },
  street: v => v ? '' : 'Вкажіть вулицю',
  house: v => v ? '' : 'Вкажіть номер будинку',
  zip: v => /^\d{5}$/.test(v) ? '' : 'Індекс — 5 цифр, наприклад 79000',
  branch: v => !v ? 'Вкажіть номер відділення чи поштомату' : /\d/.test(v) ? '' : 'Вкажіть номер, наприклад 12',
  rname: v => nameRule(v, 'Вкажіть прізвище та ім’я отримувача'),
  rphone: v => phoneRule(v, 'Вкажіть телефон отримувача'),
};

// +380671234567 → +380 67 123 45 67
function formatPhone(v) {
  let d = phoneDigits(v);
  if (/^0\d{9}$/.test(d)) d = '38' + d;
  if (!/^380\d{9}$/.test(d)) return v.trim();
  return `+${d.slice(0, 3)} ${d.slice(3, 5)} ${d.slice(5, 8)} ${d.slice(8, 10)} ${d.slice(10)}`;
}

function validateField(input) {
  const msg = RULES[input.name](input.value.trim());
  input.setAttribute('aria-invalid', msg ? 'true' : 'false');
  $('err-' + input.name).textContent = msg;
  return !msg;
}
function clearError(input) {
  input.removeAttribute('aria-invalid');
  delete input.dataset.touched;
  $('err-' + input.name).textContent = '';
}

// Поля, які зараз треба перевірити
function activeFields() {
  const names = ['name', 'phone', 'email', ...METHODS[method()].fields.filter(n => RULES[n])];
  if (F.otherRecipient.checked) names.push('rname', 'rphone');
  return names.map(n => F[n]);
}

for (const name of Object.keys(RULES)) {
  const input = F[name];
  // поки поле не покинули — не сваримося; після першої помилки перевіряємо на льоту
  input.addEventListener('blur', () => {
    if ((name === 'phone' || name === 'rphone') && !RULES[name](input.value.trim())) input.value = formatPhone(input.value);
    // для підказок даємо спершу клацнути по пункту списку
    setTimeout(() => {
      if (input.value.trim() || input.dataset.touched) validateField(input);
      input.dataset.touched = '1';
    }, 0);
  });
  input.addEventListener('input', () => {
    if (input.getAttribute('aria-invalid') === 'true') validateField(input);
  });
}
F.zip.addEventListener('input', () => { F.zip.value = F.zip.value.replace(/\D/g, ''); });

const comment = F.comment;
comment.addEventListener('input', () => {
  const left = comment.maxLength - comment.value.length;
  $('commentCount').textContent = left < 100 ? `Залишилось символів: ${left}` : '';
});

function resetValidation() {
  for (const name of Object.keys(RULES)) clearError(F[name]);
}

updateDelivery();
resetWarehouse();

async function submitOrder(e) {
  e.preventDefault();
  const invalid = activeFields().filter(input => !validateField(input));
  if (invalid.length) {
    invalid[0].focus();
    invalid[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
    return;
  }
  F.phone.value = formatPhone(F.phone.value);
  if (F.otherRecipient.checked) F.rphone.value = formatPhone(F.rphone.value);

  const v = name => F[name].value.trim();
  const delivery = { method: method() };
  for (const name of METHODS[method()].fields) delivery[name] = v(name);
  if (F.city.dataset.ref) delivery.cityRef = F.city.dataset.ref;
  if (F.warehouse.dataset.ref) delivery.warehouseRef = F.warehouse.dataset.ref;

  const payload = {
    customer: {
      name: v('name'), phone: v('phone'), email: v('email'), comment: v('comment'), website: v('website'),
      delivery,
      payment: F.payment.value,
      recipient: F.otherRecipient.checked ? { name: v('rname'), phone: v('rphone') } : null,
    },
    items: cartLines().map(l => ({ id: l.book.id, qty: l.qty })),
  };

  const btn = $('submitOrder');
  btn.disabled = true; btn.textContent = 'Надсилаємо…';
  $('formMsg').textContent = '';
  try {
    // text/plain — щоб браузер не робив CORS preflight, який Apps Script не підтримує
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);

    cart = {};
    saveCart();
    updateCartBar();
    render();
    $('doneText').textContent = `Ваше замовлення на суму ${money(data.total)} прийнято. Ми зв'яжемося з вами найближчим часом.`;
    $('orderBody').hidden = true;
    $('orderDone').hidden = false;
  } catch (err) {
    $('formMsg').textContent = err.message || 'Не вдалося надіслати замовлення. Спробуйте ще раз.';
  } finally {
    btn.disabled = false; btn.textContent = 'Надіслати замовлення';
  }
}
