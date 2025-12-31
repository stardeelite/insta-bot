const fetch = require('node-fetch');
const FormData = require('form-data');

const PHP_ENDPOINT = process.env.PHP_ENDPOINT || "https://eaglehoster1.serv00.net/filee/file_manager.php";
const TOKEN = process.env.INSTA_TOKEN;

async function run() {
    try {
        // 1. Download buffer.json from server
        const bufferResp = await fetch(PHP_ENDPOINT, {
            method: 'POST',
            body: new URLSearchParams({ action: 'download', path: 'buffer.json' })
        });
        let buffer = await bufferResp.json();
        if (!Array.isArray(buffer) || buffer.length === 0) return console.log("Buffer empty.");

        const target = buffer[0]; // first video in queue
        const videoUrl = `https://eaglehoster1.serv00.net/uploads/vids/${target.id}.mp4`;

        console.log(`🚀 Posting video: ${target.id}`);

        // 2. Create Instagram container
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
        if (!container.id) throw new Error("Container creation failed");

        // 3. Poll status_code
        let isReady = false;
        for (let i = 0; i < 15; i++) {
            const statusResp = await fetch(`https://graph.instagram.com/v24.0/${container.id}?fields=status_code&access_token=${TOKEN}`);
            const statusData = await statusResp.json();
            if (statusData.status_code === 'FINISHED') { isReady = true; break; }
            await new Promise(r => setTimeout(r, 20000));
        }
        if (!isReady) throw new Error("Video processing timed out.");

        // 4. Publish Reel
        const publishResp = await fetch(`https://graph.instagram.com/v24.0/me/media_publish`, {
            method: 'POST',
            body: new URLSearchParams({ creation_id: container.id, access_token: TOKEN })
        });
        const publish = await publishResp.json();
        if (!publish.id) throw new Error("Publish failed");

        console.log(`✅ Reel Live: ${publish.id}`);

        // 5. Post comments
        if (Array.isArray(target.comments)) {
            for (const comment of target.comments) {
                await fetch(`https://graph.instagram.com/v24.0/${publish.id}/comments`, {
                    method: 'POST',
                    body: new URLSearchParams({ message: comment, access_token: TOKEN })
                });
            }
        }

        // 6. Update buffer.json on server
        buffer.shift(); // remove posted video
        const bufferForm = new FormData();
        bufferForm.append('action', 'upload');
        bufferForm.append('path', 'buffer.json');
        bufferForm.append('file', Buffer.from(JSON.stringify(buffer, null, 2)), { filename: 'buffer.json' });

        await fetch(PHP_ENDPOINT, { method: 'POST', body: bufferForm });

        // 7. Update history.json on server
        let history = [];
        try {
            const historyResp = await fetch(PHP_ENDPOINT, {
                method: 'POST',
                body: new URLSearchParams({ action: 'download', path: 'history.json' })
            });
            history = await historyResp.json();
        } catch {}

        history.push({ ...target, postTime: new Date().toISOString(), status: "success" });

        const historyForm = new FormData();
        historyForm.append('action', 'upload');
        historyForm.append('path', 'history.json');
        historyForm.append('file', Buffer.from(JSON.stringify(history, null, 2)), { filename: 'history.json' });

        await fetch(PHP_ENDPOINT, { method: 'POST', body: historyForm });

        console.log("🎯 Posting complete, buffer and history updated on server.");

        // 8. Delete video from server
        const deleteForm = new FormData();
        deleteForm.append('action', 'delete');
        deleteForm.append('path', `vids/${target.id}.mp4`);

        const deleteResp = await fetch(PHP_ENDPOINT, { method: 'POST', body: deleteForm });
        const deleteResult = await deleteResp.json();

        if (deleteResult.status !== 'success') {
          console.warn(`⚠️ Failed to delete video ${target.id}: ${deleteResult.message}`);
        } else {
          console.log(`🗑️ Video ${target.id}.mp4 deleted from server.`);
        }

    } catch (err) {
        console.error("❌ Error:", err.message);
        process.exit(1);
    }
}

run();
