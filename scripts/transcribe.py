#!/usr/bin/env python3
"""
Local transcription script using faster-whisper + optional whisperX diarization.

Outputs JSON to stdout matching the TranscriptionResponse shape expected by
the Node.js caller. Errors are reported as JSON on stdout with a non-zero exit.

Usage:
    python3 scripts/transcribe.py \
        --input /path/to/audio.wav \
        --model medium \
        --device auto \
        --language en \
        --compute-type auto
"""

import argparse
import json
import sys
import time
import traceback
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Transcribe audio with faster-whisper")
    parser.add_argument("--input", required=True, help="Path to audio file")
    parser.add_argument("--model", default="medium", help="Model size (tiny, base, small, medium, large-v3)")
    parser.add_argument("--device", default="auto", help="Device (cpu, cuda, auto)")
    parser.add_argument("--language", default="en", help="Language code")
    parser.add_argument("--compute-type", default="auto", help="Compute type (auto, int8, float16, float32)")
    return parser.parse_args()


def resolve_device(device: str) -> str:
    """Resolve 'auto' to the best available device."""
    if device != "auto":
        return device
    try:
        import torch
        return "cuda" if torch.cuda.is_available() else "cpu"
    except ImportError:
        return "cpu"


def resolve_compute_type(compute_type: str, device: str) -> str:
    """Resolve 'auto' to a sensible compute type for the device."""
    if compute_type != "auto":
        return compute_type
    return "float16" if device == "cuda" else "int8"


def run_diarization(audio_path: str, device: str):
    """
    Attempt speaker diarization via whisperX. Returns a segment-to-speaker
    mapping function, or None if whisperX isn't available.
    """
    try:
        import whisperx
    except ImportError:
        return None

    try:
        audio = whisperx.load_audio(audio_path)
        diarize_model = whisperx.DiarizationPipeline(device=device)
        diarize_segments = diarize_model(audio)
        return diarize_segments
    except Exception:
        # Diarization is best-effort; fall back to no speaker labels
        return None


def assign_speakers(segments, diarize_segments):
    """
    Assign speaker labels to transcription segments using whisperX
    diarization output.
    """
    if diarize_segments is None:
        return segments

    try:
        import whisperx
        result = whisperx.assign_word_speakers(diarize_segments, {"segments": segments})
        return result.get("segments", segments)
    except Exception:
        return segments


def transcribe(args: argparse.Namespace) -> dict:
    from faster_whisper import WhisperModel

    audio_path = args.input
    if not Path(audio_path).exists():
        raise FileNotFoundError(f"Audio file not found: {audio_path}")

    device = resolve_device(args.device)
    compute_type = resolve_compute_type(args.compute_type, device)

    model = WhisperModel(
        args.model,
        device=device,
        compute_type=compute_type,
    )

    segments_gen, info = model.transcribe(
        audio_path,
        language=args.language,
        beam_size=5,
        word_timestamps=True,
        vad_filter=True,
    )

    # Materialize segments
    raw_segments = []
    for segment in segments_gen:
        seg_data = {
            "start": segment.start,
            "end": segment.end,
            "text": segment.text.strip(),
            "words": [],
        }
        if segment.words:
            for w in segment.words:
                seg_data["words"].append({
                    "word": w.word.strip(),
                    "start": w.start,
                    "end": w.end,
                })
        raw_segments.append(seg_data)

    # Attempt diarization
    diarize_segments = run_diarization(audio_path, device)
    segments_with_speakers = assign_speakers(raw_segments, diarize_segments)

    # Build output in the expected TranscriptionResponse shape
    utterances = []
    for seg in segments_with_speakers:
        speaker = seg.get("speaker")
        # whisperX labels speakers as "SPEAKER_00", "SPEAKER_01", etc.
        speaker_num = None
        if isinstance(speaker, str) and speaker.startswith("SPEAKER_"):
            try:
                speaker_num = int(speaker.split("_")[-1])
            except ValueError:
                pass
        elif isinstance(speaker, int):
            speaker_num = speaker

        words = []
        for w in seg.get("words", []):
            word_speaker = w.get("speaker")
            word_speaker_num = None
            if isinstance(word_speaker, str) and word_speaker.startswith("SPEAKER_"):
                try:
                    word_speaker_num = int(word_speaker.split("_")[-1])
                except ValueError:
                    pass
            elif isinstance(word_speaker, int):
                word_speaker_num = word_speaker

            words.append({
                "word": w.get("word", ""),
                "punctuated_word": w.get("word", ""),
                "start": w.get("start", 0.0),
                "end": w.get("end", 0.0),
                "speaker": word_speaker_num if word_speaker_num is not None else speaker_num,
            })

        utterances.append({
            "start": seg.get("start", 0.0),
            "end": seg.get("end", 0.0),
            "transcript": seg.get("text", ""),
            "speaker": speaker_num,
            "words": words,
        })

    return {
        "metadata": {
            "duration": info.duration,
        },
        "results": {
            "utterances": utterances,
        },
    }


def main():
    args = parse_args()

    try:
        result = transcribe(args)
        json.dump(result, sys.stdout, ensure_ascii=False)
        sys.exit(0)
    except FileNotFoundError as e:
        json.dump({"error": str(e), "code": "file_not_found"}, sys.stdout)
        sys.exit(1)
    except ImportError as e:
        json.dump({"error": f"Missing dependency: {e}", "code": "missing_dependency"}, sys.stdout)
        sys.exit(1)
    except Exception as e:
        json.dump({
            "error": str(e),
            "code": "transcription_failed",
            "traceback": traceback.format_exc(),
        }, sys.stdout)
        sys.exit(1)


if __name__ == "__main__":
    main()
