import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

export function Telegram(token) {
  const api = 'https://api.telegram.org/bot' + token + '/';
  const file = 'https://api.telegram.org/file/bot' + token + '/';

  async function call(method, body) {
    const res = await fetch(api + method, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {})
    });
    const json = await res.json();
    if (!json.ok) throw new Error(method + ' failed: ' + JSON.stringify(json));
    return json.result;
  }

  return {
    getUpdates: (offset, timeout = 0) =>
      call('getUpdates', { offset, timeout, allowed_updates: ['message', 'callback_query', 'inline_query'] }),
    copyMessage: (chatId, fromChatId, messageId, replyMarkup, caption) =>
      call('copyMessage', { chat_id: chatId, from_chat_id: fromChatId,
        message_id: messageId, reply_markup: replyMarkup, caption }),
    sendMessage: (chatId, text, replyMarkup) =>
      call('sendMessage', { chat_id: chatId, text, reply_markup: replyMarkup }),
    editMessageText: (chatId, messageId, text, replyMarkup) =>
      call('editMessageText', { chat_id: chatId, message_id: messageId, text, reply_markup: replyMarkup }),
    sendAudioByUrl: (chatId, url, caption, opts = {}) =>
      call('sendAudio', { chat_id: chatId, audio: url, caption,
        ...(opts.title ? { title: opts.title } : {}),
        ...(opts.performer ? { performer: opts.performer } : {}) }),
    sendVideoByUrl: (chatId, url, caption) =>
      call('sendVideo', { chat_id: chatId, video: url, caption }),
    setMessageReaction: (chatId, messageId, emoji) =>
      call('setMessageReaction', { chat_id: chatId, message_id: messageId,
        reaction: [{ type: 'emoji', emoji }], is_big: true }),
    answerCallback: (id, text) => call('answerCallbackQuery', { callback_query_id: id, text }),
    answerInlineQuery: (id, results, opts = {}) =>
      call('answerInlineQuery', { inline_query_id: id, results, ...opts }),
    editReplyMarkupClear: (chatId, messageId) =>
      call('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }),
    editReplyMarkup: (chatId, messageId, replyMarkup) =>
      call('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: replyMarkup }),
    editCaption: (chatId, messageId, caption) =>
      call('editMessageCaption', { chat_id: chatId, message_id: messageId, caption }),
    getFilePath: async (fileId) => (await call('getFile', { file_id: fileId })).file_path,

    async downloadFile(filePath, destPath) {
      const res = await fetch(file + filePath);
      if (!res.ok) throw new Error('download failed: ' + res.status);
      await pipeline(Readable.fromWeb(res.body), createWriteStream(destPath));
    },

    async sendAudioByPath(chatId, filePath, caption) {
      const { readFile } = await import('node:fs/promises');
      const buf = await readFile(filePath);
      const form = new FormData();
      form.append('chat_id', String(chatId));
      if (caption) form.append('caption', caption);
      form.append('audio', new Blob([buf], { type: 'audio/mpeg' }), filePath.split('/').pop());
      const res = await fetch(api + 'sendAudio', { method: 'POST', body: form });
      const json = await res.json();
      if (!json.ok) throw new Error('sendAudio failed: ' + JSON.stringify(json));
      return json.result;
    }
  };
}
