require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const {
  Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, SlashCommandBuilder, PermissionFlagsBits, REST, Routes, MessageFlags,
} = require('discord.js');

/* ---------- Config ---------- */
const { TOKEN, CLIENT_ID, CLIENT_SECRET } = process.env;
const BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '');
const PORT = process.env.PORT || 3000;
const SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update(String(TOKEN)).digest('hex');
if (!BASE_URL) console.warn('⚠️ BASE_URL غير محدد، الأزرار والتسجيل ما بيشتغلون.');

/* ---------- Storage (JSON file) ---------- */
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'vote-data.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

let db = { polls: {} };
try {
  if (fs.existsSync(DATA_FILE)) db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
} catch (e) {
  console.error('⚠️ ما قدرت أقرأ ملف البيانات:', e.message);
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
    if (!ended) return `**${i + 1}.** ${o.name}`;
    const pct = total ? Math.round((counts[i] / total) * 100) : 0;
    const f = Math.round(pct / 10);
    return `**${i + 1}. ${o.name}**\n${'█'.repeat(f)}${'░'.repeat(10 - f)} ${counts[i]} صوت (${pct}%)`;
  }).join(ended ? '\n\n' : '\n');
  const ts = Math.floor(poll.endsAt / 1000);
  return new EmbedBuilder()
    .setTitle(`🗳️ ${poll.title}`)
    .setDescription(desc + (ended ? '' : `\n\n⏰ ينتهي <t:${ts}:R>\nلكل شخص ${poll.maxVotes} أصوات كحد أقصى`))
    .setColor(ended ? 0xed4245 : 0x5865f2)
    .setFooter({ text: ended ? `انتهى • إجمالي الأصوات: ${total}` : `ID: ${id}` });
}

function buildLinkRow(id) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('افتح صفحة التصويت').setURL(`${BASE_URL}/poll/${id}`),
  );
}

async function parseOption(raw, guild) {
  raw = raw.trim();
  let m = raw.match(/^<@!?(\d{17,20})>$/);
  if (m) {
    const mem = await guild.members.fetch(m[1]).catch(() => null);
    return { name: mem ? mem.displayName : 'مرشح', userId: m[1] };
  }
  m = raw.match(/^(.+?)\s*[:：]\s*(\d{17,20})$/);
  if (m) return { name: m[1].trim(), userId: m[2] };
  return { name: raw, userId: null };
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

/* ---------- Discord bot ---------- */
const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });

const commands = [
  new SlashCommandBuilder()
    .setName('poll')
    .setDescription('نظام التصويت')
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(s => s.setName('create').setDescription('إنشاء تصويت جديد')
      .addStringOption(o => o.setName('title').setDescription('عنوان التصويت').setRequired(true))
      .addStringOption(o => o.setName('options').setDescription('مثال: أحمد:123456789012345678 | خالد:987654321098765432 | سعد').setRequired(true))
      .addIntegerOption(o => o.setName('max_votes').setDescription('أقصى عدد أصوات لكل شخص (الافتراضي 2)').setMinValue(1).setMaxValue(10))
      .addIntegerOption(o => o.setName('hours').setDescription('مدة التصويت بالساعات (الافتراضي 24)').setMinValue(1).setMaxValue(720)))
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
    if (!(i.isChatInputCommand() && i.commandName === 'poll')) return;
    const sub = i.options.getSubcommand();

    if (sub === 'create') {
      if (!BASE_URL) return i.reply(ephemeral('❌ BASE_URL غير محدد في المتغيرات.'));
      await i.deferReply();

      const title = i.options.getString('title');
      const rawOpts = i.options.getString('options').split('|').map(s => s.trim()).filter(Boolean);
      const maxVotes = i.options.getInteger('max_votes') ?? 2;
      const hours = i.options.getInteger('hours') ?? 24;

      if (rawOpts.length < 2 || rawOpts.length > 20)
        return i.editReply('❌ لازم تحط من 2 إلى 20 خيار، وافصل بينهم بـ |');
      if (maxVotes > rawOpts.length)
        return i.editReply('❌ عدد الأصوات أكثر من عدد الخيارات.');

      const options = [];
      for (const r of rawOpts) options.push(await parseOption(r, i.guild));

      const id = crypto.randomBytes(4).toString('hex');
      const poll = {
        guildId: i.guildId, channelId: i.channelId, messageId: null, title, options, maxVotes,
        endsAt: Date.now() + hours * 3600 * 1000, ended: false, finalized: false,
        createdBy: i.user.id, votes: {},
      };
      const msg = await i.editReply({
        embeds: [buildEmbed(poll, id, getCounts(poll))],
        components: [buildLinkRow(id)],
      });
      poll.messageId = msg.id;
      db.polls[id] = poll;
      save();
      return;
    }

    if (sub === 'end') {
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const id = i.options.getString('poll_id').trim();
      const poll = db.polls[id];
      if (!poll || poll.guildId !== i.guildId) return i.editReply('❌ ما لقيت تصويت بهذا الايدي.');
      if (poll.finalized) return i.editReply('⚠️ التصويت منتهي أصلاً.');
      await finalize(id);
      return i.editReply('✅ تم إنهاء التصويت.');
    }
  } catch (err) {
    console.error(err);
    const payload = ephemeral('❌ صار خطأ، حاول مرة ثانية.');
    if (i.deferred || i.replied) i.editReply(payload.content).catch(() => {});
    else i.reply(payload).catch(() => {});
  }
});

// إنهاء التصويتات اللي خلص وقتها تلقائياً
setInterval(() => {
  for (const [id, poll] of Object.entries(db.polls)) {
    if (!poll.finalized && Date.now() >= poll.endsAt) finalize(id);
  }
}, 30 * 1000);

/* ---------- Web: sessions ---------- */
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
  req.on('data', c => { d += c; if (d.length > 1e4) { req.destroy(); no(new Error('too big')); } });
  req.on('end', () => { try { ok(JSON.parse(d || '{}')); } catch (e) { no(e); } });
});

function pollView(poll, user, withResults) {
  const ended = isEnded(poll);
  const counts = getCounts(poll);
  const showCounts = withResults || ended;
  return {
    title: poll.title,
    maxVotes: poll.maxVotes,
    endsAt: poll.endsAt,
    ended,
    totalVoters: Object.keys(poll.votes).length,
    options: poll.options.map((o, i) => ({
      name: o.name,
      blocked: !!user && o.userId === user.id,
      count: showCounts ? counts[i] : undefined,
    })),
    mine: user ? (poll.votes[user.id] || []) : [],
    user: user ? { id: user.id, name: user.name } : null,
  };
}

/* ---------- Web: server ---------- */
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const user = unsign(parseCookies(req).sid);

    if (req.method === 'GET' && p === '/') return send(res, 200, 'Vote bot is running', 'text/plain; charset=utf-8');

    // تسجيل الدخول بديسكورد
    if (req.method === 'GET' && p === '/login') {
      let next = url.searchParams.get('next') || '/';
      if (!/^\/poll\/[a-f0-9]{8}$/.test(next)) next = '/';
      const state = sign({ next, exp: Date.now() + 10 * 60 * 1000 });
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
      return redirect(res, st.next, { 'Set-Cookie': `sid=${sid}; HttpOnly; Path=/; Max-Age=604800; SameSite=Lax${secure}` });
    }

    // صفحة التصويت
    let m = p.match(/^\/poll\/([a-f0-9]{8})$/);
    if (req.method === 'GET' && m) {
      if (!db.polls[m[1]]) return send(res, 404, 'التصويت غير موجود', 'text/plain; charset=utf-8');
      return send(res, 200, PAGE, 'text/html; charset=utf-8');
    }

    // API
    m = p.match(/^\/api\/poll\/([a-f0-9]{8})(\/vote)?$/);
    if (m) {
      const poll = db.polls[m[1]];
      if (!poll) return send(res, 404, { error: 'التصويت غير موجود' });

      if (req.method === 'GET' && !m[2]) {
        return send(res, 200, pollView(poll, user, url.searchParams.get('results') === '1'));
      }

      if (req.method === 'POST' && m[2]) {
        if (!user) return send(res, 401, { error: 'سجّل دخول أول' });
        if (isEnded(poll)) return send(res, 400, { error: 'التصويت منتهي' });

        const body = await readBody(req);
        const choices = Array.isArray(body.choices) ? [...new Set(body.choices.map(Number))] : [];
        if (!choices.length || choices.length > poll.maxVotes)
          return send(res, 400, { error: `اختر من 1 إلى ${poll.maxVotes}` });
        if (choices.some(c => !Number.isInteger(c) || c < 0 || c >= poll.options.length))
          return send(res, 400, { error: 'خيار غير صالح' });
        if (choices.some(c => poll.options[c].userId === user.id))
          return send(res, 400, { error: 'ما تقدر تصوّت لنفسك' });

        const guild = client.guilds.cache.get(poll.guildId);
        try { await guild.members.fetch(user.id); }
        catch { return send(res, 403, { error: 'لازم تكون داخل السيرفر عشان تصوّت' }); }

        poll.votes[user.id] = choices;
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

/* ---------- Web: page ---------- */
const PAGE = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>تصويت</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#1e1f22;color:#f2f3f5;font-family:'Segoe UI',Tahoma,Arial,sans-serif;padding:16px}
  .card{width:100%;max-width:460px;background:#0b0b0d;border:1px solid #2a2a2e;border-radius:14px;padding:22px}
  h1{margin:0 0 4px;font-size:18px;font-weight:700;word-break:break-word}
  .sub{margin:0 0 16px;color:#80848e;font-size:14px}
  .user{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;font-size:13px;color:#b5bac1}
  .user a{color:#8ea1e1;text-decoration:none}
  .opt{position:relative;overflow:hidden;display:flex;align-items:center;justify-content:space-between;gap:10px;background:#18181c;border:1px solid transparent;border-radius:10px;padding:16px;margin-bottom:8px;cursor:pointer;user-select:none}
  .opt.on{border-color:#5865f2}
  .opt.off{opacity:.45;cursor:not-allowed}
  .opt.locked{cursor:default}
  .opt .bar{position:absolute;inset:0 auto 0 0;background:#5865f244;z-index:0;right:0;left:auto}
  .opt span,.opt b,.opt small{position:relative;z-index:1}
  .opt small{color:#80848e;font-size:12px;margin-inline-start:6px}
  .dot{width:22px;height:22px;border-radius:50%;border:2px solid #b5bac1;flex:none;position:relative;z-index:1}
  .opt.on .dot{border-color:#5865f2;background:radial-gradient(#5865f2 45%,transparent 50%)}
  .foot{display:flex;justify-content:space-between;align-items:center;margin-top:14px;font-size:13px;color:#b5bac1;gap:8px;flex-wrap:wrap}
  .btns{display:flex;gap:8px;align-items:center}
  button,.btn{font:inherit;font-size:14px;font-weight:600;border:0;border-radius:8px;padding:9px 18px;cursor:pointer;text-decoration:none;display:inline-block}
  .ghost{background:transparent;color:#f2f3f5}
  .primary{background:#5865f2;color:#fff}
  .primary:disabled{background:#3b3d8f;color:#8a8cc0;cursor:not-allowed}
  .msg{margin-top:12px;font-size:13px;color:#f0b232;min-height:18px}
</style>
</head>
<body>
<div class="card" id="root">جاري التحميل...</div>
<script>
var root=document.getElementById('root'),id=location.pathname.split('/').pop(),data=null,sel=new Set(),showRes=false,first=true,msg='';
function el(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x!==undefined)e.textContent=x;return e;}
function left(ms){if(ms<=0)return 'انتهى';var m=Math.floor(ms/60000),h=Math.floor(m/60),d=Math.floor(h/24);if(d>=1)return 'باقي '+d+' يوم';if(h>=1)return 'باقي '+h+' ساعة';return 'باقي '+Math.max(m,1)+' دقيقة';}
async function load(){
  var r=await fetch('/api/poll/'+id+(showRes?'?results=1':''));
  if(!r.ok){root.textContent='التصويت غير موجود';return;}
  data=await r.json();
  if(first){sel=new Set(data.mine);first=false;}
  render();
}
async function vote(){
  var r=await fetch('/api/poll/'+id+'/vote',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({choices:Array.from(sel)})});
  var j={};try{j=await r.json();}catch(e){}
  if(!r.ok){msg=j.error||'صار خطأ';render();return;}
  msg='✅ تم تسجيل صوتك';showRes=true;await load();
}
function toggle(i){
  if(sel.has(i)){sel.delete(i);}
  else if(data.maxVotes===1){sel=new Set([i]);}
  else if(sel.size<data.maxVotes){sel.add(i);}
  else{msg='وصلت الحد الأقصى ('+data.maxVotes+')';render();return;}
  msg='';render();
}
function render(){
  root.innerHTML='';
  var showR=data.ended||showRes;
  var total=0;if(showR)data.options.forEach(function(o){total+=o.count||0;});
  root.appendChild(el('h1','',data.title));
  root.appendChild(el('p','sub',data.ended?'انتهى التصويت':'اختر حتى '+data.maxVotes+(data.maxVotes===1?' إجابة':' إجابات')));

  var ub=el('div','user');
  if(data.user){ub.appendChild(el('span','','مسجّل باسم: '+data.user.name));}
  else{var a=el('a','','سجّل دخول بديسكورد');a.href='/login?next='+encodeURIComponent(location.pathname);ub.appendChild(a);}
  root.appendChild(ub);

  data.options.forEach(function(o,i){
    var canPick=!data.ended&&data.user&&!o.blocked&&!showR;
    var row=el('div','opt'+(sel.has(i)?' on':'')+(o.blocked?' off':'')+(canPick?'':' locked'));
    if(showR){var pct=total?Math.round((o.count||0)/total*100):0;var bar=el('div','bar');bar.style.width=pct+'%';row.appendChild(bar);}
    var name=el('span','',o.name);
    if(o.blocked)name.appendChild(el('small','','(ما تقدر تصوّت لنفسك)'));
    row.appendChild(name);
    if(showR){row.appendChild(el('b','',(o.count||0)+' • '+(total?Math.round((o.count||0)/total*100):0)+'%'));}
    else row.appendChild(el('div','dot'));
    if(canPick)row.onclick=function(){toggle(i);};
    root.appendChild(row);
  });

  var foot=el('div','foot');
  var votes=showR?total:data.totalVoters;
  foot.appendChild(el('span','',(showR?votes+' أصوات':data.totalVoters+' مشارك')+' • '+left(data.endsAt-Date.now())));
  var btns=el('div','btns');
  if(!data.ended){
    var rb=el('button','ghost',showRes?'رجوع':'عرض النتائج');
    rb.onclick=function(){showRes=!showRes;msg='';load();};
    btns.appendChild(rb);
    if(data.user){
      var vb=el('button','primary','صوّت');
      vb.disabled=showRes||sel.size===0;
      vb.onclick=vote;
      btns.appendChild(vb);
    }
  }
  foot.appendChild(btns);
  root.appendChild(foot);
  root.appendChild(el('div','msg',msg));
}
load();
setInterval(function(){if(data&&!data.ended)load();},20000);
</script>
</body>
</html>`;

/* ---------- Start ---------- */
server.listen(PORT, () => console.log(`🌐 Web on port ${PORT}`));
client.login(TOKEN).catch(console.error);
