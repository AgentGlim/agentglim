// Attach immediately after spawn with stdout/stderr piped. The server prints
// this line from its listening event, after startup work and a successful bind.
export function waitForServerReady(child, port = 0, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    let output = '';
    let errors = '';
    let pending = '';
    const readyLine = /^AgentGlim on http:\/\/localhost:(\d+) \(127\.0\.0\.1\)(?:,.*)?$/;
    const finish = (error, boundPort) => {
      clearTimeout(timer);
      child.stdout.off('data', onOutput);
      child.stderr.off('data', onErrorOutput);
      child.off('error', onError);
      child.off('exit', onExit);
      if (error) reject(new Error(`${error}\nstdout: ${output}\nstderr: ${errors}`));
      else resolve(boundPort);
    };
    const onOutput = (chunk) => {
      output = (output + chunk).slice(-8192);
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop().slice(-8192);
      for (const line of lines) {
        const match = readyLine.exec(line.replace(/\r$/, ''));
        const boundPort = match && Number(match[1]);
        if (boundPort > 0 && boundPort <= 65535 && (!port || port === boundPort)) { finish(null, boundPort); break; }
      }
    };
    const onErrorOutput = (chunk) => { errors = (errors + chunk).slice(-8192); };
    const onError = (error) => finish(`Server failed to spawn: ${error.message}`);
    const onExit = (code, signal) => finish(`Server exited before ready (code ${code}, signal ${signal})`);
    const timer = setTimeout(() => finish(`Server did not become ready within ${timeoutMs}ms`), timeoutMs);
    child.stdout.on('data', onOutput);
    child.stderr.on('data', onErrorOutput);
    child.once('error', onError);
    child.once('exit', onExit);
    if (child.exitCode !== null || child.signalCode !== null) onExit(child.exitCode, child.signalCode);
  });
}
