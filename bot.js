/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

const TelegramBot = require('node-telegram-bot-api');
const Database = require('better-sqlite3');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const crypto = require('crypto');

dayjs.extend(utc);
dayjs.extend(timezone);

const TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(id => id.trim());
let APP_URL = (process.env.APP_URL || '').trim();
if (APP_URL.endsWith('/')) APP_URL = APP_URL.slice(0, -1);

const TZ = process.env.TZ || 'Europe/Moscow';

if (!TOKEN) {
  console.error('BOT_TOKEN is missing in ENV');
  process.exit(1);
}

// Database setup
const db = new Database('data.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    chatId TEXT PRIMARY KEY,
    fio TEXT,
    phone TEXT,
    registeredAt INTEGER,
    canRetry INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chatId TEXT,
    score INTEGER,
    total INTEGER,
    status TEXT,
    finishedAt INTEGER,
    details TEXT
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    chatId TEXT,
    createdAt INTEGER,
    submitted INTEGER DEFAULT 0,
    orderMap TEXT
  );
`);

const bot = new TelegramBot(TOKEN, { polling: process.env.DISABLE_POLLING !== 'true' });

if (process.env.DISABLE_POLLING === 'true') {
  console.log('⚠️ Бот запущен в режиме сервера (polling отключен для избежания конфликта 409)');
}

// Helper: Format Date
function fmtDate(ts) {
  if (!ts) return '—';
  return dayjs(ts).tz(TZ).format('DD.MM.YYYY HH:mm');
}

// Helper: Check if Admin
function isAdmin(chatId) {
  return ADMIN_IDS.includes(String(chatId));
}

// States for registration
const userStates = new Map();

// Bot Commands
bot.onText(/\/start/, async (msg) => {
  const chatId = String(msg.chat.id);
  const user = db.prepare('SELECT * FROM users WHERE chatId = ?').get(chatId);

  if (!user) {
    bot.sendMessage(chatId, '👋 Добро пожаловать! Для начала работы необходимо зарегистрироваться.\n\nВведите ваше **ФИО**:');
    userStates.set(chatId, { step: 'fio' });
  } else {
    showMainMenu(chatId);
  }
});

bot.onText(/\/admin/, (msg) => {
  if (isAdmin(msg.chat.id)) {
    showAdminPanel(msg.chat.id);
  }
});

// Handling messages (Registration & Admin Input)
bot.on('message', async (msg) => {
  const chatId = String(msg.chat.id);
  const text = msg.text;

  if (text && text.startsWith('/')) return;

  const state = userStates.get(chatId);
  if (!state) return;

  if (state.step === 'fio') {
    state.fio = text;
    state.step = 'phone';
    bot.sendMessage(chatId, `Приятно познакомиться, ${text}!\n\nТеперь отправьте ваш номер телефона (нажмите кнопку ниже или введите вручную):`, {
      reply_markup: {
        keyboard: [[{ text: '📱 Отправить контакт', request_contact: true }]],
        one_time_keyboard: true,
        resize_keyboard: true
      }
    });
  } else if (state.step === 'phone') {
    let phone = '';
    if (msg.contact) {
      phone = msg.contact.phone_number;
    } else if (text) {
      phone = text;
    }

    if (phone) {
      db.prepare('INSERT INTO users (chatId, fio, phone, registeredAt) VALUES (?, ?, ?, ?)').run(chatId, state.fio, phone, Date.now());
      userStates.delete(chatId);
      bot.sendMessage(chatId, '✅ Регистрация успешно завершена!', { reply_markup: { remove_keyboard: true } });
      showMainMenu(chatId);
    }
  } else if (state.step === 'admin_retry') {
    const targetChatId = text.trim();
    const target = db.prepare('SELECT * FROM users WHERE chatId = ?').get(targetChatId);
    if (target) {
      db.prepare('UPDATE users SET canRetry = 1 WHERE chatId = ?').run(targetChatId);
      bot.sendMessage(chatId, `✅ Пересдача разрешена для <code>${targetChatId}</code> (${target.fio})`, { parse_mode: 'HTML' });
      bot.sendMessage(targetChatId, '🔄 Администратор разрешил вам пройти экзамен повторно. Теперь вы можете нажать "Начать экзамен" в меню.');
    } else {
      bot.sendMessage(chatId, '❌ Кандидат с таким ID не найден.');
    }
    userStates.delete(chatId);
    showAdminPanel(chatId);
  } else if (state.step === 'admin_find') {
    const query = text.trim();
    const results = db.prepare('SELECT * FROM users WHERE chatId = ? OR phone LIKE ?').all(query, `%${query}%`);
    if (results.length > 0) {
      let msgText = '🔍 **Результаты поиска:**\n\n';
      results.forEach(u => {
        msgText += `👤 ${u.fio}\n📞 <code>${u.phone}</code>\n🆔 <code>${u.chatId}</code>\n\n`;
      });
      bot.sendMessage(chatId, msgText, { parse_mode: 'HTML' });
    } else {
      bot.sendMessage(chatId, '❌ Ничего не найдено.');
    }
    userStates.delete(chatId);
    showAdminPanel(chatId);
  }
});

// Error handling for polling
bot.on('polling_error', (error) => {
  console.error(`[POLLING ERROR] ${error.code}: ${error.message}`);
});

// Inline Buttons Handling
bot.on('callback_query', async (query) => {
  if (!query.message) return;
  const chatId = String(query.message.chat.id);
  const data = query.data;
  
  console.log(`[DEBUG] Callback received: ${data} from ${chatId}`);

  try {
    if (data === 'start_exam_rules') {
      const user = db.prepare('SELECT * FROM users WHERE chatId = ?').get(chatId);
      if (!user) {
        await bot.sendMessage(chatId, '❌ Ошибка: профиль не найден. Попробуйте /start');
        bot.answerCallbackQuery(query.id).catch(() => {});
        return;
      }

      const lastResult = db.prepare('SELECT * FROM results WHERE chatId = ? ORDER BY finishedAt DESC LIMIT 1').get(chatId);
      
      if (lastResult && lastResult.status === 'PASS' && !user.canRetry) {
        await bot.sendMessage(chatId, '✅ Вы уже успешно сдали экзамен!');
        bot.answerCallbackQuery(query.id).catch(() => {});
        return;
      }
      
      if (lastResult && lastResult.status === 'FAIL' && !user.canRetry) {
        await bot.sendMessage(chatId, '❌ Вы не сдали экзамен. Дождитесь разрешения администратора на пересдачу.');
        bot.answerCallbackQuery(query.id).catch(() => {});
        return;
      }

      const rules = `📜 **Правила экзамена:**\n\n` +
        `1. Всего 15 вопросов.\n` +
        `2. На каждый вопрос дается **15 секунд**.\n` +
        `3. Если время выйдет — ответ считается неверным.\n` +
        `4. Проходной балл: **${process.env.PASS_SCORE || 13} из 15**.\n\n` +
        `Готовы начать?`;

      const webAppUrl = `${APP_URL}/exam?chatId=${chatId}`;
      console.log(`[DEBUG] Opening WebApp for ${chatId}: ${webAppUrl}`);

      await bot.sendMessage(chatId, rules, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{ text: '✅ Я согласен, начать!', web_app: { url: webAppUrl } }]]
        }
      });
    } else if (data === 'my_result') {
      const result = db.prepare('SELECT * FROM results WHERE chatId = ? ORDER BY finishedAt DESC LIMIT 1').get(chatId);
      if (result) {
        await bot.sendMessage(chatId, `📊 **Ваш последний результат:**\n\n` +
          `Результат: ${result.score}/${result.total}\n` +
          `Статус: ${result.status === 'PASS' ? '✅ СДАНО' : '❌ НЕ СДАНО'}\n` +
          `Дата: ${fmtDate(result.finishedAt)}`, { parse_mode: 'Markdown' });
      } else {
        await bot.sendMessage(chatId, 'У вас еще нет результатов экзамена.');
      }
    } else if (data === 'show_rules') {
      await bot.sendMessage(chatId, `📜 **Правила экзамена:**\n\n` +
        `• 15 вопросов по клинингу и химии.\n` +
        `• 15 секунд на раздумья над каждым вопросом.\n` +
        `• Проходной балл: ${process.env.PASS_SCORE || 13}.\n` +
        `• Пересдача только после одобрения администратором.`);
    } else if (data === 'admin_panel') {
      showAdminPanel(chatId);
    } else if (data === 'admin_last_10') {
      const last = db.prepare(`
        SELECT r.*, u.fio, u.phone 
        FROM results r 
        JOIN users u ON r.chatId = u.chatId 
        ORDER BY r.finishedAt DESC LIMIT 10
      `).all();
      
      if (last.length === 0) {
        await bot.sendMessage(chatId, 'Результатов пока нет.');
      } else {
        let text = '📊 **Последние 10 результатов:**\n\n';
        last.forEach(r => {
          text += `${r.status === 'PASS' ? '✅' : '❌'} ${r.fio} (${r.score}/${r.total})\n` +
                  `🆔 <code>${r.chatId}</code> | 🕒 ${fmtDate(r.finishedAt)}\n\n`;
        });
        await bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
      }
    } else if (data === 'admin_retry_req') {
      await bot.sendMessage(chatId, 'Введите 🆔 chatId кандидата, которому нужно разрешить пересдачу:');
      userStates.set(chatId, { step: 'admin_retry' });
    } else if (data === 'admin_find_req') {
      await bot.sendMessage(chatId, 'Введите 🆔 chatId или 📞 номер телефона для поиска:');
      userStates.set(chatId, { step: 'admin_find' });
    } else if (data === 'admin_reset_req') {
      await bot.sendMessage(chatId, '⚠️ Вы уверены, что хотите сбросить ВСЕХ кандидатов?', {
        reply_markup: {
          inline_keyboard: [[{ text: '🔥 ДА, СБРОСИТЬ ВСЁ', callback_data: 'admin_reset_confirm' }, { text: '❌ Отмена', callback_data: 'admin_panel' }]]
        }
      });
    } else if (data === 'admin_reset_confirm') {
      db.prepare('DELETE FROM users').run();
      db.prepare('DELETE FROM results').run();
      db.prepare('DELETE FROM sessions').run();
      await bot.sendMessage(chatId, '🧹 База данных полностью очищена.');
      showAdminPanel(chatId);
    }
  } catch (err) {
    console.error(`[ERROR] Callback handler failed: ${err.message}`);
  }

  bot.answerCallbackQuery(query.id).catch(() => {});
});

function showMainMenu(chatId) {
  bot.sendMessage(chatId, '🏠 **Главное меню**', {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '📝 Начать экзамен', callback_data: 'start_exam_rules' }],
        [{ text: '📊 Мой результат', callback_data: 'my_result' }, { text: 'ℹ️ Правила', callback_data: 'show_rules' }],
        isAdmin(chatId) ? [{ text: '⚙️ Админ панель', callback_data: 'admin_panel' }] : []
      ].filter(r => r.length > 0)
    }
  });
}

function showAdminPanel(chatId) {
  bot.sendMessage(chatId, '⚙️ **Панель администратора**', {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '📊 Последние 10 результатов', callback_data: 'admin_last_10' }],
        [{ text: '👤 Найти кандидата', callback_data: 'admin_find_req' }],
        [{ text: '🔄 Разрешить пересдачу', callback_data: 'admin_retry_req' }],
        [{ text: '🧹 Сбросить всё', callback_data: 'admin_reset_req' }]
      ]
    }
  });
}

// Export for server.js
module.exports = { bot, db, fmtDate, isAdmin, ADMIN_IDS };
