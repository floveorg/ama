import { readFile, writeFile, rm, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseUpdates, amaEntry, prependClip, identityOf, hashId, MAX_FILE_BYTES,
  latestClips, clipsOfAuthor, clipsToday, clipsSince, randomClip,
  tagTrend, authorStats, searchClips, inlineResult
} from './logic.mjs';
import { pageUrlOf } from './pages.mjs';
import { Telegram } from './telegram.mjs';
import { uploadAudio, uploadMedia } from './r2.mjs';

const TG_ID_SECRET = process.env.TG_ID_SECRET || 'ama-dev-secret';

const run = promisify(execFile);
const ROOT = new URL('..', import.meta.url).pathname;
const p = (rel) => ROOT + rel;

const readJSON = async (rel, fallback) => {
  try { return JSON.parse(await readFile(p(rel), 'utf8')); } catch { return fallback; }
};
const writeJSON = (rel, v) => writeFile(p(rel), JSON.stringify(v, null, 2) + '\n');
const isoToday = () => new Date().toISOString().slice(0, 10);

const WELCOME_TEXT = '💗 Envia un audio o vídeo de máx. 1 min, 10 MB, 5 al día. Un moderador lo revisa y, si entra, lo publicamos en @amaliberada y en ama.liberada.net 💛';

const LIMITS_DEFAULTS = { maxFileBytes: 10 * 1024 * 1024, maxDurationS: 60, maxPending: 5, maxPerDay: 5 };

const BUTTONS = (id) => ({ inline_keyboard: [[
  { text: '✅ Publicar', callback_data: 'ok:' + id },
  { text: '🗑 Borrar',   callback_data: 'no:' + id }
], [
  { text: '✏️ Editar', callback_data: 'edit:' + id }
]] });

const EDIT_PROMPT_KEYS = (id) => ({ inline_keyboard: [[
  { text: '✖️ Cancelar', callback_data: 'edit-cancel:' + id }
]] });
const EDIT_KEYS = (id) => ({ inline_keyboard: [[
  { text: '📨 Proponer al autor', callback_data: 'edit-send:' + id },
  { text: '✖️ Cancelar', callback_data: 'edit-cancel:' + id }
]] });
const ACCEPT_KEYS = (id) => ({ inline_keyboard: [[
  { text: '✅ Aceptar', callback_data: 'accept:' + id },
  { text: '❌ Rechazar', callback_data: 'reject-edit:' + id }
]] });

const DEFAULT_SEL = { tg: false, name: true, anon: false };
const selOf = (d) => d.sel || { ...DEFAULT_SEL };
function displayName(d) {
  const s = selOf(d);
  if (s.anon) return 'Anónima';
  const parts = [];
  if (s.tg) parts.push(d.username ? '@' + d.username : (d.name || 'Anónima'));
  if (s.name) parts.push(d.name || 'Anónima');
  return [...new Set(parts)].join(' · ') || 'Anónima';
}
function identityLabel(d) {
  const s = selOf(d);
  if (s.anon) return '🙈 ' + displayName(d);
  if (s.tg) return '👤 ' + displayName(d);
  return '🙂 ' + displayName(d);
}

function tagsHash(tags) {
  return (tags || []).map(t => '#' + t.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean).join(' ');
}
function addTags(d, text) {
  const out = d.tags || [];
  const seen = new Set(out.map(t => t.toLowerCase()));
  String(text || '').split(/[;,]/).forEach(chunk =>
    chunk.split(/\s+/).forEach(word => {
      const w = word.replace(/^#/, '').trim().toLowerCase();
      if (!w) return;
      if (!seen.has(w)) { seen.add(w); out.push(w); }
    }));
  d.tags = out;
}

async function ensureUsername(q) {
  let usernames = {};
  try { usernames = JSON.parse(await readFile(p('usernames.json'), 'utf8')); } catch {}
  const myKey = q.uploader;
  const existing = Object.entries(usernames).find(([, v]) => v.key === myKey);
  if (existing) return existing[0];
  const raw = (q.username || q.name || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  let base = raw || 'user';
  if (base.length < 3) base = base + '_ama';
  let candidate = base.slice(0, 20);
  let n = 1;
  while (usernames[candidate] && usernames[candidate].key !== myKey) {
    n++;
    candidate = (base.slice(0, 16) + '_' + n).slice(0, 20);
  }
  usernames[candidate] = { key: myKey, name: q.name || 'Anónima', claimedAt: isoToday() };
  await writeFile(p('usernames.json'), JSON.stringify(usernames, null, 2) + '\n');
  return candidate;
}

function parseEditDetails(text) {
  const parts = String(text || '').split('|').map(s => s.trim());
  const out = {};
  if (parts[0]) out.title = parts[0].slice(0, 60);
  const tags = String(parts[1] || '').split(/[;,]/)
    .map(t => t.replace(/^#/, '').trim().toLowerCase()).filter(Boolean);
  if (tags.length) out.tags = tags;
  if (parts[2]) out.name = parts[2].slice(0, 40);
  return out;
}

function detailLines(q) {
  const tags = q.tags && q.tags.length ? q.tags.join(', ') : '—';
  return ['✏️ ' + (q.title || '—'), '🏷️ ' + tags, '🙂 ' + (q.name || 'Anónima')];
}

function proposalLines(q) {
  const p = q.proposed || {};
  const tags = (p.tags && p.tags.length)
    ? p.tags.join(', ')
    : ((q.tags && q.tags.length) ? q.tags.join(', ') : '—');
  return ['✏️ ' + (p.title || q.title || '—'),
          '🏷️ ' + tags,
          '🙂 ' + (p.name || q.name || 'Anónima')];
}

function modCaption(q) {
  const tags = (q.tags && q.tags.length) ? q.tags.join(', ') : '';
  return [q.title || '', tagsHash(q.tags), q.name || 'Anónima'].filter(Boolean).join('\n');
}

function clipLine(e) {
  return '💗 ' + (e.t || '—') + ' · 🙂 ' + (e.name || 'Anónima') + ' · 📅 ' + (e.when || '—');
}

function draftText(d) {
  return [
    '💗 Amor recibido 💛',
    '',
    '✏️ ' + (d.title || '—'),
    '🏷️ ' + ((d.tags && d.tags.length) ? d.tags.join(', ') : '—'),
    identityLabel(d),
    '',
    'Ajusta lo que quieras y pulsa «Enviar».'
  ].filter(Boolean).join('\n');
}

function OPTIONS(d) {
  const s = selOf(d);
  const mk = (mode, base) => ({
    text: (s[mode] ? '✓ ' : '') + base,
    callback_data: 'draft:id:' + mode
  });
  return { inline_keyboard: [
    [{ text: '✏️ Título', callback_data: 'draft:title' },
     { text: '🏷️ Tags', callback_data: 'draft:tags' }],
    [mk('tg', '👤 Usuario telegram'), mk('name', '🙂 Autor'), mk('anon', '🙈 Anónimo')],
    [{ text: '✅ Enviar', callback_data: 'draft:send' }]
  ]};
}

const CANCEL_KEYS = () => ({ inline_keyboard: [[
  { text: '✖️ Cancelar', callback_data: 'draft:cancel' }
]] });

const TGPUB_TEXT = '📣 ¿Mostrar tu @ en la web?\n\n' +
  'Ama nunca enlaza tu Telegram automáticamente: solo si tú lo pides, junto a ' +
  'tu nombre público aparecerá un enlace a t.me. Puedes cambiarlo luego con /pub.';
const TGPUB_KEYS = () => ({ inline_keyboard: [[
  { text: '✅ Sí, mostrar mi @', callback_data: 'tgpub:yes' },
  { text: '✖️ No', callback_data: 'tgpub:no' }
]] });

function tagsText(d) {
  return '🏷️ Etiqueta tu amor — escribe las etiquetas separadas por coma.\n\n' +
    'Actuales: ' + ((d.tags && d.tags.length) ? d.tags.join(', ') : '—');
}
function tagsKeys() {
  return { inline_keyboard: [[
    { text: '✅ Listo', callback_data: 'draft:tags-done' },
    { text: '✖️ Cancelar', callback_data: 'draft:cancel' }
  ]] };
}

const bestEffort = (promise) => promise.catch((err) => console.error('non-fatal:', err.message));

const LOOP_MAX_MS = 55 * 60 * 1000;
const POLL_TIMEOUT = 25;

async function publishClip(tg, cfg, q, id, clips, names, tgpub) {
  const filePath = await tg.getFilePath(q.fileId);
  const srcRaw = join(tmpdir(), id + '.vsrc');
  const out = join(tmpdir(), id + (q.video ? '.mp4' : '.mp3'));
  try {
    await tg.downloadFile(filePath, srcRaw);
    let src, posted;
    if (q.video) {
      const aac = ['-c:a', 'aac', '-movflags', '+faststart'];
      await run('ffmpeg', ['-y', '-i', srcRaw, '-c:v', 'libx264', '-preset', 'veryfast',
        '-crf', '26', '-pix_fmt', 'yuv420p', ...aac, '-b:a', '96k', out]);
      if ((await stat(out)).size > MAX_FILE_BYTES) {
        await run('ffmpeg', ['-y', '-i', srcRaw, '-c:v', 'libx264', '-preset', 'veryfast',
          '-crf', '33', '-pix_fmt', 'yuv420p', '-vf', 'scale=min(960,iw):-2',
          ...aac, '-b:a', '64k', out]);
      }
      src = await uploadMedia(out, { key: (cfg.r2Folder ? cfg.r2Folder + '/' : '') + id + '.mp4', contentType: 'video/mp4' });
    } else {
      await run('ffmpeg', ['-y', '-i', srcRaw, '-vn', '-af', 'loudnorm', '-codec:a', 'libmp3lame', '-q:a', '4', out]);
      src = await uploadAudio(out, { publicId: id, folder: cfg.r2Folder });
    }
    const who = q.uploader;
    const name = (who && names && names[who]) || q.name || 'Anónima';
    const tgLink = (who && tgpub && tgpub[who] && tgpub[who].ok) ? tgpub[who].username : undefined;
    const caption = [q.title, tagsHash(q.tags), name].filter(Boolean).join(' · ');
    if (q.video) {
      posted = await tg.sendVideoByUrl(cfg.channel, src, caption);
    } else {
      posted = await tg.sendAudioByUrl(cfg.channel, src, caption, { title: q.title, performer: name });
    }
    clips = prependClip(clips, amaEntry({
      id, name, key: who, t: q.title, tags: (q.tags || []).join(', '), when: isoToday(), src, tg: tgLink, video: !!q.video
    }));
    if (posted && posted.message_id) {
      await bestEffort(tg.setMessageReaction(cfg.channel, posted.message_id, '💗'));
    }
  } finally {
    await rm(srcRaw, { force: true });
    await rm(out, { force: true });
  }
  return clips;
}

async function handleAction(a, tg, cfg, queue, drafts, clips, uploaders, uploads, tgpub, names) {
  const limits = cfg.limits || {};
  if (a.kind === 'draft') {
    const key = String(a.chatId);
    const prev = drafts[key] || {};
    drafts[key] = {
      id: a.id, fileId: a.fileId, name: a.name, username: a.username, video: !!a.video,
      title: a.title || '', tags: [], sel: { ...DEFAULT_SEL },
      fromChatId: a.fromChatId, fromMsgId: a.fromMsgId,
      draftMsgId: prev.draftMsgId, awaitingTitle: false, awaitingTags: false
    };
    const text = draftText(drafts[key]);
    if (prev.draftMsgId) {
      await bestEffort(tg.editMessageText(a.chatId, prev.draftMsgId, text, OPTIONS(drafts[key])));
    } else {
      const sent = await tg.sendMessage(a.chatId, text, OPTIONS(drafts[key]));
      drafts[key].draftMsgId = sent.message_id;
    }
    return { clips, dirty: true };
  }
  if (a.kind === 'draft-title') {
    const d = drafts[String(a.chatId)];
    if (!d) return { clips, dirty: false };
    d.awaitingTitle = true;
    d.awaitingTags = false;
    await bestEffort(tg.answerCallback(a.callbackId, 'Escribe el título'));
    await bestEffort(tg.editMessageText(a.chatId, a.draftMsgId,
      '✏️ Escribe el título de tu amor (una palabra o frase corta):', CANCEL_KEYS()));
    return { clips, dirty: true };
  }
  if (a.kind === 'draft-title-text') {
    const d = drafts[String(a.chatId)];
    if (!d || !d.awaitingTitle) return { clips, dirty: false };
    d.title = (a.title || '').slice(0, 60);
    d.awaitingTitle = false;
    await bestEffort(tg.editMessageText(a.chatId, d.draftMsgId, draftText(d), OPTIONS(d)));
    return { clips, dirty: true };
  }
  if (a.kind === 'draft-tags') {
    const d = drafts[String(a.chatId)];
    if (!d) return { clips, dirty: false };
    d.awaitingTitle = false;
    d.awaitingTags = true;
    await bestEffort(tg.answerCallback(a.callbackId, 'Etiqueta tu amor'));
    await bestEffort(tg.editMessageText(a.chatId, a.draftMsgId, tagsText(d), tagsKeys()));
    return { clips, dirty: true };
  }
  if (a.kind === 'draft-tags-text') {
    const d = drafts[String(a.chatId)];
    if (!d || !d.awaitingTags) return { clips, dirty: false };
    addTags(d, a.tagsText);
    await bestEffort(tg.editMessageText(a.chatId, a.draftMsgId, tagsText(d), tagsKeys()));
    return { clips, dirty: true };
  }
  if (a.kind === 'draft-tags-done') {
    const d = drafts[String(a.chatId)];
    if (!d) return { clips, dirty: false };
    d.awaitingTags = false;
    await bestEffort(tg.answerCallback(a.callbackId, 'Etiquetas guardadas'));
    await bestEffort(tg.editMessageText(a.chatId, a.draftMsgId, draftText(d), OPTIONS(d)));
    return { clips, dirty: true };
  }
  if (a.kind === 'draft-id') {
    const d = drafts[String(a.chatId)];
    if (!d) return { clips, dirty: false };
    const s = selOf(d);
    if (a.mode === 'anon') { s.tg = false; s.name = false; s.anon = true; }
    else if (a.mode === 'tg') { s.tg = !s.tg; s.anon = false; }
    else if (a.mode === 'name') { s.name = !s.name; s.anon = false; }
    await bestEffort(tg.answerCallback(a.callbackId, 'Autor: ' + displayName(d)));
    await bestEffort(tg.editMessageText(a.chatId, a.draftMsgId, draftText(d), OPTIONS(d)));
    return { clips, dirty: true };
  }
  if (a.kind === 'draft-cancel') {
    const d = drafts[String(a.chatId)];
    if (!d) return { clips, dirty: false };
    d.awaitingTitle = false;
    d.awaitingTags = false;
    await bestEffort(tg.editMessageText(a.chatId, a.draftMsgId, draftText(d), OPTIONS(d)));
    return { clips, dirty: true };
  }
  if (a.kind === 'draft-send') {
    const d = drafts[String(a.chatId)];
    if (!d) { await bestEffort(tg.answerCallback(a.callbackId, 'Nada que enviar')); return { clips, dirty: false }; }
    if (queue[d.id] || clips.some((e) => e.id === d.id)) { delete drafts[String(a.chatId)]; return { clips, dirty: true }; }
    const who = hashId(a.chatId, TG_ID_SECRET);
    const today = isoToday();
    const day = uploads[today] || (uploads[today] = {});
    if ((day[who] || 0) >= limits.maxPerDay) {
      await bestEffort(tg.answerCallback(a.callbackId, 'Límite diario alcanzado'));
      await bestEffort(tg.sendMessage(a.chatId,
        'Ya has enviado ' + limits.maxPerDay + ' amores hoy. Vuelve mañana 💛'));
      return { clips, dirty: false };
    }
    const pending = Object.values(queue).filter((e) => e.uploader === who).length;
    if (pending >= limits.maxPending) {
      await bestEffort(tg.answerCallback(a.callbackId, 'Cola llena'));
      await bestEffort(tg.sendMessage(a.chatId,
        'Ya tienes ' + limits.maxPending + ' amores en moderación. Espera a que se publiquen o borren antes de enviar más 💛'));
      return { clips, dirty: false };
    }
    const name = displayName(d);
    const caption = [
      d.title || '',
      tagsHash(d.tags),
      name
    ].filter(Boolean).join('\n');
    const copied = await tg.copyMessage(cfg.modGroupId, d.fromChatId, d.fromMsgId, BUTTONS(d.id), caption);
    queue[d.id] = { fileId: d.fileId, name, username: d.username, title: d.title, video: !!d.video,
                    tags: d.tags || [], sel: d.sel || { ...DEFAULT_SEL },
                    uploader: who,
                    ...identityOf(d.sel, a.chatId, TG_ID_SECRET), modMsgId: copied.message_id };
    day[who] = (day[who] || 0) + 1;
    uploaders[d.id] = a.chatId;
    delete drafts[String(a.chatId)];
    await bestEffort(tg.answerCallback(a.callbackId, 'Enviada a moderación'));
    await bestEffort(tg.sendMessage(a.chatId,
      'Gracias, lo revisamos en breve y te avisamos cuando se publique.'));
    const entry = queue[d.id];
    if (entry.idHash && !tgpub[who]) {
      await bestEffort(tg.sendMessage(a.chatId, TGPUB_TEXT, TGPUB_KEYS()));
    }
    return { clips, dirty: true };
  }
  if (a.kind === 'draft-invalid') {
    const msg = a.reason === 'size'
      ? 'Ups… tu archivo supera el límite de 10 MB. Mándalo en un formato más ligero 💛'
      : 'Ups… tu amor supera el minuto. Mándalo más cortito 💛';
    await bestEffort(tg.sendMessage(a.chatId, msg));
    return { clips, dirty: false };
  }
  if (a.kind === 'welcome') {
    await bestEffort(tg.sendMessage(a.chatId, WELCOME_TEXT));
    return { clips, dirty: false };
  }
  if (a.kind === 'forward-channel') {
    await bestEffort(tg.sendMessage(a.chatId,
      'Reenvío detectado. Envía tu amor directamente (nota de voz o vídeo) y lo publicamos 💛'));
    return { clips, dirty: false };
  }
  if (a.kind === 'rename') {
    const who = hashId(a.chatId, TG_ID_SECRET);
    const n = (a.name || '').trim();
    if (!n) {
      await bestEffort(tg.sendMessage(a.chatId, 'Uso: /name <tu nombre público>'));
      return { clips, dirty: false };
    }
    names[who] = n;
    await bestEffort(tg.sendMessage(a.chatId,
      'Nombre público guardado: ' + n + ' — se aplica a tus próximos amores publicados.'));
    return { clips, dirty: true };
  }
  if (a.kind === 'tgpub-ask') {
    await bestEffort(tg.sendMessage(a.chatId, TGPUB_TEXT, TGPUB_KEYS()));
    return { clips, dirty: false };
  }
  if (a.kind === 'tgpub-yes' || a.kind === 'tgpub-no') {
    const who = hashId(a.chatId, TG_ID_SECRET);
    const yes = a.kind === 'tgpub-yes';
    tgpub[who] = { ok: yes, username: a.username ? '@' + a.username : '' };
    await bestEffort(tg.answerCallback(a.callbackId,
      yes ? 'Tu @ se mostrará junto a tu nombre' : 'Perfecto, tu @ quedará oculto'));
    return { clips, dirty: true };
  }
  if (a.kind === 'approve') {
    const q = queue[a.id];
    if (a.callbackId) await bestEffort(tg.answerCallback(a.callbackId, q ? 'Publicando…' : 'Ya resuelta'));
    if (!q) return { clips, dirty: false };
    if (q.pendingAccept) {
      await bestEffort(tg.answerCallback(a.callbackId,
        'El amor está esperando el visto bueno del autor — resuélvelo antes'));
      return { clips, dirty: false };
    }
    if (clips.some((e) => e.id === a.id)) { delete queue[a.id]; return { clips, dirty: true }; }
    if (!q.fileId) throw new Error('queue entry missing fileId for ' + a.id);
    clips = await publishClip(tg, cfg, q, a.id, clips, names, tgpub);
    delete queue[a.id];
    await bestEffort(tg.editReplyMarkupClear(cfg.modGroupId, q.modMsgId));
    await bestEffort(tg.editCaption(cfg.modGroupId, q.modMsgId, '✅ Publicado'));
    const upChatId = uploaders[a.id];
    if (upChatId) {
      const lines = ['✅ ¡Tu amor ya está publicado!'];
      if (q.title) lines.push('✏️ ' + q.title);
      if (q.tags && q.tags.length) lines.push('🏷️ ' + q.tags.join(', '));
      lines.push('🙂 ' + (q.name || 'Anónima'));
      lines.push('🔗 Tu página de autor: ' + pageUrlOf(q.uploader, cfg.webUrl));
      try {
        const sub = await ensureUsername(q);
        if (sub) lines.push('🌐 ' + sub + '.liberada.net');
      } catch {}
      lines.push('📣 Grupo Ama liberada: ' + cfg.groupUrl);
      await bestEffort(tg.sendMessage(upChatId, lines.join('\n')));
      delete uploaders[a.id];
    }
    return { clips, dirty: true };
  }
  if (a.kind === 'reject') {
    const q = queue[a.id];
    if (a.callbackId) await bestEffort(tg.answerCallback(a.callbackId, 'Borrada'));
    if (q) {
      q.editing = false; q.proposed = undefined; q.pendingAccept = false;
      await bestEffort(tg.editReplyMarkupClear(cfg.modGroupId, q.modMsgId));
      await bestEffort(tg.editCaption(cfg.modGroupId, q.modMsgId, '🗑 Borrada'));
      delete queue[a.id];
      delete uploaders[a.id];
    }
    return { clips, dirty: !!q };
  }
  if (a.kind === 'mod-edit') {
    const q = queue[a.id];
    if (a.callbackId) await bestEffort(tg.answerCallback(a.callbackId, q ? 'Editando…' : 'Ya resuelta'));
    if (!q) return { clips, dirty: false };
    q.editing = true;
    q.proposed = undefined;
    await bestEffort(tg.editCaption(cfg.modGroupId, q.modMsgId,
      '✏️ Editando — manda los detalles en una línea:\nTítulo | Tags | Nombre\n\nActuales:\n' +
      detailLines(q).join('\n')));
    await bestEffort(tg.editReplyMarkup(cfg.modGroupId, q.modMsgId, EDIT_PROMPT_KEYS(a.id)));
    return { clips, dirty: true };
  }
  if (a.kind === 'mod-edit-text') {
    const q = queue[a.id];
    if (!q) return { clips, dirty: false };
    const prop = parseEditDetails(a.text);
    if (!Object.keys(prop).length) {
      await bestEffort(tg.editCaption(cfg.modGroupId, q.modMsgId,
        'Nada que proponer — usa el formato: Título | Tags | Nombre'));
      await bestEffort(tg.editReplyMarkup(cfg.modGroupId, q.modMsgId, EDIT_PROMPT_KEYS(a.id)));
      return { clips, dirty: true };
    }
    q.proposed = prop;
    q.editing = false;
    await bestEffort(tg.editCaption(cfg.modGroupId, q.modMsgId,
      '✏️ Propuesta:\n\n' + proposalLines(q).join('\n') +
      '\n\n¿La enviamos al autor para su visto bueno?'));
    await bestEffort(tg.editReplyMarkup(cfg.modGroupId, q.modMsgId, EDIT_KEYS(a.id)));
    return { clips, dirty: true };
  }
  if (a.kind === 'mod-edit-send') {
    const q = queue[a.id];
    if (a.callbackId) await bestEffort(tg.answerCallback(a.callbackId, q ? 'Enviando propuesta…' : 'Ya resuelta'));
    if (!q) return { clips, dirty: false };
    const upChatId = uploaders[a.id];
    if (!upChatId) {
      q.editing = false; q.proposed = undefined;
      await bestEffort(tg.editCaption(cfg.modGroupId, q.modMsgId,
        'No encuentro al autor para el visto bueno — propuesta cancelada.'));
      await bestEffort(tg.editReplyMarkup(cfg.modGroupId, q.modMsgId, BUTTONS(a.id)));
      return { clips, dirty: true };
    }
    q.editing = false;
    q.pendingAccept = true;
    await bestEffort(tg.sendMessage(upChatId,
      'Un moderador quiere ajustar tu amor antes de publicarlo 💛\n\n' +
      proposalLines(q).join('\n') + '\n\n¿Te vale así?', ACCEPT_KEYS(a.id)));
    await bestEffort(tg.editCaption(cfg.modGroupId, q.modMsgId,
      '✏️ Propuesta enviada al autor — esperando su visto bueno.'));
    await bestEffort(tg.editReplyMarkup(cfg.modGroupId, q.modMsgId, { inline_keyboard: [] }));
    return { clips, dirty: true };
  }
  if (a.kind === 'mod-edit-cancel') {
    const q = queue[a.id];
    if (a.callbackId) await bestEffort(tg.answerCallback(a.callbackId, 'Edición cancelada'));
    if (q) {
      q.editing = false; q.proposed = undefined; q.pendingAccept = false;
      await bestEffort(tg.editCaption(cfg.modGroupId, q.modMsgId, modCaption(q)));
      await bestEffort(tg.editReplyMarkup(cfg.modGroupId, q.modMsgId, BUTTONS(a.id)));
    }
    return { clips, dirty: !!q };
  }
  if (a.kind === 'edit-accept') {
    const q = queue[a.id];
    if (a.callbackId) await bestEffort(tg.answerCallback(a.callbackId, q ? 'Publicando…' : 'Ya resuelta'));
    if (!q) return { clips, dirty: false };
    if (clips.some((e) => e.id === a.id)) { delete queue[a.id]; return { clips, dirty: true }; }
    q.editing = false; q.pendingAccept = false;
    if (q.proposed) {
      if (q.proposed.title) q.title = q.proposed.title;
      if (q.proposed.tags) q.tags = q.proposed.tags;
      if (q.proposed.name) q.name = q.proposed.name;
      q.proposed = undefined;
    }
    if (!q.fileId) throw new Error('queue entry missing fileId for ' + a.id);
    clips = await publishClip(tg, cfg, q, a.id, clips, names, tgpub);
    delete queue[a.id];
    await bestEffort(tg.editReplyMarkupClear(a.chatId, a.msgId));
    await bestEffort(tg.editReplyMarkupClear(cfg.modGroupId, q.modMsgId));
    await bestEffort(tg.editCaption(cfg.modGroupId, q.modMsgId, '✅ Publicado'));
    const upChatId = uploaders[a.id];
    if (upChatId) {
      const lines = ['✅ ¡Tu amor ya está publicado!'];
      if (q.title) lines.push('✏️ ' + q.title);
      if (q.tags && q.tags.length) lines.push('🏷️ ' + q.tags.join(', '));
      lines.push('🙂 ' + (q.name || 'Anónima'));
      lines.push('🔗 Tu página de autor: ' + pageUrlOf(q.uploader, cfg.webUrl));
      try {
        const sub = await ensureUsername(q);
        if (sub) lines.push('🌐 ' + sub + '.liberada.net');
      } catch {}
      lines.push('📣 Grupo Ama liberada: ' + cfg.groupUrl);
      await bestEffort(tg.sendMessage(upChatId, lines.join('\n')));
      delete uploaders[a.id];
    }
    return { clips, dirty: true };
  }
  if (a.kind === 'edit-reject') {
    const q = queue[a.id];
    if (a.callbackId) await bestEffort(tg.answerCallback(a.callbackId, 'Dejamos tu amor como estaba'));
    if (q) {
      q.editing = false; q.proposed = undefined; q.pendingAccept = false;
      await bestEffort(tg.editReplyMarkupClear(a.chatId, a.msgId));
      await bestEffort(tg.editCaption(cfg.modGroupId, q.modMsgId, modCaption(q)));
      await bestEffort(tg.editReplyMarkup(cfg.modGroupId, q.modMsgId, BUTTONS(a.id)));
      await bestEffort(tg.sendMessage(cfg.modGroupId,
        'El autor no aceptó la propuesta para ' + a.id + ' — se conserva lo original.'));
    }
    return { clips, dirty: !!q };
  }
  if (a.kind === 'cmd-me') {
    const key = hashId(a.chatId, TG_ID_SECRET);
    const st = authorStats(clips, queue, key);
    await bestEffort(tg.sendMessage(a.chatId,
      '👤 Tu página de autor: ' + pageUrlOf(key, cfg.webUrl) + '\n' +
      '🙂 ' + (names[key] || 'Anónima') + '\n' +
      '💗 Publicados: ' + st.published + '\n' +
      '⏳ En moderación: ' + st.pending));
    return { clips, dirty: false };
  }
  if (a.kind === 'cmd-profile') {
    const key = hashId(a.chatId, TG_ID_SECRET);
    if (a.arg) {
      const match = (Array.isArray(clips) ? clips : [])
        .filter((e) => String(e.name || '').toLowerCase() === a.arg.toLowerCase());
      if (!match.length) {
        await bestEffort(tg.sendMessage(a.chatId,
          'No encontré ningún autor con ese nombre. Prueba /profile sin palabra para ver tu página.'));
        return { clips, dirty: false };
      }
      const keys = [...new Set(match.map((e) => e.key).filter(Boolean))];
      await bestEffort(tg.sendMessage(a.chatId,
        '👥 Autor «' + a.arg + '» — páginas:\n' +
        keys.map((k) => '• ' + pageUrlOf(k, cfg.webUrl)).join('\n')));
    } else {
      await bestEffort(tg.sendMessage(a.chatId,
        '👤 Tu página de autor: ' + pageUrlOf(key, cfg.webUrl) + '\n' +
        '🙂 ' + (names[key] || 'Anónima') + '\n' +
        '💗 Publicados: ' + authorStats(clips, queue, key).published));
    }
    return { clips, dirty: false };
  }
  if (a.kind === 'cmd-stats') {
    const today = clipsToday(clips);
    const authors = new Set((Array.isArray(clips) ? clips : []).map((e) => e.key).filter(Boolean)).size;
    await bestEffort(tg.sendMessage(a.chatId,
      '📊 Ama liberada — stats\n\n' +
      '💗 ' + (Array.isArray(clips) ? clips.length : 0) + ' amores publicados\n' +
      '📅 ' + today.length + ' hoy\n' +
      '⏳ ' + Object.keys(queue).length + ' en moderación\n' +
      '👥 ' + authors + ' autores'));
    return { clips, dirty: false };
  }
  if (a.kind === 'cmd-status') {
    const key = hashId(a.chatId, TG_ID_SECRET);
    const draft = drafts[String(a.chatId)];
    await bestEffort(tg.sendMessage(a.chatId,
      '🟢 Estado del circuito\n\n' +
      '⏳ ' + Object.keys(queue).length + ' amores en moderación\n' +
      '📅 ' + clipsToday(clips).length + ' publicados hoy\n' +
      '💗 ' + (Array.isArray(clips) ? clips.length : 0) + ' amores publicados\n' +
      '✏️ Tu borrador: ' + (draft ? 'en curso (termina en el mensaje anterior)' : '—') + '\n' +
      '👤 Página: ' + pageUrlOf(key, cfg.webUrl)));
    return { clips, dirty: false };
  }
  if (a.kind === 'cmd-queue') {
    const entries = Object.values(queue).slice(0, 10);
    if (!entries.length) {
      await bestEffort(tg.sendMessage(a.chatId, 'No hay amores en moderación ahora mismo 💛'));
      return { clips, dirty: false };
    }
    const lines = ['⏳ En moderación (' + entries.length + '):'];
    entries.forEach((e) => lines.push('• ' + (e.title || '—') + ' · 🙂 ' + (e.name || 'Anónima')));
    await bestEffort(tg.sendMessage(a.chatId, lines.join('\n')));
    return { clips, dirty: false };
  }
  if (a.kind === 'cmd-latest') {
    const cs = latestClips(clips, 5);
    if (!cs.length) {
      await bestEffort(tg.sendMessage(a.chatId, 'Aún no hay amores publicados — sé la primera 💛'));
      return { clips, dirty: false };
    }
    await bestEffort(tg.sendMessage(a.chatId, '💗 Últimos amores:\n\n' + cs.map(clipLine).join('\n')));
    return { clips, dirty: false };
  }
  if (a.kind === 'cmd-now') {
    const e = (Array.isArray(clips) ? clips : [])[0];
    if (!e) {
      await bestEffort(tg.sendMessage(a.chatId, 'Aún no hay amores publicados 💛'));
      return { clips, dirty: false };
    }
    await bestEffort(tg.sendMessage(a.chatId, '▶️ Ahora mismo suena:\n\n' + clipLine(e) + '\n' + e.src));
    return { clips, dirty: false };
  }
  if (a.kind === 'cmd-today') {
    const cs = clipsToday(clips);
    if (!cs.length) {
      await bestEffort(tg.sendMessage(a.chatId, 'Hoy aún no se ha publicado nada 💛'));
      return { clips, dirty: false };
    }
    await bestEffort(tg.sendMessage(a.chatId,
      '📅 Hoy (' + cs.length + '):\n\n' + cs.slice(0, 10).map(clipLine).join('\n')));
    return { clips, dirty: false };
  }
  if (a.kind === 'cmd-since') {
    const days = Math.min(90, Math.max(1, parseInt(a.arg, 10) || 1));
    const cs = clipsSince(clips, days);
    if (!cs.length) {
      await bestEffort(tg.sendMessage(a.chatId, 'No hay amores de los últimos ' + days + ' día(s) 💛'));
      return { clips, dirty: false };
    }
    await bestEffort(tg.sendMessage(a.chatId,
      '🗓️ Últimos ' + days + ' día(s) (' + cs.length + '):\n\n' +
      cs.slice(0, 10).map(clipLine).join('\n')));
    return { clips, dirty: false };
  }
  if (a.kind === 'cmd-random') {
    const e = randomClip(clips);
    if (!e) {
      await bestEffort(tg.sendMessage(a.chatId, 'Aún no hay amores publicados 💛'));
      return { clips, dirty: false };
    }
    await bestEffort(tg.sendMessage(a.chatId, '🎲 Del saco:\n\n' + clipLine(e) + '\n' + e.src));
    return { clips, dirty: false };
  }
  if (a.kind === 'cmd-trending') {
    const top = tagTrend(clips, 50).slice(0, 5);
    if (!top.length) {
      await bestEffort(tg.sendMessage(a.chatId, 'Aún no hay etiquetas que mostrar 💛'));
      return { clips, dirty: false };
    }
    await bestEffort(tg.sendMessage(a.chatId,
      '🔥 Etiquetas con más amores:\n\n' +
      top.map((t, i) => (i + 1) + '. #' + t.tag + ' ×' + t.count).join('\n')));
    return { clips, dirty: false };
  }
  if (a.kind === 'cmd-play') {
    const e = (Array.isArray(clips) ? clips : [])[0];
    if (!e) {
      await bestEffort(tg.sendMessage(a.chatId, 'Aún no hay amores publicados — sé la primera 💛'));
      return { clips, dirty: false };
    }
    await bestEffort(tg.sendAudioByUrl(a.chatId, e.src, clipLine(e),
      { title: e.t, performer: e.name }));
    return { clips, dirty: false };
  }
  if (a.kind === 'inline-search') {
    const cs = searchClips(clips, a.query, 10);
    const results = cs.map(inlineResult);
    await bestEffort(tg.answerInlineQuery(a.queryId, results, {
      cache_time: 300,
      is_personal: false,
      switch_pm_text: results.length ? '' : '💗 Sube tu amor',
      switch_pm_parameter: 'inline_empty'
    }));
    return { clips, dirty: false };
  }
  return { clips, dirty: false };
}

async function commitState() {
  const { stdout } = await run('git', ['status', '--porcelain']);
  if (!stdout.trim()) return;
  const who = ['-c', 'user.name=ama bot', '-c', 'user.email=bot@users.noreply.github.com'];
  await run('git', [...who, 'add', 'ama.json', 'state/']);
  await run('git', [...who, 'commit', '-m', 'ama: publish/moderate (automated)']);
  const token = process.env.GITHUB_TOKEN;
  const remote = token
    ? `https://x-access-token:${token}@github.com/floveorg/ama.git`
    : 'origin';
  try {
    await run('git', ['pull', '--rebase', 'origin', 'main']);
    await run('git', ['push', remote, 'HEAD:main']);
  } catch {
    await run('git', ['pull', '--rebase', 'origin', 'main']);
    await run('git', ['push', remote, 'HEAD:main']);
  }
}

async function main() {
  const cfg = await readJSON('config.json', {});
  const token = process.env.TELEGRAM_BOT_TOKEN;
  // Ama aún no está en producción/desarrollo: pausa silenciosa (sin errores por email).
  if (!token || cfg.enabled === false) {
    console.log('ama bot en pausa (aún no en producción) — sin cambios');
    return;
  }
  if (!cfg.modGroupId || cfg.modGroupId.startsWith('TODO')) throw new Error('config.json modGroupId not set');
  cfg.limits = { ...LIMITS_DEFAULTS, ...(cfg.limits || {}) };
  const tg = Telegram(token);

  let offset = parseInt(await readFile(p('state/offset.txt'), 'utf8'), 10) || 0;
  let queue = await readJSON('state/queue.json', {});
  let drafts = await readJSON('state/drafts.json', {});
  let uploaders = await readJSON('state/.uploaders.json', {});
  let uploads = await readJSON('state/uploads.json', {});
  let tgpub = await readJSON('state/tgpub.json', {});
  let names = await readJSON('state/names.json', {});
  let ama = await readJSON('ama.json', { clips: [], risa: [], flag: {} });
  if (!ama.clips) ama.clips = [];

  const startedAt = Date.now();
  while (Date.now() - startedAt < LOOP_MAX_MS) {
    const modMsgToId = Object.fromEntries(
      Object.entries(queue).map(([id, e]) => [e.modMsgId, id]));
    const awaitingTitle = Object.fromEntries(
      Object.entries(drafts).filter(([, d]) => d.awaitingTitle));
    const awaitingTags = Object.fromEntries(
      Object.entries(drafts).filter(([, d]) => d.awaitingTags));
    const awaitingModEdit = Object.fromEntries(
      Object.entries(queue).filter(([, e]) => e.editing));
    const updates = await tg.getUpdates(offset, POLL_TIMEOUT);
    const { actions, offset: nextOffset } = parseUpdates(
      updates, { modGroupId: cfg.modGroupId, modMsgToId, awaitingTitle, awaitingTags,
                 awaitingModEdit, uploaderOf: uploaders,
                 limits: cfg.limits }, offset);

    for (const a of actions) {
      try {
        const r = await handleAction(a, tg, cfg, queue, drafts, ama.clips, uploaders, uploads, tgpub, names);
        ama.clips = r.clips;
        if (r.dirty) {
          await writeJSON('state/queue.json', queue);
          await writeJSON('state/drafts.json', drafts);
          await writeJSON('state/.uploaders.json', uploaders);
          await writeJSON('state/uploads.json', uploads);
          await writeJSON('state/tgpub.json', tgpub);
          await writeJSON('state/names.json', names);
          await writeJSON('ama.json', ama);
          await bestEffort(commitState());
        }
      } catch (err) {
        console.error('action failed', a.id, a.kind, err.message);
      }
    }

    if (nextOffset !== offset) {
      offset = nextOffset;
      await writeFile(p('state/offset.txt'), String(offset) + '\n');
    }
    if (actions.length) {
      console.log(`processed ${actions.length} action(s); offset ${offset}; clips ${ama.clips.length}`);
    }
  }

  await writeJSON('state/queue.json', queue);
  await writeJSON('state/drafts.json', drafts);
  await writeJSON('state/.uploaders.json', uploaders);
  await writeJSON('state/uploads.json', uploads);
  await writeJSON('state/tgpub.json', tgpub);
  await writeJSON('state/names.json', names);
  await writeJSON('ama.json', ama);
}

main().catch((err) => { console.error('fatal:', err); process.exit(0); });   // no fallar: ama en pausa
