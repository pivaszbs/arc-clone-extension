// The Learn tab: review the words met while watching, Learn settings, and the extension's
// Beginner anime list (shared/study/beginner-anime.json) to pick what to watch next.
import { useMemo, useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import list from '../../../shared/study/beginner-anime.json';
import { describePace, levelOf, type BeginnerSeries } from '../../../shared/study/beginner-anime';
import { romaji } from '../../../shared/study/dictionary';
import { wordChoices } from '../../../shared/study/episode-words';
import { isKnown, isLearning, type WordCard } from '../../../shared/study/word-cards';
import { haptics } from '../lib/haptics';
import type { Settings } from '../lib/storage';
import { dueWords, gradeWord, useWords } from '../lib/words';
import { colors, radius, space, status, type } from '../theme';
import { shortGloss } from './Learn';
import { Button, Row, Section, Stat } from './ui';

const beginners = list.series as BeginnerSeries[];
const FALLBACK = ['friend; companion', 'to eat', 'water', 'to go', 'house; home', 'to see; to look', 'today', 'person', 'to say', 'time; hour', 'to wait', 'big; large'];
const isVerb = (gloss: string) => gloss.startsWith('to ');

type Props = {
  settings: Settings;
  onSettings: (next: Partial<Settings>) => void;
  /** Opens an Anime365 page in the Download tab. */
  onOpenSite: (url: string) => void;
};

type Review = { card: WordCard; options: string[]; chosen: string | null };

function reviewOf(card: WordCard, all: WordCard[]): Review {
  const pool = [...all.map(word => word.gloss), ...FALLBACK].filter((gloss, index, glosses) => gloss !== card.gloss && glosses.indexOf(gloss) === index);
  const alike = pool.filter(gloss => isVerb(gloss) === isVerb(card.gloss));
  return { card, options: wordChoices(card.gloss, alike.length >= 3 ? alike : pool), chosen: null };
}

export function LearnTab({ settings, onSettings, onOpenSite }: Props) {
  const { words } = useWords();
  const [now, setNow] = useState(() => Date.now());
  const due = useMemo(() => dueWords(words, now), [words, now]);
  const known = useMemo(() => new Set(words.filter(isKnown).map(word => word.id)), [words]);
  const learning = words.filter(isLearning);
  const [review, setReview] = useState<Review | null>(null);
  const [reviewed, setReviewed] = useState({ right: 0, total: 0 });
  const reading = settings.reading ?? 'romaji';
  const wordsInPlay = settings.wordsInPlay ?? 5;

  const startReview = () => {
    const at = Date.now();
    setNow(at);
    const next = dueWords(words, at)[0];
    setReview(next ? reviewOf(next, words) : null);
  };
  const answer = (choice: string) => {
    if (!review || review.chosen) return;
    const right = choice === review.card.gloss;
    if (right) haptics.skipped(); else haptics.edge();
    gradeWord(review.card.id, right);
    setReviewed(count => ({ right: count.right + (right ? 1 : 0), total: count.total + 1 }));
    setReview({ ...review, chosen: choice });
  };
  const nextReview = () => {
    const at = Date.now();
    setNow(at);
    const next = dueWords(words, at).find(word => word.id !== review?.card.id);
    setReview(next ? reviewOf(next, words) : null);
  };

  const readingOf = (card: WordCard) => {
    if (card.word === card.reading) return reading === 'romaji' ? romaji(card.reading) : '';
    return reading === 'romaji' ? `${card.reading} · ${romaji(card.reading)}` : card.reading;
  };

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      <View style={styles.summary}>
        <View style={styles.stats}>
          <Stat value={String(known.size)} label="Known words" tone="ok" />
          <Stat value={String(learning.length)} label="Learning" tone="accent" />
          <Stat value={String(due.length)} label="Due now" tone={due.length ? 'warn' : 'idle'} />
        </View>
        {review ? (
          <View style={styles.review}>
            <Text style={styles.kicker}>{review.chosen ? (review.chosen === review.card.gloss ? 'CORRECT' : 'NOT YET · IT WILL COME UP AGAIN SOON') : 'WHAT DOES IT MEAN?'}</Text>
            <View style={styles.wordRow}>
              <Text style={styles.word}>{review.card.word}</Text>
              {!!readingOf(review.card) && <Text style={styles.reading}>{readingOf(review.card)}</Text>}
            </View>
            {review.card.example && <Text style={styles.example}>{review.card.example.text}{review.card.example.title ? `  — ${review.card.example.title}` : ''}</Text>}
            <View style={styles.options}>
              {review.options.map(option => {
                const right = !!review.chosen && option === review.card.gloss;
                const wrong = option === review.chosen && option !== review.card.gloss;
                return (
                  <Pressable key={option} accessibilityRole="button" disabled={!!review.chosen} onPress={() => answer(option)}
                    style={({ pressed }) => [styles.option, right && styles.optionRight, wrong && styles.optionWrong, pressed && styles.pressed]}>
                    <Text style={type.body}>{shortGloss(option)}</Text>
                  </Pressable>
                );
              })}
            </View>
            <View style={styles.reviewActions}>
              <Text style={type.caption}>{reviewed.right} of {reviewed.total} right this session</Text>
              <View style={{ flexDirection: 'row', gap: space.s }}>
                <Button title="Done" variant="plain" onPress={() => setReview(null)} />
                {review.chosen && <Button title="Next" variant="primary" onPress={nextReview} />}
              </View>
            </View>
          </View>
        ) : (
          <Button
            title={due.length ? `Review ${due.length} ${due.length === 1 ? 'word' : 'words'}` : words.length ? 'Nothing due right now' : 'Turn on Learn in the player to start'}
            variant="primary" icon="graduationcap.fill" disabled={!due.length} onPress={startReview}
          />
        )}
      </View>

      <Section title="While watching">
        <Row first title="Learn words in the player" detail="The episode pauses after a line with a word in play: new words are taught, learned ones asked."
          right={<Switch value={!!settings.learn} onValueChange={value => onSettings({ learn: value })} trackColor={{ true: colors.accent }} />} />
        <Row title="Words in play per episode" detail="New or still-unlearned words Learn works on at once."
          right={<Choice options={[3, 5, 8]} value={wordsInPlay} label={value => String(value)} onChange={value => onSettings({ wordsInPlay: value })} />} />
        <Row title="Readings" detail="Romaji until kana feel familiar."
          right={<Choice options={['romaji', 'kana'] as const} value={reading} label={value => (value === 'romaji' ? 'Romaji' : 'かな')} onChange={value => onSettings({ reading: value })} />} />
      </Section>

      {learning.length > 0 && (
        <Section title={`Learning · ${learning.length}`}>
          {learning.slice(0, 40).map((card, index) => (
            <Row key={card.id} first={index === 0} title={`${card.word}  ${readingOf(card)}`} detail={shortGloss(card.gloss)} />
          ))}
        </Section>
      )}

      <Section title="Beginner anime">
        <Text style={[type.subhead, styles.intro]}>
          The {beginners.length} easiest of the {list.ranked} series on Anime365 with Japanese subtitles, easiest first, measured from their first {list.sampleEpisodes} episodes: speaking speed, how many different words you need, and how common they are.
        </Text>
        {beginners.map((item, index) => {
          const level = levelOf(index, list.ranked);
          const knownTop = item.topWords.filter(id => known.has(id)).length;
          return (
            <View key={item.id} style={[styles.beginner, index > 0 && styles.divider]}>
              {item.poster ? <Image source={{ uri: item.poster }} style={styles.poster} /> : <View style={styles.poster} />}
              <View style={styles.beginnerBody}>
                <Text style={[styles.level, level.key === 'start' ? { color: status.ok } : level.key === 'next' ? { color: status.warn } : null]}>
                  {index + 1}. {level.label}
                </Text>
                <Text style={type.headline} numberOfLines={2}>{item.title}</Text>
                {!!(item.titleEn || item.titleJa) && <Text style={type.caption} numberOfLines={1}>{[item.titleEn, item.titleJa].filter(Boolean).join(' · ')}</Text>}
                <Text style={type.subhead}>
                  {describePace(item.wordsPerMinute)} · {item.wordsFor90} words cover 90% · you know {knownTop} of its top 50
                </Text>
                <Text style={type.caption} numberOfLines={1}>
                  {item.japaneseEpisodes} {item.japaneseEpisodes === 1 ? 'episode' : 'episodes'}{item.year ? ` · ${item.year}` : ''}{item.genres.length ? ` · ${item.genres.slice(0, 3).join(', ')}` : ''}
                </Text>
                <View style={styles.beginnerActions}>
                  <Button title="Download series" icon="arrow.down.circle" onPress={() => onOpenSite(item.url)} />
                  {!!item.firstEpisode && <Button title="Episode 1" variant="plain" onPress={() => onOpenSite(item.firstEpisode)} />}
                </View>
              </View>
            </View>
          );
        })}
      </Section>
    </ScrollView>
  );
}

function Choice<T extends string | number>({ options, value, label, onChange }: {
  options: readonly T[]; value: T; label: (value: T) => string; onChange: (value: T) => void;
}) {
  return (
    <View style={styles.choice}>
      {options.map(option => (
        <Pressable key={String(option)} accessibilityRole="button" accessibilityState={{ selected: option === value }}
          onPress={() => { haptics.select(); onChange(option); }}
          style={[styles.choiceItem, option === value && styles.choiceActive]}>
          <Text style={[styles.choiceText, option === value && styles.choiceTextActive]}>{label(option)}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: { paddingHorizontal: space.l, paddingTop: space.s, paddingBottom: space.xl * 2, gap: space.xl, maxWidth: 820, width: '100%', alignSelf: 'center' },
  summary: { backgroundColor: colors.surface, borderRadius: radius.large, borderCurve: 'continuous', padding: space.l, gap: space.l },
  stats: { flexDirection: 'row', gap: space.l },
  review: { gap: space.m },
  kicker: { color: colors.accent, fontSize: 11, fontWeight: '700', letterSpacing: 0.8 },
  wordRow: { flexDirection: 'row', alignItems: 'baseline', gap: space.m, flexWrap: 'wrap' },
  word: { color: colors.text, fontSize: 34, fontWeight: '700' },
  reading: { color: colors.textSecondary, fontSize: 16 },
  example: { color: colors.textSecondary, fontSize: 15, lineHeight: 21 },
  options: { gap: space.s },
  option: { borderRadius: radius.medium, paddingVertical: space.m, paddingHorizontal: space.l, backgroundColor: colors.surfaceRaised },
  optionRight: { backgroundColor: status.okMuted },
  optionWrong: { backgroundColor: status.dangerMuted },
  pressed: { opacity: 0.6 },
  reviewActions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.m },
  intro: { padding: space.l, paddingBottom: space.s },
  beginner: { flexDirection: 'row', gap: space.l, padding: space.l },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.separator },
  poster: { width: 84, aspectRatio: 3 / 4, borderRadius: radius.small, backgroundColor: colors.surfaceRaised },
  beginnerBody: { flex: 1, gap: 3 },
  level: { color: colors.textSecondary, fontSize: 12, fontWeight: '700' },
  beginnerActions: { flexDirection: 'row', gap: space.s, marginTop: space.s, flexWrap: 'wrap' },
  choice: { flexDirection: 'row', backgroundColor: colors.surfaceRaised, borderRadius: radius.pill, padding: 2 },
  choiceItem: { paddingVertical: 5, paddingHorizontal: space.m, borderRadius: radius.pill },
  choiceActive: { backgroundColor: colors.accent },
  choiceText: { color: colors.textSecondary, fontSize: 13, fontWeight: '600' },
  choiceTextActive: { color: colors.background },
});
