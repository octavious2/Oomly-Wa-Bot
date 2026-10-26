/**
 * Ghost Utilities Module for Oomly WhatsApp Bot
 * Handles status auto-view/reactions and typing/presence simulation.
 */

/**
 * Automatically marks incoming status updates as viewed (and optionally reacts to them).
 * @param {Object} sock - The active Baileys socket instance
 * @param {Object} msg - The status message object
 */
async function handleAutoStatus(sock, msg) {
    try {
        // WhatsApp status broadcasts are sent to "status@broadcast"
        if (msg.key && msg.key.remoteJid === 'status@broadcast') {
            const participant = msg.key.participant;
            const messageId = msg.key.id;

            // 1. Mark status as read/viewed automatically
            await sock.readMessages([
                {
                    remoteJid: 'status@broadcast',
                    id: messageId,
                    participant: participant
                }
            ]);

            console.log(`👁️ [AUTO-STATUS VIEWED]: Read status from ${participant?.split('@')[0] || 'Unknown'}`);

            // 2. Optional: Send an automatic heart reaction to all statuses
            // Uncomment the lines below if you want your bot to auto-react with a ❤️
            /*
            await sock.sendMessage('status@broadcast', {
                react: {
                    text: '❤️',
                    key: msg.key
                }
            }, { statusJidList: [participant] });
            */
        }
    } catch (err) {
        console.error("Auto Status Error:", err);
    }
}

/**
 * Simulates human typing or recording presence in a chat.
 * @param {Object} sock - The active Baileys socket instance
 * @param {string} jid - The target chat JID (e.g. phone@s.whatsapp.net)
 * @param {string} type - 'composing' (typing) or 'recording' (audio)
 * @param {number} durationMs - How long to show presence before clearing (default 3000ms)
 */
async function simulateGhostPresence(sock, jid, type = 'composing', durationMs = 3000) {
    try {
        await sock.presenceSubscribe(jid);
        await sock.sendPresenceUpdate(type, jid);

        await new Promise(resolve => setTimeout(resolve, durationMs));

        await sock.sendPresenceUpdate('paused', jid);
    } catch (err) {
        console.error("Ghost Presence Error:", err);
    }
}

module.exports = { handleAutoStatus, simulateGhostPresence };