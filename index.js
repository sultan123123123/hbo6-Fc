require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const {
  Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  SlashCommandBuilder, PermissionFlagsBits, ChannelType, REST, Routes, MessageFlags,
} = require('discord.js');

/* ---------- Config ---------- */
const { TOKEN, CLIENT_ID, CLIENT_SECRET } = process.env;
const BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '');
const PORT = process.env.PORT || 3000;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update(String(TOKEN)).digest('hex');
if (!BASE_URL) console.warn('⚠️ BASE_URL غير محدد، اللوحة ما بتشتغل.');

/* ---------- Storage (JSON file) ---------- */
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'vote-data.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

let db = { polls: {}, rosters: {} };
try {
  if (fs.existsSync(DATA_FILE)) db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
} catch (e) {
  console.error('⚠️ ما قدرت أقرأ ملف البيانات:', e.message);
}
db.polls = db.polls || {};
db.rosters = db.rosters || {};
function getRoster(gid) {
  if (!db.rosters[gid]) db.rosters[gid] = [];
  return db.rosters[gid];
}
function save() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DATA_FILE);
}

/* ---------- Poll helpers ---------- */
const isEnded = (poll) => poll.ended || Date.now() >= poll.endsAt;

function getCounts(poll) {
  const counts = poll.options.map(() => 0);
  Object.values(poll.votes).forEach(list => list.forEach(idx => { if (counts[idx] !== undefined) counts[idx]++; }));
  return counts;
}

function buildEmbed(poll, id, counts) {
  const ended = isEnded(poll);
  const total = counts.reduce((a, b) => a + b, 0);
  const desc = poll.options.map((o, i) => {
    const pct = total ? Math.round((counts[i] / total) * 100) : 0;
    const f = Math.round(pct / 10);
    return `**${i + 1}. ${o.name}**\n${'█'.repeat(f)}${'░'.repeat(10 - f)} ${counts[i]} صوت (${pct}%)`;
  }).join('\n\n');
  const ts = Math.floor(poll.endsAt / 1000);
  return new EmbedBuilder()
    .setTitle(`🗳️ ${poll.title}`)
    .setDescription(desc + (ended ? '' : `\n\n⏰ ينتهي <t:${ts}:R>\nلكل شخص ${poll.maxVotes} أصوات كحد أقصى • اضغط على اسم عشان تصوّت، واضغط مرة ثانية عشان تسحب صوتك`))
    .setColor(ended ? 0xed4245 : 0x5865f2)
    .setFooter({ text: ended ? `انتهى • إجمالي الأصوات: ${total}` : `إجمالي الأصوات: ${total} • ID: ${id}` });
}

function buildButtons(poll, id, disabled = false) {
  const rows = [];
  for (let i = 0; i < poll.options.length; i += 5) {
    const row = new ActionRowBuilder();
    poll.options.slice(i, i + 5).forEach((o, j) => {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`vote:${id}:${i + j}`)
          .setLabel(o.name.slice(0, 80))
          .setStyle(ButtonStyle.Primary)
          .setDisabled(disabled),
      );
    });
    rows.push(row);
  }
  return rows;
}

async function finalize(id) {
  const poll = db.polls[id];
  if (!poll || poll.finalized) return;
  poll.ended = true;
  poll.finalized = true;
  save();
  const counts = getCounts(poll);
  try {
    const ch = await client.channels.fetch(poll.channelId);
    const msg = await ch.messages.fetch(poll.messageId);
    await msg.edit({ embeds: [buildEmbed(poll, id, counts)], components: [] });
    const max = Math.max(...counts);
    const winners = poll.options.filter((_, k) => counts[k] === max && max > 0).map(o => o.name);
    await ch.send(winners.length
      ? `🏆 انتهى التصويت **${poll.title}**\nالفائز: **${winners.join(' ، ')}** بعدد ${max} صوت`
      : `🏁 انتهى التصويت **${poll.title}** بدون أي أصوات.`);
  } catch (e) {
    console.error('finalize:', e.message);
  }
}

async function canManage(guild, userId) {
  if (ADMIN_IDS.includes(userId)) return true;
  const m = await guild.members.fetch(userId).catch(() => null);
  return !!m && m.permissions.has(PermissionFlagsBits.ManageGuild);
}

/* ---------- Discord bot ---------- */
const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });

const commands = [
  new SlashCommandBuilder()
    .setName('poll')
    .setDescription('نظام التصويت')
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(s => s.setName('end').setDescription('إنهاء تصويت الآن')
      .addStringOption(o => o.setName('poll_id').setDescription('ايدي التصويت (تلقاه أسفل الرسالة)').setRequired(true))),
].map(c => c.toJSON());

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
  await new REST({ version: '10' }).setToken(TOKEN)
    .put(Routes.applicationCommands(CLIENT_ID), { body: commands });
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.on('interactionCreate', async (i) => {
  try {
    /* --- Slash commands --- */
    if (i.isChatInputCommand() && i.commandName === 'poll') {
      const sub = i.options.getSubcommand();

      if (sub === 'end') {
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        const id = i.options.getString('poll_id').trim();
        const poll = db.polls[id];
        if (!poll || poll.guildId !== i.guildId) return i.editReply('❌ ما لقيت تصويت بهذا الايدي.');
        if (poll.finalized) return i.editReply('⚠️ التصويت منتهي أصلاً.');
        await finalize(id);
        return i.editReply('✅ تم إنهاء التصويت.');
      }
    }

    /* --- Vote buttons --- */
    if (i.isButton() && i.customId.startsWith('vote:')) {
      const [, id, idxStr] = i.customId.split(':');
      const idx = parseInt(idxStr, 10);
      const poll = db.polls[id];
      if (!poll) return i.reply(ephemeral('❌ هذا التصويت غير موجود.'));
      if (isEnded(poll)) {
        finalize(id);
        return i.reply(ephemeral('🔒 التصويت منتهي.'));
      }
      const opt = poll.options[idx];
      if (!opt) return i.reply(ephemeral('❌ خيار غير صالح.'));
      if (opt.userId && opt.userId === i.user.id)
        return i.reply(ephemeral('❌ ما تقدر تصوّت لنفسك.'));

      const mine = poll.votes[i.user.id] || [];
      let notice;

      if (mine.includes(idx)) {
        const rest = mine.filter(v => v !== idx);
        if (rest.length) poll.votes[i.user.id] = rest; else delete poll.votes[i.user.id];
        notice = `↩️ سحبت صوتك من **${opt.name}** (${rest.length}/${poll.maxVotes})`;
      } else {
        if (mine.length >= poll.maxVotes)
          return i.reply(ephemeral(`❌ وصلت الحد الأقصى (${poll.maxVotes} أصوات). اضغط على اسم صوّتّ له عشان تسحب صوتك وتغيّره.`));
        poll.votes[i.user.id] = [...mine, idx];
        notice = `✅ صوّتّ لـ **${opt.name}** (${mine.length + 1}/${poll.maxVotes})`;
      }
      save();

      await i.update({ embeds: [buildEmbed(poll, id, getCounts(poll))], components: buildButtons(poll, id) });
      await i.followUp(ephemeral(notice));
    }
  } catch (err) {
    console.error(err);
    if (i.deferred) i.editReply('❌ صار خطأ، حاول مرة ثانية.').catch(() => {});
    else if (!i.replied) i.reply(ephemeral('❌ صار خطأ، حاول مرة ثانية.')).catch(() => {});
  }
});

// إنهاء التصويتات اللي خلص وقتها تلقائياً
setInterval(() => {
  for (const [id, poll] of Object.entries(db.polls)) {
    if (!poll.finalized && Date.now() >= poll.endsAt) finalize(id);
  }
}, 30 * 1000);

/* ---------- Web: sessions & helpers ---------- */
const sign = (v) => {
  const p = Buffer.from(JSON.stringify(v)).toString('base64url');
  return p + '.' + crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
};
const unsign = (t) => {
  if (!t) return null;
  const [p, s] = t.split('.');
  if (!p || !s) return null;
  const e = crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
  if (s.length !== e.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(e))) return null;
  try {
    const v = JSON.parse(Buffer.from(p, 'base64url').toString());
    if (v.exp && v.exp < Date.now()) return null;
    return v;
  } catch { return null; }
};
const parseCookies = (req) => Object.fromEntries(
  (req.headers.cookie || '').split(';').map(c => c.trim().split(/=(.*)/s).slice(0, 2)).filter(a => a[0]),
);
const send = (res, code, body, type = 'application/json; charset=utf-8', headers = {}) => {
  res.writeHead(code, { 'Content-Type': type, ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};
const redirect = (res, to, headers = {}) => { res.writeHead(302, { Location: to, ...headers }); res.end(); };
const readBody = (req) => new Promise((ok, no) => {
  let d = '';
  req.on('data', c => { d += c; if (d.length > 5e4) { req.destroy(); no(new Error('too big')); } });
  req.on('end', () => { try { ok(JSON.parse(d || '{}')); } catch (e) { no(e); } });
});

async function memberName(guild, uid) {
  const m = guild.members.cache.get(uid) || await guild.members.fetch(uid).catch(() => null);
  return m ? m.displayName : '(خرج من السيرفر)';
}

async function managedGuilds(userId) {
  const list = [];
  for (const g of client.guilds.cache.values()) {
    if (await canManage(g, userId)) list.push(g);
  }
  return list;
}

/* ---------- Web: server ---------- */
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const user = unsign(parseCookies(req).sid);

    if (req.method === 'GET' && p === '/') return send(res, 200, 'Vote bot is running', 'text/plain; charset=utf-8');

    /* --- Discord login --- */
    if (req.method === 'GET' && p === '/login') {
      const state = sign({ exp: Date.now() + 10 * 60 * 1000 });
      const q = new URLSearchParams({
        client_id: CLIENT_ID, response_type: 'code', scope: 'identify',
        redirect_uri: `${BASE_URL}/callback`, state, prompt: 'none',
      });
      return redirect(res, `https://discord.com/oauth2/authorize?${q}`);
    }

    if (req.method === 'GET' && p === '/callback') {
      const st = unsign(url.searchParams.get('state'));
      const code = url.searchParams.get('code');
      if (!st || !code) return send(res, 400, 'طلب غير صالح', 'text/plain; charset=utf-8');

      const tr = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: 'authorization_code',
          code, redirect_uri: `${BASE_URL}/callback`,
        }),
      });
      const t = await tr.json();
      if (!t.access_token) return send(res, 400, 'فشل تسجيل الدخول', 'text/plain; charset=utf-8');

      const u = await (await fetch('https://discord.com/api/users/@me', {
        headers: { Authorization: `Bearer ${t.access_token}` },
      })).json();
      if (!u.id) return send(res, 400, 'فشل تسجيل الدخول', 'text/plain; charset=utf-8');

      const sid = sign({ id: u.id, name: u.global_name || u.username, exp: Date.now() + 7 * 24 * 3600 * 1000 });
      const secure = BASE_URL.startsWith('https') ? '; Secure' : '';
      return redirect(res, '/admin', { 'Set-Cookie': `sid=${sid}; HttpOnly; Path=/; Max-Age=604800; SameSite=Lax${secure}` });
    }

    /* --- Admin page --- */
    if (req.method === 'GET' && p === '/admin') return send(res, 200, PAGE, 'text/html; charset=utf-8');

    /* --- Admin API --- */
    if (p.startsWith('/api/admin/')) {
      if (!user) return send(res, 401, { error: 'سجّل دخول أول' });

      // بيانات اللوحة
      if (req.method === 'GET' && p === '/api/admin/data') {
        const guilds = await managedGuilds(user.id);
        console.log(`[admin] user=${user.id} botGuilds=${client.guilds.cache.size} allowed=${guilds.length} adminIds=${ADMIN_IDS.length}`);
        const ids = new Set(guilds.map(g => g.id));
        const polls = [];
        const entries = Object.entries(db.polls)
          .filter(([, po]) => ids.has(po.guildId))
          .sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));

        for (const [id, po] of entries) {
          const guild = client.guilds.cache.get(po.guildId);
          const counts = getCounts(po);
          const options = [];
          for (let k = 0; k < po.options.length; k++) {
            const voterIds = Object.entries(po.votes).filter(([, l]) => l.includes(k)).map(([uid]) => uid);
            const voters = await Promise.all(voterIds.map(async uid => ({ id: uid, name: await memberName(guild, uid) })));
            options.push({ name: po.options[k].name, userId: po.options[k].userId || null, count: counts[k], voters });
          }
          polls.push({
            id, title: po.title, guildName: guild.name, ended: isEnded(po), endsAt: po.endsAt,
            totalVoters: Object.keys(po.votes).length, maxVotes: po.maxVotes, options,
            link: `https://discord.com/channels/${po.guildId}/${po.channelId}/${po.messageId}`,
          });
        }

        return send(res, 200, {
          user: { id: user.id, name: user.name },
          guilds: guilds.map(g => ({
            id: g.id, name: g.name,
            roster: getRoster(g.id),
            channels: g.channels.cache
              .filter(c => c.type === ChannelType.GuildText && c.permissionsFor(g.members.me)?.has([
                PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks,
              ]))
              .sort((a, b) => a.rawPosition - b.rawPosition)
              .map(c => ({ id: c.id, name: c.name })),
          })),
          polls,
        });
      }

      // إنشاء تصويت
      if (req.method === 'POST' && p === '/api/admin/create') {
        const b = await readBody(req);
        const guild = client.guilds.cache.get(String(b.guildId));
        if (!guild || !(await canManage(guild, user.id))) return send(res, 403, { error: 'ما عندك صلاحية على هذا السيرفر' });
        const ch = guild.channels.cache.get(String(b.channelId));
        if (!ch || ch.type !== ChannelType.GuildText) return send(res, 400, { error: 'اختر روم صالح' });

        const title = String(b.title || '').trim().slice(0, 200);
        if (!title) return send(res, 400, { error: 'اكتب عنوان التصويت' });

        const rawOpts = Array.isArray(b.options) ? b.options : [];
        const options = [];
        for (const o of rawOpts) {
          const name = String((o && o.name) || '').trim().slice(0, 80);
          const userId = String((o && o.userId) || '').trim();
          if (!name) return send(res, 400, { error: 'كل مرشح لازم يكون له اسم' });
          if (userId && !/^\d{17,20}$/.test(userId)) return send(res, 400, { error: `الايدي غير صحيح عند: ${name}` });
          options.push({ name, userId: userId || null });
        }
        if (options.length < 2 || options.length > 20) return send(res, 400, { error: 'لازم من 2 إلى 20 مرشح' });

        const roster = getRoster(guild.id);
        options.forEach(o => {
          const existing = roster.find(r => (o.userId && r.userId === o.userId) || (!o.userId && !r.userId && r.name === o.name));
          if (existing) { existing.name = o.name; existing.userId = o.userId; }
          else roster.push({ id: crypto.randomBytes(4).toString('hex'), name: o.name, userId: o.userId });
        });

        const maxVotes = Math.min(Math.max(parseInt(b.maxVotes, 10) || 2, 1), Math.min(10, options.length));
        const hours = Math.min(Math.max(parseInt(b.hours, 10) || 24, 1), 720);

        const id = crypto.randomBytes(4).toString('hex');
        const poll = {
          guildId: guild.id, channelId: ch.id, messageId: null, title, options, maxVotes,
          endsAt: Date.now() + hours * 3600 * 1000, ended: false, finalized: false,
          createdBy: user.id, createdAt: Date.now(), votes: {},
        };
        try {
          const msg = await ch.send({
            embeds: [buildEmbed(poll, id, getCounts(poll))],
            components: buildButtons(poll, id),
          });
          poll.messageId = msg.id;
        } catch (e) {
          return send(res, 400, { error: 'ما قدرت أرسل في هذا الروم، تأكد من صلاحيات البوت' });
        }
        db.polls[id] = poll;
        save();
        return send(res, 200, { ok: true, id });
      }

      // إنهاء تصويت
      if (req.method === 'POST' && p === '/api/admin/end') {
        const b = await readBody(req);
        const poll = db.polls[String(b.id)];
        if (!poll) return send(res, 404, { error: 'التصويت غير موجود' });
        const guild = client.guilds.cache.get(poll.guildId);
        if (!guild || !(await canManage(guild, user.id))) return send(res, 403, { error: 'ما عندك صلاحية' });
        await finalize(String(b.id));
        return send(res, 200, { ok: true });
      }

      // حذف صوت شخص لمرشح معيّن
      if (req.method === 'POST' && p === '/api/admin/remove-vote') {
        const b = await readBody(req);
        const poll = db.polls[String(b.id)];
        if (!poll) return send(res, 404, { error: 'التصويت غير موجود' });
        const guild = client.guilds.cache.get(poll.guildId);
        if (!guild || !(await canManage(guild, user.id))) return send(res, 403, { error: 'ما عندك صلاحية' });

        const targetUserId = String(b.userId || '');
        const idx = parseInt(b.option, 10);
        const mine = poll.votes[targetUserId] || [];
        if (!mine.includes(idx)) return send(res, 400, { error: 'ما فيه صوت لحذفه' });

        const rest = mine.filter(v => v !== idx);
        if (rest.length) poll.votes[targetUserId] = rest; else delete poll.votes[targetUserId];
        save();

        if (!isEnded(poll)) {
          try {
            const ch = await client.channels.fetch(poll.channelId);
            const msg = await ch.messages.fetch(poll.messageId);
            await msg.edit({ embeds: [buildEmbed(poll, String(b.id), getCounts(poll))], components: buildButtons(poll, String(b.id)) });
          } catch (e) { console.error('remove-vote refresh:', e.message); }
        }
        return send(res, 200, { ok: true });
      }

      // إضافة/تعديل مرشح في القائمة المحفوظة
      if (req.method === 'POST' && p === '/api/admin/roster/upsert') {
        const b = await readBody(req);
        const guild = client.guilds.cache.get(String(b.guildId));
        if (!guild || !(await canManage(guild, user.id))) return send(res, 403, { error: 'ما عندك صلاحية' });

        const name = String(b.name || '').trim().slice(0, 80);
        const userId = String(b.userId || '').trim();
        if (!name) return send(res, 400, { error: 'اكتب اسم' });
        if (userId && !/^\d{17,20}$/.test(userId)) return send(res, 400, { error: 'الايدي غير صحيح' });

        const roster = getRoster(guild.id);
        let entry = b.id ? roster.find(r => r.id === String(b.id)) : null;
        if (entry) { entry.name = name; entry.userId = userId || null; }
        else { entry = { id: crypto.randomBytes(4).toString('hex'), name, userId: userId || null }; roster.push(entry); }
        save();
        return send(res, 200, { ok: true, entry });
      }

      // حذف مرشح من القائمة المحفوظة
      if (req.method === 'POST' && p === '/api/admin/roster/delete') {
        const b = await readBody(req);
        const guild = client.guilds.cache.get(String(b.guildId));
        if (!guild || !(await canManage(guild, user.id))) return send(res, 403, { error: 'ما عندك صلاحية' });
        db.rosters[guild.id] = getRoster(guild.id).filter(r => r.id !== String(b.id));
        save();
        return send(res, 200, { ok: true });
      }
    }

    send(res, 404, 'Not found', 'text/plain; charset=utf-8');
  } catch (e) {
    console.error(e);
    send(res, 500, { error: 'خطأ في السيرفر' });
  }
});

/* ---------- Web: admin page ---------- */
const PAGE = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>لوحة التصويت</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;background:#1e1f22;color:#f2f3f5;font-family:'Segoe UI',Tahoma,Arial,sans-serif;padding:20px}
  .wrap{max-width:640px;margin:0 auto}
  .top{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;gap:8px;flex-wrap:wrap}
  h1{margin:0;font-size:20px}
  h2{margin:0 0 12px;font-size:16px}
  h3{margin:0;font-size:16px;word-break:break-word}
  .card{background:#0b0b0d;border:1px solid #2a2a2e;border-radius:14px;padding:18px;margin-bottom:16px}
  .muted{color:#80848e;font-size:13px}
  label{display:block;font-size:13px;color:#b5bac1;margin:10px 0 4px}
  input,select{width:100%;background:#18181c;color:#f2f3f5;border:1px solid #2a2a2e;border-radius:8px;padding:10px;font:inherit;font-size:14px}
  input:focus,select:focus{outline:none;border-color:#5865f2}
  .two{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  .crow{display:grid;grid-template-columns:1fr 1fr auto;gap:8px;margin-bottom:8px}
  .crow button{padding:0 12px}
  .rrow{display:flex;align-items:center;gap:6px;padding:8px 0;border-bottom:1px solid #2a2a2e;font-size:13px}
  .rrow span{flex:1;word-break:break-word}
  button.small{padding:5px 10px;font-size:12px}
  button,.btn{font:inherit;font-size:14px;font-weight:600;border:0;border-radius:8px;padding:10px 18px;cursor:pointer;text-decoration:none;display:inline-block;color:#fff}
  .primary{background:#5865f2}
  .primary:disabled{background:#3b3d8f;color:#8a8cc0;cursor:not-allowed}
  .ghost{background:#2b2d31}
  .danger{background:#da373c}
  .row{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}
  .badge{font-size:12px;padding:3px 10px;border-radius:20px}
  .live{background:#248046}
  .end{background:#4e5058}
  details.opt{background:#18181c;border-radius:10px;margin-top:8px;padding:12px 14px}
  details summary{cursor:pointer;display:flex;justify-content:space-between;gap:8px;align-items:center;list-style:none}
  details summary::-webkit-details-marker{display:none}
  details summary .arrow{color:#80848e;font-size:12px;margin-inline-end:6px;transition:transform .15s}
  details[open] summary .arrow{transform:rotate(90deg)}
  details summary small{color:#80848e;font-size:11px;direction:ltr}
  .voters{margin-top:10px;padding-top:10px;border-top:1px solid #2a2a2e;font-size:13px;color:#dbdee1}
  .voters div{padding:3px 0}
  .vrow{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:4px 0}
  button.small{padding:4px 10px;font-size:12px}
  .msg{margin-top:10px;font-size:13px;min-height:18px}
  .err{color:#f0b232}.ok{color:#57f287}
  a{color:#8ea1e1}
</style>
</head>
<body>
<div class="wrap" id="root">جاري التحميل...</div>
<script>
var root=document.getElementById('root'),D=null,built=false,fillRosterRef=null,copyPollRef=null;
function el(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x!==undefined)e.textContent=x;return e;}
async function api(path,body){
  var r=await fetch(path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:undefined);
  var j={};try{j=await r.json();}catch(e){}
  return {ok:r.ok,status:r.status,j:j};
}
function timeLeft(ms){if(ms<=0)return 'انتهى';var m=Math.floor(ms/60000),h=Math.floor(m/60),d=Math.floor(h/24);if(d>=1)return 'باقي '+d+' يوم';if(h>=1)return 'باقي '+h+' ساعة';return 'باقي '+Math.max(m,1)+' دقيقة';}

async function load(){
  var r=await api('/api/admin/data');
  if(r.status===401){
    root.innerHTML='';
    var c=el('div','card');
    c.appendChild(el('h2','','لوحة التصويت'));
    c.appendChild(el('p','muted','سجّل دخول بحساب ديسكورد (لازم تكون عندك صلاحية Manage Server)'));
    var a=el('a','btn primary','تسجيل الدخول بديسكورد');a.href='/login';c.appendChild(a);
    root.appendChild(c);return;
  }
  if(!r.ok){root.textContent=r.j.error||'صار خطأ';return;}
  D=r.j;
  if(!built){buildShell();built=true;}
  if(fillRosterRef)fillRosterRef();
  renderList();
}

function buildShell(){
  root.innerHTML='';
  var top=el('div','top');
  top.appendChild(el('h1','','🗳️ لوحة التصويت'));
  var right=el('div','row');
  right.appendChild(el('span','muted',D.user.name));
  var rf=el('button','ghost','تحديث');rf.onclick=load;right.appendChild(rf);
  top.appendChild(right);
  root.appendChild(top);

  var f=el('div','card');
  f.appendChild(el('h2','','تصويت جديد'));
  if(!D.guilds.length){
    f.appendChild(el('p','muted','ما لقيت سيرفر عندك فيه صلاحية والبوت موجود فيه.'));
    f.appendChild(el('p','muted','ايدي حسابك الحالي (انسخه وحطه في ADMIN_IDS على Railway):'));
    var idBox=el('input');idBox.value=D.user.id;idBox.readOnly=true;idBox.style.direction='ltr';idBox.onclick=function(){idBox.select();};
    f.appendChild(idBox);
    root.appendChild(f);root.appendChild(el('div','',''));var l0=el('div','');l0.id='list';root.appendChild(l0);return;
  }

  f.appendChild(el('label','','السيرفر'));
  var gs=el('select');gs.id='guild';
  D.guilds.forEach(function(g){var o=el('option','',g.name);o.value=g.id;gs.appendChild(o);});
  f.appendChild(gs);

  f.appendChild(el('label','','الروم اللي ينرسل فيه التصويت'));
  var cs=el('select');cs.id='channel';f.appendChild(cs);
  function fillChannels(){
    cs.innerHTML='';
    var g=D.guilds.filter(function(x){return x.id===gs.value;})[0];
    g.channels.forEach(function(c){var o=el('option','','# '+c.name);o.value=c.id;cs.appendChild(o);});
  }
  gs.onchange=function(){fillChannels();if(fillRosterRef)fillRosterRef();};fillChannels();

  f.appendChild(el('label','','عنوان التصويت'));
  var ti=el('input');ti.id='title';ti.placeholder='مثال: أفضل ضابط لهذا الشهر';f.appendChild(ti);

  var two=el('div','two');
  var d1=el('div');d1.appendChild(el('label','','أقصى أصوات لكل شخص'));
  var mv=el('input');mv.id='maxVotes';mv.type='number';mv.min=1;mv.max=10;mv.value=2;d1.appendChild(mv);
  var d2=el('div');d2.appendChild(el('label','','المدة (ساعات)'));
  var hr=el('input');hr.id='hours';hr.type='number';hr.min=1;hr.max=720;hr.value=24;d2.appendChild(hr);
  two.appendChild(d1);two.appendChild(d2);f.appendChild(two);

  f.appendChild(el('label','','المرشحين (الاسم + ايدي ديسكورد اختياري عشان ما يصوّت لنفسه)'));
  var rows=el('div');rows.id='rows';f.appendChild(rows);
  function addRow(name,userId){
    var r=el('div','crow');
    var n=el('input');n.placeholder='الاسم';n.value=name||'';
    var u=el('input');u.placeholder='Copy User ID (اختياري)';u.inputMode='numeric';u.style.direction='ltr';u.value=userId||'';
    var x=el('button','ghost','✕');x.onclick=function(){r.remove();};
    r.appendChild(n);r.appendChild(u);r.appendChild(x);rows.appendChild(r);
  }
  addRow();addRow();addRow();
  var add=el('button','ghost','+ إضافة مرشح');add.onclick=function(){addRow();};f.appendChild(add);
  f.appendChild(el('p','muted','عشان تجيب الايدي: فعّل Developer Mode في ديسكورد ثم كليك يمين على الشخص ثم Copy User ID.'));

  function copyPollIntoForm(p){
    var g=D.guilds.filter(function(x){return x.id===gs.value;})[0];
    if(!g||p.guildName!==g.name){
      var match=D.guilds.filter(function(x){return x.name===p.guildName;})[0];
      if(match)gs.value=match.id;
      fillChannels();
    }
    ti.value=p.title;
    mv.value=p.maxVotes;
    rows.innerHTML='';
    p.options.forEach(function(o){addRow(o.name,o.userId);});
    f.scrollIntoView({behavior:'smooth'});
  }
  copyPollRef=copyPollIntoForm;

  var rosterBox=el('div');rosterBox.id='rosterBox';rosterBox.style.marginTop='16px';f.appendChild(rosterBox);
  function fillRoster(){
    rosterBox.innerHTML='';
    var g=D.guilds.filter(function(x){return x.id===gs.value;})[0];
    var roster=g.roster||[];
    rosterBox.appendChild(el('div','muted','المرشحين المحفوظين لهذا السيرفر:'));
    if(!roster.length){rosterBox.appendChild(el('div','muted','ما فيه أحد محفوظ بعد')); return;}
    roster.forEach(function(r){
      var row=el('div','rrow');
      row.appendChild(el('span','',r.name+(r.userId?'  '+r.userId:'')));
      var addBtn=el('button','ghost small','إضافة');
      addBtn.onclick=function(){addRow(r.name,r.userId);};
      var editBtn=el('button','ghost small','تعديل');
      editBtn.onclick=async function(){
        var newName=prompt('الاسم:',r.name);if(newName===null)return;
        var newId=prompt('ايدي ديسكورد (اتركه فاضي بدون ايدي):',r.userId||'');if(newId===null)return;
        var res=await api('/api/admin/roster/upsert',{guildId:g.id,id:r.id,name:newName.trim(),userId:newId.trim()});
        if(!res.ok){alert(res.j.error||'صار خطأ');return;}
        load();
      };
      var delBtn=el('button','ghost small','حذف');
      delBtn.onclick=async function(){
        if(!confirm('تحذف '+r.name+' من القائمة المحفوظة؟'))return;
        var res=await api('/api/admin/roster/delete',{guildId:g.id,id:r.id});
        if(!res.ok){alert(res.j.error||'صار خطأ');return;}
        load();
      };
      row.appendChild(addBtn);row.appendChild(editBtn);row.appendChild(delBtn);
      rosterBox.appendChild(row);
    });
  }
  fillRosterRef=fillRoster;
  fillRoster();

  var go=el('button','primary','نشر التصويت في ديسكورد');
  var msg=el('div','msg');
  go.onclick=async function(){
    var opts=[];
    rows.querySelectorAll('.crow').forEach(function(r){
      var n=r.children[0].value.trim(),u=r.children[1].value.trim();
      if(n||u)opts.push({name:n,userId:u});
    });
    go.disabled=true;msg.className='msg';msg.textContent='جاري النشر...';
    var r=await api('/api/admin/create',{
      guildId:gs.value,channelId:cs.value,title:ti.value,
      maxVotes:mv.value,hours:hr.value,options:opts
    });
    go.disabled=false;
    if(!r.ok){msg.className='msg err';msg.textContent=r.j.error||'صار خطأ';return;}
    msg.className='msg ok';msg.textContent='✅ تم نشر التصويت في ديسكورد';
    ti.value='';rows.innerHTML='';addRow();addRow();addRow();
    load();
  };
  f.appendChild(go);f.appendChild(msg);
  root.appendChild(f);

  var h=el('h2','','التصويتات');h.style.margin='24px 0 12px';root.appendChild(h);
  var l=el('div');l.id='list';root.appendChild(l);
}

function renderList(){
  var box=document.getElementById('list');box.innerHTML='';
  if(!D.polls.length){box.appendChild(el('p','muted','ما فيه تصويتات بعد'));return;}
  D.polls.forEach(function(p){
    var c=el('div','card');
    var h=el('div','row');
    h.appendChild(el('h3','',p.title));
    h.appendChild(el('span','badge '+(p.ended?'end':'live'),p.ended?'منتهي':'شغال'));
    c.appendChild(h);
    c.appendChild(el('div','muted',p.guildName+' • '+p.totalVoters+' مشارك • '+(p.ended?'انتهى':timeLeft(p.endsAt-Date.now()))+' • ID: '+p.id));
    p.options.forEach(function(o,oi){
      var d=document.createElement('details');d.className='opt';
      var s=document.createElement('summary');
      var nm=el('span','',o.name);
      var arrow=el('span','arrow','›');
      nm.insertBefore(arrow,nm.firstChild);
      if(o.userId){nm.appendChild(el('small','',' '+o.userId));}
      s.appendChild(nm);
      s.appendChild(el('b','',o.count+' صوت'));
      d.appendChild(s);
      var v=el('div','voters');
      v.appendChild(el('p','muted','اضغط على اسم عشان تزيل صوته'));
      if(!o.voters.length)v.appendChild(el('span','muted','ما أحد صوّت له'));
      o.voters.forEach(function(x){
        var row=el('div','vrow');
        row.appendChild(el('span','',x.name+'  ('+x.id+')'));
        var rm=el('button','ghost small','إزالة');
        rm.onclick=async function(ev){
          ev.preventDefault();
          if(!confirm('تزيل صوت '+x.name+' عن '+o.name+'؟'))return;
          rm.disabled=true;
          var r=await api('/api/admin/remove-vote',{id:p.id,userId:x.id,option:oi});
          if(!r.ok){alert(r.j.error||'صار خطأ');rm.disabled=false;return;}
          load();
        };
        row.appendChild(rm);
        v.appendChild(row);
      });
      d.appendChild(v);c.appendChild(d);
    });
    var act=el('div','row');act.style.marginTop='14px';
    var cp=el('button','ghost','نسخ الأسماء لتصويت جديد');
    cp.onclick=function(){ if(copyPollRef) copyPollRef(p); };
    act.appendChild(cp);
    var a=el('a','btn ghost','فتح الرسالة في ديسكورد');a.href=p.link;a.target='_blank';act.appendChild(a);
    if(!p.ended){
      var e=el('button','danger','إنهاء التصويت');
      e.onclick=async function(){
        if(!confirm('تنهي هذا التصويت الحين؟'))return;
        e.disabled=true;
        await api('/api/admin/end',{id:p.id});
        load();
      };
      act.appendChild(e);
    }
    c.appendChild(act);
    box.appendChild(c);
  });
}
load();
</script>
</body>
</html>`;

/* ---------- Start ---------- */
server.listen(PORT, () => console.log(`🌐 Web on port ${PORT}`));
client.login(TOKEN).catch(console.error);
