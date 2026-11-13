// Збирає сайт для GitHub Pages у папку _site (запускає GitHub Action, див. .github/workflows/pages.yml).
//
// Що робить:
//  - копіює файли сайту як є;
//  - бере каталог з Apps Script і для кожної книги (у наявності чи під передзамовлення) робить сторінку /book/<№>/ — лише з цією книгою
//    (пошук і каталог ховаються, див. body[data-book] у стилях), власною назвою, описом, прев'ю для месенджерів
//    і розміткою товару для Google;
//  - на всі сторінки дописує адресу, прев'ю й розмітку магазину; робить sitemap.xml, robots.txt і 404.html;
//  - для кожної добірки з аркуша «Добірки» робить сторінку /dobirka/<адреса>/ з її книгами, а на головній — полиці добірок;
//  - робить products.xml — файл товарів для Google Merchant Center (лише книги з фото);
//  - збирає текстові сторінки (доставка й оплата, повернення, контакти) у /<назва файлу в pages/>/ —
//    з Google Документів через Apps Script, а якщо їх немає — з файлів pages/.
//
// Звідки бере дані (окремих налаштувань немає — міняйте там, де це й так видно):
//  - домен сайту — файл CNAME;
//  - назва магазину — <h1 class="brand"> в index.html;
//  - назва вкладки й опис головної — <title> і <meta name="description"> в index.html;
//  - адреса каталогу — const API_URL в js/catalog.js.
//
// До styles.css і js/*.js у сторінках дописує версію (?v=…, за вмістом файлу): GitHub Pages дозволяє браузерам
// тримати файли 10 хвилин, і без версії після оновлення хтось бачив би новий HTML зі старим JS.
//
// Локально: node scripts/build.mjs, потім, напр., python -m http.server -d _site

import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, '_site');
// що не публікуємо: службове, бекенд, сам збирач (усе з крапкою на початку теж)
const PRIVATE = new Set(['_site', 'scripts', 'apps-script', 'pages', 'docs', 'README.md', 'node_modules']);

const read = file => readFileSync(join(ROOT, file), 'utf8');
const pick = (text, re, what) => {
  const m = text.match(re);
  if (!m) throw new Error(`Не знайшов ${what}`);
  return m[1].trim();
};

// версія кожного стилю й скрипта — перші символи хешу вмісту: змінився файл — змінилась адреса
const versioned = html => html.replace(/(href|src)="((?:styles\.css)|(?:js\/[\w-]+\.js))"/g, (all, attr, file) =>
  `${attr}="${file}?v=${createHash('sha256').update(readFileSync(join(ROOT, file))).digest('hex').slice(0, 10)}"`);

// let: контакти в чаті збирач замінює тими, що на сторінці «Контакти» (див. chatFromContacts)
let template = versioned(read('index.html'));
const SITE = 'https://' + read('CNAME').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
// лише справжній тег на початку рядка, а не згадки в коментарях
const BRAND = /^(\s*)<h1 class="brand">(.*?)<\/h1>/m;
const NAME = pick(template, /^\s*<h1 class="brand">(.*?)<\/h1>/m, '<h1 class="brand"> з назвою магазину в index.html');
const HOME_TITLE = pick(template, /<title>([\s\S]*?)<\/title>/, '<title> в index.html');
const DESCRIPTION = pick(template, /<meta name="description" content="([^"]*)">/, 'meta description в index.html');
const API_URL = pick(read('js/catalog.js'), /const API_URL = '([^']+)'/, 'API_URL в js/catalog.js');

// ---------- дрібниці ----------
const esc = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const money = n => n.toLocaleString('uk-UA') + ' грн';
// Фото з Google Диску — пряма адреса, куди Диск переадресовує свої мініатюри. Саму drive.google.com/thumbnail
// роботам Google заборонено читати (robots.txt Диску), тож для пошуку, прев'ю й Merchant Center — лише ця
const photoUrl = (id, width) => `https://lh3.googleusercontent.com/d/${encodeURIComponent(id)}=w${width}`;
const isUsed = b => !!b.condition && !/^нов/i.test(b.condition);
const discount = b => b.oldPrice > b.price ? Math.round((1 - b.price / b.oldPrice) * 100) : 0;
const paragraphs = text => String(text || '').split(/\n+/).map(s => s.trim()).filter(Boolean);
// опис для Google: до ~155 знаків, обрізаємо по слову
const clip = (text, max = 155) => {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return t.slice(0, max).replace(/\s+\S*$/, '') + '…';
};
const bookUrl = b => `${SITE}/book/${encodeURIComponent(b.id)}/`;

async function fetchCatalog() {
  // Apps Script інколи відповідає з затримкою або помилкою — пробуємо кілька разів
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(API_URL, { redirect: 'follow' });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'каталог повернув помилку');
      return data;
    } catch (err) {
      if (attempt >= 3) throw new Error(`Не вдалося отримати каталог: ${err.message}`);
      console.warn(`Спроба ${attempt}: ${err.message}. Ще раз…`);
      await new Promise(r => setTimeout(r, 5000 * attempt));
    }
  }
}

// ---------- шапка сторінки: адреса, прев'ю, розмітка ----------
function seo({ url, title, description, image, imageAlt, data, noindex }) {
  if (noindex) return '<meta name="robots" content="noindex">';
  const own = image ? [] : [
    '<meta property="og:image:width" content="1200">',
    '<meta property="og:image:height" content="630">',
  ];
  return [
    `<link rel="canonical" href="${esc(url)}">`,
    '<meta property="og:type" content="website">',
    `<meta property="og:site_name" content="${esc(NAME)}">`,
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(description)}">`,
    `<meta property="og:url" content="${esc(url)}">`,
    `<meta property="og:image" content="${esc(image || SITE + '/og-image.jpg')}">`,
    ...own,
    `<meta property="og:image:alt" content="${esc(imageAlt || NAME)}">`,
    '<meta property="og:locale" content="uk_UA">',
    '<meta name="twitter:card" content="summary_large_image">',
    // «<» у JSON усередині <script> екрануємо, щоб текст з таблиці не міг закрити тег
    data && `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`,
  ].filter(Boolean).join('\n');
}

// Сторінка з шаблону index.html: свої назва, опис, шапка для пошуковиків і (для книги) сама книга
// nested — сторінка глибше кореня без власного заголовка (сторінки каталогу 2, 3…): лише <base>, назва магазину лишається <h1>;
// ownH1 — сторінка глибше кореня зі своїм <h1> (добірка): назва магазину стає посиланням на головну
function page({ html: base = template, title, description, head, book, bodyData, nested, ownH1 }) {
  let html = base
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(title)}</title>`)
    .replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${esc(description)}">`)
    .replace(/<!-- seo:[\s\S]*?-->/, head);
  // сторінки глибше кореня: відносні адреси (фото, іконки, стилі) мають іти від кореня сайту
  if (book || nested || ownH1) html = html.replace('<meta charset="utf-8">', '<meta charset="utf-8">\n<base href="/">');
  // головний заголовок сторінки — назва книги (добірки), а назва магазину стає посиланням на головну
  if (book || ownH1) html = html.replace(BRAND, '$1<a class="brand" href="/">$2</a>');
  if (book) html = html.replace(/<!-- book:[\s\S]*?-->/, book);
  if (bodyData) html = html.replace('<body>', `<body ${bodyData}>`);
  return html;
}

// ---------- книга ----------
function priceLines(b) {
  const off = discount(b);
  const was = off
    ? `<div class="was"><s><span class="sr-only">Звичайна ціна: </span>${money(b.oldPrice)}</s><span class="off">−${off}%</span></div>`
    : '';
  const price = off
    ? `<div class="price sale"><span class="sr-only">Ціна зі знижкою: </span>${money(b.price)}</div>`
    : `<div class="price">${money(b.price)}</div>`;
  return was + price;
}

// Розмітка — як у картці книги (openBook і bookFacts у js/book.js): ліворуч книга й покупка, праворуч текст
function bookArticle(b) {
  const photo = b.photos?.[0];
  const facts = [['Мова', b.language], ['Стан', b.condition], ['Рік видання', b.year], ['Сторінок', b.pages],
    ['Видавництво', b.publisher], ['Палітурка', b.binding], ['ISBN', b.isbn]]
    .filter(([, v]) => v)
    .map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('');
  const desc = paragraphs(b.description).map(p => `<p>${esc(p)}</p>`).join('');
  const crumbs = categoryLineage(b.category)
    .map(name => `<a href="/#cat=${encodeURIComponent(name)}">${esc(name)}</a>`).join('<span class="sep">›</span>');
  return `<a class="back glass" href="/"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 6-6 6 6 6"/></svg>Усі книги</a>
  <article class="book-page glass">
    <div class="page-side"><div class="page-hold">
      <div class="page-photo">${photo
        ? `<img src="${photoUrl(photo, 800)}" alt="${esc(b.title)}" referrerpolicy="no-referrer">`
        // без фото — тканинна палітурка, як на вітрині і в картці (paintCloth у js/catalog.js)
        : clothCover(b, 'cover blank big')}</div>
      <div class="page-buy"><div id="pagePrice">${priceLines(b)}</div><div id="pageCtrl"></div></div>
    </div></div>
    <div class="page-text">
      ${crumbs ? `<nav class="crumbs" aria-label="Категорія">${crumbs}</nav>` : ''}
      <h1>${esc(b.title)}</h1>
      ${b.author ? `<p class="book-by">${esc(b.author)}</p>` : ''}
      ${facts ? `<dl class="facts">${facts}</dl>` : ''}
      ${desc ? `<div class="desc">${desc}</div>` : ''}
      <aside class="ask" id="pageAsk" hidden></aside>
    </div>
  </article>`;
}

function bookDescription(b) {
  const text = paragraphs(b.description).join(' ');
  if (text) return clip(text);
  const parts = [
    `«${b.title}»` + (b.author ? ` — ${b.author}` : '') + (b.year ? `, ${b.year}` : '') + '.',
    b.condition && `Стан: ${b.condition.toLowerCase()}.`,
    b.binding && `Палітурка: ${b.binding.toLowerCase()}.`,
    `Ціна ${money(b.price)}. Доставка по Україні.`,
  ];
  return clip(parts.filter(Boolean).join(' '));
}

// ISBN → 13 цифр (так Google чекає GTIN книги) або null, якщо номер з помилкою.
// ISBN-10 перераховуємо в 13: «978» + перші 9 цифр + нова контрольна
function isbn13(raw) {
  const s = String(raw || '').toUpperCase().replace(/[^\dX]/g, '');
  const check13 = d => (10 - [...d].reduce((sum, c, i) => sum + Number(c) * (i % 2 ? 3 : 1), 0) % 10) % 10;
  if (/^\d{13}$/.test(s)) return check13(s.slice(0, 12)) === Number(s[12]) ? s : null;
  if (/^\d{9}[\dX]$/.test(s)) {
    const sum = [...s].reduce((acc, c, i) => acc + (c === 'X' ? 10 : Number(c)) * (10 - i), 0);
    if (sum % 11) return null;
    const d = '978' + s.slice(0, 9);
    return d + check13(d);
  }
  return null;
}

// Розмітка товару для Google: книга з ціною, наявністю і станом
function bookData(b) {
  const formats = { 'тверда': 'https://schema.org/Hardcover', 'суперобкладинка': 'https://schema.org/Hardcover', 'м’яка': 'https://schema.org/Paperback', "м'яка": 'https://schema.org/Paperback' };
  const data = {
    '@context': 'https://schema.org',
    '@type': ['Book', 'Product'],
    name: b.title,
    url: bookUrl(b),
    sku: b.id,
    isbn: b.gtin || undefined,
    gtin13: b.gtin || undefined,
    description: paragraphs(b.description).join(' ') || undefined,
    image: b.photos?.length ? b.photos.map(id => photoUrl(id, 1200)) : undefined,
    author: b.author ? { '@type': 'Person', name: b.author } : undefined,
    publisher: b.publisher ? { '@type': 'Organization', name: b.publisher } : undefined,
    inLanguage: b.language || undefined,
    numberOfPages: Number(b.pages) || undefined,
    datePublished: /^\d{4}$/.test(b.year) ? b.year : undefined,
    bookFormat: formats[(b.binding || '').toLowerCase()],
    offers: {
      '@type': 'Offer',
      url: bookUrl(b),
      price: b.price,
      priceCurrency: 'UAH',
      // немає в наявності, але можна передзамовити
      availability: b.stock > 0 ? 'https://schema.org/InStock' : 'https://schema.org/PreOrder',
      itemCondition: isUsed(b) ? 'https://schema.org/UsedCondition' : 'https://schema.org/NewCondition',
      seller: { '@type': 'Organization', name: NAME },
    },
  };
  return JSON.parse(JSON.stringify(data)); // прибрати порожні (undefined) поля
}

// ---------- текстові сторінки (доставка, повернення, контакти) ----------
// Текст — з Google Документа (див. «Сторінки сайту» в apps-script/Code.gs), а якщо документа немає
// або він не відкрився — з файлу pages/<адреса>.html. Тож кожна сторінка має й файл: він визначає її адресу
// і лишається запасним текстом. Назва сторінки — з <h1>, опис для Google — з першого абзацу.
// <mark class="todo"> у файлі — ще не заповнене: сторінка все одно збирається, але з попередженням
const BACK = '<a class="back glass" href="/"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 6-6 6 6 6"/></svg>Усі книги</a>';
const plain = html => html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
  .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// Тексти з документів: { адреса: { name, blocks } | { error } }. Не вдалося — збираємо з файлів, сайт не падає
async function fetchDocPages() {
  try {
    const res = await fetch(API_URL + '?pages=1', { redirect: 'follow' });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'скрипт повернув помилку');
    // стара версія скрипта не знає ?pages=1 і віддає каталог — тоді документів просто ще немає
    return data.pages || {};
  } catch (err) {
    console.warn(`::warning::Тексти сторінок з Google Документів не отримано (${err.message}) — беру з pages/`);
    return {};
  }
}

const SITE_HOST = new URL(SITE).hostname.replace(/^www\./, '');
// Посилання з документа: лише http(s), пошта й телефон; на свій сайт — коротким шляхом (/kontakty/)
function safeLink(url) {
  url = String(url || '').trim();
  if (!url || url.startsWith('#')) return ''; // закладки й заголовки всередині документа
  if (/^(mailto|tel):/i.test(url)) return url;
  let u;
  try { u = new URL(/^[a-z][\w+.-]*:/i.test(url) ? url : 'https://' + url); } catch { return ''; }
  if (!/^https?:$/.test(u.protocol)) return '';
  if (u.hostname.replace(/^www\./, '') === SITE_HOST) return (u.pathname + u.search + u.hash) || '/';
  return u.href;
}
const anchor = (href, inner) => href.startsWith('/') || /^(mailto|tel):/i.test(href)
  ? `<a href="${esc(href)}">${inner}</a>`
  : `<a href="${esc(href)}" target="_blank" rel="noopener">${inner}</a>`;
// розрив рядка всередині абзацу (Shift+Enter) Документи передають як \v
const escText = s => esc(s).replace(/\r\n|[\v\r\n\u2028]/g, '<br>');
// Телефон, пошта, адреса сайту й @нік у Telegram, які в документі написані просто текстом, стають посиланнями
const AUTO_LINK = /([\w.+-]+@[\w-]+(?:\.[\w-]+)+)|(https?:\/\/[^\s<>"]*[^\s<>".,;:!?)»])|((?<![\w+])(?:\+\s?)?(?:38[\s-]?)?\(?0\d{2}\)?(?:[\s-]?\d){7}(?!\d))|((?<![\w@.])@[A-Za-z]\w{4,31}\b)/g;
function autolink(text) {
  let out = '', last = 0;
  for (const m of text.matchAll(AUTO_LINK)) {
    const [all, email, url, phone, tg] = m;
    let href;
    if (email) href = 'mailto:' + email;
    else if (url) href = safeLink(url);
    else if (phone) {
      const d = phone.replace(/\D/g, '');
      href = 'tel:+' + (d.startsWith('380') ? d : '38' + d);
    } else if (tg) href = 'https://t.me/' + tg.slice(1);
    if (!href) continue;
    out += escText(text.slice(last, m.index)) + anchor(href, esc(all));
    last = m.index + all.length;
  }
  return out + escText(text.slice(last));
}
// Абзац: сусідні шматки з тим самим посиланням — одне посилання; жирний і курсив — <b> і <i>
function inline(runs) {
  const groups = [];
  for (const r of runs) {
    const link = safeLink(r.link);
    const g = groups.at(-1);
    if (g && g.link === link) g.runs.push(r);
    else groups.push({ link, runs: [r] });
  }
  return groups.map(g => {
    const inner = g.runs.map(r => {
      let h = g.link ? escText(r.text) : autolink(r.text);
      if (r.italic) h = `<i>${h}</i>`;
      if (r.bold) h = `<b>${h}</b>`;
      return h;
    }).join('').replace(/<\/b><b>|<\/i><i>/g, '');
    return g.link ? anchor(g.link, inner) : inner;
  }).join('').trim();
}
// Пункти списку підряд — один список (з вкладеними за рівнем)
function listHtml(items) {
  let html = '';
  const stack = []; // відкриті списки: { tag, level }
  for (const it of items) {
    const level = it.level || 0, tag = it.ordered ? 'ol' : 'ul';
    while (stack.length && stack.at(-1).level > level) html += `</li></${stack.pop().tag}>`;
    if (stack.length && stack.at(-1).level === level) {
      html += stack.at(-1).tag === tag ? '</li>\n' : `</li></${stack.pop().tag}>\n`;
    }
    if (!stack.length || stack.at(-1).level < level) {
      html += `<${tag}>\n`;
      stack.push({ tag, level });
    }
    html += `  <li>${inline(it.runs)}`;
  }
  while (stack.length) html += `</li>\n</${stack.pop().tag}>`;
  return html;
}
// Документ → HTML сторінки. Перший заголовок («Назва» чи «Заголовок 1») — <h1>; немає — назва документа.
// «Заголовок 2» — розділ (<h2>), «Заголовок 3» і нижче — <h3>; порожні абзаци пропускаємо
function docHtml(doc) {
  const out = [];
  let h1 = '';
  const blocks = doc.blocks.filter(b => b.runs.some(r => r.text.trim()));
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type === 'li') {
      const items = [b];
      while (blocks[i + 1]?.type === 'li' && (blocks[i + 1].level || blocks[i + 1].list === b.list)) items.push(blocks[++i]);
      out.push(listHtml(items));
      continue;
    }
    const text = inline(b.runs);
    if ((b.type === 'title' || b.type === 'h1') && !h1) h1 = text;
    else if (b.type === 'title' || b.type === 'h1' || b.type === 'h2') out.push(`<h2>${text}</h2>`);
    else if (b.type === 'h3') out.push(`<h3>${text}</h3>`);
    else out.push(`<p>${text}</p>`);
  }
  if (!out.length) return '';
  return `<h1>${h1 || esc(doc.name)}</h1>\n\n` + out.join('\n');
}

const docPages = await fetchDocPages();
const textPages = readdirSync(join(ROOT, 'pages')).filter(f => f.endsWith('.html')).map(file => {
  const slug = file.replace(/\.html$/, '');
  const doc = docPages[slug];
  let body = read(join('pages', file)).replace(/<!--[\s\S]*?-->/g, '').trim();
  if (doc?.error) console.warn(`::warning::${slug}: документ не відкрився (${doc.error}) — беру pages/${file}`);
  else if (doc?.blocks) {
    const html = docHtml(doc);
    if (html) { body = html; console.log(`${slug}: текст з документа «${doc.name}»`); }
    else console.warn(`::warning::${slug}: документ «${doc.name}» порожній — беру pages/${file}`);
  }
  const h1 = plain(pick(body, /<h1>([\s\S]*?)<\/h1>/, `<h1> у pages/${file}`));
  const first = body.match(/<p>([\s\S]*?)<\/p>/);
  const todo = (body.match(/class="todo"/g) || []).length;
  if (todo) console.warn(`::warning::pages/${file}: не заповнено місць — ${todo} (позначки <mark class="todo">)`);
  return { slug, file, h1, body, description: clip(first ? plain(first[1]) : h1), todo };
});

// ---------- чат «Напишіть нам»: Telegram, пошта й години — зі сторінки «Контакти» ----------
// В index.html чат має свої контакти (з ними сайт працює й без збирача), а збирач підставляє ті, що зараз
// на сторінці «Контакти». Тож міняти їх треба в одному місці — у документі «Контакти» (чи pages/kontakty.html).
// Береться перше посилання на Telegram (t.me) і перша пошта; години — абзац, що починається з «Відповідаємо».
// Чого на сторінці немає — того пункту в чаті теж немає
function chatFromContacts(html, body) {
  const chat = html.match(/<div class="chat" id="chat">[\s\S]*?<\/div>\s*<button/);
  if (!chat) {
    console.warn('::warning::Чат у index.html не знайдено — контакти в ньому не оновлено');
    return html;
  }
  const hrefs = [...body.matchAll(/<a href="([^"]+)"/g)].map(m => m[1].replace(/&amp;/g, '&'));
  const tg = hrefs.find(h => /^https:\/\/t\.me\/\w/i.test(h));
  const mail = hrefs.find(h => /^mailto:[^@\s]+@/i.test(h));
  if (!tg && !mail) {
    console.warn('::warning::На сторінці «Контакти» немає ні Telegram, ні пошти — у чаті лишаються контакти з index.html');
    return html;
  }
  const hours = [...body.matchAll(/<p>([\s\S]*?)<\/p>/g)].map(m => plain(m[1])).find(t => /^Відповіда/i.test(t));
  let block = chat[0];
  // пункт меню: <a href="…"> … <small>підпис</small> … </a>
  const item = (re, href, label) => {
    block = href
      ? block.replace(re, (all, open, mid, close) => `${open}${esc(href)}${mid}${esc(label)}${close}`)
      : block.replace(new RegExp(String.raw`\s*` + re.source.replace(/\(|\)/g, '') + String.raw`[\s\S]*?</a>`), '');
  };
  item(/(<a href=")https:\/\/t\.me\/[^"]*("[\s\S]*?<small>)[^<]*(<\/small>)/, tg,
    tg && '@' + tg.replace(/^https:\/\/t\.me\//i, '').replace(/[/?#].*/, ''));
  item(/(<a href=")mailto:[^"]*("[\s\S]*?<small>)[^<]*(<\/small>)/, mail,
    mail && decodeURIComponent(mail.replace(/^mailto:/i, '').replace(/\?.*/, '')));
  block = block.replace(/(<p class="chat-title">[^<]*)<small>[^<]*<\/small>/, (all, title) =>
    hours ? `${title}<small>${esc(hours.replace(/\.$/, ''))}</small>` : title);
  return html.replace(chat[0], () => block);
}
const contactsPage = textPages.find(p => p.slug === 'kontakty');
if (contactsPage) template = chatFromContacts(template, contactsPage.body);

// ---------- збирання ----------
const catalog = await fetchCatalog();
// шлях категорії від верхнього рівня: ['Богослов'я', 'Етика']; захист від кола в аркуші «Категорії»
const parentOf = new Map((catalog.categories || []).map(c => [String(c.name || '').trim(), String(c.parent || '').trim()]));
function categoryLineage(name) {
  const path = [];
  for (let n = name; n && !path.includes(n); n = parentOf.get(n)) path.unshift(n);
  return path;
}
const seen = new Set();
const books = catalog.books.filter(b => {
  // номер книги стає частиною адреси — дозволяємо лише безпечні символи
  if (!/^[\p{L}\p{N}_-]+$/u.test(b.id)) {
    console.warn(`::warning::Пропускаю книгу «${b.title}» з номером «${b.id}»: такий номер не годиться для адреси сторінки`);
    return false;
  }
  // однаковий № у двох книг — і сторінка одна, і кошик їх плутає; лишаємо першу, решту треба перенумерувати в таблиці
  if (seen.has(b.id)) {
    console.warn(`::warning::Номер ${b.id} у таблиці повторюється («${b.title}») — дайте книзі інший номер`);
    return false;
  }
  seen.add(b.id);
  if (b.isbn) {
    b.gtin = isbn13(b.isbn);
    if (!b.gtin) console.warn(`::warning::ISBN «${b.isbn}» у книги №${b.id} («${b.title}») з помилкою — перевірте цифри`);
  }
  return true;
});

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT);
for (const name of readdirSync(ROOT)) {
  if (name.startsWith('.') || PRIVATE.has(name)) continue;
  cpSync(join(ROOT, name), join(OUT, name), { recursive: true });
}

const store = {
  '@context': 'https://schema.org',
  '@type': 'OnlineStore',
  name: NAME,
  url: SITE + '/',
  logo: SITE + '/apple-touch-icon.png',
  image: SITE + '/og-image.jpg',
  description: DESCRIPTION,
  areaServed: 'UA',
  currenciesAccepted: 'UAH',
};

// ---------- перші книги каталогу прямо в HTML головної ----------
// Google бачить книги й посилання на їхні сторінки без JavaScript, а покупець — книги замість заглушок,
// поки скрипт вантажить каталог; тоді скрипт малює список наново (js/catalog.js, init).
// Розмітка — та сама, що в bookRow/bookCover (js/catalog.js) для вітрини: міняєте там — міняйте й тут
// Як у js/catalog.js (CLOTHS, LOOKS, clothOf) — міняєте там, міняйте й тут.
// Тканинні палітурки книг без фото: [тканина, тиснення, світла тканина?] і оформлення обкладинки.
// Книга завжди отримує ту саму пару «тканина + оформлення» — за номером
const CLOTHS = [
  ['#232427', '#d2b36e'], // майже чорна, тиснення золотом
  ['#34383d', '#c9a964'], // графіт, тиснення золотом
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
// тканинна палітурка книги без фото — як paintCloth у js/catalog.js
function clothCover(b, cls, badges = '') {
  const { cloth, stamp, tone, look } = clothOf(b.id);
  return `<div class="${cls}" aria-hidden="true" data-tone="${tone}" data-look="${look}" style="--cloth: ${cloth}; --stamp: ${stamp};">` +
    `<span class="cover-letter">${esc((b.title || '').trim().charAt(0).toUpperCase())}</span>` +
    `<span class="cover-title">${esc(b.title)}</span><span class="cover-author">${esc(b.author || '')}</span>${badges}</div>`;
}
const plural = (n, one, few, many) => {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};
function staticRow(b) {
  const off = discount(b);
  const badges = (isUsed(b) ? `<span class="cond">${esc(b.condition)}</span>` : '') +
    (off ? `<span class="ribbon">−${off}%</span>` : '');
  const photo = b.photos?.[0];
  let cover;
  if (photo) {
    const img = cls => `<img class="${cls}" src="${photoUrl(photo, 480)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">`;
    cover = `<div class="cover photo" aria-hidden="true">${img('cover-bg')}${img('cover-img')}${badges}</div>`;
  } else {
    cover = clothCover(b, 'cover blank', badges);
  }
  // як у bookRow (js/catalog.js): лише автор, без року й сторінок
  const by = (b.author ? `<span class="author">${esc(b.author)}</span>` : '') +
    (isUsed(b) ? `<span class="sr-only">, стан: ${esc(b.condition)}</span>` : '');
  return `<li class="row" data-id="${esc(b.id)}">${cover}` +
    `<div class="info"><a class="title" href="/book/${encodeURIComponent(b.id)}/">${esc(b.title)}</a><div class="byline">${by}</div></div>` +
    `<div class="pricebox">${priceLines(b)}</div><div class="ctrl"></div></li>`;
}
// Сторінки каталогу: головна — перша, далі /storinka/2/, /storinka/3/… по 50 книг, з перемикачем під ними.
// Порядок «Нові надходження», як у скрипта: більший № — новіша книга. Беремо весь каталог, а не лише книги зі сторінками.
// Номери в перемикачі й розмітка — як у pagerItems/renderPager (js/catalog.js)
const PAGE = 50;
const sorted = [...catalog.books].sort((a, b) => (Number(b.id) || 0) - (Number(a.id) || 0));
const total = sorted.length;
const pageCount = Math.max(1, Math.ceil(total / PAGE));
const pagePath = n => n > 1 ? `/storinka/${n}/` : '/';
const ARROW = dir => `<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="${dir < 0 ? 'm15 6-6 6 6 6' : 'm9 6 6 6-6 6'}" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
function pagerHtml(cur) {
  if (pageCount < 2) return '';
  const keep = new Set([1, pageCount, cur - 1, cur, cur + 1]);
  const items = [];
  for (let n = 1; n <= pageCount; n++) {
    if (keep.has(n)) items.push(n);
    else if (items.at(-1) !== '…') items.push('…');
  }
  const step = (n, dir) => {
    const inner = dir < 0 ? `${ARROW(dir)}<span class="label">Попередня</span>` : `<span class="label">Наступна</span>${ARROW(dir)}`;
    return n < 1 || n > pageCount
      ? `<span class="step" aria-disabled="true">${inner}</span>`
      : `<a class="step" href="${pagePath(n)}" rel="${dir < 0 ? 'prev' : 'next'}" aria-label="${dir < 0 ? 'Попередня' : 'Наступна'} сторінка">${inner}</a>`;
  };
  return step(cur - 1, -1) + items.map(n => n === '…' ? '<span class="gap">…</span>'
    : n === cur ? `<span class="num" aria-current="page">${n}</span>`
    : `<a class="num" href="${pagePath(n)}" aria-label="Сторінка ${n}">${n}</a>`).join('') + step(cur + 1, 1);
}
const countText = n => `${n} ${plural(n, 'книга', 'книги', 'книг')}`;

// ---------- Добірки ----------
// Як у js/collections.js: адреса /dobirka/<адреса>/, книги в порядку аркуша, лише ті, що є на сайті.
// Розмітка полиць і заголовка добірки — та сама, що в shelf/renderIntro там: міняєте тут — міняйте й там
const catalogById = new Map(catalog.books.map(b => [b.id, b]));
const collections = (catalog.collections || []).filter(c => {
  if (/^[a-z0-9-]+$/.test(c.slug || '')) return true;
  console.warn(`::warning::Пропускаю добірку «${c.name}» з адресою «${c.slug}»: адреса — лише латинські літери, цифри й дефіс`);
  return false;
}).map(c => ({ ...c, list: (c.books || []).map(id => catalogById.get(id)).filter(Boolean) }))
  .filter(c => c.list.length);
const SHELF_MAX = 12; // як у js/collections.js
const SHELVES = 1; // полиць на головній — перші добірки з аркуша; як у js/collections.js
const collUrl = c => `${SITE}/dobirka/${c.slug}/`;
const descParas = c => paragraphs(c.description);
function shelfHtml(c) {
  const n = c.list.length;
  const href = `/dobirka/${c.slug}/`;
  const more = n > SHELF_MAX
    ? `<li class="shelf-more"><a href="${href}"><b>Ще ${n - SHELF_MAX}</b><span>Уся добірка</span>${ARROW(1)}</a></li>` : '';
  return `<section class="shelf glass" aria-labelledby="shelf-${c.slug}"><div class="shelf-head">` +
    `<h2 class="shelf-title" id="shelf-${c.slug}"><a href="${href}">${esc(c.name)}</a></h2>` +
    `<a class="shelf-all" href="${href}" aria-label="Усі ${countText(n)} добірки «${esc(c.name)}»">Усі ${countText(n)}${ARROW(1)}</a></div>` +
    // на вітрині лише назва; опис (якщо є в аркуші) — на сторінці добірки
    `<ul class="shelf-row grid">${c.list.slice(0, SHELF_MAX).map(staticRow).join('')}${more}</ul></section>`;
}
const collIntroHtml = c => `<div class="coll-intro" id="collIntro"><a class="back glass" href="/">${ARROW(-1)}Усі книги</a>` +
  `<section class="coll-head glass"><p class="coll-kicker">Добірка</p><h1>${esc(c.name)}</h1>` +
  descParas(c).map(p => `<p class="coll-desc">${esc(p)}</p>`).join('') + '</section></div>';

const catalogPages = [];
for (let n = 1; n <= pageCount; n++) {
  const rows = sorted.slice((n - 1) * PAGE, n * PAGE);
  let html = template
    .replace('<ul class="list" id="list"></ul>', `<ul class="list grid" id="list">\n${rows.map(staticRow).join('\n')}\n  </ul>`)
    .replace('<div class="count" id="count">&nbsp;</div>', `<div class="count" id="count">${countText(total)}</div>`)
    .replace(/<nav class="pager" id="pager"([^>]*) hidden><\/nav>/, (all, attrs) => `<nav class="pager" id="pager"${attrs}>${pagerHtml(n)}</nav>`);
  if (!html.includes('<ul class="list grid" id="list">') || !html.includes('<nav class="pager" id="pager"')) {
    throw new Error('Не знайшов у index.html місце для каталогу чи перемикача сторінок (id="list", id="pager")');
  }
  if (n === 1 && collections.length) {
    html = html.replace('<div class="shelves" id="shelves" hidden></div>',
      `<div class="shelves" id="shelves">${collections.slice(0, SHELVES).map(shelfHtml).join('\n')}</div>`);
    if (!html.includes('<div class="shelves" id="shelves">')) throw new Error('Не знайшов у index.html місце для полиць добірок (id="shelves")');
  }
  const url = SITE + pagePath(n);
  const title = n > 1 ? `${HOME_TITLE} — сторінка ${n}` : HOME_TITLE;
  const description = n > 1 ? `Сторінка ${n} з ${pageCount}. ${DESCRIPTION}` : DESCRIPTION;
  const out = n > 1 ? join(OUT, 'storinka', String(n)) : OUT;
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'index.html'), page({
    html,
    title,
    description,
    // кожна сторінка — сама собі канонічна: на ній інші книги, ніж на головній
    head: seo({ url, title: n > 1 ? `${NAME} — сторінка ${n}` : NAME, description, data: n > 1 ? undefined : store }),
    nested: n > 1,
  }));
  if (n > 1) catalogPages.push(url);
}

// Сторінка добірки: каталог лише з її книгами (у порядку аркуша, усі на одній сторінці) і її назва з описом згори
for (const c of collections) {
  const url = collUrl(c);
  const n = c.list.length;
  const description = clip(descParas(c).join(' ') ||
    `Добірка «${c.name}»: ${countText(n)} — ${c.list.slice(0, 3).map(b => `«${b.title}»`).join(', ')}${n > 3 ? '…' : '.'}`);
  const html = template
    .replace('<div class="coll-intro" id="collIntro" hidden></div>', collIntroHtml(c))
    .replace('<ul class="list" id="list"></ul>', `<ul class="list grid" id="list">\n${c.list.map(staticRow).join('\n')}\n  </ul>`)
    .replace('<div class="count" id="count">&nbsp;</div>', `<div class="count" id="count">${countText(n)}</div>`)
    // сортування «Як у добірці» тут вибране одразу — так, як покаже й скрипт
    .replace(/<li role="option" data-value="collection" hidden>(.*?)<\/li>/, '<li role="option" data-value="collection" aria-selected="true">$1</li>')
    .replace('<li role="option" data-value="newest" aria-selected="true">', '<li role="option" data-value="newest">')
    .replace(/(<span class="label" id="sortLabel">)[^<]*/, '$1Як у добірці');
  if (!html.includes('<div class="coll-intro" id="collIntro">')) throw new Error('Не знайшов у index.html місце для заголовка добірки (id="collIntro")');
  const cover = c.list.find(b => b.photos?.length);
  const dir = join(OUT, 'dobirka', c.slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), page({
    html,
    title: `${c.name} | ${NAME}`,
    description,
    head: seo({
      url, title: c.name, description,
      // прев'ю — обкладинка першої книги з фото; немає — загальна картинка магазину
      image: cover && photoUrl(cover.photos[0], 1200),
      imageAlt: c.name,
      data: {
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        name: c.name,
        url,
        description,
        isPartOf: { '@type': 'WebSite', name: NAME, url: SITE + '/' },
        mainEntity: {
          '@type': 'ItemList',
          numberOfItems: n,
          itemListElement: c.list.map((b, i) => ({ '@type': 'ListItem', position: i + 1, url: bookUrl(b), name: b.title })),
        },
      },
    }),
    ownH1: true,
  }));
}

// ---------- текстові сторінки: запис (тексти зібрано вище, перед збиранням) ----------
for (const p of textPages) {
  const url = `${SITE}/${p.slug}/`;
  let html = page({
    title: `${p.h1} | ${NAME}`,
    description: p.description,
    head: seo({
      url, title: p.h1, description: p.description,
      data: { '@context': 'https://schema.org', '@type': 'WebPage', name: p.h1, url, isPartOf: { '@type': 'WebSite', name: NAME, url: SITE + '/' } },
    }),
    book: `${BACK}\n  <article class="text-page glass">\n${p.body}\n  </article>`,
    bodyData: 'data-page',
  });
  // у підвалі позначаємо, на якій сторінці ми зараз
  html = html.replace(`<a href="/${p.slug}/">`, `<a href="/${p.slug}/" aria-current="page">`);
  mkdirSync(join(OUT, p.slug), { recursive: true });
  writeFileSync(join(OUT, p.slug, 'index.html'), html);
}

// неіснуюча адреса (напр., сторінка проданої книги) — показуємо каталог, але просимо Google її не індексувати
writeFileSync(join(OUT, '404.html'), page({
  title: HOME_TITLE,
  description: DESCRIPTION,
  head: seo({ noindex: true }),
  book: '<p class="state">Такої сторінки немає — можливо, книгу вже продали. Ось увесь каталог.</p>',
}));

for (const b of books) {
  const dir = join(OUT, 'book', b.id);
  mkdirSync(dir, { recursive: true });
  const description = bookDescription(b);
  writeFileSync(join(dir, 'index.html'), page({
    title: `${b.title}${b.author ? ' — ' + b.author : ''} | ${NAME}`,
    description,
    head: seo({
      url: bookUrl(b),
      title: b.title + (b.author ? ' — ' + b.author : ''),
      description,
      image: b.photos?.[0] && photoUrl(b.photos[0], 1200),
      imageAlt: b.title,
      data: bookData(b),
    }),
    book: bookArticle(b),
    bodyData: `data-page data-book="${esc(b.id)}"`,
  }));
}

writeFileSync(join(OUT, 'sitemap.xml'), [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  `  <url><loc>${SITE}/</loc></url>`,
  ...catalogPages.map(url => `  <url><loc>${url}</loc></url>`),
  ...collections.map(c => `  <url><loc>${collUrl(c)}</loc></url>`),
  ...textPages.map(p => `  <url><loc>${SITE}/${p.slug}/</loc></url>`),
  ...books.map(b => `  <url><loc>${esc(bookUrl(b))}</loc></url>`),
  '</urlset>',
  '',
].join('\n'));

// ---------- файл товарів для Google Merchant Center ----------
// Формат — RSS 2.0 з полями Google (https://support.google.com/merchants/answer/7052112).
// Лише книги з фото: без фото Google товар не покаже. Решта додасться сама, коли з'являться фото
const categoryPath = name => categoryLineage(name).join(' > ');
const gPrice = n => `${n.toFixed(2)} UAH`;
// опис товару: без ціни й «доставки» — Google не приймає рекламних фраз в описі
const sentence = s => /[.!?…]$/.test(s) ? s : s + '.'; // «Бинцаровский Д.» — без другої крапки
const productText = b => paragraphs(b.description).join(' ') || [
  `«${b.title}»` + (b.author ? ` — ${b.author}` : ''),
  [b.publisher, b.year && b.year + ' р.', b.pages && b.pages + ' с.'].filter(Boolean).join(', '),
  b.language && `Мова: ${b.language.toLowerCase()}`,
  b.binding && `Палітурка: ${b.binding.toLowerCase()}`,
  b.condition && `Стан: ${b.condition.toLowerCase()}`,
].filter(Boolean).map(sentence).join(' ');
// Лише книги з фото і в наявності: передзамовлення Google вимагає з датою надходження, якої в таблиці немає
const products = books.filter(b => b.photos?.length && b.stock > 0).map(b => {
  const f = [
    ['g:id', b.id],
    // Google радить у назві книги — назву й автора
    ['g:title', (b.title + (b.author ? ' — ' + b.author : '')).slice(0, 150)],
    ['g:description', productText(b).slice(0, 5000)],
    ['g:link', bookUrl(b)],
    ['g:image_link', photoUrl(b.photos[0], 1200)],
    ...b.photos.slice(1, 11).map(id => ['g:additional_image_link', photoUrl(id, 1200)]),
    ['g:availability', 'in_stock'],
    // під акцію: звичайна ціна — price, акційна — sale_price
    ['g:price', gPrice(b.oldPrice > b.price ? b.oldPrice : b.price)],
    b.oldPrice > b.price && ['g:sale_price', gPrice(b.price)],
    ['g:condition', isUsed(b) ? 'used' : 'new'],
    b.gtin ? ['g:gtin', b.gtin] : ['g:identifier_exists', 'no'],
    b.publisher && ['g:brand', b.publisher.slice(0, 70)],
    ['g:google_product_category', '784'], // Media > Books
    b.category && ['g:product_type', categoryPath(b.category)],
  ].filter(Boolean);
  return '    <item>\n' + f.map(([k, v]) => `      <${k}>${esc(v)}</${k}>`).join('\n') + '\n    </item>';
});
writeFileSync(join(OUT, 'products.xml'), [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">',
  '  <channel>',
  `    <title>${esc(NAME)}</title>`,
  `    <link>${SITE}/</link>`,
  `    <description>${esc(DESCRIPTION)}</description>`,
  ...products,
  '  </channel>',
  '</rss>',
  '',
].join('\n'));

writeFileSync(join(OUT, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`);

console.log(`Готово: ${SITE} — головна, добірок ${collections.length} і ${books.length} сторінок книг у _site/; ` +
  `у файлі товарів для Google ${products.length} (решті бракує фото)`);
