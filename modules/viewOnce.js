const { getSettings } = require('./settings');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');

if (!global.viewOnceCache) global.viewOnceCache = new Map();

const mediaVaultDir = path.join(__dirname, '../public/vault_media');
if (!fs.existsSync(mediaVaultDir)) {
    fs.mkdirSync(mediaVaultDir, { recursive: true });
}

function cleanSenderId(jidOrParticipant) {
    if (!jidOrParticipant) return "Unknown";
    return jidOrParticipant.split('@')[0].split(':')[0];
}

// Deep search helper to find imageMessage or videoMessage inside nested wrappers
function extractMediaObject(obj) {
    if (!obj || typeof obj !== 'object') return null;
    if (obj.imageMessage) return { type: 'imageMessage', media: obj.imageMessage };
    if (obj.videoMessage) return { type: 'videoMessage', media: obj.videoMessage };

    for (const key of Object.keys(obj)) {
        if (typeof obj[key] === 'object' && obj[key] !== null) {
            const found = extractMediaObject(obj[key]);
            if (found) return found;
        }
    }
    return null;
}

// Clean helper to extract text and quoted context from any message wrapper structure
function parseMessageContent(msgObj) {
    if (!msgObj) return { text: "", quotedId: null };

    let current = msgObj;
    let text = "";
    let quotedId = null;

    while (current) {
        if (current.conversation) {
            text = current.conversation;
            break;
        }
        if (current.extendedTextMessage) {
            text = current.extendedTextMessage.text || "";
            quotedId = current.extendedTextMessage.contextInfo?.stanzaId || null;
            break;
        }
        if (current.imageMessage?.caption) {
            text = current.imageMessage.caption;
            quotedId = current.imageMessage.contextInfo?.stanzaId || null;
            break;
        }
        if (current.videoMessage?.caption) {
            text = current.videoMessage.caption;
            quotedId = current.videoMessage.contextInfo?.stanzaId || null;
            break;
        }
        if (current.ephemeralMessage?.message) {
            current = current.ephemeralMessage.message;
            continue;
        }
        if (current.viewOnceMessage?.message) {
            current = current.viewOnceMessage.message;
            continue;
        }
        if (current.viewOnceMessageV2?.message) {
            current = current.viewOnceMessageV2.message;
            continue;
        }
        break;
    }

    return { text: text.trim(), quotedId };
}

async function handleViewOnce(sock, msg) {
    if (!getSettings().viewOnce) return;
    if (!msg || !msg.message) return;

    const messageId = msg.key.id;
    const mediaResult = extractMediaObject(msg.message);
    const { text, quotedId } = parseMessageContent(msg.message);

    // 1. If incoming message is View-Once media, store it in cache
    const isViewOnceFlag = JSON.stringify(msg.message).includes('viewOnce');
    if (mediaResult && isViewOnceFlag) {
        global.viewOnceCache.set(messageId, {
            rawMessage: msg,
            mediaMessage: mediaResult.media,
            type: mediaResult.type
        });
        console.log(`📸 [VIEW-ONCE STORED]: ID ${messageId} | Type: ${mediaResult.type} | Active Cache: ${global.viewOnceCache.size}`);
        return;
    }

    // 2. If user typed ".vv", check cache using quoted stanza ID
    if (text === '.vv') {
        console.log(`🔍 [.VV COMMAND]: Quoted ID requested -> ${quotedId}`);
        console.log(`📦 [CACHE POOL]: Available keys ->`, Array.from(global.viewOnceCache.keys()));

        if (quotedId && global.viewOnceCache.has(quotedId)) {
            const cached = global.viewOnceCache.get(quotedId);

            try {
                const reconstructedMsg = {
                    key: cached.rawMessage.key,
                    message: {
                        [cached.type]: cached.mediaMessage
                    }
                };

                const buffer = await downloadMediaMessage(
                    reconstructedMsg,
                    'buffer',
                    {},
                    { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
                );

                const remoteJid = msg.key.remoteJid;
                const senderPhone = cleanSenderId(cached.rawMessage.key.participant || cached.rawMessage.key.remoteJid);
                const caption = cached.mediaMessage.caption || "";

                console.log(`🔓 [.VV SUCCESS]: Decrypted & delivered media from ${senderPhone}`);

                await sock.sendMessage(remoteJid, {
                    [cached.type === 'imageMessage' ? 'image' : 'video']: buffer,
                    caption: `🔓 *View-Once Decrypted*\n👤 From: ${senderPhone}\n${caption ? `📝 ${caption}` : ''}`
                }, { quoted: msg });

            } catch (err) {
                console.error("❌ [.VV DECRYPT ERROR]:", err.message);
                await sock.sendMessage(msg.key.remoteJid, { text: `❌ Decryption failed: ${err.message}` }, { quoted: msg });
            }
        } else {
            await sock.sendMessage(msg.key.remoteJid, { text: "⚠️ Target view-once message not found in cache. Reply directly to the view-once media with `.vv`." }, { quoted: msg });
        }
    }
}

module.exports = { handleViewOnce };