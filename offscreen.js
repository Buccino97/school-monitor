let recorder = null, stream = null;
chrome.runtime.onMessage.addListener(msg => {
  if (msg.target !== 'offscreen') return;
  if (msg.type === 'start_capture') start(msg.streamId, msg.fps);
  if (msg.type === 'stop_capture') stop();
});
async function start(streamId, fps) {
  stop();
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId, maxFrameRate: fps, maxWidth: 1280, maxHeight: 720 } }
    });
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp8') ? 'video/webm;codecs=vp8' : 'video/webm';
    recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 1000000 });
    recorder.ondataavailable = async e => {
      if (!e.data.size) return;
      const buf = new Uint8Array(await e.data.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      chrome.runtime.sendMessage({ target: 'background', type: 'videoChunk', chunk: btoa(bin), mime });
    };
    recorder.start(50);
  } catch (e) { console.warn('LIVE error', e); }
}
function stop() {
  if (recorder) { try { recorder.stop(); } catch {} recorder = null; }
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
}
