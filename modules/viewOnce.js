/**
 * Oomly Technologies - Enterprise View-Once Auto-Mirror Module
 * Uses downloadContentFromMessage to stream and decrypt View-Once media directly.
 */

const { getSettings } = require('./settings');
const pino = require('pino');
const { downloadContentFromMessage } = require('@whiskeysockets/baileys');

function cleanSenderId(jidOrParticipant) {
    if (!jidOrParticipant) return "Unknown";
    return jidOrParticipant.split('@')[0].split(':')[0];
}

/**
 * Unwraps nested View-Once containers (viewOnceMessage, viewOnceMessageV2, ephemeralMessage)
 */
function unwrapMessage(msgObj) {
    if (!msgObj) return null;
    let m = msgObj;

    // Handle ephemeral/disappearing wrapper
    if (m.ephemeralMessage) m = m.ephemeralMessage.message;
    
    // Handle View-Once wrappers
    if (m.viewOnceMessage) m = m.viewOnceMessage.message;
    else if (m.viewOnceMessageV2) m = m.viewOnceMessageV2.message;
    else if (m.viewOnceMessageV2Extension) m = m.viewOnceMessageV2Extension.message;

    return m;
}

/**
 * Identifies media payload inside the unwrapped message
 */
function extractMediaPayload(messageContainer) {
    if (!messageContainer) return null;

    if (messageContainer.imageMessage) {
        return { type: 'image', media: messageContainer.imageMessage, key: 'imageMessage' };
    }
    if (messageContainer.videoMessage) {
        return { type: 'video', media: messageContainer.videoMessage, key: 'videoMessage' };
    }
    if (messageContainer.audioMessage) {
        return { type: 'audio', media: messageContainer.audioMessage, key: 'audioMessage' };
    }

    return null;
}

async function handleViewOnce(sock, msg) {
    // 1. Verify feature setting state
    const settings = getSettings();
    if (!settings.viewOnce) {
        return;
    }

    if (!msg || !msg.message) return;

    // 2. Inspect for View-Once markers
    const rawStr = JSON.stringify(msg.message);
    const isViewOnce = rawStr.includes('viewOnce') || 
                       Boolean(msg.message.imageMessage?.viewOnce) || 
                       Boolean(msg.message.videoMessage?.viewOnce) ||
                       Boolean(msg.message.audioMessage?.viewOnce);

    if (!isViewOnce) return;

    console.log("📸 [VIEW-ONCE DETECTED]: Intercepting View-Once message payload...");

    // 3. Unwrap message layers and locate media
    const unwrapped = unwrapMessage(msg.message);
    const mediaItem = extractMediaPayload(unwrapped);

    if (!mediaItem) {
        console.log("❌ [VIEW-ONCE ERROR]: View-Once flag present, but no supported media payload found.");
        return;
    }

    try {
        const remoteJid = msg.key.remoteJid;
        const senderJid = msg.key.participant || remoteJid;
        const senderPhone = cleanSenderId(senderJid);
        const isGroup = remoteJid.endsWith('@g.us');

        // 4. Download content stream using Baileys low-level decryptor
        const stream = await downloadContentFromMessage(mediaItem.media, mediaItem.type);
        let buffer = Buffer.from([]);
        for await (const chunk of stream) {
            buffer = Buffer.concat([buffer, chunk]);
        }

        if (!buffer || buffer.length === 0) {
            console.error("❌ [VIEW-ONCE ERROR]: Decryption produced an empty buffer.");
            return;
        }

        // 5. Determine owner destination JID
        const ownerJid = sock.user?.id ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : null;
        if (!ownerJid) {
            console.error("❌ [VIEW-ONCE ERROR]: Bot owner JID unavailable.");
            return;
        }

        const caption = mediaItem.media.caption || "";
        const typeLabel = mediaItem.type.toUpperCase();

        const alertText = 
            `🔓 *VIEW-ONCE MIRROR*\n\n` +
            `📍 *Source:* ${isGroup ? 'Group Chat' : 'Direct Message'}\n` +
            `👤 *Sender:* @${senderPhone}\n` +
            `📦 *Type:* ${typeLabel}\n` +
            `${caption ? `📝 *Caption:* "${caption}"` : ''}`;

        // 6. Build payload and forward permanent copy to Owner DM
        const outPayload = {};
        if (mediaItem.type === 'image') outPayload.image = buffer;
        else if (mediaItem.type === 'video') outPayload.video = buffer;
        else if (mediaItem.type === 'audio') {
            outPayload.audio = buffer;
            outPayload.mimetype = 'audio/mp4';
            outPayload.ptt = true;
        }

        await sock.sendMessage(ownerJid, {
            ...outPayload,
            caption: alertText,
            mentions: [senderJid]
        });

        console.log(`✅ [VIEW-ONCE SUCCESS]: Mirrored ${typeLabel} (${buffer.length} bytes) to Owner DM.`);

    } catch (err) {
        console.error("❌ [VIEW-ONCE EXCEPTION]:", err.message);
    }
}

module.exports = { handleViewOnce };