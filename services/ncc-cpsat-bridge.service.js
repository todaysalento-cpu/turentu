import { spawn } from 'node:child_process';

export const NCC_CPSAT_BRIDGE_VERSION = '2.8.7.5.2';

export function eseguiCpsatNcc({
  script,
  input,
  signal = null,
  timeoutMs = 15000,
  maxInputBytes = 8 * 1024 * 1024,
  maxOutputBytes = 8 * 1024 * 1024,
  pythonBin = process.env.PYTHON_BIN ||
    (process.platform === 'win32'
      ? 'python'
      : 'python3')
} = {}) {

  return new Promise((resolve, reject) => {

    if (!script || typeof script !== 'string') {
      reject(new Error('NCC_CPSAT_SCRIPT_INVALIDO'));
      return;
    }

    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0
    ) {
      reject(new Error('NCC_CPSAT_TIMEOUT_INVALIDO'));
      return;
    }

    if (signal?.aborted) {
      reject(new Error('NCC_CPSAT_INTERROTTO'));
      return;
    }

    let payload;

    try {
      payload = JSON.stringify(input);

      if (typeof payload !== 'string') {
        throw new Error('INPUT_NON_SERIALIZZABILE');
      }

      if (Buffer.byteLength(payload) > maxInputBytes) {
        throw new Error('INPUT_TROPPO_GRANDE');
      }

    } catch (err) {
      reject(new Error(
        'NCC_CPSAT_INPUT: ' + err.message
      ));
      return;
    }

    const start = Date.now();

    let completato = false;
    let timer = null;

    let stdoutBytes = 0;
    let stderrBytes = 0;

    const stdout = [];
    const stderr = [];

    let child;

    // NCC_CHIUSURA_PROCESSO_V28752

    let processoChiuso = false;
    let errorePendente = null;

    function cleanup() {
      if (timer) clearTimeout(timer);

      signal?.removeEventListener(
        'abort',
        onAbort
      );
    }

    function termina(errore, risultato) {
      if (completato) return;

      if (errorePendente) return;

      if (errore && child && !processoChiuso) {

        errorePendente = errore;

        cleanup();

        if (
          child.exitCode === null &&
          child.signalCode === null
        ) {
          try {
            child.kill('SIGKILL');
          } catch (killError) {
            console.error(
              '[NCC CP-SAT] Terminazione processo fallita'
            );
          }
        }

        return;
      }

      completato = true;

      cleanup();

      if (errore) {
        reject(errore);
      } else {
        resolve(risultato);
      }
    }

    function onAbort() {
      termina(new Error(
        'NCC_CPSAT_INTERROTTO'
      ));
    }

    try {
      child = spawn(
        pythonBin,
        ['-u', script],
        {
          shell: false,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            PYTHONIOENCODING: 'utf-8'
          }
        }
      );

    } catch (err) {
      termina(new Error(
        'NCC_CPSAT_SPAWN: ' + err.message
      ));
      return;
    }

    timer = setTimeout(() => {
      termina(new Error(
        'NCC_CPSAT_TIMEOUT'
      ));
    }, timeoutMs);

    signal?.addEventListener(
      'abort',
      onAbort,
      { once: true }
    );

    child.on('error', err => {
      termina(new Error(
        'NCC_CPSAT_PROCESSO: ' + err.message
      ));
    });

    child.stdout.on('data', chunk => {
      if (completato || errorePendente) return;

      stdoutBytes += chunk.length;

      if (stdoutBytes > maxOutputBytes) {
        termina(new Error(
          'NCC_CPSAT_OUTPUT_TROPPO_GRANDE'
        ));
        return;
      }

      stdout.push(chunk);
    });

    child.stderr.on('data', chunk => {
      if (completato || errorePendente) return;

      stderrBytes += chunk.length;

      if (stderrBytes > 65536) {
        termina(new Error(
          'NCC_CPSAT_STDERR_TROPPO_GRANDE'
        ));
        return;
      }

      stderr.push(chunk);
    });

    child.stdin.on('error', err => {
      termina(new Error(
        'NCC_CPSAT_STDIN: ' + err.message
      ));
    });

    child.on('close', (code, exitSignal) => {

      processoChiuso = true;

      if (completato) return;

      if (errorePendente) {

        const errore = errorePendente;

        errorePendente = null;

        termina(errore);

        return;
      }

      if (code !== 0) {
        termina(new Error(
          'NCC_CPSAT_EXIT: ' +
          code + ':' + exitSignal
        ));
        return;
      }

      let risultato;

      try {
        risultato = JSON.parse(
          Buffer.concat(stdout).toString('utf8')
        );

        if (
          !risultato ||
          typeof risultato !== 'object' ||
          Array.isArray(risultato)
        ) {
          throw new Error('RISPOSTA_INVALIDA');
        }

      } catch (err) {
        termina(new Error(
          'NCC_CPSAT_JSON: ' + err.message
        ));
        return;
      }

      termina(null, {
        versione: NCC_CPSAT_BRIDGE_VERSION,
        durataMs: Date.now() - start,
        inputBytes: Buffer.byteLength(payload),
        outputBytes: stdoutBytes,
        stderrBytes,
        risultato
      });
    });

    if (signal?.aborted) {
      onAbort();
      return;
    }

    child.stdin.end(payload, 'utf8');
  });
}