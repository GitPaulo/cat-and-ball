#!/usr/bin/env bash
set -euo pipefail

mkdir -p frames_compressed

for file in frames/*.txt; do
    name="${file##*/}"
    base="${name%.txt}"
    svg="frames_compressed/${base}.svg"

    echo -n "<svg xmlns='http://www.w3.org/2000/svg' width='480' height='80'>" >"$svg"
    echo -n "<rect width='100%' height='100%' fill='#212830'/>" >>"$svg"
    echo -n "<metadata>${base}</metadata>" >>"$svg"
    echo -n "<text font-family='Courier New, monospace' font-size='14' fill='white' xml:space='preserve'>" >>"$svg"

    lineno=0
    while IFS= read -r line; do
        if [ "$lineno" -eq 0 ]; then
            echo -n "<tspan x='10' dy='0'>${line}</tspan>" >>"$svg"
        else
            echo -n "<tspan x='10' dy='16'>${line}</tspan>" >>"$svg"
        fi
        lineno=$((lineno + 1))
    done <"$file"

    echo "</text></svg>" >>"$svg"

    gzip -9 -c "$svg" >"${svg}.gz"
done

echo "✅ Frames precompressed in frames_compressed/"
