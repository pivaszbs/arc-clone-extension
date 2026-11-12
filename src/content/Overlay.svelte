<script lang="ts">
  import { onMount } from 'svelte';
  import { requestArc } from '../shared/messaging';
  import { shouldPeek } from '../shared/interaction';
  import CommandPalette from '../shared/CommandPalette.svelte';
  import Icon from '../shared/Icon.svelte';
  import { containFocus, isActivationKey } from '../shared/focus';
  import { getSpaceFavorites, getTodayTabs, urlKey } from '../shared/tabs';
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
    settings.leftSidebarMode === 'pinned' ||
      (settings.leftSidebarMode === 'hover' && leftSidebarHoverOpen)
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
  let commandMode = $state<'default' | 'new-tab' | 'little-arc'>('default');
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

  // 4. ChatGPT & Antigravity AI Hub State
  let showAiBox = $state(false);
  let aiPromptText = $state('');
  let includePageContext = $state(true);
  let agyToastMessage = $state<string | null>(null);

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

  async function sendToChatGPT(customTask = '', explicitSelection = '', inLittleArc = true) {
    const prompt = buildContextPrompt(
      customTask || (explicitSelection ? 'Explain and help me with this:' : 'Summarize and help me with this page:'),
      explicitSelection
    );
    const chatUrl = `https://chatgpt.com/?q=${encodeURIComponent(prompt)}`;
    showTranslatePill = false;
    showAiBox = false;
    aiPromptText = '';
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

  async function sendToAntigravity(customTask = '', explicitSelection = '') {
    const prompt = buildContextPrompt(
      customTask || 'Help me with this page / code in Antigravity:',
      explicitSelection
    );
    try {
      await navigator.clipboard.writeText(prompt);
    } catch {
      // ignore clipboard error
    }
    showTranslatePill = false;
    showAiBox = false;
    aiPromptText = '';
    showToast('🚀 Task & page context copied to clipboard! Launching Antigravity (⌘V to paste)...');

    // Trigger macOS antigravity:// URL scheme to bring Antigravity.app to the front
    const a = document.createElement('a');
    a.href = 'antigravity://';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 200);
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
    const excerpt = (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 1500);
    const interactiveEls = Array.from(
      document.querySelectorAll<HTMLElement>('a, button, [role="button"], input[type="submit"], input[type="button"]')
    );
    const buttons: string[] = [];
    for (const el of interactiveEls) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.top <= window.innerHeight) {
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
    return {
      title: document.title || '',
      url: window.location.href,
      selection: sel,
      excerpt,
      buttons
    };
  }

  function executeDomVoiceAction(domAction?: {
    type: string;
    direction?: string;
    targetText?: string;
    value?: string;
    taskPrompt?: string;
  }) {
    if (!domAction) return;

    if (domAction.type === 'scroll') {
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
      sendToAntigravity(domAction.taskPrompt || '', '');
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
    if (settings.leftSidebarMode === 'hover') {
      leftSidebarHoverOpen = true;
      syncSnapshot();
    }
  }

  function handleLeftSidebarLeave() {
    if (isDraggingSidebar || isResizingSidebar || activeDrag) return;
    if (settings.leftSidebarMode === 'hover') {
      if (hideTimeout) clearTimeout(hideTimeout);
      hideTimeout = setTimeout(() => {
        if (!isDraggingSidebar && !isResizingSidebar && !activeDrag) {
          leftSidebarHoverOpen = false;
        }
      }, 220);
    }
  }

  async function togglePinLeftSidebar() {
    const nextMode = settings.leftSidebarMode === 'off' ? 'pinned' : 'off';
    const res = await chrome.runtime.sendMessage({
      type: 'UPDATE_SETTINGS',
      settings: { leftSidebarMode: nextMode }
    });
    if (res?.state) {
      arcState = res.state;
      tabs = res.tabs || [];
    }
  }

  onMount(() => {
    syncSnapshot();

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
      if (msg?.type === 'OPEN_COMMAND_BAR_FROM_CMDT') {
        openCommandBar('new-tab');
        sendResponse({ ok: true });
        return;
      } else if (msg?.type === 'TRIGGER_ANTIGRAVITY_HANDOFF') {
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
        openPeek(msg.url);
        sendResponse({ ok: true });
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
      if (!anchor || !anchor.href) return;
      if (anchor.href.startsWith('javascript:') || anchor.href.startsWith('#')) return;

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

    window.addEventListener('keydown', handleKeydown, true);
    window.addEventListener('click', handleClickCapture, true);
    window.addEventListener('mouseup', handleMouseUp);
    window.addEventListener('mousedown', handleMouseDown);

    return () => {
      chrome.runtime.onMessage.removeListener(msgListener);
      window.removeEventListener('keydown', handleKeydown, true);
      window.removeEventListener('click', handleClickCapture, true);
      window.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('mousedown', handleMouseDown);
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

  async function openCommandBar(
    mode: 'default' | 'new-tab' | 'little-arc' = 'default',
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
      if (usePeek) {
        openPeek(item.url);
      } else if (commandMode === 'new-tab' && item.kind === 'search') {
        await requestArc({
          type: 'CREATE_TAB',
          url: item.url,
          spaceId: item.spaceId || activeSpace?.id
        });
      } else {
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
    try {
      if (event && shouldPeek(event, settings)) {
        if (settings.peekMode === 'popup') await requestArc({ type: 'OPEN_LITTLE_ARC', url });
        else openPeek(url);
      } else await requestArc({ type: 'OPEN_OR_SWITCH_URL', url, spaceId: activeSpace.id });
    } catch { showToast('Could not open this page. Try again.'); }
  }

  function openPeek(url: string) {
    peekUrl = url;
    peekCopied = false;
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

    .arc-ls-dragbar {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 16px;
      margin: -2px -4px 4px;
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
      height: 40px;
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.09);
      border: 1px solid rgba(255, 255, 255, 0.12);
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: background 0.12s ease, transform 0.12s ease;
    }

    .arc-ls-fav.active { background: #ffffff23; box-shadow: inset 0 0 0 1px #ffffff30; }
    .arc-ls-fav:hover {
      background: rgba(255, 255, 255, 0.18);
      transform: translateY(-1px);
    }

    .arc-ls-fav img {
      width: 20px;
      height: 20px;
      border-radius: 4px;
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
      background: rgba(255, 255, 255, 0.11);
    }

    .arc-ls-row.active {
      background: rgba(255, 255, 255, 0.22);
      color: #fff;
      font-weight: 600;
    }

    .arc-ls-row img {
      width: 15px;
      height: 15px;
      border-radius: 3px;
      flex-shrink: 0;
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
  `;
</script>

<svelte:element this={'style'}>{OVERLAY_CSS}</svelte:element>

<!-- Persistent Left Arc Sidebar Overlay -->
{#if settings.leftSidebarMode === 'off'}
  <button
    style="
      position: fixed;
      top: 12px;
      left: 10px;
      z-index: 2147483644;
      width: 28px;
      height: 28px;
      border-radius: 8px;
      background: rgba(25, 22, 46, 0.85);
      border: 1px solid rgba(255, 255, 255, 0.22);
      color: #fff;
      font-size: 13px;
      cursor: pointer;
      backdrop-filter: blur(10px);
      box-shadow: 0 6px 18px rgba(0, 0, 0, 0.4);
    "
    onclick={togglePinLeftSidebar}
    title="Show Left Arc Sidebar (Alt+S)"
  >
    ▸
  </button>
{:else}
  <aside
    class="arc-left-sidebar visible {isDraggingSidebar || isResizingSidebar ? 'no-transition' : ''}"
    style="
      background: {currentTheme.gradient};
      left: {sidebarX}px;
      top: {sidebarY}px;
      width: {sidebarWidth}px;
      {sidebarHeight ? `height: ${sidebarHeight}px;` : `bottom: 8px;`}
    "
  >
    <!-- Top Drag Handle: Drag to move sidebar anywhere, double-click to snap back to left -->
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
        <button
          class="arc-ls-iconbtn"
          onclick={(e) => {
            e.stopPropagation();
            chrome.runtime.sendMessage({
              type: 'LAUNCH_BORDERLESS_ARC',
              url: window.location.href
            });
          }}
          title="Open in Borderless Arc Window (No Chrome top bar · Alt+B)"
        >
          <Icon name="window" size={14} />
        </button>
        <button
          class="arc-ls-iconbtn"
          onclick={(e) => {
            e.stopPropagation();
            togglePinLeftSidebar();
          }}
          title="Collapse Left Sidebar (Alt+S)"
        >
          <Icon name="sidebar" size={14} />
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
            class="arc-ls-fav" class:active={urlKey(fav.url) === urlKey(window.location.href)}
            role="button"
            tabindex="0"
            draggable="true"
            ondragstart={() => {
              activeDrag = { kind: 'fav', index: favIdx };
            }}
            ondragend={() => {
              activeDrag = null;
              dropTargetHighlight = null;
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
            title="{fav.title} ({fav.url}) · Drag to reorder"
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

      <!-- Day-to-Day Voice, ChatGPT & Antigravity Quick Strip -->
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
          class="arc-ai-btn"
          onclick={(e) => {
            if (e.shiftKey || e.altKey) {
              sendToChatGPT('', '', true);
            } else {
              showAiBox = !showAiBox;
            }
          }}
          title="Ask ChatGPT (Shift+Click to pop out ChatGPT with current page · Alt+G)"
        >
          <span>🤖</span>
          <span>ChatGPT</span>
        </button>

        <button
          class="arc-ai-btn"
          onclick={(e) => {
            if (e.shiftKey || e.altKey) {
              sendToAntigravity('', '');
            } else {
              showAiBox = !showAiBox;
            }
          }}
          title="Send to Antigravity (Shift+Click to immediately launch Antigravity with page context · Alt+A)"
        >
          <span>🚀</span>
          <span>Antigravity</span>
        </button>
      </div>

      {#if showAiBox}
        <div class="arc-ai-box">
          <textarea
            class="arc-ai-textarea"
            rows="2"
            placeholder="Ask a question or describe a coding task..."
            bind:value={aiPromptText}
            onkeydown={(e) => {
              e.stopPropagation();
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                sendToChatGPT(aiPromptText, '', true);
              } else if (e.shiftKey && e.key === 'Enter') {
                e.preventDefault();
                sendToAntigravity(aiPromptText, '');
              }
            }}
          ></textarea>
          <label class="arc-ai-ctx-toggle">
            <input type="checkbox" bind:checked={includePageContext} />
            <span>Attach current page URL & highlighted text</span>
          </label>
          <div class="arc-ai-actions">
            <button
              class="arc-ai-submit"
              onclick={() => sendToChatGPT(aiPromptText, '', true)}
              title="Open ChatGPT in Little Arc with this prompt (⌘+Enter)"
            >
              🤖 Ask ChatGPT
            </button>
            <button
              class="arc-ai-submit agy"
              onclick={() => sendToAntigravity(aiPromptText, '')}
              title="Copy task + context & launch Antigravity.app (Shift+Enter)"
            >
              🚀 Antigravity
            </button>
          </div>
          <div style="display: flex; align-items: center; justify-content: space-between; margin-top: 2px;">
            <button
              style="background: none; border: none; color: rgba(255,255,255,0.65); font-size: 10.5px; cursor: pointer; text-decoration: underline;"
              onclick={() => {
                showApiKeyConfig = !showApiKeyConfig;
                apiKeyInput = settings.openaiApiKey || '';
              }}
            >
              {settings.openaiApiKey ? '🔑 OpenAI Key Configured' : '⚙️ Set OpenAI Key for Direct Voice AI'}
            </button>
          </div>
          {#if showApiKeyConfig}
            <div style="display: flex; gap: 5px; margin-top: 2px;">
              <input
                type="password"
                placeholder="sk-... (optional for GPT-4o Voice)"
                bind:value={apiKeyInput}
                onkeydown={(e) => e.stopPropagation()}
                style="flex: 1; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.2); border-radius: 6px; padding: 4px 7px; color: #fff; font-size: 11px;"
              />
              <button
                style="background: #8b7cf8; border: none; border-radius: 6px; padding: 4px 8px; color: #fff; font-size: 11px; font-weight: 600; cursor: pointer;"
                onclick={async () => {
                  await chrome.runtime.sendMessage({
                    type: 'UPDATE_SETTINGS',
                    settings: { openaiApiKey: apiKeyInput.trim() }
                  });
                  showApiKeyConfig = false;
                  showToast('✓ OpenAI API Key saved for Voice Agent');
                  syncSnapshot();
                }}
              >
                Save
              </button>
            </div>
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
              {#each item.children as child (child.id)}
                <div
                  class="arc-ls-row" class:active={urlKey(child.url) === urlKey(window.location.href)}
                  style="padding-left: 22px;"
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
              {/each}
            {/if}
          {:else}
            <div
              class="arc-ls-row" class:active={urlKey(item.url) === urlKey(window.location.href)}
              role="button"
              tabindex="0"
              draggable="true"
              ondragstart={() => {
                activeDrag = {
                  kind: 'pin',
                  index: pinIdx,
                  url: item.url,
                  title: item.title,
                  favIconUrl: item.favIconUrl
                };
              }}
              ondragend={() => {
                activeDrag = null;
                dropTargetHighlight = null;
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
        onclick={() => openCommandBar('new-tab')}
        onkeydown={(e) => isActivationKey(e) && openCommandBar('new-tab')}
      >
        <span>＋</span>
        <span class="arc-ls-row-title">New Tab</span>
      </div>

      <!-- Open Tabs (Draggable to Pinned, Favorites, Spaces, or Reorder!) -->
      {#each spaceTabs as tab (tab.id)}
        <div
          class="arc-ls-row {tab.active ? 'active' : ''}"
          role="button"
          tabindex="0"
          draggable="true"
          ondragstart={() => {
            activeDrag = { kind: 'tab', tab };
          }}
          ondragend={() => {
            activeDrag = null;
            dropTargetHighlight = null;
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
          onclick={() => chrome.runtime.sendMessage({ type: 'SWITCH_TAB', tabId: tab.id })}
          onkeydown={(e) =>
            isActivationKey(e) &&
            chrome.runtime.sendMessage({ type: 'SWITCH_TAB', tabId: tab.id })}
          title="{tab.title} (Drag to pin, favorite, reorder, or move to another Space)"
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
{/if}

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
