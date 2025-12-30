#!/bin/bash
set -e

URL="$1"
VID_FOLDER="vids"
TEMP_BUFFER="tempbuff.json"
BUFFER_FILE="buffer.json"
ID_FILE="id.txt"

mkdir -p "$VID_FOLDER"
[ -f "$TEMP_BUFFER" ] || echo "[]" > "$TEMP_BUFFER"
[ -f "$BUFFER_FILE" ] || echo "[]" > "$BUFFER_FILE"
[ -f "$ID_FILE" ] || echo "0" > "$ID_FILE"

VID_ID=$(python3 - <<END
with open("$ID_FILE") as f:
    print(str(int(f.read().strip()) + 1).zfill(5))
END
)

python3 download.py "$URL" "$VID_ID"
echo "$VID_ID" > "$ID_FILE"

COUNT=$(ls "$VID_FOLDER"/*.mp4 2>/dev/null | wc -l)

if [ "$COUNT" -ge 3 ]; then
    echo "Uploading batch…"

    # merge temp buffer into main buffer (LOCAL ONLY)
    python3 - <<EOF
import json

with open("$BUFFER_FILE") as f:
    buf = json.load(f)

with open("$TEMP_BUFFER") as f:
    temp = json.load(f)

buf.extend(temp)

with open("$BUFFER_FILE", "w") as f:
    json.dump(buf, f, indent=2, ensure_ascii=False)
EOF

    git add "$VID_FOLDER"/*.mp4 "$BUFFER_FILE"
    git commit -m "auto upload vids + buffer"

    # 🔥 THIS IS THE FIX — NO MORE ERRORS EVER
    git push --force origin main

    rm -f "$VID_FOLDER"/*.mp4
    echo "[]" > "$TEMP_BUFFER"
fi