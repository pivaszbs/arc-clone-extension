<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import type { Snippet } from 'svelte';
  import { requestArc } from './client';
  import { hasJapanese, sourceUrl, type Card, type Cue } from './study';
  import { detectAnimeOpEdIntervals, japaneseCaptions, parseCaptionResponse, subtitleUrl } from './captions';
  import { choices, defaultQuizSettings, words, type Challenge, type ListeningCue, type QuizSettings } from './quiz';
  import { AutoSubtitles, type PageCaptions } from './auto-subtitles';
  import { PhraseStops, placeStudyVideo, readSkipChapters } from './study-player';
  import { overlapsRecap, type VideoThemes } from './video-themes';
  type SkipPart = keyof VideoThemes;
  type EndingAction = 'auto' | 'next' | 'skip';
  let { loadEpisodeCaptions, inline = false, overlayHidden = false, localCues = [], localBody = '', localSource = '', referenceCues = [], videoThemes = {}, title = '', learning = $bindable(false), studying = $bindable(false), autoSkip = $bindable<Record<SkipPart, boolean>>({ recap: true, op: true, ed: true }), endingAction = $bindable<EndingAction>('auto'), showSubtitles = $bindable(true), playerActions, playerOptions, onResumeAtEnd, onToggleFullscreen, onNextEpisode }: {
    loadEpisodeCaptions?: () => Promise<PageCaptions | null>;
    inline?: boolean;
    overlayHidden?: boolean;
    localCues?: Cue[];
    localBody?: string;
    localSource?: string;
    referenceCues?: Cue[][];
    videoThemes?: VideoThemes;
    title?: string;
    learning?: boolean;
    studying?: boolean;
    autoSkip?: Record<SkipPart, boolean>;
    endingAction?: EndingAction;
    showSubtitles?: boolean;
    playerActions?: Snippet;
    playerOptions?: Snippet;
    onResumeAtEnd?: () => void;
    onToggleFullscreen?: () => void;
    /** Offered beside "Skip ending" when another episode can follow. */
    onNextEpisode?: () => void;
  } = $props();
  let open = $state(untrack(() => inline));
  let studyPlayer = $state(false);
  let showSettings = $state(false);
  let showTranscript = $state(false);
  let mode = $state<'watch' | 'learn' | 'review'>(untrack(() => learning ? 'learn' : 'watch'));
  let video = $state<HTMLVideoElement | null>(null);
  let text = $state('');
  let meaning = $state('');
  let cards = $state<Card[]>([]);
  let imported = $state<Cue[]>(untrack(() => localCues));
  let detected = $state<Cue | null>(null);
  let now = $state(Date.now());
  let lastActivity = $state(Date.now());
  let siteOverlayHidden = $state(false);
  let suppressRevealUntil = 0;
  let busy = $state(false);
  let status = $state('');
  let skipUndo = $state<{ time: number; expiresAt: number } | null>(null);
  const skipLabels = { recap: 'Skip recap', op: 'Skip opening', ed: 'Skip ending' };
  const skipParts = ['recap', 'op', 'ed'] as const;
  const skipSettings = { recap: 'Auto-skip recap', op: 'Auto-skip opening', ed: 'Auto-skip ending' };
  const autoSkipKey = 'arc-offline-auto-skip';
  const endingActionKey = 'arc-offline-ending-action';
  const subtitlesKey = 'arc-offline-subtitles';
  const siteAutoSkipKey = 'animeAutoSkip';
  const siteEndingActionKey = 'animeEndingAction';
  const siteSubtitlesKey = 'animeSubtitles';
  const replaceSitePlayerKey = 'animeReplaceSitePlayer';
  // On the anime site, open the Arc player in place of the site's player unless the user turned it off.
  let replaceSitePlayer = $state(true);
  let sitePreferencesLoaded = false;
  let leftSitePlayer = false;
  let siteNextEpisode = $state<{ page: string; url: string | null } | null>(null);
  const nextEpisode = $derived(onNextEpisode ?? (siteNextEpisode?.url ? openSiteNextEpisode : undefined));
  // Endings followed by little more than credits go straight to the next episode; otherwise skip to what follows.
  const endingTail = 20;
  let countdown = $state<{ part: keyof typeof skipLabels; end: number; remaining: number } | null>(null);
  let countdownTime = 0;
  const dismissedSkips = new Set<SkipPart>();
  let subtitleName = $state('');
  let subtitleLink = $state('');
  let loadingSubtitleLink = $state(false);
  let translating = $state(false);
  let selectedSpeed = $state('1');
  let playbackTime = $state(0);
  let playbackPaused = $state(true);
  let playbackMuted = $state(false);
  let playbackReady = $state(false);
  let playbackAttached = $state(false);
  let playbackRequestedAt = $state(0);
  let captionLookupDone = $state(false);
  let subtitleScan = $state<Promise<void> | null>(null);
  let playbackDuration = $state(0);
  let subtitleOffset = $state(0);
  let automaticCues = $state<Cue[]>([]);
  let automaticSource = $state('');
  const automatic = new AutoSubtitles(untrack(() => loadEpisodeCaptions));
  let lastScan = 0;
  let lastPlayerSource = '';
  let importedBody = $state(untrack(() => localBody));
  let automaticBody = $state('');
  let captured = $state<Cue | null>(null);
  let resumeAt = $state<number | null>(null);
  const phraseStops = new PhraseStops();
  const sourceCues = $derived(imported.length ? imported : automaticCues);
  const transcript = $derived(sourceCues.filter(cue => hasJapanese(cue.text) && cue.end + subtitleOffset > 0).map(offsetCue));
  const timeline = $derived([...transcript].sort((a, b) => a.end - b.end));
  let chapters = $state<ReturnType<typeof readSkipChapters>>({});
  const subtitleSegments = $derived(detectAnimeOpEdIntervals(imported.length ? importedBody : automaticBody, sourceCues, playbackDuration,
    importedBody === localBody ? referenceCues : []));
  const combined = $derived(studyPlayer && playbackAttached && !!video);
  // The Netflix-style skip prompts run in offline study and once the Arc player has replaced the site's player.
  const skipControls = $derived(inline || (!!loadEpisodeCaptions && combined));
  const showPlayback = $derived(combined || inline);
  const phraseWords = $derived(captured ? words(captured.text) : []);
  const playbackStatus = $derived(!video ? 'No video found'
    : !playbackAttached ? 'Waiting for the site to provide video'
    : !playbackReady ? 'Waiting for video metadata'
    : playbackPaused ? 'Paused' : 'Playing');
  const subtitleStatus = $derived(sourceCues.length ? `${transcript.length} Japanese subtitle cues loaded`
    : detected ? 'Reading the player’s Japanese captions'
    : inline || captionLookupDone ? 'No Japanese subtitles found' : 'Looking for Japanese subtitles');
  const cardSource = () => localSource || (window === window.top ? location.href : document.referrer || location.href);
  let quizSettings = $state<QuizSettings>({ ...defaultQuizSettings });
  let challenge = $state<Challenge | null>(null);
  let options = $state<string[]>([]);
  let chosen = $state<string | null>(null);
  let result = $state<'correct' | 'incorrect' | null>(null);
  let quizLoading = $state(false);
  let quizError = $state('');
  let quizSaved = $state(false);
  let quizRequest = 0;
  let currentUrl = location.href;
  let previousVideo: HTMLVideoElement | null = null;
  let oldRate: number | null = null;
  let stopAfter: { video: HTMLVideoElement; end: number } | null = null;
  const due = $derived(cards.filter((card) => card.due <= now).sort((a, b) => a.due - b.due));
  const review = $derived(due[0]);
  const fallbackOpening = $derived(playbackReady && !skipRange('op') && !canSkip('recap') && playbackTime < 360
    && playbackTime + 85 < playbackDuration && !captured && !challenge);
  const idlePlayback = $derived(showPlayback && !playbackPaused && !captured && !challenge && mode !== 'review');
  // Never hide the controls while the pointer rests on them: the next click would miss its button.
  let pointerOnControls = $state(false);
  const hideControls = $derived(idlePlayback && !showTranscript && !pointerOnControls && now - lastActivity >= 10000);
  const clock = (time: number) => `${Math.floor(time / 60)}:${String(Math.floor(time % 60)).padStart(2, '0')}`;

  $effect(() => {
    if (combined && open && video) return placeStudyVideo(video);
  });

  $effect(() => {
    if (inline) {
      learning = mode === 'learn';
      studying = !!captured;
    }
  });

  function hideSiteOverlay() {
    video?.focus({ preventScroll: true });
    suppressRevealUntil = performance.now() + 500;
    siteOverlayHidden = true;
  }

  function revealControls() {
    if (siteOverlayHidden) {
      if (performance.now() < suppressRevealUntil) return;
      siteOverlayHidden = false;
    }
    if (showPlayback) lastActivity = Date.now();
  }

  async function toggleSiteFullscreen() {
    if (!video) return;
    hideSiteOverlay();
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
      hideSiteOverlay();
    } catch { /* Keep the overlay hidden even if the frame blocks fullscreen. */ }
  }

  $effect(() => {
    const player = video;
    if (!open || !player) return;
    const modes = new Map<TextTrack, TextTrackMode>();
    function enableChapters() {
      if (!player) return;
      for (const track of player.textTracks) {
        if (track.kind === 'chapters' && track.mode === 'disabled') {
          modes.set(track, track.mode);
          track.mode = 'hidden';
        }
      }
    }
    enableChapters();
    const clearCountdown = () => { countdown = null; };
    player.addEventListener('seeking', clearCountdown);
    player.textTracks.addEventListener('addtrack', enableChapters);
    return () => {
      player.removeEventListener('seeking', clearCountdown);
      player.textTracks.removeEventListener('addtrack', enableChapters);
      for (const [track, mode] of modes) if (track.mode === 'hidden') track.mode = mode;
    };
  });

  function offsetCue(cue: Cue): Cue {
    return { ...cue, start: Math.max(0, cue.start + subtitleOffset), end: cue.end + subtitleOffset };
  }

  function timedCue(cues: Cue[]) {
    if (!video) return null;
    const time = video.currentTime - subtitleOffset;
    const cue = cues.find(item => time >= item.start && time < item.end && hasJapanese(item.text));
    if (!cue) return null;
    return offsetCue(cue);
  }

  function readCue(): ListeningCue | null {
    if (!video) return null;
    const fileCue = timedCue(imported);
    if (fileCue) return fileCue;
    const autoCue = timedCue(automaticCues);
    if (autoCue) return autoCue;
    for (const track of Array.from(video.textTracks)) {
      if (track.language && !/^ja(?:[-_]|$)/i.test(track.language)) continue;
      for (const cue of Array.from(track.activeCues || [])) {
        if (cue instanceof VTTCue && hasJapanese(cue.text)) return { start: cue.startTime, end: cue.endTime, text: cue.text.replace(/<[^>]*>/g, '') };
      }
    }
    const caption = Array.from(document.querySelectorAll('.ytp-caption-segment')).map((node) => node.textContent || '').join(' ').trim();
    if (caption && hasJapanese(caption)) return { start: Math.max(0, video.currentTime - 5), end: Math.max(0.1, video.currentTime), text: caption, estimated: true };
    return null;
  }
  function restoreSpeed() {
    if (previousVideo && oldRate !== null) previousVideo.playbackRate = oldRate;
    previousVideo = null; oldRate = null;
    selectedSpeed = '1';
  }
  function resetSubtitleLookup() {
    automatic.reset();
    subtitleScan = null;
    captionLookupDone = false;
    lastScan = 0;
    automaticCues = [];
    automaticSource = '';
    automaticBody = '';
  }
  function tick() {
    now = Date.now();
    if (currentUrl !== location.href) {
      currentUrl = location.href; imported = []; importedBody = ''; subtitleName = ''; stopAfter = null;
      subtitleOffset = 0;
      subtitleLink = '';
      leftSitePlayer = false;
      siteNextEpisode = null;
      text = ''; meaning = ''; captured = null; restoreSpeed();
      challenge = null; captured = null; resumeAt = null; quizRequest++; phraseStops.reset(); resetSubtitleLookup();
      playbackRequestedAt = 0;
    }
    if (!open) {
      replaceSitePlayerWhenReady();
      return;
    }
    const nextVideo = combined && video?.isConnected ? video
      : Array.from(document.querySelectorAll('video')).filter((v) => v.getBoundingClientRect().width > 0).sort((a, b) => Number(b === document.activeElement) - Number(a === document.activeElement) || b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0] || null;
    if (video !== nextVideo) { stopAfter = null; restoreSpeed(); challenge = null; captured = null; resumeAt = null; quizRequest++; phraseStops.reset(); resetSubtitleLookup(); playbackRequestedAt = 0; }
    video = nextVideo;
    const playerSource = video?.currentSrc || '';
    if (playerSource !== lastPlayerSource) {
      subtitleOffset = 0;
      skipUndo = null;
      countdown = null;
      dismissedSkips.clear();
      lastPlayerSource = playerSource; resetSubtitleLookup();
      challenge = null; captured = null; resumeAt = null; quizRequest++; phraseStops.reset();
    }
    playbackTime = video?.currentTime || 0;
    const paused = video?.paused ?? true;
    if (playbackPaused && !paused) lastActivity = now;
    playbackPaused = paused;
    if (showSettings && idlePlayback && now - lastActivity >= 4000) showSettings = false;
    playbackMuted = video?.muted ?? false;
    playbackReady = !!video && video.readyState >= 1;
    playbackAttached = !!video && !!(playbackReady || video.srcObject || video.getAttribute('src') || video.querySelector('source[src]'));
    playbackDuration = video && Number.isFinite(video.duration) ? video.duration : 0;
    const nextChapters = video ? readSkipChapters(video) : {};
    if (['op', 'ed'].some(key => {
      const part = key as 'op' | 'ed';
      return chapters[part]?.start !== nextChapters[part]?.start || chapters[part]?.end !== nextChapters[part]?.end;
    })) chapters = nextChapters;
    if (!inline && !imported.length && !subtitleScan && now - lastScan >= 1500) {
      lastScan = now;
      const scan = automatic.scan(video);
      subtitleScan = scan;
      void scan.then(() => {
        if (subtitleScan === scan && open) {
          captionLookupDone = true;
          if (automaticSource !== automatic.source || automaticCues.length !== automatic.cues.length || automaticBody !== automatic.body) {
            automaticCues = automatic.cues;
            automaticSource = automatic.source;
            automaticBody = automatic.body;
          }
        }
      }).catch(() => {
        if (subtitleScan === scan) captionLookupDone = true;
      }).finally(() => {
        if (subtitleScan === scan) subtitleScan = null;
      });
    }
    detected = readCue();
    if (stopAfter && (stopAfter.video.currentTime >= stopAfter.end || stopAfter.video.ended)) {
      stopAfter.video.pause();
      stopAfter = null;
    }
    if (mode === 'learn' && quizSettings.chance > 0 && video && !stopAfter && !captured && !video.seeking && (!video.paused || video.ended)) {
      const next = phraseStops.observe(timeline, detected, playbackTime, quizSettings.chance);
      if (next) inspectPhrase(next);
    }
    if (skipControls) {
      if (loadEpisodeCaptions && siteNextEpisode?.page !== location.href) lookupSiteNextEpisode();
      updateSkipCountdown();
    } else countdown = null;
  }
  async function load() {
    try { const response = await requestArc({ type: 'JAPANESE_LIST' }); cards = response.cards; quizSettings = response.settings || { ...defaultQuizSettings }; }
    catch { status = 'Could not load saved phrases. Reload the extension and this page.'; }
  }
  function seek(time: number) {
    if (!video || !Number.isFinite(time)) return;
    stopAfter = null;

    phraseStops.reset();
    video.currentTime = Math.max(0, Math.min(playbackDuration || time, time));
    tick();
  }

  function handlePlayerKey(event: KeyboardEvent) {
    if (event.key !== 'f' && event.key !== 'F') revealControls();
    if (!showPlayback || !open) return;
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const target = event.target;
    if (target instanceof HTMLElement && (target.isContentEditable || target.closest('input:not(.seek), textarea, select, summary'))) return;

    if (event.key === 'f' || event.key === 'F') {
      if (onToggleFullscreen) {
        event.preventDefault();
        if (!event.repeat) onToggleFullscreen();
        return;
      }
      if (combined) {
        event.preventDefault();
        if (!event.repeat) void toggleSiteFullscreen();
        return;
      }
    }

    if (!inline) return;

    if (!video || video.readyState < 1 || captured || challenge || mode === 'review') return;
    if (event.key === ' ' && !(target instanceof HTMLElement && target.closest('button, a[href]'))) {
      event.preventDefault();
      if (!event.repeat) void togglePlayback();
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      seek(video.currentTime + (event.key === 'ArrowLeft' ? -5 : 5));
    }
  }

  async function togglePlayback() {
    if (!video) return;
    if (studyPlayer && !playbackAttached) {
      const start = video.closest('.video-js')?.querySelector<HTMLElement>('.vjs-big-play-button');
      if (start?.getClientRects().length) {
        playbackRequestedAt = Date.now();
        start.click();
      } else status = 'Start playback with the site’s Play button.';
      return;
    }
    if (!video.paused) video.pause();
    else {
      try { await video.play(); }
      catch { status = 'Playback could not start. Try the original player.'; }
    }
    tick();
  }
  async function copyPlaybackReport() {
    const manifest = globalThis.chrome?.runtime?.getManifest?.();
    const report = [
      manifest ? `${manifest.name} ${manifest.version}` : 'Anime Study',
      `Video: ${playbackStatus}`,
      `Position: ${clock(playbackTime)} / ${clock(playbackDuration)}`,
      `Subtitles: ${subtitleStatus}`,
      video?.error ? `Media error code: ${video.error.code}` : '',
    ].filter(Boolean).join('\n');
    try {
      await navigator.clipboard.writeText(report);
      status = 'Playback report copied.';
    } catch { status = 'Chrome blocked clipboard access. Open Playback details to read the report.'; }
  }
  function adjustSubtitleTiming(amount: number) {
    subtitleOffset += amount;
    stopAfter = null;

    phraseStops.reset();
    tick();
  }
  function openStudy() {
    open = true;
    if (loadEpisodeCaptions) studyPlayer = true;
    tick();
    void load();
  }
  onMount(() => {
    if (inline) {
      try {
        const legacy = localStorage.getItem(autoSkipKey) !== 'off';
        for (const part of skipParts) {
          const saved = localStorage.getItem(`${autoSkipKey}-${part}`);
          autoSkip[part] = saved === null ? (part === 'recap' || legacy) : saved === 'on';
        }
        const savedAction = localStorage.getItem(endingActionKey);
        if (savedAction === 'auto' || savedAction === 'next' || savedAction === 'skip') endingAction = savedAction;
        showSubtitles = localStorage.getItem(subtitlesKey) !== 'off';
      } catch { /* Use the default. */ }
    } else if (loadEpisodeCaptions) {
      void siteStorage()?.get([siteAutoSkipKey, ...skipParts.map(part => `${siteAutoSkipKey}-${part}`), siteEndingActionKey, siteSubtitlesKey, replaceSitePlayerKey]).then(saved => {
        for (const part of skipParts) {
          const preference = saved[`${siteAutoSkipKey}-${part}`];
          autoSkip[part] = typeof preference === 'boolean' ? preference : (part === 'recap' || saved[siteAutoSkipKey] !== false);
        }
        const savedAction = saved[siteEndingActionKey];
        if (savedAction === 'auto' || savedAction === 'next' || savedAction === 'skip') endingAction = savedAction;
        showSubtitles = saved[siteSubtitlesKey] !== false;
        replaceSitePlayer = saved[replaceSitePlayerKey] !== false;
      }).catch(() => {}).finally(() => { sitePreferencesLoaded = true; });
      if (!siteStorage()) sitePreferencesLoaded = true;
    }
    void load();
    const timer = setInterval(tick, 100);
    return () => { clearInterval(timer); automatic.reset(); restoreSpeed(); };
  });
  async function replayPhrase() {
    if (!video || !captured) return;
    try {
      video.currentTime = captured.start;
      stopAfter = { video, end: captured.end };
      await video.play();
    } catch {
      stopAfter = null;
      status = 'Could not replay this phrase.';
    }
  }

  function inspectPhrase(cue: Cue) {
    if (video) {
      resumeAt ??= video.currentTime;
      video.pause();
      playbackPaused = true;
    }
    mode = 'learn';

    stopAfter = null;
    captured = { ...cue };
    text = cue.text;
    meaning = cards.find(card => card.text === cue.text)?.meaning || '';
    status = '';
  }

  async function resumePhrase() {
    if (busy) return;
    const time = resumeAt;
    captured = null;
    resumeAt = null;
    stopAfter = null;
    status = '';
    if (!video) return;
    if (inline && time !== null && time >= playbackDuration && playbackDuration > 0) {
      onResumeAtEnd?.();
      return;
    }
    if (time !== null && Math.abs(video.currentTime - time) > 0.05) video.currentTime = time;
    try { await video.play(); } catch { status = 'Press Play to continue.'; }
    tick();
  }

  function switchMode(next: typeof mode) {
    if (next === mode) return;
    if (captured && next === 'watch') void resumePhrase();
    else {
      captured = null;
      resumeAt = null;
      stopAfter = null;

    }
    mode = next;
    phraseStops.reset();
    if (next === 'review') { video?.pause(); void load(); }
  }

  function siteStorage() {
    return globalThis.chrome?.storage?.local;
  }

  function setAutoSkip(part: SkipPart, enabled: boolean) {
    autoSkip[part] = enabled;
    if (!enabled && countdown?.part === part) countdown = null;
    if (!inline) {
      void siteStorage()?.set({ [`${siteAutoSkipKey}-${part}`]: enabled }).catch(() => {});
      return;
    }
    try { localStorage.setItem(`${autoSkipKey}-${part}`, enabled ? 'on' : 'off'); } catch { /* Keep the current preference. */ }
  }

  function setShowSubtitles(enabled: boolean) {
    showSubtitles = enabled;
    if (!inline) {
      void siteStorage()?.set({ [siteSubtitlesKey]: enabled }).catch(() => {});
      return;
    }
    try { localStorage.setItem(subtitlesKey, enabled ? 'on' : 'off'); } catch { /* Keep the current preference. */ }
  }

  function setReplaceSitePlayer(enabled: boolean) {
    replaceSitePlayer = enabled;
    void siteStorage()?.set({ [replaceSitePlayerKey]: enabled }).catch(() => {});
  }

  function replaceSitePlayerWhenReady() {
    if (!loadEpisodeCaptions || inline || !replaceSitePlayer || !sitePreferencesLoaded || leftSitePlayer) return;
    if (!Array.from(document.querySelectorAll('video')).some(item => item.getBoundingClientRect().width > 0)) return;
    openStudy();
  }

  function lookupSiteNextEpisode() {
    const page = location.href;
    siteNextEpisode = { page, url: null };
    void requestArc({ type: 'ANIME_NEXT_EPISODE_LINK' }).then(response => {
      if (siteNextEpisode?.page === page) siteNextEpisode = { page, url: typeof response?.url === 'string' ? response.url : null };
    }).catch(() => {});
  }

  function openSiteNextEpisode() {
    const url = siteNextEpisode?.url;
    if (!url) return;
    void requestArc({ type: 'ANIME_OPEN_EPISODE', url }).then(response => {
      if (response?.error) status = response.error;
    }).catch(() => { status = 'Could not open the next episode.'; });
  }

  function setEndingAction(next: EndingAction) {
    endingAction = next;
    if (!inline) {
      void siteStorage()?.set({ [siteEndingActionKey]: next }).catch(() => {});
      return;
    }
    try { localStorage.setItem(endingActionKey, next); } catch { /* Keep the current preference. */ }
  }

  function endingGoesNext(end: number) {
    if (!nextEpisode) return false;
    if (endingAction === 'next') return true;
    if (endingAction === 'skip') return false;
    return playbackDuration - end <= endingTail;
  }

  function playNextEpisode() {
    if (!nextEpisode) return;
    dismissedSkips.add('ed');
    countdown = null;
    nextEpisode();
  }

  function keepWatching() {
    if (!countdown) return;
    dismissedSkips.add(countdown.part);
    countdown = null;
  }

  function updateSkipCountdown() {
    if (!video || video.seeking || mode === 'review' || stopAfter) {
      countdown = null;
      return;
    }
    const part = skipParts.find(part => autoSkip[part] && !dismissedSkips.has(part) && canSkip(part)
      && playbackTime >= (skipRange(part)?.start ?? Infinity));
    const range = part && skipRange(part);
    if (!part || !range) {
      countdown = null;
      return;
    }
    if (countdown?.part !== part || countdown.end !== range.end) {
      countdown = video.paused ? null : { part, end: range.end, remaining: 5 };
      countdownTime = playbackTime;
      return;
    }
    if (!video.paused && video.playbackRate > 0) {
      countdown.remaining -= Math.max(0, playbackTime - countdownTime) / video.playbackRate;
    }
    countdownTime = playbackTime;
    if (countdown.remaining <= 0) {
      if (part === 'ed' && endingGoesNext(range.end)) playNextEpisode();
      else skipPart(part);
    }
  }

  function skipPart(part: SkipPart) {
    const segment = skipRange(part);
    if (segment && canSkip(part)) {
      dismissedSkips.add(part);
      countdown = null;
      if (video) skipUndo = { time: video.currentTime, expiresAt: Date.now() + 10000 };
      seek(segment.end);
    } else if (part === 'op' && fallbackOpening && video) {
      const time = video.currentTime;
      skipUndo = { time, expiresAt: Date.now() + 10000 };
      seek(time + 85);
    }
  }

  function undoSkip() {
    if (skipUndo === null) return;
    const { time } = skipUndo;
    skipUndo = null;
    seek(time);
  }

  function skipRange(part: SkipPart) {
    if (part === 'recap') return videoThemes.recap;
    const segment = subtitleSegments[part];
    const subtitleRange = segment ? { start: segment.start + subtitleOffset, end: segment.end + subtitleOffset } : null;
    const frames = videoThemes[part];
    if (chapters[part]) return chapters[part];
    // Theme lyrics usually start after the intro music and stop before the outro, so a frame match is more exact.
    const range = frames && (!subtitleRange || (frames.start < subtitleRange.end && frames.end > subtitleRange.start))
      ? frames : (segment?.source !== 'dialogue-gap' && subtitleRange) || frames || subtitleRange;
    return part === 'op' && overlapsRecap(range || undefined, videoThemes.recap) ? undefined : range;
  }

  /** Used by touch gestures on the offline player. Returns false while a phrase or quiz holds playback. */
  export function seekBy(seconds: number) {
    if (!video || video.readyState < 1 || captured || challenge || mode === 'review') return false;
    seek(video.currentTime + seconds);
    lastActivity = Date.now();
    return true;
  }

  export function togglePlay() {
    if (!video || captured || challenge) return false;
    void togglePlayback();
    return true;
  }

  export function playbackSkipRanges(): VideoThemes {
    const ranges: VideoThemes = {};
    for (const part of skipParts) {
      const range = skipRange(part);
      if (range) ranges[part] = { start: Math.max(0, range.start), end: range.end };
    }
    return ranges;
  }

  function canSkip(part: SkipPart) {
    const segment = skipRange(part);
    return playbackReady && !!segment && segment.end > playbackTime && segment.end <= playbackDuration + 0.5
      && playbackTime >= Math.max(0, segment.start - 1) && !captured && !challenge;
  }

  async function pictureInPicture() {
    if (!video) return;
    try {
      if (document.pictureInPictureElement === video) await document.exitPictureInPicture();
      else await video.requestPictureInPicture();
    } catch { status = 'Picture in picture could not start.'; }
  }

  async function translate() {
    const phrase = text.trim();
    if (!phrase) return;
    translating = true;
    try {
      const response = await requestArc({ type: 'TRANSLATE_TEXT', text: phrase, sourceLang: 'ja', targetLang: 'en' });
      if (!response.translatedText) throw new Error('Translation unavailable');
      if (text.trim() === phrase) meaning = response.translatedText;
      status = 'Machine translation. Check the meaning in context before saving.';
    } catch { status = 'Translation unavailable. You can still enter the meaning yourself.'; }
    finally { translating = false; }
  }
  async function save() {
    if (!captured || !text.trim() || !meaning.trim()) { status = 'Add both the Japanese phrase and its meaning.'; return; }
    if (!hasJapanese(text)) { status = 'Use Japanese characters for the phrase.'; return; }
    busy = true;
    try {
      const range = captured;
      const url = cardSource();
      const response = await requestArc({ type: 'JAPANESE_SAVE', card: { ...range, text: text.trim(), meaning: meaning.trim(), url, title: title || document.title } });
      cards = response.cards;
      status = 'Phrase saved.';
    } catch (error) { status = error instanceof Error ? error.message : 'Could not save. Try again.'; }
    finally { busy = false; }
  }
  async function beginQuiz(next: Challenge) {
    const request = ++quizRequest;
    // Native iPad video fullscreen cannot contain HTML quiz controls.
    const nativeVideo = video as (HTMLVideoElement & { webkitDisplayingFullscreen?: boolean; webkitExitFullscreen?: () => void }) | null;
    if (nativeVideo?.webkitDisplayingFullscreen) nativeVideo.webkitExitFullscreen?.();
    if (video && document.fullscreenElement === video && document.exitFullscreen) void document.exitFullscreen().catch(() => {});
    challenge = { ...next, cue: { ...next.cue } }; chosen = null; result = null; quizSaved = false; quizError = ''; options = [];
    quizLoading = true; status = '';
    try {
      const expected = next.meaning || (await requestArc({ type: 'TRANSLATE_TEXT', text: next.cue.text, sourceLang: 'ja', targetLang: 'en' })).translatedText;
      if (!expected || typeof expected !== 'string') throw new Error('Translation unavailable');
      if (request !== quizRequest || !challenge) return;
      if (challenge) { challenge.meaning = expected; options = choices(expected, cards); }
    } catch { if (request === quizRequest) quizError = 'Could not prepare the answers. Retry or skip; your progress will not change.'; }
    finally { if (request === quizRequest) quizLoading = false; }
  }
  async function answerQuiz(answer: string | null) {
    if (!challenge || result || busy || quizLoading) return;
    chosen = answer; result = answer === challenge.meaning ? 'correct' : 'incorrect';
    await saveQuizResult();
  }
  async function saveQuizResult() {
    if (!challenge || !result || busy || quizSaved) return;
    busy = true; quizError = '';
    try {
      let id = challenge.cardId;
      if (!id) {
        const url = cardSource();
        const existing = cards.find((card) => card.text === challenge!.cue.text && card.url === url);
        if (existing) id = existing.id;
        else {
          const saved = await requestArc({ type: 'JAPANESE_SAVE', card: { ...challenge.cue, text: challenge.cue.text, meaning: challenge.meaning, url, title: title || document.title } });
          cards = saved.cards;
          id = cards.find((card) => card.text === challenge!.cue.text && card.url === url)?.id;
        }
      }
      if (!id) throw new Error('Could not find the saved phrase');
      cards = (await requestArc({ type: 'JAPANESE_GRADE', id, remembered: result === 'correct' })).cards;
      quizSaved = true; now = Date.now();
    } catch { quizError = 'Your answer was checked but progress was not saved. Retry saving before continuing.'; }
    finally { busy = false; }
  }
  async function continueQuiz() {
    if (busy) return;
    challenge = null; quizRequest++; quizLoading = false; phraseStops.reset(); quizError = '';
  }
  async function setChance(event: Event) {
    const chance = Number((event.currentTarget as HTMLSelectElement).value);
    quizSettings = { chance };
    phraseStops.reset();
    try { quizSettings = (await requestArc({ type: 'JAPANESE_QUIZ_SETTINGS', settings: { chance } })).settings; }
    catch { status = 'Could not save quiz frequency.'; }
  }
  function closePanel() {
    if (loadEpisodeCaptions) leftSitePlayer = true;
    skipUndo = null;
    studyPlayer = false; showSettings = false; showTranscript = false;
    open = false; captured = null; resumeAt = null; stopAfter = null; challenge = null; quizRequest++; quizLoading = false; phraseStops.reset(); restoreSpeed();
    resetSubtitleLookup();
    playbackRequestedAt = 0;
  }
  async function importSubtitleLink() {
    const url = subtitleLink.trim();
    if (!subtitleUrl(url)) { status = 'Paste a direct HTTPS link to the episode’s subtitle file.'; return; }
    const page = location.href;
    const player = video;
    const source = player?.currentSrc;
    loadingSubtitleLink = true;
    try {
      const { body } = await requestArc({ type: 'JAPANESE_FETCH_CAPTIONS', url });
      if (!open || page !== location.href || player !== video || source !== video?.currentSrc) return;
      const cues = parseCaptionResponse(body);
      if (!japaneseCaptions(cues, true)) { status = 'This file has no readable Japanese subtitle lines.'; return; }
      imported = cues; importedBody = body;
      subtitleName = 'Subtitle download link';
      subtitleOffset = 0;

      phraseStops.reset();
      status = `Loaded ${cues.length} lines from the subtitle link.`;
    } catch {
      if (open && page === location.href) status = 'Could not load that link. Download the subtitle file and open it here instead.';
    } finally { loadingSubtitleLink = false; }
  }
  async function importFile(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > 5000000) { status = 'Choose a subtitle file smaller than 5 MB.'; return; }
    try {
      const textBody = await file.text();
      const cues = parseCaptionResponse(textBody);
      if (!cues.some((cue) => hasJapanese(cue.text))) { status = 'No Japanese SRT / VTT / ASS lines found.'; return; }
      imported = cues; importedBody = textBody; subtitleName = file.name;
      status = `Loaded ${cues.length} lines from ${file.name}. Timings must match this video.`;
    } catch { status = 'Could not read that subtitle file.'; }
    input.value = '';
  }
  function exportCards() {
    const blob = new Blob([JSON.stringify(cards, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = 'arc-japanese-phrases.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function speed(event: Event) {
    if (!video) return;
    const value = (event.currentTarget as HTMLSelectElement).value;
    if (previousVideo !== video) { restoreSpeed(); previousVideo = video; oldRate = video.playbackRate; }
    selectedSpeed = value;
    video.playbackRate = Number(value);
  }
</script>

<svelte:document onfullscreenchange={() => {
  if (siteOverlayHidden) suppressRevealUntil = Math.max(suppressRevealUntil, performance.now() + 500);
}} />
<svelte:window onpointermove={revealControls} onpointerdown={revealControls} onkeydown={handlePlayerKey} />

{#snippet timelineControls()}
  <input aria-label="Playback position" class="seek" style:--progress={`${playbackDuration ? Math.min(100, playbackTime / playbackDuration * 100) : 0}%`} type="range" min="0" max={playbackDuration || 1} step="0.1" value={playbackTime} disabled={!playbackDuration || !!captured || !!challenge} oninput={event => seek(event.currentTarget.valueAsNumber)} />
  <span class="clock">{clock(playbackTime)} / {clock(playbackDuration)}</span>
{/snippet}

{#if combined}<div class="backdrop" aria-hidden="true"></div>{/if}
<div class="study" class:combined class:inline class:waiting={studyPlayer && !combined}>
  {#if open}
    {#if countdown}
      {@const goesNext = countdown.part === 'ed' && endingGoesNext(countdown.end)}
      <div class="skip-suggestion" role="group" aria-label={skipLabels[countdown.part]}>
        {#if countdown.part === 'ed' && nextEpisode}
          <button class:primary={goesNext} onclick={playNextEpisode}>Next episode</button>
        {/if}
        <button class:primary={!goesNext} onclick={() => countdown && skipPart(countdown.part)}>{skipLabels[countdown.part]}</button>
        <span>{goesNext ? 'Next episode' : 'Skipping'} in {Math.max(1, Math.ceil(countdown.remaining))} s</span>
        <button onclick={keepWatching}>Keep watching</button>
      </div>
    {:else if skipControls && skipUndo && now < skipUndo.expiresAt}
      <div class="skip-suggestion">
        <button onclick={undoSkip}>Undo skip</button>
      </div>
    {:else if inline && !overlayHidden && mode !== 'review' && canSkip('recap')}
      <div class="skip-suggestion">
        <button class="primary" onclick={() => skipPart('recap')}>Skip recap</button>
      </div>
    {/if}
    <section aria-label="Japanese learning" class="panel" hidden={overlayHidden || siteOverlayHidden}>
      {#if !challenge && mode !== 'review' && !captured && ((studyPlayer && !combined) || (showSubtitles && detected) || (mode === 'learn' && !sourceCues.length))}
        <div class="caption-row">
          {#if studyPlayer && !combined}
            <span class="notice">{playbackRequestedAt && now - playbackRequestedAt >= 5000
              ? 'The site hasn’t supplied video yet. Try its Play button.'
              : 'Start the video to switch to the Arc player.'}</span>
          {:else if showSubtitles && detected}
            <button class="caption" lang="ja" title="Study this subtitle" onclick={() => detected && inspectPhrase(detected)}>{detected.text}</button>
          {:else if !sourceCues.length}
            <span class="notice">{video ? subtitleStatus : 'Start the video to connect'}</span>
          {/if}
        </div>
      {/if}
      <div class="player-controls" class:controls-hidden={hideControls} role="group" aria-label="Player controls"
        onpointerenter={event => { if (event.pointerType === 'mouse') pointerOnControls = true; }}
        onpointerleave={() => { pointerOnControls = false; lastActivity = Date.now(); }}>
      {#if inline}<div class="playback-timeline">{@render timelineControls()}</div>{/if}
      <div class="toolbar">
        {#if showPlayback || studyPlayer}
          <button aria-label={playbackPaused ? 'Play' : 'Pause'} onclick={togglePlayback} disabled={!video || !!captured || !!challenge}>{playbackPaused ? '▶' : '❚❚'}</button>
        {/if}
        {#if showPlayback && !inline}{@render timelineControls()}{/if}
        {#if showPlayback && (loadEpisodeCaptions || inline)}
          {#if !skipControls && skipUndo && now < skipUndo.expiresAt}
            <button onclick={undoSkip}>Undo skip</button>
          {/if}
          {#if (canSkip('op') && countdown?.part !== 'op') || (fallbackOpening && (!skipUndo || now >= skipUndo.expiresAt))}
            <button onclick={() => skipPart('op')}>{fallbackOpening ? 'Skip opening (+85s)' : 'Skip opening'}</button>
          {/if}
          {#if canSkip('ed') && countdown?.part !== 'ed'}
            <button onclick={() => skipPart('ed')}>Skip ending</button>
            {#if nextEpisode}<button onclick={playNextEpisode}>Next episode</button>{/if}
          {/if}
        {/if}
        <button class="active" class:learning={mode === 'learn'} aria-pressed={mode === 'learn'} disabled={!!challenge} onclick={() => switchMode(mode === 'learn' ? 'watch' : 'learn')}>Learn</button>
        <button aria-label="Player options" title="Player options" aria-expanded={showSettings} onclick={() => {
          showSettings = !showSettings;
          if (showSettings) lastActivity = Date.now();
        }}>⋯</button>
        {@render playerActions?.()}
        {#if !inline}
          <button data-study-player aria-pressed={studyPlayer} aria-label={studyPlayer ? 'Return to page player' : 'Close Japanese panel'} title={studyPlayer ? 'Return to page player' : 'Close Japanese panel'} disabled={busy} onclick={closePanel}>×</button>
        {/if}
      </div>
      {#if showSettings}
        <div class="extras" aria-label="Player options">
          {@render playerOptions?.()}
          {#if inline || loadEpisodeCaptions}
            {#each skipParts as part}
              {#if inline || part !== 'recap'}
                <label><input type="checkbox" checked={autoSkip[part]} onchange={event => setAutoSkip(part, event.currentTarget.checked)} /> {skipSettings[part]}</label>
              {/if}
            {/each}
            <label>Ending skip <select aria-label="Ending skip action" value={endingAction} onchange={event => setEndingAction(event.currentTarget.value as EndingAction)}>
              <option value="auto">Auto (next episode or post-credits)</option>
              <option value="next">Next episode</option>
              <option value="skip">Skip ending only</option>
            </select></label>
          {/if}
          <label><input type="checkbox" checked={showSubtitles} onchange={event => setShowSubtitles(event.currentTarget.checked)} /> Show subtitles</label>
          {#if loadEpisodeCaptions}<label><input type="checkbox" checked={replaceSitePlayer} onchange={event => setReplaceSitePlayer(event.currentTarget.checked)} /> Always use the Arc player on this site</label>{/if}
          {#if video}<button onclick={() => { if (video) { video.muted = !video.muted; tick(); } }}>{playbackMuted ? 'Unmute' : 'Mute'}</button>{/if}
          {#if showPlayback && document.pictureInPictureEnabled}<button disabled={!playbackReady} onclick={pictureInPicture}>Picture in picture</button>{/if}
          <label>Speed <select aria-label="Playback speed" disabled={!video} bind:value={selectedSpeed} onchange={speed}><option value="1">Normal</option><option value="0.85">0.85×</option><option value="0.7">0.7×</option></select></label>
          <button disabled={!!challenge} onclick={() => { switchMode(mode === 'review' ? 'watch' : 'review'); showSettings = false; }}>Review · {due.length}</button>
          <button disabled={!cards.length} onclick={exportCards}>Export phrases</button>
          <details>
            <summary>Subtitles</summary>
            {#if sourceCues.length}
              <div class="controls">
                <button onclick={() => adjustSubtitleTiming(-0.5)}>Earlier</button>
                <span>Timing {subtitleOffset > 0 ? '+' : ''}{subtitleOffset.toFixed(1)}s</span>
                <button onclick={() => adjustSubtitleTiming(0.5)}>Later</button>
              </div>
            {/if}
            {#if subtitleName || automaticSource}<p class="notice">{subtitleName || automaticSource}</p>{/if}
            <input aria-label="Japanese subtitle file" type="file" accept=".srt,.vtt,.ass,.ssa" onchange={importFile} />
            {#if loadEpisodeCaptions}
              <label>Subtitle URL <input type="url" bind:value={subtitleLink} /></label>
              <button onclick={importSubtitleLink} disabled={loadingSubtitleLink || !subtitleLink.trim()}>Load subtitle link</button>
            {/if}
          </details>
          <details>
            <summary>Playback details</summary>
            <p class="notice">{playbackStatus} · {clock(playbackTime)} / {clock(playbackDuration)}</p>
            <p class="notice">{subtitleStatus}</p>
            {#if !inline && !sourceCues.length}
              <button disabled={!!subtitleScan} onclick={() => { resetSubtitleLookup(); tick(); }}>Retry subtitles</button>
            {/if}
            <button onclick={copyPlaybackReport}>Copy playback report</button>
          </details>
        </div>
      {/if}
      {#if challenge}
        <p class="hint">What does this phrase mean?</p>
        <div class="caption" lang="ja">{challenge.cue.text}</div>
        {#if quizLoading}<p role="status">Preparing translations…</p>{/if}
        <div class="quiz-options">{#each options as option}<button disabled={!!result || busy} class:correct={!!result && option === challenge.meaning} class:wrong={result === 'incorrect' && option === chosen} onclick={() => answerQuiz(option)}>{option}</button>{/each}</div>
        {#if !result && options.length}<button disabled={busy} onclick={() => answerQuiz(null)}>I don’t know yet</button>{/if}
        {#if result}<p role="status">{result === 'correct' ? 'Correct. This phrase will return later.' : 'The highlighted answer is the translation. This phrase will return sooner.'}</p><p class="hint">{challenge.meaning}</p>{/if}
        {#if quizError}<p class="status" role="alert">{quizError}</p><button disabled={busy} onclick={() => result ? saveQuizResult() : challenge && beginQuiz(challenge)}>Retry</button>{/if}
        {#if result}<button class="primary" disabled={busy || !quizSaved} onclick={continueQuiz}>Next review</button>{:else}<button disabled={busy} onclick={continueQuiz}>Skip without changing progress</button>{/if}
        <p class="hint">Translations may be machine generated. Your answer updates the review schedule automatically.</p>
      {:else if mode === 'review' && review}
        <p class="hint">Answer a translation question. The result schedules your next review automatically.</p><button class="primary" onclick={() => { if (video) video.pause(); void beginQuiz({ cue: review, kind: 'known', unknown: [], meaning: review.meaning, cardId: review.id }); }}>Start next review</button>
        {#if sourceUrl(review.url, review.start)}<a href={sourceUrl(review.url, review.start)} target="_blank" rel="noopener noreferrer">Open source · {clock(review.start)}</a>{/if}
      {:else if mode === 'review'}<div class="caption">{cards.length ? 'You’re caught up.' : 'Your first phrase starts here.'}</div><p class="hint">{cards.length ? 'Come back when a phrase is due. Remembered phrases return after 1, 2, 4 days and longer.' : 'Capture a phrase while watching, add its meaning, then come here to practise remembering it.'}</p>{/if}
      {#if mode === 'learn' && !challenge}
        <div class="learn-bar">
          <label>Pause to study <select value={String(quizSettings.chance)} onchange={setChance}>
            <option value="0">Never</option><option value="0.1">Random · 10%</option><option value="0.25">Random · 25%</option><option value="0.5">Random · 50%</option><option value="1">Every phrase</option>
          </select></label>
          {#if transcript.length}
            <details bind:open={showTranscript}>
              <summary>Transcript</summary>
              {#if showTranscript}
                <div class="transcript">
                  {#each transcript as cue}
                    <button lang="ja" onclick={() => { inspectPhrase(cue); showTranscript = false; }}>
                      <span class="clock">{clock(cue.start)}</span> {cue.text}
                    </button>
                  {/each}
                </div>
              {/if}
            </details>
          {/if}
        </div>
      {/if}
      {#if captured}
        <div class="phrase">
          <p class="phrase-text" lang="ja">{captured.text}</p>
          {#if phraseWords.length}<p class="words" lang="ja">{phraseWords.join(' · ')}</p>{/if}
          <div class="controls">
            <button disabled={!video} onclick={replayPhrase}>Replay</button>
          {#if !inline}<button disabled={translating} title="Send this phrase to Google Translate" onclick={translate}>{translating ? 'Translating…' : 'Translate'}</button>{/if}
            <button class="active" disabled={busy} onclick={resumePhrase}>Continue</button>
          </div>
          <div class="controls">
            <input aria-label="Meaning" bind:value={meaning} placeholder="Add a meaning" />
            <button disabled={busy || !meaning.trim()} onclick={save}>Save phrase</button>
          </div>
        </div>
      {/if}
      {#if status}<p class="notice" role="status">{status}</p>{/if}
      </div>
    </section>
  {:else if !inline}
    <button class="launcher" hidden={!!loadEpisodeCaptions} aria-expanded={open} onclick={openStudy}>{loadEpisodeCaptions ? 'Arc player' : 'Learn Japanese'}</button>
  {/if}
</div>

<style>
  :host { all: initial; }
  * { box-sizing: border-box; }
  .backdrop { position: fixed; inset: 0; background: #0d0d12; z-index: 2147483644; }
  .study { position: fixed; right: 12px; bottom: 12px; width: min(100% - 24px, 380px); z-index: 2147483647; color: #f7f5fc; font: 13px/1.5 system-ui, sans-serif; color-scheme: dark; }
  .study.combined { left: 12px; width: auto; }
  .study.waiting { top: 12px; bottom: auto; }
  .study.inline { position: static; width: 100%; }
  .panel { background: #18171f; border: 1px solid #393642; border-radius: 12px; padding: 8px 10px; max-height: min(60dvh, 430px); overflow: auto; }
  .combined .panel, .inline .panel { border: 0; background: transparent; padding: 0; pointer-events: none; }
  .combined .player-controls, .inline .player-controls {
    background: #18171fed; border: 1px solid #393642; border-radius: 9px; padding: 4px 7px; pointer-events: auto;
  }
  .player-controls { transition: opacity .22s ease, transform .22s ease, visibility 0s; }
  .player-controls.controls-hidden {
    visibility: hidden; pointer-events: none; opacity: 0; transform: translateY(8px);
    transition: opacity .4s ease, transform .4s ease, visibility 0s .4s;
  }
  button { transition: background-color .15s ease, filter .12s ease; }
  button:active:not(:disabled) { filter: brightness(.8); }
  @media (prefers-reduced-motion: reduce) {
    .player-controls, .player-controls.controls-hidden, button { transition: none; transform: none; }
  }
  .skip-suggestion {
    display: flex; align-items: center; flex-wrap: wrap; justify-content: flex-end; gap: 8px;
    width: fit-content; max-width: 100%; margin: 0 0 6px auto; padding: 5px 7px;
    border: 1px solid #393642; border-radius: 9px; background: #18171fed; pointer-events: auto;
  }
  .skip-suggestion span { white-space: nowrap; font-variant-numeric: tabular-nums; }
  .toolbar, .extras, .learn-bar, .controls { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  .toolbar { min-height: 32px; }
  .inline .toolbar :is(button, select) { min-height: 32px; min-width: 32px; padding: 4px 10px; font-size: 14px; }
  .playback-timeline { display: flex; align-items: center; gap: 8px; min-height: 24px; padding-bottom: 3px; }
  .seek { flex: 1 1 72px; width: 0; accent-color: #ceb9f7; }
  .clock { font-variant-numeric: tabular-nums; color: #c2bdce; white-space: nowrap; }
  .caption-row { display: grid; place-items: center; margin-bottom: 4px; }
  .caption { max-width: 100%; text-align: center; font-size: clamp(15px, 2vw, 23px); line-height: 1.35; white-space: pre-line; overflow-wrap: anywhere; }
  button, select, input { color: inherit; font: inherit; }
  button, select, input:not([type='range']) { border: 1px solid #ffffff24; border-radius: 6px; background: #ffffff09; padding: 4px 8px; }
  button, select, summary { cursor: pointer; }
  button:hover { background: #ffffff19; }
  .combined .caption-row > *, .inline .caption-row > * { background: #0d0d12e8; border-radius: 6px; padding: 4px 8px; pointer-events: auto; }
  button:disabled { opacity: .4; cursor: default; }
  button:focus-visible, select:focus-visible, input:focus-visible, summary:focus-visible, a:focus-visible { outline: 2px solid #cfb6ff; outline-offset: 2px; }
  .active { border-color: #8e78ae; }
  .learning, .primary { background: #ceb9f7; color: #201829; }
  .learning:hover, .primary:hover { background: #deccff; }
  .extras, .learn-bar, .phrase { border-top: 1px solid #ffffff1a; margin-top: 6px; padding-top: 6px; }
  .phrase { width: min(100%, 680px); margin-inline: auto; }
  .phrase-text { font-size: 20px; white-space: pre-line; }
  .phrase p { margin: 3px 0; }
  .phrase .controls + .controls { margin-top: 5px; }
  .phrase input { flex: 1; min-width: 100px; }
  .words, .notice, .hint { color: #c2bdce; }
  .notice { margin: 4px 0; }
  a { color: #decaff; }
  .transcript { display: grid; max-height: 135px; overflow: auto; gap: 2px; }
  .transcript button, .quiz-options button { text-align: left; }
  .quiz-options { display: grid; gap: 4px; margin: 6px 0; }
  .quiz-options .correct { border-color: #8cda9b; }
  .quiz-options .wrong { border-color: #eea1a1; }
  .launcher[hidden] { display: none; }
  .launcher { display: block; margin-left: auto; background: #302b40; }
</style>
