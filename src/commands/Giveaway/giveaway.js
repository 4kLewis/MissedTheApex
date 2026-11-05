/**
 * Opt-in slash-command consolidation.
 * /giveaway create|end|delete|reroll replaces 4 global command slots with 1.
 * The old command modules stay installed for prefix-command compatibility.
 * Enable with MTA_COMPACT_GIVEAWAYS=true in Railway AFTER testing.
 */
import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';
import { createError, ErrorTypes } from '../../utils/errorHandler.js';
import { isCommandEnabled } from '../../services/commandAccessService.js';
import { botConfig } from '../../config/bot.js';
import create from './gcreate.js';
import end from './gend.js';
import remove from './gdelete.js';
import reroll from './greroll.js';

const COMMANDS = new Map([
  ['create', ['gcreate', create]],
  ['end', ['gend', end]],
  ['delete', ['gdelete', remove]],
  ['reroll', ['greroll', reroll]],
]);

export default {
  data: new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('Manage giveaways in this server')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sub => sub.setName('create').setDescription('Start a new giveaway')
      .addStringOption(opt => opt.setName('duration').setDescription('Duration: 1h, 30m, 5d').setRequired(true))
      .addIntegerOption(opt => opt.setName('winners').setDescription('Number of winners')
        .setMinValue(botConfig.giveaways?.minimumWinners ?? 1)
        .setMaxValue(botConfig.giveaways?.maximumWinners ?? 10).setRequired(true))
      .addStringOption(opt => opt.setName('prize').setDescription('Prize description').setRequired(true))
      .addChannelOption(opt => opt.setName('channel').setDescription('Channel to host the giveaway')
        .addChannelTypes(ChannelType.GuildText).setRequired(false)))
    .addSubcommand(sub => sub.setName('end').setDescription('End an active giveaway')
      .addStringOption(opt => opt.setName('messageid').setDescription('Giveaway message ID').setRequired(true)))
    .addSubcommand(sub => sub.setName('delete').setDescription('Delete an existing giveaway')
      .addStringOption(opt => opt.setName('messageid').setDescription('Giveaway message ID').setRequired(true)))
    .addSubcommand(sub => sub.setName('reroll').setDescription('Reroll ended giveaway winners')
      .addStringOption(opt => opt.setName('messageid').setDescription('Giveaway message ID').setRequired(true))),

  async execute(interaction, guildConfig, client) {
    const subcommand = interaction.options.getSubcommand();
    const target = COMMANDS.get(subcommand);
    if (!target) {
      throw createError(`Unknown giveaway subcommand: ${subcommand}`, ErrorTypes.VALIDATION,
        'Unknown giveaway action.');
    }
    const [legacyName, legacyCommand] = target;
    // Preserve server-level disabled-command settings for old /gcreate etc.
    if (interaction.guildId && !(await isCommandEnabled(client, interaction.guildId, legacyName, 'Giveaway'))) {
      throw createError(`Legacy command ${legacyName} disabled in guild`, ErrorTypes.CONFIGURATION,
        'This giveaway action has been disabled for this server.');
    }
    return legacyCommand.execute(interaction, guildConfig, client);
  },
};
