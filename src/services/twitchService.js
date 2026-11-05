import axios from 'axios';
import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
} from 'discord.js';
import { logger } from '../utils/logger.js';

const TWITCH_TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const TWITCH_STREAMS_URL = 'https://api.twitch.tv/helix/streams';

let cachedAccessToken = null;
let cachedAccessTokenExpiresAt = 0;

let twitchCheckInProgress = false;

// Extra protection against duplicate alerts if the database temporarily fails.
const announcedThisProcess = new Map();

function getStreamers() {
    return (process.env.TWITCH_STREAMERS || '')
        .split(',')
        .map(streamer => streamer.trim().toLowerCase())
        .filter(Boolean)
        .filter((streamer, index, array) => array.indexOf(streamer) === index);
}

function getTwitchConfig() {
    return {
        clientId: process.env.TWITCH_CLIENT_ID,
        clientSecret: process.env.TWITCH_CLIENT_SECRET,
        channelId: process.env.TWITCH_ALERT_CHANNEL_ID,
        roleId: process.env.TWITCH_ALERT_ROLE_ID,
        streamers: getStreamers(),
    };
}

async function getAppAccessToken(forceRefresh = false) {
    const config = getTwitchConfig();

    if (!config.clientId || !config.clientSecret) {
        throw new Error(
            'TWITCH_CLIENT_ID or TWITCH_CLIENT_SECRET is missing from environment variables.'
        );
    }

    // Refresh one minute early to avoid using a token that is just about to expire.
    const tokenStillValid =
        cachedAccessToken &&
        Date.now() < cachedAccessTokenExpiresAt - 60_000;

    if (!forceRefresh && tokenStillValid) {
        return cachedAccessToken;
    }

    const body = new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: 'client_credentials',
    });

    const response = await axios.post(TWITCH_TOKEN_URL, body, {
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 10_000,
    });

    cachedAccessToken = response.data.access_token;

    const expiresInSeconds = Number(response.data.expires_in || 0);

    cachedAccessTokenExpiresAt =
        Date.now() + expiresInSeconds * 1000;

    logger.info('Twitch app access token refreshed');

    return cachedAccessToken;
}

async function fetchLiveStreams(streamers, retryOnUnauthorized = true) {
    if (!streamers.length) {
        return [];
    }

    const config = getTwitchConfig();
    const accessToken = await getAppAccessToken();

    const query = new URLSearchParams();

    for (const streamer of streamers) {
        query.append('user_login', streamer);
    }

    try {
        const response = await axios.get(
            `${TWITCH_STREAMS_URL}?${query.toString()}`,
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'Client-Id': config.clientId,
                },
                timeout: 10_000,
            }
        );

        return response.data?.data || [];
    } catch (error) {
        // Token may have expired/revoked. Refresh once and retry.
        if (
            retryOnUnauthorized &&
            error.response?.status === 401
        ) {
            logger.warn(
                'Twitch access token was rejected. Refreshing token and retrying.'
            );

            cachedAccessToken = null;
            cachedAccessTokenExpiresAt = 0;

            await getAppAccessToken(true);

            return fetchLiveStreams(streamers, false);
        }

        throw error;
    }
}

function getPreviewImage(stream) {
    if (!stream.thumbnail_url) {
        return null;
    }

    const image = stream.thumbnail_url
        .replace('{width}', '1280')
        .replace('{height}', '720');

    // Prevent Discord from showing a cached image from an older stream.
    return `${image}?t=${Date.now()}`;
}

function createStreamEmbed(stream) {
    const twitchUrl = `https://www.twitch.tv/${stream.user_login}`;

    const embed = new EmbedBuilder()
        .setColor(0x9146FF)
        .setAuthor({
            name: `🔴 ${stream.user_name} is LIVE on Twitch!`,
        })
        .setTitle(
            stream.title || `${stream.user_name} is now live!`
        )
        .setURL(twitchUrl)
        .addFields(
            {
                name: '🎮 Category',
                value: stream.game_name || 'No category set',
                inline: true,
            },
            {
                name: '👀 Viewers',
                value: Number(stream.viewer_count || 0).toLocaleString('en-GB'),
                inline: true,
            },
            {
                name: '🟣 Live Since',
                value: `<t:${Math.floor(
                    new Date(stream.started_at).getTime() / 1000
                )}:R>`,
                inline: true,
            }
        )
        .setFooter({
            text: 'MissedTheApex • Twitch Live Alert',
        });

    const previewImage = getPreviewImage(stream);

    if (previewImage) {
        embed.setImage(previewImage);
    }

    return embed;
}

function createStreamButton(stream) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setLabel('Watch Stream')
            .setEmoji('🟣')
            .setStyle(ButtonStyle.Link)
            .setURL(`https://www.twitch.tv/${stream.user_login}`)
    );
}

async function announceStream(client, channel, roleId, stream) {
    const username = stream.user_login.toLowerCase();

    const databaseKey =
        `cache:twitch:last_announced_stream:${username}`;

    const previouslyAnnouncedStreamId =
        await client.db?.get(databaseKey, null);

    const processStreamId =
        announcedThisProcess.get(username);

    // Same Twitch broadcast — don't announce it again.
    if (
        previouslyAnnouncedStreamId === stream.id ||
        processStreamId === stream.id
    ) {
        return false;
    }

    const embed = createStreamEmbed(stream);
    const button = createStreamButton(stream);

    await channel.send({
        content:
            `<@&${roleId}> **${stream.user_name} just went LIVE on Twitch!**`,
        embeds: [embed],
        components: [button],

        // Only permit the specific configured role to be pinged.
        allowedMentions: {
            parse: [],
            roles: [roleId],
        },
    });

    // Immediately mark it in memory before touching the DB.
    // This prevents spam if PostgreSQL temporarily fails.
    announcedThisProcess.set(username, stream.id);

    if (client.db) {
        const saved = await client.db.set(
            databaseKey,
            stream.id
        );

        if (!saved) {
            logger.warn(
                `Twitch alert for ${username} was sent but could not be saved to the database.`
            );
        }
    }

    logger.info(
        `Twitch live alert sent for ${stream.user_name} (${stream.id})`
    );

    return true;
}

export async function checkTwitchStreams(client) {
    if (twitchCheckInProgress) {
        logger.debug(
            'Skipping Twitch check because the previous check is still running.'
        );
        return;
    }

    twitchCheckInProgress = true;

    try {
        const config = getTwitchConfig();

        if (
            !config.clientId ||
            !config.clientSecret ||
            !config.channelId ||
            !config.roleId
        ) {
            logger.warn(
                'Twitch alerts are not configured. Missing Twitch environment variables.'
            );
            return;
        }

        if (!config.streamers.length) {
            logger.warn(
                'Twitch alerts are enabled but TWITCH_STREAMERS is empty.'
            );
            return;
        }

        if (!client.isReady()) {
            logger.debug(
                'Discord client is not ready. Skipping Twitch check.'
            );
            return;
        }

        const alertChannel =
            await client.channels.fetch(config.channelId);

        if (
            !alertChannel ||
            !alertChannel.isTextBased() ||
            typeof alertChannel.send !== 'function'
        ) {
            logger.error(
                `Twitch alert channel ${config.channelId} is not a sendable text channel.`
            );
            return;
        }

        const liveStreams =
            await fetchLiveStreams(config.streamers);

        if (!liveStreams.length) {
            logger.debug(
                `Twitch check complete: none of ${config.streamers.length} monitored streamers are live.`
            );
            return;
        }

        for (const stream of liveStreams) {
            try {
                await announceStream(
                    client,
                    alertChannel,
                    config.roleId,
                    stream
                );
            } catch (error) {
                logger.error(
                    `Failed to announce Twitch stream for ${stream.user_login}:`,
                    error
                );
            }
        }
    } catch (error) {
        const twitchError =
            error.response?.data?.message ||
            error.response?.data?.error ||
            error.message;

        logger.error(
            `Twitch stream check failed: ${twitchError}`,
            error
        );
    } finally {
        twitchCheckInProgress = false;
    }
}
