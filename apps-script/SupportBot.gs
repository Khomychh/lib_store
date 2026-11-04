/**
 * Бот крамниці в Telegram: покупці пишуть боту, а не на особистий акаунт продавця.
 *
 *   покупець пише боту → бот пересилає повідомлення продавцю (уночі — без звуку)
 *                        і поза робочими годинами відповідає покупцю, коли чекати відповіді;
 *   продавець натискає «Відповісти» на пересланому повідомленні → бот надсилає відповідь покупцю
 *                        (текст, фото, файл — що завгодно) від свого імені. Особистий акаунт покупець не бачить.
 *
 * Вебхук не використовується: скрипт сам забирає нові повідомлення раз на хвилину (тригер за часом).
 * Так він не залежить від doPost (там замовлення з сайту) і від переадресації, яку Apps Script віддає на вебхуки.
 * Тому відповідь бота приходить із затримкою до хвилини.
 *
 * Листування пишеться в аркуш «Чат» таблиці замовлень — за ним бот знає, кому віддати відповідь продавця.
 *
 * Налаштування — Властивості скрипта (як і в Code.gs):
 *   SUPPORT_TOKEN — токен окремого бота для покупців (@BotFather → /newbot); обов'язково;
 *   SUPPORT_HOURS — робочі години, напр. «10:00-18:00» (типово так). Час — часовий пояс проєкту;
 *   SUPPORT_DAYS — робочі дні: 1 — понеділок … 7 — неділя, через дефіс чи кому: «1-5» (типово — будні), «1-6», «1-7»;
 *   SUPPORT_ADMIN_ID, SUPPORT_OFFSET — заповнює сам скрипт, руками не міняйте.
 * Запуск: функція supportSetup (див. docs/setup.md, крок «Бот для покупців»). Зупинити — supportStop.
 */

const SUPPORT_SHEET = 'Чат';
const SUPPORT_HEADERS = ['Дата', 'Від', 'Ім’я', 'Telegram', 'chat_id', 'Повідомлення', '№ у продавця'];
const SUPPORT_DEFAULT_HOURS = '10:00-18:00';
const SUPPORT_DEFAULT_DAYS = '1-5'; // понеділок — п'ятниця
// автовідповідь «відповімо зранку» — не частіше ніж раз на стільки годин одному покупцю
const SUPPORT_AWAY_EVERY_HOURS = 6;

const SUPPORT_TEXT = {
  start: 'Вітаємо в книжковій крамниці! Напишіть ваше питання — про книгу, замовлення чи доставку — і ми відповімо тут.',
  away: (days, hours) => `Дякуємо за повідомлення! Ми відповідаємо ${days} з ${hours.replace('-', ' до ')}, ` +
    'тож відповімо, щойно почнемо роботу.',
  adminStart: 'Готово: повідомлення покупців приходитимуть сюди. Щоб відповісти покупцю, натисніть «Відповісти» ' +
    'на його повідомленні й напишіть відповідь — бот надішле її від свого імені.',
  adminHint: 'Щоб відповісти покупцю, натисніть «Відповісти» саме на його пересланому повідомленні.',
  adminUnknown: 'Не знайшов, кому ця відповідь. Натисніть «Відповісти» саме на пересланому повідомленні покупця.',
  adminFailed: err => `⚠️ Відповідь не доставлено: ${err}`,
};

function supportProps_() { return PropertiesService.getScriptProperties(); }

function supportToken_() {
  const token = String(supportProps_().getProperty('SUPPORT_TOKEN') || '').trim();
  if (!token) throw new Error('Додайте SUPPORT_TOKEN (токен бота від @BotFather) у Властивості скрипта.');
  return token;
}

// Виклик Telegram Bot API; помилку Telegram перетворює на Error з його поясненням
function supportApi_(method, payload) {
  const res = UrlFetchApp.fetch(`https://api.telegram.org/bot${supportToken_()}/${method}`, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload || {}),
    muteHttpExceptions: true,
  });
  const data = JSON.parse(res.getContentText());
  if (!data.ok) throw new Error(`${method}: ${data.description || res.getResponseCode()}`);
  return data.result;
}

// ───────────── Запуск і зупинка (вручну з редактора) ─────────────

// 1) Напишіть своєму новому боту /start зі свого Telegram. 2) Запустіть цю функцію.
// Вона запам'ятає вас як продавця, вимкне вебхук (якщо був) і поставить перевірку раз на хвилину.
// Повторний запуск нічого не зламає; щоб змінити продавця — видаліть SUPPORT_ADMIN_ID і запустіть знову
function supportSetup() {
  const props = supportProps_();
  const me = supportApi_('getMe');
  // getUpdates не працює, поки в бота є вебхук
  supportApi_('deleteWebhook', { drop_pending_updates: false });

  if (!props.getProperty('SUPPORT_ADMIN_ID')) {
    const updates = supportApi_('getUpdates', { timeout: 0, allowed_updates: ['message'] });
    const mine = updates.map(u => u.message).filter(m => m && m.chat.type === 'private').pop();
    if (!mine) {
      throw new Error(`Спершу напишіть боту @${me.username} /start зі свого Telegram, потім запустіть supportSetup ще раз.`);
    }
    props.setProperty('SUPPORT_ADMIN_ID', String(mine.chat.id));
    // те, що вже було в черзі (ваш /start), не пересилати
    props.setProperty('SUPPORT_OFFSET', String(updates[updates.length - 1].update_id));
    supportApi_('sendMessage', { chat_id: mine.chat.id, text: SUPPORT_TEXT.adminStart });
    console.log(`Продавець: ${[mine.from.first_name, mine.from.last_name].filter(Boolean).join(' ')} (chat_id ${mine.chat.id})`);
  }

  // одна перевірка раз на хвилину; старі тригери цієї функції прибираємо, щоб не було двох
  supportStop();
  ScriptApp.newTrigger('supportPoll').timeBased().everyMinutes(1).create();
  supportSheet_();
  console.log(`Готово. Посилання на бота для сайту: https://t.me/${me.username}`);
}

// Зупиняє бота: прибирає перевірку раз на хвилину. Повідомлення покупців чекатимуть у Telegram до наступного supportSetup
function supportStop() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'supportPoll')
    .forEach(t => ScriptApp.deleteTrigger(t));
}

// ───────────── Робота: тригер викликає раз на хвилину ─────────────

function supportPoll() {
  // попередній запуск ще працює — цей пропускаємо, щоб не обробити повідомлення двічі
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) return;
  try {
    const props = supportProps_();
    const admin = props.getProperty('SUPPORT_ADMIN_ID');
    if (!admin) return;
    const offset = Number(props.getProperty('SUPPORT_OFFSET')) || 0;
    const updates = supportApi_('getUpdates', { offset: offset + 1, timeout: 0, limit: 100, allowed_updates: ['message'] });
    for (const u of updates) {
      try {
        if (u.message) supportHandle_(u.message, admin);
      } catch (err) {
        // одне невдале повідомлення (покупець заблокував бота тощо) не зупиняє решту
        console.error(err);
      }
      // зсуваємо після кожного: якщо запуск обірветься, оброблене не повториться
      props.setProperty('SUPPORT_OFFSET', String(u.update_id));
    }
  } finally {
    lock.releaseLock();
  }
}

function supportHandle_(msg, admin) {
  if (msg.chat.type !== 'private') return; // у групах бот не працює
  if (String(msg.chat.id) === admin) return supportFromAdmin_(msg, admin);

  const text = supportText_(msg);
  if (/^\/start\b/.test(msg.text || '')) {
    supportApi_('sendMessage', { chat_id: msg.chat.id, text: SUPPORT_TEXT.start });
    return;
  }
  const open = supportOpen_();
  // уночі — без звуку: повідомлення чекає продавця до ранку
  const fwd = supportApi_('forwardMessage', {
    chat_id: admin, from_chat_id: msg.chat.id, message_id: msg.message_id, disable_notification: !open,
  });
  supportLog_('Покупець', msg.from, msg.chat.id, text, fwd.message_id);

  if (!open) {
    const cache = CacheService.getScriptCache();
    const key = `away:${msg.chat.id}`;
    if (!cache.get(key)) {
      supportApi_('sendMessage', { chat_id: msg.chat.id, text: SUPPORT_TEXT.away(supportDays_().text, supportHours_().text) });
      cache.put(key, '1', SUPPORT_AWAY_EVERY_HOURS * 3600);
    }
  }
}

// Продавець відповідає на переслане повідомлення — бот копіює відповідь покупцю
function supportFromAdmin_(msg, admin) {
  if (/^\/start\b/.test(msg.text || '')) {
    supportApi_('sendMessage', { chat_id: admin, text: SUPPORT_TEXT.adminStart });
    return;
  }
  const replyTo = msg.reply_to_message;
  if (!replyTo) {
    supportApi_('sendMessage', { chat_id: admin, text: SUPPORT_TEXT.adminHint });
    return;
  }
  const customer = supportFindCustomer_(replyTo.message_id);
  if (!customer) {
    supportApi_('sendMessage', { chat_id: admin, text: SUPPORT_TEXT.adminUnknown, reply_parameters: { message_id: msg.message_id } });
    return;
  }
  try {
    supportApi_('copyMessage', { chat_id: customer.chatId, from_chat_id: admin, message_id: msg.message_id });
    supportLog_('Продавець', { first_name: '→ ' + customer.name }, customer.chatId, supportText_(msg), msg.message_id);
  } catch (err) {
    supportApi_('sendMessage', { chat_id: admin, text: SUPPORT_TEXT.adminFailed(err.message), reply_parameters: { message_id: msg.message_id } });
  }
}

// ───────────── Допоміжне ─────────────

// «10:00-18:00» з SUPPORT_HOURS; кривий запис — типові години
function supportHours_() {
  const raw = String(supportProps_().getProperty('SUPPORT_HOURS') || SUPPORT_DEFAULT_HOURS).trim();
  const m = raw.match(/^(\d{1,2})(?::(\d{2}))?\s*[-–—]\s*(\d{1,2})(?::(\d{2}))?$/);
  if (!m) return supportHoursFrom_(SUPPORT_DEFAULT_HOURS.match(/^(\d+):(\d+)-(\d+):(\d+)$/));
  return supportHoursFrom_(m);
}
function supportHoursFrom_(m) {
  const pad = n => String(n).padStart(2, '0');
  const from = `${pad(m[1])}:${m[2] || '00'}`;
  const to = `${pad(m[3])}:${m[4] || '00'}`;
  return { from, to, text: `${from}-${to}` };
}

// Робочі дні з SUPPORT_DAYS: { set: {1: true, …}, text: «в будні» }. 1 — понеділок … 7 — неділя
function supportDays_() {
  const raw = String(supportProps_().getProperty('SUPPORT_DAYS') || SUPPORT_DEFAULT_DAYS).trim();
  const set = {};
  raw.split(/[,;\s]+/).forEach(part => {
    const m = part.match(/^([1-7])(?:[-–—]([1-7]))?$/);
    if (!m) return;
    for (let d = Number(m[1]); d <= Number(m[2] || m[1]); d++) set[d] = true;
  });
  // нічого не розібрали — типові будні, щоб бот не вважав, що вихідні щодня
  if (!Object.keys(set).length) [1, 2, 3, 4, 5].forEach(d => { set[d] = true; });
  const key = Object.keys(set).join('');
  const NAMES = ['', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'нд'];
  const text = { 12345: 'в будні', 1234567: 'щодня', 123456: 'з понеділка по суботу' }[key] ||
    'у такі дні: ' + Object.keys(set).map(d => NAMES[d]).join(', ');
  return { set, text };
}

// Чи зараз робочий час (у часовому поясі проєкту): робочий день і робочі години.
// Години «через північ» (22:00-02:00): після півночі рахується день, коли зміна почалась
function supportOpen_() {
  const { from, to } = supportHours_();
  const { set } = supportDays_();
  const date = new Date();
  const tz = Session.getScriptTimeZone();
  const now = Utilities.formatDate(date, tz, 'HH:mm');
  const day = Number(Utilities.formatDate(date, tz, 'u')); // 1 — понеділок … 7 — неділя
  const yesterday = day === 1 ? 7 : day - 1;
  if (from <= to) return Boolean(set[day]) && now >= from && now < to;
  return (Boolean(set[day]) && now >= from) || (Boolean(set[yesterday]) && now < to);
}

// Що записати в аркуш: текст, підпис до фото чи вид вкладення
function supportText_(msg) {
  if (msg.text) return msg.text;
  const kind = ['photo', 'document', 'voice', 'video', 'sticker', 'audio', 'video_note', 'contact', 'location']
    .find(k => msg[k]);
  const label = { photo: 'фото', document: 'файл', voice: 'голосове', video: 'відео', sticker: 'стікер',
    audio: 'аудіо', video_note: 'відеоповідомлення', contact: 'контакт', location: 'геолокація' }[kind] || 'повідомлення';
  return `[${label}]` + (msg.caption ? ' ' + msg.caption : '');
}

function supportSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SUPPORT_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(SUPPORT_SHEET);
    sheet.appendRow(SUPPORT_HEADERS);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, SUPPORT_HEADERS.length).setFontWeight('bold');
    sheet.getRange('A:A').setNumberFormat('dd.MM.yyyy HH:mm');
    sheet.setColumnWidth(SUPPORT_HEADERS.indexOf('Повідомлення') + 1, 420);
    sheet.getRange('F:F').setWrap(true);
  }
  return sheet;
}

function supportLog_(who, from, chatId, text, adminMsgId) {
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ');
  const user = from.username ? '@' + from.username : '';
  // текст, що починається з = + - @, таблиця сприйняла б як формулу
  const safe = v => (/^[=+\-@]/.test(v) ? "'" + v : v);
  supportSheet_().appendRow([new Date(), who, safe(name), safe(user), "'" + chatId, safe(String(text).slice(0, 5000)), adminMsgId]);
}

// Покупець, якому належить переслане продавцю повідомлення (шукаємо за його номером у чаті продавця)
function supportFindCustomer_(adminMsgId) {
  const sheet = supportSheet_();
  const last = sheet.getLastRow();
  if (last < 2) return null;
  const rows = sheet.getRange(2, 1, last - 1, SUPPORT_HEADERS.length).getValues();
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i][1] === 'Покупець' && String(rows[i][6]) === String(adminMsgId)) {
      return { chatId: String(rows[i][4]).replace(/^'/, ''), name: String(rows[i][2]) };
    }
  }
  return null;
}
