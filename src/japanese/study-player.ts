import type { ListeningCue } from './quiz';
import type { Cue } from './study';

export function readSkipChapters(video: HTMLVideoElement) {
  const chapters: Partial<Record<'op' | 'ed', { start: number; end: number }>> = {};
  for (const track of video.textTracks) {
    if (track.kind !== 'chapters') continue;
    for (const cue of Array.from(track.cues || [])) {
      const label = (cue as VTTCue).text?.trim();
      if (!label || cue.endTime <= cue.startTime) continue;
      if (/^(?:opening\b|op$|オープニング)/i.test(label)) chapters.op ??= { start: cue.startTime, end: cue.endTime };
      if (/^(?:ending\b|ed$|エンディング)/i.test(label)) chapters.ed ??= { start: cue.startTime, end: cue.endTime };
    }
  }
  return chapters;
}

/** Sample each subtitle once when playback crosses its end. */
export class PhraseStops {
  private timeline: Cue[] | null = null;
  private next = 0;
  private previousTime: number | null = null;
  private previousCaption: ListeningCue | null = null;

  reset() {
    this.previousTime = null;
    this.previousCaption = null;
  }

  observe(timeline: Cue[], caption: ListeningCue | null, time: number, chance: number, random = Math.random): Cue | null {
    if (this.timeline !== timeline || this.previousTime === null || time < this.previousTime || time - this.previousTime > 1.5) {
      this.timeline = timeline;
      let start = 0;
      let end = timeline.length;
      while (start < end) {
        const middle = (start + end) >>> 1;
        if (timeline[middle].end <= time) start = middle + 1;
        else end = middle;
      }
      this.next = start;
      this.previousTime = time;
      this.previousCaption = caption;
      return null;
    }
    this.previousTime = time;
    while (this.next < timeline.length && timeline[this.next].end <= time) {
      const cue = timeline[this.next++];
      if (random() < chance) return cue;
    }
    if (!timeline.length) {
      const previous = this.previousCaption;
      if (previous?.text !== caption?.text || (!previous?.estimated && previous?.start !== caption?.start)) {
        this.previousCaption = caption;
        if (previous && random() < chance) return previous.estimated ? { ...previous, end: time } : previous;
      }
    }
    return null;
  }
}

/** Lay out the existing player without moving it or reopening its media source. */
export function placeStudyVideo(video: HTMLVideoElement) {
  const layout = {
    position: 'fixed', left: '12px', top: '12px', right: 'auto', bottom: 'auto',
    margin: '0', 'max-width': 'none', 'max-height': 'none', transform: 'none',
    'object-fit': 'contain', 'z-index': '2147483645', background: '#0d0d12',
    width: 'calc(100vw - 24px)', height: 'calc(100dvh - 24px)'
  };
  const original = new Map<string, { value: string; priority: string }>();
  const applied = new Map<string, string>();
  const controls = video.controls;
  for (const [property, value] of Object.entries(layout)) {
    original.set(property, { value: video.style.getPropertyValue(property), priority: video.style.getPropertyPriority(property) });
    video.style.setProperty(property, value, 'important');
    applied.set(property, video.style.getPropertyValue(property));
  }
  video.controls = false;
  video.setAttribute('data-arc-study-video', '');
  return () => {
    video.removeAttribute('data-arc-study-video');
    video.controls = controls;
    for (const [property, { value, priority }] of original) {
      if (video.style.getPropertyValue(property) === applied.get(property) && video.style.getPropertyPriority(property) === 'important') {
        video.style.setProperty(property, value, priority);
      }
    }
  };
}
