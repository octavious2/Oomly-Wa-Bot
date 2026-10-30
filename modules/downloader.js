/**
 * Oomly Technologies - Cobalt API Cloud Media Downloader Engine
 */

const fs = require('fs');
const path = require('path');
const pino = require('pino');

const logger = pino({ level: 'info' });
const TEMP_DIR = path.join(__dirname, '../temp');

if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

async function handleMediaDownloader(sock, msg) {
    if (!msg || !msg.message) return;

    const text = msg.message.conversation || 
                 msg.message.extendedTextMessage?.text || 
                 msg.message.imageMessage?.caption || "";

    if (!text) return;

    console.log(`🔍 [DOWNLOADER INSPECT]: Received text -> "${text}"`);

    const remoteJid = msg.key.remoteJid;
    
    // Extract target URL using Regex
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const match = text.match(urlRegex);

    if (!match) return;
    const targetUrl = match[0];

    const isYouTube = targetUrl.includes('youtube.com') || targetUrl.includes('youtu.be');
    const isSpotify = targetUrl.includes('spotify.com');
    const isInstagram = targetUrl.includes('instagram.com');
    const isTikTok = targetUrl.includes('tiktok.com');
    const isFacebook = targetUrl.includes('facebook.com') || targetUrl.includes('fb.watch');

    if (!isYouTube && !isSpotify && !isInstagram && !isTikTok && !isFacebook) return;

    console.log(`🎯 [DOWNLOADER TARGET]: Resolved URL -> ${targetUrl}`);

    const isAudio = text.startsWith('.yta') || text.startsWith('.song') || isSpotify;

    try {
        await sock.sendMessage(remoteJid, { text: "⏳ *Oomly Engine:* Fetching media via Cobalt API..." }, { quoted: msg });

        // Query Cobalt API for direct media stream URL
        const response = await fetch('https://api.cobalt.tools/', {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                url: targetUrl,
                isAudioOnly: isAudio,
                aFormat: isAudio ? 'mp3' : undefined
            })
        });

        const data = await response.json();
        console.log("📦 [COBALT RESPONSE]:", JSON.stringify(data));

        if (data.status === 'error' || (!data.url && !data.picker)) {
            throw new Error(data.text || "Failed to retrieve media link from downloader service.");
        }

        const mediaUrl = data.url || (data.picker && data.picker[0] && data.picker[0].url);

        if (!mediaUrl) {
            throw new Error("No direct media stream returned from API.");
        }

        console.log(`✅ [MEDIA STREAM URL]: Resolved successfully.`);

        if (isAudio) {
            await sock.sendMessage(remoteJid, {
                audio: { url: mediaUrl },
                mimetype: 'audio/mp4',
                ptt: false
            }, { quoted: msg });
        } else {
            await sock.sendMessage(remoteJid, {
                video: { url: mediaUrl },
                caption: "🎬 *Downloaded via Oomly Media Engine*"
            }, { quoted: msg });
        }

    } catch (err) {
        console.error("❌ [DOWNLOADER EXCEPTION]:", err.message);
        await sock.sendMessage(remoteJid, { text: `❌ *Download Failed:* ${err.message}` }, { quoted: msg });
    }
}

module.exports = { handleMediaDownloader };