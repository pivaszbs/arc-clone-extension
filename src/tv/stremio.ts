/** The Movies & TV screens of the Samsung app: search, seasons, episodes and torrent streams. */
import type { Progress } from './library-client';
import {
  episodeCode,
  metaPath,
  playPath,
  searchPath,
  seasonName,
  seasonsOf,
  streamLabel,
  streamsPath,
  type SeriesMeta,
  type StreamOption,
  type StremioEpisode,
  type StremioType,
  type TitleCard
} from './stremio-client';

export type StreamPick = { id: string; title: string; label: string; path: string };

type View =
  | { kind: 'home' }
  | { kind: 'seasons'; card: TitleCard; meta?: SeriesMeta }
  | { kind: 'episodes'; card: TitleCard; meta: SeriesMeta; season: number }
  | { kind: 'streams'; card: TitleCard; episode?: StremioEpisode; streams?: StreamOption[] };

type Options = {
  list: HTMLElement;
  heading: HTMLElement;
  status: HTMLElement;
  form: HTMLFormElement;
  typeButton: HTMLButtonElement;
  query: HTMLInputElement;
  base: () => string;
  progress: (id: string) => Progress | undefined;
  play: (pick: StreamPick) => void;
  log: (line: string) => void;
};

function format(time: number) {
  return `${Math.floor(time / 60)}:${String(Math.floor(time % 60)).padStart(2, '0')}`;
}

export function createStremioBrowser(options: Options) {
  const { list, heading, status, form, typeButton, query } = options;
  let type: StremioType = 'movie';
  let results: TitleCard[] | undefined;
  let resultsFor = '';
  let stack: View[] = [];
  let request = 0;
  /** Index of the focused button per view depth, so going back lands where you were. */
  const focusAt: number[] = [];

  async function load<T>(path: string): Promise<T> {
    const response = await fetch(options.base() + path);
    const body = await response.json().catch(() => ({})) as T & { error?: string };
    options.log(`Movies & TV ${path.split('?')[0]}: HTTP ${response.status}`);
    if (!response.ok) throw new Error(body.error || 'The Mac could not reach the catalog. Try again.');
    return body;
  }

  function button(main: string, info: string, onPick: () => void, poster?: string | null) {
    const row = document.createElement('li');
    const item = document.createElement('button');
    if (poster !== undefined) {
      item.className = 'title-card';
      if (poster) {
        const img = document.createElement('img');
        img.className = 'title-poster';
        img.src = poster;
        img.alt = '';
        img.addEventListener('error', () => img.remove());
        item.append(img);
      }
      const meta = document.createElement('div');
      meta.className = 'title-meta';
      const name = document.createElement('span');
      name.className = 'title-name';
      name.textContent = main;
      meta.append(name);
      if (info) {
        const small = document.createElement('small');
        small.textContent = info;
        meta.append(small);
      }
      item.append(meta);
    } else {
      item.textContent = main;
      if (info) {
        const small = document.createElement('small');
        small.textContent = info;
        item.append(small);
      }
    }
    item.addEventListener('click', () => {
      focusAt[stack.length - 1] = Array.from(list.querySelectorAll('button')).indexOf(item);
      onPick();
    });
    row.append(item);
    list.append(row);
  }

  function resumeText(id: string) {
    const saved = options.progress(id);
    if (!saved) return '';
    return saved.finished ? 'Watched' : saved.position > 0 ? `Resume at ${format(saved.position)}` : '';
  }

  function focusList(fallback?: HTMLElement) {
    const buttons = list.querySelectorAll<HTMLButtonElement>('button');
    const at = focusAt[stack.length - 1] ?? 0;
    (buttons[at] || buttons[0] || fallback)?.focus();
  }

  function begin(title: string, grid: boolean) {
    list.textContent = '';
    list.classList.toggle('titles-grid', grid);
    list.classList.toggle('streams-grid', stack[stack.length - 1]?.kind === 'streams');
    heading.textContent = title;
    status.textContent = '';
    form.hidden = stack.length > 1;
    return ++request;
  }

  async function render() {
    const view = stack[stack.length - 1];
    if (!view) return;
    if (view.kind === 'home') {
      const id = begin('Movies & TV', true);
      typeButton.textContent = type === 'movie' ? 'Movies' : 'Series';
      const wanted = `${type}:${query.value.trim()}`;
      if (!results || resultsFor !== wanted) {
        status.textContent = query.value.trim() ? 'Searching…' : 'Loading popular titles…';
        try {
          const payload = await load<{ results?: TitleCard[] }>(searchPath(type, query.value));
          if (id !== request) return;
          results = payload.results || [];
          resultsFor = wanted;
          status.textContent = '';
        } catch (error) {
          if (id !== request) return;
          status.textContent = (error as Error).message;
          query.focus();
          return;
        }
      }
      if (!results.length) status.textContent = 'Nothing found. Try another name, or switch between Movies and Series.';
      for (const card of results) {
        button(card.name, [card.year, resumeText(card.id)].filter(Boolean).join(' · '), () => openTitle(card), card.poster);
      }
      focusList(query);
      return;
    }
    if (view.kind === 'seasons') {
      const id = begin(view.card.name, false);
      if (!view.meta) {
        status.textContent = 'Loading episodes…';
        try {
          view.meta = await load<SeriesMeta>(metaPath('series', view.card.id));
          if (id !== request) return;
          status.textContent = '';
        } catch (error) {
          if (id === request) status.textContent = (error as Error).message;
          return;
        }
      }
      const meta = view.meta;
      const seasons = seasonsOf(meta.episodes);
      if (!seasons.length) status.textContent = 'No episodes are listed for this series yet.';
      for (const season of seasons) {
        const count = meta.episodes.filter(ep => ep.season === season).length;
        button(seasonName(season), `${count} episodes`, () => push({ kind: 'episodes', card: view.card, meta, season }));
      }
      focusList();
      return;
    }
    if (view.kind === 'episodes') {
      begin(`${view.card.name} · ${seasonName(view.season)}`, false);
      for (const ep of view.meta.episodes.filter(item => item.season === view.season)) {
        button(`${episodeCode(ep)} · ${ep.name}`, resumeText(ep.id), () => push({ kind: 'streams', card: view.card, episode: ep }));
      }
      focusList();
      return;
    }
    const label = view.episode ? `${episodeCode(view.episode)} · ${view.episode.name}` : view.card.name;
    const id = begin(view.episode ? `${view.card.name} · ${episodeCode(view.episode)}` : view.card.name, false);
    if (!view.streams) {
      status.textContent = 'Finding torrents…';
      try {
        const payload = await load<{ streams?: StreamOption[] }>(streamsPath(view.card.type, view.episode?.id || view.card.id));
        if (id !== request) return;
        view.streams = payload.streams || [];
        status.textContent = '';
      } catch (error) {
        if (id === request) status.textContent = (error as Error).message;
        return;
      }
    }
    if (!view.streams.length) status.textContent = 'No torrents with seeders were found for this title.';
    else status.textContent = 'Pick a stream. 1080p H.264 (x264) files with many seeders start fastest.';
    const progressId = view.episode?.id || view.card.id;
    for (const stream of view.streams) {
      const text = streamLabel(stream);
      button(text.main, text.info, () => options.play({ id: progressId, title: view.card.name, label, path: playPath(stream) }));
    }
    focusList();
  }

  function push(view: View) {
    stack.push(view);
    focusAt[stack.length - 1] = 0;
    void render();
  }

  function openTitle(card: TitleCard) {
    push(card.type === 'series' ? { kind: 'seasons', card } : { kind: 'streams', card });
  }

  form.addEventListener('submit', event => {
    event.preventDefault();
    focusAt[0] = 0;
    void render();
  });
  typeButton.addEventListener('click', () => {
    type = type === 'movie' ? 'series' : 'movie';
    focusAt[0] = 0;
    void render().then(() => typeButton.focus());
  });

  return {
    get active() { return stack.length > 0; },
    open() {
      stack = [{ kind: 'home' }];
      focusAt.length = 0;
      void render();
    },
    /** Shows the current screen again, e.g. after closing the player. */
    show() { void render(); },
    /** One step back; false when already on the search screen (the caller leaves Movies & TV). */
    back() {
      if (stack.length <= 1) return false;
      stack.pop();
      void render();
      return true;
    },
    close() {
      stack = [];
      ++request;
      form.hidden = true;
      status.textContent = '';
    }
  };
}
