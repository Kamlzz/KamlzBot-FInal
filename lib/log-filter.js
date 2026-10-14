function stringifyForFilter(value) {
  if (value instanceof Error) {
    return `${value.name}: ${value.message}\n${value.stack || ''}`;
  }
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return String(value);

  try {
    return JSON.stringify(value, (_key, item) => {
      if (item instanceof Error) {
        return { name: item.name, message: item.message, stack: item.stack };
      }
      return item;
    });
  } catch {
    return String(value);
  }
}

function joinedText(args) {
  return (Array.isArray(args) ? args : [args]).map(stringifyForFilter).join(' ');
}


function isSignalSessionBookkeepingNoise(args) {
  const first = Array.isArray(args) ? args[0] : args;
  if (typeof first !== 'string') return false;
  const line = first.trim();
  return /^(?:Closing session:|Closing open session in favor of incoming prekey bundle\b|Closing stale open session for new outgoing prekey bundle\b|Removing old closed session:|Removing old closed session\b)/i.test(line);
}

function isSignalDecryptNoise(args) {
  const text = joinedText(args);

  if (/Failed to decrypt message with any known session/i.test(text)) return true;
  if (/failed to decrypt message/i.test(text)
      && /SessionError/i.test(text)
      && /No matching sessions found for message/i.test(text)) return true;

  const isLibSignalFrame = /libsignal[\\/](?:src[\\/])?(?:crypto|session_cipher|queue_job)\.js/i.test(text)
    || /SessionCipher\.doDecryptWhisperMessage/i.test(text);
  return /\bBad MAC\b/i.test(text)
    && isLibSignalFrame
    && /Session error:|SessionCipher|verifyMAC/i.test(text);
}

/**
 * This suppresses only Baileys' non-fatal startup/init-query timeout event.
 * Other 408/timeout logs remain visible. Set BAILEYS_SHOW_INIT_TIMEOUTS=1 to
 * see these messages when investigating a persistent connection problem.
 */
function isInitQueryTimeoutNoise(args) {
  if (process.env.BAILEYS_SHOW_INIT_TIMEOUTS === '1') return false;
  const text = joinedText(args);
  const initQueryLog = /unexpected error in ['"`]init queries['"`]/i.test(text);
  const timeout = /Timed Out|Request Time-out/i.test(text);
  const timedOutStatus = /statusCode["']?\s*[:=]\s*408|\b408\b/i.test(text);
  return initQueryLog && timeout && timedOutStatus;
}

function installConsoleNoiseFilter(targetConsole = console) {
  const restore = [];
  for (const method of ['log', 'info', 'debug', 'warn', 'error']) {
    const original = targetConsole[method].bind(targetConsole);
    targetConsole[method] = (...args) => {
      if (isSignalDecryptNoise(args) || isInitQueryTimeoutNoise(args) || isSignalSessionBookkeepingNoise(args)) return;
      original(...args);
    };
    restore.push(() => { targetConsole[method] = original; });
  }
  return () => restore.reverse().forEach(fn => fn());
}

export { isSignalDecryptNoise, isInitQueryTimeoutNoise, isSignalSessionBookkeepingNoise, installConsoleNoiseFilter };
