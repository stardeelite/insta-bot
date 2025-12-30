const fs = require('fs').promises;

async function run() {
  try {
    // 1. Load the Queue
    const bufferData = await fs.readFile('./buffer.json', 'utf8');
    let buffer = JSON.parse(bufferData);
    if (buffer.length === 0) return console.log("Buffer is empty.");

    // 2. Identify Video & Path (Automatic Detection)
    const target = buffer[0]; 
    const token = process.env.INSTA_TOKEN;
    const repo = process.env.GITHUB_REPOSITORY; // Automatically gets "username/reponame"
    
    // This creates the public link Instagram needs to download your video
    const videoUrl = `https://raw.githubusercontent.com/${repo}/main/vids/${target.id}.mp4`;

    console.log(`🚀 Posting: ${target.id}`);

    // 3. Step 1: Create the Container (Updated to graph.instagram.com v24.0)
    const containerResp = await fetch(`https://graph.instagram.com/v24.0/me/media`, {
      method: 'POST',
      body: new URLSearchParams({
        media_type: 'REELS',
        video_url: videoUrl,
        caption: target.caption,
        access_token: token
      })
    });
    const container = await containerResp.json();
    if (!container.id) throw new Error(`Container Fail: ${JSON.stringify(container)}`);

    // 4. Step 2: Poll for status_code (Updated field for 2025)
    let isReady = false;
    for (let i = 0; i < 15; i++) {
      const statusResp = await fetch(`https://graph.instagram.com/v24.0/${container.id}?fields=status_code&access_token=${token}`);
      const statusData = await statusResp.json();
      if (statusData.status_code === 'FINISHED') { isReady = true; break; }
      await new Promise(r => setTimeout(r, 20000)); // Wait 20s
    }
    if (!isReady) throw new Error("Video processing timed out.");

    // 5. Step 3: Publish the Reel (Updated to graph.instagram.com v24.0)
    const publishResp = await fetch(`https://graph.instagram.com/v24.0/me/media_publish`, {
      method: 'POST',
      body: new URLSearchParams({ creation_id: container.id, access_token: token })
    });
    const publish = await publishResp.json();
    if (!publish.id) throw new Error(`Publish Fail: ${JSON.stringify(publish)}`);
    
    console.log(`✅ Reel Live: ${publish.id}`);

    // 6. Step 4: Post Comments (Updated to graph.instagram.com v24.0)
    if (target.comments && Array.isArray(target.comments)) {
      for (const comment of target.comments) {
        await fetch(`https://graph.instagram.com/v24.0/${publish.id}/comments`, {
          method: 'POST',
          body: new URLSearchParams({ message: comment, access_token: token })
        });
      }
    }

    // 7. Data Move: Buffer -> History
    buffer.shift();
    await fs.writeFile('./buffer.json', JSON.stringify(buffer, null, 2));

    let history = [];
    try { history = JSON.parse(await fs.readFile('./history.json', 'utf8')); } catch (e) {}
    history.push({ ...target, postTime: new Date().toISOString(), status: "success" });
    await fs.writeFile('./history.json', JSON.stringify(history, null, 2));

    // 8. Delete Video File
    await fs.unlink(`./vids/${target.id}.mp4`);

  } catch (error) {
    console.error("❌ Error:", error.message);
    process.exit(1);
  }
}
run();

