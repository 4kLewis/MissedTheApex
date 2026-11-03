/**
 * MissedTheApex F1 Team Selector (2026)
 * discord.js v14 — persistent selection menu with one team role per member.
 * No extra slash commands required.
 *
 * Configure F1_TEAM_SELECTOR_CHANNEL_ID in Railway.
 * IMPORTANT: Role names below must match existing Discord roles exactly.
 */
import {
  ActionRowBuilder,
  EmbedBuilder,
  StringSelectMenuBuilder,
  PermissionsBitField,
} from 'discord.js';
import { logger } from '../utils/logger.js';

const CUSTOM_ID = 'mta:f1-team-select:v1';
const PANEL_KEY_PREFIX = 'cache:f1-team-selector:v1:panel:';
const CHANNEL_ENV = 'F1_TEAM_SELECTOR_CHANNEL_ID';

// Edit the roleName values if your Discord role names differ.
const TEAMS = [
  { id: 'mercedes',    label: 'Mercedes',         roleName: 'Mercedes' },
  { id: 'ferrari',     label: 'Ferrari',          roleName: 'Ferrari' },
  { id: 'mclaren',     label: 'McLaren',          roleName: 'McLaren' },
  { id: 'redbull',     label: 'Red Bull Racing',  roleName: 'Red Bull Racing' },
  { id: 'williams',    label: 'Williams',         roleName: 'Williams' },
  { id: 'alpine',      label: 'Alpine',           roleName: 'Alpine' },
  { id: 'astonmartin', label: 'Aston Martin',     roleName: 'Aston Martin' },
  { id: 'racingbulls', label: 'Racing Bulls',     roleName: 'Racing Bulls' },
  { id: 'haas',        label: 'Haas F1 Team',     roleName: 'Haas F1 Team' },
  { id: 'audi',        label: 'Audi',             roleName: 'Audi' },
  { id: 'cadillac',    label: 'Cadillac',         roleName: 'Cadillac' },
];

// Never automatically assign privileged roles even if the configured
// Discord role name accidentally points to something administrative.
const FORBIDDEN_PERMISSIONS = [
  PermissionsBitField.Flags.Administrator,
  PermissionsBitField.Flags.ManageGuild,
  PermissionsBitField.Flags.ManageRoles,
  PermissionsBitField.Flags.ManageChannels,
  PermissionsBitField.Flags.KickMembers,
  PermissionsBitField.Flags.BanMembers,
  PermissionsBitField.Flags.ManageWebhooks,
];

function selectionRow() {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(CUSTOM_ID)
    .setPlaceholder('Choose your F1 team...')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions([
      ...TEAMS.map(team => ({ label: team.label, value: team.id })),
      { label: 'Remove my team role', value: 'none', description: 'Opt out of team colours' },
    ]);
  return new ActionRowBuilder().addComponents(menu);
}

function panelEmbed() {
  return new EmbedBuilder()
    .setColor(0xF47600)
    .setTitle('🏁 Choose Your F1 Team')
    .setDescription(
      'Pick the constructor you support from the 2026 Formula One grid using the menu below.\n\n' +
      '• You can support **one team at a time**.\n' +
      '• Choosing a different team automatically switches your role.\n' +
      '• Choose **Remove my team role** to opt out.\n\n' +
      'Your role colour will show in Discord unless a higher-positioned coloured role overrides it.'
    )
    .setFooter({ text: 'MissedTheApex • F1 Team Supporters' });
}

async function resolveTeamRoles(guild) {
  const allRoles = await guild.roles.fetch();
  const byId = new Map();
  const missing = [];

  for (const team of TEAMS) {
    const role = allRoles.find(r => r.name.toLowerCase() === team.roleName.toLowerCase());
    if (!role) {
      missing.push(team.roleName);
      continue;
    }
    if (role.managed || FORBIDDEN_PERMISSIONS.some(p => role.permissions.has(p))) {
      throw new Error(`Unsafe or managed role: ${role.name}. Team roles must be cosmetic.`);
    }
    byId.set(team.id, role);
  }
  if (missing.length) {
    throw new Error(`Missing team roles: ${missing.join(', ')}. Check TEAMS.roleName in the service file.`);
  }

  const botMember = await guild.members.fetchMe();
  if (!botMember.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
    throw new Error('MissedTheApex needs the Manage Roles permission.');
  }
  for (const role of byId.values()) {
    if (role.position >= botMember.roles.highest.position) {
      throw new Error(`${role.name} is at or above the MissedTheApex bot role. Move the bot role higher.`);
    }
  }
  if (new Set([...byId.values()].map(r => r.id)).size !== TEAMS.length) {
    throw new Error('Two team entries resolved to the same role. Check role names.');
  }
  return byId;
}

async function ensurePanel(bot) {
  const channelId = process.env[CHANNEL_ENV];
  if (!channelId) {
    logger.info(`[F1 Teams] ${CHANNEL_ENV} not set; selector disabled.`);
    return;
  }
  if (!bot.db || bot.db.getStatus?.().isDegraded) {
    throw new Error('Persistent database unavailable. Selector panel creation paused to prevent duplicates.');
  }
  const channel = await bot.channels.fetch(channelId);
  if (!channel?.guild || typeof channel.send !== 'function' || !channel.messages) {
    throw new Error(`${CHANNEL_ENV} must refer to a server text channel.`);
  }
  await resolveTeamRoles(channel.guild); // Prevent publishing a broken selector.

  const dbKey = `${PANEL_KEY_PREFIX}${channel.guild.id}:${channel.id}`;
  const previousId = await bot.db.get(dbKey, null);
  if (previousId) {
    try {
      const existing = await channel.messages.fetch(String(previousId));
      if (existing.author.id !== bot.user.id) {
        throw new Error('Stored message ID belongs to another user; refusing to overwrite.');
      }
      await existing.edit({ embeds: [panelEmbed()], components: [selectionRow()] });
      logger.info(`[F1 Teams] Updated existing team selector panel in #${channel.name}.`);
      return;
    } catch (error) {
      // Unknown Message means the panel was deleted; create a replacement.
      if (error.code !== 10008) throw error;
    }
  }
  const message = await channel.send({
    embeds: [panelEmbed()],
    components: [selectionRow()],
    allowedMentions: { parse: [] },
  });
  await bot.db.set(dbKey, message.id);
  logger.info(`[F1 Teams] Posted team selector panel in #${channel.name}.`);
}

async function onTeamSelection(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const channelId = process.env[CHANNEL_ENV];
  if (!channelId || interaction.channelId !== channelId || !interaction.guild) {
    await interaction.editReply('This team selector is no longer active.');
    return;
  }

  const choice = interaction.values[0];
  if (choice !== 'none' && !TEAMS.some(team => team.id === choice)) {
    await interaction.editReply('That team is not available.');
    return;
  }
  const roles = await resolveTeamRoles(interaction.guild);
  const member = await interaction.guild.members.fetch(interaction.user.id);
  const teamRoleIds = new Set([...roles.values()].map(role => role.id));
  const currentTeamIds = member.roles.cache.filter(role => teamRoleIds.has(role.id)).map(role => role.id);

  if (choice === 'none') {
    if (currentTeamIds.length) {
      await member.roles.remove(currentTeamIds, 'Member removed their F1 supporter role');
      await interaction.editReply('✅ Your F1 team role has been removed.');
    } else {
      await interaction.editReply('You don’t currently have an F1 team role.');
    }
    return;
  }

  const selected = roles.get(choice);
  if (currentTeamIds.length === 1 && currentTeamIds[0] === selected.id) {
    await interaction.editReply(`✅ You already support **${selected.name}**!`);
    return;
  }

  // Add the selected role before removing old team roles. Never touch
  // unrelated member roles (moderator, level, notification, etc.).
  if (!member.roles.cache.has(selected.id)) {
    await member.roles.add(selected.id, 'Member selected their F1 team');
  }
  const oldTeamIds = currentTeamIds.filter(id => id !== selected.id);
  if (oldTeamIds.length) {
    await member.roles.remove(oldTeamIds, 'Member switched F1 team');
  }
  await interaction.editReply(`🏁 You're now supporting **${selected.name}**! Your team role has been updated.`);
}

export function setupF1TeamSelector(bot) {
  bot.on('interactionCreate', async interaction => {
    if (!interaction.isStringSelectMenu() || interaction.customId !== CUSTOM_ID) return;
    try {
      await onTeamSelection(interaction);
    } catch (error) {
      logger.error('[F1 Teams] Role selection failed:', error);
      const message = '❌ Could not update your team role. Please let a server admin know.';
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply(message);
        } else {
          await interaction.reply({ content: message, ephemeral: true });
        }
      } catch (replyError) {
        logger.warn('[F1 Teams] Could not reply to role selection:', replyError);
      }
    }
  });
  // Registers the permanent listener; then publishes/refreshes the persistent panel.
  void ensurePanel(bot).catch(error => logger.error('[F1 Teams] Panel setup failed:', error));
}
