import { syncIssues } from '../../lib/auto-queue.ts'
import { slugOf } from '../../lib/auto-request.ts'
import { type IssueState, type Phase, readState, writeState } from '../../lib/auto-state.ts'
import { fixture } from './auto-fixture.ts'

import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
        ? `const sd=join(flag('--repo-root'),'.dispatch',flag('--slug'));mkdirSync(sd,{recursive:true});if(args.includes('--request-file'))copyFileSync(flag('--request-file'),join(sd,'request.md'));\nif(rc===null||rc===0){let w={run_id:'run_1',integration_branch:'main',integration_role:flag('--phase-b')==='on'?'exec':'design',roles:{design:{dispatch:'ctx_design',branch:'user/'+flag('--slug'),worktree_path:join(dir,'worktree')}}};if(args.includes('--phase')){w=JSON.parse(readFileSync(join(sd,'workers.json'),'utf8'));w.roles.exec={dispatch:'ctx_exec',branch:'user/'+flag('--slug')+'-exec',worktree_path:join(dir,'exec-worktree')}};if(args.includes('--transport')){w.transport='mail';w.environment=args.includes('--on')?flag('--on'):null;w.host_repo=flag('--host-repo');w.base_branch=flag('--base-branch');w.worker_orca=flag('--worker-orca')};if(w.transport==='mail'){for(const role of Object.values(w.roles))role.environment=w.environment};if(args.includes('--repos-file'))w.repos=JSON.parse(readFileSync(flag('--repos-file'),'utf8')).map(r=>({...r,integration_branch:'main'}));if(w.repos){for(const role of Object.values(w.roles))if(!role.extra)role.extra=Object.fromEntries(w.repos.slice(1).map(r=>[r.repo,{worktree_id:'wt_extra',worktree_path:join(dir,'worktree2'),branch:role.branch+'-2'}]))};writeFileSync(join(sd,'workers.json'),JSON.stringify(w));writeFileSync(join(sd,'run.json'),JSON.stringify({run_id:'run_1',parent_handle:process.env.ORCA_TERMINAL_HANDLE,repo_root:flag('--repo-root')}));if(!w.environment){spawnSync('git',['-C',flag('--repo-root'),'branch',w.roles[w.integration_role]?.branch||w.roles.design.branch]);if(w.repos)for(const r of w.repos.slice(1)){const extra=w.roles[w.integration_role]?.extra?.[r.repo]||w.roles.design.extra[r.repo];spawnSync('git',['-C',r.checkout,'branch',extra.branch])}}}\nprocess.exit(rc??0);`
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
  const commentHook = join(f.dir, 'comment-hook.js')
  writeFileSync(
    commentHook,
    "const fs=require('fs');const path=require('path');const args=process.argv.slice(2);const body=args[args.indexOf('--body')+1];fs.appendFileSync(path.join(process.env.GH_STUB_DIR,'../comments.jsonl'),JSON.stringify(body)+'\\n');const rc=path.join(process.env.GH_STUB_DIR,'issue_comment.rc');if(fs.existsSync(rc)&&Number(fs.readFileSync(rc,'utf8'))!==0)process.exit(0);const file=path.join(process.env.GH_STUB_DIR,'api');let list=[];try{list=JSON.parse(fs.readFileSync(file,'utf8'))}catch{};list.push({body});fs.writeFileSync(file,JSON.stringify(list));",
  )
  f.hook('issue_comment', `exec '${process.execPath}' '${commentHook}' "$@"`)
  const closeHook = join(f.dir, 'close-hook.js')
  writeFileSync(
    closeHook,
    "const fs=require('fs');const dir=process.env.GH_STUB_DIR;const rc=dir+'/issue_close.rc';if(fs.existsSync(rc)&&Number(fs.readFileSync(rc,'utf8'))!==0)process.exit(0);const file=dir+'/issue_view';const issue=JSON.parse(fs.readFileSync(file));issue.state='CLOSED';fs.writeFileSync(file,JSON.stringify(issue));",
  )
  f.hook('issue_close', `exec '${process.execPath}' '${closeHook}' "$@"`)
  const removeHook = join(f.dir, 'remove-hook.js')
  writeFileSync(
    removeHook,
    "const fs=require('fs');const dir=process.env.ORCA_STUB_DIR;const rc=dir+'/worktree_rm.rc';if(fs.existsSync(rc)&&Number(fs.readFileSync(rc,'utf8'))!==0)process.exit(0);const args=process.argv.slice(2);const p=args[args.indexOf('--worktree')+1].replace(/^path:/,'');const file=dir+'/worktree_list';const row=JSON.parse(fs.readFileSync(file));row.result.worktrees=row.result.worktrees.filter(w=>w.path!==p);fs.writeFileSync(file,JSON.stringify(row));",
  )
  f.hook('worktree_rm', `exec '${process.execPath}' '${removeHook}' "$@"`, f.orca)
  const childCalls = () => {
    try {
      return readFileSync(join(children, 'calls.log'), 'utf8')
    } catch {
      return ''
    }
  }
  const childRc = (name: string, rc: number) => writeFileSync(join(children, `${name}.ts.rc`), String(rc))
  const liveWorker = () => {
    f.respond(
      'orchestration_worker-list',
      { ok: true, result: { workers: [{ dispatchId: 'ctx_design', resource: { releaseState: 'retained' } }] } },
      f.orca,
    )
    f.respond('orchestration_worker-show', { ok: true, result: { worker: { state: 'active' } } }, f.orca)
    f.hook(
      'orchestration_worker-stop',
      `printf '%s' '{"ok":true,"result":{"workers":[{"dispatchId":"ctx_design","resource":{"releaseState":"released"}}]}}' > '${f.orca}/orchestration_worker-list'
printf 'worker-stop ORCA_TERMINAL_HANDLE=%s\\n' "$ORCA_TERMINAL_HANDLE" >> '${children}/calls.log'`,
      f.orca,
    )
  }
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
        branch: `user/${slugOf(i.key)}`,
        coordinator: 'term_auto',
        worktrees: 1,
        startedAt: '2026-11-13T05:00:00Z',
      })
      mkdirSync(i.statusDir, { recursive: true })
      writeFileSync(join(i.statusDir, 'request.md'), `${i.key} ${i.title}\n`)
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

  const second = (): string => {
    const checkout2 = f.raw.repos['other/api'].checkout
    if (existsSync(join(checkout2, '.git'))) return checkout2
    const origin2 = join(f.dir, 'origin2.git')
    git('init', '--bare', '--initial-branch=main', origin2)
    git('clone', origin2, checkout2)
    git('-C', checkout2, 'config', 'user.email', 'test@example.invalid')
    git('-C', checkout2, 'config', 'user.name', 'auto-test')
    writeFileSync(join(checkout2, 'seed'), 'second seed')
    git('-C', checkout2, 'add', 'seed')
    git('-C', checkout2, 'commit', '-m', 'seed')
    git('-C', checkout2, 'push', 'origin', 'main')
    appendFileSync(join(checkout2, '.git/info/exclude'), '.dispatch/\n')
    return checkout2
  }
  const trackMulti = (
    phase: Phase = 'queued',
    targets: [string, string] = ['other/api', 'acme/app'],
    number = 7,
  ): IssueState => {
    second()
    const issue = track('queued', number)
    issue.targets = targets
    if (phase !== 'queued') {
      const root = targets[0] === 'acme/app' ? checkout : second()
      Object.assign(issue, {
        phase,
        slug: slugOf(issue.key),
        statusDir: join(root, '.dispatch', slugOf(issue.key)),
        branch: `user/${slugOf(issue.key)}`,
        coordinator: 'term_auto',
        worktrees: 2,
        startedAt: '2026-11-13T05:00:00Z',
      })
      issue.branches = { [targets[0]]: issue.branch, [targets[1]]: `${issue.branch}-2` }
      mkdirSync(issue.statusDir, { recursive: true })
      writeFileSync(join(issue.statusDir, 'request.md'), `${issue.key} ${issue.title}\n`)
      f.put(join(issue.statusDir, 'run.json'), { run_id: 'run_1', parent_handle: 'term_auto', repo_root: root })
      const repos = targets.map((repo) => {
        const path = repo === 'acme/app' ? checkout : second()
        return {
          repo,
          checkout: path,
          host_repo: `path:${path}`,
          base_branch: 'origin/main',
          integration_branch: 'main',
        }
      })
      f.put(join(issue.statusDir, 'workers.json'), {
        run_id: 'run_1',
        integration_branch: 'main',
        integration_role: 'design',
        repos,
        roles: {
          design: {
            dispatch: 'ctx_design',
            branch: issue.branch,
            worktree_path: join(children, 'worktree'),
            extra: {
              [targets[1]]: {
                worktree_id: 'wt_extra',
                worktree_path: join(children, 'worktree2'),
                branch: `${issue.branch}-2`,
              },
            },
          },
        },
      })
      for (const r of repos) git('-C', r.checkout, 'branch', issue.branches[r.repo] ?? '')
      f.respond('issue_view', {
        state: 'OPEN',
        title: '題',
        body: '本文',
        labels: [{ name: phase === 'dispatching' ? 'Ready' : 'In progress' }],
      })
    }
    const state = readState('main')
    state.issues[issue.key] = issue
    writeState('main', state)
    return issue
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
  return { ...f, git, checkout, children, childCalls, childRc, liveWorker, track, second, trackMulti, result }
}
