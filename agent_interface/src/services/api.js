const API_BASE_URL = String(import.meta.env.VITE_API_BASE_URL || '/api').trim() || '/api';
const API_KEY = String(import.meta.env.VITE_API_KEY || '').trim();

function buildApiUrl(pathname, searchParams) {
  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
  const normalizedBase = API_BASE_URL.endsWith('/') ? API_BASE_URL : `${API_BASE_URL}/`;
  const absoluteBase = /^https?:\/\//i.test(normalizedBase)
    ? normalizedBase
    : new URL(normalizedBase, origin).toString();
  const normalizedPath = String(pathname || '').replace(/^\/+/, '');
  const url = new URL(normalizedPath, absoluteBase);

  if (searchParams && typeof searchParams === 'object') {
    Object.entries(searchParams).forEach(([key, value]) => {
      if (value === undefined || value === null || value === '') return;
      url.searchParams.set(key, String(value));
    });
  }

  return url.toString();
}

function withApiHeaders(headers = {}) {
  const next = { ...headers };
  if (API_KEY) {
    next['x-api-key'] = API_KEY;
  }
  return next;
}

async function parseJsonResponse(response) {
  const rawText = await response.text();
  let payload = {};

  try {
    payload = rawText ? JSON.parse(rawText) : {};
  } catch {
    payload = { ok: false, error: rawText || 'Invalid JSON response.' };
  }

  if (!response.ok || payload?.ok === false) {
    const detail = payload?.error ? String(payload.error) : `HTTP ${response.status}`;
    throw new Error(detail);
  }

  return payload;
}

export async function openBrowserSession(signal) {
  const response = await fetch(buildApiUrl('browser/open'), {
    method: 'POST',
    headers: withApiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({}),
    signal,
  });
  const payload = await parseJsonResponse(response);
  return {
    status: payload.status || null,
    frame: payload.frame || null,
    history: Array.isArray(payload.history) ? payload.history : [],
  };
}

export async function loadBrowserStatus(signal) {
  const response = await fetch(buildApiUrl('browser/status'), {
    headers: withApiHeaders(),
    signal,
  });
  const payload = await parseJsonResponse(response);
  return payload.status || null;
}

export async function loadBrowserFrame({ live = false, signal } = {}) {
  const response = await fetch(buildApiUrl('browser/frame', {
    live: live ? '1' : '',
  }), {
    headers: withApiHeaders(),
    signal,
  });
  const payload = await parseJsonResponse(response);
  return payload.frame || null;
}

export async function loadBrowserHistory(limit = 120, signal) {
  const response = await fetch(buildApiUrl('browser/history', {
    limit: String(limit),
  }), {
    headers: withApiHeaders(),
    signal,
  });
  const payload = await parseJsonResponse(response);
  return Array.isArray(payload.history) ? payload.history : [];
}

export async function setBrowserManualControl(enabled, signal) {
  const response = await fetch(buildApiUrl('browser/manual-control'), {
    method: 'POST',
    headers: withApiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ enabled: Boolean(enabled) }),
    signal,
  });
  const payload = await parseJsonResponse(response);
  return payload.status || null;
}

export async function sendBrowserControl(action, signal) {
  const response = await fetch(buildApiUrl('browser/control'), {
    method: 'POST',
    headers: withApiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(action || {}),
    signal,
  });
  const payload = await parseJsonResponse(response);
  return {
    result: payload.result || null,
    frame: payload.frame || null,
    status: payload.status || null,
  };
}

export async function sendBrowserTask(goal, options = {}, signal) {
  const response = await fetch(buildApiUrl('browser/task'), {
    method: 'POST',
    headers: withApiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      goal: String(goal || ''),
      cleanContext: typeof options?.cleanContext === 'boolean' ? options.cleanContext : undefined,
      preserveContext: typeof options?.preserveContext === 'boolean' ? options.preserveContext : undefined,
      model: typeof options?.model === 'string' ? options.model : undefined,
      thinkingLevel: typeof options?.thinkingLevel === 'string' ? options.thinkingLevel : undefined,
    }),
    signal,
  });
  const payload = await parseJsonResponse(response);
  return payload.status || null;
}

export async function streamBrowserFrames(
  {
    live = true,
    fps = 8,
    includeStatus = true,
    onStart,
    onFrame,
    onStatus,
    onError,
  } = {},
  signal
) {
  const response = await fetch(buildApiUrl('browser/stream', {
    live: live ? '1' : '0',
    fps: String(fps),
    status: includeStatus ? '1' : '0',
  }), {
    headers: withApiHeaders(),
    signal,
  });

  if (!response.ok || !response.body) {
    throw new Error(`Browser stream unavailable (${response.status}).`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const emitPayload = async (payloadText) => {
    if (!payloadText || payloadText === '[DONE]') {
      return;
    }

    let payload;
    try {
      payload = JSON.parse(payloadText);
    } catch {
      return;
    }

    if (payload?.type === 'start') {
      if (typeof onStart === 'function') {
        await onStart(payload);
      }
      return;
    }

    if (payload?.type === 'frame') {
      if (typeof onFrame === 'function') {
        await onFrame(payload.frame || null);
      }
      return;
    }

    if (payload?.type === 'status') {
      if (typeof onStatus === 'function') {
        await onStatus(payload.status || null);
      }
      return;
    }

    if (payload?.type === 'error') {
      if (typeof onError === 'function') {
        await onError(String(payload.error || 'Browser stream error.'));
      }
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf('\n');

      if (!line) continue;

      let payloadText = line;
      if (payloadText.startsWith('data:')) {
        payloadText = payloadText.slice(5).trim();
      }

      await emitPayload(payloadText);
    }
  }

  const tail = buffer.trim();
  if (tail) {
    let payloadText = tail;
    if (payloadText.startsWith('data:')) {
      payloadText = payloadText.slice(5).trim();
    }
    await emitPayload(payloadText);
  }
}

export async function sendMessage(message, conversationId, signal, attachments) {
  const response = await fetch(buildApiUrl('chat'), {
    method: 'POST',
    headers: withApiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ message, conversationId, attachments }),
    signal,
  });

  const payload = await parseJsonResponse(response);
  return {
    content: String(payload.content || ''),
    conversationId: payload.conversationId,
    attachments: Array.isArray(payload.attachments) ? payload.attachments : [],
    meta: payload.meta || null,
  };
}

export async function streamResponse(message, conversationId, onChunk, onAgentStart, onAgentResult, onDone, signal, attachments) {
  let accumulated = '';

  try {
    const response = await fetch(buildApiUrl('chat/stream'), {
      method: 'POST',
      headers: withApiHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ message, conversationId, attachments }),
      signal,
    });

    if (!response.ok || !response.body) {
      throw new Error(`Streaming unavailable (${response.status}).`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf('\n');

        if (!line) continue;

        let payloadText = line;
        if (payloadText.startsWith('data:')) {
          payloadText = payloadText.slice(5).trim();
        }

        if (!payloadText || payloadText === '[DONE]') {
          continue;
        }

        let payload;
        try {
          payload = JSON.parse(payloadText);
        } catch {
          continue;
        }

        if (payload?.type === 'chunk' && typeof payload.text === 'string') {
          accumulated += payload.text;
          onChunk(accumulated);
          continue;
        }

        if (payload?.type === 'agent_start' && typeof onAgentStart === 'function') {
          onAgentStart(payload.call);
          continue;
        }

        if (payload?.type === 'agent_result' && typeof onAgentResult === 'function') {
          onAgentResult(payload.call, payload.result);
          continue;
        }

        if (payload?.type === 'done') {
          const finalText = typeof payload.content === 'string' ? payload.content : accumulated;
          onDone({
            content: finalText,
            conversationId: payload?.conversationId || conversationId,
            attachments: Array.isArray(payload?.attachments) ? payload.attachments : [],
            meta: payload?.meta || null,
          });
          return;
        }

        if (payload?.type === 'error') {
          throw new Error(String(payload.error || 'Stream failed.'));
        }
      }
    }

    onDone({
      content: accumulated,
      conversationId,
      attachments: [],
      meta: null,
    });
  } catch (error) {
    if (!signal?.aborted && accumulated.length === 0) {
      // Fallback to non-streaming endpoint if SSE is unavailable.
      try {
        const response = await sendMessage(message, conversationId, signal, attachments);
        const text = response.content || '';
        const words = text.split(/(\s+)/).filter(Boolean);

        let localAccumulated = '';
        for (const token of words) {
          if (signal?.aborted) {
          onDone({
            content: localAccumulated,
            conversationId: response.conversationId || conversationId,
            attachments: Array.isArray(response.attachments) ? response.attachments : [],
            meta: response.meta || null,
          });
          return;
          }
          await new Promise((resolve) => setTimeout(resolve, 14));
          localAccumulated += token;
          onChunk(localAccumulated);
        }

        onDone({
          content: localAccumulated,
          conversationId: response.conversationId || conversationId,
          attachments: Array.isArray(response.attachments) ? response.attachments : [],
          meta: response.meta || null,
        });
        return;
      } catch {
        // Continue to final error handling below.
      }
    }

    if (signal?.aborted) {
      onDone({
        content: accumulated,
        conversationId,
        attachments: [],
        meta: null,
      });
      return;
    }

    throw error;
  }
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...slice);
  }

  return btoa(binary);
}

async function uploadAttachmentFileLegacyBase64(file, conversationId, signal) {
  const arrayBuffer = await file.arrayBuffer();
  const dataBase64 = arrayBufferToBase64(arrayBuffer);

  const response = await fetch(buildApiUrl('media/upload'), {
    method: 'POST',
    headers: withApiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      conversationId,
      fileName: file.name,
      mimeType: file.type || 'application/octet-stream',
      dataBase64,
    }),
    signal,
  });

  const payload = await parseJsonResponse(response);
  if (!payload?.attachment) {
    throw new Error('Upload failed: missing attachment payload.');
  }

  return payload.attachment;
}

async function uploadAttachmentFile(file, conversationId, signal) {
  const response = await fetch(buildApiUrl('media/upload/binary'), {
    method: 'POST',
    headers: withApiHeaders({
      'Content-Type': file.type || 'application/octet-stream',
      'x-file-name': encodeURIComponent(file.name || 'attachment'),
      ...(conversationId ? { 'x-conversation-id': String(conversationId) } : {}),
    }),
    body: file,
    signal,
  });

  if (!response.ok && (response.status === 404 || response.status === 405)) {
    return uploadAttachmentFileLegacyBase64(file, conversationId, signal);
  }

  const payload = await parseJsonResponse(response);
  if (!payload?.attachment) {
    throw new Error('Upload failed: missing attachment payload.');
  }

  return payload.attachment;
}

export async function persistAttachments(attachments, conversationId, signal) {
  if (!Array.isArray(attachments) || attachments.length === 0) return null;

  const persisted = [];
  for (const attachment of attachments) {
    const file = attachment?.file;
    if (file instanceof File) {
      const uploaded = await uploadAttachmentFile(file, conversationId, signal);
      persisted.push({
        name: uploaded.name || attachment.name || file.name,
        type: uploaded.type || attachment.type || file.type || 'application/octet-stream',
        size: uploaded.size || attachment.size || file.size || 0,
        url: uploaded.url,
        storageKey: uploaded.storageKey || '',
        stored: true,
      });
      continue;
    }

    persisted.push({
      name: attachment?.name || 'attachment',
      type: attachment?.type || 'application/octet-stream',
      size: attachment?.size || 0,
      url: attachment?.url || '',
      storageKey: attachment?.storageKey || '',
      stored: Boolean(attachment?.stored),
    });
  }

  return persisted;
}

export async function streamToolExecution(command, conversationId, onLine, signal) {
  if (!command) return false;

  try {
    const response = await fetch(buildApiUrl('tools/exec/stream'), {
      method: 'POST',
      headers: withApiHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ command, conversationId }),
      signal,
    });

    if (!response.ok || !response.body) {
      return false;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const raw = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        await emitToolStreamLine(raw, onLine);
        newlineIndex = buffer.indexOf('\n');
      }
    }

    const tail = buffer.trim();
    if (tail) await emitToolStreamLine(tail, onLine);
    return true;
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    return false;
  }
}

async function emitToolStreamLine(rawLine, onLine) {
  if (!rawLine) return;

  let payload = rawLine;
  if (payload.startsWith('data:')) {
    payload = payload.slice(5).trim();
  }
  if (!payload || payload === '[DONE]') return;

  try {
    const parsed = JSON.parse(payload);
    if (typeof parsed === 'string') {
      await onLine(parsed);
      return;
    }
    if (parsed && typeof parsed.line === 'string') {
      await onLine(parsed.line);
      return;
    }
    if (parsed && typeof parsed.output === 'string') {
      await onLine(parsed.output);
      return;
    }
  } catch {
    // ignore and fallback to raw payload
  }

  await onLine(payload);
}

export async function checkHealth() {
  try {
    const response = await fetch(buildApiUrl('health'), {
      headers: withApiHeaders(),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function syncConversation(conversation) {
  try {
    await fetch(buildApiUrl(`conversations/${conversation.id}`), {
      method: 'PUT',
      headers: withApiHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(conversation),
    });
    return true;
  } catch {
    return false;
  }
}

export async function loadConversations() {
  try {
    const response = await fetch(buildApiUrl('conversations'), {
      headers: withApiHeaders(),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

export async function deleteConversation(conversationId) {
  try {
    await fetch(buildApiUrl(`conversations/${conversationId}`), {
      method: 'DELETE',
      headers: withApiHeaders(),
    });
    return true;
  } catch {
    return false;
  }
}

export async function loadRuntimeSettings() {
  const response = await fetch(buildApiUrl('settings'), {
    headers: withApiHeaders(),
  });
  const payload = await parseJsonResponse(response);
  return payload.settings || null;
}

export async function loadAppUpdateStatus({ force = false } = {}) {
  const response = await fetch(buildApiUrl('app/update-status', {
    force: force ? '1' : '',
  }), {
    headers: withApiHeaders(),
  });
  const payload = await parseJsonResponse(response);
  return payload.status || null;
}

export async function applyAppUpdate({ restart = true } = {}) {
  const response = await fetch(buildApiUrl('app/update-apply'), {
    method: 'POST',
    headers: withApiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ restart: Boolean(restart) }),
  });
  const payload = await parseJsonResponse(response);
  return {
    status: payload.status || null,
    restarted: Boolean(payload.restarted),
  };
}

export async function loadContextStatus(message = '', conversationId = '', attachments = [], signal) {
  const response = await fetch(buildApiUrl('context/status'), {
    method: 'POST',
    headers: withApiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      message: String(message || ''),
      conversationId: conversationId || '',
      attachments: Array.isArray(attachments) ? attachments : [],
    }),
    signal,
  });
  const payload = await parseJsonResponse(response);
  return payload.context || null;
}

export async function saveRuntimeSettings(patch) {
  const response = await fetch(buildApiUrl('settings'), {
    method: 'PUT',
    headers: withApiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(patch || {}),
  });
  const payload = await parseJsonResponse(response);
  return payload.settings || null;
}

export async function loadAvailableModels(query = '', action = 'all') {
  const response = await fetch(
    buildApiUrl('models', {
      q: query && String(query).trim() ? String(query).trim() : '',
      action: action && String(action).trim() ? String(action).trim() : 'all',
    }),
    { headers: withApiHeaders() }
  );
  const payload = await parseJsonResponse(response);
  return Array.isArray(payload.models) ? payload.models : [];
}

export async function loadUsageSummary(days = 7) {
  const response = await fetch(
    buildApiUrl('usage', { days: String(days) }),
    { headers: withApiHeaders() }
  );
  const payload = await parseJsonResponse(response);
  return payload.usage || null;
}

export async function loadLogs(component = 'orchestrator', date = '', limit = 200) {
  const response = await fetch(
    buildApiUrl('logs', {
      component: component || 'orchestrator',
      date: date || '',
      limit: String(limit),
    }),
    { headers: withApiHeaders() }
  );
  const payload = await parseJsonResponse(response);
  return {
    component: payload.component || component,
    date: payload.date || date,
    logs: Array.isArray(payload.logs) ? payload.logs : [],
  };
}

export async function loadUsageEvents(date = '', limit = 500) {
  const response = await fetch(
    buildApiUrl('usage/events', {
      date: date || '',
      limit: String(limit),
    }),
    { headers: withApiHeaders() }
  );
  const payload = await parseJsonResponse(response);
  return {
    date: payload.date || date,
    events: Array.isArray(payload.events) ? payload.events : [],
  };
}
