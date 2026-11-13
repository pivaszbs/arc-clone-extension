import { NativeModules, Platform } from 'react-native'
import { NitroModules } from 'react-native-nitro-modules'
import type { AnimeCore, VideoFingerprint } from './specs/AnimeCore.nitro'

export type {
  AnimeCore,
  Cue,
  EpisodePair,
  FolderTitle,
  FrameWindow,
  OpEdIntervals,
  SkipRanges,
  ThemeSegment,
  TimeRange,
  VideoFingerprint,
} from './specs/AnimeCore.nitro'

export const animeCore = NitroModules.createHybridObject<AnimeCore>('AnimeCore')

export type SampledVideoResult = VideoFingerprint & { duration: number }

type NativeFrameSampler = {
  sampleVideoWindows(url: string, durationHint: number): Promise<SampledVideoResult>
}

export async function sampleVideoFrames(url: string, durationHint = 0): Promise<SampledVideoResult> {
  if (Platform.OS !== 'ios') {
    throw new Error('AVAssetImageGenerator frame sampling is only available on iOS')
  }
  const sampler = NativeModules.AnimeFrameSampler as NativeFrameSampler | undefined
  if (!sampler?.sampleVideoWindows) {
    throw new Error('AnimeFrameSampler native module is not linked; rebuild the iOS app')
  }
  return sampler.sampleVideoWindows(url, durationHint)
}
