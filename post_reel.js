const https = require('https');
const querystring = require('querystring');

const PHP_ENDPOINT = process.env.PHP_ENDPOINT || "https://eaglehoster1.serv00.net/filee/file_manager.php";
const TOKEN = process.env.INSTA_TOKEN;

function log(stage, msg, data = null) {
    console.log(`\n[${new Date().toISOString()}] [${stage}] ${msg}`);
    if (data !== null) {
        console.dir(data, { depth: null });
    }
}

function phpPost(params, fileContent) {
    return new Promise((resolve, reject) => {

        const boundary = '----NodeFormBoundary' + Math.random().toString(16);
        let body = '';

        for (const k in params) {
            body += `--${boundary}\r\n`;
            body += `Content-Disposition: form-data; name="${k}"\r\n\r\n`;
            body += `${params[k]}\r\n`;
        }

        if (fileContent !== undefined) {
            body += `--${boundary}\r\n`;
            body += `Content-Disposition: form-data; name="file"; filename="data.json"\r\n`;
            body += `Content-Type: application/json\r\n\r\n`;
            body += fileContent + `\r\n`;
        }

        body += `--${boundary}--\r\n`;

        const url = new URL(PHP_ENDPOINT);

        const req = https.request({
            method: 'POST',
            hostname: url.hostname,
            path: url.pathname,
            headers: {
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
                'Content-Length': Buffer.byteLength(body)
            }
        }, res => {
            let out = '';
            res.on('data', c => out += c);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(out));
                } catch {
                    reject(new Error("Invalid JSON from PHP: " + out));
                }
            });
        });

        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

async function ensureHistoryFileExists() {
    log("HISTORY_CHECK", "Checking if history.json exists");

    let history;
    try {
        history = await phpPost({ action: 'download', path: 'history.json' });
    } catch {
        history = null;
    }

    if (!Array.isArray(history)) {
        log("HISTORY_CREATE", "history.json missing → creating empty file");

        await phpPost(
            { action: 'upload', path: 'history.json' },
            JSON.stringify([])
        );

        const verify = await phpPost({ action: 'download', path: 'history.json' });

        if (!Array.isArray(verify)) {
            throw new Error("FAILED to create history.json");
        }

        log("HISTORY_CREATED", "history.json successfully created");
    } else {
        log("HISTORY_EXISTS", "history.json already exists");
    }
}

async function run() {
    try {
        log("START", "Workflow started");

        /* ===== BUFFER ===== */
        const buffer = await phpPost({ action: 'download', path: 'buffer.json' });
        if (!Array.isArray(buffer) || buffer.length === 0) {
            log("BUFFER_EMPTY", "Nothing to post");
            return;
        }

        const target = buffer[0];
        log("TARGET", "Selected buffer item", target);

        const videoUrl = `https://eaglehoster1.serv00.net/filee/uploads/vids/${target.id}.mp4`;

        /* ===== CREATE CONTAINER ===== */
        const container = await (await fetch(
            "https://graph.instagram.com/v24.0/me/media",
            {
                method: 'POST',
                body: new URLSearchParams({
                    media_type: 'REELS',
                    video_url: videoUrl,
                    caption: target.caption,
                    access_token: TOKEN
                })
            }
        )).json();

        if (!container.id) throw new Error("Container creation failed");

        await new Promise(r => setTimeout(r, 60000));

        /* ===== POLL ===== */
        let ready = false;
        for (let i = 0; i < 15; i++) {
            const s = await (await fetch(
                `https://graph.instagram.com/v24.0/${container.id}?fields=status_code&access_token=${TOKEN}`
            )).json();
           
            if (s.status_code === "FINISHED") {
                ready = true;
                break;
            }
            log("Retrying", "poll " + i);
            await new Promise(r => setTimeout(r, 30000));
        }

        if (!ready) throw new Error("Processing timeout");
       log("Next", "Publishing");
        /* ===== PUBLISH ===== */
        const publish = await (await fetch(
            "https://graph.instagram.com/v24.0/me/media_publish",
            {
                method: 'POST',
                body: new URLSearchParams({
                    creation_id: container.id,
                    access_token: TOKEN
                })
            }
        )).json();

        if (!publish.id) throw new Error("Publish failed");

        /* ===== COMMENTS ===== */
        if (Array.isArray(target.comments)) {
            for (const c of target.comments) {
                await fetch(
                    `https://graph.instagram.com/v24.0/${publish.id}/comments`,
                    {
                        method: 'POST',
                        body: new URLSearchParams({
                            message: c,
                            access_token: TOKEN
                        })
                    }
                );
            }
        }

        /* ===== UPDATE BUFFER ===== */
        buffer.shift();
        await phpPost(
            { action: 'upload', path: 'buffer.json' },
            JSON.stringify(buffer)
        );

        /* ===== ENSURE + UPDATE HISTORY ===== */
        await ensureHistoryFileExists();

        const history = await phpPost({ action: 'download', path: 'history.json' });
        history.push({
            ...target,
            postTime: new Date().toISOString(),
            ig_post_id: publish.id,
            status: "success"
        });

        await phpPost(
            { action: 'upload', path: 'history.json' },
            JSON.stringify(history)
        );

        /* ===== DELETE VIDEO ===== */
        await phpPost({
            action: 'delete',
            path: `vids/${target.id}.mp4`
        });

        log("DONE", "Everything completed successfully");

    } catch (err) {
        log("FATAL", err.message, err);
        process.exit(1);
    }
}

run();
