import { openDb } from '../../lib/db.ts'
import { acquireLease } from '../../lib/lease.ts'

const [file = '', at = ''] = process.argv.slice(2)
const db = openDb(file)
console.log(acquireLease(db, 'poll', null, new Date(at), 60000).ok ? 'ok' : 'busy')
db.close()
