"""Soundtrack fingerprints for matching anime ending songs between episodes.

Python port of src/japanese/audio-print.ts. Every 0.1 s there is a 16-bit word: bit m says whether
the energy difference between neighbouring bands m and m+1 grew or shrank since the previous word.
The same song gives nearly the same words in every episode, even when the credits run over
different footage. Needs numpy; without it the worker falls back to picture-only matching.
"""

import base64
import subprocess

try:
    import numpy as np
except ImportError:  # pragma: no cover - optional dependency
    np = None

SAMPLE_RATE = 16000
FFT_SIZE = 2048
HOP = 1024
BAND_COUNT = 17
WORD_BITS = BAND_COUNT - 1
LOW_HZ = 300.0
HIGH_HZ = 3000.0
STEP = 0.1
SPAN = 0.4
SILENT_RMS = 0.004
BLOCK_ERROR_LIMIT = 0.3
EDGE_ERROR_LIMIT = 0.35
QUIET_PADDING = 3.0


def available():
    return np is not None


def print_from_pcm(pcm, pcm_start, start, end, rate=SAMPLE_RATE):
    """Build a print covering [start, end] from mono float PCM that begins at `pcm_start` seconds."""
    if np is None or len(pcm) < FFT_SIZE:
        return None
    count = int((end - start) / STEP) + 1
    if count < 2:
        return None
    frames = (len(pcm) - FFT_SIZE) // HOP + 1
    index = np.arange(FFT_SIZE)[None, :] + HOP * np.arange(frames)[:, None]
    blocks = pcm[index]
    window = 0.5 - 0.5 * np.cos(2 * np.pi * np.arange(FFT_SIZE) / FFT_SIZE)
    power = np.abs(np.fft.rfft(blocks * window, axis=1)) ** 2
    ratio = (HIGH_HZ / LOW_HZ) ** (1.0 / BAND_COUNT)
    edges = [int(round(LOW_HZ * ratio ** i * FFT_SIZE / rate)) for i in range(BAND_COUNT + 1)]
    bands = np.stack([power[:, edges[b]:max(edges[b] + 1, edges[b + 1])].sum(axis=1) for b in range(BAND_COUNT)], axis=1)
    rms = np.sqrt((blocks ** 2).mean(axis=1))
    times = pcm_start + (np.arange(frames) * HOP + FFT_SIZE / 2) / rate

    bits = np.zeros(count, dtype=np.uint16)
    loud = np.zeros(count, dtype=np.uint8)
    previous = None
    for k in range(count):
        t = start + k * STEP
        lo, hi = np.searchsorted(times, [t - SPAN / 2, t + SPAN / 2])
        if hi <= lo:
            previous = None
            continue
        log = np.log(bands[lo:hi].sum(axis=0) + 1e-9)
        if previous is not None:
            change = (log[:-1] - log[1:]) - (previous[:-1] - previous[1:])
            bits[k] = int(np.sum((change > 0) << np.arange(WORD_BITS)))
            loud[k] = 1 if rms[lo:hi].mean() >= SILENT_RMS else 0
        previous = log
    return {"start": float(start), "step": STEP, "bits": bits, "loud": loud}


def audio_print(video_url, start, end, ffmpeg_bin):
    """Fingerprint a file's soundtrack between two times, or None when it can't be decoded."""
    if np is None or end - start < 10:
        return None
    pcm_start = max(0.0, start - SPAN)
    cmd = [
        ffmpeg_bin, "-hide_banner", "-loglevel", "error",
        "-ss", f"{pcm_start:.3f}", "-t", f"{end + SPAN - pcm_start:.3f}",
        "-i", video_url, "-vn", "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "f32le", "pipe:1",
    ]
    try:
        raw = subprocess.check_output(cmd, stderr=subprocess.PIPE, timeout=180)
    except (subprocess.SubprocessError, OSError):
        return None
    pcm = np.frombuffer(raw[: len(raw) // 4 * 4], dtype="<f4").astype(np.float64)
    return print_from_pcm(pcm, pcm_start, start, end)


def encode(print_):
    if not print_:
        return None
    return {
        "start": print_["start"],
        "step": print_["step"],
        "bitsBase64": base64.b64encode(print_["bits"].astype("<u2").tobytes()).decode("ascii"),
        "loudBase64": base64.b64encode(print_["loud"].tobytes()).decode("ascii"),
    }


def decode(data):
    if np is None or not isinstance(data, dict) or not data.get("bitsBase64"):
        return None
    bits = np.frombuffer(base64.b64decode(data["bitsBase64"]), dtype="<u2").astype(np.uint16)
    loud = np.frombuffer(base64.b64decode(data.get("loudBase64") or ""), dtype=np.uint8)
    if len(loud) != len(bits):
        return None
    return {"start": float(data["start"]), "step": float(data["step"]), "bits": bits, "loud": loud}


_POPCOUNT = None


def _errors(a, b):
    global _POPCOUNT
    if _POPCOUNT is None:
        _POPCOUNT = np.array([bin(i).count("1") for i in range(1 << 16)], dtype=np.uint8)
    return _POPCOUNT[np.bitwise_xor(a, b)]


def _candidate_offsets(current, reference, limit=12):
    """Vote for alignments using words that match exactly or within one bit."""
    ref_index = {}
    for j in np.flatnonzero(reference["loud"]):
        ref_index.setdefault(int(reference["bits"][j]), []).append(int(j))
    shift = len(current["bits"])
    votes = np.zeros(len(current["bits"]) + len(reference["bits"]), dtype=np.int32)
    for i in np.flatnonzero(current["loud"]):
        word = int(current["bits"][i])
        for key in [word] + [word ^ (1 << b) for b in range(WORD_BITS)]:
            for j in ref_index.get(key, ()):
                votes[j - i + shift] += 1
    ranked = [int(x) for x in np.argsort(-votes, kind="stable") if votes[x] >= 8][:limit]
    return sorted({index - shift + near for index in ranked for near in (-1, 0, 1)})


def match_prints(current, reference, minimum_seconds=50.0, maximum_seconds=130.0):
    """Longest stretch of shared soundtrack, as ({start, end} in current, {start, end} in reference)."""
    if np is None or not current or not reference or abs(current["step"] - reference["step"]) > 1e-6:
        return None
    step = current["step"]
    per_block = int(round(1 / step))
    cur_len, ref_len = len(current["bits"]), len(reference["bits"])
    blocks = cur_len // per_block
    best = None

    for offset in _candidate_offsets(current, reference):
        i = np.arange(blocks * per_block)
        j = i + offset
        valid = (j >= 0) & (j < ref_len)
        jc = np.clip(j, 0, ref_len - 1)
        valid &= (current["loud"][i] == 1) & (reference["loud"][jc] == 1)
        errors = np.where(valid, _errors(current["bits"][i], reference["bits"][jc]), 0)
        count = valid.reshape(blocks, per_block).sum(axis=1)
        wrong = errors.reshape(blocks, per_block).sum(axis=1)
        hit = (count >= per_block * 0.6) & (wrong <= BLOCK_ERROR_LIMIT * WORD_BITS * np.maximum(count, 1))

        first = last = -1
        hits = total = 0

        def consider():
            nonlocal best
            if first < 0:
                return
            span = last - first + 1
            seconds = span * per_block * step
            if (seconds >= minimum_seconds * 0.8 and seconds <= maximum_seconds and hits / span >= 0.7
                    and (best is None or hits > best[3] or (hits == best[3] and total < best[4]))):
                best = (offset, first, last, hits, total)

        for block in np.flatnonzero(hit):
            block = int(block)
            if first >= 0 and block - last > 4:
                consider()
                first, hits, total = -1, 0, 0
            if first < 0:
                first = block
            last = block
            hits += 1
            total += int(wrong[block])
        consider()

    if best is None:
        return None
    offset, first, last = best[0], best[1], best[2]

    def word_error(i):
        j = i + offset
        if i < 0 or i >= cur_len or j < 0 or j >= ref_len or not current["loud"][i] or not reference["loud"][j]:
            return None
        return int(_errors(current["bits"][i], reference["bits"][j])) / WORD_BITS

    def matches(i):
        if word_error(i) is None:
            return False
        found = [e for e in (word_error(k) for k in range(i - 2, i + 3)) if e is not None]
        return len(found) >= 3 and sum(found) / len(found) <= EDGE_ERROR_LIMIT

    start_word, end_word = first * per_block, last * per_block + per_block - 1
    while matches(start_word - 1):
        start_word -= 1
    while start_word < end_word and not matches(start_word):
        start_word += 1
    while matches(end_word + 1):
        end_word += 1
    while end_word > start_word and not matches(end_word):
        end_word -= 1

    # Songs are padded by a moment of silence that the skip should cover too. Each episode uses its
    # own silence: look just past the matched edge, then run to the far side of the quiet stretch.
    def pad(print_, first_word, last_word):
        loud, size = print_["loud"], len(print_["bits"])
        reach, limit = int(round(0.5 / step)), int(round(QUIET_PADDING / step))

        def extend(edge, direction):
            k = edge + direction
            for _ in range(reach):
                if not (0 <= k < size) or not loud[k]:
                    break
                k += direction
            if not (0 <= k < size) or loud[k]:
                return edge
            for _ in range(limit):
                if not (0 <= k + direction < size) or loud[k + direction]:
                    break
                k += direction
            return k

        first_word, last_word = extend(first_word, -1), extend(last_word, 1)
        return (
            round(max(print_["start"], print_["start"] + (first_word - 0.5) * step), 2),
            round(print_["start"] + (last_word + 0.5) * step, 2),
        )

    cur_start, cur_end = pad(current, start_word, end_word)
    ref_start, ref_end = pad(reference, start_word + offset, end_word + offset)
    if not (minimum_seconds <= cur_end - cur_start <= maximum_seconds + 2 * QUIET_PADDING):
        return None
    return ({"start": cur_start, "end": cur_end}, {"start": ref_start, "end": ref_end})
