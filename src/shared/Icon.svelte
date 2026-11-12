<script lang="ts">
  export type IconName = 'search' | 'link' | 'check' | 'window' | 'sidebar' | 'folder' | 'pin' | 'globe' | 'settings' | 'eye' | 'volume' | 'mute' | 'move' | 'arrow' | 'command' | 'close' | 'plus';
  let { name, size = 16 }: { name: IconName; size?: number } = $props();
  const paths: Record<IconName, string> = {
    search: 'm21 21-4.4-4.4 M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
    link: 'm10 13 4-4 M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0 M16 8l1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0',
    check: 'm5 12 4 4L19 6',
    window: 'M4 4h16v16H4z M4 9h16 M9 9v11',
    sidebar: 'M4 4h16v16H4z M9 4v16 M6 8h0 M6 12h0',
    folder: 'M3 7V5h6l2 2h10v12H3z',
    pin: 'm9 3 6 0-1 6 4 4v2H6v-2l4-4z M12 15v7',
    globe: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M3 12h18 M12 3c5 5 5 13 0 18-5-5-5-13 0-18',
    settings: 'M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
    eye: 'M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12 M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
    volume: 'M11 4 6 8H3v8h3l5 4z M15 8a6 6 0 0 1 0 8 M18 5a10 10 0 0 1 0 14',
    mute: 'M11 4 6 8H3v8h3l5 4z m5 5 6 6 m0-6-6 6',
    move: 'M3 7h17m-4-4 4 4-4 4 M21 17H4m4-4-4 4 4 4',
    arrow: 'M5 19 19 5 M5 5h14v14',
    command: 'M9 9H6a3 3 0 1 1 3-3v12a3 3 0 1 1-3-3h12a3 3 0 1 1-3 3V6a3 3 0 1 1 3 3z',
    close: 'm6 6 12 12 M6 18 18 6',
    plus: 'M12 5v14 M5 12h14'
  };
</script>

<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex-shrink: 0; display: block; pointer-events: none;">
  <path d={paths[name]} />
</svg>
