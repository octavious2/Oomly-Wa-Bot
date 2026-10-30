/**
 * Oomly Technologies - Universal Multi-Platform Media Engine
 * Supports: YouTube, Instagram, Facebook, TikTok, X, Spotify, SoundCloud, etc.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const pino = require('pino');

const logger = pino({ level: 'info' });
const TEMP_DIR = path.join(__dirname, '../temp');

if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

/**
 * Universal resolution fallback layer using cloud-resilient media APIs
 */
async function resolveUniversalMedia(targetUrl, requestedFormat) {
    const encoded = encodeURIComponent(targetUrl);
    
    // Primary universal API route (handles Insta Reels, FB, TikTok, YT, Twitter)
    try {
        const endpoint = requestedFormat === 'mp3' 
            ? `https://apis.davidcyriltech.my.id/download/audio?url=${encoded}`
            : `https://apis.davidcyriltech.my.id/download/video?url=${encoded}`;

        const res = await axios.get(endpoint, { timeout: 15000 });
        if (res.data && res.data.success && (res.data.result.download_url || res.data.result.url)) {
            return res.data.result.download_url || res.data.result.url;
        }
    } catch (e) {
        logger.warn(`Primary resolver skipped for ${targetUrl}, attempting secondary stream API...`);
    }

    // Secondary fallback route (handles Spotify, YT, social video clips)
    try {
        const altEndpoint = requestedFormat === 'mp3'
            ? `https://api.siputzx.my.id/api/d/ytmp3?url=${encoded}`
            : `https://api.siputzx.my.id/api/d/ytmp4?url=${encoded}`;

        const altRes = await axios.get(altEndpoint, { timeout: 15000 });
        if (altRes.data && (altRes.data.data?.dl || altRes.data.data?.download)) {
            return altRes.data.data.dl || altRes.data.data.download;
        }
    } catch (e) {
        logger.error(`Secondary resolver failed: ${e.message}`);
    }

    throw new Error("Unable to extract media stream from provided URL.");
}

async function handleMediaDownloader(sock, msg) {
    if (!msg || !msg.message) return;

    const text = msg.message.conversation || 
                 msg.message.extendedTextMessage?.text || 
                 msg.message.imageMessage?.caption || "";

    if (!text) return;

    const remoteJid = msg.key.remoteJid;
    
    // Command prefixes or raw link triggers
    const isExplicitAudio = text.startsWith('.song') || text.startsWith('.yta') || text.startsWith('.mp3');
    const isExplicitVideo = text.startsWith('.video') || text.startsWith('.ytv') || text.startsWith('.mp4');

    // Detect social links across major platforms
    const supportedDomainRegex = /(youtube\.com|youtu\.be|instagram\.com|facebook\.com|fb\.watch|tiktok\.com|twitter\.com|x\.com|spotify\.com|soundcloud\.com)/i;
    const hasMediaLink = supportedDomainRegex.test(text);

    if (!isExplicitAudio && !isExplicitVideo && !hasMediaLink) return;

    // Extract target URL from payload
    let targetUrl = text;
    if (text.includes(' ')) {
        const parts = text.split(' ');
        targetUrl = parts.find(p => p.startsWith('http://') || p.startsWith('https://')) || parts[1];
    }

    if (!targetUrl || !targetUrl.startsWith('http')) return;

    console.log(`🎯 [UNIVERSAL DOWNLOADER TARGET]: ${targetUrl}`);

    const timestamp = Date.now();
    // Default to MP3 for audio platforms, MP4 for video clips unless specified
    let isAudioOnly = isExplicitAudio || targetUrl.includes('spotify.com') || targetUrl.includes('soundcloud.com');
    let format = isAudioOnly ? 'mp3' : 'mp4';
    
    const outputPath = path.join(TEMP_DIR, `media_${timestamp}.${format}`);

    try {
        await sock.sendMessage(remoteJid, { text: "⏳ *Oomly Engine:* Extracting media from platform..." }, { quoted: msg });

        const directDownloadUrl = await resolveUniversalMedia(targetUrl, format);

        console.log(`📥 Streaming media to temporary buffer...`);
        const writer = fs.createWriteStream(outputPath);
        const streamResponse = await axios({
            url: directDownloadUrl,
            method: 'GET',
            responseType: 'stream'
        });

        streamResponse.data.pipe(writer);

        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        if (!fs.existsSync(outputPath)) {
            throw new Error("Failed to write stream to local disk buffer.");
        }

        if (format === 'mp3') {
            await sock.sendMessage(remoteJid, {
                audio: { url: outputPath },
                mimetype: 'audio/mp4',
                ptt: false
            }, { quoted: msg });
        } else {
            await sock.sendMessage(remoteJid, {
                video: { url: outputPath },
                caption: "🎬 *Downloaded via Oomly Universal Media Engine*"
            }, { quoted: msg });
        }

    } catch (err) {
        console.error("❌ [UNIVERSAL DOWNLOADER ERROR]:", err.message);
        await sock.sendMessage(remoteJid, { text: `❌ *Download Failed:* ${err.message}` }, { quoted: msg });
    } finally {
        if (fs.existsSync(outputPath)) {
            try { fs.unlinkSync(outputPath); } catch (e) {}
        }
    }
}

module.exports = { handleMediaDownloader };