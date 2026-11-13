import { syncIssues } from '../../lib/auto-queue.ts'
import { slugOf } from '../../lib/auto-request.ts'
import { type IssueState, type Phase, readState, writeState } from '../../lib/auto-state.ts'
import { fixture } from './auto-fixture.ts'

import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
export const runtimeFixture = () => {
  const f = fixture()
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { encoding: 'utf8' })
    if (r.status !== 0) throw new Error(r.stderr)
    return r.stdout.trim()
  }
  const origin = join(f.dir, 'origin.git')
  const checkout = f.raw.repos['acme/app'].checkout
  git('init', '--bare', '--initial-branch=main', origin)
  git('clone', origin, checkout)
  git('-C', checkout, 'config', 'user.email', 'test@example.invalid')
  git('-C', checkout, 'config', 'user.name', 'auto-test')
  writeFileSync(join(checkout, 'seed'), 'seed')
  git('-C', checkout, 'add', 'seed')
  git('-C', checkout, 'commit', '-m', 'seed')
  git('-C', checkout, 'push', 'origin', 'main')
  appendFileSync(join(checkout, '.git/info/exclude'), '.dispatch/\n')
  const children = join(f.dir, 'children')
  mkdirSync(children)
  const common = `import { existsSync, readFileSync, appendFileSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs'; import { join } from 'node:path'; import { spawnSync } from 'node:child_process';\nconst args=process.argv.slice(2); const dir=process.env.ORCA_AUTO_BIN_DIR; const name=process.argv[1].split('/').at(-1); const flag=(key)=>args[args.indexOf(key)+1];\nappendFileSync(join(dir,'calls.log'),name+' '+JSON.stringify(args)+' ORCA_TERMINAL_HANDLE='+process.env.ORCA_TERMINAL_HANDLE+' ORCA_WAITER_RETRY_TRIES='+process.env.ORCA_WAITER_RETRY_TRIES+' ORCA_CREATE_SETTLE_SECS='+process.env.ORCA_CREATE_SETTLE_SECS+'\\n');\nconst hook=join(dir,name+'.sh');if(existsSync(hook)){const child=spawnSync('sh',[hook,...args],{stdio:'inherit'});if(child.status!==0)process.exit(child.status??1)}\nconst rc=existsSync(join(dir,name+'.rc'))?Number(readFileSync(join(dir,name+'.rc'),'utf8')):null;\n`
  for (const name of ['orca-start.ts', 'orca-wait.ts', 'orca-stop.ts', 'orca-pr.ts']) {
    const body =
      name === 'orca-start.ts'
        ? `const sd=join(flag('--repo-root'),'.dispatch',flag('--slug'));mkdirSync(sd,{recursive:true});if(args.includes('--request-file'))copyFileSync(flag('--request-file'),join(sd,'request.md'));\nif(rc===null||rc===0){let w={run_id:'run_1',integration_branch:'main',integration_role:flag('--phase-b')==='on'?'exec':'design',roles:{design:{dispatch:'ctx_design',branch:'user/'+flag('--slug'),worktree_path:join(dir,'worktree')}}};if(args.includes('--phase')){w=JSON.parse(readFileSync(join(sd,'workers.json'),'utf8'));w.roles.exec={dispatch:'ctx_exec',branch:'user/'+flag('--slug')+'-exec',worktree_path:join(dir,'exec-worktree')}};writeFileSync(join(sd,'workers.json'),JSON.stringify(w));writeFileSync(join(sd,'run.json'),JSON.stringify({run_id:'run_1',parent_handle:process.env.ORCA_TERMINAL_HANDLE,repo_root:flag('--repo-root')}));spawnSync('git',['-C',flag('--repo-root'),'branch',w.roles[w.integration_role]?.branch||w.roles.design.branch]);}\nprocess.exit(rc??0);`
        : name === 'orca-wait.ts'
          ? 'process.exit(rc??3);'
          : 'process.exit(rc??0);'
    writeFileSync(join(children, name), common + body)
  }
  f.respond('repo_view', {
    defaultBranchRef: { name: 'main' },
    squashMergeAllowed: true,
    mergeCommitAllowed: true,
    rebaseMergeAllowed: true,
  })
  f.respond('pr_view', {
    number: 101,
    url: 'https://github.com/acme/app/pull/101',
    state: 'OPEN',
    mergedAt: null,
    statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }],
  })
  f.respond('worktree_list', { ok: true, result: { worktrees: [], truncated: false } }, f.orca)
  f.respond('terminal_create', { ok: true, result: { terminal: { handle: 'term_auto' } } }, f.orca)
  f.respond(
    'terminal_show',
    { ok: true, result: { terminal: { handle: 'term_auto', orphaned: false, connected: true } } },
    f.orca,
  )
  f.respond(
    'orchestration_run-current',
    { ok: true, result: { run: { id: 'run_1', coordinator_handle: 'term_auto' } } },
    f.orca,
  )
  f.respond(
    'orchestration_worker-list',
    { ok: true, result: { workers: [{ dispatchId: 'ctx_design', resource: { releaseState: 'released' } }] } },
    f.orca,
  )
  // Make label writes observable on the next read, as on GitHub.
  const editHook = join(f.dir, 'edit-hook.js')
  writeFileSync(
    editHook,
    `const fs=require('fs');const args=process.argv.slice(2);const file=process.env.GH_STUB_DIR+'/issue_view';if(fs.existsSync(process.env.GH_STUB_DIR+'/issue_edit.rc')&&Number(fs.readFileSync(process.env.GH_STUB_DIR+'/issue_edit.rc','utf8'))!==0)process.exit(0);const old=JSON.parse(fs.readFileSync(file));old.labels=[{name:args[args.indexOf('--add-label')+1]}];fs.writeFileSync(file,JSON.stringify(old));`,
  )
  f.hook('issue_edit', `exec '${process.execPath}' '${editHook}' "$@"`)
  const childCalls = () => {
    try {
      return readFileSync(join(children, 'calls.log'), 'utf8')
    } catch {
      return ''
    }
  }
  const childRc = (name: string, rc: number) => writeFileSync(join(children, `${name}.ts.rc`), String(rc))
  const track = (phase: Phase = 'queued', number = 7): IssueState => {
    f.respond('issue_list', [{ number, title: '題', labels: [], updatedAt: '2026-01-01' }])
    const s = readState('main')
    const source = f.config().sources[0]
    if (!source) throw new Error('source')
    syncIssues(s, [source])
    f.respond('issue_list', [])
    const i = s.issues[`acme/app#${number}`]
    if (!i) throw new Error('issue')
    Object.assign(i, { phase, targets: ['acme/app'], limitMinutes: 60, reason: '明確な修正です' })
    if (phase !== 'queued') {
      Object.assign(i, {
        slug: slugOf(i.key),
        statusDir: join(checkout, '.dispatch', slugOf(i.key)),
        branch: 'user/' + slugOf(i.key),
        coordinator: 'term_auto',
        worktrees: 1,
        startedAt: '2026-11-13T05:00:00Z',
      })
      mkdirSync(i.statusDir, { recursive: true })
      writeFileSync(join(i.statusDir, 'request.md'), i.key + ' ' + i.title + '\n')
      f.put(join(i.statusDir, 'run.json'), { run_id: 'run_1', parent_handle: 'term_auto', repo_root: checkout })
      f.put(join(i.statusDir, 'workers.json'), {
        run_id: 'run_1',
        integration_branch: 'main',
        integration_role: 'design',
        roles: { design: { dispatch: 'ctx_design', branch: i.branch, worktree_path: join(children, 'worktree') } },
      })
      git('-C', checkout, 'branch', i.branch)
      f.respond('issue_view', {
        state: 'OPEN',
        title: '題',
        body: '本文',
        labels: [{ name: phase === 'dispatching' ? 'Ready' : 'In progress' }],
      })
    }
    writeState('main', s)
    return i
  }
  const result = (i: IssueState, extra: object = {}) =>
    f.put(join(i.statusDir, 'auto-result.json'), {
      decisions: [],
      summary: '修正しました',
      verify: { passed: true, ran: ['node --test'] },
      review: { unresolved: [], declined: [] },
      envFailure: null,
      ...extra,
    })
  return { ...f, git, checkout, children, childCalls, childRc, track, result }
}
