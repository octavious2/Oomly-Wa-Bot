const { getSettings } = require('./settings');

if (!global.messageCache) global.messageCache = new Map();

function cleanSenderId(jidOrParticipant) {
    if (!jidOrParticipant) return "Unknown";
    return jidOrParticipant.split('@')[0].split(':')[0];
}

async function handleAntiDelete(sock, msg) {
    if (!getSettings().antiDelete) return;
    if (!msg || !msg.message) return;
    const messageId = msg.key.id;

    // Cache message
    if (global.messageCache.size > 1000) {
        const firstKey = global.messageCache.keys().next().value;
        global.messageCache.delete(firstKey);
    }
    global.messageCache.set(messageId, msg);

    // Detect message deletion (protocolMessage type === 0)
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

            console.log(`🗑️ [ANTI-DELETE]: Intercepted deletion from ${senderPhone}: "${textContent}"`);

            // Send private notification to the bot owner's chat
            try {
                const ownerJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
                await sock.sendMessage(ownerJid, {
                    text: `🛡️ *Anti-Delete Intercept*\n\n📍 *Chat:* ${remoteJid.includes('@g.us') ? 'Group Chat' : 'Direct Message'}\n👤 *Sender ID:* ${senderPhone}\n💬 *Deleted Text:* "${textContent}"`
                });
            } catch (e) {
                console.error("Anti-delete notification dispatch error:", e.message);
            }
        }
    }
}

module.exports = { handleAntiDelete };