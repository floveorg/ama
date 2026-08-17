// Pure logic: Telegram getUpdates -> ordered actions + new offset. No I/O.

import { createHash } from 'node:crypto';

const APPROVE_WORDS = new Set(['ok', 'si', 'sí', 'yes', 'publicar', 'publish', 'dale', 'adelante', 'aprobado', 'subir', 'listo']);
const REJECT_WORDS = new Set(['no', 'borrar', 'delete', 'rechazar', 'quitar', 'fuera', 'cancelar', 'anular']);

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_VIDEO_BYTES = 20 * 1024 * 1024;
const MAX_DURATION_S = 60;
export { MAX_FILE_BYTES, MAX_VIDEO_BYTES, MAX_DURATION_S };

export function hashId(chatId, secret = '') {
  return createHash('sha256').update(String(secret) + ':' + String(chatId)).digest('hex');
}

export function identityOf(sel, chatId, secret = '') {
  const s = sel || {};
  if (s.anon) return {};
  if (s.tg && s.name) return { idHash: hashId(chatId, secret) };
  if (s.tg) return { idDirect: String(chatId) };
  return {};
}

export function decisionOf(raw) {
  const text = (raw || '').trim();
  if (/^(✅|👍|✔️|sí|si|ok|yes)$/i.test(text)) return 'approve';
  if (/^(🗑|❌|🚫|no)$/i.test(text)) return 'reject';
  const t = text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '').trim();
  if (!t) return null;
  if (APPROVE_WORDS.has(t)) return 'approve';
  if (REJECT_WORDS.has(t)) return 'reject';
  return null;
}

export function parseUpdates(updates, ctx, currentOffset = 0) {
  const lim = ctx.limits || {};
  const maxBytes = lim.maxFileBytes || MAX_FILE_BYTES;
  const maxVideoBytes = lim.maxVideoBytes || MAX_VIDEO_BYTES;
  const maxDur = lim.maxDurationS || MAX_DURATION_S;
  const actions = [];
  let maxId = -1;
  for (const u of updates) {
    if (typeof u.update_id === 'number') maxId = Math.max(maxId, u.update_id);

    const cb = u.callback_query;
    if (cb && cb.message && cb.message.chat) {
      const chatId = cb.message.chat.id;
      if (chatId === ctx.modGroupId) {
        const m = /^(ok|no):(.+)$/.exec(cb.data || '');
        if (m) {
          actions.push({
            kind: m[1] === 'ok' ? 'approve' : 'reject',
            id: m[2], callbackId: cb.id, modMsgId: cb.message.message_id
          });
          continue;
        }
        const ed = /^edit(-(send|cancel))?:(.+)$/.exec(cb.data || '');
        if (ed) {
          const kind = ed[2] === 'send' ? 'mod-edit-send'
            : ed[2] === 'cancel' ? 'mod-edit-cancel'
            : 'mod-edit';
          actions.push({ kind, id: ed[3], callbackId: cb.id, modMsgId: cb.message.message_id });
        }
        continue;
      }
      if (cb.message.chat.type === 'private' && cb.from && cb.from.id === chatId) {
        const m = /^draft:([a-z-]+)(?::([^:]*))?$/.exec(cb.data || '');
        if (m) {
          const act = m[1];
          if (act === 'id' && m[2]) {
            actions.push({ kind: 'draft-id', chatId, callbackId: cb.id,
              draftMsgId: cb.message.message_id, mode: m[2] });
          } else if (['title', 'tags', 'tags-done', 'send', 'cancel'].includes(act)) {
            actions.push({ kind: 'draft-' + act, chatId, callbackId: cb.id,
              draftMsgId: cb.message.message_id });
          }
          continue;
        }
        const tp = /^tgpub:(yes|no)$/.exec(cb.data || '');
        if (tp) {
          actions.push({ kind: 'tgpub-' + tp[1], chatId, callbackId: cb.id,
            username: (cb.from && cb.from.username) || '' });
          continue;
        }
        const ok = /^accept:(.+)$/.exec(cb.data || '');
        if (ok && ctx.uploaderOf && ctx.uploaderOf[ok[1]] === chatId) {
          actions.push({ kind: 'edit-accept', id: ok[1], chatId, callbackId: cb.id,
            msgId: cb.message.message_id });
          continue;
        }
        const rj = /^reject-edit:(.+)$/.exec(cb.data || '');
        if (rj && ctx.uploaderOf && ctx.uploaderOf[rj[1]] === chatId) {
          actions.push({ kind: 'edit-reject', id: rj[1], chatId, callbackId: cb.id,
            msgId: cb.message.message_id });
        }
      }
      continue;
    }

    const iq = u.inline_query;
    if (iq && iq.id && iq.query !== undefined) {
      actions.push({ kind: 'inline-search', queryId: iq.id, query: iq.query.trim(),
        userId: iq.from && iq.from.id });
    }

    const msg = u.message;
    if (msg && msg.chat && msg.chat.id === ctx.modGroupId) {
      const replyId = msg.reply_to_message && msg.reply_to_message.message_id;
      let decided = false;
      if (replyId) {
        const id = ctx.modMsgToId && ctx.modMsgToId[replyId];
        const kind = decisionOf(msg.text);
        if (id && kind) {
          actions.push({ kind, id, modMsgId: replyId, via: 'reply' });
          decided = true;
        }
      }
      if (!decided && msg.text && ctx.awaitingModEdit) {
        const editId = Object.keys(ctx.awaitingModEdit)[0];
        if (editId) {
          actions.push({ kind: 'mod-edit-text', id: editId, chatId: msg.chat.id, text: msg.text.trim() });
        }
      }
      continue;
    }
    if (msg && msg.chat && msg.chat.type === 'private') {
      const key = String(msg.chat.id);
      const fwd = msg.forward_from_chat;
      if (fwd && msg.forward_from_message_id) {
        actions.push({
          kind: 'forward-channel', chatId: msg.chat.id,
          channelMsgId: msg.forward_from_message_id,
          channelId: fwd.id
        });
        continue;
      }
      const media = msg.voice || msg.audio || msg.video;
      if (media && media.file_id) {
        const video = !!msg.video;
        const sizeCap = video ? maxVideoBytes : maxBytes;
        if (media.file_size && media.file_size > sizeCap) {
          actions.push({ kind: 'draft-invalid', chatId: msg.chat.id, reason: 'size' });
        } else if (media.duration && media.duration > maxDur) {
          actions.push({ kind: 'draft-invalid', chatId: msg.chat.id, reason: 'duration' });
        } else {
          actions.push({
            kind: 'draft', id: 'lv_' + u.update_id, chatId: msg.chat.id,
            fileId: media.file_id, ...(video ? { video: true } : {}),
            fromChatId: msg.chat.id, fromMsgId: msg.message_id,
            name: (msg.from && msg.from.first_name) || 'Anónima',
            username: (msg.from && msg.from.username) || '',
            title: (msg.caption || '').trim()
          });
        }
      } else if (msg.text) {
        const cmd = /^\/(name|pub|me|stats|profile|status|queue|latest|random|now|since|today|trending|play)\b(?:\s+(.+))?$/i.exec(msg.text.trim());
        if (cmd) {
          const c = cmd[1].toLowerCase();
          if (c === 'name') {
            actions.push({ kind: 'rename', chatId: msg.chat.id, name: (cmd[2] || '').trim().slice(0, 40) });
          } else if (c === 'pub') {
            actions.push({ kind: 'tgpub-ask', chatId: msg.chat.id });
          } else {
            actions.push({ kind: 'cmd-' + c, chatId: msg.chat.id, arg: (cmd[2] || '').trim() });
          }
        } else if (ctx.awaitingTitle && ctx.awaitingTitle[key]) {
          actions.push({ kind: 'draft-title-text', chatId: msg.chat.id, title: (msg.text || '').trim() });
        } else if (ctx.awaitingTags && ctx.awaitingTags[key]) {
          actions.push({ kind: 'draft-tags-text', chatId: msg.chat.id, tagsText: (msg.text || '').trim() });
        } else {
          actions.push({ kind: 'welcome', chatId: msg.chat.id });
        }
      }
    }
  }
  const offset = maxId >= 0 ? maxId + 1 : currentOffset;
  return { actions, offset };
}

export function amaEntry({ id, name, tags, when, src, t, tg, key, video }) {
  const e = {
    id,
    name: name || 'Anónima',
    src,
    when
  };
  if (t) e.t = t;
  if (tags) e.tags = tags;
  if (tg) e.tg = tg;
  if (key) e.key = key;
  if (video) e.video = true;
  return e;
}

export function prependClip(clips, entry) {
  return [entry, ...(Array.isArray(clips) ? clips : [])];
}

export function latestClips(clips, n = 5) {
  return (Array.isArray(clips) ? clips : []).slice(0, Math.max(0, n));
}

export function clipsOfAuthor(clips, key) {
  return (Array.isArray(clips) ? clips : []).filter((e) => e.key === key);
}

export function clipsToday(clips, today) {
  const t = today || new Date().toISOString().slice(0, 10);
  return (Array.isArray(clips) ? clips : []).filter((e) => e.when === t);
}

export function clipsSince(clips, days = 1, today) {
  const t = today || new Date().toISOString().slice(0, 10);
  const from = new Date(t + 'T00:00:00Z');
  from.setUTCDate(from.getUTCDate() - Math.max(0, days - 1));
  const fromIso = from.toISOString().slice(0, 10);
  return (Array.isArray(clips) ? clips : []).filter((e) => e.when >= fromIso);
}

export function randomClip(clips) {
  const b = Array.isArray(clips) ? clips : [];
  return b.length ? b[Math.floor(Math.random() * b.length)] : undefined;
}

export function tagTrend(clips, n = 50) {
  const counts = new Map();
  latestClips(clips, n).forEach((e) =>
    String(e.tags || '').split(/[;,]/)
      .map((t) => t.trim().toLowerCase().replace(/^#/, ''))
      .filter(Boolean)
      .forEach((t) => counts.set(t, (counts.get(t) || 0) + 1)));
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([tag, count]) => ({ tag, count }));
}

export function authorStats(clips, queue, key) {
  return { key, published: clipsOfAuthor(clips, key).length,
           pending: Object.values(queue || {}).filter((e) => e.uploader === key).length };
}

export function searchClips(clips, query, limit = 10) {
  if (!query) return latestClips(clips, limit);
  const q = query.toLowerCase();
  return (Array.isArray(clips) ? clips : [])
    .filter((e) => {
      const title = (e.t || '').toLowerCase();
      const tags = String(e.tags || '').toLowerCase();
      const name = (e.name || '').toLowerCase();
      return title.includes(q) || tags.includes(q) || name.includes(q);
    })
    .slice(0, limit);
}

export function inlineResult(e) {
  return {
    type: 'audio',
    id: e.id,
    audio_url: e.src,
    title: e.t || 'Ama liberada',
    performer: e.name || 'Anónima',
    caption: [(e.t || ''), (e.tags || ''), (e.name || 'Anónima')].filter(Boolean).join(' · '),
    description: e.tags || undefined
  };
}
