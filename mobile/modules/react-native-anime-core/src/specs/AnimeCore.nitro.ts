import type { HybridObject } from 'react-native-nitro-modules'

export interface Cue {
  start: number
  end: number
  text: string
}

export interface TimeRange {
  start: number
  end: number
}

/** source: ass-style | subtitle-label | subtitle-music | repeated-subtitles | dialogue-gap */
export interface ThemeSegment {
  start: number
  end: number
  source: string
}

export interface OpEdIntervals {
  op?: ThemeSegment
  ed?: ThemeSegment
}

export interface SkipRanges {
  op?: TimeRange
  ed?: TimeRange
  recap?: TimeRange
}

export interface FolderTitle {
  title: string
  credit: string
}

export interface EpisodePair {
  video: string
  subtitle?: string
  label: string
}

/** Shared Anime Study logic, implemented once in C++ for iOS and Android. */
export interface AnimeCore extends HybridObject<{ ios: 'c++'; android: 'c++' }> {
  parseSubtitles(body: string): Cue[]
  isJapanese(cues: Cue[], declaredJapanese: boolean): boolean
  detectOpEd(body: string, cues: Cue[], duration: number, references: Cue[][]): OpEdIntervals
  resolveSkipRanges(frames: SkipRanges, subtitles: OpEdIntervals, subtitleOffset: number): SkipRanges
  folderTitle(folderName: string): FolderTitle
  episodeLabel(fileName: string): string
  pairEpisodes(paths: string[]): EpisodePair[]
  cueIndexAt(cues: Cue[], time: number): number
}
