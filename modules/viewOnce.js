const { getSettings } = require('./settings');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');

if (!global.viewOnceVault) global.viewOnceVault = [];

const mediaVaultDir = path.join(__dirname, '../public/vault_media');
if (!fs.existsSync(mediaVaultDir)) {
    fs.mkdirSync(mediaVaultDir, { recursive: true });
}

function cleanSenderId(jidOrParticipant) {
    if (!jidOrParticipant) return "Unknown";
    const base = jidOrParticipant.split('@')[0];
    return base.split(':')[0];
}

async function handleViewOnce(sock, msg) {
    if (!getSettings().viewOnce) return;
    if (!msg || !msg.message) return;

    let targetMessage = msg.message;
    let isViewOnce = false;

    // Log message keys to inspect incoming structure during testing
    const topKeys = Object.keys(targetMessage);
    console.log(`🔍 [VIEW-ONCE DEBUG] Incoming message keys:`, topKeys);

    if (targetMessage.viewOnceMessage?.message) {
        targetMessage = targetMessage.viewOnceMessage.message;
        isViewOnce = true;
    } else if (targetMessage.viewOnceMessageV2?.message) {
        targetMessage = targetMessage.viewOnceMessageV2.message;
        isViewOnce = true;
    } else if (targetMessage.viewOnceMessageV2Extension?.message) {
        targetMessage = targetMessage.viewOnceMessageV2Extension.message;
        isViewOnce = true;
    } else if (targetMessage.imageMessage?.viewOnce || targetMessage.videoMessage?.viewOnce) {
        // Handle inline viewOnce property if present
        isViewOnce = true;
    }

    const type = Object.keys(targetMessage)[0];
    console.log(`🔍 [VIEW-ONCE DEBUG] Resolved target message type: ${type}, IsViewOnce: ${isViewOnce}`);

    if (!['imageMessage', 'videoMessage'].includes(type)) return;

    try {
        const unpackedMsg = { key: msg.key, message: targetMessage };
        const buffer = await downloadMediaMessage(
            unpackedMsg,
            'buffer',
            {},
            { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
        );

        const ext = type === 'imageMessage' ? 'jpg' : 'mp4';
        const fileName = `viewonce_${Date.now()}.${ext}`;
        const filePath = path.join(mediaVaultDir, fileName);

        fs.writeFileSync(filePath, buffer);

        const remoteJid = msg.key.remoteJid;
        const rawSender = msg.key.participant || remoteJid;
        const senderPhone = cleanSenderId(rawSender);
        const caption = targetMessage[type]?.caption || "";

        // Save to dashboard
        global.viewOnceVault.unshift({
            sender: senderPhone,
            type: isViewOnce ? 'View-Once ' + ext.toUpperCase() : ext.toUpperCase(),
            url: `/vault_media/${fileName}`,
            caption: caption,
            timestamp: new Date().toLocaleTimeString()
        });

        console.log(`📸 [VIEW-ONCE BYPASSED]: Successfully captured ${ext} from ${senderPhone}`);

        if (type === 'imageMessage') {
            await sock.sendMessage(remoteJid, {
                image: buffer,
                caption: `🔓 *View-Once Bypassed Photo*\n👤 From: @${senderPhone}\n${caption ? `📝 ${caption}` : ''}`,
                mentions: [`${senderPhone}@s.whatsapp.net`]
            });
        } else if (type === 'videoMessage') {
            await sock.sendMessage(remoteJid, {
                video: buffer,
                caption: `🔓 *View-Once Bypassed Video*\n👤 From: @${senderPhone}\n${caption ? `📝 ${caption}` : ''}`,
                mentions: [`${senderPhone}@s.whatsapp.net`]
            });
        }
    } catch (err) {
        console.error("❌ [VIEW-ONCE DOWNLOAD ERROR]:", err.message || err);
    }
}

module.exports = { handleViewOnce };