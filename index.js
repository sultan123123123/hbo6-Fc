require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
  Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, SlashCommandBuilder, PermissionFlagsBits, REST, Routes, MessageFlags,
} = require('discord.js');

/* ---------- Storage (JSON file) ---------- */
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'polls.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

let db = { polls: {} };
try {
  if (fs.existsSync(DATA_FILE)) db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
} catch (e) {
  console.error('⚠️ ما قدرت أقرأ ملف البيانات، بيبدأ فاضي:', e.message);
}

function save() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DATA_FILE);
}

/* ---------- Helpers ---------- */
function getCounts(poll) {
  const counts = poll.options.map(() => 0);
  Object.values(poll.votes).forEach(list => list.forEach(idx => { counts[idx]++; }));
  return counts;
}

function buildEmbed(poll, counts) {
  const total = counts.reduce((a, b) => a + b, 0);
  const desc = poll.options.map((opt, i) => {
    const pct = total ? Math.round((counts[i] / total) * 100) : 0;
    const filled = Math.round(pct / 10);
    return `**${i + 1}. ${opt}**\n${'█'.repeat(filled)}${'░'.repeat(10 - filled)} ${counts[i]} صوت (${pct}%)`;
  }).join('\n\n');

  return new EmbedBuilder()
    .setTitle(`🗳️ ${poll.title}`)
    .setDescription(desc)
    .setColor(poll.ended ? 0xed4245 : 0x5865f2)
    .setFooter({
      text: poll.ended
        ? `انتهى التصويت • إجمالي الأصوات: ${total}`
        : `لكل شخص ${poll.maxVotes} أصوات كحد أقصى • إجمالي الأصوات: ${total}`,
    });
}

function buildButtons(poll, disabled = false) {
  const rows = [];
  for (let i = 0; i < poll.options.length; i += 5) {
    const row = new ActionRowBuilder();
    poll.options.slice(i, i + 5).forEach((_, j) => {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`vote:${i + j}`)
          .setLabel(String(i + j + 1))
          .setStyle(ButtonStyle.Primary)
          .setDisabled(disabled),
      );
    });
    rows.push(row);
  }
  return rows;
}

const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });

/* ---------- Commands ---------- */
const commands = [
  new SlashCommandBuilder()
    .setName('poll')
    .setDescription('نظام التصويت')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(s => s.setName('create').setDescription('إنشاء تصويت جديد')
      .addStringOption(o => o.setName('title').setDescription('عنوان التصويت').setRequired(true))
      .addStringOption(o => o.setName('options').setDescription('الخيارات مفصولة بـ | مثال: أحمد | خالد | سعد').setRequired(true))
      .addIntegerOption(o => o.setName('max_votes').setDescription('أقصى عدد أصوات لكل شخص (الافتراضي 2)').setMinValue(1).setMaxValue(10)))
    .addSubcommand(s => s.setName('end').setDescription('إنهاء تصويت')
      .addStringOption(o => o.setName('message_id').setDescription('ايدي رسالة التصويت').setRequired(true))),
].map(c => c.toJSON());

/* ---------- Client ---------- */
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
  await new REST({ version: '10' }).setToken(process.env.TOKEN)
    .put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.on('interactionCreate', async (i) => {
  try {
    /* --- Slash commands --- */
    if (i.isChatInputCommand() && i.commandName === 'poll') {
      const sub = i.options.getSubcommand();

      if (sub === 'create') {
        const title = i.options.getString('title');
        const options = i.options.getString('options').split('|').map(s => s.trim()).filter(Boolean);
        const maxVotes = i.options.getInteger('max_votes') ?? 2;

        if (options.length < 2 || options.length > 20)
          return i.reply(ephemeral('❌ لازم تحط من 2 إلى 20 خيار، وافصل بينهم بـ |'));
        if (maxVotes > options.length)
          return i.reply(ephemeral('❌ عدد الأصوات أكثر من عدد الخيارات.'));

        const poll = {
          guildId: i.guildId, channelId: i.channelId, title, options,
          maxVotes, ended: false, createdBy: i.user.id, votes: {},
        };
        const msg = await i.reply({
          embeds: [buildEmbed(poll, getCounts(poll))],
          components: buildButtons(poll),
          fetchReply: true,
        });
        db.polls[msg.id] = poll;
        save();
        return;
      }

      if (sub === 'end') {
        const messageId = i.options.getString('message_id').trim();
        const poll = db.polls[messageId];
        if (!poll || poll.guildId !== i.guildId) return i.reply(ephemeral('❌ ما لقيت تصويت بهذا الايدي.'));
        if (poll.ended) return i.reply(ephemeral('⚠️ التصويت منتهي أصلاً.'));
        poll.ended = true;
        save();

        const counts = getCounts(poll);
        const channel = await client.channels.fetch(poll.channelId);
        const msg = await channel.messages.fetch(messageId);
        await msg.edit({ embeds: [buildEmbed(poll, counts)], components: buildButtons(poll, true) });

        const max = Math.max(...counts);
        const winners = poll.options.filter((_, idx) => counts[idx] === max && max > 0);
        return i.reply(winners.length
          ? `🏆 انتهى التصويت. الفائز: **${winners.join(' ، ')}** بعدد ${max} صوت`
          : '🏁 انتهى التصويت بدون أي أصوات.');
      }
    }

    /* --- Vote buttons --- */
    if (i.isButton() && i.customId.startsWith('vote:')) {
      const idx = parseInt(i.customId.split(':')[1], 10);
      const poll = db.polls[i.message.id];
      if (!poll) return i.reply(ephemeral('❌ هذا التصويت غير موجود.'));
      if (poll.ended) return i.reply(ephemeral('🔒 التصويت منتهي.'));

      const mine = poll.votes[i.user.id] || [];
      let notice;

      if (mine.includes(idx)) {
        poll.votes[i.user.id] = mine.filter(v => v !== idx);
        if (!poll.votes[i.user.id].length) delete poll.votes[i.user.id];
        notice = `↩️ سحبت صوتك من **${poll.options[idx]}**`;
      } else {
        if (mine.length >= poll.maxVotes)
          return i.reply(ephemeral(`❌ وصلت الحد الأقصى (${poll.maxVotes} أصوات). اضغط على خيار صوّتّ له عشان تسحب صوتك وتغيّره.`));
        poll.votes[i.user.id] = [...mine, idx];
        notice = `✅ صوّتّ لـ **${poll.options[idx]}** (${mine.length + 1}/${poll.maxVotes})`;
      }
      save();

      await i.update({ embeds: [buildEmbed(poll, getCounts(poll))], components: buildButtons(poll) });
      await i.followUp(ephemeral(notice));
    }
  } catch (err) {
    console.error(err);
    if (!i.replied && !i.deferred) i.reply(ephemeral('❌ صار خطأ، حاول مرة ثانية.')).catch(() => {});
  }
});

client.login(process.env.TOKEN).catch(console.error);
