/**
 * bot.js - Discord.js client management (sidecar of the discord-bot plugin)
 *
 * Manages the Discord client, thread creation, output posting, and reply detection.
 * Uses Components V2 for structured messages (session open/close, prompts, acks)
 * and regular messages for terminal output code blocks.
 */

import {
  Client, GatewayIntentBits, ChannelType, Partials, MessageFlags,
  ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
} from 'discord.js';
import { stripAndFormat, detectPrompt } from './formatter.js';

class DiscordBot {
  constructor(sendToParent) {
    this.sendToParent = sendToParent;
    this.client = null;
    this.config = null;
    // terminalId -> { thread, threadId, threadUrl, ... }
    this.threads = new Map();
  }

  /**
   * Initialize and log in the Discord client.
   * @param {object} config - { token, guildId, channelId, qualifiedRoleId }
   */
  async init(config) {
    this.config = config;

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Message],
    });

    this.client.on('ready', () => {
      const guild = this.client.guilds.cache.get(config.guildId);
      this.sendToParent({
        type: 'ready',
        botUsername: this.client.user.tag,
      });
      this.sendToParent({
        type: 'status',
        connected: true,
        guildName: guild ? guild.name : 'Unknown',
      });
    });

    this.client.on('messageCreate', (message) => this.handleMessage(message));
    this.client.on('interactionCreate', (interaction) => this._handleButtonInteraction(interaction));

    this.client.on('error', (error) => {
      this.sendToParent({ type: 'error', message: error.message, fatal: false });
    });

    this.client.on('disconnect', () => {
      this.sendToParent({ type: 'status', connected: false, guildName: null });
    });

    try {
      await this.client.login(config.token);
    } catch (error) {
      this.sendToParent({ type: 'error', message: `Login failed: ${error.message}`, fatal: true });
    }
  }

  /**
   * Handle incoming Discord messages - check if in a tracked thread and from qualified role
   */
  handleMessage(message) {
    if (message.author.bot) return;

    for (const [terminalId, info] of this.threads) {
      if (message.channel.id === info.threadId) {
        const member = message.member;
        const hasAccess = !this.config.qualifiedRoleId
          || (member && member.roles.cache.has(this.config.qualifiedRoleId));

        if (member && hasAccess) {
          const displayName = member.displayName || message.author.username;
          this.sendToParent({
            type: 'reply',
            terminalId,
            author: displayName,
            content: message.content,
          });

          // V2 ack - compact green container showing what was sent
          const ack = new ContainerBuilder()
            .setAccentColor(0x57F287)
            .addTextDisplayComponents(
              new TextDisplayBuilder().setContent(
                `**${displayName}** \u2192 \`${message.content.length > 60 ? message.content.substring(0, 57) + '...' : message.content}\`\n-# Sent to terminal`
              )
            );
          message.reply({
            components: [ack],
            flags: MessageFlags.IsComponentsV2,
          }).catch(() => {});
        }
        return;
      }
    }
  }

  /**
   * Create a thread for a terminal session
   */
  async createThread(terminalId, sessionLabel) {
    try {
      const channel = await this.client.channels.fetch(this.config.channelId);
      if (!channel || channel.type !== ChannelType.GuildText) {
        this.sendToParent({
          type: 'error',
          message: `Channel ${this.config.channelId} not found or not a text channel`,
          fatal: false,
        });
        return;
      }

      const thread = await channel.threads.create({
        name: sessionLabel || `Terminal ${terminalId.substring(0, 8)}`,
        autoArchiveDuration: 1440,
        reason: 'QuadFlow terminal session mirror',
      });

      // V2 opening message
      const roleNotice = this.config.qualifiedRoleId
        ? `Only <@&${this.config.qualifiedRoleId}> can send commands`
        : 'All members can send commands';

      const openContainer = new ContainerBuilder()
        .setAccentColor(0x5865F2)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `## \uD83D\uDDA5\uFE0F Terminal Session \u2014 ${sessionLabel || 'Shell'}`
          )
        )
        .addSeparatorComponents(
          new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent([
            `> ${roleNotice}`,
            '',
            '\u2328\uFE0F **Type a message** to send it as terminal input',
            '\uD83D\uDD18 **Click buttons** on prompts for quick answers',
          ].join('\n'))
        )
        .addSeparatorComponents(
          new SeparatorBuilder().setDivider(false).setSpacing(SeparatorSpacingSize.Small)
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `-# QuadFlow \u2022 Live terminal mirror \u2022 \`${terminalId.substring(0, 8)}\``
          )
        );

      await thread.send({
        components: [openContainer],
        flags: MessageFlags.IsComponentsV2,
      });

      this.threads.set(terminalId, {
        thread,
        threadId: thread.id,
        threadUrl: thread.url,
        lastMessage: null,
        lastMessageTimestamp: 0,
        lastMessageContent: '',
        activePrompt: null,
        startedAt: Date.now(),
      });

      this.sendToParent({
        type: 'thread_created',
        terminalId,
        threadId: thread.id,
        threadUrl: thread.url,
      });
    } catch (error) {
      this.sendToParent({
        type: 'error',
        message: `Failed to create thread: ${error.message}`,
        fatal: false,
      });
    }
  }

  /**
   * Send or edit a chunk in the thread, consolidating messages within a 3s window.
   * Terminal output stays as regular messages (not V2) since they're just code blocks.
   */
  async _sendOrEditChunk(info, chunk) {
    const now = Date.now();
    const timeSinceLast = now - (info.lastMessageTimestamp || 0);

    if (info.lastMessage && timeSinceLast < 3000) {
      const combined = info.lastMessageContent + '\n' + chunk;
      if (combined.length <= 1900) {
        try {
          await info.lastMessage.edit(combined);
          info.lastMessageContent = combined;
          info.lastMessageTimestamp = now;
          return;
        } catch {
          // Edit failed, fall through to send new message
        }
      }
    }

    const msg = await info.thread.send(chunk);
    info.lastMessage = msg;
    info.lastMessageTimestamp = now;
    info.lastMessageContent = chunk;
  }

  /**
   * Check for a prompt in output and send V2 container with buttons.
   */
  async _checkAndSendPrompt(terminalId, info, cleanedText) {
    const prompt = detectPrompt(cleanedText);
    if (!prompt) return;

    // V2 prompt container with interactive buttons
    const container = new ContainerBuilder()
      .setAccentColor(0xFEE75C)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `### \u26A0\uFE0F Input Required\n**${prompt.question}**`
        )
      )
      .addSeparatorComponents(
        new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
      );

    // Build buttons from prompt options
    const buttons = prompt.options.map(opt => {
      const btn = new ButtonBuilder()
        .setCustomId(`qc:${terminalId}:${opt.value}`)
        .setLabel(opt.label);

      try { btn.setEmoji(opt.emoji); } catch { /* skip emoji if invalid */ }

      if (opt.value === 'Y') btn.setStyle(ButtonStyle.Success);
      else if (opt.value === 'N') btn.setStyle(ButtonStyle.Danger);
      else btn.setStyle(ButtonStyle.Secondary);

      return btn;
    });

    // Split into rows of max 5 buttons each
    for (let i = 0; i < buttons.length; i += 5) {
      const rowButtons = buttons.slice(i, i + 5);
      container.addActionRowComponents(
        new ActionRowBuilder().addComponents(...rowButtons)
      );
    }

    const promptMsg = await info.thread.send({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
    });

    // Store active prompt for button handler
    info.activePrompt = {
      messageId: promptMsg.id,
      terminalId,
      question: prompt.question,
    };
    info.lastMessage = null;
    info.lastMessageTimestamp = 0;
    info.lastMessageContent = '';
  }

  /**
   * Handle button interactions on prompt messages.
   * Replaces the old reaction-based system with native Discord buttons.
   */
  async _handleButtonInteraction(interaction) {
    if (!interaction.isButton()) return;
    if (!interaction.customId.startsWith('qc:')) return;

    const parts = interaction.customId.split(':');
    if (parts.length < 3) return;
    const terminalId = parts[1];
    const value = parts.slice(2).join(':');

    const info = this.threads.get(terminalId);
    if (!info || !info.activePrompt) {
      await interaction.reply({
        content: 'This prompt has expired.',
        ephemeral: true,
      }).catch(() => {});
      return;
    }

    // Check qualified role (if not configured, allow all)
    const member = interaction.member;
    if (this.config.qualifiedRoleId && (!member || !member.roles.cache.has(this.config.qualifiedRoleId))) {
      await interaction.reply({
        content: 'You do not have the required role to interact with this terminal.',
        ephemeral: true,
      }).catch(() => {});
      return;
    }

    const displayName = member?.displayName || interaction.user.username;

    // Send input to parent (Rust -> terminal)
    this.sendToParent({
      type: 'reply',
      terminalId,
      author: displayName,
      content: value,
    });

    // Save question before clearing prompt
    const question = info.activePrompt.question;
    info.activePrompt = null;

    // Update the prompt message: yellow -> green, buttons removed, show who selected
    const updatedContainer = new ContainerBuilder()
      .setAccentColor(0x57F287)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `**${question}**\n\n\u2705 **${displayName}** selected **${value}**`
        )
      )
      .addSeparatorComponents(
        new SeparatorBuilder().setDivider(false).setSpacing(SeparatorSpacingSize.Small)
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent('-# Sent to terminal')
      );

    await interaction.update({
      components: [updatedContainer],
      flags: MessageFlags.IsComponentsV2,
    }).catch(() => {});
  }

  /**
   * Send terminal output to a thread
   */
  async sendOutput(terminalId, data) {
    const info = this.threads.get(terminalId);
    if (!info) return;

    try {
      info.thread.sendTyping().catch(() => {});

      const { chunks, cleanedText } = await stripAndFormat(data);

      // Filter out noise chunks (empty code blocks or just whitespace)
      const meaningful = chunks.filter(c => {
        const inner = c.replace(/^```(?:ansi)?\n?/, '').replace(/\n?```$/, '').trim();
        return inner.length > 0;
      });

      if (meaningful.length === 0) return;

      const MAX_CHUNKS = 4;
      const toSend = meaningful.slice(0, MAX_CHUNKS);
      const truncatedCount = meaningful.length - MAX_CHUNKS;

      for (const chunk of toSend) {
        await this._sendOrEditChunk(info, chunk);
      }

      // V2 truncation notice (minimal, no container - just small text)
      if (truncatedCount > 0) {
        await info.thread.send({
          components: [
            new TextDisplayBuilder().setContent(
              `-# \u2026 ${truncatedCount} more block(s) omitted \u2014 output was too large`
            ),
          ],
          flags: MessageFlags.IsComponentsV2,
        });
        info.lastMessage = null;
        info.lastMessageContent = '';
      }

      // Check for prompts after all output chunks are sent
      if (cleanedText) {
        await this._checkAndSendPrompt(terminalId, info, cleanedText);
      }
    } catch (error) {
      if (error.code === 50001 || error.code === 50013) {
        this.sendToParent({
          type: 'error',
          message: `Permission error sending to thread: ${error.message}`,
          fatal: false,
        });
      }
    }
  }

  /**
   * Close a thread (archive it and stop tracking)
   */
  async closeThread(terminalId) {
    const info = this.threads.get(terminalId);
    if (!info) return;

    try {
      const durationMs = Date.now() - (info.startedAt || Date.now());
      const mins = Math.floor(durationMs / 60000);
      const secs = Math.floor((durationMs % 60000) / 1000);
      const duration = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

      // V2 close message
      const closeContainer = new ContainerBuilder()
        .setAccentColor(0xED4245)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent('## Session Ended')
        )
        .addSeparatorComponents(
          new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`Duration: \`${duration}\``)
        )
        .addSeparatorComponents(
          new SeparatorBuilder().setDivider(false).setSpacing(SeparatorSpacingSize.Small)
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent('-# Thread will auto-archive')
        );

      await info.thread.send({
        components: [closeContainer],
        flags: MessageFlags.IsComponentsV2,
      });
      await info.thread.setArchived(true);
    } catch {
      // Best effort
    }

    this.threads.delete(terminalId);
  }

  /**
   * Update settings (qualified role, channel, etc.)
   */
  updateSettings(settings) {
    if (settings.qualifiedRoleId !== undefined) {
      this.config.qualifiedRoleId = settings.qualifiedRoleId;
    }
    if (settings.channelId !== undefined) {
      this.config.channelId = settings.channelId;
    }
  }

  /**
   * Gracefully shut down the bot
   */
  async shutdown() {
    for (const [terminalId] of this.threads) {
      await this.closeThread(terminalId);
    }

    if (this.client) {
      this.client.destroy();
      this.client = null;
    }
  }
}

export { DiscordBot };
