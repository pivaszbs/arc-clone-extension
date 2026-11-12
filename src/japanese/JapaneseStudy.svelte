<script lang="ts">
  import { onMount } from 'svelte';
  import { requestArc } from './client';
  import { hasJapanese, parseSubtitles, sourceUrl, type Card, type Cue } from './study';
  import { ListeningQuiz, knowledge, choices, defaultQuizSettings, type Challenge, type ListeningCue, type QuizSettings } from './quiz';
  import { AutoSubtitles } from './auto-subtitles';
  let open = $state(false);
  let mode = $state<'watch' | 'review'>('watch');
  let video = $state<HTMLVideoElement | null>(null);
  let text = $state('');
  let meaning = $state('');
  let cards = $state<Card[]>([]);
  let imported = $state<Cue[]>([]);
  let detected = $state<Cue | null>(null);
  let loop = $state<Cue | null>(null);
  let now = $state(Date.now());
  let busy = $state(false);
  let status = $state('');
  let subtitleName = $state('');
  let translating = $state(false);
  let selectedSpeed = $state('1');
  let playbackTime = $state(0);
  let playbackPaused = $state(true);
  let playbackReady = $state(false);
  let automaticCues = $state<Cue[]>([]);
  let automaticSource = $state('');
  const automatic = new AutoSubtitles();
  let lastScan = 0;
  let lastPlayerSource = '';
  let quizEnabled = $state(false);
  let quizSettings = $state<QuizSettings>({ ...defaultQuizSettings });
  let challenge = $state<Challenge | null>(null);
  let options = $state<string[]>([]);
  let chosen = $state<string | null>(null);
  let result = $state<'correct' | 'incorrect' | null>(null);
  let quizLoading = $state(false);
  let quizError = $state('');
  let quizSaved = $state(false);
  const learned = $derived(knowledge(cards));
  const quizEngine = new ListeningQuiz();
  let quizRequest = 0;
  let currentUrl = location.href;
  let previousVideo: HTMLVideoElement | null = null;
  let oldRate: number | null = null;
  let lastSelection = '';
  let stopAfter: { video: HTMLVideoElement; end: number } | null = null;
  const due = $derived(cards.filter((card) => card.due <= now).sort((a, b) => a.due - b.due));
  const review = $derived(due[0]);
  const clock = (time: number) => `${Math.floor(time / 60)}:${String(Math.floor(time % 60)).padStart(2, '0')}`;

  function readCue(): ListeningCue | null {
    if (!video) return null;
    const fileCue = imported.find((cue) => video!.currentTime >= cue.start && video!.currentTime < cue.end);
    if (fileCue && hasJapanese(fileCue.text)) return fileCue;
    const autoCue = automaticCues.find((cue) => video!.currentTime >= cue.start && video!.currentTime < cue.end);
    if (autoCue && hasJapanese(autoCue.text)) return autoCue;
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
  function stopLoop() { loop = null; }
  function restoreSpeed() {
    if (previousVideo && oldRate !== null) previousVideo.playbackRate = oldRate;
    previousVideo = null; oldRate = null;
    selectedSpeed = '1';
  }
  function tick() {
    now = Date.now();
    if (!open) return;
    if (currentUrl !== location.href) {
      currentUrl = location.href; imported = []; subtitleName = ''; loop = null; stopAfter = null;
      text = ''; meaning = ''; captured = null; restoreSpeed();
      challenge = null; quizRequest++; quizEngine.reset(); automatic.reset(); automaticCues = []; automaticSource = '';
    }
    const nextVideo = Array.from(document.querySelectorAll('video')).filter((v) => v.getBoundingClientRect().width > 0).sort((a, b) => Number(b === document.activeElement) - Number(a === document.activeElement) || b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0] || null;
    if (video !== nextVideo) { loop = null; stopAfter = null; restoreSpeed(); challenge = null; quizRequest++; quizEngine.reset(); automatic.reset(); automaticCues = []; automaticSource = ''; }
    video = nextVideo;
    const playerSource = video?.currentSrc || '';
    if (playerSource !== lastPlayerSource) {
      lastPlayerSource = playerSource; automatic.reset(); automaticCues = []; automaticSource = '';
      challenge = null; quizRequest++; quizEngine.reset();
    }
    playbackTime = video?.currentTime || 0;
    playbackPaused = video?.paused ?? true;
    playbackReady = !!video && video.readyState >= 1;
    if (video && !imported.length && now - lastScan >= 1500) {
      lastScan = now;
      const currentVideo = video;
      void automatic.scan(currentVideo).then(() => {
        if (video === currentVideo && open) { automaticCues = [...automatic.cues]; automaticSource = automatic.source; }
      }).catch(() => {});
    }
    detected = readCue();
    if (loop && video && (video.currentTime >= loop.end || video.currentTime < loop.start - 0.5)) video.currentTime = loop.start;
    if (stopAfter && stopAfter.video.currentTime >= stopAfter.end) { stopAfter.video.pause(); stopAfter = null; }
    if (quizEnabled && mode === 'watch' && video && !loop && !stopAfter && !challenge && !video.seeking) {
      const next = quizEngine.observe(detected, video.currentTime, !video.paused || video.ended, learned, quizSettings.chance);
      if (next) { video.pause(); void beginQuiz(next); }
    }
  }
  async function load() {
    try { const response = await requestArc({ type: 'JAPANESE_LIST' }); cards = response.cards; quizSettings = response.settings || { ...defaultQuizSettings }; }
    catch { status = 'Could not load saved phrases. Reload the extension and this page.'; }
  }
  onMount(() => {
    void load();
    const timer = setInterval(tick, 100);
    const selection = () => { const value = window.getSelection()?.toString().trim() || ''; if (value && hasJapanese(value)) lastSelection = value; };
    document.addEventListener('selectionchange', selection);
    return () => { clearInterval(timer); automatic.reset(); restoreSpeed(); document.removeEventListener('selectionchange', selection); };
  });
  async function play(cue: Cue, repeat: boolean) {
    if (!video) { status = 'Start a video first. If it is embedded, use the Japanese button inside the player.'; return; }
    try {
      stopAfter = null;
      quizEngine.reset();
      loop = repeat ? cue : null;
      video.currentTime = cue.start;
      if (!repeat) stopAfter = { video, end: cue.end };
      await video.play();
    } catch { loop = null; stopAfter = null; status = 'Playback could not start. Press play on the video and try again.'; }
  }
  function lastFive(): Cue {
    const end = video?.currentTime || 0;
    return { start: Math.max(0, end - 5), end: Math.max(0.1, end), text: '' };
  }
  function capture() {
    text = detected?.text || lastSelection || '';
    if (video) video.pause();
    loop = null; stopAfter = null;
    status = text ? 'Say it aloud, then add a meaning you have checked.' : 'No Japanese subtitle detected. Paste a phrase below or load Japanese SRT / VTT subtitles.';
  }
  let captured = $state<Cue | null>(null);
  function capturePhrase() { captured = detected ? { ...detected } : video ? lastFive() : null; capture(); }
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
    if (!text.trim() || !meaning.trim()) { status = 'Add both the Japanese phrase and its meaning.'; return; }
    if (!hasJapanese(text)) { status = 'Use Japanese characters for the phrase.'; return; }
    busy = true;
    try {
      const range = captured || detected || (video ? lastFive() : { start: 0, end: 5, text: '' });
      const url = window === window.top ? location.href : document.referrer || location.href;
      const response = await requestArc({ type: 'JAPANESE_SAVE', card: { ...range, text: text.trim(), meaning: meaning.trim(), url, title: document.title } });
      cards = response.cards; text = ''; meaning = ''; captured = null;
      status = 'Saved. Review it with the meaning hidden.';
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
        const url = window === window.top ? location.href : document.referrer || location.href;
        const existing = cards.find((card) => card.text === challenge!.cue.text && card.url === url);
        if (existing) id = existing.id;
        else {
          const saved = await requestArc({ type: 'JAPANESE_SAVE', card: { ...challenge.cue, text: challenge.cue.text, meaning: challenge.meaning, url, title: document.title } });
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
    challenge = null; quizRequest++; quizLoading = false; quizEngine.reset(); quizError = '';
    if (mode === 'watch' && video) { try { await video.play(); } catch { status = 'Press play on the video to continue.'; } }
  }
  async function setChance(event: Event) {
    const chance = Number((event.currentTarget as HTMLSelectElement).value);
    try { quizSettings = (await requestArc({ type: 'JAPANESE_QUIZ_SETTINGS', settings: { chance } })).settings; }
    catch { status = 'Could not save quiz frequency.'; }
  }
  function closePanel() {
    open = false; quizEnabled = false; loop = null; stopAfter = null; challenge = null; quizRequest++; quizLoading = false; quizEngine.reset(); restoreSpeed();
    automatic.reset(); automaticCues = []; automaticSource = '';
  }
  async function importFile(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > 5000000) { status = 'Choose a subtitle file smaller than 5 MB.'; return; }
    try {
      const cues = parseSubtitles(await file.text());
      if (!cues.some((cue) => hasJapanese(cue.text))) { status = 'No Japanese SRT / VTT lines found. ASS files are not supported yet.'; return; }
      imported = cues; subtitleName = file.name;
      status = `Loaded ${cues.length} lines. Timings must match this video.`;
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

<div class="study">
  {#if open}
    <section aria-label="Japanese learning" class="panel">
      <header><div><small>ARC · JAPANESE</small><h2>A little, every day.</h2></div><button aria-label="Close Japanese panel" disabled={busy} onclick={closePanel}>×</button></header>
      <nav aria-label="Study mode"><button disabled={!!challenge} class:active={mode === 'watch'} onclick={() => { mode = 'watch'; status = ''; }}>Watch & learn</button><button disabled={!!challenge} class:active={mode === 'review'} onclick={() => { mode = 'review'; stopLoop(); status = ''; void load(); }}>Review · {due.length}</button></nav>
      {#if challenge}
        <p class="hint">{mode === 'watch' ? 'Video paused. What did you hear?' : 'What does this phrase mean?'}</p>
        {#if mode === 'review' || result}<div class="caption" lang="ja">{challenge.cue.text}</div>{:else}<button disabled={!video} onclick={() => challenge && play(challenge.cue, false)}>Listen again</button>{/if}
        {#if quizLoading}<p role="status">Preparing translations…</p>{/if}
        <div class="quiz-options">{#each options as option}<button disabled={!!result || busy} class:correct={!!result && option === challenge.meaning} class:wrong={result === 'incorrect' && option === chosen} onclick={() => answerQuiz(option)}>{option}</button>{/each}</div>
        {#if !result && options.length}<button disabled={busy} onclick={() => answerQuiz(null)}>I don’t know yet</button>{/if}
        {#if result}<p role="status">{result === 'correct' ? 'Correct. This phrase will return later.' : 'The highlighted answer is the translation. This phrase will return sooner.'}</p><p class="hint">{challenge.meaning}</p>{/if}
        {#if quizError}<p class="status" role="alert">{quizError}</p><button disabled={busy} onclick={() => result ? saveQuizResult() : challenge && beginQuiz(challenge)}>Retry</button>{/if}
        {#if result}<button class="primary" disabled={busy || !quizSaved} onclick={continueQuiz}>{mode === 'watch' ? 'Continue watching' : 'Next review'}</button>{:else}<button disabled={busy} onclick={continueQuiz}>Skip without changing progress</button>{/if}
        <p class="hint">Translations may be machine generated. Your answer updates the review schedule automatically.</p>
      {:else if mode === 'watch'}
        <p class="connection" aria-live="off">{video ? `Connected to video · ${playbackReady ? playbackPaused ? 'Paused' : 'Playing' : 'Loading'} · ${clock(playbackTime)}` : 'No video connected in this frame'}</p>
        <p class="hint">{automaticSource ? `Ready automatically · ${automaticSource}` : detected ? 'Reading the player’s Japanese captions automatically.' : 'Looking for Japanese subtitles in the player and its caption requests…'}</p>
        <label class="quiz-toggle"><input type="checkbox" bind:checked={quizEnabled} onchange={() => quizEngine.reset()} /> Pause for listening quizzes</label>
        {#if quizEnabled}<p class="hint">Known phrases pause when due. Short lines with an estimated 1–2 unfamiliar words are sampled. Learning starts from your answers.</p><label>Sample unfamiliar lines <select aria-label="Unfamiliar phrase frequency" value={String(quizSettings.chance)} onchange={setChance}><option value="0.1">Occasionally · 10%</option><option value="0.25">Sometimes · 25%</option><option value="0.5">Often · 50%</option><option value="1">Every eligible line</option></select></label><p class="hint">Quiz mode sends selected subtitle lines to Google Translate to prepare answers. Your answers stay on this device.</p>{/if}
        <p class="hint">Listen once. Replay. Say it aloud. Save a phrase you want to use.</p>
        <div class="caption" lang="ja">{detected?.text || (video ? automaticCues.length ? 'Japanese subtitles connected. Waiting for the next line.' : 'No Japanese text found yet. The video may not provide Japanese subtitles.' : 'Start a video to connect playback.')}</div>
        <div class="controls"><button disabled={!video} onclick={() => play(lastFive(), false)}>Replay 5 seconds</button><button disabled={!video} class:active={!!loop} onclick={() => loop ? stopLoop() : play(detected || lastFive(), true)}>{loop ? 'Stop loop' : detected ? 'Loop captured section' : 'Loop last 5 seconds'}</button></div>
        <div class="controls"><label>Speed <select aria-label="Playback speed" disabled={!video} bind:value={selectedSpeed} onchange={speed}><option value="1">Normal</option><option value="0.85">0.85×</option><option value="0.7">0.7×</option></select></label><button onclick={capturePhrase}>Capture phrase</button></div>
        {#if !video}<p class="hint">Start a video. For embedded videos, use the Japanese button inside the player.</p>{/if}
        <label for="jp-phrase">Japanese phrase</label><textarea id="jp-phrase" lang="ja" rows="2" bind:value={text} placeholder="Capture, select, or paste Japanese text"></textarea>
        <div class="controls"><label for="jp-meaning">Meaning in your own words</label><button disabled={translating || !text.trim()} onclick={translate}>{translating ? 'Translating…' : 'Translate to English'}</button></div><textarea id="jp-meaning" rows="2" bind:value={meaning} placeholder="Add a meaning you have checked"></textarea>
        <small class="translation-note">Translate sends this phrase to Google Translate.</small>
        <button class="primary" disabled={busy || !text.trim() || !meaning.trim()} onclick={save}>{busy ? 'Saving…' : 'Save phrase'}</button>
        <details><summary>Advanced: use your own subtitles</summary><p class="hint">Optional SRT or VTT override. Normal playback discovers player subtitles automatically.</p><input aria-label="Japanese subtitle file" type="file" accept=".srt,.vtt" onchange={importFile} />{#if subtitleName}<small>{subtitleName}</small>{/if}</details>
      {:else if review}
        <p class="hint">Answer a translation question. The result schedules your next review automatically.</p><button class="primary" onclick={() => { if (video) video.pause(); void beginQuiz({ cue: review, kind: 'known', unknown: [], meaning: review.meaning, cardId: review.id }); }}>Start next review</button>
        <a href={sourceUrl(review.url, review.start)} target="_blank" rel="noopener noreferrer">Open source · {clock(review.start)}</a><p class="hint">YouTube links return to the saved time. On anime pages, seek to the time shown.</p>
      {:else}<div class="caption">{cards.length ? 'You’re caught up.' : 'Your first phrase starts here.'}</div><p class="hint">{cards.length ? 'Come back when a phrase is due. Remembered phrases return after 1, 2, 4 days and longer.' : 'Capture a phrase while watching, add its meaning, then come here to practise remembering it.'}</p>{/if}
      {#if status}<p class="status" role="status">{status}</p>{/if}
      <footer><span>{cards.length} saved · stored on this device</span><button disabled={!cards.length} onclick={exportCards}>Export</button></footer>
    </section>
  {/if}
  <button class="launcher" disabled={busy} aria-expanded={open} onclick={() => { if (open) closePanel(); else { open = true; void load(); } }}>日本語 <span>{open ? 'Close' : 'Learn'}</span></button>
</div>

<style>
  :host { all: initial; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #f4f3fa; font-size: 13px; }
  .connection { color: #d2c4ed; font-size: 12px; padding: 9px 11px; border: 1px solid #ffffff20; border-radius: 9px; }
  .quiz-options { display: grid; gap: 8px; margin: 14px 0; } .quiz-options button { text-align: left; padding: 12px; } .quiz-options button.correct { background: #49795966; border-color: #8cda9b; opacity: 1; } .quiz-options button.wrong { background: #a34d4d66; border-color: #eea1a1; opacity: 1; } .quiz-toggle { display: flex; gap: 8px; align-items: center; padding-top: 10px; }
  @media (pointer: coarse) {
    .study { right: max(12px, env(safe-area-inset-right)); bottom: max(12px, env(safe-area-inset-bottom)); width: min(420px, calc(100vw - 24px)); font-size: 16px; }
    .panel { max-height: calc(100dvh - 100px - env(safe-area-inset-bottom)); padding: 20px; }
    button, select, summary { min-height: 48px; }
    .quiz-options button { min-height: 60px; font-size: 17px; padding: 15px; }
    header button { min-width: 48px; }
    textarea { font-size: 16px; }
    input[type='checkbox'] { width: 24px; height: 24px; flex-shrink: 0; }
    .hint { font-size: 14px; }
  }
  * { box-sizing: border-box; } .study { position: fixed; right: 20px; bottom: 20px; z-index: 2147483646; width: min(366px, calc(100vw - 24px)); pointer-events: none; line-height: 1.5; }
  .panel, .launcher { pointer-events: auto; } .panel { border: 1px solid #ffffff24; border-radius: 20px; background: #24232ded; backdrop-filter: blur(24px); padding: 20px; margin-bottom: 10px; box-shadow: 0 20px 80px #0006; max-height: calc(100dvh - 100px); overflow: auto; }
  header, nav, .controls, footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; } header { align-items: start; margin-bottom: 18px; } small { color: #beb9d4; font-size: 10px; letter-spacing: 1px; } h2 { font-size: 20px; font-weight: 550; margin: 3px 0 0; letter-spacing: -.5px; }
  button, select, textarea { font: inherit; color: inherit; } button, select, summary { cursor: pointer; } button { border: 1px solid #ffffff1c; border-radius: 9px; background: #ffffff09; padding: 8px 10px; } button:hover { background: #ffffff18; } button:disabled { opacity: .45; cursor: default; } button:focus-visible, select:focus-visible, textarea:focus-visible, summary:focus-visible, a:focus-visible { outline: 2px solid #cfb6ff; outline-offset: 3px; }
  header button { border: 0; font-size: 20px; padding: 0 5px; } nav { justify-content: start; padding-bottom: 3px; } nav button { flex: 1; } .active { background: #ae8af52b; border-color: #bc9cf56b; } .hint { color: #bfbacb; font-size: 12px; margin: 12px 0; } .caption { background: #15141c66; padding: 18px; border-radius: 12px; margin: 12px 0; font-size: 19px; line-height: 1.7; overflow-wrap: anywhere; min-height: 90px; } .controls { margin: 10px 0; } .controls button { flex: 1; font-size: 12px; } label { display: block; font-size: 12px; margin: 10px 0 5px; color: #d5d0e2; } .controls label { margin: 0; } select { background: #33303e; border: 1px solid #ffffff20; border-radius: 7px; padding: 5px; } textarea { display: block; resize: vertical; width: 100%; border: 1px solid #ffffff23; border-radius: 10px; padding: 10px; background: #15141c66; } textarea::placeholder { color: #a5a0b2; font-size: 12px; } .primary { background: #ceb9f7; color: #21192e; border: 0; width: 100%; margin-top: 12px; font-weight: 600; } .primary:hover { background: #ddccff; } details { margin-top: 14px; color: #c8c1d8; font-size: 12px; } input { max-width: 100%; } footer { border-top: 1px solid #ffffff15; margin-top: 18px; padding-top: 12px; color: #bfbacb; font-size: 10px; } footer button { padding: 4px 8px; font-size: 11px; } .status { font-size: 12px; color: #e6d8ff; } .launcher { display: block; margin-left: auto; border-radius: 24px; background: #302b40; box-shadow: 0 4px 20px #0004; padding: 10px 16px; border-color: #cbb1f44d; } .launcher span { margin-left: 10px; color: #d1bddf; } a { color: #d9c2ff; display: block; margin-top: 14px; font-size: 12px; }
</style>
