// Learn: the words saved while watching, scheduled like the extension's (shared/study/word-cards.ts),
// and the bundled dictionary that splits subtitle lines into words.
import { Directory, File, Paths } from 'expo-file-system';
import { useEffect, useSyncExternalStore } from 'react';

import { dictionaryReady, loadDictionary, type Token } from '../../../shared/study/dictionary';
import { wordId, wordText } from '../../../shared/study/episode-words';
import { applyWordMessage, type WordCard } from '../../../shared/study/word-cards';

const folder = new Directory(Paths.document, '.anime-study');
const file = new File(folder, 'words.json');

let words: WordCard[] | null = null;
let snapshot: { words: WordCard[]; byId: Map<string, WordCard> } = { words: [], byId: new Map() };
const listeners = new Set<() => void>();

function load() {
  if (words) return words;
  words = [];
  try {
    if (file.exists) {
      const saved = JSON.parse(file.textSync()) as unknown;
      if (Array.isArray(saved)) words = saved as WordCard[];
    }
  } catch { /* A damaged word list starts fresh. */ }
  snapshot = { words, byId: new Map(words.map(word => [word.id, word])) };
  return words;
}

function commit(next: WordCard[]) {
  words = next;
  snapshot = { words: next, byId: new Map(next.map(word => [word.id, word])) };
  try {
    if (!folder.exists) folder.create({ intermediates: true });
    file.write(JSON.stringify(next));
  } catch { /* Best effort, like progress. */ }
  listeners.forEach(listener => listener());
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const getSnapshot = () => { load(); return snapshot; };

/** All saved words, and the same keyed by id; re-renders when a word is saved or graded. */
export function useWords() {
  return useSyncExternalStore(subscribe, getSnapshot);
}

export const wordCards = () => getSnapshot().byId;

/** Saves the word a token stands for, with the line it was met in. */
export function saveWord(token: Token, line: { text: string; start: number; end: number }, title: string, known?: boolean) {
  if (!token.entry) return;
  try {
    const next = applyWordMessage(load(), {
      type: 'JAPANESE_WORD_SAVE',
      word: {
        id: wordId(token.entry), word: wordText(token.entry), reading: token.entry.reading, gloss: token.entry.gloss,
        ...(known === undefined ? {} : { known }),
        example: { text: line.text, url: '', title, start: line.start, end: line.end },
      },
    });
    if (next) commit(next);
  } catch { /* The list is full or the word is malformed: nothing to save. */ }
}

export function gradeWord(id: string, remembered: boolean) {
  try {
    const next = applyWordMessage(load(), { type: 'JAPANESE_WORD_GRADE', id, remembered });
    if (next) commit(next);
  } catch { /* The word was removed meanwhile. */ }
}

/** Words due for review now (not marked known), soonest first. */
export function dueWords(list: WordCard[], now = Date.now()) {
  return list.filter(word => !word.known && word.due <= now).sort((a, b) => a.due - b.due);
}

// ----- Dictionary -----

let dictionaryLoad: Promise<void> | null = null;

/**
 * Loads the bundled JMdict table (about 1.8 MB) the first time Learn needs it. The require stays
 * inside the function so the table is only parsed when Learn is used.
 */
export function ensureDictionary(): Promise<void> {
  if (dictionaryReady()) return Promise.resolve();
  dictionaryLoad ??= new Promise<void>((resolve, reject) => {
    // Let the UI paint first: parsing takes a moment.
    setTimeout(() => {
      try {
        const data = require('../../../shared/study/dictionary-data.json') as { entries: string };
        loadDictionary(data.entries);
        resolve();
      } catch (error) {
        dictionaryLoad = null;
        reject(error);
      }
    }, 0);
  });
  return dictionaryLoad;
}

/** True once the dictionary is loaded; re-renders when it finishes. */
export function useDictionary(enabled: boolean) {
  const ready = useSyncExternalStore(subscribeDictionary, dictionaryReady);
  useEffect(() => {
    if (enabled && !ready) void ensureDictionary().then(notifyDictionary, () => {});
  }, [enabled, ready]);
  return ready;
}
const dictionaryListeners = new Set<() => void>();
const subscribeDictionary = (listener: () => void) => {
  dictionaryListeners.add(listener);
  return () => { dictionaryListeners.delete(listener); };
};
const notifyDictionary = () => dictionaryListeners.forEach(listener => listener());
