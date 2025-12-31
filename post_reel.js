
const https = require('https');
const querystring = require('querystring');

const PHP_ENDPOINT = process.env.PHP_ENDPOINT || "https://eaglehoster1.serv00.net/filee/file_manager.php";
const TOKEN = process.env.INSTA_TOKEN;

/* =========================
   DEBUG LOGGER
========================= */
function log(stage, msg, obj = null) {
    const time = new Date().toISOString();
    console.log(`\n[${time}] [${stage}]`);
    console.log(msg);
    if (obj !== null) {
        console.log("DATA >>>");
        console.dir(obj, { depth: null });
    }
}

/* =========================
   PHP POST HELPER
========================= */
function phpPost(params, fileBuffer) {
    return new Promise((resolve, reject) => {
        const postData = fileBuffer
            ? querystring.stringify(params) + '&file=' + encodeURIComponent(fileBuffer)
            : querystring.stringify(params);

        const url = new URL(PHP_ENDPOINT);

        log("PHP_POST_INIT", "Preparing PHP POST request", {
            endpoint: PHP_ENDPOINT,
            params,
            hasFile: !!fileBuffer,
            payloadSize: Buffer.byteLength(postData)
        });

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
            log("PHP_POST_RESPONSE", "PHP responded", {
                statusCode: res.statusCode,
                headers: res.headers
            });

            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                log("PHP_POST_RAW_BODY", "Raw response body", data);
                try {
                    const parsed = JSON.parse(data);
                    resolve(parsed);
                } catch (e) {
                    log("PHP_POST_PARSE_FAIL", "Failed to parse JSON", data);
                    reject(e);
                }
            });
        });

        req.on('error', err => {
            log("PHP_POST_ERROR", "Request error", err);
            reject(err);
        });

        req.write(postData);
        req.end();
    });
}

/* =========================
   MAIN WORKFLOW
========================= */
async function run() {
    try {
        log("START", "Workflow started");

        /* ---------- LOAD BUFFER ---------- */
        log("BUFFER_LOAD", "Downloading buffer.json");
        const bufferResp = await phpPost({ action: 'download', path: 'buffer.json' });
        log("BUFFER_RAW", "Buffer downloaded", bufferResp);

        if (!Array.isArray(bufferResp)) {
            throw new Error("buffer.json is not an array");
        }

        if (bufferResp.length === 0) {
            log("BUFFER_EMPTY", "No videos in buffer. Exiting.");
            return;
        }

        const buffer = bufferResp;
        const target = buffer[0];

        log("TARGET_SELECTED", "Oldest buffer entry selected", target);

        const videoUrl = `https://eaglehoster1.serv00.net/filee/uploads/vids/${target.id}.mp4`;
        log("VIDEO_URL", "Resolved video URL", videoUrl);

        /* ---------- CREATE CONTAINER ---------- */
        log("IG_CONTAINER_CREATE", "Creating Instagram media container");
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
        log("IG_CONTAINER_RESPONSE", "Container creation response", container);

        if (!container.id) {
            throw new Error("Instagram container creation failed");
        }

        /* ---------- WAIT BEFORE POLLING ---------- */
        log("IG_WAIT", "Waiting 30s before polling status");
        await new Promise(r => setTimeout(r, 30000));

        /* ---------- POLL STATUS ---------- */
        let isReady = false;

        for (let i = 1; i <= 15; i++) {
            log("IG_STATUS_POLL", `Polling attempt ${i}`);
            const statusResp = await fetch(
                `https://graph.instagram.com/v24.0/${container.id}?fields=status_code&access_token=${TOKEN}`
            );
            const statusData = await statusResp.json();

            log("IG_STATUS_RESPONSE", "Status response", statusData);

            if (statusData.status_code === 'FINISHED') {
                isReady = true;
                break;
            }

            await new Promise(r => setTimeout(r, 15000));
        }

        if (!isReady) {
            throw new Error("Instagram video processing timed out");
        }

        /* ---------- PUBLISH ---------- */
        log("IG_PUBLISH", "Publishing reel");
        const publishResp = await fetch(`https://graph.instagram.com/v24.0/me/media_publish`, {
            method: 'POST',
            body: new URLSearchParams({
                creation_id: container.id,
                access_token: TOKEN
            })
        });

        const publish = await publishResp.json();
        log("IG_PUBLISH_RESPONSE", "Publish response", publish);

        if (!publish.id) {
            throw new Error("Instagram publish failed");
        }

        /* ---------- COMMENTS ---------- */
        if (Array.isArray(target.comments)) {
            for (const comment of target.comments) {
                log("IG_COMMENT", "Posting comment", comment);
                await fetch(`https://graph.instagram.com/v24.0/${publish.id}/comments`, {
                    method: 'POST',
                    body: new URLSearchParams({
                        message: comment,
                        access_token: TOKEN
                    })
                });
            }
        }

        /* ---------- UPDATE BUFFER ---------- */
        log("BUFFER_UPDATE", "Removing oldest entry from buffer");
        buffer.shift();

        log("BUFFER_UPLOAD", "Uploading updated buffer.json", buffer);
        const uploadResp = await phpPost(
            { action: 'upload', path: 'buffer.json' },
            JSON.stringify(buffer)
        );
        log("BUFFER_UPLOAD_RESPONSE", "Upload response", uploadResp);

        /* ---------- VERIFY BUFFER ---------- */
        log("BUFFER_VERIFY", "Re-downloading buffer.json to verify");
        const verifyBuffer = await phpPost({ action: 'download', path: 'buffer.json' });
        log("BUFFER_VERIFY_RESULT", "Verified buffer content", verifyBuffer);

        if (!Array.isArray(verifyBuffer) || verifyBuffer.length !== buffer.length) {
            throw new Error("Buffer verification failed — NOT deleting video");
        }

        /* ---------- UPDATE HISTORY ---------- */
        log("HISTORY_LOAD", "Loading history.json");
        const historyResp = await phpPost({ action: 'download', path: 'history.json' });
        const history = Array.isArray(historyResp) ? historyResp : [];

        history.push({
            ...target,
            postTime: new Date().toISOString(),
            status: "success",
            ig_post_id: publish.id
        });

        log("HISTORY_UPLOAD", "Uploading updated history.json", history);
        await phpPost(
            { action: 'upload', path: 'history.json' },
            JSON.stringify(history)
        );

        /* ---------- DELETE VIDEO ---------- */
        log("VIDEO_DELETE", "Deleting video file from server", target.id);
        await phpPost({
            action: 'delete',
            path: `vids/${target.id}.mp4`
        });

        log("DONE", "Workflow completed successfully");

    } catch (err) {
        log("FATAL_ERROR", err.message, err);
        process.exit(1);
    }
}

run();
