if (!global.deletedVault) global.deletedVault = [];
if (!global.messageCache) global.messageCache = new Map();

/**
 * Handles incoming message upserts for caching and capturing deleted messages,
 * and sends an alert directly into the chat.
 * @param {Object} sock - The active Baileys socket instance
 * @param {Object} msg - The single WhatsApp message object
 */
async function handleAntiDelete(sock, msg) {
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
            const senderPhone = (originalMsg.key.participant || remoteJid).split('@')[0];
            
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

            // 🚀 Send the recovered message directly into the WhatsApp chat!
            await sock.sendMessage(remoteJid, {
                text: `🛡️ *Anti-Delete Alert*\n\n👤 *Sender:* @${senderPhone}\n💬 *Deleted Message:* "${textContent}"`,
                mentions: [`${senderPhone}@s.whatsapp.net`]
            });
        }
    }
}

module.exports = { handleAntiDelete };