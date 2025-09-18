const { SlashCommandBuilder } = require('discord.js');
const { Manager } = require('erela.js');
const path = require('path');
const fs = require('fs').promises;

const PLUGIN_DIR = path.join(__dirname, 'music-data');
const QUEUE_FILE = path.join(PLUGIN_DIR, 'queue.json');

const LAVALINK_HOST = process.env.LAVALINK_HOST || 'localhost';
const LAVALINK_PORT = process.env.LAVALINK_PORT || '2333';
const LAVALINK_PASSWORD = process.env.LAVALINK_PASSWORD || 'youshallnotpass';

let manager;

async function ensureDataDir() {
  try { await fs.access(PLUGIN_DIR); } catch { await fs.mkdir(PLUGIN_DIR, { recursive: true }); }
  try { await fs.access(QUEUE_FILE); } catch { await fs.writeFile(QUEUE_FILE, JSON.stringify({})); }
}
async function getQueue(guildId) {
  await ensureDataDir();
  try {
    const allQueues = JSON.parse(await fs.readFile(QUEUE_FILE, 'utf8'));
    return allQueues[guildId] || [];
  } catch { return []; }
}
async function saveQueue(guildId, queue) {
  await ensureDataDir();
  let allQueues = {};
  try { allQueues = JSON.parse(await fs.readFile(QUEUE_FILE, 'utf8')); } catch { allQueues = {}; }
  allQueues[guildId] = queue;
  await fs.writeFile(QUEUE_FILE, JSON.stringify(allQueues, null, 2));
}
async function addToQueue(guildId, track, user) {
  const queue = await getQueue(guildId);
  queue.push({ track, user, time: new Date().toISOString() });
  await saveQueue(guildId, queue);
}
async function removeFromQueue(guildId, index) {
  const queue = await getQueue(guildId);
  if (index < 1 || index > queue.length) return false;
  queue.splice(index - 1, 1);
  await saveQueue(guildId, queue);
  return true;
}
async function clearQueue(guildId) {
  await saveQueue(guildId, []);
}
async function skipQueue(guildId) {
  const queue = await getQueue(guildId);
  if (queue.length === 0) return null;
  const skipped = queue.shift();
  await saveQueue(guildId, queue);
  return skipped;
}

function initErela(client) {
  manager = new Manager({
    nodes: [{
      host: LAVALINK_HOST,
      port: LAVALINK_PORT,
      password: LAVALINK_PASSWORD,
    }],
    send(id, payload) {
      const guild = client.guilds.cache.get(id);
      if (guild) guild.shard.send(payload);
    },
  });

  client.on('raw', d => manager.updateVoiceState(d));

  manager.on('nodeConnect', () => {
    console.log('[MUSIC] Kết nối node Lavalink thành công.');
  });

  manager.on('nodeError', (node, error) => {
    console.log(`[MUSIC] Lỗi node: ${error.message}`);
  });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('music')
    .setDescription('Phát nhạc với Erela.js/Lavalink 🎶')
    .addSubcommand(sub =>
      sub.setName('play')
        .setDescription('Phát hoặc thêm bài vào hàng đợi')
        .addStringOption(opt =>
          opt.setName('tukhoa')
            .setDescription('Từ khóa hoặc link')
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('stop')
        .setDescription('Dừng phát nhạc và rời kênh')
    )
    .addSubcommand(sub =>
      sub.setName('pause')
        .setDescription('Tạm dừng phát nhạc')
    )
    .addSubcommand(sub =>
      sub.setName('resume')
        .setDescription('Tiếp tục phát nhạc')
    )
    .addSubcommand(sub =>
      sub.setName('queue')
        .setDescription('Xem hàng đợi')
    )
    .addSubcommand(sub =>
      sub.setName('skip')
        .setDescription('Bỏ qua bài hiện tại')
    )
    .addSubcommand(sub =>
      sub.setName('remove')
        .setDescription('Xóa một bài khỏi hàng đợi')
        .addIntegerOption(opt =>
          opt.setName('index')
            .setDescription('Vị trí bài cần xóa (tính từ 1)')
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('clear')
        .setDescription('Xóa toàn bộ hàng đợi')
    ),

  async onReady(client) {
    initErela(client);
  },

  async execute(interaction, { logToChannel }) {
    await ensureDataDir();
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId;
    const member = interaction.member;
    const voiceChannel = member.voice.channel;

    if (!manager) throw new Error('Erela.js chưa được khởi tạo!');
    if (!voiceChannel && ['play', 'pause', 'resume', 'skip', 'stop'].includes(sub)) {
      await interaction.reply('🚫 Bạn cần vào voice channel trước!');
      return;
    }

    let player = manager.players.get(guildId);

    if (sub === 'play') {
      const query = interaction.options.getString('tukhoa');
      await interaction.deferReply();

      if (!player) player = manager.create({
        guild: guildId,
        voiceChannel: voiceChannel.id,
        textChannel: interaction.channel.id,
        selfDeaf: true,
      });

      let search = await manager.search(query, interaction.user);
      if (!search || !search.tracks.length) {
        await interaction.editReply('🚫 Không tìm thấy bài hát phù hợp!');
        return;
      }
      const track = search.tracks[0];

      player.connect();
      player.queue.add(track);

      await interaction.editReply(
        `🎶 Đã thêm vào hàng đợi:\n` +
        `- Tiêu đề: **${track.title}**\n` +
        `- Kênh: ${track.author}\n` +
        `- Thời lượng: ${(track.duration / 60000).toFixed(2)} phút\n` +
        `- Link: <${track.uri}>\n` +
        `👉 Hàng đợi hiện có ${player.queue.size} bài.`
      );
      await logToChannel(`Đã thêm vào hàng đợi: "${track.title}" bởi ${interaction.user.tag}`);

      if (!player.playing && !player.paused) player.play();

      player.on('end', async () => {
        if (player.queue.size > 0) player.play();
        else player.destroy();
      });
    }

    else if (sub === 'queue') {
      if (!player || !player.queue || player.queue.size === 0) {
        await interaction.reply('📭 Hàng đợi đang trống!');
        return;
      }
      let reply = `🎶 **Hàng đợi nhạc:**\n`;
      player.queue.forEach((track, i) => {
        reply += `${i + 1}. **${track.title}** (${(track.duration / 60000).toFixed(2)} phút)\n`;
      });
      await interaction.reply(reply);
    }

    else if (sub === 'skip') {
      if (!player || !player.queue || player.queue.size === 0) {
        await interaction.reply('🚫 Không có bài nào trong hàng đợi!');
        return;
      }
      await player.stop();
      await interaction.reply('⏩ Đã bỏ qua bài hiện tại!');
    }

    else if (sub === 'remove') {
      const index = interaction.options.getInteger('index');
      if (!player || !player.queue || index < 1 || index > player.queue.size) {
        await interaction.reply('🚫 Vị trí không hợp lệ!');
        return;
      }
      player.queue.remove(index - 1);
      await interaction.reply(`🗑️ Đã xóa bài thứ ${index} khỏi hàng đợi.`);
    }

    else if (sub === 'clear') {
      if (player) player.queue.clear();
      await interaction.reply('🧹 Đã xóa toàn bộ hàng đợi!');
    }

    else if (sub === 'stop') {
      if (player) {
        player.destroy();
        await interaction.reply('⏹️ Đã dừng phát nhạc và rời kênh!');
      } else {
        await interaction.reply('🚫 Không có player nào đang chạy!');
      }
    }

    else if (sub === 'pause') {
      if (player && player.playing) {
        player.pause(true);
        await interaction.reply('⏸️ Đã tạm dừng phát nhạc!');
      } else {
        await interaction.reply('🚫 Không có bài nào đang phát!');
      }
    }

    else if (sub === 'resume') {
      if (player && player.paused) {
        player.pause(false);
        await interaction.reply('▶️ Đã tiếp tục phát nhạc!');
      } else {
        await interaction.reply('🚫 Không có bài nào đang tạm dừng!');
      }
    }

    else {
      await interaction.reply('🚫 Lệnh không hợp lệ!');
    }
  }
};