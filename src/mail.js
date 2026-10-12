// The landlord's mailbox (IONOS by default): read the inbox over IMAP and send over SMTP.
// Turned on by MAIL_USER and MAIL_PASSWORD in Railway's Variables. The password never reaches the browser.

const { ImapFlow } = require('imapflow');
const nodemailer = require('nodemailer');
const MailComposer = require('nodemailer/lib/mail-composer');
const { simpleParser } = require('mailparser');

function cfg() {
  return {
    user: (process.env.MAIL_USER || '').trim(),
    pass: process.env.MAIL_PASSWORD || '',
    imapHost: process.env.MAIL_IMAP_HOST || 'imap.ionos.co.uk',
    smtpHost: process.env.MAIL_SMTP_HOST || 'smtp.ionos.co.uk',
    imapPort: Number(process.env.MAIL_IMAP_PORT) || 993,
    smtpPort: Number(process.env.MAIL_SMTP_PORT) || 465,
    fromName: process.env.MAIL_FROM_NAME || 'The Old Mill'
  };
}
const enabled = () => { const c = cfg(); return !!(c.user && c.pass); };

async function withImap(fn) {
  const c = cfg();
  const client = new ImapFlow({ host: c.imapHost, port: c.imapPort, secure: true, auth: { user: c.user, pass: c.pass }, logger: false, socketTimeout: 30000 });
  await client.connect();
  try { return await fn(client); } finally { await client.logout().catch(() => {}); }
}

// Map our two folder names to the mailbox's real folders.
async function folderPath(client, folder) {
  if (folder !== 'sent') return 'INBOX';
  const list = await client.list();
  const sent = list.find(f => f.specialUse === '\\Sent') || list.find(f => /^(sent|sent items|sent messages|gesendete objekte)$/i.test(f.name));
  return sent ? sent.path : null;
}

const addr = list => (list || []).map(a => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', ');

async function listMessages(folder = 'inbox', limit = 50) {
  return withImap(async client => {
    const path = await folderPath(client, folder);
    if (!path) return [];
    const lock = await client.getMailboxLock(path);
    try {
      const total = client.mailbox.exists;
      if (!total) return [];
      const out = [];
      for await (const m of client.fetch(`${Math.max(1, total - limit + 1)}:*`, { uid: true, envelope: true, flags: true, internalDate: true })) {
        out.push({
          uid: m.uid,
          from: addr(m.envelope.from), to: addr(m.envelope.to),
          subject: m.envelope.subject || '(no subject)',
          date: (m.envelope.date || m.internalDate || new Date()).toISOString(),
          seen: m.flags.has('\\Seen')
        });
      }
      return out.reverse();
    } finally { lock.release(); }
  });
}

// Removes anything in an email's HTML that could run code. It's also shown in a locked-down frame,
// so this is a second line of defence.
function cleanHtml(html) {
  return String(html || '')
    .replace(/<\s*(script|iframe|object|embed|applet|frameset|noscript)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*\/?\s*(script|iframe|object|embed|form|frameset|frame|applet|base|meta|link|noscript)\b[^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src|action|xlink:href)\s*=\s*(["']?)\s*(javascript|vbscript|data:text\/html)[^"'\s>]*\2/gi, '$1="#"')
    .slice(0, 600000);
}

async function fetchParsed(folder, uid, markSeen) {
  return withImap(async client => {
    const path = await folderPath(client, folder);
    if (!path) return null;
    const lock = await client.getMailboxLock(path);
    try {
      const m = await client.fetchOne(String(uid), { source: true }, { uid: true });
      if (!m) return null;
      if (markSeen) await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true }).catch(() => {});
      return await simpleParser(m.source); // inline (cid:) pictures become data: images in p.html
    } finally { lock.release(); }
  });
}

const PREVIEWABLE = /^(image\/(png|jpe?g|gif|webp)|application\/pdf)$/i;

async function readMessage(folder, uid) {
  const p = await fetchParsed(folder, uid, true);
  if (!p) return null;
  const fromAddr = (p.from && p.from.value && p.from.value[0]) || {};
  return {
    uid,
    from: p.from ? p.from.text : '', fromAddress: fromAddr.address || '', replyTo: p.replyTo ? p.replyTo.value.map(a => a.address).join(', ') : '',
    to: p.to ? [].concat(p.to).map(t => t.text).join(', ') : '', cc: p.cc ? [].concat(p.cc).map(t => t.text).join(', ') : '',
    subject: p.subject || '(no subject)', date: (p.date || new Date()).toISOString(),
    text: (p.text || '').slice(0, 100000),
    html: p.html ? cleanHtml(p.html) : '',
    messageId: p.messageId || '', references: [].concat(p.references || []),
    attachments: (p.attachments || []).map((a, i) => ({ index: i, filename: a.filename || `attachment-${i + 1}`, size: a.size, contentType: a.contentType || 'application/octet-stream', inline: a.contentDisposition === 'inline' && !!a.cid, previewable: PREVIEWABLE.test(a.contentType || '') }))
  };
}

async function getAttachment(folder, uid, index) {
  const p = await fetchParsed(folder, uid, false);
  const a = p && (p.attachments || [])[index];
  return a ? { filename: a.filename || `attachment-${index + 1}`, contentType: a.contentType || 'application/octet-stream', content: a.content, previewable: PREVIEWABLE.test(a.contentType || '') } : null;
}

// Sends from the mailbox and files a copy in its Sent folder so phones and webmail see it too.
async function sendMail({ to, subject, text, html, inReplyTo, references, replyTo }) {
  const c = cfg();
  const message = {
    from: { name: c.fromName, address: c.user }, to, subject, text, ...(html ? { html: cleanHtml(html) } : {}), ...(replyTo ? { replyTo } : {}),
    ...(inReplyTo ? { inReplyTo } : {}), ...(references && references.length ? { references } : {})
  };
  const raw = await new MailComposer(message).compile().build();
  const recipients = [].concat(to).join(',').split(',').map(s => s.trim()).filter(Boolean);
  if (process.env.RESEND_API_KEY) {
    // Railway's Hobby plan blocks outgoing SMTP, so send through Resend's web API instead. Same From address.
    const headers = {};
    if (inReplyTo) headers['In-Reply-To'] = inReplyTo;
    if (references && references.length) headers.References = references.join(' ');
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', signal: AbortSignal.timeout(20000),
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: `${c.fromName} <${c.user}>`, to: recipients, subject, text, ...(message.html ? { html: message.html } : {}), ...(replyTo ? { reply_to: replyTo } : {}), ...(Object.keys(headers).length ? { headers } : {}) })
    });
    if (!r.ok) { const body = await r.json().catch(() => ({})); const err = new Error(`Resend: ${body.message || r.status}`); err.code = 'ERESEND'; throw err; }
  } else {
    const transport = nodemailer.createTransport({ host: c.smtpHost, port: c.smtpPort, secure: true, auth: { user: c.user, pass: c.pass }, connectionTimeout: 15000, greetingTimeout: 10000, socketTimeout: 20000 });
    await transport.sendMail({ envelope: { from: c.user, to: recipients }, raw });
  }
  try {
    await withImap(async client => {
      const path = await folderPath(client, 'sent');
      if (path) await client.append(path, raw, ['\\Seen']);
    });
  } catch (e) { console.warn('Sent, but could not file a copy in Sent:', e.message); }
}

module.exports = { enabled, address: () => cfg().user, listMessages, readMessage, getAttachment, sendMail };
