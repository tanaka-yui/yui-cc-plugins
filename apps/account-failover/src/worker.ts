// Orca が読み込み時に変換する worker のエントリ。ビルド工程はない。
import type { OrcaWorkerApi } from 'orca/worker'

export default function activate(orca: OrcaWorkerApi): void {
  orca.log('account-failover activated')
}
