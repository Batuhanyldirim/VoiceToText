#!/usr/bin/env bash
# Generate a synthetic 2-speaker conversation for smoke-testing.
# Uses two distinct native macOS voices (Samantha + Daniel) so diarization has
# two genuinely different speakers to separate.
# Result: samples/conversation.wav (16 kHz mono).
#
# To test another language, just swap the lines below and pass --language <code>
# to transcribe.py (or leave it on auto-detect).
set -euo pipefail
PROJECT_ROOT="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
SAMPLES="$PROJECT_ROOT/samples"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

VOICE_A="Samantha"   # en_US female
VOICE_B="Daniel"     # en_GB male

# Lines alternate between speaker A and speaker B.
A=(
  "Hello, and welcome to the meeting. Today we will discuss the new project."
  "I agree. So what do you think about the budget?"
  "Great, then we can start next week. Thank you very much."
)
B=(
  "Thank you. I am really looking forward to getting started."
  "I think the budget is sufficient, but we should clarify the timeline a bit more."
  "Thank you as well. See you later, and have a good day."
)

segfiles=()
for i in "${!A[@]}"; do
  aiff_a="$TMP/a_$i.aiff"; wav_a="$TMP/a_$i.wav"
  say -v "$VOICE_A" -r 180 -o "$aiff_a" "${A[$i]}"
  ffmpeg -y -loglevel error -i "$aiff_a" -ar 16000 -ac 1 "$wav_a"
  segfiles+=("$wav_a")

  aiff_b="$TMP/b_$i.aiff"; wav_b="$TMP/b_$i.wav"
  say -v "$VOICE_B" -r 180 -o "$aiff_b" "${B[$i]}"
  ffmpeg -y -loglevel error -i "$aiff_b" -ar 16000 -ac 1 "$wav_b"
  segfiles+=("$wav_b")
done

# Concatenate all segments with 0.4s silence between turns
silence="$TMP/sil.wav"
ffmpeg -y -loglevel error -f lavfi -i anullsrc=r=16000:cl=mono -t 0.4 "$silence"

concat_list="$TMP/list.txt"
: > "$concat_list"
for f in "${segfiles[@]}"; do
  echo "file '$f'" >> "$concat_list"
  echo "file '$silence'" >> "$concat_list"
done

mkdir -p "$SAMPLES"
ffmpeg -y -loglevel error -f concat -safe 0 -i "$concat_list" -ar 16000 -ac 1 "$SAMPLES/conversation.wav"
echo "Wrote $SAMPLES/conversation.wav"
ffmpeg -hide_banner -i "$SAMPLES/conversation.wav" 2>&1 | grep -E "Duration|Stream" || true
