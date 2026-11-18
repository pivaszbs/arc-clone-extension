// The TV tab: the whole TV from the phone. The TV set (power, volume, Home, Source) goes through the
// Mac to Samsung's remote API; navigation, typing and playback go to the Anime Study TV app when it
// is open, and to the TV set's own keys otherwise.
import { SymbolView, type SFSymbol } from 'expo-symbols';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { haptics } from '../lib/haptics';
import { fetchTvDevice, playOnTv, sendTvRemote, type TvDevice, type TvKey, type TvRemoteAction, type TvStream } from '../lib/tv-remote';
import type { TvControlCommand, TvPlaybackState } from '../lib/tv-sync';
import { colors, radius, space, status, type } from '../theme';
import { MoviesBrowser } from './MoviesBrowser';
import { TvRemotePanel } from './TvRemotePanel';
import { Button, Section, StatusDot } from './ui';
import { VolumeSlider } from './VolumeSlider';

type Props = {
  serverUrl: string;
  tvState: TvPlaybackState | null;
  tvAutoplay?: boolean;
  onCommand: (command: TvControlCommand) => void;
  onPlayOnPhone: () => void;
};

type Direction = 'up' | 'down' | 'left' | 'right' | 'ok' | 'back';
const deviceKeys: Record<Direction, TvKey> = {
  up: 'KEY_UP', down: 'KEY_DOWN', left: 'KEY_LEFT', right: 'KEY_RIGHT', ok: 'KEY_ENTER', back: 'KEY_RETURN',
};

export function TvScreen({ serverUrl, tvState, tvAutoplay, onCommand, onPlayOnPhone }: Props) {
  const [device, setDevice] = useState<TvDevice | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  /** Movies first: find something on the phone and play it on the TV. */
  const [panel, setPanel] = useState<'movies' | 'remote'>('movies');


  const refresh = useCallback(async () => {
    try { setDevice(await fetchTvDevice(serverUrl)); } catch { setDevice(null); }
  }, [serverUrl]);

  const play = async (stream: TvStream, saved?: { folder: string; file: string }) => {
    setMessage(`Sending ${stream.title} to the TV…`);
    const result = await playOnTv(serverUrl, saved ? { saved } : { stream });
    if (result.error) setMessage(result.error);
    else if (result.state === 'starting') setMessage(`Turning on the TV and opening Anime Study… ${stream.title} starts by itself.`);
    else setMessage(saved ? `Playing the saved ${stream.title} on the TV.` : `Starting ${stream.title} on the TV… a torrent can take up to a minute.`);
    setTimeout(() => void refresh(), 1500);
  };

  useEffect(() => {
    const first = setTimeout(() => void refresh(), 0);
    const timer = setInterval(() => void refresh(), 4000);
    return () => { clearTimeout(first); clearInterval(timer); };
  }, [refresh]);

  const remote = async (action: TvRemoteAction, done?: string) => {
    haptics.select();
    if ('power' in action || 'open' in action) setBusy(true);
    const error = await sendTvRemote(serverUrl, action);
    setBusy(false);
    setMessage(error || done || '');
    if ('power' in action || 'open' in action) setTimeout(() => void refresh(), 1500);
  };

  /** Slider moves go straight out; the device poll catches the TV's own reading up. */
  const setVolume = async (volume: number) => {
    setDevice(current => (current ? { ...current, volume } : current));
    const error = await sendTvRemote(serverUrl, { volume });
    if (error) setMessage(error);
  };
  const toggleMute = async () => {
    const mute = !device?.muted;
    setDevice(current => (current ? { ...current, muted: mute } : current));
    const error = await sendTvRemote(serverUrl, { mute });
    setMessage(error || '');
  };

  const appOpen = Boolean(device?.appOpen);
  const tvOn = device?.power === 'on';
  /** With Anime Study open its own commands answer faster and also work before pairing. */
  const navigate = (direction: Direction) => {
    if (appOpen) {
      haptics.select();
      onCommand({ action: direction });
    } else void remote({ key: deviceKeys[direction] });
  };

  const sendText = (submit: boolean) => {
    if (!text.trim()) return;
    haptics.select();
    onCommand({ action: 'text', text: text.trim(), submit });
    setMessage(appOpen ? (submit ? 'Searching on the TV' : 'Typed on the TV') : 'Open Anime Study on the TV first.');
  };

  const powerLabel = !device ? 'Mac not answering'
    : !device.known ? 'Open Anime Study on the TV once so the Mac can find it'
      : device.power === 'on' ? 'On' : device.power === 'standby' ? 'Standby' : 'Off';

  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View style={styles.header}>
        <Text style={type.largeTitle}>TV</Text>
        <View style={styles.statusRow}>
          <StatusDot tone={!device?.known ? 'idle' : tvOn ? 'ok' : 'warn'} />
          <Text style={type.subhead} numberOfLines={2}>
            {device?.name ? `${device.name} · ` : ''}{powerLabel}
            {tvOn ? (appOpen ? ' · Anime Study open' : ' · Anime Study closed') : ''}
            {device?.known && !device.paired ? ' · not paired yet' : ''}
          </Text>
        </View>
        {device?.pairing && <Text style={[type.subhead, { color: status.warn }]}>Choose Allow on the TV screen to let this phone control it.</Text>}
        {!!message && <Text style={[type.subhead, { color: colors.textSecondary }]}>{message}</Text>}
      </View>

      <View style={styles.topButtons}>
        <Button
          title={tvOn ? 'Turn off' : 'Turn on'}
          icon="power"
          variant={tvOn ? 'danger' : 'primary'}
          disabled={!device?.known}
          loading={busy}
          onPress={() => void remote({ power: tvOn ? 'off' : 'on' }, tvOn ? 'TV turning off' : 'TV turning on…')}
          style={styles.flex}
        />
        <Button
          title={appOpen ? 'Anime Study open' : 'Open Anime Study'}
          icon="play.tv"
          disabled={!device?.known || appOpen}
          onPress={() => void remote({ open: true }, 'Opening Anime Study on the TV…')}
          style={styles.flex}
        />
      </View>

      {tvOn && (
        <VolumeSlider
          volume={device?.volume}
          muted={device?.muted}
          disabled={device?.volume === undefined}
          onChange={volume => void setVolume(volume)}
          onToggleMute={() => void toggleMute()}
        />
      )}

      {tvState?.active && (
        <TvRemotePanel tvState={tvState} tvAutoplay={tvAutoplay} onCommand={command => onCommand(command)} onPlayOnPhone={onPlayOnPhone} />
      )}

      <View style={styles.segments}>
        {(['movies', 'remote'] as const).map(item => (
          <Pressable
            key={item}
            accessibilityRole="button"
            accessibilityState={{ selected: panel === item }}
            onPress={() => { haptics.select(); setPanel(item); }}
            style={[styles.segment, panel === item && styles.segmentActive]}
          >
            <Text style={[styles.segmentText, panel === item && styles.segmentTextActive]}>{item === 'movies' ? 'Movies & TV' : 'Remote'}</Text>
          </Pressable>
        ))}
      </View>

      {panel === 'movies' ? (
        <MoviesBrowser
          serverUrl={serverUrl}
          onPlay={stream => void play(stream)}
          onPlaySaved={job => void play({ id: job.itemId, title: job.name, label: job.name, path: '' }, { folder: job.folder!, file: job.file! })}
        />
      ) : (
      <>
      <View style={styles.pad}>
        <PadButton icon="chevron.up" label="Up" onPress={() => navigate('up')} style={styles.padUp} />
        <PadButton icon="chevron.left" label="Left" onPress={() => navigate('left')} style={styles.padLeft} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="OK"
          onPress={() => navigate('ok')}
          style={({ pressed }) => [styles.ok, pressed && styles.pressed]}
        >
          <Text style={styles.okText}>OK</Text>
        </Pressable>
        <PadButton icon="chevron.right" label="Right" onPress={() => navigate('right')} style={styles.padRight} />
        <PadButton icon="chevron.down" label="Down" onPress={() => navigate('down')} style={styles.padDown} />
      </View>

      <View style={styles.keyRow}>
        <Key icon="arrow.uturn.backward" label="Back" onPress={() => navigate('back')} />
        <Key icon="house" label="Home" onPress={() => void remote({ key: 'KEY_HOME' })} />
        <Key icon="line.3.horizontal" label="Menu" onPress={() => (appOpen ? (haptics.select(), onCommand({ action: 'menu' })) : void remote({ key: 'KEY_MENU' }))} />
        <Key icon="rectangle.connected.to.line.below" label="Source" onPress={() => void remote({ key: 'KEY_SOURCE' })} />
      </View>

      <View style={styles.keyRow}>
        <Key icon="speaker.minus" label="Vol −" onPress={() => void remote({ key: 'KEY_VOLDOWN' })} />
        <Key icon="speaker.slash" label="Mute" onPress={() => void remote({ key: 'KEY_MUTE' })} />
        <Key icon="speaker.plus" label="Vol +" onPress={() => void remote({ key: 'KEY_VOLUP' })} />
        <Key icon="playpause" label="Play/Pause" onPress={() => (appOpen ? (haptics.select(), onCommand({ action: 'toggle' })) : void remote({ key: 'KEY_PLAY' }))} />
      </View>

      <Section title="Type on the TV">
        <View style={styles.typeRow}>
          <TextInput
            value={text}
            onChangeText={setText}
            onSubmitEditing={() => sendText(true)}
            placeholder="Search or text for the focused field"
            placeholderTextColor={colors.textTertiary}
            returnKeyType="send"
            autoCorrect={false}
            style={styles.input}
          />
          <Button title="Send" onPress={() => sendText(true)} disabled={!text.trim()} />
        </View>
      </Section>

      </>
      )}
    </ScrollView>
  );
}

function PadButton({ icon, label, onPress, style }: { icon: SFSymbol; label: string; onPress: () => void; style: object }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={6} style={({ pressed }) => [styles.padButton, style, pressed && styles.pressed]}>
      <SymbolView name={icon} size={22} tintColor={colors.text} />
    </Pressable>
  );
}

function Key({ icon, label, onPress }: { icon: SFSymbol; label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => [styles.key, pressed && styles.pressed]}>
      <SymbolView name={icon} size={18} tintColor={colors.text} />
      <Text style={styles.keyText}>{label}</Text>
    </Pressable>
  );
}

const PAD = 220;
const styles = StyleSheet.create({
  content: { padding: space.l, gap: space.l, paddingBottom: 120 },
  header: { gap: space.xs },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: space.s },
  topButtons: { flexDirection: 'row', gap: space.s },
  flex: { flex: 1 },
  pad: {
    width: PAD, height: PAD, borderRadius: PAD / 2, alignSelf: 'center',
    backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.separator,
  },
  padButton: { position: 'absolute', width: 64, height: 64, alignItems: 'center', justifyContent: 'center', borderRadius: 32 },
  padUp: { top: 6, left: PAD / 2 - 32 },
  padDown: { bottom: 6, left: PAD / 2 - 32 },
  padLeft: { left: 6, top: PAD / 2 - 32 },
  padRight: { right: 6, top: PAD / 2 - 32 },
  ok: {
    position: 'absolute', width: 84, height: 84, borderRadius: 42, top: PAD / 2 - 42, left: PAD / 2 - 42,
    backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center',
  },
  okText: { color: colors.background, fontSize: 17, fontWeight: '800' },
  keyRow: { flexDirection: 'row', gap: space.s },
  key: {
    flex: 1, alignItems: 'center', gap: 4, paddingVertical: space.m,
    backgroundColor: colors.surface, borderRadius: radius.medium,
  },
  keyText: { color: colors.textSecondary, fontSize: 11, fontWeight: '600' },
  typeRow: { flexDirection: 'row', gap: space.s, alignItems: 'center', padding: space.m },
  input: {
    flex: 1, color: colors.text, backgroundColor: colors.surfaceRaised, borderRadius: radius.medium,
    paddingHorizontal: space.m, paddingVertical: 10, fontSize: 15,
  },
  segments: { flexDirection: 'row', backgroundColor: colors.surface, borderRadius: radius.pill, padding: 3 },
  segment: { flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: radius.pill },
  segmentActive: { backgroundColor: colors.accentMuted },
  segmentText: { color: colors.textSecondary, fontSize: 14, fontWeight: '700' },
  segmentTextActive: { color: colors.accent },
  pressed: { opacity: 0.6 },
});
