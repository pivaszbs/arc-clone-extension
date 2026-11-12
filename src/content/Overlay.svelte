<script lang="ts">
  import { onMount } from 'svelte';
  import { requestArc } from '../shared/messaging';
  import { canPreviewInPeek, shouldPeek } from '../shared/interaction';
  import CommandPalette from '../shared/CommandPalette.svelte';
  import Icon from '../shared/Icon.svelte';
  import { containFocus, isActivationKey } from '../shared/focus';
  import { pinnedRows } from '../shared/pins';
  import { getSpaceFavorites, getTodayTabs, isRootDomainUrl, sameHost, urlKey } from '../shared/tabs';
  import {
    type ArcState,
    type ExtensionSettings,
    type FavoriteItem,
    type OmniboxResultItem,
    type Space,
    type TabInfo,
    SPACE_THEMES,
    SUPPORTED_LANGUAGES,
    getFaviconUrl,
    parseCommandBarInput
  } from '../shared/types';
  import { DesktopVideoStream } from '../video/desktop-stream';
  let arcState = $state<ArcState>({
    spaces: [
      {
        id: 'space-personal',
        name: 'Personal',
        icon: '✨',
        theme: 'indigo',
        pinnedItems: []
      }
    ],
    activeSpaceId: 'space-personal',
    favorites: [],
    tabSpaceMap: {},
    tabLastAccessed: {},
    settings: {
      targetLanguage: 'en',
      translateOnSelectMode: 'pill',
      peekTrigger: 'shift-click',
      peekMode: 'overlay',
      leftSidebarMode: 'pinned',
      syncChromeTabGroups: false,
      autoArchiveHours: 12
    }
  });

  let tabs = $state<TabInfo[]>([]);
  let settings = $derived<ExtensionSettings>(arcState.settings);

  // Left-side Arc Sidebar state + Draggable Position & Resizable Dimensions
  let leftSidebarHoverOpen = $state(false);
  let hideTimeout: ReturnType<typeof setTimeout> | null = null;
  let copiedCurrentUrl = $state(false);
  let currentPageUrl = $state(window.location.href);
  let pointerDownCoords = { x: 0, y: 0 };

  function isUrlActive(targetUrl: string, currentUrl = currentPageUrl): boolean {
    if (!targetUrl || !currentUrl) return false;
    if (urlKey(targetUrl) === urlKey(currentUrl)) return true;
    if (isRootDomainUrl(targetUrl) && sameHost(targetUrl, currentUrl)) return true;
    try {
      const t = new URL(targetUrl);
      const c = new URL(currentUrl);
      if (
        sameHost(targetUrl, currentUrl) &&
        t.pathname !== '/' &&
        c.pathname.startsWith(t.pathname)
      ) {
        return true;
      }
    } catch {
      // ignore invalid URL
    }
    return false;
  }

  let sidebarX = $state(8);
  let sidebarY = $state(8);
  let sidebarWidth = $state(276);
  let sidebarHeight = $state<number | null>(null); // null = full viewport height minus 16px
  let isDraggingSidebar = $state(false);
  let isResizingSidebar = $state(false);

  // Drag-and-drop state for items inside sidebar
  type DragPayload =
    | { kind: 'tab'; tab: TabInfo }
    | { kind: 'fav'; index: number }
    | { kind: 'pin'; index: number; url: string; title: string; favIconUrl?: string };

  let activeDrag = $state<DragPayload | null>(null);
  let dropTargetHighlight = $state<string | null>(null);

  function startSidebarMove(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    isDraggingSidebar = true;

    const startX = e.clientX;
    const startY = e.clientY;
    const origX = sidebarX;
    const origY = sidebarY;

    const onMove = (ev: PointerEvent) => {
      const nextX = Math.max(4, Math.min(window.innerWidth - sidebarWidth - 4, origX + (ev.clientX - startX)));
      const nextY = Math.max(4, Math.min(window.innerHeight - 180, origY + (ev.clientY - startY)));
      sidebarX = nextX < 20 ? 8 : nextX;
      sidebarY = nextY < 20 ? 8 : nextY;
    };

    const onUp = (ev: PointerEvent) => {
      isDraggingSidebar = false;
      target.releasePointerCapture(ev.pointerId);
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
    };

    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
  }

  function resetSidebarPosition() {
    sidebarX = 8;
    sidebarY = 8;
    sidebarWidth = 276;
    sidebarHeight = null;
  }

  function startSidebarResize(e: PointerEvent, resizeHeight = false) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    isResizingSidebar = true;

    const startX = e.clientX;
    const startY = e.clientY;
    const origW = sidebarWidth;
    const origH = sidebarHeight ?? window.innerHeight - sidebarY - 8;

    const onMove = (ev: PointerEvent) => {
      sidebarWidth = Math.max(210, Math.min(540, origW + (ev.clientX - startX)));
      if (resizeHeight) {
        sidebarHeight = Math.max(320, Math.min(window.innerHeight - sidebarY - 8, origH + (ev.clientY - startY)));
      }
    };

    const onUp = (ev: PointerEvent) => {
      isResizingSidebar = false;
      target.releasePointerCapture(ev.pointerId);
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
    };

    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
  }

  let isLeftSidebarVisible = $derived(
    settings.leftSidebarMode === 'pinned' || leftSidebarHoverOpen
  );

  let activeSpace = $derived<Space>(
    arcState.spaces.find((s) => s.id === arcState.activeSpaceId) || arcState.spaces[0]
  );

  let spaceFavorites = $derived<FavoriteItem[]>(getSpaceFavorites(arcState, activeSpace?.id));

  let currentTheme = $derived(SPACE_THEMES[activeSpace?.theme || 'indigo'] || SPACE_THEMES.indigo);

  let spaceTabs = $derived<TabInfo[]>(getTodayTabs(arcState, tabs, activeSpace?.id));

  // Custom Pin / Favorite & Folder Creator State for active Space
  let showAddFavForm = $state(false);
  let customFavUrl = $state('');
  let customFavTitle = $state('');
  let showAddPinForm = $state(false);
  let customPinUrl = $state('');
  let customPinTitle = $state('');
  let showAddFolderForm = $state(false);
  let customFolderTitle = $state('');

  async function addCurrentPageToSpaceFavorites() {
    await chrome.runtime.sendMessage({
      type: 'ADD_FAVORITE',
      spaceId: activeSpace?.id,
      title: document.title || window.location.hostname,
      url: window.location.href
    });
    syncSnapshot();
  }

  async function submitCustomSpaceFavorite() {
    const raw = customFavUrl.trim();
    if (!raw) return;
    const parsed = parseCommandBarInput(raw);
    const url = parsed.isUrl ? parsed.url : `https://${raw}`;
    await chrome.runtime.sendMessage({
      type: 'ADD_FAVORITE',
      spaceId: activeSpace?.id,
      title: customFavTitle.trim() || raw,
      url
    });
    customFavUrl = '';
    customFavTitle = '';
    showAddFavForm = false;
    syncSnapshot();
  }

  async function submitCustomSpacePin() {
    const raw = customPinUrl.trim();
    if (!raw) return;
    const parsed = parseCommandBarInput(raw);
    const url = parsed.isUrl ? parsed.url : `https://${raw}`;
    await chrome.runtime.sendMessage({
      type: 'PIN_TAB_TO_SPACE',
      spaceId: activeSpace?.id,
      title: customPinTitle.trim() || raw,
      url
    });
    customPinUrl = '';
    customPinTitle = '';
    showAddPinForm = false;
    syncSnapshot();
  }

  async function submitCustomSpaceFolder() {
    const title = customFolderTitle.trim();
    if (!title) return;
    await chrome.runtime.sendMessage({
      type: 'CREATE_FOLDER',
      spaceId: activeSpace?.id,
      title
    });
    customFolderTitle = '';
    showAddFolderForm = false;
    syncSnapshot();
  }

  // 1. Command Bar State
  let showCommandBar = $state(false);
  let commandMode = $state<'default' | 'little-arc'>('default');
  let commandQuery = $state('');

  // 2. Peek / Little Arc Modal State
  let peekUrl = $state<string | null>(null);
  let peekCopied = $state(false);

  // 3. Highlight-to-Translate State
  let selectionText = $state('');
  let pillPosition = $state<{ x: number; y: number } | null>(null);
  let showTranslatePill = $state(false);
  let showTranslateCard = $state(false);
  let translating = $state(false);
  let translatedText = $state('');
  let translationError = $state('');
  let translationVersion = 0;
  let detectedLang = $state('auto');
  let targetLang = $state('en');
  let copiedTranslation = $state(false);

  // 4. ChatGPT & Antigravity Browser Agent Sidebar State
  interface AgentChatMessage {
    id: string;
    role: 'user' | 'assistant';
    agent: 'chatgpt' | 'antigravity' | 'browser';
    content: string;
    timestamp: string;
    actionBadge?: string;
    promptUsed?: string;
  }

  let showAgentSidebar = $state(false);
  let agentSidebarMode = $state<'chatgpt' | 'antigravity'>('chatgpt');
  let agentSidebarDock = $state<'left' | 'right'>('left');
  let agentSidebarWidth = $state(380);
  let isResizingAgentSidebar = $state(false);
  let showBrowserContextDrawer = $state(false);
  let agentMessages = $state<AgentChatMessage[]>([]);
  let agentSending = $state(false);
  let showAiBox = $state(false);
  let aiPromptText = $state('');
  let includePageContext = $state(true);
  let agyToastMessage = $state<string | null>(null);
  let livePageContext = $state<{
    title: string;
    url: string;
    selection: string;
    excerpt: string;
    buttons: string[];
    headings: string[];
    inputs: string[];
    videoInfo: {
      hasVideo: boolean;
      videoCount: number;
      iframeCount: number;
      paused?: boolean;
      muted?: boolean;
      duration?: number;
      currentTime?: number;
      src?: string;
      captionText?: string;
    };
  }>({
    title: '',
    url: '',
    selection: '',
    excerpt: '',
    buttons: [],
    headings: [],
    inputs: [],
    videoInfo: { hasVideo: false, videoCount: 0, iframeCount: 0 }
  });

  function showToast(msg: string) {
    agyToastMessage = msg;
    setTimeout(() => {
      if (agyToastMessage === msg) agyToastMessage = null;
    }, 3200);
  }

  function buildContextPrompt(customTask = '', explicitSelection = ''): string {
    const sel = explicitSelection || window.getSelection()?.toString().trim() || selectionText || '';
    const parts: string[] = [];
    if (customTask.trim()) {
      parts.push(customTask.trim());
    }
    if (includePageContext || !customTask.trim()) {
      parts.push(`Page: ${document.title || 'Untitled'} (${window.location.href})`);
      if (sel) {
        parts.push(`Selected context:\n\`\`\`\n${sel.slice(0, 3500)}\n\`\`\``);
      }
    }
    return parts.join('\n\n');
  }

  async function launchExternalChatGPT(customTask = '', explicitSelection = '', inLittleArc = true) {
    const prompt = buildContextPrompt(
      customTask || (explicitSelection ? 'Explain and help me with this:' : 'Summarize and help me with this page:'),
      explicitSelection
    );
    const chatUrl = `https://chatgpt.com/?q=${encodeURIComponent(prompt)}`;
    if (inLittleArc) {
      await chrome.runtime.sendMessage({ type: 'OPEN_LITTLE_ARC', url: chatUrl });
    } else {
      await chrome.runtime.sendMessage({
        type: 'CREATE_TAB',
        url: chatUrl,
        spaceId: activeSpace?.id
      });
    }
  }

  async function launchExternalAntigravity(customTask = '', explicitSelection = '') {
    const ctx = collectPageContext();
    const prompt = [
      customTask || 'Help me inspect and make this page work in Antigravity:',
      `Page: ${ctx.title} (${ctx.url})`,
      ctx.videoInfo.hasVideo || ctx.videoInfo.iframeCount > 0
        ? `Media: ${ctx.videoInfo.videoCount} <video>, ${ctx.videoInfo.iframeCount} <iframe>`
        : '',
      explicitSelection || ctx.selection
        ? `Selected Text:\n\`\`\`\n${(explicitSelection || ctx.selection).slice(0, 3000)}\n\`\`\``
        : ''
    ]
      .filter(Boolean)
      .join('\n\n');

    try {
      await navigator.clipboard.writeText(prompt);
    } catch {
      // ignore clipboard error
    }
    showToast('🚀 Task + Browser DOM context copied! Opening Antigravity IDE (⌘V to paste)...');

    const a = document.createElement('a');
    a.href = 'antigravity://';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 200);
  }

  function openAgentSidebar(
    mode: 'chatgpt' | 'antigravity',
    initialPrompt = '',
    explicitSelection = '',
    autoSubmit = false
  ) {
    agentSidebarMode = mode;
    showAgentSidebar = true;
    showAiBox = false;
    showTranslatePill = false;
    if (explicitSelection) {
      selectionText = explicitSelection;
    }
    livePageContext = collectPageContext();

    if (agentMessages.length === 0) {
      const host = window.location.hostname.replace(/^www\./, '') || window.location.href;
      const mediaNote =
        livePageContext.videoInfo.videoCount > 0 || livePageContext.videoInfo.iframeCount > 0
          ? `🎬 Detected **${livePageContext.videoInfo.videoCount} video(s)** & **${livePageContext.videoInfo.iframeCount} embedded player frame(s)**.`
          : `🎯 Detected **${livePageContext.buttons.length} interactive controls** on this page.`;
      agentMessages = [
        {
          id: `welcome-${Date.now()}`,
          role: 'assistant',
          agent: mode,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          actionBadge: '🟢 Browser DOM Connected',
          content: `Connected to **${document.title || host}** (\`${host}\`).\n${mediaNote}\n\nAsk me anything about this page, tell me to **fix/inspect the video or page**, **click any button**, **summarize**, or **manage your tabs & Spaces**!`
        }
      ];
    }

    const combinedPrompt = initialPrompt.trim()
      ? initialPrompt.trim()
      : explicitSelection.trim()
        ? `Help me with this selection:\n"${explicitSelection.trim().slice(0, 500)}"`
        : '';

    if (combinedPrompt) {
      aiPromptText = combinedPrompt;
      if (autoSubmit) {
        submitAgentSidebarMessage(combinedPrompt);
      }
    }
  }

  async function submitAgentSidebarMessage(overrideText?: string) {
    const text = (overrideText ?? aiPromptText).trim();
    if (!text || agentSending) return;
    if (!overrideText) {
      aiPromptText = '';
    }

    const nowStamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const userMsg: AgentChatMessage = {
      id: `u-${Date.now()}`,
      role: 'user',
      agent: agentSidebarMode,
      content: text,
      timestamp: nowStamp
    };

    const historyForApi = agentMessages
      .slice(-8)
      .map((m) => ({ role: m.role, content: m.content }));

    agentMessages = [...agentMessages, userMsg];
    agentSending = true;

    try {
      const pageContext = collectPageContext();
      livePageContext = pageContext;
      const res = await chrome.runtime.sendMessage({
        type: 'HANDLE_VOICE_COMMAND',
        transcript: text,
        pageContext,
        preferredAgent: agentSidebarMode,
        fromSidebar: true,
        history: historyForApi
      });

      agentSending = false;
      if (res?.domAction) {
        executeDomVoiceAction(res.domAction);
      }

      const replyContent = res?.reply || 'Done.';
      const assistantMsg: AgentChatMessage = {
        id: `a-${Date.now()}`,
        role: 'assistant',
        agent: res?.agent || agentSidebarMode,
        content: replyContent,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        actionBadge: res?.actionBadge,
        promptUsed: text
      };
      agentMessages = [...agentMessages, assistantMsg];
      syncSnapshot();
    } catch (err) {
      agentSending = false;
      agentMessages = [
        ...agentMessages,
        {
          id: `err-${Date.now()}`,
          role: 'assistant',
          agent: agentSidebarMode,
          content: `Could not complete browser action: ${String(err)}`,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        }
      ];
    }
  }

  async function sendToChatGPT(customTask = '', explicitSelection = '', _inLittleArc = true) {
    openAgentSidebar('chatgpt', customTask, explicitSelection, Boolean(customTask || explicitSelection));
  }

  async function sendToAntigravity(customTask = '', explicitSelection = '') {
    openAgentSidebar('antigravity', customTask, explicitSelection, Boolean(customTask || explicitSelection));
  }

  // 5. Voice Browser Control State (SpeechRecognition + TTS + DOM Actions)
  let isVoiceListening = $state(false);
  let showVoiceOrb = $state(false);
  let voiceInterimTranscript = $state('');
  let voiceFinalTranscript = $state('');
  let voiceReplyText = $state('');
  let voiceProcessing = $state(false);
  let voicePreferredAgent = $state<'auto' | 'chatgpt' | 'antigravity'>('auto');
  let voiceContinuousMode = $state(false);
  let showApiKeyConfig = $state(false);
  let apiKeyInput = $state('');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let recognitionInstance: any = null;

  function collectPageContext() {
    const sel = window.getSelection()?.toString().trim() || selectionText || '';
    const excerpt = (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 1600);
    const interactiveEls = Array.from(
      document.querySelectorAll<HTMLElement>(
        'a, button, [role="button"], input[type="submit"], input[type="button"]'
      )
    );
    const buttons: string[] = [];
    for (const el of interactiveEls) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 && rect.top >= -100 && rect.top <= window.innerHeight + 200) {
        const label = (
          el.innerText ||
          el.getAttribute('aria-label') ||
          (el as HTMLInputElement).value ||
          ''
        )
          .replace(/\s+/g, ' ')
          .trim();
        if (label && label.length >= 2 && label.length <= 45 && !buttons.includes(label)) {
          buttons.push(label);
          if (buttons.length >= 30) break;
        }
      }
    }

    const headings = Array.from(document.querySelectorAll<HTMLElement>('h1, h2, h3'))
      .map((h) => (h.innerText || '').replace(/\s+/g, ' ').trim())
      .filter((t) => t.length >= 2 && t.length <= 90)
      .slice(0, 12);

    const inputs = Array.from(
      document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        'input[type="text"], input[type="search"], input:not([type]), textarea'
      )
    )
      .map(
        (inp) =>
          inp.placeholder || inp.getAttribute('aria-label') || inp.name || inp.id || 'text input'
      )
      .slice(0, 10);

    const videos = Array.from(document.querySelectorAll<HTMLVideoElement>('video'));
    const iframes = Array.from(document.querySelectorAll<HTMLIFrameElement>('iframe'));
    const primaryVideo = findPrimaryVideo();

    return {
      title: document.title || '',
      url: window.location.href,
      selection: sel,
      excerpt,
      buttons,
      headings,
      inputs,
      videoInfo: {
        hasVideo: Boolean(primaryVideo),
        videoCount: videos.length,
        iframeCount: iframes.length,
        paused: primaryVideo ? primaryVideo.paused : undefined,
        muted: primaryVideo ? primaryVideo.muted : undefined,
        duration:
          primaryVideo && Number.isFinite(primaryVideo.duration) ? primaryVideo.duration : undefined,
        currentTime: primaryVideo ? primaryVideo.currentTime : undefined,
        src: primaryVideo?.currentSrc || primaryVideo?.src || undefined,
        captionText: ytCaptionLine || undefined
      }
    };
  }

  function fixAndInspectPageDom() {
    let fixedCount = 0;

    // 1. Unlock all <video> elements on the page
    const videos = Array.from(document.querySelectorAll<HTMLVideoElement>('video'));
    for (const v of videos) {
      v.controls = true;
      v.removeAttribute('disablePictureInPicture');
      v.style.pointerEvents = 'auto';
      fixedCount++;
    }

    // 2. Ensure embedded player iframes have pointer-events enabled and are visible
    const iframes = Array.from(document.querySelectorAll<HTMLIFrameElement>('iframe'));
    for (const f of iframes) {
      const rect = f.getBoundingClientRect();
      if (rect.width >= 200 && rect.height >= 120) {
        f.style.pointerEvents = 'auto';
        f.setAttribute('allowfullscreen', 'true');
        fixedCount++;
      }
    }

    // 3. Remove transparent click-jacking / ad-overlay divs covering the video or page
    const allDivs = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[class*="overlay"], [id*="overlay"], [class*="preroll"], [class*="ad-"], [id*="ad-"]'
      )
    );
    for (const el of allDivs) {
      if (el.closest('#arc-chrome-overlay-root') || el.closest('#arc-japanese-study')) continue;
      const style = window.getComputedStyle(el);
      const z = parseInt(style.zIndex || '0', 10);
      if (
        (style.position === 'fixed' || style.position === 'absolute') &&
        z > 50 &&
        !el.querySelector('video, iframe')
      ) {
        el.style.pointerEvents = 'none';
        el.style.opacity = '0';
        fixedCount++;
      }
    }

    // 4. Highlight primary video or player iframe so user can see what was unlocked
    const targetMedia =
      findPrimaryVideo() ||
      iframes.find((f) => {
        const r = f.getBoundingClientRect();
        return r.width >= 240 && r.height >= 140;
      });
    if (targetMedia) {
      targetMedia.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const prevOutline = targetMedia.style.outline;
      targetMedia.style.outline = '3px solid #34d399';
      setTimeout(() => {
        targetMedia.style.outline = prevOutline;
      }, 2000);
    }

    updateYouTubeWidgetState();
    livePageContext = collectPageContext();
    showToast(`✓ Inspected DOM & unlocked ${fixedCount || 1} media/page element(s)`);
  }

  function executeDomVoiceAction(domAction?: {
    type: string;
    direction?: string;
    targetText?: string;
    value?: string;
    taskPrompt?: string;
  }) {
    if (!domAction) return;

    if (domAction.type === 'fix_page') {
      fixAndInspectPageDom();
    } else if (domAction.type === 'toggle_pip') {
      ytToggleNativePip();
    } else if (domAction.type === 'scroll') {
      const amount = Math.round(window.innerHeight * 0.72);
      if (domAction.direction === 'down') {
        window.scrollBy({ top: amount, behavior: 'smooth' });
      } else if (domAction.direction === 'up') {
        window.scrollBy({ top: -amount, behavior: 'smooth' });
      } else if (domAction.direction === 'bottom') {
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
      } else if (domAction.direction === 'top') {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    } else if (domAction.type === 'history') {
      if (domAction.direction === 'back') window.history.back();
      else if (domAction.direction === 'forward') window.history.forward();
      else if (domAction.direction === 'reload') window.location.reload();
    } else if (domAction.type === 'click' && domAction.targetText) {
      const needle = domAction.targetText.toLowerCase().trim();
      const candidates = Array.from(
        document.querySelectorAll<HTMLElement>(
          'a, button, [role="button"], input[type="submit"], input[type="button"], summary, label'
        )
      );
      let bestMatch: HTMLElement | null = null;
      for (const el of candidates) {
        const text = (
          el.innerText ||
          el.getAttribute('aria-label') ||
          el.getAttribute('title') ||
          (el as HTMLInputElement).value ||
          ''
        )
          .toLowerCase()
          .trim();
        if (text === needle) {
          bestMatch = el;
          break;
        }
        if (!bestMatch && text.includes(needle)) {
          bestMatch = el;
        }
      }
      if (bestMatch) {
        bestMatch.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const prevOutline = bestMatch.style.outline;
        bestMatch.style.outline = '3px solid #a78bfa';
        setTimeout(() => {
          if (bestMatch) bestMatch.style.outline = prevOutline;
        }, 1400);
        bestMatch.click();
      } else {
        showToast(`Could not find button/link matching "${domAction.targetText}"`);
      }
    } else if (domAction.type === 'type' && typeof domAction.value === 'string') {
      let input = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
      if (!input || (input.tagName !== 'INPUT' && input.tagName !== 'TEXTAREA')) {
        input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
          'input[type="search"], input[type="text"], input:not([type]), textarea'
        );
      }
      if (input) {
        input.focus();
        input.value = domAction.value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    } else if (domAction.type === 'antigravity') {
      openAgentSidebar('antigravity', domAction.taskPrompt || '', '', true);
    }
  }

  async function processVoiceTranscript(transcript: string) {
    const clean = transcript.trim();
    if (!clean) return;
    voiceFinalTranscript = clean;
    voiceInterimTranscript = '';
    voiceProcessing = true;
    voiceReplyText = 'Thinking...';

    try {
      const pageContext = collectPageContext();
      const res = await chrome.runtime.sendMessage({
        type: 'HANDLE_VOICE_COMMAND',
        transcript: clean,
        pageContext,
        preferredAgent: voicePreferredAgent
      });
      voiceProcessing = false;
      if (res?.reply) {
        voiceReplyText = res.reply;
        if (settings.voiceAutoSpeak !== false) {
          speakText(res.reply, 'en-US');
        }
      }
      if (res?.domAction) {
        executeDomVoiceAction(res.domAction);
      }
      syncSnapshot();
    } catch (err) {
      voiceProcessing = false;
      voiceReplyText = `Voice error: ${String(err)}`;
    }
  }

  function toggleVoiceAssistant() {
    if (isVoiceListening) {
      stopVoiceRecognition();
      return;
    }
    startVoiceRecognition();
  }

  function startVoiceRecognition() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SpeechRec = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRec) {
      showToast('SpeechRecognition is not supported in this browser tab.');
      return;
    }

    if (recognitionInstance) {
      try {
        recognitionInstance.stop();
      } catch {
        // ignore
      }
    }

    const rec = new SpeechRec();
    rec.lang = navigator.language || 'en-US';
    rec.interimResults = true;
    rec.continuous = voiceContinuousMode;
    rec.maxAlternatives = 1;

    showVoiceOrb = true;
    isVoiceListening = true;
    voiceInterimTranscript = '';
    voiceFinalTranscript = '';
    voiceReplyText = 'Listening... Speak a browser command, or ask ChatGPT / Antigravity';

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rec.onresult = (event: any) => {
      let interim = '';
      let finalChunk = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        if (res.isFinal) {
          finalChunk += res[0].transcript;
        } else {
          interim += res[0].transcript;
        }
      }
      if (interim) {
        voiceInterimTranscript = interim;
      }
      if (finalChunk.trim()) {
        processVoiceTranscript(finalChunk.trim());
      }
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rec.onerror = (event: any) => {
      if (event.error === 'not-allowed') {
        voiceReplyText = 'Microphone access denied. Please allow microphone permission for this site.';
        isVoiceListening = false;
      } else if (event.error !== 'no-speech') {
        voiceReplyText = `Mic status: ${event.error}`;
      }
    };

    rec.onend = () => {
      if (voiceContinuousMode && showVoiceOrb && isVoiceListening) {
        try {
          rec.start();
          return;
        } catch {
          // ignore
        }
      }
      isVoiceListening = false;
    };

    recognitionInstance = rec;
    try {
      rec.start();
    } catch {
      // ignore
    }
  }

  function stopVoiceRecognition() {
    isVoiceListening = false;
    if (recognitionInstance) {
      try {
        recognitionInstance.stop();
      } catch {
        // ignore
      }
    }
  }

  // 6. Media sidebar widget state
  let isYouTubeOrVideoPage = $state(false);
  let videoCaptionTranslation = $state('');
  let videoCaptionTranslating = $state(false);
  let ytSideWidgetExpanded = $state(true);
  let ytTitle = $state('');
  let ytChannel = $state('');
  let ytThumbnail = $state('');
  let ytPlaying = $state(false);
  let ytMuted = $state(false);
  let ytCurrentTime = $state(0);
  let ytDuration = $state(0);
  let ytSpeed = $state(1);
  let ytLoopStart = $state<number | null>(null);
  let ytLoopEnd = $state<number | null>(null);
  let ytPipActive = $state(false);
  let ytDesktopPipActive = $state(false);
  let ytCaptionLine = $state('');
  let ytSearchQuery = $state('');
  let activeVideoEl: HTMLVideoElement | null = null;
  let desktopStreamInstance: DesktopVideoStream | null = null;

  function formatMediaTime(sec: number): string {
    if (!Number.isFinite(sec) || sec < 0) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function findPrimaryVideo(): HTMLVideoElement | null {
    const videos = Array.from(document.querySelectorAll('video')).filter(
      (v) => v.getBoundingClientRect().width >= 120 || v.readyState > 0
    );
    return (
      videos.sort(
        (a, b) =>
          b.getBoundingClientRect().width * b.getBoundingClientRect().height -
          a.getBoundingClientRect().width * a.getBoundingClientRect().height
      )[0] || null
    );
  }

  async function translateVideoCaption(line: string) {
    const clean = line.trim();
    if (!clean) return;
    videoCaptionTranslating = true;
    try {
      const res = await requestArc({
        type: 'TRANSLATE_SELECTION',
        text: clean,
        targetLang: settings.targetLanguage || 'en'
      });
      videoCaptionTranslating = false;
      if (res.ok) {
        videoCaptionTranslation = res.result.translatedText;
      }
    } catch {
      videoCaptionTranslating = false;
    }
  }

  function updateYouTubeWidgetState() {
    if (currentPageUrl !== window.location.href) {
      currentPageUrl = window.location.href;
    }
    const host = window.location.hostname.toLowerCase();
    const isYt = host.includes('youtube.com') || host.includes('youtu.be');
    const vid = findPrimaryVideo();

    if (activeVideoEl !== vid) {
      activeVideoEl = vid;
      ytLoopStart = null;
      ytLoopEnd = null;
      if (desktopStreamInstance?.active) {
        desktopStreamInstance.stop();
      }
      desktopStreamInstance = null;
      ytCaptionLine = '';
    }

    isYouTubeOrVideoPage = isYt || Boolean(vid);
    if (!isYouTubeOrVideoPage) return;

    if (isYt) {
      const h1 =
        document.querySelector<HTMLElement>('h1.ytd-watch-metadata yt-formatted-string') ||
        document.querySelector<HTMLElement>('ytd-watch-metadata h1');
      const ch =
        document.querySelector<HTMLElement>('#owner #channel-name a') ||
        document.querySelector<HTMLElement>('ytd-channel-name a');
      ytTitle =
        h1?.innerText?.trim() ||
        document.title.replace(/^\(\d+\)\s*/, '').replace(/\s*-\s*YouTube$/i, '') ||
        'YouTube';
      ytChannel = ch?.innerText?.trim() || '';
      const vidId = new URLSearchParams(window.location.search).get('v');
      ytThumbnail = vidId ? `https://i.ytimg.com/vi/${vidId}/mqdefault.jpg` : '';
    } else {
      ytTitle = document.title || formatCleanHost(window.location.href);
      ytChannel = formatCleanHost(window.location.href);
      ytThumbnail = '';
    }

    if (vid) {
      ytPlaying = !vid.paused && !vid.ended;
      ytMuted = vid.muted;
      ytCurrentTime = vid.currentTime || 0;
      const newDur = Number.isFinite(vid.duration) ? vid.duration : 0;
      ytDuration = newDur;
      ytSpeed = vid.playbackRate || 1;
      ytPipActive = document.pictureInPictureElement === vid;
      ytDesktopPipActive = Boolean(desktopStreamInstance?.active);

      if (
        ytLoopStart !== null &&
        ytLoopEnd !== null &&
        (vid.currentTime >= ytLoopEnd || vid.currentTime < ytLoopStart - 0.5)
      ) {
        vid.currentTime = ytLoopStart;
      }

      ytCaptionLine = Array.from(document.querySelectorAll('.ytp-caption-segment'))
        .map(node => node.textContent || '').join(' ').trim();
    } else {
      ytPlaying = false;
      ytCurrentTime = 0;
      ytDuration = 0;
      ytPipActive = false;
    }
  }

  function ytTogglePlay() {
    const vid = findPrimaryVideo();
    if (!vid) return;
    if (vid.paused) vid.play().catch(() => {});
    else vid.pause();
    updateYouTubeWidgetState();
  }

  function ytSeekRelative(deltaSec: number) {
    const vid = findPrimaryVideo();
    if (!vid) return;
    vid.currentTime = Math.max(0, Math.min(vid.duration || Infinity, vid.currentTime + deltaSec));
    updateYouTubeWidgetState();
  }

  function ytSetSpeed(rate: number) {
    const vid = findPrimaryVideo();
    if (!vid) return;
    vid.playbackRate = rate;
    ytSpeed = rate;
  }

  function ytToggleLoop5s() {
    const vid = findPrimaryVideo();
    if (!vid) return;
    if (ytLoopStart !== null) {
      ytLoopStart = null;
      ytLoopEnd = null;
    } else {
      ytLoopEnd = Math.max(1, vid.currentTime);
      ytLoopStart = Math.max(0, ytLoopEnd - 5);
      vid.currentTime = ytLoopStart;
      if (vid.paused) vid.play().catch(() => {});
    }
  }

  async function ytToggleNativePip() {
    const vid = findPrimaryVideo();
    if (!vid) return;
    try {
      if (document.pictureInPictureElement === vid) {
        await document.exitPictureInPicture();
      } else {
        await vid.requestPictureInPicture();
      }
      updateYouTubeWidgetState();
    } catch {
      showToast('Click on the video once first to enable Picture-in-Picture.');
    }
  }

  async function ytToggleDesktopPip() {
    const vid = findPrimaryVideo();
    if (!vid) return;
    if (!desktopStreamInstance) {
      desktopStreamInstance = new DesktopVideoStream(
        vid,
        () => updateYouTubeWidgetState(),
        (msg) => showToast(msg)
      );
    }
    try {
      if (desktopStreamInstance.active) {
        desktopStreamInstance.stop();
      } else {
        await desktopStreamInstance.start();
      }
      updateYouTubeWidgetState();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Could not start Desktop PiP');
    }
  }

  function ytOpenTimestampNoteInChatGpt() {
    const stamp = formatMediaTime(ytCurrentTime);
    const prompt = [
      `Help me understand or summarize this YouTube video at ${stamp}:`,
      `Video: "${ytTitle}" (${window.location.href})`,
      ytCaptionLine ? `Current Subtitle at ${stamp}: "${ytCaptionLine}"` : ''
    ]
      .filter(Boolean)
      .join('\n');
    sendToChatGPT(prompt, '', true);
  }

  async function syncSnapshot() {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GET_SNAPSHOT' });
      if (res?.state) {
        arcState = res.state;
        tabs = res.tabs || [];
        targetLang = res.state.settings?.targetLanguage || 'en';
      }
    } catch {
      // ignore if extension context invalidated
    }
  }

  function handleLeftEdgeEnter() {
    if (hideTimeout) {
      clearTimeout(hideTimeout);
      hideTimeout = null;
    }
    if (settings.leftSidebarMode !== 'pinned') {
      if (!leftSidebarHoverOpen) {
        leftSidebarHoverOpen = true;
        syncSnapshot();
      }
    }
  }

  function handleLeftSidebarLeave() {
    if (isDraggingSidebar || isResizingSidebar || activeDrag) return;
    if (settings.leftSidebarMode !== 'pinned') {
      if (hideTimeout) clearTimeout(hideTimeout);
      hideTimeout = setTimeout(() => {
        if (!isDraggingSidebar && !isResizingSidebar && !activeDrag) {
          leftSidebarHoverOpen = false;
        }
      }, 240);
    }
  }

  async function togglePinLeftSidebar() {
    const isCurrentlyPinned = settings.leftSidebarMode === 'pinned';
    const nextMode = isCurrentlyPinned ? 'hover' : 'pinned';
    leftSidebarHoverOpen = !isCurrentlyPinned;
    const res = await chrome.runtime.sendMessage({
      type: 'UPDATE_SETTINGS',
      settings: { leftSidebarMode: nextMode }
    });
    if (res?.state) {
      arcState = res.state;
      tabs = res.tabs || [];
    }
    if (nextMode === 'hover') {
      showToast('◧ Sidebar minified — move cursor to the leftmost edge to slide out like macOS');
    } else {
      showToast('📌 Sidebar pinned open');
    }
  }

  onMount(() => {
    syncSnapshot();
    updateYouTubeWidgetState();
    const ytInterval = setInterval(updateYouTubeWidgetState, 400);

    const msgListener = (
      msg: {
        type?: string;
        url?: string;
        text?: string;
        mode?: string;
        selectionText?: string;
        customPrompt?: string;
      },
      _sender: chrome.runtime.MessageSender,
      sendResponse: (response?: unknown) => void
    ) => {
      if (msg?.type === 'TRIGGER_ANTIGRAVITY_HANDOFF') {
        sendToAntigravity(msg.customPrompt || '', msg.selectionText || '');
        sendResponse({ ok: true });
        return;
      } else if (msg?.type === 'TOGGLE_COMMAND_BAR') {
        if (showCommandBar) {
          showCommandBar = false;
        } else {
          openCommandBar(msg.mode === 'little-arc' ? 'little-arc' : 'default');
        }
        sendResponse({ ok: true });
        return;
      } else if (msg?.type === 'SHOW_PEEK_OVERLAY' && msg.url) {
        sendResponse({ ok: openPeek(msg.url) });
        return;
      } else if (msg?.type === 'SHOW_TRANSLATION_POPOVER' && msg.text) {
        selectionText = msg.text;
        pillPosition = {
          x: Math.min(window.innerWidth - 340, Math.max(24, window.innerWidth / 2 - 160)),
          y: Math.min(window.innerHeight - 240, Math.max(24, window.innerHeight / 3))
        };
        triggerTranslation(msg.text);
        sendResponse({ ok: true });
        return;
      } else if (msg?.type === 'ARC_STATE_UPDATED') {
        syncSnapshot();
      }
    };

    chrome.runtime.onMessage.addListener(msgListener);

    const handleKeydown = (e: KeyboardEvent) => {
      // Alt+V -> Toggle Voice Browser Control (ChatGPT + Antigravity + Browser Voice Agent)
      if (e.altKey && !e.metaKey && !e.ctrlKey && e.key.toLowerCase() === 'v') {
        e.preventDefault();
        e.stopPropagation();
        toggleVoiceAssistant();
        return;
      }

      // Alt+G -> Ask ChatGPT about current selection or page (in Little Arc)
      if (e.altKey && !e.metaKey && !e.ctrlKey && e.key.toLowerCase() === 'g') {
        e.preventDefault();
        e.stopPropagation();
        const sel = window.getSelection()?.toString().trim() || '';
        sendToChatGPT('', sel, true);
        return;
      }

      // Alt+A -> Send current selection or page to Antigravity (antigravity://)
      if (e.altKey && !e.metaKey && !e.ctrlKey && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        e.stopPropagation();
        const sel = window.getSelection()?.toString().trim() || '';
        sendToAntigravity('', sel);
        return;
      }

      // Alt+B -> Launch Borderless Arc Window (No Chrome top tab bar or URL bar)
      if (e.altKey && !e.metaKey && !e.ctrlKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        e.stopPropagation();
        chrome.runtime.sendMessage({
          type: 'LAUNCH_BORDERLESS_ARC',
          url: window.location.href
        });
        return;
      }

      // Alt+S -> Toggle Persistent Left Arc Sidebar on or off
      if (e.altKey && !e.metaKey && !e.ctrlKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        e.stopPropagation();
        togglePinLeftSidebar();
        return;
      }

      // Cmd+K / Ctrl+K or Alt+Space -> Toggle Arc Command Bar
      if (
        ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'k') ||
        (e.altKey && e.code === 'Space')
      ) {
        e.preventDefault();
        e.stopPropagation();
        if (showCommandBar) {
          showCommandBar = false;
        } else {
          openCommandBar('default');
        }
        return;
      }

      // Alt+T -> Translate current highlighted selection
      if (e.altKey && e.key.toLowerCase() === 't') {
        const sel = window.getSelection()?.toString().trim();
        if (sel) {
          e.preventDefault();
          selectionText = sel;
          const rect = window.getSelection()?.getRangeAt(0)?.getBoundingClientRect();
          pillPosition = rect
            ? {
                x: Math.min(window.innerWidth - 350, Math.max(16, rect.left)),
                y: Math.min(window.innerHeight - 220, Math.max(16, rect.bottom + 10))
              }
            : { x: window.innerWidth / 2 - 160, y: 120 };
          triggerTranslation(sel);
        }
        return;
      }

      if (e.key === 'Escape') {
        if (showCommandBar) {
          showCommandBar = false;
          e.stopPropagation();
        } else if (peekUrl) {
          peekUrl = null;
          e.stopPropagation();
        } else if (showTranslateCard || showTranslatePill) {
          showTranslateCard = false;
          showTranslatePill = false;
        } else if (leftSidebarHoverOpen) {
          leftSidebarHoverOpen = false;
        }
      }
    };

    const handleClickCapture = (e: MouseEvent) => {
      if (settings.peekTrigger === 'off') return;
      const isTriggerPressed =
        (settings.peekTrigger === 'shift-click' && e.shiftKey && !e.metaKey && !e.ctrlKey) ||
        (settings.peekTrigger === 'alt-click' && e.altKey && !e.metaKey && !e.ctrlKey);

      if (!isTriggerPressed) return;

      const target = e.target as HTMLElement | null;
      const anchor = target?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!anchor || !canPreviewInPeek(anchor.href)) return;

      e.preventDefault();
      e.stopPropagation();

      if (settings.peekMode === 'popup') {
        chrome.runtime.sendMessage({ type: 'OPEN_LITTLE_ARC', url: anchor.href });
      } else {
        openPeek(anchor.href);
      }
    };

    const handleMouseUp = (e: MouseEvent) => {
      const path = e.composedPath();
      if (path.some((el) => (el as HTMLElement)?.id === 'arc-chrome-extension-root')) {
        return;
      }

      setTimeout(() => {
        const sel = window.getSelection();
        const text = sel?.toString().trim() || '';

        if (text.length < 2 || text.length > 2500) {
          if (!showTranslateCard) {
            showTranslatePill = false;
          }
          return;
        }

        const activeEl = document.activeElement;
        if (
          activeEl &&
          (activeEl.tagName === 'INPUT' ||
            activeEl.tagName === 'TEXTAREA' ||
            (activeEl as HTMLElement).isContentEditable)
        ) {
          return;
        }

        try {
          const range = sel!.getRangeAt(0);
          const rect = range.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) return;

          selectionText = text;
          pillPosition = {
            x: Math.min(window.innerWidth - 350, Math.max(16, rect.left + rect.width / 2 - 55)),
            y: Math.min(window.innerHeight - 60, Math.max(16, rect.bottom + 8))
          };

          if (settings.translateOnSelectMode === 'instant') {
            triggerTranslation(text);
          } else if (settings.translateOnSelectMode === 'pill') {
            showTranslateCard = false;
            showTranslatePill = true;
          }
        } catch {
          // ignore range errors
        }
      }, 15);
    };

    const handleMouseDown = (e: MouseEvent) => {
      const path = e.composedPath();
      if (!path.some((el) => (el as HTMLElement)?.id === 'arc-chrome-extension-root')) {
        showTranslatePill = false;
        showTranslateCard = false;
      }
    };

    // macOS Leftmost-Edge Auto-Show / Auto-Hide Sensor
    const handleMouseMove = (e: MouseEvent) => {
      if (settings.leftSidebarMode === 'pinned') return;
      if (e.clientX <= 14) {
        handleLeftEdgeEnter();
      } else if (leftSidebarHoverOpen && e.clientX > sidebarX + sidebarWidth + 32) {
        handleLeftSidebarLeave();
      } else if (leftSidebarHoverOpen && e.clientX <= sidebarX + sidebarWidth + 12) {
        if (hideTimeout) {
          clearTimeout(hideTimeout);
          hideTimeout = null;
        }
      }
    };

    window.addEventListener('keydown', handleKeydown, true);
    window.addEventListener('click', handleClickCapture, true);
    window.addEventListener('mouseup', handleMouseUp);
    window.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('mousemove', handleMouseMove, { passive: true });

    return () => {
      clearInterval(ytInterval);
      window.removeEventListener('keydown', handleKeydown, true);
      window.removeEventListener('click', handleClickCapture, true);
      window.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('mousemove', handleMouseMove);
      if (desktopStreamInstance?.active) desktopStreamInstance.stop();
      if (chrome.runtime?.id) chrome.runtime.onMessage.removeListener(msgListener);
    };
  });

  function formatCleanHost(url: string): string {
    try {
      const u = new URL(url);
      const host = u.hostname.replace(/^www\./, '');
      const path = u.pathname === '/' ? '' : u.pathname;
      return `${host}${path}`.slice(0, 34);
    } catch {
      return url.slice(0, 34);
    }
  }

  async function openNewTab() {
    try { await requestArc({ type: 'OPEN_FOCUSED_NEW_TAB' }); }
    catch { showToast('Could not open a new tab. Refresh this page and try again.'); }
  }

  async function openCommandBar(
    mode: 'default' | 'little-arc' = 'default',
    prefillCurrentUrl = false
  ) {
    commandMode = mode;
    showCommandBar = true;
    commandQuery = prefillCurrentUrl ? window.location.href : '';
  }

  async function runOmniboxItem(item: OmniboxResultItem, forcePeek = false) {
    const usePeek = forcePeek || commandMode === 'little-arc';

    if (item.kind === 'tab' && typeof item.tabId === 'number' && !usePeek) {
      if (item.spaceId) {
        await requestArc({ type: 'SET_ACTIVE_SPACE', spaceId: item.spaceId });
      }
      await requestArc({ type: 'SWITCH_TAB', tabId: item.tabId });
    } else if (item.kind === 'action' && item.actionId) {
      await requestArc({
        type: 'EXECUTE_OMNIBOX_ACTION',
        actionId: item.actionId
      });
    } else if (item.url) {
      if (!usePeek || !openPeek(item.url)) {
        await requestArc({
          type: 'OPEN_OR_SWITCH_URL',
          url: item.url,
          spaceId: item.spaceId
        });
      }
    }
    showCommandBar = false;
  }

  async function openSidebarUrl(url: string, event?: MouseEvent) {
    if (!url) return;
    try {
      if (event && shouldPeek(event, settings) && canPreviewInPeek(url)) {
        if (settings.peekMode === 'popup') await requestArc({ type: 'OPEN_LITTLE_ARC', url });
        else openPeek(url);
        return;
      }
      if (event && (event.metaKey || event.ctrlKey)) {
        await requestArc({ type: 'CREATE_TAB', url, spaceId: activeSpace?.id, active: true });
        return;
      }
      await requestArc({ type: 'OPEN_OR_SWITCH_URL', url, spaceId: activeSpace?.id });
    } catch {
      // Fallback direct navigation if extension service worker was reloaded
      if (!canPreviewInPeek(url)) {
        showToast('Open this page from Chrome’s address bar.');
        return;
      }
      if (event && (event.metaKey || event.ctrlKey)) {
        window.open(url, '_blank');
      } else {
        window.location.href = url;
      }
    }
  }

  async function switchToSidebarTab(tab: TabInfo, event?: MouseEvent) {
    try {
      await requestArc({ type: 'SWITCH_TAB', tabId: tab.id });
    } catch {
      if (tab.url && canPreviewInPeek(tab.url)) {
        if (event && (event.metaKey || event.ctrlKey)) {
          window.open(tab.url, '_blank');
        } else {
          window.location.href = tab.url;
        }
      }
    }
  }

  function openPeek(url: string) {
    if (!canPreviewInPeek(url)) return false;
    peekUrl = url;
    peekCopied = false;
    return true;
  }

  function expandPeekToFullTab() {
    if (!peekUrl) return;
    const url = peekUrl;
    peekUrl = null;
    chrome.runtime.sendMessage({ type: 'CREATE_TAB', url, active: true });
  }

  function popOutPeekToLittleArc() {
    if (!peekUrl) return;
    const url = peekUrl;
    peekUrl = null;
    chrome.runtime.sendMessage({ type: 'OPEN_LITTLE_ARC', url });
  }

  async function triggerTranslation(text = selectionText) {
    if (!text.trim()) return;
    const request = ++translationVersion;
    showTranslatePill = false;
    showTranslateCard = true;
    translating = true;
    translatedText = '';
    translationError = '';
    copiedTranslation = false;

    if (pillPosition) {
      pillPosition = {
        x: Math.max(16, Math.min(window.innerWidth - 360, pillPosition.x)),
        y: Math.max(16, Math.min(window.innerHeight - 240, pillPosition.y))
      };
    }

    try {
      const res = await chrome.runtime.sendMessage({
        type: 'TRANSLATE_TEXT',
        text,
        targetLang
      });
      if (request !== translationVersion) return;
      if (res?.error || !res?.translatedText) throw new Error('Translation unavailable');
      translatedText = res.translatedText;
      detectedLang = res?.detectedSourceLang || 'auto';
    } catch {
      if (request === translationVersion) translationError = 'Could not translate. Check your connection and try again.';
    } finally {
      if (request === translationVersion) translating = false;
    }
  }

  function speakText(text: string, lang: string) {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang;
    window.speechSynthesis.speak(utterance);
  }

  const OVERLAY_CSS = `
    :host {
      all: initial;
      font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', 'Segoe UI', Roboto, sans-serif;
      color: #f4f4f8;
    }
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', 'Segoe UI', Roboto, sans-serif;
    }

    button:focus-visible, [role="button"]:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 2px solid #c5bdf6; outline-offset: 2px; }
    button:disabled { opacity: .4; cursor: default; }
    .folder-symbol { display: flex; align-items: center; gap: 6px; }
    .arc-ls-row:focus-within .arc-ls-close { opacity: 1; }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; } }
    /* Left-Edge Hover Trigger Strip */
    .arc-left-trigger {
      position: fixed;
      top: 0;
      left: 0;
      width: 7px;
      height: 100vh;
      z-index: 2147483643;
      background: transparent;
    }

    /* Left-Side Arc Sidebar Drawer */
    .arc-left-sidebar {
      position: fixed;
      z-index: 2147483644;
      border-radius: 16px;
      border: 1px solid rgba(255, 255, 255, 0.2);
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.65), 0 0 0 1px rgba(0, 0, 0, 0.4);
      display: flex;
      flex-direction: column;
      padding: 6px 10px 10px;
      color: #f4f4f8;
      transform: translateX(-340px);
      opacity: 0;
      pointer-events: none;
      transition: transform 0.22s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.18s ease, background 0.3s ease;
      overflow: hidden;
      user-select: none;
    }

    .arc-left-sidebar.visible {
      transform: translateX(0);
      opacity: 1;
      pointer-events: auto;
    }

    .arc-left-sidebar.no-transition {
      transition: none !important;
    }

    /* macOS Leftmost-Edge Auto-Show Sensor & Top-Left Minified Pill */
    .arc-left-edge-sensor {
      position: fixed;
      top: 0;
      left: 0;
      bottom: 0;
      width: 14px;
      z-index: 2147483643;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: flex-start;
    }

    .arc-left-edge-bar {
      width: 4px;
      height: 96px;
      border-radius: 0 999px 999px 0;
      background: rgba(167, 139, 250, 0.25);
      transition: all 0.16s ease;
    }

    .arc-left-edge-sensor:hover .arc-left-edge-bar {
      width: 6px;
      height: 140px;
      background: #a78bfa;
      box-shadow: 0 0 14px rgba(167, 139, 250, 0.85);
    }

    .arc-macos-minified-pill {
      position: fixed;
      top: 10px;
      left: 8px;
      z-index: 2147483644;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      border-radius: 10px;
      background: rgba(20, 18, 38, 0.88);
      border: 1px solid rgba(255, 255, 255, 0.22);
      color: #fff;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      backdrop-filter: blur(14px);
      box-shadow: 0 8px 22px rgba(0, 0, 0, 0.45);
      transition: all 0.15s ease;
    }

    .arc-macos-minified-pill:hover {
      background: rgba(139, 124, 248, 0.35);
      border-color: rgba(167, 139, 250, 0.65);
      transform: translateX(2px);
    }

    /* macOS / Arc Top-Left Sidebar Bar */
    .arc-macos-topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      margin-bottom: 6px;
      padding: 2px 0;
    }

    .arc-macos-left-controls {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .arc-macos-sidebar-btn {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 4px 8px;
      border-radius: 8px;
      border: 1px solid rgba(255, 255, 255, 0.2);
      background: rgba(255, 255, 255, 0.12);
      color: #fff;
      font-size: 11px;
      font-weight: 700;
      cursor: pointer;
      transition: all 0.12s ease;
    }

    .arc-macos-sidebar-btn:hover {
      background: rgba(255, 255, 255, 0.24);
      border-color: rgba(255, 255, 255, 0.38);
    }

    .arc-macos-sidebar-btn.auto-mode {
      background: rgba(52, 211, 153, 0.22);
      border-color: rgba(52, 211, 153, 0.55);
      color: #6ee7b7;
    }

    .arc-macos-nav-btn {
      width: 24px;
      height: 24px;
      border-radius: 7px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      background: rgba(255, 255, 255, 0.08);
      color: rgba(255, 255, 255, 0.88);
      font-size: 12px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.12s ease;
    }

    .arc-macos-nav-btn:hover {
      background: rgba(255, 255, 255, 0.2);
      color: #fff;
    }

    .arc-top-places-hdr {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 2px;
      margin-top: 2px;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: rgba(255, 255, 255, 0.65);
    }

    .arc-top-places-add-btn {
      background: rgba(255, 255, 255, 0.1);
      border: 1px solid rgba(255, 255, 255, 0.18);
      color: rgba(255, 255, 255, 0.9);
      border-radius: 6px;
      padding: 2px 7px;
      font-size: 10px;
      font-weight: 700;
      cursor: pointer;
      transition: background 0.12s ease;
    }

    .arc-top-places-add-btn:hover {
      background: rgba(255, 255, 255, 0.22);
      color: #fff;
    }

    .arc-ls-dragbar {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      height: 20px;
      cursor: grab;
      border-radius: 8px;
      transition: background 0.12s ease;
    }

    .arc-ls-dragbar:hover {
      background: rgba(255, 255, 255, 0.08);
    }

    .arc-ls-dragbar:active {
      cursor: grabbing;
      background: rgba(255, 255, 255, 0.14);
    }

    .arc-ls-grip {
      width: 36px;
      height: 4px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.28);
    }

    .arc-ls-resize-right {
      position: absolute;
      top: 12px;
      right: 0;
      bottom: 18px;
      width: 7px;
      cursor: ew-resize;
      z-index: 10;
    }

    .arc-ls-resize-right:hover {
      background: rgba(255, 255, 255, 0.18);
    }

    .arc-ls-resize-corner {
      position: absolute;
      right: 0;
      bottom: 0;
      width: 16px;
      height: 16px;
      cursor: nwse-resize;
      z-index: 11;
    }

    .drop-highlight {
      outline: 2px dashed rgba(255, 255, 255, 0.65) !important;
      background: rgba(255, 255, 255, 0.16) !important;
    }

    .arc-ls-top {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-bottom: 8px;
    }

    .arc-ls-urlbar {
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 7px 9px;
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.11);
      border: 1px solid rgba(255, 255, 255, 0.16);
      cursor: pointer;
    }

    .arc-ls-urlbar:hover {
      background: rgba(255, 255, 255, 0.17);
    }

    .arc-ls-urltext {
      flex: 1;
      font-size: 12px;
      font-weight: 500;
      color: rgba(255, 255, 255, 0.92);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .arc-ls-iconbtn {
      background: rgba(255, 255, 255, 0.12);
      border: none;
      color: #fff;
      width: 22px;
      height: 22px;
      border-radius: 6px;
      font-size: 11px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .arc-ls-iconbtn:hover {
      background: rgba(255, 255, 255, 0.25);
    }

    .arc-ls-favs {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 6px;
    }

    .arc-ls-fav {
      position: relative;
      height: 42px;
      border-radius: 11px;
      background: rgba(255, 255, 255, 0.09);
      border: 1px solid rgba(255, 255, 255, 0.14);
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: all 0.14s ease;
    }

    .arc-ls-fav.active {
      background: linear-gradient(145deg, rgba(167, 139, 250, 0.38) 0%, rgba(255, 255, 255, 0.24) 100%);
      border-color: rgba(196, 181, 253, 0.9);
      box-shadow:
        0 4px 14px rgba(139, 124, 248, 0.35),
        inset 0 0 0 1px rgba(255, 255, 255, 0.35);
    }

    .arc-ls-fav.active::after {
      content: '';
      position: absolute;
      bottom: 3px;
      left: 50%;
      transform: translateX(-50%);
      width: 14px;
      height: 3px;
      border-radius: 999px;
      background: #c4b5fd;
      box-shadow: 0 0 6px #a78bfa;
    }

    .arc-ls-fav:hover {
      background: rgba(255, 255, 255, 0.22);
      border-color: rgba(255, 255, 255, 0.38);
      transform: translateY(-1px);
    }

    .arc-ls-fav img {
      width: 20px;
      height: 20px;
      border-radius: 4px;
      pointer-events: none;
    }

    .arc-ls-fav-remove {
      position: absolute;
      top: 2px;
      right: 2px;
      width: 15px;
      height: 15px;
      border-radius: 50%;
      border: none;
      background: rgba(15, 14, 24, 0.85);
      color: rgba(255, 255, 255, 0.85);
      font-size: 11px;
      line-height: 1;
      display: none;
      align-items: center;
      justify-content: center;
      cursor: pointer;
    }

    .arc-ls-fav:hover .arc-ls-fav-remove,
    .arc-ls-fav:focus-within .arc-ls-fav-remove {
      display: flex;
    }

    .arc-ls-fav-remove:hover {
      background: #ef4444;
      color: #fff;
    }

    .arc-ls-fav-add {
      border: 1px dashed rgba(255, 255, 255, 0.25);
      background: rgba(255, 255, 255, 0.04);
      color: rgba(255, 255, 255, 0.72);
      font-size: 16px;
      font-weight: 500;
    }

    .arc-ls-fav-add:hover {
      border-color: rgba(255, 255, 255, 0.55);
      color: #fff;
    }

    .arc-custom-pin-popover {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 8px;
      border-radius: 10px;
      background: rgba(12, 12, 24, 0.65);
      border: 1px solid rgba(255, 255, 255, 0.18);
      margin-bottom: 4px;
    }

    .arc-custom-pin-input {
      width: 100%;
      background: rgba(255, 255, 255, 0.09);
      border: 1px solid rgba(255, 255, 255, 0.18);
      border-radius: 7px;
      padding: 5px 8px;
      color: #fff;
      font-size: 11.5px;
      outline: none;
    }

    .arc-custom-pin-actions {
      display: flex;
      gap: 5px;
    }

    .arc-custom-pin-btn {
      flex: 1;
      padding: 5px 7px;
      border-radius: 7px;
      border: 1px solid rgba(255, 255, 255, 0.16);
      background: rgba(255, 255, 255, 0.12);
      color: #fff;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
    }

    .arc-custom-pin-btn.primary {
      background: #8b7cf8;
      border-color: transparent;
      color: #0e0e18;
    }

    /* YouTube & Media Sidebar Companion Widget */
    .arc-yt-widget {
      display: flex;
      flex-direction: column;
      gap: 7px;
      padding: 9px 10px;
      border-radius: 12px;
      background: linear-gradient(155deg, rgba(42, 16, 26, 0.72) 0%, rgba(16, 15, 28, 0.85) 100%);
      border: 1px solid rgba(251, 113, 133, 0.35);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
    }

    .arc-yt-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
    }

    .arc-yt-badge {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: 10.5px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: #fda4af;
    }

    .arc-yt-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #ef4444;
      box-shadow: 0 0 8px #ef4444;
    }

    .arc-yt-meta {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .arc-yt-thumb {
      width: 56px;
      height: 34px;
      border-radius: 6px;
      object-fit: cover;
      flex-shrink: 0;
      border: 1px solid rgba(255, 255, 255, 0.16);
    }

    .arc-yt-titles {
      flex: 1;
      min-width: 0;
    }

    .arc-yt-title {
      font-size: 11.5px;
      font-weight: 600;
      color: #fff;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .arc-yt-sub {
      font-size: 10.5px;
      color: rgba(255, 255, 255, 0.65);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .arc-yt-progress-row {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 10px;
      color: rgba(255, 255, 255, 0.72);
      font-variant-numeric: tabular-nums;
    }

    .arc-yt-scrubber {
      flex: 1;
      height: 4px;
      accent-color: #fb7185;
      cursor: pointer;
    }

    .arc-yt-controls {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 4px;
    }

    .arc-yt-btn {
      padding: 5px 4px;
      border-radius: 7px;
      border: 1px solid rgba(255, 255, 255, 0.15);
      background: rgba(255, 255, 255, 0.09);
      color: #fff;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 3px;
      transition: background 0.12s ease;
    }

    .arc-yt-btn:hover {
      background: rgba(255, 255, 255, 0.2);
    }

    .arc-yt-btn.active {
      background: rgba(244, 63, 94, 0.38);
      border-color: #fb7185;
      color: #fff;
    }

    .arc-yt-caption {
      font-size: 11px;
      color: #e9d5ff;
      background: rgba(15, 12, 28, 0.6);
      border: 1px solid rgba(192, 132, 252, 0.25);
      border-radius: 7px;
      padding: 5px 7px;
      line-height: 1.35;
      max-height: 44px;
      overflow: hidden;
    }

    .arc-ls-scroll {
      min-height: 0;
      overscroll-behavior: contain;
      flex: 1;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding-right: 2px;
    }

    .arc-ls-scroll::-webkit-scrollbar {
      width: 4px;
    }

    .arc-ls-scroll::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.2);
      border-radius: 4px;
    }

    .arc-ls-space-hdr {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 4px 6px;
      font-size: 12.5px;
      font-weight: 700;
      color: #fff;
    }

    .arc-ls-row {
      min-height: 36px;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 8px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 12.5px;
      color: rgba(255, 255, 255, 0.86);
      transition: background 0.12s ease;
    }

    .arc-ls-row:hover {
      background: rgba(255, 255, 255, 0.16);
      color: #fff;
    }

    .arc-ls-row.active {
      background: linear-gradient(90deg, rgba(167, 139, 250, 0.36) 0%, rgba(255, 255, 255, 0.2) 100%);
      border: 1px solid rgba(196, 181, 253, 0.55);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
      color: #fff;
      font-weight: 700;
    }

    .arc-ls-row img {
      width: 15px;
      height: 15px;
      border-radius: 3px;
      flex-shrink: 0;
      pointer-events: none;
    }

    .arc-ls-row-title {
      flex: 1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .arc-ls-close {
      background: transparent;
      border: none;
      color: rgba(255, 255, 255, 0.6);
      font-size: 13px;
      width: 18px;
      height: 18px;
      border-radius: 4px;
      cursor: pointer;
      display: none;
      align-items: center;
      justify-content: center;
    }

    .arc-ls-row:hover .arc-ls-close {
      display: flex;
    }

    .arc-ls-close:hover {
      background: rgba(255, 255, 255, 0.2);
      color: #fff;
    }

    .arc-ls-divider {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 6px 4px;
      font-size: 10.5px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: rgba(255, 255, 255, 0.5);
    }

    .arc-ls-divider-line {
      flex: 1;
      height: 1px;
      background: rgba(255, 255, 255, 0.14);
    }

    .arc-ls-clear {
      background: none;
      border: none;
      color: rgba(255, 255, 255, 0.6);
      font-size: 10.5px;
      cursor: pointer;
    }

    .arc-ls-clear:hover {
      color: #fff;
    }

    .arc-ls-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding-top: 8px;
      margin-top: 6px;
      border-top: 1px solid rgba(255, 255, 255, 0.14);
    }

    .arc-ls-spaces {
      display: flex;
      gap: 5px;
    }

    .arc-ls-space-pill {
      width: 30px;
      height: 30px;
      border-radius: 8px;
      border: 1px solid transparent;
      background: rgba(255, 255, 255, 0.09);
      color: #fff;
      font-size: 14px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .arc-ls-space-pill.active {
      background: rgba(255, 255, 255, 0.24);
      border-color: #fff;
    }

    .arc-cmd-backdrop { position: fixed; inset: 0; z-index: 2147483646; background: #10101466; backdrop-filter: blur(9px); padding: max(40px, 14vh) 16px 16px; display: flex; align-items: flex-start; }

    /* Arc Peek Modal */
    .arc-peek-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(8, 8, 18, 0.68);
      backdrop-filter: blur(8px);
      z-index: 2147483645;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 3vh 4vw;
      animation: arcFadeIn 0.16s ease-out;
    }

    .arc-peek-window {
      width: min(1060px, 92vw);
      height: 88vh;
      background: #292830;
      border: 1px solid #ffffff24;
      border-radius: 18px;
      box-shadow: 0 32px 90px rgba(0, 0, 0, 0.75);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .arc-peek-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 14px;
      background: #2d2b36;
      border-bottom: 1px solid rgba(255, 255, 255, 0.12);
      gap: 12px;
    }

    .arc-peek-badge {
      background: rgba(139, 124, 248, 0.24);
      border: 1px solid rgba(139, 124, 248, 0.5);
      color: #d8d2ff;
      font-size: 11px;
      font-weight: 700;
      padding: 3px 8px;
      border-radius: 6px;
      letter-spacing: 0.03em;
    }

    .arc-peek-url {
      flex: 1;
      font-size: 12.5px;
      color: rgba(255, 255, 255, 0.8);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .arc-peek-actions {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .arc-peek-btn {
      background: rgba(255, 255, 255, 0.12);
      border: 1px solid rgba(255, 255, 255, 0.16);
      color: #fff;
      font-size: 12px;
      font-weight: 500;
      padding: 5px 10px;
      border-radius: 8px;
      cursor: pointer;
      transition: background 0.12s ease;
    }

    .arc-peek-btn:hover {
      background: rgba(255, 255, 255, 0.22);
    }

    .arc-peek-btn.primary {
      background: #8b7cf8;
      color: #0e0e18;
      border-color: transparent;
      font-weight: 700;
    }

    .arc-peek-iframe {
      flex: 1;
      width: 100%;
      border: none;
      background: #ffffff;
    }

    /* Highlight-to-Translate Pill & Card */
    .arc-translate-pill {
      position: fixed;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      border-radius: 999px;
      background: linear-gradient(135deg, #2b1f5c 0%, #191633 100%);
      border: 1px solid rgba(165, 152, 255, 0.45);
      color: #ffffff;
      font-size: 12.5px;
      font-weight: 600;
      box-shadow: 0 10px 26px rgba(0, 0, 0, 0.45);
      cursor: pointer;
      transition: transform 0.12s ease, box-shadow 0.12s ease;
      animation: arcFadeIn 0.12s ease-out;
    }

    .arc-translate-pill:hover {
      transform: translateY(-1px) scale(1.02);
      box-shadow: 0 12px 30px rgba(0, 0, 0, 0.6);
    }

    .arc-translate-card {
      max-width: calc(100vw - 32px);
      position: fixed;
      z-index: 2147483647;
      width: 340px;
      background: linear-gradient(160deg, rgba(31, 25, 58, 0.98) 0%, rgba(18, 17, 32, 0.99) 100%);
      border: 1px solid rgba(165, 152, 255, 0.38);
      border-radius: 14px;
      padding: 12px 14px;
      color: #f4f4f8;
      box-shadow: 0 22px 55px rgba(0, 0, 0, 0.65);
      display: flex;
      flex-direction: column;
      gap: 10px;
      animation: arcFadeIn 0.14s ease-out;
    }

    .arc-translate-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      padding-bottom: 8px;
    }

    .arc-lang-bar {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11.5px;
      color: rgba(255, 255, 255, 0.75);
    }

    .arc-lang-select {
      background: rgba(255, 255, 255, 0.1);
      border: 1px solid rgba(255, 255, 255, 0.2);
      color: #fff;
      font-size: 11.5px;
      padding: 3px 6px;
      border-radius: 6px;
      outline: none;
    }

    .arc-translate-close {
      background: rgba(255, 255, 255, 0.1);
      border: none;
      color: #fff;
      width: 22px;
      height: 22px;
      border-radius: 50%;
      cursor: pointer;
      font-size: 13px;
    }

    .arc-translate-body {
      font-size: 13.5px;
      line-height: 1.5;
      color: #ffffff;
      max-height: 180px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .arc-translate-footer {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 6px;
    }

    .arc-mini-btn {
      background: rgba(255, 255, 255, 0.1);
      border: 1px solid rgba(255, 255, 255, 0.14);
      color: #fff;
      font-size: 11px;
      padding: 4px 9px;
      border-radius: 6px;
      cursor: pointer;
    }

    .arc-mini-btn:hover {
      background: rgba(255, 255, 255, 0.2);
    }

    /* ChatGPT, Antigravity & Voice Quick Bar in Sidebar */
    .arc-ai-strip {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 5px;
    }

    .arc-ai-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      padding: 6px 5px;
      border-radius: 9px;
      background: rgba(255, 255, 255, 0.1);
      border: 1px solid rgba(255, 255, 255, 0.16);
      color: #fff;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.14s ease, transform 0.12s ease;
    }

    .arc-ai-btn.listening {
      background: linear-gradient(135deg, rgba(244, 63, 94, 0.45), rgba(167, 139, 250, 0.45));
      border-color: #fb7185;
      box-shadow: 0 0 14px rgba(244, 63, 94, 0.45);
    }

    .arc-ai-btn:hover {
      background: rgba(255, 255, 255, 0.2);
      transform: translateY(-1px);
    }

    /* Floating Arc Voice Orb */
    .arc-voice-orb-card {
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%);
      width: min(520px, 90vw);
      z-index: 2147483647;
      background: linear-gradient(155deg, rgba(28, 22, 56, 0.97) 0%, rgba(15, 14, 29, 0.99) 100%);
      border: 1px solid rgba(167, 139, 250, 0.45);
      border-radius: 20px;
      padding: 14px 16px;
      color: #f4f4f8;
      box-shadow: 0 26px 70px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(255, 255, 255, 0.08);
      display: flex;
      flex-direction: column;
      gap: 10px;
      backdrop-filter: blur(20px);
    }

    .arc-voice-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }

    .arc-voice-modes {
      display: flex;
      gap: 5px;
    }

    .arc-voice-mode-pill {
      padding: 4px 9px;
      border-radius: 999px;
      border: 1px solid rgba(255, 255, 255, 0.16);
      background: rgba(255, 255, 255, 0.07);
      color: rgba(255, 255, 255, 0.78);
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
    }

    .arc-voice-mode-pill.active {
      background: rgba(167, 139, 250, 0.28);
      border-color: #a78bfa;
      color: #fff;
    }

    .arc-voice-main {
      display: flex;
      align-items: center;
      gap: 14px;
    }

    .arc-mic-orb {
      width: 48px;
      height: 48px;
      border-radius: 50%;
      border: none;
      background: linear-gradient(135deg, #8b7cf8, #f472b6);
      color: #fff;
      font-size: 20px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      flex-shrink: 0;
      box-shadow: 0 0 0 0 rgba(244, 114, 182, 0.6);
      transition: transform 0.15s ease;
    }

    .arc-mic-orb.listening {
      animation: arcPulseOrb 1.5s infinite;
      background: linear-gradient(135deg, #f43f5e, #a855f7);
    }

    .arc-voice-texts {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .arc-voice-transcript {
      font-size: 14.5px;
      font-weight: 600;
      color: #ffffff;
      line-height: 1.35;
    }

    .arc-voice-reply {
      font-size: 12.5px;
      color: rgba(216, 210, 255, 0.85);
      line-height: 1.4;
    }

    .arc-voice-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      padding-top: 4px;
      border-top: 1px solid rgba(255, 255, 255, 0.09);
    }

    .arc-voice-chip {
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.12);
      color: rgba(255, 255, 255, 0.82);
      font-size: 11px;
      padding: 3px 8px;
      border-radius: 999px;
      cursor: pointer;
    }

    .arc-voice-chip:hover {
      background: rgba(255, 255, 255, 0.18);
      color: #fff;
    }

    @keyframes arcPulseOrb {
      0% {
        box-shadow: 0 0 0 0 rgba(244, 63, 94, 0.65);
      }
      70% {
        box-shadow: 0 0 0 14px rgba(244, 63, 94, 0);
      }
      100% {
        box-shadow: 0 0 0 0 rgba(244, 63, 94, 0);
      }
    }

    .arc-ai-box {
      display: flex;
      flex-direction: column;
      gap: 7px;
      padding: 9px;
      border-radius: 11px;
      background: rgba(10, 10, 22, 0.55);
      border: 1px solid rgba(255, 255, 255, 0.18);
    }

    .arc-ai-textarea {
      width: 100%;
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.16);
      border-radius: 8px;
      padding: 7px 8px;
      color: #fff;
      font-size: 12px;
      resize: none;
      outline: none;
    }

    .arc-ai-ctx-toggle {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      color: rgba(255, 255, 255, 0.78);
      cursor: pointer;
    }

    .arc-ai-actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px;
    }

    .arc-ai-submit {
      padding: 6px 8px;
      border-radius: 7px;
      border: none;
      font-size: 11.5px;
      font-weight: 700;
      cursor: pointer;
      color: #0e0e18;
      background: #34d399;
    }

    .arc-ai-submit.agy {
      background: linear-gradient(135deg, #a78bfa, #f472b6);
    }

    /* Multi-action Selection Pill Bar */
    .arc-selection-bar {
      position: fixed;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px;
      border-radius: 999px;
      background: linear-gradient(135deg, rgba(35, 26, 74, 0.96) 0%, rgba(20, 18, 38, 0.98) 100%);
      border: 1px solid rgba(165, 152, 255, 0.45);
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.55);
      animation: arcFadeIn 0.12s ease-out;
    }

    .arc-sel-btn {
      display: flex;
      align-items: center;
      gap: 5px;
      padding: 5px 10px;
      border-radius: 999px;
      border: none;
      background: transparent;
      color: #fff;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.12s ease;
    }

    .arc-sel-btn:hover {
      background: rgba(255, 255, 255, 0.18);
    }

    .arc-toast {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 2147483647;
      background: linear-gradient(135deg, #271b52 0%, #16142c 100%);
      border: 1px solid rgba(167, 139, 250, 0.5);
      color: #fff;
      padding: 11px 16px;
      border-radius: 12px;
      font-size: 13px;
      font-weight: 600;
      box-shadow: 0 16px 42px rgba(0, 0, 0, 0.6);
      animation: arcFadeIn 0.15s ease-out;
    }

    @keyframes arcFadeIn {
      from {
        opacity: 0;
        transform: translateY(4px) scale(0.98);
      }
      to {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
    }

    /* Full-Height ChatGPT & Antigravity Browser Agent Sidebar */
    .arc-agent-sidebar {
      position: fixed;
      z-index: 2147483645;
      display: flex;
      flex-direction: column;
      border-radius: 16px;
      background: linear-gradient(165deg, rgba(20, 18, 38, 0.97) 0%, rgba(11, 10, 22, 0.98) 100%);
      border: 1px solid rgba(167, 139, 250, 0.35);
      box-shadow:
        0 20px 55px rgba(0, 0, 0, 0.65),
        inset 0 1px 0 rgba(255, 255, 255, 0.14);
      backdrop-filter: blur(22px);
      color: #fff;
      overflow: hidden;
      animation: arcFadeIn 0.16s ease-out;
    }

    .arc-agent-sidebar.mode-antigravity {
      border-color: rgba(244, 114, 182, 0.42);
      background: linear-gradient(165deg, rgba(28, 16, 42, 0.97) 0%, rgba(12, 10, 24, 0.98) 100%);
    }

    .arc-agent-hdr {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      padding: 10px 12px 8px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      background: rgba(255, 255, 255, 0.03);
    }

    .arc-agent-tabs {
      display: flex;
      gap: 4px;
      background: rgba(0, 0, 0, 0.35);
      padding: 3px;
      border-radius: 10px;
      border: 1px solid rgba(255, 255, 255, 0.1);
    }

    .arc-agent-tab {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 5px 10px;
      border-radius: 7px;
      border: none;
      background: transparent;
      color: rgba(255, 255, 255, 0.68);
      font-size: 11.5px;
      font-weight: 700;
      cursor: pointer;
      transition: all 0.12s ease;
    }

    .arc-agent-tab.active.gpt {
      background: linear-gradient(135deg, #10b981, #059669);
      color: #06130e;
      box-shadow: 0 2px 10px rgba(16, 185, 129, 0.35);
    }

    .arc-agent-tab.active.agy {
      background: linear-gradient(135deg, #a78bfa, #f472b6);
      color: #12091c;
      box-shadow: 0 2px 10px rgba(244, 114, 182, 0.35);
    }

    .arc-agent-hdr-actions {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .arc-agent-iconbtn {
      width: 25px;
      height: 25px;
      border-radius: 7px;
      border: 1px solid rgba(255, 255, 255, 0.14);
      background: rgba(255, 255, 255, 0.07);
      color: rgba(255, 255, 255, 0.85);
      font-size: 12px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .arc-agent-iconbtn:hover {
      background: rgba(255, 255, 255, 0.18);
      color: #fff;
    }

    .arc-agent-ctx-bar {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 8px 12px;
      background: rgba(255, 255, 255, 0.04);
      border-bottom: 1px solid rgba(255, 255, 255, 0.09);
    }

    .arc-agent-ctx-status {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      font-size: 11px;
      color: rgba(255, 255, 255, 0.82);
    }

    .arc-agent-live-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #34d399;
      box-shadow: 0 0 8px #34d399;
      display: inline-block;
    }

    .arc-agent-quick-tools {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
    }

    .arc-agent-tool-chip {
      padding: 4px 8px;
      border-radius: 7px;
      border: 1px solid rgba(255, 255, 255, 0.15);
      background: rgba(255, 255, 255, 0.08);
      color: rgba(255, 255, 255, 0.9);
      font-size: 10.5px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.12s ease;
    }

    .arc-agent-tool-chip:hover {
      background: rgba(167, 139, 250, 0.25);
      border-color: rgba(167, 139, 250, 0.55);
      color: #fff;
    }

    .arc-agent-drawer {
      max-height: 175px;
      overflow-y: auto;
      padding: 8px 12px;
      background: rgba(8, 7, 16, 0.72);
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      display: flex;
      flex-direction: column;
      gap: 6px;
      font-size: 11px;
    }

    .arc-agent-feed {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      overscroll-behavior: contain;
    }

    .arc-agent-msg {
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-width: 94%;
      padding: 9px 11px;
      border-radius: 12px;
      font-size: 12px;
      line-height: 1.45;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .arc-agent-msg.user {
      align-self: flex-end;
      background: linear-gradient(135deg, rgba(139, 124, 248, 0.35), rgba(99, 102, 241, 0.28));
      border: 1px solid rgba(167, 139, 250, 0.45);
      color: #fff;
    }

    .arc-agent-msg.assistant {
      align-self: flex-start;
      background: rgba(255, 255, 255, 0.07);
      border: 1px solid rgba(255, 255, 255, 0.13);
      color: rgba(255, 255, 255, 0.94);
    }

    .arc-agent-msg-meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      font-size: 10px;
      color: rgba(255, 255, 255, 0.55);
      font-weight: 600;
    }

    .arc-agent-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      align-self: flex-start;
      padding: 2px 7px;
      border-radius: 999px;
      background: rgba(52, 211, 153, 0.16);
      border: 1px solid rgba(52, 211, 153, 0.4);
      color: #6ee7b7;
      font-size: 10px;
      font-weight: 700;
      margin-bottom: 2px;
    }

    .arc-agent-msg-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      margin-top: 4px;
      padding-top: 5px;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
    }

    .arc-agent-composer {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 10px 12px;
      border-top: 1px solid rgba(255, 255, 255, 0.12);
      background: rgba(12, 11, 24, 0.9);
    }

    .arc-agent-input-row {
      display: flex;
      align-items: flex-end;
      gap: 6px;
    }

    .arc-agent-textarea {
      flex: 1;
      background: rgba(255, 255, 255, 0.09);
      border: 1px solid rgba(255, 255, 255, 0.18);
      border-radius: 10px;
      padding: 8px 10px;
      color: #fff;
      font-size: 12px;
      font-family: inherit;
      resize: none;
      outline: none;
      min-height: 44px;
      max-height: 120px;
    }

    .arc-agent-textarea:focus {
      border-color: rgba(167, 139, 250, 0.65);
      background: rgba(255, 255, 255, 0.12);
    }

    .arc-agent-send {
      height: 36px;
      padding: 0 12px;
      border-radius: 9px;
      border: none;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
      color: #090d16;
      background: linear-gradient(135deg, #34d399, #10b981);
      flex-shrink: 0;
    }

    .arc-agent-send.agy {
      background: linear-gradient(135deg, #a78bfa, #f472b6);
    }
  `;
</script>

<svelte:element this={'style'}>{OVERLAY_CSS}</svelte:element>

<!-- Persistent / macOS Left-Edge Auto-Show Arc Sidebar Overlay -->
{#if !isLeftSidebarVisible}
  <!-- macOS Leftmost-Edge Hover Strip: Move cursor to the leftmost edge to slide out sidebar -->
  <div
    class="arc-left-edge-sensor"
    role="button"
    tabindex="0"
    onpointerenter={handleLeftEdgeEnter}
    onclick={togglePinLeftSidebar}
    onkeydown={(e) => isActivationKey(e) && togglePinLeftSidebar()}
    title="Move cursor to leftmost edge to slide out Arc Sidebar (Click to Pin Open · Alt+S)"
  >
    <div class="arc-left-edge-bar"></div>
  </div>

  <!-- Easy-to-spot Top-Left macOS Sidebar Button when minified -->
  <button
    class="arc-macos-minified-pill"
    onpointerenter={handleLeftEdgeEnter}
    onclick={togglePinLeftSidebar}
    title="Open & Pin Left Arc Sidebar (or hover leftmost edge to slide out like macOS · Alt+S)"
  >
    <Icon name="sidebar" size={14} />
    <span>Sidebar</span>
  </button>
{/if}

<aside
  class="arc-left-sidebar {isLeftSidebarVisible ? 'visible' : ''} {isDraggingSidebar || isResizingSidebar ? 'no-transition' : ''}"
  style="
    background: {currentTheme.gradient};
    left: {sidebarX}px;
    top: {sidebarY}px;
    width: {sidebarWidth}px;
    {sidebarHeight ? `height: ${sidebarHeight}px;` : `bottom: 8px;`}
  "
  onpointerenter={() => {
    if (hideTimeout) {
      clearTimeout(hideTimeout);
      hideTimeout = null;
    }
  }}
  onpointerleave={handleLeftSidebarLeave}
>
  <!-- macOS Top-Left Controls Bar: Prominent Left-Side Minify/Pin Button + Back/Forward/Reload + Drag Grip -->
  <div class="arc-macos-topbar">
    <div class="arc-macos-left-controls">
      <button
        class="arc-macos-sidebar-btn {settings.leftSidebarMode !== 'pinned' ? 'auto-mode' : ''}"
        onclick={(e) => {
          e.stopPropagation();
          togglePinLeftSidebar();
        }}
        title={settings.leftSidebarMode === 'pinned'
          ? 'Minify Sidebar to Left Edge (Slides out when cursor touches leftmost edge like macOS · Alt+S)'
          : 'Pin Sidebar Open Permanently (Alt+S)'}
      >
        <Icon name="sidebar" size={14} />
        <span>{settings.leftSidebarMode === 'pinned' ? 'Minify' : '📌 Pin'}</span>
      </button>

      <button
        class="arc-macos-nav-btn"
        onclick={() => window.history.back()}
        title="Back"
      >
        ‹
      </button>
      <button
        class="arc-macos-nav-btn"
        onclick={() => window.history.forward()}
        title="Forward"
      >
        ›
      </button>
      <button
        class="arc-macos-nav-btn"
        onclick={() => window.location.reload()}
        title="Reload Page"
      >
        ↻
      </button>
    </div>

    <div
      class="arc-ls-dragbar"
      role="button"
      tabindex="0"
      onpointerdown={startSidebarMove}
      ondblclick={resetSidebarPosition}
      title="Drag to move sidebar anywhere · Double-click to reset to left edge"
    >
      <div class="arc-ls-grip"></div>
    </div>

    <button
      class="arc-macos-nav-btn"
      onclick={(e) => {
        e.stopPropagation();
        chrome.runtime.sendMessage({
          type: 'LAUNCH_BORDERLESS_ARC',
          url: window.location.href
        });
      }}
      title="Open in Borderless Arc Window (No Chrome top bar · Alt+B)"
    >
      <Icon name="window" size={13} />
    </button>
  </div>

  <!-- Right-edge width resize handle & Bottom-right corner resize handle -->
  <div
    class="arc-ls-resize-right"
    role="presentation"
    onpointerdown={(e) => startSidebarResize(e, false)}
    title="Drag to resize sidebar width"
  ></div>
  <div
    class="arc-ls-resize-corner"
    role="presentation"
    onpointerdown={(e) => startSidebarResize(e, true)}
    title="Drag to resize sidebar width & height"
  ></div>

  <div class="arc-ls-top">
    <!-- URL / Command Bar Trigger -->
    <div
      class="arc-ls-urlbar"
      role="button"
      tabindex="0"
      onclick={() => openCommandBar('default', true)}
      onkeydown={(e) => isActivationKey(e) && openCommandBar('default', true)}
      title="Click to edit URL or press Cmd+K to open Arc Command Bar"
    >
      <span style="opacity: .65"><Icon name="search" size={15} /></span>
      <span class="arc-ls-urltext">{formatCleanHost(window.location.href)}</span>
      <button
        class="arc-ls-iconbtn"
        onclick={(e) => {
          e.stopPropagation();
          navigator.clipboard.writeText(window.location.href);
          copiedCurrentUrl = true;
          setTimeout(() => (copiedCurrentUrl = false), 1400);
        }}
        title="Copy current URL"
      >
        <Icon name={copiedCurrentUrl ? 'check' : 'link'} size={14} />
      </button>
    </div>

    <!-- Top Places Header + Grid (Per-Space Top Places like Arc on macOS) -->
    <div class="arc-top-places-hdr">
      <span>{activeSpace?.icon} {activeSpace?.name} · Top Places</span>
      <button
        class="arc-top-places-add-btn"
        onclick={() => {
          showAddFavForm = !showAddFavForm;
          showAddPinForm = false;
          showAddFolderForm = false;
        }}
        title="Add current page or custom URL to {activeSpace?.name} Top Places"
      >
        {showAddFavForm ? 'Close' : '+ Add Place'}
      </button>
    </div>

      <!-- Space-Specific Top Pins / Favorites Grid (Supports Drag & Drop, Remove, and Custom Pin Creation!) -->
      <div
        class="arc-ls-favs {dropTargetHighlight === 'favorites' ? 'drop-highlight' : ''}"
        role="region"
        aria-label="{activeSpace?.name} Top Pins"
        ondragover={(e) => {
          e.preventDefault();
          dropTargetHighlight = 'favorites';
        }}
        ondragleave={() => {
          if (dropTargetHighlight === 'favorites') dropTargetHighlight = null;
        }}
        ondrop={async (e) => {
          e.preventDefault();
          dropTargetHighlight = null;
          if (activeDrag?.kind === 'tab') {
            await chrome.runtime.sendMessage({
              type: 'ADD_FAVORITE',
              spaceId: activeSpace?.id,
              title: activeDrag.tab.title,
              url: activeDrag.tab.url,
              favIconUrl: activeDrag.tab.favIconUrl
            });
            syncSnapshot();
          } else if (activeDrag?.kind === 'pin') {
            await chrome.runtime.sendMessage({
              type: 'ADD_FAVORITE',
              spaceId: activeSpace?.id,
              title: activeDrag.title,
              url: activeDrag.url,
              favIconUrl: activeDrag.favIconUrl
            });
            syncSnapshot();
          }
          activeDrag = null;
        }}
      >
        {#each spaceFavorites as fav, favIdx (fav.id)}
          <div
            class="arc-ls-fav"
            class:active={isUrlActive(fav.url, currentPageUrl)}
            role="button"
            tabindex="0"
            draggable="true"
            onpointerdown={(e) => {
              pointerDownCoords = { x: e.clientX, y: e.clientY };
            }}
            ondragstart={() => {
              activeDrag = { kind: 'fav', index: favIdx };
            }}
            ondragend={(e) => {
              const dist = Math.hypot(e.clientX - pointerDownCoords.x, e.clientY - pointerDownCoords.y);
              activeDrag = null;
              dropTargetHighlight = null;
              if (dist < 10) {
                openSidebarUrl(fav.url, e);
              }
            }}
            ondragover={(e) => e.preventDefault()}
            ondrop={async (e) => {
              e.preventDefault();
              if (activeDrag?.kind === 'fav' && activeDrag.index !== favIdx) {
                e.stopPropagation();
                await chrome.runtime.sendMessage({
                  type: 'REORDER_FAVORITES',
                  spaceId: activeSpace?.id,
                  fromIndex: activeDrag.index,
                  toIndex: favIdx
                });
                syncSnapshot();
              }
              activeDrag = null;
            }}
            onclick={(event) => openSidebarUrl(fav.url, event)}
            onkeydown={(event) => { if (isActivationKey(event)) openSidebarUrl(fav.url); }}
            title="{fav.title} ({fav.url}) · Click to open · Drag to reorder"
          >
            {#if getFaviconUrl(fav.url, fav.favIconUrl)}
              <img src={getFaviconUrl(fav.url, fav.favIconUrl)} alt={fav.title} draggable="false" />
            {:else}
              <span style="font-weight: 700; font-size: 13px;">
                {fav.title.slice(0, 1).toUpperCase()}
              </span>
            {/if}
            <button
              class="arc-ls-fav-remove"
              onclick={async (e) => {
                e.stopPropagation();
                await chrome.runtime.sendMessage({
                  type: 'REMOVE_FAVORITE',
                  spaceId: activeSpace?.id,
                  favoriteId: fav.id
                });
                syncSnapshot();
              }}
              title="Remove {fav.title} from {activeSpace?.name} top pins"
              aria-label="Remove {fav.title}"
            >
              ×
            </button>
          </div>
        {/each}

        <button
          class="arc-ls-fav arc-ls-fav-add"
          onclick={() => {
            showAddFavForm = !showAddFavForm;
            showAddPinForm = false;
            showAddFolderForm = false;
          }}
          title="Add custom top pin to {activeSpace?.name}"
          aria-label="Add custom top pin to {activeSpace?.name}"
        >
          ＋
        </button>
      </div>

      {#if showAddFavForm}
        <div class="arc-custom-pin-popover">
          <div style="display: flex; align-items: center; justify-content: space-between; font-size: 11px; font-weight: 600; color: rgba(255,255,255,0.85);">
            <span>New Top Pin in {activeSpace?.icon} {activeSpace?.name}</span>
            <button
              style="background: none; border: none; color: rgba(255,255,255,0.6); cursor: pointer; font-size: 13px;"
              onclick={() => (showAddFavForm = false)}
            >
              ×
            </button>
          </div>
          <button
            class="arc-custom-pin-btn"
            onclick={async () => {
              await addCurrentPageToSpaceFavorites();
              showAddFavForm = false;
            }}
          >
            📌 Pin Current Page ({formatCleanHost(window.location.href)})
          </button>
          <input
            class="arc-custom-pin-input"
            type="text"
            placeholder="Custom URL (e.g. figma.com, linear.app)..."
            bind:value={customFavUrl}
            onkeydown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') submitCustomSpaceFavorite();
              if (e.key === 'Escape') showAddFavForm = false;
            }}
          />
          <div class="arc-custom-pin-actions">
            <input
              class="arc-custom-pin-input"
              style="flex: 1;"
              type="text"
              placeholder="Title (optional)"
              bind:value={customFavTitle}
              onkeydown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') submitCustomSpaceFavorite();
              }}
            />
            <button
              class="arc-custom-pin-btn primary"
              style="flex: 0 0 auto; padding: 5px 12px;"
              onclick={submitCustomSpaceFavorite}
            >
              Add
            </button>
          </div>
        </div>
      {/if}

      <div class="arc-ai-strip">
        <button
          class="arc-ai-btn {isVoiceListening ? 'listening' : ''}"
          onclick={() => toggleVoiceAssistant()}
          title="Voice Browser Control via ChatGPT & Antigravity (Alt+V)"
        >
          <span>{isVoiceListening ? '🔴' : '🎙️'}</span>
          <span>{isVoiceListening ? 'Listening' : 'Voice'}</span>
        </button>

        <button
          class="arc-ai-btn {showAgentSidebar && agentSidebarMode === 'chatgpt' ? 'listening' : ''}"
          onclick={(e) => {
            if (e.shiftKey) {
              launchExternalChatGPT('', '', true);
            } else if (showAgentSidebar && agentSidebarMode === 'chatgpt') {
              showAgentSidebar = false;
            } else {
              openAgentSidebar('chatgpt');
            }
          }}
          title="Open ChatGPT Browser Agent Sidebar with live page & DOM access (Alt+G · Shift+Click for ChatGPT Web)"
        >
          <span>🤖</span>
          <span>ChatGPT</span>
        </button>

        <button
          class="arc-ai-btn {showAgentSidebar && agentSidebarMode === 'antigravity' ? 'listening' : ''}"
          onclick={(e) => {
            if (e.shiftKey) {
              launchExternalAntigravity('', '');
            } else if (showAgentSidebar && agentSidebarMode === 'antigravity') {
              showAgentSidebar = false;
            } else {
              openAgentSidebar('antigravity');
            }
          }}
          title="Open Antigravity Browser Agent Sidebar with live page & DOM access (Alt+A · Shift+Click for Antigravity IDE)"
        >
          <span>🚀</span>
          <span>Antigravity</span>
        </button>
      </div>
      {#if isYouTubeOrVideoPage}
        <div class="arc-yt-widget" role="region" aria-label="Media & Subtitle Studio Companion">
          <div class="arc-yt-header">
            <span class="arc-yt-badge">
              <span class="arc-yt-dot"></span>
              <span>▶️ YouTube Studio</span>
            </span>
            <div style="display: flex; align-items: center; gap: 6px;">
              <button
                style="background: none; border: none; color: rgba(255,255,255,0.65); font-size: 11px; cursor: pointer;"
                onclick={() => (ytSideWidgetExpanded = !ytSideWidgetExpanded)}
                title={ytSideWidgetExpanded ? 'Collapse Media Studio' : 'Expand Media Studio'}
              >
                {ytSideWidgetExpanded ? '▾' : '▸'}
              </button>
            </div>
          </div>

          {#if ytSideWidgetExpanded}
            <div class="arc-yt-meta">
              {#if ytThumbnail}
                <img src={ytThumbnail} alt="" class="arc-yt-thumb" draggable="false" />
              {/if}
              <div class="arc-yt-titles">
                <div class="arc-yt-title" title={ytTitle}>{ytTitle}</div>
                {#if ytChannel}
                  <div class="arc-yt-sub">{ytChannel}</div>
                {/if}
              </div>
            </div>

            {#if ytDuration > 0}
              <div class="arc-yt-progress-row" style="position: relative;">
                <span>{formatMediaTime(ytCurrentTime)}</span>
                <div style="position: relative; flex: 1; display: flex; align-items: center;">
                  <input
                    class="arc-yt-scrubber"
                    style="width: 100%; position: relative; z-index: 2;"
                    type="range"
                    min="0"
                    max={ytDuration}
                    step="1"
                    value={ytCurrentTime}
                    oninput={(e) => {
                      const v = findPrimaryVideo();
                      if (v) v.currentTime = Number((e.currentTarget as HTMLInputElement).value);
                    }}
                  />
                </div>
                <span>{formatMediaTime(ytDuration)}</span>
              </div>

              <div class="arc-yt-controls">
                <button class="arc-yt-btn" onclick={() => ytSeekRelative(-5)} title="Rewind 5 seconds">
                  ⏪ 5s
                </button>
                <button class="arc-yt-btn {ytPlaying ? 'active' : ''}" onclick={ytTogglePlay} title={ytPlaying ? 'Pause' : 'Play'}>
                  {ytPlaying ? '⏸ Pause' : '▶ Play'}
                </button>
                <button class="arc-yt-btn" onclick={() => ytSeekRelative(5)} title="Forward 5 seconds">
                  5s ⏩
                </button>
                <button
                  class="arc-yt-btn {ytLoopStart !== null ? 'active' : ''}"
                  onclick={ytToggleLoop5s}
                  title="Loop last 5 seconds"
                >
                  🔁 {ytLoopStart !== null ? 'Stop' : 'Loop'}
                </button>
              </div>

              <div class="arc-yt-controls" style="grid-template-columns: 1fr 1fr 1fr;">
                <select
                  class="arc-yt-btn"
                  value={String(ytSpeed)}
                  onchange={(e) => ytSetSpeed(Number((e.currentTarget as HTMLSelectElement).value))}
                  title="Playback Speed"
                >
                  <option value="0.75">0.75×</option>
                  <option value="1">1.0×</option>
                  <option value="1.25">1.25×</option>
                  <option value="1.5">1.5×</option>
                  <option value="2">2.0×</option>
                </select>
                <button
                  class="arc-yt-btn {ytPipActive ? 'active' : ''}"
                  onclick={ytToggleNativePip}
                  title="Floating Picture-in-Picture Player"
                >
                  📺 PiP
                </button>
                <button
                  class="arc-yt-btn {ytDesktopPipActive ? 'active' : ''}"
                  onclick={ytToggleDesktopPip}
                  title="Picture-in-Picture Across macOS Desktops"
                >
                  🖥️ Float
                </button>
              </div>

              {#if ytCaptionLine}
                <button
                  type="button"
                  class="arc-yt-caption"
                  style="width: 100%; text-align: left; cursor: pointer;"
                  onclick={() => translateVideoCaption(ytCaptionLine)}
                  title="Click to translate this Japanese subtitle line"
                >
                  <div>{ytCaptionLine}</div>
                  {#if videoCaptionTranslating}
                    <div style="font-size: 10px; color: rgba(165, 180, 252, 0.85); margin-top: 3px;">Translating...</div>
                  {:else if videoCaptionTranslation}
                    <div style="font-size: 10.5px; color: #a7f3d0; margin-top: 3px; font-weight: 600;">
                      {videoCaptionTranslation}
                    </div>
                  {/if}
                </button>
              {/if}

              <div class="arc-yt-controls" style="grid-template-columns: 1fr 1fr;">
                <button
                  class="arc-yt-btn"
                  onclick={ytOpenTimestampNoteInChatGpt}
                  title="Ask ChatGPT about this exact moment & subtitle"
                >
                  🤖 Ask @ {formatMediaTime(ytCurrentTime)}
                </button>
              </div>
            {:else}
              <!-- On YouTube Home / Feed when no video is playing yet -->
              <div style="display: flex; gap: 5px;">
                <input
                  class="arc-custom-pin-input"
                  style="flex: 1;"
                  type="text"
                  placeholder="Search YouTube..."
                  bind:value={ytSearchQuery}
                  onkeydown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter' && ytSearchQuery.trim()) {
                      window.location.href = `https://www.youtube.com/results?search_query=${encodeURIComponent(ytSearchQuery.trim())}`;
                    }
                  }}
                />
                <button
                  class="arc-yt-btn active"
                  style="padding: 4px 9px;"
                  onclick={() => {
                    if (ytSearchQuery.trim()) {
                      window.location.href = `https://www.youtube.com/results?search_query=${encodeURIComponent(ytSearchQuery.trim())}`;
                    }
                  }}
                >
                  Go
                </button>
              </div>
            {/if}
          {/if}
        </div>
      {/if}
    </div>

    <!-- Scrollable Pinned & Today's Tabs -->
    <div class="arc-ls-scroll">
      <div
        class="arc-ls-space-hdr {dropTargetHighlight === 'pinned-root' ? 'drop-highlight' : ''}"
        role="region"
        aria-label="Pinned Header Drop Zone"
        ondragover={(e) => {
          e.preventDefault();
          dropTargetHighlight = 'pinned-root';
        }}
        ondragleave={() => {
          if (dropTargetHighlight === 'pinned-root') dropTargetHighlight = null;
        }}
        ondrop={async (e) => {
          e.preventDefault();
          dropTargetHighlight = null;
          if (activeDrag?.kind === 'tab') {
            await chrome.runtime.sendMessage({
              type: 'PIN_TAB_TO_SPACE',
              spaceId: activeSpace?.id,
              title: activeDrag.tab.title,
              url: activeDrag.tab.url,
              favIconUrl: activeDrag.tab.favIconUrl
            });
            syncSnapshot();
          }
          activeDrag = null;
        }}
      >
        <span>{activeSpace?.icon} {activeSpace?.name}</span>
        <div style="display: flex; align-items: center; gap: 4px;">
          <button
            class="arc-ls-iconbtn"
            onclick={() => {
              showAddPinForm = !showAddPinForm;
              showAddFolderForm = false;
              showAddFavForm = false;
            }}
            title="Create custom pinned link in {activeSpace?.name}"
          >
            ＋
          </button>
          <button
            class="arc-ls-iconbtn"
            onclick={() => {
              showAddFolderForm = !showAddFolderForm;
              showAddPinForm = false;
              showAddFavForm = false;
            }}
            title="Create new folder in {activeSpace?.name}"
          >
            <Icon name="folder" size={13} />
          </button>
          <button
            class="arc-ls-iconbtn"
            onclick={async () => {
              await chrome.runtime.sendMessage({
                type: 'PIN_TAB_TO_SPACE',
                spaceId: activeSpace?.id,
                title: document.title || window.location.href,
                url: window.location.href
              });
              syncSnapshot();
            }}
            title="Pin current page to {activeSpace?.name} (or drag any tab here)"
          >
            <Icon name="pin" size={14} />
          </button>
        </div>
      </div>

      {#if showAddPinForm}
        <div class="arc-custom-pin-popover">
          <div style="display: flex; align-items: center; justify-content: space-between; font-size: 11px; font-weight: 600; color: rgba(255,255,255,0.85);">
            <span>New Pinned Link in {activeSpace?.icon} {activeSpace?.name}</span>
            <button
              style="background: none; border: none; color: rgba(255,255,255,0.6); cursor: pointer; font-size: 13px;"
              onclick={() => (showAddPinForm = false)}
            >
              ×
            </button>
          </div>
          <input
            class="arc-custom-pin-input"
            type="text"
            placeholder="URL (e.g. docs.google.com, localhost:3000)..."
            bind:value={customPinUrl}
            onkeydown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') submitCustomSpacePin();
              if (e.key === 'Escape') showAddPinForm = false;
            }}
          />
          <div class="arc-custom-pin-actions">
            <input
              class="arc-custom-pin-input"
              style="flex: 1;"
              type="text"
              placeholder="Custom title (optional)"
              bind:value={customPinTitle}
              onkeydown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') submitCustomSpacePin();
              }}
            />
            <button
              class="arc-custom-pin-btn primary"
              style="flex: 0 0 auto; padding: 5px 12px;"
              onclick={submitCustomSpacePin}
            >
              Pin
            </button>
          </div>
        </div>
      {/if}

      {#if showAddFolderForm}
        <div class="arc-custom-pin-popover">
          <div class="arc-custom-pin-actions">
            <input
              class="arc-custom-pin-input"
              style="flex: 1;"
              type="text"
              placeholder="Folder name in {activeSpace?.name}..."
              bind:value={customFolderTitle}
              onkeydown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') submitCustomSpaceFolder();
                if (e.key === 'Escape') showAddFolderForm = false;
              }}
            />
            <button
              class="arc-custom-pin-btn primary"
              style="flex: 0 0 auto; padding: 5px 12px;"
              onclick={submitCustomSpaceFolder}
            >
              Create
            </button>
          </div>
        </div>
      {/if}

      <!-- Pinned Items (Supports Dragging to reorder or Dropping Tabs into Folders!) -->
      {#if activeSpace?.pinnedItems?.length}
        {#each activeSpace.pinnedItems as item, pinIdx (item.id)}
          {#if item.type === 'folder'}
            <div
              class="arc-ls-row {dropTargetHighlight === `folder-${item.id}` ? 'drop-highlight' : ''}"
              role="button"
              tabindex="0"
              draggable="true"
              ondragstart={() => {
                activeDrag = { kind: 'pin', index: pinIdx, url: '', title: item.title };
              }}
              ondragend={() => {
                activeDrag = null;
                dropTargetHighlight = null;
              }}
              ondragover={(e) => {
                e.preventDefault();
                dropTargetHighlight = `folder-${item.id}`;
              }}
              ondragleave={() => {
                if (dropTargetHighlight === `folder-${item.id}`) dropTargetHighlight = null;
              }}
              ondrop={async (e) => {
                e.preventDefault();
                dropTargetHighlight = null;
                if (activeDrag?.kind === 'tab') {
                  await chrome.runtime.sendMessage({
                    type: 'PIN_TAB_TO_SPACE',
                    spaceId: activeSpace.id,
                    title: activeDrag.tab.title,
                    url: activeDrag.tab.url,
                    favIconUrl: activeDrag.tab.favIconUrl,
                    folderId: item.id
                  });
                  syncSnapshot();
                } else if (activeDrag?.kind === 'pin' && activeDrag.index !== pinIdx) {
                  await chrome.runtime.sendMessage({
                    type: 'REORDER_PINNED',
                    spaceId: activeSpace.id,
                    fromIndex: activeDrag.index,
                    toIndex: pinIdx
                  });
                  syncSnapshot();
                }
                activeDrag = null;
              }}
              onclick={async () => {
                await chrome.runtime.sendMessage({
                  type: 'TOGGLE_FOLDER',
                  spaceId: activeSpace.id,
                  folderId: item.id
                });
                syncSnapshot();
              }}
              onkeydown={(e) => { if (isActivationKey(e)) { chrome.runtime.sendMessage({ type: 'TOGGLE_FOLDER', spaceId: activeSpace.id, folderId: item.id }).then(syncSnapshot); } }}
              aria-expanded={!item.collapsed}
              title="Drop tabs here to pin inside {item.title}"
            >
              <span class="folder-symbol">{item.collapsed ? '▸' : '▾'} <Icon name="folder" /></span>
              <span class="arc-ls-row-title">{item.title}</span>
            </div>
            {#if !item.collapsed}
              {#each pinnedRows(item.children, true) as { item: child, depth } (child.id)}
                {#if child.type === 'folder'}
                <div
                  class="arc-ls-row folder"
                  style="padding-left: {22 + depth * 16}px;"
                  role="button"
                  tabindex="0"
                  aria-expanded={!child.collapsed}
                  onclick={() => chrome.runtime.sendMessage({ type: 'TOGGLE_FOLDER', spaceId: activeSpace.id, folderId: child.id }).then(syncSnapshot)}
                  onkeydown={(e) => { if (isActivationKey(e)) chrome.runtime.sendMessage({ type: 'TOGGLE_FOLDER', spaceId: activeSpace.id, folderId: child.id }).then(syncSnapshot); }}
                >
                  <span class="folder-symbol">{child.collapsed ? '▸' : '▾'} <Icon name="folder" /></span>
                  <span class="arc-ls-row-title">{child.title}</span>
                </div>
                {:else}
                <div
                  class="arc-ls-row"
                  class:active={isUrlActive(child.url, currentPageUrl)}
                  style="padding-left: {22 + depth * 16}px;"
                  role="button"
                  tabindex="0"
                  onclick={(event) => openSidebarUrl(child.url, event)}
                  onkeydown={(e) => { if (isActivationKey(e)) openSidebarUrl(child.url); }}
                >
                  {#if getFaviconUrl(child.url, child.favIconUrl)}
                    <img src={getFaviconUrl(child.url, child.favIconUrl)} alt="" draggable="false" />
                  {:else}
                    <span><Icon name="globe" /></span>
                  {/if}
                  <span class="arc-ls-row-title">{child.title}</span>
                  <button
                    class="arc-ls-close"
                    onclick={async (e) => {
                      e.stopPropagation();
                      await chrome.runtime.sendMessage({
                        type: 'REMOVE_PINNED_ITEM',
                        spaceId: activeSpace.id,
                        itemId: child.id
                      });
                      syncSnapshot();
                    }}
                    title="Unpin"
                  >
                    ×
                  </button>
                </div>
                {/if}
              {/each}
            {/if}
          {:else}
            <div
              class="arc-ls-row"
              class:active={isUrlActive(item.url, currentPageUrl)}
              role="button"
              tabindex="0"
              draggable="true"
              onpointerdown={(e) => {
                pointerDownCoords = { x: e.clientX, y: e.clientY };
              }}
              ondragstart={() => {
                activeDrag = {
                  kind: 'pin',
                  index: pinIdx,
                  url: item.url,
                  title: item.title,
                  favIconUrl: item.favIconUrl
                };
              }}
              ondragend={(e) => {
                const dist = Math.hypot(e.clientX - pointerDownCoords.x, e.clientY - pointerDownCoords.y);
                activeDrag = null;
                dropTargetHighlight = null;
                if (dist < 10) {
                  openSidebarUrl(item.url, e);
                }
              }}
              ondragover={(e) => e.preventDefault()}
              ondrop={async (e) => {
                e.preventDefault();
                if (activeDrag?.kind === 'pin' && activeDrag.index !== pinIdx) {
                  await chrome.runtime.sendMessage({
                    type: 'REORDER_PINNED',
                    spaceId: activeSpace.id,
                    fromIndex: activeDrag.index,
                    toIndex: pinIdx
                  });
                  syncSnapshot();
                } else if (activeDrag?.kind === 'tab') {
                  await chrome.runtime.sendMessage({
                    type: 'PIN_TAB_TO_SPACE',
                    spaceId: activeSpace.id,
                    title: activeDrag.tab.title,
                    url: activeDrag.tab.url,
                    favIconUrl: activeDrag.tab.favIconUrl
                  });
                  syncSnapshot();
                }
                activeDrag = null;
              }}
              onclick={(event) => openSidebarUrl(item.url, event)}
              onkeydown={(e) => { if (isActivationKey(e)) openSidebarUrl(item.url); }}
            >
              {#if getFaviconUrl(item.url, item.favIconUrl)}
                <img src={getFaviconUrl(item.url, item.favIconUrl)} alt="" draggable="false" />
              {:else}
                <span><Icon name="globe" /></span>
              {/if}
              <span class="arc-ls-row-title">{item.title}</span>
              <button
                class="arc-ls-close"
                onclick={async (e) => {
                  e.stopPropagation();
                  await chrome.runtime.sendMessage({
                    type: 'REMOVE_PINNED_ITEM',
                    spaceId: activeSpace.id,
                    itemId: item.id
                  });
                  syncSnapshot();
                }}
                title="Unpin"
              >
                ×
              </button>
            </div>
          {/if}
        {/each}
      {/if}

      <!-- Divider -->
      <div class="arc-ls-divider">
        <span>Today · {spaceTabs.length}</span>
        <div class="arc-ls-divider-line"></div>
        {#if spaceTabs.some((tab) => !tab.active)}
          <button
            class="arc-ls-clear"
            onclick={async () => {
              await chrome.runtime.sendMessage({
                type: 'CLEAR_TODAY_TABS',
                spaceId: activeSpace.id
              });
              syncSnapshot();
            }}
          >
            Clear
          </button>
        {/if}
      </div>

      <!-- New Tab Row -->
      <div
        class="arc-ls-row"
        role="button"
        tabindex="0"
        onclick={openNewTab}
        onkeydown={(e) => isActivationKey(e) && openNewTab()}
      >
        <span>＋</span>
        <span class="arc-ls-row-title">New Tab</span>
      </div>

      <!-- Open Tabs (Draggable to Pinned, Favorites, Spaces, or Reorder!) -->
      {#each spaceTabs as tab (tab.id)}
        <div
          class="arc-ls-row {tab.active || urlKey(tab.url) === urlKey(currentPageUrl) ? 'active' : ''}"
          role="button"
          tabindex="0"
          draggable="true"
          onpointerdown={(e) => {
            pointerDownCoords = { x: e.clientX, y: e.clientY };
          }}
          ondragstart={() => {
            activeDrag = { kind: 'tab', tab };
          }}
          ondragend={(e) => {
            const dist = Math.hypot(e.clientX - pointerDownCoords.x, e.clientY - pointerDownCoords.y);
            activeDrag = null;
            dropTargetHighlight = null;
            if (dist < 10) {
              switchToSidebarTab(tab, e);
            }
          }}
          ondragover={(e) => e.preventDefault()}
          ondrop={async (e) => {
            e.preventDefault();
            if (activeDrag?.kind === 'tab' && activeDrag.tab.id !== tab.id) {
              await chrome.runtime.sendMessage({
                type: 'REORDER_TAB',
                tabId: activeDrag.tab.id,
                toIndex: tab.index
              });
              syncSnapshot();
            }
            activeDrag = null;
          }}
          onclick={(e) => switchToSidebarTab(tab, e)}
          onkeydown={(e) => isActivationKey(e) && switchToSidebarTab(tab)}
          title="{tab.title} (Click to switch · Drag to pin, favorite, reorder, or move to another Space)"
        >
          {#if getFaviconUrl(tab.url, tab.favIconUrl)}
            <img src={getFaviconUrl(tab.url, tab.favIconUrl)} alt="" draggable="false" />
          {:else}
            <span><Icon name="globe" /></span>
          {/if}
          <span class="arc-ls-row-title">{tab.title}</span>
          <button
            class="arc-ls-close"
            onclick={async (e) => {
              e.stopPropagation();
              await chrome.runtime.sendMessage({ type: 'CLOSE_TAB', tabId: tab.id });
              syncSnapshot();
            }}
            title="Close tab"
          >
            ×
          </button>
        </div>
      {/each}
    </div>

    <!-- Bottom Space Switcher (Drop a tab onto any Space pill to move it to that Space!) -->
    <div class="arc-ls-footer">
      <div class="arc-ls-spaces">
        {#each arcState.spaces as sp (sp.id)}
          <button
            class="arc-ls-space-pill {sp.id === activeSpace?.id ? 'active' : ''} {dropTargetHighlight === `space-${sp.id}` ? 'drop-highlight' : ''}"
            ondragover={(e) => {
              e.preventDefault();
              dropTargetHighlight = `space-${sp.id}`;
            }}
            ondragleave={() => {
              if (dropTargetHighlight === `space-${sp.id}`) dropTargetHighlight = null;
            }}
            ondrop={async (e) => {
              e.preventDefault();
              dropTargetHighlight = null;
              if (activeDrag?.kind === 'tab') {
                await chrome.runtime.sendMessage({
                  type: 'MOVE_TAB_TO_SPACE',
                  tabId: activeDrag.tab.id,
                  spaceId: sp.id
                });
                syncSnapshot();
              }
              activeDrag = null;
            }}
            onclick={async () => {
              await chrome.runtime.sendMessage({ type: 'SET_ACTIVE_SPACE', spaceId: sp.id });
              syncSnapshot();
            }}
            title="{sp.name} (Drop a tab here to move to {sp.name})"
          >
            {sp.icon}
          </button>
        {/each}
      </div>
      <div style="display: flex; align-items: center; gap: 6px;">
        <button
          class="arc-ls-iconbtn"
          onclick={async () => {
            await chrome.runtime.sendMessage({ type: 'RELOAD_EXTENSION' });
            setTimeout(() => window.location.reload(), 250);
          }}
          title="1-Click Reload Arc Extension"
        >
          🔄
        </button>
        <span style="font-size: 10.5px; opacity: 0.55;">Alt+S</span>
      </div>
    </div>
  </aside>

{#if showCommandBar}
  <div class="arc-cmd-backdrop" role="presentation" onclick={(event) => { if (event.target === event.currentTarget) showCommandBar = false; }}>
    <CommandPalette initialQuery={commandQuery} label={commandMode === 'little-arc' ? 'Little Arc' : 'Search'} onexecute={runOmniboxItem} onclose={() => showCommandBar = false} />
  </div>
{/if}

<!-- 2. Arc Peek / Little Arc In-Page Preview Modal -->
{#if peekUrl}
  <div
    class="arc-peek-backdrop"
    role="presentation"
    onclick={() => (peekUrl = null)}
  >
    <div
      class="arc-peek-window" use:containFocus aria-modal="true" aria-label="Peek"
      role="dialog"
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
    >
      <div class="arc-peek-toolbar">
        <span class="arc-peek-badge">ARC PEEK</span>
        <span class="arc-peek-url">{peekUrl}</span>
        <div class="arc-peek-actions">
          <button
            class="arc-peek-btn"
            onclick={() => {
              if (peekUrl) {
                navigator.clipboard.writeText(peekUrl);
                peekCopied = true;
                setTimeout(() => (peekCopied = false), 1500);
              }
            }}
          >
            {peekCopied ? '✓ Copied' : '🔗 Copy Link'}
          </button>
          <button
            class="arc-peek-btn"
            onclick={popOutPeekToLittleArc}
            title="Use if site blocks embedded preview"
          >
            ❐ Little Arc Window
          </button>
          <button class="arc-peek-btn primary" onclick={expandPeekToFullTab}>
            ↗ Open Full Tab
          </button>
          <button class="arc-peek-btn" onclick={() => (peekUrl = null)}>✕</button>
        </div>
      </div>
      <iframe class="arc-peek-iframe" src={peekUrl} title="Arc Peek Preview"></iframe>
    </div>
  </div>
{/if}

<!-- 3. Highlight Selection Floating Action Bar (Translate · ChatGPT · Antigravity) -->
{#if showTranslatePill && pillPosition}
  <div
    class="arc-selection-bar"
    style="left: {pillPosition.x}px; top: {pillPosition.y}px;"
  >
    <button
      class="arc-sel-btn"
      onclick={() => triggerTranslation(selectionText)}
      title="Translate selection (Alt+T)"
    >
      <span><Icon name="globe" /></span>
      <span>Translate</span>
    </button>
    <button
      class="arc-sel-btn"
      onclick={() => sendToChatGPT('', selectionText, true)}
      title="Ask ChatGPT about this selection (Alt+G)"
    >
      <span>🤖</span>
      <span>ChatGPT</span>
    </button>
    <button
      class="arc-sel-btn"
      onclick={() => sendToAntigravity('', selectionText)}
      title="Send selection & page context to Antigravity (Alt+A)"
    >
      <span>🚀</span>
      <span>Antigravity</span>
    </button>
  </div>
{/if}

{#if agyToastMessage}
  <div class="arc-toast" role="status" aria-live="polite">
    {agyToastMessage}
  </div>
{/if}

{#if showTranslateCard && pillPosition}
  <div
    class="arc-translate-card"
    style="left: {pillPosition.x}px; top: {pillPosition.y}px;"
    role="dialog"
    aria-label="Arc Translation"
  >
    <div class="arc-translate-top">
      <div class="arc-lang-bar">
        <span>🌐 {detectedLang.toUpperCase()} →</span>
        <select
          class="arc-lang-select"
          value={targetLang}
          onchange={(e) => {
            targetLang = (e.currentTarget as HTMLSelectElement).value;
            chrome.runtime.sendMessage({
              type: 'UPDATE_SETTINGS',
              settings: { targetLanguage: targetLang }
            });
            triggerTranslation(selectionText);
          }}
        >
          {#each SUPPORTED_LANGUAGES as lang}
            <option value={lang.code}>{lang.name}</option>
          {/each}
        </select>
      </div>
      <button class="arc-translate-close" onclick={() => (showTranslateCard = false)}>×</button>
    </div>

    <div class="arc-translate-body">
      {#if translating}
        <span style="opacity: 0.65;">Translating selection...</span>
      {:else}
        {translationError || translatedText}
      {/if}
    </div>

    {#if !translating && translatedText}
      <div class="arc-translate-footer">
        <button class="arc-mini-btn" onclick={() => speakText(translatedText, targetLang)}>
          🔊 Listen
        </button>
        <button
          class="arc-mini-btn"
          onclick={() => {
            navigator.clipboard.writeText(translatedText);
            copiedTranslation = true;
            setTimeout(() => (copiedTranslation = false), 1500);
          }}
        >
          {copiedTranslation ? '✓ Copied' : '📋 Copy'}
        </button>
      </div>
    {/if}
  </div>
{/if}

<!-- 4. Floating Arc Voice Orb (Control Browser, ChatGPT & Antigravity by Voice · Alt+V) -->
{#if showVoiceOrb}
  <div class="arc-voice-orb-card" role="dialog" aria-label="Arc Voice Assistant">
    <div class="arc-voice-header">
      <div class="arc-voice-modes">
        <button
          class="arc-voice-mode-pill {voicePreferredAgent === 'auto' ? 'active' : ''}"
          onclick={() => (voicePreferredAgent = 'auto')}
          title="Auto-route between Browser Actions, ChatGPT & Antigravity"
        >
          ⚡ Auto
        </button>
        <button
          class="arc-voice-mode-pill {voicePreferredAgent === 'chatgpt' ? 'active' : ''}"
          onclick={() => (voicePreferredAgent = 'chatgpt')}
          title="Route voice queries to ChatGPT"
        >
          🤖 ChatGPT
        </button>
        <button
          class="arc-voice-mode-pill {voicePreferredAgent === 'antigravity' ? 'active' : ''}"
          onclick={() => (voicePreferredAgent = 'antigravity')}
          title="Route voice commands & coding tasks to Antigravity"
        >
          🚀 Antigravity
        </button>
      </div>

      <div style="display: flex; align-items: center; gap: 6px;">
        <button
          class="arc-voice-mode-pill {voiceContinuousMode ? 'active' : ''}"
          onclick={() => {
            voiceContinuousMode = !voiceContinuousMode;
            if (isVoiceListening) {
              startVoiceRecognition();
            }
          }}
          title="Keep microphone listening continuously after each command"
        >
          ♾️ Continuous
        </button>
        <button
          class="arc-translate-close"
          onclick={() => {
            stopVoiceRecognition();
            showVoiceOrb = false;
            if ('speechSynthesis' in window) window.speechSynthesis.cancel();
          }}
          title="Close Voice Assistant"
        >
          ×
        </button>
      </div>
    </div>

    <div class="arc-voice-main">
      <button
        class="arc-mic-orb {isVoiceListening ? 'listening' : ''}"
        onclick={() => toggleVoiceAssistant()}
        title={isVoiceListening ? 'Click to pause listening (Alt+V)' : 'Click to start listening (Alt+V)'}
      >
        {isVoiceListening ? '🎙️' : '🎤'}
      </button>

      <div class="arc-voice-texts">
        <div class="arc-voice-transcript">
          {voiceInterimTranscript ||
            voiceFinalTranscript ||
            (isVoiceListening ? 'Listening... Speak a command' : 'Tap mic or press Alt+V to speak')}
        </div>
        {#if voiceReplyText}
          <div class="arc-voice-reply">
            {voiceProcessing ? '⏳ ' : '🔊 '}{voiceReplyText}
          </div>
        {/if}
      </div>
    </div>

    <div class="arc-voice-chips">
      {#each [
        'Open GitHub',
        'Switch to Work space',
        'Scroll down',
        'Pin this page',
        'Read this page',
        'Ask ChatGPT to summarize this page',
        'Antigravity help with this page'
      ] as sampleCmd}
        <button
          class="arc-voice-chip"
          onclick={() => processVoiceTranscript(sampleCmd)}
          title="Run voice command: {sampleCmd}"
        >
          "{sampleCmd}"
        </button>
      {/each}
    </div>
  </div>
{/if}

<!-- 5. Full-Height ChatGPT & Antigravity Browser Agent Sidebar (Live Page & DOM Access) -->
{#if showAgentSidebar}
  <aside
    class="arc-agent-sidebar {agentSidebarMode === 'antigravity' ? 'mode-antigravity' : 'mode-chatgpt'}"
    style="
      top: 8px;
      bottom: 8px;
      width: {agentSidebarWidth}px;
      {agentSidebarDock === 'left'
        ? `left: ${!isLeftSidebarVisible ? 50 : sidebarX + sidebarWidth + 10}px;`
        : 'right: 10px;'}
    "
    aria-label="ChatGPT and Antigravity Browser Agent Sidebar"
  >
    <!-- Top Header: Mode Switcher + Dock/Key/Close Controls -->
    <div class="arc-agent-hdr">
      <div class="arc-agent-tabs">
        <button
          class="arc-agent-tab gpt {agentSidebarMode === 'chatgpt' ? 'active' : ''}"
          onclick={() => {
            agentSidebarMode = 'chatgpt';
            livePageContext = collectPageContext();
          }}
          title="ChatGPT Browser Agent (Direct access to page DOM & tabs)"
        >
          <span>🤖</span>
          <span>ChatGPT</span>
        </button>
        <button
          class="arc-agent-tab agy {agentSidebarMode === 'antigravity' ? 'active' : ''}"
          onclick={() => {
            agentSidebarMode = 'antigravity';
            livePageContext = collectPageContext();
          }}
          title="Antigravity Browser Agent (Direct access to page DOM, media & IDE)"
        >
          <span>🚀</span>
          <span>Antigravity</span>
        </button>
      </div>

      <div class="arc-agent-hdr-actions">
        <button
          class="arc-agent-iconbtn"
          onclick={() => {
            showApiKeyConfig = !showApiKeyConfig;
            apiKeyInput = settings.openaiApiKey || '';
          }}
          title={settings.openaiApiKey ? 'OpenAI API Key Connected (Click to edit)' : 'Configure OpenAI API Key for GPT-4o Browser Agent'}
        >
          🔑
        </button>
        <button
          class="arc-agent-iconbtn"
          onclick={() => (agentSidebarDock = agentSidebarDock === 'left' ? 'right' : 'left')}
          title={agentSidebarDock === 'left' ? 'Dock sidebar to Right edge of screen' : 'Dock sidebar next to Left Arc Sidebar'}
        >
          {agentSidebarDock === 'left' ? '⇥' : '⇤'}
        </button>
        <button
          class="arc-agent-iconbtn"
          onclick={() => {
            agentMessages = [];
            openAgentSidebar(agentSidebarMode);
          }}
          title="Reset conversation & refresh page DOM snapshot"
        >
          ↻
        </button>
        <button
          class="arc-agent-iconbtn"
          onclick={() => (showAgentSidebar = false)}
          title="Close Agent Sidebar (Esc)"
        >
          ×
        </button>
      </div>
    </div>

    {#if showApiKeyConfig}
      <div
        style="display: flex; gap: 6px; padding: 8px 12px; background: rgba(139, 124, 248, 0.14); border-bottom: 1px solid rgba(255,255,255,0.12);"
      >
        <input
          type="password"
          placeholder="OpenAI API Key (sk-...) for live GPT-4o tool-calling"
          bind:value={apiKeyInput}
          onkeydown={(e) => e.stopPropagation()}
          style="flex: 1; background: rgba(0,0,0,0.35); border: 1px solid rgba(255,255,255,0.22); border-radius: 7px; padding: 5px 8px; color: #fff; font-size: 11px;"
        />
        <button
          style="background: #34d399; border: none; border-radius: 7px; padding: 5px 10px; color: #06130e; font-size: 11px; font-weight: 700; cursor: pointer;"
          onclick={async () => {
            await chrome.runtime.sendMessage({
              type: 'UPDATE_SETTINGS',
              settings: { openaiApiKey: apiKeyInput.trim() }
            });
            showApiKeyConfig = false;
            showToast('✓ OpenAI API Key saved for Browser Agent Sidebar');
            syncSnapshot();
          }}
        >
          Save
        </button>
      </div>
    {/if}

    <!-- Browser Context & 1-Click DOM Tools Bar -->
    <div class="arc-agent-ctx-bar">
      <div class="arc-agent-ctx-status">
        <div style="display: flex; align-items: center; gap: 6px; min-width: 0;">
          <span class="arc-agent-live-dot"></span>
          <span
            style="font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;"
            title={window.location.href}
          >
            Browser Access: {window.location.hostname.replace(/^www\./, '') || window.location.href}
          </span>
        </div>
        <button
          style="background: none; border: none; color: #a78bfa; font-size: 10.5px; font-weight: 600; cursor: pointer; flex-shrink: 0;"
          onclick={() => {
            livePageContext = collectPageContext();
            showBrowserContextDrawer = !showBrowserContextDrawer;
          }}
        >
          {showBrowserContextDrawer ? 'Hide DOM ▴' : 'Inspect DOM ▾'}
        </button>
      </div>

      <div class="arc-agent-quick-tools">
        <button
          class="arc-agent-tool-chip"
          onclick={() => submitAgentSidebarMessage('Can you help me make this page and video player work?')}
          title="Scan page for broken video players, cross-origin iframes, or click-blocking overlays and unlock them"
        >
          🛠️ Fix Page & Video
        </button>
        <button
          class="arc-agent-tool-chip"
          onclick={() => submitAgentSidebarMessage('Summarize this page and its key sections')}
          title="Read live page DOM and summarize"
        >
          📄 Summarize
        </button>
        <button
          class="arc-agent-tool-chip"
          onclick={() => submitAgentSidebarMessage('Translate this page selection')}
          title="Translate highlighted text or page excerpt"
        >
          🌐 Translate
        </button>
        <button
          class="arc-agent-tool-chip"
          onclick={() => {
            livePageContext = collectPageContext();
            showBrowserContextDrawer = !showBrowserContextDrawer;
          }}
          title="View clickable buttons, inputs, and open tabs"
        >
          🎯 Controls ({livePageContext.buttons.length})
        </button>
      </div>
    </div>

    <!-- Expandable Live DOM & Browser Inspector Drawer -->
    {#if showBrowserContextDrawer}
      <div class="arc-agent-drawer">
        <div style="font-weight: 700; color: #c4b5fd;">
          📄 {livePageContext.title || 'Untitled Page'}
        </div>
        <div style="color: rgba(255,255,255,0.65); font-size: 10.5px;">
          Media: {livePageContext.videoInfo.videoCount} &lt;video&gt; · {livePageContext.videoInfo.iframeCount} &lt;iframe&gt; · {tabs.length} open tabs in browser
        </div>

        {#if livePageContext.buttons.length > 0}
          <div style="margin-top: 2px; font-weight: 600; color: rgba(255,255,255,0.78);">
            Click an element on the page directly:
          </div>
          <div style="display: flex; flex-wrap: wrap; gap: 4px;">
            {#each livePageContext.buttons.slice(0, 14) as btnLabel}
              <button
                class="arc-agent-tool-chip"
                onclick={() => submitAgentSidebarMessage(`Click ${btnLabel}`)}
                title="Highlight and click '{btnLabel}' on the page"
              >
                🎯 {btnLabel}
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    <!-- Interactive Multi-Turn Conversation Feed -->
    <div class="arc-agent-feed">
      {#each agentMessages as msg (msg.id)}
        <div class="arc-agent-msg {msg.role}">
          <div class="arc-agent-msg-meta">
            <span>
              {#if msg.role === 'user'}
                You
              {:else if msg.agent === 'antigravity'}
                🚀 Antigravity Agent
              {:else if msg.agent === 'chatgpt'}
                🤖 ChatGPT Agent
              {:else}
                ⚡ Browser Action
              {/if}
            </span>
            <span>{msg.timestamp}</span>
          </div>

          {#if msg.actionBadge}
            <div class="arc-agent-badge">{msg.actionBadge}</div>
          {/if}

          <div>{msg.content}</div>

          {#if msg.role === 'assistant'}
            <div class="arc-agent-msg-actions">
              <button
                class="arc-agent-tool-chip"
                onclick={() => fixAndInspectPageDom()}
                title="Unlock video controls & remove overlay blockers on this page"
              >
                ⚡ Unlock Video / DOM
              </button>
              <button
                class="arc-agent-tool-chip"
                onclick={() => speakText(msg.content.replace(/[*#`_~]/g, ''), 'en-US')}
                title="Read response aloud"
              >
                🔊 Listen
              </button>
              <button
                class="arc-agent-tool-chip"
                onclick={() => launchExternalChatGPT(msg.promptUsed || '', '', true)}
                title="Continue this thread in ChatGPT Web popup"
              >
                🌐 ChatGPT Web ↗
              </button>
              <button
                class="arc-agent-tool-chip"
                onclick={() => launchExternalAntigravity(msg.promptUsed || '', '')}
                title="Copy full page DOM context & open Antigravity Desktop IDE"
              >
                🚀 Antigravity IDE ↗
              </button>
            </div>
          {/if}
        </div>
      {/each}

      {#if agentSending}
        <div class="arc-agent-msg assistant">
          <div class="arc-agent-msg-meta">
            <span>{agentSidebarMode === 'antigravity' ? '🚀 Antigravity' : '🤖 ChatGPT'}</span>
            <span>Working...</span>
          </div>
          <div style="color: #a78bfa;">Inspecting browser DOM & executing actions...</div>
        </div>
      {/if}
    </div>

    <!-- Bottom Composer with Voice & Browser Context Attachment -->
    <div class="arc-agent-composer">
      <div style="display: flex; align-items: center; justify-content: space-between; font-size: 10.5px; color: rgba(255,255,255,0.68);">
        <label style="display: flex; align-items: center; gap: 5px; cursor: pointer;">
          <input type="checkbox" bind:checked={includePageContext} />
          <span>Live Browser & DOM Access enabled</span>
        </label>
        <button
          style="background: none; border: none; color: {isVoiceListening ? '#fda4af' : '#a78bfa'}; font-size: 11px; font-weight: 600; cursor: pointer;"
          onclick={() => toggleVoiceAssistant()}
          title="Speak a command or question (Alt+V)"
        >
          {isVoiceListening ? '🔴 Listening...' : '🎙️ Voice'}
        </button>
      </div>

      <div class="arc-agent-input-row">
        <textarea
          class="arc-agent-textarea"
          rows="2"
          placeholder={agentSidebarMode === 'antigravity'
            ? 'Ask Antigravity to fix this page, inspect DOM, click elements, or run a task...'
            : 'Ask ChatGPT about this page, or tell it to click/scroll/fix/translate...'}
          bind:value={aiPromptText}
          onkeydown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submitAgentSidebarMessage();
            } else if (e.key === 'Escape') {
              showAgentSidebar = false;
            }
          }}
        ></textarea>
        <button
          class="arc-agent-send {agentSidebarMode === 'antigravity' ? 'agy' : ''}"
          onclick={() => submitAgentSidebarMessage()}
          disabled={agentSending}
          title="Send message to Browser Agent (Enter)"
        >
          {agentSidebarMode === 'antigravity' ? '🚀 Run' : '🤖 Send'}
        </button>
      </div>
    </div>
  </aside>
{/if}
