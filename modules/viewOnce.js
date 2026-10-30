/**
 * Oomly Technologies - View Once Media Extractor Engine (Deep Protocol Support)
 */

const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');

const logger = pino({ level: 'info' });

async function handleViewOnce(sock, msg) {
    try {
        if (!msg || !msg.message) return;

        // 1. Unwrap ephemeral message containers if present
        let rawMessage = msg.message;
        if (rawMessage.ephemeralMessage) {
            rawMessage = rawMessage.ephemeralMessage.message;
        }

        // 2. Unpack view once wrappers across all protocol variants
        const viewOnceContainer = 
            rawMessage.viewOnceMessage || 
            rawMessage.viewOnceMessageV2 || 
            rawMessage.viewOnceMessageV2Extension;

        if (!viewOnceContainer || !viewOnceContainer.message) return;

        const innerMessage = viewOnceContainer.message;
        const mediaType = Object.keys(innerMessage)[0]; // imageMessage or videoMessage

        if (mediaType !== 'imageMessage' && mediaType !== 'videoMessage') {
            return;
        }

        console.log(`👁️ [VIEW ONCE DETECTED]: Intercepted ${mediaType}`);

        const remoteJid = msg.key.remoteJid;
        const sender = msg.key.participant || remoteJid;

        // 3. Reconstruct a download-compatible message structure
        const downloadStreamMessage = {
            key: msg.key,
            message: innerMessage
        };

        // 4. Download media buffer directly
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

        const caption = innerMessage[mediaType]?.caption || "";
        const notificationText = `👁️ *Oomly View Once Extracted*\n👤 *From:* @${sender.split('@')[0]}\n${caption ? `💬 *Caption:* ${caption}` : ''}`;

        if (mediaType === 'imageMessage') {
            await sock.sendMessage(remoteJid, {
                image: buffer,
                caption: notificationText,
                mentions: [sender]
            }, { quoted: msg });
        } else if (mediaType === 'videoMessage') {
            await sock.sendMessage(remoteJid, {
                video: buffer,
                caption: notificationText,
                mentions: [sender]
            }, { quoted: msg });
        }

        console.log(`✅ [VIEW ONCE]: Successfully reposted extracted media.`);

    } catch (err) {
        console.error("❌ [VIEW ONCE EXCEPTION]:", err.message);
    }
}

module.exports = { handleViewOnce };