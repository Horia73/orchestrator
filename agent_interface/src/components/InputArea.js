const ICONS = {
  attach: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path></svg>',
  camera: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path><circle cx="12" cy="13" r="4"></circle></svg>',
  mic: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>',
  send: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>',
  stop: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect></svg>',
  arrowRight: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>',
  close: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>',
  trash: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>',
  sendFilled: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>',
};

export function createInputArea() {
  const el = document.createElement('div');
  el.className = 'chat-input-wrapper';

  el.innerHTML = `
    <div class="chat-input-container">
      <!-- Queue Preview (above input) -->
      <div class="chat-queue-preview" id="queue-preview">
        <div class="queue-content">
          <span class="queue-label">Queued:</span>
          <span class="queue-text" id="queue-text"></span>
        </div>
        <button class="queue-action-btn" id="queue-send-now" title="Interrupt and send now">
          ${ICONS.arrowRight}
        </button>
      </div>

      <div class="chat-attachments-preview" id="attachments-preview"></div>
      
      <div class="chat-input-box" id="chat-input-box">
        <div class="input-actions-left">
          <button class="input-icon-btn" id="attach-btn" title="Attach file" aria-label="Attach file">
            ${ICONS.attach}
          </button>
          <button class="input-icon-btn" id="camera-btn" title="Photo" aria-label="Take or select photo">
            ${ICONS.camera}
          </button>
        </div>
        
        <div class="input-field-container">
            <textarea 
              id="chat-input"
              placeholder="Message..." 
              rows="1"
              aria-label="Message input"
            ></textarea>
            <div class="input-status-indicator" id="status-indicator" aria-live="polite" role="status">Thinking...</div>
        </div>

        <div class="input-actions-right">
          <div class="context-meter" id="context-meter">
            <button class="context-meter-btn" id="context-meter-btn" type="button" title="Context usage" aria-label="Context usage">
              <span class="context-meter-ring" id="context-meter-ring"></span>
            </button>
            <div class="context-meter-popover" id="context-meter-popover">
              <div class="context-meter-title" id="context-meter-title">Context</div>
              <div class="context-meter-row" id="context-meter-row">Loading…</div>
              <div class="context-meter-note" id="context-meter-note"></div>
            </div>
          </div>
          <button class="input-icon-btn mic-btn" id="mic-btn" title="Voice recording" aria-label="Record voice">
            ${ICONS.mic}
          </button>
          <button class="send-btn" id="send-btn" title="Send" aria-label="Send message" disabled>
            ${ICONS.send}
          </button>
          <button class="send-btn stop-btn" id="stop-btn" title="Stop" aria-label="Stop generation" style="display: none;">
            ${ICONS.stop}
          </button>
        </div>
      </div>

      <!-- Recording overlay -->
      <div class="recording-overlay" id="recording-overlay">
        <button class="recording-cancel" id="recording-cancel" title="Cancel recording">
          ${ICONS.trash}
        </button>
        <div class="recording-info">
          <div class="recording-dot"></div>
          <span class="recording-timer" id="recording-timer">0:00</span>
        </div>
        <div class="recording-waveform" id="recording-waveform"></div>
        <button class="recording-send" id="recording-send" title="Send recording">
          ${ICONS.sendFilled}
        </button>
      </div>
      <input type="file" id="file-input" multiple hidden accept="*/*" />
      <input type="file" id="camera-input" hidden accept="image/*,video/*" capture="environment" />
      <input type="file" id="audio-capture-input" hidden accept="audio/*" capture />
    </div>
  `;

  const inputBox = el.querySelector('#chat-input-box');
  const textarea = el.querySelector('#chat-input');
  const statusIndicator = el.querySelector('#status-indicator');
  const sendBtn = el.querySelector('#send-btn');
  const stopBtn = el.querySelector('#stop-btn');
  const attachBtn = el.querySelector('#attach-btn');
  const cameraBtn = el.querySelector('#camera-btn');
  const micBtn = el.querySelector('#mic-btn');
  const contextMeter = el.querySelector('#context-meter');
  const contextMeterBtn = el.querySelector('#context-meter-btn');
  const contextMeterRing = el.querySelector('#context-meter-ring');
  const contextMeterPopover = el.querySelector('#context-meter-popover');
  const contextMeterTitle = el.querySelector('#context-meter-title');
  const contextMeterRow = el.querySelector('#context-meter-row');
  const contextMeterNote = el.querySelector('#context-meter-note');
  const fileInput = el.querySelector('#file-input');
  const cameraInput = el.querySelector('#camera-input');
  const audioCaptureInput = el.querySelector('#audio-capture-input');
  const attachmentsPreview = el.querySelector('#attachments-preview');

  const queuePreview = el.querySelector('#queue-preview');
  const queueText = el.querySelector('#queue-text');
  const queueSendNow = el.querySelector('#queue-send-now');
  queueSendNow.style.display = 'none'; // We use individual send buttons now

  // Recording elements
  const recordingOverlay = el.querySelector('#recording-overlay');
  const recordingCancel = el.querySelector('#recording-cancel');
  const recordingSend = el.querySelector('#recording-send');
  const recordingTimer = el.querySelector('#recording-timer');
  const recordingWaveform = el.querySelector('#recording-waveform');

  let pendingFiles = [];
  let isRecording = false;
  let isBusy = false; // "Thinking" or streaming
  let messageQueue = []; // Array of { content, attachments }

  let mediaRecorder = null;
  let audioChunks = [];
  let audioContext = null;
  let analyser = null;
  let animFrameId = null;
  let recordingStartTime = 0;
  let timerInterval = null;
  let mediaStream = null;
  let contextPopoverPinned = false;

  let micErrorTimeout = null;
  function showMicError(message) {
    const text = String(message || '').trim();
    if (!text) return;
    statusIndicator.textContent = text;
    statusIndicator.style.display = 'block';
    clearTimeout(micErrorTimeout);
    micErrorTimeout = setTimeout(() => {
      if (!isBusy) statusIndicator.style.display = 'none';
    }, 5000);
  }

  function getBestAudioMimeType() {
    if (typeof window.MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
      return '';
    }
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4',
      'audio/ogg;codecs=opus',
    ];
    return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || '';
  }

  function getAudioFileInfo() {
    const mimeType = getBestAudioMimeType();
    if (mimeType.includes('mp4')) return { mimeType, extension: 'm4a' };
    if (mimeType.includes('ogg')) return { mimeType, extension: 'ogg' };
    return { mimeType: mimeType || 'audio/webm', extension: 'webm' };
  }

  const contextState = {
    model: '',
    usedTokens: null,
    inputTokenLimit: null,
    remainingTokens: null,
    usageRatio: null,
    estimated: false,
    error: '',
  };

  // ─── Exposed Methods ───
  el.setBusy = (busy) => {
    isBusy = busy;
    updateUIState();
  };

  el.insertIntoDraft = (text, options = {}) => {
    const value = String(text || '').trim();
    if (!value) return;

    const replace = Boolean(options.replace);
    if (replace || !textarea.value.trim()) {
      textarea.value = value;
    } else {
      const suffix = textarea.value.endsWith('\n') ? '' : '\n\n';
      textarea.value = `${textarea.value}${suffix}${value}`;
    }

    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 180) + 'px';
    textarea.focus();
    updateSendBtn();
    emitDraftChanged();
  };

  el.setContextMeter = (payload = {}) => {
    contextState.model = String(payload?.model || '');
    contextState.usedTokens = Number.isFinite(Number(payload?.usedTokens)) ? Number(payload.usedTokens) : null;
    contextState.inputTokenLimit = Number.isFinite(Number(payload?.inputTokenLimit)) ? Number(payload.inputTokenLimit) : null;
    contextState.remainingTokens = Number.isFinite(Number(payload?.remainingTokens)) ? Number(payload.remainingTokens) : null;
    contextState.usageRatio = Number.isFinite(Number(payload?.usageRatio)) ? Number(payload.usageRatio) : null;
    contextState.estimated = Boolean(payload?.estimated);
    contextState.error = String(payload?.error || '').trim();
    renderContextMeter();
  };

  function formatNumber(value) {
    return Number.isFinite(Number(value)) ? Number(value).toLocaleString('en-US') : 'n/a';
  }

  function contextToneClass(ratio) {
    if (!Number.isFinite(ratio)) return 'unknown';
    if (ratio < 0.6) return 'safe';
    if (ratio < 0.82) return 'warn';
    return 'danger';
  }

  function renderContextMeter() {
    const ratio = Number.isFinite(contextState.usageRatio)
      ? Math.max(0, Math.min(1, Number(contextState.usageRatio)))
      : null;
    const pct = ratio === null ? null : Math.round(ratio * 100);
    const used = contextState.usedTokens;
    const limit = contextState.inputTokenLimit;
    const remaining = contextState.remainingTokens;
    const tone = contextToneClass(ratio);

    contextMeter.classList.remove('safe', 'warn', 'danger', 'unknown');
    contextMeter.classList.add(tone);
    contextMeterRing.style.setProperty('--context-progress', `${pct ?? 0}%`);
    contextMeterRing.textContent = pct === null ? '?' : `${pct}%`;

    const modelLabel = contextState.model ? String(contextState.model).replace(/^models\//, '') : 'Model';
    contextMeterTitle.textContent = `Context • ${modelLabel}`;

    if (contextState.error) {
      contextMeterRow.textContent = 'Could not load context status.';
      contextMeterNote.textContent = contextState.error;
      return;
    }

    if (!Number.isFinite(used) && !Number.isFinite(limit)) {
      contextMeterRow.textContent = 'Context status unavailable.';
      contextMeterNote.textContent = '';
      return;
    }

    if (Number.isFinite(used) && Number.isFinite(limit)) {
      contextMeterRow.textContent = `${formatNumber(used)} / ${formatNumber(limit)} tokens`;
      contextMeterNote.textContent = `${formatNumber(remaining)} tokens remaining${contextState.estimated ? ' (estimated)' : ''}`;
      return;
    }

    contextMeterRow.textContent = `${formatNumber(used)} tokens used`;
    contextMeterNote.textContent = contextState.estimated
      ? 'Estimated usage (model limit unavailable).'
      : 'Model limit unavailable for current model.';
  }

  function setContextPopoverVisible(visible) {
    contextMeter.classList.toggle('open', Boolean(visible));
  }

  function emitDraftChanged() {
    const content = textarea.value || '';
    const attachments = pendingFiles.map((file) => ({
      name: file.name,
      type: file.type,
      size: file.size,
      url: file.url,
    }));
    el.dispatchEvent(new CustomEvent('draft-changed', {
      detail: { content, attachments },
      bubbles: true,
    }));
  }

  contextMeterBtn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    contextPopoverPinned = !contextPopoverPinned;
    setContextPopoverVisible(contextPopoverPinned);
  });

  contextMeter.addEventListener('mouseenter', () => {
    setContextPopoverVisible(true);
  });

  contextMeter.addEventListener('mouseleave', () => {
    if (!contextPopoverPinned) {
      setContextPopoverVisible(false);
    }
  });

  document.addEventListener('click', (event) => {
    if (!contextPopoverPinned) return;
    if (contextMeter.contains(event.target)) return;
    contextPopoverPinned = false;
    setContextPopoverVisible(false);
  });

  renderContextMeter();

  function updateUIState() {
    if (isBusy) {
      sendBtn.style.display = 'none';
      stopBtn.style.display = 'flex';
      micBtn.style.display = 'none';
      statusIndicator.style.display = 'none'; // Rely on stop button
    } else {
      stopBtn.style.display = 'none';
      statusIndicator.style.display = 'none';
      updateSendBtn();

      // Process queue if any
      if (messageQueue.length > 0) {
        const nextMsg = messageQueue.shift(); // FIFO
        renderQueuePreview();
        // Trigger send with slight delay to allow UI to settle
        setTimeout(() => triggerSend(nextMsg.content, nextMsg.attachments), 200);
      }
    }
  }

  // ─── Queue Management ───
  function addToQueue(content, attachments) {
    messageQueue.push({ content, attachments });
    renderQueuePreview();

    // Clear input
    textarea.value = '';
    textarea.style.height = 'auto';
    pendingFiles = [];
    renderAttachmentPreviews();
    updateSendBtn();
    emitDraftChanged();
  }

  function renderQueuePreview() {
    if (messageQueue.length === 0) {
      queuePreview.classList.remove('visible');
      queueText.innerHTML = '';
      return;
    }

    queuePreview.classList.add('visible');

    // FIX: Remove CSS max-width constraint so items stretch to full width
    queueText.style.maxWidth = 'none';
    queueText.style.width = '100%';
    queueText.style.flex = '1';

    // Render list of messages
    queueText.innerHTML = `
      <div class="queue-list" style="display: flex; flex-direction: column; gap: 8px; width: 100%;">
        ${messageQueue.map((msg, i) => `
          <div class="queue-item" data-index="${i}" style="display: flex; align-items: center; justify-content: space-between; background: rgba(255,255,255,0.05); padding: 6px 10px; border-radius: 6px;">
             <span class="queue-item-text" style="font-size: 0.9em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 65%; color: var(--text-secondary);">${escapeHtml(msg.content)}</span>
             <div style="display: flex; align-items: center; gap: 8px;">
                <button class="queue-item-delete" title="Remove from queue" style="width: 28px; height: 28px; border-radius: 4px; background: none; color: #999; border: none; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: all 0.2s;">${ICONS.trash}</button>
                <button class="queue-item-send" title="Send this now" style="width: 28px; height: 28px; border-radius: 50%; background: rgba(201, 100, 66, 0.1); color: #c96442; border: none; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: background 0.2s;">${ICONS.arrowRight}</button>
             </div>
          </div>
        `).join('')}
      </div>
    `;

    // Add listeners to send buttons
    queueText.querySelectorAll('.queue-item-send').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const item = btn.closest('.queue-item');
        const index = parseInt(item.dataset.index, 10);
        const msg = messageQueue[index];
        if (!msg) return;
        // Remove from queue
        messageQueue.splice(index, 1);
        renderQueuePreview();
        // Interrupt and send
        el.dispatchEvent(new CustomEvent('stop-generation', { bubbles: true }));
        setTimeout(() => triggerSend(msg.content, msg.attachments), 100);
      });
    });

    // Add listeners to delete buttons
    queueText.querySelectorAll('.queue-item-delete').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const item = btn.closest('.queue-item');
        const index = parseInt(item.dataset.index, 10);
        const [removed] = messageQueue.splice(index, 1);
        if (removed?.attachments) revokeAttachmentUrls(removed.attachments);
        renderQueuePreview();
      });
    });
  }

  function clearQueue() {
    messageQueue.forEach((msg) => revokeAttachmentUrls(msg.attachments));
    messageQueue = [];
    renderQueuePreview();
  }

  queueSendNow.addEventListener('click', () => {
    if (messageQueue.length > 0) {
      // Stop current generation
      el.dispatchEvent(new CustomEvent('stop-generation', { bubbles: true }));

      // Send the next one immediately
      // Note: we don't clear the WHOLE queue, just process the next one.
      // The user said "Interrupt and send now". 
      // If we stop generation, `isBusy` becomes false (via ChatArea).
      // That triggers `updateUIState`, which consumes the queue naturally!
      // So strictly speaking, we just need to STOP.
      // But to be responsive, we can force-trigger.
      // However, relying on busy-state toggling is cleaner.
    }
  });

  // ─── Auto-resize ───
  textarea.addEventListener('input', () => {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 180) + 'px';
    updateSendBtn();
    emitDraftChanged();
  });

  function updateSendBtn() {
    if (isBusy) {
      // While busy, we show STOP button usually. 
      // But if user types, maybe we show Send (Queue)?
      // Stick to Stop button logic for simplicity, Enter key handles queue.
      sendBtn.style.display = 'none';
      stopBtn.style.display = 'flex';
      micBtn.style.display = 'none';
      return;
    }

    const hasContent = textarea.value.trim() || pendingFiles.length > 0;
    sendBtn.disabled = !hasContent;
    if (hasContent) {
      sendBtn.style.display = 'flex';
      micBtn.style.display = 'none';
    } else {
      sendBtn.style.display = 'none';
      micBtn.style.display = 'flex';
    }
    stopBtn.style.display = 'none';
  }

  updateSendBtn();

  // ─── File Attach ───
  attachBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    for (const file of fileInput.files) addPendingFile(file);
    fileInput.value = '';
    updateSendBtn();
    emitDraftChanged();
    // FIX: Focus back to textarea so Enter sends message
    setTimeout(() => textarea.focus(), 100);
  });

  // ─── Camera / Gallery ───
  cameraBtn.addEventListener('click', () => cameraInput.click());
  cameraInput.addEventListener('change', () => {
    for (const file of cameraInput.files) addPendingFile(file);
    cameraInput.value = '';
    updateSendBtn();
    emitDraftChanged();
    setTimeout(() => textarea.focus(), 100);
  });

  audioCaptureInput.addEventListener('change', () => {
    const file = audioCaptureInput.files?.[0];
    if (!file) return;
    addPendingFile(file);
    audioCaptureInput.value = '';
    updateSendBtn();
    emitDraftChanged();
    triggerSend();
  });

  // ═══════════════════════════════════════════════
  //  VOICE RECORDING
  // ═══════════════════════════════════════════════
  const NUM_BARS = 40;
  for (let i = 0; i < NUM_BARS; i++) {
    const bar = document.createElement('div');
    bar.className = 'waveform-bar';
    recordingWaveform.appendChild(bar);
  }
  const waveformBars = recordingWaveform.querySelectorAll('.waveform-bar');

  micBtn.addEventListener('click', startRecording);
  recordingCancel.addEventListener('click', cancelRecording);
  recordingSend.addEventListener('click', sendRecording);

  async function startRecording() {
    if (isRecording) return;
    try {
      if (!window.isSecureContext) {
        showMicError('Voice recording requires HTTPS. Open the app on a secure connection and try again.');
        return;
      }
      if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
        showMicError('Microphone access is not available in this browser.');
        return;
      }
      if (typeof window.MediaRecorder === 'undefined') {
        audioCaptureInput.click();
        return;
      }

      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const { mimeType } = getAudioFileInfo();
      mediaRecorder = mimeType
        ? new MediaRecorder(mediaStream, { mimeType })
        : new MediaRecorder(mediaStream);
      audioChunks = [];
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunks.push(e.data);
      };
      mediaRecorder.start();

      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const source = audioContext.createMediaStreamSource(mediaStream);
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.7;
      source.connect(analyser);

      isRecording = true;
      recordingStartTime = Date.now();

      inputBox.style.display = 'none';
      recordingOverlay.classList.add('active');

      updateTimer();
      timerInterval = setInterval(updateTimer, 1000);
      drawWaveform();

    } catch (err) {
      const errorName = String(err?.name || '').toLowerCase();
      let message = 'Could not start voice recording.';
      if (errorName === 'notallowederror' || errorName === 'securityerror') {
        message = 'Microphone access is blocked. In Safari, tap aA → Website Settings → Microphone → Allow, then reload the page.';
      } else if (errorName === 'notfounderror') {
        message = 'No microphone was found on this device.';
      } else if (errorName === 'notreadableerror') {
        message = 'Microphone is busy in another app. Close other recording apps and try again.';
      }
      console.error('Mic access denied:', err);
      showMicError(message);
    }
  }

  function updateTimer() {
    const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    recordingTimer.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  function drawWaveform() {
    if (!isRecording || !analyser) return;
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    analyser.getByteFrequencyData(dataArray);
    const step = Math.floor(bufferLength / NUM_BARS);
    for (let i = 0; i < NUM_BARS; i++) {
      let sum = 0;
      for (let j = 0; j < step; j++) {
        sum += dataArray[i * step + j] || 0;
      }
      const avg = sum / step;
      const height = Math.max(3, (avg / 255) * 32);
      waveformBars[i].style.height = height + 'px';
    }
    animFrameId = requestAnimationFrame(drawWaveform);
  }

  function stopRecordingCleanup() {
    isRecording = false;
    clearInterval(timerInterval);
    cancelAnimationFrame(animFrameId);
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
    if (audioContext) { audioContext.close(); audioContext = null; }
    waveformBars.forEach(b => b.style.height = '3px');
    recordingTimer.textContent = '0:00';
    recordingOverlay.classList.remove('active');
    inputBox.style.display = 'flex';
  }

  function cancelRecording() {
    stopRecordingCleanup();
  }

  function sendRecording() {
    if (!mediaRecorder) return;
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };
    const onStop = () => {
      const { mimeType, extension } = getAudioFileInfo();
      const blob = new Blob(audioChunks, { type: mimeType || 'audio/webm' });
      const file = new File([blob], `voice_${Date.now()}.${extension}`, { type: blob.type });
      addPendingFile(file);
      updateSendBtn();
      triggerSend();
    };
    mediaRecorder.addEventListener('stop', onStop, { once: true });
    stopRecordingCleanup();
  }

  // ─── Drag & Drop ───
  el.addEventListener('dragover', (e) => {
    e.preventDefault();
    inputBox.classList.add('dragover');
  });
  el.addEventListener('dragleave', (e) => {
    if (!el.contains(e.relatedTarget)) inputBox.classList.remove('dragover');
  });
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    inputBox.classList.remove('dragover');
    for (const file of e.dataTransfer.files) addPendingFile(file);
    updateSendBtn();
    emitDraftChanged();
  });

  // ─── Pending Files ───
  function addPendingFile(file) {
    const fileData = {
      id: Math.random().toString(36).slice(2, 11),
      file, name: file.name, type: file.type, size: file.size,
      url: URL.createObjectURL(file),
    };
    pendingFiles.push(fileData);
    renderAttachmentPreviews();
    // Focus back to textarea ensures Enter works immediately
    setTimeout(() => textarea.focus(), 100);
  }

  function removePendingFile(id) {
    const f = pendingFiles.find(f => f.id === id);
    if (f) URL.revokeObjectURL(f.url);
    pendingFiles = pendingFiles.filter(f => f.id !== id);
    renderAttachmentPreviews();
    updateSendBtn();
    emitDraftChanged();
  }

  function renderAttachmentPreviews() {
    if (pendingFiles.length === 0) {
      attachmentsPreview.innerHTML = '';
      attachmentsPreview.classList.remove('visible');
      return;
    }
    attachmentsPreview.classList.add('visible');
    attachmentsPreview.innerHTML = pendingFiles.map(f => {
      const isImage = f.type.startsWith('image/');
      const isAudio = f.type.startsWith('audio/');
      return `
        <div class="attachment-chip ${isImage ? 'has-thumb' : ''}">
          ${isImage ? `<img src="${f.url}" class="attachment-chip-thumb" alt="" />` : ''}
          ${!isImage ? `<span class="attachment-chip-icon">${isAudio ? '🎵' : '📎'}</span>` : ''}
          <span class="attachment-chip-name">${f.name}</span>
          <button class="attachment-chip-remove" data-remove-id="${f.id}">${ICONS.close}</button>
        </div>
      `;
    }).join('');

    attachmentsPreview.querySelectorAll('.attachment-chip-remove').forEach(btn => {
      btn.addEventListener('click', () => removePendingFile(btn.dataset.removeId));
    });
  }

  // ─── Send Logic ───
  function triggerSend(overrideContent, overrideAttachments) {
    let content, attachments;

    if (overrideContent !== undefined) {
      content = overrideContent;
      attachments = overrideAttachments;
    } else {
      content = textarea.value.trim();
      if (!content && pendingFiles.length === 0) return;
      attachments = pendingFiles.length > 0
        ? pendingFiles.map(f => ({ name: f.name, type: f.type, size: f.size, url: f.url, file: f.file }))
        : undefined;
    }

    // Fallback text for audio - REMOVED per user request
    const finalContent = content;

    el.dispatchEvent(new CustomEvent('send-message', {
      detail: {
        content: finalContent,
        attachments,
      },
      bubbles: true,
    }));

    if (overrideContent === undefined) {
      const released = pendingFiles.map((f) => ({ url: f.url }));
      revokeAttachmentUrls(released);
      textarea.value = '';
      textarea.style.height = 'auto';
      pendingFiles = [];
      renderAttachmentPreviews();
      updateSendBtn();
      emitDraftChanged();
    }
  }

  function handleAction() {
    if (isBusy) {
      // If typing and Enter pressed, Add to queue
      const content = textarea.value.trim();
      if (content || pendingFiles.length > 0) {
        const attachments = pendingFiles.length > 0
          ? pendingFiles.map(f => ({ name: f.name, type: f.type, size: f.size, url: f.url, file: f.file }))
          : undefined;

        // Fallback text - REMOVED
        const finalContent = content;

        addToQueue(finalContent, attachments);
        return;
      }

      // If Stop button clicked (and no text), Stop generation
      el.dispatchEvent(new CustomEvent('stop-generation', { bubbles: true }));
    } else {
      triggerSend();
    }
  }

  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleAction();
    }
  });

  sendBtn.addEventListener('click', () => triggerSend());

  stopBtn.addEventListener('click', () => {
    el.dispatchEvent(new CustomEvent('stop-generation', { bubbles: true }));
  });

  return el;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function revokeAttachmentUrls(attachments) {
  if (!Array.isArray(attachments)) return;
  attachments.forEach((attachment) => {
    if (typeof attachment?.url === 'string' && attachment.url.startsWith('blob:')) {
      URL.revokeObjectURL(attachment.url);
    }
  });
}
