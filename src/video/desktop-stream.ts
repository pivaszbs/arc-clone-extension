/** Streams only the chosen video to the local macOS companion over native messaging. */
export class DesktopVideoStream {
  sessionId = '';
  recorder?: MediaRecorder;
  stream?: MediaStream;
  active = false;
  originalMuted = false;
  wasPaused = false;
  pending: Promise<unknown> = Promise.resolve();
  constructor(readonly video: HTMLVideoElement, readonly update: () => void, readonly error: (message: string) => void) {}
  async start() {
    const video = this.video as HTMLVideoElement & { captureStream?: () => MediaStream };
    if (video.mediaKeys) throw new Error('Protected video cannot be sent to the desktop player.');
    if (!video.captureStream) throw new Error('This browser cannot send the video to the desktop player.');
    this.originalMuted = video.muted;
    this.wasPaused = video.paused;
    // Start playback within the button click before waiting for the native process.
    await video.play();
    try {
      this.stream = video.captureStream();
      const response = await chrome.runtime.sendMessage({ type: 'DESKTOP_PIP_OPEN', muted: this.originalMuted, volume: video.volume });
      if (!response?.ok) throw new Error(response?.error || 'Install the macOS desktop PiP companion first.');
      this.sessionId = response.sessionId;
      const mime = (response.formats as string[]).find(type => MediaRecorder.isTypeSupported(type));
      if (!mime) throw new Error('The browser and desktop player have no compatible video format.');
      const start = await chrome.runtime.sendMessage({
        type: 'DESKTOP_PIP_START', sessionId: this.sessionId, mime, paused: video.paused || video.ended
      });
      if (start?.error) throw new Error(start.error);
      const options: MediaRecorderOptions & { videoKeyFrameIntervalDuration: number } = {
        mimeType: mime, videoBitsPerSecond: 1600000, audioBitsPerSecond: 128000, videoKeyFrameIntervalDuration: 250
      };
      this.recorder = new MediaRecorder(this.stream, options);
      this.recorder.addEventListener('dataavailable', (event) => {
        if (!event.data.size || !this.active) return;
        this.pending = this.pending.then(async () => {
          if (!this.active) return;
          const bytes = new Uint8Array(await event.data.arrayBuffer());
          let binary = '';
          for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
          const result = await chrome.runtime.sendMessage({ type: 'DESKTOP_PIP_CHUNK', sessionId: this.sessionId, data: btoa(binary) });
          if (result?.error) throw new Error(result.error);
        }).catch((error) => { this.error(error instanceof Error ? error.message : 'Desktop video failed.'); this.stop(); });
      });
      this.recorder.addEventListener('stop', () => { if (this.active) { this.error('Video capture ended. Open desktop playback again to continue.'); this.stop(); } });
      this.recorder.addEventListener('error', () => { this.error('The video cannot be captured. Protected or cross-origin media may restrict capture.'); this.stop(); });
      video.ownerDocument.defaultView?.addEventListener('pagehide', this.onPageHide);
      video.addEventListener('emptied', this.onPageHide);
      this.active = true;
      this.recorder.start(250);
      // Element mute does not mute captureStream's audio, avoiding duplicate playback.
      video.muted = true;
      chrome.runtime.onMessage.addListener(this.listener);
      for (const type of ['play', 'pause', 'ended']) video.addEventListener(type, this.onPlaybackChange);
      this.syncPlayback();
      this.update();
    } catch (error) {
      this.stop();
      throw error;
    }
  }
  listener = (message: { type?: string; sessionId?: string; event?: string; error?: string }, _sender?: chrome.runtime.MessageSender, respond?: (value: unknown) => void) => {
    if (message.type === 'DESKTOP_PIP_SOURCE_STATE' && message.sessionId === this.sessionId) {
      respond?.({ paused: this.video.paused, time: this.video.currentTime, recording: this.recorder?.state, streamActive: this.stream?.active });
      return;
    }
    if (message.type !== 'DESKTOP_PIP_EVENT' || message.sessionId !== this.sessionId) return;
    if (message.event === 'play') {
      void this.video.play().then(() => this.syncPlayback(), () => this.syncPlayback(true));
    } else if (message.event === 'pause') {
      this.video.pause();
      this.syncPlayback();
    } else if (message.event === 'closed' || message.event === 'error') {
      if (message.error) this.error(message.error);
      this.stop(false);
    }
  };
  syncPlayback(failed = false) {
    if (!this.active) return;
    void chrome.runtime.sendMessage({
      type: 'DESKTOP_PIP_PLAYBACK', sessionId: this.sessionId,
      paused: this.video.paused || this.video.ended, failed
    }).catch(() => {});
  }
  onPlaybackChange = () => this.syncPlayback();
  onPageHide = () => this.stop();
  stop(closeWindow = true) {
    this.video.ownerDocument.defaultView?.removeEventListener('pagehide', this.onPageHide);
    this.video.removeEventListener('emptied', this.onPageHide);
    for (const type of ['play', 'pause', 'ended']) this.video.removeEventListener(type, this.onPlaybackChange);
    this.active = false;
    chrome.runtime.onMessage.removeListener(this.listener);
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    this.stream?.getTracks().forEach(track => track.stop());
    this.video.muted = this.originalMuted;
    if (this.wasPaused) this.video.pause();
    if (closeWindow && this.sessionId) void chrome.runtime.sendMessage({ type: 'DESKTOP_PIP_CLOSE', sessionId: this.sessionId }).catch(() => {});
    this.sessionId = '';
    this.update();
  }
}
