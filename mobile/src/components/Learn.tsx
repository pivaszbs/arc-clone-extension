// Learn in the player, like the extension's study player (src/japanese/JapaneseStudy.svelte):
// after a line with a word in play the episode pauses, teaches a new word or asks one that is due,
// then carries on. The word logic is shared with the extension (shared/study).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { tokenize, tokenRomaji, type Token } from '../../../shared/study/dictionary';
import { analyseEpisode, coverage, episodeTargets, learnable, wordChoices, wordStop, type WordStop } from '../../../shared/study/episode-words';
import { hasJapanese, spokenText } from '../../../shared/study/study';
import { isLearning, type WordCard } from '../../../shared/study/word-cards';
import { haptics } from '../lib/haptics';
import { gradeWord, saveWord, useDictionary, useWords } from '../lib/words';
import { colors, radius, space } from '../theme';
import { Glass } from './Glass';

type Cue = { start: number; end: number; text: string };
type Answer = { options: string[]; chosen: string | null; result: 'correct' | 'incorrect' | null };
export type LearnStop = WordStop & Answer & { cue: Cue; tokens: Token[]; resumeAt: number };

/** Seconds of video between word stops, so learning never turns the episode into a slideshow. */
const WORD_PAUSE = 20;
const FALLBACK_GLOSSES = ['friend; companion', 'to eat', 'water', 'to go', 'house; home', 'to see; to look', 'today', 'person', 'to say', 'time; hour', 'to wait', 'big; large'];
const isVerb = (gloss: string) => gloss.startsWith('to ');
/** The first two senses are enough on a card. */
export const shortGloss = (gloss: string) => gloss.split('; ').slice(0, 2).join('; ');

type Controls = { pause: () => void; play: () => void; seekTo: (seconds: number) => void };

/**
 * Watches playback for lines that just finished and decides whether to stop for a word.
 * `time` is the player's position; `playing` whether it is playing.
 */
export function useLearn({ enabled, cues, time, playing, title, wordsInPlay, controls }: {
  enabled: boolean; cues: Cue[]; time: number; playing: boolean; title: string; wordsInPlay: number; controls: Controls;
}) {
  const dictionary = useDictionary(enabled);
  const { words, byId } = useWords();
  // Speaker labels such as （こうさぎ） are dropped, so names are not taught as words.
  const timeline = useMemo(() => cues.filter(cue => hasJapanese(cue.text)).map(cue => ({ ...cue, text: spokenText(cue.text) }))
    .filter(cue => hasJapanese(cue.text)).sort((a, b) => a.end - b.end), [cues]);
  const episode = useMemo(() => (enabled && dictionary && timeline.length ? analyseEpisode(timeline) : null), [enabled, dictionary, timeline]);
  const targets = useMemo(() => (episode ? episodeTargets(episode, byId, wordsInPlay) : null), [episode, byId, wordsInPlay]);
  const freshIds = useMemo(() => new Set(targets?.fresh.map(word => word.id) ?? []), [targets]);
  const progress = useMemo(() => (episode?.total ? coverage(episode, byId) : null), [episode, byId]);

  const [stop, setStop] = useState<LearnStop | null>(null);
  const lastTime = useRef<number | null>(null);
  const lastStop = useRef(-Infinity);
  /** While a line is replayed: pause again at its end. */
  const replayEnd = useRef<number | null>(null);

  const answerOptions = useCallback((correct: string) => {
    const pool = [...(episode ? [...episode.words.values()].map(word => word.entry.gloss) : []), ...words.map(word => word.gloss), ...FALLBACK_GLOSSES]
      .filter((gloss, index, all) => gloss !== correct && !gloss.startsWith('indicates') && all.indexOf(gloss) === index);
    // Wrong answers of the same kind as the right one, so "to …" does not give a verb away.
    const alike = pool.filter(gloss => isVerb(gloss) === isVerb(correct));
    return wordChoices(correct, (alike.length >= 3 ? alike : pool).slice(0, 40));
  }, [episode, words]);

  const begin = useCallback((cue: Cue, found: WordStop, cards: Map<string, WordCard>, at: number) => {
    const tokens = tokenize(cue.text);
    const token = tokens[found.index];
    const card = cards.get(found.id);
    if (!token?.entry || (found.action === 'quiz' && !card)) return false;
    controls.pause();
    lastStop.current = at;
    haptics.tap();
    if (found.action === 'teach') saveWord(token, cue, title);
    setStop({ ...found, cue, tokens, resumeAt: at, options: found.action === 'quiz' ? answerOptions(card!.gloss) : [], chosen: null, result: null });
    return true;
  }, [controls, title, answerOptions]);

  useEffect(() => {
    const previous = lastTime.current;
    lastTime.current = time;
    if (replayEnd.current !== null) {
      if (time >= replayEnd.current) { replayEnd.current = null; controls.pause(); }
      return;
    }
    if (!enabled || !dictionary || !playing || stop || previous === null) return;
    // A seek (or a jump of more than a second and a half) starts watching from the new place.
    if (time < previous || time - previous > 1.5) return;
    if (time - lastStop.current < WORD_PAUSE && time >= lastStop.current) return;
    const finished = timeline.filter(cue => cue.end > previous && cue.end <= time);
    for (const cue of finished) {
      const found = wordStop(tokenize(cue.text), byId, id => freshIds.has(id));
      if (found && begin(cue, found, byId, time)) return;
    }
  }, [time, enabled, dictionary, playing, stop, timeline, byId, freshIds, begin, controls]);

  const answer = useCallback((choice: string) => {
    setStop(current => {
      if (!current || current.result) return current;
      const card = byId.get(current.id);
      if (!card) return current;
      const result = choice === card.gloss ? 'correct' : 'incorrect';
      gradeWord(current.id, result === 'correct');
      if (result === 'correct') haptics.skipped(); else haptics.edge();
      return { ...current, chosen: choice, result };
    });
  }, [byId]);

  const resume = useCallback(() => {
    replayEnd.current = null;
    setStop(current => {
      if (current) controls.seekTo(current.resumeAt);
      return null;
    });
    controls.play();
  }, [controls]);

  const replay = useCallback(() => {
    if (!stop) return;
    replayEnd.current = stop.cue.end;
    controls.seekTo(Math.max(0, stop.cue.start - 0.2));
    controls.play();
  }, [stop, controls]);

  const knowIt = useCallback(() => {
    if (!stop) return;
    const token = stop.tokens[stop.index];
    saveWord(token, stop.cue, title, true);
    resume();
  }, [stop, title, resume]);

  return { stop, answer, resume, replay, knowIt, progress, targets, dictionary, inPlay: words.filter(isLearning).length };
}

/** The paused line with its words: tap one for its meaning. The word being learned is highlighted. */
function Line({ tokens, focus, reading, onSelect, selected }: {
  tokens: Token[]; focus: number; reading: 'romaji' | 'kana'; onSelect: (index: number) => void; selected: number;
}) {
  return (
    <View style={styles.line}>
      {tokens.map((token, index) => {
        const hint = token.entry && token.reading && token.reading !== token.surface
          ? (reading === 'romaji' ? tokenRomaji(token) : token.reading) : reading === 'romaji' && token.reading ? tokenRomaji(token) : '';
        const active = index === focus;
        return (
          <Pressable key={index} disabled={!token.entry} onPress={() => { haptics.select(); onSelect(index); }} style={styles.token}>
            <Text style={[styles.tokenHint, active && styles.focusText]}>{hint || ' '}</Text>
            <Text style={[styles.tokenText, active && styles.focusText, index === selected && !active && styles.selectedText, learnable(token) && styles.learnable]}>
              {token.surface}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** The card shown while a word stop holds the episode. */
export function LearnCard({ learn, reading, wide, bottom }: {
  learn: ReturnType<typeof useLearn>; reading: 'romaji' | 'kana'; wide: boolean;
  /** Room left for the player's control bar under the card. */
  bottom: number;
}) {
  const { stop } = learn;
  // Keyed by the stop (Player), so a new stop starts with nothing selected.
  const [selected, setSelected] = useState(-1);
  if (!stop) return null;
  const token = stop.tokens[stop.index];
  const entry = token?.entry;
  if (!entry) return null;
  const asking = stop.action === 'quiz' && !stop.result;
  const detail = selected >= 0 && selected !== stop.index ? stop.tokens[selected] : undefined;
  const word = entry.usuallyKana || !entry.written.length ? entry.reading : entry.written[0];
  const wordReading = reading === 'romaji' ? `${entry.reading} · ${tokenRomaji({ surface: entry.reading, reading: entry.reading })}` : entry.reading;

  return (
    <View style={[styles.wrap, wide && styles.wrapWide, { bottom }]} pointerEvents="box-none">
      <Glass style={styles.card}>
        <ScrollView contentContainerStyle={styles.cardBody} bounces={false}>
          <Text style={styles.kicker}>
            {stop.action === 'teach' ? 'NEW WORD · LISTEN FOR IT IN THIS LINE'
              : asking ? 'YOU HAVE MET THIS WORD · WHAT DOES IT MEAN?'
              : stop.result === 'correct' ? 'CORRECT' : 'NOT YET · IT WILL COME UP AGAIN SOON'}
          </Text>
          <Line tokens={stop.tokens} focus={stop.index} reading={reading} onSelect={setSelected} selected={selected} />

          <View style={styles.wordRow}>
            <Text style={styles.word}>{word}</Text>
            {(!asking || entry.written.length > 0) && word !== entry.reading && <Text style={styles.reading}>{wordReading}</Text>}
            {word === entry.reading && reading === 'romaji' && <Text style={styles.reading}>{tokenRomaji({ surface: entry.reading, reading: entry.reading })}</Text>}
          </View>

          {asking ? (
            <View style={styles.options}>
              {stop.options.map(option => (
                <Pressable key={option} accessibilityRole="button" onPress={() => learn.answer(option)}
                  style={({ pressed }) => [styles.option, pressed && styles.pressed]}>
                  <Text style={styles.optionText}>{shortGloss(option)}</Text>
                </Pressable>
              ))}
            </View>
          ) : stop.action === 'quiz' ? (
            <View style={styles.options}>
              {stop.options.map(option => {
                const right = option === entry.gloss;
                const wrong = option === stop.chosen && !right;
                return (
                  <View key={option} style={[styles.option, right && styles.optionRight, wrong && styles.optionWrong]}>
                    <Text style={styles.optionText}>{shortGloss(option)}</Text>
                  </View>
                );
              })}
            </View>
          ) : (
            <Text style={styles.gloss}>{shortGloss(entry.gloss)}</Text>
          )}

          {detail?.entry && (
            <Text style={styles.detail}>
              <Text style={styles.detailWord}>{detail.surface}</Text>
              {detail.reading && detail.reading !== detail.surface ? `  ${reading === 'romaji' ? tokenRomaji(detail) : detail.reading}` : ''}
              {`  ${shortGloss(detail.entry.gloss)}`}
            </Text>
          )}

          <View style={styles.actions}>
            <Pressable accessibilityRole="button" onPress={learn.replay} style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}>
              <Text style={styles.secondaryText}>Replay line</Text>
            </Pressable>
            {stop.action === 'teach' && (
              <Pressable accessibilityRole="button" onPress={learn.knowIt} style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}>
                <Text style={styles.secondaryText}>I know it</Text>
              </Pressable>
            )}
            {!asking && (
              <Pressable accessibilityRole="button" onPress={learn.resume} style={({ pressed }) => [styles.primary, pressed && styles.pressed]}>
                <Text style={styles.primaryText}>Continue</Text>
              </Pressable>
            )}
          </View>
        </ScrollView>
      </Glass>
    </View>
  );
}

/** Small status for the player bar: words in play and how much of the episode is understood. */
export function learnSummary(learn: ReturnType<typeof useLearn>) {
  if (!learn.dictionary) return 'Loading words…';
  if (!learn.progress) return 'No Japanese subtitles';
  return `You know ${Math.round(learn.progress.share * 100)}% of this episode's words`;
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: space.l, right: space.l, alignItems: 'center' },
  wrapWide: { left: '18%', right: '18%' },
  card: { width: '100%', maxHeight: 460 },
  cardBody: { padding: space.l, gap: space.m },
  kicker: { color: colors.accent, fontSize: 11, fontWeight: '700', letterSpacing: 0.8 },
  line: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end' },
  token: { alignItems: 'center', paddingHorizontal: 1, paddingVertical: 2 },
  tokenHint: { color: colors.textTertiary, fontSize: 10, minHeight: 13 },
  tokenText: { color: colors.text, fontSize: 22 },
  learnable: { textDecorationLine: 'underline', textDecorationColor: 'rgba(244,244,246,0.18)' },
  focusText: { color: colors.accent },
  selectedText: { color: '#7dd3fc' },
  wordRow: { flexDirection: 'row', alignItems: 'baseline', gap: space.m, flexWrap: 'wrap' },
  word: { color: colors.text, fontSize: 30, fontWeight: '700' },
  reading: { color: colors.textSecondary, fontSize: 16 },
  gloss: { color: colors.text, fontSize: 18, lineHeight: 24 },
  options: { gap: space.s },
  option: { borderRadius: radius.medium, paddingVertical: space.m, paddingHorizontal: space.l, backgroundColor: 'rgba(255,255,255,0.08)' },
  optionRight: { backgroundColor: 'rgba(52,211,153,0.28)' },
  optionWrong: { backgroundColor: 'rgba(248,113,113,0.26)' },
  optionText: { color: colors.text, fontSize: 16 },
  detail: { color: colors.textSecondary, fontSize: 14 },
  detailWord: { color: '#7dd3fc', fontWeight: '600' },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: space.s, flexWrap: 'wrap' },
  secondary: { borderRadius: radius.pill, paddingVertical: space.s, paddingHorizontal: space.l, backgroundColor: 'rgba(255,255,255,0.1)' },
  secondaryText: { color: colors.text, fontSize: 15, fontWeight: '600' },
  primary: { borderRadius: radius.pill, paddingVertical: space.s, paddingHorizontal: space.xl, backgroundColor: colors.accent },
  primaryText: { color: colors.background, fontSize: 15, fontWeight: '700' },
  pressed: { opacity: 0.6 },
});
