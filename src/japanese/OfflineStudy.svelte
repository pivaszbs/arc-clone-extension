<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import JapaneseStudy from './JapaneseStudy.svelte';
  import SeriesDownloads from './SeriesDownloads.svelte';
  import { detectAnimeOpEdIntervals, parseCaptionResponse } from './captions';
  import { castEpisode, findCastDevices, openSafariAirPlay, stopDirectCast, stopSafariAirPlay, updateSafariAirPlay, type CastDevice, type CastSession } from './direct-cast';
  import type { Cue } from './study';
  import { THEME_DETECTOR_VERSION, overlapsRecap, type VideoThemes } from './video-themes';
  import { exportVideoThemes } from './theme-export';
  import { forgetFrameChecks, VideoThemeQueue, type ScanStatus } from './video-theme-queue';
  import { DesktopVideoStream } from '../video/desktop-stream';
  import { directoryPicker, isEpisodeVideo, readEpisodeFolders, rememberFolder, rememberedFolder, type DownloadFolder, type EpisodeFolder } from './offline-library';
  import { buildTvPlaybackData, TvSyncClient, writeTvPlaybackToFolder as persistTvPlayback, type EpisodeProgress as Progress, type PipelineEvent, type TvWsState } from './tv-sync';
  import { extractEpisodeNumberFromName, extractSeriesIdFromName, parseSeriesArcMetadata, selectStoryCuesForExplainer, type ArcExplainerData } from './arc-explainer';

  const preferredParams = new URLSearchParams(location.search).get('series');
  const preferredSeriesId = preferredParams?.match(/\/catalog\/[^/]+-(\d+)(?:\/|[?#]|$)/)?.[1];
  const preferredSlugWords = (preferredParams?.match(/\/catalog\/([^/?#]+)/)?.[1] || '')
    .replace(/-\d+$/, '')
    .toLowerCase()
    .split('-')
    .filter(word => word.length >= 3);
  const preferredId = preferredParams?.match(/\/catalog\/[^/]+\/[^/]+\/[^/]+-(\d+)\/?$/)?.[1];
  const preferredEpisodeNumber = Number(preferredParams?.match(/\/catalog\/[^/]+\/(\d+)-seriya-\d+(?:\/|$)/)?.[1] || 0);
  // Use the source episode as a fallback until playback is selected in this tab.
  let usePreferredEpisode = true;

  let videoUrl = $state('');
  let fileName = $state('');
  let mediaError = $state(false);
  let localCues = $state<Cue[]>([]);
  let referenceCues = $state<Cue[][]>([]);
  let videoThemes = $state<VideoThemes>({});
  const predictionLabels = { op: 'Opening', ed: 'Ending', recap: 'Recap' };
  const predictions = $derived(
    (['op', 'ed', 'recap'] as const)
      .filter(part => part !== 'op' || !overlapsRecap(videoThemes.op, videoThemes.recap))
      .flatMap(part => {
        const range = videoThemes[part];
        return range ? [{ label: predictionLabels[part], ...range }] : [];
      })
      .sort((first, second) => first.start - second.start)
  );
  let scanQueue = $state<VideoThemeQueue>();
  let scanStatus = $state<ScanStatus>();
  let scanPaused = $state(false);
  let rescanPreparing = $state(false);
  let scanFolder = $state<DownloadFolder>();
  let scanSeries: string | undefined;
  let scanPreferredId = '';
  let scanFileNames = new Map<string, string>();
  let scanFileSeries = new Map<string, string>();
  type ParallelJob = {
    key: string;
    seriesName: string;
    title: string;
    queue: VideoThemeQueue;
    status?: ScanStatus;
    paused: boolean;
  };
  type SavedParallelJob = { key: string; seriesName: string; title: string; paused: boolean };
  let parallelJobs = $state<ParallelJob[]>([]);
  let pendingSavedJobs = $state<SavedParallelJob[]>([]);
  let expandedCoverage = $state<Record<string, boolean>>({});
  let arcExplainer = $state<ArcExplainerData | null>(null);
  let arcExplainerLoading = $state(false);
  let arcExplainerError = $state('');
  let activeScreen = $state<'watch' | 'gallery' | 'pipelines'>('watch');
  let tvWsState = $state<TvWsState>('disconnected');
  let tvAutoplay = $state(true);
  let pipelineEvents = $state<PipelineEvent[]>([]);
  const tvSync = new TvSyncClient(
    state => { tvWsState = state; },
    events => { pipelineEvents = events; },
    undefined,
    msg => {
      if (typeof msg.autoplay === 'boolean') tvAutoplay = msg.autoplay;
    }
  );
  const toggleTvAutoplay = () => {
    const next = !tvAutoplay;
    tvAutoplay = next;
    void tvSync.pushSync({ autoplay: next });
  };
  const sendTvSocket = (payload: Record<string, unknown>) => tvSync.sendSocket(payload);
  const pushTvSync = (payload: Record<string, unknown>) => tvSync.pushSync(payload);
  const connectTvSocket = () => tvSync.connect();
  let localBody = $state('');
  let localSource = $state('');
  let currentVideoFile: File | undefined;
  let episodes = $state<{ path: string; video: File; subtitle?: File }[]>([]);
  let selected = $state('');
  let opening = 0;
  let progressReady = false;
  let lastProgressSave = 0;
  let lastSavedPosition = 0;
  let lastSavedFinished = false;
  let resumePosition = 0;
  let player = $state<HTMLDivElement>();
  let video = $state<HTMLVideoElement>();
  let studyPlayer: ReturnType<typeof JapaneseStudy> | undefined = $state();
  let fullscreen = $state(false);
  let fullscreenError = $state(false);
  const desktopPipAvailable = /Mac/i.test(navigator.platform);
  let desktopStream: DesktopVideoStream | undefined;
  let desktopPipActive = $state(false);
  let desktopPipStarting = $state(false);
  let videoReady = $state(false);
  let desktopPipError = $state('');
  let learning = $state(false);
  let studying = $state(false);
  let overlayHidden = $state(false);
  let revealOverlayAfter = 0;
  let folder = $state<DownloadFolder>();
  let folderGranted = $state(false);
  let folderBusy = $state(false);
  let folderStatus = $state('');
  let episodeFolders = $state<EpisodeFolder[]>([]);
  let selectedFolder = $state<string>();
  let episodeList = $state<HTMLUListElement>();
  let castHelp = $state<HTMLDialogElement>();
  let castDevices = $state<CastDevice[]>([]);
  let castSession = $state<CastSession>();
  let castBusy = $state('');
  let castStatus = $state('');
  let airPlayBusy = $state(false);
  let airPlayStatus = $state('');
  let safariAirPlayId = $state('');
  let progressRevision = $state(0);
  let downloadsOpen = $state(!!preferredParams);
  // Download folders are named "Смотреть аниме <title> онлайн - <id> - <translation>".
  function folderTitle(name: string) {
    const plain = name.replace(/^Смотреть аниме\s+/i, '');
    const parts = plain.match(/^(.*?) - \d+(?: - (.+))?$/);
    // Without an id, drop a trailing translation credit such as "- NDA Studio Дубляж".
    const credit = parts ? parts[2] || '' : plain.match(/\s+-\s+([^-]*(?:дубляж|озвучка|субтитр|войсовер|dub|sub)[^-]*)$/i)?.[1] || '';
    const title = (parts ? parts[1] : credit ? plain.slice(0, plain.lastIndexOf(credit)).replace(/\s+-\s*$/, '') : plain)
      .replace(/\s+онлайн$/i, '').trim();
    return { title, credit: credit.trim() };
  }
  const seriesFolderName = $derived(episodeFolders.find(entry => entry.key === selectedFolder)?.name
    || episodes[0]?.video.webkitRelativePath.split('/').at(-2)
    || '');
  const animeName = $derived(folderTitle(seriesFolderName).title);
  const translationCredit = $derived(folderTitle(seriesFolderName).credit);
  const episodeIndex = $derived(episodes.findIndex(item => item.path === selected));

  $effect(() => {
    document.title = animeName ? `${animeName} · Anime Study` : 'Offline study · Anime Study';
  });
  const railProgress = $derived.by(() => {
    // Reading the revision refreshes the rail after progress is saved.
    void progressRevision;
    return new Map(episodes.map(episode => [episode.path, episodeProgress(episode.video)]));
  });
  const savedPosition = $derived(episodes[episodeIndex] ? episodeProgress(episodes[episodeIndex].video)?.position || 0 : 0);

  $effect(() => {
    const list = episodeList;
    if (!selected || !list) return;
    const current = list.querySelector<HTMLElement>('li:has([aria-current="true"])');
    if (!current) return;
    function keepCurrentVisible() {
      if (!list || !current) return;
      const top = current.offsetTop;
      const bottom = top + current.offsetHeight;
      if (top < list.scrollTop) list.scrollTop = top;
      else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
    }
    keepCurrentVisible();
    const observer = new ResizeObserver(keepCurrentVisible);
    observer.observe(list);
    return () => observer.disconnect();
  });

  function episodeLabel(name: string) {
    const number = name.match(/^Episode\s+(\d+)\b/i)?.[1];
    return number ? `Episode ${Number(number)}` : name.replace(/\.[^.]+$/, '');
  }

  function fileIdentity(file: File) {
    return `arc-offline:${encodeURIComponent(file.name)}/${file.size}/${file.lastModified}`;
  }

  let exportStatus = $state('');
  type SkipPart = keyof VideoThemes;
  type EndingAction = 'auto' | 'next' | 'skip';
  const skipParts = ['recap', 'op', 'ed'] as const;
  const autoSkipKey = 'arc-offline-auto-skip';
  const endingActionKey = 'arc-offline-ending-action';
  const subtitlesKey = 'arc-offline-subtitles';
  let autoSkip = $state<Record<SkipPart, boolean>>((() => {
    try {
      const legacy = localStorage.getItem(autoSkipKey) !== 'off';
      return {
        recap: localStorage.getItem(`${autoSkipKey}-recap`) !== 'off',
        op: (localStorage.getItem(`${autoSkipKey}-op`) ?? (legacy ? 'on' : 'off')) === 'on',
        ed: (localStorage.getItem(`${autoSkipKey}-ed`) ?? (legacy ? 'on' : 'off')) === 'on'
      };
    } catch { return { recap: true, op: true, ed: true }; }
  })());
  let endingAction = $state<EndingAction>((() => {
    try {
      const saved = localStorage.getItem(endingActionKey);
      return saved === 'auto' || saved === 'next' || saved === 'skip' ? saved : 'auto';
    } catch { return 'auto'; }
  })());
  let showSubtitles = $state((() => {
    try { return localStorage.getItem(subtitlesKey) !== 'off'; } catch { return true; }
  })());

  function updateAutoSkip(enabled: boolean) {
    autoSkip = { recap: enabled, op: enabled, ed: enabled };
    try {
      localStorage.setItem(autoSkipKey, enabled ? 'on' : 'off');
      for (const part of skipParts) localStorage.setItem(`${autoSkipKey}-${part}`, enabled ? 'on' : 'off');
    } catch { /* Keep the current preference. */ }
  }

  function updateEndingAction(next: EndingAction) {
    endingAction = next;
    try { localStorage.setItem(endingActionKey, next); } catch { /* Keep the current preference. */ }
  }

  function updateShowSubtitles(enabled: boolean) {
    showSubtitles = enabled;
    try { localStorage.setItem(subtitlesKey, enabled ? 'on' : 'off'); } catch { /* Keep the current preference. */ }
  }

  function exportPredictions() {
    try {
      const files = episodes.length ? episodes.map(item => item.video) : currentVideoFile ? [currentVideoFile] : [];
      const json = exportVideoThemes(files.map(file => ({ name: file.name, themes: storedThemes(fileIdentity(file)) })));
      if (!json) {
        exportStatus = 'No saved predictions for these episodes yet. Run frame checking first.';
        return;
      }
      const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'video-themes.json';
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      exportStatus = 'Download requested. Put video-themes.json beside this series’ videos before importing into Anime Study.';
    } catch {
      exportStatus = 'Could not export predictions. Check that each video has a unique filename.';
    }
  }

  function progressKey(file: File) {
    return `arc-offline:${encodeURIComponent(file.name)}:progress`;
  }

  // Older results remain available while the queue checks for late openings.
  function themeStorageKey(id: string, version = THEME_DETECTOR_VERSION) {
    return `${id}:video-themes-v${version}`;
  }

  function storedThemes(id: string, legacy = true): VideoThemes {
    try {
      const read = (version: number): VideoThemes => JSON.parse(localStorage.getItem(themeStorageKey(id, version)) || '{}');
      const current = read(THEME_DETECTOR_VERSION);
      if (!legacy) return current;
      let merged: VideoThemes = {};
      for (let v = 1; v < THEME_DETECTOR_VERSION; v++) merged = { ...merged, ...read(v) };
      return { ...merged, ...current };
    } catch { return {}; }
  }

  let reprocessDismissed = $state(false);
  const needsDetectorReprocess = $derived.by(() => {
    if (reprocessDismissed || scanQueue || rescanPreparing || !episodes.length) return false;
    return episodes.some(episode => {
      const id = fileIdentity(episode.video);
      try {
        if (localStorage.getItem(themeStorageKey(id, THEME_DETECTOR_VERSION))) return false;
        for (let v = 1; v < THEME_DETECTOR_VERSION; v++) {
          if (localStorage.getItem(themeStorageKey(id, v))) return true;
        }
      } catch { /* ignore storage errors */ }
      return false;
    });
  });

  // A detector update reuses the saved frame checks, so it can run without asking. It only decodes
  // each episode's ending audio and recompares. Each series upgrades once per session, so stopping
  // the queue sticks.
  const autoUpgradedSeries = new Set<string>();
  let autoUpgrading = $state(false);
  $effect(() => {
    if (!needsDetectorReprocess || scanQueue || rescanPreparing) return;
    const series = selectedFolder ?? '';
    if (autoUpgradedSeries.has(series) || parallelJobs.some(job => job.key === selectedFolder)) return;
    autoUpgradedSeries.add(series);
    autoUpgrading = true;
    tvSync.log('Pipeline', `Updating skip timings to detector v${THEME_DETECTOR_VERSION}`);
    startScanQueue();
  });

  async function translateToEnglish(text: string, sourceLang = 'auto'): Promise<string> {
    const clean = text.trim();
    if (!clean) return '';
    try {
      const response = await requestArc({ type: 'TRANSLATE_TEXT', text: clean, sourceLang, targetLang: 'en' });
      return response.translatedText?.trim() || clean;
    } catch {
      return clean;
    }
  }

  async function loadArcExplainer(force = false) {
    if (arcExplainerLoading || !fileName) return;
    const cacheKey = `arc-explainer:${localSource || fileName}`;
    if (!force) {
      try {
        const cached = JSON.parse(localStorage.getItem(cacheKey) || 'null') as ArcExplainerData | null;
        if (cached && cached.hasSubtitles === (localCues.length > 0)) {
          arcExplainer = cached;
          return;
        }
      } catch { /* ignore cache errors */ }
    }
    arcExplainerLoading = true;
    arcExplainerError = '';
    try {
      const seriesId = extractSeriesIdFromName(seriesFolderName || animeName);
      const episodeNumber = extractEpisodeNumberFromName(fileName);
      let meta: ReturnType<typeof parseSeriesArcMetadata> = {
        seriesTitle: animeName || seriesFolderName,
        synopsis: '',
        genres: [],
      };
      if (seriesId) {
        try {
          const metaCacheKey = `arc-series-meta:${seriesId}`;
          let rawPayload: unknown = null;
          if (!force) {
            try { rawPayload = JSON.parse(localStorage.getItem(metaCacheKey) || 'null'); } catch { /* ignore */ }
          }
          if (!rawPayload) {
            const res = await fetch(`https://smotret-anime.com/api/series/${seriesId}`);
            if (res.ok) {
              rawPayload = await res.json();
              try { localStorage.setItem(metaCacheKey, JSON.stringify(rawPayload)); } catch { /* ignore */ }
            }
          }
          if (rawPayload) meta = parseSeriesArcMetadata(rawPayload, episodeNumber);
        } catch { /* Offline or series API unreachable. */ }
      }

      const [overview, episodeTitle] = await Promise.all([
        meta.synopsis ? translateToEnglish(meta.synopsis) : Promise.resolve(''),
        meta.episodeTitle ? translateToEnglish(meta.episodeTitle) : Promise.resolve(undefined),
      ]);

      const { recapLines, storyLines } = selectStoryCuesForExplainer(localCues, videoThemes);
      const [recapSummary, storyBeats] = await Promise.all([
        recapLines.length ? translateToEnglish(recapLines.join(' ')) : Promise.resolve(undefined),
        storyLines.length
          ? Promise.all(storyLines.map(line => translateToEnglish(line)))
          : Promise.resolve([]),
      ]);

      const data: ArcExplainerData = {
        seriesTitle: animeName || meta.seriesTitle || 'Current Series',
        episodeTitle,
        overview: overview || 'Load episode subtitles (.ass/.srt/.vtt) to generate an English story digest for this episode.',
        recapSummary,
        storyBeats,
        genres: meta.genres,
        hasSubtitles: localCues.length > 0,
      };
      arcExplainer = data;
      try { localStorage.setItem(cacheKey, JSON.stringify(data)); } catch { /* ignore */ }
    } catch (error) {
      arcExplainerError = error instanceof Error ? error.message : 'Could not build arc explainer.';
    } finally {
      arcExplainerLoading = false;
    }
  }

  async function loadSubtitleFile(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const body = await file.text();
      localBody = body;
      const key = localSource || fileName;
      if (key) {
        try { localStorage.setItem(`${key}:subtitles`, body); } catch { /* ignore */ }
      }
      arcExplainer = null;
      await tick();
      const cues = parseCaptionResponse(body);
      if (cues.length && currentVideoFile) {
        const subThemes = detectAnimeOpEdIntervals(body, cues, videoDuration || Math.max(cues.at(-1)?.end ?? 0, 1400));
        if (subThemes.op || subThemes.ed) {
          const merged = { ...videoThemes, op: videoThemes.op ?? subThemes.op, ed: videoThemes.ed ?? subThemes.ed };
          videoThemes = merged;
          try { localStorage.setItem(themeStorageKey(fileIdentity(currentVideoFile)), JSON.stringify(merged)); } catch { /* ignore */ }
          void pushTvSync({ seriesName: seriesFolderName, episode: currentVideoFile.name, themes: merged });
        }
      }
      void loadArcExplainer(true);
    } catch {
      arcExplainerError = 'Could not read that subtitle file.';
    }
  }

  function rememberScanQueue() {
    try {
      if (scanQueue && scanFolder) {
        localStorage.setItem('arc-theme-queue', JSON.stringify({ folder: scanFolder.name, series: scanSeries, paused: scanPaused, preferredId: scanPreferredId }));
      } else localStorage.removeItem('arc-theme-queue');
    } catch { /* The open tab can still run the queue. */ }
  }

  function rememberParallelJobs() {
    try {
      if (parallelJobs.length && folder) {
        const jobs: SavedParallelJob[] = parallelJobs.map(j => ({
          key: j.key,
          seriesName: j.seriesName,
          title: j.title,
          paused: j.paused,
        }));
        localStorage.setItem('arc-parallel-jobs', JSON.stringify({ folder: folder.name, jobs }));
        pendingSavedJobs = jobs;
      } else {
        localStorage.removeItem('arc-parallel-jobs');
        pendingSavedJobs = [];
      }
    } catch { /* Storage may be unavailable. */ }
  }

  function readSavedParallelJobs(folderName?: string): SavedParallelJob[] {
    try {
      const saved = JSON.parse(localStorage.getItem('arc-parallel-jobs') || 'null') as { folder?: string; jobs?: SavedParallelJob[] } | null;
      if (!saved || !Array.isArray(saved.jobs)) return [];
      if (folderName && saved.folder !== folderName) return [];
      return saved.jobs.filter(j => typeof j?.key === 'string' && typeof j?.seriesName === 'string');
    } catch {
      return [];
    }
  }

  function findPairedSubtitle(videoFile: File, pool: File[]): File | undefined {
    const stem = videoFile.name.replace(/\.[^.]+$/, '').toLowerCase();
    return pool.find(f => /\.(ass|ssa|srt|vtt)$/i.test(f.name) && f.name.replace(/\.[^.]+$/, '').toLowerCase() === stem);
  }

  function queueFiles(files: File[]) {
    const ordered = files.filter(file => isEpisodeVideo(file.name))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    scanFileNames = new Map(ordered.map(file => [fileIdentity(file), file.name]));
    const folderLookup = new Map<File, string>();
    for (const entry of episodeFolders) {
      for (const f of entry.files) folderLookup.set(f, entry.name);
    }
    scanFileSeries = new Map(ordered.map(file => [
      fileIdentity(file),
      folderLookup.get(file) || file.webkitRelativePath.split('/').at(-2) || seriesFolderName
    ]));
    scanQueue?.update(ordered.map(file => ({ file, id: fileIdentity(file), subtitle: findPairedSubtitle(file, files) })));
  }

  function startScanQueue(series = selectedFolder, paused = false, fresh = false, preferredId = '') {
    if (scanQueue) return;
    scanFolder = folderGranted ? folder : undefined;
    scanSeries = series;
    scanPreferredId = preferredId;
    scanPaused = paused;
    const scanSeriesName = episodeFolders.find(entry => entry.key === scanSeries)?.name || seriesFolderName;
    let lastProgressKey = '';
    const queue = new VideoThemeQueue(status => {
      if (scanQueue === queue) {
        scanStatus = status;
        if (scanSeriesName && status) {
          const progressKey = `${status.scanned}/${status.total}/${status.active || ''}`;
          if (progressKey !== lastProgressKey) {
            lastProgressKey = progressKey;
            sendTvSocket({ type: 'scan_progress', seriesName: scanSeriesName, done: status.scanned, total: status.total });
          }
        }
      }
    }, (id, match) => {
      if (scanQueue !== queue || !match.op && !match.ed && !match.recap) return;
      const previous = storedThemes(id, false);
      const recap = match.recap ?? previous.recap;
      const opening = overlapsRecap(previous.op, recap) ? match.op : previous.op ?? match.op;
      const found = { op: opening, ed: previous.ed ?? match.ed, recap };
      if (id === localSource) videoThemes = {
        op: found.op ?? (overlapsRecap(videoThemes.op, recap) ? undefined : videoThemes.op),
        ed: found.ed ?? videoThemes.ed,
        recap
      };
      try { localStorage.setItem(themeStorageKey(id), JSON.stringify(found)); } catch { /* Playback still uses the current match. */ }
      if (scanSeries === selectedFolder) void writeTvPlaybackToFolder(selectedFolder, buildTvPlayback());
      const epName = scanFileNames.get(id) || (id === localSource ? currentVideoFile?.name : undefined);
      const targetSeries = scanFileSeries.get(id) || scanSeriesName;
      if (epName && targetSeries) {
        void pushTvSync({ seriesName: targetSeries, episode: epName, themes: found });
      }
    }, id => storedThemes(id, false), fresh, preferredId);
    scanQueue = queue;
    queue.setPaused(paused);
    queueFiles(scanFolder ? episodeFolders.find(entry => entry.key === scanSeries)?.files || [] : episodes.map(episode => episode.video));
    rememberScanQueue();
  }

  function stopParallelJobs() {
    for (const job of parallelJobs) job.queue.stop();
    parallelJobs = [];
    rememberParallelJobs();
  }

  function launchSeriesJob(entry: EpisodeFolder, fresh: boolean, preferredId = '', paused = false) {
    const ordered = entry.files.filter(file => isEpisodeVideo(file.name))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    if (!ordered.length) return;
    const fileNames = new Map(ordered.map(file => [fileIdentity(file), file.name]));
    const clean = folderTitle(entry.name).title || entry.name;
    let lastKey = '';
    const queue = new VideoThemeQueue(status => {
      parallelJobs = parallelJobs.map(j => j.queue === queue ? { ...j, status } : j);
      if (status) {
        const progressKey = `${status.scanned}/${status.total}/${status.active || ''}`;
        if (progressKey !== lastKey) {
          lastKey = progressKey;
          sendTvSocket({ type: 'scan_progress', seriesName: entry.name, done: status.scanned, total: status.total });
        }
      }
    }, (id, match) => {
      if (!match.op && !match.ed && !match.recap) return;
      const previous = storedThemes(id, false);
      const recap = match.recap ?? previous.recap;
      const opening = overlapsRecap(previous.op, recap) ? match.op : previous.op ?? match.op;
      const found = { op: opening, ed: previous.ed ?? match.ed, recap };
      if (id === localSource) videoThemes = {
        op: found.op ?? (overlapsRecap(videoThemes.op, recap) ? undefined : videoThemes.op),
        ed: found.ed ?? videoThemes.ed,
        recap
      };
      try { localStorage.setItem(themeStorageKey(id), JSON.stringify(found)); } catch { /* Playback still uses the current match. */ }
      if (entry.key === selectedFolder) void writeTvPlaybackToFolder(selectedFolder, buildTvPlayback());
      const epName = fileNames.get(id);
      if (epName) void pushTvSync({ seriesName: entry.name, episode: epName, themes: found });
    }, id => storedThemes(id, false), fresh, preferredId);
    parallelJobs = [...parallelJobs.filter(j => j.key !== entry.key), { key: entry.key, seriesName: entry.name, title: clean, queue, paused }];
    if (paused) queue.setPaused(true);
    rememberParallelJobs();
    queue.update(ordered.map(file => ({ file, id: fileIdentity(file), subtitle: findPairedSubtitle(file, entry.files) })));
  }

  function queueAllFolders() {
    if (rescanPreparing || !episodeFolders.length) return;
    stopScanQueue();
    stopParallelJobs();
    for (const entry of episodeFolders) launchSeriesJob(entry, false, localSource);
    tvSync.log('Pipeline', `Started ${episodeFolders.length} parallel scan jobs`);
    activeScreen = 'pipelines';
  }

  function toggleScanQueue() {
    if (!scanQueue) { startScanQueue(); return; }
    scanPaused = !scanPaused;
    scanQueue.setPaused(scanPaused);
    rememberScanQueue();
  }

  function stopScanQueue() {
    scanQueue?.stop();
    scanQueue = undefined;
    scanFolder = undefined;
    scanStatus = undefined;
    autoUpgrading = false;
    rememberScanQueue();
  }

  async function scanSingleEpisode(entry: EpisodeFolder, file: File) {
    if (rescanPreparing) return;
    rescanPreparing = true;
    stopScanQueue();
    const id = fileIdentity(file);
    const existingThemes = storedThemes(id, false);
    if (existingThemes.op || existingThemes.ed || existingThemes.recap) {
      await clearCachedThemes([file]);
    }
    const existingJob = parallelJobs.find(j => j.key === entry.key);
    if (existingJob) {
      existingJob.queue.stop();
      parallelJobs = parallelJobs.filter(j => j.key !== entry.key);
    }
    launchSeriesJob(entry, false, id);
    tvSync.log('Pipeline', `Scanning ${folderTitle(entry.name).title || entry.name} · ${episodeLabel(file.name)}`);
    activeScreen = 'pipelines';
    rescanPreparing = false;
  }

  async function clearCachedThemes(files: File[]) {
    const ids = new Set(files.filter(file => isEpisodeVideo(file.name)).map(fileIdentity));
    const cleared = await forgetFrameChecks(ids).then(() => true, () => false);
    for (const id of ids) {
      for (let version = 1; version <= THEME_DETECTOR_VERSION; version++) {
        try { localStorage.removeItem(themeStorageKey(id, version)); } catch { /* Storage may be unavailable. */ }
      }
    }
    if (ids.has(localSource)) videoThemes = {};
    return cleared;
  }

  function startSeriesJob(entry: EpisodeFolder) {
    stopScanQueue();
    launchSeriesJob(entry, false, localSource);
    tvSync.log('Pipeline', `Started ${folderTitle(entry.name).title || entry.name}`);
    activeScreen = 'pipelines';
  }

  async function rescanSeriesJob(entry: EpisodeFolder) {
    if (rescanPreparing) return;
    rescanPreparing = true;
    stopScanQueue();
    const existing = parallelJobs.find(j => j.key === entry.key);
    if (existing) {
      existing.queue.stop();
      parallelJobs = parallelJobs.filter(j => j.key !== entry.key);
    }
    const cleared = await clearCachedThemes(entry.files);
    launchSeriesJob(entry, !cleared, localSource);
    tvSync.log('Pipeline', `Rescanning ${folderTitle(entry.name).title || entry.name}`);
    activeScreen = 'pipelines';
    rescanPreparing = false;
  }

  async function rescanFiles(files: File[], series: string | undefined, preferredId: string) {
    if (rescanPreparing) return;
    rescanPreparing = true;
    stopScanQueue();
    const sourceFolder = folder;
    const cleared = await clearCachedThemes(files);
    if (sourceFolder === folder && (series === undefined || series === selectedFolder)) {
      startScanQueue(series, false, !cleared, preferredId);
      if (series === undefined) queueFiles(files);
    }
    rescanPreparing = false;
  }

  function rescanFrames() {
    const files = folderGranted ? episodeFolders.find(entry => entry.key === selectedFolder)?.files ?? [] : episodes.map(episode => episode.video);
    return rescanFiles(files, selectedFolder, localSource);
  }

  async function rescanAllFrames() {
    if (rescanPreparing) return;
    if (!folderGranted || !episodeFolders.length) {
      return rescanFiles(episodes.map(episode => episode.video), undefined, localSource);
    }
    rescanPreparing = true;
    stopScanQueue();
    stopParallelJobs();
    const cleared = await clearCachedThemes(episodeFolders.flatMap(entry => entry.files));
    for (const entry of episodeFolders) launchSeriesJob(entry, !cleared, localSource);
    tvSync.log('Pipeline', `Rescanning ${episodeFolders.length} series in parallel`);
    activeScreen = 'pipelines';
    rescanPreparing = false;
  }

  function restoreScanQueue(handle: DownloadFolder) {
    if (!scanQueue) {
      try {
        const saved = JSON.parse(localStorage.getItem('arc-theme-queue') || 'null');
        if (saved?.folder === handle.name) startScanQueue(saved.series, saved.paused === true, false, typeof saved.preferredId === 'string' ? saved.preferredId : '');
      } catch { /* The queue can be started again from the library. */ }
    }
    restoreParallelJobs(handle);
  }

  function restoreParallelJobs(handle: DownloadFolder, forceResume = false) {
    if (parallelJobs.length) return;
    const saved = readSavedParallelJobs(handle.name);
    if (!saved.length) return;
    let restored = 0;
    for (const job of saved) {
      const entry = episodeFolders.find(item => item.key === job.key || item.name === job.seriesName);
      if (!entry) continue;
      launchSeriesJob(entry, false, localSource, forceResume ? false : job.paused);
      restored++;
    }
    if (restored) {
      tvSync.log('Pipeline', `Continued ${restored} saved scan ${restored === 1 ? 'job' : 'jobs'}`);
    }
  }

  async function continueSavedScan() {
    if (!folderGranted) {
      await openFolder(true);
      if (folderGranted && folder) restoreParallelJobs(folder, true);
      return;
    }
    if (folder && readSavedParallelJobs(folder.name).length) {
      restoreParallelJobs(folder, true);
      return;
    }
    // Fall back to continuing any unfinished series folders.
    if (folderGranted && episodeFolders.length) {
      let started = 0;
      for (const entry of episodeFolders) {
        if (parallelJobs.some(j => j.key === entry.key)) continue;
        const videos = entry.files.filter(f => isEpisodeVideo(f.name));
        const readyCount = videos.filter(f => { const t = storedThemes(fileIdentity(f), false); return !!(t.op || t.ed || t.recap); }).length;
        if (readyCount < videos.length) {
          launchSeriesJob(entry, false, localSource);
          started++;
        }
      }
      if (started) tvSync.log('Pipeline', `Continued ${started} unfinished scan ${started === 1 ? 'job' : 'jobs'}`);
    }
  }

  function episodeProgress(file: File): Progress | undefined {
    try {
      const saved = localStorage.getItem(progressKey(file)) || localStorage.getItem(`${fileIdentity(file)}:progress`);
      if (saved) return JSON.parse(saved);
    } catch { /* Playback can still work without storage. */ }
  }

  function buildTvPlayback(targetEpisodes = episodes, title = animeName) {
    return buildTvPlaybackData(targetEpisodes, title, video => storedThemes(fileIdentity(video)), episodeProgress);
  }

  async function writeTvPlaybackToFolder(seriesKey: string | undefined, data: ReturnType<typeof buildTvPlayback>) {
    const ok = await persistTvPlayback(folder, folderGranted, seriesKey, data);
    if (ok && seriesKey) void pushTvSync({ seriesName: seriesKey, autoSkip: data.autoSkip });
    return ok;
  }

  async function exportTvPlaybackData() {
    saveProgress(true);
    const data = buildTvPlayback();
    if (await writeTvPlaybackToFolder(selectedFolder, data)) {
      folderStatus = 'Synced skip timings & progress to anime-study-tv.json in the series folder.';
      return;
    }
    const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'anime-study-tv.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  function writeEpisodeProgress(file: File | string, progress: Progress) {
    try {
      const key = typeof file === 'string' ? `${file}:progress` : progressKey(file);
      localStorage.setItem(key, JSON.stringify(progress));
      if (typeof file !== 'string') localStorage.setItem(`${fileIdentity(file)}:progress`, JSON.stringify(progress));
    } catch { /* Playback can still work without storage. */ }
  }

  function saveProgress(force = false, playing = false) {
    if (!progressReady || !video || video.currentSrc !== videoUrl || video.seeking) return;
    const watchedAt = Date.now();
    if (!force && (video.paused || watchedAt - lastProgressSave < 3000)) return;
    const position = video.ended ? 0 : video.currentTime;
    if (!Number.isFinite(position) || (!playing && position === lastSavedPosition && video.ended === lastSavedFinished)) return;
    const progress: Progress = { position, watchedAt, finished: video.ended };
    if (currentVideoFile && fileIdentity(currentVideoFile) === localSource) writeEpisodeProgress(currentVideoFile, progress);
    else writeEpisodeProgress(localSource, progress);
    lastProgressSave = watchedAt;
    lastSavedPosition = position;
    lastSavedFinished = video.ended;
    progressRevision++;
    if (currentVideoFile && (seriesFolderName || animeName)) {
      void pushTvSync({ seriesName: seriesFolderName || animeName, episode: currentVideoFile.name, progress });
    }
  }

  function restoreProgress() {
    if (!video || video.currentSrc !== videoUrl) return;
    if (resumePosition > 0 && resumePosition < video.duration) video.currentTime = resumePosition;
    progressReady = true;
  }

  function latestWatched<T>(items: T[], files: (item: T) => File[]) {
    let latest: T | undefined;
    let watchedAt = 0;
    for (const item of items) {
      for (const file of files(item)) {
        const progress = episodeProgress(file);
        if (progress && progress.watchedAt > watchedAt) {
          latest = item;
          watchedAt = progress.watchedAt;
        }
      }
    }
    return latest;
  }

  function setEpisodeFiles(files: File[]) {
    const path = (file: File) => file.webkitRelativePath || file.name;
    const stem = (file: File) => path(file).replace(/\.[^.]+$/, '');
    const subtitles = new Map(files.filter(file => /\.(ass|ssa|srt|vtt)$/i.test(file.name)).map(file => [stem(file), file]));
    episodes = files.filter(file => isEpisodeVideo(file.name))
      .sort((a, b) => path(a).localeCompare(path(b), undefined, { numeric: true }))
      .map(video => ({ path: path(video), video, subtitle: subtitles.get(stem(video)) }));
    if (!episodes.some(item => item.path === selected)) {
      const latest = latestWatched(episodes, item => [item.video]);
      const next = latest && episodeProgress(latest.video)?.finished ? episodes[episodes.indexOf(latest) + 1] : undefined;
      const watched = next || latest;
      const preferred = episodes.find(item => matchesPreferredEpisode(item.video));
      selected = (watched || preferred || episodes[0])?.path || '';
    }
  }

  function matchesPreferredEpisode(file: File) {
    if (!usePreferredEpisode) return false;
    if (matchesPreferredTranslation(file)) return true;
    const episodeNumber = Number(file.name.match(/^Episode\s+(\d+)\b/i)?.[1] || 0);
    return preferredEpisodeNumber > 0 && episodeNumber === preferredEpisodeNumber;
  }

  function matchesPreferredTranslation(file: File) {
    return !!preferredId && file.name.match(/ - (\d+)(?: \(\d+\))?\.[^.]+$/)?.[1] === preferredId;
  }

  function resumeRememberedEpisode() {
    const episode = episodes[episodeIndex];
    if (!episode) return false;
    const latest = latestWatched(episodes, item => [item.video]);
    const hasSavedProgress = !!latest && !(latest.path === episode.path && episodeProgress(latest.video)?.finished);
    if (!hasSavedProgress && !matchesPreferredEpisode(episode.video)) return false;
    selectEpisode(true);
    return true;
  }

  function matchesPreferredSeries(entry: EpisodeFolder) {
    if (preferredSeriesId && new RegExp(` - ${preferredSeriesId}(?: - |$)`).test(entry.name)) return true;
    if (preferredSlugWords.length >= 2) {
      const lower = entry.name.toLowerCase();
      const hits = preferredSlugWords.filter(word => lower.includes(word)).length;
      if (hits >= Math.min(2, preferredSlugWords.length)) return true;
    }
    return false;
  }

  async function refreshFolder(handle: DownloadFolder) {
    const found = await readEpisodeFolders(handle);
    if (folder !== handle) return;
    episodeFolders = found;
    const videos = (entry: EpisodeFolder) => entry.files.filter(file => isEpisodeVideo(file.name));
    const scoped = usePreferredEpisode && !!preferredParams;
    const exact = scoped ? found.find(entry => videos(entry).some(matchesPreferredTranslation)) : undefined;
    const matched = scoped ? found.filter(entry => entry === exact || matchesPreferredSeries(entry)) : [];
    const available = matched.length ? matched : found;
    const current = found.find(entry => entry.key === selectedFolder);
    const keepCurrent = current && (!matched.length || matched.includes(current) || !!videoUrl);
    const chosen = (keepCurrent ? current : undefined)
      || exact
      || latestWatched(available, videos)
      || available.find(entry => videos(entry).some(matchesPreferredEpisode))
      || available[0];
    if (chosen?.key !== selectedFolder) selected = '';
    selectedFolder = chosen?.key;
    setEpisodeFiles(chosen?.files || []);
    folderStatus = episodes.length ? '' : scoped
      ? 'This series is not downloaded in the connected folder.'
      : 'No finished videos in this folder yet.';
    if (matched.length && !keepCurrent && chosen && !videoUrl && !opening) selectEpisode(true);
    if (scanQueue && scanFolder === handle) {
      if (scanSeries === undefined && chosen) {
        scanSeries = chosen.key;
        rememberScanQueue();
      }
      queueFiles(found.find(entry => entry.key === scanSeries)?.files || []);
    }
  }

  function switchEpisodeFolder() {
    const chosen = episodeFolders.find(entry => entry.key === selectedFolder);
    if (!chosen) return;
    usePreferredEpisode = false;
    folderStatus = '';
    selected = '';
    setEpisodeFiles(chosen.files);
    if (videoUrl) selectEpisode(true);
  }

  async function chooseFolder(reconnect = false) {
    if (!directoryPicker || folderBusy) return;
    folderBusy = true;
    try {
      const handle = reconnect && folder ? folder : await directoryPicker({ id: 'arc-offline', mode: 'read', startIn: 'downloads' });
      if (reconnect && await handle.requestPermission({ mode: 'read' }) !== 'granted') return;
      if (!reconnect && scanQueue) stopScanQueue();
      folder = handle;
      folderGranted = true;
      selected = '';
      selectedFolder = undefined;
      await refreshFolder(handle);
      if (reconnect) restoreScanQueue(handle);
      void rememberFolder(handle).catch(() => { folderStatus = 'This folder could not be remembered for next time.'; });
      if (resumeRememberedEpisode()) return;
      if (episodeFolders.length === 1) selectEpisode(true);
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== 'AbortError') folderStatus = 'Could not open that folder. Choose the downloaded series folder.';
    } finally { folderBusy = false; }
  }

  onMount(() => {
    let mounted = true;
    pendingSavedJobs = readSavedParallelJobs();
    connectTvSocket();
    if (directoryPicker) void rememberedFolder().then(async handle => {
      if (!mounted || folder || folderBusy || !handle) return;
      folder = handle;
      pendingSavedJobs = readSavedParallelJobs(handle.name);
      const granted = await handle.queryPermission({ mode: 'read' }) === 'granted';
      if (!mounted || folder !== handle) return;
      folderGranted = granted;
      if (granted) {
        await refreshFolder(handle);
        if (mounted && folder === handle) {
          restoreScanQueue(handle);
          if (!videoUrl && !opening && !folderBusy) resumeRememberedEpisode();
        }
      }
    }).catch(() => {});
    const refresh = setInterval(() => {
      const handle = folder;
      if (handle && folderGranted && !folderBusy) {
        void refreshFolder(handle).catch(() => {
          if (folder === handle) folderGranted = false;
        });
      }
    }, 5000);
    return () => { mounted = false; clearInterval(refresh); };
  });

  async function playFile(file: File, subtitle?: File, autoplay = false) {
    const request = ++opening;
    let body = subtitle && subtitle.size <= 5000000 ? await subtitle.text().catch(() => '') : '';
    if (!body) {
      try { body = localStorage.getItem(`${fileIdentity(file)}:subtitles`) || ''; } catch { /* ignore */ }
    }
    if (request !== opening) return;
    arcExplainer = null;
    arcExplainerError = '';
    if (desktopStream?.active) desktopStream.stop();
    videoReady = false;
    desktopPipError = '';
    videoThemes = storedThemes(fileIdentity(file));
    saveProgress(true);
    progressReady = false;
    lastProgressSave = 0;
    const progress = episodeProgress(file);
    resumePosition = progress?.finished ? 0 : (progress?.position || 0);
    lastSavedPosition = resumePosition;
    lastSavedFinished = !!progress?.finished;
    const previousUrl = videoUrl;
    mediaError = false;
    localCues = parseCaptionResponse(body);
    referenceCues = [];
    if (localCues.length) {
      const nearby = episodes.map((episode, index) => ({ ...episode, distance: Math.abs(index - episodeIndex) }))
        .filter(episode => episode.distance > 0 && episode.subtitle && episode.subtitle.size <= 5000000)
        .sort((a, b) => a.distance - b.distance).slice(0, 2);
      void Promise.all(nearby.map(async episode => {
        const reference = await episode.subtitle?.text().catch(() => '');
        return reference && reference !== body ? parseCaptionResponse(reference) : [];
      })).then(tracks => {
        if (request === opening) referenceCues = tracks.filter(track => track.length);
      });
    }
    localBody = body;
    localSource = fileIdentity(file);
    currentVideoFile = file;
    videoUrl = URL.createObjectURL(file);
    fileName = file.name;
    await tick();
    if (previousUrl) URL.revokeObjectURL(previousUrl);
    if (request !== opening || !video) return;
    if (previousUrl && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      video.animate([{ opacity: 0.4 }, { opacity: 1 }], { duration: 200 });
    }
    if (autoplay && !safariAirPlayId) void video.play().catch(() => {});
    if (safariAirPlayId) void syncSafariAirPlayEpisode(file, resumePosition, localCues);
  }

  function openVideo(event: Event) {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    if (file) {
      episodes = [];
      selected = '';
      folderGranted = false;
      folder = undefined;
      episodeFolders = [];
      void playFile(file, undefined, true);
    }
  }

  function openFolder(event: Event) {
    const files = Array.from((event.currentTarget as HTMLInputElement).files || []);
    if (!files.length) return;
    folderGranted = false;
    folder = undefined;
    episodeFolders = [];
    selected = '';
    setEpisodeFiles(files);
    selectEpisode(true);
  }

  function selectEpisode(autoplay = !!video && !video.paused) {
    usePreferredEpisode = false;
    const episode = episodes[episodeIndex];
    if (episode) void playFile(episode.video, episode.subtitle, autoplay);
  }

  function stepEpisode(offset: number, autoplay = !!video && !video.paused) {
    const episode = episodes[episodeIndex + offset];
    if (!episode) return;
    usePreferredEpisode = false;
    selected = episode.path;
    void playFile(episode.video, episode.subtitle, autoplay);
  }

  function advanceAfterEnding() {
    saveProgress(true);
    const request = opening;
    // Let the study player finish a final phrase before advancing.
    setTimeout(() => {
      if (request === opening && video?.ended && !studying) stepEpisode(1, true);
    }, 150);
  }

  function predictionTime(time: number) {
    return `${Math.floor(time / 60)}:${String(Math.floor(time % 60)).padStart(2, '0')}`;
  }

  function previewPrediction(start: number) {
    if (!video || !videoReady) return;
    video.pause();
    video.currentTime = start;
  }

  async function searchForTv() {
    if (castBusy) return;
    castBusy = 'Looking for TVs…';
    castStatus = '';
    castDevices = [];
    try {
      const result = await findCastDevices();
      castDevices = result.devices;
      castSession = result.session;
      if (!castDevices.length && !castSession) castStatus = 'No Google Cast TVs found. Check that your TV and computer are on the same network.';
    } catch (error) {
      castStatus = error instanceof Error ? error.message : 'Could not search for TVs.';
    } finally { castBusy = ''; }
  }

  function openCast() {
    airPlayStatus = '';
    if (!castHelp?.open) castHelp?.showModal();
    void searchForTv();
  }

  async function openQuickTime() {
    const file = currentVideoFile;
    if (!file || airPlayBusy) return;
    airPlayBusy = true;
    airPlayStatus = '';
    try {
      const granted = await chrome.permissions.request({ permissions: ['downloads'] });
      if (!granted) throw new Error('Open the downloaded episode from Finder in QuickTime, or use Screen Mirroring.');
      const result = await chrome.runtime.sendMessage({
        type: 'ANIME_OPEN_QUICKTIME', name: file.name, size: file.size, modified: file.lastModified
      });
      if (!result?.ok) throw new Error(result?.error || 'Could not open the episode in QuickTime.');
      if (file === currentVideoFile) video?.pause();
      airPlayStatus = 'In QuickTime, open the AirPlay menu and select your TV.';
    } catch (error) {
      airPlayStatus = error instanceof Error ? error.message : 'Could not open the episode in QuickTime.';
    } finally { airPlayBusy = false; }
  }

  function airPlayEpisodePayload(file: File) {
    const title = [animeName, episodeLabel(file.name)].filter(Boolean).join(' · ');
    const themes = studyPlayer?.playbackSkipRanges() ?? { ...videoThemes };
    if (overlapsRecap(themes.op, themes.recap)) delete themes.op;
    return { title, themes };
  }

  async function syncSafariAirPlayEpisode(file: File, position: number, cues: Cue[]) {
    const id = safariAirPlayId;
    if (!id || airPlayBusy) return;
    airPlayBusy = true;
    const { title, themes } = airPlayEpisodePayload(file);
    airPlayStatus = `Switching AirPlay to ${episodeLabel(file.name)}…`;
    try {
      await updateSafariAirPlay(id, file, title, position, cues, themes);
      if (file === currentVideoFile) video?.pause();
      airPlayStatus = `Playing ${episodeLabel(file.name)} in Safari AirPlay.`;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not switch AirPlay episode.';
      if (/expired/i.test(message)) safariAirPlayId = '';
      airPlayStatus = message;
    } finally { airPlayBusy = false; }
  }

  async function toggleSafariAirPlay() {
    const file = currentVideoFile;
    if (!video || !file || airPlayBusy) return;
    airPlayBusy = true;
    airPlayStatus = safariAirPlayId ? 'Stopping AirPlay…' : 'Preparing the AirPlay MP4…';
    try {
      if (safariAirPlayId) {
        await stopSafariAirPlay(safariAirPlayId);
        safariAirPlayId = '';
        airPlayStatus = '';
      } else {
        const { title, themes } = airPlayEpisodePayload(file);
        safariAirPlayId = await openSafariAirPlay(file, title, video.currentTime, localCues, themes);
        if (file === currentVideoFile) video?.pause();
        airPlayStatus = 'In Safari, click AirPlay and choose your TV.';
      }
    } catch (error) {
      airPlayStatus = error instanceof Error ? error.message : 'Could not prepare AirPlay.';
    } finally { airPlayBusy = false; }
  }

  async function startDirectCast(device: CastDevice) {
    const file = currentVideoFile;
    if (!file || !video || !videoReady || castBusy || castSession) return;
    castBusy = `Preparing ${episodeLabel(file.name)} for ${device.name}…`;
    castStatus = '';
    try {
      castSession = await castEpisode(device.id, file, episodeLabel(file.name), video.currentTime, localCues);
      if (file === currentVideoFile) video?.pause();
    } catch (error) {
      castStatus = error instanceof Error ? error.message : 'Could not start casting.';
    } finally { castBusy = ''; }
  }

  async function stopCasting() {
    if (!castSession || castBusy) return;
    castBusy = 'Stopping cast…';
    castStatus = '';
    try {
      await stopDirectCast(castSession.id);
      castSession = undefined;
    } catch (error) {
      castStatus = error instanceof Error ? error.message : 'Could not stop casting.';
    } finally { castBusy = ''; }
  }

  async function toggleFullscreen(hideControls = false) {
    if (!player) return;
    fullscreenError = false;
    if (hideControls) hideOverlay();
    try {
      if (document.fullscreenElement === player) await document.exitFullscreen();
      else await player.requestFullscreen();
      if (hideControls) hideOverlay();
      else video?.focus({ preventScroll: true });
    } catch { fullscreenError = true; }
  }

  async function toggleDesktopPip() {
    if (desktopPipStarting || !video) return;
    if (desktopStream?.active) {
      desktopStream.stop();
      return;
    }
    desktopPipError = '';
    desktopPipStarting = true;
    const stream = new DesktopVideoStream(video, () => {
      if (desktopStream === stream) desktopPipActive = stream.active;
    }, message => {
      if (desktopStream === stream) desktopPipError = message;
    });
    desktopStream = stream;
    try {
      await stream.start();
      if (desktopStream !== stream) stream.stop();
    } catch (error) {
      if (desktopStream === stream) desktopPipError = error instanceof Error ? error.message : 'Desktop Picture in Picture could not start.';
    } finally {
      if (desktopStream === stream) desktopPipStarting = false;
    }
  }

  function hideOverlay() {
    video?.focus({ preventScroll: true });
    revealOverlayAfter = performance.now() + 500;
    overlayHidden = true;
  }

  function revealOverlayOnPointerMove() {
    if (overlayHidden && performance.now() >= revealOverlayAfter) overlayHidden = false;
  }

  // Touch gestures on the video: tap plays or pauses, double-tap a side skips 10 seconds,
  // double-tap the middle toggles fullscreen. On touch, a tap on hidden controls only reveals them.
  let videoPaused = $state(true);
  let seekFlash = $state<{ forward: boolean; total: number; key: number }>();
  let playFlash = $state<{ playing: boolean; key: number }>();
  let lastTapAt = 0;
  let tapTimer: ReturnType<typeof setTimeout> | undefined;
  let seekFlashTimer: ReturnType<typeof setTimeout> | undefined;
  let seekChainUntil = 0;
  let controlsWereHidden = false;

  function tapZone(event: PointerEvent) {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    return x < 0.35 ? 'back' : x > 0.65 ? 'forward' : 'middle';
  }

  function gestureSeek(forward: boolean) {
    if (!studyPlayer?.seekBy(forward ? 10 : -10)) return;
    navigator.vibrate?.(8);
    const total = seekFlash && seekFlash.forward === forward && performance.now() < seekChainUntil ? seekFlash.total + 10 : 10;
    seekFlash = { forward, total, key: performance.now() };
    seekChainUntil = performance.now() + 650;
    clearTimeout(seekFlashTimer);
    seekFlashTimer = setTimeout(() => { seekFlash = undefined; }, 650);
  }

  // The big play button starts the episode in fullscreen. Fullscreen must be requested
  // during the click itself, before playback starts.
  function playFullscreen() {
    if (player && !document.fullscreenElement) {
      fullscreenError = false;
      const target = player as HTMLDivElement & { webkitRequestFullscreen?: () => void };
      const request = target.requestFullscreen ? target.requestFullscreen() : (target.webkitRequestFullscreen?.(), undefined);
      request?.catch(() => { fullscreenError = true; });
    }
    gesturePlay();
  }

  function gesturePlay() {
    if (!studyPlayer?.togglePlay()) return;
    playFlash = { playing: !!video?.paused, key: performance.now() };
  }

  function handleTapStart() {
    controlsWereHidden = overlayHidden || !!player?.querySelector('.player-controls.controls-hidden');
  }

  function handleTap(event: PointerEvent) {
    if (event.button !== 0 || !videoReady) return;
    const zone = tapZone(event);
    const now = performance.now();
    // Keep skipping while the viewer keeps tapping the same side.
    if (zone !== 'middle' && now < seekChainUntil && seekFlash?.forward === (zone === 'forward')) {
      lastTapAt = 0;
      gestureSeek(zone === 'forward');
      return;
    }
    if (now - lastTapAt < 300) {
      clearTimeout(tapTimer);
      lastTapAt = 0;
      if (zone === 'middle') void toggleFullscreen();
      else gestureSeek(zone === 'forward');
      return;
    }
    lastTapAt = now;
    // A tap or click on hidden controls only brings them back.
    const revealOnly = controlsWereHidden;
    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => { if (!revealOnly) gesturePlay(); }, 260);
  }

  function handleFullscreenChange() {
    fullscreen = document.fullscreenElement === player;
    if (overlayHidden) revealOverlayAfter = Math.max(revealOverlayAfter, performance.now() + 500);
  }

  onDestroy(() => {
    tvSync.destroy();
    for (const job of parallelJobs) job.queue.stop();
    scanQueue?.stop();
    if (desktopStream?.active) desktopStream.stop();
    desktopStream = undefined;
    if (videoUrl) URL.revokeObjectURL(videoUrl);
  });
</script>

<svelte:document onfullscreenchange={handleFullscreenChange} />
<svelte:window onpagehide={() => saveProgress(true)} onpointermove={revealOverlayOnPointerMove} onpointerdown={revealOverlayOnPointerMove} />

<header class="masthead">
  <div class="app-name">
    <span class="app-mark" aria-hidden="true"></span>
    <h1 title={animeName || undefined}>{animeName || 'Offline Study'}</h1>
  </div>
  <nav aria-label="Offline Study">
    <button type="button" class="nav-tab" aria-current={activeScreen === 'watch' ? 'page' : undefined} onclick={() => { activeScreen = 'watch'; }}>Watch</button>
    <button type="button" class="nav-tab" aria-current={activeScreen === 'gallery' ? 'page' : undefined} onclick={() => { activeScreen = 'gallery'; }}>Gallery</button>
    <button type="button" class="nav-tab" aria-current={activeScreen === 'pipelines' ? 'page' : undefined} onclick={() => { activeScreen = 'pipelines'; }}>Pipelines</button>
    <a href="#settings" onclick={event => { event.preventDefault(); activeScreen = 'gallery'; void tick().then(() => document.getElementById('settings')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })); }}>Settings</a>
    <a href="#downloads" onclick={event => { event.preventDefault(); activeScreen = 'gallery'; downloadsOpen = true; }}>Downloads</a>
  </nav>
</header>

<div class="watch-layout" class:with-episodes={episodes.length > 1} hidden={activeScreen !== 'watch'}>
  <div class="watch-main">
{#if videoUrl}
  <div class="player" bind:this={player}>
    <div class="video-frame">
    <video bind:this={video} src={videoUrl} playsinline tabindex="-1" onloadedmetadata={restoreProgress}
      onloadeddata={() => { videoReady = true; }}
      onplaying={() => saveProgress(true, true)} ontimeupdate={() => saveProgress()} onpause={() => { videoPaused = true; saveProgress(true); }} onseeked={() => saveProgress(true)}
      onplay={() => { videoPaused = false; }}
      onended={advanceAfterEnding} onerror={() => { mediaError = true; }}>
      <track kind="captions" />
    </video>
    <div class="gesture-layer" aria-hidden="true" onpointerdown={handleTapStart} onpointerup={handleTap}>
      {#if seekFlash}
        {#key seekFlash.key}
          <div class="seek-ripple" class:forward={seekFlash.forward}>
            <span>{seekFlash.forward ? '››' : '‹‹'}</span>{seekFlash.total} sec
          </div>
        {/key}
      {/if}
      {#if playFlash}
        {#key playFlash.key}<div class="play-flash">{playFlash.playing ? '▶' : '❚❚'}</div>{/key}
      {/if}
    </div>
    {#if videoPaused && videoReady && !studying && !overlayHidden}
      <button class="big-play" aria-label="Play episode in fullscreen" title="Play in fullscreen" onclick={playFullscreen}><span aria-hidden="true">▶</span></button>
    {/if}
    </div>
    {#if mediaError}<p role="alert">Chrome could not play this file. Try an MP4 or WebM file.</p>{/if}
    {#if fullscreenError}<p role="alert">Fullscreen could not open.</p>{/if}
    {#key videoUrl}
      <div class="offline-controls">
        <JapaneseStudy bind:this={studyPlayer} inline {overlayHidden} {localCues} {localBody} {localSource} {referenceCues} {videoThemes} title={fileName} bind:learning bind:studying bind:autoSkip bind:endingAction bind:showSubtitles onResumeAtEnd={() => stepEpisode(1, true)} onNextEpisode={episodeIndex >= 0 && episodeIndex < episodes.length - 1 ? () => stepEpisode(1, true) : undefined} onToggleFullscreen={() => toggleFullscreen(true)}>
          {#snippet playerOptions()}
            {#if desktopPipAvailable}
              <button class="theme-scan" disabled={desktopPipStarting || !videoReady} onclick={toggleDesktopPip}>
                {desktopPipStarting ? 'Opening desktop window…' : desktopPipActive ? 'Exit picture in picture across desktops' : 'Picture in picture across desktops'}
              </button>
              {#if desktopPipError}<span role="alert">{desktopPipError}</span>{/if}
            {/if}
            {#if episodes.length > 1}
              <button class="theme-scan" onclick={toggleScanQueue}>{scanQueue ? (scanPaused ? 'Resume frame checking' : 'Pause frame checking') : 'Queue frame checking'}</button>
              {#if scanStatus}<span>{scanStatus.scanned} / {scanStatus.total} episodes checked</span>{/if}
            {/if}
          {/snippet}
          {#snippet playerActions()}
            <div class="episode-controls">
              {#if episodes.length > 1}
                <button aria-label="Previous" title="Previous episode" disabled={episodeIndex <= 0} onclick={() => stepEpisode(-1)}>‹</button>
                <select aria-label="Episode" bind:value={selected} onchange={() => selectEpisode()}>
                  {#each episodes as episode (episode.path)}
                    <option value={episode.path} title={episode.video.name}>{episodeLabel(episode.video.name)}</option>
                  {/each}
                </select>
                <button aria-label="Next" title="Next episode" disabled={episodeIndex >= episodes.length - 1} onclick={() => stepEpisode(1)}>›</button>
              {/if}
              <button onclick={() => toggleFullscreen()} aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'} title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}>⛶</button>
              <button onclick={hideOverlay} title="Hide controls and subtitles until you move the pointer">Hide</button>
            </div>
          {/snippet}
        </JapaneseStudy>
      </div>
    {/key}
  </div>
  <div class="episode-heading">
    <div class="episode-identity">
      {#if animeName}<p class="series-name">{animeName}{#if translationCredit}<span class="translation-credit">{' · '}{translationCredit}</span>{/if}</p>{/if}
      <h2 title={fileName}>{episodeLabel(fileName)}</h2>
    </div>
    <div class="watch-actions">
      <button class="cast-button" aria-haspopup="dialog" onclick={openCast}>
        <span class="tv-icon" aria-hidden="true"></span> {castSession ? 'Manage cast' : 'Cast to TV'}
      </button>
      {#if episodeIndex >= 0 && episodes[episodeIndex + 1]}
        <button class="next-episode" onclick={() => stepEpisode(1, true)}>
          <span>Up next</span> {episodeLabel(episodes[episodeIndex + 1].video.name)} <span aria-hidden="true">›</span>
        </button>
      {/if}
    </div>
  </div>
  <section class="episode-bar predictions" aria-label="Frame predictions">
    <strong>Frame predictions</strong>
    {#each predictions as prediction (prediction.label)}
      <button class="prediction" disabled={!videoReady} onclick={() => previewPrediction(prediction.start)}
        title="Pause and jump to the predicted start">
        {prediction.label}
        <span class="prediction-time">{predictionTime(prediction.start)}–{predictionTime(prediction.end)}</span>
      </button>
    {:else}
      <span class="no-predictions">No predictions for this episode</span>
    {/each}
  </section>
  <details class="episode-bar arc-explainer" ontoggle={e => { if (e.currentTarget.open && !arcExplainer && !arcExplainerLoading) void loadArcExplainer(); }}>
    <summary>
      <strong>Arc explainer (English)</strong>
      <span class="arc-explainer-meta">
        {localCues.length ? `${localCues.length} subtitle lines` : 'No subtitles loaded'}
      </span>
    </summary>
    <div class="arc-explainer-body">
      <div class="arc-explainer-actions">
        <button type="button" disabled={arcExplainerLoading} onclick={() => loadArcExplainer(true)}>
          {arcExplainerLoading ? 'Generating…' : 'Refresh explainer'}
        </button>
        <label class="subtitle-upload">
          Load subtitles (.ass/.srt/.vtt)
          <input type="file" accept=".ass,.srt,.vtt,text/plain" onchange={loadSubtitleFile} hidden />
        </label>
      </div>
      {#if arcExplainerError}
        <p class="arc-error" role="alert">{arcExplainerError}</p>
      {:else if arcExplainerLoading && !arcExplainer}
        <p class="hint">Translating arc overview &amp; subtitle beats…</p>
      {:else if arcExplainer}
        {#if arcExplainer.episodeTitle}
          <p class="arc-ep-title"><strong>Episode:</strong> {arcExplainer.episodeTitle}</p>
        {/if}
        <p class="arc-overview">{arcExplainer.overview}</p>
        {#if arcExplainer.recapSummary}
          <div class="arc-section">
            <strong>Recap:</strong>
            <p>{arcExplainer.recapSummary}</p>
          </div>
        {/if}
        {#if arcExplainer.storyBeats.length}
          <div class="arc-section">
            <strong>Episode story beats (from subtitles):</strong>
            <ul class="arc-beats">
              {#each arcExplainer.storyBeats as beat}
                <li>{beat}</li>
              {/each}
            </ul>
          </div>
        {/if}
      {/if}
    </div>
  </details>
{:else}
  <section class="empty-player">
    <h2>Watch from your library</h2>
    <p>Open a downloaded series or an episode to start watching.</p>
    <a href="#library">Open library</a>
  </section>
{/if}
  </div>

  {#if episodes.length > 1}
    <aside class="episode-rail" aria-label="Episodes">
      <div class="rail-heading">
        <h2>Episodes</h2><span>{episodes.length} available</span>
      </div>
      <ul bind:this={episodeList}>
        {#each episodes as episode (episode.path)}
          {@const progress = railProgress.get(episode.path)}
          <li>
            <button class="episode-entry" aria-current={episode.path === selected ? 'true' : undefined}
              title={episode.video.name} onclick={() => {
                if (episode.path === selected && videoUrl) return;
                selected = episode.path;
                selectEpisode(true);
              }}>
              <span class="episode-entry-copy">
                <strong>{episodeLabel(episode.video.name)}</strong>
                {#if progress?.finished}<small>Watched</small>
                {:else if progress && progress.position >= 1}<small>{predictionTime(progress.position)} watched</small>
                {:else if episode.subtitle}<small>Subtitles available</small>{/if}
              </span>
              {#if episode.path === selected}<span class="current-episode">Current</span>
              {:else}<span class="episode-play" aria-hidden="true">▶</span>{/if}
            </button>
          </li>
        {/each}
      </ul>
    </aside>
  {/if}
</div>

<dialog bind:this={castHelp} aria-labelledby="cast-title">
  <h2 id="cast-title">Cast to TV</h2>
  {#if desktopPipAvailable}
    <section aria-labelledby="airplay-title">
      <h3 id="airplay-title">AirPlay</h3>
      <button disabled={airPlayBusy || (!safariAirPlayId && !videoReady)} onclick={toggleSafariAirPlay}>{safariAirPlayId ? 'Stop Safari AirPlay' : 'Open AirPlay in Safari'}</button>
      {#if airPlayStatus}<p role="status">{airPlayStatus}</p>{/if}
      <details>
        <summary>QuickTime</summary>
        <button disabled={airPlayBusy || !videoReady} onclick={openQuickTime}>Open in QuickTime</button>
      </details>
      <details>
        <summary>Screen Mirroring with subtitles</summary>
        <p>On your Mac, open <strong>Control Center → Screen Mirroring</strong> and select your Apple TV or AirPlay-compatible TV. Then return here and play the episode.</p>
      </details>
    </section>
    <h3>Google Cast</h3>
  {/if}
  {#if castBusy || castStatus}<p role="status">{castBusy || castStatus}</p>{/if}
  {#if castSession}
    <p>{castSession.title} is on the TV. Use the TV remote to pause or seek.</p>
    <button disabled={!!castBusy} onclick={stopCasting}>Stop casting</button>
  {:else}
    {#if castDevices.length}
      <ul class="cast-devices" aria-label="Available TVs">
        {#each castDevices as device (device.id)}
          <li><button disabled={!!castBusy || !videoReady} onclick={() => startDirectCast(device)}>{device.name}</button></li>
        {/each}
      </ul>
    {/if}
    <button disabled={!!castBusy} onclick={searchForTv}>Search again</button>
  {/if}
  <details>
    <summary>Mirror this tab instead</summary>
    <p>In Chrome’s <strong>⋮</strong> menu choose <strong>Cast, save, and share → Cast…</strong>. Select <strong>Cast tab</strong> if Chrome asks for a source.</p>
  </details>
  <form method="dialog"><button>Done</button></form>
</dialog>

<div class="watch-tools" class:single-pane={activeScreen === 'pipelines'} hidden={activeScreen === 'watch'}>
  <section id="library" class="library-tools" aria-labelledby="library-title" hidden={activeScreen !== 'gallery'}>
    <div class="library-header">
      <h2 id="library-title">Gallery</h2>
    </div>
{#if directoryPicker}
  <div class="episode-bar library">
    <button disabled={folderBusy} onclick={() => chooseFolder()}>{folder ? 'Change download folder' : 'Connect download folder'}</button>
    {#if folder && !folderGranted}<button disabled={folderBusy} onclick={() => chooseFolder(true)}>Reconnect {folder.name}</button>{/if}
    {#if folderGranted && (episodeFolders.length > 1 || (episodeFolders.length && selectedFolder === undefined))}
      <select aria-label="Series folder" value={selectedFolder ?? null} onchange={event => {
        selectedFolder = event.currentTarget.value;
        switchEpisodeFolder();
      }}>
        {#if selectedFolder === undefined}<option value={null} disabled>Choose a downloaded series</option>{/if}
        {#each episodeFolders as entry (entry.key)}{@const name = folderTitle(entry.name)}<option value={entry.key} title={entry.name}>{[name.title, name.credit].filter(Boolean).join(' · ')}</option>{/each}
      </select>
    {/if}
    {#if !videoUrl && episodes.length}
      <select aria-label="Saved episode" bind:value={selected}>
        {#each episodes as episode (episode.path)}<option value={episode.path} title={episode.video.name}>{episodeLabel(episode.video.name)}</option>{/each}
      </select>
      <button onclick={() => selectEpisode(true)}>{savedPosition ? 'Resume episode' : 'Play saved episode'}</button>
    {/if}
  </div>
  {#if folderGranted && episodeFolders.length > 1}
    <div class="folder-cards" role="list" aria-label="Series folders">
      {#each episodeFolders as entry (entry.key)}
        {@const name = folderTitle(entry.name)}
        {@const videoCount = entry.files.filter(f => isEpisodeVideo(f.name)).length}
        <button
          type="button"
          class="folder-card"
          aria-current={entry.key === selectedFolder ? 'true' : undefined}
          title={entry.name}
          onclick={() => { selectedFolder = entry.key; switchEpisodeFolder(); activeScreen = 'watch'; }}
        >
          <strong>{name.title || entry.name}</strong>
          <small>{videoCount} {videoCount === 1 ? 'episode' : 'episodes'}{name.credit ? ` · ${name.credit}` : ''}</small>
        </button>
      {/each}
    </div>
  {/if}
  {#if folderStatus}<p role="status">{folderStatus}</p>
  {:else if !folder}<p>Choose Arc Anime or a series folder inside it.</p>{/if}
{/if}
  {#if episodes.length}
    <button class="export-tv" onclick={exportTvPlaybackData} title="Save the selected series’ skip predictions and watch progress for Anime Study TV">Export TV playback data</button>
  {/if}
  <details class="local-files" open={!directoryPicker}>
    <summary>Open files manually</summary>
    <div class="files">
      <div><label for="series-folder">Open a downloaded series folder</label><input id="series-folder" type="file" webkitdirectory onchange={openFolder} /></div>
      <div><label for="episode">Episode video</label><input id="episode" type="file" accept="video/*,.mp4,.webm,.m4v" onchange={openVideo} /></div>
    </div>
  </details>
  </section>
  <section id="pipelines" class="library-tools" aria-labelledby="pipelines-title" hidden={activeScreen !== 'pipelines'}>
    <div class="library-header">
      <h2 id="pipelines-title">Pipelines</h2>
      <div style="display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap;">
        <button type="button" onclick={toggleTvAutoplay} aria-pressed={!tvAutoplay}>
          {tvAutoplay ? 'Stop TV autoplay' : 'TV autoplay stopped (Enable)'}
        </button>
        <span class="ws-pill" data-state={tvWsState}>
          <span class="ws-dot" aria-hidden="true"></span>
          TV WebSocket: {tvWsState}
        </span>
      </div>
    </div>
  {#if folderGranted || episodes.length || scanQueue || pendingSavedJobs.length}
  <div class="episode-bar scan-queue" aria-label="Frame checking queue">
    {#if pendingSavedJobs.length && !parallelJobs.length}
      <button type="button" onclick={continueSavedScan}>
        Continue scan ({pendingSavedJobs.length} {pendingSavedJobs.length === 1 ? 'job' : 'jobs'})
      </button>
    {/if}
    {#if folderGranted || episodes.length || scanQueue}
      <button disabled={rescanPreparing} onclick={toggleScanQueue}>{scanQueue ? (scanPaused ? 'Resume frame checking' : 'Pause frame checking') : 'Queue frame checking'}</button>
    {/if}
    {#if episodeFolders.length > 1}
      <button disabled={rescanPreparing} onclick={queueAllFolders}>Queue all folders</button>
    {/if}
    {#if episodes.length}
      <button disabled={rescanPreparing || (!!scanStatus?.active && !scanPaused)} onclick={rescanFrames}>{rescanPreparing ? 'Preparing rescan…' : 'Rescan frames'}</button>
    {/if}
    {#if episodeFolders.length > 1}
      <button disabled={rescanPreparing || (!!scanStatus?.active && !scanPaused)} onclick={rescanAllFrames}>Rescan all</button>
    {/if}
    {#if autoUpgrading && scanQueue}
      <p class="hint" role="status">
        Skip detector updated (v{THEME_DETECTOR_VERSION}): matching ending songs and updating OP/ED timings automatically.
      </p>
    {:else if needsDetectorReprocess}
      <p class="hint" role="status">
        Skip detector updated (v{THEME_DETECTOR_VERSION}). Reprocess this series for updated OP/ED timings?
        <button onclick={rescanFrames}>Reprocess series</button>
        {#if episodeFolders.length > 1}<button onclick={rescanAllFrames}>Reprocess all</button>{/if}
        <button onclick={() => { reprocessDismissed = true; }}>Dismiss</button>
      </p>
    {/if}
    {#if scanQueue && scanStatus}
      <button onclick={stopScanQueue}>Stop frame checking</button>
      <span role="status">
        {#if scanStatus.restoring && !scanStatus.active}
          Restoring saved frame checks…
        {:else}
          {scanStatus.scanned} / {scanStatus.total} episodes checked{scanStatus.failed ? ` · ${scanStatus.failed} failed` : ''}
          {#if scanStatus.active} · Checking {scanStatus.active}{:else if scanPaused} · Paused{:else if scanFolder && scanStatus.scanned + scanStatus.failed === scanStatus.total} · Watching for finished downloads{/if}
        {/if}
      </span>
    {/if}
  </div>
  <div class="pipelines-dashboard" aria-label="Realtime pipelines">
    <div class="pipeline-card">
      <div class="pipeline-head">
        <strong>{parallelJobs.length ? `Parallel Scan Jobs (${parallelJobs.length})` : 'Frame Scan Pipeline'}</strong>
        {#if parallelJobs.length}
          <button type="button" onclick={stopParallelJobs}>Stop all</button>
        {:else}
          <span>{scanQueue && scanStatus ? `${scanStatus.scanned} / ${scanStatus.total}` : 'Idle'}</span>
        {/if}
      </div>
      {#if parallelJobs.length}
        <ul class="jobs-list">
          {#each parallelJobs as job (job.key)}
            {@const jobEntry = episodeFolders.find(entry => entry.key === job.key || entry.name === job.seriesName)}
            {@const jobVideos = jobEntry ? jobEntry.files.filter(f => isEpisodeVideo(f.name)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })) : []}
            {@const jobExpanded = !!expandedCoverage[`job:${job.key}`]}
            <li class="job-row">
              <button
                type="button"
                class="job-head job-toggle"
                aria-expanded={jobExpanded}
                onclick={() => { expandedCoverage = { ...expandedCoverage, [`job:${job.key}`]: !jobExpanded }; }}
              >
                <span class="coverage-caret">{jobExpanded ? '▾' : '▸'}</span>
                <strong class="coverage-title">{job.title}</strong>
                <span>{job.status ? `${job.status.scanned} / ${job.status.total}` : 'Starting…'}</span>
              </button>
              {#if job.status && job.status.total > 0}
                <progress max={job.status.total} value={job.status.scanned}></progress>
              {/if}
              <div class="job-foot">
                <small>{job.paused ? 'Paused' : job.status?.active ? `Checking ${job.status.active}` : job.status && job.status.scanned + job.status.failed === job.status.total ? 'Done · watching folder' : 'Queued…'}</small>
                <div class="job-actions">
                  <button type="button" onclick={() => {
                    const nextPaused = !job.paused;
                    job.queue.setPaused(nextPaused);
                    parallelJobs = parallelJobs.map(j => j.key === job.key ? { ...j, paused: nextPaused } : j);
                    rememberParallelJobs();
                  }}>{job.paused ? 'Resume' : 'Pause'}</button>
                  <button type="button" onclick={() => {
                    job.queue.stop();
                    parallelJobs = parallelJobs.filter(j => j.key !== job.key);
                    rememberParallelJobs();
                  }}>Stop</button>
                </div>
              </div>
              {#if jobExpanded && jobEntry && jobVideos.length}
                <ul class="coverage-episodes">
                  {#each jobVideos as file (fileIdentity(file))}
                    {@const epThemes = storedThemes(fileIdentity(file), false)}
                    {@const epParts = [epThemes.recap ? 'Recap' : '', epThemes.op ? 'OP' : '', epThemes.ed ? 'ED' : ''].filter(Boolean)}
                    {@const isChecking = job.status?.active === file.name}
                    <li>
                      <button
                        type="button"
                        class="coverage-ep-btn"
                        disabled={rescanPreparing}
                        onclick={() => scanSingleEpisode(jobEntry, file)}
                        title={epParts.length ? 'Click to rescan this episode' : 'Click to scan this episode'}
                      >
                        <span class="coverage-ep-name">{episodeLabel(file.name)}</span>
                        <span class="coverage-ep-state" data-state={isChecking ? 'checking' : epParts.length ? 'done' : 'pending'}>
                          {isChecking ? 'Checking…' : epParts.length ? epParts.join(' · ') : 'Scan'}
                        </span>
                      </button>
                    </li>
                  {/each}
                </ul>
              {/if}
            </li>
          {/each}
        </ul>
      {:else if scanQueue && scanStatus && scanStatus.total > 0}
        <progress max={scanStatus.total} value={scanStatus.scanned}></progress>
        <small>{scanStatus.active ? `Checking ${scanStatus.active}` : scanPaused ? 'Paused' : 'Watching folder for new episodes'}</small>
      {:else}
        <small>Start "Queue frame checking" or "Rescan all" to scan OP/ED timings.</small>
      {/if}
    </div>
    {#if folderGranted && episodeFolders.length}
      <div class="pipeline-card">
        <div class="pipeline-head">
          <strong>Series Coverage</strong>
          <span>{episodeFolders.length} {episodeFolders.length === 1 ? 'folder' : 'folders'}</span>
        </div>
        <ul class="coverage-list">
          {#each episodeFolders as entry (entry.key)}
            {@const videos = entry.files.filter(f => isEpisodeVideo(f.name)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))}
            {@const readyCount = videos.filter(f => { const t = storedThemes(fileIdentity(f), false); return !!(t.op || t.ed || t.recap); }).length}
            {@const activeJob = parallelJobs.find(j => j.key === entry.key)}
            {@const isExpanded = !!expandedCoverage[entry.key]}
            <li class="coverage-item">
              <div class="coverage-row">
                <button
                  type="button"
                  class="coverage-toggle"
                  aria-expanded={isExpanded}
                  onclick={() => { expandedCoverage = { ...expandedCoverage, [entry.key]: !isExpanded }; }}
                >
                  <span class="coverage-caret">{isExpanded ? '▾' : '▸'}</span>
                  <span class="coverage-title">{folderTitle(entry.name).title || entry.name}</span>
                  <span class="coverage-count">{readyCount} / {videos.length}</span>
                </button>
                <span class="coverage-right">
                  {#if activeJob}
                    <button type="button" onclick={() => {
                      const nextPaused = !activeJob.paused;
                      activeJob.queue.setPaused(nextPaused);
                      parallelJobs = parallelJobs.map(j => j.key === activeJob.key ? { ...j, paused: nextPaused } : j);
                      rememberParallelJobs();
                    }}>{activeJob.paused ? 'Resume' : 'Pause'}</button>
                    <button type="button" onclick={() => {
                      activeJob.queue.stop();
                      parallelJobs = parallelJobs.filter(j => j.key !== activeJob.key);
                      rememberParallelJobs();
                    }}>Stop</button>
                  {:else}
                    {#if readyCount < videos.length}
                      <button type="button" disabled={rescanPreparing} onclick={() => startSeriesJob(entry)}>Scan</button>
                    {/if}
                    <button type="button" disabled={rescanPreparing} onclick={() => rescanSeriesJob(entry)}>Rescan</button>
                  {/if}
                </span>
              </div>
              {#if isExpanded}
                <ul class="coverage-episodes">
                  {#each videos as file (fileIdentity(file))}
                    {@const epThemes = storedThemes(fileIdentity(file), false)}
                    {@const epParts = [epThemes.recap ? 'Recap' : '', epThemes.op ? 'OP' : '', epThemes.ed ? 'ED' : ''].filter(Boolean)}
                    {@const isChecking = activeJob?.status?.active === file.name}
                    <li>
                      <button
                        type="button"
                        class="coverage-ep-btn"
                        disabled={rescanPreparing}
                        onclick={() => scanSingleEpisode(entry, file)}
                        title={epParts.length ? 'Click to rescan this episode' : 'Click to scan this episode'}
                      >
                        <span class="coverage-ep-name">{episodeLabel(file.name)}</span>
                        <span class="coverage-ep-state" data-state={isChecking ? 'checking' : epParts.length ? 'done' : 'pending'}>
                          {isChecking ? 'Checking…' : epParts.length ? epParts.join(' · ') : 'Scan'}
                        </span>
                      </button>
                    </li>
                  {/each}
                </ul>
              {/if}
            </li>
          {/each}
        </ul>
      </div>
    {/if}
    <div class="pipeline-card">
      <div class="pipeline-head">
        <strong>Live Event Feed</strong>
        <span>{pipelineEvents.length} events</span>
      </div>
      {#if pipelineEvents.length}
        <ul class="event-feed">
          {#each pipelineEvents as item (item.id)}
            <li><span class="event-time">{item.time}</span> <span class="event-kind">{item.kind}</span> {item.detail}</li>
          {/each}
        </ul>
      {:else}
        <small>Waiting for WebSocket or scan events…</small>
      {/if}
    </div>
  </div>
{/if}
  </section>
  <section id="settings" class="library-tools settings-tools" aria-labelledby="settings-title" hidden={activeScreen !== 'gallery'}>
    <h2 id="settings-title">Settings</h2>
    <label class="setting-check">
      <input type="checkbox" checked={autoSkip.op && autoSkip.ed && autoSkip.recap} onchange={event => updateAutoSkip(event.currentTarget.checked)} />
      <span>Auto-skip openings, endings and recaps</span>
    </label>
    <label class="setting-check">
      <input type="checkbox" checked={showSubtitles} onchange={event => updateShowSubtitles(event.currentTarget.checked)} />
      <span>Show subtitles</span>
    </label>
    <div class="episode-bar">
      <label class="setting-select" for="offline-ending-action">Ending skip</label>
      <select id="offline-ending-action" value={endingAction} onchange={event => updateEndingAction(event.currentTarget.value as EndingAction)}>
        <option value="auto">Auto (next episode or post-credits)</option>
        <option value="next">Next episode</option>
        <option value="skip">Skip ending only</option>
      </select>
    </div>
    <div class="episode-bar">
      <button onclick={exportPredictions}>Export saved skip predictions</button>
    </div>
    {#if exportStatus}<p role="status">{exportStatus}</p>{/if}
  </section>
  <section id="downloads" aria-label="Downloads" hidden={activeScreen !== 'gallery'}>
    <SeriesDownloads bind:expanded={downloadsOpen} />
  </section>
</div>

<style>
  :global(body) {
    margin: 0;
    background: #0e0e10;
    color: #f7f6f3;
    font: 15px/1.5 system-ui, sans-serif;
    color-scheme: dark;
  }
  :global(#app) {
    --surface: #171719;
    --line: #2f2d2d;
    --muted: #b6b1ae;
    --accent: #ff8248;
    max-width: 1520px;
    padding: 0 clamp(16px, 3vw, 48px) 48px;
    margin: auto;
  }
  h1, h2, p { margin: 0; }
  h2 { font-size: 19px; line-height: 1.25; }
  .masthead {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 18px 0;
    border-bottom: 1px solid var(--line);
  }
  .app-name, .masthead nav { display: flex; align-items: center; gap: 12px; }
  .app-name { min-width: 0; }
  .masthead h1 { font-size: clamp(17px, 2.4vw, 22px); letter-spacing: -.035em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .app-mark {
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    flex: none;
    border-radius: 7px;
    background: var(--accent);
  }
  .app-mark::after {
    content: '';
    margin-left: 2px;
    border-top: 6px solid transparent;
    border-bottom: 6px solid transparent;
    border-left: 9px solid #21130c;
  }
  .masthead nav a { padding: 6px 4px; color: var(--muted); font-size: 13px; text-decoration: none; }
  .masthead nav a:hover { color: var(--accent); }
  .watch-layout { display: grid; gap: 24px; margin-top: 24px; }
  .watch-layout.with-episodes { grid-template-columns: minmax(0, 1fr) clamp(240px, 23vw, 315px); }
  .watch-main { min-width: 0; }
  .player { position: relative; background: #050505; border-radius: 10px; }
  video {
    display: block;
    width: 100%;
    aspect-ratio: 16 / 9;
    max-height: 68dvh;
    object-fit: contain;
    border-radius: inherit;
  }
  video:focus { outline: none; }
  .offline-controls { position: absolute; inset: auto 8px 8px; pointer-events: none; }
  .video-frame { position: relative; border-radius: inherit; }
  .gesture-layer { position: absolute; inset: 0; overflow: hidden; border-radius: inherit; touch-action: manipulation; -webkit-tap-highlight-color: transparent; user-select: none; }
  .seek-ripple {
    position: absolute; top: -20%; bottom: -20%; left: -12%; width: 42%;
    display: grid; place-content: center; justify-items: center; gap: 2px;
    border-radius: 0 50% 50% 0 / 0 50% 50% 0;
    background: #ffffff1f; color: #fff; font-size: 14px; font-weight: 650;
    animation: ripple .65s ease-out forwards; pointer-events: none;
  }
  .seek-ripple.forward { left: auto; right: -12%; border-radius: 50% 0 0 50% / 50% 0 0 50%; }
  .seek-ripple span { font-size: 26px; line-height: 1; letter-spacing: -4px; animation: nudge .4s ease-out; }
  .seek-ripple:not(.forward) span { --nudge: -6px; }
  @keyframes ripple { 0% { opacity: 0; } 15% { opacity: 1; } 70% { opacity: 1; } 100% { opacity: 0; } }
  @keyframes nudge { from { transform: translateX(var(--nudge, 6px)); } to { transform: none; } }
  .play-flash {
    position: absolute; left: 50%; top: 50%; width: 76px; height: 76px; margin: -38px 0 0 -38px;
    display: grid; place-items: center; border-radius: 50%;
    background: #000000a0; color: #fff; font-size: 26px; pointer-events: none;
    animation: flash .55s ease-out forwards;
  }
  @keyframes flash { from { opacity: 1; transform: scale(.8); } to { opacity: 0; transform: scale(1.35); } }
  .big-play {
    position: absolute; left: 50%; top: 50%; width: 84px; height: 84px; margin: -42px 0 0 -42px;
    display: grid; place-items: center; border: 0; border-radius: 50%;
    background: var(--accent); color: #21130c; font-size: 30px;
    box-shadow: 0 10px 40px #0009, 0 0 0 0 #ff824866;
    animation: pop-in .28s cubic-bezier(.2, 1.4, .4, 1), pulse 2.4s ease-out .3s infinite;
    transition: transform .12s ease;
  }
  .big-play span { margin-left: 5px; }
  .big-play:hover { background: #ffa273; }
  .big-play:active { transform: scale(.9); }
  @keyframes pop-in { from { opacity: 0; transform: scale(.6); } }
  @keyframes pulse { 0% { box-shadow: 0 10px 40px #0009, 0 0 0 0 #ff824866; } 70%, 100% { box-shadow: 0 10px 40px #0009, 0 0 0 22px #ff824800; } }
  /* A chunkier seek bar with a filled track and a thumb that grows while dragging. */
  .offline-controls :global(.study.inline .seek) {
    -webkit-appearance: none; appearance: none; height: 22px; background: transparent; cursor: pointer;
  }
  .offline-controls :global(.study.inline .seek::-webkit-slider-runnable-track) {
    height: 5px; border-radius: 3px;
    background: linear-gradient(to right, var(--accent) var(--progress, 0%), #ffffff38 var(--progress, 0%));
    transition: height .15s ease;
  }
  .offline-controls :global(.study.inline .seek::-webkit-slider-thumb) {
    -webkit-appearance: none; width: 14px; height: 14px; margin-top: -4.5px; border-radius: 50%;
    background: var(--accent); box-shadow: 0 0 0 0 #ff824855; transition: transform .15s ease, box-shadow .15s ease;
  }
  .offline-controls :global(.study.inline .seek:hover::-webkit-slider-runnable-track) { height: 7px; }
  .offline-controls :global(.study.inline .seek:hover::-webkit-slider-thumb) { margin-top: -3.5px; }
  .offline-controls :global(.study.inline .seek:active::-webkit-slider-thumb) { transform: scale(1.45); box-shadow: 0 0 0 7px #ff824840; }
  .offline-controls :global(.study.inline .seek::-moz-range-track) { height: 5px; border-radius: 3px; background: #ffffff38; }
  .offline-controls :global(.study.inline .seek::-moz-range-progress) { height: 5px; border-radius: 3px; background: var(--accent); }
  .offline-controls :global(.study.inline .seek::-moz-range-thumb) { width: 14px; height: 14px; border: 0; border-radius: 50%; background: var(--accent); }
  @media (prefers-reduced-motion: reduce) {
    .seek-ripple, .seek-ripple span, .play-flash, .big-play { animation-duration: .01s; animation-iteration-count: 1; }
  }
  /* Frosted glass control bar with borderless buttons, so the picture shows through. */
  .offline-controls { inset: auto 12px 12px; }
  .offline-controls :global(.study.inline .player-controls) {
    padding: 6px 10px 4px;
    background: rgb(18 18 22 / 34%);
    -webkit-backdrop-filter: blur(22px) saturate(170%);
    backdrop-filter: blur(22px) saturate(170%);
    border: 1px solid rgb(255 255 255 / 10%);
    border-radius: 14px;
    box-shadow: 0 10px 30px rgb(0 0 0 / 28%), inset 0 1px 0 rgb(255 255 255 / 8%);
  }
  .offline-controls :global(.study.inline :is(.toolbar, .extras) :is(button, select)) {
    min-height: 32px;
    min-width: 32px;
    padding: 4px 9px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: rgb(255 255 255 / 88%);
    font-size: 14px;
  }
  .offline-controls :global(.study.inline :is(.toolbar, .extras) :is(button, select):hover:not(:disabled)) {
    background: rgb(255 255 255 / 14%);
    color: #fff;
  }
  .offline-controls :global(.study.inline .toolbar button[aria-pressed='true']) {
    background: rgb(255 130 72 / 88%);
    color: #21130c;
  }
  .offline-controls :global(.study.inline select option) { background: #1b1b1f; color: #f7f6f3; }
  .offline-controls :global(.study.inline .clock) { color: rgb(255 255 255 / 78%); font-size: 13px; }
  .offline-controls :global(.study.inline :is(.extras, .learn-bar)) { border-top-color: rgb(255 255 255 / 10%); }
  .offline-controls :global(.study.inline :is(.skip-suggestion, .caption-row > *)) {
    background: rgb(18 18 22 / 40%);
    -webkit-backdrop-filter: blur(18px) saturate(160%);
    backdrop-filter: blur(18px) saturate(160%);
    border: 1px solid rgb(255 255 255 / 10%);
    border-radius: 10px;
  }
  /* A soft shade behind the controls keeps them readable on bright scenes. */
  .video-frame::after {
    content: '';
    position: absolute;
    inset: auto 0 0;
    height: 38%;
    border-radius: 0 0 10px 10px;
    background: linear-gradient(to top, rgb(0 0 0 / 55%), transparent);
    pointer-events: none;
    opacity: 0;
    transition: opacity .3s ease;
  }
  .player:has(:global(.player-controls:not(.controls-hidden))) .video-frame::after { opacity: 1; }
  .player:fullscreen .video-frame::after { border-radius: 0; }
  .offline-controls :global(.study.inline .seek) { accent-color: var(--accent); }
  .offline-controls :global(.study.inline .skip-suggestion .primary) {
    background: var(--accent);
    color: #21130c;
  }
  .offline-controls :global(.study.inline .skip-suggestion .primary:hover) { background: #ffa273; }
  .episode-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-inline-start: auto; min-width: 0; }
  .episode-controls select { min-width: 0; max-width: min(220px, 36vw); text-overflow: ellipsis; }
  .episode-controls button, .episode-controls select, .theme-scan {
    font: inherit;
    color: inherit;
    border: 1px solid #ffffff28;
    border-radius: 6px;
    background: #ffffff0c;
    padding: 4px 8px;
  }
  .episode-controls button:hover:not(:disabled) { background: #ffffff20; }
  .episode-heading {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 12px 20px;
    margin: 19px 0 14px;
  }
  .episode-identity { min-width: 0; overflow-wrap: anywhere; flex: 1 1 230px; }
  .episode-identity h2 { font-size: clamp(22px, 3vw, 34px); letter-spacing: -.035em; }
  .series-name { color: var(--accent); font-size: 13px; font-weight: 600; margin-bottom: 3px; }
  .translation-credit { color: var(--muted); font-weight: 400; }
  .watch-actions { display: flex; flex-wrap: wrap; gap: 8px; }
  .watch-actions button, .empty-player a, dialog button {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--surface);
    color: inherit;
    font: inherit;
    font-size: 13px;
    font-weight: 650;
    text-decoration: none;
  }
  .watch-actions .next-episode, .empty-player a { background: var(--accent); color: #21130c; border-color: transparent; }
  .next-episode:hover, .empty-player a:hover { background: #ffa273; }
  .next-episode span:first-child { color: #49271b; }
  .tv-icon { width: 14px; height: 9px; border: 1.5px solid currentColor; border-radius: 2px; position: relative; }
  .tv-icon::after { content: ''; position: absolute; width: 7px; height: 1px; bottom: -4px; left: 3.5px; background: currentColor; }
  .cast-button:hover:not(:disabled), dialog button:hover { background: #252326; }
  dialog { width: min(400px, calc(100% - 56px)); padding: 22px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); color: inherit; }
  dialog::backdrop { background: #000a; }
  dialog p { margin-top: 12px; color: var(--muted); }
  dialog > button, dialog details { margin-top: 12px; }
  .cast-devices { display: grid; gap: 6px; list-style: none; padding: 0; }
  .cast-devices button { width: 100%; text-align: left; }
  dialog form { margin-top: 18px; }
  .episode-bar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
  .predictions { border-top: 1px solid var(--line); padding-top: 13px; }
  .predictions strong { font-size: 13px; margin-inline-end: 4px; }
  .episode-bar button, .episode-bar select {
    font: inherit;
    font-size: 13px;
    color: inherit;
    background: #201f22;
    border: 1px solid #ffffff26;
    border-radius: 6px;
    padding: 5px 9px;
  }
  .episode-bar select { max-width: 100%; min-width: 0; text-overflow: ellipsis; }
  .scan-queue span { min-width: 0; overflow-wrap: anywhere; }
  .prediction:hover:not(:disabled) { background: #302624; border-color: #a45230; }
  .prediction-time, .no-predictions { color: var(--muted); }
  .prediction-time { margin-inline-start: 4px; font-variant-numeric: tabular-nums; }
  .episode-rail {
    min-width: 0;
    align-self: start;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 10px;
    overflow: hidden;
  }
  .rail-heading {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 8px;
    padding: 15px 16px;
    border-bottom: 1px solid var(--line);
  }
  .rail-heading span, .episode-entry small { color: var(--muted); font-size: 12px; }
  .episode-rail ul { position: relative; list-style: none; padding: 5px 0; margin: 0; overflow-y: auto; max-height: min(61dvh, 560px); }
  .episode-entry {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    width: 100%;
    min-height: 50px;
    border: 0;
    border-inline-start: 3px solid transparent;
    background: transparent;
    color: inherit;
    padding: 8px 13px;
    font: inherit;
    text-align: left;
  }
  .episode-entry:hover { background: #242326; }
  .episode-entry[aria-current='true'] { border-inline-start-color: var(--accent); background: #2a211f; }
  .episode-entry-copy { display: grid; gap: 1px; min-width: 0; overflow-wrap: anywhere; }
  .episode-entry strong { font-weight: 620; font-size: 14px; }
  .current-episode { color: var(--accent); font-size: 12px; }
  .episode-play { font-size: 11px; color: var(--muted); }
  .empty-player {
    display: grid;
    justify-items: start;
    align-content: center;
    gap: 12px;
    padding: clamp(24px, 6vw, 70px);
    min-height: 160px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: linear-gradient(120deg, #231a17, var(--surface) 64%);
  }
  .empty-player h2 { font-size: clamp(22px, 3vw, 34px); }
  .empty-player p { color: var(--muted); }
  .watch-tools {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    align-items: start;
    gap: 18px;
    margin-top: 26px;
  }
  .library-tools { display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; padding: 15px 16px; background: var(--surface); border: 1px solid var(--line); border-radius: 10px; min-width: 0; }
  .library-tools p, .scan-queue span, .local-files { color: var(--muted); font-size: 13px; }
  .library-tools label { display: block; margin-bottom: 5px; }
  .settings-tools .setting-check { display: flex; align-items: center; gap: 8px; margin-bottom: 0; font-size: 14px; cursor: pointer; }
  .settings-tools .setting-select { margin-bottom: 0; font-size: 13px; color: var(--muted); }
  .export-tv {
    justify-self: start;
    font: inherit;
    font-size: 13px;
    color: inherit;
    background: #201f22;
    border: 1px solid #ffffff26;
    border-radius: 6px;
    padding: 5px 9px;
  }
  .export-tv:hover, .episode-bar button:hover:not(:disabled) { background: #2a292c; }
  .files { display: grid; gap: 10px; margin-top: 10px; }
  .files input { max-width: 100%; }
  button, summary { cursor: pointer; }
  button:disabled { opacity: .45; cursor: default; }
  :is(a, button, select, summary):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .episode-entry:focus-visible { outline-offset: -3px; }
  .player:fullscreen { display: flex; flex-direction: column; border-radius: 0; }
  .player:fullscreen .video-frame { display: flex; flex: 1 1 0; min-height: 0; }
  .player:fullscreen video { flex: 1 1 0; min-height: 0; max-height: none; aspect-ratio: auto; border-radius: 0; }
  .player:fullscreen :global(.study.inline .panel) { max-height: 35dvh; }
  /* Touch screens such as iPad: finger-sized targets. */
  @media (pointer: coarse) {
    .offline-controls :global(.study.inline :is(button, select)),
    .episode-controls :is(button, select),
    .episode-bar :is(button, select), .export-tv, .watch-actions button, dialog button {
      min-height: 44px;
      min-width: 44px;
    }
    .offline-controls :global(.study.inline .toolbar) { gap: 8px; }
    .offline-controls :global(.study.inline .seek) { height: 36px; }
    .offline-controls :global(.study.inline .seek::-webkit-slider-runnable-track) { height: 8px; border-radius: 4px; }
    .offline-controls :global(.study.inline .seek::-webkit-slider-thumb) { width: 22px; height: 22px; margin-top: -7px; }
    .episode-controls select { padding-inline: 10px; }
    .episode-entry { min-height: 56px; }
    .masthead nav a { padding: 12px 8px; }
    summary { padding-block: 8px; }
  }
  @media (max-width: 860px) {
    .watch-layout.with-episodes, .watch-tools { grid-template-columns: minmax(0, 1fr); }
    .episode-rail ul { max-height: 250px; }
  }
  @media (max-width: 470px) {
    .masthead { gap: 8px; }
    .app-name, .masthead nav { gap: 6px; }
    .watch-layout { margin-top: 15px; gap: 16px; }
    /* The controls are taller than a phone-width video, so place them below it. */
    .player { padding-bottom: 3px; }
    .offline-controls { position: relative; inset: auto; margin: 3px 3px 0; }
    .big-play { width: 64px; height: 64px; margin: -32px 0 0 -32px; font-size: 24px; }
    .episode-controls { margin-inline-start: 0; }
  }
  .folder-cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
    gap: 8px;
    margin: 10px 0 4px;
  }
  .folder-card {
    text-align: left;
    padding: 10px 12px;
    border-radius: 8px;
    border: 1px solid rgba(255, 255, 255, 0.14);
    background: rgba(255, 255, 255, 0.04);
    color: inherit;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .folder-card strong { font-size: 13px; line-height: 1.3; }
  .folder-card small { font-size: 11.5px; opacity: 0.72; }
  .folder-card[aria-current='true'] {
    border-color: #ff6a2b;
    background: rgba(255, 106, 43, 0.14);
  }
  .nav-tab {
    background: transparent;
    border: 1px solid transparent;
    color: inherit;
    padding: 5px 12px;
    border-radius: 999px;
    cursor: pointer;
    font: inherit;
    opacity: 0.78;
  }
  .nav-tab[aria-current='page'] {
    opacity: 1;
    border-color: #ff6a2b;
    background: rgba(255, 106, 43, 0.16);
  }
  .library-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }
  .ws-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    padding: 4px 10px;
    border-radius: 999px;
    border: 1px solid rgba(255, 255, 255, 0.16);
    background: rgba(255, 255, 255, 0.04);
  }
  .ws-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #888;
  }
  .ws-pill[data-state='connected'] .ws-dot { background: #34d399; }
  .ws-pill[data-state='connecting'] .ws-dot { background: #fbbf24; }
  .ws-pill[data-state='disconnected'] .ws-dot { background: #f87171; }
  .pipelines-dashboard {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 12px;
    margin-top: 14px;
  }
  .pipeline-card {
    padding: 12px 14px;
    border-radius: 10px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    background: rgba(255, 255, 255, 0.03);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .pipeline-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 13px;
  }
  .pipeline-card progress { width: 100%; height: 6px; accent-color: #ff6a2b; }
  .pipeline-card small { font-size: 12px; opacity: 0.75; }
  .coverage-list, .event-feed {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 5px;
    font-size: 12px;
  }
  .coverage-item {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .coverage-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
  }
  .coverage-toggle, .job-toggle {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    background: transparent;
    border: 0;
    padding: 2px 0;
    text-align: left;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }
  .job-toggle { width: 100%; }
  .coverage-caret { opacity: 0.65; font-size: 11px; flex-shrink: 0; }
  .coverage-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .coverage-count { opacity: 0.75; font-variant-numeric: tabular-nums; flex-shrink: 0; }
  .coverage-right { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
  .coverage-right button { padding: 2px 8px; font-size: 11px; }
  .coverage-episodes {
    list-style: none;
    margin: 0 0 4px 14px;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 220px;
    overflow-y: auto;
  }
  .coverage-ep-btn {
    width: 100%;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    padding: 4px 8px;
    font-size: 11px;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 6px;
    text-align: left;
  }
  .coverage-ep-btn:hover { background: rgba(255, 255, 255, 0.07); }
  .coverage-ep-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .coverage-ep-state { opacity: 0.75; flex-shrink: 0; font-variant-numeric: tabular-nums; }
  .coverage-ep-state[data-state='checking'] { color: #ff8a5b; opacity: 1; font-weight: 600; }
  .coverage-ep-state[data-state='done'] { color: #34d399; opacity: 1; }
  .event-feed { max-height: 150px; overflow-y: auto; }
  .event-time { opacity: 0.55; font-variant-numeric: tabular-nums; }
  .event-kind { color: #ff8a5b; font-weight: 600; }
  .jobs-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
  .job-row { padding: 8px 10px; border-radius: 8px; background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.08); display: flex; flex-direction: column; gap: 6px; }
  .job-head, .job-foot { display: flex; justify-content: space-between; align-items: center; gap: 8px; font-size: 12px; }
  .job-actions { display: flex; gap: 6px; }
  .job-actions button { padding: 2px 8px; font-size: 11px; }
  [hidden] { display: none !important; }
  .watch-tools.single-pane { grid-template-columns: minmax(0, 1fr); }
  .arc-explainer { display: block; }
  .arc-explainer summary { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .arc-explainer-meta { font-size: 12px; opacity: 0.72; }
  .arc-explainer-body { display: flex; flex-direction: column; gap: 10px; padding-top: 10px; font-size: 13px; line-height: 1.5; }
  .arc-explainer-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .subtitle-upload {
    display: inline-flex; align-items: center; padding: 6px 12px; border-radius: 9px;
    background: var(--surface-raised, rgba(255,255,255,0.08)); border: 1px solid rgba(255,255,255,0.14);
    cursor: pointer; font-size: 12px; font-weight: 600;
  }
  .arc-ep-title, .arc-overview, .arc-section p { margin: 0; }
  .arc-overview { opacity: 0.92; }
  .arc-beats { margin: 4px 0 0; padding-left: 18px; display: flex; flex-direction: column; gap: 4px; opacity: 0.9; }
  .arc-error { color: #f87171; margin: 0; }
</style>
