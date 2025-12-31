const https = require('https');
const querystring = require('querystring');

const PHP_ENDPOINT = process.env.PHP_ENDPOINT || "https://eaglehoster1.serv00.net/filee/file_manager.php";
const TOKEN = process.env.INSTA_TOKEN;

// Helper to communicate with PHP file manager
function phpPost(params, fileBuffer) {
    return new Promise((resolve, reject) => {
        const postData = fileBuffer
            ? querystring.stringify(params) + '&file=' + encodeURIComponent(fileBuffer)
            : querystring.stringify(params);

        const url = new URL(PHP_ENDPOINT);
        const options = {
            method: 'POST',
            hostname: url.hostname,
            path: url.pathname,
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(postData),
            },
        };

        const req = https.request(options, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(e);
                }
            });
        });

        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

// Wait for webhook trigger
async function waitForWebhook() {
    console.log("⏳ Waiting for webhook trigger...");
    while (true) {
        // Check for a "webhook_buffer.json" flag set by your website
        const webhookResp = await phpPost({ action: 'download', path: 'webhook_buffer.json' });
        const webhookData = webhookResp && webhookResp.triggered;
        if (webhookData) break;

        // Wait 5 seconds before checking again
        await new Promise(r => setTimeout(r, 5000));
    }
    console.log("⚡ Webhook triggered, continuing posting flow...");
}

async function run() {
    try {
        // 1. Wait for Instagram webhook trigger via your website
        await waitForWebhook();

        // 2. Load the Queue from server
        let bufferResp = await phpPost({ action: 'download', path: 'buffer.json' });
        let buffer = Array.isArray(bufferResp) ? bufferResp : [];
        if (buffer.length === 0) return console.log("Buffer is empty.");

        const target = buffer[0]; // first video
        const videoUrl = `https://eaglehoster1.serv00.net/filee/uploads/vids/${target.id}.mp4`;

        console.log(`🚀 Posting video: ${target.id}`);

        // 3. Create Instagram container
        const containerResp = await fetch(`https://graph.instagram.com/v24.0/me/media`, {
            method: 'POST',
            body: new URLSearchParams({
                media_type: 'REELS',
                video_url: videoUrl,
                caption: target.caption,
                access_token: TOKEN
            })
        });
        const container = await containerResp.json();
        if (!container.id) throw new Error(`Container Fail: ${JSON.stringify(container)}`);

        // 4. Poll status_code (optional, keep short since webhook ensures ready)
        const statusResp = await fetch(`https://graph.instagram.com/v24.0/${container.id}?fields=status_code&access_token=${TOKEN}`);
        const statusData = await statusResp.json();
        if (statusData.status_code !== 'FINISHED') throw new Error("Video processing not finished.");

        // 5. Publish Reel
        const publishResp = await fetch(`https://graph.instagram.com/v24.0/me/media_publish`, {
            method: 'POST',
            body: new URLSearchParams({ creation_id: container.id, access_token: TOKEN })
        });
        const publish = await publishResp.json();
        if (!publish.id) throw new Error(`Publish Fail: ${JSON.stringify(publish)}`);
        console.log(`✅ Reel Live: ${publish.id}`);

        // 6. Post Comments
        if (Array.isArray(target.comments)) {
            for (const comment of target.comments) {
                await fetch(`https://graph.instagram.com/v24.0/${publish.id}/comments`, {
                    method: 'POST',
                    body: new URLSearchParams({ message: comment, access_token: TOKEN })
                });
            }
        }

        // 7. Update buffer.json on server
        buffer.shift(); // remove posted video
        await phpPost({ action: 'upload', path: 'buffer.json' }, JSON.stringify(buffer));

        // 8. Update history.json on server
        let historyResp = await phpPost({ action: 'download', path: 'history.json' });
        let history = Array.isArray(historyResp) ? historyResp : [];
        history.push({ ...target, postTime: new Date().toISOString(), status: "success" });
        await phpPost({ action: 'upload', path: 'history.json' }, JSON.stringify(history));

        // 9. Delete video file on server
        await phpPost({ action: 'delete', path: `vids/${target.id}.mp4` });

        console.log("🎯 Posting complete, buffer, history updated, video deleted from server.");

    } catch (error) {
        console.error("❌ Error:", error.message);
        process.exit(1);
    }
}

run();
