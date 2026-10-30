/**
 * Oomly Technologies - View Once Media Extractor Engine
 */

const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');

const logger = pino({ level: 'info' });

async function handleViewOnce(sock, msg) {
    try {
        if (!msg || !msg.message) return;

        // Unpack view once wrappers across different Baileys protocol versions
        const innerMessage = 
            msg.message.viewOnceMessage?.message || 
            msg.message.viewOnceMessageV2?.message || 
            msg.message.viewOnceMessageV2Extension?.message;

        if (!innerMessage) return;

        const mediaType = Object.keys(innerMessage)[0]; // imageMessage or videoMessage
        if (!mediaType || (mediaType !== 'imageMessage' && mediaType !== 'videoMessage')) {
            return;
        }

        console.log(`👁️ [VIEW ONCE DETECTED]: Intercepted ephemeral ${mediaType}`);

        const remoteJid = msg.key.remoteJid;
        const sender = msg.key.participant || remoteJid;

        // Reconstruct a standard message object for downloading
        const downloadStreamMessage = {
            key: msg.key,
            message: innerMessage
        };

        // Download the media buffer directly via Baileys stream
        const buffer = await downloadMediaMessage(
            downloadStreamMessage,
            'buffer',
            {},
            { logger }
        );

        if (!buffer) {
            console.error("❌ [VIEW ONCE]: Failed to download media buffer.");
            return;
        }

        const caption = innerMessage[mediaType].caption || "";
        const notificationText = `👁️ *Oomly View Once Extracted*\n👤 *From:* @${sender.split('@')[0]}\n${caption ? `💬 *Caption:* ${caption}` : ''}`;

        if (mediaType === 'imageMessage') {
            await sock.sendMessage(remoteJid, {
                image: buffer,
                caption: notificationText,
                mentions: [sender]
            });
        } else if (mediaType === 'videoMessage') {
            await sock.sendMessage(remoteJid, {
                video: buffer,
                caption: notificationText,
                mentions: [sender]
            });
        }

        console.log(`✅ [VIEW ONCE]: Successfully reposted extracted media.`);

    } catch (err) {
        console.error("❌ [VIEW ONCE EXCEPTION]:", err.message);
    }
}

module.exports = { handleViewOnce };