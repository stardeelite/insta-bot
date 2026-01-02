const https = require('https');
const querystring = require('querystring');

const PHP_ENDPOINT = process.env.PHP_ENDPOINT || "https://eaglehoster1.serv00.net/filee/file_manager.php";

/* ===== MULTI ACCOUNT TOKENS ===== */
const TOKENS = [
    process.env.INSTA_TOKEN,
    process.env.INSTA_TOKEN_BSCLIPZ,
    // add more tokens if needed
].filter(Boolean);

function log(stage, msg, data = null) {
    console.log(`\n[${new Date().toISOString()}] [${stage}] ${msg}`);
    if (data !== null) {
        console.dir(data, { depth: null });
    }
}

function formatIST(date = new Date()) {
    const istOffsetMs = 5.5 * 60 * 60 * 1000;
    const ist = new Date(date.getTime() + istOffsetMs);

    let dd = String(ist.getUTCDate()).padStart(2, '0');
    let mm = String(ist.getUTCMonth() + 1).padStart(2, '0');
    let yy = String(ist.getUTCFullYear()).slice(-2);

    let hh = ist.getUTCHours();
    const ampm = hh >= 12 ? 'pm' : 'am';
    hh = hh % 12 || 12;

    let min = String(ist.getUTCMinutes()).padStart(2, '0');
    let sec = String(ist.getUTCSeconds()).padStart(2, '0');

    return `${dd}/${mm}/${yy} - ${String(hh).padStart(2, '0')}:${min}:${sec} ${ampm}`;
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

        let successCount = 0;
        let publishedIds = [];

        for (let t = 0; t < TOKENS.length; t++) {
            const TOKEN = TOKENS[t];
            log("ACCOUNT", `Starting account ${t + 1}`);

            try {
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

                    log("Retrying", `poll ${i} (acc ${t + 1})`);
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

                successCount++;
                publishedIds.push(publish.id);

                log("ACCOUNT_SUCCESS", `Account ${t + 1} posted`, publish.id);

            } catch (e) {
                log("ACCOUNT_ERROR", `Account ${t + 1} failed`, e.message);
            }

            await new Promise(r => setTimeout(r, 120000));
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
            postTime: formatIST(),
            ig_post_ids: publishedIds,
            status: successCount > 0 ? "success" : "failed"
        });

        await phpPost(
            { action: 'upload', path: 'history.json' },
            JSON.stringify(history)
        );

        /* ===== DELETE VIDEO (CONDITIONAL) ===== */
        if (successCount > 0) {
            await phpPost({
                action: 'delete',
                path: `vids/${target.id}.mp4`
            });
            log("VIDEO", "Deleted after successful post(s)");
        } else {
            log("VIDEO", "Not deleted — no account succeeded");
        }

        log("DONE", "Workflow completed");

    } catch (err) {
        log("FATAL", err.message, err);
        process.exit(1);
    }
}

run();
