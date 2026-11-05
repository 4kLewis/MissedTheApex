/**
 * Slash-only command consolidation helper.
 * Existing command objects remain loaded for prefix handlers and permissions.
 * Each command's original option metadata is preserved inside its subcommand.
 */
import { isCommandEnabled } from '../services/commandAccessService.js';
import { enforceDefaultCommandPermissions } from './permissionGuard.js';
import { createError, ErrorTypes } from './errorHandler.js';

export function createCompactCommandGroup(name, description, category, legacyCommands) {
  const commands = new Map(Object.entries(legacyCommands));
  if (commands.size === 0 || commands.size > 25) {
    throw new Error(`/${name} must contain between 1 and 25 subcommands`);
  }

  const options = [...commands].map(([subcommandName, command]) => {
    const original = command?.data?.toJSON?.();
    if (!original?.name || !command?.execute) {
      throw new Error(`/${name} ${subcommandName} is missing command metadata or handler`);
    }
    if (original.options?.some(option => option.type === 1 || option.type === 2)) {
      throw new Error(`Cannot nest command /${original.name}: it already has subcommands`);
    }
    if ((original.options?.length || 0) > 25) {
      throw new Error(`/${original.name} exceeds Discord option limits`);
    }
    return {
      type: 1, // SUB_COMMAND
      name: subcommandName,
      description: original.description,
      ...(original.options?.length ? { options: original.options } : {}),
    };
  });

  const payload = {
    type: 1, // CHAT_INPUT
    name,
    description,
    options,
  };

  return {
    slashOnly: true,
    category,
    data: {
      name,
      description,
      toJSON: () => structuredClone(payload),
    },
    async execute(interaction, guildConfig, client) {
      const subcommand = interaction.options.getSubcommand();
      const command = commands.get(subcommand);
      if (!command) {
        throw createError(`Unknown /${name} subcommand: ${subcommand}`,
          ErrorTypes.VALIDATION, 'That action is not available.');
      }

      // Preserve the legacy per-command guild enable/disable configuration.
      const legacyName = command.data.name;
      if (interaction.guildId && !(await isCommandEnabled(client, interaction.guildId, legacyName, category))) {
        throw createError(`Disabled legacy command /${legacyName}`,
          ErrorTypes.CONFIGURATION, 'That command is disabled in this server.');
      }

      // Root slash commands have no per-subcommand Discord permission flag.
      // Enforce each original command's permission requirements in the bot.
      if (!(await enforceDefaultCommandPermissions(interaction, command, {
        guildConfig,
        source: `compact_${name}`,
      }))) return;

      return command.execute(interaction, guildConfig, client);
    },
  };
}
