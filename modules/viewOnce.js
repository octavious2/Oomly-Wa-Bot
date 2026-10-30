/**
 * Oomly Technologies - View Once Engine (Diagnostic Build)
 */

const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');

const logger = pino({ level: 'info' });

async function handleViewOnce(sock, msg) {
    try {
        if (!msg || !msg.message) return;

        // Print message top-level keys to terminal for debugging
        const keys = Object.keys(msg.message);
        console.log("📥 [UPSERT MESSAGE KEYS]:", keys);

        // Check if message is View Once (direct or unwrapped)
        let messageContent = msg.message;
        if (messageContent.ephemeralMessage) {
            messageContent = messageContent.ephemeralMessage.message;
        }

        const isViewOnce = 
            messageContent.viewOnceMessage || 
            messageContent.viewOnceMessageV2 || 
            messageContent.viewOnceMessageV2Extension ||
            msg.message?.imageMessage?.viewOnce ||
            msg.message?.videoMessage?.viewOnce;

        if (!isViewOnce) return;

        console.log("👁️ [VIEW ONCE MATCHED!]: Inspecting structure ->", JSON.stringify(messageContent).slice(0, 300));

        // Extract media object
        const targetMessage = messageContent.viewOnceMessage?.message ||
                              messageContent.viewOnceMessageV2?.message ||
                              messageContent.viewOnceMessageV2Extension?.message ||
                              messageContent;

        const mediaType = targetMessage.imageMessage ? 'imageMessage' : 
                          targetMessage.videoMessage ? 'videoMessage' : null;

        if (!mediaType) {
            console.log("⚠️ [VIEW ONCE]: No image or video message found inside container.");
            return;
        }

        const remoteJid = msg.key.remoteJid;
        const sender = msg.key.participant || remoteJid;

        // Download media buffer
        const buffer = await downloadMediaMessage(
            { key: msg.key, message: targetMessage },
            'buffer',
            {},
            { logger }
        );

        if (!buffer) {
            console.log("❌ [VIEW ONCE]: Failed to extract media buffer.");
            return;
        }

        const caption = targetMessage[mediaType]?.caption || "";
        const notificationText = `👁️ *Oomly View Once Extracted*\n👤 *From:* @${sender.split('@')[0]}\n${caption ? `💬 *Caption:* ${caption}` : ''}`;

        if (mediaType === 'imageMessage') {
            await sock.sendMessage(remoteJid, {
                image: buffer,
                caption: notificationText,
                mentions: [sender]
            }, { quoted: msg });
        } else {
            await sock.sendMessage(remoteJid, {
                video: buffer,
                caption: notificationText,
                mentions: [sender]
            }, { quoted: msg });
        }

        console.log("✅ [VIEW ONCE]: Extraction complete.");

    } catch (err) {
        console.error("❌ [VIEW ONCE ERROR]:", err.message);
    }
}

module.exports = { handleViewOnce };