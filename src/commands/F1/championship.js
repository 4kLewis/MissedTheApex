import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { getChampionshipState, markFiaReviewed } from '../../services/f1ChampionshipService.js';

export default {
  data: new SlashCommandBuilder()
    .setName('championship')
    .setDescription('View the live championship tracker or review FIA Championship Points')
    .addSubcommand(sub => sub.setName('status').setDescription('Show the latest tracked championship state'))
    .addSubcommand(sub => sub.setName('verify')
      .setDescription('Admin: attest you checked both standings against the FIA PDF')
      .addStringOption(o => o.setName('fia_pdf').setDescription('Official FIA Championship Points PDF URL').setRequired(true))
      .addBooleanOption(o => o.setName('checked_both').setDescription('I manually compared Drivers AND Constructors points').setRequired(true))),
  async execute(interaction) {
    if (process.env.F1_CHAMPIONSHIP_ENABLED !== 'true') {
      await interaction.reply({ content: 'Championship tracker is not enabled yet.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (!interaction.inGuild()) {
      await interaction.reply({ content: 'This command only works inside a server.', flags: MessageFlags.Ephemeral });
      return;
    }
    const action = interaction.options.getSubcommand();
    if (action === 'status') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const state = await getChampionshipState(interaction.client);
      if (!state) return interaction.editReply('No championship boards have been posted yet. They will appear during the next race when live data is available.');
      const status = state.verified ? 'Manually cross-checked against FIA' : state.fiaDocUrl ? 'FIA document available, review pending' : 'Provisional';
      return interaction.editReply(`**${state.snapshot.event}**\nStatus: **${status}**\nDrivers: ${state.snapshot.drivers.length} · Constructors: ${state.snapshot.teams.length}\nLast data: <t:${Math.floor(state.snapshot.at / 1000)}:R>\nSource: OpenF1 beta`);
    }
    if (action !== 'verify') return;
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ content: 'Manage Server permission is required.', flags: MessageFlags.Ephemeral });
    }
    if (!interaction.options.getBoolean('checked_both')) {
      return interaction.reply({ content: 'Do not verify until you have checked both championship tables against the official FIA document.', flags: MessageFlags.Ephemeral });
    }
    if (process.env.F1_CHAMPIONSHIP_DRY_RUN !== 'false') {
      return interaction.reply({ content: 'Disable dry-run first; no live boards have been created.', flags: MessageFlags.Ephemeral });
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const pdf = interaction.options.getString('fia_pdf', true);
      const state = await markFiaReviewed(interaction.client, pdf, interaction.user.id);
      await interaction.editReply(`Both boards updated: **FIA cross-checked by server admin** for ${state.snapshot.event}. If the standings change again, the tracker will return to provisional.`);
    } catch (error) {
      await interaction.editReply(`Verification not applied: ${String(error.message).slice(0, 240)}`);
    }
  },
};
