/**
 * Oomly Technologies - Enterprise Anti-Delete Module (Mode A: Instant Owner DM)
 * Gracefully captures deleted messages and forwards them silently to the bot owner's private DM.
 */

const { getSettings } = require('./settings');
const pino = require('pino');

// Bounded in-memory message cache (Holds up to 1000 recent messages to prevent memory bloating)
if (!global.messageCache) {
    global.messageCache = new Map();
}

const MAX_CACHE_SIZE = 1000;

/**
 * Normalizes phone numbers / JIDs for display
 */
function cleanSenderId(jidOrParticipant) {
    if (!jidOrParticipant) return "Unknown";
    return jidOrParticipant.split('@')[0].split(':')[0];
}

/**
 * Caches incoming messages to track potential future deletions
 */
function cacheIncomingMessage(msg) {
    if (!msg || !msg.key || !msg.key.id) return;

    const messageId = msg.key.id;

    // Enforce size limit (FIFO eviction)
    if (global.messageCache.size >= MAX_CACHE_SIZE) {
        const oldestKey = global.messageCache.keys().next().value;
        global.messageCache.delete(oldestKey);
    }

    global.messageCache.set(messageId, msg);
}

/**
 * Extracts readable content from complex message structures
 */
function extractMessageContent(msgMessage) {
    if (!msgMessage) return { type: 'text', content: '[Empty Message]' };

    if (msgMessage.conversation) {
        return { type: 'text', content: msgMessage.conversation };
    }
    if (msgMessage.extendedTextMessage) {
        return { type: 'text', content: msgMessage.extendedTextMessage.text || '[Extended Text]' };
    }
    if (msgMessage.imageMessage) {
        return { type: 'image', content: msgMessage.imageMessage.caption || '[Photo Attachment]' };
    }
    if (msgMessage.videoMessage) {
        return { type: 'video', content: msgMessage.videoMessage.caption || '[Video Attachment]' };
    }
    if (msgMessage.audioMessage) {
        return { type: 'audio', content: '[Voice Note / Audio Attachment]' };
    }
    if (msgMessage.documentMessage) {
        return { type: 'document', content: msgMessage.documentMessage.fileName || '[Document File]' };
    }

    return { type: 'unknown', content: '[Media / Unsupported Content Type]' };
}

/**
 * Main anti-delete event processor
 */
async function handleAntiDelete(sock, msg) {
    // 1. Check if anti-delete feature is toggled on in settings
    if (!getSettings().antiDelete) return;
    if (!msg || !msg.message) return;

    // 2. Cache every incoming message normal flow
    cacheIncomingMessage(msg);

    // 3. Detect if the incoming message is a revocation / deletion event (protocolMessage type 0)
    const protocolMsg = msg.message.protocolMessage;
    if (protocolMsg && protocolMsg.type === 0) {
        const deletedMessageId = protocolMsg.key?.id;
        if (!deletedMessageId) return;

        // Retrieve original message from memory cache
        const originalMsg = global.messageCache.get(deletedMessageId);
        if (!originalMsg) {
            console.log(`🛡️ [ANTI-DELETE]: Received deletion event for ID ${deletedMessageId}, but message was not found in local cache.`);
            return;
        }

        try {
            // Resolve details
            const remoteJid = originalMsg.key.remoteJid;
            const senderJid = originalMsg.key.participant || remoteJid;
            const senderPhone = cleanSenderId(senderJid);
            const isGroup = remoteJid.endsWith('@g.us');
            
            const { type, content } = extractMessageContent(originalMsg.message);

            // Derive owner JID (Bot's own personal chat / Message Yourself)
            const ownerJid = sock.user?.id ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : null;
            if (!ownerJid) {
                console.error("❌ [ANTI-DELETE ERROR]: Could not resolve owner JID for DM notification.");
                return;
            }

            // Construct stealth alert layout
            const alertText = 
                `🛡️ *ANTI-DELETE INTERCEPT*\n\n` +
                `📍 *Context:* ${isGroup ? 'Group Chat' : 'Direct Message'}\n` +
                `👤 *Sender:* @${senderPhone}\n` +
                `📦 *Type:* ${type.toUpperCase()}\n` +
                `💬 *Recovered Content:* \n"${content}"`;

            // Silently deliver straight to your personal owner DM
            await sock.sendMessage(ownerJid, {
                text: alertText,
                mentions: [senderJid]
            });

            console.log(`🛡️ [ANTI-DELETE SUCCESS]: Recovered & forwarded deleted ${type} from ${senderPhone}`);

        } catch (err) {
            console.error("❌ [ANTI-DELETE ERROR]: Failed to process deletion event:", err.message);
        }
    }
}

module.exports = { handleAntiDelete };