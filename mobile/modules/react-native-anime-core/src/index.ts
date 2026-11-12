import { NitroModules } from 'react-native-nitro-modules'
import type { AnimeCore } from './specs/AnimeCore.nitro'

export type {
  AnimeCore,
  Cue,
  EpisodePair,
  FolderTitle,
  OpEdIntervals,
  SkipRanges,
  ThemeSegment,
  TimeRange,
} from './specs/AnimeCore.nitro'

export const animeCore = NitroModules.createHybridObject<AnimeCore>('AnimeCore')
