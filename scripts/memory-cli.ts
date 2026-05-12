#!/usr/bin/env node
// scripts/memory-cli.ts
// ─────────────────────────────────────────────────────────────────────────────
// CLI for the NerdAlert memory module.
// Lets you test every memory function without running the full agent.
// Credit: original pattern by Sherman (OpenClaw memory-cli.js)
//
// Usage:
//   npx ts-node scripts/memory-cli.ts <command> [args]
//
// Commands:
//   capture   '{"subject":"soc","content":"Wazuh is running on 192.168.1.50"}'
//   search    'wazuh alert'
//   recent    [subject]
//   subjects
//   context   ['query string']
//   sweep
//   count
//   rebuild   — rebuild the index from JSONL source of truth
// ─────────────────────────────────────────────────────────────────────────────

import {
  capture,
  search,
  recent,
  subjects,
  sessionContext,
  sweep,
  count,
  rebuildIndex,
} from '../src/memory/engine'

const [,, cmd, ...rest] = process.argv
const arg = rest[0]

function printJSON(data: unknown) {
  console.log(JSON.stringify(data, null, 2))
}

function printLine() {
  console.log('─'.repeat(60))
}

// All CLI commands run inside an async main() so the `capture` case (now
// async since v0.5.26 to support inline embedding) can use `await`. The
// other engine functions stayed synchronous; they're called without await
// and behave exactly as before.
async function main() {
switch (cmd) {

  case 'capture': {
    if (!arg) {
      console.error('Usage: memory-cli capture \'{"subject":"...","content":"..."}\'')
      process.exit(1)
    }
    const input  = JSON.parse(arg)
    const { record, conflict } = await capture(input)
    console.log(`✓ Captured [${record.id}]`)
    console.log(`  Subject    : ${record.subject}`)
    console.log(`  Content    : ${record.content}`)
    console.log(`  Confidence : ${record.confidence}`)
    console.log(`  Source     : ${record.source}`)
    console.log(`  Embedded   : ${record.embedded === true ? 'yes' : 'no'}`)
    if (record.tags.length > 0) console.log(`  Tags       : ${record.tags.join(', ')}`)
    if (conflict.has_conflict) {
      console.log(`\n⚠️  Conflict detected:`)
      console.log(`   Existing [${conflict.existing_id}]: "${conflict.existing_text}"`)
      console.log(`   ${conflict.message}`)
    }
    break
  }

  case 'search': {
    if (!arg) {
      console.error('Usage: memory-cli search "query string"')
      process.exit(1)
    }
    const results = search(arg)
    printLine()
    if (results.length === 0) {
      console.log('No results found.')
    } else {
      console.log(`${results.length} result(s) for: "${arg}"\n`)
      for (const r of results) {
        console.log(`[${r.score.toFixed(3)}] ${r.subject} — ${r.content}`)
        if (r.tags.length > 0) console.log(`        tags: ${r.tags.join(', ')}`)
        console.log(`        confidence: ${r.confidence.toFixed(2)} | id: ${r.id}`)
        console.log()
      }
    }
    printLine()
    break
  }

  case 'recent': {
    const results = recent({ subject: arg, limit: 10 })
    printLine()
    if (results.length === 0) {
      console.log('No recent records found.')
    } else {
      console.log(`${results.length} recent record(s)${arg ? ` for subject "${arg}"` : ''}:\n`)
      for (const r of results) {
        console.log(`${r.subject} — ${r.content}`)
        console.log(`  created: ${r.created_at} | confidence: ${r.confidence.toFixed(2)}`)
        console.log()
      }
    }
    printLine()
    break
  }

  case 'subjects': {
    const subs = subjects()
    printLine()
    if (subs.length === 0) {
      console.log('No subjects found. Memory is empty.')
    } else {
      console.log('Subject buckets:\n')
      for (const s of subs) {
        console.log(`  ${s.subject.padEnd(20)} ${s.count} record(s)`)
      }
    }
    printLine()
    break
  }

  case 'context': {
    const ctx = sessionContext(arg)
    printLine()
    console.log(ctx.summary)
    console.log(`\n— ${ctx.record_count} records loaded from subjects: [${ctx.subjects.join(', ')}]`)
    printLine()
    break
  }

  case 'sweep': {
    console.log('Running decay sweep...\n')
    const result = sweep()
    printLine()
    console.log(`Checked : ${result.checked}`)
    console.log(`Decayed : ${result.decayed}`)
    console.log(`Archived: ${result.archived}`)
    console.log()
    for (const line of result.report) console.log(line)
    printLine()
    break
  }

  case 'count': {
    const stats = count()
    printLine()
    console.log(`Total records : ${stats.total}`)
    console.log(`Active        : ${stats.active}`)
    console.log(`Archived      : ${stats.archived}`)
    console.log(`Stale (< 0.3) : ${stats.stale}`)
    printLine()
    break
  }

  case 'rebuild': {
    console.log('Rebuilding index from JSONL...')
    const index = rebuildIndex()
    console.log(`✓ Index rebuilt. ${index.records.length} records indexed.`)
    break
  }

  default: {
    console.log(`NerdAlert Memory CLI
─────────────────────────────────────────
Commands:
  capture  '{"subject":"soc","content":"...","tags":["wazuh"]}'
  search   "query string"
  recent   [subject]
  subjects
  context  ["query string"]
  sweep
  count
  rebuild

Environment:
  NERDALERT_MEMORY_DIR — override default storage path
  Default: ~/.nerdalert/memory/
`)
    break
  }
}
}

// Run main() and ensure any async error (capture is the only async path) is
// surfaced with a non-zero exit. Otherwise an unhandled rejection would
// produce a confusing process error rather than a clean stack trace.
main().catch(err => {
  console.error(err)
  process.exit(1)
})
