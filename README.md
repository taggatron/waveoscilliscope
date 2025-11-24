# Wave Guitar Lab

Interactive browser-based guitar fretboard with bend/slide and a live oscilloscope sourced from both the synth guitar and your microphone.

## Features

- Tap notes on a 6-string, 16-fret virtual fretboard
- Bend by dragging vertically, slide by dragging horizontally
- Electric-style tone using Web Audio (saw + waveshaper distortion)
- Animated color glow around active notes (Guitar Hero style)
- Live oscilloscope using `getUserMedia` (mic) and Web Audio analyser
- Mobile-first, touch-friendly layout and controls

## Running locally

Use any static file server from this folder. For example, with Python:

```bash
cd .
python3 -m http.server 8000
```

Then open `http://localhost:8000` in a modern browser (Chrome, Edge, or Safari). You will be prompted for microphone access when enabling the mic.

## Notes

- Audio and mic input require user interaction and a secure context (https or `localhost`).
- Browser audio behavior can vary across devices; if you get no sound, try tapping the fretboard once after page load to unlock audio on mobile.
