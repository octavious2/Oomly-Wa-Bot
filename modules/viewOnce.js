/**
 * Oomly Technologies - Enterprise View-Once Auto-Mirror Module
 * Unpacks WhatsApp ViewOnce wrappers and mirrors permanent media to the owner DM.
 */

const { getSettings } = require('./settings');
const pino = require('pino');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');

function cleanSenderId(jidOrParticipant) {
    if (!jidOrParticipant) return "Unknown";
    return jidOrParticipant.split('@')[0].split(':')[0];
}

/**
 * Extracts and unpacks view-once structures to reveal inner media payload
 */
function extractViewOnceContent(rawMsg) {
    if (!rawMsg || !rawMsg.message) return null;

    let msg = rawMsg.message;

    // Un-wrap protocol viewOnce wrappers if present
    if (msg.viewOnceMessage) {
        msg = msg.viewOnceMessage.message;
    } else if (msg.viewOnceMessageV2) {
        msg = msg.viewOnceMessageV2.message;
    } else if (msg.viewOnceMessageV2Extension) {
        msg = msg.viewOnceMessageV2Extension.message;
    }

    if (!msg) return null;

    if (msg.imageMessage) {
        return { type: 'imageMessage', media: msg.imageMessage, innerMessage: { imageMessage: msg.imageMessage } };
    }
    if (msg.videoMessage) {
        return { type: 'videoMessage', media: msg.videoMessage, innerMessage: { videoMessage: msg.videoMessage } };
    }
    if (msg.audioMessage) {
        return { type: 'audioMessage', media: msg.audioMessage, innerMessage: { audioMessage: msg.audioMessage } };
    }

    return null;
}

async function handleViewOnce(sock, msg) {
    if (!getSettings().viewOnce) return;
    if (!msg || !msg.message) return;

    // Check if message is a view-once type
    const isViewOnce = Boolean(
        msg.message.viewOnceMessage || 
        msg.message.viewOnceMessageV2 || 
        msg.message.viewOnceMessageV2Extension ||
        msg.message.imageMessage?.viewOnce ||
        msg.message.videoMessage?.viewOnce ||
        msg.message.audioMessage?.viewOnce
    );

    if (!isViewOnce) return;

    const extracted = extractViewOnceContent(msg);
    if (!extracted) {
        console.log("📸 [VIEW-ONCE]: Detected view-once flag, but could not extract media payload.");
        return;
    }

    try {
        const remoteJid = msg.key.remoteJid;
        const senderJid = msg.key.participant || remoteJid;
        const senderPhone = cleanSenderId(senderJid);
        const isGroup = remoteJid.endsWith('@g.us');

        // Reconstruct precise download message wrapper
        const downloadTarget = {
            key: msg.key,
            message: extracted.innerMessage
        };

        // Download raw media buffer
        const buffer = await downloadMediaMessage(
            downloadTarget,
            'buffer',
            {},
            { 
                logger: pino({ level: 'silent' }), 
                reuploadRequest: sock.updateMediaMessage 
            }
        );

        // Resolve owner JID (Bot Owner DM / Message Yourself)
        const ownerJid = sock.user?.id ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : null;
        if (!ownerJid) {
            console.error("❌ [VIEW-ONCE ERROR]: Missing owner JID.");
            return;
        }

        const originalCaption = extracted.media.caption || "";
        const mediaTypeLabel = extracted.type === 'imageMessage' ? 'Photo' : extracted.type === 'videoMessage' ? 'Video' : 'Audio';

        const captionText = 
            `🔓 *VIEW-ONCE MIRROR*\n\n` +
            `📍 *Source:* ${isGroup ? 'Group Chat' : 'Direct Message'}\n` +
            `👤 *Sender:* @${senderPhone}\n` +
            `📦 *Type:* ${mediaTypeLabel}\n` +
            `${originalCaption ? `📝 *Caption:* "${originalCaption}"` : ''}`;

        // Forward unlocked media directly to owner DM
        const mediaPayload = {};
        if (extracted.type === 'imageMessage') mediaPayload.image = buffer;
        else if (extracted.type === 'videoMessage') mediaPayload.video = buffer;
        else if (extracted.type === 'audioMessage') {
            mediaPayload.audio = buffer;
            mediaPayload.mimetype = 'audio/mp4';
            mediaPayload.ptt = true;
        }

        await sock.sendMessage(ownerJid, {
            ...mediaPayload,
            caption: captionText,
            mentions: [senderJid]
        });

        console.log(`📸 [VIEW-ONCE SUCCESS]: Intercepted & mirrored ${mediaTypeLabel} from ${senderPhone}`);

    } catch (err) {
        console.error("❌ [VIEW-ONCE ERROR]: Failed to download/forward media:", err.message);
    }
}

module.exports = { handleViewOnce };