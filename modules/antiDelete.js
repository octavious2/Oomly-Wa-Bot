const { getSettings } = require('./settings');

if (!global.deletedVault) global.deletedVault = [];
if (!global.messageCache) global.messageCache = new Map();

// Helper to reliably extract clean phone/sender identifiers from JIDs
function cleanSenderId(jidOrParticipant) {
    if (!jidOrParticipant) return "Unknown";
    // Handles formats like "2567XXXXX:2@s.whatsapp.net" or "2567XXXXX@s.whatsapp.net"
    const base = jidOrParticipant.split('@')[0];
    return base.split(':')[0];
}

async function handleAntiDelete(sock, msg) {
    if (!getSettings().antiDelete) return;
    if (!msg || !msg.message) return;
    const messageId = msg.key.id;

    // 1. Cache message
    if (global.messageCache.size > 1000) {
        const firstKey = global.messageCache.keys().next().value;
        global.messageCache.delete(firstKey);
    }
    global.messageCache.set(messageId, msg);

    // 2. Check for deletion (protocolMessage type === 0)
    if (msg.message.protocolMessage && msg.message.protocolMessage.type === 0) {
        const deletedKey = msg.message.protocolMessage.key.id;
        const originalMsg = global.messageCache.get(deletedKey);

        if (originalMsg) {
            const remoteJid = originalMsg.key.remoteJid;
            const rawSender = originalMsg.key.participant || remoteJid;
            const senderPhone = cleanSenderId(rawSender);
            
            const innerMsg = originalMsg.message;
            const textContent = innerMsg.conversation 
                || innerMsg.extendedTextMessage?.text 
                || innerMsg.imageMessage?.caption 
                || innerMsg.videoMessage?.caption 
                || "[Media / Attachment]";

            // Save to web dashboard vault
            global.deletedVault.unshift({
                id: deletedKey,
                sender: senderPhone,
                text: textContent,
                timestamp: new Date().toLocaleTimeString()
            });

            console.log(`🗑️ [ANTI-DELETE]: Recovered message from ${senderPhone}: "${textContent}"`);

            await sock.sendMessage(remoteJid, {
                text: `🛡️ *Anti-Delete Alert*\n\n👤 *Sender:* @${senderPhone}\n💬 *Deleted Message:* "${textContent}"`,
                mentions: [`${senderPhone}@s.whatsapp.net`]
            });
        }
    }
}

module.exports = { handleAntiDelete };