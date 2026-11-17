import { asArray, asObject, asString, get, parseJson } from './json.ts'
import { receiptOk, runOrca } from './orca.ts'
import { envCount, MAX_BUFFER, sleepSeconds } from './sys.ts'

import { spawnSync } from 'node:child_process'

export type VerifyResult = {
  ok: boolean
  failed: string | null
  exitCode: number | null
  peakMemoryMb: number | null
  diskGrowthMb: number | null
  missingTools: string[]
  platform: string | null
  tmpPath: string | null
}
export const VERIFY_BEGIN = '@@orca-auto-verify:begin@@'
export const VERIFY_END = '@@orca-auto-verify:end@@'
export const VERIFY_TMP = '@@orca-auto-verify:tmp@@'
export const VERIFY_SCRIPT_FAILED = '確認のスクリプト'

const VERIFY_BODY = String.raw`
process.on('SIGINT', () => {});
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const spawnSync = require('node:child_process').spawnSync;
const result = { ok: false, failed: null, exitCode: null, peakMemoryMb: null, diskGrowthMb: null,
  missingTools: [], platform: os.platform(), tmpPath: null };
let tmp = null, worktree = null;
const git = (...args) => spawnSync('git', ['worktree', ...args], { stdio: ['ignore', 2, 2] });
const disk = () => {
  const r = spawnSync('du', ['-sk', worktree], { encoding: 'utf8' });
  const match = r.status === 0 && r.stdout.match(/^\s*(\d+)/);
  return match ? Number(match[1]) : null;
};
try {
  git('prune');
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-auto-verify-'));
  result.tmpPath = tmp;
  console.log('@@orca-auto-verify:tmp@@' + tmp + '@@');
  worktree = path.join(tmp, 'worktree');
  const report = path.join(tmp, 'time.txt');
  if (git('add', '--detach', worktree, 'HEAD').status !== 0) {
    result.failed = 'git worktree add';
  } else {
    const flag = result.platform === 'darwin' ? '-l' : result.platform === 'linux' ? '-v' : null;
    const timed = flag && fs.existsSync('/usr/bin/time') &&
      spawnSync('/usr/bin/time', [flag, '-o', report, '/bin/sh', '-c', 'true'], { stdio: 'ignore' }).status === 0;
    const before = disk();
    result.ok = true;
    result.exitCode = 0;
    for (const command of input.commands) {
      const r = spawnSync(timed ? '/usr/bin/time' : '/bin/sh',
        timed ? [flag, '-o', report, '/bin/sh', '-c', command] : ['-c', command],
        { cwd: worktree, stdio: ['ignore', 2, 2], env: { ...process.env, GIT_PAGER: 'cat', PAGER: 'cat' } });
      if (timed) {
        try {
          const text = fs.readFileSync(report, 'utf8');
          const match = result.platform === 'darwin' ? text.match(/(\d+)\s+maximum resident set size/) :
            text.match(/Maximum resident set size \(kbytes\):\s*(\d+)/);
          const mb = match ? Math.ceil(Number(match[1]) / (result.platform === 'darwin' ? 1048576 : 1024)) : 0;
          if (mb >= 1) result.peakMemoryMb = Math.max(result.peakMemoryMb || 0, mb);
        } catch {}
      }
      if (r.status !== 0) {
        result.ok = false;
        result.failed = command;
        result.exitCode = r.status;
        break;
      }
    }
    const after = disk();
    if (before !== null && after !== null) result.diskGrowthMb = Math.max(0, Math.ceil((after - before) / 1024));
  }
} catch {
  result.ok = false;
  if (!result.failed) result.failed = input.scriptFailed;
} finally {
  for (const cleanup of [
    ...input.tools.map((tool) => () => {
      if (spawnSync('/bin/sh', ['-c', 'command -v "$1" >/dev/null 2>&1', 'sh', tool]).status !== 0)
        result.missingTools.push(tool);
    }),
    () => { if (worktree) git('remove', '--force', worktree); },
    () => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); },
    () => git('prune')
  ]) {
    try { cleanup(); } catch {
      result.ok = false;
      if (!result.failed) result.failed = input.scriptFailed;
      if (tmp) console.error('一時ディレクトリが残っていれば消してください: ' + tmp);
    }
  }
}
console.log('@@orca-auto-verify:begin@@' + JSON.stringify(result) + '@@orca-auto-verify:end@@');
`
export const verifyCommand = (commands: string[], tools: string[]): string => {
  const script =
    'const input=' + JSON.stringify({ commands, tools, scriptFailed: VERIFY_SCRIPT_FAILED }) + ';' + VERIFY_BODY
  return `node -e "eval(Buffer.from('${Buffer.from(script).toString('base64')}','base64').toString('utf8'))"`
}
export const parseVerifyTmp = (text: string): string | null => {
  const flat = text.replace(/[\r\n]/g, '')
  const start = flat.indexOf(VERIFY_TMP)
  if (start < 0) return null
  const end = flat.indexOf('@@', start + VERIFY_TMP.length)
  return end < 0 ? null : flat.slice(start + VERIFY_TMP.length, end) || null
}
export const parseVerifyOutput = (text: string): VerifyResult | null => {
  const flat = text.replace(/[\r\n]/g, '')
  const start = flat.indexOf(VERIFY_BEGIN)
  const end = flat.indexOf(VERIFY_END, start + VERIFY_BEGIN.length)
  const value = start >= 0 && end >= 0 ? asObject(parseJson(flat.slice(start + VERIFY_BEGIN.length, end))) : null
  if (!value || typeof value.ok !== 'boolean') return null
  const integer = (n: typeof value.exitCode, floor: number): number | null =>
    typeof n === 'number' && Number.isInteger(n) && n >= floor ? n : null
  const failed = asString(value.failed)
  return {
    ok: value.ok === true && failed === null,
    failed,
    exitCode: integer(value.exitCode, Number.NEGATIVE_INFINITY),
    peakMemoryMb: integer(value.peakMemoryMb, 1),
    diskGrowthMb: integer(value.diskGrowthMb, 0),
    missingTools: (asArray(value.missingTools) ?? []).filter((t): t is string => typeof t === 'string' && t.length > 0),
    platform: asString(value.platform),
    tmpPath: asString(value.tmpPath) ?? parseVerifyTmp(text),
  }
}
export const VERIFY_REMOTE_TIMEOUT_MS = 30 * 60 * 1000
export const VERIFY_REMOTE_INTERVAL_MS = 5000
export type RemoteVerify = { result: VerifyResult | null; timedOut: boolean; tmpPath: string | null }
export const verifyRemote = (
  id: string,
  worktreeSelector: string,
  commands: string[],
  tools: string[],
  onWait: (minutes: number) => void,
): RemoteVerify => {
  const created = runOrca([
    'terminal',
    'create',
    '--environment',
    id,
    '--worktree',
    worktreeSelector,
    '--title',
    'orca-auto-verify',
    '--command',
    verifyCommand(commands, tools),
    '--json',
  ])
  const handle = receiptOk(created) ? asString(get(created.json, 'result', 'terminal', 'handle')) : null
  if (!handle) return { result: null, timedOut: false, tmpPath: null }
  let tmpPath: string | null = null
  const start = Date.now()
  let reported = 0
  try {
    for (;;) {
      const read = runOrca(['terminal', 'read', '--environment', id, '--terminal', handle, '--limit', '400', '--json'])
      const tail = receiptOk(read) ? asArray(get(read.json, 'result', 'terminal', 'tail')) : null
      const text = tail?.filter((line): line is string => typeof line === 'string').join('') ?? ''
      tmpPath = parseVerifyTmp(text) ?? tmpPath
      const result = parseVerifyOutput(text)
      if (result) return { result, timedOut: false, tmpPath: result.tmpPath ?? tmpPath }
      const elapsed = Date.now() - start
      if (elapsed >= envCount('ORCA_AUTO_VERIFY_TIMEOUT_MS', VERIFY_REMOTE_TIMEOUT_MS))
        return { result: null, timedOut: true, tmpPath }
      const minutes = Math.floor(elapsed / 60000)
      if (minutes > reported) {
        onWait(minutes)
        reported = minutes
      }
      sleepSeconds(envCount('ORCA_AUTO_VERIFY_INTERVAL_MS', VERIFY_REMOTE_INTERVAL_MS) / 1000)
    }
  } finally {
    runOrca(['terminal', 'close', '--environment', id, '--terminal', handle, '--json'])
  }
}
export const runVerifyLocal = (checkout: string, commands: string[], tools: string[]): VerifyResult => {
  const ignore = () => {}
  process.on('SIGINT', ignore)
  try {
    const result = spawnSync('/bin/sh', ['-c', verifyCommand(commands, tools)], {
      cwd: checkout,
      stdio: ['ignore', 'pipe', 'inherit'],
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER,
    })
    const stdout = result.stdout ?? ''
    return (
      parseVerifyOutput(stdout) ?? {
        ok: false,
        failed: VERIFY_SCRIPT_FAILED,
        exitCode: null,
        peakMemoryMb: null,
        diskGrowthMb: null,
        missingTools: [],
        platform: null,
        tmpPath: parseVerifyTmp(stdout),
      }
    )
  } finally {
    process.removeListener('SIGINT', ignore)
  }
}
