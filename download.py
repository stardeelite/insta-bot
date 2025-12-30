import sys, json, subprocess, datetime, os

url = sys.argv[1]
vid_id = sys.argv[2]

VID_FOLDER = "vids"
BUFFER_FILE = "tempbuff.json"
ID_FILE = "id.txt"
os.makedirs(VID_FOLDER, exist_ok=True)

# Ensure buffer.json exists and is valid
if not os.path.isfile(BUFFER_FILE) or os.path.getsize(BUFFER_FILE) == 0:
    with open(BUFFER_FILE, "w") as f:
        f.write("[]")

# Download metadata
meta = subprocess.check_output(
    ["yt-dlp", "--dump-single-json", url],
    text=True
)
data = json.loads(meta)

# Download video
output_file = os.path.join(VID_FOLDER, f"{vid_id}.%(ext)s")
subprocess.run([
    "yt-dlp",
    "-f", "bestvideo+bestaudio/best",
    "--merge-output-format", "mp4",
    "-o", output_file,
    url
], check=True)

# Ask for manual comments
def ask(n):
    v = input(f"comment{n} (∆ to skip): ").strip()
    return None if v in ("", "∆") else v

# Prepare entry
upload_date = data.get("upload_date")
entry = {
    "id": vid_id,
    "caption": data.get("description"),
    "comments": [c for c in (ask(1), ask(2)) if c],
    "like_count": data.get("like_count"),
    "comment_count": data.get("comment_count"),
    "upload_date": (
        f"{upload_date[:4]}-{upload_date[4:6]}-{upload_date[6:]}"
        if upload_date else None
    ),
    "scraped_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
}

# Load buffer safely
with open(BUFFER_FILE, "r") as f:
    try:
        buf = json.load(f)
    except json.JSONDecodeError:
        buf = []

# Append new entry and save
buf.append(entry)
with open(BUFFER_FILE, "w") as f:
    json.dump(buf, f, indent=2, ensure_ascii=False)

# Update id.txt with last used ID
last_id = buf[-1]["id"] if buf else vid_id
with open(ID_FILE, "w") as f:
    f.write(str(last_id))

print(f"Video {vid_id} downloaded and buffer updated.")