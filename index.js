require('dotenv').config();
const {
  Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, SlashCommandBuilder, PermissionFlagsBits, REST, Routes, MessageFlags,
} = require('discord.js');
const mongoose = require('mongoose');

/* ---------- Database ---------- */
const Poll = mongoose.model('Poll', new mongoose.Schema({
  guildId: String,
  channelId: String,
  messageId: { type: String, index: true },
  title: String,
  options: [String],
  maxVotes: { type: Number, default: 2 },
  ended: { type: Boolean, default: false },
  createdBy: String,
}, { timestamps: true }));

const voteSchema = new mongoose.Schema({
  pollId: { type: mongoose.Schema.Types.ObjectId, index: true },
  userId: String,
  option: Number,
});
voteSchema.index({ pollId: 1, userId: 1, option: 1 }, { unique: true });
const Vote = mongoose.model('Vote', voteSchema);

/* ---------- Helpers ---------- */
const locks = new Set();

async function getCounts(poll) {
  const rows = await Vote.aggregate([
    { $match: { pollId: poll._id } },
    { $group: { _id: '$option', c: { $sum: 1 } } },
  ]);
  const counts = poll.options.map(() => 0);
  rows.forEach(r => (counts[r._id] = r.c));
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

        const poll = new Poll({
          guildId: i.guildId, channelId: i.channelId, title, options, maxVotes, createdBy: i.user.id,
        });
        const msg = await i.reply({
          embeds: [buildEmbed(poll, poll.options.map(() => 0))],
          components: buildButtons(poll),
          fetchReply: true,
        });
        poll.messageId = msg.id;
        await poll.save();
        return;
      }

      if (sub === 'end') {
        const poll = await Poll.findOne({ messageId: i.options.getString('message_id'), guildId: i.guildId });
        if (!poll) return i.reply(ephemeral('❌ ما لقيت تصويت بهذا الايدي.'));
        if (poll.ended) return i.reply(ephemeral('⚠️ التصويت منتهي أصلاً.'));
        poll.ended = true;
        await poll.save();

        const counts = await getCounts(poll);
        const channel = await client.channels.fetch(poll.channelId);
        const msg = await channel.messages.fetch(poll.messageId);
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
      const lockKey = `${i.message.id}:${i.user.id}`;
      if (locks.has(lockKey)) return i.deferUpdate();
      locks.add(lockKey);

      try {
        const poll = await Poll.findOne({ messageId: i.message.id });
        if (!poll) return i.reply(ephemeral('❌ هذا التصويت غير موجود.'));
        if (poll.ended) return i.reply(ephemeral('🔒 التصويت منتهي.'));

        let notice;
        const existing = await Vote.findOne({ pollId: poll._id, userId: i.user.id, option: idx });

        if (existing) {
          await existing.deleteOne();
          notice = `↩️ سحبت صوتك من **${poll.options[idx]}**`;
        } else {
          const used = await Vote.countDocuments({ pollId: poll._id, userId: i.user.id });
          if (used >= poll.maxVotes)
            return i.reply(ephemeral(`❌ وصلت الحد الأقصى (${poll.maxVotes} أصوات). اضغط على خيار صوّتّ له عشان تسحب صوتك وتغيّره.`));
          await Vote.create({ pollId: poll._id, userId: i.user.id, option: idx });
          notice = `✅ صوّتّ لـ **${poll.options[idx]}** (${used + 1}/${poll.maxVotes})`;
        }

        const counts = await getCounts(poll);
        await i.update({ embeds: [buildEmbed(poll, counts)], components: buildButtons(poll) });
        await i.followUp(ephemeral(notice));
      } finally {
        locks.delete(lockKey);
      }
    }
  } catch (err) {
    console.error(err);
    if (!i.replied && !i.deferred) i.reply(ephemeral('❌ صار خطأ، حاول مرة ثانية.')).catch(() => {});
  }
});

mongoose.connect(process.env.MONGO_URI)
  .then(() => client.login(process.env.TOKEN))
  .catch(console.error);
