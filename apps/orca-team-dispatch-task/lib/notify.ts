// 人の答えを待つことを、Mac の通知で知らせる（awaiting-user.ts から呼ぶ）。
//
// ★ codex の worker には通知を出す道具が無い。質問を端末に書いてターンを終えると、人は気づけない。
//   awaiting-user.ts は agent を問わず「答えを待つ直前」に必ず呼ばれるので、ここで知らせる
// ★ 知らせは添え物。出せなくても awaiting-user.json の書き込み（停滞の判定に使う）は成功として扱う
// ★ ORCA_DISPATCH_NOTIFY=0 で止められる。macOS 以外では何もしない
import { run } from './sys.ts'

import { basename, dirname } from 'node:path'

// .dispatch/<slug>/roles/<role> から slug と役の名前を取る。形が違えば最後の 2 つの名前をそのまま使う
export const roleLabel = (roleDir: string): { slug: string; role: string } => {
  const role = basename(roleDir)
  const parent = dirname(roleDir)
  const slug = basename(parent) === 'roles' ? basename(dirname(parent)) : basename(parent)
  return { slug, role }
}

// AppleScript の文字列に入れる値。\ と " を逃がし、改行は空白にする
const quote = (value: string): string =>
  `"${value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\r\n]+/g, ' ')}"`

export const notificationScript = (title: string, body: string): string =>
  `display notification ${quote(body)} with title ${quote(title)} sound name "Glass"`

export const notifyAwaitingUser = (roleDir: string, env: NodeJS.ProcessEnv = process.env): boolean => {
  if (process.platform !== 'darwin' || env.ORCA_DISPATCH_NOTIFY === '0') return false
  const { slug, role } = roleLabel(roleDir)
  const script = notificationScript(`Orca: ${slug}`, `${role} が答えを待っています。担当の端末を見てください`)
  return run('osascript', ['-e', script], undefined, 5000).rc === 0
}
