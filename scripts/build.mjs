// Збирає сайт для GitHub Pages у папку _site (запускає GitHub Action, див. .github/workflows/pages.yml).
//
// Що робить:
//  - копіює файли сайту як є;
//  - бере каталог з Apps Script і для кожної книги в наявності робить сторінку /book/<№>/ —
//    з книгою вгорі й каталогом під нею, власною назвою, описом, прев'ю для месенджерів і розміткою товару для Google;
//  - на всі сторінки дописує адресу, прев'ю й розмітку магазину; робить sitemap.xml, robots.txt і 404.html.
//
// Звідки бере дані (окремих налаштувань немає — міняйте там, де це й так видно):
//  - домен сайту — файл CNAME;
//  - назва магазину — <h1 class="brand"> в index.html;
//  - назва вкладки й опис головної — <title> і <meta name="description"> в index.html;
//  - адреса каталогу — const API_URL в index.html.
//
// Локально: node scripts/build.mjs, потім, напр., python -m http.server -d _site

import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, '_site');
// що не публікуємо: службове, бекенд, сам збирач (усе з крапкою на початку теж)
const PRIVATE = new Set(['_site', 'scripts', 'apps-script', 'README.md', 'node_modules']);

const read = file => readFileSync(join(ROOT, file), 'utf8');
const pick = (text, re, what) => {
  const m = text.match(re);
  if (!m) throw new Error(`Не знайшов ${what}`);
  return m[1].trim();
};

const template = read('index.html');
const SITE = 'https://' + read('CNAME').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
// лише справжній тег на початку рядка, а не згадки в коментарях
const BRAND = /^(\s*)<h1 class="brand">(.*?)<\/h1>/m;
const NAME = pick(template, /^\s*<h1 class="brand">(.*?)<\/h1>/m, '<h1 class="brand"> з назвою магазину в index.html');
const HOME_TITLE = pick(template, /<title>([\s\S]*?)<\/title>/, '<title> в index.html');
const DESCRIPTION = pick(template, /<meta name="description" content="([^"]*)">/, 'meta description в index.html');
const API_URL = pick(template, /const API_URL = '([^']+)'/, 'API_URL в index.html');

// ---------- дрібниці ----------
const esc = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const money = n => n.toLocaleString('uk-UA') + ' грн';
const photoUrl = (id, width) => `https://drive.google.com/thumbnail?id=${encodeURIComponent(id)}&sz=w${width}`;
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
    `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`,
  ].join('\n');
}

// Сторінка з шаблону index.html: свої назва, опис, шапка для пошуковиків і (для книги) сама книга
function page({ title, description, head, book, bodyData }) {
  let html = template
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(title)}</title>`)
    .replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${esc(description)}">`)
    .replace(/<!-- seo:[\s\S]*?-->/, head);
  if (book) {
    // сторінки глибше кореня: відносні адреси (фото, іконки, стилі) мають іти від кореня сайту
    html = html
      .replace('<meta charset="utf-8">', '<meta charset="utf-8">\n<base href="/">')
      // головний заголовок сторінки — назва книги, а назва магазину стає посиланням на головну
      .replace(BRAND, '$1<a class="brand" href="/">$2</a>');
  }
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
  return was + price + `<div class="stock">в наявності: ${b.stock}</div>`;
}

function bookArticle(b) {
  const photo = b.photos?.[0];
  const meta = [b.year && b.year + ' р.', b.pages && b.pages + ' с.'].filter(Boolean).join(' · ');
  const by = (b.author ? `<span class="author">${esc(b.author)}</span>` : '') + (b.author && meta ? ' · ' : '') + esc(meta);
  const facts = [['Видавництво', b.publisher], ['Мова', b.language], ['Обкладинка', b.binding], ['Стан', b.condition]]
    .filter(([, v]) => v)
    .map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('');
  const desc = paragraphs(b.description).map(p => `<p>${esc(p)}</p>`).join('');
  return `<article class="book-page glass${photo ? '' : ' no-photo'}">
    ${photo ? `<div class="page-photo"><img src="${photoUrl(photo, 800)}" alt="${esc(b.title)}" referrerpolicy="no-referrer"></div>` : ''}
    <div class="page-text">
      <h1>${esc(b.title)}</h1>
      ${by ? `<p class="book-by">${by}</p>` : ''}
      ${facts ? `<dl class="facts">${facts}</dl>` : ''}
      ${desc ? `<div class="desc">${desc}</div>` : ''}
      <div class="page-buy"><div id="pagePrice">${priceLines(b)}</div><div id="pageCtrl"></div></div>
    </div>
  </article>`;
}

function bookDescription(b) {
  const text = paragraphs(b.description).join(' ');
  if (text) return clip(text);
  const parts = [
    `«${b.title}»` + (b.author ? ` — ${b.author}` : '') + (b.year ? `, ${b.year}` : '') + '.',
    b.condition && `Стан: ${b.condition.toLowerCase()}.`,
    b.binding && `Обкладинка: ${b.binding.toLowerCase()}.`,
    `Ціна ${money(b.price)}. Доставка по Україні.`,
  ];
  return clip(parts.filter(Boolean).join(' '));
}

// Розмітка товару для Google: книга з ціною, наявністю і станом
function bookData(b) {
  const formats = { 'тверда': 'https://schema.org/Hardcover', 'м’яка': 'https://schema.org/Paperback', "м'яка": 'https://schema.org/Paperback' };
  const data = {
    '@context': 'https://schema.org',
    '@type': ['Book', 'Product'],
    name: b.title,
    url: bookUrl(b),
    sku: b.id,
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
      availability: 'https://schema.org/InStock',
      itemCondition: isUsed(b) ? 'https://schema.org/UsedCondition' : 'https://schema.org/NewCondition',
      seller: { '@type': 'Organization', name: NAME },
    },
  };
  return JSON.parse(JSON.stringify(data)); // прибрати порожні (undefined) поля
}

// ---------- збирання ----------
const catalog = await fetchCatalog();
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

writeFileSync(join(OUT, 'index.html'), page({
  title: HOME_TITLE,
  description: DESCRIPTION,
  head: seo({ url: SITE + '/', title: NAME, description: DESCRIPTION, data: store }),
}));

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
    bodyData: `data-book="${esc(b.id)}"`,
  }));
}

writeFileSync(join(OUT, 'sitemap.xml'), [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  `  <url><loc>${SITE}/</loc></url>`,
  ...books.map(b => `  <url><loc>${esc(bookUrl(b))}</loc></url>`),
  '</urlset>',
  '',
].join('\n'));

writeFileSync(join(OUT, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`);

console.log(`Готово: ${SITE} — головна і ${books.length} сторінок книг у _site/`);
