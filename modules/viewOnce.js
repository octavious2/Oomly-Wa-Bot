/**
 * Oomly Technologies - Enterprise View-Once Auto-Mirror Module
 * Silently intercepts view-once media and permanently mirrors it to the owner's private DM.
 */

const { getSettings } = require('./settings');
const pino = require('pino');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');

/**
 * Normalizes JIDs to clean phone numbers
 */
function cleanSenderId(jidOrParticipant) {
    if (!jidOrParticipant) return "Unknown";
    return jidOrParticipant.split('@')[0].split(':')[0];
}

/**
 * Deep recursive search helper to find imageMessage or videoMessage inside nested wrappers
 */
function extractMediaObject(obj) {
    if (!obj || typeof obj !== 'object') return null;
    if (obj.imageMessage) return { type: 'imageMessage', media: obj.imageMessage };
    if (obj.videoMessage) return { type: 'videoMessage', media: obj.videoMessage };

    for (const key of Object.keys(obj)) {
        if (typeof obj[key] === 'object' && obj[key] !== null) {
            const found = extractMediaObject(obj[key]);
            if (found) return found;
        }
    }
    return null;
}

/**
 * Main View-Once processor
 */
async function handleViewOnce(sock, msg) {
    // 1. Check if view-once feature is toggled on in settings
    if (!getSettings().viewOnce) return;
    if (!msg || !msg.message) return;

    // 2. Locate media payload and verify view-once flag
    const mediaResult = extractMediaObject(msg.message);
    const rawString = JSON.stringify(msg.message);
    const isViewOnceFlag = rawString.includes('viewOnce') || rawString.includes('viewOnceMessageV2');

    if (mediaResult && isViewOnceFlag) {
        try {
            const messageId = msg.key.id;
            const remoteJid = msg.key.remoteJid;
            const senderJid = msg.key.participant || remoteJid;
            const senderPhone = cleanSenderId(senderJid);
            const isGroup = remoteJid.endsWith('@g.us');

            // Reconstruct payload for Baileys media downloader
            const reconstructedMsg = {
                key: msg.key,
                message: {
                    [mediaResult.type]: mediaResult.media
                }
            };

            // Download media buffer into RAM
            const buffer = await downloadMediaMessage(
                reconstructedMsg,
                'buffer',
                {},
                { 
                    logger: pino({ level: 'silent' }), 
                    reuploadRequest: sock.updateMediaMessage 
                }
            );

            // Derive owner JID (Bot's own personal chat / Message Yourself)
            const ownerJid = sock.user?.id ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : null;
            if (!ownerJid) {
                console.error("❌ [VIEW-ONCE ERROR]: Could not resolve owner JID.");
                return;
            }

            const originalCaption = mediaResult.media.caption || "";
            const mediaTypeName = mediaResult.type === 'imageMessage' ? 'Photo' : 'Video';

            const captionText = 
                `🔓 *VIEW-ONCE MIRROR*\n\n` +
                `📍 *Source:* ${isGroup ? 'Group Chat' : 'Direct Message'}\n` +
                `👤 *Sender:* @${senderPhone}\n` +
                `📦 *Type:* ${mediaTypeName}\n` +
                `${originalCaption ? `📝 *Caption:* "${originalCaption}"` : ''}`;

            // Automatically send the unlocked permanent media directly to your private owner DM
            await sock.sendMessage(ownerJid, {
                [mediaResult.type === 'imageMessage' ? 'image' : 'video']: buffer,
                caption: captionText,
                mentions: [senderJid]
            });

            console.log(`📸 [VIEW-ONCE SUCCESS]: Intercepted & mirrored ${mediaTypeName} from ${senderPhone}`);

        } catch (err) {
            console.error("❌ [VIEW-ONCE ERROR]: Failed to download/mirror media:", err.message);
        }
    }
}

module.exports = { handleViewOnce };